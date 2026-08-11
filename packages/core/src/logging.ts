/**
 * Logging and persistent per-mount state.
 *
 * Logs go to stderr, never stdout. stdout is reserved for the data the user asked for so
 * that `mscomms ls /mail/Inbox --tsv | awk ...` stays clean, and so a screen reader
 * reading the transcript is not interrupted by diagnostics it did not request.
 */

import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname as hostDirname, join as hostJoin } from 'node:path';
import type { Logger, StateStore } from './provider.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly prefix?: string;
  /** Append structured JSON lines here as well as writing to stderr. */
  readonly file?: string;
  /**
   * Where a finished line goes. It is called with the trailing newline already attached,
   * so an injected writer never has to know how lines are framed — an earlier version left
   * that to the caller and every `--verbose` run came out as one unreadable run-on line.
   */
  readonly write?: (line: string) => void;
}

export class ConsoleLogger implements Logger {
  readonly #level: number;
  readonly #prefix: string;
  readonly #file: string | undefined;
  readonly #write: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.#level = LEVEL_ORDER[options.level ?? 'warn'];
    this.#prefix = options.prefix ?? '';
    this.#file = options.file;
    this.#write = options.write ?? ((line) => process.stderr.write(line));
  }

  child(prefix: string): ConsoleLogger {
    const options: LoggerOptions = {
      level: (Object.keys(LEVEL_ORDER) as LogLevel[]).find((k) => LEVEL_ORDER[k] === this.#level) ?? 'warn',
      prefix: this.#prefix ? `${this.#prefix}:${prefix}` : prefix,
      write: this.#write,
      ...(this.#file === undefined ? {} : { file: this.#file }),
    };
    return new ConsoleLogger(options);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.#log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.#log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.#log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.#log('error', message, meta);
  }

  #log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.#level) return;
    const label = this.#prefix ? `[${level}] ${this.#prefix}: ` : `[${level}] `;
    const detail = meta === undefined ? '' : ' ' + safeJson(meta);
    this.#write(label + message + detail + '\n');

    if (this.#file !== undefined) {
      const record = safeJson({ ts: new Date().toISOString(), level, scope: this.#prefix, message, ...meta });
      appendLine(this.#file, record);
    }
  }

  /** Wait for this logger's pending file writes. Tests need this; production does not. */
  async flush(): Promise<void> {
    await flushLogFile(this.#file);
  }
}

/**
 * Per-file append queues.
 *
 * Two un-awaited `appendFile` calls can complete in either order, so a log written that way
 * records events in an order that never happened — and reconstructing a sequence is the
 * entire reason to keep a log. Each append therefore waits for the previous one to the same
 * file.
 *
 * Keyed by path rather than held per logger, because `child()` produces a separate instance
 * writing to the same file, and per-instance queues would let a parent and its child
 * interleave. The constraint belongs to the file, so the queue does too.
 *
 * Callers are never blocked: the chain is advanced, not awaited.
 */
const fileTails = new Map<string, Promise<void>>();

function appendLine(file: string, record: string): void {
  const previous = fileTails.get(file) ?? Promise.resolve();
  const next = previous.then(() =>
    appendFile(file, record + '\n', 'utf8').catch(() => {
      // A failing log file must never take down the application.
    }),
  );
  fileTails.set(file, next);
  // Drop the entry once it settles, so a long-lived process does not retain a promise per
  // log file it has ever touched.
  void next.then(() => {
    if (fileTails.get(file) === next) fileTails.delete(file);
  });
}

async function flushLogFile(file: string | undefined): Promise<void> {
  if (file === undefined) return;
  await fileTails.get(file);
}

/** JSON.stringify that survives cycles and BigInt rather than throwing inside a logger. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

export const NULL_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NULL_LOGGER;
  },
};

// ---------------------------------------------------------------------------
// State stores
// ---------------------------------------------------------------------------

export class MemoryStateStore implements StateStore {
  readonly #map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.#map.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.#map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#map);
  }
}

/**
 * A JSON file backed store, one file per mount.
 *
 * Writes are atomic (write to a temp file, then rename) because these files hold sync
 * cursors: a half-written deltaLink truncated by a Ctrl+C would silently desynchronize
 * the mailbox and the user would never be told why they stopped seeing new mail.
 * Writes are also serialized through a promise chain so concurrent polls cannot interleave.
 */
export class FileStateStore implements StateStore {
  #cache: Record<string, string> | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<string | undefined> {
    const data = await this.#load();
    return data[key];
  }

  async set(key: string, value: string): Promise<void> {
    return this.#mutate((data) => {
      data[key] = value;
    });
  }

  async delete(key: string): Promise<void> {
    return this.#mutate((data) => {
      delete data[key];
    });
  }

  async #load(): Promise<Record<string, string>> {
    if (this.#cache !== undefined) return this.#cache;
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      this.#cache =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
    } catch {
      // Missing or corrupt state is recoverable: we simply resync from scratch.
      this.#cache = {};
    }
    return this.#cache;
  }

  #mutate(apply: (data: Record<string, string>) => void): Promise<void> {
    const next = this.#queue.then(async () => {
      const data = await this.#load();
      apply(data);
      await mkdir(hostDirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
      await rename(temp, this.filePath);
    });
    // Keep the chain alive even if one write fails, so later writes still run.
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

export function stateFileFor(baseDir: string, mountId: string): string {
  const safe = mountId.replace(/[^A-Za-z0-9._-]/g, '_');
  return hostJoin(baseDir, 'state', `${safe}.json`);
}
