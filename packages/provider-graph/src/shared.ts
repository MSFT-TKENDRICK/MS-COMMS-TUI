/**
 * Shared plumbing for the Graph-backed providers.
 *
 * Both the mail provider and the Teams provider need the same authenticator. Creating one
 * per mount would mean two device-code prompts on first run, which is exactly the kind of
 * small papercut that makes people stop using a tool. The authenticator is therefore
 * cached per (authority, tenant, client, scope-set) for the lifetime of the process.
 */

import type { Logger, StateStore } from '@mscomms/core';
import { DeviceCodeAuthenticator, DEFAULT_CLIENT_ID, DEFAULT_SCOPES } from './auth.js';
import { GraphClient } from './client.js';

export interface GraphSharedOptions {
  readonly clientId?: string;
  readonly tenantId?: string;
  readonly authority?: string;
  readonly baseUrl?: string;
  readonly scopes?: readonly string[];
  readonly timeoutMs?: number;
}

const authenticators = new Map<string, DeviceCodeAuthenticator>();

export function getAuthenticator(
  options: GraphSharedOptions,
  state: StateStore,
  logger: Logger,
): DeviceCodeAuthenticator {
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const tenantId = options.tenantId ?? 'organizations';
  const authority = options.authority ?? 'https://login.microsoftonline.com';
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  const key = `${authority}|${tenantId}|${clientId}|${[...scopes].sort().join(',')}`;

  let authenticator = authenticators.get(key);
  if (authenticator === undefined) {
    authenticator = new DeviceCodeAuthenticator({ clientId, tenantId, authority, scopes, state, logger });
    authenticators.set(key, authenticator);
  }
  return authenticator;
}

export function createClient(options: GraphSharedOptions, state: StateStore, logger: Logger): GraphClient {
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
