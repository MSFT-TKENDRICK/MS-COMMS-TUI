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
import { NameAllocator, sanitizeSegment } from './naming.js';
import {
  evaluateQuery,
  isMatchAll,
  requiresContent,
  stringifyQuery,
  type Query,
} from './query.js';
import type {
  ActionDescriptor,
  ActionResult,
  Capability,
  Document,
  ListOptions,
  ListPage,
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
}

export class Vfs {
  readonly #mounts = new Map<string, Mount>();
  readonly #dirCache: TtlCache<DirectoryIndex>;
  readonly #docCache: TtlCache<Document>;
  readonly #defaultPageSize: number;
  readonly #serveStaleOnError: boolean;
  readonly #now: () => number;

  constructor(options: VfsOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#defaultPageSize = options.pageSize ?? 50;
    this.#serveStaleOnError = options.serveStaleOnError ?? true;
    const cacheOptions = {
      ttlMs: options.ttlMs ?? 60_000,
      maxEntries: options.maxCacheEntries ?? 2_000,
      now: this.#now,
    };
    this.#dirCache = new TtlCache<DirectoryIndex>(cacheOptions);
    this.#docCache = new TtlCache<Document>({ ...cacheOptions, ttlMs: 5 * 60_000 });
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
  // Cache control
  // -------------------------------------------------------------------------

  /** Drop cached listings and documents at or beneath `path`. */
  invalidate(path: string): void {
    const normalized = vpath.normalize(path);
    if (normalized === vpath.ROOT) {
      this.#dirCache.clear();
      this.#docCache.clear();
      return;
    }
    this.#dirCache.delete(normalized);
    this.#dirCache.invalidatePrefix(normalized);
    this.#docCache.delete(normalized);
    this.#docCache.invalidatePrefix(normalized);
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
    options: ListOptions & { refresh?: boolean } = {},
  ): Promise<VfsListResult> {
    const { mount, node, synthetic, path: normalized } = await this.#locate(target, options);

    if (mount === undefined && synthetic) {
      return this.#listSynthetic(normalized, options);
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

    return {
      path: normalized,
      entries: sorted,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.fromCache === undefined ? {} : { fromCache: page.fromCache }),
      undecided,
      stale,
      ...(staleAgeMs === undefined ? {} : { staleAgeMs }),
    };
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

    try {
      const doc = await owner.provider.read(node, options);
      this.#docCache.set(normalized, doc);
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
   * Native results get the same treatment `list` gives: the query is re-applied locally
   * unless the provider explicitly claims it applied the whole thing, and every name is
   * run through the naming rules. Search is the one place where results from many
   * directories land in one list, so names are shown relative to the search root — both
   * because the user wants to know *where* a hit lives, and because a bare leaf name is
   * not unique across folders.
   */
  async search(
    path: string,
    query: Query,
    options: ListOptions & { maxNodes?: number; maxDepth?: number } = {},
  ): Promise<VfsListResult> {
    const normalized = vpath.normalize(path);
    const located = this.findMount(normalized);

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

      seen.set(name, {
        name,
        kind: 'dir',
        title: isMountRoot ? (mount.description ?? mount.provider.displayName) : name,
        id: isMountRoot ? `mount:${mount.id}` : `synthetic:${childPath}`,
        path: childPath,
        meta: isMountRoot
          ? { mount: mount.id, provider: mount.provider.id, capabilities: [...mount.provider.capabilities].join(',') }
          : { synthetic: true },
      });
    }

    const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { path, entries, total: entries.length, undecided: 0, stale: false };
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

    const providerOptions: ListOptions = {
      ...options,
      ...(options.cursor !== undefined && offset === undefined ? { cursor: options.cursor } : {}),
    };
    if (offset !== undefined) delete (providerOptions as { cursor?: string }).cursor;

    const page = await mount.provider.list(node, providerOptions);
    const merged = this.#mergeIntoIndex(path, page, options.cursor === undefined && offset === undefined);

    return {
      entries: merged,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.appliedQuery === undefined ? {} : { appliedQuery: page.appliedQuery }),
    };
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

  /** Breadth-first fallback search for providers with no native search. */
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
    const contentNeeded = requiresContent(query);

    while (queue.length > 0 && visited < maxNodes && matches.length < limit) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > maxDepth) continue;

      let page: VfsListResult;
      try {
        page = await this.list(current.path, {
          limit: 200,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch {
        // One unreadable subtree (permissions, a revoked scope) must not abort the search.
        continue;
      }

      for (const entry of page.entries) {
        visited += 1;
        const verdict = evaluateQuery(query, entry);
        if (verdict === true) {
          matches.push(entry);
          if (matches.length >= limit) break;
        } else if (verdict === 'unknown') {
          undecided += 1;
        }
        if (entry.kind === 'dir' && entry.path !== undefined) {
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

function decodeOffsetCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || !cursor.startsWith(OFFSET_PREFIX)) return undefined;
  const value = Number(cursor.slice(OFFSET_PREFIX.length));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
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
