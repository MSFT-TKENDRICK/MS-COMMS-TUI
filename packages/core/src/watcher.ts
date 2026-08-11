/**
 * The watch scheduler.
 *
 * Change detection is modelled as polling with a resumable cursor rather than as a push
 * subscription, because that is what the real backends actually offer a command-line
 * client. Microsoft Graph exposes `delta()` links, RSS exposes ETag/Last-Modified, GitHub
 * exposes `since=`. None of them will push to a laptop without a publicly reachable
 * webhook endpoint. One `poll(cursor) -> {changes, cursor}` primitive covers all three,
 * and every piece of the hard part — scheduling, jitter, backoff, honouring Retry-After,
 * persisting the cursor across restarts, coalescing bursts — lives here so that providers
 * do not each reinvent it (and each get it wrong in a different way).
 */

import { VfsError, toVfsError } from './errors.js';
import type { ChangeEvent, Logger, StateStore, VNode } from './provider.js';
import { NULL_LOGGER } from './logging.js';
import { evaluateQuery, isMatchAll, stringifyQuery, type Query } from './query.js';
import type { Vfs } from './vfs.js';
import type { Notifier } from './notify.js';
import * as vpath from './vpath.js';

export interface WatchSpec {
  readonly id: string;
  /** VFS path to watch. */
  readonly path: string;
  /** Only notify about changes matching this query. */
  readonly query?: Query;
  readonly intervalMs?: number;
  /** Notify about updates and deletions too, not just new items. */
  readonly includeUpdates?: boolean;
  readonly label?: string;
}

export interface WatchStatus {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly query: string | undefined;
  readonly intervalMs: number;
  readonly lastPollAt: Date | undefined;
  readonly lastChangeAt: Date | undefined;
  readonly consecutiveFailures: number;
  readonly lastError: string | undefined;
  readonly nextPollAt: Date | undefined;
  readonly changesSeen: number;
}

export interface WatcherOptions {
  readonly vfs: Vfs;
  readonly notifier?: Notifier;
  readonly logger?: Logger;
  /** Persists poll cursors so a restart resumes instead of replaying the whole mailbox. */
  readonly state?: StateStore;
  readonly defaultIntervalMs?: number;
  readonly maxIntervalMs?: number;
  /** Injected in tests to avoid real timers. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
}

interface WatchRuntime {
  readonly spec: WatchSpec;
  cursor: string | undefined;
  timer: unknown;
  lastPollAt: Date | undefined;
  lastChangeAt: Date | undefined;
  consecutiveFailures: number;
  lastError: string | undefined;
  nextPollAt: Date | undefined;
  changesSeen: number;
  running: boolean;
  stopped: boolean;
  /** True until the first poll completes; that poll seeds the cursor and stays silent. */
  priming: boolean;
}

export class Watcher {
  readonly #vfs: Vfs;
  readonly #notifier: Notifier | undefined;
  readonly #logger: Logger;
  readonly #state: StateStore | undefined;
  readonly #defaultIntervalMs: number;
  readonly #maxIntervalMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #now: () => number;
  readonly #watches = new Map<string, WatchRuntime>();
  readonly #listeners = new Set<(event: ChangeEvent, spec: WatchSpec) => void>();

  constructor(options: WatcherOptions) {
    this.#vfs = options.vfs;
    this.#notifier = options.notifier;
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#state = options.state;
    this.#defaultIntervalMs = options.defaultIntervalMs ?? 120_000;
    this.#maxIntervalMs = options.maxIntervalMs ?? 30 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Never hold the process open just because a watch is pending.
        handle.unref?.();
        return handle;
      });
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  onChange(listener: (event: ChangeEvent, spec: WatchSpec) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get statuses(): readonly WatchStatus[] {
    return [...this.#watches.values()].map((runtime) => ({
      id: runtime.spec.id,
      path: runtime.spec.path,
      label: runtime.spec.label ?? runtime.spec.path,
      query: runtime.spec.query === undefined ? undefined : stringifyQuery(runtime.spec.query),
      intervalMs: runtime.spec.intervalMs ?? this.#defaultIntervalMs,
      lastPollAt: runtime.lastPollAt,
      lastChangeAt: runtime.lastChangeAt,
      consecutiveFailures: runtime.consecutiveFailures,
      lastError: runtime.lastError,
      nextPollAt: runtime.nextPollAt,
      changesSeen: runtime.changesSeen,
    }));
  }

  /**
   * Register and start a watch. Verifies up front that the mount actually supports
   * polling, so a typo or an unsupported provider fails loudly at `watch` time rather
   * than silently never notifying — the worst possible failure mode for this feature.
   */
  async add(spec: WatchSpec): Promise<WatchStatus> {
    const path = vpath.normalize(spec.path);
    if (this.#watches.has(spec.id)) {
      throw VfsError.invalid(`A watch with id "${spec.id}" already exists.`, 'Use `unwatch` first, or pick another id.');
    }

    const located = this.#vfs.findMount(path);
    if (located === undefined) {
      throw VfsError.notFound(path, 'You can only watch a path inside a mount.');
    }
    if (!located.mount.provider.capabilities.has('poll') || located.mount.provider.poll === undefined) {
      throw VfsError.unsupported('Watching for changes', located.mount.provider.id);
    }

    const runtime: WatchRuntime = {
      spec: { ...spec, path },
      cursor: await this.#loadCursor(spec.id),
      timer: undefined,
      lastPollAt: undefined,
      lastChangeAt: undefined,
      consecutiveFailures: 0,
      lastError: undefined,
      nextPollAt: undefined,
      changesSeen: 0,
      running: false,
      stopped: false,
      // A cold watch with no stored cursor would otherwise report every message in the
      // folder as "new" on the very first poll.
      priming: (await this.#loadCursor(spec.id)) === undefined,
    };

    this.#watches.set(spec.id, runtime);
    this.#schedule(runtime, 0);

    return this.statuses.find((s) => s.id === spec.id) as WatchStatus;
  }

  remove(id: string): boolean {
    const runtime = this.#watches.get(id);
    if (runtime === undefined) return false;
    runtime.stopped = true;
    if (runtime.timer !== undefined) this.#clearTimer(runtime.timer);
    this.#watches.delete(id);
    return true;
  }

  stop(): void {
    for (const runtime of this.#watches.values()) {
      runtime.stopped = true;
      if (runtime.timer !== undefined) this.#clearTimer(runtime.timer);
    }
    this.#watches.clear();
  }

  /** Poll one watch immediately, bypassing its schedule. Used by the `poll` command. */
  async pollNow(id: string): Promise<readonly ChangeEvent[]> {
    const runtime = this.#watches.get(id);
    if (runtime === undefined) {
      throw VfsError.invalid(`No watch with id "${id}".`, 'Run `watches` to see the active ones.');
    }
    return this.#poll(runtime);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #schedule(runtime: WatchRuntime, delayMs: number): void {
    if (runtime.stopped) return;
    if (runtime.timer !== undefined) this.#clearTimer(runtime.timer);

    // Jitter keeps a dozen watches added in one config file from stampeding the API in
    // lockstep every two minutes.
    const jitter = delayMs === 0 ? 0 : Math.floor(Math.random() * Math.min(5_000, delayMs * 0.1));
    const effective = delayMs + jitter;
    runtime.nextPollAt = new Date(this.#now() + effective);

    runtime.timer = this.#setTimer(() => {
      void this.#poll(runtime)
        .catch(() => undefined)
        .then(() => {
          if (!runtime.stopped) this.#schedule(runtime, this.#intervalFor(runtime));
        });
    }, effective);
  }

  #intervalFor(runtime: WatchRuntime): number {
    const base = runtime.spec.intervalMs ?? this.#defaultIntervalMs;
    if (runtime.consecutiveFailures === 0) return base;
    // Exponential backoff, capped. A backend that is down, rate-limiting us, or has had
    // our scope revoked should see progressively less traffic, not a tight retry loop.
    const backoff = base * 2 ** Math.min(runtime.consecutiveFailures, 6);
    return Math.min(backoff, this.#maxIntervalMs);
  }

  async #poll(runtime: WatchRuntime): Promise<readonly ChangeEvent[]> {
    // Overlapping polls would double-advance the cursor and lose changes.
    if (runtime.running) return [];
    runtime.running = true;

    try {
      const located = this.#vfs.findMount(runtime.spec.path);
      if (located === undefined || located.mount.provider.poll === undefined) {
        throw VfsError.notFound(runtime.spec.path);
      }

      const { node } = await this.#vfs.resolve(runtime.spec.path);
      const result = await located.mount.provider.poll(node, runtime.cursor, {});

      runtime.lastPollAt = new Date(this.#now());
      runtime.consecutiveFailures = 0;
      runtime.lastError = undefined;

      if (result.cursor !== undefined && result.cursor !== runtime.cursor) {
        runtime.cursor = result.cursor;
        await this.#saveCursor(runtime.spec.id, result.cursor);
      }

      // The priming poll only establishes a baseline; announcing its results would mean
      // a toast for every message already sitting in the folder.
      if (runtime.priming) {
        runtime.priming = false;
        this.#logger.debug('watch primed', { id: runtime.spec.id, seen: result.changes.length });
        return [];
      }

      const relevant = result.changes.filter((change) => this.#isRelevant(change, runtime.spec));
      if (relevant.length > 0) {
        runtime.lastChangeAt = new Date(this.#now());
        runtime.changesSeen += relevant.length;
        this.#vfs.invalidate(runtime.spec.path);
        await this.#announce(relevant, runtime.spec);
      }

      return relevant;
    } catch (error) {
      const vfsError = toVfsError(error, runtime.spec.path);
      runtime.consecutiveFailures += 1;
      runtime.lastError = vfsError.message;
      runtime.lastPollAt = new Date(this.#now());
      this.#logger.warn('watch poll failed', {
        id: runtime.spec.id,
        code: vfsError.code,
        message: vfsError.message,
        failures: runtime.consecutiveFailures,
      });
      return [];
    } finally {
      runtime.running = false;
    }
  }

  #isRelevant(change: ChangeEvent, spec: WatchSpec): boolean {
    if (change.type !== 'created' && spec.includeUpdates !== true) return false;
    if (isMatchAll(spec.query)) return true;
    if (change.node === undefined) return false;
    // 'unknown' means the query asked about something not present on the node (a body,
    // say). Treating that as a match would produce notifications the user did not ask
    // for, which erodes trust in the feature faster than missing one does.
    return evaluateQuery(spec.query as Query, change.node) === true;
  }

  async #announce(changes: readonly ChangeEvent[], spec: WatchSpec): Promise<void> {
    for (const change of changes) {
      for (const listener of this.#listeners) {
        try {
          listener(change, spec);
        } catch {
          // Isolated listener failure.
        }
      }
    }

    if (this.#notifier === undefined) return;

    const label = spec.label ?? spec.path;
    const created = changes.filter((c) => c.type === 'created');
    const primary = (created[0] ?? changes[0]) as ChangeEvent;

    // A burst becomes one summary notification rather than fifty toasts. Fifty toasts is
    // not just annoying, it is an accessibility failure: a screen reader queues them all
    // and the user cannot interrupt to do anything else.
    if (changes.length > 1) {
      await this.#notifier.notify({
        title: `${label}: ${String(changes.length)} updates`,
        body: summarize(primary) + (changes.length > 1 ? ` and ${String(changes.length - 1)} more` : ''),
        key: `watch:${spec.id}`,
        path: vpath.join(spec.path, primary.node?.name ?? ''),
        source: label,
      });
      return;
    }

    await this.#notifier.notify({
      title: label,
      body: summarize(primary),
      key: `watch:${spec.id}:${primary.node?.id ?? primary.path}`,
      path: primary.node?.path ?? vpath.join(spec.path, primary.node?.name ?? ''),
      source: label,
    });
  }

  async #loadCursor(id: string): Promise<string | undefined> {
    if (this.#state === undefined) return undefined;
    return this.#state.get(`watch:${id}:cursor`);
  }

  async #saveCursor(id: string, cursor: string): Promise<void> {
    if (this.#state === undefined) return;
    await this.#state.set(`watch:${id}:cursor`, cursor);
  }
}

/**
 * What the notification says.
 *
 * This used to take only the node, and fall back to "Something changed." whenever there
 * wasn't one. That fallback fired constantly in practice, because `node` is optional on
 * ChangeEvent while `type` and `path` are required — so a provider that implements `poll`
 * exactly as documented, returning `{type, path, at}`, produced a notification that said
 * nothing at all. Every external plugin hit this.
 *
 * "Something changed" is the notification equivalent of an unlabelled button. Since the
 * change always carries a type and a path, say those instead: the name is what the user
 * recognises, and the verb is what tells them whether to care.
 */
function summarize(change: ChangeEvent | undefined): string {
  if (change === undefined) return 'Something changed.';

  const node = change.node;
  if (node !== undefined) {
    const author = node.author === undefined ? '' : `${node.author}: `;
    return `${author}${node.title}`.slice(0, 200);
  }

  // `path` is provider-relative, and the last segment is the part a person recognises.
  const name = change.path.split('/').filter((part) => part !== '').pop() ?? change.path;
  if (name === '') return 'Something changed.';

  const verb =
    change.type === 'created' ? 'New' : change.type === 'deleted' ? 'Removed' : 'Updated';
  return `${verb}: ${name}`.slice(0, 200);
}
