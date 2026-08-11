/**
 * Minimal GitHub REST client.
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
 */

import { VfsError } from '@mscomms/core';

export interface GitHubClientOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
}

export interface GitHubResponse<T> {
  readonly data: T;
  readonly etag?: string;
  readonly pollIntervalSeconds?: number;
  readonly nextPage?: string;
}

export class GitHubClient {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#userAgent = options.userAgent ?? 'mscomms/0.1';
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  get authenticated(): boolean {
    return this.#token !== undefined && this.#token.length > 0;
  }

  async get<T>(
    path: string,
    options: { signal?: AbortSignal; etag?: string; accept?: string } = {},
  ): Promise<GitHubResponse<T>> {
    const url = path.startsWith('http') ? path : `${this.#baseUrl}${path}`;

    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.#userAgent,
    };
    if (this.#token !== undefined && this.#token.length > 0) headers['authorization'] = `Bearer ${this.#token}`;
    if (options.etag !== undefined) headers['if-none-match'] = options.etag;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(url, { headers, signal: controller.signal });

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
