/**
 * The graph view of the mount table.
 *
 * The claim these tests defend is the one the whole projection feature rests on: every
 * mount is projectable, whether or not its author ever thought about graphs. A provider
 * that declares nothing still yields typed nodes with `children`, `descendants` and
 * `parent`, because those edges are already implied by any tree. A provider that declares
 * its own graph gets used verbatim.
 *
 * If that stops being true, projections silently lose a source — a projection over "all
 * sources" that quietly omits one is indistinguishable from a source with nothing in it,
 * which is the failure mode this codebase treats as the worst available.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BUILTIN_NODE_FIELDS,
  GraphSpace,
  graphFieldText,
  graphFieldValue,
  isBuiltinNodeField,
  safeGraphName,
  treeGraphSource,
  type GraphNode,
  type GraphSelection,
  type GraphSource,
} from '../graph.js';
import { Vfs } from '../vfs.js';
import type { Capability, ListOptions, ListPage, Provider, VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Item {
  readonly name: string;
  readonly title?: string;
  readonly author?: string;
  readonly flags?: readonly string[];
  readonly children?: readonly Item[];
}

const TREE: readonly Item[] = [
  {
    name: 'Inbox',
    children: [
      { name: 'budget.eml', title: 'Budget review', author: 'alice', flags: ['unread'] },
      { name: 'lunch.eml', title: 'Lunch?', author: 'bob' },
    ],
  },
  {
    name: 'Archive',
    children: [{ name: 'old.eml', title: 'Old thread', author: 'alice' }],
  },
];

class TreeProvider implements Provider {
  readonly id: string;
  readonly displayName = 'Tree';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read']);
  readonly #byId = new Map<string, Item>();

  constructor(id: string, private readonly tree: readonly Item[]) {
    this.id = id;
    const index = (items: readonly Item[], prefix: string): void => {
      for (const item of items) {
        this.#byId.set(`${prefix}${item.name}`, item);
        if (item.children !== undefined) index(item.children, `${prefix}${item.name}/`);
      }
    };
    index(tree, '');
  }

  list(parent: VNode | null, _options: ListOptions): Promise<ListPage> {
    const prefix = parent === null ? '' : `${parent.id}/`;
    const items = parent === null ? this.tree : (this.#byId.get(parent.id)?.children ?? []);
    return Promise.resolve({
      entries: items.map((item) => ({
        name: item.name,
        id: `${prefix}${item.name}`,
        kind: item.children === undefined ? ('file' as const) : ('dir' as const),
        title: item.title ?? item.name,
        ...(item.author === undefined ? {} : { author: item.author }),
        ...(item.flags === undefined ? {} : { flags: [...item.flags] }),
      })),
      total: items.length,
    });
  }

  read(node: VNode): Promise<{ title: string; headers: readonly (readonly [string, string])[]; body: string; format: 'text' }> {
    return Promise.resolve({ title: node.title, headers: [], body: '', format: 'text' as const });
  }
}

function mounted(): Vfs {
  const vfs = new Vfs();
  vfs.mount({ path: '/mail', id: 'mail', provider: new TreeProvider('mail', TREE) });
  return vfs;
}

const EMPTY_SELECTION: GraphSelection = {};

// ---------------------------------------------------------------------------

describe('graphFieldValue', () => {
  const node: GraphNode = {
    source: 'mail',
    type: 'Message',
    key: 'm1',
    node: {
      name: 'budget.eml',
      id: 'm1',
      kind: 'file',
      title: 'Budget review',
      author: 'alice',
      flags: ['unread'],
      meta: { project: 'atlas' },
    },
    fields: { status: 'open' },
  };

  it('reads the built-in fields every node has, whatever its type', () => {
    assert.equal(graphFieldValue(node, 'name'), 'budget.eml');
    assert.equal(graphFieldValue(node, 'title'), 'Budget review');
    assert.equal(graphFieldValue(node, 'author'), 'alice');
    assert.equal(graphFieldValue(node, 'source'), 'mail');
    assert.deepEqual(graphFieldValue(node, 'flags'), ['unread']);
  });

  it('reads provider-declared fields', () => {
    assert.equal(graphFieldValue(node, 'status'), 'open');
  });

  it('falls back to meta, so a provider gets fields without declaring them twice', () => {
    assert.equal(graphFieldValue(node, 'project'), 'atlas');
    assert.equal(graphFieldValue(node, 'meta_project'), 'atlas');
  });

  it('never lets meta shadow a built-in', () => {
    const shadowing: GraphNode = {
      ...node,
      node: { ...node.node, meta: { name: 'not-this-one' } },
      fields: {},
    };
    assert.equal(graphFieldValue(shadowing, 'name'), 'budget.eml');
  });

  it('returns undefined for a field nothing supplies', () => {
    assert.equal(graphFieldValue(node, 'nonsense'), undefined);
  });

  it('knows which names are built in', () => {
    for (const field of BUILTIN_NODE_FIELDS) assert.ok(isBuiltinNodeField(field.name));
    assert.ok(!isBuiltinNodeField('status'));
  });
});

describe('graphFieldText', () => {
  it('renders each value kind as something a filename can contain', () => {
    assert.equal(graphFieldText('alice'), 'alice');
    assert.equal(graphFieldText(3), '3');
    assert.equal(graphFieldText(true), 'true');
    assert.equal(graphFieldText(undefined), '');
    assert.equal(graphFieldText(null), '');
    assert.equal(graphFieldText(['a', 'b']), 'a, b');
    assert.match(graphFieldText(new Date('2026-02-03T04:05:06Z')), /^2026-02-03/);
  });
});

describe('treeGraphSource', () => {
  it('exposes the graph a tree already implies, with no help from the provider', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const schema = await source.schema();
    const type = schema.types[0];
    assert.equal(type?.name, 'Entry');
    assert.deepEqual(
      type?.edges.map((edge) => edge.name),
      ['children', 'descendants', 'parent'],
    );
    assert.equal(type?.childEdge, 'children');
  });

  it('offers a universal root, which is what cross-source queries fan out to', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const schema = await source.schema();
    assert.ok(schema.roots.some((root) => root.universal === true));
  });

  it('lists the top-level entries of the mount', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const nodes = await source.roots('entries', EMPTY_SELECTION);
    assert.deepEqual(
      nodes.map((n) => n.node.name),
      ['Inbox', 'Archive'],
    );
    assert.deepEqual(
      nodes.map((n) => n.node.path),
      ['/mail/Inbox', '/mail/Archive'],
    );
  });

  it('walks the whole mount for the universal root, folders included', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const names = (await source.roots('all', EMPTY_SELECTION)).map((n) => n.node.name);
    assert.deepEqual(new Set(names), new Set(['Inbox', 'Archive', 'budget.eml', 'lunch.eml', 'old.eml']));
  });

  it('offers a files-only root, because "every message" is the common request', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const nodes = await source.roots('files', EMPTY_SELECTION);
    assert.ok(nodes.every((n) => n.node.kind === 'file'));
    assert.equal(nodes.length, 3);
  });

  it('honours a selection limit rather than walking the whole tree', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    assert.equal((await source.roots('all', { limit: 2 })).length, 2);
  });

  it('follows children and parent, which is the tree read as a graph', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const [inbox] = await source.roots('entries', EMPTY_SELECTION);
    assert.ok(inbox !== undefined);

    const children = await source.neighbors(inbox, 'children', EMPTY_SELECTION);
    assert.deepEqual(
      children.map((n) => n.node.name),
      ['budget.eml', 'lunch.eml'],
    );

    const first = children[0];
    assert.ok(first !== undefined);
    const parents = await source.neighbors(first, 'parent', EMPTY_SELECTION);
    assert.equal(parents[0]?.node.name, 'Inbox');
  });

  it('reports an unknown edge instead of returning nothing', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    const [inbox] = await source.roots('entries', EMPTY_SELECTION);
    assert.ok(inbox !== undefined);
    await assert.rejects(() => source.neighbors(inbox, 'siblings', EMPTY_SELECTION));
  });

  it('reports an unknown root instead of returning nothing', async () => {
    const source = treeGraphSource(mounted(), { id: 'mail', path: '/mail' });
    await assert.rejects(() => source.roots('nonsense', EMPTY_SELECTION));
  });

  it('survives a folder that cannot be listed, rather than emptying the projection', async () => {
    const vfs = mounted();
    const broken: Provider = {
      id: 'broken',
      displayName: 'Broken',
      capabilities: new Set<Capability>(['list']),
      list: (parent) =>
        parent === null
          ? Promise.resolve({ entries: [{ name: 'Folder', id: 'f', kind: 'dir' as const, title: 'Folder' }] })
          : Promise.reject(new Error('the network went away')),
    };
    vfs.mount({ path: '/flaky', id: 'flaky', provider: broken });
    const source = treeGraphSource(vfs, { id: 'flaky', path: '/flaky' });
    const nodes = await source.roots('all', EMPTY_SELECTION);
    assert.deepEqual(
      nodes.map((n) => n.node.name),
      ['Folder'],
    );
  });
});

describe('safeGraphName', () => {
  it('rewrites anything GraphQL cannot spell', () => {
    assert.equal(safeGraphName('my-mail'), 'my_mail');
    assert.equal(safeGraphName('work mail'), 'work_mail');
    assert.equal(safeGraphName('2fa'), '_2fa');
    assert.equal(safeGraphName('ok_name9'), 'ok_name9');
  });
});

describe('GraphSpace', () => {
  const fake = (id: string): GraphSource => ({
    id,
    displayName: id,
    schema: () => ({ types: [], roots: [] }),
    roots: () => Promise.resolve([]),
    neighbors: () => Promise.resolve([]),
  });

  it('renames colliding aliases instead of dropping a source', () => {
    // Two mounts whose ids sanitize to the same GraphQL name is a real config: `my-mail`
    // and `my mail`. Losing one of them silently is exactly the bug to avoid.
    const space = new GraphSpace([
      { alias: 'my-mail', mountId: 'my-mail', mountPath: '/a', source: fake('a') },
      { alias: 'my mail', mountId: 'my mail', mountPath: '/b', source: fake('b') },
    ]);
    assert.deepEqual(
      space.entries.map((entry) => entry.alias),
      ['my_mail', 'my_mail_2'],
    );
  });

  it('finds a source by alias or by mount id', () => {
    const space = new GraphSpace([
      { alias: 'my-mail', mountId: 'my-mail', mountPath: '/a', source: fake('a') },
    ]);
    assert.ok(space.find('my_mail') !== undefined);
    assert.ok(space.find('my-mail') !== undefined);
    assert.equal(space.find('nope'), undefined);
  });

  it('excludes a subtree, which is what stops a projection recursing into itself', () => {
    const space = new GraphSpace([
      { alias: 'mail', mountId: 'mail', mountPath: '/mail', source: fake('mail') },
      { alias: 'byperson', mountId: 'byperson', mountPath: '/by-person', source: fake('p') },
    ]);
    assert.deepEqual(
      space.without('/by-person').entries.map((entry) => entry.alias),
      ['mail'],
    );
  });

  it('narrows to one source', () => {
    const space = new GraphSpace([
      { alias: 'mail', mountId: 'mail', mountPath: '/mail', source: fake('mail') },
      { alias: 'chat', mountId: 'chat', mountPath: '/chat', source: fake('chat') },
    ]);
    assert.equal(space.only('chat').entries.length, 1);
    assert.equal(space.only('nope').entries.length, 0);
    assert.ok(space.only('nope').isEmpty);
  });
});

describe('Vfs.graphSpace', () => {
  it('includes a provider that never heard of graphs', async () => {
    const space = mounted().graphSpace();
    assert.deepEqual(
      space.entries.map((entry) => entry.alias),
      ['mail'],
    );
    const [first] = await space.schemas();
    assert.equal(first?.schema.types[0]?.name, 'Entry');
  });

  it('uses a provider’s own graph when it declares one', async () => {
    const vfs = mounted();
    const declared: Provider = {
      id: 'jira',
      displayName: 'Jira',
      capabilities: new Set<Capability>(['list', 'graph']),
      list: () => Promise.resolve({ entries: [] }),
      graph: {
        id: 'jira',
        displayName: 'Jira',
        schema: () => ({
          types: [{ name: 'Issue', fields: BUILTIN_NODE_FIELDS, edges: [] }],
          roots: [{ name: 'issues', type: 'Issue', list: true }],
        }),
        roots: () => Promise.resolve([]),
        neighbors: () => Promise.resolve([]),
      },
    };
    vfs.mount({ path: '/jira', id: 'jira', provider: declared });

    const schemas = await vfs.graphSpace().schemas();
    const jira = schemas.find((entry) => entry.entry.alias === 'jira');
    assert.equal(jira?.schema.types[0]?.name, 'Issue');
  });

  it('reflects the mount table as it is now, not as it was at startup', () => {
    const vfs = mounted();
    assert.equal(vfs.graphSpace().entries.length, 1);
    vfs.mount({ path: '/second', id: 'second', provider: new TreeProvider('second', TREE) });
    assert.equal(vfs.graphSpace().entries.length, 2);
  });
});
