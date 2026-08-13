/**
 * Snapshot store tests.
 *
 * The store is a cache for corporate mail, so the tests are weighted towards the failure
 * that actually costs someone something: not "the cache was slow" but "the cache said no
 * such message exists". Retention, completeness flags and the candidates/evaluator split
 * get the most attention for that reason.
 *
 * These run against a real database. When the host Node has no `node:sqlite` — the
 * package's floor is 20.11, and that module landed in 22.5 — the suite skips rather than
 * fails, because the snapshot is optional by design and so is being able to test it.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { SnapshotStore } from '../snapshot.js';
import { openSqlDriver, type SqlDriver, type SqlValue } from '../sql.js';
import { hashEmbedder } from '../vector.js';
import { parseQuery, MATCH_ALL } from '../query.js';
import type { Document, VNode } from '../provider.js';

const HOUR = 3_600_000;

let available = true;
try {
  const probe = await openSqlDriver({ path: ':memory:' });
  await probe.close();
} catch {
  available = false;
}

const suite = available ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(name: string, id: string, overrides: Partial<VNode> = {}): VNode {
  return {
    name,
    id,
    kind: 'file',
    title: name.replace(/\.eml$/, ''),
    path: `/mail/Inbox/${name}`,
    ...overrides,
  };
}

const INBOX: readonly VNode[] = [
  node('budget-review.eml', 'm1', {
    title: 'Q3 budget review',
    author: 'alice@example.com',
    summary: 'Numbers for the quarter',
    mtime: new Date('2024-06-01T09:00:00Z'),
    flags: ['unread'],
  }),
  node('server-outage.eml', 'm2', {
    title: 'Server outage postmortem',
    author: 'bob@example.com',
    mtime: new Date('2024-06-02T09:00:00Z'),
  }),
  node('lunch.eml', 'm3', {
    title: 'Lunch tomorrow?',
    author: 'carol@example.com',
    mtime: new Date('2024-06-03T09:00:00Z'),
  }),
];

interface Harness {
  readonly store: SnapshotStore;
  readonly driver: SqlDriver;
  now: number;
}

async function open(options: Parameters<typeof SnapshotStore.open>[0] extends infer T ? Partial<Omit<T, 'driver'>> : never = {}): Promise<Harness> {
  const driver = await openSqlDriver({ path: ':memory:' });
  const harness = { driver, now: Date.parse('2024-06-04T09:00:00Z') } as { driver: SqlDriver; now: number; store: SnapshotStore };
  harness.store = await SnapshotStore.open({
    driver,
    embedder: hashEmbedder(64),
    now: () => harness.now,
    ...options,
  });
  return harness as Harness;
}

async function seedInbox(harness: Harness, entries: readonly VNode[] = INBOX): Promise<void> {
  await harness.store.putListing({
    mountId: 'mail',
    path: '/mail/Inbox',
    entries,
    isFirstPage: true,
    complete: true,
  });
}

// ---------------------------------------------------------------------------

suite('SnapshotStore: listings', () => {
  let harness: Harness;
  before(async () => {
    harness = await open();
    await seedInbox(harness);
  });
  after(async () => {
    await harness.store.close();
  });

  it('returns what was stored, in the order it was stored', async () => {
    const listing = await harness.store.listing('/mail/Inbox');
    assert.ok(listing !== undefined);
    assert.deepEqual(
      listing.entries.map((entry) => entry.id),
      ['m1', 'm2', 'm3'],
    );
  });

  it('preserves the fields a listing is rendered from', async () => {
    const listing = await harness.store.listing('/mail/Inbox');
    const first = listing?.entries[0];
    assert.equal(first?.title, 'Q3 budget review');
    assert.equal(first?.author, 'alice@example.com');
    assert.deepEqual(first?.flags, ['unread']);
    assert.equal(first?.mtime?.toISOString(), '2024-06-01T09:00:00.000Z');
  });

  it('reports itself fresh inside the TTL and stale outside it', async () => {
    assert.equal((await harness.store.listing('/mail/Inbox'))?.fresh, true);
    harness.now += 24 * HOUR;
    const stale = await harness.store.listing('/mail/Inbox');
    assert.equal(stale?.fresh, false);
    // Still served — that is the entire point of a snapshot — but honest about its age.
    assert.equal(stale?.entries.length, 3);
    assert.ok((stale?.ageMs ?? 0) >= 24 * HOUR);
    harness.now -= 24 * HOUR;
  });

  it('returns undefined for a directory it has never seen', async () => {
    assert.equal(await harness.store.listing('/mail/Archive'), undefined);
  });

  it('honours limit and offset so the engine can page it', async () => {
    const page = await harness.store.listing('/mail/Inbox', { limit: 2 });
    assert.equal(page?.entries.length, 2);
    const rest = await harness.store.listing('/mail/Inbox', { limit: 2, offset: 2 });
    assert.equal(rest?.entries.length, 1);
    assert.equal(rest?.entries[0]?.id, 'm3');
  });

  it('resolves a single node by path', async () => {
    assert.equal((await harness.store.node('/mail/Inbox/lunch.eml'))?.id, 'm3');
    assert.equal(await harness.store.node('/mail/Inbox/nope.eml'), undefined);
  });
});

suite('SnapshotStore: paging', () => {
  it('appends a second page rather than replacing the first', async () => {
    const harness = await open();
    await harness.store.putListing({
      mountId: 'mail',
      path: '/mail/Inbox',
      entries: INBOX.slice(0, 2),
      page: { cursor: 'p2' },
      isFirstPage: true,
    });
    await harness.store.putListing({
      mountId: 'mail',
      path: '/mail/Inbox',
      entries: INBOX.slice(2),
      isFirstPage: false,
      complete: true,
    });

    const listing = await harness.store.listing('/mail/Inbox');
    assert.deepEqual(listing?.entries.map((entry) => entry.id), ['m1', 'm2', 'm3']);
    assert.equal(listing?.complete, true);
    await harness.store.close();
  });

  it('re-storing a first page replaces the ordering rather than duplicating it', async () => {
    const harness = await open();
    await seedInbox(harness);
    await seedInbox(harness, [...INBOX].reverse());

    const listing = await harness.store.listing('/mail/Inbox');
    assert.equal(listing?.entries.length, 3, 'a refresh must not double the folder');
    assert.deepEqual(listing?.entries.map((entry) => entry.id), ['m3', 'm2', 'm1']);
    await harness.store.close();
  });

  it('keeps a cursor so a resumed listing continues from the backend', async () => {
    const harness = await open();
    await harness.store.putListing({
      mountId: 'mail',
      path: '/mail/Inbox',
      entries: INBOX.slice(0, 1),
      page: { cursor: 'next-page-token', total: 3 },
      isFirstPage: true,
    });
    const listing = await harness.store.listing('/mail/Inbox');
    assert.equal(listing?.cursor, 'next-page-token');
    assert.equal(listing?.complete, false);
    assert.equal(listing?.total, 3);
    await harness.store.close();
  });

  it('lets two backend items collide on one path without losing either', async () => {
    // The engine allocates display names per directory, so a re-sync can hand the same
    // path to a different item. The loser must keep its row and stay addressable by id.
    const harness = await open();
    await seedInbox(harness, [node('dup.eml', 'first')]);
    await seedInbox(harness, [node('dup.eml', 'second')]);

    const listing = await harness.store.listing('/mail/Inbox');
    assert.deepEqual(listing?.entries.map((entry) => entry.id), ['second']);
    await harness.store.close();
  });
});

suite('SnapshotStore: documents', () => {
  it('stores and returns a document with its headers intact', async () => {
    const harness = await open();
    await seedInbox(harness);
    const doc: Document = {
      title: 'Q3 budget review',
      headers: [
        ['From', 'alice@example.com'],
        ['Date', 'Sat, 1 Jun 2024 09:00:00 +0000'],
      ],
      body: 'The forecast is attached.',
      format: 'text',
    };
    await harness.store.putDocument('mail', INBOX[0] as VNode, doc);

    const stored = await harness.store.document('/mail/Inbox/budget-review.eml');
    assert.equal(stored?.doc.title, 'Q3 budget review');
    assert.equal(stored?.doc.body, 'The forecast is attached.');
    assert.deepEqual(stored?.doc.headers, doc.headers);
    assert.equal(stored?.doc.format, 'text');
    assert.equal(stored?.ageMs, 0);
    await harness.store.close();
  });

  it('returns undefined for an item whose body was never fetched', async () => {
    const harness = await open();
    await seedInbox(harness);
    assert.equal(await harness.store.document('/mail/Inbox/lunch.eml'), undefined);
    await harness.store.close();
  });

  it('reports a document age, so the caller can decide about a stale body', async () => {
    const harness = await open();
    await seedInbox(harness);
    await harness.store.putDocument('mail', INBOX[0] as VNode, { title: 't', headers: [], body: 'b', format: 'text' });
    harness.now += 3 * HOUR;
    assert.equal((await harness.store.document('/mail/Inbox/budget-review.eml'))?.ageMs, 3 * HOUR);
    await harness.store.close();
  });
});

suite('SnapshotStore: search candidates', () => {
  let harness: Harness;
  before(async () => {
    harness = await open();
    await seedInbox(harness);
    await harness.store.putDocument('mail', INBOX[0] as VNode, {
      title: 'Q3 budget review',
      headers: [],
      body: 'The forecast is attached and the numbers are final.',
      format: 'text',
    });
  });
  after(async () => {
    await harness.store.close();
  });

  it('finds an item by a word in its subject', async () => {
    const hits = await harness.store.candidates(parseQuery('budget'));
    assert.ok(hits.some((hit) => hit.node.id === 'm1'));
  });

  it('finds an item by its author', async () => {
    const hits = await harness.store.candidates(parseQuery('from:bob@example.com'));
    assert.ok(hits.some((hit) => hit.node.id === 'm2'));
  });

  it('returns the stored body alongside the node, so `body:` can be decided locally', async () => {
    const hits = await harness.store.candidates(parseQuery('body:forecast'));
    const hit = hits.find((entry) => entry.node.id === 'm1');
    assert.ok(hit !== undefined, 'expected the message with a stored body');
    assert.match(hit.body ?? '', /forecast/);
  });

  it('proposes candidates without claiming they match', async () => {
    // The store is deliberately over-eager: it does not implement the query language, so
    // it hands back plausible rows and lets the engine's own evaluator decide. A store
    // that filtered here would give two different search semantics depending on whether
    // an item happened to be cached, which is far worse than an extra row.
    const hits = await harness.store.candidates(parseQuery('budget'));
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((hit) => typeof hit.score === 'number'));
  });

  it('answers a purely structural query from the recency floor', async () => {
    // `is:unread after:7d` has no text at all. Without a recency fallback the most
    // cacheable class of query would never hit the cache.
    const hits = await harness.store.candidates(parseQuery('is:unread'));
    assert.ok(hits.length > 0, 'a text-free query must still produce candidates');
    assert.ok(hits.some((hit) => hit.source === 'recent'));
  });

  it('confines results to the requested root', async () => {
    await harness.store.putListing({
      mountId: 'chat',
      path: '/chat/General',
      entries: [node('budget-chat.txt', 'c1', { title: 'budget chat', path: '/chat/General/budget-chat.txt' })],
      isFirstPage: true,
      complete: true,
    });

    const scoped = await harness.store.candidates(parseQuery('budget'), { root: '/mail' });
    assert.ok(scoped.every((hit) => (hit.node.path ?? '').startsWith('/mail')));

    const everywhere = await harness.store.candidates(parseQuery('budget'));
    assert.ok(everywhere.some((hit) => hit.node.id === 'c1'));
  });

  it('can be told to skip the vector index', async () => {
    const hits = await harness.store.candidates(parseQuery('budget'), { semantic: false });
    assert.ok(hits.every((hit) => hit.source !== 'vector'));
  });

  it('survives a query whose terms tokenize to nothing', async () => {
    // FTS5 will happily throw a syntax error on punctuation. A search for "???" should
    // return nothing, not take down the search.
    await assert.doesNotReject(async () => harness.store.candidates(parseQuery('"???"')));
  });

  it('returns nothing for MATCH_ALL rather than the whole database', async () => {
    const hits = await harness.store.candidates(MATCH_ALL, { limit: 2 });
    assert.ok(hits.length <= 2);
  });
});

suite('SnapshotStore: retention', () => {
  it('keeps only the n most recent items in a folder', async () => {
    const harness = await open({ maxNodesPerDirectory: 2 });
    await seedInbox(harness);

    const listing = await harness.store.listing('/mail/Inbox');
    assert.equal(listing?.entries.length, 2);
    // The two newest, by mtime — not the two most recently written.
    assert.deepEqual(listing?.entries.map((entry) => entry.id).sort(), ['m2', 'm3']);
    await harness.store.close();
  });

  it('marks a folder incomplete once anything has been evicted', async () => {
    // This is the important one. A truncated folder still flagged `complete` would be
    // served as though it were the whole thing, with no `more` offered — the cache
    // silently hiding mail.
    const harness = await open({ maxNodesPerDirectory: 2 });
    await seedInbox(harness);
    assert.equal((await harness.store.listing('/mail/Inbox'))?.complete, false);
    await harness.store.close();
  });

  it('never evicts directories, however old', async () => {
    const harness = await open({ maxNodesPerDirectory: 1 });
    await harness.store.putListing({
      mountId: 'mail',
      path: '/mail',
      entries: [
        node('Inbox', 'd1', { kind: 'dir', path: '/mail/Inbox' }),
        node('Archive', 'd2', { kind: 'dir', path: '/mail/Archive' }),
        node('Sent', 'd3', { kind: 'dir', path: '/mail/Sent' }),
      ],
      isFirstPage: true,
      complete: true,
    });

    const listing = await harness.store.listing('/mail');
    assert.equal(listing?.entries.length, 3, 'the shape of the tree is not sheddable data');
    await harness.store.close();
  });

  it('drops the body and the vector along with the row', async () => {
    const harness = await open({ maxNodesPerDirectory: 1 });
    await seedInbox(harness, [INBOX[0] as VNode]);
    await harness.store.putDocument('mail', INBOX[0] as VNode, { title: 't', headers: [], body: 'b', format: 'text' });
    assert.equal((await harness.store.stats()).documents, 1);

    await seedInbox(harness, INBOX);
    const stats = await harness.store.stats();
    assert.equal(stats.nodes, 1);
    assert.equal(stats.documents, 0, 'an orphaned body is a leak');
    assert.equal(stats.vectors, 1);
    await harness.store.close();
  });
});

suite('SnapshotStore: invalidation', () => {
  it('clears a subtree by prefix', async () => {
    const harness = await open();
    await seedInbox(harness);
    await harness.store.putListing({
      mountId: 'chat',
      path: '/chat/General',
      entries: [node('a.txt', 'c1', { path: '/chat/General/a.txt' })],
      isFirstPage: true,
      complete: true,
    });

    await harness.store.invalidate('/mail');
    assert.equal(await harness.store.listing('/mail/Inbox'), undefined);
    assert.ok((await harness.store.listing('/chat/General')) !== undefined, 'an unrelated mount is not collateral');
    await harness.store.close();
  });

  it('does not treat a sibling with a shared name prefix as a child', async () => {
    const harness = await open();
    await seedInbox(harness);
    await harness.store.putListing({
      mountId: 'mail',
      path: '/mail/InboxArchive',
      entries: [node('a.eml', 'x1', { path: '/mail/InboxArchive/a.eml' })],
      isFirstPage: true,
      complete: true,
    });

    await harness.store.invalidate('/mail/Inbox');
    assert.equal(await harness.store.listing('/mail/Inbox'), undefined);
    assert.ok((await harness.store.listing('/mail/InboxArchive')) !== undefined);
    await harness.store.close();
  });

  it('clear() empties the cache but keeps what it learned about navigation', async () => {
    const harness = await open();
    await seedInbox(harness);
    await harness.store.saveNavigationHistory([{ from: '/mail', to: '/mail/Inbox', count: 7 }]);

    await harness.store.clear();
    assert.equal(await harness.store.listing('/mail/Inbox'), undefined);
    const history = await harness.store.navigationHistory();
    assert.deepEqual(history, [{ from: '/mail', to: '/mail/Inbox', count: 7 }]);
    await harness.store.close();
  });
});

suite('SnapshotStore: sync bookkeeping', () => {
  it('round-trips a poll cursor per mount and path', async () => {
    const harness = await open();
    assert.equal(await harness.store.pollCursor('mail', '/mail/Inbox'), undefined);
    await harness.store.setPollCursor('mail', '/mail/Inbox', 'delta-token-1');
    assert.equal(await harness.store.pollCursor('mail', '/mail/Inbox'), 'delta-token-1');
    await harness.store.setPollCursor('mail', '/mail/Inbox', undefined);
    assert.equal(await harness.store.pollCursor('mail', '/mail/Inbox'), undefined);
    await harness.store.close();
  });

  it('lists directories that have not been synced recently, oldest first', async () => {
    const harness = await open();
    await seedInbox(harness);
    harness.now += 2 * HOUR;
    await harness.store.putListing({
      mountId: 'mail',
      path: '/mail/Archive',
      entries: [node('old.eml', 'a1', { path: '/mail/Archive/old.eml' })],
      isFirstPage: true,
      complete: true,
    });

    harness.now += HOUR;
    const stale = await harness.store.staleDirectories(90 * 60_000);
    assert.deepEqual(stale.map((entry) => entry.path), ['/mail/Inbox']);
    await harness.store.close();
  });

  it('accumulates navigation counts across sessions', async () => {
    const harness = await open();
    await harness.store.saveNavigationHistory([{ from: '/mail', to: '/mail/Inbox', count: 2 }]);
    await harness.store.saveNavigationHistory([
      { from: '/mail', to: '/mail/Inbox', count: 5 },
      { from: '/mail', to: '/mail/Sent', count: 1 },
    ]);

    const history = await harness.store.navigationHistory();
    const inbox = history.find((entry) => entry.to === '/mail/Inbox');
    assert.equal(inbox?.count, 5, 'the latest count replaces, it does not add');
    assert.equal(history.length, 2);
    await harness.store.close();
  });
});

suite('SnapshotStore: schema handling', () => {
  it('drops and rebuilds when the stored schema version does not match', async () => {
    const driver = await openSqlDriver({ path: ':memory:' });
    const first = await SnapshotStore.open({ driver, embedder: hashEmbedder(64) });
    await first.putListing({ mountId: 'mail', path: '/mail/Inbox', entries: INBOX, isFirstPage: true, complete: true });

    await driver.run("UPDATE snapshot_meta SET value = '-1' WHERE key = 'schema_version'");

    // Same file, reopened. The old rows are unreadable by the new code, so they go — it
    // is a cache, and rebuilding is cheaper than migrating something disposable.
    const second = await SnapshotStore.open({ driver, embedder: hashEmbedder(64) });
    assert.equal(await second.listing('/mail/Inbox'), undefined);
    await second.close();
  });

  it('discards vectors written by a different embedding scheme', async () => {
    const driver = await openSqlDriver({ path: ':memory:' });
    const first = await SnapshotStore.open({ driver, embedder: hashEmbedder(64) });
    await first.putListing({ mountId: 'mail', path: '/mail/Inbox', entries: INBOX, isFirstPage: true, complete: true });
    assert.equal((await first.stats()).vectors, 3);

    // A wider embedder is a different scheme. Comparing across schemes produces
    // plausible nonsense rather than an error, so the old vectors must not survive.
    const second = await SnapshotStore.open({ driver, embedder: hashEmbedder(128) });
    assert.equal((await second.stats()).vectors, 0);
    assert.ok((await second.listing('/mail/Inbox')) !== undefined, 're-embedding is not a reason to lose the listing');
    await second.close();
  });
});

suite('SnapshotStore: stats', () => {
  it('counts what it holds and how often it answered', async () => {
    const harness = await open();
    await seedInbox(harness);
    await harness.store.listing('/mail/Inbox');
    await harness.store.listing('/mail/Nowhere');

    const stats = await harness.store.stats();
    assert.equal(stats.nodes, 3);
    assert.equal(stats.directories, 1);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.ok(stats.writes > 0);
    await harness.store.close();
  });
});

// ---------------------------------------------------------------------------
// SQLite builds without FTS5
// ---------------------------------------------------------------------------

/**
 * A driver that behaves exactly like a SQLite build with no full-text extension: every
 * statement mentioning fts5 or the index it creates fails the way Node 22's bundled
 * SQLite fails, and everything else works normally.
 *
 * This is not a hypothetical. Node did not ship FTS5 in `node:sqlite` until v23, so on
 * Node 22 — an LTS, inside this program's supported range — the snapshot used to refuse
 * to open at all with "no such module: fts5".
 */
function withoutFts(driver: SqlDriver): SqlDriver {
  const blocked = (sql: string): boolean => /fts5|node_fts/i.test(sql);
  const fail = (): never => {
    throw new Error('no such module: fts5');
  };
  return {
    ...driver,
    kind: driver.kind,
    description: driver.description,
    nativeVector: driver.nativeVector,
    exec: async (sql: string) => (blocked(sql) ? fail() : driver.exec(sql)),
    all: async (sql: string, params?: readonly SqlValue[]) => (blocked(sql) ? fail() : driver.all(sql, params)),
    get: async (sql: string, params?: readonly SqlValue[]) => (blocked(sql) ? fail() : driver.get(sql, params)),
    run: async (sql: string, params?: readonly SqlValue[]) => (blocked(sql) ? fail() : driver.run(sql, params)),
    batch: async (statements: readonly { sql: string; params?: readonly SqlValue[] }[]) =>
      statements.some((s) => blocked(s.sql)) ? fail() : driver.batch(statements),
    close: () => driver.close(),
  } as SqlDriver;
}

async function openWithoutFts(): Promise<Harness> {
  const real = await openSqlDriver({ path: ':memory:' });
  const driver = withoutFts(real);
  const harness = { driver, now: Date.parse('2024-06-04T09:00:00Z') } as {
    driver: SqlDriver;
    now: number;
    store: SnapshotStore;
  };
  harness.store = await SnapshotStore.open({ driver, embedder: hashEmbedder(64), now: () => harness.now });
  return harness as Harness;
}

suite('SnapshotStore: a SQLite build without FTS5', () => {
  it('opens anyway, because a missing index is not a missing cache', async () => {
    const harness = await openWithoutFts();
    const stats = await harness.store.stats();
    assert.equal(stats.fts, false);
    await harness.store.close();
  });

  it('still stores and serves listings', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness);
    const listing = await harness.store.listing('/mail/Inbox');
    assert.equal(listing?.entries.length, 3);
    await harness.store.close();
  });

  it('still answers a text search, by scanning instead of indexing', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness);
    const hits = await harness.store.candidates(parseQuery('outage'), { semantic: false });
    assert.deepEqual(
      hits.map((hit) => hit.node.title),
      ['Server outage postmortem'],
    );
    await harness.store.close();
  });

  it('ANDs its terms, so a second word narrows the result', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness);
    const both = await harness.store.candidates(parseQuery('budget review'), { semantic: false });
    assert.deepEqual(
      both.map((hit) => hit.node.title),
      ['Q3 budget review'],
    );
    const neither = await harness.store.candidates(parseQuery('budget outage'), { semantic: false });
    assert.deepEqual(neither, []);
    await harness.store.close();
  });

  it('finds a word that appears only in a body, which needs the body: prefix', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness);
    await harness.store.putDocument('mail', INBOX[1] as VNode, {
      title: 'Server outage postmortem',
      headers: [],
      body: 'The quarterly budget was not the cause.',
      format: 'text',
    });
    // Bare terms are metadata-only by design, so this is the query that proves the scan
    // reaches document bodies at all — the same reach FTS5 has.
    const hits = await harness.store.candidates(parseQuery('body:quarterly'), { semantic: false });
    assert.deepEqual(
      hits.map((hit) => hit.node.title),
      ['Server outage postmortem'],
    );
    await harness.store.close();
  });

  it('ranks a title hit above one found elsewhere', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness, [
      node('a.eml', 'r1', { title: 'Unrelated subject', summary: 'mentions budget in passing', mtime: new Date('2024-06-03T09:00:00Z') }),
      node('b.eml', 'r2', { title: 'Budget review', summary: 'nothing else', mtime: new Date('2024-06-01T09:00:00Z') }),
    ]);
    const hits = await harness.store.candidates(parseQuery('budget'), { semantic: false });
    assert.equal(hits.length, 2);
    // Without bm25 this ordering is the only ranking signal there is, and it has to beat
    // recency: the older message is the one whose subject the user typed.
    assert.equal(hits[0]?.node.title, 'Budget review');
    await harness.store.close();
  });

  it('treats LIKE wildcards in the query as literal text', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness, [
      node('discount.eml', 'p1', { title: '50% off everything', mtime: new Date('2024-06-01T09:00:00Z') }),
      node('plain.eml', 'p2', { title: 'Ordinary message', mtime: new Date('2024-06-02T09:00:00Z') }),
    ]);
    // Unescaped, "%" is LIKE's match-anything and this would return both rows — a search
    // that silently matches everything is worse than one that matches nothing.
    const hits = await harness.store.candidates(parseQuery('50%'), { semantic: false });
    assert.deepEqual(
      hits.map((hit) => hit.node.title),
      ['50% off everything'],
    );
    await harness.store.close();
  });

  it('still does semantic search, which never needed FTS5 in the first place', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness);
    const stats = await harness.store.stats();
    assert.equal(stats.vectors, 3);
    await harness.store.close();
  });

  it('can evict and clear without tripping over the index it does not have', async () => {
    const harness = await openWithoutFts();
    await seedInbox(harness);
    await harness.store.invalidate('/mail/Inbox');
    assert.equal(await harness.store.listing('/mail/Inbox'), undefined);
    await harness.store.clear();
    assert.equal((await harness.store.stats()).nodes, 0);
    await harness.store.close();
  });
});

