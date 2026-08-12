/**
 * The snapshot, end to end through the engine.
 *
 * The unit suites prove each piece works. This one proves the promise the feature actually
 * makes: that a second session is fast because it does not touch the network, that search
 * answers from local indexes before it asks anybody, and — the part that matters most —
 * that being fast never changes the answer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SnapshotStore } from '../snapshot.js';
import { BackgroundSync } from '../sync.js';
import { openSqlDriver } from '../sql.js';
import { Vfs, type Mount, type VfsOptions } from '../vfs.js';
import { parseQuery, evaluateQuery } from '../query.js';
import type { Capability, Document, ListPage, Provider, VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// A counting provider, so "did this touch the network" is answerable
// ---------------------------------------------------------------------------

interface Counts {
  list: number;
  read: number;
  search: number;
}

interface Item {
  readonly name: string;
  readonly title?: string;
  readonly body?: string;
  readonly flags?: readonly string[];
  readonly mtime?: number;
}

function buildProvider(items: readonly Item[], options: { searchable?: boolean; offline?: () => boolean } = {}) {
  const counts: Counts = { list: 0, read: 0, search: 0 };
  const capabilities = new Set<Capability>(['list', 'read']);
  if (options.searchable === true) capabilities.add('search');

  const nodes: VNode[] = items.map((item, index) => ({
    id: `id-${item.name}`,
    name: item.name,
    kind: 'file',
    title: item.title ?? item.name,
    path: `/mail/${item.name}`,
    author: 'Ada Lovelace',
    ...(item.flags === undefined ? {} : { flags: [...item.flags] }),
    mtime: new Date(item.mtime ?? 1_000 + index),
  }));

  const guard = (): void => {
    if (options.offline?.() === true) throw new Error('ENOTFOUND: the network is gone');
  };

  const provider: Provider = {
    id: 'mail',
    displayName: 'Mail',
    capabilities,
    async list(node) {
      counts.list += 1;
      guard();
      if (node !== null && node.path !== '/mail') return { entries: [] } as ListPage;
      return { entries: nodes } as ListPage;
    },
    async read(node) {
      counts.read += 1;
      guard();
      const item = items.find((candidate) => candidate.name === node.name);
      return {
        title: node.title,
        body: item?.body ?? `body of ${node.name}`,
      } as Document;
    },
  };

  if (options.searchable === true) {
    provider.search = async () => {
      counts.search += 1;
      guard();
      return { entries: nodes } as ListPage;
    };
  }

  return { provider, counts, nodes };
}

async function newSnapshot(options: { recent?: number } = {}): Promise<SnapshotStore> {
  const driver = await openSqlDriver({ path: ':memory:' });
  return SnapshotStore.open({
    driver,
    ...(options.recent === undefined ? {} : { maxNodesPerDirectory: options.recent }),
  });
}

function mountFor(provider: Provider): Mount {
  return { id: 'mail', path: '/mail', provider };
}

/** A Vfs with the provider mounted, since mounts are registered rather than constructed. */
function makeVfs(provider: Provider, options: Omit<VfsOptions, 'logger'> = {}): Vfs {
  const vfs = new Vfs(options);
  vfs.mount(mountFor(provider));
  return vfs;
}

// ---------------------------------------------------------------------------

describe('Vfs with a snapshot: cold start', () => {
  it('serves a listing from disk without asking the provider', async () => {
    const snapshot = await newSnapshot();
    const first = buildProvider([{ name: 'a' }, { name: 'b' }]);

    const warm = makeVfs(first.provider, { snapshot, prefetch: { enabled: false } });
    await warm.list('/mail');
    await warm.flush();
    assert.equal(first.counts.list, 1);

    // A new session over the same snapshot: this is the second time the user runs the tool.
    const second = buildProvider([{ name: 'a' }, { name: 'b' }]);
    const cold = makeVfs(second.provider, { snapshot, prefetch: { enabled: false } });
    const result = await cold.list('/mail');

    assert.deepEqual(result.entries.map((entry) => entry.name), ['a', 'b']);
    assert.equal(second.counts.list, 0, 'a warm snapshot must not touch the network');
    await snapshot.close();
  });

  it('reads a stored body without asking the provider', async () => {
    const snapshot = await newSnapshot();
    const first = buildProvider([{ name: 'a', body: 'the quarterly forecast' }]);
    const warm = makeVfs(first.provider, { snapshot, prefetch: { enabled: false } });
    await warm.list('/mail');
    await warm.read('/mail/a');
    await warm.flush();

    const second = buildProvider([{ name: 'a', body: 'the quarterly forecast' }]);
    const cold = makeVfs(second.provider, { snapshot, prefetch: { enabled: false } });
    const doc = await cold.read('/mail/a');

    assert.match(doc.body, /quarterly forecast/);
    assert.equal(second.counts.read, 0);
    await snapshot.close();
  });

  it('still works when the network is gone', async () => {
    const snapshot = await newSnapshot();
    const warm = buildProvider([{ name: 'a' }, { name: 'b' }]);
    const warmVfs = makeVfs(warm.provider, { snapshot, prefetch: { enabled: false } });
    await warmVfs.list('/mail');
    await warmVfs.flush();

    let offline = false;
    const cold = buildProvider([{ name: 'a' }, { name: 'b' }], { offline: () => offline });
    const coldVfs = makeVfs(cold.provider, { snapshot, prefetch: { enabled: false } });
    offline = true;

    // This is the whole point of a snapshot rather than a cache: a train tunnel is not an
    // error state.
    const result = await coldVfs.list('/mail');
    assert.equal(result.entries.length, 2);
    await snapshot.close();
  });

  it('does not invent entries for a directory it has never seen', async () => {
    const snapshot = await newSnapshot();
    const { provider, counts } = buildProvider([{ name: 'a' }]);
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });

    await vfs.list('/mail');
    assert.equal(counts.list, 1, 'an empty snapshot must fall through to the provider');
    await snapshot.close();
  });
});

describe('Vfs with a snapshot: staying correct', () => {
  it('does not serve a listing the user just invalidated', async () => {
    const snapshot = await newSnapshot();
    const { provider, counts } = buildProvider([{ name: 'a' }]);
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });

    await vfs.list('/mail');
    await vfs.flush();
    vfs.invalidate('/mail');
    await vfs.list('/mail');

    // `refresh` has to mean refresh. A cache that ignores it is a cache the user stops
    // trusting, and then stops using.
    assert.equal(counts.list, 2);
    await snapshot.close();
  });

  it('sends a filtered listing to the provider rather than answering from a partial snapshot', async () => {
    const snapshot = await newSnapshot();
    const warm = buildProvider([
      { name: 'a', flags: ['unread'] },
      { name: 'b' },
    ]);
    const warmVfs = makeVfs(warm.provider, { snapshot, prefetch: { enabled: false } });
    await warmVfs.list('/mail');
    await warmVfs.flush();

    const cold = buildProvider([{ name: 'a', flags: ['unread'] }, { name: 'b' }]);
    const coldVfs = makeVfs(cold.provider, { snapshot, prefetch: { enabled: false } });
    const result = await coldVfs.list('/mail', { query: parseQuery('is:unread') });

    // The snapshot holds the recent past, not the whole mailbox. Answering `is:unread`
    // from it would quietly report "nothing" for a message sitting just outside the
    // retention window — a wrong answer that looks exactly like a right one. So a
    // narrowed listing goes to the provider, which can see everything.
    assert.deepEqual(result.entries.map((entry) => entry.name), ['a']);
    assert.equal(cold.counts.list, 1);
    await snapshot.close();
  });

  it('filters snapshot entries by the same rules as live ones', async () => {
    const snapshot = await newSnapshot();
    const warm = buildProvider([
      { name: 'a', flags: ['unread'] },
      { name: 'b' },
    ]);
    const warmVfs = makeVfs(warm.provider, { snapshot, prefetch: { enabled: false } });
    const live = await warmVfs.list('/mail');
    await warmVfs.flush();

    const cold = buildProvider([]);
    const coldVfs = makeVfs(cold.provider, { snapshot, prefetch: { enabled: false } });
    const restored = await coldVfs.list('/mail');
    assert.equal(cold.counts.list, 0);

    // Whatever a filter decides about a node, it must decide the same thing after that
    // node has been through SQLite and back. One query implementation, one meaning —
    // otherwise `is:unread` would depend on how recently you restarted.
    const query = parseQuery('is:unread');
    const verdicts = (entries: readonly VNode[]): [string, boolean | 'unknown'][] =>
      entries.map((entry) => [entry.name, evaluateQuery(query, entry)]);
    assert.deepEqual(verdicts(restored.entries), verdicts(live.entries));
    assert.deepEqual(verdicts(restored.entries), [['a', true], ['b', false]]);
    await snapshot.close();
  });
});

describe('Vfs with a snapshot: search', () => {
  it('answers from the local index before asking anybody', async () => {
    const snapshot = await newSnapshot();
    const warm = buildProvider([{ name: 'budget', title: 'Quarterly budget' }, { name: 'other', title: 'Lunch' }], {
      searchable: true,
    });
    const warmVfs = makeVfs(warm.provider, { snapshot, prefetch: { enabled: false } });
    await warmVfs.list('/mail');
    await warmVfs.flush();

    const cold = buildProvider([{ name: 'budget', title: 'Quarterly budget' }, { name: 'other', title: 'Lunch' }], {
      searchable: true,
    });
    const coldVfs = makeVfs(cold.provider, { snapshot, prefetch: { enabled: false } });

    const result = await coldVfs.search('/mail', parseQuery('budget'), { local: true });

    assert.deepEqual(result.entries.map((entry) => entry.name), ['budget']);
    assert.equal(cold.counts.search, 0, 'local search must not hit the network');
    await snapshot.close();
  });

  it('merges live results with local ones without duplicating anything', async () => {
    const snapshot = await newSnapshot();
    const items: Item[] = [{ name: 'budget', title: 'Quarterly budget' }];
    const warm = buildProvider(items, { searchable: true });
    const warmVfs = makeVfs(warm.provider, { snapshot, prefetch: { enabled: false } });
    await warmVfs.list('/mail');
    await warmVfs.flush();

    const live = buildProvider(items, { searchable: true });
    const vfs = makeVfs(live.provider, { snapshot, prefetch: { enabled: false } });
    const result = await vfs.search('/mail', parseQuery('budget'), {});

    // The same message found twice is one message. Identity is the node id, because a
    // provider is free to return a different path for the same item.
    assert.equal(result.entries.length, 1);
    assert.equal(live.counts.search, 1, 'the network is still consulted for anything newer');
    await snapshot.close();
  });

  it('never reports absence from the snapshot alone', async () => {
    const snapshot = await newSnapshot();
    const warm = buildProvider([{ name: 'a', title: 'Anything' }], { searchable: true });
    const warmVfs = makeVfs(warm.provider, { snapshot, prefetch: { enabled: false } });
    await warmVfs.list('/mail');
    await warmVfs.flush();

    const live = buildProvider([{ name: 'a', title: 'Anything' }], { searchable: true });
    const vfs = makeVfs(live.provider, { snapshot, prefetch: { enabled: false } });
    await vfs.search('/mail', parseQuery('somethingnotinthesnapshot'), {});

    // A user who believes search is complete stops scrolling. If the snapshot has no hit,
    // that is not an answer — it is a reason to ask the server.
    assert.equal(live.counts.search, 1);
    await snapshot.close();
  });
});

describe('Vfs with a snapshot: prefetch', () => {
  it('warms what the user is about to open', async () => {
    const snapshot = await newSnapshot();
    const { provider, counts } = buildProvider([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const vfs = makeVfs(provider, {
      snapshot,
      prefetch: { enabled: true, documents: 2, concurrency: 1 },
    });

    await vfs.list('/mail');
    await vfs.flush();

    // Bodies of the first two entries, fetched while the user is still reading the listing.
    assert.equal(counts.read, 2);
    assert.notEqual(await snapshot.document('/mail/a'), undefined);
    await snapshot.close();
  });

  it('is entirely optional', async () => {
    const snapshot = await newSnapshot();
    const { provider, counts } = buildProvider([{ name: 'a' }, { name: 'b' }]);
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });

    await vfs.list('/mail');
    await vfs.flush();

    // Speculation spends the user's API quota. It has to be possible to say no.
    assert.equal(counts.read, 0);
    await snapshot.close();
  });

  it('never lets a failed guess reach the user', async () => {
    const snapshot = await newSnapshot();
    const { provider } = buildProvider([{ name: 'a' }]);
    provider.read = async () => {
      throw new Error('429 Too Many Requests');
    };

    const vfs = makeVfs(provider, {
      snapshot,
      prefetch: { enabled: true, documents: 1, concurrency: 1 },
    });

    // Nobody asked for this fetch, so its failure must not surface as an error about a
    // message the user never opened.
    const result = await vfs.list('/mail');
    await vfs.flush();
    assert.equal(result.entries.length, 1);
    await snapshot.close();
  });
});

describe('Vfs with a snapshot: retention', () => {
  it('keeps only the n most recent, and stops claiming the folder is complete', async () => {
    const snapshot = await newSnapshot({ recent: 2 });
    const items = Array.from({ length: 6 }, (_unused, index) => ({ name: `m${index}`, mtime: 1_000 + index }));
    const { provider } = buildProvider(items);

    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });
    await vfs.list('/mail');
    await vfs.flush();

    const listing = await snapshot.listing('/mail');
    assert.equal(listing?.entries.length, 2);
    // A truncated folder must never be served as the whole folder, or `ls` would quietly
    // stop showing mail that exists.
    assert.equal(listing?.complete, false);
    await snapshot.close();
  });
});

describe('Vfs without a snapshot', () => {
  it('behaves exactly as it did before the snapshot existed', async () => {
    const { provider, counts } = buildProvider([{ name: 'a' }, { name: 'b' }]);
    const vfs = makeVfs(provider);

    const result = await vfs.list('/mail');
    assert.deepEqual(result.entries.map((entry) => entry.name), ['a', 'b']);
    assert.equal(counts.list, 1);

    // No snapshot configured must not mean a degraded engine — flushing nothing is fine.
    await vfs.flush();
  });

  it('can have a snapshot attached and detached at runtime', async () => {
    const snapshot = await newSnapshot();
    const { provider, counts } = buildProvider([{ name: 'a' }]);
    const vfs = makeVfs(provider);

    vfs.attachSnapshot(snapshot, { enabled: false });
    await vfs.list('/mail');
    await vfs.flush();

    vfs.detachSnapshot();
    vfs.invalidate('/mail');
    await vfs.list('/mail');

    // `cache disable` has to take effect without restarting the shell: once detached,
    // a cold listing goes to the network even though the rows are still on disk.
    assert.equal(counts.list, 2);
    await snapshot.close();
  });
});

// ---------------------------------------------------------------------------

describe('BackgroundSync and the engine agree on names', () => {
  /**
   * A provider whose raw names are hostile in the ways real backends are: a subject
   * containing a slash, a reserved Windows device name, a right-to-left override used to
   * disguise an extension, and two messages that share a subject exactly.
   */
  function hostileProvider() {
    const raw: ReadonlyArray<{ id: string; name: string; author: string }> = [
      { id: 'msg-slash', name: 'Q3/Q4 planning: infra/tooling split.eml', author: 'Dana' },
      { id: 'msg-con', name: 'CON.eml', author: 'Lena' },
      { id: 'msg-rtl', name: 'Invoice \u202Efdp.exe.eml', author: 'unknown' },
      { id: 'msg-dup-a', name: 'FY26 budget review.eml', author: 'Tom' },
      { id: 'msg-dup-b', name: 'FY26 budget review.eml', author: 'Priya' },
    ];
    const nodes = raw.map((item, index) => ({
      id: item.id,
      name: item.name,
      kind: 'file' as const,
      title: item.name,
      author: item.author,
      mtime: new Date(2_000 + index),
    }));
    const provider: Provider = {
      id: 'mail',
      displayName: 'Mail',
      capabilities: new Set<Capability>(['list', 'read']),
      async list() {
        return { entries: nodes } as ListPage;
      },
      async read(node) {
        return { title: node.title, body: `body of ${node.id}` } as Document;
      },
    };
    return { provider, nodes };
  }

  it('stores the filenames the engine shows, not the provider raw text', async () => {
    const snapshot = await newSnapshot();
    const { provider } = hostileProvider();
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });

    const live = await vfs.list('/mail');
    const sync = new BackgroundSync({ host: vfs, snapshot, bodies: 0 });
    await sync.runOnce();
    await vfs.flush();

    const stored = await snapshot.listing('/mail');
    assert.notEqual(stored, undefined);

    const shown = live.entries.map((entry) => entry.name).sort();
    const cached = (stored as { entries: readonly VNode[] }).entries.map((entry) => entry.name).sort();

    // A cached name that the engine would never produce is a path that cannot be opened.
    assert.deepEqual(cached, shown);
    await snapshot.close();
  });

  it('does not let two messages with one subject collapse into one row', async () => {
    const snapshot = await newSnapshot();
    const { provider } = hostileProvider();
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });

    await vfs.list('/mail');
    const sync = new BackgroundSync({ host: vfs, snapshot, bodies: 0 });
    await sync.runOnce();
    await vfs.flush();

    const stored = (await snapshot.listing('/mail')) as { entries: readonly VNode[] };
    const ids = stored.entries.map((entry) => entry.id);

    // Deduplication is what makes the second one reachable at all. Without it the newer
    // message quietly overwrites the older at the same path, and the older is simply gone.
    assert.ok(ids.includes('msg-dup-a'), 'first of the duplicate pair is missing');
    assert.ok(ids.includes('msg-dup-b'), 'second of the duplicate pair is missing');
    assert.equal(new Set(stored.entries.map((entry) => entry.name)).size, stored.entries.length);
    await snapshot.close();
  });

  it('gives a cached path that the engine can actually resolve', async () => {
    const snapshot = await newSnapshot();
    const { provider } = hostileProvider();
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: false } });

    await vfs.list('/mail');
    const sync = new BackgroundSync({ host: vfs, snapshot, bodies: 0 });
    await sync.runOnce();
    await vfs.flush();

    const stored = (await snapshot.listing('/mail')) as { entries: readonly VNode[] };
    for (const entry of stored.entries) {
      const path = entry.path as string;
      const resolved = await vfs.resolve(path);
      assert.notEqual(resolved.node, null, `cached path did not resolve: ${path}`);
      assert.equal(resolved.node?.id, entry.id, `cached path resolved to a different item: ${path}`);
    }
    await snapshot.close();
  });
});

// ---------------------------------------------------------------------------

describe('prefetching is bounded', () => {
  /** A provider with a real tree, so speculation has somewhere to run away to. */
  function treeProvider() {
    const counts = { list: 0 };
    const children: Record<string, readonly string[]> = {
      '/mail': ['a', 'b', 'c'],
      '/mail/a': ['a1', 'a2', 'a3'],
      '/mail/b': ['b1', 'b2', 'b3'],
      '/mail/c': ['c1', 'c2', 'c3'],
      '/mail/a/a1': ['x', 'y', 'z'],
      '/mail/a/a2': ['x', 'y', 'z'],
      '/mail/a/a3': ['x', 'y', 'z'],
      '/mail/b/b1': ['x', 'y', 'z'],
    };
    const provider: Provider = {
      id: 'mail',
      displayName: 'Mail',
      capabilities: new Set<Capability>(['list', 'read']),
      async list(node) {
        counts.list += 1;
        // Yield to the event loop, as any provider doing real I/O would. This is not
        // decoration: runaway speculation is a chain of microtasks, and a provider that
        // resolves synchronously never lets a timer run, so the process wedges instead of
        // failing and no test timeout can fire. One real turn of the loop is the
        // difference between a red test and a hung suite.
        await new Promise((resolve) => setImmediate(resolve));
        const path = node === null ? '/mail' : (node.path as string);
        const names = children[path] ?? [];
        return {
          entries: names.map((name) => ({
            id: `${path}/${name}`,
            name,
            kind: 'dir' as const,
            title: name,
            path: `${path}/${name}`,
          })),
        } as ListPage;
      },
      async read(node) {
        return { title: node.title, body: 'body' } as Document;
      },
    };
    return { provider, counts };
  }

  it('does not walk the whole tree from a single listing', { timeout: 15_000 }, async () => {
    const snapshot = await newSnapshot();
    const { provider, counts } = treeProvider();
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: true } });

    await vfs.list('/mail');
    // Without a speculation guard this never settles: each speculative listing predicts
    // from its own result and schedules more, forever. Note the failure mode — runaway
    // speculation saturates the event loop, so this does not fail politely, it hangs the
    // run. A hung suite here means exactly one thing, and this comment is the map to it.
    await vfs.flush();

    // One foreground listing plus a bounded first hop. The exact number depends on the
    // predictor's budget; what must never happen is a number that scales with the tree.
    assert.ok(counts.list <= 12, `prefetch made ${String(counts.list)} listings from one navigation`);
    assert.ok(counts.list > 1, 'nothing was prefetched at all, so this proves nothing');
    await snapshot.close();
  });

  it('does not learn transitions the user never made', { timeout: 15_000 }, async () => {
    const snapshot = await newSnapshot();
    const { provider } = treeProvider();
    const vfs = makeVfs(provider, { snapshot, prefetch: { enabled: true } });

    // Two real moves, so there is exactly one transition a correct predictor may record.
    await vfs.list('/mail');
    await vfs.list('/mail/a');
    await vfs.flush();

    // Speculation is a guess about the user, so letting it feed the model would make the
    // model a record of its own guesses — and every prefetched folder would look like a
    // place the user had been.
    const history = await snapshot.navigationHistory();
    assert.ok(history.length >= 1, 'no transition was recorded, so this proves nothing');
    for (const entry of history) {
      assert.equal(
        `${entry.from ?? ''} -> ${entry.to}`,
        '/mail -> /mail/a',
        'learned a move nobody made',
      );
    }
    await snapshot.close();
  });
});




