/**
 * Turso's AgentFS, running on our storage driver.
 *
 * AgentFS is a filesystem specification over SQLite: inodes, directory entries, chunked
 * file data, an insert-only tool-call audit log, and a key-value store. That matters here
 * because this program already models mail, chats, issues and feeds as a filesystem. The
 * snapshot turns that model into rows; AgentFS turns those rows into something the rest of
 * the machine can open. Exported, the cache can be mounted with `agentfs mount`, and then
 * `rg`, `fzf`, an editor, or another agent can read your mail as ordinary files.
 *
 * We do not reimplement the specification. We use the real SDK, and supply the one piece it
 * cannot supply here: a database.
 *
 * The SDK reaches for `@tursodatabase/database`, a native module with no win32-arm64 build
 * (`@tursodatabase/database-win32-arm64-msvc` is a 404), so importing the package's public
 * entry throws "Cannot find native binding" on this machine. Its filesystem logic, however,
 * is plain SQL over a tiny database interface, and it takes that database as a constructor
 * argument — `AgentFS.fromDatabase(db)`. `DatabasePromise` is imported there as a *type*,
 * so it erases at runtime and the class itself has no native dependency at all.
 *
 * So the gap is the driver, not the filesystem, and we already have a driver that works
 * everywhere. `agentFsDatabase()` adapts `SqlDriver` to the shape the SDK expects, and the
 * genuine, unmodified AgentFS runs on top of it. When Turso publishes a build for this
 * platform, `loadAgentFs()` starts taking the public entry and nothing else changes.
 */

import type { SqlDriver, SqlValue } from './sql.js';

/**
 * The database interface the AgentFS SDK expects.
 *
 * Structural, and deliberately not imported from the SDK: the SDK's type entry pulls in the
 * native module's types, and this is the whole surface it actually uses. Writing it out is
 * also the honest documentation of how small the coupling is.
 */
export interface AgentFsDatabase {
  exec(sql: string): Promise<void>;
  /** Synchronous by contract — the SDK does not await it. */
  prepare(sql: string): AgentFsStatement;
}

export interface AgentFsStatement {
  run(...params: readonly SqlValue[]): Promise<unknown>;
  get(...params: readonly SqlValue[]): Promise<Record<string, unknown> | undefined>;
  all(...params: readonly SqlValue[]): Promise<ReadonlyArray<Record<string, unknown>>>;
}

/** The slice of the AgentFS filesystem this program uses. */
export interface AgentFsLike {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<{ size: number; mode: number; isFile(): boolean; isDirectory(): boolean }>;
  getChunkSize(): number;
}

export interface ToolCallsLike {
  record(
    name: string,
    startedAt: number,
    completedAt: number,
    parameters?: unknown,
    result?: unknown,
    error?: string,
  ): Promise<number>;
  getRecent(since: number, limit?: number): Promise<ReadonlyArray<Record<string, unknown>>>;
  getStats(): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export interface KvStoreLike {
  set(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
}

export interface AgentFsModule {
  readonly AgentFS: { fromDatabase(db: AgentFsDatabase): Promise<AgentFsLike> };
  readonly ToolCalls: { fromDatabase(db: AgentFsDatabase): Promise<ToolCallsLike> };
  readonly KvStore: { fromDatabase(db: AgentFsDatabase): Promise<KvStoreLike> };
  /**
   * How the SDK was reached. `package` means its public entry imported cleanly, which is
   * what we want everywhere and what will happen here once Turso ships this platform.
   */
  readonly via: 'package' | 'submodule';
}

/**
 * Adapt a `SqlDriver` to the SDK's database interface.
 *
 * `prepare` returns a statement rather than running anything, because the SDK prepares once
 * and binds many times. Our drivers take the SQL and the parameters together, so a prepared
 * statement here is just the SQL held until it is bound — the driver does its own caching
 * underneath, and pretending otherwise would buy nothing.
 */
export function agentFsDatabase(driver: SqlDriver): AgentFsDatabase {
  return {
    exec: (sql: string) => driver.exec(sql),
    prepare: (sql: string): AgentFsStatement => ({
      run: (...params) => driver.run(sql, params),
      get: async (...params) => {
        const row = await driver.get(sql, params);
        return row as Record<string, unknown> | undefined;
      },
      all: async (...params) => {
        const rows = await driver.all(sql, params);
        return rows as ReadonlyArray<Record<string, unknown>>;
      },
    }),
  };
}

/** Cached so a failing import is attempted once, not once per call. */
let cachedModule: AgentFsModule | undefined;
let cachedFailure: Error | undefined;

/**
 * Load the AgentFS SDK, preferring its public entry.
 *
 * The fallback imports the SDK's own compiled submodules directly. That is a deliberate
 * reach past a package's front door, so it is worth being precise about why it is safe
 * here: those files contain the filesystem implementation itself, they import nothing
 * native, and we are not reimplementing or patching them — we are loading the same code the
 * public entry would have loaded, having skipped the index module that eagerly pulls in a
 * binding this platform does not have.
 *
 * It is still a version-coupled path, so `agentfs-sdk` is pinned and a test asserts the
 * layout still exists. If that test ever fails, the fix is to widen the pin, not to guess.
 */
export async function loadAgentFs(): Promise<AgentFsModule> {
  if (cachedModule !== undefined) return cachedModule;
  if (cachedFailure !== undefined) throw cachedFailure;

  try {
    const mod = (await import('agentfs-sdk')) as unknown as {
      AgentFS: AgentFsModule['AgentFS'];
      ToolCalls: AgentFsModule['ToolCalls'];
      KvStore: AgentFsModule['KvStore'];
    };
    cachedModule = { AgentFS: mod.AgentFS, ToolCalls: mod.ToolCalls, KvStore: mod.KvStore, via: 'package' };
    return cachedModule;
  } catch (error) {
    // Anything other than the missing binding is a real problem and should not be papered
    // over by a fallback that will fail in a more confusing way.
    if (!isMissingNativeBinding(error)) {
      cachedFailure = asError(error);
      throw cachedFailure;
    }
  }

  try {
    const entry = import.meta.resolve('agentfs-sdk');
    const at = (file: string): string => entry.replace(/index_node\.js$/, file);
    const [fsMod, toolMod, kvMod] = await Promise.all([
      import(at('filesystem/agentfs.js')) as Promise<{ AgentFS: AgentFsModule['AgentFS'] }>,
      import(at('toolcalls.js')) as Promise<{ ToolCalls: AgentFsModule['ToolCalls'] }>,
      import(at('kvstore.js')) as Promise<{ KvStore: AgentFsModule['KvStore'] }>,
    ]);
    cachedModule = {
      AgentFS: fsMod.AgentFS,
      ToolCalls: toolMod.ToolCalls,
      KvStore: kvMod.KvStore,
      via: 'submodule',
    };
    return cachedModule;
  } catch (error) {
    cachedFailure = new Error(
      `AgentFS could not be loaded on ${process.platform}-${process.arch}: ${asError(error).message}`,
      { cause: error },
    );
    throw cachedFailure;
  }
}

/** Only for tests, which need to prove both load paths rather than whichever ran first. */
export function resetAgentFsCache(): void {
  cachedModule = undefined;
  cachedFailure = undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * napi-rs reports every missing platform package with the same sentence, and the error is a
 * plain `Error`, so the message is the only thing to match on.
 */
function isMissingNativeBinding(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Cannot find native binding') ||
    message.includes('ERR_MODULE_NOT_FOUND') ||
    message.includes('Cannot find module')
  );
}
