/**
 * Azure DevOps Boards as a filesystem.
 *
 * A work item is a titled, authored, timestamped thing with a state and a discussion. That
 * is the same shape as a mail thread and a GitHub issue, so it needs no new commands, no
 * new key bindings and no new query syntax — `find . -q "is:open author:dana"` already
 * works, and so does `cat 3`.
 *
 * Layout:
 *
 *   /ado/<project>/<team>/<board>/<column>/2026-08-11 #1234 Title.md
 *   /ado/<project>/Assigned to me/2026-08-11 #1234 Title.md
 *
 * The column level is the point. A backlog is a list and could have been one directory,
 * but a *board* is its columns — "what is in Active" is the question people open Azure
 * DevOps to answer, and making it `ls` rather than a query is the whole reason to model
 * boards rather than work items.
 *
 * Team and board are separate levels for the same reason the GitHub provider splits owner
 * from repo: they are independent names, a project can have several teams, and a team can
 * have a Stories board and a Features board that share every column name.
 *
 * The tree shape never varies with content. A project with one team still shows the team
 * level, because a hierarchy that collapses itself when it happens to be small means a
 * saved path stops working the day somebody adds a second team.
 */

import {
  VfsError,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
  type Capability,
  type ChangeEvent,
  type Document,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollOptions,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type ReadOptions,
  type VNode,
} from '@mscomms/core';
import { htmlToText, preview } from '@mscomms/provider-graph';

import { AdoClient, segment, type FetchLike } from './client.js';
import { resolveCredential, type AdoAuthOptions } from './auth.js';
import { WORK_ITEM_FIELDS, buildWiql, type WiqlScope } from './wiql.js';

export interface AdoBoardsOptions extends AdoAuthOptions {
  /** Organization name, e.g. `contoso` for https://dev.azure.com/contoso. */
  readonly organization?: string;
  /** Full collection URL. Required for Azure DevOps Server; overrides `organization`. */
  readonly orgUrl?: string;
  /**
   * Projects to expose. Listing them here also skips project discovery, so the credential
   * needs no organization-wide read — useful for a PAT scoped to a single project.
   */
  readonly projects?: readonly string[];
  /** Restrict to these team names. Default: every team the identity can see. */
  readonly teams?: readonly string[];
  /** Restrict to these board names, e.g. `["Stories"]`. Default: every board. */
  readonly boards?: readonly string[];
  readonly apiVersion?: string;
  readonly pageSize?: number;
  /** Hard cap on work items a single query will return. Guards against a 20k-item board. */
  readonly maxItems?: number;
  /** Add an "Assigned to me" folder to every project. Default: true. */
  readonly includeAssignedToMe?: boolean;
  /** Append the discussion to the rendered work item. Default: true. */
  readonly includeComments?: boolean;
  readonly timeoutMs?: number;
  /** Test seam. Never set from configuration; a JSON file cannot hold a function. */
  readonly transport?: FetchLike;
}

type Level = 'root' | 'project' | 'team' | 'board' | 'column' | 'assigned' | 'workitem';

interface Identity {
  readonly displayName?: string;
  readonly uniqueName?: string;
}

interface WorkItem {
  readonly id: number;
  readonly rev?: number;
  readonly fields?: Record<string, unknown>;
}

interface BoardColumn {
  readonly id: string;
  readonly name: string;
  readonly itemLimit?: number;
  readonly columnType?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_ITEMS = 1_000;
/** The work item batch endpoint refuses more than 200 ids per call. */
const BATCH_LIMIT = 200;

const ASSIGNED_DIR = 'Assigned to me';

/**
 * States that mean "finished".
 *
 * A deliberate heuristic, and one that only ever affects a display flag. The authoritative
 * answer is the work item type's state *category*, which costs one metadata request per
 * type per project; spending that on every listing to colour an icon is a bad trade. The
 * real state is always in `meta.state` and in the document header, so a customized process
 * with an unusual name loses a flag, not information.
 */
const CLOSED_STATES = new Set(['closed', 'done', 'completed', 'removed', 'cut', 'abandoned']);

export class AdoBoardsProvider implements Provider {
  readonly id: string;
  readonly displayName = 'Azure DevOps Boards';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll', 'actions']);

  readonly #options: AdoBoardsOptions;
  readonly #context: ProviderContext;
  #client: AdoClient | undefined;
  #authMode: 'pat' | 'aad' | undefined;

  constructor(options: AdoBoardsOptions, context: ProviderContext) {
    this.#options = options;
    this.#context = context;
    this.id = `ado-boards:${context.mountPath}`;
  }

  async init(): Promise<void> {
    const credential = await resolveCredential(this.#options, this.#context);
    this.#authMode = credential.mode;
    this.#context.logger.debug('azure devops credential resolved', { mode: credential.mode });

    this.#client = new AdoClient({
      orgUrl: orgUrlFor(this.#options),
      authorization: credential.authorization,
      ...(this.#options.apiVersion === undefined ? {} : { apiVersion: this.#options.apiVersion }),
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
      ...(this.#options.transport === undefined ? {} : { fetch: this.#options.transport }),
    });
  }

  get #api(): AdoClient {
    if (this.#client === undefined) throw VfsError.config('The Azure DevOps mount was not initialised.');
    return this.#client;
  }

  get #pageSize(): number {
    return Math.max(1, this.#options.pageSize ?? DEFAULT_PAGE_SIZE);
  }

  get #maxItems(): number {
    return Math.max(1, this.#options.maxItems ?? DEFAULT_MAX_ITEMS);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const level: Level = parent === null ? 'root' : (String(parent.meta?.['level'] ?? '') as Level);
    const meta = parent?.meta ?? {};

    switch (level) {
      case 'root':
        return paginate(await this.#projects(options), options, this.#pageSize);

      case 'project':
        return paginate(await this.#projectChildren(String(meta['project']), options), options, this.#pageSize);

      case 'team':
        return paginate(
          await this.#boards(String(meta['project']), String(meta['team']), options),
          options,
          this.#pageSize,
        );

      case 'board':
        return paginate(
          await this.#columns(String(meta['project']), String(meta['team']), String(meta['boardId']), options),
          options,
          this.#pageSize,
        );

      case 'column':
        return this.#workItems(
          {
            project: String(meta['project']),
            boardColumn: String(meta['column']),
          },
          String(meta['team']),
          options,
        );

      case 'assigned':
        return this.#workItems({ project: String(meta['project']), assignedToMe: true }, undefined, options);

      default:
        throw VfsError.notDirectory(parent?.path ?? '/');
    }
  }

  async #projects(options: ListOptions): Promise<VNode[]> {
    const configured = this.#options.projects;
    if (configured !== undefined && configured.length > 0) {
      return configured.map((name) => this.#projectNode(name, undefined));
    }

    const response = await this.#api.get<{ value?: ReadonlyArray<{ name: string; description?: string; lastUpdateTime?: string }> }>(
      '/_apis/projects?$top=500',
      options.signal === undefined ? {} : { signal: options.signal },
    );

    return (response.data.value ?? []).map((project) =>
      this.#projectNode(project.name, project.lastUpdateTime, project.description),
    );
  }

  #projectNode(name: string, lastUpdate: string | undefined, description?: string): VNode {
    const changed = lastUpdate === undefined ? undefined : new Date(lastUpdate);
    return {
      name,
      kind: 'dir',
      subtype: 'project',
      title: name,
      id: `project:${name}`,
      ...(changed === undefined || Number.isNaN(changed.getTime()) ? {} : { mtime: changed }),
      ...(description === undefined || description === '' ? {} : { summary: preview(description) }),
      meta: { level: 'project', project: name },
    };
  }

  async #projectChildren(project: string, options: ListOptions): Promise<VNode[]> {
    const entries: VNode[] = [];

    if (this.#options.includeAssignedToMe !== false) {
      // First, because it is the folder most people actually want, and a listing is read
      // top to bottom whether by eye or by screen reader.
      entries.push({
        name: ASSIGNED_DIR,
        kind: 'dir',
        subtype: 'view',
        title: `${project}: assigned to me`,
        id: `assigned:${project}`,
        summary: 'Every work item in this project assigned to you',
        meta: { level: 'assigned', project },
      });
    }

    const teams = await this.#api.get<{ value?: ReadonlyArray<{ id: string; name: string; description?: string }> }>(
      `/_apis/projects/${segment(project)}/teams?$top=500`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const allowed = nameFilter(this.#options.teams);
    for (const team of teams.data.value ?? []) {
      if (!allowed(team.name)) continue;
      entries.push({
        name: team.name,
        kind: 'dir',
        subtype: 'team',
        title: team.name,
        id: `team:${project}/${team.id}`,
        ...(team.description === undefined || team.description === ''
          ? {}
          : { summary: preview(team.description) }),
        meta: { level: 'team', project, team: team.name, teamId: team.id },
      });
    }

    return entries;
  }

  async #boards(project: string, team: string, options: ListOptions): Promise<VNode[]> {
    const response = await this.#api.get<{ value?: ReadonlyArray<{ id: string; name: string }> }>(
      `/${segment(project)}/${segment(team)}/_apis/work/boards`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const allowed = nameFilter(this.#options.boards);
    return (response.data.value ?? [])
      .filter((board) => allowed(board.name))
      .map((board) => ({
        name: board.name,
        kind: 'dir' as const,
        subtype: 'board',
        title: `${team} — ${board.name}`,
        id: `board:${project}/${team}/${board.id}`,
        meta: { level: 'board', project, team, boardId: board.id, board: board.name },
      }));
  }

  async #columns(project: string, team: string, boardId: string, options: ListOptions): Promise<VNode[]> {
    const response = await this.#api.get<{ columns?: readonly BoardColumn[] }>(
      `/${segment(project)}/${segment(team)}/_apis/work/boards/${segment(boardId)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    return (response.data.columns ?? []).map((column) => ({
      name: column.name,
      kind: 'dir' as const,
      subtype: 'column',
      title: column.name,
      id: `column:${project}/${team}/${boardId}/${column.id}`,
      ...(column.itemLimit === undefined || column.itemLimit === 0
        ? {}
        : { summary: `Work in progress limit: ${String(column.itemLimit)}` }),
      meta: {
        level: 'column',
        project,
        team,
        boardId,
        column: column.name,
        ...(column.columnType === undefined ? {} : { columnType: column.columnType }),
      },
    }));
  }

  /**
   * Work items for a scope, in pages.
   *
   * WIQL has no continuation token: it answers with an id list and nothing else. So the
   * cursor is an offset into that list, the statement is re-run per page with `$top` sized
   * to the window, and only the ids for the requested page are hydrated. Re-running is
   * cheap — an id list is small — and it keeps the provider stateless, which matters
   * because every command in this tool is a cold start.
   *
   * The ordering in `buildWiql` breaks ties on id for this reason: an unstable sort would
   * make page two silently repeat and drop rows.
   */
  async #workItems(scope: WiqlScope, team: string | undefined, options: ListOptions): Promise<ListPage> {
    const limit = Math.max(1, Math.min(options.limit ?? this.#pageSize, this.#maxItems));
    const offset = parseOffset(options.cursor);

    const { statement, applied } = buildWiql(scope, options.query);
    // One extra row is the cheapest way to distinguish "that was the last page" from
    // "there is exactly one more page", and getting that wrong shows a `more` prompt that
    // returns nothing.
    const top = Math.min(this.#maxItems, offset + limit + 1);

    const ids = await this.#runWiql(statement, scope.project, team, top, options.signal);
    const window = ids.slice(offset, offset + limit);
    const items = await this.#hydrate(window, options.signal);
    const hasMore = ids.length > offset + limit;

    return {
      entries: items.map((item) => this.#workItemNode(item, scope.project)),
      ...(hasMore ? { cursor: String(offset + limit) } : {}),
      ...(hasMore ? {} : { total: ids.length }),
      ...(applied === undefined ? {} : { appliedQuery: applied }),
    };
  }

  async #runWiql(
    statement: string,
    project: string,
    team: string | undefined,
    top: number,
    signal: AbortSignal | undefined,
  ): Promise<number[]> {
    // Board columns are a property of a team's board, so `[System.BoardColumn]` only
    // resolves when the query runs in that team's context. Project context is right for
    // everything else and avoids inventing a team the user did not ask about.
    const scopePath =
      team === undefined || team === '' ? `/${segment(project)}` : `/${segment(project)}/${segment(team)}`;

    const response = await this.#api.post<{ workItems?: ReadonlyArray<{ id: number }> }>(
      `${scopePath}/_apis/wit/wiql?$top=${String(top)}`,
      { query: statement },
      signal === undefined ? {} : { signal },
    );

    return (response.data.workItems ?? []).map((item) => item.id);
  }

  async #hydrate(ids: readonly number[], signal: AbortSignal | undefined): Promise<WorkItem[]> {
    if (ids.length === 0) return [];

    const byId = new Map<number, WorkItem>();
    for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
      const chunk = ids.slice(start, start + BATCH_LIMIT);
      const response = await this.#api.post<{ value?: readonly WorkItem[] }>(
        '/_apis/wit/workitemsbatch',
        {
          ids: chunk,
          fields: [...WORK_ITEM_FIELDS],
          // One work item the identity cannot see must not blank the whole board.
          errorPolicy: 'omit',
        },
        signal === undefined ? {} : { signal },
      );
      for (const item of response.data.value ?? []) byId.set(item.id, item);
    }

    // The batch endpoint does not promise to preserve request order, and the WIQL order is
    // the one the user was shown.
    return ids.map((id) => byId.get(id)).filter((item): item is WorkItem => item !== undefined);
  }

  #workItemNode(item: WorkItem, project: string): VNode {
    const fields = item.fields ?? {};
    const title = text(fields['System.Title']) || '(untitled)';
    const changed = new Date(text(fields['System.ChangedDate']));
    const state = text(fields['System.State']);
    const type = text(fields['System.WorkItemType']);
    const createdBy = identity(fields['System.CreatedBy']);
    const assignedTo = identity(fields['System.AssignedTo']);
    const description = htmlToText(text(fields['System.Description']));
    const tags = text(fields['System.Tags']);
    const comments = number(fields['System.CommentCount']);
    const priority = number(fields['Microsoft.VSTS.Common.Priority']);

    const flags: string[] = [CLOSED_STATES.has(state.toLowerCase()) ? 'closed' : 'open'];
    if (fields['System.BoardColumnDone'] === true) flags.push('done');
    if (assignedTo.displayName === undefined) flags.push('unassigned');
    if (priority === 1) flags.push('important');
    // `discussed` rather than the well-known `reply` flag, matching the GitHub provider:
    // `reply` means "this item is itself a reply", and a work item never is.
    if (comments !== undefined && comments > 0) flags.push('discussed');

    return {
      name: `${timestampPrefix(changed)} #${String(item.id)} ${title}.md`,
      kind: 'file',
      subtype: 'workitem',
      title: `#${String(item.id)} ${title}`,
      id: String(item.id),
      ...(Number.isNaN(changed.getTime()) ? {} : { mtime: changed }),
      size: description.length,
      flags,
      ...(description === '' ? {} : { summary: preview(description) }),
      ...(createdBy.displayName === undefined ? {} : { author: createdBy.displayName }),
      ...(createdBy.uniqueName === undefined ? {} : { authorId: createdBy.uniqueName }),
      meta: {
        level: 'workitem',
        project,
        workItemId: item.id,
        ...(type === '' ? {} : { type }),
        ...(state === '' ? {} : { state }),
        ...(text(fields['System.BoardColumn']) === '' ? {} : { column: text(fields['System.BoardColumn']) }),
        ...(assignedTo.displayName === undefined ? {} : { assignedTo: assignedTo.displayName }),
        // Omitted rather than blank when empty: `stat` prints every key, and a row that
        // reads aloud as "tags, nothing" is pure noise through a screen reader.
        ...(tags === '' ? {} : { tags: tags.split(';').map((tag) => tag.trim()).filter(Boolean).join(', ') }),
        ...(text(fields['System.AreaPath']) === '' ? {} : { area: text(fields['System.AreaPath']) }),
        ...(text(fields['System.IterationPath']) === '' ? {} : { iteration: text(fields['System.IterationPath']) }),
        ...(priority === undefined ? {} : { priority }),
        ...(comments === undefined ? {} : { comments }),
        ...(text(fields['System.CreatedDate']) === '' ? {} : { created: text(fields['System.CreatedDate']) }),
        url: this.#webUrl(project, item.id),
      },
    };
  }

  #webUrl(project: string, id: number): string {
    return `${this.#api.orgUrl}/${segment(project)}/_workitems/edit/${String(id)}`;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    const project = String(node.meta?.['project'] ?? '');
    const id = Number(node.meta?.['workItemId'] ?? 0);
    if (project === '' || id === 0) throw VfsError.notFound(node.path ?? node.name);

    const signal = options.signal === undefined ? {} : { signal: options.signal };
    const response = await this.#api.get<WorkItem>(
      `/${segment(project)}/_apis/wit/workitems/${String(id)}`,
      signal,
    );
    const fields = response.data.fields ?? {};

    const headers: Array<readonly [string, string]> = [
      ['Type', text(fields['System.WorkItemType'])],
      ['State', text(fields['System.State'])],
    ];
    const column = text(fields['System.BoardColumn']);
    if (column !== '') headers.push(['Board column', column]);
    const assigned = identity(fields['System.AssignedTo']).displayName;
    headers.push(['Assigned to', assigned ?? 'Unassigned']);
    headers.push(['Created by', identity(fields['System.CreatedBy']).displayName ?? 'unknown']);
    headers.push(['Created', isoOrEmpty(text(fields['System.CreatedDate']))]);
    headers.push(['Changed', isoOrEmpty(text(fields['System.ChangedDate']))]);
    const iteration = text(fields['System.IterationPath']);
    if (iteration !== '') headers.push(['Iteration', iteration]);
    const tags = text(fields['System.Tags']);
    if (tags !== '') headers.push(['Tags', tags.split(';').map((tag) => tag.trim()).filter(Boolean).join(', ')]);
    headers.push(['Project', project]);

    const parts: string[] = [];
    const description = htmlToText(text(fields['System.Description']));
    // A bug's narrative lives in ReproSteps, not Description. Rendering only Description
    // makes every bug in the tenant look like an empty document.
    const repro = htmlToText(text(fields['Microsoft.VSTS.TCM.ReproSteps']));
    const criteria = htmlToText(text(fields['Microsoft.VSTS.Common.AcceptanceCriteria']));

    if (description !== '') parts.push(description);
    if (repro !== '') parts.push('', '## Repro steps', '', repro);
    if (criteria !== '') parts.push('', '## Acceptance criteria', '', criteria);
    if (parts.length === 0) parts.push('_No description._');

    const commentCount = number(fields['System.CommentCount']) ?? 0;
    if (this.#options.includeComments !== false && commentCount > 0) {
      parts.push(...(await this.#discussion(project, id, options.signal)));
    }

    return {
      title: `#${String(id)} ${text(fields['System.Title'])}`,
      headers,
      body: parts.join('\n'),
      format: 'markdown',
      webUrl: this.#webUrl(project, id),
    };
  }

  /**
   * The discussion, appended into the same document rather than exposed as separate files.
   *
   * A conversation read linearly is how a screen reader reads and how anyone catching up
   * on a work item wants it, so it is one continuous body rather than a directory to walk
   * one file at a time.
   */
  async #discussion(project: string, id: number, signal: AbortSignal | undefined): Promise<string[]> {
    try {
      const response = await this.#api.get<{
        comments?: ReadonlyArray<{ text?: string; createdBy?: unknown; createdDate?: string }>;
      }>(`/${segment(project)}/_apis/wit/workItems/${String(id)}/comments?$top=200`, {
        // The comments endpoint has never left preview, so it needs its own api-version.
        apiVersion: '7.1-preview.4',
        ...(signal === undefined ? {} : { signal }),
      });

      const parts: string[] = [];
      for (const comment of response.data.comments ?? []) {
        const author = identity(comment.createdBy).displayName ?? 'unknown';
        const at = comment.createdDate === undefined ? '' : new Date(comment.createdDate).toLocaleString();
        parts.push('', '---', `**${author}** commented${at === '' ? '' : ` on ${at}`}:`, '', htmlToText(comment.text ?? ''));
      }
      return parts;
    } catch (error) {
      // Failing to load the discussion must not hide the work item itself.
      return ['', '---', `_The discussion could not be loaded: ${error instanceof Error ? error.message : String(error)}_`];
    }
  }

  // -------------------------------------------------------------------------
  // Polling and actions
  // -------------------------------------------------------------------------

  async poll(parent: VNode | null, cursor: string | undefined, options: PollOptions): Promise<PollResult> {
    const level: Level = parent === null ? 'root' : (String(parent.meta?.['level'] ?? '') as Level);
    const meta = parent?.meta ?? {};
    const since = cursor ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
    const next = new Date().toISOString();

    if (level !== 'column' && level !== 'assigned') return { changes: [], cursor: next };

    const project = String(meta['project']);
    const scope: WiqlScope =
      level === 'column'
        ? { project, boardColumn: String(meta['column']), changedSince: since }
        : { project, assignedToMe: true, changedSince: since };
    const team = level === 'column' ? String(meta['team']) : undefined;

    const { statement } = buildWiql(scope, undefined);
    const ids = await this.#runWiql(statement, project, team, this.#pageSize, options.signal);
    const items = await this.#hydrate(ids, options.signal);

    const changes: ChangeEvent[] = items.map((item) => {
      const node = this.#workItemNode(item, project);
      const created = text(item.fields?.['System.CreatedDate']);
      // Created inside the polling window means it is genuinely new rather than edited.
      const isNew = created !== '' && created >= since;
      return {
        type: isNew ? ('created' as const) : ('updated' as const),
        path: node.name,
        node,
        at: node.mtime ?? new Date(),
      };
    });

    return { changes, cursor: next };
  }

  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    if (node.meta?.['url'] === undefined) return [];
    return [{ name: 'url', label: 'Show the web URL', description: 'Print the canonical Azure DevOps URL for this work item.' }];
  }

  async invoke(action: string, node: VNode, _params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    if (action !== 'url') throw VfsError.unsupported(`Action "${action}"`, this.id);
    return { ok: true, message: String(node.meta?.['url'] ?? '') };
  }

  /** Exposed for diagnostics: `mounts` and `doctor` want to say how a mount signed in. */
  get authMode(): 'pat' | 'aad' | undefined {
    return this.#authMode;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function orgUrlFor(options: AdoBoardsOptions): string {
  if (options.orgUrl !== undefined && options.orgUrl !== '') return options.orgUrl.replace(/\/+$/, '');
  const organization = options.organization ?? '';
  if (organization === '') {
    throw VfsError.config(
      'An Azure DevOps mount needs "organization" or "orgUrl".',
      'Example: { "type": "ado-boards", "options": { "organization": "contoso" } }. For Azure DevOps Server, set "orgUrl" to the full collection URL.',
    );
  }
  if (/^https?:\/\//.test(organization)) return organization.replace(/\/+$/, '');
  return `https://dev.azure.com/${segment(organization)}`;
}

/** Case-insensitive allow-list; an unset or empty list allows everything. */
function nameFilter(allowed: readonly string[] | undefined): (name: string) => boolean {
  if (allowed === undefined || allowed.length === 0) return () => true;
  const set = new Set(allowed.map((entry) => entry.toLowerCase()));
  return (name: string) => set.has(name.toLowerCase());
}

/**
 * Page an in-memory list.
 *
 * Teams, boards and columns all come back whole from one small request, so paging them is
 * the engine's contract rather than a network concern — but the contract still has to be
 * honoured, because `limit` is what stops `ls` from dumping five hundred rows at a screen
 * reader.
 */
function paginate(entries: readonly VNode[], options: ListOptions, pageSize: number): ListPage {
  const limit = Math.max(1, options.limit ?? pageSize);
  const offset = parseOffset(options.cursor);
  const window = entries.slice(offset, offset + limit);
  const hasMore = entries.length > offset + limit;
  return {
    entries: window,
    total: entries.length,
    ...(hasMore ? { cursor: String(offset + limit) } : {}),
  };
}

function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Identity fields arrive as an object on modern api-versions and as a bare string on older
 * ones, and Azure DevOps Server installations are routinely several versions behind.
 */
function identity(value: unknown): Identity {
  if (typeof value === 'string') return value === '' ? {} : { displayName: value };
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const displayName = typeof record['displayName'] === 'string' ? record['displayName'] : undefined;
  const uniqueName = typeof record['uniqueName'] === 'string' ? record['uniqueName'] : undefined;
  return {
    ...(displayName === undefined || displayName === '' ? {} : { displayName }),
    ...(uniqueName === undefined || uniqueName === '' ? {} : { uniqueName }),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isoOrEmpty(value: string): string {
  if (value === '') return '';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

export const adoBoardsPlugin: ProviderPlugin<AdoBoardsOptions> = {
  type: 'ado-boards',
  displayName: 'Azure DevOps Boards',
  description: 'Projects, teams, boards, columns and work items as directories.',
  validateOptions(raw) {
    const options = (raw ?? {}) as AdoBoardsOptions;
    // Fail here rather than on first use: a precise startup message beats a mysterious
    // 404 the first time somebody runs `ls`.
    orgUrlFor(options);
    const auth = options.auth;
    if (auth !== undefined && auth !== 'auto' && auth !== 'pat' && auth !== 'aad') {
      throw VfsError.config(`"${String(auth)}" is not an Azure DevOps auth mode.`, 'Use "auto", "pat" or "aad".');
    }
    return options;
  },
  create(options, context) {
    return new AdoBoardsProvider(options, context);
  },
};
