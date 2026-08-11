/**
 * Line-delimited JSON transport for external provider programs.
 *
 * WHY A SUBPROCESS TIER EXISTS AT ALL
 *
 * The in-process plugin tier (a JS package exporting a `ProviderPlugin`) is the fast path,
 * but it locks the ecosystem to one language and one runtime. Most of the interesting
 * feeds someone will want to mount — an internal ticketing system, a Jira instance, a
 * mailing list archive, a Slack export — already have a first-class client library in
 * Python, Go, or Rust, and a shell script that shells out to an existing CLI is often
 * fifteen lines. Requiring those authors to rewrite in TypeScript is how plugin systems
 * end up with four plugins.
 *
 * So: one process, stdin/stdout, one JSON object per line. That is implementable in every
 * language on earth, including `bash` + `jq`, with no SDK to install and nothing to keep
 * in step with our version.
 *
 * PROTOCOL
 *
 *   -> {"id":1,"method":"list","params":{...}}      (host to plugin, one line)
 *   <- {"id":1,"result":{...}}                      (plugin to host, one line)
 *   <- {"id":1,"error":{"code":"ENOENT","message":"..."}}
 *
 * Requests carry an `id` and responses echo it, so a plugin is free to answer out of order
 * or concurrently. A plugin that only ever answers in order is also correct — the host
 * does not care.
 *
 * stderr is NOT part of the protocol. It is forwarded to the log. This is deliberate and
 * it is the single most important usability decision here: the first thing anyone writing
 * a plugin does is add a print statement, and in a design where stdout is the protocol and
 * stderr is swallowed, that print statement either corrupts the stream or vanishes. Here it
 * lands in the log where the author can read it with `mscomms --log-level debug`.
 *
 * FAILURE MODES, EACH HANDLED EXPLICITLY
 *
 * - Plugin hangs.        Every request has a deadline. On expiry the promise rejects and
 *                        the id is abandoned, so a late reply is discarded rather than
 *                        being mismatched onto some later request.
 * - Plugin crashes.      All in-flight requests reject with a diagnosis that includes the
 *                        exit code and the tail of stderr, which is almost always the
 *                        actual error message. Restart is lazy and backed off, so a plugin
 *                        that crashes on startup does not become a fork bomb.
 * - Plugin floods.       A line-length cap stops a runaway plugin from exhausting memory
 *                        one unterminated line at a time.
 * - Plugin prints junk.  Unparseable lines are logged and skipped, not fatal. A stray
 *                        `console.log` in a Node plugin should degrade one response, not
 *                        take down the shell.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { VfsError, type Logger, type VfsErrorCode } from '@mscomms/core';

/** Wire protocol version. Bumped only for incompatible changes. */
export const PROTOCOL_VERSION = 1;

/** Hard cap on a single line from the plugin. Prevents unbounded buffering. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Bytes of stderr retained for diagnostics. */
const STDERR_TAIL_BYTES = 8 * 1024;

export interface RpcOptions {
  /**
   * Program and arguments, already split.
   *
   * An array, never a string, and never run through a shell. A config file that could say
   * `command: "fetch-feed $FOLDER"` would be a shell injection waiting to happen the first
   * time a folder name contained a backtick — and folder names here come from remote
   * servers. Splitting is the caller's job, done once, in config validation.
   */
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs: number;
  /**
   * One process per request instead of a persistent one.
   *
   * Slower — a process spawn per `ls` — but it makes the plugin a plain filter: read one
   * JSON object from stdin, write one to stdout, exit. That is a five-line shell script,
   * and being able to write a working plugin in five lines is worth a great deal more than
   * the milliseconds it costs.
   */
  readonly oneshot?: boolean;
  readonly logger: Logger;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly method: string;
}

/**
 * A JSON-line channel to a child process.
 *
 * Owns process lifetime, request correlation and every timeout. Callers see a plain
 * `call(method, params)` promise.
 */
export class JsonLineClient {
  readonly #options: RpcOptions;
  readonly #pending = new Map<number, Pending>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #buffer = '';
  #stderrTail = '';
  #closed = false;
  #restartAt = 0;
  #consecutiveFailures = 0;

  constructor(options: RpcOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  /** Recent stderr, for error messages. Usually contains the plugin's real complaint. */
  get stderrTail(): string {
    return this.#stderrTail.trim();
  }

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) {
      throw new VfsError('EINTERNAL', 'This provider has been shut down.');
    }
    return this.#options.oneshot === true
      ? this.#callOneshot(method, params, signal)
      : this.#callPersistent(method, params, signal);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#failAll(new VfsError('EINTERNAL', 'The provider program was shut down.'));
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.stdin.end();
    // Give it a moment to leave on its own before insisting.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 500);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Persistent mode
  // -------------------------------------------------------------------------

  async #callPersistent(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.#ensureChild();
    const id = this.#nextId++;
    const line = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new VfsError(
            'ETIMEDOUT',
            `The provider program did not answer "${method}" within ${String(Math.round(this.#options.timeoutMs / 1000))}s.`,
            hintOption(this.#hintFromStderr()),
          ),
        );
      }, this.#options.timeoutMs);
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer, method });

      if (signal !== undefined) {
        const onAbort = (): void => {
          const entry = this.#pending.get(id);
          if (entry === undefined) return;
          this.#pending.delete(id);
          clearTimeout(entry.timer);
          reject(new VfsError('ECANCELED', 'Cancelled.'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdin.write(line, (error) => {
        if (!error) return;
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new VfsError('EINTERNAL', `Could not send a request to the provider program: ${error.message}`));
      });
    });
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    const existing = this.#child;
    if (existing !== undefined && existing.exitCode === null) return existing;

    if (Date.now() < this.#restartAt) {
      throw new VfsError(
        'EINTERNAL',
        'The provider program keeps failing to start, so it is being left alone for a moment.',
        {
          hint: this.#hintFromStderr() ?? 'Run the command yourself to see what it prints.',
          retryAfter: Math.ceil((this.#restartAt - Date.now()) / 1000),
        },
      );
    }

    const child = this.#spawn();
    this.#child = child;
    this.#buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#onStdout(chunk);
    });
    child.on('error', (error: Error) => {
      this.#onExit(null, error);
    });
    child.on('exit', (code, signalName) => {
      this.#onExit(code, undefined, signalName);
    });

    return child;
  }

  #spawn(): ChildProcessWithoutNullStreams {
    const [program, ...args] = this.#options.command;
    if (program === undefined) {
      throw new VfsError('ECONFIG', 'This provider has no command configured.');
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(program, args, {
        cwd: this.#options.cwd ?? process.cwd(),
        env: { ...process.env, ...this.#options.env, MSCOMMS_PROTOCOL: String(PROTOCOL_VERSION) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // No shell. See RpcOptions.command.
        shell: false,
      });
    } catch (error) {
      throw new VfsError('ECONFIG', `Could not start "${program}": ${(error as Error).message}`, {
        hint: 'Check the command path in your config.',
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') this.#options.logger.debug(`[${program}] ${line.trim()}`);
      }
    });
    return child;
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE_BYTES) {
      this.#buffer = '';
      this.#options.logger.error('The provider program sent one enormous line; it was dropped.');
      this.#failAll(
        new VfsError('EINTERNAL', 'The provider program sent more data than it is allowed to in a single response.'),
      );
      return;
    }
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#onLine(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #onLine(raw: string): void {
    const line = raw.trim();
    if (line === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Not fatal. A stray print in the plugin should cost one line, not the session.
      this.#options.logger.warn(`Ignoring a line from the provider program that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const envelope = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof envelope.id !== 'number') {
      this.#options.logger.warn('Ignoring a message from the provider program that has no request id.');
      return;
    }
    const entry = this.#pending.get(envelope.id);
    if (entry === undefined) return; // Abandoned by timeout, or a duplicate. Discard.
    this.#pending.delete(envelope.id);
    clearTimeout(entry.timer);
    this.#consecutiveFailures = 0;

    if (envelope.error !== undefined && envelope.error !== null) {
      entry.reject(rpcError(envelope.error, entry.method));
      return;
    }
    entry.resolve(envelope.result);
  }

  #onExit(code: number | null, error?: Error, signalName?: NodeJS.Signals | null): void {
    this.#child = undefined;
    if (this.#closed) return;

    this.#consecutiveFailures += 1;
    // Back off geometrically, capped, so a plugin that dies instantly is retried at a
    // human pace rather than as fast as the event loop allows.
    const backoff = Math.min(30_000, 250 * 2 ** Math.min(this.#consecutiveFailures, 7));
    this.#restartAt = Date.now() + backoff;

    const reason =
      error !== undefined
        ? error.message
        : signalName != null
          ? `killed by ${signalName}`
          : `exited with status ${String(code ?? 0)}`;
    const failure = new VfsError('EINTERNAL', `The provider program ${reason}.`, hintOption(this.#hintFromStderr()));
    if (this.#pending.size > 0) this.#options.logger.warn(failure.message);
    this.#failAll(failure);
  }

  #failAll(error: Error): void {
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  #hintFromStderr(): string | undefined {
    const tail = this.stderrTail;
    if (tail === '') return undefined;
    const lines = tail.split('\n').filter((line) => line.trim() !== '');
    const last = lines[lines.length - 1];
    return last === undefined ? undefined : `It last printed: ${last.trim().slice(0, 200)}`;
  }

  // -------------------------------------------------------------------------
  // One-shot mode
  // -------------------------------------------------------------------------

  async #callOneshot(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const [program, ...args] = this.#options.command;
    if (program === undefined) {
      throw new VfsError('ECONFIG', 'This provider has no command configured.');
    }

    return new Promise<unknown>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(program, [...args, method], {
          cwd: this.#options.cwd ?? process.cwd(),
          env: {
            ...process.env,
            ...this.#options.env,
            MSCOMMS_PROTOCOL: String(PROTOCOL_VERSION),
            MSCOMMS_METHOD: method,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        reject(new VfsError('ECONFIG', `Could not start "${program}": ${(error as Error).message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => {
          reject(
            new VfsError(
              'ETIMEDOUT',
              `The provider program did not answer "${method}" within ${String(Math.round(this.#options.timeoutMs / 1000))}s.`,
            ),
          );
        });
      }, this.#options.timeoutMs);
      timer.unref?.();

      signal?.addEventListener(
        'abort',
        () => {
          child.kill('SIGKILL');
          finish(() => {
            reject(new VfsError('ECANCELED', 'Cancelled.'));
          });
        },
        { once: true },
      );

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_LINE_BYTES) {
          child.kill('SIGKILL');
          finish(() => {
            reject(new VfsError('EINTERNAL', 'The provider program sent more data than it is allowed to.'));
          });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });

      child.on('error', (error: Error) => {
        finish(() => {
          reject(new VfsError('ECONFIG', `Could not run "${program}": ${error.message}`));
        });
      });

      child.on('close', (code) => {
        for (const line of stderr.split('\n')) {
          if (line.trim() !== '') this.#options.logger.debug(`[${program}] ${line.trim()}`);
        }
        finish(() => {
          if (code !== 0) {
            const lines = stderr.split('\n').filter((line) => line.trim() !== '');
            const last = lines[lines.length - 1];
            reject(
              new VfsError('EINTERNAL', `The provider program exited with status ${String(code ?? 0)}.`, {
                ...(last === undefined ? {} : { hint: `It last printed: ${last.trim().slice(0, 200)}` }),
              }),
            );
            return;
          }
          // Tolerate a plugin that prints several lines and ends with the answer, which is
          // what happens the moment someone adds a debug print to a shell script.
          const line = lastJsonLine(stdout);
          if (line === undefined) {
            reject(
              new VfsError('EINTERNAL', 'The provider program did not print a JSON response.', {
                hint: 'It must print one JSON object on stdout, like {"result": ...}.',
              }),
            );
            return;
          }
          const envelope = line as { result?: unknown; error?: unknown };
          if (envelope.error !== undefined && envelope.error !== null) {
            reject(rpcError(envelope.error, method));
            return;
          }
          resolve(envelope.result);
        });
      });

      child.stdin.write(`${JSON.stringify({ id: 1, method, params })}\n`);
      child.stdin.end();
    });
  }
}

/** Spread-safe hint, for xactOptionalPropertyTypes. */
function hintOption(hint: string | undefined): { hint?: string } {
  return hint === undefined ? {} : { hint };
}

/** Last parseable JSON object in the text, so debug output before the answer is tolerated. */
function lastJsonLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Turn a plugin's error object into a VfsError.
 *
 * Plugins are allowed, but not required, to use our error codes. A plugin that just says
 * `{"error": "not found"}` gets a sensible generic error rather than a type crash — the
 * cost of being strict here is paid by the plugin author's users, who cannot fix it.
 */
function rpcError(raw: unknown, method: string): VfsError {
  if (typeof raw === 'string') {
    return new VfsError('EINTERNAL', raw);
  }
  if (typeof raw !== 'object' || raw === null) {
    return new VfsError('EINTERNAL', `The provider program failed to handle "${method}".`);
  }
  const shape = raw as { code?: unknown; message?: unknown; hint?: unknown; retryAfter?: unknown };
  const message = typeof shape.message === 'string' && shape.message !== '' ? shape.message : `"${method}" failed.`;
  const code = KNOWN_CODES.has(String(shape.code)) ? (String(shape.code) as VfsErrorCode) : 'EINTERNAL';
  return new VfsError(code, message, {
    ...(typeof shape.hint === 'string' ? { hint: shape.hint } : {}),
    ...(typeof shape.retryAfter === 'number' ? { retryAfter: shape.retryAfter } : {}),
  });
}

const KNOWN_CODES = new Set<string>([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EACCES',
  'EAUTH',
  'ENOTSUP',
  'ENETWORK',
  'ERATELIMIT',
  'ETIMEDOUT',
  'ECANCELED',
  'EINVAL',
  'ECONFIG',
  'EINTERNAL',
] satisfies VfsErrorCode[]);
