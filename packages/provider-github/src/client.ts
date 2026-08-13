/**
 * Minimal GitHub REST and GraphQL client.
 *
 * Only the handful of endpoints this provider needs, using the built-in `fetch`. The
 * interesting part is not the HTTP; it is the failure handling. GitHub's failure modes are
 * well-documented and each one has a different correct response, so they are distinguished
 * here rather than collapsed into "request failed":
 *
 *   401 — the token is bad or expired. Re-authenticating is the only fix.
 *   403 + rate-limit headers — throttled. Backing off is the fix; retrying now is not.
 *   403 without them — the token lacks a scope, or SSO authorization is missing for an org.
 *   404 on a repo — very often a *private* repo plus a token without `repo` scope, not a
 *        typo. Saying "not found" alone would send the user hunting for the wrong bug.
 *
 * Both transports live here because GitHub genuinely has two APIs and the split is not a
 * matter of taste: issues, pull requests and notifications are REST, while Discussions and
 * Projects v2 were never given REST endpoints at all. A provider covering all four has to
 * speak both, so the token handling, timeout, user agent and error vocabulary are shared
 * rather than duplicated into a second client that would drift.
 */

import { VfsError } from '@mscomms/core';

/** Injected so tests can drive the client without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  /**
   * GraphQL endpoint. Derived from `baseUrl` when omitted, which is what makes GitHub
   * Enterprise Server work: its REST API lives at `https://host/api/v3` but its GraphQL
   * endpoint is `https://host/api/graphql`, so appending `/graphql` to the REST base would
   * produce a URL that does not exist.
   */
  readonly graphqlUrl?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

export interface GitHubResponse<T> {
  readonly data: T;
  readonly etag?: string;
  readonly pollIntervalSeconds?: number;
  readonly nextPage?: string;
}

/** One entry of the `errors` array a GraphQL response may carry alongside `data`. */
interface GraphQLError {
  readonly type?: string;
  readonly message?: string;
}

export class GitHubClient {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #graphqlUrl: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#graphqlUrl = options.graphqlUrl ?? defaultGraphqlUrl(this.#baseUrl);
    this.#userAgent = options.userAgent ?? 'mscomms/0.1';
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  get authenticated(): boolean {
    return this.#token !== undefined && this.#token.length > 0;
  }

  async get<T>(
    path: string,
    options: { signal?: AbortSignal; etag?: string; accept?: string } = {},
  ): Promise<GitHubResponse<T>> {
    const url = this.#resolve(path);

    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.#userAgent,
    };
    if (this.authenticated) headers['authorization'] = this.#bearer();
    if (options.etag !== undefined) headers['if-none-match'] = options.etag;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await this.#fetch(url, { headers, signal: controller.signal });

      if (response.status === 304) {
        return {
          data: [] as unknown as T,
          ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag') as string }),
          ...pollInterval(response),
        };
      }

      if (!response.ok) throw this.#describeFailure(response, url);

      const data = (await response.json()) as T;
      return {
        data,
        ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag') as string }),
        ...pollInterval(response),
        ...(parseNextLink(response.headers.get('link')) === undefined
          ? {}
          : { nextPage: parseNextLink(response.headers.get('link')) as string }),
      };
    } catch (error) {
      if (error instanceof VfsError) throw error;
      if (controller.signal.aborted) {
        throw new VfsError('ETIMEDOUT', 'GitHub did not respond in time.', {
          hint: 'Check connectivity, or raise timeoutMs on the mount.',
        });
      }
      throw new VfsError('ENETWORK', `Could not reach GitHub: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turn a path or absolute URL into the URL to actually request.
   *
   * Absolute URLs arrive from two places: GitHub's own `Link` headers, and paging cursors.
   * Cursors are the interesting one, because the engine persists them and hands them back
   * on a later run, so their content is not necessarily still ours. This method is called
   * immediately before a corporate token is attached to the request, which makes an
   * off-origin URL here a way to post that token to someone else's server. Pinning to the
   * configured host closes that off and costs nothing: GitHub's paging links are always
   * same-origin, so no legitimate caller notices.
   */
  #resolve(path: string): string {
    if (!path.startsWith('http')) return `${this.#baseUrl}${path}`;

    let target: URL;
    try {
      target = new URL(path);
    } catch {
      throw VfsError.invalid(`Not a usable GitHub URL: "${path}".`);
    }

    if (target.origin !== new URL(this.#baseUrl).origin) {
      throw new VfsError('EINVAL', `Refusing to send GitHub credentials to ${target.origin}.`, {
        hint: 'A paging cursor pointed somewhere other than this mount\u2019s GitHub host.',
      });
    }
    return target.toString();
  }

  /**
   * Run one GraphQL query.
   *
   * Discussions and Projects v2 have no REST equivalent, so this is not an optimization —
   * it is the only way to reach them at all.
   *
   * GraphQL's error model is the part worth being careful about. A failed GraphQL request
   * is usually HTTP 200 with an `errors` array beside a partially-populated `data`, so
   * checking `response.ok` alone reports success for a query that returned nothing. Worse,
   * partial success is normal and useful: asking for six projects when the token can see
   * five yields five projects *and* an error. So errors are fatal only when they are all
   * there is; otherwise they are handed to the caller to log and move on.
   */
  async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<{ data: T; errors: readonly GraphQLError[] }> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': this.#userAgent,
    };
    // Unlike REST, the GraphQL API is closed to anonymous callers entirely. Saying so up
    // front is far kinder than letting it come back as a bare 401 from a URL the user
    // never typed.
    if (!this.authenticated) {
      throw new VfsError('EAUTH', 'GitHub GraphQL requires a token.', {
        hint: 'Discussions and projects have no anonymous API. Set GITHUB_TOKEN, or run `gh auth login`.',
      });
    }
    headers['authorization'] = this.#bearer();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await this.#fetch(this.#graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) throw this.#describeFailure(response, this.#graphqlUrl);

      const payload = (await response.json()) as { data?: T; errors?: readonly GraphQLError[] };
      const errors = payload.errors ?? [];

      if (payload.data === undefined || payload.data === null) {
        if (errors.length > 0) throw describeGraphqlErrors(errors);
        // No `data` key at all is a shape GitHub should never produce, and reporting it as
        // an empty result would show an empty folder for a repository that does have
        // discussions — worse than saying something went wrong.
        throw new VfsError('ENETWORK', 'GitHub returned an empty GraphQL response.');
      }

      // All-null `data` beside errors means the errors explain the whole failure, so they
      // are fatal rather than partial. Without errors it is a real answer: `node(id:)`
      // resolves to null for an object that has been deleted or is no longer visible, and
      // GitHub attaches no error to that. Turning "gone" into a connectivity failure would
      // send the reader to check their network over a card someone archived.
      if (errors.length > 0 && isEmpty(payload.data)) throw describeGraphqlErrors(errors);

      return { data: payload.data, errors };
    } catch (error) {
      if (error instanceof VfsError) throw error;
      if (controller.signal.aborted) {
        throw new VfsError('ETIMEDOUT', 'GitHub did not respond in time.', {
          hint: 'Check connectivity, or raise timeoutMs on the mount.',
        });
      }
      throw new VfsError('ENETWORK', `Could not reach GitHub: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One definition of the credential header, shared by both transports. */
  #bearer(): string {
    return `Bearer ${this.#token ?? ''}`;
  }

  #describeFailure(response: Response, url: string): VfsError {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');

    if (response.status === 401) {
      return new VfsError('EAUTH', 'GitHub rejected the token.', {
        hint: 'The token is missing, expired or revoked. Set GITHUB_TOKEN, or run `gh auth token` and point the mount at it.',
      });
    }

    if (response.status === 403 && remaining === '0') {
      const resetAt = reset === null ? undefined : new Date(Number(reset) * 1000);
      return new VfsError('ERATELIMIT', 'GitHub rate limit exhausted.', {
        hint: this.authenticated
          ? `Authenticated limit reached${resetAt === undefined ? '' : `; it resets at ${resetAt.toLocaleTimeString()}`}.`
          : 'Unauthenticated requests are limited to 60 per hour. Setting GITHUB_TOKEN raises that to 5000.',
        ...(resetAt === undefined ? {} : { retryAfter: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) }),
      });
    }

    if (response.status === 403) {
      return new VfsError('EACCES', 'GitHub refused the request.', {
        hint: 'Usually a missing scope, or an organization that requires the token to be SSO-authorized.',
      });
    }

    if (response.status === 404) {
      return new VfsError('ENOENT', `GitHub has no ${url.replace(this.#baseUrl, '')}.`, {
        hint: this.authenticated
          ? 'Check the spelling. If the repository is private, the token also needs repo access.'
          : 'If the repository is private, set GITHUB_TOKEN — an unauthenticated request cannot see it, and GitHub reports that as 404 rather than 403.',
      });
    }

    if (response.status >= 500) {
      return new VfsError('ENETWORK', `GitHub returned HTTP ${String(response.status)}.`, {
        hint: 'A server-side problem. Retrying later usually works.',
      });
    }

    return new VfsError('ENETWORK', `GitHub returned HTTP ${String(response.status)}.`);
  }
}

function pollInterval(response: Response): { pollIntervalSeconds?: number } {
  const value = response.headers.get('x-poll-interval');
  if (value === null) return {};
  const seconds = Number(value);
  return Number.isFinite(seconds) ? { pollIntervalSeconds: seconds } : {};
}

/** GitHub paginates with RFC 5988 Link headers, which double as an opaque cursor. */
function parseNextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match !== null) return match[1];
  }
  return undefined;
}

/**
 * Where GraphQL lives, given where REST lives.
 *
 * On github.com the two are separate hosts (`api.github.com` and `api.github.com/graphql`),
 * but on Enterprise Server REST is `https://host/api/v3` and GraphQL is `https://host/api/
 * graphql` — a sibling, not a child. Getting this wrong is a 404 on every discussion and
 * project in an Enterprise install, which is exactly the deployment least able to debug it.
 */
function defaultGraphqlUrl(baseUrl: string): string {
  return baseUrl.endsWith('/api/v3') ? `${baseUrl.slice(0, -'/v3'.length)}/graphql` : `${baseUrl}/graphql`;
}

/** True when a GraphQL `data` object came back with every requested root field null. */
function isEmpty(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return true;
  return Object.values(data).every((value) => value === null || value === undefined);
}

/**
 * Turn a GraphQL `errors` array into the same vocabulary the REST paths use.
 *
 * The types are worth distinguishing because the fixes are unrelated. `NOT_FOUND` on a
 * discussions query usually means the feature is switched off for that repository rather
 * than that the repository is missing, and `INSUFFICIENT_SCOPES` on projects almost always
 * means a token without `read:project` — a scope people rarely add, because nothing else
 * needs it. Reporting either as a generic failure sends the user to the wrong place.
 */
function describeGraphqlErrors(errors: readonly GraphQLError[]): VfsError {
  const first = errors[0];
  const message = (first?.message ?? 'GitHub rejected the GraphQL query.').trim();
  const type = first?.type ?? '';

  if (type === 'INSUFFICIENT_SCOPES' || /read:project|scope/i.test(message)) {
    return new VfsError('EACCES', message, {
      hint: 'Projects need the `read:project` scope and discussions need `repo` (or `public_repo`). Run `gh auth refresh -s read:project`, or reissue the PAT with those scopes.',
    });
  }
  if (type === 'FORBIDDEN') {
    return new VfsError('EACCES', message, {
      hint: 'Usually an organization that requires the token to be SSO-authorized.',
    });
  }
  if (type === 'NOT_FOUND') {
    return new VfsError('ENOENT', message, {
      hint: 'Check the spelling. Discussions and projects are also features a repository can have switched off, which reports the same way.',
    });
  }
  if (type === 'RATE_LIMITED') {
    return new VfsError('ERATELIMIT', message, {
      hint: 'The GraphQL API has its own point-based budget, separate from the REST rate limit.',
    });
  }
  return new VfsError('ENETWORK', message);
}
