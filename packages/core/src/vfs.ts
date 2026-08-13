/**
 * The virtual filesystem engine.
 *
 * Responsibilities that live HERE rather than in providers:
 *   - the mount table, including synthetic intermediate directories
 *   - resolving a textual path to a node, by walking and caching directory listings
 *   - allocating stable, unique display names within a directory
 *   - paging, and remembering where each directory got to
 *   - applying whatever part of a query the provider could not apply itself
 *   - serving stale cached data when the network or the vendor's API goes away
 *
 * Concentrating all of this in one place is what keeps the provider contract small enough
 * that writing a new backend is an afternoon's work rather than a project.
 */

import { TtlCache, type CacheStats } from './cache.js';
import { VfsError, toVfsError } from './errors.js';
import { GraphSpace, treeGraphSource, type GraphSourceEntry } from './graph.js';
import { NULL_LOGGER } from './logging.js';
import { NameAllocator, sanitizeSegment } from './naming.js';
import {
  NavigationPredictor,
  PREFETCH_PRIORITY,
  PrefetchQueue,
  rankWarmCandidates,
  type PredictorOptions,
  type PrefetchStats,
} from './prefetch.js';
import {
  evaluateQuery,
  isMatchAll,
  requiresContent,
  scoreQuery,
  stringifyQuery,
  type Query,
} from './query.js';
import type { SnapshotHit, SnapshotStore } from './snapshot.js';
import type {
  ActionDescriptor,
  ActionResult,
  Capability,
  Document,
  ListOptions,
  ListPage,
  Logger,
  MetaValue,
  Provider,
  ReadOptions,
  SortSpec,
  VNode,
} from './provider.js';
import * as vpath from './vpath.js';

export interface Mount {
  /** Absolute VFS path this provider is attached to, e.g. `/mail`. */
  readonly path: string;
  /** Stable identifier used for state files and cache namespacing. */
  readonly id: string;
  readonly provider: Provider;
  /** Cache lifetime for listings from this mount. */
  readonly ttlMs?: number;
  /** Default page size for listings from this mount. */
  readonly pageSize?: number;
  /** Human description shown by the `mounts` command. */
  readonly description?: string;
}

/**
 * The accumulated, ordered view of one directory.
 *
 * Two properties matter and are easy to get wrong:
 *
 * `byId` makes display names STABLE. A name is allocated once per node id and then
 * reused forever, so a node keeps the same name whether it was reached through a plain
 * listing or a filtered one. Without this, a deduplicating `~2` suffix would attach to
 * whichever of two identically-named messages happened to arrive first in a given query,
 * and `cat "Budget~2.eml"` would refer to different messages on different days.
 *
 * `order` accumulates across pages, so paging deeper never renumbers what the user has
 * already been shown — the entry they heard announced as "7" is still 7 after `more`.
 */
interface DirectoryIndex {
  readonly byName: Map<string, VNode>;
  readonly byId: Map<string, string>;
  readonly order: string[];
  readonly allocator: NameAllocator;
  cursor: string | undefined;
  complete: boolean;
  total: number | undefined;
  fetchedAt: number;
}

/**
 * Anything that identifies a place in the tree.
 *
 * Passing the `VNode` is always preferable when you have one: it is exact, it needs no
 * lookup, and it cannot be spoiled by the display name having been sanitized or
 * deduplicated on its way to the screen.
 */
export type VfsTarget = string | VNode;

export interface VfsListResult extends ListPage {
  /** The directory that was listed. */
  readonly path: string;
  /** Entries the query could not decide without fetching item bodies. */
  readonly undecided: number;
  /** True when served from cache after a failed refresh. */
  readonly stale: boolean;
  readonly staleAgeMs?: number;
  /**
   * Folders skipped during a walked search because they could not be read.
   *
   * A walk must not abort because one subtree is unreadable — a revoked scope on one
   * folder should not cost you the other nine. But swallowing the failure entirely makes
   * "nothing matched" and "I could not look" render identically, so the count comes back
   * and the caller is expected to say so.
   */
  readonly unreadable?: number;
  /** The first failure encountered while walking, when `unreadable` is set. */
  readonly unreadableError?: string;
  /**
   * One entry per source consulted, present only for a cross-source search.
   *
   * A search that spans several backends is a search that can be *partly* wrong: one
   * tenant revokes a scope, one feed times out, one repository rate-limits. Returning the
   * surviving results with no word about the rest turns "your mail is not there" and "I
   * could not look" into the same answer, which is the single most damaging thing a
   * search tool can do. So every source reports back, including the ones that failed.
   */
  readonly sources?: readonly SearchSourceReport[];
  /** True when entries are ordered by relevance rather than by the provider's order. */
  readonly ranked?: boolean;
}

/** What one source did during a cross-source search. */
export interface SearchSourceReport {
  /** The mount's stable id, as used by `--source`. */
  readonly id: string;
  readonly path: string;
  readonly provider: string;
  /**
   * What became of this source.
   *
   * 'ok' — it answered in full. 'partial' — it answered, but some folders under it could
   * not be read, so the absence of a result there means nothing. 'failed' — it errored.
   * 'timeout' — it did not answer in time. The last three are all reported to the user by
   * name, because a search that quietly drops a source teaches you to trust an answer
   * that was never complete.
   */
  readonly status: 'ok' | 'partial' | 'failed' | 'timeout';
  /** True when the source's own index answered, rather than the engine walking it. */
  readonly native: boolean;
  readonly matches: number;
  readonly durationMs: number;
  /** True when this source had more to give and was cut off by the budget. */
  readonly truncated: boolean;
  /** Entries this source could not decide without fetching bodies. */
  readonly undecided: number;
  readonly error?: string;
}

export interface SearchOptions extends ListOptions {
  /** Cap on nodes visited when a source has no index and must be walked. */
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  /**
   * Restrict a cross-source search to these sources, named by mount id or mount path.
   * Supplying it forces a cross-source search even from inside a single mount.
   */
  readonly sources?: readonly string[];
  /**
   * How long any one source gets before the others are reported without it. Default
   * 15 seconds; 0 waits indefinitely.
   */
  readonly sourceTimeoutMs?: number;
  /** How many sources to query at once. Default 6. */
  readonly concurrency?: number;
  /**
   * Order merged results by relevance. Defaults to true for a real query, because there
   * is no meaningful common order across four different backends otherwise. Ignored when
   * an explicit `sort` is given.
   */
  readonly rank?: boolean;
  /**
   * Answer from the local snapshot alone, without asking any provider.
   *
   * Instant, and correct about everything it holds — which is the recent past, not the
   * archive. The result says so: the snapshot reports as a source with `truncated` set,
   * so "nothing found locally" never renders as "nothing exists".
   */
  readonly local?: boolean;
  /**
   * Include vector nearest-neighbours from the snapshot as search candidates.
   * Defaults to true when a snapshot is configured.
   */
  readonly semantic?: boolean;
}

export interface PrefetchOptions extends PredictorOptions {
  readonly enabled?: boolean;
  /** Speculative fetches in flight at once. Small on purpose; see ./prefetch.js. */
  readonly concurrency?: number;
  /** Entries fetched per speculative listing. Smaller than a real page — it is a guess. */
  readonly pageSize?: number;
}

/**
 * A listing that has been superseded since it was served.
 *
 * Delivered to {@link Vfs.onListingChanged} subscribers when a stale answer served from the
 * local snapshot has been corrected against the source.
 */
export interface ListingChanged {
  readonly path: string;
  /** The full merged listing, ready to display — not a delta. */
  readonly entries: readonly VNode[];
  readonly total?: number;
}


export interface VfsOptions {
  readonly ttlMs?: number;
  readonly pageSize?: number;
  readonly maxCacheEntries?: number;
  readonly now?: () => number;
  /**
   * When true (the default), a failed refresh falls back to expired cache rather than
   * surfacing an error. This is what keeps the tool usable on a plane, on hotel wifi,
   * and on the day the vendor changes their API.
   */
  readonly serveStaleOnError?: boolean;
  /**
   * Local libSQL/Turso snapshot. Absent means the engine behaves exactly as it did
   * before one existed — in-memory caching only, every cold start a cold start.
   */
  readonly snapshot?: SnapshotStore;
  /** Predictive cache-ahead. Requires a snapshot to be worth anything, but works without. */
  readonly prefetch?: PrefetchOptions;
  readonly logger?: Logger;
}

/**
 * Directories per mount root that {@link Vfs.warm} follows into at startup.
 *
 * Four rather than "all of them": the point is to cover the handful of places a user
 * plausibly opens first, not to mirror the source. Warming is spending the user's rate
 * limit on a guess, and the odds fall off a cliff past the first few entries.
 */
const WARM_CHILDREN = 4;

/**
 * How far {@link Vfs.#rollUpUnread} will walk the cache to total up a folder.
 *
 * A mount root is depth 1 from the synthetic root and its folders are depth 2, which covers
 * every shape in the tool today. The bound is here because the graph is genuinely cyclic —
 * a person's `reports/` contains their manager, whose `reports/` contains them — so a walk
 * with no limit is a hang, and it would be one on the render path of the first thing a user
 * ever types.
 */
const UNREAD_ROLLUP_DEPTH = 4;

/**
 * Directories whose last-shown counters are remembered, to tell a real change from a repeat.
 *
 * One short string per directory, so this is a guard against a long session accumulating
 * state without bound rather than a meaningful memory cost.
 */
const MAX_UNREAD_MEMORY = 1024;

export class Vfs {
  readonly #mounts = new Map<string, Mount>();
  readonly #dirCache: TtlCache<DirectoryIndex>;
  readonly #docCache: TtlCache<Document>;
  readonly #defaultPageSize: number;
  readonly #serveStaleOnError: boolean;
  readonly #now: () => number;
  readonly #logger: Logger;
  /**
   * Requests currently in flight, so that arriving mid-prefetch means waiting for the
   * remainder rather than starting again. See {@link Vfs.#coalesce}.
   */
  readonly #inflight = new Map<
    string,
    { promise: Promise<ListPage>; controller: AbortController; callers: number }
  >();
  /** Subscribers to {@link Vfs.onListingChanged}. */
  readonly #listingListeners = new Set<(event: ListingChanged) => void>();

  /**
   * Path → the counters last shown for it, so {@link Vfs.#announceIfUnreadMoved} can tell a
   * genuine change from re-deriving the same answer.
   */
  readonly #announcedUnread = new Map<string, string>();

  #snapshot: SnapshotStore | undefined;
  #prefetchQueue: PrefetchQueue | undefined;
  #predictor: NavigationPredictor | undefined;
  #prefetchOptions: PrefetchOptions;
  /**
   * Snapshot writes, chained.
   *
   * Recording a listing must never make `ls` slower, so every write is fired and not
   * awaited. But "fired and forgotten" is untestable and makes shutdown a race, so the
   * tail is retained and exposed as {@link flush}. Serialising them also keeps SQLite off
   * the write-contention path, which matters because the background sync is writing too.
   */
  #writes: Promise<void> = Promise.resolve();
  #lastListedPath: string | undefined;

  constructor(options: VfsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#defaultPageSize = options.pageSize ?? 50;
    this.#serveStaleOnError = options.serveStaleOnError ?? true;
    this.#logger = options.logger ?? NULL_LOGGER;
    const cacheOptions = {
      ttlMs: options.ttlMs ?? 60_000,
      maxEntries: options.maxCacheEntries ?? 2_000,
      now: this.#now,
    };
    this.#dirCache = new TtlCache<DirectoryIndex>(cacheOptions);
    this.#docCache = new TtlCache<Document>({ ...cacheOptions, ttlMs: 5 * 60_000 });

    this.#snapshot = options.snapshot;
    this.#prefetchOptions = options.prefetch ?? {};
    if (this.#prefetchOptions.enabled === true) {
      this.#prefetchQueue = new PrefetchQueue({
        ...(this.#prefetchOptions.concurrency === undefined ? {} : { concurrency: this.#prefetchOptions.concurrency }),
        logger: this.#logger.child('prefetch'),
      });
      this.#predictor = new NavigationPredictor(this.#prefetchOptions);
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot and prefetch
  // -------------------------------------------------------------------------

  get snapshot(): SnapshotStore | undefined {
    return this.#snapshot;
  }

  /**
   * Attach a snapshot after construction.
   *
   * Opening a database is I/O, and the engine is constructed synchronously by callers who
   * then hand it to a shell, a watcher and a completer before anything has been awaited.
   * Rather than make every one of those wait for a disk file that may not even be enabled,
   * the engine starts fully functional without a snapshot and gains one when it is ready —
   * which is also exactly what happens when the user runs `cache enable` mid-session.
   */
  attachSnapshot(snapshot: SnapshotStore, prefetch: PrefetchOptions = {}): void {
    this.#snapshot = snapshot;
    this.#prefetchOptions = prefetch;
    if (prefetch.enabled === true && this.#prefetchQueue === undefined) {
      this.#prefetchQueue = new PrefetchQueue({
        ...(prefetch.concurrency === undefined ? {} : { concurrency: prefetch.concurrency }),
        logger: this.#logger.child('prefetch'),
      });
      this.#predictor = new NavigationPredictor(prefetch);
    }
  }

  /** Detach and stop using the snapshot. Speculative work aimed at it is abandoned. */
  detachSnapshot(): void {
    this.#prefetchQueue?.cancel({ includeRunning: true });
    this.#snapshot = undefined;
  }

  get prefetchStats(): PrefetchStats | undefined {
    return this.#prefetchQueue?.stats;
  }

  /**
   * Recover a previous session's navigation history so the first command is already warm.
   *
   * Separate from the constructor because it is I/O, and because a predictor that has not
   * loaded yet is merely less clever rather than broken — there is nothing to await for
   * correctness, only for quality of guessing.
   */
  async warmPredictor(): Promise<void> {
    if (this.#snapshot === undefined || this.#predictor === undefined) return;
    const history = await this.#snapshot.navigationHistory().catch(() => []);
    if (history.length === 0) return;
    for (const entry of history) this.#predictor.learn(entry.from, entry.to, entry.count);
  }

  /** Settle outstanding snapshot writes and speculative fetches. Tests and shutdown. */
  async flush(): Promise<void> {
    await this.#prefetchQueue?.idle();
    await this.#writes;
  }

  /**
   * Give up on every speculative fetch, immediately.
   *
   * Prefetching is a bet that the user is about to want something. On the way out they
   * demonstrably are not, so shutdown calls this before flushing. Without it, `flush()`
   * waits for the prefetch queue to go *idle* — which means quitting blocks on guesses
   * nobody will ever collect, each able to sit on a provider request until it times out.
   * That is the same "quitting hangs" symptom as the MCP shutdown bug, arriving from a
   * different direction, and it lands on one-shot commands too.
   */
  cancelSpeculative(): void {
    this.#prefetchQueue?.cancel({ includeRunning: true });
  }

  /**
   * Be told when a listing already handed out has been superseded.
   *
   * Reading is deliberately staged: an answer from the local snapshot arrives in
   * milliseconds and may be minutes old, and the fresh one arrives when the network says
   * so. Serving the stale page immediately is the right trade — but only if the correction
   * eventually reaches the screen. Without this, {@link #refreshInBackground} quietly fixed
   * the cache while the user carried on reading the old list, and only found out by
   * pressing refresh, which is precisely the thing they should never have to do.
   *
   * Handlers are called with the *merged* entries, so a caller can redraw directly. They
   * fire only for a genuine correction, never for a listing the caller just requested.
   *
   * Returns an unsubscribe function. Handlers are isolated from each other and from the
   * refresh: one that throws is ignored, because a redraw failing must not abandon the
   * cache update or the other subscribers.
   */
  onListingChanged(handler: (event: ListingChanged) => void): () => void {
    this.#listingListeners.add(handler);
    return () => {
      this.#listingListeners.delete(handler);
    };
  }

  #announce(path: string, entries: readonly VNode[], total: number | undefined): void {
    if (this.#listingListeners.size === 0) return;
    const event: ListingChanged = { path, entries, ...(total === undefined ? {} : { total }) };
    for (const handler of [...this.#listingListeners]) {
      try {
        handler(event);
      } catch {
        // A subscriber's problem is not the cache's problem.
      }
    }
  }

  /**
   * Get everything expensive out of the way before the user asks for anything.
   *
   * Two distinct costs, and they need different treatment:
   *
   * **Connecting.** A provider's first request can carry a large fixed setup cost — the
   * Graph providers spend about seven seconds starting an MCP server, against a quarter of
   * a second for the request itself. Paid lazily that lands on whichever command the user
   * typed first, which is why the tool felt like it hung. These run in parallel and are
   * awaited, because there is nothing to interleave them with and every mount pays its own
   * cost concurrently.
   *
   * **Listing.** Mount roots go through the prefetch queue rather than being fetched here,
   * so they inherit its bounds, its deduplication and — the important part — its
   * cancellation. The moment the user navigates somewhere real, speculation about the roots
   * is dropped rather than competing with them for the same rate limit.
   *
   * Never throws. Warming is an optimisation, and a session that refuses to start because
   * a speculative listing failed would be a worse tool than one that is merely slower.
   */
  async warm(options: { signal?: AbortSignal } = {}): Promise<void> {
    const mounts = [...this.#mounts.values()];

    const connected = Promise.all(
      mounts.map(async (mount) => {
        try {
          await mount.provider.warm?.(options.signal);
        } catch (error) {
          this.#logger.debug('Provider could not be warmed.', {
            mount: mount.id,
            error: String(error),
          });
        }
      }),
    );

    // Stop *waiting* on abort rather than merely declining to continue afterwards.
    //
    // Connecting is the slow part — about seven seconds for the Graph transport — and a
    // provider is under no obligation to honour the signal, so awaiting the handshake and
    // checking the flag afterwards means shutdown still blocks for the full seven seconds.
    // That is exactly what quitting during startup used to do. Whoever aborted is tearing
    // the session down and will close the transport underneath this anyway.
    if (options.signal !== undefined) {
      const signal = options.signal;
      let onAbort: (() => void) | undefined;
      const abandoned = new Promise<'abandoned'>((resolve) => {
        if (signal.aborted) {
          resolve('abandoned');
          return;
        }
        onAbort = () => resolve('abandoned');
        signal.addEventListener('abort', onAbort, { once: true });
      });
      // Neither branch rejects, so the loser is safe to leave unobserved.
      const outcome = await Promise.race([connected.then(() => 'connected' as const), abandoned]);
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      if (outcome === 'abandoned') return;
    } else {
      await connected;
    }

    if (options.signal?.aborted === true) return;

    const queue = this.#prefetchQueue;
    if (queue === undefined) return;
    const pageSize = this.#prefetchOptions.pageSize ?? 25;

    for (const mount of mounts) {
      queue.schedule({
        key: `warm:${mount.path}`,
        priority: PREFETCH_PRIORITY.warm,
        path: mount.path,
        run: async (signal) => {
          const result = await this.list(mount.path, { signal, limit: pageSize, speculative: true });
          // One level further, because for most sources the root is a menu rather than a
          // destination: `/mail` is a list of folders and nobody is reading it, they are on
          // their way to Inbox. Stopping at the root would warm the one listing the user
          // spends no time on and leave the one they actually want cold.
          //
          // Bounded to a handful, not `entries.length`, because warming is a bet placed
          // with the user's rate limit and a mailbox with sixty folders would spend all of
          // it here. Which handful is chosen matters as much as the bound — see
          // `rankWarmCandidates`, which exists because listing order picked three empty
          // folders and missed the Inbox.
          for (const child of rankWarmCandidates(result.entries, WARM_CHILDREN)) {
            const path = child.path ?? vpath.join(mount.path, child.name);
            queue.schedule({
              key: `warm:${path}`,
              priority: PREFETCH_PRIORITY.warm,
              path,
              run: async (childSignal) => {
                await this.list(path, { signal: childSignal, limit: pageSize, speculative: true });
              },
            });
          }
        },
      });
    }
  }

  /** Queue a snapshot write without making the caller wait for it. */
  #record(work: () => Promise<void>): void {
    if (this.#snapshot === undefined) return;
    this.#writes = this.#writes.then(work).catch((error: unknown) => {
      // The snapshot is an accelerator. A cache that cannot be written is a slower tool,
      // not a broken one, and turning a disk-full into a failed `ls` would be a poor trade.
      this.#logger.debug('Snapshot write failed.', { error: String(error) });
    });
  }


  // -------------------------------------------------------------------------
  // Mount table
  // -------------------------------------------------------------------------

  mount(mount: Mount): void {
    const path = vpath.normalize(mount.path);
    if (path === vpath.ROOT) {
      throw VfsError.config(
        'Cannot mount a provider at "/".',
        'The root is synthetic and lists your mounts. Mount at /mail, /teams, /gh and so on.',
      );
    }
    if (this.#mounts.has(path)) {
      throw VfsError.config(
        `Another provider is already mounted at "${path}".`,
        'Give this mount a different path, or remove the duplicate from your config.',
      );
    }
    this.#mounts.set(path, { ...mount, path });
  }

  async unmount(path: string): Promise<boolean> {
    const normalized = vpath.normalize(path);
    const mount = this.#mounts.get(normalized);
    if (mount === undefined) return false;
    this.#mounts.delete(normalized);
    this.invalidate(normalized);
    await mount.provider.dispose?.();
    return true;
  }

  get mounts(): readonly Mount[] {
    return [...this.#mounts.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The mount owning `path`, using longest-prefix matching. */
  findMount(path: string): { mount: Mount; relative: string[] } | undefined {
    const normalized = vpath.normalize(path);
    let best: Mount | undefined;
    for (const mount of this.#mounts.values()) {
      if (!vpath.contains(mount.path, normalized)) continue;
      if (best === undefined || vpath.depth(mount.path) > vpath.depth(best.path)) best = mount;
    }
    if (best === undefined) return undefined;
    const rel = vpath.relative(best.path, normalized) ?? '';
    return { mount: best, relative: vpath.segments(rel) };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#mounts.values()].map((m) => m.provider.dispose?.()));
    this.#mounts.clear();
    this.#dirCache.clear();
    this.#docCache.clear();
  }

  // -------------------------------------------------------------------------
  // Graph view
  // -------------------------------------------------------------------------

  /**
   * Every mount, as one graph.
   *
   * Built fresh on each call rather than cached, so a mount added mid-session is
   * projectable without a restart, and a mount that has gone away stops appearing.
   *
   * A provider that declares `graph` supplies its own typed nodes and edges. Everything
   * else is wrapped in {@link treeGraphSource}, which exposes exactly the graph its tree
   * already implies. That fallback is what makes "write a projection over all your
   * sources" true of sources whose authors never heard of projections — including
   * `exec` plugins written in Python.
   */
  graphSpace(): GraphSpace {
    const entries: GraphSourceEntry[] = [];
    for (const mount of this.mounts) {
      const declared =
        mount.provider.capabilities.has('graph') && mount.provider.graph !== undefined
          ? mount.provider.graph
          : undefined;
      entries.push({
        alias: mount.id,
        mountId: mount.id,
        mountPath: mount.path,
        source:
          declared ??
          treeGraphSource(
            this,
            {
              id: mount.id,
              path: mount.path,
              ...(mount.description === undefined ? {} : { description: mount.description }),
            },
            { supportsSearch: mount.provider.capabilities.has('search') },
          ),
      });
    }
    return new GraphSpace(entries);
  }

  // -------------------------------------------------------------------------
  // Cache control
  // -------------------------------------------------------------------------

  /** Drop cached listings and documents at or beneath `path`. */
  invalidate(path: string): void {
    const normalized = vpath.normalize(path);
    // Speculative work aimed at the place being invalidated is now fetching what we have
    // just decided we do not trust; killing it also stops it re-populating the snapshot
    // from behind with the very rows being cleared.
    this.#prefetchQueue?.cancel({ includeRunning: true });
    this.#record(async () => {
      await (this.#snapshot as SnapshotStore).invalidate(normalized);
    });
    if (normalized === vpath.ROOT) {
      this.#dirCache.clear();
      this.#docCache.clear();
      this.#announcedUnread.clear();
      return;
    }
    this.#dirCache.delete(normalized);
    this.#dirCache.invalidatePrefix(normalized);
    this.#docCache.delete(normalized);
    this.#docCache.invalidatePrefix(normalized);
    // Forget the counters shown for anything cleared, so the listing that replaces it is
    // compared against what is on screen rather than against a discarded answer.
    for (const key of [...this.#announcedUnread.keys()]) {
      if (key === normalized || key.startsWith(`${normalized}/`)) this.#announcedUnread.delete(key);
    }
  }

  get cacheStats(): { directories: CacheStats; documents: CacheStats } {
    return { directories: this.#dirCache.stats, documents: this.#docCache.stats };
  }

  /**
   * Children of `path` from cache only, never touching the network.
   *
   * This exists for Tab completion. Completion runs on a keystroke, so it must answer in
   * microseconds or not at all; a Tab that blocks on a mailbox page load reads, through a
   * screen reader, as the program having hung. Returns undefined when nothing is cached,
   * which the completer reports honestly rather than stalling.
   *
   * Deliberately uses `getStale`: for completion, slightly out-of-date names are far more
   * useful than no names, and the worst case is a completion that then fails to resolve.
   */
  cachedChildren(path: string): readonly VNode[] | undefined {
    const normalized = vpath.normalize(path);
    const index = this.#dirCache.get(normalized) ?? this.#dirCache.getStale(normalized)?.value;
    if (index === undefined) {
      // The synthetic tree above the mounts is computed, not fetched, so it is always
      // available and completing `/` should offer the mount points.
      if (this.#isSyntheticDirectory(normalized) || normalized === vpath.ROOT) {
        return this.#listSynthetic(normalized, {}).entries;
      }
      return undefined;
    }
    return index.order.map((name) => index.byName.get(name)).filter((node): node is VNode => node !== undefined);
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a path to its node. Returns `node: null` for the VFS root, a mount root, or a
   * synthetic intermediate directory — all of which are engine-owned rather than
   * provider-owned.
   */
  async resolve(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ mount: Mount | undefined; node: VNode | null; synthetic: boolean }> {
    const normalized = vpath.normalize(path);

    if (normalized === vpath.ROOT) {
      return { mount: undefined, node: null, synthetic: true };
    }

    const located = this.findMount(normalized);
    if (located === undefined) {
      // Not inside a mount, but it may still be a prefix of one (e.g. `/a` when `/a/b`
      // is mounted), in which case it is a legitimate synthetic directory.
      if (this.#isSyntheticDirectory(normalized)) {
        return { mount: undefined, node: null, synthetic: true };
      }
      throw VfsError.notFound(normalized, 'Run `mounts` to see what is available.');
    }

    const { mount, relative } = located;
    if (relative.length === 0) {
      return { mount, node: null, synthetic: false };
    }

    let parent: VNode | null = null;
    let currentPath = mount.path;
    for (const segment of relative) {
      currentPath = vpath.join(currentPath, segment);
      const child: VNode | undefined = await this.#resolveChild(mount, parent, currentPath, segment, options);
      if (child === undefined) {
        throw VfsError.notFound(currentPath);
      }
      parent = child;
    }

    return { mount, node: parent, synthetic: false };
  }

  /**
   * Resolve a target that may already be a node.
   *
   * Callers very often *have* the node already — it came from the listing they are acting
   * on. Throwing it away and re-deriving it from its display name is not merely wasteful,
   * it is incorrect: a display name is sanitized (lossy), deduplicated (contextual) and,
   * for a search hit, may not even live in the directory the caller is standing in. That
   * round trip was a real bug — acting on a search result failed with "no such file"
   * because the hit's name was joined to the search root rather than its true parent.
   *
   * So: when a node is handed in, trust it. It carries its own `path` and `id`, and the
   * provider is given the object it originally produced. This is the same principle the
   * provider contract already states — nobody should ever have to parse a path back into
   * an identity — applied one layer up.
   */
  async #locate(
    target: VfsTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ mount: Mount | undefined; node: VNode | null; synthetic: boolean; path: string }> {
    if (typeof target === 'string') {
      const path = vpath.normalize(target);
      const resolved = await this.resolve(path, options);
      return { ...resolved, path };
    }

    const path = target.path ?? vpath.ROOT;
    const located = this.findMount(path);
    if (located === undefined) {
      // A node with no owning mount can only be one of the engine's own synthetic
      // directories; fall back to the string path so the normal errors still apply.
      const resolved = await this.resolve(path, options);
      return { ...resolved, path };
    }
    return { mount: located.mount, node: target, synthetic: false, path };
  }


  async stat(target: VfsTarget, options: { signal?: AbortSignal } = {}): Promise<VNode> {
    if (typeof target !== 'string') return target;
    const normalized = vpath.normalize(target);
    const { mount, node, synthetic } = await this.resolve(normalized, options);

    if (node !== null) return { ...node, path: normalized };

    if (synthetic && mount === undefined) {
      return {
        name: vpath.basename(normalized) || '/',
        kind: 'dir',
        title: normalized === vpath.ROOT ? '/' : vpath.basename(normalized),
        id: `synthetic:${normalized}`,
        path: normalized,
        meta: { synthetic: true },
      };
    }

    const owner = mount as Mount;
    return {
      name: vpath.basename(normalized),
      kind: 'dir',
      title: owner.description ?? owner.provider.displayName,
      id: `mount:${owner.id}`,
      path: normalized,
      meta: { mount: owner.id, provider: owner.provider.id },
    };
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(
    target: VfsTarget,
    options: ListOptions & { refresh?: boolean; speculative?: boolean } = {},
  ): Promise<VfsListResult> {
    const { mount, node, synthetic, path: normalized } = await this.#locate(target, options);

    if (mount === undefined && synthetic) {
      const result = this.#listSynthetic(normalized, options);
      // Recorded here rather than inside #listSynthetic, because that is also how the
      // roll-up re-derives the root to check it for news. Recording it there would mean
      // every check overwrote the very answer it was about to compare against, and the
      // root — the one listing nobody can navigate above — could never report a change.
      this.#rememberUnread(normalized, result.entries);
      return result;
    }

    const owner = mount as Mount;
    if (node !== null && node.kind !== 'dir') {
      throw VfsError.notDirectory(normalized);
    }

    if (options.refresh === true) this.invalidate(normalized);

    const query = options.query;
    const limit = options.limit ?? owner.pageSize ?? this.#defaultPageSize;

    let page: ListPage;
    let stale = false;
    let staleAgeMs: number | undefined;

    try {
      page = await this.#fetchPage(owner, node, normalized, { ...options, limit });
    } catch (error) {
      const cached = this.#serveStaleOnError ? this.#dirCache.getStale(normalized) : undefined;
      if (cached === undefined) throw toVfsError(error, normalized);
      stale = true;
      staleAgeMs = cached.ageMs;
      const entries = cached.value.order
        .map((name) => cached.value.byName.get(name))
        .filter((n): n is VNode => n !== undefined);
      page = { entries, ...(cached.value.total === undefined ? {} : { total: cached.value.total }) };
    }

    // Apply whatever the provider could not.
    let entries = page.entries;
    let undecided = 0;

    const providerApplied = page.appliedQuery;
    const fullyApplied =
      isMatchAll(query) ||
      (providerApplied !== undefined && stringifyQuery(providerApplied) === stringifyQuery(query as Query));

    if (!isMatchAll(query) && !fullyApplied) {
      const filtered: VNode[] = [];
      for (const entry of entries) {
        const verdict = evaluateQuery(query as Query, entry);
        if (verdict === true) filtered.push(entry);
        else if (verdict === 'unknown') undecided += 1;
      }
      entries = filtered;
    }

    const sorted = options.sort === undefined ? entries : sortNodes(entries, options.sort);
    const counted = this.#withRolledUpUnread(sorted);
    // The caller is about to see these numbers, so they are not news. Recording them here is
    // what keeps the first speculative listing to land underneath from announcing a
    // "correction" that corrects nothing.
    this.#rememberUnread(normalized, counted);

    // Learning and guessing happen only for a plain, un-narrowed listing the *user* asked
    // for: that is the shape of navigation. A filtered `ls` is someone interrogating a
    // folder, not moving to it, and treating it as a move would poison the transition
    // model with places the user never actually went.
    //
    // Speculative listings are excluded for a sharper reason: a prefetch that fed the
    // predictor would predict from its own guess, schedule more, and walk the entire tree
    // — an unbounded recursion that never yields, taking the provider's rate limit and the
    // event loop with it. Prefetching is exactly one hop deep, and this is what keeps it
    // that way.
    if (isMatchAll(query) && options.cursor === undefined && options.speculative !== true) {
      this.#afterNavigation(owner, node, normalized, sorted, page.cursor);
    }

    return {
      path: normalized,
      entries: counted,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.fromCache === undefined ? {} : { fromCache: page.fromCache }),
      undecided,
      stale,
      ...(staleAgeMs === undefined ? {} : { staleAgeMs }),
    };
  }

  /**
   * Record the move and warm what comes next.
   *
   * Cancelling first is the important half. Predictions made from the previous directory
   * are guesses about somewhere the user has now left, and letting them run would spend
   * the tiny prefetch budget — and the provider's rate limit — on the past. Documents and
   * below are dropped; an in-flight next-page fetch is kept, because paging is the one
   * prediction that survives a `cd` (the user often comes straight back).
   */
  #afterNavigation(
    mount: Mount,
    node: VNode | null,
    path: string,
    entries: readonly VNode[],
    cursor: string | undefined,
  ): void {
    const queue = this.#prefetchQueue;
    const predictor = this.#predictor;
    const moved = this.#lastListedPath !== path;
    this.#lastListedPath = path;

    if (predictor === undefined || queue === undefined) return;
    if (moved) {
      predictor.record(path);
      // Predictions made from the previous directory are now guesses about somewhere the
      // user has left, so they go. Warm-up is kept, because it is no longer only a latency
      // bet: it is the one thing that puts an unread counter on a mount the user has not
      // opened yet, and those rows — the root listing — are the first thing anyone sees.
      // Dropping it here is why `ls /` came up blank however long the session had been
      // running. Keeping it costs nothing in contention: warm is the worst-ranked work in
      // the queue, so it still runs only when there is nothing a user is waiting for.
      queue.cancel({ minPriority: PREFETCH_PRIORITY.document, keep: (task) => task.key.startsWith('warm:') });
      this.#persistNavigation();
    }

    const targets = predictor.predict(path, entries, {
      ...(cursor === undefined ? {} : { cursor }),
      siblings: this.#siblingPaths(path),
    });

    for (const target of targets) {
      queue.schedule({
        key: `${target.kind}:${target.path}:${target.cursor ?? ''}`,
        priority: target.priority,
        path: target.path,
        run: async (signal) => {
          const pageSize = this.#prefetchOptions.pageSize ?? 25;
          if (target.kind === 'document') {
            await this.read(target.path, { signal });
            return;
          }
          await this.list(target.path, {
            signal,
            limit: pageSize,
            speculative: true,
            ...(target.cursor === undefined ? {} : { cursor: target.cursor }),
          });
        },
      });
    }
  }

  /** Directories alongside `path`, from cache only — a prediction must not cost a fetch. */
  #siblingPaths(path: string): readonly string[] {
    if (path === vpath.ROOT) return [];
    const parent = vpath.dirname(path);
    const siblings = this.cachedChildren(parent) ?? [];
    return siblings
      .filter((entry) => entry.kind === 'dir')
      .map((entry) => entry.path ?? vpath.join(parent, entry.name))
      .filter((candidate) => candidate !== path);
  }

  #persistNavigation(): void {
    const predictor = this.#predictor;
    if (predictor === undefined || !predictor.dirty) return;
    const transitions = predictor.transitions();
    this.#record(async () => {
      await (this.#snapshot as SnapshotStore).saveNavigationHistory(transitions);
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(target: VfsTarget, options: ReadOptions = {}): Promise<Document> {
    const { mount, node, path: normalized } = await this.#locate(target, options);
    const cached = this.#docCache.get(normalized);
    if (cached !== undefined) return cached;

    if (node === null) throw VfsError.isDirectory(normalized);

    const owner = mount as Mount;
    if (owner.provider.read === undefined || !owner.provider.capabilities.has('read')) {
      throw VfsError.unsupported('Reading item content', owner.provider.id);
    }
    if (node.kind === 'dir') throw VfsError.isDirectory(normalized);

    // A message body does not change. That is what makes the snapshot's document store
    // worth far more than its listing store: a listing goes stale in minutes, but a mail
    // you have already read is correct forever, so re-fetching it over the network is
    // pure latency for no information.
    if (this.#snapshot !== undefined) {
      const stored = await this.#snapshot.document(normalized).catch(() => undefined);
      if (stored !== undefined) {
        this.#docCache.set(normalized, stored.doc);
        return stored.doc;
      }
    }

    try {
      const doc = await owner.provider.read(node, options);
      this.#docCache.set(normalized, doc);
      this.#record(async () => {
        await (this.#snapshot as SnapshotStore).putDocument(owner.id, { ...node, path: normalized }, doc);
      });
      return doc;
    } catch (error) {
      const stale = this.#serveStaleOnError ? this.#docCache.getStale(normalized) : undefined;
      if (stale !== undefined) return stale.value;
      throw toVfsError(error, normalized);
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Recursive search. Prefers the provider's native search, which pushes the work to the
   * backend's index; otherwise walks the tree breadth-first with a bounded budget so an
   * unindexed provider degrades to something slow but finite rather than unbounded.
   *
   * From a synthetic directory — the root, or any ancestor of several mounts — this fans
   * out across every source beneath it *in parallel*, each through its own native index,
   * and merges the results by relevance. Walking a synthetic root breadth-first instead
   * would be both far slower and much worse: a shared node budget spent depth-first means
   * the first mount in path order eats it, and the honest answer "no results in Teams"
   * becomes indistinguishable from "never got as far as Teams".
   *
   * Native results get the same treatment `list` gives: the query is re-applied locally
   * unless the provider explicitly claims it applied the whole thing, and every name is
   * run through the naming rules. Search is the one place where results from many
   * directories land in one list, so names are shown relative to the search root — both
   * because the user wants to know *where* a hit lives, and because a bare leaf name is
   * not unique across folders.
   *
   * The local snapshot is consulted *before* any of that. It answers in about a
   * millisecond from indexes that are already on disk, and its hits are merged with the
   * network's, deduplicated by node id with the live copy winning. That ordering is what
   * makes search survive a dead network: the recent past always answers, and the archive
   * answers when it can. The snapshot reports as a source of its own so the result never
   * pretends a local-only answer was exhaustive.
   */
  async search(path: string, query: Query, options: SearchOptions = {}): Promise<VfsListResult> {
    const normalized = vpath.normalize(path);
    const limit = options.limit ?? this.#defaultPageSize;
    const local = await this.#snapshotSearch(normalized, query, options);

    if (options.local === true) {
      const named = this.#nameSearchHits(normalized, local.entries);
      const ranked = options.sort === undefined && (options.rank ?? true);
      const ordered = ranked ? rankHits(named, query) : options.sort === undefined ? named : sortNodes(named, options.sort);
      return {
        path: normalized,
        entries: ordered.slice(0, limit),
        undecided: 0,
        stale: false,
        total: ordered.length,
        ...(local.report === undefined ? {} : { sources: [local.report] }),
        ranked,
      };
    }

    const live = await this.#searchProviders(normalized, query, options);
    return this.#mergeSnapshotHits(normalized, query, options, live, local);
  }

  /**
   * Merge local snapshot hits into a live result set.
   *
   * The live copy wins every collision. A snapshot row is a photograph of a message as it
   * was when it was cached: the provider's version knows it has since been read, moved or
   * flagged, and showing the stale one would have the user acting on yesterday's state.
   */
  #mergeSnapshotHits(
    root: string,
    query: Query,
    options: SearchOptions,
    live: VfsListResult,
    local: { entries: readonly VNode[]; report?: SearchSourceReport },
  ): VfsListResult {
    if (local.entries.length === 0) return local.report === undefined ? live : { ...live, sources: [...(live.sources ?? []), local.report] };

    const limit = options.limit ?? this.#defaultPageSize;
    const seen = new Set(live.entries.map((entry) => entry.id));
    const extra = local.entries.filter((entry) => !seen.has(entry.id));
    if (extra.length === 0) {
      return local.report === undefined ? live : { ...live, sources: [...(live.sources ?? []), local.report] };
    }

    const named = this.#nameSearchHits(root, [...live.entries, ...extra]);
    const ranked = live.ranked ?? (options.sort === undefined && (options.rank ?? true));
    const ordered = ranked ? rankHits(named, query) : options.sort === undefined ? named : sortNodes(named, options.sort);

    return {
      ...live,
      entries: ordered.slice(0, limit),
      total: ordered.length,
      ...(local.report === undefined ? {} : { sources: [...(live.sources ?? []), local.report] }),
      ranked,
    };
  }

  /**
   * Candidates from the local indexes, filtered by the engine's own query evaluator.
   *
   * The snapshot proposes; `evaluateQuery` disposes. Re-implementing the query language in
   * SQL would give two subtly different search semantics depending on whether a message
   * happened to be cached, which is a far worse bug than a slow search — so the SQL side
   * over-retrieves on purpose and the real evaluator makes every decision.
   */
  async #snapshotSearch(
    root: string,
    query: Query,
    options: SearchOptions,
  ): Promise<{ entries: readonly VNode[]; report?: SearchSourceReport }> {
    if (this.#snapshot === undefined) return { entries: [] };
    const started = this.#now();
    const limit = options.limit ?? this.#defaultPageSize;

    let hits: readonly SnapshotHit[];
    try {
      hits = await this.#snapshot.candidates(query, {
        root,
        limit,
        ...(options.semantic === undefined ? {} : { semantic: options.semantic }),
      });
    } catch (error) {
      return {
        entries: [],
        report: {
          id: 'snapshot',
          path: root,
          provider: 'Local snapshot',
          native: true,
          status: 'failed',
          matches: 0,
          durationMs: this.#now() - started,
          truncated: false,
          undecided: 0,
          error: describeError(error),
        },
      };
    }

    const entries: VNode[] = [];
    for (const hit of hits) {
      const verdict = evaluateQuery(query, hit.node, hit.body === undefined ? undefined : { body: hit.body });
      if (verdict === true) entries.push(hit.node);
    }

    return {
      entries,
      report: {
        id: 'snapshot',
        path: root,
        provider: 'Local snapshot',
        native: true,
        status: 'ok',
        matches: entries.length,
        durationMs: this.#now() - started,
        // Always true: the snapshot holds the recent past by construction, so "no local
        // hits" must never be presented as "no such message exists".
        truncated: true,
        undecided: 0,
      },
    };
  }

  async #searchProviders(path: string, query: Query, options: SearchOptions): Promise<VfsListResult> {
    const normalized = vpath.normalize(path);
    const located = this.findMount(normalized);
    const explicitSources = options.sources !== undefined && options.sources.length > 0;

    if (located === undefined || explicitSources) {
      const beneath = this.#mountsBeneath(normalized, options.sources);
      if (beneath.length > 0) return this.#federatedSearch(normalized, beneath, query, options);
      if (explicitSources) {
        const known = this.mounts.map((mount) => mount.id).join(', ');
        throw VfsError.invalid(
          `No source matches ${(options.sources ?? []).map((name) => `"${name}"`).join(', ')}.`,
          known === '' ? 'Nothing is mounted yet.' : `Mounted sources: ${known}.`,
        );
      }
    }

    if (located !== undefined) {
      const { mount } = located;
      if (mount.provider.capabilities.has('search') && mount.provider.search !== undefined) {
        const { node } = await this.resolve(normalized, options);
        const page = await mount.provider.search(node, query, options);

        // Same honesty guard as `list`. A provider that over-claims its search accuracy
        // would otherwise silently return items the user did not ask for, and search is
        // exactly where an unnoticed false positive does the most damage.
        const fullyApplied =
          page.appliedQuery !== undefined && stringifyQuery(page.appliedQuery) === stringifyQuery(query);

        let undecided = 0;
        const kept: VNode[] = [];
        for (const entry of page.entries) {
          if (!fullyApplied) {
            const verdict = evaluateQuery(query, entry);
            if (verdict === 'unknown') undecided += 1;
            if (verdict !== true) continue;
          }
          kept.push(entry);
        }

        const entries = this.#nameSearchHits(normalized, kept);
        return {
          path: normalized,
          entries: options.sort === undefined ? entries : sortNodes(entries, options.sort),
          undecided: requiresContent(query) ? undecided : 0,
          stale: false,
          total: entries.length,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      }
    }

    return this.#walkSearch(normalized, query, options);
  }

  /**
   * The mounts a cross-source search should consult, optionally narrowed by name.
   *
   * A source may be named by its id (`mail`), its mount path (`/mail`) or the last
   * segment of that path, because those are the three things the user actually sees and
   * none of them is obviously the "real" one.
   *
   * Derived mounts — projections — are dropped from an un-narrowed fan-out. They hold no
   * items of their own, so including one means returning every hit twice and spending part
   * of a bounded, ranked budget on the copy. Naming one explicitly opts it back in, since
   * `--source by-person` is unambiguous about what was meant. If *everything* beneath the
   * root is derived there is nothing else to ask, so they are kept: a view of a source is a
   * far better answer than no answer.
   */
  #mountsBeneath(root: string, sources?: readonly string[]): readonly Mount[] {
    const beneath = this.mounts.filter((mount) => vpath.contains(root, mount.path));
    if (sources === undefined || sources.length === 0) {
      const independent = beneath.filter((mount) => mount.provider.derived !== true);
      return independent.length > 0 ? independent : beneath;
    }

    const wanted = new Set(
      sources.map((name) => name.trim().toLocaleLowerCase()).filter((name) => name !== ''),
    );
    return beneath.filter(
      (mount) =>
        wanted.has(mount.id.toLocaleLowerCase()) ||
        wanted.has(mount.path.toLocaleLowerCase()) ||
        wanted.has(vpath.basename(mount.path).toLocaleLowerCase()),
    );
  }

  /**
   * Search several sources at once and merge what comes back.
   *
   * Three rules govern this, and each exists because the obvious alternative is a lie:
   *
   * Sources are isolated. One provider throwing must never abort the rest — the whole
   * point of asking four backends is that three of them can still answer.
   *
   * Sources are bounded. A source that does not answer within the deadline is dropped
   * from the results and named in the report. A hung mail tenant must not make the tool
   * look frozen, which for a screen-reader user is indistinguishable from a crash.
   *
   * No cursor is returned. Continuing a merged search would mean resuming N independent
   * provider cursors and re-ranking against results the user has already seen; a cursor
   * that quietly loses or repeats items is worse than no cursor. Truncation is reported
   * instead, so the caller can say "showing the top 50" and mean it.
   */
  async #federatedSearch(
    root: string,
    mounts: readonly Mount[],
    query: Query,
    options: SearchOptions,
  ): Promise<VfsListResult> {
    const limit = options.limit ?? this.#defaultPageSize;
    const timeoutMs = options.sourceTimeoutMs ?? 15_000;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, mounts.length));

    const reports = new Array<SearchSourceReport>(mounts.length);
    const harvest = new Array<readonly VNode[]>(mounts.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const mount = mounts[index];
        if (mount === undefined) return;
        const outcome = await this.#searchOneSource(mount, query, options, timeoutMs, limit);
        reports[index] = outcome.report;
        harvest[index] = outcome.entries;
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    // A caller-initiated abort is a real error, not a per-source failure to report around.
    options.signal?.throwIfAborted();

    const merged: VNode[] = [];
    for (const entries of harvest) merged.push(...entries);

    const named = this.#nameSearchHits(root, merged);
    const ranked = options.sort === undefined && (options.rank ?? true);
    const ordered = ranked
      ? rankHits(named, query)
      : options.sort === undefined
        ? named
        : sortNodes(named, options.sort);

    const sources = reports.filter((report): report is SearchSourceReport => report !== undefined);
    const undecided = sources.reduce((sum, report) => sum + report.undecided, 0);

    return {
      path: root,
      entries: ordered.slice(0, limit),
      undecided: requiresContent(query) ? undecided : 0,
      stale: false,
      total: ordered.length,
      sources,
      ranked,
    };
  }

  /** Ask one source, under a deadline, and never throw. */
  async #searchOneSource(
    mount: Mount,
    query: Query,
    options: SearchOptions,
    timeoutMs: number,
    limit: number,
  ): Promise<{ report: SearchSourceReport; entries: readonly VNode[] }> {
    const started = this.#now();
    const native = mount.provider.capabilities.has('search') && mount.provider.search !== undefined;
    const base = {
      id: mount.id,
      path: mount.path,
      provider: mount.provider.displayName,
      native,
    } as const;

    // The deadline is enforced twice on purpose: the signal asks politely, and the race
    // guarantees the merge proceeds even against a provider that ignores signals.
    const stopper = new AbortController();
    const signals = [stopper.signal, ...(options.signal === undefined ? [] : [options.signal])];
    const perSource: SearchOptions = {
      ...options,
      limit,
      sources: [],
      signal: signals.length === 1 ? stopper.signal : AbortSignal.any(signals),
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Deliberately the provider path, not the public `search`: the snapshot has already
      // been consulted once for the whole result set, and asking it again per mount would
      // pay for the same local query N times to produce rows that are then deduplicated.
      const work = this.#searchProviders(mount.path, query, perSource);
      const page =
        timeoutMs > 0
          ? await Promise.race([
              work,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  stopper.abort();
                  reject(new SourceTimeout());
                }, timeoutMs);
                timer.unref?.();
              }),
            ])
          : await work;

      const unreadable = page.unreadable ?? 0;
      return {
        report: {
          ...base,
          status: unreadable > 0 ? 'partial' : 'ok',
          matches: page.entries.length,
          durationMs: this.#now() - started,
          truncated: page.cursor !== undefined || page.entries.length >= limit,
          undecided: page.undecided,
          ...(unreadable === 0
            ? {}
            : {
                error: `${unreadable} ${unreadable === 1 ? 'folder' : 'folders'} could not be read${
                  page.unreadableError === undefined ? '' : `: ${page.unreadableError}`
                }`,
              }),
        },
        entries: page.entries,
      };
    } catch (error) {
      const timedOut = error instanceof SourceTimeout;
      return {
        report: {
          ...base,
          status: timedOut ? 'timeout' : 'failed',
          matches: 0,
          durationMs: this.#now() - started,
          truncated: false,
          undecided: 0,
          error: timedOut ? `No response within ${timeoutMs}ms.` : describeError(error),
        },
        entries: [],
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      stopper.abort();
    }
  }


  /**
   * Give search hits display names that are unique within the result set and safe as path
   * segments, without disturbing the `path` that identifies them.
   *
   * A hit keeps its true path — that is what every subsequent command acts on — but its
   * *name* becomes the path relative to the search root, so `Inbox/budget.eml` and
   * `Archive/budget.eml` are visibly different things. Hits from outside the root, which
   * a provider is free to return, fall back to their absolute path.
   */
  #nameSearchHits(root: string, entries: readonly VNode[]): VNode[] {
    const allocator = new NameAllocator({ allowSlashes: true });
    const mountRoot = this.findMount(root)?.mount.path ?? root;

    return entries.map((entry) => {
      const full = this.#searchHitPath(root, mountRoot, entry);
      const prefix = root === vpath.ROOT ? '/' : `${root}/`;
      const relative = full.startsWith(prefix) ? full.slice(prefix.length) : full;
      return { ...entry, name: allocator.allocate(relative), path: full };
    });
  }

  /**
   * Work out where a search hit actually lives.
   *
   * Preference order, most trustworthy first: a path the engine itself produced, then the
   * provider's own account of the containing folder, and only then the assumption that it
   * sits directly under the search root. The last of those is usually wrong for nested
   * results, so it is the fallback rather than the rule.
   *
   * When the containing folder has already been listed, its cached index is consulted by
   * `id` and the canonical allocated name is used. That repairs the one case the provider
   * cannot get right on its own: an item whose display name was deduplicated to `~2`.
   */
  #searchHitPath(root: string, mountRoot: string, entry: VNode): string {
    if (entry.path !== undefined) return entry.path;

    const parent =
      entry.parentPath === undefined || entry.parentPath === ''
        ? root
        : vpath.join(
            mountRoot,
            entry.parentPath
              .split('/')
              .filter((part) => part !== '')
              .map((part) => sanitizeSegment(part))
              .join('/'),
          );

    const index = this.#dirCache.get(parent) ?? this.#dirCache.getStale(parent)?.value;
    const canonical = index?.byId.get(entry.id);
    return vpath.join(parent, canonical ?? entry.name);
  }

  // -------------------------------------------------------------------------
  // Unread roll-up
  // -------------------------------------------------------------------------

  /**
   * Give a directory an unread counter when its provider did not.
   *
   * A counter earns its keep on the row you are choosing *from* — the row you have to commit
   * to before you can see anything behind it. Two of the most important such rows are owned
   * by no provider at all: the synthetic root, where `/mail`, `/teams` and `/github` live,
   * and any synthetic directory between mounts. Left alone, the part of the tree everyone
   * sees first, and the part a keyboard user must navigate blind, was exactly the part that
   * said nothing.
   *
   * The same gap appears inside a mount whenever a source knows what is unread but never
   * totals it. GitHub marks a notification unread and offers no count anywhere; Teams says
   * only whether a chat has moved since you read it. Both would otherwise be silent for the
   * same reason: nobody whose job it was to count did.
   *
   * So the engine fills the gaps, under three rules.
   *
   * **A provider's number is final.** If a source gave a count, that is the count, and
   * nothing is added to it — a mail folder saying `9` means nine, exactly as it does in
   * every mail client, and a folder whose children carry their own counts is showing you a
   * breakdown rather than a contradiction. Adding to it would also double-count the moment a
   * provider started totalling its own subtree, and would make the number on a row *change*
   * as browsing filled the cache, which is the fastest way to teach someone to ignore it.
   *
   * **It never fetches.** This runs on the way out of `list()`, with a user waiting. A
   * roll-up that went to the network would turn one listing of eight mounts into eight round
   * trips and would make `ls /` fail offline — for a decoration on a row.
   *
   * **Silence is preserved.** `undefined` means "nobody has a basis for an answer" and stays
   * `undefined`. Zero is a different claim — it says someone counted and found nothing — and
   * a source with no notion of read state at all, like GitHub issues, must not be made to
   * appear to have made it.
   */
  #withRolledUpUnread(entries: readonly VNode[]): readonly VNode[] {
    let changed = false;
    const filled = entries.map((entry) => {
      if (entry.kind !== 'dir') return entry;
      const path = entry.path;
      if (path === undefined) return entry;
      const total = this.#unreadBeneath(path, entry.unreadCount, 0, new Map());
      if (total === undefined || total === entry.unreadCount) return entry;
      changed = true;
      return { ...entry, unreadCount: total };
    });
    return changed ? filled : entries;
  }

  /**
   * What to show against a directory whose provider gave no count: everything unread that
   * the cache can already see at or below `path`.
   *
   * Returns `own` untouched whenever the provider did give a count, so this only ever adds
   * rows to the display, never revises one.
   *
   * `seen` is what keeps the answer honest on a source that is a graph rather than a tree,
   * and several of them are. The demo org chart reaches the same person from `Org`, from
   * `Recent`, from `Colleagues` and from the `Directory` they are defined in; the real
   * people provider is worse, being an outright cycle of managers and reports. Summing
   * paths there counted six unread messages as thirty-three — a number with no relationship
   * to anything the user could go and read, on the one row it exists to inform. So an item
   * contributes once per row, keyed by the provider's own stable id, no matter how many ways
   * there are to walk to it.
   *
   * The map remembers whether each id *had* an answer rather than merely that it was
   * visited, because the second occurrence still has to distinguish "already counted" from
   * "nobody down there counts": a source with no read state must stay silent even when it
   * appears twice.
   */
  #unreadBeneath(
    path: string,
    own: number | undefined,
    depth: number,
    seen: Map<string, boolean>,
  ): number | undefined {
    // The source counted. Whatever it said stands, and the walk stops here — this is what
    // keeps a number from drifting upward as the cache below it fills in.
    if (own !== undefined) return own;
    if (depth >= UNREAD_ROLLUP_DEPTH) return undefined;

    // Stale is deliberately good enough. This is a decoration on a row, and the whole tool
    // already prefers a slightly old answer to a spinner.
    const index = this.#dirCache.get(path) ?? this.#dirCache.getStale(path)?.value;
    // A half-paged directory can only produce a floor, and a number that silently means "at
    // least" is worse than no number at all: nothing distinguishes it from an exact one.
    if (index === undefined || !index.complete) return undefined;

    let total = 0;
    // Whether anything down here gave a basis for a number at all. A folder from a source
    // with no notion of read state — GitHub issues, a channel's threads — must stay silent
    // rather than report `0`, which would claim someone counted and found nothing.
    let counted = false;
    for (const name of index.order) {
      const child = index.byName.get(name);
      if (child === undefined) continue;
      if (child.kind === 'dir') {
        // A folder contributes its number, never its `unread` flag as well: the flag says
        // "something inside is new", which is the fact the number already states.
        const already = seen.get(child.id);
        if (already !== undefined) {
          // Reached a second way. Its total is already in `total`; all that is left to
          // carry over is whether it constituted an answer at all.
          if (already) counted = true;
          continue;
        }
        const below = this.#unreadBeneath(child.path ?? vpath.join(path, name), child.unreadCount, depth + 1, seen);
        seen.set(child.id, below !== undefined);
        if (below !== undefined) {
          total += below;
          counted = true;
        }
      } else if (child.flags?.includes('unread') === true) {
        // Only unread files are remembered. A read one contributes nothing by either route,
        // so recording it would cost memory to answer a question nobody asks.
        if (seen.has(child.id)) {
          counted = true;
          continue;
        }
        seen.set(child.id, true);
        total += 1;
        counted = true;
      }
    }

    return counted ? total : undefined;
  }

  /**
   * Tell anyone watching an ancestor that its counters have moved.
   *
   * A folder's counter is derived from what the cache can see beneath it, so the moment a
   * listing lands anywhere below, the number on a row *above* becomes wrong. That row is
   * usually the one on screen: you sit at `/`, warming fills in `/mail` behind you, and the
   * count belonging to the `mail/` row you are looking at arrives after the frame that
   * should have shown it. Without this, it appeared only if you happened to navigate — which
   * is precisely the moment the counter has stopped being useful, because you have already
   * committed to going in.
   *
   * Bounded by the same depth as the roll-up, because a listing deeper than that cannot
   * change anything up here, and stops at the first ancestor nobody has listed: a directory
   * outside the cache is a directory nobody is looking at.
   */
  #announceUnreadAncestors(path: string): void {
    // Nobody is watching, so there is nothing to be out of date.
    if (this.#listingListeners.size === 0) return;

    let current = path;
    for (let depth = 0; depth <= UNREAD_ROLLUP_DEPTH; depth += 1) {
      const parent = vpath.dirname(current);
      if (parent === current) break;
      this.#announceIfUnreadMoved(parent);
      if (parent === vpath.ROOT) break;
      current = parent;
    }
  }

  /**
   * Re-derive one directory's counters and announce it only if they actually changed.
   *
   * The gate matters more than the announcement. Every announcement costs a repaint, a
   * listing is re-derived once per page that lands anywhere beneath it, and a list that
   * flickers while being read is worse than one that updates a moment late.
   */
  #announceIfUnreadMoved(path: string): void {
    const children = this.cachedChildren(path);
    if (children === undefined) return;

    const entries = this.#withRolledUpUnread(children);
    const vector = unreadVector(entries);

    // Only a listing someone has actually been given can be corrected. A directory that has
    // never been served is not on anyone's screen, and recording it here would quietly make
    // it eligible for a later "update" about a listing it has never held — which is how
    // resolving a deep path ended up announcing every directory it walked through.
    const shown = this.#announcedUnread.get(path);
    if (shown === undefined || shown === vector) return;

    this.#rememberUnread(path, entries);
    this.#announce(path, entries, this.#dirCache.get(path)?.total);
  }

  /** What was last shown for `path`, so a later derivation can tell news from noise. */
  #rememberUnread(path: string, entries: readonly VNode[]): void {
    // Bounded so a long session that walks a large tree cannot accumulate one entry per
    // directory forever. Insertion order is eviction order, and losing an old entry costs at
    // most one redundant repaint of a directory nobody has looked at in a long time.
    if (this.#announcedUnread.size >= MAX_UNREAD_MEMORY && !this.#announcedUnread.has(path)) {
      const oldest = this.#announcedUnread.keys().next();
      if (oldest.done !== true) this.#announcedUnread.delete(oldest.value);
    }
    this.#announcedUnread.set(path, unreadVector(entries));
  }



  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async actions(target: VfsTarget): Promise<readonly ActionDescriptor[]> {
    const { mount, node } = await this.#locate(target);
    if (mount === undefined || node === null) return [];
    if (!mount.provider.capabilities.has('actions') || mount.provider.actions === undefined) return [];
    return mount.provider.actions(node);
  }

  async invoke(
    action: string,
    target: VfsTarget,
    params: Readonly<Record<string, MetaValue>> = {},
  ): Promise<ActionResult> {
    const { mount, node, path: normalized } = await this.#locate(target);
    if (mount === undefined || node === null) {
      throw VfsError.invalid(`Cannot run actions on "${normalized}".`, 'Actions apply to items inside a mount.');
    }
    if (mount.provider.invoke === undefined || !mount.provider.capabilities.has('actions')) {
      throw VfsError.unsupported(`Action "${action}"`, mount.provider.id);
    }

    const result = await mount.provider.invoke(action, node, params);

    // An action almost always changes what a listing would show, so invalidate the item
    // and its parent by default. Providers can widen this via `invalidates`.
    this.invalidate(normalized);
    this.invalidate(vpath.dirname(normalized));
    for (const extra of result.invalidates ?? []) this.invalidate(extra);

    return result;
  }

  capabilitiesAt(path: string): ReadonlySet<Capability> {
    const located = this.findMount(path);
    return located?.mount.provider.capabilities ?? new Set<Capability>();
  }

  /**
   * Fetch attachment bytes.
   *
   * Lives here rather than in the CLI so callers never have to reach through a mount to
   * touch a provider directly — the moment a caller does that, it has to reimplement
   * resolution, capability checks and error mapping, and it will get one of them wrong.
   */
  async readAttachment(target: VfsTarget, attachmentId: string): Promise<{ name: string; contentType: string; data: Uint8Array }> {
    const { mount, node, path } = await this.#locate(target);
    if (mount === undefined || node === null) throw VfsError.isDirectory(path);
    if (mount.provider.readAttachment === undefined || !mount.provider.capabilities.has('attachments')) {
      throw VfsError.unsupported('Downloading attachments', mount.provider.id);
    }
    try {
      return await mount.provider.readAttachment(node, attachmentId);
    } catch (error) {
      throw toVfsError(error, path);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #isSyntheticDirectory(path: string): boolean {
    for (const mountPath of this.#mounts.keys()) {
      if (vpath.contains(path, mountPath)) return true;
    }
    return false;
  }

  /** List the engine-owned part of the tree: the root and any intermediate directories. */
  #listSynthetic(path: string, _options: ListOptions): VfsListResult {
    const prefix = vpath.segments(path);
    const seen = new Map<string, VNode>();

    for (const mount of this.#mounts.values()) {
      const segs = vpath.segments(mount.path);
      if (segs.length <= prefix.length) continue;
      if (!prefix.every((segment, i) => segs[i] === segment)) continue;

      const name = segs[prefix.length] as string;
      if (seen.has(name)) continue;

      const childPath = vpath.join(path, name);
      const isMountRoot = vpath.normalize(childPath) === mount.path;

      // Asked only for the mount's own row, and only ever accepted, never added to — the
      // same rule that governs every other provider-supplied count. A provider that declines
      // to answer leaves the row to `#unreadBeneath`, which is where every provider that has
      // no opinion still gets a number.
      const stated = isMountRoot ? this.#statedUnread(mount) : undefined;

      seen.set(name, {
        name,
        kind: 'dir',
        title: isMountRoot ? (mount.description ?? mount.provider.displayName) : name,
        id: isMountRoot ? `mount:${mount.id}` : `synthetic:${childPath}`,
        path: childPath,
        ...(stated === undefined ? {} : { unreadCount: stated }),
        meta: isMountRoot
          ? { mount: mount.id, provider: mount.provider.id, capabilities: [...mount.provider.capabilities].join(',') }
          : { synthetic: true },
      });
    }

    const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    const counted = this.#withRolledUpUnread(entries);
    return { path, entries: counted, total: entries.length, undecided: 0, stale: false };
  }

  /**
   * What a provider says is unread across its whole mount, if it says anything.
   *
   * Wrapped because this runs inside the render path of every `ls /`. A provider that throws
   * here, or that answers with something that is not a whole number, must cost the row its
   * counter and nothing more — the root listing is how the user finds everything else, and
   * it failing outright because one source miscounted would be a far worse trade than a
   * missing badge.
   */
  #statedUnread(mount: Mount): number | undefined {
    if (mount.provider.unreadTotal === undefined) return undefined;
    try {
      const stated = mount.provider.unreadTotal();
      if (stated === undefined) return undefined;
      if (!Number.isInteger(stated) || stated < 0) {
        this.#logger.debug('Provider gave a nonsensical unread total; ignoring it.', {
          mount: mount.id,
          stated: String(stated),
        });
        return undefined;
      }
      return stated;
    } catch (error) {
      this.#logger.debug('Provider could not total its unread.', { mount: mount.id, error: String(error) });
      return undefined;
    }
  }

  /** Fetch (or serve from the accumulated index) one page of a provider-backed directory. */
  async #fetchPage(
    mount: Mount,
    node: VNode | null,
    path: string,
    options: ListOptions,
  ): Promise<ListPage> {
    const index = this.#dirCache.get(path);

    // A cursor-less request that the index already fully satisfies is served locally.
    if (index !== undefined && options.cursor === undefined && isMatchAll(options.query)) {
      const limit = options.limit ?? this.#defaultPageSize;
      if (index.order.length >= limit || index.complete) {
        const entries = index.order
          .slice(0, limit)
          .map((name) => index.byName.get(name))
          .filter((n): n is VNode => n !== undefined);
        return {
          entries,
          ...(index.complete || index.order.length <= limit ? {} : { cursor: encodeOffsetCursor(limit) }),
          ...(index.total === undefined ? {} : { total: index.total }),
          fromCache: true,
        };
      }
    }

    // An offset cursor means "continue from the accumulated index", not "ask the backend".
    const offset = decodeOffsetCursor(options.cursor);
    if (offset !== undefined && index !== undefined) {
      const limit = options.limit ?? this.#defaultPageSize;
      if (index.order.length > offset || index.complete) {
        const slice = index.order.slice(offset, offset + limit);
        const entries = slice.map((name) => index.byName.get(name)).filter((n): n is VNode => n !== undefined);
        const consumed = offset + slice.length;
        const more = !index.complete || consumed < index.order.length;
        const nextCursor = index.complete ? encodeOffsetCursor(consumed) : index.cursor;
        return {
          entries,
          ...(more && nextCursor !== undefined ? { cursor: nextCursor } : {}),
          ...(index.total === undefined ? {} : { total: index.total }),
          fromCache: true,
        };
      }
    }

    // Nothing usable in memory. Before paying for the network, ask the local snapshot —
    // this is the cold-start path, and the whole point of having one. It only answers
    // un-narrowed first pages: the snapshot holds the recent past, so serving a *filtered*
    // listing from it would silently answer "no matches" for something sitting just
    // outside retention. Filtered listings go to the provider, which can see everything.
    if (this.#snapshot !== undefined && options.cursor === undefined && isMatchAll(options.query)) {
      const limit = options.limit ?? this.#defaultPageSize;
      const listing = await this.#snapshot.listing(path, { limit }).catch(() => undefined);
      if (listing !== undefined && listing.entries.length > 0) {
        const merged = this.#mergeIntoIndex(
          path,
          {
            entries: listing.entries,
            ...(listing.cursor === undefined ? {} : { cursor: listing.cursor }),
            ...(listing.total === undefined ? {} : { total: listing.total }),
          },
          true,
        );
        const index = this.#dirCache.get(path);
        if (index !== undefined) index.complete = listing.complete;

        // A stale snapshot is still served immediately, and refreshed behind the user's
        // back. Blocking on the network to correct a listing that is minutes old trades a
        // certainty (a slow command) for a possibility (a changed folder).
        if (!listing.fresh) this.#refreshInBackground(mount, node, path, limit);

        return {
          entries: merged.slice(0, limit),
          ...(listing.cursor === undefined ? {} : { cursor: listing.cursor }),
          ...(listing.total === undefined ? {} : { total: listing.total }),
          fromCache: true,
        };
      }
    }

    return this.#coalesce(
      // Everything that can change the answer belongs in the identity. Two callers only
      // share a request if they would have made the same one.
      [
        path,
        options.cursor ?? '',
        offset ?? '',
        options.limit ?? '',
        // An absent query and an explicit match-all are the same request, and must key the
        // same way or the common case never coalesces with itself.
        options.query === undefined ? '*' : stringifyQuery(options.query),
      ].join('\u0000'),
      options.signal,
      async (signal) => {
        const providerOptions: ListOptions = {
          ...options,
          ...(options.cursor !== undefined && offset === undefined ? { cursor: options.cursor } : {}),
          ...(signal === undefined ? {} : { signal }),
        };
        if (offset !== undefined) delete (providerOptions as { cursor?: string }).cursor;
        if (signal === undefined) delete (providerOptions as { signal?: AbortSignal }).signal;

        const page = await mount.provider.list(node, providerOptions);
        const isFirstPage = options.cursor === undefined && offset === undefined;
        const merged = this.#mergeIntoIndex(path, page, isFirstPage);

        // Only un-narrowed pages are worth snapshotting: a filtered page is a fact about a
        // query, not about the folder, and storing it as though it were the folder is how a
        // cache starts lying.
        //
        // `merged`, not `page.entries`: the provider's raw names are backend text, not
        // filenames, and storing those would give the cache paths the engine can never
        // resolve — and would silently merge two items whose names only differ after
        // deduplication.
        if (isMatchAll(options.query) && page.appliedQuery === undefined) {
          this.#record(async () => {
            await (this.#snapshot as SnapshotStore).putListing({
              mountId: mount.id,
              path,
              entries: merged,
              page: {
                ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                ...(page.total === undefined ? {} : { total: page.total }),
              },
              isFirstPage,
              complete: page.cursor === undefined,
            });
          });
        }

        return {
          entries: merged,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
          ...(page.total === undefined ? {} : { total: page.total }),
          ...(page.appliedQuery === undefined ? {} : { appliedQuery: page.appliedQuery }),
        };
      },
    );
  }

  /**
   * Run one request for however many callers ask for it at the same time.
   *
   * This is what makes prefetch pay off rather than merely cost. Speculation exists to be
   * arrived at *mid-flight*: the whole design bets that the user reaches a folder while
   * the guess about it is still in the air. Without coalescing that is the worst case
   * instead of the best — the foreground issues a second, identical request, waits the
   * full latency again, and doubles the load on a rate limit the prefetcher is already
   * spending. With it, arriving early simply means waiting for the part that is left.
   *
   * Aborts are per-caller, not shared. A speculative caller being cancelled — which the
   * queue does routinely, on every navigation — must not cancel the foreground caller
   * that joined it, or prefetch would actively break the thing it is meant to accelerate.
   * So each caller races the shared work against its own signal, and the underlying
   * request is only abandoned once every caller has gone away.
   */
  async #coalesce(key: string, signal: AbortSignal | undefined, run: (signal?: AbortSignal) => Promise<ListPage>) {
    let entry = this.#inflight.get(key);

    if (entry === undefined) {
      const controller = new AbortController();
      const created = {
        controller,
        callers: 0,
        promise: undefined as unknown as Promise<ListPage>,
      };
      created.promise = run(controller.signal).finally(() => {
        if (this.#inflight.get(key) === created) this.#inflight.delete(key);
      });
      // The shared work must always be observed, whatever its callers do. A caller whose
      // signal is already aborted by the time it gets here — abort arriving during the
      // walk to the provider, `invalidate()` cancelling running prefetches, a search
      // deadline firing — returns below without ever attaching a handler, and then the
      // abort a turn later rejects a promise nobody is listening to. Node treats that as
      // fatal. This handler is the one that makes the promise observed no matter what;
      // real callers still see the rejection through their own `.then` below.
      created.promise.catch(() => undefined);
      this.#inflight.set(key, created);
      entry = created;
    }

    const joined = entry;
    joined.callers += 1;

    // A caller with no signal can never leave, so there is nothing to race and nothing to
    // clean up; awaiting directly also avoids leaving an unhandled rejection behind.
    if (signal === undefined) return joined.promise;

    try {
      return await new Promise<ListPage>((resolve, reject) => {
        const onAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted.'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        joined.promise.then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
      });
    } finally {
      joined.callers -= 1;
      // Last one out turns off the lights — but not instantly. A caller that is *about* to
      // join is partway through its own awaits and has not been counted yet, so cancelling
      // the moment the count hits zero would routinely kill a request someone still wants.
      // Re-checking a turn later costs nothing and makes the common case — a speculative
      // fetch being cancelled at the instant the user navigates into it — safe.
      if (joined.callers <= 0) {
        setImmediate(() => {
          if (joined.callers <= 0) joined.controller.abort();
        });
      }
    }
  }

  /**
   * Correct a stale snapshot listing after it has already been served.
   *
   * The last stage of a staged read: the snapshot answered in a millisecond with something
   * that may be minutes old, and this is the part that goes and checks. Deliberately
   * fire-and-forget and deliberately silent on failure — the user already has their answer,
   * so the only thing an error here could do is interrupt them with news about work they
   * never asked for.
   *
   * Success is *not* silent. It announces the corrected listing so a live view can catch up
   * on its own; a correction that only reaches the cache leaves the user reading a stale
   * screen with no way to know it, and pressing refresh — which is the one thing all of
   * this exists to make unnecessary.
   */
  #refreshInBackground(mount: Mount, node: VNode | null, path: string, limit: number): void {
    const queue = this.#prefetchQueue;
    if (queue === undefined) return;
    queue.schedule({
      key: `refresh:${path}`,
      priority: PREFETCH_PRIORITY.nextPage,
      path,
      run: async (signal) => {
        const before = listingFingerprint(this.#currentEntries(path));
        // The signal is what makes this task cancellable, and cancellable is what
        // `cancelSpeculative()` needs it to be: `idle()` only settles once the task promise
        // settles, so a refresh that ignores its abort keeps `flush()` — and therefore the
        // whole of `dispose()` — waiting out a provider round-trip nobody is going to read.
        const page = await mount.provider.list(node, { limit, signal });
        if (signal.aborted) return;
        const merged = this.#mergeIntoIndex(path, page, true);
        // Most refreshes find exactly what was already there. Announcing those would make
        // the subscription almost pure noise — and every announcement costs a repaint,
        // which the user sees as a flicker in a list they were reading.
        if (listingFingerprint(merged) !== before) this.#announce(path, merged, page.total);
        this.#record(async () => {
          await (this.#snapshot as SnapshotStore).putListing({
            mountId: mount.id,
            path,
            entries: merged,
            page: {
              ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
              ...(page.total === undefined ? {} : { total: page.total }),
            },
            isFirstPage: true,
            complete: page.cursor === undefined,
          });
        });
      },
    });
  }

  /** The directory as it currently stands in the live index, in display order. */
  #currentEntries(path: string): readonly VNode[] {
    const index = this.#dirCache.get(path);
    if (index === undefined) return [];
    const entries: VNode[] = [];
    for (const name of index.order) {
      const node = index.byName.get(name);
      if (node !== undefined) entries.push(node);
    }
    return entries;
  }

  /**
   * Give a page of provider entries the names and paths this engine would give them.
   *
   * Exists for {@link BackgroundSync}, which calls providers directly and would otherwise
   * store raw backend text as if it were a filename. It reuses the directory's live index
   * when there is one, so an item keeps the name the user is already looking at, and
   * allocates from a scratch index when there is not — the same code either way, because
   * two naming implementations would eventually disagree and the disagreement would look
   * like a message that cannot be opened.
   *
   * The index is not published to the cache: this is a naming question, not a fetch, and
   * a background sync should not make a folder look freshly listed to the foreground.
   */
  canonicalize(path: string, entries: readonly VNode[]): readonly VNode[] {
    const existing = this.#dirCache.get(path);
    const allocator = existing?.allocator ?? new NameAllocator();
    const byId = existing?.byId ?? new Map<string, string>();

    return entries.map((entry) => {
      let name = byId.get(entry.id);
      if (name === undefined) {
        name = allocator.allocate(entry.name);
        byId.set(entry.id, name);
      }
      return { ...entry, name, path: vpath.join(path, name) };
    });
  }

  /**
   * Fold a page into the directory index, assigning stable unique names, and return the
   * page's entries with their final names and absolute paths attached.
   */
  #mergeIntoIndex(path: string, page: ListPage, isFirstPage: boolean): VNode[] {
    let index = this.#dirCache.get(path);
    if (index === undefined || isFirstPage) {
      index = {
        byName: new Map(),
        byId: new Map(),
        order: [],
        allocator: new NameAllocator(),
        cursor: undefined,
        complete: false,
        total: undefined,
        fetchedAt: this.#now(),
      };
    }

    const result: VNode[] = [];
    for (const entry of page.entries) {
      let name = index.byId.get(entry.id);
      if (name === undefined) {
        name = index.allocator.allocate(entry.name);
        index.byId.set(entry.id, name);
        index.order.push(name);
      }
      const resolved: VNode = { ...entry, name, path: vpath.join(path, name) };
      index.byName.set(name, resolved);
      result.push(resolved);
    }

    index.cursor = page.cursor;
    index.complete = page.cursor === undefined;
    index.total = page.total;
    index.fetchedAt = this.#now();
    this.#dirCache.set(path, index);

    // Data landing here changes what an ancestor's row should say, and an ancestor is
    // usually what is on screen. This is the single point where new listings enter the
    // cache, so it is the one place that has to notice.
    this.#announceUnreadAncestors(path);

    return result;
  }

  async #resolveChild(
    mount: Mount,
    parent: VNode | null,
    childPath: string,
    name: string,
    options: { signal?: AbortSignal },
  ): Promise<VNode | undefined> {
    const index = this.#dirCache.get(vpath.dirname(childPath));
    const cached = index?.byName.get(name);
    if (cached !== undefined) return cached;

    // Fast path: let the provider look the child up directly rather than paging a
    // 200,000-message folder to find one message.
    if (mount.provider.resolveChild !== undefined) {
      const direct = await mount.provider.resolveChild(parent, name, options);
      if (direct !== undefined) {
        return { ...direct, name, path: childPath };
      }
    }

    // Fallback: page through the parent until the name shows up. Bounded so a pathological
    // directory cannot spin forever; the user gets a clear error instead of a hang.
    const parentPath = vpath.dirname(childPath);
    let cursor: string | undefined;
    let pages = 0;
    const maxPages = 40;

    do {
      const page: ListPage = await mount.provider.list(parent, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: mount.pageSize ?? this.#defaultPageSize,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const merged = this.#mergeIntoIndex(parentPath, page, pages === 0);
      const hit = merged.find((entry) => entry.name === name);
      if (hit !== undefined) return hit;
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined && pages < maxPages);

    if (cursor !== undefined) {
      throw new VfsError('ENOENT', `Could not find "${name}" in ${parentPath} within ${maxPages} pages.`, {
        path: childPath,
        hint: 'Narrow the directory with a query, e.g. `ls -q "from:alice"`, or use `find`.',
      });
    }

    return undefined;
  }

  /**
   * Breadth-first fallback search for providers with no native search.
   *
   * Both `seen` sets exist because a mount's tree is not necessarily a *tree*. The people
   * graph is genuinely cyclic — your manager's `reports/` contains you — so without them a
   * search would re-walk the same subtree from every direction, spend its whole node budget
   * doing it, and report one unread message a dozen times under a dozen paths. Identity is
   * the provider's own `id`, which is defined as identifying the item rather than the
   * route taken to it.
   */
  async #walkSearch(
    root: string,
    query: Query,
    options: ListOptions & { maxNodes?: number; maxDepth?: number },
  ): Promise<VfsListResult> {
    const maxNodes = options.maxNodes ?? 5_000;
    const maxDepth = options.maxDepth ?? 8;
    const limit = options.limit ?? 200;

    const matches: VNode[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    let visited = 0;
    let undecided = 0;
    let unreadable = 0;
    let firstFailure: string | undefined;
    const contentNeeded = requiresContent(query);
    const seenItems = new Set<string>();
    const seenDirectories = new Set<string>();

    while (queue.length > 0 && visited < maxNodes && matches.length < limit) {
      // Checked every iteration, not just handed to the provider: a walk can spend
      // minutes on a mailbox, and a Ctrl-C that only takes effect if the backend happens
      // to honour signals is not a working Ctrl-C.
      options.signal?.throwIfAborted();
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > maxDepth) continue;

      let page: VfsListResult;
      try {
        page = await this.list(current.path, {
          limit: 200,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        // One unreadable subtree (permissions, a revoked scope, a feed that will not
        // answer) must not abort the search — but it must not vanish either, or a
        // partial answer is indistinguishable from a complete one. Count it and go on.
        if (isAbortError(error)) throw error;
        unreadable += 1;
        firstFailure ??= describeError(error);
        continue;
      }

      // Identity is the provider's own id, scoped to the mount that produced the page —
      // ids are unique within a provider, and a search from `/` spans several. Above the
      // mounts the tree is synthetic, finite and acyclic, and a node there *is* its path.
      const owner = this.findMount(current.path)?.mount.path;

      for (const entry of page.entries) {
        visited += 1;
        const key = owner === undefined ? `\u0000${entry.path ?? entry.name}` : `${owner}\u0000${entry.id}`;
        if (!seenItems.has(key)) {
          seenItems.add(key);
          const verdict = evaluateQuery(query, entry);
          if (verdict === true) {
            matches.push(entry);
            if (matches.length >= limit) break;
          } else if (verdict === 'unknown') {
            undecided += 1;
          }
        }
        if (entry.kind === 'dir' && entry.path !== undefined && !seenDirectories.has(key)) {
          seenDirectories.add(key);
          queue.push({ path: entry.path, depth: current.depth + 1 });
        }
      }
    }

    return {
      path: root,
      entries: this.#nameSearchHits(root, matches),
      undecided: contentNeeded ? undecided : 0,
      stale: false,
      total: matches.length,
      ...(unreadable === 0 ? {} : { unreadable }),
      ...(firstFailure === undefined ? {} : { unreadableError: firstFailure }),
    };
  }

  #withPath(parent: string, node: VNode): VNode {
    return node.path === undefined ? { ...node, path: vpath.join(parent, node.name) } : node;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OFFSET_PREFIX = 'vfs-offset:';

function encodeOffsetCursor(offset: number): string {
  return `${OFFSET_PREFIX}${offset}`;
}

/**
 * A listing reduced to just its counters.
 *
 * Narrower than {@link listingFingerprint} on purpose. This answers one question — "would
 * any row's number look different?" — for the roll-up, which re-derives an ancestor every
 * time a page lands anywhere beneath it. Comparing whole listings there would report a
 * change whenever a message's relative time crossed a minute boundary, and repaint a list
 * somebody is reading in order to say nothing.
 */
function unreadVector(entries: readonly VNode[]): string {
  return entries.map((entry) => `${entry.name}\u0000${entry.unreadCount ?? ''}`).join('\u0001');
}

/**
 * A listing reduced to what a reader would actually notice about it.
 *
 * Used to decide whether a background refresh found anything worth telling anyone about.
 * Object identity is useless here — every refresh builds new objects — and deep equality
 * over whole nodes would fire on fields nobody displays, so this covers exactly the things
 * a list view renders. `flags` is in deliberately: a message going from unread to read is
 * a change the user very much wants to see land.
 */
function listingFingerprint(entries: readonly VNode[]): string {
  return entries
    .map((entry) =>
      [
        entry.id,
        entry.name,
        entry.kind,
        entry.title ?? '',
        entry.author ?? '',
        entry.summary ?? '',
        entry.mtime === undefined ? '' : entry.mtime.getTime(),
        (entry.flags ?? []).join(','),
        // A folder whose counter moved has changed as far as anyone reading the list is
        // concerned, even though every other field is identical. Leaving this out meant a
        // corrected count was computed, compared, found "unchanged" and dropped.
        entry.unreadCount ?? '',
      ].join('\u0000'),
    )
    .join('\u0001');
}

function decodeOffsetCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || !cursor.startsWith(OFFSET_PREFIX)) return undefined;
  const value = Number(cursor.slice(OFFSET_PREFIX.length));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Raised when a source misses its deadline; never escapes `#searchOneSource`. */
class SourceTimeout extends Error {
  constructor() {
    super('Source timed out.');
    this.name = 'SourceTimeout';
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * True for a cancellation rather than a failure.
 *
 * A walk swallows failures so one bad folder cannot cost you the rest, but cancellation
 * is not a failure — it is the caller changing their mind, and continuing to walk after
 * it would ignore the only instruction that matters.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Order merged hits by relevance.
 *
 * Across four unrelated backends there is no shared natural order — a mail folder's
 * order, a chat's order and a repository's order have nothing to say to each other — so
 * the query itself has to supply one. Ties break on recency and then on path, because a
 * search whose result order changes between two identical runs is unusable for someone
 * reading it one line at a time.
 */
export function rankHits(nodes: readonly VNode[], query: Query): VNode[] {
  const scored = nodes.map((node, index) => ({ node, index, score: scoreQuery(query, node) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const recency = (b.node.mtime?.getTime() ?? 0) - (a.node.mtime?.getTime() ?? 0);
    if (recency !== 0) return recency;
    const path = (a.node.path ?? a.node.name).localeCompare(b.node.path ?? b.node.name);
    return path !== 0 ? path : a.index - b.index;
  });
  return scored.map((entry) => entry.node);
}

export function sortNodes(nodes: readonly VNode[], sort: SortSpec): VNode[] {
  const direction = sort.direction === 'desc' ? -1 : 1;
  const compare = (a: VNode, b: VNode): number => {
    switch (sort.field) {
      case 'date':
        return (a.mtime?.getTime() ?? 0) - (b.mtime?.getTime() ?? 0);
      case 'author':
        return (a.author ?? '').localeCompare(b.author ?? '');
      case 'size':
        return (a.size ?? 0) - (b.size ?? 0);
      case 'name':
      default:
        return a.name.localeCompare(b.name);
    }
  };
  // Directories always sort before files, matching `ls --group-directories-first`, so the
  // structure of a place is announced before its contents.
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return compare(a, b) * direction;
  });
}



