/**
 * Predictive cache-ahead.
 *
 * The snapshot makes a *revisit* instant. This module is what makes a *first* visit feel
 * instant, by working out where the user is about to go and fetching it while they are
 * still reading where they are.
 *
 * The opportunity is specific to this interface and quite large. A line shell is not a
 * GUI: between `ls` finishing and the next command arriving there are seconds of a human
 * reading — and for a screen-reader user, who is having the listing spoken to them, often
 * tens of seconds. That is a long time to leave the network idle when the set of things
 * they might do next is small and highly predictable.
 *
 * Four rules keep speculation from becoming a liability:
 *
 * IT IS INVISIBLE WHEN IT FAILS. A prefetch that errors is swallowed. It was work nobody
 * asked for; surfacing its failure would mean a user seeing errors about a folder they
 * never opened, which is worse than the fetch simply not having happened.
 *
 * IT YIELDS TO REAL WORK. Speculation runs at low concurrency and is abandoned the moment
 * the user goes somewhere else. Prefetch that competes with the command actually being
 * typed makes the tool slower, which is the exact opposite of the point.
 *
 * IT IS BOUNDED, AND IT COSTS THE USER'S API QUOTA. Every speculative fetch is a real
 * request against a corporate tenant with real rate limits. Guessing badly does not just
 * waste time, it spends the budget that the next foreground `ls` needs. So predictions
 * are ranked, only the top few are issued, and a wrong guess is cheap by construction.
 *
 * IT NEVER CHANGES WHAT IS TRUE. Prefetch only fills the snapshot. It never marks
 * anything read, never advances a poll cursor the foreground would need, and never
 * decides a listing is complete.
 */

import { NULL_LOGGER } from './logging.js';
import type { Logger, VNode } from './provider.js';
import * as vpath from './vpath.js';

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * Lower runs first. Named rather than numeric at call sites so the ordering is a stated
 * policy rather than a scattering of magic numbers.
 */
export const PREFETCH_PRIORITY = {
  /** The next page of the directory the user is standing in. They are one `more` away. */
  nextPage: 0,
  /** Bodies of the items just listed. They are one `cat 3` away. */
  document: 10,
  /** Subdirectories just listed. They are one `cd` away. */
  child: 20,
  /** Somewhere this user has historically gone from here. */
  learned: 30,
  /** Siblings of the current directory. `cd ../other` is common and cheap to cover. */
  sibling: 40,
} as const;

export interface PrefetchTask {
  /** Dedupe identity. Re-scheduling a key already queued or running is a no-op. */
  readonly key: string;
  readonly priority: number;
  readonly path: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface PrefetchQueueOptions {
  /**
   * How many speculative fetches may be in flight.
   *
   * Two, not eight. This shares a rate limit with the foreground, and the goal is to use
   * the idle time between commands rather than to saturate the link — a burst of eight
   * speculative requests is how a prefetcher turns into the reason `ls` got throttled.
   */
  readonly concurrency?: number;
  readonly logger?: Logger;
  /** Ceiling on queued-but-not-started tasks. Beyond it, the worst-ranked are dropped. */
  readonly maxQueued?: number;
}

interface QueuedTask {
  readonly task: PrefetchTask;
  readonly sequence: number;
}

export interface PrefetchStats {
  readonly issued: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly queued: number;
  readonly running: number;
}

/**
 * A bounded, deduplicating, cancellable background work queue.
 *
 * Not a generic job runner: everything here exists because the work is *speculative*, and
 * speculative work has different rules from work somebody is waiting for.
 */
export class PrefetchQueue {
  readonly #queue: QueuedTask[] = [];
  readonly #running = new Map<string, AbortController>();
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #logger: Logger;

  #sequence = 0;
  #issued = 0;
  #completed = 0;
  #failed = 0;
  #canceled = 0;
  #disposed = false;
  #pumpScheduled = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: PrefetchQueueOptions = {}) {
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#maxQueued = Math.max(1, options.maxQueued ?? 64);
    this.#logger = options.logger ?? NULL_LOGGER;
  }

  get stats(): PrefetchStats {
    return {
      issued: this.#issued,
      completed: this.#completed,
      failed: this.#failed,
      canceled: this.#canceled,
      queued: this.#queue.length,
      running: this.#running.size,
    };
  }

  /** Enqueue unless the same key is already queued or in flight. Returns false if dropped. */
  schedule(task: PrefetchTask): boolean {
    if (this.#disposed) return false;
    if (this.#running.has(task.key)) return false;
    if (this.#queue.some((entry) => entry.task.key === task.key)) return false;

    this.#queue.push({ task, sequence: this.#sequence++ });
    // Priority first, then arrival order, so equal-priority work stays FIFO and a
    // long-running session cannot starve a task that has been waiting.
    this.#queue.sort((a, b) => a.task.priority - b.task.priority || a.sequence - b.sequence);

    if (this.#queue.length > this.#maxQueued) {
      const dropped = this.#queue.splice(this.#maxQueued);
      this.#canceled += dropped.length;
    }

    this.#schedulePump();
    return true;
  }

  /**
   * Start work on a microtask rather than immediately.
   *
   * Predictions arrive as a batch — one `predict()` call produces a page fetch, some
   * bodies and some children — and pumping on the first `schedule()` would hand the only
   * free slot to whichever happened to be scheduled first. Coalescing to the end of the
   * turn lets the whole batch land and sort, so `priority` decides what runs rather than
   * the caller's loop order. It also makes the priority field authoritative instead of
   * advisory, which is the only way a later caller can rely on it.
   */
  #schedulePump(): void {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pump();
    });
  }

  /**
   * Abandon queued work, and optionally kill what is already running.
   *
   * Called when the user navigates: predictions made from the old location are now
   * guesses about a place they have left. Running tasks are left alone by default
   * because they are usually nearly done and their result is still cached usefully;
   * `includeRunning` exists for shutdown, where finishing is pointless.
   *
   * `minPriority` cancels tasks *at or worse than* that rank — remember lower numbers run
   * first — so `minPriority: PREFETCH_PRIORITY.document` drops bodies, children, learned
   * and siblings while leaving the next-page fetch alone. Omitting it cancels everything.
   */
  cancel(
    options: { minPriority?: number; includeRunning?: boolean; keep?: (task: PrefetchTask) => boolean } = {},
  ): number {
    const threshold = options.minPriority ?? Number.NEGATIVE_INFINITY;
    let removed = 0;
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const entry = this.#queue[i] as QueuedTask;
      if (entry.task.priority < threshold) continue;
      if (options.keep?.(entry.task) === true) continue;
      this.#queue.splice(i, 1);
      removed += 1;
    }
    if (options.includeRunning === true) {
      for (const controller of this.#running.values()) controller.abort();
    }
    this.#canceled += removed;
    this.#settleIfIdle();
    return removed;
  }

  /** Resolves when nothing is queued or running. For tests and for orderly shutdown. */
  async idle(): Promise<void> {
    if (this.#queue.length === 0 && this.#running.size === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  dispose(): void {
    this.#disposed = true;
    this.cancel({ includeRunning: true });
  }

  #pump(): void {
    while (this.#running.size < this.#concurrency && this.#queue.length > 0) {
      const entry = this.#queue.shift() as QueuedTask;
      const controller = new AbortController();
      this.#running.set(entry.task.key, controller);
      this.#issued += 1;

      void entry.task
        .run(controller.signal)
        .then(() => {
          this.#completed += 1;
        })
        .catch((error: unknown) => {
          this.#failed += 1;
          // Deliberately debug, not warn. Nobody asked for this fetch, so a failure is
          // not news; it becomes news only when the user actually goes there and the
          // foreground request fails too, at which point they get a real error.
          this.#logger.debug('Prefetch failed.', { path: entry.task.path, error: String(error) });
        })
        .finally(() => {
          this.#running.delete(entry.task.key);
          this.#pump();
          this.#settleIfIdle();
        });
    }
    this.#settleIfIdle();
  }

  #settleIfIdle(): void {
    if (this.#queue.length > 0 || this.#running.size > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

// ---------------------------------------------------------------------------
// The predictor
// ---------------------------------------------------------------------------

export interface PredictedTarget {
  readonly path: string;
  readonly kind: 'directory' | 'document';
  readonly priority: number;
  /** Why this was predicted. Surfaced by `cache status` so the guessing is inspectable. */
  readonly reason: 'next-page' | 'document' | 'child' | 'learned' | 'sibling';
  readonly cursor?: string;
}

export interface PredictorOptions {
  /** How many item bodies to warm from a listing. */
  readonly documents?: number;
  /** How many subdirectories to warm. */
  readonly children?: number;
  /** How many sibling directories to warm. */
  readonly siblings?: number;
  /** How many learned destinations to warm. */
  readonly learned?: number;
  /** Transition counts recovered from a previous session. */
  readonly history?: ReadonlyArray<{ from: string; to: string; count: number }>;
}

/**
 * Where the user is likely to go next.
 *
 * The static part of the guess — next page, then bodies, then subdirectories, then
 * siblings — is just the shape of the command set: after `ls` the only things you can do
 * are `more`, `cat`, `cd` into something you were shown, or `cd ..` and across.
 *
 * The learned part is a first-order Markov chain over directories actually visited. It is
 * first-order on purpose. Longer contexts fit a session's noise: people navigate in short
 * bursts, so a second-order model mostly memorises one afternoon and then confidently
 * mispredicts for a week. "From here, where did you go last time" is the part of the
 * signal that is stable, and it is genuinely strong — the same four folders account for
 * most of anyone's mail navigation.
 */
export class NavigationPredictor {
  readonly #transitions = new Map<string, Map<string, number>>();
  readonly #options: Required<Omit<PredictorOptions, 'history'>>;
  #last: string | undefined;
  #dirty = false;

  constructor(options: PredictorOptions = {}) {
    this.#options = {
      documents: options.documents ?? 5,
      children: options.children ?? 3,
      siblings: options.siblings ?? 2,
      learned: options.learned ?? 2,
    };
    for (const entry of options.history ?? []) {
      this.#bucket(entry.from).set(entry.to, entry.count);
    }
  }

  /** True when transitions have changed since they were last persisted. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Note that the user is now at `path`, learning the edge that got them there. */
  record(path: string): void {
    const normalized = vpath.normalize(path);
    if (this.#last !== undefined && this.#last !== normalized) {
      const bucket = this.#bucket(this.#last);
      bucket.set(normalized, (bucket.get(normalized) ?? 0) + 1);
      this.#dirty = true;
    }
    this.#last = normalized;
  }

  /**
   * Install a transition count recovered from a previous session.
   *
   * Kept separate from {@link record} because loading history is I/O and therefore happens
   * after construction, and because a restored edge must not be treated as something the
   * user just did — it sets no `last`, so the first real navigation of the session does
   * not invent an edge from wherever the previous session happened to end.
   */
  learn(from: string, to: string, count: number): void {
    if (count <= 0) return;
    this.#bucket(vpath.normalize(from)).set(vpath.normalize(to), count);
  }

  /** Every learned edge, for persisting into the snapshot. */
  transitions(): ReadonlyArray<{ from: string; to: string; count: number }> {
    const out: Array<{ from: string; to: string; count: number }> = [];
    for (const [from, bucket] of this.#transitions) {
      for (const [to, count] of bucket) out.push({ from, to, count });
    }
    this.#dirty = false;
    return out;
  }

  /**
   * Rank what to warm after listing `path`.
   *
   * `entries` is the listing the user was just shown, which is what makes the guess
   * concrete rather than statistical: those names are on their screen right now, so a
   * `cd` or a `cat` can only land on one of them.
   */
  predict(
    path: string,
    entries: readonly VNode[],
    options: { cursor?: string; siblings?: readonly string[] } = {},
  ): readonly PredictedTarget[] {
    const normalized = vpath.normalize(path);
    const targets: PredictedTarget[] = [];

    if (options.cursor !== undefined) {
      targets.push({
        path: normalized,
        kind: 'directory',
        priority: PREFETCH_PRIORITY.nextPage,
        reason: 'next-page',
        cursor: options.cursor,
      });
    }

    let documents = 0;
    let children = 0;
    for (const entry of entries) {
      const target = entry.path ?? vpath.join(normalized, entry.name);
      if (entry.kind === 'file') {
        if (documents >= this.#options.documents) continue;
        documents += 1;
        targets.push({ path: target, kind: 'document', priority: PREFETCH_PRIORITY.document, reason: 'document' });
      } else {
        if (children >= this.#options.children) continue;
        children += 1;
        targets.push({ path: target, kind: 'directory', priority: PREFETCH_PRIORITY.child, reason: 'child' });
      }
    }

    const seen = new Set(targets.map((t) => t.path));
    for (const learned of this.#rank(normalized, this.#options.learned)) {
      if (seen.has(learned)) continue;
      seen.add(learned);
      targets.push({ path: learned, kind: 'directory', priority: PREFETCH_PRIORITY.learned, reason: 'learned' });
    }

    let siblings = 0;
    for (const sibling of options.siblings ?? []) {
      if (siblings >= this.#options.siblings) break;
      const candidate = vpath.normalize(sibling);
      if (candidate === normalized || seen.has(candidate)) continue;
      seen.add(candidate);
      siblings += 1;
      targets.push({ path: candidate, kind: 'directory', priority: PREFETCH_PRIORITY.sibling, reason: 'sibling' });
    }

    // Returned in rank order, not in the order the pieces were assembled. `predict` says
    // it ranks, so a caller that takes the first few must get the best few — the queue
    // sorts too, but a caller that truncates before scheduling would otherwise silently
    // throw away the page fetch in favour of whichever body happened to be listed first.
    return targets.sort((a, b) => a.priority - b.priority);
  }

  #rank(from: string, count: number): readonly string[] {
    const bucket = this.#transitions.get(from);
    if (bucket === undefined) return [];
    return [...bucket.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, count)
      .map(([to]) => to);
  }

  #bucket(from: string): Map<string, number> {
    let bucket = this.#transitions.get(from);
    if (bucket === undefined) {
      bucket = new Map();
      this.#transitions.set(from, bucket);
    }
    return bucket;
  }
}
