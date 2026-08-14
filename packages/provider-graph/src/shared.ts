/**
 * Shared plumbing for the Graph-backed providers.
 *
 * Both the mail provider and the Teams provider need the same access. Creating one per
 * mount would mean two sign-in prompts on first run, which is exactly the kind of small
 * papercut that makes people stop using a tool. Whatever the transport, it is therefore
 * cached and shared across mounts for the lifetime of the process.
 *
 * There are two ways in:
 *
 *   - An **MCP server** that already holds the user's M365 access. Preferred when one is
 *     present, because a machine that is already signed in should never be asked again.
 *   - The **device-code flow**, for machines with no such server.
 *
 * The Azure DevOps provider reuses `getAuthenticator` too. It is not a Graph client — the
 * API, the base URL and the error semantics are all different — but the sign-in *is* the
 * same Microsoft identity device-code flow, and reimplementing it there would mean two
 * copies of the trickiest code in the repo.
 */

import type { Logger, StateStore } from '@mscomms/core';
import { VfsError } from '@mscomms/core';
import { DeviceCodeAuthenticator, DEFAULT_CLIENT_ID, DEFAULT_SCOPES } from './auth.js';
import { GraphClient, type GraphApi } from './client.js';
import {
  closeAllMcpClients,
  getMcpClient,
  hasDiscoverableMcpServer,
  McpGraphApi,
  type McpTransportOptions,
} from './mcp.js';

/**
 * How a mount reaches Microsoft 365.
 *
 * `auto` prefers an already-authenticated MCP server and falls back to signing in, so the
 * common case — a provisioned work machine — needs no configuration and raises no prompt.
 */
export type GraphTransport = 'auto' | 'mcp' | 'device-code';

export interface GraphSharedOptions {
  readonly clientId?: string;
  readonly tenantId?: string;
  readonly authority?: string;
  readonly baseUrl?: string;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly transport?: GraphTransport;
  readonly mcp?: McpTransportOptions;
}

const authenticators = new Map<string, DeviceCodeAuthenticator>();

/**
 * The shared option names, listed once so each plugin can declare what it actually reads.
 *
 * Kept beside the interface rather than derived from it because TypeScript interfaces do not
 * survive to runtime, and a list that drifts from the type is worse than no list — it would
 * warn about options that work.
 */
export const GRAPH_SHARED_OPTION_KEYS = [
  'clientId',
  'tenantId',
  'authority',
  'baseUrl',
  'scopes',
  'timeoutMs',
  'transport',
  'mcp',
] as const;

/**
 * Identity of a non-Graph resource reusing this sign-in flow.
 *
 * Kept out of `GraphSharedOptions` on purpose: these are properties of the *resource*, not
 * of a user's mount, and nobody should be able to redirect a mail mount at another
 * audience's token by editing a config file.
 */
export interface AuthenticatorIdentity {
  readonly tokenEnvVar?: string;
  readonly stateKey?: string;
}

export function getAuthenticator(
  options: GraphSharedOptions,
  state: StateStore,
  logger: Logger,
  identity: AuthenticatorIdentity = {},
): DeviceCodeAuthenticator {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const tenantId = options.tenantId ?? 'organizations';
  const authority = options.authority ?? 'https://login.microsoftonline.com';
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  // The identity is part of the key, not just decoration: two resources can legitimately
  // want the same client and tenant while needing separate token caches.
  const key = [
    authority,
    tenantId,
    clientId,
    [...scopes].sort().join(','),
    identity.tokenEnvVar ?? '',
    identity.stateKey ?? '',
  ].join('|');

  let authenticator = authenticators.get(key);
  if (authenticator === undefined) {
    authenticator = new DeviceCodeAuthenticator({
      clientId,
      tenantId,
      authority,
      scopes,
      state,
      logger,
      ...(identity.tokenEnvVar === undefined ? {} : { tokenEnvVar: identity.tokenEnvVar }),
      ...(identity.stateKey === undefined ? {} : { stateKey: identity.stateKey }),
    });
    authenticators.set(key, authenticator);
  }
  return authenticator;
}

/**
 * Decide how a mount will reach Microsoft 365.
 *
 * An explicit `transport` is always honoured, including `device-code` on a machine that
 * has an MCP server: someone who asks to sign in should be allowed to.
 */
export function resolveTransport(options: GraphSharedOptions): Exclude<GraphTransport, 'auto'> {
  if (options.transport !== undefined && options.transport !== 'auto') return options.transport;
  // A caller-supplied token already avoids the prompt, and it names the exact audience the
  // user wants, so it wins over a generic server.
  const token = process.env['MSCOMMS_GRAPH_TOKEN'];
  if (token !== undefined && token.trim() !== '') return 'device-code';
  return hasDiscoverableMcpServer(options.mcp ?? {}) ? 'mcp' : 'device-code';
}

const TRANSPORTS: readonly GraphTransport[] = ['auto', 'mcp', 'device-code'];

/**
 * Check the transport options a mount declares.
 *
 * The plugins otherwise cast their options through untouched, which means a misspelled
 * key is silently ignored. For most options that is a cosmetic problem; for this one it
 * is not, because the visible symptom of `"transprot": "mcp"` is a sign-in prompt the
 * user explicitly configured the tool to avoid, with nothing on screen to explain it.
 */
export function validateSharedOptions(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw VfsError.config('Mount "options" must be an object.');
  }
  const options = raw as Record<string, unknown>;

  const transport = options['transport'];
  if (transport !== undefined && !TRANSPORTS.includes(transport as GraphTransport)) {
    throw VfsError.config(
      `"transport" must be one of ${TRANSPORTS.map((value) => `"${value}"`).join(', ')}, not ${JSON.stringify(transport)}.`,
    );
  }

  const mcp = options['mcp'];
  if (mcp !== undefined && (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp))) {
    throw VfsError.config('"mcp" must be an object describing the server to run, such as { "command": "npx" }.');
  }
  if (mcp !== undefined) {
    const server = mcp as Record<string, unknown>;
    if (server['command'] !== undefined && typeof server['command'] !== 'string') {
      throw VfsError.config('"mcp.command" must be the name of a program to run.');
    }
    if (server['args'] !== undefined && !Array.isArray(server['args'])) {
      throw VfsError.config('"mcp.args" must be a list of arguments.');
    }
  }
}

export function createClient(options: GraphSharedOptions, state: StateStore, logger: Logger): GraphApi {
  if (resolveTransport(options) === 'mcp') {
    return new McpGraphApi(getMcpClient(options.mcp ?? {}, logger));
  }

  const authenticator = getAuthenticator(options, state, logger);
  return new GraphClient({
    getToken: () => authenticator.getToken(),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** Clear every cached sign-in. Backs `mscomms auth --reset`. */
export async function resetAllAuth(): Promise<void> {
  for (const authenticator of authenticators.values()) await authenticator.signOut();
  authenticators.clear();
  // The MCP servers hold no credentials of ours, but leaving them running after an
  // explicit reset would be surprising.
  closeAllMcpClients();
}

/**
 * Graph returns HTML bodies by default and they are unreadable in a terminal and worse
 * through a screen reader, which announces every tag. Requesting text is the first line of
 * defence; this is the fallback for the messages that arrive as HTML anyway.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '  • ');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** One line of preview text, for listings. */
export function preview(text: string, max = 160): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim().slice(0, max);
}
