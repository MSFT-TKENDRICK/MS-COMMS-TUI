/**
 * A fake GitHub, served over the provider's `FetchLike` seam.
 *
 * The provider talks to GitHub and nothing else, so the only honest way to test it offline
 * is to answer its requests with the shapes the real service returns. Both APIs are here
 * because the provider needs both: issues, pull requests and notifications are REST, while
 * discussions and Projects v2 exist only on GraphQL.
 *
 * It is deliberately faithful in the places the provider makes non-obvious assumptions:
 *
 *   - `/issues` returns pull requests too, each carrying a `pull_request` key, because the
 *     real endpoint does. That is what makes the "listing pulls from /issues pages badly"
 *     regression detectable rather than theoretical.
 *   - `/pulls` has no `comments` count and `/issues` has no `head`, matching the real
 *     divergence between the two payloads.
 *   - Paging is by RFC 5988 `Link` header on REST and by `pageInfo` on GraphQL, so cursor
 *     handling is exercised in both dialects.
 *   - GraphQL failures come back as HTTP 200 with an `errors` array, which is the shape
 *     that makes naive clients report success.
 *
 * Timestamps are all at midday UTC rather than midnight. Names are dated in local time, so
 * a midnight-UTC fixture lands on the previous day for anyone west of Greenwich and the
 * suite passes or fails depending on where it is run.
 *
 * Every request is recorded so tests can assert on traffic — which endpoint a folder used,
 * that a query was pushed down, that comments were not fetched when switched off.
 */

import { MemoryStateStore, NULL_LOGGER, type ProviderContext } from '@mscomms/core';

import type { FetchLike } from '../client.js';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** GraphQL operation name, when the request was a GraphQL one. */
  readonly operation?: string;
}

export interface FakeGitHub {
  readonly transport: FetchLike;
  readonly requests: RecordedRequest[];
  /** Requests whose path contains the given fragment. */
  matching(fragment: string): RecordedRequest[];
  /** The GraphQL requests that ran the named operation. */
  operations(name: string): RecordedRequest[];
}

export const OWNER = 'octocat';
export const REPO = 'hello-world';
export const BASE = 'https://api.github.com';

/** A provider context with no disk, no network and no real secret store. */
export function testContext(mountPath = '/gh'): ProviderContext {
  return {
    mountPath,
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '.',
    // Echoes the reference back, so `token` resolves without touching the environment.
    secret: (ref: string) => Promise.resolve(ref),
  };
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

function issue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1000 + number,
    number,
    title: `Issue ${String(number)}`,
    body: `Body of issue ${String(number)}.\nSecond line.`,
    state: 'open',
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${String(number)}`,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: `2026-08-${String(10 + number).padStart(2, '0')}T10:00:00Z`,
    comments: 0,
    user: { login: 'alice' },
    labels: [{ name: 'bug' }],
    assignees: [],
    ...overrides,
  };
}

function pull(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2000 + number,
    number,
    title: `Pull ${String(number)}`,
    body: `Body of pull ${String(number)}.`,
    state: 'open',
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${String(number)}`,
    created_at: '2026-08-02T10:00:00Z',
    // Spelled out per pull request rather than derived from the number: arithmetic on a
    // number like 101 quietly produces `2026-08-111`, and an invalid Date does not
    // complain until something far away calls `toISOString` on it.
    updated_at: '2026-08-10T11:00:00Z',
    draft: false,
    merged_at: null,
    user: { login: 'bob' },
    labels: [],
    assignees: [],
    requested_reviewers: [{ login: 'carol' }],
    head: { ref: 'feature' },
    base: { ref: 'main' },
    ...overrides,
  };
}

/** Twelve issues and three pull requests: enough that filtering `/issues` pages badly. */
const ISSUES = [
  ...Array.from({ length: 12 }, (_, i) => issue(i + 1)),
  ...Array.from({ length: 3 }, (_, i) =>
    issue(100 + i, {
      title: `Pull ${String(100 + i)}`,
      pull_request: { url: `${BASE}/repos/${OWNER}/${REPO}/pulls/${String(100 + i)}` },
    }),
  ),
];

const PULLS = [
  pull(101),
  pull(102, {
    state: 'closed',
    merged_at: '2026-08-09T12:00:00Z',
    merged: true,
    updated_at: '2026-08-11T11:00:00Z',
  }),
  pull(103, { draft: true, requested_reviewers: [], updated_at: '2026-08-13T11:00:00Z' }),
];

/** Six, so a `limit` smaller than the folder is a meaningful thing to ask for. */
const NOTIFICATIONS = Array.from({ length: 6 }, (_, i) => ({
  id: `n${String(i + 1)}`,
  unread: i % 2 === 0,
  reason: 'mention',
  updated_at: `2026-08-${String(12 - i).padStart(2, '0')}T08:00:00Z`,
  subject: {
    title: `You were mentioned ${String(i + 1)}`,
    url: `${BASE}/repos/${OWNER}/${REPO}/issues/1`,
    type: 'Issue',
  },
  repository: { full_name: `${OWNER}/${REPO}` },
}));

const DISCUSSIONS = [
  {
    id: 'D_1',
    number: 7,
    title: 'How do I mount a private repo?',
    bodyText: 'I have a token but nothing shows up.',
    url: `https://github.com/${OWNER}/${REPO}/discussions/7`,
    createdAt: '2026-08-05T09:00:00Z',
    updatedAt: '2026-08-12T09:00:00Z',
    upvoteCount: 4,
    locked: false,
    isAnswered: true,
    author: { login: 'dana' },
    category: { name: 'Q&A', slug: 'q-a', emoji: ':question:', isAnswerable: true },
    comments: { totalCount: 2 },
  },
  {
    id: 'D_2',
    number: 8,
    title: 'Roadmap for 2027',
    bodyText: 'What is planned next?',
    url: `https://github.com/${OWNER}/${REPO}/discussions/8`,
    createdAt: '2026-08-06T09:00:00Z',
    updatedAt: '2026-08-11T09:00:00Z',
    upvoteCount: 0,
    locked: true,
    isAnswered: false,
    author: { login: 'erin' },
    category: { name: 'Ideas', slug: 'ideas', emoji: ':bulb:', isAnswerable: false },
    comments: { totalCount: 0 },
  },
  {
    id: 'D_3',
    number: 9,
    title: 'Is polling configurable?',
    bodyText: 'Asking about refresh intervals.',
    url: `https://github.com/${OWNER}/${REPO}/discussions/9`,
    createdAt: '2026-08-07T09:00:00Z',
    updatedAt: '2026-08-10T09:00:00Z',
    upvoteCount: 1,
    locked: false,
    isAnswered: false,
    author: { login: 'frank' },
    category: { name: 'Q&A', slug: 'q-a', emoji: ':question:', isAnswerable: true },
    comments: { totalCount: 0 },
  },
];

const OWNER_PROJECTS = [
  {
    id: 'PVT_owner_1',
    number: 3,
    title: 'Company roadmap',
    url: `https://github.com/orgs/${OWNER}/projects/3`,
    closed: false,
    public: true,
    shortDescription: 'Everything in flight.',
    createdAt: '2026-01-01T12:00:00Z',
    updatedAt: '2026-08-12T12:00:00Z',
    items: { totalCount: 2 },
  },
];

const REPO_PROJECTS = [
  {
    id: 'PVT_repo_1',
    number: 1,
    title: 'Release 2.0',
    url: `https://github.com/${OWNER}/${REPO}/projects/1`,
    closed: true,
    public: false,
    shortDescription: null,
    createdAt: '2026-02-01T12:00:00Z',
    updatedAt: '2026-07-01T12:00:00Z',
    items: { totalCount: 1 },
  },
];

function statusField(name: string) {
  return { __typename: 'ProjectV2ItemFieldSingleSelectValue', name, field: { name: 'Status' } };
}

const PROJECT_ITEMS: Record<string, unknown[]> = {
  PVT_owner_1: [
    {
      id: 'PVTI_1',
      type: 'ISSUE',
      isArchived: false,
      createdAt: '2026-08-01T12:00:00Z',
      updatedAt: '2026-08-11T12:00:00Z',
      fieldValues: {
        nodes: [
          statusField('In progress'),
          { __typename: 'ProjectV2ItemFieldNumberValue', number: 5, field: { name: 'Estimate' } },
          { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-09-01', field: { name: 'Due' } },
          // A value whose field could not be resolved; the flattener must skip it rather
          // than write an `undefined` key into meta.
          { __typename: 'ProjectV2ItemFieldTextValue', text: 'orphan', field: null },
        ],
      },
      content: {
        __typename: 'Issue',
        number: 1,
        title: 'Issue 1',
        bodyText: 'Body of issue 1.',
        url: `https://github.com/${OWNER}/${REPO}/issues/1`,
        state: 'OPEN',
        createdAt: '2026-08-01T10:00:00Z',
        updatedAt: '2026-08-11T10:00:00Z',
        author: { login: 'alice' },
        repository: { nameWithOwner: `${OWNER}/${REPO}` },
      },
    },
    {
      id: 'PVTI_2',
      type: 'DRAFT_ISSUE',
      isArchived: true,
      createdAt: '2026-08-03T12:00:00Z',
      updatedAt: '2026-08-04T12:00:00Z',
      fieldValues: { nodes: [statusField('Todo')] },
      content: {
        __typename: 'DraftIssue',
        title: 'Write the migration note',
        bodyText: 'Nobody has claimed this yet.',
        createdAt: '2026-08-03T12:00:00Z',
        updatedAt: '2026-08-04T12:00:00Z',
        creator: { login: 'grace' },
      },
    },
  ],
  PVT_repo_1: [
    {
      id: 'PVTI_3',
      type: 'PULL_REQUEST',
      isArchived: false,
      createdAt: '2026-08-02T12:00:00Z',
      updatedAt: '2026-08-09T12:00:00Z',
      fieldValues: { nodes: [statusField('Done')] },
      content: {
        __typename: 'PullRequest',
        number: 102,
        title: 'Pull 102',
        bodyText: 'Body of pull 102.',
        url: `https://github.com/${OWNER}/${REPO}/pull/102`,
        state: 'MERGED',
        isDraft: false,
        merged: true,
        createdAt: '2026-08-02T10:00:00Z',
        updatedAt: '2026-08-09T12:00:00Z',
        author: { login: 'bob' },
        repository: { nameWithOwner: `${OWNER}/${REPO}` },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export interface FakeOptions {
  /** Answer every GraphQL request with this error type instead of data. */
  readonly graphqlError?: { type: string; message: string };
  /** Return data *and* an error, the partial-success shape. */
  readonly partialError?: string;
  /** Serve discussions one page at a time, so cursor handling is exercised. */
  readonly pageDiscussions?: boolean;
  /** Fail every request to a path containing this fragment with a 500. */
  readonly failing?: string;
  /** Answer `node(id:)` queries with a null node and no errors, as GitHub does for a
   * board that has been deleted since the folder was listed. */
  readonly missingNode?: boolean;
}

export function createFakeGitHub(options: FakeOptions = {}): FakeGitHub {
  const requests: RecordedRequest[] = [];

  const transport: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const method = (init.method ?? 'GET').toUpperCase();
    const body: unknown = init.body === undefined ? undefined : JSON.parse(String(init.body));

    const record: RecordedRequest = {
      method,
      url: rawUrl,
      path: url.pathname,
      query: url.searchParams,
      body,
      ...(url.pathname === '/graphql'
        ? { operation: operationName(String((body as { query?: string }).query ?? '')) }
        : {}),
    };
    requests.push(record);

    if (options.failing !== undefined && url.pathname.includes(options.failing)) {
      return json({ message: 'Server Error' }, 500);
    }

    return url.pathname === '/graphql' ? graphql(record, options) : rest(url, options);
  };

  return {
    transport,
    requests,
    matching: (fragment) => requests.filter((r) => r.path.includes(fragment)),
    operations: (name) => requests.filter((r) => r.operation === name),
  };
}

function rest(url: URL, _options: FakeOptions): Response {
  const path = url.pathname;
  const repo = `/repos/${OWNER}/${REPO}`;

  if (path === '/notifications') {
    const perPage = Number(url.searchParams.get('per_page') ?? '50');
    const page = Number(url.searchParams.get('page') ?? '1');
    const start = (page - 1) * perPage;
    const slice = NOTIFICATIONS.slice(start, start + perPage);
    const more = start + perPage < NOTIFICATIONS.length;
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    return json(slice, 200, more ? { link: `<${next.toString()}>; rel="next"` } : {});
  }

  if (path === `${repo}/issues`) {
    // Paged the way GitHub pages: a slice plus a Link header when more exist.
    const perPage = Number(url.searchParams.get('per_page') ?? '50');
    const page = Number(url.searchParams.get('page') ?? '1');
    const state = url.searchParams.get('state') ?? 'open';
    const creator = url.searchParams.get('creator');

    let items = ISSUES.filter((i) => state === 'all' || i['state'] === state);
    if (creator !== null) items = items.filter((i) => (i['user'] as { login: string }).login === creator);

    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    const more = start + perPage < items.length;
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    return json(slice, 200, more ? { link: `<${next.toString()}>; rel="next"` } : {});
  }

  if (path === `${repo}/pulls`) {
    const state = url.searchParams.get('state') ?? 'open';
    const items = PULLS.filter((p) => {
      if (state === 'all') return true;
      return p['state'] === state;
    });
    // The real endpoint honours `sort=updated&direction=desc`, and `poll` depends on that
    // order to stop early. A fake that returns insertion order lets a broken early exit
    // pass, which is the one thing this fixture exists to catch.
    const direction = url.searchParams.get('direction') ?? 'desc';
    if (url.searchParams.get('sort') === 'updated') {
      items.sort((a, b) => {
        const at = String(a['updated_at']);
        const bt = String(b['updated_at']);
        return direction === 'asc' ? at.localeCompare(bt) : bt.localeCompare(at);
      });
    }
    return json(items);
  }

  const issueMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const found = ISSUES.find((i) => i['number'] === number);
    return found === undefined ? json({ message: 'Not Found' }, 404) : json(found);
  }

  if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) {
    return json([
      { id: 1, body: 'First comment.', created_at: '2026-08-11T12:00:00Z', user: { login: 'carol' } },
    ]);
  }

  const pullMatch = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]);
    const found = PULLS.find((p) => p['number'] === number);
    if (found === undefined) return json({ message: 'Not Found' }, 404);
    // The detail endpoint adds the computed fields the list endpoint omits.
    return json({
      ...found,
      merged: found['merged_at'] !== null,
      mergeable: found['state'] === 'open' ? true : null,
      comments: 1,
      review_comments: 0,
      commits: 3,
      additions: 42,
      deletions: 7,
      changed_files: 4,
    });
  }

  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(path)) {
    return json([
      { id: 1, body: 'Looks good.', state: 'APPROVED', submitted_at: '2026-08-11T13:00:00Z', user: { login: 'carol' } },
      { id: 2, body: '', state: 'COMMENTED', submitted_at: '2026-08-11T13:05:00Z', user: { login: 'dave' } },
      { id: 3, body: 'Draft note.', state: 'PENDING', submitted_at: null, user: { login: 'erin' } },
    ]);
  }

  return json({ message: 'Not Found' }, 404);
}

function graphql(record: RecordedRequest, options: FakeOptions): Response {
  if (options.graphqlError !== undefined) {
    return json({ data: null, errors: [options.graphqlError] });
  }

  // A `node(id:)` that resolves to nothing. GitHub answers a deleted or no-longer-visible
  // object with exactly this — a null node and *no* `errors` array — so it is a real
  // answer meaning "gone", not a transport failure.
  if (options.missingNode === true && record.operation?.startsWith('Project') === true) {
    return json({ data: { node: null } });
  }

  const variables = ((record.body as { variables?: Record<string, unknown> }).variables ?? {}) as Record<string, unknown>;
  const errors = options.partialError === undefined ? [] : [{ type: 'FORBIDDEN', message: options.partialError }];

  switch (record.operation) {
    case 'Discussions': {
      if (options.pageDiscussions === true) {
        const after = variables['after'] as string | null;
        const start = after === null || after === undefined ? 0 : Number(after);
        const slice = DISCUSSIONS.slice(start, start + 2);
        const end = start + slice.length;
        return json({
          data: {
            repository: {
              discussions: {
                totalCount: DISCUSSIONS.length,
                pageInfo: { hasNextPage: end < DISCUSSIONS.length, endCursor: String(end) },
                nodes: slice,
              },
            },
          },
          errors,
        });
      }
      return json({
        data: {
          repository: {
            discussions: {
              totalCount: DISCUSSIONS.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              // A null entry, which GraphQL uses for nodes the viewer may not see.
              nodes: [...DISCUSSIONS, null],
            },
          },
        },
        errors,
      });
    }

    case 'Discussion': {
      const number = Number(variables['number']);
      const summary = DISCUSSIONS.find((d) => d.number === number);
      if (summary === undefined) return json({ data: { repository: { discussion: null } }, errors });
      const wanted = Number(variables['comments'] ?? 0);
      const comments =
        wanted === 0
          ? []
          : [
              {
                id: 'DC_1',
                body: 'Set GITHUB_TOKEN and try again.',
                createdAt: '2026-08-11T10:00:00Z',
                upvoteCount: 2,
                isAnswer: true,
                author: { login: 'heidi' },
                replies: {
                  totalCount: 1,
                  nodes: [
                    {
                      id: 'DR_1',
                      body: 'That worked.\nThanks!',
                      createdAt: '2026-08-11T11:00:00Z',
                      author: { login: 'dana' },
                    },
                  ],
                },
              },
            ];
      return json({
        data: {
          repository: {
            discussion: {
              ...summary,
              body: `${summary.bodyText}\n\nMore detail.`,
              answer: summary.isAnswered ? { id: 'DC_1' } : null,
              comments: {
                totalCount: summary.comments.totalCount,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: comments,
              },
            },
          },
        },
        errors,
      });
    }

    case 'OwnerProjects':
      return json({
        data: {
          repositoryOwner: {
            __typename: 'Organization',
            projectsV2: {
              totalCount: OWNER_PROJECTS.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: OWNER_PROJECTS,
            },
          },
        },
        errors,
      });

    case 'RepoProjects':
      return json({
        data: {
          repository: {
            projectsV2: {
              totalCount: REPO_PROJECTS.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: REPO_PROJECTS,
            },
          },
        },
        errors,
      });

    case 'ProjectItems': {
      const items = PROJECT_ITEMS[String(variables['id'])] ?? [];
      return json({
        data: {
          node: {
            id: variables['id'],
            title: 'Board',
            items: {
              totalCount: items.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: items,
            },
          },
        },
        errors,
      });
    }

    case 'ProjectItemBody': {
      const id = String(variables['id']);
      const item = Object.values(PROJECT_ITEMS)
        .flat()
        .find((entry) => (entry as { id: string }).id === id);
      if (item === undefined) return json({ data: { node: null }, errors });
      const typed = item as { id: string; fieldValues: unknown; content: Record<string, unknown> };
      return json({
        data: {
          node: {
            id: typed.id,
            fieldValues: typed.fieldValues,
            content: { ...typed.content, body: `${String(typed.content['bodyText'])}\n\nFull markdown.` },
          },
        },
        errors,
      });
    }

    default:
      return json({ data: null, errors: [{ type: 'BAD_REQUEST', message: `Unknown operation ${String(record.operation)}` }] });
  }
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The operation name out of a query document, so the fake can route on it. */
function operationName(query: string): string {
  return /query\s+(\w+)/.exec(query)?.[1] ?? '';
}
