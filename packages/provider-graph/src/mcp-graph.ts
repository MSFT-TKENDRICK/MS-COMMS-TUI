/**
 * A `GraphApi` that asks an MCP server instead of calling Graph directly.
 *
 * The point is authentication, not transport. `GraphClient` needs a bearer token, and the
 * only way this package knows to get one is the device-code flow — which a managed tenant
 * frequently forbids. Meanwhile the same machine often already has a signed-in MCP server
 * that will happily answer Graph questions. Routing through it means the providers work
 * with no prompt, no token in a config file and no new credential to manage.
 *
 * It implements `GraphApi` rather than replacing the providers because the interesting code
 * in mail, chat and people is the tree shape and the ordering, none of which cares how the
 * JSON arrived. The mapping is possible at all because the tools used here are a thin
 * passthrough: they take a Graph relative URL and hand back the verbatim Graph response, so
 * `$select`, `$filter` and `@odata.nextLink` all keep working untouched.
 *
 * The default tool names match Microsoft's WorkIQ server, which covers the whole surface
 * these providers need (read, blob download, actions, property updates). They are options
 * so another server with the same shape can be used without code changes.
 */

import { VfsError } from '@mscomms/core';
import { graphFailure, type GraphApi, type GraphPage, type GraphRequestOptions } from './client.js';
import type { McpTransport } from './mcp-client.js';

export interface McpToolNames {
  /** GET. Takes a list of relative URLs, answers one result per URL. */
  readonly fetch: string;
  /** GET returning bytes rather than JSON. */
  readonly fetchBlob: string;
  /** POST to an action endpoint such as `/me/sendMail`. */
  readonly action: string;
  /** POST that creates a member of a collection, such as a chat message. */
  readonly create: string;
  /** PATCH. */
  readonly update: string;
}

export const DEFAULT_TOOL_NAMES: McpToolNames = {
  fetch: 'fetch',
  fetchBlob: 'fetch_blob',
  action: 'do_action',
  create: 'create_entity',
  update: 'update_entity',
};

/**
 * Graph POSTs come in two flavours and the servers model them as different tools.
 *
 * `/chats/{id}/messages` adds a member to a collection; `/me/sendMail` invokes a function
 * that returns nothing. Guessing from the shape of the URL is unreliable — both are a POST
 * to a path with a trailing segment — so the actions are named. Anything unrecognised is
 * treated as a create, which is the more common case in this codebase.
 */
const ACTION_SEGMENTS = new Set([
  'sendMail',
  'reply',
  'replyAll',
  'forward',
  'createReply',
  'createReplyAll',
  'createForward',
  'move',
  'copy',
  'send',
  'markRead',
  'setReaction',
  'unsetReaction',
]);

export interface McpGraphClientOptions {
  readonly transport: McpTransport;
  readonly tools?: Partial<McpToolNames>;
}

interface FetchResult {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly statusCode?: number;
}

export class McpGraphClient implements GraphApi {
  readonly #transport: McpTransport;
  readonly #tools: McpToolNames;

  constructor(options: McpGraphClientOptions) {
    this.#transport = options.transport;
    this.#tools = { ...DEFAULT_TOOL_NAMES, ...options.tools };
  }

  async get<T>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    const url = flattenExpand(relativeUrl(path));
    const result = await this.#call(this.#tools.fetch, { entityUrls: [url] }, options);
    return this.#unwrapFetch<T>(result, url);
  }

  async getPage<T>(path: string, options: GraphRequestOptions = {}): Promise<GraphPage<T>> {
    const raw = await this.get<Record<string, unknown>>(path, options);
    return {
      value: (raw['value'] as T[] | undefined) ?? [],
      ...(typeof raw['@odata.nextLink'] === 'string' ? { nextLink: raw['@odata.nextLink'] } : {}),
      ...(typeof raw['@odata.deltaLink'] === 'string' ? { deltaLink: raw['@odata.deltaLink'] } : {}),
    };
  }

  async getBytes(path: string, options: GraphRequestOptions = {}): Promise<Uint8Array> {
    const url = relativeUrl(path);
    const result = await this.#call(this.#tools.fetchBlob, { path: url }, options);
    const encoded = findBase64(result.structuredContent) ?? findBase64(result.content);
    if (encoded === undefined) {
      // A refused download reports an empty string and an explanation rather than omitting
      // the field, so prefer the server's own account of what went wrong.
      const status = (result.structuredContent as { statusCode?: number } | undefined)?.statusCode;
      const failure = describeError((result.structuredContent as { error?: unknown } | undefined)?.error);
      if (failure.message !== undefined || (status !== undefined && status >= 400)) {
        throw graphFailure(status ?? 500, url, failure);
      }
      throw new VfsError('ENETWORK', 'The MCP server did not return any content for that attachment.');
    }
    return Uint8Array.from(Buffer.from(encoded, 'base64'));
  }

  async post<T>(path: string, body: unknown, options: GraphRequestOptions = {}): Promise<T> {
    const url = relativeUrl(path);
    const segment = url.split('?')[0]?.split('/').pop() ?? '';
    const result = ACTION_SEGMENTS.has(segment)
      ? await this.#call(this.#tools.action, { actionUrl: url, jsonBody: body ?? {} }, options)
      : await this.#call(this.#tools.create, { parentUrl: url, jsonBody: body ?? {} }, options);
    return this.#unwrapWrite<T>(result, url);
  }

  async patch<T>(path: string, body: unknown, options: GraphRequestOptions = {}): Promise<T> {
    const url = relativeUrl(path);
    const result = await this.#call(this.#tools.update, { entityUrl: url, jsonBody: body ?? {} }, options);
    return this.#unwrapWrite<T>(result, url);
  }

  async #call(
    tool: string,
    args: Record<string, unknown>,
    options: GraphRequestOptions,
  ): Promise<{ structuredContent?: unknown; content?: unknown; isError?: boolean }> {
    try {
      return await this.#transport.callTool(tool, args, options.signal);
    } catch (error) {
      if (error instanceof VfsError) throw error;
      throw new VfsError('ENETWORK', `Could not reach Microsoft Graph through the MCP server: ${String(error)}`, {
        hint: 'Check that the MCP server command is installed and that you are signed in to it.',
      });
    }
  }

  /**
   * The fetch tool answers a list, one entry per requested URL, each carrying its own
   * status. A failure is therefore reported inside a successful tool call, which is why
   * this cannot lean on `isError` alone.
   */
  #unwrapFetch<T>(
    result: { structuredContent?: unknown; content?: unknown; isError?: boolean },
    url: string,
  ): T {
    const structured = result.structuredContent as { results?: readonly FetchResult[] } | undefined;
    const first = structured?.results?.[0];

    if (first === undefined) {
      const text = firstText(result.content);
      if (text !== undefined) {
        const parsed = tryParse(text);
        if (parsed !== undefined) return parsed as T;
        throw new VfsError('ENETWORK', `The MCP server answered with an unexpected result: ${text.slice(0, 200)}`);
      }
      throw new VfsError('ENETWORK', 'The MCP server returned an empty result.');
    }

    const status = first.statusCode ?? 200;
    if (status >= 400 || first.data === null || first.data === undefined) {
      throw graphFailure(status, url, describeError(first.error));
    }
    return first.data as T;
  }

  #unwrapWrite<T>(
    result: { structuredContent?: unknown; content?: unknown; isError?: boolean },
    url: string,
  ): T {
    const structured = result.structuredContent as
      | { results?: readonly FetchResult[]; statusCode?: number; error?: unknown; data?: unknown }
      | undefined;
    const entry = structured?.results?.[0] ?? structured;

    if (entry !== undefined) {
      const status = entry.statusCode ?? (result.isError === true ? 500 : 200);
      if (status >= 400) throw graphFailure(status, url, describeError(entry.error));
      // Writes routinely answer 202 with no body; an empty object is the documented result.
      return ((entry.data ?? {}) as T) ?? ({} as T);
    }

    if (result.isError === true) {
      const text = firstText(result.content) ?? 'The MCP server rejected the request.';
      throw graphFailure(500, url, { message: text });
    }
    return {} as T;
  }
}

/**
 * These tools take a path relative to the Graph root, but `@odata.nextLink` — which the
 * providers hand straight back as a cursor — is absolute. Passing one through unchanged
 * silently breaks paging on the second page of every listing.
 */
export function relativeUrl(path: string): string {
  const trimmed = path.trim();
  const withoutHost = trimmed.replace(/^https:\/\/graph\.microsoft\.com\/(v1\.0|beta)/i, '');
  return withoutHost.startsWith('/') ? withoutHost : `/${withoutHost}`;
}

/**
 * Drop the nested options from `$expand`, which these proxies reject.
 *
 * Graph itself accepts `$expand=members($select=displayName)`, and the Teams provider asks
 * for exactly that; the proxy answers `400 Unsupported query parameters` and the chat list
 * fails outright. Widening the request to `$expand=members` returns a superset of what was
 * asked for, which every caller here tolerates — they read named fields off the result and
 * ignore the rest — so a slightly larger response is much the better trade against a
 * listing that does not work at all.
 */
export function flattenExpand(url: string): string {
  return url.replace(/(\$expand=)([^&]*)/gi, (_match, prefix: string, value: string) => {
    let depth = 0;
    let flattened = '';
    for (const character of value) {
      if (character === '(') depth += 1;
      else if (character === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) flattened += character;
    }
    return `${prefix}${flattened}`;
  });
}

function describeError(error: unknown): { code?: string; message?: string } {
  if (typeof error === 'string') return { message: error };
  if (error !== null && typeof error === 'object') {
    // Graph nests the useful part one level down: `{ error: { code, message } }`.
    const inner = (error as { error?: unknown }).error;
    if (inner !== undefined) return describeError(inner);
    const record = error as { code?: unknown; message?: unknown };
    return {
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
    };
  }
  return {};
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const entry of content as readonly { text?: unknown }[]) {
    if (typeof entry.text === 'string' && entry.text !== '') return entry.text;
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Servers disagree about where the base64 goes, so look in the documented places.
 *
 * `base64Content` is first because that is what the reference server actually uses; the
 * rest are the other spellings seen in this family of tools. An empty string counts as
 * absent — a failed download reports one alongside its error rather than omitting it.
 */
function findBase64(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findBase64(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['base64Content', 'contentBase64', 'base64', 'contentBytes', 'blob', 'data', 'content']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  for (const key of ['result', 'results', 'value', 'data', 'content']) {
    const found = findBase64(record[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
