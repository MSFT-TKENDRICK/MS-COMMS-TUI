/**
 * Background preloading: keeping the snapshot warm without anybody waiting for it.
 *
 * The prefetcher in ./prefetch.js reacts to where the user just went. This reacts to
 * nothing — it runs on a timer and keeps the recent past of every mount on local disk, so
 * that the *first* command of a session already has an answer and so that search has
 * something to search before the network is consulted.
 *
 * WHAT "N MOST RECENT" MEANS HERE, AND WHY IT IS NOT NEGOTIABLE. A mailbox is unbounded.
 * A preloader without a limit is a program that downloads a corporate mail account onto a
 * laptop, which is a different product with a different threat model and was never asked
 * for. So the unit of work is "the first page or two of each directory, newest first",
 * and the retention rule in the snapshot enforces the ceiling independently — belt and
 * braces, because the two failure modes (a provider that ignores `limit`, a sync loop
 * that runs more often than expected) are different and either one alone fills a disk.
 *
 * HOW IT AVOIDS RE-DOWNLOADING EVERYTHING. Where a provider declares `poll`, the sync
 * resumes from its cursor — a Graph deltaLink, an ETag, a `since` timestamp — so a refresh
 * costs one request that usually returns nothing. That is the same primitive the watcher
 * already uses, and the cursors live in the snapshot next to the data they describe.
 * Where a provider has no `poll`, it falls back to re-listing the first page, which is
 * exactly as much work as the `ls` the user was going to do anyway.
 *
 * WHAT IT REFUSES TO DO. It does not walk the whole tree, it does not fetch bodies for
 * everything it sees, and it does not touch derived mounts — a projection holds nothing
 * of its own, so syncing one means fetching the same items a second time under a second
 * name. Depth is capped, page counts are capped, and a mount that errors is skipped and
 * retried next cycle rather than aborting the run.
 */

import { NULL_LOGGER } from './logging.js';
import type { Document, ListPage, Logger, Provider, VNode } from './provider.js';
import { DEFAULT_RECENT } from './snapshot.js';
import type { ToolCallsLike } from './agentfs.js';
import type { SnapshotStore } from './snapshot.js';
import * as vpath from './vpath.js';

/** The part of {@link ./vfs.js Vfs} the sync needs. Declared structurally to keep the
 * dependency one-way: the engine owns the sync, not the other way round. */
export interface SyncMount {
  readonly id: string;
  readonly path: string;
  readonly provider: Provider;
  readonly pageSize?: number;
}

export interface SyncHost {
  readonly mounts: readonly SyncMount[];
  /** Resolve a path to its node, so listings can be taken through the provider directly. */
  resolve(path: string, options?: { signal?: AbortSignal }): Promise<{ node: VNode | null }>;
  /**
   * Give a page of provider entries the names and paths the engine would give them.
   *
   * Sync calls providers directly — it has to, since its whole job is to bypass the caches
   * a normal `ls` is trying to hit. But a provider's `name` is raw backend text, not a
   * filename: it can contain a slash, be a reserved device name, carry a right-to-left
   * override, or collide with a sibling. The engine fixes all of that on the way out, and
   * a snapshot that skipped the fix would store paths that do not exist, and silently
   * merge two messages that happened to share a subject.
   *
   * So the names come from the engine, not from here. One naming implementation, one set
   * of paths, whether a listing arrived through the foreground or the background.
   */
  canonicalize(path: string, entries: readonly VNode[]): readonly VNode[];
}

export interface BackgroundSyncOptions {
  readonly host: SyncHost;
  readonly snapshot: SnapshotStore;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** How often a full cycle runs. Default five minutes. */
  readonly intervalMs?: number;
  /** How many items to hold per directory. The "n" of the brief. Default 200. */
  readonly recent?: number;
  /** How deep below a mount root to descend. Default 2 — mount, folders, their contents. */
  readonly depth?: number;
  /** Directories synced concurrently. Deliberately small; this shares a rate limit. */
  readonly concurrency?: number;
  /** Also snapshot bodies for this many of the newest items per directory. Default 0. */
  readonly bodies?: number;
  /** Cap on directories touched per cycle, so one enormous account cannot monopolise. */
  readonly maxDirectoriesPerCycle?: number;
  /**
   * Where to record provider calls. Absent means no audit trail is kept — the feature is
   * opt-in because it is a write per fetch, and a program that reads mail should not start
   * keeping records of you without being asked to.
   */
  readonly audit?: ToolCallsLike;
}

export interface SyncStatus {
  readonly running: boolean;
  readonly cycles: number;
  readonly lastStartedAt?: number;
  readonly lastFinishedAt?: number;
  readonly lastDurationMs?: number;
  readonly directories: number;
  readonly items: number;
  readonly bodies: number;
  readonly evicted: number;
  readonly errors: readonly string[];
}

export class BackgroundSync {
  readonly #host: SyncHost;
  readonly #snapshot: SnapshotStore;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #recent: number;
  readonly #depth: number;
  readonly #concurrency: number;
  readonly #bodies: number;
  readonly #maxDirectories: number;
  readonly #audit: ToolCallsLike | undefined;

  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<SyncStatus> | undefined;
  #controller: AbortController | undefined;
  #cycles = 0;
  #lastStartedAt: number | undefined;
  #lastFinishedAt: number | undefined;
  #lastDurationMs: number | undefined;
  #directories = 0;
  #items = 0;
  #bodyCount = 0;
  #evicted = 0;
  #errors: string[] = [];

  constructor(options: BackgroundSyncOptions) {
    this.#host = options.host;
    this.#snapshot = options.snapshot;
    this.#logger = (options.logger ?? NULL_LOGGER).child('sync');
    this.#now = options.now ?? Date.now;
    this.#intervalMs = Math.max(30_000, options.intervalMs ?? 5 * 60_000);
    this.#recent = Math.max(1, options.recent ?? DEFAULT_RECENT);
    this.#depth = Math.max(1, options.depth ?? 2);
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#bodies = Math.max(0, options.bodies ?? 0);
    this.#maxDirectories = Math.max(1, options.maxDirectoriesPerCycle ?? 64);
    this.#audit = options.audit;
  }

  /**
   * Run a provider call and record it in the AgentFS tool-call log.
   *
   * This program reads corporate mail in the background, on a timer, without anyone
   * watching. "Which mailboxes did it touch, when, and did it fail" should therefore be a
   * question with a real answer rather than an assurance, and `tool_calls` is an
   * insert-only table the specification provides for exactly that.
   *
   * Only the path and the shape of the result are recorded — never message content. An
   * audit trail that quietly became a second copy of your mail would be a worse privacy
   * problem than the one it set out to solve.
   *
   * Auditing never fails the call it is auditing. A cache that cannot write its log is a
   * program with a gap in its history, not a program that stops fetching mail.
   */
  async #audited<T>(name: string, parameters: unknown, run: () => Promise<T>, describe: (value: T) => unknown): Promise<T> {
    if (this.#audit === undefined) return run();
    const startedAt = Math.floor(this.#now() / 1000);
    const startedMs = this.#now();
    try {
      const value = await run();
      await this.#record(name, startedAt, startedMs, parameters, describe(value), undefined);
      return value;
    } catch (error) {
      await this.#record(name, startedAt, startedMs, parameters, undefined, String(error));
      throw error;
    }
  }

  async #record(
    name: string,
    startedAt: number,
    startedMs: number,
    parameters: unknown,
    result: unknown,
    error: string | undefined,
  ): Promise<void> {
    try {
      // The specification requires duration_ms to equal (completed_at - started_at) * 1000,
      // so completed_at is derived from the elapsed milliseconds rather than sampled again.
      const elapsedMs = Math.max(0, this.#now() - startedMs);
      const completedAt = startedAt + Math.round(elapsedMs / 1000);
      await this.#audit?.record(name, startedAt, completedAt, parameters, result, error);
    } catch (failure) {
      this.#logger.debug('could not write the audit record', { name, error: String(failure) });
    }
  }

  get status(): SyncStatus {
    return {
      running: this.#inFlight !== undefined,
      cycles: this.#cycles,
      ...(this.#lastStartedAt === undefined ? {} : { lastStartedAt: this.#lastStartedAt }),
      ...(this.#lastFinishedAt === undefined ? {} : { lastFinishedAt: this.#lastFinishedAt }),
      ...(this.#lastDurationMs === undefined ? {} : { lastDurationMs: this.#lastDurationMs }),
      directories: this.#directories,
      items: this.#items,
      bodies: this.#bodyCount,
      evicted: this.#evicted,
      errors: [...this.#errors],
    };
  }

  /**
   * Begin cycling.
   *
   * The timer is unref'd so that a background sync can never be the reason a one-shot
   * `mscomms ls` fails to exit. A process that will not quit because a cache is warming
   * is a bug that gets reported as "the CLI hangs".
   */
  start(): void {
    if (this.#timer !== undefined) return;
    void this.runOnce();
    this.#timer = setInterval(() => void this.runOnce(), this.#intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#controller?.abort();
    await this.#inFlight?.catch(() => undefined);
  }

  /**
   * Run a single cycle, or join the one already running.
   *
   * Joining rather than queueing matters: `start()` fires immediately and then on a timer,
   * and a slow first cycle on a big account would otherwise stack up runs that each
   * re-fetch what the previous one is still fetching.
   */
  async runOnce(): Promise<SyncStatus> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const controller = new AbortController();
    this.#controller = controller;
    this.#inFlight = this.#cycle(controller.signal).finally(() => {
      this.#inFlight = undefined;
      this.#controller = undefined;
    });
    return this.#inFlight;
  }

  async #cycle(signal: AbortSignal): Promise<SyncStatus> {
    const started = this.#now();
    this.#lastStartedAt = started;
    this.#errors = [];

    const queue: Array<{ mount: SyncMount; path: string; depth: number }> = [];
    for (const mount of this.#host.mounts) {
      // Derived mounts (projections) hold nothing of their own. Syncing one downloads the
      // same items again under a different path and doubles the snapshot for no gain.
      if (mount.provider.derived === true) continue;
      if (!mount.provider.capabilities.has('list')) continue;
      queue.push({ mount, path: mount.path, depth: 0 });
    }

    let touched = 0;
    const workers: Array<Promise<void>> = [];
    const next = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const job = queue.shift();
        if (job === undefined) return;
        if (touched >= this.#maxDirectories) return;
        touched += 1;
        try {
          const children = await this.#syncDirectory(job.mount, job.path, signal);
          if (job.depth + 1 < this.#depth) {
            for (const child of children) {
              queue.push({ mount: job.mount, path: child, depth: job.depth + 1 });
            }
          }
        } catch (error) {
          // One unreadable folder must not cost the other nine, exactly as in the search
          // walk. It is recorded and retried next cycle.
          const message = `${job.path}: ${error instanceof Error ? error.message : String(error)}`;
          if (this.#errors.length < 20) this.#errors.push(message);
          this.#logger.debug('Sync skipped a directory.', { path: job.path, error: message });
        }
      }
    };

    for (let i = 0; i < this.#concurrency; i += 1) workers.push(next());
    await Promise.all(workers);

    this.#evicted += await this.#snapshot.prune().catch(() => 0);

    this.#cycles += 1;
    this.#lastFinishedAt = this.#now();
    this.#lastDurationMs = this.#lastFinishedAt - started;
    this.#logger.debug('Sync cycle finished.', {
      directories: touched,
      durationMs: this.#lastDurationMs,
      errors: this.#errors.length,
    });
    return this.status;
  }

  /**
   * Bring one directory up to date and report its subdirectories.
   *
   * The `poll` path is the cheap one and is tried first: a provider with a resumable
   * cursor answers "nothing changed" in a single request, which is what makes a five
   * minute cycle affordable against a real tenant. It deliberately does not *replace* the
   * listing — a delta describes changes, not order — so a change simply triggers the
   * re-list that a change warrants.
   */
  async #syncDirectory(mount: SyncMount, path: string, signal: AbortSignal): Promise<readonly string[]> {
    const { node } = await this.#host.resolve(path, { signal });

    if (mount.provider.capabilities.has('poll') && mount.provider.poll !== undefined) {
      const cursor = await this.#snapshot.pollCursor(mount.id, path);
      if (cursor !== undefined) {
        const result = await mount.provider.poll(node, cursor, { signal });
        await this.#snapshot.setPollCursor(mount.id, path, result.cursor ?? cursor);
        if (result.changes.length === 0) {
          const existing = await this.#snapshot.listing(path, { limit: this.#recent });
          if (existing !== undefined) {
            return existing.entries.filter((entry) => entry.kind === 'dir').map((entry) => childPath(path, entry));
          }
        }
      }
    }

    const pageSize = mount.pageSize ?? 50;
    const seen: VNode[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const maxPages = Math.ceil(this.#recent / pageSize);

    do {
      if (signal.aborted) break;
      const page: ListPage = await this.#audited(
        'provider.list',
        { path, mount: mount.id },
        () =>
          mount.provider.list(node, {
            limit: Math.min(pageSize, this.#recent - seen.length),
            ...(cursor === undefined ? {} : { cursor }),
            signal,
          }),
        (result) => ({ entries: result.entries.length, more: result.cursor !== undefined }),
      );
      const withPaths = this.#host.canonicalize(path, page.entries);
      await this.#snapshot.putListing({
        mountId: mount.id,
        path,
        entries: withPaths,
        page: { ...(page.cursor === undefined ? {} : { cursor: page.cursor }), ...(page.total === undefined ? {} : { total: page.total }) },
        isFirstPage: pages === 0,
        complete: page.cursor === undefined,
      });
      seen.push(...withPaths);
      this.#items += withPaths.length;
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined && seen.length < this.#recent && pages < maxPages);

    if (mount.provider.capabilities.has('poll') && mount.provider.poll !== undefined) {
      // Establish a cursor if there was not one, so the *next* cycle can be the cheap kind.
      const existing = await this.#snapshot.pollCursor(mount.id, path);
      if (existing === undefined) {
        const result = await mount.provider.poll(node, undefined, { signal }).catch(() => undefined);
        if (result?.cursor !== undefined) await this.#snapshot.setPollCursor(mount.id, path, result.cursor);
      }
    }

    await this.#syncBodies(mount, seen, signal);
    this.#directories += 1;

    return seen.filter((entry) => entry.kind === 'dir').map((entry) => entry.path ?? childPath(path, entry));
  }

  /**
   * Snapshot the bodies of the newest few items.
   *
   * Off by default, and capped hard when on. Bodies are the expensive part — one request
   * each, and by far the largest thing stored — so this is the setting that turns a
   * cache into a mirror if it is set carelessly. It exists because for a *small* number
   * of very recent messages it is exactly right: those are the ones about to be read,
   * and having them makes `cat` instant and `body:` answerable offline.
   */
  async #syncBodies(mount: SyncMount, entries: readonly VNode[], signal: AbortSignal): Promise<void> {
    if (this.#bodies === 0) return;
    if (!mount.provider.capabilities.has('read') || mount.provider.read === undefined) return;
    // Bound to a local so the narrowing above survives into the closure below. `read` is
    // optional on the provider, and a deferred call loses what the guard proved.
    const read = mount.provider.read.bind(mount.provider);

    const newest = entries
      .filter((entry) => entry.kind === 'file')
      .slice()
      .sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0))
      .slice(0, this.#bodies);

    for (const entry of newest) {
      if (signal.aborted) return;
      if (entry.path === undefined) continue;
      const existing = await this.#snapshot.document(entry.path);
      if (existing !== undefined) continue;
      try {
        const doc: Document = await this.#audited(
          'provider.read',
          { path: entry.path, mount: mount.id },
          () => read(entry, { signal }),
          // Length, not text. The point is that a body was fetched, not what it said.
          (result) => ({ format: result.format, bytes: result.body.length }),
        );
        await this.#snapshot.putDocument(mount.id, entry, doc);
        this.#bodyCount += 1;
      } catch (error) {
        // Not surfaced to the user: they did not ask for this body, and they will get a
        // real error if and when they open it. But it is logged, because a *systematic*
        // failure here — a schema mismatch, a provider returning something unstorable —
        // otherwise looks identical to "bodies is switched off" forever.
        this.#logger.debug('Sync could not store a body.', {
          path: entry.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function childPath(parent: string, node: VNode): string {
  return vpath.join(parent, node.name);
}

