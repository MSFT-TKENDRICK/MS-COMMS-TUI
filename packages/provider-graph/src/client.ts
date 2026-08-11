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

export class GraphClient {
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

  async get<T>(path: string, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
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

  async getPage<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<GraphPage<T>> {
    const raw = await this.get<Record<string, unknown>>(path, options);
    return {
      value: (raw['value'] as T[] | undefined) ?? [],
      ...(typeof raw['@odata.nextLink'] === 'string' ? { nextLink: raw['@odata.nextLink'] } : {}),
      ...(typeof raw['@odata.deltaLink'] === 'string' ? { deltaLink: raw['@odata.deltaLink'] } : {}),
    };
  }

  async getBytes(path: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
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

  const endpoint = url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '');

  if (response.status === 401) {
    return new VfsError('EAUTH', 'Microsoft Graph rejected the credentials.', {
      hint: 'The sign-in has expired. Run `mscomms auth --reset` and sign in again.',
    });
  }

  if (response.status === 403) {
    const teams = endpoint.includes('/teams') || endpoint.includes('/chats');
    return new VfsError('EACCES', `Access denied${detail === '' ? '' : `: ${detail}`}`, {
      hint: teams
        ? 'Teams scopes such as ChannelMessage.Read.All usually require tenant administrator consent. Mail will keep working without them.'
        : 'The signed-in account is missing a permission for this operation.',
    });
  }

  if (response.status === 404) {
    return new VfsError('ENOENT', `Microsoft Graph has no ${endpoint}.`, {
      hint: 'The item may have been moved or deleted. Try refreshing the listing.',
    });
  }

  if (code === 'ErrorItemNotFound') {
    return new VfsError('ENOENT', 'That item no longer exists.');
  }

  return new VfsError('ENETWORK', `Microsoft Graph returned HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail}`}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
