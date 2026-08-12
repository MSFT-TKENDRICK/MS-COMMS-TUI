/**
 * Microsoft Graph over an already-authenticated MCP server.
 *
 * The device-code flow in `auth.ts` asks the user to sign in. On a machine where the user
 * is *already* signed in to M365 and an MCP server is already brokering that access, being
 * asked again is not a security measure — it is the tool failing to notice credentials it
 * has been handed. This transport reads mail through that server instead, so a fully
 * provisioned machine never sees a sign-in prompt.
 *
 * Two things make this a small change rather than a second client:
 *
 *   1. `GraphApi` is the only surface the providers depend on, so mail, Teams and people
 *      all work through this with no provider changes at all.
 *   2. The MCP server returns *raw Graph payloads*, `@odata.nextLink` and all. Paging,
 *      `$select`, filtering and error mapping are therefore identical to the HTTP path —
 *      this file is transport, not translation.
 *
 * The JSON-RPC framing is written out rather than pulled from the MCP SDK because the
 * surface actually used here is three calls wide (`initialize`, `notifications/initialized`,
 * `tools/call`) and pinning a protocol library for that would couple the mail client's
 * release cadence to the SDK's for no behavioural gain.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VfsError, type Logger } from '@mscomms/core';
import {
  graphFailure,
  toGraphPage,
  toRelativeGraphPath,
  type GraphApi,
  type GraphPage,
  type GraphRequestOptions,
} from './client.js';

/** Where the MCP server comes from, and how patient to be with it. */
export interface McpTransportOptions {
  /** Executable to run. Defaults to the discovered server, then to WorkIQ via `npx`. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Name of the server to look for in the MCP config files. Defaults to `workiq`. */
  readonly server?: string;
  /** Explicit MCP config file, bypassing discovery. */
  readonly configPath?: string;
  /** `npx` may need to download the server on first run, so this is generous. */
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface McpToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** One entry of a WorkIQ `fetch` response: the Graph body plus the status it came back with. */
interface McpFetchEntry {
  readonly data?: unknown;
  readonly statusCode?: number;
  /** Either a bare string or Graph's own `{ error: { code, message } }` envelope. */
  readonly error?: unknown;
}

const DEFAULT_SERVER_NAME = 'workiq';
const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = ['-y', '@microsoft/workiq@latest', 'mcp'];

/**
 * A minimal JSON-RPC 2.0 client speaking newline-delimited messages over stdio.
 *
 * Deliberately lazy: the server is not started until something actually needs data, so a
 * config listing a Graph mount does not pay an `npx` startup on every shell launch.
 */
export class McpStdioClient {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #env: Readonly<Record<string, string>> | undefined;
  readonly #cwd: string | undefined;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #logger: Logger;

  #child: ChildProcess | undefined;
  #ready: Promise<void> | undefined;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** Kept because a server that dies during startup explains itself on stderr and nowhere else. */
  #stderr: string[] = [];
  #closed = false;

  constructor(options: McpTransportOptions, logger: Logger) {
    this.#command = options.command ?? DEFAULT_COMMAND;
    this.#args = options.args ?? (options.command === undefined ? DEFAULT_ARGS : []);
    this.#env = options.env;
    this.#cwd = options.cwd;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#logger = logger;
  }

  get description(): string {
    return [this.#command, ...this.#args].join(' ');
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.#start();
    const result = await this.#request('tools/call', { name, arguments: args }, this.#requestTimeoutMs, signal);
    return result as McpToolResult;
  }

  #start(): Promise<void> {
    this.#ready ??= this.#handshake();
    return this.#ready;
  }

  async #handshake(): Promise<void> {
    if (this.#closed) throw VfsError.config('The MCP transport has been shut down.');
    this.#spawn();
    const result = (await this.#request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mscomms', version: '1.0.0' },
      },
      this.#startupTimeoutMs,
    )) as { serverInfo?: { name?: string; version?: string } };

    this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.#logger.debug(
      `Graph MCP transport ready: ${result.serverInfo?.name ?? 'unknown server'} (${this.description})`,
    );
  }

  #spawn(): void {
    // `npx`, and most MCP servers, are shell shims on Windows. Node refuses to execute a
    // `.cmd` directly, and `shell: true` would hand the arguments to a command line to be
    // re-parsed. Going through `cmd /d /c` with the arguments still separate avoids both.
    const useCmd = process.platform === 'win32' && !/\.(exe|com)$/i.test(this.#command);
    const command = useCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : this.#command;
    const args = useCmd ? ['/d', '/c', this.#command, ...this.#args] : [...this.#args];

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
        env: { ...process.env, ...this.#env },
      });
    } catch (error) {
      throw VfsError.config(`Could not start the MCP server \`${this.description}\`: ${String(error)}`);
    }

    this.#child = child;
    // A one-shot command like `mscomms ls /mail` must still exit when it is done. An
    // attached child process and its pipes are all handles that keep the event loop
    // alive, so the transport would otherwise hang the CLI after printing its output.
    // Unreferencing them is safe: while a request is in flight its timeout timer keeps
    // the process alive, and I/O on an unreferenced handle still works normally.
    child.unref();
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    unrefStream(child.stdin);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.#consume(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Bounded: a chatty server must not turn into a memory leak in a long-lived shell.
      this.#stderr.push(chunk);
      if (this.#stderr.length > 50) this.#stderr.shift();
    });
    child.on('error', (error) => {
      this.#fail(VfsError.config(`The MCP server \`${this.description}\` could not be started: ${error.message}`));
    });
    child.on('exit', (code) => {
      this.#fail(
        VfsError.config(
          `The MCP server \`${this.description}\` exited (code ${String(code ?? 0)}).${this.#stderrHint()}`,
        ),
      );
    });
  }

  #stderrHint(): string {
    const text = this.#stderr.join('').trim();
    return text === '' ? '' : ` Output: ${text.slice(-400)}`;
  }

  /** Reject everything in flight and allow a later call to start a fresh server. */
  #fail(error: VfsError): void {
    this.#ready = undefined;
    this.#child = undefined;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === '') continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Servers that print diagnostics to stdout are common enough that this must not be
        // fatal; the request's own timeout still covers a genuinely broken server.
        continue;
      }

      if (message.id === undefined) continue;
      const entry = this.#pending.get(message.id);
      if (entry === undefined) continue;
      this.#pending.delete(message.id);

      if (message.error !== undefined) {
        entry.reject(new VfsError('ENETWORK', `MCP server error: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  #request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        settle(() => {
          reject(new VfsError('ETIMEDOUT', 'The request was cancelled.'));
        });
      };

      const timer = setTimeout(() => {
        this.#pending.delete(id);
        settle(() => {
          reject(
            new VfsError('ETIMEDOUT', `The MCP server did not answer ${method} in time.`, {
              hint: `Server: \`${this.description}\`.${this.#stderrHint()}`,
            }),
          );
        });
      }, timeoutMs);

      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      if (signal?.aborted === true) {
        settle(() => {
          reject(new VfsError('ETIMEDOUT', 'The request was cancelled.'));
        });
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (value) => {
          settle(() => {
            resolve(value);
          });
        },
        reject: (error) => {
          settle(() => {
            reject(error);
          });
        },
      });

      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        settle(() => {
          reject(VfsError.config(`Could not write to the MCP server: ${String(error)}`));
        });
      }
    });
  }

  #write(message: unknown): void {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || stdin === null) throw new Error('the server is not running');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * Shut the server down the way the stdio transport is meant to be shut down.
   *
   * Closing stdin first matters on Windows, where the server is reached through a `cmd`
   * shim: killing the shim would leave the actual server process orphaned, whereas the
   * server notices its own stdin reaching end-of-file and exits. The kill is only a
   * backstop for a server that ignores that, and its timer is unreferenced so waiting for
   * it cannot itself delay exit.
   */
  close(): void {
    this.#closed = true;
    const child = this.#child;
    this.#ready = undefined;
    this.#child = undefined;
    for (const entry of this.#pending.values()) {
      entry.reject(VfsError.config('The MCP transport was shut down.'));
    }
    this.#pending.clear();
    if (child === undefined) return;

    try {
      child.stdin?.end();
    } catch {
      // Already gone; the kill below is enough.
    }
    const timer = setTimeout(() => {
      child.kill();
    }, 2_000);
    timer.unref();
  }
}

/**
 * `GraphApi` backed by an MCP server.
 *
 * Every method funnels through the same unwrap-and-map pair, so a status code means the
 * same thing here as it does over HTTP.
 */
export class McpGraphApi implements GraphApi {
  readonly #client: McpStdioClient;

  constructor(client: McpStdioClient) {
    this.#client = client;
  }

  async get<T>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    const relative = toRelativeGraphPath(path);
    const result = await this.#client.call('fetch', { entityUrls: [relative] }, options.signal);
    return this.#unwrapFetch(result, relative) as T;
  }

  async getPage<T>(path: string, options: GraphRequestOptions = {}): Promise<GraphPage<T>> {
    return toGraphPage<T>(await this.get<Record<string, unknown>>(path, options));
  }

  async getBytes(path: string, options: GraphRequestOptions = {}): Promise<Uint8Array> {
    const relative = toRelativeGraphPath(path);
    const result = await this.#client.call('fetch_blob', { path: relative }, options.signal);
    const payload = structuredPayload(result, relative);
    const status = typeof payload['statusCode'] === 'number' ? payload['statusCode'] : 200;
    if (status >= 400) {
      const { detail, code } = describeMcpError(payload['error']);
      throw graphFailure(status, relative, detail, code);
    }

    const base64 = payload['base64Content'];
    if (typeof base64 !== 'string') {
      throw new VfsError('ENETWORK', `The MCP server returned no content for ${relative}.`);
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  async post<T>(path: string, body: unknown, options: GraphRequestOptions = {}): Promise<T> {
    const relative = toRelativeGraphPath(path);
    const result = await this.#client.call(
      'do_action',
      { actionUrl: relative, jsonBody: body ?? {} },
      options.signal,
    );
    return this.#unwrapWrite(result, relative) as T;
  }

  async patch<T>(path: string, body: unknown, options: GraphRequestOptions = {}): Promise<T> {
    const relative = toRelativeGraphPath(path);
    const result = await this.#client.call(
      'update_entity',
      {
        entityUrl: relative,
        jsonBody: body ?? {},
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
      options.signal,
    );
    return this.#unwrapWrite(result, relative) as T;
  }

  /**
   * A `fetch` response carries the Graph body under `results[0].data` with the status
   * beside it, so failures are reported by status rather than by the tool erroring.
   */
  #unwrapFetch(result: McpToolResult, path: string): unknown {
    const payload = structuredPayload(result, path);
    const results = payload['results'];
    const entry: McpFetchEntry | undefined = Array.isArray(results)
      ? (results[0] as McpFetchEntry | undefined)
      : undefined;

    if (entry === undefined) {
      throw new VfsError('ENETWORK', `The MCP server returned nothing for ${path}.`, {
        hint: describeToolError(result),
      });
    }

    const status = entry.statusCode ?? (result.isError === true ? 500 : 200);
    if (status >= 400 || entry.data === null || entry.data === undefined) {
      const { detail, code } = describeMcpError(entry.error);
      throw graphFailure(
        status >= 400 ? status : 500,
        path,
        detail === '' ? describeToolError(result) : detail,
        code,
      );
    }
    return entry.data;
  }

  /**
   * Writes are looser: the action tools answer with whatever the underlying call produced,
   * and several Graph actions legitimately return nothing at all.
   */
  #unwrapWrite(result: McpToolResult, path: string): unknown {
    const payload = structuredPayload(result, path);
    const results = payload['results'];
    const entry: McpFetchEntry | undefined = Array.isArray(results)
      ? (results[0] as McpFetchEntry | undefined)
      : undefined;

    const status = entry?.statusCode ?? (typeof payload['statusCode'] === 'number' ? payload['statusCode'] : 200);
    if (status >= 400) {
      const { detail, code } = describeMcpError(entry?.error ?? payload['error']);
      throw graphFailure(status, path, detail === '' ? describeToolError(result) : detail, code);
    }
    if (result.isError === true) {
      throw new VfsError('ENETWORK', `The MCP server rejected ${path}.`, { hint: describeToolError(result) });
    }
    return entry?.data ?? payload['data'] ?? {};
  }
}

/**
 * Prefer `structuredContent`, fall back to a JSON text block.
 *
 * Servers are free to answer either way, and a transport that only understood one of them
 * would work until the day the server changed its mind.
 */
function structuredPayload(result: McpToolResult, path: string): Record<string, unknown> {
  if (result.structuredContent !== undefined) return result.structuredContent;

  for (const block of result.content ?? []) {
    if (block.type !== 'text' || block.text === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // Not JSON; fall through to the error below.
    }
  }

  throw new VfsError('ENETWORK', `The MCP server returned an unreadable response for ${path}.`, {
    hint: describeToolError(result),
  });
}

/**
 * A child process's pipes keep the event loop alive but are not typed as unreferenceable.
 * They are sockets at runtime, so this checks rather than asserts.
 */
function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

function describeToolError(result: McpToolResult): string {
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && block.text !== undefined)
    .map((block) => block.text ?? '')
    .join(' ')
    .trim();
  return text === '' ? 'The server gave no explanation.' : text.slice(0, 400);
}

/**
 * Pull a message and a Graph error code out of whatever the server put in `error`.
 *
 * It may be a bare string or Graph's own `{ error: { code, message } }` envelope. Reading
 * the envelope is what keeps "that message is gone" from being reported as a bare HTTP
 * number, and it recovers the code that `graphFailure` uses to classify the failure.
 */
export function describeMcpError(value: unknown): { detail: string; code: string } {
  if (typeof value === 'string') return { detail: value, code: '' };
  if (typeof value !== 'object' || value === null) return { detail: '', code: '' };

  const record = value as Record<string, unknown>;
  const inner = record['error'];
  if (typeof inner === 'object' && inner !== null) return describeMcpError(inner);
  if (typeof inner === 'string') return { detail: inner, code: '' };

  const message = record['message'];
  const code = record['code'];
  return {
    detail: typeof message === 'string' ? message : JSON.stringify(value).slice(0, 300),
    code: typeof code === 'string' ? code : '',
  };
}

const clients = new Map<string, McpStdioClient>();

/**
 * One server process per command, shared by every mount that resolves to it.
 *
 * Three Graph mounts is the normal case, and starting three copies of the same server
 * would triple both the startup cost and the memory for no benefit.
 */
export function getMcpClient(options: McpTransportOptions, logger: Logger): McpStdioClient {
  const resolved = resolveMcpServer(options);
  const key = JSON.stringify([resolved.command, resolved.args, resolved.env ?? {}, resolved.cwd ?? '']);
  let client = clients.get(key);
  if (client === undefined) {
    client = new McpStdioClient(resolved, logger);
    clients.set(key, client);
  }
  return client;
}

export function closeAllMcpClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}

/** Config files that may describe the server, most specific first. */
export function mcpConfigCandidates(): string[] {
  const home = homedir();
  const explicit = process.env['MSCOMMS_GRAPH_MCP_CONFIG'];
  return [
    ...(explicit === undefined || explicit === '' ? [] : [explicit]),
    join(home, '.copilot', 'mcp-config.json'),
    join(home, '.copilot', 'installed-plugins', 'copilot-plugins', DEFAULT_SERVER_NAME, '.mcp.json'),
  ];
}

interface McpServerEntry {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

/**
 * Find the server's launch command.
 *
 * Explicit config always wins; discovery only fills in what was not stated. Discovery is
 * by *name* rather than by guessing which of the installed servers looks like it can read
 * mail, because silently picking a different server than the user expected is worse than
 * not finding one.
 */
export function resolveMcpServer(options: McpTransportOptions): McpTransportOptions {
  if (options.command !== undefined) return options;

  const envCommand = process.env['MSCOMMS_GRAPH_MCP_COMMAND'];
  if (envCommand !== undefined && envCommand.trim() !== '') {
    const parts = envCommand.trim().split(/\s+/);
    const [command, ...args] = parts;
    return { ...options, command: command ?? DEFAULT_COMMAND, args };
  }

  const name = options.server ?? DEFAULT_SERVER_NAME;
  const paths = options.configPath === undefined ? mcpConfigCandidates() : [options.configPath];
  for (const path of paths) {
    const entry = readServerEntry(path, name);
    if (entry?.command === undefined) continue;
    return {
      ...options,
      command: entry.command,
      args: entry.args ?? [],
      ...(entry.env === undefined ? {} : { env: { ...entry.env, ...options.env } }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    };
  }

  return { ...options, command: DEFAULT_COMMAND, args: DEFAULT_ARGS };
}

function readServerEntry(path: string, name: string): McpServerEntry | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServerEntry> };
    return parsed.mcpServers?.[name];
  } catch {
    return undefined;
  }
}

/** True when a server is configured or installed, so `auto` can prefer it over signing in. */
export function hasDiscoverableMcpServer(options: McpTransportOptions = {}): boolean {
  if (options.command !== undefined) return true;
  const envCommand = process.env['MSCOMMS_GRAPH_MCP_COMMAND'];
  if (envCommand !== undefined && envCommand.trim() !== '') return true;

  const name = options.server ?? DEFAULT_SERVER_NAME;
  const paths = options.configPath === undefined ? mcpConfigCandidates() : [options.configPath];
  return paths.some((path) => readServerEntry(path, name)?.command !== undefined);
}
