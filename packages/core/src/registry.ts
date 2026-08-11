/**
 * The plugin registry and mount builder.
 *
 * Two tiers of plugin exist, on purpose:
 *
 *  1. In-process TypeScript/JavaScript plugins, loaded by dynamic `import()`. Fast, typed,
 *     full access to the engine.
 *  2. Any executable at all, via the `exec` provider, which speaks newline-delimited JSON
 *     over stdio. Slower, but a user can add a feed in Python, Bash or PowerShell without
 *     touching this codebase or learning its types.
 *
 * WeeChat is the evidence for tier 2. It outlasted irssi's Perl-only scripting precisely
 * because contributors could write in whatever they already knew. irssi's maintainers have
 * said the single-language binding became a liability. The cost of tier 2 is one extra
 * process and a serialization boundary; the benefit is that the plugin ecosystem is not
 * gated on knowing TypeScript.
 */

import { VfsError } from './errors.js';
import type { Logger, Provider, ProviderContext, ProviderPlugin, StateStore } from './provider.js';
import { NULL_LOGGER } from './logging.js';
import type { AppConfig, MountConfig } from './config.js';
import { resolveSecret } from './config.js';
import type { Mount } from './vfs.js';

export class PluginRegistry {
  readonly #plugins = new Map<string, ProviderPlugin>();
  readonly #logger: Logger;

  constructor(logger: Logger = NULL_LOGGER) {
    this.#logger = logger;
  }

  register(plugin: ProviderPlugin): void {
    if (this.#plugins.has(plugin.type)) {
      throw VfsError.config(
        `Two plugins both claim the type "${plugin.type}".`,
        'Provider types must be unique. Remove one from "plugins" in your config.',
      );
    }
    this.#plugins.set(plugin.type, plugin);
    this.#logger.debug('registered provider plugin', { type: plugin.type });
  }

  has(type: string): boolean {
    return this.#plugins.has(type);
  }

  get(type: string): ProviderPlugin {
    const plugin = this.#plugins.get(type);
    if (plugin === undefined) {
      const known = [...this.#plugins.keys()].sort();
      const suggestion = closest(type, known);
      throw VfsError.config(
        `No provider plugin is registered for type "${type}".`,
        suggestion === undefined
          ? `Known types: ${known.join(', ') || '(none)'}. Add the package to "plugins" in your config.`
          : `Did you mean "${suggestion}"? Known types: ${known.join(', ')}.`,
      );
    }
    return plugin;
  }

  get all(): readonly ProviderPlugin[] {
    return [...this.#plugins.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  /**
   * Load an external plugin package by module specifier.
   *
   * A failure here is reported and skipped rather than fatal. A user with four mounts
   * should not lose access to their mail because an unrelated third-party plugin package
   * was uninstalled — the failing mount will report its own clear error when touched.
   */
  async load(specifier: string): Promise<boolean> {
    try {
      const module = (await import(specifier)) as Record<string, unknown>;
      const candidates = [module['plugin'], module['default'], module];
      let loaded = 0;

      for (const candidate of candidates) {
        if (isPlugin(candidate)) {
          this.register(candidate);
          loaded += 1;
          break;
        }
        // A package may export several plugins as named exports.
        if (candidate === module && typeof candidate === 'object' && candidate !== null) {
          for (const value of Object.values(candidate as Record<string, unknown>)) {
            if (isPlugin(value) && !this.#plugins.has(value.type)) {
              this.register(value);
              loaded += 1;
            }
          }
        }
      }

      if (loaded === 0) {
        this.#logger.warn('plugin package exported no provider plugin', { specifier });
        return false;
      }
      return true;
    } catch (error) {
      this.#logger.warn('failed to load plugin package', {
        specifier,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async loadAll(specifiers: readonly string[]): Promise<{ loaded: string[]; failed: string[] }> {
    const loaded: string[] = [];
    const failed: string[] = [];
    for (const specifier of specifiers) {
      if (await this.load(specifier)) loaded.push(specifier);
      else failed.push(specifier);
    }
    return { loaded, failed };
  }
}

function isPlugin(value: unknown): value is ProviderPlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProviderPlugin).type === 'string' &&
    typeof (value as ProviderPlugin).create === 'function'
  );
}

/** Levenshtein-based "did you mean", capped so unrelated words are not suggested. */
function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return bestDistance <= threshold ? best : undefined;
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] as number;
}

// ---------------------------------------------------------------------------
// Mount construction
// ---------------------------------------------------------------------------

export interface MountBuilderOptions {
  readonly registry: PluginRegistry;
  readonly logger?: Logger;
  /** Builds the per-mount state store. Injected so tests can use memory stores. */
  readonly stateFor: (mountId: string) => StateStore;
  readonly cacheDirFor: (mountId: string) => string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BuiltMount {
  readonly mount?: Mount;
  readonly config: MountConfig;
  readonly error?: VfsError;
}

/**
 * Turn mount config into live mounts.
 *
 * One broken mount must not take down the session. A user with mail, GitHub and three RSS
 * feeds who revokes a GitHub token should still be able to read mail; the GitHub mount
 * reports its specific error when listed. This is the same containment principle that
 * keeps a dead vendor API from bricking the whole tool.
 */
export async function buildMounts(
  configs: readonly MountConfig[],
  options: MountBuilderOptions,
): Promise<readonly BuiltMount[]> {
  const logger = options.logger ?? NULL_LOGGER;
  const results: BuiltMount[] = [];

  for (const config of configs) {
    const mountId = (config.id ?? config.path.replace(/^\//, '').replace(/\//g, '.')) || 'root';
    try {
      const plugin = options.registry.get(config.type);
      const rawOptions = config.options ?? {};
      const validated =
        plugin.validateOptions === undefined ? rawOptions : plugin.validateOptions(rawOptions);

      const context: ProviderContext = {
        mountPath: config.path,
        logger,
        state: options.stateFor(mountId),
        cacheDir: options.cacheDirFor(mountId),
        secret: (ref) => resolveSecret(ref, options.env ?? process.env),
      };

      const provider: Provider = await plugin.create(validated, context);
      if (provider.init !== undefined) await provider.init();

      results.push({
        config,
        mount: {
          path: config.path,
          id: mountId,
          provider,
          ...(config.ttlMs === undefined ? {} : { ttlMs: config.ttlMs }),
          ...(config.pageSize === undefined ? {} : { pageSize: config.pageSize }),
          ...(config.description === undefined
            ? { description: plugin.displayName }
            : { description: config.description }),
        },
      });
    } catch (error) {
      const vfsError =
        error instanceof VfsError
          ? error
          : VfsError.config(
              `Mount "${config.path}" (${config.type}) failed to start: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'Run `mscomms doctor` for a full diagnosis.',
            );
      logger.error('mount failed', { path: config.path, type: config.type, message: vfsError.message });
      results.push({ config, error: vfsError });
    }
  }

  return results;
}

/** Convenience: registry + plugins + mounts from a whole AppConfig. */
export async function buildFromConfig(
  config: AppConfig,
  options: MountBuilderOptions,
): Promise<{ mounts: readonly BuiltMount[]; failedPlugins: readonly string[] }> {
  const { failed } = await options.registry.loadAll(config.plugins);
  const mounts = await buildMounts(config.mounts, options);
  return { mounts, failedPlugins: failed };
}
