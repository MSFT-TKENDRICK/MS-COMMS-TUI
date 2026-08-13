import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openSqlDriver } from '../sql.js';
import { SnapshotStore } from '../snapshot.js';
import { BackgroundSync, type SyncHost, type SyncMount } from '../sync.js';
import { NameAllocator } from '../naming.js';
import { agentFsDatabase, loadAgentFs, type ToolCallsLike } from '../agentfs.js';
import type { Capability, Document, ListPage, Provider, VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// A provider that records what was asked of it
// ---------------------------------------------------------------------------

interface Recorded {
  readonly lists: Array<{ path: string; limit: number | undefined; cursor: string | undefined }>;
  readonly polls: Array<{ path: string; cursor: string | undefined }>;
  readonly reads: string[];
}

interface FakeOptions {
  readonly tree?: Record<string, VNode[]>;
  readonly capabilities?: Capability[];
  readonly derived?: boolean;
  readonly pollResults?: Array<{ changes: unknown[]; cursor?: string }>;
  readonly failOn?: string;
  readonly pageSize?: number;
}

function file(name: string, at: string, mtime = 0): VNode {
  return { id: `${at}/${name}`, name, kind: 'file', title: name, path: `${at}/${name}`, mtime: new Date(mtime) };
}

function dir(name: string, at: string): VNode {
  return { id: `${at}/${name}`, name, kind: 'dir', title: name, path: `${at}/${name}` };
}

function fakeProvider(options: FakeOptions = {}): { provider: Provider; recorded: Recorded } {
  const tree = options.tree ?? {};
  const recorded: Recorded = { lists: [], polls: [], reads: [] };
  let pollIndex = 0;

  const provider: Provider = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: new Set<Capability>(options.capabilities ?? ['list']),
    ...(options.derived === true ? { derived: true as const } : {}),
    async list(node, listOptions) {
      const path = node?.path ?? '/mail';
      recorded.lists.push({ path, limit: listOptions?.limit, cursor: listOptions?.cursor });
      if (options.failOn === path) throw new Error('403 Forbidden');

      const all = tree[path] ?? [];
      const size = options.pageSize ?? all.length;
      const start = listOptions?.cursor === undefined ? 0 : Number(listOptions.cursor);
      const slice = all.slice(start, start + size);
      const nextStart = start + slice.length;
      const page: ListPage = {
        entries: slice,
        ...(nextStart < all.length ? { cursor: String(nextStart) } : {}),
      };
      return page;
    },
  } as Provider;

  if ((options.capabilities ?? []).includes('poll')) {
    provider.poll = async (node, cursor) => {
      recorded.polls.push({ path: node?.path ?? '/mail', cursor });
      const result = options.pollResults?.[pollIndex] ?? { changes: [], cursor: `c${pollIndex}` };
      pollIndex += 1;
      return result as never;
    };
  }

  if ((options.capabilities ?? []).includes('read')) {
    provider.read = async (node) => {
      recorded.reads.push(node.path ?? node.id);
      return { title: node.title, body: `body of ${node.name}` } as Document;
    };
  }

  return { provider, recorded };
}

function hostFor(mounts: readonly SyncMount[]): SyncHost {
  // Per-directory allocators, exactly as the engine keeps them: a name is allocated once
  // per item and reused, so paging a folder cannot rename what is already in it.
  const allocators = new Map<string, { allocator: NameAllocator; byId: Map<string, string> }>();

  return {
    mounts,
    async resolve(path) {
      // Every path in these tests is a real directory; the engine's own resolution is
      // covered by the vfs suite, so this stands in for it faithfully but simply.
      const name = path.split('/').filter(Boolean).pop() ?? '';
      return { node: { id: path, name, kind: 'dir', title: name, path } as VNode };
    },
    canonicalize(path, entries) {
      let state = allocators.get(path);
      if (state === undefined) {
        state = { allocator: new NameAllocator(), byId: new Map() };
        allocators.set(path, state);
      }
      return entries.map((entry) => {
        let name = state.byId.get(entry.id);
        if (name === undefined) {
          name = state.allocator.allocate(entry.name);
          state.byId.set(entry.id, name);
        }
        return { ...entry, name, path: `${path === '/' ? '' : path}/${name}` };
      });
    },
  };
}

async function store(options: { recent?: number } = {}): Promise<SnapshotStore> {
  const driver = await openSqlDriver({ path: ':memory:' });
  return SnapshotStore.open({
    driver,
    ...(options.recent === undefined ? {} : { maxNodesPerDirectory: options.recent }),
  });
}

// ---------------------------------------------------------------------------

describe('BackgroundSync: a cycle', () => {
  it('fills the snapshot so a cold start has an answer', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({ tree: { '/mail': [file('a', '/mail'), file('b', '/mail')] } });
    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
    });

    const status = await sync.runOnce();

    assert.equal(status.items, 2);
    assert.equal(status.directories, 1);
    const listing = await snapshot.listing('/mail');
    assert.deepEqual(listing?.entries.map((entry) => entry.name), ['a', 'b']);
    await snapshot.close();
  });

  it('descends only as deep as it is told', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: {
        '/mail': [dir('Inbox', '/mail')],
        '/mail/Inbox': [dir('Sub', '/mail/Inbox')],
        '/mail/Inbox/Sub': [file('deep', '/mail/Inbox/Sub')],
      },
    });
    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      depth: 2,
    });

    await sync.runOnce();

    // Depth 2 means the mount root and its folders — not the whole account.
    assert.deepEqual(
      recorded.lists.map((entry) => entry.path),
      ['/mail', '/mail/Inbox'],
    );
    await snapshot.close();
  });

  it('never syncs a derived mount', async () => {
    const snapshot = await store();
    const real = fakeProvider({ tree: { '/mail': [file('a', '/mail')] } });
    const view = fakeProvider({ tree: { '/people': [file('a', '/people')] }, derived: true });

    const sync = new BackgroundSync({
      host: hostFor([
        { id: 'mail', path: '/mail', provider: real.provider },
        { id: 'people', path: '/people', provider: view.provider },
      ]),
      snapshot,
    });
    await sync.runOnce();

    // A projection holds nothing of its own; syncing it stores the same mail twice under
    // a second name, doubling the snapshot and the API spend for no new information.
    assert.equal(view.recorded.lists.length, 0);
    assert.equal(real.recorded.lists.length, 1);
    await snapshot.close();
  });

  it('skips a mount that cannot list at all', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({ capabilities: ['read'] });
    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
    });

    const status = await sync.runOnce();
    assert.equal(status.directories, 0);
    assert.equal(recorded.lists.length, 0);
    await snapshot.close();
  });

  it('keeps going when one folder fails, and records why', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({
      tree: {
        '/mail': [dir('Inbox', '/mail'), dir('Locked', '/mail')],
        '/mail/Inbox': [file('a', '/mail/Inbox')],
        '/mail/Locked': [],
      },
      failOn: '/mail/Locked',
    });
    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      concurrency: 1,
    });

    const status = await sync.runOnce();

    // One unreadable folder must not cost the other nine.
    assert.equal(status.errors.length, 1);
    assert.match(status.errors[0] ?? '', /\/mail\/Locked: 403 Forbidden/);
    assert.notEqual(await snapshot.listing('/mail/Inbox'), undefined);
    await snapshot.close();
  });

  it('stops descending once it has touched enough directories', async () => {
    const snapshot = await store();
    const tree: Record<string, VNode[]> = { '/mail': [] };
    for (let i = 0; i < 10; i += 1) {
      (tree['/mail'] as VNode[]).push(dir(`f${i}`, '/mail'));
      tree[`/mail/f${i}`] = [file('a', `/mail/f${i}`)];
    }
    const { provider, recorded } = fakeProvider({ tree });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      maxDirectoriesPerCycle: 4,
      concurrency: 1,
    });
    await sync.runOnce();

    // One enormous account must not monopolise the cycle; the rest is picked up next time.
    assert.equal(recorded.lists.length, 4);
    await snapshot.close();
  });
});

describe('BackgroundSync: the n most recent', () => {
  it('stops paging once it has enough', async () => {
    const snapshot = await store();
    const many = Array.from({ length: 100 }, (_unused, index) => file(`m${index}`, '/mail', index));
    const { provider, recorded } = fakeProvider({ tree: { '/mail': many }, pageSize: 10 });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider, pageSize: 10 }]),
      snapshot,
      recent: 30,
    });
    const status = await sync.runOnce();

    // A preloader without a limit downloads a corporate mail account onto a laptop.
    assert.equal(status.items, 30);
    assert.equal(recorded.lists.length, 3);
    await snapshot.close();
  });

  it('never asks for more than it is allowed to keep', async () => {
    const snapshot = await store();
    const many = Array.from({ length: 100 }, (_unused, index) => file(`m${index}`, '/mail', index));
    const { provider, recorded } = fakeProvider({ tree: { '/mail': many }, pageSize: 50 });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider, pageSize: 50 }]),
      snapshot,
      recent: 20,
    });
    await sync.runOnce();

    // The last page is trimmed to the remaining budget rather than overshooting and
    // relying on retention to clean up afterwards.
    assert.deepEqual(
      recorded.lists.map((entry) => entry.limit),
      [20],
    );
    await snapshot.close();
  });
});

describe('BackgroundSync: poll cursors', () => {
  it('establishes a cursor on the first cycle so the next one is cheap', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({
      tree: { '/mail': [file('a', '/mail')] },
      capabilities: ['list', 'poll'],
      pollResults: [{ changes: [], cursor: 'delta-1' }],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
    });
    await sync.runOnce();

    assert.equal(await snapshot.pollCursor('mail', '/mail'), 'delta-1');
    await snapshot.close();
  });

  it('answers "nothing changed" without re-listing', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: { '/mail': [file('a', '/mail'), dir('Sub', '/mail')] },
      capabilities: ['list', 'poll'],
      pollResults: [
        { changes: [], cursor: 'delta-1' },
        { changes: [], cursor: 'delta-2' },
      ],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      depth: 1,
    });
    await sync.runOnce();
    const listsAfterFirst = recorded.lists.length;

    await sync.runOnce();

    // This is what makes a five minute cycle affordable against a real tenant: the
    // steady state is one request that returns nothing.
    assert.equal(recorded.lists.length, listsAfterFirst);
    assert.equal(await snapshot.pollCursor('mail', '/mail'), 'delta-2');
    await snapshot.close();
  });

  it('re-lists when the cursor reports a change', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: { '/mail': [file('a', '/mail')] },
      capabilities: ['list', 'poll'],
      pollResults: [
        { changes: [], cursor: 'delta-1' },
        { changes: [{ type: 'created', path: '/mail/b' }], cursor: 'delta-2' },
      ],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      depth: 1,
    });
    await sync.runOnce();
    const listsAfterFirst = recorded.lists.length;

    await sync.runOnce();

    // A delta describes changes, not order — so a change triggers the re-list it warrants
    // rather than being applied to the stored listing directly.
    assert.equal(recorded.lists.length, listsAfterFirst + 1);
    await snapshot.close();
  });

  it('still returns subdirectories on the cheap path', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: {
        '/mail': [dir('Inbox', '/mail')],
        '/mail/Inbox': [file('a', '/mail/Inbox')],
      },
      capabilities: ['list', 'poll'],
      pollResults: [
        { changes: [], cursor: 'd1' },
        { changes: [], cursor: 'd1' },
        { changes: [], cursor: 'd2' },
        { changes: [], cursor: 'd2' },
      ],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      depth: 2,
      concurrency: 1,
    });
    await sync.runOnce();
    recorded.lists.length = 0;

    await sync.runOnce();

    // The cheap path must still walk the tree, or a folder one level down would stop
    // being refreshed the moment its parent went quiet.
    assert.equal(recorded.lists.length, 0);
    assert.notEqual(await snapshot.listing('/mail/Inbox'), undefined);
    await snapshot.close();
  });
});

describe('BackgroundSync: bodies', () => {
  it('fetches nothing by default', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: { '/mail': [file('a', '/mail')] },
      capabilities: ['list', 'read'],
    });

    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });
    await sync.runOnce();

    // Bodies are the setting that turns a cache into a mirror. Off unless asked for.
    assert.deepEqual(recorded.reads, []);
    await snapshot.close();
  });

  it('fetches the newest few when switched on', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: {
        '/mail': [file('old', '/mail', 1_000), file('newest', '/mail', 9_000), file('mid', '/mail', 5_000)],
      },
      capabilities: ['list', 'read'],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      bodies: 2,
    });
    const status = await sync.runOnce();

    assert.deepEqual(recorded.reads, ['/mail/newest', '/mail/mid']);
    assert.equal(status.bodies, 2);
    assert.match((await snapshot.document('/mail/newest'))?.doc.body ?? '', /body of newest/);
    await snapshot.close();
  });

  it('does not re-download a body it already holds', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({
      tree: { '/mail': [file('a', '/mail', 1)] },
      capabilities: ['list', 'read'],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      bodies: 5,
    });
    await sync.runOnce();
    await sync.runOnce();

    assert.deepEqual(recorded.reads, ['/mail/a']);
    await snapshot.close();
  });

  it('skips bodies for a provider that cannot read', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({ tree: { '/mail': [file('a', '/mail')] }, capabilities: ['list'] });
    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      bodies: 5,
    });

    const status = await sync.runOnce();
    assert.equal(status.bodies, 0);
    await snapshot.close();
  });
});

describe('BackgroundSync: lifecycle', () => {
  it('joins the cycle already running rather than starting a second', async () => {
    const snapshot = await store();
    let listCalls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider = {
      id: 'slow',
      displayName: 'Slow',
      capabilities: new Set<Capability>(['list']),
      async list() {
        listCalls += 1;
        await blocked;
        return { entries: [] } as ListPage;
      },
    } as Provider;

    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    const first = sync.runOnce();
    const second = sync.runOnce();

    release();
    await Promise.all([first, second]);

    // A slow first cycle on a big account would otherwise stack up runs that each
    // re-fetch what the previous one is still fetching.
    assert.equal(listCalls, 1);
    assert.equal(sync.status.cycles, 1);
    await snapshot.close();
  });

  it('reports itself as running only while a cycle is in flight', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({ tree: { '/mail': [] } });
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    assert.equal(sync.status.running, false);
    const cycle = sync.runOnce();
    assert.equal(sync.status.running, true);
    await cycle;
    assert.equal(sync.status.running, false);
    await snapshot.close();
  });

  it('stops cleanly and leaves nothing behind', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({ tree: { '/mail': [file('a', '/mail')] } });
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    sync.start();
    await sync.stop();

    // A background sync must never be the reason a one-shot `mscomms ls` fails to exit.
    assert.equal(sync.status.running, false);
    await snapshot.close();
  });

  it('clears stale errors at the start of each cycle', async () => {
    const snapshot = await store();
    let fail = true;
    const provider = {
      id: 'flaky',
      displayName: 'Flaky',
      capabilities: new Set<Capability>(['list']),
      async list() {
        if (fail) throw new Error('timeout');
        return { entries: [] } as ListPage;
      },
    } as Provider;

    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });
    assert.equal((await sync.runOnce()).errors.length, 1);

    fail = false;
    // Otherwise `cache status` would show an outage that resolved twenty minutes ago.
    assert.equal((await sync.runOnce()).errors.length, 0);
    await snapshot.close();
  });

  it('prunes once per cycle rather than once per directory', async () => {
    const snapshot = await store({ recent: 2 });
    const many = Array.from({ length: 6 }, (_unused, index) => file(`m${index}`, '/mail', index));
    const { provider } = fakeProvider({ tree: { '/mail': many } });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      recent: 6,
    });
    await sync.runOnce();

    // Retention is the independent belt to the sync's braces: a provider that ignores
    // `limit` still cannot fill the disk.
    const listing = await snapshot.listing('/mail');
    assert.equal(listing?.entries.length, 2);
    await snapshot.close();
  });
});


describe('BackgroundSync: the audit trail', () => {
  async function auditFor(): Promise<{ audit: ToolCallsLike; close: () => Promise<void> }> {
    const driver = await openSqlDriver({ path: ':memory:' });
    const { ToolCalls } = await loadAgentFs();
    const audit = (await ToolCalls.fromDatabase(agentFsDatabase(driver))) as ToolCallsLike;
    return { audit, close: () => driver.close() };
  }

  it('records the calls a cycle made, with paths but never message bodies', async () => {
    const snapshot = await store();
    const { audit, close } = await auditFor();
    const { provider } = fakeProvider({
      tree: { '/mail': [file('a', '/mail', 5_000)] },
      capabilities: ['list', 'read'],
    });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      bodies: 1,
      audit,
    });
    await sync.runOnce();

    const recent = await audit.getRecent(0, 50);
    const names = recent.map((row) => row['name']);
    assert.ok(names.includes('provider.list'));
    assert.ok(names.includes('provider.read'));

    // The whole point of the restraint in #audited: the log says a body was fetched and
    // how big it was, never what it said. An audit trail that becomes a second copy of
    // your mail is worse than the problem it solves.
    const read = recent.find((row) => row['name'] === 'provider.read');
    const serialised = JSON.stringify(read);
    assert.match(serialised, /\/mail\/a/);
    assert.doesNotMatch(serialised, /body of a/);

    await close();
    await snapshot.close();
  });

  it('records a failed call with its error instead of dropping it', async () => {
    const snapshot = await store();
    const { audit, close } = await auditFor();
    const { provider } = fakeProvider({ tree: { '/mail': [] }, failOn: '/mail' });

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      audit,
    });
    await sync.runOnce();

    const recent = await audit.getRecent(0, 50);
    assert.equal(recent.length, 1);
    // A cache that silently fetches nothing looks identical to an empty mailbox. The
    // failure is the single most useful thing in the log.
    assert.match(String(recent[0]?.['error']), /403 Forbidden/);
    await close();
    await snapshot.close();
  });

  it('keeps syncing when the audit store itself is broken', async () => {
    const snapshot = await store();
    const { provider, recorded } = fakeProvider({ tree: { '/mail': [file('a', '/mail')] } });
    const broken: ToolCallsLike = {
      record: async () => {
        throw new Error('disk full');
      },
      getRecent: async () => [],
      getStats: async () => [],
    };

    const sync = new BackgroundSync({
      host: hostFor([{ id: 'mail', path: '/mail', provider }]),
      snapshot,
      audit: broken,
    });
    const status = await sync.runOnce();

    // Bookkeeping must never be able to stop the work it is bookkeeping for.
    assert.equal(recorded.lists.length, 1);
    assert.equal(status.items, 1);
    assert.equal((await snapshot.listing('/mail'))?.entries.length, 1);
    await snapshot.close();
  });

  it('writes nothing at all when no audit store is configured', async () => {
    const snapshot = await store();
    const { provider } = fakeProvider({ tree: { '/mail': [file('a', '/mail')] } });
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });
    await sync.runOnce();

    // Opt-in means opt-in: the snapshot database must not grow an audit table because
    // background sync happened to run.
    const driver = snapshot.driver;
    const row = await driver.get("SELECT name FROM sqlite_master WHERE name = 'tool_calls'");
    assert.equal(row, undefined);
    await snapshot.close();
  });
});



// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Stopping, when the thing being stopped will not stop.
 *
 * `stop()` has to wait for the cycle to unwind — closing the database under a sync still
 * writing to it is a genuine corruption risk, and that is why it is awaited at all. But
 * "wait for it to unwind" only terminates if the work can actually be left, and a provider
 * is third-party code for which honouring an AbortSignal is a courtesy rather than a
 * guarantee. When it is not honoured, the await never returns. Measured against a real
 * mailbox, quitting took twenty-six seconds this way; this is the third time shutdown has
 * hung and the first time the general case has a guard.
 *
 * The provider below is the distilled version: it ignores its signal completely, and can be
 * released by the test so the disowned worker's behaviour *after* being abandoned is
 * observable rather than merely asserted about.
 */
describe('BackgroundSync: stopping', () => {
  /** A provider whose `list` hangs until the test lets it go. */
  function heldProvider(): { provider: Provider; release: () => void; started: Promise<void> } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const provider: Provider = {
      id: 'held',
      displayName: 'Held',
      capabilities: new Set<Capability>(['list']),
      async list() {
        markStarted();
        // No signal handling on purpose. That is the whole point.
        await held;
        return { entries: [file('a', '/mail')] } satisfies ListPage;
      },
    } as Provider;

    return { provider, release, started };
  }

  it('returns promptly even when the provider ignores the abort', async () => {
    const snapshot = await store();
    const { provider, release, started } = heldProvider();
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    sync.start();
    await started;

    const at = Date.now();
    await sync.stop();
    const elapsed = Date.now() - at;
    // The grace period is 250ms; the failure this guards against was 26_000ms.
    assert.ok(elapsed < 2000, `stop() took ${String(elapsed)}ms`);

    release();
    await snapshot.close();
  });

  it('does not let work it walked away from carry on writing', async () => {
    // The direct statement of what "disowned" has to mean. The snapshot is deliberately
    // left *open* here — with it closed, a stray write merely fails and is indistinguishable
    // from one that was correctly declined. Open, the difference is plain: an unguarded
    // worker succeeds in writing a listing that shutdown already decided not to wait for.
    const snapshot = await store();
    const { provider, release, started } = heldProvider();
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    sync.start();
    await started;
    await sync.stop();

    release();
    // Long enough for the abandoned worker to run to completion if nothing stops it.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(await snapshot.listing('/mail'), undefined, 'a disowned worker must not write');
    await snapshot.close();
  });

  it('reports no errors, because being told to stop is not a failure', async () => {
    // What the user sees. `cache status` and `doctor` both surface these, and a clean quit
    // that leaves "database is not open" behind reads like corruption rather than teardown.
    const snapshot = await store();
    const { provider, release, started } = heldProvider();
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    sync.start();
    await started;
    await sync.stop();
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(sync.status.errors, []);
    await snapshot.close();
  });

  it('stays stopped, so a timer that already fired cannot restart it', async () => {
    // `start()` schedules on an interval and `runOnce` joins whatever is running. A cycle
    // that begins after stop() would reopen exactly the window shutdown just closed.
    const snapshot = await store();
    const { provider } = fakeProvider({ tree: { '/mail': [file('a', '/mail')] } });
    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });

    await sync.stop();
    await sync.runOnce();

    assert.equal(await snapshot.listing('/mail'), undefined, 'a stopped sync must not write');
    await snapshot.close();
  });

  it('does not write a poll cursor for work it walked away from', async () => {
    // The `list` provider above cannot reach this: `poll` is a separate branch, and it is
    // the *longer* of the two against a real account — it is the path the twenty-six second
    // hang actually took. A guard before `putListing` says nothing about a `setPollCursor`
    // written on the way back from a poll that ignored its abort. Snapshot left open, for
    // the same reason as the test above.
    const snapshot = await store();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider: Provider = {
      id: 'held-poll',
      displayName: 'Held poll',
      capabilities: new Set<Capability>(['list', 'poll']),
      async list() {
        return { entries: [file('a', '/mail')] } satisfies ListPage;
      },
      async poll() {
        markStarted();
        // Ignores the signal on purpose, exactly as a third-party provider may.
        await held;
        return { cursor: 'moved-on', changes: [] };
      },
    } as unknown as Provider;

    // A cursor has to already exist, or the poll branch is skipped entirely.
    await snapshot.setPollCursor('mail', '/mail', 'start-here');

    const sync = new BackgroundSync({ host: hostFor([{ id: 'mail', path: '/mail', provider }]), snapshot });
    sync.start();
    await started;
    await sync.stop();

    release();
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(
      await snapshot.pollCursor('mail', '/mail'),
      'start-here',
      'a disowned worker advanced the cursor after shutdown',
    );
    assert.deepEqual(sync.status.errors, []);
    await snapshot.close();
  });
});
