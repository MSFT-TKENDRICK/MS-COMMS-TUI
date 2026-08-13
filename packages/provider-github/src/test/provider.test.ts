/**
 * The GitHub provider, against a fake GitHub.
 *
 * These tests are about the mapping, not the HTTP: given the payloads GitHub really
 * returns, does the tree come out the way a user can navigate, and does the provider ask
 * for the right things? Anything that would need a network or a token is served by
 * `fake-github.ts` over the provider's `transport` seam, so the suite passes on a laptop
 * that has never heard of GitHub.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateQuery, isVfsError, parseQuery, type ListPage, type VNode } from '@mscomms/core';

import { GitHubProvider, type GitHubProviderOptions } from '../provider.js';
import { GitHubClient } from '../client.js';
import { createFakeGitHub, testContext, OWNER, REPO, type FakeGitHub, type FakeOptions } from './fake-github.js';

async function makeProvider(
  options: Partial<GitHubProviderOptions> = {},
  fakeOptions: FakeOptions = {},
): Promise<{ provider: GitHubProvider; fake: FakeGitHub }> {
  const fake = createFakeGitHub(fakeOptions);
  const provider = new GitHubProvider(
    {
      repos: [`${OWNER}/${REPO}`],
      token: 'fake-token',
      transport: fake.transport,
      ...options,
    },
    testContext(),
  );
  await provider.init();
  return { provider, fake };
}

/** Walk to a directory node by the names a user would type. */
async function cd(provider: GitHubProvider, ...names: readonly string[]): Promise<VNode> {
  let node: VNode | null = null;
  for (const name of names) {
    const page = await provider.list(node, {});
    const found = page.entries.find((entry) => entry.name === name);
    assert.ok(found !== undefined, `no entry named "${name}" in ${JSON.stringify(page.entries.map((e) => e.name))}`);
    node = found;
  }
  assert.ok(node !== null);
  return node;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('tree shape', () => {
  it('gives a repository all four content folders when a token is present', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO), {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['issues', 'pulls', 'discussions', 'projects'],
    );
  });

  it('offers owner-level projects beside the owner\'s repositories', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER), {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['projects', REPO],
    );
  });

  it('lists an owner that has projects but no repository', async () => {
    // The point of the `owners` option: a board that spans repositories belongs to the
    // organization, and naming one of its repositories to reach it would be arbitrary.
    const { provider } = await makeProvider({ repos: [], owners: ['acme'] });
    const page = await provider.list(null, {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['acme'],
    );
  });

  it('hides discussions and projects when there is no token', async () => {
    // GitHub's GraphQL API has no anonymous access at all, so these folders could only
    // ever throw. A folder that always fails is indistinguishable from a bug.
    const fake = createFakeGitHub();
    const provider = new GitHubProvider(
      { repos: [`${OWNER}/${REPO}`], token: '', transport: fake.transport },
      testContext(),
    );
    await provider.init();

    const page = await provider.list(await cd(provider, OWNER, REPO), {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['issues', 'pulls'],
    );
    const owner = await provider.list(await cd(provider, OWNER), {});
    assert.deepEqual(
      owner.entries.map((entry) => entry.name),
      [REPO],
    );
  });

  it('honours the opt-outs individually', async () => {
    const { provider } = await makeProvider({ includePulls: false, includeProjects: false });
    const page = await provider.list(await cd(provider, OWNER, REPO), {});
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ['issues', 'discussions'],
    );
  });

  it('rejects an owner entry that is really a repository', async () => {
    assert.throws(
      () => new GitHubProvider({ owners: [`${OWNER}/${REPO}`] }, testContext()),
      (error: unknown) => isVfsError(error) && error.code === 'ECONFIG',
    );
  });

  it('pages the levels it builds from configuration', async () => {
    // These lists are short and local, which makes returning them whole tempting. The
    // engine sizes a page to what it is about to draw and trusts the length it gets back,
    // so over-returning corrupts the caller's paging rather than the provider's.
    const { provider } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO);

    const first = await provider.list(parent, { limit: 2 });
    assert.equal(first.entries.length, 2);
    assert.equal(first.total, 4);
    assert.ok(first.cursor !== undefined);

    const second = await provider.list(parent, { limit: 2, cursor: first.cursor as string });
    assert.deepEqual(
      [...first.entries, ...second.entries].map((entry) => entry.name),
      ['issues', 'pulls', 'discussions', 'projects'],
    );
    assert.equal(second.cursor, undefined);
  });

  it('rejects a cursor it did not issue rather than silently restarting', async () => {
    const { provider } = await makeProvider();
    await assert.rejects(
      () => provider.list(null, { cursor: 'not-a-cursor' }),
      (error: unknown) => isVfsError(error),
    );
  });
});

// ---------------------------------------------------------------------------
// Issues and pull requests
// ---------------------------------------------------------------------------

describe('issues', () => {
  it('keeps pull requests out of the issues folder', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'issues'), { limit: 100 });
    assert.equal(page.entries.length, 12);
    assert.ok(page.entries.every((entry) => entry.subtype === 'issue'));
  });

  it('leaves a substring author filter to the engine rather than mistranslating it', async () => {
    // `author:alice` parses as a *contains* match, and GitHub's `creator` is whole-login
    // equality. Sending it would return nothing for `author:ali`, and claiming it would
    // stop the engine from noticing — a search that silently finds nothing is worse than
    // one that costs a local pass.
    const { provider, fake } = await makeProvider();
    const query = parseQuery('author:ali');
    const page = await provider.list(await cd(provider, OWNER, REPO, 'issues'), { query, limit: 100 });

    assert.equal(fake.matching('/issues').at(-1)?.query.get('creator'), null);
    assert.equal(page.appliedQuery, undefined);
    // Everything alice wrote is still on the page, for the engine to narrow.
    assert.ok(page.entries.some((entry) => entry.author === 'alice'));
  });

  it('never claims to have applied a compound query', async () => {
    // Over-claiming means the engine skips its own filtering and the user silently gets
    // results that do not match what they asked for.
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'issues'), {
      query: parseQuery('is:open author:alice'),
      limit: 100,
    });
    assert.equal(page.appliedQuery, undefined);
  });

  it('honours a limit that shrinks part way through a walk', async () => {
    // `per_page` is only on the first URL this provider builds. Every page after that
    // comes from GitHub's Link header, which carries the size that was in force when the
    // link was minted — so a cursor would otherwise outrank the caller's new limit.
    const { provider } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO, 'issues');

    const first = await provider.list(parent, { limit: 10 });
    assert.equal(first.entries.length, 10);
    assert.ok(first.cursor !== undefined);

    const second = await provider.list(parent, { limit: 1, cursor: first.cursor as string });
    assert.equal(second.entries.length, 1);
  });

  it('walks every issue exactly once in small pages', async () => {
    const { provider } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO, 'issues');

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result: ListPage = await provider.list(parent, {
        limit: 5,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.ok(result.entries.length <= 5, `page of ${String(result.entries.length)} exceeded the limit`);
      seen.push(...result.entries.map((entry) => entry.name));
      cursor = result.cursor;
      if (cursor === undefined) break;
    }

    assert.equal(cursor, undefined, 'paging never terminated');
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12, 'an entry was returned twice');
  });

  it('rejects a cursor it did not issue rather than refetching the first page', async () => {
    const { provider } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO, 'issues');
    await assert.rejects(
      () => provider.list(parent, { cursor: 'https://evil.example.com/steal' }),
      (error: unknown) => isVfsError(error) && error.code === 'EINVAL',
    );
  });

  it('will not send the token to a host the mount was not pointed at', async () => {
    // Cursors are persisted and replayed on a later run, and the client attaches a
    // corporate token to whatever URL one names. Even though the provider's own codec
    // rejects a foreign cursor first, the client pins the origin as well: this is the last
    // gate before the credential leaves the machine, so it should not depend on a caller
    // upstream having validated anything.
    const fake = createFakeGitHub();
    const client = new GitHubClient({ token: 'fake-token', fetch: fake.transport });

    await assert.rejects(
      () => client.get('https://evil.example.com/steal'),
      (error: unknown) => isVfsError(error) && error.code === 'EINVAL',
    );
    assert.equal(fake.requests.length, 0, 'the request was actually sent');
  });
});

describe('pull requests', () => {
  it('lists from the pulls endpoint, not by filtering issues', async () => {
    // Filtering `/issues` looks equivalent but pages badly: a page of fifty mixed items
    // yields a handful of pull requests in any repository where issues outnumber them.
    const { provider, fake } = await makeProvider({ state: 'all' });
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), { limit: 100 });

    assert.equal(fake.matching(`/repos/${OWNER}/${REPO}/pulls`).length, 1);
    assert.equal(page.entries.length, 3);
    assert.ok(page.entries.every((entry) => entry.subtype === 'pull'));
    // Nothing was fetched from the issues endpoint to produce them.
    assert.equal(fake.matching(`/repos/${OWNER}/${REPO}/issues`).length, 0);
  });

  it('carries branches, reviewers and the merged state', async () => {
    const { provider } = await makeProvider({ state: 'all' });
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), { limit: 100 });

    const open = page.entries.find((entry) => entry.title.startsWith('#101'));
    assert.equal(open?.meta?.['head'], 'feature');
    assert.equal(open?.meta?.['base'], 'main');
    assert.equal(open?.meta?.['reviewers'], 'carol');
    assert.ok(open?.flags?.includes('review-requested'));

    // Merged is a third state GitHub reports as `closed`, and the difference is the whole
    // reason to look at a closed pull request.
    const merged = page.entries.find((entry) => entry.title.startsWith('#102'));
    assert.ok(merged?.flags?.includes('merged'));
    assert.equal(merged?.meta?.['state'], 'merged');

    const draft = page.entries.find((entry) => entry.title.startsWith('#103'));
    assert.ok(draft?.flags?.includes('draft'));
    assert.ok(!(draft?.flags ?? []).includes('review-requested'));
  });

  it('fetches closed pull requests without claiming to have applied is:closed', async () => {
    // GitHub calls a merged pull request closed; this provider does not, because whether
    // one landed or was abandoned is the entire question. `state=closed` is still the
    // right fetch, but claiming the query would switch off local filtering and hand back
    // merged pull requests for a query that excludes them.
    const { provider, fake } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), {
      query: parseQuery('is:closed'),
      limit: 100,
    });

    assert.equal(fake.matching(`/repos/${OWNER}/${REPO}/pulls`).at(-1)?.query.get('state'), 'closed');
    assert.equal(page.appliedQuery, undefined);
    // The merged one is on the page for the engine to reject, not filtered out early.
    assert.ok(page.entries.some((entry) => entry.flags?.includes('merged')));
  });

  it('finds a merged pull request for is:merged, which GitHub has no state for', async () => {
    const { provider, fake } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), {
      query: parseQuery('is:merged'),
      limit: 100,
    });

    // The mount defaults to open. Left alone, a merged pull request could never appear.
    assert.equal(fake.matching(`/repos/${OWNER}/${REPO}/pulls`).at(-1)?.query.get('state'), 'closed');
    assert.ok(page.entries.some((entry) => entry.title.startsWith('#102')));
    assert.equal(page.appliedQuery, undefined);
  });

  it('claims is:open, the one state whose meaning survives the trip', async () => {
    const { provider, fake } = await makeProvider({ state: 'all' });
    const query = parseQuery('is:open');
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), { query, limit: 100 });

    assert.equal(fake.matching(`/repos/${OWNER}/${REPO}/pulls`).at(-1)?.query.get('state'), 'open');
    assert.deepEqual(page.appliedQuery, query);
  });

  it('widens the fetch for an is: term it cannot translate', async () => {
    // `is:draft` is decided from the node, so the only useful thing the URL can do is stop
    // the mount's default state from hiding the answer.
    const { provider, fake } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), {
      query: parseQuery('is:draft'),
      limit: 100,
    });

    assert.equal(fake.matching(`/repos/${OWNER}/${REPO}/pulls`).at(-1)?.query.get('state'), 'all');
    assert.equal(page.appliedQuery, undefined);
    assert.ok(page.entries.some((entry) => entry.flags?.includes('draft')));
  });

  it('does not push author down, because the pulls endpoint cannot do it', async () => {    const { provider, fake } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), {
      query: parseQuery('author:bob'),
      limit: 100,
    });
    assert.equal(page.appliedQuery, undefined);
    assert.equal(fake.matching('/pulls').at(-1)?.query.get('creator'), null);
  });

  it('reads the diffstat, the branch and the review verdicts', async () => {
    const { provider } = await makeProvider();
    const list = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), { limit: 100 });
    const node = list.entries.find((entry) => entry.title.startsWith('#101'));
    assert.ok(node !== undefined);

    const document = await provider.read(node, {});
    const headers = new Map(document.headers);
    assert.equal(headers.get('Branch'), 'feature into main');
    assert.equal(headers.get('Changes'), '4 file(s), +42 -7');
    assert.equal(headers.get('Mergeable'), 'true');
    assert.match(document.body, /\*\*carol\*\* approved/);
    assert.match(document.body, /\*\*carol\*\* commented/);
  });

  it('leaves out reviews that say nothing', async () => {
    // A PENDING review is the viewer's own unsubmitted draft and an empty COMMENTED one is
    // the envelope GitHub wraps around inline comments; both read aloud as noise.
    const { provider } = await makeProvider();
    const list = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), { limit: 100 });
    const node = list.entries.find((entry) => entry.title.startsWith('#101'));
    const document = await provider.read(node as VNode, {});

    assert.ok(!document.body.includes('Draft note.'));
    assert.ok(!document.body.includes('dave'));
  });

  it('shows the pull request even when reviews fail to load', async () => {
    const { provider } = await makeProvider({}, { failing: '/reviews' });
    const list = await provider.list(await cd(provider, OWNER, REPO, 'pulls'), { limit: 100 });
    const document = await provider.read(list.entries[0] as VNode, {});

    assert.match(document.body, /Body of pull/);
    assert.match(document.body, /Reviews could not be loaded/);
  });
});

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

describe('discussions', () => {
  it('maps a discussion the same way an issue is mapped', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});

    const first = page.entries[0];
    // The question mark is gone: it is illegal in a filename on Windows, and the title is
    // preserved intact for display.
    assert.equal(first?.name, '2026-08-12 #7 How do I mount a private repo-.md');
    assert.equal(first?.title, '#7 How do I mount a private repo?');
    assert.equal(first?.subtype, 'discussion');
    assert.equal(first?.author, 'dana');
    assert.equal(first?.meta?.['category'], 'Q&A');
    assert.equal(first?.meta?.['upvotes'], 4);
  });

  it('drops the nulls GraphQL leaves for hidden nodes', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    assert.equal(page.entries.length, 3);
  });

  it('flags an unanswered question but not an idea', async () => {
    // `unanswered` means "the ball is in your court", which is exactly an open question in
    // a Q&A category. An Ideas post has nothing to answer, so it gets no flag at all.
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    const byTitle = new Map(page.entries.map((entry) => [entry.title, entry]));

    assert.ok(byTitle.get('#7 How do I mount a private repo?')?.flags?.includes('answered'));
    assert.ok(byTitle.get('#9 Is polling configurable?')?.flags?.includes('unanswered'));
    const idea = byTitle.get('#8 Roadmap for 2027');
    assert.ok(!(idea?.flags ?? []).includes('unanswered'));
    assert.ok(idea?.flags?.includes('locked'));
  });

  it('pages with the GraphQL cursor', async () => {
    const { provider } = await makeProvider({}, { pageDiscussions: true });
    const parent = await cd(provider, OWNER, REPO, 'discussions');

    const first = await provider.list(parent, {});
    assert.equal(first.entries.length, 2);
    assert.equal(first.total, 3);
    assert.ok(first.cursor !== undefined);

    const second = await provider.list(parent, { cursor: first.cursor as string });
    assert.equal(second.entries.length, 1);
    assert.equal(second.cursor, undefined);
  });

  it('renders the thread, indenting replies so nesting survives being read aloud', async () => {
    const { provider } = await makeProvider();
    const list = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    const document = await provider.read(list.entries[0] as VNode, {});

    const headers = new Map(document.headers);
    assert.equal(headers.get('Category'), 'Q&A');
    assert.equal(headers.get('Answered'), 'yes');
    assert.match(document.body, /\*\*heidi\*\* commented .* — marked as the answer/);
    assert.match(document.body, /^> \*\*dana\*\* replied/m);
    assert.match(document.body, /^> That worked\.$/m);
    assert.match(document.body, /^> Thanks!$/m);
  });

  it('does not fetch comments when they are switched off', async () => {
    const { provider, fake } = await makeProvider({ includeComments: false });
    const list = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    await provider.read(list.entries[0] as VNode, {});

    const request = fake.operations('Discussion').at(-1);
    assert.equal((request?.body as { variables: { comments: number } }).variables.comments, 0);
  });

  it('says how many comments were left out', async () => {
    const { provider } = await makeProvider({ includeComments: false });
    const list = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    const document = await provider.read(list.entries[0] as VNode, {});
    assert.match(document.body, /2 more comment\(s\) not shown/);
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe('projects', () => {
  it('lists an organization board under the owner', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, 'projects'), {});

    const project = page.entries[0];
    // Numbered because project titles collide freely, and the number is what the GitHub
    // URL shows.
    assert.equal(project?.name, '#3 Company roadmap');
    assert.equal(project?.kind, 'dir');
    assert.equal(project?.childCount, 2);
    assert.equal(project?.meta?.['visibility'], 'public');
  });

  it('lists a repository-linked board under the repository', async () => {
    const { provider, fake } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'projects'), {});

    assert.equal(fake.operations('RepoProjects').length, 1);
    assert.equal(page.entries[0]?.name, '#1 Release 2.0');
    assert.ok(page.entries[0]?.flags?.includes('closed'));
  });

  it('addresses items by the project id, not by where the board was listed', async () => {
    // A board reached through a repository is usually owned by the organization, so
    // re-deriving a lookup from the listing path would ask the wrong account.
    const { provider, fake } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, REPO, 'projects'), {});
    await provider.list(projects.entries[0] as VNode, {});

    const request = fake.operations('ProjectItems').at(-1);
    assert.equal((request?.body as { variables: { id: string } }).variables.id, 'PVT_repo_1');
  });

  it('flattens board fields into meta so meta:Status=Done works', async () => {
    const { provider } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});

    const card = items.entries.find((entry) => entry.title === '#1 Issue 1');
    assert.equal(card?.meta?.['Status'], 'In progress');
    assert.equal(card?.meta?.['Estimate'], '5');
    assert.equal(card?.meta?.['Due'], '2026-09-01');
    assert.equal(card?.meta?.['repository'], `${OWNER}/${REPO}`);
    assert.ok(card?.flags?.includes('open'));
  });

  it('ignores a field value whose field could not be resolved', async () => {
    // Otherwise a permission-trimmed field writes an `undefined` key into meta, which
    // `stat` then prints.
    const { provider } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});
    const card = items.entries.find((entry) => entry.title === '#1 Issue 1');

    assert.ok(!Object.keys(card?.meta ?? {}).includes('undefined'));
    assert.ok(!Object.values(card?.meta ?? {}).includes('orphan'));
  });

  it('handles a draft card, which has no number and no repository', async () => {
    const { provider } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});

    const draft = items.entries.find((entry) => entry.title === 'Write the migration note');
    assert.equal(draft?.name, '2026-08-04 Write the migration note.md');
    assert.equal(draft?.author, 'grace');
    assert.ok(draft?.flags?.includes('draft'));
    assert.ok(draft?.flags?.includes('archived'));
    assert.equal(draft?.meta?.['url'], undefined);
  });

  it('identifies a card by the card, not by the issue it quotes', async () => {
    // The same issue can sit on several boards, and each card carries its own fields.
    const { provider } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});
    assert.equal(items.entries[0]?.id, 'project-item:PVTI_1');
  });

  it('reads a card with the board fields after the fixed ones', async () => {
    const { provider } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});
    const document = await provider.read(items.entries[0] as VNode, {});

    const labels = document.headers.map(([label]) => label);
    assert.deepEqual(labels.slice(0, 2), ['Project', 'Type']);
    assert.ok(labels.indexOf('Status') > labels.indexOf('State'));
    assert.match(document.body, /Full markdown/);
    assert.equal(document.webUrl, `https://github.com/${OWNER}/${REPO}/issues/1`);
  });
});

// ---------------------------------------------------------------------------
// GraphQL failure handling
// ---------------------------------------------------------------------------

describe('GraphQL failures', () => {
  it('calls a deleted board gone rather than blaming the network', async () => {
    // GitHub answers `node(id:)` for a deleted or no-longer-visible object with a null
    // node and no `errors` array at all. That is a real answer, and reporting it as a
    // transport failure sends the reader to check their connection over a board somebody
    // archived — while an empty folder would suggest a board with no cards, which is a
    // different thing again.
    const { provider } = await makeProvider({}, { missingNode: true });
    const board = await cd(provider, OWNER, 'projects');
    const page = await provider.list(board, {});
    const first = page.entries[0];
    assert.ok(first !== undefined);

    await assert.rejects(
      () => provider.list(first, {}),
      (error: unknown) => isVfsError(error) && error.code === 'ENOENT',
    );
  });

  it('turns a missing scope into advice about the scope', async () => {
    // `read:project` is a scope nobody adds by accident, because nothing else needs it.
    const { provider } = await makeProvider(
      {},
      { graphqlError: { type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted read:project.' } },
    );
    const parent = await cd(provider, OWNER, 'projects');

    await assert.rejects(
      () => provider.list(parent, {}),
      (error: unknown) => isVfsError(error) && error.code === 'EACCES' && /read:project/.test(error.hint ?? ''),
    );
  });

  it('reports a not-found as a repository that may simply have the feature off', async () => {
    const { provider } = await makeProvider(
      {},
      { graphqlError: { type: 'NOT_FOUND', message: 'Could not resolve to a Repository.' } },
    );
    const parent = await cd(provider, OWNER, REPO, 'discussions');

    await assert.rejects(
      () => provider.list(parent, {}),
      (error: unknown) => isVfsError(error) && error.code === 'ENOENT' && /switched off/.test(error.hint ?? ''),
    );
  });

  it('shows the data that did come back when only part of the query failed', async () => {
    // Partial success is normal on GraphQL: five projects the token can see, plus an error
    // for the sixth. Treating that as a total failure hides five working boards.
    const { provider } = await makeProvider({}, { partialError: 'Resource not accessible.' });
    const page = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    assert.equal(page.entries.length, 3);
  });

  it('refuses GraphQL without a token rather than sending an anonymous request', async () => {
    const fake = createFakeGitHub();
    const provider = new GitHubProvider(
      { repos: [`${OWNER}/${REPO}`], token: '', includeDiscussions: true, transport: fake.transport },
      testContext(),
    );
    await provider.init();

    // The folder is hidden, so reach the level directly to prove the client itself refuses.
    const parent: VNode = {
      name: 'discussions',
      kind: 'dir',
      title: 'Discussions',
      id: 'x',
      meta: { level: 'discussions', owner: OWNER, repo: REPO },
    };
    await assert.rejects(
      () => provider.list(parent, {}),
      (error: unknown) => isVfsError(error) && error.code === 'EAUTH',
    );
    assert.equal(fake.matching('/graphql').length, 0);
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe('poll', () => {
  it('asks the issues endpoint for changes since the cursor', async () => {
    const { provider, fake } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO, 'issues');
    const result = await provider.poll(parent, '2026-08-11T00:00:00.000Z', {});

    assert.equal(fake.matching('/issues').at(-1)?.query.get('since'), '2026-08-11T00:00:00.000Z');
    assert.ok(result.cursor !== undefined);
    assert.ok(result.changes.every((change) => change.node?.subtype === 'issue'));
  });

  it('stops reading pull requests once they are older than the cursor', async () => {
    // The pulls endpoint has no `since`, so the window is applied locally — but the list
    // is sorted by update descending, so it can stop rather than read the whole repository.
    const { provider } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO, 'pulls');
    const result = await provider.poll(parent, '2026-08-12T00:00:00.000Z', {});

    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]?.node?.title, '#103 Pull 103');
  });

  it('detects changed discussions', async () => {
    const { provider } = await makeProvider();
    const parent = await cd(provider, OWNER, REPO, 'discussions');
    const result = await provider.poll(parent, '2026-08-11T12:00:00.000Z', {});

    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0]?.type, 'updated');
    assert.equal(result.changes[0]?.node?.title, '#7 How do I mount a private repo?');
  });

  it('says nothing changed for a level it does not watch', async () => {
    const { provider } = await makeProvider();
    const result = await provider.poll(await cd(provider, OWNER, REPO), undefined, {});
    assert.deepEqual(result.changes, []);
  });
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

describe('names', () => {
  it('never lets a slash out of a notification, which always names owner/repo', async () => {
    // A slash in a name reads as a directory level that does not exist, so the tree forks
    // one level too deep. A notification carries `owner/repo` every single time, so this
    // is not an edge case, it is every row in the folder.
    const { provider } = await makeProvider({ includeNotifications: true });
    const page = await provider.list(await cd(provider, 'notifications'), {});

    assert.ok(page.entries.length > 0);
    for (const entry of page.entries) {
      assert.ok(!entry.name.includes('/'), `name "${entry.name}" contains a slash`);
      assert.ok(!entry.name.includes('\\'), `name "${entry.name}" contains a backslash`);
    }
    assert.equal(page.entries[0]?.meta?.['repository'], `${OWNER}/${REPO}`);
  });

  it('honours a limit on notifications, which had a hard-coded page size', async () => {
    const { provider, fake } = await makeProvider({ includeNotifications: true });
    const parent = await cd(provider, 'notifications');

    const first = await provider.list(parent, { limit: 2 });
    assert.equal(first.entries.length, 2);
    assert.equal(fake.matching('/notifications').at(-1)?.query.get('per_page'), '2');
    assert.ok(first.cursor !== undefined);

    const second = await provider.list(parent, { limit: 2, cursor: first.cursor as string });
    assert.equal(second.entries.length, 2);
    const names = new Set([...first.entries, ...second.entries].map((entry) => entry.name));
    assert.equal(names.size, 4, 'a notification was returned on both pages');
  });

  it('keeps the readable title while making the name safe', async () => {
    const { provider } = await makeProvider();
    const page = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    const question = page.entries.find((entry) => entry.title.endsWith('?'));

    assert.ok(question !== undefined, 'fixture no longer has a title needing sanitizing');
    assert.ok(!/[?<>:"|*]/.test(question.name), `name "${question.name}" keeps a character Windows rejects`);
  });

  it('does not hide the .github repository most organizations have', async () => {
    // A leading dot makes an entry hidden to half the tools on the machine, and `.github`
    // is a real repository name rather than a hypothetical one. The true name is kept in
    // metadata, which is what the provider actually navigates by.
    const { provider } = await makeProvider({ repos: [`${OWNER}/.github`] });
    const page = await provider.list(await cd(provider, OWNER), {});
    const repo = page.entries.find((entry) => entry.subtype === 'repo');

    assert.equal(repo?.name, 'github');
    assert.equal(repo?.title, `${OWNER}/.github`);
    assert.equal(repo?.meta?.['repo'], '.github');
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('actions', () => {
  it('offers the web URL on every kind of item that has one', async () => {
    const { provider } = await makeProvider();

    const discussions = await provider.list(await cd(provider, OWNER, REPO, 'discussions'), {});
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});

    for (const node of [discussions.entries[0], projects.entries[0], items.entries[0]]) {
      const actions = await provider.actions(node as VNode);
      assert.deepEqual(
        actions.map((action) => action.name),
        ['url'],
      );
    }

    const result = await provider.invoke('url', discussions.entries[0] as VNode, {});
    assert.equal(result.message, `https://github.com/${OWNER}/${REPO}/discussions/7`);
  });

  it('offers nothing on a card that has no URL to show', async () => {
    const { provider } = await makeProvider();
    const projects = await provider.list(await cd(provider, OWNER, 'projects'), {});
    const items = await provider.list(projects.entries[0] as VNode, {});
    const draft = items.entries.find((entry) => entry.title === 'Write the migration note');

    assert.deepEqual(await provider.actions(draft as VNode), []);
  });
});

// ---------------------------------------------------------------------------
// Warning before the wall
// ---------------------------------------------------------------------------

describe('unavailable folders', () => {
  const NO_PROJECT_SCOPE = 'gist, read:org, repo, workflow';
  const REFUSAL = { type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes to execute this query' };

  /** Find the `projects` entry under an owner, which is where the label has to show up. */
  async function projectsFolder(provider: GitHubProvider): Promise<VNode> {
    const page = await provider.list(await cd(provider, OWNER), {});
    const found = page.entries.find((entry) => entry.name === 'projects');
    assert.ok(found !== undefined, 'the projects folder disappeared');
    return found;
  }

  it('says a token cannot read projects before the user opens the folder', async () => {
    // The whole point. Without this the first sign of trouble is an error, after a
    // navigation, in a folder that looked exactly like the ones that work.
    const { provider } = await makeProvider({}, { scopes: NO_PROJECT_SCOPE });

    assert.equal((await projectsFolder(provider)).unavailable, 'needs the read:project scope');
  });

  it('labels the repository board folder too, not just the owner one', async () => {
    const { provider } = await makeProvider({}, { scopes: NO_PROJECT_SCOPE });
    const page = await provider.list(await cd(provider, OWNER, REPO), {});

    assert.equal(page.entries.find((entry) => entry.name === 'projects')?.unavailable, 'needs the read:project scope');
  });

  it('leaves the folder alone when the token does carry the scope', async () => {
    const { provider } = await makeProvider({}, { scopes: 'repo, read:project' });

    assert.equal((await projectsFolder(provider)).unavailable, undefined);
  });

  it('treats a missing scope header as unknown rather than as no scopes', async () => {
    // Fine-grained tokens and App installations send no `x-oauth-scopes` at all. Reading
    // that silence as "no scopes" would grey out a folder that works perfectly, for every
    // user on a modern token — a worse failure than the one being fixed.
    const { provider } = await makeProvider({}, {});

    assert.equal((await projectsFolder(provider)).unavailable, undefined);
  });

  it('still throws when an unavailable folder is opened', async () => {
    // The label is a warning, not a replacement for the error. Anything else would leave
    // scripts and pipes to infer failure from an empty listing.
    const { provider } = await makeProvider({}, { scopes: NO_PROJECT_SCOPE, graphqlError: REFUSAL });
    const folder = await projectsFolder(provider);

    await assert.rejects(
      () => provider.list(folder, {}),
      (error: unknown) => isVfsError(error) && error.code === 'EACCES',
    );
  });

  it('remembers a refusal it was not warned about', async () => {
    // No scope header, so the probe learns nothing and the first listing is a normal
    // failure. What must not happen is the second listing looking just as inviting.
    const { provider } = await makeProvider({}, { graphqlError: REFUSAL });
    const folder = await projectsFolder(provider);
    assert.equal(folder.unavailable, undefined);

    await assert.rejects(() => provider.list(folder, {}));

    assert.equal((await projectsFolder(provider)).unavailable, 'needs the read:project scope');
  });

  it('names SSO enforcement rather than blaming the scope', async () => {
    // Same 403, unrelated fix: `gh auth refresh` does nothing here, and sending the user
    // to it wastes the one piece of guidance the row has room for.
    const { provider } = await makeProvider(
      {},
      { graphqlError: { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' } },
    );
    await assert.rejects(async () => provider.list(await projectsFolder(provider), {}));

    assert.equal((await projectsFolder(provider)).unavailable, 'this token is not SSO-authorized for this organization');
  });

  it('forgets the warning once a listing succeeds', async () => {
    // A token can be refreshed without restarting the shell, and the scope probe is a
    // heuristic. A label the user cannot clear by fixing the problem is just wrong.
    const fake = createFakeGitHub({ scopes: NO_PROJECT_SCOPE });
    const provider = new GitHubProvider(
      { repos: [`${OWNER}/${REPO}`], token: 'fake-token', transport: fake.transport },
      testContext(),
    );
    await provider.init();
    assert.equal((await projectsFolder(provider)).unavailable, 'needs the read:project scope');

    await provider.list(await projectsFolder(provider), {});

    assert.equal((await projectsFolder(provider)).unavailable, undefined);
  });

  it('does not mark the folder over a rate limit or an outage', async () => {
    // A blip says nothing about whether the folder is readable. Latching on one would
    // leave a permanent warning about a problem that fixed itself.
    const { provider } = await makeProvider({}, { failing: '/graphql' });
    await assert.rejects(async () => provider.list(await projectsFolder(provider), {}));

    assert.equal((await projectsFolder(provider)).unavailable, undefined);
  });

  it('matches is:unavailable so a warning can be searched for', async () => {
    const { provider } = await makeProvider({}, { scopes: NO_PROJECT_SCOPE });
    const query = parseQuery('is:unavailable');
    const page = await provider.list(await cd(provider, OWNER), {});

    assert.deepEqual(
      page.entries.filter((entry) => evaluateQuery(query, entry) === true).map((entry) => entry.name),
      ['projects'],
    );
  });

  it('does not hold up startup waiting for the answer', async () => {
    // Mounts are built one after another, so a request awaited in `init` delays the shell
    // for this mount *and* every one behind it. A warning does not get to cost that. The
    // probe is collected where it is used instead, which is why the label still arrives.
    const fake = createFakeGitHub({ scopes: NO_PROJECT_SCOPE });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider = new GitHubProvider(
      {
        repos: [`${OWNER}/${REPO}`],
        token: 'fake-token',
        transport: async (url, init) => {
          if (new URL(url).pathname === '/rate_limit') await held;
          return fake.transport(url, init);
        },
      },
      testContext(),
    );

    await provider.init();
    assert.equal(fake.matching('/rate_limit').length, 0, 'init waited for the probe');

    release();
    assert.equal((await projectsFolder(provider)).unavailable, 'needs the read:project scope');
  });
});

describe('unavailable folders, keyed to what the reason covers', () => {
  const SAML = 'Resource protected by organization SAML enforcement.';

  /** A mount over two owners, where GraphQL refuses exactly one of them. */
  function twoOwners(refuse: string): { provider: GitHubProvider; fake: FakeGitHub } {
    const fake = createFakeGitHub();
    const provider = new GitHubProvider(
      {
        owners: ['orga', 'orgb'],
        token: 'fake-token',
        transport: async (url, init) => {
          if (new URL(url).pathname === '/graphql') {
            const body = JSON.parse(String(init.body)) as { variables?: Record<string, unknown> };
            if (body.variables?.['login'] === refuse) {
              return new Response(JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: SAML }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            return new Response(
              JSON.stringify({
                data: { repositoryOwner: { projectsV2: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return fake.transport(url, init);
        },
      },
      testContext(),
    );
    return { provider, fake };
  }

  async function labelFor(provider: GitHubProvider, owner: string): Promise<string | undefined> {
    const page = await provider.list(await cd(provider, owner), {});
    return page.entries.find((entry) => entry.name === 'projects')?.unavailable;
  }

  it('does not let one organization speak for another', async () => {
    // SAML enforcement, OAuth-app restrictions and board visibility are all decided per
    // organization. A single mount-wide flag would grey out a folder that works perfectly.
    const { provider } = twoOwners('orga');
    await provider.init();

    await assert.rejects(async () => provider.list(await cd(provider, 'orga', 'projects'), {}));

    assert.equal(await labelFor(provider, 'orga'), 'this token is not SSO-authorized for this organization');
    assert.equal(await labelFor(provider, 'orgb'), undefined, 'orgb was blamed for orga');
  });

  it('does not let one organization clear another', async () => {
    // The same bug in the other direction, and the worse half: a success elsewhere silently
    // deleting a true warning leaves the user walking back into the error it was for.
    const { provider } = twoOwners('orga');
    await provider.init();
    await assert.rejects(async () => provider.list(await cd(provider, 'orga', 'projects'), {}));

    await provider.list(await cd(provider, 'orgb', 'projects'), {});

    assert.equal(await labelFor(provider, 'orga'), 'this token is not SSO-authorized for this organization');
  });

  it('does not treat a half-refused answer as proof of access', async () => {
    // GraphQL answers a partly-forbidden query with data *and* errors, and the client does
    // not throw on that, so the boards the token cannot see arrive as an empty connection.
    // Reading that as success deletes the warning and shows an empty folder instead: a
    // listing that looks fine and is wrong, which is worse than the error it replaced.
    const fake = createFakeGitHub({ scopes: 'repo' });
    const provider = new GitHubProvider(
      {
        repos: [`${OWNER}/${REPO}`],
        token: 'fake-token',
        transport: async (url, init) => {
          if (new URL(url).pathname === '/graphql') {
            return new Response(
              JSON.stringify({
                data: { repositoryOwner: { projectsV2: null } },
                errors: [{ type: 'FORBIDDEN', message: SAML }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return fake.transport(url, init);
        },
      },
      testContext(),
    );
    await provider.init();

    const page = await provider.list(await cd(provider, OWNER, 'projects'), {});
    assert.deepEqual(page.entries, [], 'the fixture changed');

    const label = (await provider.list(await cd(provider, OWNER), {})).entries.find((e) => e.name === 'projects');
    assert.equal(label?.unavailable, 'needs the read:project scope');
  });

  it('does not latch a secondary rate limit as a permission problem', async () => {
    // The secondary limit fires on burst rather than quota, so it arrives as a 403 with a
    // healthy `x-ratelimit-remaining` and is otherwise indistinguishable from a refusal.
    // Latching it would assert something about the token that the scope probe disproved.
    const fake = createFakeGitHub({ scopes: 'repo, read:project' });
    const provider = new GitHubProvider(
      {
        repos: [`${OWNER}/${REPO}`],
        token: 'fake-token',
        transport: async (url, init) => {
          if (new URL(url).pathname === '/graphql') {
            return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
              status: 403,
              headers: { 'content-type': 'application/json', 'retry-after': '60', 'x-ratelimit-remaining': '4831' },
            });
          }
          return fake.transport(url, init);
        },
      },
      testContext(),
    );
    await provider.init();

    await assert.rejects(
      async () => provider.list(await cd(provider, OWNER, 'projects'), {}),
      (error: unknown) => isVfsError(error) && error.code === 'ERATELIMIT',
    );

    const label = (await provider.list(await cd(provider, OWNER), {})).entries.find((e) => e.name === 'projects');
    assert.equal(label?.unavailable, undefined, 'a passing blip became a permanent warning');
  });
});
