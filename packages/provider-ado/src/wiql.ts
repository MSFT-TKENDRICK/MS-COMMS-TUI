/**
 * Query push-down: the engine's query language, expressed as WIQL.
 *
 * The rule this module exists to respect is stated in docs/ARCHITECTURE.md: a provider may
 * push a query down to its backend, but if it echoes back an `appliedQuery` the engine
 * stops filtering and trusts it completely. Over-claiming silently drops matching work
 * items; under-claiming only costs a little local filtering. So the two jobs here are kept
 * deliberately separate:
 *
 *   NARROWING — add WHERE clauses that are guaranteed to return a *superset* of what the
 *   engine would keep. Cheap, always safe, never claimed.
 *
 *   CLAIMING — assert that WIQL evaluated the query exactly. Only date bounds qualify,
 *   because only they have identical semantics on both sides: the engine compares
 *   `node.mtime` against an instant, `node.mtime` is `System.ChangedDate`, and WIQL's `>=`
 *   on a datetime field is the same comparison. Everything else differs in some corner —
 *   Azure DevOps `CONTAINS` on an identity field also matches the account's unique name,
 *   `is:` maps onto states whose names a customized process is free to change — and a
 *   corner is exactly where a silent wrong answer lives.
 *
 * Only a top-level AND of terms is considered. WIQL has parentheses and `NOT`, but nesting
 * them under the mandatory project and column clauses puts correctness in the hands of
 * operator precedence, and the downside of getting that wrong is missing work items rather
 * than an error.
 */

import { parseDateValue, type Query, type TermQuery } from '@mscomms/core';

export interface WiqlScope {
  readonly project: string;
  /** Restrict to one kanban column. Requires the query to run in a team context. */
  readonly boardColumn?: string;
  /** Restrict to items assigned to the signed-in identity. */
  readonly assignedToMe?: boolean;
  readonly workItemTypes?: readonly string[];
  /** ISO instant; used by `poll` rather than by the query language. */
  readonly changedSince?: string;
}

export interface WiqlBuild {
  readonly statement: string;
  /**
   * Echoed straight back to the engine when every clause was translated exactly. It is the
   * caller's original object, so `stringifyQuery` cannot disagree with itself.
   */
  readonly applied?: Query;
}

/** Fields fetched for every work item. Narrow on purpose: a board can hold thousands. */
export const WORK_ITEM_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.BoardColumn',
  'System.BoardColumnDone',
  'System.AssignedTo',
  'System.CreatedBy',
  'System.CreatedDate',
  'System.ChangedDate',
  'System.ChangedBy',
  'System.Tags',
  'System.AreaPath',
  'System.IterationPath',
  'System.CommentCount',
  'System.Description',
  'Microsoft.VSTS.Common.Priority',
] as const;

export function buildWiql(scope: WiqlScope, query: Query | undefined, now: Date = new Date()): WiqlBuild {
  const clauses: string[] = [`[System.TeamProject] = ${literal(scope.project)}`];

  if (scope.boardColumn !== undefined) {
    clauses.push(`[System.BoardColumn] = ${literal(scope.boardColumn)}`);
  }
  if (scope.assignedToMe === true) {
    clauses.push('[System.AssignedTo] = @Me');
  }
  if (scope.workItemTypes !== undefined && scope.workItemTypes.length > 0) {
    clauses.push(`[System.WorkItemType] IN (${scope.workItemTypes.map(literal).join(', ')})`);
  }
  if (scope.changedSince !== undefined) {
    clauses.push(`[System.ChangedDate] >= ${literal(scope.changedSince)}`);
  }

  const pushed = query === undefined ? { clauses: [] as string[], exact: false } : pushDown(query, now);
  clauses.push(...pushed.clauses);

  const statement = [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE ${clauses.join(' AND ')}`,
    // System.Id breaks ties, so two items changed in the same second cannot swap places
    // between pages. Unstable ordering makes cursor paging drop and repeat entries.
    'ORDER BY [System.ChangedDate] DESC, [System.Id] DESC',
  ].join(' ');

  return {
    statement,
    // `changedSince` is an extra filter the user never asked for, so a claim would be a
    // lie about a *different* query than the one that was evaluated.
    ...(pushed.exact && query !== undefined && scope.changedSince === undefined ? { applied: query } : {}),
  };
}

interface PushDown {
  readonly clauses: readonly string[];
  /** True only when every leaf of the query was translated without loss. */
  readonly exact: boolean;
}

function pushDown(query: Query, now: Date): PushDown {
  if (query.type === 'all') return { clauses: [], exact: true };

  const terms =
    query.type === 'and'
      ? query.clauses
      : [query];

  const clauses: string[] = [];
  let exact = true;

  for (const clause of terms) {
    if (clause.type !== 'term') {
      exact = false;
      continue;
    }
    const translated = translateTerm(clause, now);
    if (translated === undefined) {
      exact = false;
      continue;
    }
    clauses.push(translated.clause);
    if (!translated.exact) exact = false;
  }

  return { clauses, exact };
}

interface TranslatedTerm {
  readonly clause: string;
  readonly exact: boolean;
}

/**
 * Translate one term.
 *
 * Dates go through the engine's own `parseDateValue`, which is what makes an exact claim
 * defensible: both sides resolve `7d` and `2026-08-01` to the same instant, in the same
 * time zone. It throws EINVAL on a date it cannot read, and that is deliberately allowed to
 * propagate — the engine would throw the identical error evaluating the identical term, so
 * catching it here would only turn one clear message into two different ones.
 */
function translateTerm(term: TermQuery, now: Date): TranslatedTerm | undefined {
  switch (term.field) {
    case 'after':
      return { clause: `[System.ChangedDate] >= ${literal(parseDateValue(term.value, now).toISOString())}`, exact: true };

    case 'before':
      return { clause: `[System.ChangedDate] < ${literal(parseDateValue(term.value, now).toISOString())}`, exact: true };

    case 'on': {
      const start = parseDateValue(term.value, now);
      // A local calendar day, half-open — the same window the engine evaluates.
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return {
        clause: `[System.ChangedDate] >= ${literal(start.toISOString())} AND [System.ChangedDate] < ${literal(end.toISOString())}`,
        exact: true,
      };
    }

    case 'author': {
      // Narrowing only. Azure DevOps matches identity fields on display name *and* unique
      // name, so this returns a superset of what the engine keeps — which is the safe
      // direction — but it is not the same predicate, so it is never claimed.
      const operator = term.op === 'equals' ? '=' : 'CONTAINS';
      return { clause: `[System.CreatedBy] ${operator} ${literal(term.value)}`, exact: false };
    }

    case 'subject': {
      const operator = term.op === 'equals' ? '=' : 'CONTAINS';
      // The engine's `subject` is the node title, which is exactly System.Title, but
      // CONTAINS is a word-prefix match in Azure DevOps rather than a substring one, so it
      // can return *fewer* rows than the engine would keep. Narrowing is therefore unsafe
      // for equality-free matching and only the exact form is pushed.
      if (term.op !== 'equals') return undefined;
      return { clause: `[System.Title] ${operator} ${literal(term.value)}`, exact: false };
    }

    default:
      return undefined;
  }
}

/** WIQL string literals are single-quoted, and a quote inside one is doubled. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
