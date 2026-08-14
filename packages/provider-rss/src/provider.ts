/**
 * The RSS/Atom provider.
 *
 * This is the provider that proves the abstraction is real. Mail, chat and issues are all
 * "conversations"; a feed is not, yet it maps onto the same tree, the same query language,
 * the same notifications and the same key bindings without the engine knowing anything
 * about it. If feeds had needed a special case, the plugin boundary would be in the wrong
 * place.
 *
 * It is also the cheapest possible answer to "will this tool still work when a vendor
 * turns off their API?" — a feed is a file over HTTP, and nobody has to approve an OAuth
 * scope for it.
 */

import {
  VfsError,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
  type Capability,
  type Document,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type ReadOptions,
  type VNode,
} from '@mscomms/core';
import { parseFeed, type Feed, type FeedItem } from './feed.js';

export interface RssFeedConfig {
  readonly name: string;
  readonly url: string;
  readonly description?: string;
}

export interface RssProviderOptions {
  /** Several feeds, each becoming a directory. */
  readonly feeds?: readonly RssFeedConfig[];
  /** A single feed, whose items appear directly at the mount point. */
  readonly url?: string;
  readonly name?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  readonly maxItems?: number;
  /** How long a fetched feed is reused before refetching. */
  readonly refreshMs?: number;
}

interface CachedFeed {
  readonly feed: Feed;
  readonly fetchedAt: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

/**
 * What this mount remembers about a feed between sessions.
 *
 * `seen` is the read state, and it is a set of ids for the same reason the poll cursor is:
 * a distressing number of feeds emit items with no date, with the fetch time as the date,
 * or with dates that move backwards when an article is edited. Identity is the only field
 * that behaves.
 *
 * `unread` and `total` are the last computed counts, carried so that listing the feeds
 * themselves can put a number on each row without making N HTTP requests to do it.
 */
interface ReadState {
  readonly seen: ReadonlySet<string>;
  readonly unread: number;
  readonly total: number;
}

/**
 * How far back read state is tracked, in items.
 *
 * It bounds the stored id set, and it also decides the answer to "is this old thing
 * unread?" — anything past the window counts as read. Both directions of the alternative
 * are worse: an unbounded set grows forever, and a set truncated without also truncating
 * the question would make every item that falls out of it unread again.
 */
const TRACKED_ITEMS = 500;

const DEFAULT_TIMEOUT = 15_000;

export class RssProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll', 'actions']);

  readonly #feeds: readonly RssFeedConfig[];
  readonly #single: boolean;
  readonly #options: RssProviderOptions;
  readonly #context: ProviderContext;
  readonly #cache = new Map<string, CachedFeed>();
  /**
   * Loaded read state, by feed url. A key present with an `undefined` value means "checked
   * the store, this feed has never been seen" — which is a different thing from "not
   * loaded yet", and the difference is what makes the cold start silent exactly once.
   */
  readonly #readState = new Map<string, ReadState | undefined>();

  constructor(options: RssProviderOptions, context: ProviderContext) {
    this.#options = options;
    this.#context = context;

    if (options.url !== undefined) {
      this.#single = true;
      this.#feeds = [{ name: options.name ?? hostOf(options.url), url: options.url }];
    } else {
      this.#single = false;
      this.#feeds = options.feeds ?? [];
    }

    this.id = `rss:${context.mountPath}`;
    this.displayName = options.name ?? (this.#single ? (this.#feeds[0]?.name ?? 'Feed') : 'Feeds');
  }

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    if (parent === null && !this.#single) {
      const entries: VNode[] = await Promise.all(
        this.#feeds.map(async (feed) => {
          const counts = await this.#counts(feed);
          return {
            name: feed.name,
            kind: 'dir' as const,
            subtype: 'feed',
            title: feed.name,
            id: `feed:${feed.url}`,
            ...(feed.description === undefined ? {} : { summary: feed.description }),
            ...(counts === undefined ? {} : { childCount: counts.total, unreadCount: counts.unread }),
            meta: { url: feed.url },
          };
        }),
      );
      return { entries, total: entries.length };
    }

    const config = this.#feedFor(parent);
    const feed = await this.#fetch(config, options.signal);
    const { unread } = await this.#reconcile(config, feed.items);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = parseCursor(options.cursor);
    const items = feed.items.slice(0, this.#options.maxItems ?? 500);
    const slice = items.slice(offset, offset + limit);

    return {
      entries: slice.map((item) => this.#toNode(item, config, unread)),
      ...(offset + slice.length < items.length ? { cursor: `rss:${String(offset + slice.length)}` } : {}),
      total: items.length,
    };
  }

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    const url = node.meta?.['feedUrl'];
    if (typeof url !== 'string') {
      throw VfsError.notFound(node.path ?? node.name, 'This entry does not belong to a feed.');
    }
    const config = this.#feeds.find((f) => f.url === url) ?? { name: hostOf(url), url };
    const feed = await this.#fetch(config, options.signal);
    const item = feed.items.find((candidate) => candidate.id === node.id);
    if (item === undefined) {
      throw VfsError.notFound(
        node.path ?? node.name,
        'The feed no longer lists this entry. Feeds usually keep only the most recent items.',
      );
    }

    // Opening an article is what makes it read. Listing a folder is not: a counter that
    // resets the moment you look at the folder it is attached to counts nothing.
    await this.#markRead(config, feed.items, [item.id]);

    const headers: Array<readonly [string, string]> = [];
    if (item.author !== undefined) headers.push(['Author', item.author]);
    if (item.published !== undefined) headers.push(['Published', item.published.toISOString()]);
    headers.push(['Feed', config.name]);
    if (item.link !== undefined) headers.push(['Link', item.link]);
    if (item.categories.length > 0) headers.push(['Categories', item.categories.join(', ')]);

    return {
      title: item.title,
      headers,
      body: item.content.length > 0 ? item.content : item.summary,
      format: 'text',
      ...(item.link === undefined ? {} : { webUrl: item.link }),
      ...(item.enclosures.length === 0
        ? {}
        : {
            attachments: item.enclosures.map((enclosure, index) => ({
              id: String(index),
              name: enclosure.url.split('/').pop() ?? `enclosure-${String(index)}`,
              ...(enclosure.type === undefined ? {} : { contentType: enclosure.type }),
              ...(enclosure.length === undefined ? {} : { size: enclosure.length }),
            })),
          }),
    };
  }

  /**
   * Poll by remembering which item ids have already been seen.
   *
   * Timestamps look like the obvious cursor and are a trap: a distressing number of feeds
   * emit items with no date, with the *fetch* time as the date, or with dates that move
   * backwards when an article is edited. Identity is the only field that behaves, so the
   * cursor is a bounded set of seen ids.
   */
  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    const config = this.#feedFor(parent);
    const feed = await this.#fetch(config, options.signal, true);
    // Polling is also what keeps the counter honest for a feed nobody has opened this
    // session: `watch` refreshes the stored counts as a side effect of doing its own job.
    const { unread } = await this.#reconcile(config, feed.items);

    const seen = new Set<string>(cursor === undefined ? [] : safeParseIds(cursor));
    const changes = feed.items
      .filter((item) => !seen.has(item.id))
      .map((item) => ({
        type: 'created' as const,
        path: this.#toNode(item, config, unread).name,
        node: this.#toNode(item, config, unread),
        at: item.published ?? new Date(),
      }));

    // Bounded so the cursor cannot grow without limit; feeds do not resurrect items that
    // have fallen off the end.
    const ids = feed.items.slice(0, 200).map((item) => item.id);
    return { changes, cursor: JSON.stringify(ids) };
  }

  /**
   * The two verbs a feed has.
   *
   * Declared honestly, the way every other provider does it: an article you have read does
   * not offer to mark it read, and a feed with nothing outstanding does not offer to clear
   * it. Without these the counter would be a number you could only ever lower by opening
   * every article one at a time.
   */
  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    if (node.kind === 'dir') {
      const config = this.#feedOrUndefined(node);
      if (config === undefined) return [];
      const counts = await this.#counts(config);
      return counts === undefined || counts.unread === 0
        ? []
        : [
            {
              name: 'mark-all-read',
              label: `Mark all ${String(counts.unread)} read`,
              description: 'Clear this feed\u2019s unread counter without opening every article.',
              group: 'unread',
              key: 'A',
            },
          ];
    }

    if (typeof node.meta?.['feedUrl'] !== 'string') return [];
    return node.flags?.includes('unread') === true
      ? [{ name: 'mark-read', label: 'Mark read', group: 'unread', key: 'm' }]
      : [{ name: 'mark-unread', label: 'Mark unread', group: 'unread', key: 'm' }];
  }

  async invoke(action: string, node: VNode, _params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    const config = this.#feedFor(node);
    const feed = await this.#fetch(config, undefined);

    switch (action) {
      case 'mark-all-read': {
        const { unread } = await this.#reconcile(config, feed.items);
        const changed = await this.#markRead(config, feed.items, [...unread]);
        return this.#marked(
          changed === 0 ? `Nothing was unread in ${config.name}.` : `Marked ${String(changed)} read in ${config.name}.`,
        );
      }
      case 'mark-read': {
        const changed = await this.#markRead(config, feed.items, [node.id]);
        return this.#marked(changed === 0 ? `${node.title} was already read.` : `Marked ${node.title} read.`);
      }
      case 'mark-unread': {
        const changed = await this.#markUnread(config, feed.items, [node.id]);
        return this.#marked(changed === 0 ? `${node.title} was already unread.` : `Marked ${node.title} unread.`);
      }
      default:
        return { ok: false, message: `The feed provider has no "${action}" action.` };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The engine already invalidates the item and its parent, which is not quite enough here:
   * the counter that just changed is painted one level further up, on the feed's own row.
   */
  #marked(message: string): ActionResult {
    return { ok: true, message, invalidates: [this.#context.mountPath] };
  }

  /**
   * What a feed's directory row says, without going near the network.
   *
   * `unreadCount` is documented as a hint for a backend that has the number cheaply, and
   * listing the feeds is the one screen in this provider that costs nothing at all. Turning
   * it into one HTTP request per feed to decorate the rows would trade the fastest thing
   * here for a number that is stale five minutes later anyway — and it would mean `ls` of a
   * feed list failed when the network did. So the count comes from the most recent fetch:
   * live, if this session has the feed cached, and otherwise from what the last session
   * wrote down. Opening a feed refreshes it, and so does `watch`.
   */
  async #counts(config: RssFeedConfig): Promise<{ readonly unread: number; readonly total: number } | undefined> {
    const stored = await this.#loadState(config.url);
    if (stored === undefined) return undefined;

    const cached = this.#cache.get(config.url);
    if (cached === undefined) return { unread: stored.unread, total: stored.total };

    const tracked = cached.feed.items.slice(0, TRACKED_ITEMS);
    return {
      unread: tracked.reduce((count, item) => count + (stored.seen.has(item.id) ? 0 : 1), 0),
      total: cached.feed.items.length,
    };
  }

  /** Read state as stored, or `undefined` for a feed this mount has never fetched. */
  async #loadState(url: string): Promise<ReadState | undefined> {
    if (this.#readState.has(url)) return this.#readState.get(url);
    const parsed = parseReadState(await this.#context.state.get(stateKey(url)));
    this.#readState.set(url, parsed);
    return parsed;
  }

  /**
   * Reconcile the stored read state against what the feed currently carries.
   *
   * The first sight of a feed is recorded silently: a feed you subscribed to this morning
   * is not forty articles you have failed to read, and the watcher already applies exactly
   * this rule to its poll cursor for exactly this reason. Everything that arrives after
   * that first fetch is new.
   *
   * Ids that have fallen off the end of the feed are dropped, which is what keeps the
   * stored set bounded without a separate eviction rule: an item the feed no longer lists
   * can never be listed again either.
   */
  async #reconcile(
    config: RssFeedConfig,
    items: readonly FeedItem[],
  ): Promise<{ readonly state: ReadState; readonly unread: ReadonlySet<string> }> {
    const ids = items.slice(0, TRACKED_ITEMS).map((item) => item.id);
    const stored = await this.#loadState(config.url);

    const seen = stored === undefined ? new Set(ids) : new Set(ids.filter((id) => stored.seen.has(id)));
    const unread = new Set(ids.filter((id) => !seen.has(id)));
    return { state: await this.#save(config.url, { seen, unread: unread.size, total: items.length }), unread };
  }

  async #markRead(config: RssFeedConfig, items: readonly FeedItem[], ids: readonly string[]): Promise<number> {
    const { state, unread } = await this.#reconcile(config, items);
    const marked = ids.filter((id) => unread.has(id));
    if (marked.length === 0) return 0;

    const seen = new Set(state.seen);
    for (const id of marked) seen.add(id);
    await this.#save(config.url, { seen, unread: unread.size - marked.length, total: state.total });
    return marked.length;
  }

  async #markUnread(config: RssFeedConfig, items: readonly FeedItem[], ids: readonly string[]): Promise<number> {
    const { state, unread } = await this.#reconcile(config, items);
    const tracked = new Set(items.slice(0, TRACKED_ITEMS).map((item) => item.id));
    const marked = ids.filter((id) => tracked.has(id) && !unread.has(id));
    if (marked.length === 0) return 0;

    const seen = new Set(state.seen);
    for (const id of marked) seen.delete(id);
    await this.#save(config.url, { seen, unread: unread.size + marked.length, total: state.total });
    return marked.length;
  }

  /** Write read state through the in-memory copy, skipping the disk write when nothing moved. */
  async #save(url: string, next: ReadState): Promise<ReadState> {
    const previous = this.#readState.get(url);
    this.#readState.set(url, next);
    if (previous !== undefined && previous.unread === next.unread && previous.total === next.total && sameIds(previous.seen, next.seen)) {
      return next;
    }

    try {
      await this.#context.state.set(
        stateKey(url),
        JSON.stringify({ seen: [...next.seen], unread: next.unread, total: next.total }),
      );
    } catch (error) {
      // Read state is a convenience, not the data. A store that will not write must not
      // take a feed listing down with it.
      this.#context.logger.warn('could not persist feed read state', { url, error: String(error) });
    }
    return next;
  }

  #feedFor(parent: VNode | null): RssFeedConfig {
    if (parent === null) {
      const first = this.#feeds[0];
      if (first === undefined) {
        throw VfsError.config('No feeds are configured for this mount.', 'Add a "feeds" array or a "url" to the mount options.');
      }
      return first;
    }
    const found = this.#feedOrUndefined(parent);
    if (found !== undefined) return found;
    throw VfsError.notDirectory(parent.path ?? parent.name);
  }

  /** The feed a node belongs to, whether it is the feed's own directory or an article in it. */
  #feedOrUndefined(node: VNode): RssFeedConfig | undefined {
    const url = node.meta?.['url'] ?? node.meta?.['feedUrl'];
    if (typeof url !== 'string') return undefined;
    return this.#feeds.find((feed) => feed.url === url) ?? { name: node.title, url };
  }

  #toNode(item: FeedItem, config: RssFeedConfig, unread: ReadonlySet<string>): VNode {
    const date = item.published;
    const prefix = date === undefined ? '' : `${timestampPrefix(date)} `;
    const flags = [
      ...(unread.has(item.id) ? ['unread'] : []),
      ...(item.enclosures.length > 0 ? ['attachment'] : []),
    ];
    return {
      name: `${prefix}${item.title}.txt`,
      kind: 'file',
      subtype: 'article',
      title: item.title,
      id: item.id,
      ...(date === undefined ? {} : { mtime: date }),
      size: Buffer.byteLength(item.content, 'utf8'),
      ...(item.summary.length === 0 ? {} : { summary: item.summary }),
      ...(item.author === undefined ? {} : { author: item.author }),
      ...(flags.length === 0 ? {} : { flags }),
      meta: {
        feedUrl: config.url,
        feed: config.name,
        ...(item.link === undefined ? {} : { link: item.link }),
        ...(item.categories.length === 0 ? {} : { categories: item.categories.join(', ') }),
      },
    };
  }

  async #fetch(config: RssFeedConfig, signal: AbortSignal | undefined, force = false): Promise<Feed> {
    const cached = this.#cache.get(config.url);
    const refreshMs = this.#options.refreshMs ?? 5 * 60_000;
    if (!force && cached !== undefined && Date.now() - cached.fetchedAt < refreshMs) {
      return cached.feed;
    }

    const headers: Record<string, string> = {
      accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
      'user-agent': this.#options.userAgent ?? 'mscomms/0.1 (+https://github.com/MSFT-TKENDRICK/MS-COMMS-TUI)',
    };
    // Conditional GET is basic feed-reader etiquette and the difference between a tool
    // publishers tolerate and one they block.
    if (cached?.etag !== undefined) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified !== undefined) headers['if-modified-since'] = cached.lastModified;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? DEFAULT_TIMEOUT);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(config.url, { headers, signal: controller.signal, redirect: 'follow' });

      if (response.status === 304 && cached !== undefined) {
        this.#cache.set(config.url, { ...cached, fetchedAt: Date.now() });
        return cached.feed;
      }
      if (response.status === 429) {
        throw new VfsError('ERATELIMIT', `${config.name} is rate-limiting requests.`, {
          hint: 'Increase refreshMs for this mount.',
          ...(response.headers.get('retry-after') === null
            ? {}
            : { retryAfter: Number(response.headers.get('retry-after')) }),
        });
      }
      if (!response.ok) {
        throw new VfsError('ENETWORK', `${config.name} returned HTTP ${String(response.status)}.`, {
          hint: response.status === 404 ? 'Check the feed URL.' : 'The feed may be temporarily unavailable.',
        });
      }

      const text = await response.text();
      const feed = parseFeed(text);
      this.#cache.set(config.url, {
        feed,
        fetchedAt: Date.now(),
        ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag') as string }),
        ...(response.headers.get('last-modified') === null
          ? {}
          : { lastModified: response.headers.get('last-modified') as string }),
      });
      return feed;
    } catch (error) {
      if (error instanceof VfsError) throw error;
      // A stale feed beats an error page. This is the offline-tolerance principle applied
      // one level down from the engine's own stale-serving.
      if (cached !== undefined) {
        this.#context.logger.warn('serving stale feed', { url: config.url });
        return cached.feed;
      }
      if (controller.signal.aborted) {
        throw new VfsError('ETIMEDOUT', `${config.name} did not respond in time.`, {
          hint: 'Check connectivity, or raise timeoutMs for this mount.',
        });
      }
      throw new VfsError('ENETWORK', `Could not fetch ${config.name}: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor.replace(/^rss:/, ''));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeParseIds(cursor: string): string[] {
  try {
    const parsed: unknown = JSON.parse(cursor);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function stateKey(url: string): string {
  return `rss:read:${url}`;
}

/**
 * Parse stored read state, treating anything unrecognizable as "never seen".
 *
 * The cost of getting this wrong in the lenient direction is one silent catch-up; the cost
 * of throwing is a feed that cannot be listed because of a corrupt cache entry.
 */
function parseReadState(raw: string | undefined): ReadState | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record['seen'])) return undefined;
    const seen = new Set(record['seen'].filter((id): id is string => typeof id === 'string'));
    return {
      seen,
      unread: typeof record['unread'] === 'number' ? record['unread'] : 0,
      total: typeof record['total'] === 'number' ? record['total'] : seen.size,
    };
  } catch {
    return undefined;
  }
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export const rssPlugin: ProviderPlugin<RssProviderOptions> = {
  type: 'rss',
  displayName: 'RSS / Atom feeds',
  description: 'Any RSS, RDF or Atom feed. No credentials, no vendor API, no way for anyone to turn it off.',
  validateOptions(raw) {
    const options = (raw ?? {}) as RssProviderOptions;
    if (options.url === undefined && (options.feeds === undefined || options.feeds.length === 0)) {
      throw VfsError.config(
        'An rss mount needs either "url" or a non-empty "feeds" array.',
        'Example: { "path": "/feeds", "type": "rss", "options": { "feeds": [ { "name": "Release notes", "url": "https://example.com/feed.xml" } ] } }',
      );
    }
    for (const feed of options.feeds ?? []) {
      if (typeof feed.url !== 'string' || typeof feed.name !== 'string') {
        throw VfsError.config('Every entry in "feeds" needs a "name" and a "url".');
      }
    }
    return options;
  },
  create(options, context) {
    return new RssProvider(options, context);
  },
};
