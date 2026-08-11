/**
 * Engine tests.
 *
 * These target the places where the engine has to defend itself against a provider that is
 * wrong, slow, or lying — because in production every provider eventually is. The
 * conformance suite checks that providers hold up their end; this checks that the engine
 * survives when they don't.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vfs, type Mount } from '../vfs.js';
import { VfsError } from '../errors.js';
import { parseQuery, MATCH_ALL } from '../query.js';
import type { Capability, ListOptions, ListPage, Provider, VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// A tree-shaped test provider with knobs for each way a provider can misbehave
// ---------------------------------------------------------------------------

interface Item {
  readonly name: string;
  /** Defaults to the path. Set explicitly when two siblings share a name. */
  readonly id?: string;
  readonly title?: string;
  readonly body?: string;
  readonly flags?: readonly string[];
  readonly children?: readonly Item[];
}

/**
 * How the provider reports query push-down.
 *
 * - `none`     — no claim at all, the honest default for a backend with no server-side filter.
 * - `partial`  — the realistic case: the backend can filter part of the query (say `is:unread`)
 *                but not the rest, and says so.
 * - `full`     — the provider echoes the entire query back, which is a promise that it
 *                filtered completely.
 */
type Pushdown = 'none' | 'partial' | 'full';

interface StubOptions {
  readonly tree: readonly Item[];
  readonly capabilities?: readonly Capability[];
  /**
   * Report push-down without doing any filtering. Combined with `pushdown` this is how a
   * provider lies, which is the case the engine's honesty guard exists for.
   */
  readonly pushdown?: Pushdown;
  /** Return search hits with no path and no parentPath. */
  readonly amnesiacSearch?: boolean;
  /** Return search hits carrying only `parentPath`, as a well-behaved provider does. */
  readonly parentPathOnly?: boolean;
  /** Throw on every call after the first N. Used to test stale-cache fallback. */
  readonly failAfter?: number;
  readonly pageSize?: number;
}

class StubProvider implements Provider {
  readonly id = 'stub';
  readonly displayName = 'Stub';
  readonly capabilities: ReadonlySet<Capability>;

  listCalls = 0;
  searchCalls = 0;
  readonly #options: StubOptions;
  readonly #byId = new Map<string, { item: Item; parentPath: string }>();

  search?: NonNullable<Provider['search']>;

  constructor(options: StubOptions) {
    this.#options = options;
    this.capabilities = new Set<Capability>(options.capabilities ?? ['list', 'read', 'search']);
    if (this.capabilities.has('search')) {
      this.search = (parent, query, listOptions) => this.#search(parent, query, listOptions);
    }
    const index = (items: readonly Item[], parentPath: string): void => {
      for (const item of items) {
        this.#byId.set(item.id ?? `${parentPath}${item.name}`, { item, parentPath });
        if (item.children !== undefined) index(item.children, `${parentPath}${item.name}/`);
      }
    };
    index(options.tree, '');
  }

  #node(item: Item, parentPath: string): VNode {
    return {
      name: item.name,
      id: item.id ?? `${parentPath}${item.name}`,
      kind: item.children === undefined ? 'file' : 'dir',
      title: item.title ?? item.name,
      ...(item.flags === undefined ? {} : { flags: [...item.flags] }),
    };
  }

  #childrenOf(parent: VNode | null): { items: readonly Item[]; parentPath: string } {
    if (parent === null) return { items: this.#options.tree, parentPath: '' };
    const found = this.#byId.get(parent.id);
    if (found === undefined) return { items: [], parentPath: '' };
    return { items: found.item.children ?? [], parentPath: `${parent.id}/` };
  }

  list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    this.listCalls += 1;
    if (this.#options.failAfter !== undefined && this.listCalls > this.#options.failAfter) {
      return Promise.reject(new VfsError('ENETWORK', 'the network went away'));
    }
    const { items, parentPath } = this.#childrenOf(parent);
    const all = items.map((item) => this.#node(item, parentPath));
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.pageSize ?? 50, 500));
    const slice = all.slice(offset, offset + limit);
    const next = offset + slice.length;
    return Promise.resolve({
      entries: slice,
      total: all.length,
      ...(next < all.length ? { cursor: String(next) } : {}),
      ...this.#claim(options.query),
    });
  }

  /**
   * The push-down claim, made without doing any of the corresponding filtering.
   *
   * The entries returned are always unfiltered, so any test using this is asking: does the
   * engine's answer stay correct when the provider's claim is wrong?
   */
  #claim(query: unknown): { appliedQuery?: never } {
    const mode = this.#options.pushdown ?? 'none';
    if (mode === 'none' || query === undefined) return {};
    if (mode === 'full') return { appliedQuery: query as never };
    // A partial claim: "I filtered by is:unread, you deal with the rest."
    return { appliedQuery: parseQuery('is:unread') as never };
  }

  read(node: VNode): Promise<{ title: string; headers: readonly (readonly [string, string])[]; body: string; format: 'text' }> {
    const found = this.#byId.get(node.id);
    return Promise.resolve({
      title: node.title,
      headers: [['Id', node.id]] as const,
      body: found?.item.body ?? '',
      format: 'text' as const,
    });
  }

  #search(parent: VNode | null, _query: unknown, _options: ListOptions): Promise<ListPage> {
    this.searchCalls += 1;
    // Deliberately returns EVERYTHING under the root, ignoring the query. Combined with
    // `overclaimQuery` this is the exact shape of the bug the honesty guard exists for.
    const hits: VNode[] = [];
    const walk = (items: readonly Item[], parentPath: string): void => {
      for (const item of items) {
        const node = this.#node(item, parentPath);
        if (item.children === undefined) {
          hits.push(
            this.#options.amnesiacSearch
              ? node
              : this.#options.parentPathOnly
                ? { ...node, parentPath }
                : { ...node, parentPath, path: `/m/${parentPath}${item.name}` },
          );
        } else {
          walk(item.children, `${parentPath}${item.name}/`);
        }
      }
    };
    walk(this.#childrenOf(parent).items, parent === null ? '' : `${parent.id}/`);
    return Promise.resolve({
      entries: hits,
      total: hits.length,
      ...this.#claim(_query),
    });
  }
}

function mountStub(vfs: Vfs, options: StubOptions, path = '/m'): StubProvider {
  const provider = new StubProvider(options);
  const mount: Mount = { path, id: 'stub', provider };
  vfs.mount(mount);
  return provider;
}

const TREE: readonly Item[] = [
  {
    name: 'Inbox',
    children: [
      { name: 'budget.eml', title: 'Budget review', body: 'quarterly numbers', flags: ['unread'] },
      { name: 'lunch.eml', title: 'Lunch?', body: 'sandwiches' },
    ],
  },
  {
    name: 'Archive',
    children: [
      { name: 'budget.eml', title: 'Budget review (old)', body: 'last year numbers' },
      { name: 'deep', children: [{ name: 'buried.eml', title: 'Buried', body: 'way down here' }] },
    ],
  },
];

// ---------------------------------------------------------------------------

describe('Vfs: mounting', () => {
  it('refuses to mount at the root', () => {
    const vfs = new Vfs();
    assert.throws(
      () => vfs.mount({ path: '/', id: 'x', provider: new StubProvider({ tree: [] }) }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('refuses two providers at the same path', () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: [] });
    assert.throws(
      () => mountStub(vfs, { tree: [] }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('lists mounts as directories at the synthetic root', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE }, '/mail');
    mountStub(vfs, { tree: TREE }, '/chat');
    const result = await vfs.list('/');
    assert.deepEqual(
      result.entries.map((entry) => entry.name).sort(),
      ['chat', 'mail'],
    );
    assert.ok(result.entries.every((entry) => entry.kind === 'dir'));
  });

  it('synthesizes intermediate directories for a nested mount', async () => {
    // Mounting at /work/mail must make /work listable, or the user cannot navigate to it.
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE }, '/work/mail');
    const result = await vfs.list('/work');
    assert.deepEqual(result.entries.map((entry) => entry.name), ['mail']);
  });
});

describe('Vfs: listing', () => {
  it('resolves a nested path through several providers', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.list('/m/Archive/deep');
    assert.deepEqual(result.entries.map((entry) => entry.name), ['buried.eml']);
  });

  it('accepts a VNode as a target and reaches the same place as its path', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const listing = await vfs.list('/m');
    const inbox = listing.entries.find((entry) => entry.name === 'Inbox');
    assert.ok(inbox !== undefined);

    const byNode = await vfs.list(inbox);
    const byPath = await vfs.list('/m/Inbox');
    assert.deepEqual(
      byNode.entries.map((entry) => entry.id),
      byPath.entries.map((entry) => entry.id),
    );
  });

  it('serves a directory from cache instead of asking twice', async () => {
    const vfs = new Vfs();
    const provider = mountStub(vfs, { tree: TREE });
    await vfs.list('/m');
    const calls = provider.listCalls;
    await vfs.list('/m');
    assert.equal(provider.listCalls, calls, 'a cached listing must not hit the provider again');
  });

  it('refetches when refresh is requested', async () => {
    const vfs = new Vfs();
    const provider = mountStub(vfs, { tree: TREE });
    await vfs.list('/m');
    const calls = provider.listCalls;
    await vfs.list('/m', { refresh: true });
    assert.ok(provider.listCalls > calls, 'refresh must bypass the cache');
  });

  it('errors on a path that does not exist', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    await assert.rejects(
      () => vfs.list('/m/Nope'),
      (error: unknown) => error instanceof VfsError && error.code === 'ENOENT',
    );
  });

  it('refuses to list a file', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    await assert.rejects(
      () => vfs.list('/m/Inbox/budget.eml'),
      (error: unknown) => error instanceof VfsError && error.code === 'ENOTDIR',
    );
  });

  it('gives colliding names stable, distinct display names', async () => {
    const vfs = new Vfs();
    mountStub(vfs, {
      tree: [
        {
          name: 'Inbox',
          children: [
            { name: 'budget.eml', id: 'msg-a', title: 'A' },
            { name: 'budget.eml', id: 'msg-b', title: 'B' },
          ],
        },
      ],
    });
    const first = await vfs.list('/m/Inbox');
    const names = first.entries.map((entry) => entry.name);
    assert.equal(new Set(names).size, 2, 'two items must not share a name');

    const second = await vfs.list('/m/Inbox', { refresh: true });
    assert.deepEqual(
      second.entries.map((entry) => entry.name),
      names,
      'a name, once shown, must mean the same item on the next listing',
    );
  });
});

describe('Vfs: query push-down honesty', () => {
  it('re-applies the query locally when the provider does not claim push-down', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.list('/m/Inbox', { query: parseQuery('is:unread') });
    assert.deepEqual(result.entries.map((entry) => entry.title), ['Budget review']);
  });

  it('still filters when the provider claims only partial push-down', async () => {
    // The realistic case: Graph can filter `isRead` server-side but not a free-text term,
    // so it reports `appliedQuery: is:unread`. If the engine took that as "job done", the
    // user's `budget` term would be silently dropped and they would see the whole folder.
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE, pushdown: 'partial' });
    const result = await vfs.list('/m/Inbox', { query: parseQuery('is:unread budget') });
    assert.deepEqual(result.entries.map((entry) => entry.title), ['Budget review']);
  });

  it('re-applies everything when the claimed query differs from the requested one at all', async () => {
    // Not a subset, not a superset — just different. Anything other than an exact match
    // has to mean "assume nothing was applied".
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE, pushdown: 'partial' });
    const result = await vfs.list('/m/Inbox', { query: parseQuery('name:lunch.eml') });
    assert.deepEqual(result.entries.map((entry) => entry.title), ['Lunch?']);
  });

  it('trusts an exactly-echoed appliedQuery, which is the documented trust boundary', async () => {
    // This is a deliberate limit, pinned here so it can never become an accident.
    //
    // `appliedQuery` is a promise. Echoing the query back means "I applied all of it", and
    // the engine takes that at face value — re-filtering regardless would make push-down
    // pointless, and push-down is what makes a 200,000-message mailbox usable.
    //
    // A provider that echoes without filtering is therefore broken, not merely imprecise.
    // That is caught on the provider side by the conformance suite's "never claims to have
    // applied a query it was not given" check, which is where it belongs.
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE, pushdown: 'full' });
    const result = await vfs.list('/m/Inbox', { query: parseQuery('is:unread') });
    assert.equal(result.entries.length, 2, 'the engine passes through what a full claim returned');
  });

  it('reports how many entries the query could not decide without bodies', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.list('/m/Inbox', { query: parseQuery('body:sandwiches') });
    assert.ok(result.undecided > 0, 'a body query on unfetched items must be reported as undecided');
  });
});

describe('Vfs: search', () => {
  it('gives every hit a path that can be used with the other commands', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.search('/m', parseQuery('budget'));
    assert.ok(result.entries.length >= 2);
    for (const entry of result.entries) {
      assert.ok(entry.path !== undefined, 'every search hit needs a path');
      // The real regression: `stat` on a hit used to fail with ENOENT because the engine
      // assumed every hit lived directly under the search root.
      const stat = await vfs.stat(entry.path);
      assert.equal(stat.id, entry.id);
    }
  });

  it('reconstructs a nested path from parentPath alone', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE, parentPathOnly: true });
    const result = await vfs.search('/m', parseQuery('buried'));
    const hit = result.entries.find((entry) => entry.title === 'Buried');
    assert.ok(hit !== undefined);
    assert.equal(hit.path, '/m/Archive/deep/buried.eml');
  });

  it('names hits by their path relative to the search root, so duplicates are distinguishable', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.search('/m', parseQuery('budget'));
    const names = result.entries.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, 'two hits must not share a display name');
    assert.ok(
      names.some((name) => name.includes('/')),
      'a hit from a subfolder should say which subfolder it came from',
    );
  });

  it('filters provider search results when push-down was not claimed', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.search('/m', parseQuery('name:lunch.eml'));
    assert.deepEqual(result.entries.map((entry) => entry.title), ['Lunch?']);
  });

  it('falls back to walking the tree when the provider cannot search', async () => {
    const vfs = new Vfs();
    const provider = mountStub(vfs, { tree: TREE, capabilities: ['list', 'read'] });
    const result = await vfs.search('/m', parseQuery('name:buried.eml'));
    assert.equal(provider.searchCalls, 0);
    assert.deepEqual(result.entries.map((entry) => entry.title), ['Buried']);
    assert.equal(result.entries[0]?.path, '/m/Archive/deep/buried.eml');
  });

  it('searches across every mount from the synthetic root', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE }, '/mail');
    mountStub(vfs, { tree: [{ name: 'General', children: [{ name: 'budget.md', title: 'Budget chat' }] }] }, '/chat');
    const result = await vfs.search('/', parseQuery('budget'));
    const roots = new Set(result.entries.map((entry) => entry.path?.split('/')[1]));
    assert.deepEqual([...roots].sort(), ['chat', 'mail']);
  });

  it('accepts match-all as "list everything below here"', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const result = await vfs.search('/m', MATCH_ALL);
    assert.ok(result.entries.length >= 4);
  });
});

describe('Vfs: reading', () => {
  it('reads a file and caches the document', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    const doc = await vfs.read('/m/Inbox/budget.eml');
    assert.equal(doc.title, 'Budget review');
    assert.match(doc.body, /quarterly/);
  });

  it('refuses to read a directory', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE });
    await assert.rejects(
      () => vfs.read('/m/Inbox'),
      (error: unknown) => error instanceof VfsError && error.code === 'EISDIR',
    );
  });

  it('reports unsupported rather than crashing when a provider cannot read', async () => {
    const vfs = new Vfs();
    mountStub(vfs, { tree: TREE, capabilities: ['list'] });
    await assert.rejects(
      () => vfs.read('/m/Inbox/budget.eml'),
      (error: unknown) => error instanceof VfsError && error.code === 'ENOTSUP',
    );
  });
});

describe('Vfs: degradation', () => {
  it('serves an expired listing rather than an error when the provider goes away', async () => {
    // On a plane, on hotel wifi, or the day the API changes: a stale answer with a
    // visible marker beats a wall of errors.
    let clock = 1_000;
    const vfs = new Vfs({ ttlMs: 50, now: () => clock });
    mountStub(vfs, { tree: TREE, failAfter: 1 });

    const fresh = await vfs.list('/m');
    assert.equal(fresh.stale, false);

    clock += 10_000;
    const stale = await vfs.list('/m');
    assert.equal(stale.stale, true, 'the result must announce that it is stale');
    assert.ok((stale.staleAgeMs ?? 0) > 0, 'and say how stale, so the user can judge');
    assert.deepEqual(
      stale.entries.map((entry) => entry.name),
      fresh.entries.map((entry) => entry.name),
    );
  });

  it('surfaces the error when stale serving is switched off', async () => {
    let clock = 1_000;
    const vfs = new Vfs({ ttlMs: 50, now: () => clock, serveStaleOnError: false });
    mountStub(vfs, { tree: TREE, failAfter: 1 });
    await vfs.list('/m');
    clock += 10_000;
    await assert.rejects(() => vfs.list('/m'), (error: unknown) => error instanceof VfsError);
  });
});
