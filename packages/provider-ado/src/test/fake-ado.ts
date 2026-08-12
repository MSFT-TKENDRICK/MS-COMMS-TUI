/**
 * A fake Azure DevOps organization, served over the provider's `FetchLike` seam.
 *
 * The provider talks to Azure DevOps and nothing else, so the only honest way to test it
 * offline is to answer its HTTP requests with the shapes the real service returns. That is
 * what this is: a small routing table over fixture data, deliberately faithful in the three
 * places the provider makes non-obvious assumptions —
 *
 *   - WIQL is actually evaluated, from the statement text. A statement that scopes to the
 *     wrong project or forgets the board column returns the wrong ids here, exactly as it
 *     would in production, so `wiql.ts` is tested through the provider rather than only in
 *     isolation.
 *   - The work item batch endpoint answers in a different order than it was asked, because
 *     the real one makes no ordering promise and the provider is supposed to re-sort.
 *   - `api-version` is required on every request, as the service requires it.
 *
 * Every request is recorded so tests can assert on traffic — that paging re-runs the query,
 * that batching respects the 200-id ceiling, that a preview api-version is used for
 * comments.
 */

import { VfsError, MemoryStateStore, NULL_LOGGER, type ProviderContext } from '@mscomms/core';

import type { FetchLike } from '../client.js';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface FakeAdo {
  readonly transport: FetchLike;
  readonly requests: RecordedRequest[];
  /** Requests whose path ends with the given suffix, case-insensitively. */
  matching(suffix: string): RecordedRequest[];
}

interface FakeWorkItem {
  readonly id: number;
  readonly fields: Record<string, unknown>;
}

export const ORG_URL = 'https://dev.azure.com/contoso';
export const PROJECT = 'Contoso Works';
export const TEAM = 'Platform Team';
export const BOARD_ID = 'b1';
export const ME = 'me@contoso.example';

/** A provider context with no disk, no network and no real secret store. */
export function testContext(mountPath = '/ado'): ProviderContext {
  return {
    mountPath,
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '.',
    // Echoes the reference back, so `token` resolves without touching the environment.
    secret: (ref: string) => Promise.resolve(ref),
  };
}

const projects = [
  { id: 'p1', name: PROJECT, description: 'The main project', lastUpdateTime: '2026-08-01T09:00:00Z' },
  { id: 'p2', name: 'Archive', lastUpdateTime: '2025-01-02T09:00:00Z' },
];

const teams = [
  { id: 't1', name: TEAM, description: 'Owns the platform' },
  { id: 't2', name: 'Design' },
];

const boards = [
  { id: BOARD_ID, name: 'Stories' },
  { id: 'b2', name: 'Features' },
];

const columns = [
  { id: 'c1', name: 'New', itemLimit: 0, columnType: 'incoming' },
  { id: 'c2', name: 'Active', itemLimit: 5, columnType: 'inProgress' },
  { id: 'c3', name: 'Done', itemLimit: 0, columnType: 'outgoing' },
];

/**
 * Seven items in Active so a page size of two forces at least three real pages, plus items
 * in other columns and other projects that must never leak into a column listing.
 */
const workItems: readonly FakeWorkItem[] = [
  item(1, {
    title: 'Ship the board provider',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-11T10:00:00Z',
    created: '2026-08-01T10:00:00Z',
    createdBy: 'Dana Scully',
    assignedTo: 'Dana Scully',
    description: '<div>Boards should be <b>directories</b>.</div>',
    tags: 'platform; vfs',
    comments: 2,
    priority: 1,
  }),
  item(2, {
    title: "Column names with 'quotes'",
    column: 'Active',
    state: 'Active',
    changed: '2026-08-10T10:00:00Z',
    created: '2026-08-02T10:00:00Z',
    createdBy: 'Fox Mulder',
    type: 'Bug',
    repro: '<p>Open the board. It explodes.</p>',
  }),
  item(3, {
    title: 'Unassigned work',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-09T10:00:00Z',
    created: '2026-08-03T10:00:00Z',
    createdBy: 'Dana Scully',
    assignedTo: undefined,
  }),
  item(4, {
    title: 'Fourth item',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-08T10:00:00Z',
    created: '2026-08-04T10:00:00Z',
    createdBy: 'Fox Mulder',
    assignedTo: 'Dana Scully',
  }),
  item(5, {
    title: 'Fifth item',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-07T10:00:00Z',
    created: '2026-08-05T10:00:00Z',
    createdBy: 'Dana Scully',
  }),
  item(6, {
    title: 'Sixth item',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-06T10:00:00Z',
    created: '2026-08-05T11:00:00Z',
    createdBy: 'Dana Scully',
    assignedTo: 'Dana Scully',
  }),
  item(7, {
    title: 'Seventh item',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-05T10:00:00Z',
    created: '2026-08-05T12:00:00Z',
    createdBy: 'Fox Mulder',
  }),
  item(8, {
    title: 'Already finished',
    column: 'Done',
    state: 'Closed',
    changed: '2026-08-04T10:00:00Z',
    created: '2026-07-04T10:00:00Z',
    createdBy: 'Dana Scully',
    assignedTo: 'Dana Scully',
    boardColumnDone: true,
  }),
  item(9, {
    title: 'Somebody else\u2019s project',
    column: 'Active',
    state: 'Active',
    changed: '2026-08-11T11:00:00Z',
    created: '2026-08-01T10:00:00Z',
    createdBy: 'Dana Scully',
    project: 'Archive',
  }),
];

interface ItemSpec {
  readonly title: string;
  readonly column: string;
  readonly state: string;
  readonly changed: string;
  readonly created: string;
  readonly createdBy: string;
  readonly assignedTo?: string | undefined;
  readonly type?: string;
  readonly description?: string;
  readonly repro?: string;
  readonly tags?: string;
  readonly comments?: number;
  readonly priority?: number;
  readonly project?: string;
  readonly boardColumnDone?: boolean;
}

function item(id: number, spec: ItemSpec): FakeWorkItem {
  const fields: Record<string, unknown> = {
    'System.Id': id,
    'System.Title': spec.title,
    'System.WorkItemType': spec.type ?? 'User Story',
    'System.State': spec.state,
    'System.BoardColumn': spec.column,
    'System.BoardColumnDone': spec.boardColumnDone ?? false,
    'System.TeamProject': spec.project ?? PROJECT,
    'System.CreatedBy': person(spec.createdBy),
    'System.CreatedDate': spec.created,
    'System.ChangedDate': spec.changed,
    'System.ChangedBy': person(spec.createdBy),
    'System.AreaPath': `${spec.project ?? PROJECT}\\Platform`,
    'System.IterationPath': `${spec.project ?? PROJECT}\\Sprint 3`,
    'System.CommentCount': spec.comments ?? 0,
  };
  if (spec.assignedTo !== undefined) fields['System.AssignedTo'] = person(spec.assignedTo);
  if (spec.description !== undefined) fields['System.Description'] = spec.description;
  if (spec.repro !== undefined) fields['Microsoft.VSTS.TCM.ReproSteps'] = spec.repro;
  if (spec.tags !== undefined) fields['System.Tags'] = spec.tags;
  if (spec.priority !== undefined) fields['Microsoft.VSTS.Common.Priority'] = spec.priority;
  return { id, fields };
}

function person(displayName: string): Record<string, string> {
  return {
    displayName,
    uniqueName: displayName === 'Dana Scully' ? ME : `${displayName.split(' ')[0]?.toLowerCase() ?? 'x'}@contoso.example`,
  };
}

export function createFakeAdo(): FakeAdo {
  const requests: RecordedRequest[] = [];

  const transport: FetchLike = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const path = decodeURIComponent(url.pathname).replace(/^\/contoso/, '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({
      method: init.method ?? 'GET',
      url: rawUrl,
      path,
      query: url.searchParams,
      body,
    });

    if (url.searchParams.get('api-version') === null) {
      return json({ message: 'The api-version query parameter is required.' }, 400);
    }

    return route(path, init.method ?? 'GET', body);
  };

  return {
    transport,
    requests,
    matching: (suffix) =>
      requests.filter((request) => request.path.toLowerCase().endsWith(suffix.toLowerCase())),
  };
}

function route(path: string, method: string, body: unknown): Response {
  const lower = path.toLowerCase();

  if (lower === '/_apis/projects') {
    return json({ count: projects.length, value: projects });
  }

  const teamsMatch = /^\/_apis\/projects\/(.+)\/teams$/i.exec(path);
  if (teamsMatch !== null) {
    if (teamsMatch[1] !== PROJECT && teamsMatch[1] !== 'Archive') return notFound(path);
    return json({ count: teams.length, value: teams });
  }

  const boardMatch = /^\/(.+)\/(.+)\/_apis\/work\/boards\/(.+)$/i.exec(path);
  if (boardMatch !== null) {
    if (boardMatch[3] !== BOARD_ID && boardMatch[3] !== 'b2') return notFound(path);
    return json({ id: boardMatch[3], name: 'Stories', columns });
  }

  const boardsMatch = /^\/(.+)\/(.+)\/_apis\/work\/boards$/i.exec(path);
  if (boardsMatch !== null) {
    if (boardsMatch[2] !== TEAM && boardsMatch[2] !== 'Design') return notFound(path);
    return json({ count: boards.length, value: boards });
  }

  if (lower.endsWith('/_apis/wit/wiql') && method === 'POST') {
    const statement = String((body as { query?: unknown } | undefined)?.query ?? '');
    return json({ workItems: evaluateWiql(statement).map((entry) => ({ id: entry.id })) });
  }

  if (lower === '/_apis/wit/workitemsbatch' && method === 'POST') {
    const request = body as { ids?: number[]; fields?: string[] } | undefined;
    const ids = request?.ids ?? [];
    if (ids.length > 200) return json({ message: 'Too many ids requested.' }, 400);
    const selected = workItems.filter((entry) => ids.includes(entry.id));
    // Deliberately not in request order: the real endpoint makes no such promise.
    const value = [...selected].reverse().map((entry) => project(entry, request?.fields));
    return json({ count: value.length, value });
  }

  const commentsMatch = /^\/(.+)\/_apis\/wit\/workitems\/(\d+)\/comments$/i.exec(path);
  if (commentsMatch !== null) {
    const id = Number(commentsMatch[2]);
    return json({
      totalCount: 2,
      comments: [
        { id: 1, text: '<p>First thought.</p>', createdBy: person('Fox Mulder'), createdDate: '2026-08-10T08:00:00Z' },
        { id: 2, text: `<p>Second thought on ${String(id)}.</p>`, createdBy: person('Dana Scully'), createdDate: '2026-08-10T09:00:00Z' },
      ],
    });
  }

  const oneMatch = /^\/(.+)\/_apis\/wit\/workitems\/(\d+)$/i.exec(path);
  if (oneMatch !== null) {
    const found = workItems.find((entry) => entry.id === Number(oneMatch[2]));
    if (found === undefined) return notFound(path);
    return json({
      id: found.id,
      rev: 3,
      fields: {
        ...found.fields,
        // Only the bug carries acceptance criteria, so the "nothing to show" path stays
        // reachable.
        ...(found.id === 2 ? { 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>It works.</li></ul>' } : {}),
      },
    });
  }

  return notFound(path);
}

function project(entry: FakeWorkItem, fields: readonly string[] | undefined): FakeWorkItem {
  if (fields === undefined) return entry;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in entry.fields) picked[field] = entry.fields[field];
  }
  return { id: entry.id, fields: picked };
}

/**
 * A small WIQL evaluator.
 *
 * It understands exactly the clauses `buildWiql` emits, and rejects anything else loudly —
 * a silently ignored clause would let an incorrect statement pass the test suite, which is
 * the one failure mode a fake backend must not have.
 */
function evaluateWiql(statement: string): readonly FakeWorkItem[] {
  const where = /WHERE (.+) ORDER BY/.exec(statement);
  if (where === null) throw new VfsError('EINVAL', `Fake Azure DevOps could not parse: ${statement}`);

  const predicates = (where[1] ?? '').split(' AND ').map(parseClause);

  return workItems
    .filter((entry) => predicates.every((predicate) => predicate(entry)))
    .sort((a, b) => {
      const left = String(a.fields['System.ChangedDate']);
      const right = String(b.fields['System.ChangedDate']);
      return right.localeCompare(left) || b.id - a.id;
    });
}

type Predicate = (item: FakeWorkItem) => boolean;

function parseClause(clause: string): Predicate {
  const trimmed = clause.trim();

  const assignedToMe = /^\[System\.AssignedTo\] = @Me$/.exec(trimmed);
  if (assignedToMe !== null) {
    return (entry) => (entry.fields['System.AssignedTo'] as { uniqueName?: string } | undefined)?.uniqueName === ME;
  }

  const comparison = /^\[([^\]]+)\] (=|<|>=|CONTAINS) '(.*)'$/.exec(trimmed);
  if (comparison === null) throw new VfsError('EINVAL', `Fake Azure DevOps could not parse clause: ${trimmed}`);

  const [, field = '', operator = '=', raw = ''] = comparison;
  const value = raw.replace(/''/g, "'");

  return (entry) => {
    const actual = entry.fields[field];
    const text = typeof actual === 'object' && actual !== null
      ? String((actual as { displayName?: string }).displayName ?? '')
      : String(actual ?? '');
    switch (operator) {
      case '=':
        return text === value;
      case '<':
        return new Date(text).getTime() < new Date(value).getTime();
      case '>=':
        return new Date(text).getTime() >= new Date(value).getTime();
      default:
        return text.toLowerCase().includes(value.toLowerCase());
    }
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function notFound(path: string): Response {
  return json({ message: `No route for ${path}`, typeKey: 'VssResourceNotFoundException' }, 404);
}
