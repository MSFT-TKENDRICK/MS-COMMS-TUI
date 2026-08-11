/**
 * The mapping surface: the pluggable path from an integration to a VFS structure.
 *
 * The bet this module makes is that a developer should describe their data — what a record
 * is, what identifies it, what it is called, what it connects to — and get a conforming
 * provider AND a graph out of it, rather than implementing the provider contract by hand
 * and getting the graph never. So the tests here check two things above all:
 *
 *   1. The synthesized provider passes the same conformance suite a hand-written one does.
 *      A mapping that produces a second-class mount would defeat the point.
 *   2. The tree and the graph agree. They are generated from one declaration precisely so
 *      they cannot drift, and a projection that disagrees with `ls` about what exists is
 *      worse than no projection at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MappedProvider, defineMapping } from '../mapping.js';
import { isVfsError } from '../errors.js';
import { MemoryStateStore, NULL_LOGGER } from '../logging.js';
import { parseQuery } from '../query.js';
import { conformanceTests } from '../testing/conformance.js';
import type { ProviderContext } from '../provider.js';

// ---------------------------------------------------------------------------
// A small integration, described the way a plugin author would describe it
// ---------------------------------------------------------------------------

interface Issue {
  readonly id: string;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly assignee: string;
  readonly labels: readonly string[];
  readonly updated: string;
}

interface Comment {
  readonly id: string;
  readonly issue: string;
  readonly author: string;
  readonly body: string;
}

const ISSUES: readonly Issue[] = [
  {
    id: '12',
    title: 'Crash on startup',
    state: 'open',
    assignee: 'alice',
    labels: ['bug', 'p1'],
    updated: '2026-02-03T10:00:00Z',
  },
  {
    id: '13',
    title: 'Add dark mode',
    state: 'open',
    assignee: 'bob',
    labels: ['feature'],
    updated: '2026-02-01T10:00:00Z',
  },
  {
    id: '9',
    title: 'Typo in README',
    state: 'closed',
    assignee: 'alice',
    labels: [],
    updated: '2026-01-10T10:00:00Z',
  },
];

const COMMENTS: readonly Comment[] = [
  { id: 'c1', issue: '12', author: 'bob', body: 'Reproduced on Windows.' },
  { id: 'c2', issue: '12', author: 'alice', body: 'Fix on the way.' },
];

function context(mountPath = '/issues'): ProviderContext {
  return {
    mountPath,
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '',
    secret: () => Promise.resolve(undefined),
  };
}

function tracker(overrides: { rootMode?: 'auto' | 'folders' | 'flat' } = {}): MappedProvider {
  return new MappedProvider(
    'tracker',
    {
      displayName: 'Tracker',
      ...(overrides.rootMode === undefined ? {} : { rootMode: overrides.rootMode }),
      types: [
        {
          name: 'Issue',
          key: (i: Issue) => i.id,
          title: (i: Issue) => i.title,
          extension: '.md',
          mtime: (i: Issue) => new Date(i.updated),
          author: (i: Issue) => i.assignee,
          flags: (i: Issue) => (i.state === 'open' ? ['unread'] : []),
          fields: [
            { name: 'state', type: 'String', value: (i: Issue) => i.state },
            { name: 'assignee', type: 'String', value: (i: Issue) => i.assignee },
            { name: 'labels', type: 'String', list: true, value: (i: Issue) => [...i.labels] },
          ],
          edges: [
            {
              name: 'comments',
              target: 'Comment',
              list: true,
              resolve: (i: Issue) => COMMENTS.filter((c) => c.issue === i.id),
            },
          ],
          childEdge: 'comments',
          read: (i: Issue) => ({
            title: i.title,
            headers: [['State', i.state] as const],
            body: `#${i.id}`,
            format: 'markdown' as const,
          }),
          lookup: (key: string) => ISSUES.find((i) => i.id === key),
        },
        {
          name: 'Comment',
          key: (c: Comment) => c.id,
          title: (c: Comment) => c.body,
          extension: '.md',
          author: (c: Comment) => c.author,
          read: (c: Comment) => ({
            title: c.body,
            headers: [],
            body: c.body,
            format: 'text' as const,
          }),
          lookup: (key: string) => COMMENTS.find((c) => c.id === key),
        },
      ],
      roots: [{ name: 'issues', type: 'Issue', universal: true, resolve: () => ISSUES }],
    },
    context(),
  );
}

// ---------------------------------------------------------------------------

describe('MappedProvider: validation at construction', () => {
  it('rejects a root pointing at a type that does not exist, naming the types that do', () => {
    assert.throws(
      () =>
        new MappedProvider(
          'x',
          {
            types: [{ name: 'Issue', key: (i: Issue) => i.id, title: (i: Issue) => i.title }],
            roots: [{ name: 'r', type: 'Ticket', resolve: () => [] }],
          },
          context(),
        ),
      (error: unknown) => isVfsError(error) && /Issue/.test(error.hint ?? ''),
    );
  });

  it('rejects an edge pointing at a type that does not exist', () => {
    assert.throws(
      () =>
        new MappedProvider(
          'x',
          {
            types: [
              {
                name: 'Issue',
                key: (i: Issue) => i.id,
                title: (i: Issue) => i.title,
                edges: [{ name: 'comments', target: 'Comment', resolve: () => [] }],
              },
            ],
            roots: [{ name: 'r', type: 'Issue', resolve: () => [] }],
          },
          context(),
        ),
      isVfsError,
    );
  });

  it('rejects a childEdge that is not one of the type’s edges', () => {
    assert.throws(
      () =>
        new MappedProvider(
          'x',
          {
            types: [
              { name: 'Issue', key: (i: Issue) => i.id, title: (i: Issue) => i.title, childEdge: 'nope' },
            ],
            roots: [{ name: 'r', type: 'Issue', resolve: () => [] }],
          },
          context(),
        ),
      isVfsError,
    );
  });

  it('rejects a duplicate type name rather than silently keeping one', () => {
    assert.throws(
      () =>
        new MappedProvider(
          'x',
          {
            types: [
              { name: 'Issue', key: (i: Issue) => i.id, title: (i: Issue) => i.title },
              { name: 'Issue', key: (i: Issue) => i.id, title: (i: Issue) => i.title },
            ],
            roots: [{ name: 'r', type: 'Issue', resolve: () => [] }],
          },
          context(),
        ),
      isVfsError,
    );
  });
});

describe('MappedProvider: capabilities', () => {
  it('declares only what the mapping actually supports', () => {
    const provider = tracker();
    assert.ok(provider.capabilities.has('list'));
    assert.ok(provider.capabilities.has('read'));
    assert.ok(provider.capabilities.has('graph'));
    assert.ok(!provider.capabilities.has('actions'));
  });

  it('installs no method for a capability it does not declare', () => {
    // The engine probes with `typeof provider.actions === 'function'`, so a method left on
    // the prototype would advertise support the mapping never promised.
    const provider = tracker();
    assert.equal(typeof provider.actions, 'undefined');
    assert.equal(typeof provider.invoke, 'undefined');
  });

  it('drops read when no type can be read', () => {
    const provider = new MappedProvider(
      'x',
      {
        types: [{ name: 'Issue', key: (i: Issue) => i.id, title: (i: Issue) => i.title }],
        roots: [{ name: 'issues', type: 'Issue', resolve: () => ISSUES }],
      },
      context(),
    );
    assert.ok(!provider.capabilities.has('read'));
    assert.equal(typeof provider.read, 'undefined');
  });

  it('installs the method for a capability it does declare', () => {
    const provider = tracker();
    assert.equal(typeof provider.read, 'function');
  });
});

describe('MappedProvider: the tree view', () => {
  it('puts a single root’s records at the mount, without a pointless folder', async () => {
    const page = await tracker().list(null, {});
    assert.deepEqual(
      page.entries.map((entry) => entry.title),
      ['Crash on startup', 'Add dark mode', 'Typo in README'],
    );
  });

  it('gives each root a folder when asked, for a mapping with more than one', async () => {
    const page = await tracker({ rootMode: 'folders' }).list(null, {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['issues'],
    );
    assert.equal(page.entries[0]?.kind, 'dir');
  });

  it('names entries from the title, sanitized, with the declared extension', async () => {
    const page = await tracker().list(null, {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['Crash on startup.md', 'Add dark mode.md', 'Typo in README.md'],
    );
  });

  it('carries the metadata the shell renders: author, mtime, flags', async () => {
    const [first] = (await tracker().list(null, {})).entries;
    assert.equal(first?.author, 'alice');
    assert.equal(first?.mtime?.toISOString(), '2026-02-03T10:00:00.000Z');
    assert.deepEqual(first?.flags, ['unread']);
  });

  it('follows childEdge for `ls`, so an issue contains its comments', async () => {
    const provider = tracker();
    const [issue] = (await provider.list(null, {})).entries;
    assert.ok(issue !== undefined);
    const page = await provider.list(issue, {});
    assert.deepEqual(
      page.entries.map((entry) => entry.author),
      ['bob', 'alice'],
    );
  });

  it('treats a type with no childEdge as a leaf, not as an error', async () => {
    const provider = tracker();
    const [issue] = (await provider.list(null, {})).entries;
    assert.ok(issue !== undefined);
    const [comment] = (await provider.list(issue, {})).entries;
    assert.ok(comment !== undefined);
    assert.deepEqual((await provider.list(comment, {})).entries, []);
  });

  it('reads a record through the type that produced it', async () => {
    const provider = tracker();
    const [issue] = (await provider.list(null, {})).entries;
    assert.ok(issue !== undefined);
    assert.ok(provider.read !== undefined);
    const document = await provider.read(issue, {});
    assert.equal(document.title, 'Crash on startup');
    assert.equal(document.format, 'markdown');
  });

  it('searches recursively and re-filters honestly, claiming no push-down', async () => {
    const page = await tracker().search(null, parseQuery('dark'), {});
    assert.deepEqual(
      page.entries.map((entry) => entry.title),
      ['Add dark mode'],
    );
    // Not claiming push-down is what makes the engine re-check the result.
    assert.equal(page.appliedQuery, undefined);
  });

  it('finds a record again from a cold cache, via lookup', async () => {
    // A projection can resolve a deep path without having walked there first, so a type
    // that can be re-fetched must be.
    const fresh = tracker();
    assert.ok(fresh.read !== undefined);
    const document = await fresh.read(
      { name: 'Crash on startup.md', id: 'Issue:12', kind: 'file', title: 'Crash on startup' },
      {},
    );
    assert.equal(document.title, 'Crash on startup');
  });
});

describe('MappedProvider: the graph view', () => {
  it('describes the same types the tree is built from', async () => {
    const schema = await tracker().graph.schema();
    assert.deepEqual(
      schema.types.map((type) => type.name),
      ['Issue', 'Comment'],
    );
    const issue = schema.types[0];
    assert.equal(issue?.childEdge, 'comments');
    assert.deepEqual(
      issue?.edges.map((edge) => edge.name),
      ['comments'],
    );
  });

  it('exposes declared fields alongside the built-in ones', async () => {
    const schema = await tracker().graph.schema();
    const names = schema.types[0]?.fields.map((field) => field.name) ?? [];
    for (const expected of ['state', 'assignee', 'labels', 'name', 'title', 'mtime']) {
      assert.ok(names.includes(expected), `expected the schema to expose ${expected}`);
    }
  });

  it('marks the universal root, which is what cross-source queries fan out to', async () => {
    const schema = await tracker().graph.schema();
    assert.ok(schema.roots.some((root) => root.name === 'issues' && root.universal === true));
  });

  it('yields nodes whose fields are readable by a projection', async () => {
    const nodes = await tracker().graph.roots('issues', {});
    assert.equal(nodes.length, 3);
    assert.equal(nodes[0]?.fields['state'], 'open');
    assert.deepEqual(nodes[0]?.fields['labels'], ['bug', 'p1']);
    assert.equal(nodes[0]?.type, 'Issue');
    assert.equal(nodes[0]?.key, '12');
  });

  it('gives every node a path, so a projection entry can point back at the original', async () => {
    const nodes = await tracker().graph.roots('issues', {});
    assert.equal(nodes[0]?.node.path, '/issues/Crash on startup.md');
  });

  it('follows a named edge', async () => {
    const graph = tracker().graph;
    const [issue] = await graph.roots('issues', {});
    assert.ok(issue !== undefined);
    const comments = await graph.neighbors(issue, 'comments', {});
    assert.deepEqual(
      comments.map((node) => node.key),
      ['c1', 'c2'],
    );
  });

  it('honours a limit rather than fetching everything', async () => {
    assert.equal((await tracker().graph.roots('issues', { limit: 2 })).length, 2);
  });

  it('agrees with the tree about what exists', async () => {
    // The whole reason both views come from one declaration.
    const provider = tracker();
    const listed = (await provider.list(null, {})).entries.map((entry) => entry.name);
    const projected = (await provider.graph.roots('issues', {})).map((node) => node.node.name);
    assert.deepEqual(projected, listed);
  });

  it('re-fetches a node by identity, for a projection resolving a path from cold', async () => {
    const node = await tracker().graph.node?.('Issue', '12');
    assert.equal(node?.node.title, 'Crash on startup');
  });

  it('reports an unknown root and an unknown edge rather than returning nothing', async () => {
    const graph = tracker().graph;
    await assert.rejects(() => graph.roots('nonsense', {}), isVfsError);
    const [issue] = await graph.roots('issues', {});
    assert.ok(issue !== undefined);
    await assert.rejects(() => graph.neighbors(issue, 'nonsense', {}), isVfsError);
  });
});

describe('defineMapping', () => {
  it('produces an ordinary plugin, so a mapped source is mounted like any other', async () => {
    const plugin = defineMapping<{ token?: string }>({
      type: 'tracker',
      displayName: 'Tracker',
      description: 'A tiny issue tracker.',
      setup: () => ({
        types: [
          {
            name: 'Issue',
            key: (i: Issue) => i.id,
            title: (i: Issue) => i.title,
            extension: '.md',
            read: (i: Issue) => ({ title: i.title, headers: [], body: i.title, format: 'text' as const }),
          },
        ],
        roots: [{ name: 'issues', type: 'Issue', resolve: () => ISSUES }],
      }),
    });

    assert.equal(plugin.type, 'tracker');
    assert.equal(plugin.description, 'A tiny issue tracker.');

    const provider = await plugin.create({}, context());
    assert.equal(provider.displayName, 'Tracker');
    assert.equal((await provider.list(null, {})).entries.length, 3);
  });

  it('passes validateOptions through, so config errors surface at load', () => {
    const plugin = defineMapping<{ repo: string }>({
      type: 'tracker',
      displayName: 'Tracker',
      validateOptions: (raw) => {
        const repo = (raw as { repo?: unknown } | undefined)?.repo;
        if (typeof repo !== 'string') throw new Error('repo is required');
        return { repo };
      },
      setup: () => ({ types: [], roots: [] }),
    });
    assert.throws(() => plugin.validateOptions?.({}));
    assert.deepEqual(plugin.validateOptions?.({ repo: 'a/b' }), { repo: 'a/b' });
  });

  it('runs the mapping’s dispose when the mount goes away', async () => {
    let disposed = false;
    const plugin = defineMapping({
      type: 'tracker',
      displayName: 'Tracker',
      setup: () => ({
        types: [{ name: 'Issue', key: (i: Issue) => i.id, title: (i: Issue) => i.title }],
        roots: [{ name: 'issues', type: 'Issue', resolve: () => ISSUES }],
        dispose: () => {
          disposed = true;
        },
      }),
    });
    const provider = await plugin.create({}, context());
    await provider.dispose?.();
    assert.ok(disposed);
  });
});

// A mapped provider is only worth having if it is indistinguishable from a hand-written
// one at the point of use, so it takes the same exam.
describe('conformance: mapped provider', () => {
  for (const testCase of conformanceTests({ create: () => tracker(), offlineOnly: true })) {
    it(testCase.name, () => testCase.run());
  }
});
