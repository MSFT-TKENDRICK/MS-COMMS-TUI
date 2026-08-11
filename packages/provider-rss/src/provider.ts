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
  type Capability,
  type Document,
  type ListOptions,
  type ListPage,
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

const DEFAULT_TIMEOUT = 15_000;

export class RssProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll']);

  readonly #feeds: readonly RssFeedConfig[];
  readonly #single: boolean;
  readonly #options: RssProviderOptions;
  readonly #context: ProviderContext;
  readonly #cache = new Map<string, CachedFeed>();

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
      const entries: VNode[] = this.#feeds.map((feed) => ({
        name: feed.name,
        kind: 'dir' as const,
        subtype: 'feed',
        title: feed.name,
        id: `feed:${feed.url}`,
        ...(feed.description === undefined ? {} : { summary: feed.description }),
        meta: { url: feed.url },
      }));
      return { entries, total: entries.length };
    }

    const config = this.#feedFor(parent);
    const feed = await this.#fetch(config, options.signal);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = parseCursor(options.cursor);
    const items = feed.items.slice(0, this.#options.maxItems ?? 500);
    const slice = items.slice(offset, offset + limit);

    return {
      entries: slice.map((item) => this.#toNode(item, config)),
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

    const seen = new Set<string>(cursor === undefined ? [] : safeParseIds(cursor));
    const changes = feed.items
      .filter((item) => !seen.has(item.id))
      .map((item) => ({
        type: 'created' as const,
        path: this.#toNode(item, config).name,
        node: this.#toNode(item, config),
        at: item.published ?? new Date(),
      }));

    // Bounded so the cursor cannot grow without limit; feeds do not resurrect items that
    // have fallen off the end.
    const ids = feed.items.slice(0, 200).map((item) => item.id);
    return { changes, cursor: JSON.stringify(ids) };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #feedFor(parent: VNode | null): RssFeedConfig {
    if (parent === null) {
      const first = this.#feeds[0];
      if (first === undefined) {
        throw VfsError.config('No feeds are configured for this mount.', 'Add a "feeds" array or a "url" to the mount options.');
      }
      return first;
    }
    const url = parent.meta?.['url'] ?? parent.meta?.['feedUrl'];
    const found = typeof url === 'string' ? this.#feeds.find((f) => f.url === url) : undefined;
    if (found !== undefined) return found;
    if (typeof url === 'string') return { name: parent.title, url };
    throw VfsError.notDirectory(parent.path ?? parent.name);
  }

  #toNode(item: FeedItem, config: RssFeedConfig): VNode {
    const date = item.published;
    const prefix = date === undefined ? '' : `${timestampPrefix(date)} `;
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
      ...(item.enclosures.length > 0 ? { flags: ['attachment'] } : {}),
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
