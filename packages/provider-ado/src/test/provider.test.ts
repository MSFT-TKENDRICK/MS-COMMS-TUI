/**
 * The parts of the boards provider the conformance suite cannot reach.
 *
 * Work items live three levels down (project → team → board → column), and the shared
 * suite only walks one level below the root, so everything that makes this provider
 * *Azure DevOps* rather than a generic tree — WIQL scoping, cursor paging over an id list,
 * batch hydration order, field mapping, the discussion, push-down honesty — is tested here.
 *
 * All of it runs against the fake organization, so the assertions are about behaviour the
 * provider controls rather than about a tenant that might change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MATCH_ALL, parseQuery, stringifyQuery, VfsError, type ListPage, type VNode } from '@mscomms/core';

import { AdoBoardsProvider, adoBoardsPlugin, orgUrlFor } from '../provider.js';
import type { AdoBoardsOptions } from '../provider.js';
import { createFakeAdo, PROJECT, TEAM, testContext, type FakeAdo } from './fake-ado.js';

interface Harness {
  readonly provider: AdoBoardsProvider;
  readonly fake: FakeAdo;
}

/** `discoverProjects` drops the explicit project list so the discovery path runs instead. */
type HarnessOptions = Partial<AdoBoardsOptions> & { readonly discoverProjects?: boolean };

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { discoverProjects = false, ...rest } = options;
  const fake = createFakeAdo();
  const provider = new AdoBoardsProvider(
    {
      organization: 'contoso',
      auth: 'pat',
      token: 'fake-token',
      transport: fake.transport,
      ...(discoverProjects ? {} : { projects: [PROJECT] }),
      ...rest,
    },
    testContext(),
  );
  await provider.init();
  return { provider, fake };
}

/** Walk to a named child, the way the engine does: list, then match by name. */
async function child(provider: AdoBoardsProvider, parent: VNode | null, name: string): Promise<VNode> {
  const page = await provider.list(parent, { limit: 100 });
  const found = page.entries.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `no child named "${name}" in [${page.entries.map((e) => e.name).join(', ')}]`);
  return found;
}

async function activeColumn(provider: AdoBoardsProvider): Promise<VNode> {
  const project = await child(provider, null, PROJECT);
  const team = await child(provider, project, TEAM);
  const board = await child(provider, team, 'Stories');
  return child(provider, board, 'Active');
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

describe('azure devops boards: tree', () => {
  it('lists configured projects without asking the service for any', async () => {
    const { provider, fake } = await harness();
    const page = await provider.list(null, {});

    assert.deepEqual(page.entries.map((entry) => entry.name), [PROJECT]);
    assert.equal(page.entries[0]?.kind, 'dir');
    // A PAT scoped to one project cannot enumerate the organization, so configuring
    // projects has to mean "do not try".
    assert.equal(fake.matching('/_apis/projects').length, 0);
  });

  it('discovers projects when none are configured', async () => {
    const { provider, fake } = await harness({ discoverProjects: true });
    const page = await provider.list(null, {});

    assert.deepEqual(page.entries.map((entry) => entry.name), [PROJECT, 'Archive']);
    assert.equal(fake.matching('/_apis/projects').length, 1);
  });

  it('puts "Assigned to me" first, ahead of the teams', async () => {
    const { provider } = await harness();
    const project = await child(provider, null, PROJECT);
    const page = await provider.list(project, { limit: 100 });

    assert.equal(page.entries[0]?.name, 'Assigned to me');
    assert.deepEqual(page.entries.map((entry) => entry.name), ['Assigned to me', TEAM, 'Design']);
  });

  it('omits "Assigned to me" when it is turned off, and filters teams and boards', async () => {
    const { provider } = await harness({ includeAssignedToMe: false, teams: [TEAM], boards: ['Stories'] });
    const project = await child(provider, null, PROJECT);
    const teams = await provider.list(project, { limit: 100 });
    assert.deepEqual(teams.entries.map((entry) => entry.name), [TEAM]);

    const boards = await provider.list(teams.entries[0] as VNode, { limit: 100 });
    assert.deepEqual(boards.entries.map((entry) => entry.name), ['Stories']);
  });

  it('lists board columns and reports the work-in-progress limit', async () => {
    const { provider } = await harness();
    const project = await child(provider, null, PROJECT);
    const team = await child(provider, project, TEAM);
    const board = await child(provider, team, 'Stories');
    const page = await provider.list(board, { limit: 100 });

    assert.deepEqual(page.entries.map((entry) => entry.name), ['New', 'Active', 'Done']);
    assert.equal(page.entries[1]?.summary, 'Work in progress limit: 5');
    // A limit of zero means "no limit" in Azure DevOps, and printing it as one is a lie.
    assert.equal(page.entries[0]?.summary, undefined);
  });

  it('reports a work item as a leaf rather than an empty directory', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 5 });
    const file = page.entries[0] as VNode;

    await assert.rejects(
      () => provider.list(file, {}),
      (error: unknown) => error instanceof VfsError && error.code === 'ENOTDIR',
    );
  });
});

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

describe('azure devops boards: work items', () => {
  it('scopes a column listing to the project, the column and the team context', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100 });

    // Items 8 (a different column) and 9 (a different project) must not appear.
    assert.deepEqual(
      page.entries.map((entry) => entry.title),
      [
        '#1 Ship the board provider',
        "#2 Column names with 'quotes'",
        '#3 Unassigned work',
        '#4 Fourth item',
        '#5 Fifth item',
        '#6 Sixth item',
        '#7 Seventh item',
      ],
    );

    const wiql = fake.matching('/_apis/wit/wiql').at(-1);
    // System.BoardColumn only resolves in a team context, so the URL has to carry the team.
    assert.ok(wiql?.path.includes(`/${PROJECT}/${TEAM}/`), `wiql was not team-scoped: ${String(wiql?.path)}`);
  });

  it('names files so they sort by date and carry the work item number', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    assert.match(node.name, /^\d{4}-\d{2}-\d{2} #1 Ship the board provider\.md$/);
    assert.equal(node.kind, 'file');
    assert.equal(node.id, '1');
    assert.equal(node.author, 'Dana Scully');
    assert.equal(node.mtime?.toISOString(), '2026-08-11T10:00:00.000Z');
    assert.equal(node.summary, 'Boards should be directories.');
    assert.deepEqual(node.meta?.['tags'], 'platform, vfs');
    assert.equal(node.meta?.['state'], 'Active');
    assert.equal(node.meta?.['column'], 'Active');
    assert.equal(node.meta?.['assignedTo'], 'Dana Scully');
    assert.equal(node.meta?.['url'], `https://dev.azure.com/contoso/${encodeURIComponent(PROJECT)}/_workitems/edit/1`);
  });

  it('flags open, closed, unassigned, important and discussed items', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100 });
    const byId = new Map(page.entries.map((entry) => [entry.id, entry.flags ?? []]));

    assert.deepEqual([...(byId.get('1') ?? [])].sort(), ['discussed', 'important', 'open']);
    assert.deepEqual([...(byId.get('3') ?? [])].sort(), ['open', 'unassigned']);

    const project = await child(provider, null, PROJECT);
    const assigned = await provider.list(await child(provider, project, 'Assigned to me'), { limit: 100 });
    const closed = assigned.entries.find((entry) => entry.id === '8');
    assert.ok(closed?.flags?.includes('closed'), 'a Closed work item was not flagged as closed');
  });

  it('keeps the query order even though the batch endpoint reorders', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100 });

    // The fake answers the batch in reverse; the listing must still be newest-first.
    assert.deepEqual(page.entries.map((entry) => entry.id), ['1', '2', '3', '4', '5', '6', '7']);
    const batch = fake.matching('/_apis/wit/workitemsbatch').at(-1);
    assert.deepEqual((batch?.body as { ids?: number[] } | undefined)?.ids, [1, 2, 3, 4, 5, 6, 7]);
    // Hydration is for the requested window only, never the whole board.
    assert.equal((batch?.body as { errorPolicy?: string } | undefined)?.errorPolicy, 'omit');
  });

  it('pages a column with a cursor, without repeating or losing an item', async () => {
    const { provider } = await harness({ pageSize: 3 });
    const column = await activeColumn(provider);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result: ListPage = await provider.list(column, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.ok(result.entries.length <= 3);
      seen.push(...result.entries.map((entry) => entry.id));
      if (result.cursor === undefined) break;
      cursor = result.cursor;
    }

    assert.deepEqual(seen, ['1', '2', '3', '4', '5', '6', '7']);
    assert.equal(new Set(seen).size, seen.length, 'an item appeared on more than one page');
  });

  it('hydrates only the requested page, not the whole id list', async () => {
    const { provider, fake } = await harness({ pageSize: 2 });
    const column = await activeColumn(provider);
    await provider.list(column, { limit: 2 });

    const batch = fake.matching('/_apis/wit/workitemsbatch').at(-1);
    assert.deepEqual((batch?.body as { ids?: number[] } | undefined)?.ids, [1, 2]);
  });

  it('caps a listing at maxItems', async () => {
    const { provider } = await harness({ maxItems: 2 });
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100 });

    assert.equal(page.entries.length, 2);
  });

  it('ignores a nonsense cursor rather than throwing', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 3, cursor: 'not-a-cursor' });

    assert.deepEqual(page.entries.map((entry) => entry.id), ['1', '2', '3']);
  });

  it('lists "Assigned to me" through @Me and without a team context', async () => {
    const { provider, fake } = await harness();
    const project = await child(provider, null, PROJECT);
    const page = await provider.list(await child(provider, project, 'Assigned to me'), { limit: 100 });

    assert.deepEqual(page.entries.map((entry) => entry.id), ['1', '4', '6', '8']);
    const wiql = fake.matching('/_apis/wit/wiql').at(-1);
    assert.equal(wiql?.path, `/${PROJECT}/_apis/wit/wiql`);
    assert.match(String((wiql?.body as { query?: string } | undefined)?.query), /\[System\.AssignedTo\] = @Me/);
  });
});

// ---------------------------------------------------------------------------
// Query push-down
// ---------------------------------------------------------------------------

describe('azure devops boards: query push-down', () => {
  it('claims a date query it translated exactly, and filters by it', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const query = parseQuery('after:2026-08-09');
    const page = await provider.list(column, { limit: 100, query });

    assert.deepEqual(page.entries.map((entry) => entry.id), ['1', '2', '3']);
    assert.ok(page.appliedQuery !== undefined, 'an exactly translatable query was not claimed');
    assert.equal(
      stringifyQuery(page.appliedQuery),
      stringifyQuery(query),
      'the claim must be the caller\u2019s own query, or the engine will re-filter anyway',
    );
  });

  it('narrows on author but never claims it', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100, query: parseQuery('author:Mulder') });

    // Narrowing happened: items 2, 4 and 7 were created by Fox Mulder.
    assert.deepEqual(page.entries.map((entry) => entry.id), ['2', '4', '7']);
    // ...but Azure DevOps also matches unique names, so the engine must still re-filter.
    assert.equal(page.appliedQuery, undefined);
    assert.match(
      String((fake.matching('/_apis/wit/wiql').at(-1)?.body as { query?: string } | undefined)?.query),
      /\[System\.CreatedBy\] CONTAINS 'Mulder'/,
    );
  });

  it('claims nothing for a query it cannot express', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);

    for (const source of ['is:unread', 'kind:file', 'meeting notes', 'after:2026-08-09 OR before:2026-01-01']) {
      const page = await provider.list(column, { limit: 100, query: parseQuery(source) });
      assert.equal(page.appliedQuery, undefined, `over-claimed for "${source}"`);
    }
  });

  it('never claims a query it was not given', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);

    const none = await provider.list(column, { limit: 5 });
    assert.equal(none.appliedQuery, undefined);

    const all = await provider.list(column, { limit: 5, query: MATCH_ALL });
    assert.equal(stringifyQuery(all.appliedQuery ?? MATCH_ALL), stringifyQuery(MATCH_ALL));
  });

  it('escapes quotes in a literal instead of producing broken WIQL', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    await provider.list(column, { limit: 5, query: parseQuery('author:"O\'Brien"') });

    const statement = String((fake.matching('/_apis/wit/wiql').at(-1)?.body as { query?: string } | undefined)?.query);
    assert.match(statement, /'O''Brien'/);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('azure devops boards: reading', () => {
  it('renders a work item with headers, body and discussion', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const document = await provider.read(page.entries[0] as VNode, {});

    assert.equal(document.title, '#1 Ship the board provider');
    assert.equal(document.format, 'markdown');
    assert.equal(headerValue(document.headers, 'Type'), 'User Story');
    assert.equal(headerValue(document.headers, 'State'), 'Active');
    assert.equal(headerValue(document.headers, 'Board column'), 'Active');
    assert.equal(headerValue(document.headers, 'Assigned to'), 'Dana Scully');
    assert.equal(headerValue(document.headers, 'Tags'), 'platform, vfs');
    assert.equal(headerValue(document.headers, 'Project'), PROJECT);
    assert.match(document.body, /Boards should be directories\./);
    assert.match(document.body, /\*\*Fox Mulder\*\* commented/);
    assert.match(document.body, /First thought\./);
    assert.equal(document.webUrl, `https://dev.azure.com/contoso/${encodeURIComponent(PROJECT)}/_workitems/edit/1`);

    // The comments endpoint has never left preview and needs its own api-version.
    const comments = fake.matching('/comments').at(-1);
    assert.equal(comments?.query.get('api-version'), '7.1-preview.4');
  });

  it('renders a bug\u2019s repro steps, which do not live in the description', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100 });
    const bug = page.entries.find((entry) => entry.id === '2') as VNode;
    const document = await provider.read(bug, {});

    assert.match(document.body, /## Repro steps/);
    assert.match(document.body, /Open the board\. It explodes\./);
    assert.match(document.body, /## Acceptance criteria/);
  });

  it('says so plainly when a work item has no description at all', async () => {
    const { provider } = await harness({ includeComments: false });
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 100 });
    const bare = page.entries.find((entry) => entry.id === '5') as VNode;
    const document = await provider.read(bare, {});

    assert.match(document.body, /_No description\._/);
    assert.equal(headerValue(document.headers, 'Assigned to'), 'Unassigned');
  });

  it('skips the discussion when it is turned off', async () => {
    const { provider, fake } = await harness({ includeComments: false });
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    await provider.read(page.entries[0] as VNode, {});

    assert.equal(fake.matching('/comments').length, 0);
  });

  it('still renders the work item when the discussion cannot be loaded', async () => {
    const fake = createFakeAdo();
    const provider = new AdoBoardsProvider(
      {
        organization: 'contoso',
        projects: [PROJECT],
        auth: 'pat',
        token: 'fake-token',
        transport: (url, init) =>
          url.includes('/comments') ? Promise.resolve(new Response('nope', { status: 500 })) : fake.transport(url, init),
      },
      testContext(),
    );
    await provider.init();

    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const document = await provider.read(page.entries[0] as VNode, {});

    assert.match(document.body, /Boards should be directories\./);
    assert.match(document.body, /discussion could not be loaded/);
  });

  it('refuses to read a node that is not a work item', async () => {
    const { provider } = await harness();
    const project = await child(provider, null, PROJECT);

    await assert.rejects(
      () => provider.read(project, {}),
      (error: unknown) => error instanceof VfsError && error.code === 'ENOENT',
    );
  });
});

function headerValue(headers: ReadonlyArray<readonly [string, string]>, label: string): string | undefined {
  return headers.find(([name]) => name === label)?.[1];
}

// ---------------------------------------------------------------------------
// Polling and actions
// ---------------------------------------------------------------------------

describe('azure devops boards: polling and actions', () => {
  it('opens a cold poll on a 24-hour window rather than the whole board', async () => {
    // Asserted on the window rather than the result, because "no changes" would otherwise
    // depend on how old the fixtures happen to be on the day the suite runs.
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const first = await provider.poll(column, undefined, {});

    assert.equal(typeof first.cursor, 'string');
    const statement = String((fake.matching('/_apis/wit/wiql').at(-1)?.body as { query?: string } | undefined)?.query);
    const bound = /\[System\.ChangedDate\] >= '([^']+)'/.exec(statement);
    assert.ok(bound !== null, `a cold poll must be bounded, got: ${statement}`);
    const age = Date.now() - new Date(bound[1] as string).getTime();
    assert.ok(age > 23 * 3_600_000 && age < 25 * 3_600_000, `cold poll window was ${String(age)}ms`);
  });

  it('reports items changed since the cursor, distinguishing new from updated', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const result = await provider.poll(column, '2026-08-09T00:00:00.000Z', {});

    assert.deepEqual(result.changes.map((change) => change.node?.id), ['1', '2', '3']);
    // Every fixture item was created before the window, so none of them is new.
    assert.deepEqual([...new Set(result.changes.map((change) => change.type))], ['updated']);
    assert.ok(result.cursor !== undefined);
  });

  it('polls the root cheaply, without running a query', async () => {
    const { provider, fake } = await harness();
    const before = fake.requests.length;
    const result = await provider.poll(null, '2026-08-09T00:00:00.000Z', {});

    assert.deepEqual(result.changes, []);
    assert.equal(fake.requests.length, before, 'polling the root should not talk to Azure DevOps');
  });

  it('offers contextual work-item actions and omits close for an already-closed item', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    const actions = await provider.actions(node);
    assert.deepEqual(actions.map((action) => action.name), ['comment', 'assign', 'state', 'close', 'title', 'tag', 'url']);

    const project = await child(provider, null, PROJECT);
    const assigned = await provider.list(await child(provider, project, 'Assigned to me'), { limit: 100 });
    const closed = assigned.entries.find((entry) => entry.id === '8') as VNode;
    assert.ok(closed !== undefined, 'closed fixture item was not listed');
    assert.equal((await provider.actions(closed)).some((action) => action.name === 'close'), false);
  });

  it('assigns with JSON Patch and the mandatory Azure DevOps content type', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    fake.requests.length = 0;
    const result = await provider.invoke('assign', node, { to: 'sam@contoso.example' });

    assert.equal(result.message, 'Assigned #1 "Ship the board provider" to sam@contoso.example.');
    const patch = fake.requests.at(-1);
    assert.equal(patch?.method, 'PATCH');
    assert.equal(patch?.contentType, 'application/json-patch+json');
    assert.deepEqual(patch?.body, [
      { op: 'test', path: '/rev', value: 3 },
      { op: 'add', path: '/fields/System.AssignedTo', value: 'sam@contoso.example' },
    ]);
  });

  it('changes state with JSON Patch', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    fake.requests.length = 0;
    const result = await provider.invoke('state', node, { state: 'Resolved' });

    assert.equal(result.message, 'Moved #1 "Ship the board provider" to Resolved.');
    assert.deepEqual(fake.requests.at(-1)?.body, [
      { op: 'test', path: '/rev', value: 3 },
      { op: 'add', path: '/fields/System.State', value: 'Resolved' },
    ]);
  });

  it('appends tags instead of replacing the existing Azure DevOps tag string', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    fake.requests.length = 0;
    const result = await provider.invoke('tag', node, { tags: 'accessibility; platform' });

    assert.equal(result.message, 'Added tags to #1 "Ship the board provider": accessibility, platform.');
    assert.deepEqual(fake.requests.at(-1)?.body, [
      { op: 'test', path: '/rev', value: 3 },
      { op: 'add', path: '/fields/System.Tags', value: 'platform; vfs; accessibility' },
    ]);
  });

  it('posts discussion comments as comments', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    fake.requests.length = 0;
    const result = await provider.invoke('comment', node, { body: 'Looks good to me.' });

    assert.equal(result.message, 'Added a comment to #1 "Ship the board provider".');
    const comment = fake.requests.at(-1);
    assert.equal(comment?.method, 'POST');
    assert.equal(comment?.path, `/${PROJECT}/_apis/wit/workItems/1/comments`);
    assert.equal(comment?.query.get('api-version'), '7.0-preview.3');
    assert.deepEqual(comment?.body, { text: 'Looks good to me.' });
  });

  it('refuses a missing required parameter before any HTTP request', async () => {
    const { provider, fake } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    fake.requests.length = 0;
    await assert.rejects(
      () => provider.invoke('assign', node, {}),
      (error: unknown) => error instanceof VfsError && error.code === 'EINVAL',
    );
    assert.equal(fake.requests.length, 0);
  });

  it('returns the web URL action result', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });
    const node = page.entries[0] as VNode;

    const result = await provider.invoke('url', node, {});
    assert.equal(result.ok, true);
    assert.equal(result.message, `https://dev.azure.com/contoso/${encodeURIComponent(PROJECT)}/_workitems/edit/1`);
  });

  it('rejects an unknown action with a VfsError', async () => {
    const { provider } = await harness();
    const column = await activeColumn(provider);
    const page = await provider.list(column, { limit: 1 });

    await assert.rejects(
      () => provider.invoke('delete-everything', page.entries[0] as VNode, {}),
      (error: unknown) => error instanceof VfsError && error.code === 'ENOTSUP',
    );
  });

  it('offers no actions on a directory', async () => {
    const { provider } = await harness();
    const project = await child(provider, null, PROJECT);

    assert.deepEqual(await provider.actions(project), []);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('azure devops boards: configuration', () => {
  it('builds the collection URL from an organization name', () => {
    assert.equal(orgUrlFor({ organization: 'contoso' }), 'https://dev.azure.com/contoso');
    assert.equal(orgUrlFor({ organization: 'my org' }), 'https://dev.azure.com/my%20org');
  });

  it('prefers an explicit collection URL, for Azure DevOps Server', () => {
    assert.equal(
      orgUrlFor({ organization: 'ignored', orgUrl: 'https://tfs.contoso.example/tfs/DefaultCollection/' }),
      'https://tfs.contoso.example/tfs/DefaultCollection',
    );
    assert.equal(orgUrlFor({ organization: 'https://dev.azure.com/contoso/' }), 'https://dev.azure.com/contoso');
  });

  it('rejects a mount with no organization at configuration time', () => {
    assert.throws(
      () => adoBoardsPlugin.validateOptions?.({}),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('rejects an auth mode it does not implement', () => {
    assert.throws(
      () => adoBoardsPlugin.validateOptions?.({ organization: 'contoso', auth: 'kerberos' }),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('declares exactly the capabilities it implements', async () => {
    const { provider } = await harness();

    assert.deepEqual([...provider.capabilities].sort(), ['actions', 'list', 'poll', 'read']);
    // Declaring search would remove the engine's own walk, and a work item cannot say
    // which board column directory it should be reported under.
    assert.equal('search' in provider, false);
    assert.equal(provider.authMode, 'pat');
  });

  it('refuses to work before init', async () => {
    const provider = new AdoBoardsProvider({ organization: 'contoso' }, testContext());

    await assert.rejects(
      () => provider.list(null, {}),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });
});
