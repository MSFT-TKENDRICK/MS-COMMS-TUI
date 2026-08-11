/**
 * Projections: the user's own answer to "what should this tree look like?".
 *
 * The premise of the whole feature is that the default tree a source ships with is one
 * opinion about navigation, not the only possible one, and that a user who disagrees
 * should be able to write down a better one rather than file a feature request. A
 * projection is that written-down disagreement: a GraphQL query over every mapped source,
 * materialized back as an ordinary mount.
 *
 * So the properties worth defending here are:
 *
 *   1. It is a real mount. Lazy, paged, searchable, and readable through to the original
 *      item — not a rendered report. A projected message must open.
 *   2. It re-organizes rather than hides. The fall-through rule (an entry the projection
 *      stops describing keeps its own children) is what stops a partial projection from
 *      looking like data loss.
 *   3. It survives a cold cache. Frames are rebuilt from the id, because `cat` on a
 *      projected path in a fresh process must work.
 *   4. It cannot eat itself. A projection is a mount, and a projection over "all sources"
 *      that included itself would recurse until the stack gave out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GraphSpace, type GraphNode, type GraphSourceEntry } from '../graph.js';
import { isVfsError } from '../errors.js';
import { MappedProvider } from '../mapping.js';
import { parseQuery } from '../query.js';
import {
  ProjectionProvider,
  executeProjection,
  parseOrderBy,
  printProjectionSchema,
  projectionPlugin,
  sortGraphNodes,
} from '../projection.js';
import { NULL_LOGGER, MemoryStateStore } from '../logging.js';
import { conformanceTests } from '../testing/conformance.js';
import { Vfs } from '../vfs.js';
import type { Capability, ListPage, Provider, ProviderContext, VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// Two sources, deliberately unalike
// ---------------------------------------------------------------------------

interface Message {
  readonly id: string;
  readonly subject: string;
  readonly from: string;
  readonly folder: string;
  readonly at: string;
  readonly unread: boolean;
}

const MESSAGES: readonly Message[] = [
  { id: 'm1', subject: 'Budget review', from: 'alice', folder: 'Inbox', at: '2024-03-01T09:00:00Z', unread: true },
  { id: 'm2', subject: 'Lunch?', from: 'bob', folder: 'Inbox', at: '2024-03-02T12:00:00Z', unread: false },
  { id: 'm3', subject: 'Old thread', from: 'alice', folder: 'Archive', at: '2024-01-05T08:00:00Z', unread: false },
];

interface Ticket {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
}

const TICKETS: readonly Ticket[] = [
  { key: 'T-1', title: 'Crash on startup', owner: 'alice' },
  { key: 'T-2', title: 'Slow search', owner: 'carol' },
];

function context(mountPath: string): ProviderContext {
  return {
    mountPath,
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '',
    secret: () => Promise.resolve(undefined),
  };
}

function mailProvider(): MappedProvider {
  return new MappedProvider(
    'mail',
    {
      displayName: 'Mail',
      types: [
        {
          name: 'Message',
          key: (m: Message) => m.id,
          title: (m: Message) => m.subject,
          author: (m: Message) => m.from,
          mtime: (m: Message) => new Date(m.at),
          flags: (m: Message) => (m.unread ? ['unread'] : []),
          extension: '.eml',
          fields: [
            { name: 'folder', type: 'String', value: (m: Message) => m.folder },
            { name: 'from', type: 'String', value: (m: Message) => m.from },
          ],
          read: (m: Message) => ({
            title: m.subject,
            body: `From: ${m.from}`,
            format: 'markdown' as const,
            headers: [['From', m.from] as const],
          }),
          lookup: (key: string) => MESSAGES.find((m) => m.id === key),
        },
      ],
      roots: [
        { name: 'messages', type: 'Message', universal: true, resolve: () => MESSAGES },
      ],
    },
    context('/mail'),
  );
}

function ticketProvider(): MappedProvider {
  return new MappedProvider(
    'tickets',
    {
      displayName: 'Tickets',
      types: [
        {
          name: 'Ticket',
          key: (t: Ticket) => t.key,
          title: (t: Ticket) => t.title,
          author: (t: Ticket) => t.owner,
          extension: '.md',
          fields: [{ name: 'owner', type: 'String', value: (t: Ticket) => t.owner }],
          read: (t: Ticket) => ({
            title: t.title,
            body: t.key,
            format: 'markdown' as const,
            headers: [['Owner', t.owner] as const],
          }),
        },
      ],
      roots: [{ name: 'tickets', type: 'Ticket', universal: true, resolve: () => TICKETS }],
    },
    context('/tickets'),
  );
}

function entry(alias: string, mountPath: string, provider: MappedProvider): GraphSourceEntry {
  return { alias, mountId: alias, mountPath, source: provider.graph };
}

function space(): GraphSpace {
  return new GraphSpace([
    entry('mail', '/mail', mailProvider()),
    entry('tickets', '/tickets', ticketProvider()),
  ]);
}

/** A projection mount over both sources. */
function projection(query: string, options: { defaultLimit?: number } = {}): ProjectionProvider {
  return new ProjectionProvider({
    space: () => space(),
    mountPath: '/view',
    query,
    ...(options.defaultLimit === undefined ? {} : { defaultLimit: options.defaultLimit }),
  });
}

async function names(provider: ProjectionProvider, node: VNode | null): Promise<readonly string[]> {
  const page: ListPage = await provider.list(node, {});
  return page.entries.map((child) => child.name);
}

/** Walk a projected path segment by segment, the way the engine does. */
async function walk(provider: ProjectionProvider, path: readonly string[]): Promise<VNode> {
  let current: VNode | null = null;
  for (const segment of path) {
    const page = await provider.list(current, {});
    const found = page.entries.find((child) => child.name === segment);
    assert.ok(found !== undefined, `no entry "${segment}" in [${page.entries.map((e) => e.name).join(', ')}]`);
    current = found;
  }
  assert.ok(current !== null);
  return current;
}

// ---------------------------------------------------------------------------
// Schema printing
// ---------------------------------------------------------------------------

describe('printProjectionSchema', () => {
  it('prints the universal roots a cross-source projection is written against', async () => {
    const sdl = await printProjectionSchema(space());
    assert.match(sdl, /type Query \{/);
    assert.match(sdl, /\bnodes\(/);
    assert.match(sdl, /\ball\(/);
  });

  it('prints every source’s own root, so a single-source projection is discoverable', async () => {
    const sdl = await printProjectionSchema(space());
    assert.match(sdl, /mail_messages/);
    assert.match(sdl, /tickets_tickets/);
  });

  it('prints declared fields next to the built-in ones', async () => {
    const sdl = await printProjectionSchema(space());
    assert.match(sdl, /type mail_Message\b/);
    assert.match(sdl, /\bfolder: String/);
    // A projection is written by hand against these names, so the built-ins have to be
    // listed too or the author has to guess at them.
    assert.match(sdl, /\bname: String/);
  });

  it('says something useful when nothing is mapped, rather than printing an empty type', async () => {
    const sdl = await printProjectionSchema(new GraphSpace([]));
    assert.match(sdl, /type Query \{/);
    assert.ok(sdl.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

describe('parseOrderBy', () => {
  it('reads a field and a direction', () => {
    assert.deepEqual(parseOrderBy('date desc'), { field: 'date', direction: 'desc' });
  });

  it('accepts the synonyms people actually type', () => {
    assert.equal(parseOrderBy('mtime').field, 'date');
    assert.equal(parseOrderBy('from').field, 'author');
    assert.equal(parseOrderBy('time desc').field, 'date');
  });

  it('defaults to ascending by name rather than rejecting nonsense', () => {
    // An unparseable sort is not worth failing a whole projection over.
    assert.deepEqual(parseOrderBy('wobble'), { field: 'name', direction: 'asc' });
    assert.deepEqual(parseOrderBy(''), { field: 'name', direction: 'asc' });
  });

  it('reads a comma as a separator too', () => {
    assert.deepEqual(parseOrderBy('size, desc'), { field: 'size', direction: 'desc' });
  });
});

describe('sortGraphNodes', () => {
  const nodes: readonly GraphNode[] = [
    { source: 's', type: 'T', key: 'b', node: { name: 'b', kind: 'file', title: 'b', id: 'b' }, fields: {} },
    { source: 's', type: 'T', key: 'a', node: { name: 'a', kind: 'file', title: 'a', id: 'a' }, fields: {} },
  ];

  it('sorts ascending and descending', () => {
    assert.deepEqual(sortGraphNodes(nodes, 'name', 'asc').map((n) => n.key), ['a', 'b']);
    assert.deepEqual(sortGraphNodes(nodes, 'name', 'desc').map((n) => n.key), ['b', 'a']);
  });

  it('does not mutate the input', () => {
    sortGraphNodes(nodes, 'name', 'desc');
    assert.deepEqual(nodes.map((n) => n.key), ['b', 'a']);
  });
});

// ---------------------------------------------------------------------------
// Eager execution — what `graphql` runs
// ---------------------------------------------------------------------------

describe('executeProjection', () => {
  it('fans a universal root out across every source', async () => {
    const result = await executeProjection(space(), '{ nodes { name source: __typename } }');
    const rows = (result as { nodes: readonly { name: string }[] }).nodes;
    assert.equal(rows.length, MESSAGES.length + TICKETS.length);
  });

  it('restricts to one source when asked', async () => {
    const result = await executeProjection(space(), '{ nodes(source: "tickets") { name } }');
    assert.equal((result as { nodes: readonly unknown[] }).nodes.length, TICKETS.length);
  });

  it('resolves a source’s own root by its qualified name', async () => {
    const result = await executeProjection(space(), '{ mail_messages { name } }');
    assert.equal((result as { mail_messages: readonly unknown[] }).mail_messages.length, MESSAGES.length);
  });

  it('accepts the bare source name, which is what people try first', async () => {
    const result = await executeProjection(space(), '{ mail { name } }');
    assert.equal((result as { mail: readonly unknown[] }).mail.length, MESSAGES.length);
  });

  it('returns declared fields alongside built-in ones', async () => {
    const result = await executeProjection(space(), '{ mail { name folder author } }');
    const [first] = (result as { mail: readonly Record<string, unknown>[] }).mail;
    assert.equal(first?.['folder'], 'Inbox');
    assert.equal(first?.['author'], 'alice');
  });

  it('honours an alias, since that is how two views of one field are named apart', async () => {
    const result = await executeProjection(space(), '{ inbox: mail { who: author } }');
    const rows = (result as { inbox: readonly Record<string, unknown>[] }).inbox;
    assert.equal(rows[0]?.['who'], 'alice');
  });

  it('reports __typename as source-qualified, so two sources cannot collide', async () => {
    const result = await executeProjection(space(), '{ mail { __typename } }');
    const rows = (result as { mail: readonly Record<string, unknown>[] }).mail;
    assert.equal(rows[0]?.['__typename'], 'mail_Message');
  });

  it('applies filter and first', async () => {
    const result = await executeProjection(space(), '{ mail(filter: "alice", first: 1) { author } }');
    const rows = (result as { mail: readonly Record<string, unknown>[] }).mail;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['author'], 'alice');
  });

  it('applies orderBy', async () => {
    const result = await executeProjection(space(), '{ mail(orderBy: "name desc") { name } }');
    const rows = (result as { mail: readonly Record<string, string>[] }).mail;
    const sorted = [...rows.map((r) => r['name'] as string)].sort().reverse();
    assert.deepEqual(rows.map((r) => r['name']), sorted);
  });

  it('substitutes variables', async () => {
    const result = await executeProjection(
      space(),
      'query Recent($who: String!) { mail(filter: $who) { author } }',
      { variables: { who: 'bob' } },
    );
    const rows = (result as { mail: readonly Record<string, unknown>[] }).mail;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['author'], 'bob');
  });

  it('names the variable when one was never supplied', async () => {
    await assert.rejects(
      () => executeProjection(space(), 'query Q($who: String!) { mail(filter: $who) { name } }'),
      (error: unknown) => isVfsError(error) && /\$who/.test(error.message),
    );
  });

  it('expands a fragment', async () => {
    const result = await executeProjection(
      space(),
      '{ mail { ...card } } fragment card on mail_Message { name author }',
    );
    const rows = (result as { mail: readonly Record<string, unknown>[] }).mail;
    assert.equal(rows[0]?.['author'], 'alice');
  });

  it('refuses a mutation, since a projection is a view', async () => {
    await assert.rejects(
      () => executeProjection(space(), 'mutation { mail { name } }'),
      (error: unknown) => isVfsError(error) && /mutation/i.test(error.message),
    );
  });

  it('insists on a name when the document defines more than one operation', async () => {
    const document = 'query A { mail { name } } query B { tickets { name } }';
    await assert.rejects(
      () => executeProjection(space(), document),
      (error: unknown) => isVfsError(error) && /operation/i.test(error.message),
    );
    const picked = await executeProjection(space(), document, { operationName: 'B' });
    assert.equal((picked as { tickets: readonly unknown[] }).tickets.length, TICKETS.length);
  });

  it('reports an unknown edge rather than quietly returning nothing', async () => {
    // Silence here would look exactly like "there is nothing there", which is the one
    // failure this codebase refuses to ship.
    await assert.rejects(
      () => executeProjection(space(), '{ mail { nonsense { name } } }'),
      (error: unknown) => isVfsError(error) && /nonsense/.test(error.message),
    );
  });

  it('serializes a date as an ISO string, so the output is real JSON', async () => {
    const result = await executeProjection(space(), '{ mail { mtime } }');
    const rows = (result as { mail: readonly Record<string, unknown>[] }).mail;
    assert.equal(typeof rows[0]?.['mtime'], 'string');
    assert.match(rows[0]?.['mtime'] as string, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// The mount
// ---------------------------------------------------------------------------

describe('ProjectionProvider: construction', () => {
  it('refuses to mount without a query, and says where to put one', () => {
    assert.throws(
      () => new ProjectionProvider({ space: () => new GraphSpace([]), mountPath: '/view' }),
      (error: unknown) => isVfsError(error) && /query/i.test(error.message),
    );
  });

  it('reports a syntax error at load, not on first `ls`', () => {
    assert.throws(
      () => projection('{ mail { name '),
      (error: unknown) => isVfsError(error),
    );
  });

  it('declares the capabilities it implements', () => {
    const provider = projection('{ mail { name } }');
    assert.ok(provider.capabilities.has('list'));
    assert.ok(provider.capabilities.has('read'));
    assert.ok(provider.capabilities.has('search'));
    assert.equal(typeof provider.list, 'function');
    assert.equal(typeof provider.read, 'function');
  });
});

describe('ProjectionProvider: the projected tree', () => {
  it('turns each selected root field into a directory', async () => {
    const provider = projection('{ mail { name } tickets { name } }');
    assert.deepEqual(await names(provider, null), ['mail', 'tickets']);
  });

  it('uses the alias as the directory name, which is how a tree gets renamed', async () => {
    const provider = projection('{ Correspondence: mail { name } }');
    assert.deepEqual(await names(provider, null), ['Correspondence']);
  });

  it('puts the matching nodes inside', async () => {
    const provider = projection('{ mail { name } }');
    const inside = await walk(provider, ['mail']);
    assert.deepEqual((await names(provider, inside)).length, MESSAGES.length);
  });

  it('is lazy: listing the root does not resolve the leaves', async () => {
    // The point of a mount over a report. A projection spanning every source must not
    // fetch every source to draw one directory.
    let resolved = 0;
    const counting = new MappedProvider(
      'mail',
      {
        types: [{ name: 'Message', key: (m: Message) => m.id, title: (m: Message) => m.subject }],
        roots: [
          {
            name: 'messages',
            type: 'Message',
            universal: true,
            resolve: () => {
              resolved += 1;
              return MESSAGES;
            },
          },
        ],
      },
      context('/mail'),
    );
    const provider = new ProjectionProvider({
      space: () => new GraphSpace([entry('mail', '/mail', counting)]),
      mountPath: '/view',
      query: '{ mail { name } }',
    });

    await provider.list(null, {});
    assert.equal(resolved, 0, 'listing the projection root resolved a source it did not need');
    await provider.list(await walk(provider, ['mail']), {});
    assert.ok(resolved > 0);
  });

  it('pages, and reports the total so the shell can say there is more', async () => {
    const provider = projection('{ mail { name } }');
    const page = await provider.list(await walk(provider, ['mail']), { limit: 2 });
    assert.equal(page.entries.length, 2);
    assert.equal(page.total, MESSAGES.length);
  });

  it('gives every entry a unique name within its directory', async () => {
    const provider = projection('{ mail @name(field: "author") { name } }');
    const entries = await names(provider, await walk(provider, ['mail']));
    assert.equal(new Set(entries).size, entries.length, `duplicate names in ${entries.join(', ')}`);
  });
});

describe('ProjectionProvider: directives', () => {
  it('@group builds a directory per distinct value', async () => {
    const provider = projection('{ mail @group(by: "author") { name } }');
    const groups = await names(provider, await walk(provider, ['mail']));
    assert.deepEqual([...groups].sort(), ['alice', 'bob']);
  });

  it('@group puts only the matching nodes in each group', async () => {
    const provider = projection('{ mail @group(by: "author") { name } }');
    const alice = await walk(provider, ['mail', 'alice']);
    assert.equal(alice.childCount, 2);
    assert.equal((await names(provider, alice)).length, 2);
  });

  it('@group labels a group with a template when given one', async () => {
    const provider = projection('{ mail @group(by: "author", name: "from {value}") { name } }');
    const groups = await names(provider, await walk(provider, ['mail']));
    assert.ok(groups.includes('from alice'), groups.join(', '));
  });

  it('@group insists on a field, since grouping by nothing is a typo', async () => {
    const provider = projection('{ mail @group { name } }');
    const mail = await walk(provider, ['mail']);
    await assert.rejects(
      () => provider.list(mail, {}),
      (error: unknown) => isVfsError(error) && /@group/.test(error.message),
    );
  });

  it('@sort orders the entries', async () => {
    const provider = projection('{ mail @sort(by: "author", order: "desc") { name } }');
    const entries = (await provider.list(await walk(provider, ['mail']), {})).entries;
    assert.equal(entries[0]?.author, 'bob');
  });

  it('@name renames entries from a field', async () => {
    const provider = projection('{ tickets @name(field: "owner") { name } }');
    const entries = await names(provider, await walk(provider, ['tickets']));
    assert.deepEqual([...entries].sort(), ['alice', 'carol']);
  });

  it('@name renames entries from a template', async () => {
    const provider = projection('{ tickets @name(template: "{author} - {title}") { name } }');
    const entries = await names(provider, await walk(provider, ['tickets']));
    assert.ok(entries.includes('alice - Crash on startup'), entries.join(', '));
  });

  it('@flatten lifts a field’s entries into its parent, removing a level', async () => {
    const flat = projection('{ mail @flatten { name } }');
    // Without @flatten the root holds one directory; with it, the messages themselves.
    assert.equal((await names(flat, null)).length, MESSAGES.length);
  });

  it('@as forces a kind, so a leaf can be made browsable or a folder made readable', async () => {
    const provider = projection('{ tickets @as(kind: "dir") { name } }');
    const entries = (await provider.list(await walk(provider, ['tickets']), {})).entries;
    assert.ok(entries.every((child) => child.kind === 'dir'));
  });
});

describe('ProjectionProvider: reaching the original item', () => {
  it('reads a projected entry through the source that owns it', async () => {
    const provider = projection('{ mail { name } }');
    const entries = (await provider.list(await walk(provider, ['mail']), {})).entries;
    const first = entries[0];
    assert.ok(first !== undefined);
    const document = await provider.read(first, {});
    assert.match(document.body, /From: /);
  });

  it('records where an entry came from, so the copy is traceable', async () => {
    const provider = projection('{ mail { name } }');
    const entries = (await provider.list(await walk(provider, ['mail']), {})).entries;
    assert.equal(entries[0]?.meta?.['source'], 'mail');
    assert.equal(typeof entries[0]?.meta?.['origin'], 'string');
  });

  it('promotes a selected scalar to metadata, which is what the columns render from', async () => {
    const provider = projection('{ mail { folder } }');
    const entries = (await provider.list(await walk(provider, ['mail']), {})).entries;
    assert.equal(entries[0]?.meta?.['folder'], 'Inbox');
  });

  it('refuses to read a directory the projection invented', async () => {
    const provider = projection('{ mail { name } }');
    const mail = await walk(provider, ['mail']);
    await assert.rejects(
      () => provider.read(mail, {}),
      (error: unknown) => isVfsError(error) && error.code === 'EISDIR',
    );
  });

  it('offers no actions on an invented directory rather than failing', async () => {
    const provider = projection('{ mail { name } }');
    assert.deepEqual(await provider.actions(await walk(provider, ['mail'])), []);
  });

  it('rebuilds a frame from a cold cache, so a deep path opens in a fresh process', async () => {
    const warm = projection('{ mail { name } }');
    const target = (await warm.list(await walk(warm, ['mail']), {})).entries[0];
    assert.ok(target !== undefined);

    // A brand-new provider has never listed anything, so the only thing it can go on is
    // the id — which is exactly the situation after a restart.
    const cold = projection('{ mail { name } }');
    const document = await cold.read(target, {});
    assert.match(document.body, /From: /);
  });

  it('says the entry is gone when the projection no longer produces it', async () => {
    const warm = projection('{ mail { name } }');
    const target = (await warm.list(await walk(warm, ['mail']), {})).entries[0];
    assert.ok(target !== undefined);

    const different = projection('{ tickets { name } }');
    await assert.rejects(
      () => different.read(target, {}),
      (error: unknown) => isVfsError(error) && error.code === 'ENOENT',
    );
  });
});

describe('ProjectionProvider: the fall-through rule', () => {
  it('keeps a source’s own children for an entry the projection stops describing', async () => {
    // `{ mail { name } }` says nothing about what is under a message. The honest answer is
    // "whatever the source says", not "nothing" — a projection re-organizes, it does not
    // delete.
    const tree = new Vfs();
    tree.mount({ path: '/folders', id: 'folders', provider: folderProvider() });
    const source = tree.graphSpace();
    const provider = new ProjectionProvider({
      space: () => source,
      mountPath: '/view',
      query: '{ folders { name } }',
    });

    const entries = (await provider.list(await walk(provider, ['folders']), {})).entries;
    const inbox = entries.find((child) => child.name === 'Inbox');
    assert.ok(inbox !== undefined, entries.map((e) => e.name).join(', '));
    const children = await provider.list(inbox, {});
    assert.deepEqual(
      children.entries.map((child) => child.name),
      ['a.eml', 'b.eml'],
    );
  });
});

describe('ProjectionProvider: search', () => {
  it('finds an entry in the projected tree and reports where it is', async () => {
    const provider = projection('{ mail { name } }');
    const page = await provider.search(null, parseQuery('Budget'), {});
    assert.equal(page.entries.length, 1);
    const [hit] = page.entries;
    assert.ok(hit?.path !== undefined || hit?.parentPath !== undefined, 'a hit with no location cannot be opened');
  });

  it('returns an empty page rather than throwing when nothing matches', async () => {
    const provider = projection('{ mail { name } }');
    const page = await provider.search(null, parseQuery('zzzznothing'), {});
    assert.deepEqual(page.entries, []);
  });
});

describe('ProjectionProvider: a projected entry is located in the projection', () => {
  // A tree-derived graph gives every node the path it has in its own mount. Spreading that
  // node into a projected entry used to carry `path` along, and since the engine prefers a
  // hit's `path` when resolving a search result, `find` over a projection handed back paths
  // into the source mount — the projected tree could not be navigated from its own results.
  function projectedTree(query: string): { provider: ProjectionProvider } {
    const tree = new Vfs();
    tree.mount({ path: '/folders', id: 'folders', provider: folderProvider() });
    const source = tree.graphSpace();
    return {
      provider: new ProjectionProvider({ space: () => source, mountPath: '/view', query }),
    };
  }

  it('does not carry the source’s own path into a listed entry', async () => {
    const { provider } = projectedTree('{ folders { name } }');
    const inbox = await walk(provider, ['folders', 'Inbox']);
    assert.equal(inbox.path, undefined, 'a projected entry does not live where the source keeps it');
    assert.equal(inbox.parentPath, undefined);
  });

  it('does not carry it into a fall-through entry either', async () => {
    const { provider } = projectedTree('{ folders { name } }');
    const children = await provider.list(await walk(provider, ['folders', 'Inbox']), {});
    for (const child of children.entries) {
      assert.equal(child.path, undefined, `${child.name} still points at its source`);
    }
  });

  it('still records where the entry came from, as meta.origin', async () => {
    const { provider } = projectedTree('{ folders { name } }');
    const inbox = await walk(provider, ['folders', 'Inbox']);
    assert.equal(inbox.meta?.['origin'], '/folders/Inbox');
  });

  it('reports a search hit at its projected location, not its source one', async () => {
    const { provider } = projectedTree('{ folders { name } }');
    const page = await provider.search(null, parseQuery('a.eml'), {});
    assert.ok(page.entries.length > 0, 'expected to find the message');
    // The root of a tree-derived graph is "everything in this source", so the message shows
    // up both directly under the selected field and under the folder it lives in. Every one
    // of those locations has to be a path in the projection.
    for (const hit of page.entries) {
      assert.equal(hit.path, undefined, 'a projected hit must not point back at its source');
      assert.ok(hit.parentPath !== undefined, 'a hit with no location cannot be opened');
      assert.ok(
        !hit.parentPath.startsWith('/'),
        `parentPath "${hit.parentPath}" is absolute, so it names a mount rather than a place in the projection`,
      );
      await walk(provider, [...hit.parentPath.split('/').filter((s) => s !== ''), hit.name]);
    }
  });
});

// ---------------------------------------------------------------------------
// Self-exclusion — the recursion guard
// ---------------------------------------------------------------------------

describe('a projection over its own mount table', () => {
  it('does not include itself, which would otherwise recurse forever', async () => {
    const vfs = new Vfs();
    vfs.mount({ path: '/mail', id: 'mail', provider: mailProvider() });

    const view = new ProjectionProvider({
      space: () => vfs.graphSpace().without('/view'),
      mountPath: '/view',
      query: '{ nodes { name } }',
    });
    vfs.mount({ path: '/view', id: 'view', provider: view });

    const aliases = vfs
      .graphSpace()
      .without('/view')
      .entries.map((source) => source.alias);
    assert.deepEqual(aliases, ['mail']);

    // And the projection still lists, rather than blowing the stack.
    const roots = await view.list(null, {});
    assert.equal(roots.entries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

describe('projectionPlugin', () => {
  it('registers as the `projection` mount type', () => {
    assert.equal(projectionPlugin.type, 'projection');
  });

  it('builds a provider from mount options', async () => {
    const vfs = new Vfs();
    vfs.mount({ path: '/mail', id: 'mail', provider: mailProvider() });
    const provider = await projectionPlugin.create(
      { query: '{ mail { name } }' },
      { ...context('/view'), graph: () => vfs.graphSpace() },
    );
    assert.equal((await provider.list(null, {})).entries[0]?.name, 'mail');
  });

  it('explains itself when mounted with no graph available', async () => {
    await assert.rejects(
      async () => projectionPlugin.create({ query: '{ mail { name } }' }, context('/view')),
      (error: unknown) => isVfsError(error),
    );
  });

  it('rejects variables that are not an object, at load', () => {
    assert.throws(
      () => projectionPlugin.validateOptions?.({ query: '{ a { b } }', variables: [1, 2] }),
      (error: unknown) => isVfsError(error) && /variables/.test(error.message),
    );
  });
});

// ---------------------------------------------------------------------------
// The conformance suite
// ---------------------------------------------------------------------------

// The whole claim of this feature is that a re-organized tree is an ordinary mount, not a
// rendered report. That claim is only worth anything if a projection passes the same exam
// every real provider passes.
describe('conformance: a projection mount', () => {
  for (const testCase of conformanceTests({
    create: () => projection('{ mail { name folder } tickets { name } }'),
    offlineOnly: true,
    sampleQuery: 'a',
  })) {
    it(testCase.name, () => testCase.run());
  }
});

// ---------------------------------------------------------------------------
// A plain tree provider, used for the fall-through test
// ---------------------------------------------------------------------------

function folderProvider(): Provider {
  const children: Record<string, readonly string[]> = {
    Inbox: ['a.eml', 'b.eml'],
  };
  return {
    id: 'folders',
    displayName: 'Folders',
    capabilities: new Set<Capability>(['list']),
    list: (parent: VNode | null): Promise<ListPage> => {
      if (parent === null) {
        return Promise.resolve({
          entries: [{ name: 'Inbox', kind: 'dir' as const, title: 'Inbox', id: 'Inbox' }],
        });
      }
      const names_ = children[parent.id] ?? [];
      return Promise.resolve({
        entries: names_.map((name) => ({ name, kind: 'file' as const, title: name, id: `${parent.id}/${name}` })),
      });
    },
  };
}
