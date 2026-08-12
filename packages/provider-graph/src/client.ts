/**
 * Microsoft Graph HTTP client.
 *
 * Three behaviours here are not optional against Graph and are the difference between a
 * tool that works and one that gets throttled into uselessness:
 *
 *   1. `Retry-After` is obeyed. Graph returns 429 and 503 with an explicit backoff, and
 *      ignoring it is how a client gets its whole app id throttled at the tenant level.
 *   2. `$select` is always narrow. Graph returns very large objects by default; fetching
 *      full message bodies to render a listing would be an order of magnitude more data.
 *   3. Permission failures are distinguished from missing data. A 403 on a Teams endpoint
 *      almost always means the tenant requires admin consent for that scope, which is a
 *      completely different problem from a wrong id, and the user needs to be told which.
 */

import { VfsError } from '@mscomms/core';

export interface GraphClientOptions {
  readonly getToken: () => Promise<string>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface GraphPage<T> {
  readonly value: T[];
  readonly nextLink?: string;
  readonly deltaLink?: string;
}

export interface GraphRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

/**
 * The subset of the client the providers actually use.
 *
 * It exists so a provider can be exercised without a tenant, a token or a network. The
 * class below uses `#private` fields, which makes it *nominally* typed — a hand-written
 * stub object is not assignable to `GraphClient` no matter how faithfully it matches.
 * Depending on this interface instead is what makes the people provider's tree shape,
 * priority ordering and reply detection testable at all.
 */
export interface GraphApi {
  get<T>(path: string, options?: GraphRequestOptions): Promise<T>;
  getPage<T>(path: string, options?: GraphRequestOptions): Promise<GraphPage<T>>;
  getBytes(path: string, options?: GraphRequestOptions): Promise<Uint8Array>;
  post<T>(path: string, body: unknown, options?: GraphRequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: GraphRequestOptions): Promise<T>;
}

/**
 * Turn a raw Graph collection response into a `GraphPage`.
 *
 * Shared with the MCP transport rather than reimplemented there. Paging is the one place
 * where a subtle difference between two transports would show up as "the listing stops
 * after 50 items" long after the code was written, so both read the envelope the same way.
 */
export function toGraphPage<T>(raw: Record<string, unknown>): GraphPage<T> {
  return {
    value: (raw['value'] as T[] | undefined) ?? [],
    ...(typeof raw['@odata.nextLink'] === 'string' ? { nextLink: raw['@odata.nextLink'] } : {}),
    ...(typeof raw['@odata.deltaLink'] === 'string' ? { deltaLink: raw['@odata.deltaLink'] } : {}),
  };
}

const GRAPH_ORIGIN = /^https:\/\/graph\.microsoft\.com(\/(v1\.0|beta))?/i;

/**
 * Reduce a Graph URL to the tenant-relative path.
 *
 * `@odata.nextLink` always comes back absolute, so any transport that addresses Graph by
 * path — as the MCP one does — has to strip the origin or paging breaks on the second page.
 */
export function toRelativeGraphPath(path: string): string {
  const relative = path.replace(GRAPH_ORIGIN, '');
  if (/^https?:\/\//i.test(relative)) {
    throw new VfsError('ENETWORK', `Not a Microsoft Graph URL: ${path}`, {
      hint: 'This transport can only address Microsoft Graph itself.',
    });
  }
  return relative.startsWith('/') ? relative : `/${relative}`;
}

export class GraphClient implements GraphApi {
  readonly #getToken: () => Promise<string>;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: GraphClientOptions) {
    this.#getToken = options.getToken;
    this.#baseUrl = (options.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  async get<T>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.#baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      try {
        const token = await this.#getToken();
        const response = await fetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            // Graph refuses to return non-ASCII header values (subjects, display names)
            // unless this is set, and silently mangles them otherwise.
            'prefer': 'outlook.body-content-type="text"',
            ...options.headers,
          },
          signal: controller.signal,
        });

        if (response.status === 429 || response.status === 503 || response.status === 504) {
          const retryAfter = Number(response.headers.get('retry-after') ?? '5');
          if (attempt >= this.#maxRetries) {
            throw new VfsError('ERATELIMIT', 'Microsoft Graph is throttling requests.', {
              hint: `Try again in about ${String(retryAfter)} seconds. Increasing the mount's ttlMs reduces how often this happens.`,
              retryAfter,
            });
          }
          attempt += 1;
          await sleep(Math.max(1, retryAfter) * 1000);
          continue;
        }

        if (!response.ok) throw await describeFailure(response, url);
        if (response.status === 204) return { value: [] } as unknown as T;
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof VfsError) throw error;
        if (controller.signal.aborted) {
          throw new VfsError('ETIMEDOUT', 'Microsoft Graph did not respond in time.');
        }
        if (attempt < this.#maxRetries) {
          attempt += 1;
          await sleep(500 * attempt);
          continue;
        }
        throw new VfsError('ENETWORK', `Could not reach Microsoft Graph: ${String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async getPage<T>(path: string, options: GraphRequestOptions = {}): Promise<GraphPage<T>> {
    return toGraphPage<T>(await this.get<Record<string, unknown>>(path, options));
  }

  /**
   * Sending mail, starting a chat, posting a message.
   *
   * Deliberately not retried on anything other than throttling: `get` can be replayed
   * safely, but replaying a POST is how a user ends up sending the same mail twice. A 429
   * is the exception, because Graph rejected the request outright rather than performing
   * it, and it tells us exactly how long to wait.
   */
  async post<T>(path: string, body: unknown, options: GraphRequestOptions = {}): Promise<T> {
    return this.#write<T>('POST', path, body, options);
  }

  /** Property updates: marking a message read, flagging it. Same non-retry reasoning. */
  async patch<T>(path: string, body: unknown, options: GraphRequestOptions = {}): Promise<T> {
    return this.#write<T>('PATCH', path, body, options);
  }

  async #write<T>(
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
    options: GraphRequestOptions,
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.#baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      try {
        const token = await this.#getToken();
        const response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'content-type': 'application/json',
            ...options.headers,
          },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });

        if (response.status === 429 && attempt < this.#maxRetries) {
          attempt += 1;
          await sleep(Math.max(1, Number(response.headers.get('retry-after') ?? '5')) * 1000);
          continue;
        }

        if (!response.ok) throw await describeFailure(response, url);
        // sendMail and several other actions answer 202 Accepted with no body.
        if (response.status === 202 || response.status === 204) return {} as T;
        const text = await response.text();
        return (text === '' ? {} : JSON.parse(text)) as T;
      } catch (error) {
        if (error instanceof VfsError) throw error;
        if (controller.signal.aborted) {
          throw new VfsError('ETIMEDOUT', 'Microsoft Graph did not respond in time.');
        }
        throw new VfsError('ENETWORK', `Could not reach Microsoft Graph: ${String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async getBytes(path: string, options: GraphRequestOptions = {}): Promise<Uint8Array> {
    const url = path.startsWith('http') ? path : `${this.#baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const token = await this.#getToken();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw await describeFailure(response, url);
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function describeFailure(response: Response, url: string): Promise<VfsError> {
  let detail = '';
  let code = '';
  try {
    const payload = (await response.json()) as { error?: { message?: string; code?: string } };
    detail = payload.error?.message ?? '';
    code = payload.error?.code ?? '';
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }

  return graphFailure(response.status, url, detail, code);
}

/**
 * Map a Graph status code onto the error the UI knows how to explain.
 *
 * Split out from the HTTP path so every transport reports the same thing: a 403 on a Teams
 * endpoint means "ask your tenant admin" no matter which pipe the 403 arrived through, and
 * a user should never have to learn two vocabularies for the same failure.
 */
export function graphFailure(status: number, url: string, detail = '', code = ''): VfsError {
  const endpoint = url.replace(GRAPH_ORIGIN, '');

  if (status === 401) {
    return new VfsError('EAUTH', 'Microsoft Graph rejected the credentials.', {
      hint: 'The sign-in has expired. Run `mscomms auth --reset` and sign in again.',
    });
  }

  if (status === 403) {
    const teams = endpoint.includes('/teams') || endpoint.includes('/chats');
    return new VfsError('EACCES', `Access denied${detail === '' ? '' : `: ${detail}`}`, {
      hint: teams
        ? 'Teams scopes such as ChannelMessage.Read.All usually require tenant administrator consent. Mail will keep working without them.'
        : 'The signed-in account is missing a permission for this operation.',
    });
  }

  if (status === 404) {
    return new VfsError('ENOENT', `Microsoft Graph has no ${endpoint}.`, {
      hint: 'The item may have been moved or deleted. Try refreshing the listing.',
    });
  }

  if (status === 429 || status === 503 || status === 504) {
    return new VfsError('ERATELIMIT', 'Microsoft Graph is throttling requests.', {
      hint: "Try again shortly. Increasing the mount's ttlMs reduces how often this happens.",
    });
  }

  if (code === 'ErrorItemNotFound' || code === 'ErrorInvalidIdMalformed') {
    return new VfsError('ENOENT', 'That item no longer exists.', {
      hint: 'The id may be stale. Try refreshing the listing.',
    });
  }

  return new VfsError('ENETWORK', `Microsoft Graph returned HTTP ${String(status)}${detail === '' ? '' : `: ${detail}`}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
