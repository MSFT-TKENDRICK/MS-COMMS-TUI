/**
 * A minimal MCP client speaking JSON-RPC over a child process's stdio.
 *
 * This exists so a Graph mount can borrow a sign-in that already happened somewhere else.
 * In a managed tenant the device-code flow this package implements is often disabled
 * outright by policy, which left the providers with no way to authenticate at all even
 * though the machine was already signed in — the credential was simply held by another
 * tool. An MCP server is exactly that other tool: a subprocess that is already authorised
 * and will answer Graph questions on our behalf.
 *
 * Deliberately hand-rolled rather than taking the official SDK as a dependency. Nothing in
 * this repo has a third-party runtime dependency, and the slice of MCP needed here is
 * `initialize` plus `tools/call`.
 *
 * Care is taken with the subprocess because a wedged one would hang a session before the
 * first frame is drawn:
 *
 * - **Every request has a deadline.** A server that never answers rejects the call instead
 *   of leaving an await outstanding forever.
 * - **The argument vector is fixed and `shell` is false.** A config file cannot smuggle
 *   arguments into a command interpreter.
 * - **A dead child is not fatal.** If the server exits, in-flight calls reject and the next
 *   call spawns a fresh one, so a crash costs one request rather than the process.
 * - **stderr is drained, never parsed.** Servers print banners and progress there; leaving
 *   it unread would eventually fill the pipe buffer and block the child.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export interface McpToolResult {
  readonly structuredContent?: unknown;
  readonly content?: readonly { readonly type?: string; readonly text?: string; readonly data?: string }[];
  readonly isError?: boolean;
}

export interface McpClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Per-request deadline. Generous by default: these servers call a cloud API. */
  readonly timeoutMs?: number;
  readonly onLog?: (message: string) => void;
}

/** The part of the client `McpGraphClient` needs, so tests can supply a fake. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
  dispose(): void;
}

interface JsonRpcResponse {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpStdioClient implements McpTransport {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #timeoutMs: number;
  readonly #onLog: (message: string) => void;

  #child: ChildProcessWithoutNullStreams | undefined;
  #ready: Promise<void> | undefined;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(options: McpClientOptions) {
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#onLog = options.onLog ?? (() => undefined);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.#start();
    const result = await this.#request('tools/call', { name, arguments: args }, signal);
    return (result ?? {}) as McpToolResult;
  }

  dispose(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#ready = undefined;
    this.#failAll(new Error('MCP client disposed'));
    child?.kill();
  }

  /** Spawn and handshake at most once; concurrent callers share the same attempt. */
  #start(): Promise<void> {
    this.#ready ??= this.#spawn().catch((error: unknown) => {
      // A failed handshake must not be cached, or one bad start poisons the process.
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #spawn(): Promise<void> {
    const child = spawn(this.#command, [...this.#args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#consume(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#onLog(chunk.trimEnd());
    });
    child.on('error', (error) => {
      this.#child = undefined;
      this.#ready = undefined;
      this.#failAll(error);
    });
    child.on('exit', (code) => {
      this.#child = undefined;
      this.#ready = undefined;
      this.#failAll(new Error(`MCP server ${this.#command} exited with code ${String(code ?? 0)}`));
    });

    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mscomms', version: '0.1.0' },
    });
    // A notification, so no id and no reply to wait for.
    this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line === '') continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Servers are entitled to print non-JSON to stdout; it just is not for us.
        continue;
      }

      if (typeof message.id !== 'number') continue;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);

      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? 'MCP request failed'));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP server ${this.#command} did not answer ${method} within ${String(this.#timeoutMs)}ms`));
      }, this.#timeoutMs);

      const settle = {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#pending.set(id, settle);

      signal?.addEventListener(
        'abort',
        () => {
          this.#pending.delete(id);
          settle.reject(new Error('Request aborted'));
        },
        { once: true },
      );

      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        settle.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (child === undefined) throw new Error(`MCP server ${this.#command} is not running`);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/**
 * Whether a command can be found, without running it.
 *
 * The transport is chosen during provider initialisation, which is synchronous, so this
 * cannot be "try it and see". Spawning purely to probe would also mean paying for a process
 * start on machines that will never use this path.
 */
export function commandExists(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) {
    return isAbsolute(command) ? existsSync(command) : existsSync(join(process.cwd(), command));
  }

  const path = process.env['PATH'] ?? '';
  const extensions =
    process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];

  for (const directory of path.split(delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      if (existsSync(join(directory, `${command}${extension}`))) return true;
    }
  }
  return false;
}
