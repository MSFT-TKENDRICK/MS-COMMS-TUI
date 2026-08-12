/**
 * Minimal Azure DevOps REST client.
 *
 * Azure DevOps is not Microsoft Graph and gets its own client rather than a `baseUrl`
 * option on the Graph one. The URL shape, the pagination model and — mostly — the failure
 * modes all differ, and a client whose throttling error says "Microsoft Graph is throttling
 * requests" while talking to dev.azure.com sends the reader to the wrong dashboard.
 *
 * Three Azure DevOps specifics are handled here because each one is otherwise a long
 * afternoon:
 *
 *   1. A BAD CREDENTIAL DOES NOT ALWAYS PRODUCE A 401. Given an expired or malformed PAT,
 *      Azure DevOps frequently answers 203 (or even 200) with an HTML sign-in page. Parsed
 *      as JSON that is a syntax error somewhere far from the cause, and the user goes
 *      hunting for a bug in the provider. Any HTML body is treated as "not signed in".
 *   2. `api-version` IS MANDATORY. Omit it and the service answers with a version-negotiation
 *      error rather than data, so it is appended centrally instead of at every call site.
 *   3. CONTINUATION IS A HEADER, NOT A LINK. Listing endpoints return
 *      `x-ms-continuationtoken`, which doubles as the opaque cursor the engine wants.
 */

import { VfsError } from '@mscomms/core';

/** Injected so tests can drive the provider without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AdoClientOptions {
  /** Collection URL, e.g. `https://dev.azure.com/contoso`. No trailing slash required. */
  readonly orgUrl: string;
  /** Produces the full `Authorization` header value; re-invoked per request so tokens refresh. */
  readonly authorization: () => Promise<string>;
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: FetchLike;
}

export interface AdoResponse<T> {
  readonly data: T;
  /** `x-ms-continuationtoken`, when the endpoint paged. */
  readonly continuationToken?: string;
}

export const DEFAULT_API_VERSION = '7.1';

export class AdoClient {
  readonly #orgUrl: string;
  readonly #authorization: () => Promise<string>;
  readonly #apiVersion: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: FetchLike;

  constructor(options: AdoClientOptions) {
    this.#orgUrl = options.orgUrl.replace(/\/+$/, '');
    this.#authorization = options.authorization;
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  get orgUrl(): string {
    return this.#orgUrl;
  }

  async get<T>(
    path: string,
    options: { signal?: AbortSignal; apiVersion?: string } = {},
  ): Promise<AdoResponse<T>> {
    return this.#request<T>('GET', path, undefined, options);
  }

  async post<T>(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; apiVersion?: string } = {},
  ): Promise<AdoResponse<T>> {
    return this.#request<T>('POST', path, body, options);
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; apiVersion?: string },
  ): Promise<AdoResponse<T>> {
    const url = this.#url(path, options.apiVersion ?? this.#apiVersion);
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      try {
        const headers: Record<string, string> = {
          authorization: await this.#authorization(),
          accept: 'application/json',
        };
        if (body !== undefined) headers['content-type'] = 'application/json';

        const response = await this.#fetch(url, {
          method,
          headers,
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        if (response.status === 429 || response.status === 503 || response.status === 504) {
          const retryAfter = Number(response.headers.get('retry-after') ?? '5');
          if (attempt >= this.#maxRetries) {
            throw new VfsError('ERATELIMIT', 'Azure DevOps is throttling requests.', {
              hint: `Try again in about ${String(retryAfter)} seconds. Raising the mount's ttlMs reduces how often this happens.`,
              retryAfter,
            });
          }
          attempt += 1;
          await sleep(Math.max(1, retryAfter) * 1000);
          continue;
        }

        if (!response.ok) throw await describeFailure(response, url);

        // The sign-in page masquerading as success. See the header comment.
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/html')) {
          throw new VfsError('EAUTH', 'Azure DevOps returned a sign-in page instead of data.', {
            hint: 'The personal access token is expired, revoked, or was issued for a different organization. Create a new one with the "Work items (read)" scope.',
          });
        }

        if (response.status === 204) return { data: { value: [] } as unknown as T };

        const token = response.headers.get('x-ms-continuationtoken');
        return {
          data: (await response.json()) as T,
          ...(token === null || token === '' ? {} : { continuationToken: token }),
        };
      } catch (error) {
        if (error instanceof VfsError) throw error;
        if (controller.signal.aborted) {
          throw new VfsError('ETIMEDOUT', 'Azure DevOps did not respond in time.', {
            hint: 'Check connectivity, or raise timeoutMs on the mount.',
          });
        }
        if (attempt < this.#maxRetries) {
          attempt += 1;
          await sleep(500 * attempt);
          continue;
        }
        throw new VfsError('ENETWORK', `Could not reach Azure DevOps: ${String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  #url(path: string, apiVersion: string): string {
    const absolute = path.startsWith('http')
      ? path
      : `${this.#orgUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (absolute.includes('api-version=')) return absolute;
    return `${absolute}${absolute.includes('?') ? '&' : '?'}api-version=${apiVersion}`;
  }
}

/** Path segments carry project and team names, which routinely contain spaces. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

async function describeFailure(response: Response, url: string): Promise<VfsError> {
  let detail = '';
  let typeKey = '';
  try {
    const payload = (await response.json()) as { message?: string; typeKey?: string };
    detail = payload.message ?? '';
    typeKey = payload.typeKey ?? '';
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }

  const suffix = detail === '' ? '' : `: ${detail}`;

  // 203 is Azure DevOps saying "here is a login page" without admitting it is an error.
  if (response.status === 401 || response.status === 203) {
    return new VfsError('EAUTH', `Azure DevOps rejected the credentials${suffix}`, {
      hint: 'Set a personal access token with the "Work items (read)" scope in AZURE_DEVOPS_EXT_PAT, or set "auth": "aad" on the mount to sign in interactively.',
    });
  }

  if (response.status === 403) {
    return new VfsError('EACCES', `Access denied${suffix}`, {
      hint: 'The signed-in identity can reach the organization but not this project or board. A personal access token also needs the "Work items (read)" scope — an all-scopes token from a different organization will fail here.',
    });
  }

  if (response.status === 404) {
    return new VfsError('ENOENT', `Azure DevOps has no ${url.replace(/\?.*$/, '')}.`, {
      hint: 'Check the organization, project and team names. A project the account cannot see is reported as missing rather than forbidden.',
    });
  }

  // A malformed WIQL statement is a bug in this provider or an unsupported field in a
  // custom process, not a transport problem. Saying "network error" would be a lie.
  if (typeKey.startsWith('WorkItemTracking') || response.status === 400) {
    return new VfsError('EINVAL', `Azure DevOps rejected the work item query${suffix}`, {
      hint: 'Boards using a customized process can rename or remove fields this query relies on.',
    });
  }

  if (response.status >= 500) {
    return new VfsError('ENETWORK', `Azure DevOps returned HTTP ${String(response.status)}.`, {
      hint: 'A server-side problem. Retrying later usually works.',
    });
  }

  return new VfsError('ENETWORK', `Azure DevOps returned HTTP ${String(response.status)}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
