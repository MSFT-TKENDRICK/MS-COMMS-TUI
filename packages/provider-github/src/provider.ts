/**
 * GitHub issues, pull requests, discussions, projects and notifications as directories.
 *
 * This is the provider that answers the "map anything into the same navigation model"
 * requirement. An issue is a conversation with a title, an author, a date, a body and
 * replies — structurally identical to a mail thread — so it needs no new concepts, no new
 * commands and no new key bindings. The same `find . -q "is:open author:alice"` works. A
 * discussion is the same shape again, and a project item is a card that quotes one.
 *
 * Layout:
 *
 *   /gh/<owner>/projects/#3 Roadmap/2026-08-11 #12 Ship it.md
 *   /gh/<owner>/<repo>/issues/2026-08-11 #12 Title.md
 *   /gh/<owner>/<repo>/pulls/2026-08-11 #14 Title.md
 *   /gh/<owner>/<repo>/discussions/2026-08-11 #7 Title.md
 *   /gh/<owner>/<repo>/projects/#1 Board/...
 *   /gh/notifications/...
 *
 * Owner and repo are separate levels rather than a single `owner/repo` segment because a
 * slash cannot survive in a path segment, and `owner-repo` would be ambiguous for the many
 * repositories whose names contain hyphens.
 *
 * Projects appear at two levels because GitHub genuinely puts them at two levels: a
 * Projects v2 board belongs to an organization or a user, and is then *linked* to any
 * number of repositories. Exposing only the repository side would hide every board that
 * spans repositories — which is most of the interesting ones — and exposing only the owner
 * side would make a board that a repository's contributors think of as theirs live
 * somewhere they would not look.
 *
 * Discussions and projects are reached over GraphQL because GitHub never gave them REST
 * endpoints; see `graphql.ts`. That has one user-visible consequence, handled in `init`:
 * the GraphQL API refuses anonymous callers outright, so these two folders are hidden
 * rather than shown-and-broken when the mount has no token.
 */

import {
  VfsError,
  sanitizeSegment,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
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
  type TermQuery,
  type VNode,
  queryFields,
} from '@mscomms/core';
import { GitHubClient, type FetchLike } from './client.js';
import { ghToken } from './gh.js';
import {
  DISCUSSIONS_QUERY,
  DISCUSSION_QUERY,
  OWNER_PROJECTS_QUERY,
  PROJECT_ITEMS_QUERY,
  PROJECT_ITEM_BODY_QUERY,
  REPO_PROJECTS_QUERY,
  fieldValueMap,
  nextCursor,
  nodesOf,
  type DiscussionResponse,
  type DiscussionSummary,
  type DiscussionsResponse,
  type OwnerProjectsResponse,
  type ProjectItem,
  type ProjectItemBodyResponse,
  type ProjectItemsResponse,
  type ProjectSummary,
  type RepoProjectsResponse,
} from './graphql.js';

export interface GitHubProviderOptions {
  /** Repositories as `owner/name`. */
  readonly repos?: readonly string[];
  /**
   * Extra accounts whose organization- or user-level projects should appear, for owners
   * that have no repository listed in `repos`. Owners named there are included already.
   */
  readonly owners?: readonly string[];
  /** Token, or a `${env:NAME}` reference. Falls back to GITHUB_TOKEN / GH_TOKEN. */
  readonly token?: string;
  readonly baseUrl?: string;
  /** GraphQL endpoint. Derived from `baseUrl` when omitted. */
  readonly graphqlUrl?: string;
  readonly includePulls?: boolean;
  readonly includeNotifications?: boolean;
  /** Add a `discussions/` folder to each repository. Needs a token. */
  readonly includeDiscussions?: boolean;
  /** Add `projects/` folders at owner and repository level. Needs a token with `read:project`. */
  readonly includeProjects?: boolean;
  readonly state?: 'open' | 'closed' | 'all';
  readonly timeoutMs?: number;
  /** Include issue comments in the rendered document. */
  readonly includeComments?: boolean;
  /** Test seam. Never set from configuration; a JSON file cannot hold a function. */
  readonly transport?: FetchLike;
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

/**
 * A pull request as the dedicated endpoint returns it.
 *
 * Structurally an issue plus the things that make a pull request one — branches, a merge
 * state and a diffstat — and deliberately *not* modelled as `IssuePayload & extras`,
 * because the two endpoints disagree about which fields exist: `/pulls` has no `comments`
 * count, and `/issues` has no `head`. Pretending otherwise is how `undefined` ends up
 * rendered into a header.
 */
interface PullPayload {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly merged_at: string | null;
  readonly mergeable?: boolean | null;
  readonly mergeable_state?: string;
  readonly comments?: number;
  readonly review_comments?: number;
  readonly commits?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changed_files?: number;
  readonly user: { login: string } | null;
  readonly labels: ReadonlyArray<{ name: string } | string>;
  readonly assignees?: ReadonlyArray<{ login: string }>;
  readonly requested_reviewers?: ReadonlyArray<{ login: string }>;
  readonly head?: { ref: string };
  readonly base?: { ref: string };
}

interface CommentPayload {
  readonly id: number;
  readonly body: string | null;
  readonly created_at: string;
  readonly user: { login: string } | null;
}

interface ReviewPayload {
  readonly id: number;
  readonly body: string | null;
  readonly state: string;
  readonly submitted_at: string | null;
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

/** Directory levels, carried in `meta.level` so no path is ever parsed. */
type Level =
  | 'root'
  | 'owner'
  | 'repo'
  | 'issues'
  | 'pulls'
  | 'discussions'
  | 'projects'
  | 'project'
  | 'notifications';

export class GitHubProvider implements Provider {
  readonly id: string;
  readonly displayName = 'GitHub';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll', 'actions']);

  readonly #options: GitHubProviderOptions;
  readonly #context: ProviderContext;
  readonly #repos: ReadonlyArray<{ owner: string; repo: string }>;
  readonly #owners: readonly string[];
  #client: GitHubClient | undefined;
  /**
   * Whether the GraphQL-only folders may be shown.
   *
   * Resolved once in `init` rather than checked per listing, so a repository does not gain
   * and lose folders between two `ls` calls depending on which code path asked.
   */
  #graphqlAvailable = false;
  /**
   * Why `projects/` cannot be opened, keyed by what the reason actually covers.
   *
   * Keyed, not a single flag, because a mount can hold several owners and almost none of
   * the reasons are token-wide. SAML enforcement, OAuth-app restrictions and board
   * visibility are all decided per organization, so one refusal from `acme` says nothing
   * about `initech` — and letting it speak for both would mean greying out a folder that
   * works and, worse, wiping a true warning the moment the other one succeeded.
   *
   * The one genuinely token-wide reason is a missing scope, which lives under `ALL_OWNERS`.
   */
  readonly #projectFailures = new Map<string, string>();
  /**
   * The in-flight scope probe, started at init and awaited at the point of use.
   *
   * Mounts are built one after another, so anything awaited in `init` is added directly to
   * how long the shell takes to start — for every mount behind this one as well. A warning
   * is not worth that. Starting the request and collecting it later costs nothing, because
   * by the time a listing needs the answer the round trip has almost always finished.
   */
  #scopeProbe: Promise<void> | undefined;

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
    for (const owner of options.owners ?? []) {
      if (owner.includes('/')) {
        throw VfsError.config(
          `"${owner}" is not an account.`,
          '"owners" takes bare organization or user logins; put "owner/name" entries in "repos".',
        );
      }
    }
    this.#owners = [...new Set([...this.#repos.map((r) => r.owner), ...(options.owners ?? [])])].sort();
    this.id = `github:${context.mountPath}`;
  }

  async init(): Promise<void> {
    const configured = this.#options.token;
    // Order is a promise the config file makes: an explicit token, then the environment,
    // then whatever `gh auth login` left in the keychain. Each step is more surprising than
    // the last, so each only runs when the ones above it had nothing.
    const token =
      configured === undefined
        ? (process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? (await ghToken()))
        : await this.#context.secret(configured);

    if (token === undefined || token.length === 0) {
      // Not fatal: public repositories work unauthenticated, just with a much smaller rate
      // limit. Refusing to start would make the tool unusable for a perfectly valid setup.
      this.#context.logger.warn(
        'GitHub mount has no token; using unauthenticated access (60 requests/hour). Set GH_TOKEN or run `gh auth login`.',
      );
    }

    this.#client = new GitHubClient({
      ...(token === undefined ? {} : { token }),
      ...(this.#options.baseUrl === undefined ? {} : { baseUrl: this.#options.baseUrl }),
      ...(this.#options.graphqlUrl === undefined ? {} : { graphqlUrl: this.#options.graphqlUrl }),
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
      ...(this.#options.transport === undefined ? {} : { fetch: this.#options.transport }),
    });

    this.#graphqlAvailable = this.#client.authenticated;
    if (!this.#graphqlAvailable && (this.#wants('includeDiscussions') || this.#wants('includeProjects'))) {
      // Hidden rather than shown-and-broken. A folder that always throws when opened is
      // worse than one that is not there: it is indistinguishable from a bug, and a screen
      // reader user pays the cost of finding out on every listing.
      this.#context.logger.info(
        'Discussions and projects are hidden: GitHub serves them only over GraphQL, which has no anonymous access.',
      );
    }

    if (this.#showProjects()) {
      // Deliberately not awaited. `scopes` swallows its own failures, and the `catch` is
      // belt and braces so a logger that throws cannot become an unhandled rejection.
      this.#scopeProbe = this.#checkProjectScope().catch(() => undefined);
    }
  }

  /**
   * Find out before the user does whether this token can read projects.
   *
   * Projects v2 needs `read:project`, which is unusual: nothing else in this tool wants it,
   * `repo` does not imply it, and `gh auth login` does not ask for it. So the overwhelmingly
   * common way to meet this feature is a folder that throws the moment you open it, having
   * given no warning that it would.
   *
   * The cost of checking is one request to an endpoint that does not count against the rate
   * limit, made once per mount. Silence is treated as permission: a token whose scopes
   * GitHub does not report is left alone rather than greyed out on a guess.
   */
  async #checkProjectScope(): Promise<void> {
    const scopes = await this.#api.scopes();
    if (scopes === undefined) return;
    if (scopes.some((scope) => scope === 'read:project' || scope === 'project')) return;

    // The one reason that really is token-wide: no scope means no boards anywhere.
    this.#projectFailures.set(ALL_OWNERS, 'needs the read:project scope');
    this.#context.logger.info(
      'GitHub projects are shown but not readable: this token has no read:project scope. Run `gh auth refresh -s read:project`.',
      { scopes: scopes.join(', ') },
    );
  }

  /**
   * Remember a refusal so the next listing can warn instead of repeating it.
   *
   * Only permission failures are recorded, and only against the owner or repository that
   * produced them. A timeout, an outage or a rate limit says nothing about whether the
   * folder is readable, and latching a permanent warning over a passing blip would be its
   * own kind of lie. `retryAfter` is the giveaway for the secondary rate limit, which
   * arrives as a 403 and is otherwise indistinguishable from a real refusal.
   */
  #noteProjectFailure(key: string, error: unknown): void {
    if (!(error instanceof VfsError)) return;
    if (error.code !== 'EACCES' && error.code !== 'EAUTH') return;
    if (error.retryAfter !== undefined) return;
    if (!this.#projectFailures.has(key)) this.#projectFailures.set(key, describeRefusal(error.message));
  }

  /** Label a projects folder with why it will fail, when that is already known. */
  async #markProjects(node: VNode): Promise<VNode> {
    await this.#scopeProbe;
    const reason = this.#projectFailures.get(ALL_OWNERS) ?? this.#projectFailures.get(projectKey(node.meta ?? {}));
    return reason === undefined ? node : { ...node, unavailable: reason };
  }

  get #api(): GitHubClient {
    if (this.#client === undefined) throw VfsError.config('The GitHub mount was not initialised.');
    return this.#client;
  }

  /** Opt-out options: present and `false` disables, anything else leaves the default on. */
  #wants(option: 'includeDiscussions' | 'includeProjects'): boolean {
    return this.#options[option] !== false;
  }

  #showDiscussions(): boolean {
    return this.#graphqlAvailable && this.#wants('includeDiscussions');
  }

  #showProjects(): boolean {
    return this.#graphqlAvailable && this.#wants('includeProjects');
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const level = (parent === null ? 'root' : String(parent.meta?.['level'] ?? '')) as Level;

    switch (level) {
      case 'root':
        return paginate(this.#rootEntries(), options);

      case 'owner': {
        const owner = String(parent?.meta?.['owner'] ?? '');
        const entries = this.#repos
          .filter((r) => r.owner === owner)
          // The folder name is sanitized but `meta.repo` keeps the real one, because a
          // repository called `.github` — which most organizations have — would otherwise
          // be a folder that half the tools on the machine treat as hidden.
          .map((r) => dir(dirName(r.repo), `${owner}/${r.repo}`, 'repo', { level: 'repo', owner, repo: r.repo }));
        if (this.#showProjects()) {
          // Emitted first so that an owner who also has a repository called "projects"
          // gives the plain name to the folder that is always there, and the engine's
          // deduplication renames the repository rather than the other way round.
          entries.unshift(
            await this.#markProjects(
              dir('projects', `${owner} projects`, 'folder', { level: 'projects', scope: 'owner', owner }),
            ),
          );
        }
        return paginate(entries, options);
      }

      case 'repo': {
        const owner = String(parent?.meta?.['owner'] ?? '');
        const repo = String(parent?.meta?.['repo'] ?? '');
        const entries = [dir('issues', 'Issues', 'folder', { level: 'issues', owner, repo })];
        if (this.#options.includePulls !== false) {
          entries.push(dir('pulls', 'Pull requests', 'folder', { level: 'pulls', owner, repo }));
        }
        if (this.#showDiscussions()) {
          entries.push(dir('discussions', 'Discussions', 'folder', { level: 'discussions', owner, repo }));
        }
        if (this.#showProjects()) {
          entries.push(
            await this.#markProjects(
              dir('projects', 'Projects', 'folder', { level: 'projects', scope: 'repo', owner, repo }),
            ),
          );
        }
        return paginate(entries, options);
      }

      case 'issues':
        return this.#listIssues(parent as VNode, options);

      case 'pulls':
        return this.#listPulls(parent as VNode, options);

      case 'discussions':
        return this.#listDiscussions(parent as VNode, options);

      case 'projects':
        return this.#listProjects(parent as VNode, options);

      case 'project':
        return this.#listProjectItems(parent as VNode, options);

      case 'notifications':
        return this.#listNotifications(options);

      default:
        throw VfsError.notDirectory(parent?.path ?? '/');
    }
  }

  #rootEntries(): VNode[] {
    const entries = this.#owners.map((owner) => dir(dirName(owner), owner, 'owner', { level: 'owner', owner }));
    if (this.#options.includeNotifications === true) {
      entries.unshift(dir('notifications', 'Notifications', 'folder', { level: 'notifications' }));
    }
    return entries;
  }

  /**
   * Fetch one REST page and cut it down to the size the caller asked for.
   *
   * `per_page` alone cannot do this. It is only on the *first* URL this provider builds;
   * every page after that comes from GitHub's `Link` header, which carries the page size
   * that was in force when the link was minted. So a reader who lists with `limit: 50` and
   * then asks for the next page with `limit: 5` gets fifty entries, because the cursor
   * outranks the new limit. Rewriting `per_page` on the link is not a fix either — GitHub
   * pages by number, so changing the size mid-walk makes `page=3` point at different rows
   * and quietly skips or repeats items.
   *
   * Hence a cursor that carries both the URL and how far into that URL's page we have got.
   * The page is fetched whole and served out in `limit`-sized slices; only when a slice
   * reaches the end does the next cursor move on to GitHub's next link.
   */
  async #restPage<T>(
    path: string,
    options: ListOptions,
    keep?: (item: T) => boolean,
  ): Promise<{ items: readonly T[]; cursor?: string }> {
    const { url, offset } = decodeRestCursor(options.cursor, path);
    const response = await this.#api.get<T[]>(
      url,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const all = keep === undefined ? response.data : response.data.filter(keep);
    const items = all.slice(offset, offset + pageSize(options, all.length));
    const next = offset + items.length;

    // Two ways to have more: further down this page, or on GitHub's next one. A stale
    // cursor pointing past a page that has since shrunk lands here with an empty slice and
    // falls through to the next link or to no cursor at all, so paging still terminates.
    if (next < all.length) return { items, cursor: encodeRestCursor(url, next) };
    if (response.nextPage !== undefined) return { items, cursor: encodeRestCursor(response.nextPage, 0) };
    return { items };
  }

  async #listIssues(parent: VNode, options: ListOptions): Promise<ListPage> {
    const owner = String(parent.meta?.['owner'] ?? '');
    const repo = String(parent.meta?.['repo'] ?? '');

    const { path, applied } = this.#buildIssuesPath(owner, repo, options);
    // The issues endpoint returns pull requests too; they have their own folder.
    const page = await this.#restPage<IssuePayload>(
      path,
      options,
      (item) => item.pull_request === undefined,
    );

    return {
      entries: page.items.map((item) => this.#toIssueNode(item, owner, repo)),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
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
  #buildIssuesPath(owner: string, repo: string, options: ListOptions): { path: string; applied?: Query } {
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
      } else if (query.field === 'author' && isWholeStringMatch(query)) {
        // `creator` is an exact login. The local matcher is a substring match unless the
        // term asked for equality, so pushing `author:ali` down would return nothing where
        // the engine would have matched alice — and claiming it would stop the engine from
        // noticing. Both the parameter and the claim are therefore limited to the one form
        // whose meaning survives the trip.
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

    return {
      path: `/repos/${owner}/${repo}/issues?${params.toString()}`,
      ...(applied === undefined ? {} : { applied }),
    };
  }

  /**
   * Pull requests, from the endpoint that is actually about pull requests.
   *
   * Deriving them from `/issues` and discarding whatever was not a pull request looks
   * equivalent — GitHub does model a pull request as an issue — but it breaks paging in a
   * way that gets worse the more successful a repository is. A page is fifty *issues and
   * pull requests*, so in a repository with twenty open issues per pull request, a fifty
   * item fetch yields two or three entries, and `ls` reports "more" for pages that are
   * mostly empty. Asking `/pulls` returns fifty pull requests, and brings `head`, `base`
   * and `merged_at` along, none of which the issues endpoint has.
   */
  async #listPulls(parent: VNode, options: ListOptions): Promise<ListPage> {
    const owner = String(parent.meta?.['owner'] ?? '');
    const repo = String(parent.meta?.['repo'] ?? '');

    const { path, applied } = this.#buildPullsPath(owner, repo, options);
    const page = await this.#restPage<PullPayload>(path, options);

    return {
      entries: page.items.map((item) => this.#toPullNode(item, owner, repo)),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      ...(applied === undefined ? {} : { appliedQuery: applied }),
    };
  }

  #buildPullsPath(owner: string, repo: string, options: ListOptions): { path: string; applied?: Query } {
    const params = new URLSearchParams({
      per_page: String(Math.min(options.limit ?? 50, 100)),
      state: this.#options.state ?? 'open',
      sort: 'updated',
      direction: 'desc',
    });

    const query = options.query;
    let applied: Query | undefined;

    // Narrower than the issues endpoint on purpose: `/pulls` has no `creator` and no
    // `since`, so `author:` and `after:` must be left to the engine. Claiming them here
    // because the sibling endpoint supports them is exactly the over-claim that returns
    // silently wrong results.
    //
    // `is:closed` is the subtler trap. GitHub calls a merged pull request closed, and this
    // provider does not — a merged one is flagged `merged`, because whether a pull request
    // landed or was abandoned is the entire question a reader has about a closed one. So
    // `state=closed` is the right fetch for both, but only `is:open` can be *claimed*:
    // claiming `is:closed` would hand back merged pull requests with local filtering
    // switched off, and the engine's own predicate rejects every one of them.
    if (query !== undefined && query.type === 'term' && query.field === 'is') {
      const value = query.value.toLowerCase();
      if (value === 'open') {
        params.set('state', 'open');
        applied = query;
      } else if (value === 'closed' || value === 'merged') {
        params.set('state', 'closed');
      } else {
        // `is:draft`, `is:review-requested` and the rest are decided from the node, so the
        // only useful thing to do is stop the mount's default state from hiding matches.
        params.set('state', 'all');
      }
    } else if (query !== undefined && queryFields(query).has('is')) {
      params.set('state', 'all');
    }

    return {
      path: `/repos/${owner}/${repo}/pulls?${params.toString()}`,
      ...(applied === undefined ? {} : { applied }),
    };
  }

  async #listDiscussions(parent: VNode, options: ListOptions): Promise<ListPage> {
    const owner = String(parent.meta?.['owner'] ?? '');
    const repo = String(parent.meta?.['repo'] ?? '');

    const { data, errors } = await this.#api.graphql<DiscussionsResponse>(
      DISCUSSIONS_QUERY,
      {
        owner,
        repo,
        first: Math.min(options.limit ?? 50, 100),
        after: options.cursor ?? null,
        categoryId: null,
      },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.#logPartial('discussions', errors);

    const connection = data.repository?.discussions ?? null;
    return {
      entries: nodesOf(connection).map((item) => this.#toDiscussionNode(item, owner, repo)),
      ...(nextCursor(connection) === undefined ? {} : { cursor: nextCursor(connection) as string }),
      ...(connection?.totalCount === undefined ? {} : { total: connection.totalCount }),
    };
  }

  async #listProjects(parent: VNode, options: ListOptions): Promise<ListPage> {
    return this.#trackProjects(parent, () => this.#fetchProjects(parent, options));
  }

  /**
   * Run a projects request and learn from how it goes.
   *
   * Both directions matter. A refusal is remembered so the folder can carry the reason next
   * time it is listed, and a clean answer clears it, because a token can be refreshed
   * without restarting the shell and scope detection is only a heuristic. Clearing is what
   * keeps the label a warning rather than a verdict the user cannot argue with.
   *
   * "Clean" is doing real work in that sentence. GraphQL answers a half-refused query with
   * data *and* errors, and the client deliberately does not throw on that, so the boards the
   * token may not see come back as an empty connection. Treating that as proof of access
   * would delete a true warning and leave an empty folder in its place — the listing would
   * look fine and be wrong, which is the one outcome worse than the error.
   */
  async #trackProjects(parent: VNode, run: () => Promise<ProjectFetch>): Promise<ListPage> {
    const key = projectKey(parent.meta ?? {});
    try {
      const { page, clean } = await run();
      if (clean) {
        this.#projectFailures.delete(key);
        // A board that really loaded disproves the scope probe as well, whoever owns it.
        this.#projectFailures.delete(ALL_OWNERS);
      }
      return page;
    } catch (error) {
      this.#noteProjectFailure(key, error);
      throw error;
    }
  }

  async #fetchProjects(parent: VNode, options: ListOptions): Promise<ProjectFetch> {
    const owner = String(parent.meta?.['owner'] ?? '');
    const repo = String(parent.meta?.['repo'] ?? '');
    const scope = String(parent.meta?.['scope'] ?? 'owner');
    const first = Math.min(options.limit ?? 50, 100);

    if (scope === 'repo') {
      const { data, errors } = await this.#api.graphql<RepoProjectsResponse>(
        REPO_PROJECTS_QUERY,
        { owner, repo, first, after: options.cursor ?? null },
        options.signal === undefined ? {} : { signal: options.signal },
      );
      this.#logPartial('projects', errors);
      const connection = data.repository?.projectsV2 ?? null;
      return {
        clean: isClean(errors, connection),
        page: {
          entries: nodesOf(connection).map((item) => this.#toProjectNode(item, owner, repo)),
          ...(nextCursor(connection) === undefined ? {} : { cursor: nextCursor(connection) as string }),
          ...(connection?.totalCount === undefined ? {} : { total: connection.totalCount }),
        },
      };
    }

    const { data, errors } = await this.#api.graphql<OwnerProjectsResponse>(
      OWNER_PROJECTS_QUERY,
      { login: owner, first, after: options.cursor ?? null },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.#logPartial('projects', errors);

    const connection = data.repositoryOwner?.projectsV2 ?? null;
    return {
      clean: isClean(errors, connection),
      page: {
        entries: nodesOf(connection).map((item) => this.#toProjectNode(item, owner)),
        ...(nextCursor(connection) === undefined ? {} : { cursor: nextCursor(connection) as string }),
        ...(connection?.totalCount === undefined ? {} : { total: connection.totalCount }),
      },
    };
  }

  async #listProjectItems(parent: VNode, options: ListOptions): Promise<ListPage> {
    return this.#trackProjects(parent, () => this.#fetchProjectItems(parent, options));
  }

  async #fetchProjectItems(parent: VNode, options: ListOptions): Promise<ProjectFetch> {
    const projectId = String(parent.meta?.['projectId'] ?? '');
    if (projectId === '') throw VfsError.notFound(parent.path ?? parent.name);

    const { data, errors } = await this.#api.graphql<ProjectItemsResponse>(
      PROJECT_ITEMS_QUERY,
      { id: projectId, first: Math.min(options.limit ?? 50, 100), after: options.cursor ?? null },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.#logPartial('project items', errors);

    // A null node is GitHub's way of saying the board is gone — deleted, or moved out of
    // view since this folder was listed. An empty folder would suggest a board with no
    // cards, which is a different thing and sends the reader looking for the wrong problem.
    if (data.node === null || data.node === undefined) {
      throw VfsError.notFound(parent.path ?? parent.name);
    }

    const connection = data.node.items ?? null;
    const project = String(parent.meta?.['project'] ?? parent.title);
    return {
      clean: isClean(errors, connection),
      page: {
        entries: nodesOf(connection).map((item) => this.#toProjectItemNode(item, projectId, project)),
        ...(nextCursor(connection) === undefined ? {} : { cursor: nextCursor(connection) as string }),
        ...(connection?.totalCount === undefined ? {} : { total: connection.totalCount }),
      },
    };
  }

  async #listNotifications(options: ListOptions): Promise<ListPage> {
    if (!this.#api.authenticated) {
      throw new VfsError('EAUTH', 'Listing notifications needs a token.', {
        hint: 'Set GITHUB_TOKEN, or remove "includeNotifications" from this mount.',
      });
    }
    const page = await this.#restPage<NotificationPayload>(
      `/notifications?per_page=${String(pageSize(options, DEFAULT_PAGE))}`,
      options,
    );

    return {
      entries: page.items.map((item) => {
        const at = new Date(item.updated_at);
        return {
          name: fileName(`${timestampPrefix(at)} ${item.repository.full_name} ${item.subject.title}`),
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
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  }

  /**
   * A GraphQL response can be partially successful — five of six projects, plus an error
   * for the one the token cannot see. Dropping that on the floor makes a missing board look
   * like a board that does not exist, so it is logged and the rest is shown.
   */
  #logPartial(what: string, errors: readonly { message?: string }[]): void {
    if (errors.length === 0) return;
    this.#context.logger.warn(
      `GitHub returned ${String(errors.length)} error(s) while listing ${what}; showing what came back.`,
      { first: errors[0]?.message ?? '' },
    );
  }

  // -------------------------------------------------------------------------
  // Node mapping
  // -------------------------------------------------------------------------

  #toIssueNode(item: IssuePayload, owner: string, repo: string): VNode {
    const updated = new Date(item.updated_at);
    const flags = [item.state === 'open' ? 'open' : 'closed'];
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
      name: fileName(`${timestampPrefix(updated)} #${String(item.number)} ${item.title}`),
      kind: 'file',
      subtype: 'issue',
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

  #toPullNode(item: PullPayload, owner: string, repo: string): VNode {
    const updated = new Date(item.updated_at);
    const merged = item.merged === true || item.merged_at !== null;
    // `merged` is a third state the API reports as `closed`, and the difference is the
    // whole point of looking: a merged pull request landed, a closed one was abandoned.
    const flags = [merged ? 'merged' : item.state === 'open' ? 'open' : 'closed'];
    if (item.draft === true) flags.push('draft');
    if ((item.requested_reviewers ?? []).length > 0) flags.push('review-requested');

    const labels = item.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(', ');
    const assignees = (item.assignees ?? []).map((a) => a.login).join(', ');
    const reviewers = (item.requested_reviewers ?? []).map((r) => r.login).join(', ');

    return {
      name: fileName(`${timestampPrefix(updated)} #${String(item.number)} ${item.title}`),
      kind: 'file',
      subtype: 'pull',
      title: `#${String(item.number)} ${item.title}`,
      id: `${owner}/${repo}#${String(item.number)}`,
      mtime: updated,
      size: (item.body ?? '').length,
      flags,
      ...(item.body === null ? {} : { summary: firstLine(item.body) }),
      ...(item.user === null ? {} : { author: item.user.login, authorId: item.user.login }),
      meta: {
        level: 'pull',
        owner,
        repo,
        number: item.number,
        state: merged ? 'merged' : item.state,
        url: item.html_url,
        created: item.created_at,
        ...(item.head === undefined ? {} : { head: item.head.ref }),
        ...(item.base === undefined ? {} : { base: item.base.ref }),
        ...(item.merged_at === null ? {} : { merged: item.merged_at }),
        ...(labels === '' ? {} : { labels }),
        ...(assignees === '' ? {} : { assignees }),
        ...(reviewers === '' ? {} : { reviewers }),
      },
    };
  }

  #toDiscussionNode(item: DiscussionSummary, owner: string, repo: string): VNode {
    const updated = new Date(item.updatedAt);
    const answerable = item.category?.isAnswerable === true;
    const comments = item.comments?.totalCount ?? 0;

    const flags: string[] = [];
    if (item.isAnswered === true) flags.push('answered');
    // `unanswered` in its most literal sense: a question category with no accepted answer.
    // The well-known flag means "the ball is in your court", which is exactly what an
    // unanswered question in a Q&A category is, so `is:unanswered` keeps one meaning
    // across mounts rather than gaining a second one here.
    else if (answerable) flags.push('unanswered');
    if (item.locked) flags.push('locked');
    if (comments > 0) flags.push('discussed');

    const category = item.category?.name ?? '';

    return {
      name: fileName(`${timestampPrefix(updated)} #${String(item.number)} ${item.title}`),
      kind: 'file',
      subtype: 'discussion',
      title: `#${String(item.number)} ${item.title}`,
      id: `discussion:${owner}/${repo}#${String(item.number)}`,
      mtime: updated,
      size: (item.bodyText ?? '').length,
      flags,
      ...(item.bodyText === null ? {} : { summary: firstLine(item.bodyText) }),
      ...(item.author === null ? {} : { author: item.author.login, authorId: item.author.login }),
      meta: {
        level: 'discussion',
        owner,
        repo,
        number: item.number,
        url: item.url,
        created: item.createdAt,
        comments,
        upvotes: item.upvoteCount,
        answerable,
        ...(category === '' ? {} : { category }),
      },
    };
  }

  #toProjectNode(item: ProjectSummary, owner: string, repo?: string): VNode {
    const updated = new Date(item.updatedAt);
    // Numbered rather than titled alone because project titles collide freely — every
    // other organization has two boards called "Roadmap" — and the number is the stable
    // thing a user sees in the GitHub URL.
    return {
      name: dirName(`#${String(item.number)} ${item.title}`),
      kind: 'dir',
      subtype: 'project',
      title: item.title,
      id: `project:${item.id}`,
      mtime: updated,
      flags: [item.closed ? 'closed' : 'open'],
      ...(item.shortDescription === null ? {} : { summary: firstLine(item.shortDescription) }),
      ...(item.items?.totalCount === undefined ? {} : { childCount: item.items.totalCount }),
      meta: {
        level: 'project',
        projectId: item.id,
        project: item.title,
        number: item.number,
        owner,
        url: item.url,
        created: item.createdAt,
        visibility: item.public ? 'public' : 'private',
        state: item.closed ? 'closed' : 'open',
        ...(repo === undefined ? {} : { repo }),
      },
    };
  }

  #toProjectItemNode(item: ProjectItem, projectId: string, project: string): VNode {
    const content = item.content;
    const updated = new Date(content?.updatedAt ?? item.updatedAt);
    const kind = content?.__typename ?? item.type;
    const number = content?.number;
    const title = content?.title ?? '(untitled)';
    const fields = fieldValueMap(item);

    const flags: string[] = [];
    if (item.isArchived) flags.push('archived');
    if (content?.merged === true) flags.push('merged');
    else if (content?.state !== undefined) flags.push(content.state.toLowerCase() === 'open' ? 'open' : 'closed');
    if (content?.isDraft === true || kind === 'DraftIssue') flags.push('draft');

    const author = content?.author?.login ?? content?.creator?.login;
    const label = number === undefined ? title : `#${String(number)} ${title}`;

    return {
      name: fileName(`${timestampPrefix(updated)} ${label}`),
      kind: 'file',
      subtype: 'project-item',
      title: label,
      // The project item id, not the issue's: the same issue can sit on several boards,
      // and each card carries its own field values.
      id: `project-item:${item.id}`,
      mtime: updated,
      size: (content?.bodyText ?? '').length,
      flags,
      ...(content?.bodyText == null ? {} : { summary: firstLine(content.bodyText) }),
      ...(author === undefined ? {} : { author, authorId: author }),
      meta: {
        level: 'project-item',
        itemId: item.id,
        projectId,
        project,
        type: kind,
        ...(number === undefined ? {} : { number }),
        ...(content?.url === undefined ? {} : { url: content.url }),
        ...(content?.repository?.nameWithOwner === undefined ? {} : { repository: content.repository.nameWithOwner }),
        ...(content?.state === undefined ? {} : { state: content.state.toLowerCase() }),
        created: content?.createdAt ?? item.createdAt,
        archived: item.isArchived,
        // Board columns are user-defined fields, so they arrive as data rather than as
        // named properties. Flattening them into `meta` is what makes `meta:Status=Done`
        // work without the engine or the config knowing any board's vocabulary.
        ...Object.fromEntries(fields),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    const level = String(node.meta?.['level'] ?? '');

    switch (level) {
      case 'notification':
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

      case 'pull':
        return this.#readPull(node, options);

      case 'discussion':
        return this.#readDiscussion(node, options);

      case 'project-item':
        return this.#readProjectItem(node, options);

      default:
        return this.#readIssue(node, options);
    }
  }

  async #readIssue(node: VNode, options: ReadOptions): Promise<Document> {
    const { owner, repo, number } = this.#locate(node);

    const issue = await this.#api.get<IssuePayload>(
      `/repos/${owner}/${repo}/issues/${String(number)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const parts: string[] = [issue.data.body ?? '_No description._'];

    if (this.#options.includeComments !== false && issue.data.comments > 0) {
      parts.push(...(await this.#issueComments(owner, repo, number, options)));
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

  /**
   * A pull request, with the numbers that decide whether it is worth opening.
   *
   * The detail endpoint is a separate request from the listing on purpose: `additions`,
   * `deletions`, `changed_files` and `mergeable` are computed per pull request and GitHub
   * only returns them when one is asked for by number. That is also why `mergeable` can
   * come back null — GitHub computes the merge in the background and says "ask again" —
   * which is reported as "being computed" rather than silently as "no".
   */
  async #readPull(node: VNode, options: ReadOptions): Promise<Document> {
    const { owner, repo, number } = this.#locate(node);
    const signal = options.signal === undefined ? {} : { signal: options.signal };

    const pull = await this.#api.get<PullPayload>(`/repos/${owner}/${repo}/pulls/${String(number)}`, signal);
    const data = pull.data;
    const merged = data.merged === true || data.merged_at !== null;

    const parts: string[] = [data.body ?? '_No description._'];

    if (this.#options.includeComments !== false) {
      // Reviews first, then the conversation. A reviewer's verdict is the thing a reader
      // is looking for, and burying it after forty comments means listening to all forty.
      parts.push(...(await this.#pullReviews(owner, repo, number, options)));
      if ((data.comments ?? 0) > 0) parts.push(...(await this.#issueComments(owner, repo, number, options)));
    }

    const labels = data.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const reviewers = (data.requested_reviewers ?? []).map((r) => r.login);

    const headers: Array<readonly [string, string]> = [
      ['Author', data.user?.login ?? 'unknown'],
      ['State', merged ? 'merged' : data.state],
      ['Created', new Date(data.created_at).toISOString()],
      ['Updated', new Date(data.updated_at).toISOString()],
      ['Repository', `${owner}/${repo}`],
    ];
    if (data.head !== undefined && data.base !== undefined) {
      headers.push(['Branch', `${data.head.ref} into ${data.base.ref}`]);
    }
    if (data.changed_files !== undefined) {
      headers.push([
        'Changes',
        `${String(data.changed_files)} file(s), +${String(data.additions ?? 0)} -${String(data.deletions ?? 0)}`,
      ]);
    }
    if (!merged && data.state === 'open') {
      headers.push(['Mergeable', data.mergeable === null || data.mergeable === undefined ? 'being computed' : String(data.mergeable)]);
    }
    if (reviewers.length > 0) headers.push(['Reviewers requested', reviewers.join(', ')]);
    if (labels.length > 0) headers.push(['Labels', labels.join(', ')]);

    return {
      title: `#${String(data.number)} ${data.title}`,
      headers,
      body: parts.join('\n'),
      format: 'markdown',
      webUrl: data.html_url,
    };
  }

  async #readDiscussion(node: VNode, options: ReadOptions): Promise<Document> {
    const { owner, repo, number } = this.#locate(node);

    const { data, errors } = await this.#api.graphql<DiscussionResponse>(
      DISCUSSION_QUERY,
      { owner, repo, number, comments: this.#options.includeComments === false ? 0 : 50 },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.#logPartial('a discussion', errors);

    const discussion = data.repository?.discussion;
    if (discussion === null || discussion === undefined) throw VfsError.notFound(node.path ?? node.name);

    const parts: string[] = [discussion.body ?? '_No description._'];

    // The whole thread in one document, comments and their replies, for the same reason
    // issue comments are inlined: a conversation read linearly is how a screen reader
    // reads and how anyone catching up actually wants it. Replies are indented as
    // blockquotes so the nesting survives being read aloud rather than depending on layout.
    for (const comment of nodesOf(discussion.comments)) {
      parts.push(
        '',
        '---',
        `**${comment.author?.login ?? 'unknown'}** commented on ${new Date(comment.createdAt).toLocaleString()}${
          comment.isAnswer ? ' — marked as the answer' : ''
        }:`,
        '',
        comment.body ?? '',
      );
      for (const reply of nodesOf(comment.replies)) {
        parts.push(
          '',
          `> **${reply.author?.login ?? 'unknown'}** replied on ${new Date(reply.createdAt).toLocaleString()}:`,
          '>',
          ...(reply.body ?? '').split('\n').map((line) => `> ${line}`),
        );
      }
    }

    const total = discussion.comments?.totalCount ?? 0;
    const shown = nodesOf(discussion.comments).length;
    if (total > shown) parts.push('', '---', `_${String(total - shown)} more comment(s) not shown._`);

    const headers: Array<readonly [string, string]> = [
      ['Author', discussion.author?.login ?? 'unknown'],
      ['Category', discussion.category?.name ?? 'uncategorized'],
      ['Created', new Date(discussion.createdAt).toISOString()],
      ['Updated', new Date(discussion.updatedAt).toISOString()],
      ['Repository', `${owner}/${repo}`],
    ];
    if (discussion.category?.isAnswerable === true) {
      headers.push(['Answered', discussion.isAnswered === true ? 'yes' : 'no']);
    }
    if (discussion.upvoteCount > 0) headers.push(['Upvotes', String(discussion.upvoteCount)]);
    if (total > 0) headers.push(['Comments', String(total)]);
    if (discussion.locked) headers.push(['Locked', 'yes']);

    return {
      title: `#${String(discussion.number)} ${discussion.title}`,
      headers,
      body: parts.join('\n'),
      format: 'markdown',
      webUrl: discussion.url,
    };
  }

  async #readProjectItem(node: VNode, options: ReadOptions): Promise<Document> {
    const itemId = String(node.meta?.['itemId'] ?? '');
    if (itemId === '') throw VfsError.notFound(node.path ?? node.name);

    const { data, errors } = await this.#api.graphql<ProjectItemBodyResponse>(
      PROJECT_ITEM_BODY_QUERY,
      { id: itemId },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.#logPartial('a project item', errors);

    const item = data.node;
    if (item === null || item === undefined) throw VfsError.notFound(node.path ?? node.name);

    const content = item.content;
    const number = content?.number;
    const title = content?.title ?? node.title;

    const headers: Array<readonly [string, string]> = [
      ['Project', String(node.meta?.['project'] ?? '')],
      ['Type', readableType(content?.__typename ?? String(node.meta?.['type'] ?? ''))],
    ];
    const author = content?.author?.login ?? content?.creator?.login;
    if (author !== undefined) headers.push(['Author', author]);
    if (content?.repository?.nameWithOwner !== undefined) {
      headers.push(['Repository', content.repository.nameWithOwner]);
    }
    if (content?.state !== undefined) {
      headers.push(['State', content.merged === true ? 'merged' : content.state.toLowerCase()]);
    }
    // Board fields come after the fixed ones so the reading order is predictable: the same
    // five rows every time, then whatever this particular board happens to track.
    for (const [name, value] of fieldValueMap(item as ProjectItem)) headers.push([name, value]);
    if (content?.updatedAt !== undefined) headers.push(['Updated', new Date(content.updatedAt).toISOString()]);

    return {
      title: number === undefined ? title : `#${String(number)} ${title}`,
      headers,
      body: content?.body ?? '_No description._',
      format: 'markdown',
      ...(content?.url === undefined ? {} : { webUrl: content.url }),
    };
  }

  /** Comments on an issue or a pull request, as document parts. */
  async #issueComments(owner: string, repo: string, number: number, options: ReadOptions): Promise<string[]> {
    // Comments are appended into one document rather than exposed as separate files.
    // A conversation read linearly — which is how a screen reader reads, and how anyone
    // catching up on a thread actually wants it — should be one continuous body, not a
    // directory the user has to walk one file at a time.
    try {
      const comments = await this.#api.get<CommentPayload[]>(
        `/repos/${owner}/${repo}/issues/${String(number)}/comments?per_page=100`,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      const parts: string[] = [];
      for (const comment of comments.data) {
        parts.push(
          '',
          '---',
          `**${comment.user?.login ?? 'unknown'}** commented on ${new Date(comment.created_at).toLocaleString()}:`,
          '',
          comment.body ?? '',
        );
      }
      return parts;
    } catch (error) {
      // A failure to load comments must not hide the issue itself.
      return ['', '---', `_Comments could not be loaded: ${error instanceof Error ? error.message : String(error)}_`];
    }
  }

  async #pullReviews(owner: string, repo: string, number: number, options: ReadOptions): Promise<string[]> {
    try {
      const reviews = await this.#api.get<ReviewPayload[]>(
        `/repos/${owner}/${repo}/pulls/${String(number)}/reviews?per_page=100`,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      const parts: string[] = [];
      for (const review of reviews.data) {
        // A `PENDING` review is the viewer's own unsubmitted draft, and a `COMMENTED`
        // review with no body is the empty envelope GitHub creates around inline comments.
        // Neither says anything, and both would read aloud as a row of noise.
        if (review.state === 'PENDING') continue;
        if ((review.body ?? '') === '' && review.state === 'COMMENTED') continue;
        parts.push(
          '',
          '---',
          `**${review.user?.login ?? 'unknown'}** ${reviewVerb(review.state)}${
            review.submitted_at === null ? '' : ` on ${new Date(review.submitted_at).toLocaleString()}`
          }:`,
          '',
          review.body ?? '_No comment._',
        );
      }
      return parts;
    } catch (error) {
      return ['', '---', `_Reviews could not be loaded: ${error instanceof Error ? error.message : String(error)}_`];
    }
  }

  /** The owner, repo and number a node was built from, or a clean ENOENT. */
  #locate(node: VNode): { owner: string; repo: string; number: number } {
    const owner = String(node.meta?.['owner'] ?? '');
    const repo = String(node.meta?.['repo'] ?? '');
    const number = Number(node.meta?.['number'] ?? 0);
    if (owner === '' || repo === '' || number === 0) throw VfsError.notFound(node.path ?? node.name);
    return { owner, repo, number };
  }

  // -------------------------------------------------------------------------
  // Polling and actions
  // -------------------------------------------------------------------------

  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    const level = parent === null ? 'root' : String(parent.meta?.['level'] ?? '');
    const since = cursor ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
    const signal = options.signal === undefined ? {} : { signal: options.signal };

    if (level === 'notifications') {
      const page = await this.#listNotifications(signal);
      const changes = page.entries
        .filter((node) => (node.mtime?.toISOString() ?? '') > since)
        .map((node) => ({ type: 'created' as const, path: node.name, node, at: node.mtime ?? new Date() }));
      return { changes, cursor: new Date().toISOString() };
    }

    const owner = String(parent?.meta?.['owner'] ?? '');
    const repo = String(parent?.meta?.['repo'] ?? '');

    if (level === 'issues') {
      const response = await this.#api.get<IssuePayload[]>(
        `/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50&since=${encodeURIComponent(since)}`,
        signal,
      );
      return {
        changes: response.data
          .filter((item) => item.pull_request === undefined)
          .map((item) => toChange(this.#toIssueNode(item, owner, repo), item.created_at, since)),
        cursor: new Date().toISOString(),
      };
    }

    if (level === 'pulls') {
      // The pulls endpoint has no `since`, so the window is applied here. Sorting by
      // update descending means the loop can stop at the first item older than the cursor
      // rather than reading every open pull request in the repository.
      const response = await this.#api.get<PullPayload[]>(
        `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
        signal,
      );
      const changes = [];
      for (const item of response.data) {
        if (new Date(item.updated_at).toISOString() <= since) break;
        changes.push(toChange(this.#toPullNode(item, owner, repo), item.created_at, since));
      }
      return { changes, cursor: new Date().toISOString() };
    }

    if (level === 'discussions') {
      const { data } = await this.#api.graphql<DiscussionsResponse>(
        DISCUSSIONS_QUERY,
        { owner, repo, first: 50, after: null, categoryId: null },
        signal,
      );
      const changes = [];
      // Ordered by update descending by the query, so the same early exit applies.
      for (const item of nodesOf(data.repository?.discussions ?? null)) {
        if (new Date(item.updatedAt).toISOString() <= since) break;
        changes.push(toChange(this.#toDiscussionNode(item, owner, repo), item.createdAt, since));
      }
      return { changes, cursor: new Date().toISOString() };
    }

    return { changes: [], cursor: new Date().toISOString() };
  }

  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    if (node.meta?.['url'] === undefined) return [];
    return [{ name: 'url', label: 'Show the web URL', description: 'Print the canonical GitHub URL for this item.' }];
  }

  async invoke(action: string, node: VNode, _params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    if (action !== 'url') throw VfsError.unsupported(`Action "${action}"`, this.id);
    return { ok: true, message: String(node.meta?.['url'] ?? '') };
  }
}

function dir(name: string, title: string, subtype: string, meta: Record<string, MetaValue>): VNode {
  return { name, kind: 'dir', subtype, title, id: `${subtype}:${name}:${JSON.stringify(meta)}`, meta };
}

/**
 * Boil a refusal down to something that fits on one line next to a folder name.
 *
 * The label has to say what to *do*, not what happened, because it is read in a listing
 * where there is no room to explain. The two causes worth telling apart are the missing
 * scope and SAML enforcement: both arrive as a 403, and the fixes have nothing in common —
 * one is `gh auth refresh`, the other is a button on the organization's settings page.
 * Anything else stays vague on purpose rather than guessing wrong in a confident voice.
 */
function describeRefusal(message: string): string {
  if (/saml|\bsso\b|single sign/i.test(message)) return 'this token is not SSO-authorized for this organization';
  if (/scope/i.test(message)) return 'needs the read:project scope';
  return 'this token cannot read projects';
}

/** The key for a reason that holds no matter whose boards you ask for. */
const ALL_OWNERS = '*';

/**
 * Which boards a projects reason covers, derived from the node's own metadata.
 *
 * Owner-scope and repo-scope boards are separate permissions on GitHub's side and have to
 * stay separate here, or one org's refusal starts speaking for another's. Project items
 * inherit the key of the board they belong to, since a card is unreachable for exactly the
 * reasons its board is.
 */
function projectKey(meta: Readonly<Record<string, MetaValue>>): string {
  const owner = String(meta['owner'] ?? '');
  const repo = String(meta['repo'] ?? '');
  return repo === '' ? `owner:${owner}` : `repo:${owner}/${repo}`;
}

/** A page, plus whether GitHub answered it in full. */
interface ProjectFetch {
  readonly page: ListPage;
  readonly clean: boolean;
}

/**
 * Did that answer actually prove the boards are readable?
 *
 * Only if GitHub raised nothing *and* returned a connection. A partial success — data with
 * an errors array, or a nulled connection — is the shape of "you may not see these", which
 * is the opposite of proof, however much it looks like an ordinary empty folder.
 */
function isClean(errors: readonly unknown[] | undefined, connection: unknown): boolean {
  return (errors === undefined || errors.length === 0) && connection !== null && connection !== undefined;
}

/**
 * Turn text that came from GitHub into one safe path segment.
 *
 * Everything here is user-supplied: issue titles, board names, and — worst of all — the
 * `owner/repo` a notification names, which contains a slash *every single time*. A name
 * with a slash in it reads as a directory level that does not exist, so the whole tree
 * would quietly fork one level too deep. Titles are also unbounded, and a filesystem
 * component is not, which is the other half of what the core sanitizer handles.
 */
function fileName(text: string): string {
  return sanitizeSegment(text, { extension: '.md' });
}

/** As `fileName`, for the directory levels, which carry no extension. */
function dirName(text: string): string {
  return sanitizeSegment(text, { extension: '' });
}

const OFFSET_CURSOR = 'offset:';
const REST_CURSOR = 'rest:';
const DEFAULT_PAGE = 50;

/**
 * How many entries to hand back for one call.
 *
 * `limit` is not advisory. The engine sizes a page to what it is about to draw and then
 * trusts the length it gets, so a provider that returns more rows than it was asked for
 * corrupts the caller's paging rather than its own.
 */
function pageSize(options: ListOptions, fallback: number): number {
  return Math.max(1, Math.min(options.limit ?? fallback, 500));
}

/**
 * Page a list that was assembled from configuration rather than fetched.
 *
 * The mount root, an owner and a repository are each a short fixed list, so handing the
 * whole thing back looks harmless — but see `pageSize`. An offset is a sound cursor at
 * exactly these levels, because the list comes from configuration and cannot shift
 * underneath a reader part way through.
 */
function paginate(entries: readonly VNode[], options: ListOptions): ListPage {
  const offset = parseOffsetCursor(options.cursor);
  const slice = entries.slice(offset, offset + pageSize(options, entries.length));
  const next = offset + slice.length;

  return {
    entries: slice,
    ...(next < entries.length ? { cursor: `${OFFSET_CURSOR}${String(next)}` } : {}),
    total: entries.length,
  };
}

function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(OFFSET_CURSOR)) {
    throw VfsError.invalid(`Unrecognised cursor "${cursor}".`, 'Cursors are opaque; do not construct them by hand.');
  }
  const offset = Number(cursor.slice(OFFSET_CURSOR.length));
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

/** A REST cursor is a URL plus how far into that URL's page the reader has got. */
function encodeRestCursor(url: string, offset: number): string {
  return `${REST_CURSOR}${String(offset)}:${url}`;
}

function decodeRestCursor(cursor: string | undefined, fallback: string): { url: string; offset: number } {
  if (cursor === undefined) return { url: fallback, offset: 0 };

  if (cursor.startsWith(REST_CURSOR)) {
    const rest = cursor.slice(REST_CURSOR.length);
    const mark = rest.indexOf(':');
    const offset = Number(rest.slice(0, mark));
    const url = rest.slice(mark + 1);
    if (mark > 0 && Number.isInteger(offset) && offset >= 0 && url.length > 0) return { url, offset };
  }

  throw VfsError.invalid(`Unrecognised cursor "${cursor}".`, 'Cursors are opaque; do not construct them by hand.');
}

/**
 * Does this term mean the same thing to GitHub as it does to the local matcher?
 *
 * GitHub's `creator` is whole-login equality. The engine's default is a substring match,
 * and its wildcard and fuzzy forms are looser still, so only a bare `equals` term can be
 * pushed down without changing what the reader is asking for.
 */
function isWholeStringMatch(query: TermQuery): boolean {
  return (
    query.op === 'equals' &&
    query.wildcard !== true &&
    query.fuzzy === undefined &&
    query.slop === undefined
  );
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim().slice(0, 200);
}

/** Created and updated within the same window means it is genuinely new. */
function toChange(node: VNode, createdAt: string, since: string) {
  const isNew = new Date(createdAt).toISOString() > since;
  return {
    type: isNew ? ('created' as const) : ('updated' as const),
    path: node.name,
    node,
    at: node.mtime ?? new Date(),
  };
}

function reviewVerb(state: string): string {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'requested changes';
    case 'DISMISSED':
      return 'left a dismissed review';
    default:
      return 'reviewed';
  }
}

function readableType(typename: string): string {
  switch (typename) {
    case 'DraftIssue':
      return 'draft';
    case 'PullRequest':
      return 'pull request';
    case 'Issue':
      return 'issue';
    default:
      return typename.toLowerCase();
  }
}

export const githubPlugin: ProviderPlugin<GitHubProviderOptions> = {
  type: 'github',
  displayName: 'GitHub issues, pull requests, discussions and projects',
  description: 'Repositories, issues, pull requests, discussions, projects and notifications as directories.',
  validateOptions(raw) {
    const options = (raw ?? {}) as GitHubProviderOptions;
    const hasRepos = options.repos !== undefined && options.repos.length > 0;
    const hasOwners = options.owners !== undefined && options.owners.length > 0;
    if (!hasRepos && !hasOwners && options.includeNotifications !== true) {
      throw VfsError.config(
        'A github mount needs "repos", "owners", or "includeNotifications": true.',
        'Example: { "type": "github", "options": { "repos": ["microsoft/vscode"] } }',
      );
    }
    return options;
  },
  create(options, context) {
    return new GitHubProvider(options, context);
  },
};
