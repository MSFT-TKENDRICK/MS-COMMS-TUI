/**
 * A bounded, TTL'd cache with prefix invalidation.
 *
 * Caching is not an optimization here, it is a correctness and resilience feature. The
 * single biggest cause of death among the tools surveyed in docs/PRIOR-ART.md was the
 * backend vendor changing or revoking API access. A tool whose entire UI is a thin
 * passthrough to a live API becomes a brick the moment that happens. Because every
 * listing and body is cached on disk-backed state, this one keeps working read-only when
 * the network, the token, or the vendor's goodwill goes away.
 */

export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
  readonly storedAt: number;
}

export interface CacheOptions {
  /** Default time-to-live in milliseconds. */
  readonly ttlMs?: number;
  /** Maximum number of live entries before least-recently-used eviction. */
  readonly maxEntries?: number;
  /** Injectable clock, so tests do not have to sleep. */
  readonly now?: () => number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly stale: number;
  readonly size: number;
}

export class TtlCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  #hits = 0;
  #misses = 0;
  #stale = 0;

  constructor(options: CacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 2_000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get stats(): CacheStats {
    return { hits: this.#hits, misses: this.#misses, stale: this.#stale, size: this.#entries.size };
  }

  /** Fresh value, or undefined when absent or expired. */
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#stale += 1;
      this.#misses += 1;
      return undefined;
    }
    // Refresh recency for LRU: Map preserves insertion order, so re-inserting moves it last.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits += 1;
    return entry.value;
  }

  /**
   * Value even if expired, plus its age. This is what powers offline and degraded modes:
   * when the network fails we would rather show a user their mail from ten minutes ago,
   * clearly labelled as stale, than show them an error.
   */
  getStale(key: string): { value: T; ageMs: number; expired: boolean } | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.#now();
    return { value: entry.value, ageMs: now - entry.storedAt, expired: entry.expiresAt <= now };
  }

  set(key: string, value: T, ttlMs?: number): void {
    const now = this.#now();
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, { value, storedAt: now, expiresAt: now + (ttlMs ?? this.#ttlMs) });
    this.#evict();
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  /**
   * Drop every entry whose key is `prefix` or starts with `prefix` followed by the
   * delimiter. Segment-aware so invalidating `/mail` does not also blow away `/mailbox`.
   */
  invalidatePrefix(prefix: string, delimiter = '/'): number {
    let removed = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key === prefix || key.startsWith(prefix.endsWith(delimiter) ? prefix : prefix + delimiter)) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.#entries.clear();
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}
