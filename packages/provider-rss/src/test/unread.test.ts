/**
 * Read state for feeds.
 *
 * A feed has no server-side notion of "read" — nobody is storing a flag for you — so this
 * provider keeps its own, and the counter on a feed's directory row is only as trustworthy
 * as the rules below. The two that matter most are the ones a naive implementation gets
 * backwards:
 *
 * 1. **Listing a folder does not read it.** A counter that resets when you look at the
 *    folder it is attached to is counting nothing.
 * 2. **The first sight of a feed is silent.** Subscribing to a feed this morning is not
 *    forty articles you have failed to read, and a counter whose first value is "40" is one
 *    the user learns to ignore on day one.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryStateStore, NULL_LOGGER, type ProviderContext, type VNode } from '@mscomms/core';

import { RssProvider } from '../provider.js';

const URL_A = 'https://example.com/a.xml';
const URL_B = 'https://example.com/b.xml';

interface Article {
  readonly id: string;
  readonly title: string;
}

/** A feed server with no server: the item list is a variable the test moves. */
class FakeFeeds {
  readonly #items = new Map<string, Article[]>();
  requests = 0;

  set(url: string, items: readonly Article[]): void {
    this.#items.set(url, [...items]);
  }

  install(): void {
    globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
      this.requests += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const items = this.#items.get(url);
      if (items === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
      return Promise.resolve(
        new Response(rssXml(items), { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
      );
    }) as typeof fetch;
  }
}

function rssXml(items: readonly Article[]): string {
  const entries = items
    .map(
      (item) =>
        `<item><guid>${item.id}</guid><title>${item.title}</title><description>Body of ${item.id}</description></item>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${entries}</channel></rss>`;
}

function article(id: string): Article {
  return { id, title: `Article ${id}` };
}

let feeds: FakeFeeds;
let store: MemoryStateStore;
const realFetch = globalThis.fetch;

function context(): ProviderContext {
  return {
    mountPath: '/feeds',
    logger: NULL_LOGGER,
    state: store,
    cacheDir: '.',
    secret: (ref: string) => Promise.resolve(ref),
  };
}

/** A fresh provider over the same persisted state, which is what a new session is. */
function provider(): RssProvider {
  return new RssProvider(
    {
      feeds: [
        { name: 'Alpha', url: URL_A },
        { name: 'Beta', url: URL_B },
      ],
      // Fetch every time, so a test that moves the feed sees it move.
      refreshMs: 0,
    },
    context(),
  );
}

async function feedDir(rss: RssProvider, name: string): Promise<VNode> {
  const { entries } = await rss.list(null, {});
  const found = entries.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `no feed directory called ${name}`);
  return found;
}

async function items(rss: RssProvider, dir: VNode): Promise<readonly VNode[]> {
  return (await rss.list(dir, {})).entries;
}

function unreadTitles(entries: readonly VNode[]): readonly string[] {
  return entries.filter((entry) => entry.flags?.includes('unread') === true).map((entry) => entry.title);
}

beforeEach(() => {
  feeds = new FakeFeeds();
  feeds.set(URL_A, [article('a1'), article('a2')]);
  feeds.set(URL_B, [article('b1')]);
  feeds.install();
  store = new MemoryStateStore();
});

describe('rss: the first sight of a feed', () => {
  it('does not present a brand new subscription as a backlog', async () => {
    const rss = provider();
    const entries = await items(rss, await feedDir(rss, 'Alpha'));
    assert.equal(entries.length, 2);
    assert.deepEqual(unreadTitles(entries), []);
  });

  it('reports the feed as caught up once it has been opened', async () => {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));
    const dir = await feedDir(rss, 'Alpha');
    assert.equal(dir.unreadCount, 0);
    assert.equal(dir.childCount, 2);
  });

  it('says nothing at all about a feed it has never fetched', async () => {
    // Silence and zero are different claims, and only one of them is true here.
    const dir = await feedDir(provider(), 'Beta');
    assert.equal(dir.unreadCount, undefined);
    assert.equal(dir.childCount, undefined);
  });
});

describe('rss: counting what arrived since', () => {
  it('flags an item that appeared after the first fetch', async () => {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));

    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);
    const entries = await items(rss, await feedDir(rss, 'Alpha'));
    assert.deepEqual(unreadTitles(entries), ['Article a3']);
  });

  it('puts the count on the feed\u2019s own row, which is the row you choose from', async () => {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));

    feeds.set(URL_A, [article('a3'), article('a4'), article('a1'), article('a2')]);
    await items(rss, await feedDir(rss, 'Alpha'));

    const dir = await feedDir(rss, 'Alpha');
    assert.equal(dir.unreadCount, 2);
    assert.equal(dir.childCount, 4);
  });

  it('does not clear the count merely because the folder was listed', async () => {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));
    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);

    for (let i = 0; i < 3; i += 1) await items(rss, await feedDir(rss, 'Alpha'));
    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 1);
  });

  it('counts each feed separately', async () => {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));
    await items(rss, await feedDir(rss, 'Beta'));

    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);
    await items(rss, await feedDir(rss, 'Alpha'));

    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 1);
    assert.equal((await feedDir(rss, 'Beta')).unreadCount, 0);
  });

  it('survives into the next session, which is the only session that matters', async () => {
    const first = provider();
    await items(first, await feedDir(first, 'Alpha'));
    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);
    await items(first, await feedDir(first, 'Alpha'));

    // A new provider over the same store: a restart, with nothing in memory.
    const second = provider();
    assert.equal((await feedDir(second, 'Alpha')).unreadCount, 1);
  });

  it('forgets an article that has fallen off the end of the feed', async () => {
    // Which is what keeps the stored id set bounded: an item the feed no longer lists can
    // never be listed again either.
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));

    feeds.set(URL_A, [article('a3')]);
    await items(rss, await feedDir(rss, 'Alpha'));

    const stored: unknown = JSON.parse((await store.get(`rss:read:${URL_A}`)) ?? '{}');
    assert.deepEqual((stored as { seen: string[] }).seen, []);
  });

  it('treats unreadable stored state as a feed it has never seen, rather than failing', async () => {
    await store.set(`rss:read:${URL_A}`, '{ not json at all');
    const rss = provider();
    const entries = await items(rss, await feedDir(rss, 'Alpha'));
    assert.deepEqual(unreadTitles(entries), []);
  });
});

describe('rss: listing the feeds themselves', () => {
  it('costs nothing, because a feed list that needs the network is a feed list that hangs', async () => {
    const rss = provider();
    feeds.requests = 0;
    await rss.list(null, {});
    assert.equal(feeds.requests, 0);
  });

  it('still answers from what the last session wrote down', async () => {
    const first = provider();
    await items(first, await feedDir(first, 'Alpha'));
    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);
    await items(first, await feedDir(first, 'Alpha'));

    const second = provider();
    feeds.requests = 0;
    const dir = await feedDir(second, 'Alpha');
    assert.equal(feeds.requests, 0);
    assert.equal(dir.unreadCount, 1);
  });
});

describe('rss: clearing the counter', () => {
  async function withOneUnread(): Promise<{ readonly rss: RssProvider; readonly unread: VNode }> {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));
    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);
    const entries = await items(rss, await feedDir(rss, 'Alpha'));
    const unread = entries.find((entry) => entry.flags?.includes('unread') === true);
    assert.ok(unread !== undefined);
    return { rss, unread };
  }

  it('marks an article read when it is opened', async () => {
    const { rss, unread } = await withOneUnread();
    await rss.read(unread, {});
    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 0);
    assert.deepEqual(unreadTitles(await items(rss, await feedDir(rss, 'Alpha'))), []);
  });

  it('offers to clear a feed that has something outstanding, and not one that has not', async () => {
    const { rss } = await withOneUnread();
    const offered = await rss.actions(await feedDir(rss, 'Alpha'));
    assert.deepEqual(
      offered.map((action) => action.name),
      ['mark-all-read'],
    );
    assert.deepEqual(await rss.actions(await feedDir(rss, 'Beta')), []);
  });

  it('clears the whole feed in one verb, and says how many', async () => {
    const { rss } = await withOneUnread();
    const result = await rss.invoke('mark-all-read', await feedDir(rss, 'Alpha'), {});
    assert.equal(result.ok, true);
    assert.match(result.message, /1/);
    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 0);
  });

  it('invalidates the mount root, where the counter it just changed is painted', async () => {
    const { rss } = await withOneUnread();
    const result = await rss.invoke('mark-all-read', await feedDir(rss, 'Alpha'), {});
    assert.deepEqual(result.invalidates, ['/feeds']);
  });

  it('does not claim to have marked anything when there was nothing to mark', async () => {
    const rss = provider();
    await items(rss, await feedDir(rss, 'Alpha'));
    const result = await rss.invoke('mark-all-read', await feedDir(rss, 'Alpha'), {});
    assert.equal(result.ok, true);
    assert.match(result.message, /Nothing/i);
  });

  it('offers the opposite verb on an article, depending which way round it is', async () => {
    const { rss, unread } = await withOneUnread();
    assert.deepEqual(
      (await rss.actions(unread)).map((action) => action.name),
      ['mark-read'],
    );

    await rss.invoke('mark-read', unread, {});
    const read = (await items(rss, await feedDir(rss, 'Alpha'))).find((entry) => entry.id === unread.id);
    assert.ok(read !== undefined);
    assert.deepEqual(
      (await rss.actions(read)).map((action) => action.name),
      ['mark-unread'],
    );
  });

  it('puts an article back, so a counter reaching zero is not a one-way door', async () => {
    const { rss, unread } = await withOneUnread();
    await rss.invoke('mark-read', unread, {});
    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 0);

    await rss.invoke('mark-unread', unread, {});
    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 1);
    assert.deepEqual(unreadTitles(await items(rss, await feedDir(rss, 'Alpha'))), ['Article a3']);
  });

  it('refuses an action it does not have rather than pretending it worked', async () => {
    const rss = provider();
    const result = await rss.invoke('archive', await feedDir(rss, 'Alpha'), {});
    assert.equal(result.ok, false);
  });
});

describe('rss: polling', () => {
  it('keeps the counter fresh for a feed nobody has opened', async () => {
    const rss = provider();
    const dir = await feedDir(rss, 'Alpha');
    await rss.poll(dir, undefined, {});

    feeds.set(URL_A, [article('a3'), article('a1'), article('a2')]);
    const result = await rss.poll(dir, undefined, {});

    assert.equal((await feedDir(rss, 'Alpha')).unreadCount, 1);
    assert.ok(result.changes.some((change) => change.node?.flags?.includes('unread') === true));
  });
});

// Nothing outside this file should inherit a stubbed fetch.
process.on('exit', () => {
  globalThis.fetch = realFetch;
});
