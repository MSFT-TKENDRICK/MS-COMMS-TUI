/**
 * GitHub issues, pull requests and notifications as directories.
 *
 * This is the provider that answers the "map anything into the same navigation model"
 * requirement. An issue is a conversation with a title, an author, a date, a body and
 * replies — structurally identical to a mail thread — so it needs no new concepts, no new
 * commands and no new key bindings. The same `find . -q "is:open author:alice"` works.
 *
 * Layout:
 *
 *   /gh/<owner>/<repo>/issues/2026-08-11 #12 Title.md
 *   /gh/<owner>/<repo>/pulls/2026-08-11 #14 Title.md
 *   /gh/notifications/...
 *
 * Owner and repo are separate levels rather than a single `owner/repo` segment because a
 * slash cannot survive in a path segment, and `owner-repo` would be ambiguous for the many
 * repositories whose names contain hyphens.
 */

import {
  VfsError,
  timestampPrefix,
  type Capability,
  type Document,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type Query,
  type ReadOptions,
  type VNode,
  queryFields,
} from '@mscomms/core';
import { GitHubClient } from './client.js';

export interface GitHubProviderOptions {
  /** Repositories as `owner/name`. */
  readonly repos?: readonly string[];
  /** Token, or a `${env:NAME}` reference. Falls back to GITHUB_TOKEN / GH_TOKEN. */
  readonly token?: string;
  readonly baseUrl?: string;
  readonly includePulls?: boolean;
  readonly includeNotifications?: boolean;
  readonly state?: 'open' | 'closed' | 'all';
  readonly timeoutMs?: number;
  /** Include issue comments in the rendered document. */
  readonly includeComments?: boolean;
}

interface IssuePayload {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly comments: number;
  readonly draft?: boolean;
  readonly user: { login: string } | null;
  readonly labels: ReadonlyArray<{ name: string } | string>;
  readonly assignees?: ReadonlyArray<{ login: string }>;
  readonly pull_request?: unknown;
}

interface CommentPayload {
  readonly id: number;
  readonly body: string | null;
  readonly created_at: string;
  readonly user: { login: string } | null;
}

interface NotificationPayload {
  readonly id: string;
  readonly unread: boolean;
  readonly reason: string;
  readonly updated_at: string;
  readonly subject: { title: string; url: string | null; type: string };
  readonly repository: { full_name: string };
}

export class GitHubProvider implements Provider {
  readonly id: string;
  readonly displayName = 'GitHub';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll', 'actions']);

  readonly #options: GitHubProviderOptions;
  readonly #context: ProviderContext;
  readonly #repos: ReadonlyArray<{ owner: string; repo: string }>;
  #client: GitHubClient | undefined;

  constructor(options: GitHubProviderOptions, context: ProviderContext) {
    this.#options = options;
    this.#context = context;
    this.#repos = (options.repos ?? []).map((entry) => {
      const [owner, repo] = entry.split('/');
      if (owner === undefined || repo === undefined || owner === '' || repo === '') {
        throw VfsError.config(`"${entry}" is not a repository.`, 'Use the form "owner/name", e.g. "microsoft/vscode".');
      }
      return { owner, repo };
    });
    this.id = `github:${context.mountPath}`;
  }

  async init(): Promise<void> {
    const configured = this.#options.token;
    const token =
      configured === undefined
        ? (process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'])
        : await this.#context.secret(configured);

    if (token === undefined || token.length === 0) {
      // Not fatal: public repositories work unauthenticated, just with a much smaller rate
      // limit. Refusing to start would make the tool unusable for a perfectly valid setup.
      this.#context.logger.warn('GitHub mount has no token; using unauthenticated access (60 requests/hour)');
    }

    this.#client = new GitHubClient({
      ...(token === undefined ? {} : { token }),
      ...(this.#options.baseUrl === undefined ? {} : { baseUrl: this.#options.baseUrl }),
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
    });
  }

  get #api(): GitHubClient {
    if (this.#client === undefined) throw VfsError.config('The GitHub mount was not initialised.');
    return this.#client;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const level = parent === null ? 'root' : String(parent.meta?.['level'] ?? '');

    switch (level) {
      case 'root':
        return { entries: this.#rootEntries(), total: this.#rootEntries().length };

      case 'owner': {
        const owner = String(parent?.meta?.['owner'] ?? '');
        const entries = this.#repos
          .filter((r) => r.owner === owner)
          .map((r) => dir(r.repo, `${owner}/${r.repo}`, 'repo', { level: 'repo', owner, repo: r.repo }));
        return { entries, total: entries.length };
      }

      case 'repo': {
        const owner = String(parent?.meta?.['owner'] ?? '');
        const repo = String(parent?.meta?.['repo'] ?? '');
        const entries = [dir('issues', 'Issues', 'folder', { level: 'issues', owner, repo })];
        if (this.#options.includePulls !== false) {
          entries.push(dir('pulls', 'Pull requests', 'folder', { level: 'pulls', owner, repo }));
        }
        return { entries, total: entries.length };
      }

      case 'issues':
      case 'pulls':
        return this.#listIssues(parent as VNode, level === 'pulls', options);

      case 'notifications':
        return this.#listNotifications(options);

      default:
        throw VfsError.notDirectory(parent?.path ?? '/');
    }
  }

  #rootEntries(): VNode[] {
    const owners = [...new Set(this.#repos.map((r) => r.owner))].sort();
    const entries = owners.map((owner) => dir(owner, owner, 'owner', { level: 'owner', owner }));
    if (this.#options.includeNotifications === true) {
      entries.unshift(dir('notifications', 'Notifications', 'folder', { level: 'notifications' }));
    }
    return entries;
  }

  async #listIssues(parent: VNode, pullsOnly: boolean, options: ListOptions): Promise<ListPage> {
    const owner = String(parent.meta?.['owner'] ?? '');
    const repo = String(parent.meta?.['repo'] ?? '');

    const { path, applied } = this.#buildIssuesPath(owner, repo, pullsOnly, options);
    const response = await this.#api.get<IssuePayload[]>(
      options.cursor ?? path,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const items = response.data.filter((item) =>
      pullsOnly ? item.pull_request !== undefined : item.pull_request === undefined,
    );

    return {
      entries: items.map((item) => this.#toIssueNode(item, owner, repo, pullsOnly)),
      ...(response.nextPage === undefined ? {} : { cursor: response.nextPage }),
      ...(applied === undefined ? {} : { appliedQuery: applied }),
    };
  }

  /**
   * Translate the parts of a query GitHub can answer into URL parameters.
   *
   * Push-down here is a pure optimization: the engine re-applies the whole query locally
   * unless the provider claims to have applied *exactly* it. So the safe move is to use
   * the parameters to fetch less, and only claim `appliedQuery` when the query consisted
   * of nothing but pushable terms. Over-claiming would silently return wrong results;
   * under-claiming just costs a little local filtering.
   */
  #buildIssuesPath(
    owner: string,
    repo: string,
    pullsOnly: boolean,
    options: ListOptions,
  ): { path: string; applied?: Query } {
    const params = new URLSearchParams({
      per_page: String(Math.min(options.limit ?? 50, 100)),
      state: this.#options.state ?? 'open',
      sort: 'updated',
      direction: 'desc',
    });

    const query = options.query;
    let applied: Query | undefined;

    if (query !== undefined && query.type === 'term') {
      const value = query.value.toLowerCase();
      if (query.field === 'is' && (value === 'open' || value === 'closed')) {
        params.set('state', value);
        applied = query;
      } else if (query.field === 'author') {
        params.set('creator', query.value);
        applied = query;
      } else if (query.field === 'after') {
        const since = new Date(query.value);
        if (!Number.isNaN(since.getTime())) params.set('since', since.toISOString());
      }
    } else if (query !== undefined) {
      // Compound queries: still narrow the fetch using an `is:` term if one is present,
      // but never claim to have applied the whole thing.
      const fields = queryFields(query);
      if (fields.has('is')) params.set('state', 'all');
    }

    void pullsOnly;
    return {
      path: `/repos/${owner}/${repo}/issues?${params.toString()}`,
      ...(applied === undefined ? {} : { applied }),
    };
  }

  async #listNotifications(options: ListOptions): Promise<ListPage> {
    if (!this.#api.authenticated) {
      throw new VfsError('EAUTH', 'Listing notifications needs a token.', {
        hint: 'Set GITHUB_TOKEN, or remove "includeNotifications" from this mount.',
      });
    }
    const response = await this.#api.get<NotificationPayload[]>(
      options.cursor ?? '/notifications?per_page=50',
      options.signal === undefined ? {} : { signal: options.signal },
    );

    return {
      entries: response.data.map((item) => {
        const at = new Date(item.updated_at);
        return {
          name: `${timestampPrefix(at)} ${item.repository.full_name} ${item.subject.title}.md`,
          kind: 'file' as const,
          subtype: 'notification',
          title: item.subject.title,
          id: `notification:${item.id}`,
          mtime: at,
          ...(item.unread ? { flags: ['unread'] } : {}),
          summary: `${item.reason} in ${item.repository.full_name}`,
          meta: {
            level: 'notification',
            reason: item.reason,
            repository: item.repository.full_name,
            type: item.subject.type,
            ...(item.subject.url === null ? {} : { apiUrl: item.subject.url }),
          },
        };
      }),
      ...(response.nextPage === undefined ? {} : { cursor: response.nextPage }),
    };
  }

  #toIssueNode(item: IssuePayload, owner: string, repo: string, isPull: boolean): VNode {
    const updated = new Date(item.updated_at);
    const flags = [item.state === 'open' ? 'open' : 'closed'];
    if (item.draft === true) flags.push('draft');
    // Deliberately *not* the well-known `reply` flag. Elsewhere `reply` means "this item
    // is itself a reply to something" (see the chat provider), and an issue never is.
    // Reusing it here to mean "has comments" would make `is:reply` return two different
    // things depending on which mount you happened to be standing in, and would imply a
    // reply action this provider does not offer. The comment count is already carried in
    // `meta.comments` and shown in the document header, so nothing is lost.
    if (item.comments > 0) flags.push('discussed');

    const labels = item.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(', ');
    const assignees = (item.assignees ?? []).map((a) => a.login).join(', ');

    return {
      name: `${timestampPrefix(updated)} #${String(item.number)} ${item.title}.md`,
      kind: 'file',
      subtype: isPull ? 'pull' : 'issue',
      title: `#${String(item.number)} ${item.title}`,
      id: `${owner}/${repo}#${String(item.number)}`,
      mtime: updated,
      size: (item.body ?? '').length,
      flags,
      ...(item.body === null ? {} : { summary: firstLine(item.body) }),
      ...(item.user === null ? {} : { author: item.user.login, authorId: item.user.login }),
      meta: {
        level: 'issue',
        owner,
        repo,
        number: item.number,
        state: item.state,
        comments: item.comments,
        url: item.html_url,
        created: item.created_at,
        // Omitted rather than blank when empty. `stat` and `--json` show every meta key,
        // and a row that reads aloud as "labels, nothing" is pure noise to listen to.
        ...(labels === '' ? {} : { labels }),
        ...(assignees === '' ? {} : { assignees }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    const level = String(node.meta?.['level'] ?? '');

    if (level === 'notification') {
      return {
        title: node.title,
        headers: [
          ['Repository', String(node.meta?.['repository'] ?? '')],
          ['Reason', String(node.meta?.['reason'] ?? '')],
          ['Type', String(node.meta?.['type'] ?? '')],
          ['Updated', node.mtime?.toISOString() ?? ''],
        ],
        body: node.summary ?? '',
        format: 'markdown',
      };
    }

    const owner = String(node.meta?.['owner'] ?? '');
    const repo = String(node.meta?.['repo'] ?? '');
    const number = Number(node.meta?.['number'] ?? 0);
    if (owner === '' || repo === '' || number === 0) {
      throw VfsError.notFound(node.path ?? node.name);
    }

    const issue = await this.#api.get<IssuePayload>(
      `/repos/${owner}/${repo}/issues/${String(number)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const parts: string[] = [issue.data.body ?? '_No description._'];

    // Comments are appended into one document rather than exposed as separate files.
    // A conversation read linearly — which is how a screen reader reads, and how anyone
    // catching up on a thread actually wants it — should be one continuous body, not a
    // directory the user has to walk one file at a time.
    if (this.#options.includeComments !== false && issue.data.comments > 0) {
      try {
        const comments = await this.#api.get<CommentPayload[]>(
          `/repos/${owner}/${repo}/issues/${String(number)}/comments?per_page=100`,
          options.signal === undefined ? {} : { signal: options.signal },
        );
        for (const comment of comments.data) {
          parts.push(
            '',
            '---',
            `**${comment.user?.login ?? 'unknown'}** commented on ${new Date(comment.created_at).toLocaleString()}:`,
            '',
            comment.body ?? '',
          );
        }
      } catch (error) {
        // A failure to load comments must not hide the issue itself.
        parts.push('', '---', `_Comments could not be loaded: ${error instanceof Error ? error.message : String(error)}_`);
      }
    }

    const labels = issue.data.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const headers: Array<readonly [string, string]> = [
      ['Author', issue.data.user?.login ?? 'unknown'],
      ['State', issue.data.state],
      ['Created', new Date(issue.data.created_at).toISOString()],
      ['Updated', new Date(issue.data.updated_at).toISOString()],
      ['Repository', `${owner}/${repo}`],
    ];
    if (labels.length > 0) headers.push(['Labels', labels.join(', ')]);
    if (issue.data.comments > 0) headers.push(['Comments', String(issue.data.comments)]);

    return {
      title: `#${String(issue.data.number)} ${issue.data.title}`,
      headers,
      body: parts.join('\n'),
      format: 'markdown',
      webUrl: issue.data.html_url,
    };
  }

  // -------------------------------------------------------------------------
  // Polling and actions
  // -------------------------------------------------------------------------

  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    const level = parent === null ? 'root' : String(parent.meta?.['level'] ?? '');
    const since = cursor ?? new Date(Date.now() - 24 * 3_600_000).toISOString();

    if (level === 'notifications') {
      const page = await this.#listNotifications(options.signal === undefined ? {} : { signal: options.signal });
      const changes = page.entries
        .filter((node) => (node.mtime?.toISOString() ?? '') > since)
        .map((node) => ({ type: 'created' as const, path: node.name, node, at: node.mtime ?? new Date() }));
      return { changes, cursor: new Date().toISOString() };
    }

    if (level !== 'issues' && level !== 'pulls') {
      return { changes: [], cursor: new Date().toISOString() };
    }

    const owner = String(parent?.meta?.['owner'] ?? '');
    const repo = String(parent?.meta?.['repo'] ?? '');
    const response = await this.#api.get<IssuePayload[]>(
      `/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50&since=${encodeURIComponent(since)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const wantPulls = level === 'pulls';
    const changes = response.data
      .filter((item) => (wantPulls ? item.pull_request !== undefined : item.pull_request === undefined))
      .map((item) => {
        const node = this.#toIssueNode(item, owner, repo, wantPulls);
        // Created and updated within the same window means it is genuinely new.
        const isNew = item.created_at === item.updated_at || new Date(item.created_at).toISOString() > since;
        return { type: isNew ? ('created' as const) : ('updated' as const), path: node.name, node, at: node.mtime ?? new Date() };
      });

    return { changes, cursor: new Date().toISOString() };
  }

  async actions(node: VNode): Promise<readonly import('@mscomms/core').ActionDescriptor[]> {
    if (node.meta?.['url'] === undefined) return [];
    return [{ name: 'url', label: 'Show the web URL', description: 'Print the canonical GitHub URL for this item.' }];
  }

  async invoke(action: string, node: VNode, _params: Readonly<Record<string, MetaValue>>): Promise<import('@mscomms/core').ActionResult> {
    if (action !== 'url') throw VfsError.unsupported(`Action "${action}"`, this.id);
    return { ok: true, message: String(node.meta?.['url'] ?? '') };
  }
}

function dir(name: string, title: string, subtype: string, meta: Record<string, MetaValue>): VNode {
  return { name, kind: 'dir', subtype, title, id: `${subtype}:${name}:${JSON.stringify(meta)}`, meta };
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim().slice(0, 200);
}

export const githubPlugin: ProviderPlugin<GitHubProviderOptions> = {
  type: 'github',
  displayName: 'GitHub issues and pull requests',
  description: 'Repositories, issues, pull requests and notifications as directories.',
  validateOptions(raw) {
    const options = (raw ?? {}) as GitHubProviderOptions;
    if ((options.repos === undefined || options.repos.length === 0) && options.includeNotifications !== true) {
      throw VfsError.config(
        'A github mount needs "repos", or "includeNotifications": true.',
        'Example: { "type": "github", "options": { "repos": ["microsoft/vscode"] } }',
      );
    }
    return options;
  },
  create(options, context) {
    return new GitHubProvider(options, context);
  },
};
