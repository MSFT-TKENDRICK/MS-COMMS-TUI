/**
 * Configuration.
 *
 * Format is JSONC — JSON with `//` comments and trailing commas. TOML would be marginally
 * nicer to hand-edit and is what most terminal tools have converged on, but a correct TOML
 * parser is a few thousand lines and this project holds runtime dependencies at zero on
 * purpose: it reads corporate mail, so every transitive package is attack surface someone
 * has to justify. JSONC gets the two things that actually matter for a hand-edited file
 * (comments, forgiving commas) for about eighty lines of well-tested code.
 *
 * Secrets are never stored in the file. A value written as `${env:GITHUB_TOKEN}` is
 * resolved from the environment at use time, so a config file is safe to commit and safe
 * to paste into a bug report.
 */

import { homedir } from 'node:os';
import { join as hostJoin, isAbsolute as hostIsAbsolute, resolve as hostResolve, posix as posixPath, win32 as win32Path } from 'node:path';
import { readFile } from 'node:fs/promises';
import { VfsError } from './errors.js';
import * as vpath from './vpath.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface MountConfig {
  readonly path: string;
  readonly type: string;
  readonly id?: string;
  readonly description?: string;
  readonly options?: Record<string, unknown>;
  readonly ttlMs?: number;
  readonly pageSize?: number;
}

export interface SavedQueryConfig {
  readonly name: string;
  readonly query: string;
  /** Paths to search. Defaults to every mount. */
  readonly scope?: readonly string[];
  readonly description?: string;
}

export interface WatchConfig {
  readonly id: string;
  readonly path: string;
  readonly query?: string;
  readonly intervalMs?: number;
  readonly includeUpdates?: boolean;
  readonly label?: string;
}

export interface UiConfig {
  /** Force plain output: no colour, no box drawing, no spinners, no alternate screen. */
  readonly plain?: boolean;
  readonly color?: 'auto' | 'always' | 'never';
  readonly pageSize?: number;
  readonly bell?: boolean;
  /**
   * Emacspeak-style output: render listings as spoken sentences rather than aligned
   * columns, because column alignment is a purely visual affordance.
   */
  readonly announce?: boolean;
  readonly dateStyle?: 'relative' | 'absolute' | 'iso';
  readonly prompt?: string;
  readonly showHiddenMeta?: boolean;
}

export interface NotificationConfig {
  readonly desktop?: boolean;
  readonly appId?: string;
  readonly appName?: string;
  readonly maxEntries?: number;
}

/**
 * The local snapshot: a libSQL/SQLite database that keeps recent mail on disk so a cold
 * start is not a cold network.
 *
 * Off by default, and that default is deliberate. Turning it on means corporate mail is
 * written to a file on this machine, which is a real decision with real consequences —
 * backup software, disk encryption, shared workstations — and it is not one to make on a
 * user's behalf. `cache enable` asks once, in plain language, and writes it here.
 */
export interface CacheConfig {
  readonly enabled?: boolean;
  /** Database file. Defaults to `snapshot.db` under the cache directory. */
  readonly path?: string;
  /**
   * Which backend to open the snapshot with. `auto` takes the best this platform can
   * load: the native libSQL client, else Node's built-in SQLite. Both store the same
   * schema in the same local file. See docs/ARCHITECTURE.md.
   */
  readonly driver?: 'auto' | 'libsql' | 'node-sqlite';
  /** How many items to keep per folder. The "n most recent"; everything older is evicted. */
  readonly recent?: number;
  /** Freshness window for a snapshot listing, in milliseconds. */
  readonly ttlMs?: number;
  /** Background sync period in milliseconds. Floors at 30s. */
  readonly intervalMs?: number;
  /** How deep below each mount root to sync. */
  readonly depth?: number;
  /** Message bodies to pre-download per folder per cycle. 0 disables body sync. */
  readonly bodies?: number;
  /** Build lexical embeddings for vector search. */
  readonly vectors?: boolean;
  /**
   * Predictive cache-ahead: warming mount roots at startup and likely next steps on
   * navigation.
   *
   * On by default, and *independent of {@link enabled}* — the snapshot decides whether
   * warmed results survive the process, not whether warming happens. Gating one on the
   * other meant a default install preloaded nothing at all, so every folder was a cold
   * round trip and the program appeared to stall on each keystroke.
   *
   * Costs bandwidth on a guess, so it remains switchable for a metered connection.
   */
  readonly prefetch?: boolean;
  /**
   * Speculative fetches in flight at once. Defaults to 1.
   *
   * This is less a throughput setting than a latency one: work already handed to a
   * provider cannot be recalled, so on a transport that serialises requests — MCP, which
   * is how the Graph mounts usually run — a foreground request waits behind everything
   * in flight. The worst case is this number multiplied by the provider's round trip.
   */
  readonly prefetchConcurrency?: number;
  /**
   * Record every provider fetch in an AgentFS `tool_calls` log. Off by default: it is a
   * write per fetch, and a program that reads your mail should not start keeping a record
   * of what it read without being told to.
   */
  readonly audit?: boolean;
}

export interface AppConfig {
  readonly plugins: readonly string[];
  readonly mounts: readonly MountConfig[];
  readonly queries: readonly SavedQueryConfig[];
  readonly watches: readonly WatchConfig[];
  readonly ui: UiConfig;
  readonly notifications: NotificationConfig;
  readonly cache: CacheConfig;
  readonly keymap: Readonly<Record<string, string>>;
  readonly ttlMs?: number;
  /** Where this config was loaded from; undefined when defaults were used. */
  readonly sourcePath?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  plugins: [],
  mounts: [],
  queries: [],
  watches: [],
  ui: {},
  notifications: {},
  cache: {},
  keymap: {},
};

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * Strip `//` and block comments and trailing commas, preserving string contents and
 * character offsets so that a JSON syntax error still points at the right place.
 */
export function stripJsonc(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';

  while (i < input.length) {
    const char = input[i] as string;
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (char === '\\') {
        // Copy the escaped character verbatim so `\"` does not end the string.
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      } else if (char === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') {
        // Preserve the byte count so error offsets remain meaningful.
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }

    out += char;
    i += 1;
  }

  // Trailing commas: a comma whose next non-whitespace character closes the container.
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

export function parseJsonc(text: string, sourcePath?: string): unknown {
  const stripped = stripJsonc(text);
  // An empty or comment-only file means "no configuration", not "corrupt file". People
  // comment their whole config out to test something, and getting "Unexpected end of JSON
  // input" for it is a needless dead end.
  if (stripped.trim() === '') return {};
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw VfsError.config(
      `Could not parse config${sourcePath === undefined ? '' : ` at ${sourcePath}`}: ${detail}`,
      'Comments and trailing commas are allowed; check for an unclosed brace, bracket or quote.',
    );
  }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface AppPaths {
  readonly configFile: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly stateDir: string;
  readonly notificationsFile: string;
  readonly logFile: string;
}

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AppPaths {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  // Join with the separator of the *target* platform, not the host's. Without this the
  // `platform` argument only half works — it picks the layout but writes host separators
  // into it — which makes the function impossible to test and its contract a lie.
  const join = platform === 'win32' ? win32Path.join : posixPath.join;

  const configDir =
    env['MSCOMMS_CONFIG_DIR'] ??
    (platform === 'win32'
      ? join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'mscomms')
      : join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'mscomms'));

  const dataDir =
    env['MSCOMMS_DATA_DIR'] ??
    (platform === 'win32'
      ? join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'mscomms')
      : join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'mscomms'));

  return {
    configDir,
    configFile: env['MSCOMMS_CONFIG'] ?? join(configDir, 'config.jsonc'),
    dataDir,
    // State is deliberately not under the cache directory. Sync cursors live in state, and
    // a cache-clearing script that wiped them would make the next poll report every
    // existing message as new.
    cacheDir: join(dataDir, 'cache'),
    stateDir: join(dataDir, 'state'),
    notificationsFile: join(dataDir, 'notifications.json'),
    logFile: join(dataDir, 'mscomms.log'),
  };
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

/**
 * Every setting the top level of a config file may contain.
 *
 * Kept next to {@link validateConfig} because the two must never drift: a key added to the
 * shape and forgotten here becomes an error message telling the user their own
 * documentation is wrong.
 */
const KNOWN_CONFIG_KEYS = new Set([
  'plugins',
  'mounts',
  'queries',
  'watches',
  'ui',
  'notifications',
  'cache',
  'keymap',
  'ttlMs',
  // Conventional no-ops, so a file can carry an editor schema reference or a note.
  '$schema',
  'comment',
]);

/**
 * The closest known key, when the user's key is plausibly a typo of it.
 *
 * Plain Levenshtein with a distance cap. The cap matters more than the algorithm: a
 * confident wrong suggestion ("did you mean 'ui'?" for "watchers") is worse than none.
 */
function nearestKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_CONFIG_KEYS) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const budget = Math.max(2, Math.floor(key.length / 3));
  return bestDistance <= budget ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] as number) + 1, (current[j - 1] as number) + 1);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

export async function loadConfig(
  filePath: string,
  options: { required?: boolean } = {},
): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (options.required === true) {
      throw VfsError.config(`Could not read config at ${filePath}.`, `Run \`mscomms init\` to create one. (${String(error)})`);
    }
    return DEFAULT_CONFIG;
  }
  return validateConfig(parseJsonc(text, filePath), filePath);
}

/**
 * Validate and normalize raw config.
 *
 * Every failure names the offending key and says what to do about it. Configuration
 * errors are the first thing a new user hits, and "unexpected token" is a terrible
 * welcome; a wrong mount path should read like a code review comment, not a stack trace.
 */
export function validateConfig(raw: unknown, sourcePath?: string): AppConfig {
  try {
    return validateConfigBody(raw, sourcePath);
  } catch (error) {
    // Every configuration error should say which file to open. The individual checks
    // report the offending key, which is the harder half; adding the filename here means
    // no check has to remember to.
    if (
      sourcePath !== undefined &&
      error instanceof VfsError &&
      error.code === 'ECONFIG' &&
      !error.message.includes(sourcePath)
    ) {
      throw VfsError.config(`${error.message} (in ${sourcePath})`, error.hint);
    }
    throw error;
  }
}

function validateConfigBody(raw: unknown, sourcePath?: string): AppConfig {
  const where = sourcePath === undefined ? '' : ` in ${sourcePath}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw VfsError.config(
      `Config${where} must be a JSON object.`,
      'The top level should look like: { "mounts": [ ... ] }',
    );
  }
  const root = raw as Record<string, unknown>;

  // Reject unknown top-level keys rather than ignoring them.
  //
  // Silently dropping a key the user believed in is the worst outcome available: someone
  // who writes "savedQueries" instead of "queries" gets no error, no queries, and no way
  // to tell the difference between "my config is wrong" and "this feature is broken". A
  // near-miss suggestion costs one line and saves an afternoon.
  for (const key of Object.keys(root)) {
    if (KNOWN_CONFIG_KEYS.has(key)) continue;
    const suggestion = nearestKey(key);
    throw VfsError.config(
      `Unknown setting "${key}"${where}.`,
      suggestion === undefined
        ? `Known settings are: ${[...KNOWN_CONFIG_KEYS].sort().join(', ')}.`
        : `Did you mean "${suggestion}"?`,
    );
  }

  const plugins = asStringArray(root['plugins'], 'plugins');
  const mounts = asArray(root['mounts'], 'mounts').map((entry, index) => validateMount(entry, index));

  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  for (const mount of mounts) {
    if (seenPaths.has(mount.path)) {
      throw VfsError.config(`Two mounts share the path "${mount.path}".`, 'Mount paths must be unique.');
    }
    seenPaths.add(mount.path);
    const id = mount.id ?? mount.path;
    if (seenIds.has(id)) {
      throw VfsError.config(`Two mounts share the id "${id}".`, 'Give one of them an explicit unique "id".');
    }
    seenIds.add(id);
  }

  const queries = asArray(root['queries'], 'queries').map((entry, index) => validateSavedQuery(entry, index));
  const watches = asArray(root['watches'], 'watches').map((entry, index) => validateWatch(entry, index));

  return {
    plugins,
    mounts,
    queries,
    watches,
    ui: asObject(root['ui'], 'ui') as UiConfig,
    notifications: asObject(root['notifications'], 'notifications') as NotificationConfig,
    cache: validateCache(root['cache']),
    keymap: asObject(root['keymap'], 'keymap') as Record<string, string>,
    ...(typeof root['ttlMs'] === 'number' ? { ttlMs: root['ttlMs'] } : {}),
    ...(sourcePath === undefined ? {} : { sourcePath }),
  };
}

const CACHE_DRIVERS = new Set(['auto', 'libsql', 'node-sqlite']);

/**
 * Settings that used to point the snapshot at a hosted database.
 *
 * These are rejected rather than ignored. `validateCache` builds its result from a list of
 * keys it knows, so an unrecognised one is dropped without a word — and "I configured
 * replication and it silently did nothing" is exactly the sort of quiet failure that
 * leaves somebody believing their mail is somewhere it is not.
 */
const REMOTE_KEYS = ['syncUrl', 'authToken', 'syncInterval', 'syncIntervalMs'] as const;

function validateCache(entry: unknown): CacheConfig {
  const raw = asObject(entry, 'cache') as Record<string, unknown>;

  const driver = raw['driver'];
  if (driver !== undefined && (typeof driver !== 'string' || !CACHE_DRIVERS.has(driver))) {
    throw VfsError.config(
      `cache.driver must be one of: ${[...CACHE_DRIVERS].join(', ')}.`,
      '"auto" picks the best backend this machine can load, and is almost always what you want.',
    );
  }

  for (const key of REMOTE_KEYS) {
    if (raw[key] === undefined) continue;
    throw VfsError.config(
      `cache.${key} is not supported: the snapshot is local to this machine.`,
      'It holds message bodies, so it is deliberately never replicated to a hosted database. ' +
        `Remove "${key}".`,
    );
  }

  const numbers = ['recent', 'ttlMs', 'intervalMs', 'depth', 'bodies', 'prefetchConcurrency'] as const;
  const out: Record<string, unknown> = {};
  for (const key of numbers) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw VfsError.config(`cache.${key} must be a number of 0 or more.`, `Got: ${JSON.stringify(value)}.`);
    }
    out[key] = value;
  }
  for (const key of ['enabled', 'vectors', 'prefetch', 'audit'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw VfsError.config(`cache.${key} must be true or false.`, `Got: ${JSON.stringify(value)}.`);
    }
    out[key] = value;
  }
  for (const key of ['path'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw VfsError.config(`cache.${key} must be a non-empty string.`, `Got: ${JSON.stringify(value)}.`);
    }
    out[key] = value;
  }
  if (typeof driver === 'string') out['driver'] = driver;

  return out as CacheConfig;
}

function validateMount(entry: unknown, index: number): MountConfig {
  const where = `mounts[${String(index)}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw VfsError.config(`${where} must be an object.`, 'Example: { "path": "/mail", "type": "graph-mail" }');
  }
  const record = entry as Record<string, unknown>;

  const rawPath = record['path'];
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw VfsError.config(`${where}.path is required.`, 'Example: "path": "/mail"');
  }
  const path = vpath.normalize(rawPath);
  if (!vpath.isAbsolute(path) || path === vpath.ROOT) {
    throw VfsError.config(
      `${where}.path must be an absolute path below the root, not "${rawPath}".`,
      'Use something like "/mail" or "/gh/myorg". "/" is reserved for the mount list itself.',
    );
  }

  const type = record['type'];
  if (typeof type !== 'string' || type.length === 0) {
    throw VfsError.config(`${where}.type is required.`, 'Run `mscomms plugins` to list the available provider types.');
  }

  return {
    path,
    type,
    ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
    ...(typeof record['options'] === 'object' && record['options'] !== null
      ? { options: record['options'] as Record<string, unknown> }
      : {}),
    ...(typeof record['ttlMs'] === 'number' ? { ttlMs: record['ttlMs'] } : {}),
    ...(typeof record['pageSize'] === 'number' ? { pageSize: record['pageSize'] } : {}),
  };
}

function validateSavedQuery(entry: unknown, index: number): SavedQueryConfig {
  const where = `queries[${String(index)}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw VfsError.config(`${where} must be an object.`, 'Example: { "name": "unread", "query": "is:unread" }');
  }
  const record = entry as Record<string, unknown>;
  const name = record['name'];
  const query = record['query'];
  if (typeof name !== 'string' || name.length === 0) {
    throw VfsError.config(`${where}.name is required.`, 'This becomes a directory under /q, so keep it short.');
  }
  if (typeof query !== 'string' || query.length === 0) {
    throw VfsError.config(`${where}.query is required.`, 'Example: "query": "is:unread from:alice"');
  }
  return {
    name,
    query,
    ...(Array.isArray(record['scope']) ? { scope: asStringArray(record['scope'], `${where}.scope`) } : {}),
    ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
  };
}

function validateWatch(entry: unknown, index: number): WatchConfig {
  const where = `watches[${String(index)}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw VfsError.config(`${where} must be an object.`, 'Example: { "id": "inbox", "path": "/mail/Inbox" }');
  }
  const record = entry as Record<string, unknown>;
  const id = record['id'];
  const path = record['path'];
  if (typeof id !== 'string' || id.length === 0) {
    throw VfsError.config(`${where}.id is required.`, 'Any short unique string, e.g. "inbox".');
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw VfsError.config(`${where}.path is required.`, 'Example: "path": "/mail/Inbox"');
  }
  const intervalMs = record['intervalMs'];
  if (intervalMs !== undefined) {
    // A zero or negative interval is a busy loop against someone's mail API. Rejecting it
    // costs one message; accepting it costs a rate-limit ban that looks like a bug in the
    // tool.
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 1000) {
      throw VfsError.config(
        `${where}.intervalMs must be at least 1000.`,
        'Polling faster than once a second will get you rate-limited. 60000 (one minute) is a sensible default.',
      );
    }
  }

  return {
    id,
    path: vpath.normalize(path),
    ...(typeof record['query'] === 'string' ? { query: record['query'] } : {}),
    ...(typeof intervalMs === 'number' ? { intervalMs } : {}),
    ...(typeof record['includeUpdates'] === 'boolean' ? { includeUpdates: record['includeUpdates'] } : {}),
    ...(typeof record['label'] === 'string' ? { label: record['label'] } : {}),
  };
}

function asArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw VfsError.config(`"${name}" must be an array.`);
  }
  return value;
}

function asStringArray(value: unknown, name: string): string[] {
  return asArray(value, name).map((entry, index) => {
    if (typeof entry !== 'string') {
      throw VfsError.config(`${name}[${String(index)}] must be a string.`);
    }
    return entry;
  });
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw VfsError.config(`"${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_REF = /^\$\{(env|file):([^}]+)\}$/;

/**
 * Resolve a secret reference.
 *
 * `${env:NAME}` reads the environment; `${file:/path}` reads a file (trimmed), which
 * suits `gh auth token > ~/.mscomms-token` style setups and Docker secrets. Anything else
 * is returned as a literal, so a user who really wants to inline a token can — but the
 * docs and the generated config only ever show the indirection.
 */
export async function resolveSecret(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const match = SECRET_REF.exec(reference.trim());
  if (match === null) return reference;

  const kind = match[1] as string;
  const target = (match[2] as string).trim();

  if (kind === 'env') {
    const value = env[target];
    return value === undefined || value.length === 0 ? undefined : value;
  }

  try {
    const expanded = target.startsWith('~')
      ? hostJoin(env['HOME'] ?? env['USERPROFILE'] ?? homedir(), target.slice(1))
      : hostIsAbsolute(target)
        ? target
        : hostResolve(target);
    return (await readFile(expanded, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** True when a config value is an unresolved indirection rather than a literal secret. */
export function isSecretRef(value: string): boolean {
  return SECRET_REF.test(value.trim());
}
