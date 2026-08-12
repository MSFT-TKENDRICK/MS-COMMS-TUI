/**
 * Shared plumbing for the Graph-backed providers.
 *
 * Both the mail provider and the Teams provider need the same authenticator. Creating one
 * per mount would mean two device-code prompts on first run, which is exactly the kind of
 * small papercut that makes people stop using a tool. The authenticator is therefore
 * cached per (authority, tenant, client, scope-set, resource identity) for the lifetime of
 * the process.
 *
 * The Azure DevOps provider reuses `getAuthenticator` too. It is not a Graph client — the
 * API, the base URL and the error semantics are all different — but the sign-in *is* the
 * same Microsoft identity device-code flow, and reimplementing it there would mean two
 * copies of the trickiest code in the repo.
 */

import type { Logger, StateStore } from '@mscomms/core';
import { DeviceCodeAuthenticator, DEFAULT_CLIENT_ID, DEFAULT_SCOPES } from './auth.js';
import { GraphClient, type GraphApi } from './client.js';
import { McpStdioClient, commandExists, type McpTransport } from './mcp-client.js';
import { McpGraphClient, type McpToolNames } from './mcp-graph.js';

/**
 * How a mount reaches Graph.
 *
 * - `https` calls Graph directly and signs in with the device-code flow.
 * - `mcp` asks an already-signed-in MCP server, so nothing has to sign in here at all.
 * - `auto` prefers `mcp` when its command is installed, because a tenant that ships one
 *   usually does so *because* interactive sign-in is restricted. It falls back to `https`,
 *   which is what happens on a machine that has never heard of any of this.
 */
export type GraphTransport = 'auto' | 'https' | 'mcp';

export interface GraphMcpOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly tools?: Partial<McpToolNames>;
}

export interface GraphSharedOptions {
  readonly clientId?: string;
  readonly tenantId?: string;
  readonly authority?: string;
  readonly baseUrl?: string;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
  readonly transport?: GraphTransport;
  readonly mcp?: GraphMcpOptions;
}

const DEFAULT_MCP_COMMAND = 'agency';
const DEFAULT_MCP_ARGS: readonly string[] = ['mcp', 'workiq'];

const authenticators = new Map<string, DeviceCodeAuthenticator>();
const transports = new Map<string, { transport: McpTransport; refs: number }>();

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
 * Which transport a mount will actually use.
 *
 * Exported so `mscomms doctor` can report the decision: "why am I being asked to sign in"
 * and "why am I not" are both questions the answer to this determines.
 */
export function resolveTransport(options: GraphSharedOptions = {}): 'https' | 'mcp' {
  const requested = options.transport ?? 'auto';
  if (requested === 'https') return 'https';
  const command = options.mcp?.command ?? DEFAULT_MCP_COMMAND;
  if (requested === 'mcp') return 'mcp';
  return commandExists(command) ? 'mcp' : 'https';
}

/**
 * One server process per command line, shared by every mount that wants it.
 *
 * Mail, Teams and people mounts would otherwise start three copies of the same server, each
 * paying its own startup and holding its own connection, to answer questions that one can
 * serve perfectly well.
 *
 * Reference counted, because the process has to be killed on the way out. A child holding
 * an open pipe keeps the event loop alive, so a command that forgot to let go would print
 * its output and then hang forever instead of exiting.
 */
export function getMcpTransport(options: GraphSharedOptions, logger: Logger): McpTransport {
  const key = mcpKey(options);

  let entry = transports.get(key);
  if (entry === undefined) {
    const command = options.mcp?.command ?? DEFAULT_MCP_COMMAND;
    entry = {
      refs: 0,
      transport: new McpStdioClient({
        command,
        args: options.mcp?.args ?? DEFAULT_MCP_ARGS,
        ...(options.mcp?.timeoutMs === undefined ? {} : { timeoutMs: options.mcp.timeoutMs }),
        onLog: (message) => {
          logger.debug(`[mcp:${command}] ${message}`);
        },
      }),
    };
    transports.set(key, entry);
  }
  entry.refs += 1;
  return entry.transport;
}

/** Give up a mount's share of the server, stopping it once nobody is left using it. */
export function releaseClient(options: GraphSharedOptions = {}): void {
  if (resolveTransport(options) !== 'mcp') return;
  const key = mcpKey(options);
  const entry = transports.get(key);
  if (entry === undefined) return;

  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.transport.dispose();
  transports.delete(key);
}

function mcpKey(options: GraphSharedOptions): string {
  return [options.mcp?.command ?? DEFAULT_MCP_COMMAND, ...(options.mcp?.args ?? DEFAULT_MCP_ARGS)].join(' ');
}

export function createClient(options: GraphSharedOptions, state: StateStore, logger: Logger): GraphApi {
  if (resolveTransport(options) === 'mcp') {
    const command = options.mcp?.command ?? DEFAULT_MCP_COMMAND;
    logger.debug(`Graph transport: MCP via \`${command}\` (no interactive sign-in needed)`);
    return new McpGraphClient({
      transport: getMcpTransport(options, logger),
      ...(options.mcp?.tools === undefined ? {} : { tools: options.mcp.tools }),
    });
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
  for (const entry of transports.values()) entry.transport.dispose();
  transports.clear();
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
