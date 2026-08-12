/**
 * The SQL layer under the local snapshot store.
 *
 * The snapshot is a libSQL (Turso) database, and `@libsql/client` is a real dependency of
 * this package. That buys the things the snapshot actually wants: an embedded replica that
 * syncs against a remote Turso database, `vector32`/`vector_distance_cos` evaluated inside
 * the database, and `libsql_vector_idx` for approximate nearest-neighbour search.
 *
 * WHY THERE IS STILL A FALLBACK. `@libsql/client` reaches local files through the native
 * `libsql` module, which ships prebuilt binaries for darwin-arm64, darwin-x64, win32-x64
 * and the common Linux triples — but not win32-arm64. On that platform importing the
 * package throws at load. This is a portability problem, not a policy: the fallback exists
 * so a Windows-on-ARM machine gets a working local cache instead of a stack trace, and it
 * says so out loud rather than quietly pretending to be the real thing.
 *
 * So there are three ways this opens, in preference order:
 *
 *   1. `libsql`        — native client. Local file, optional embedded replica, native
 *                        vector functions. What almost everybody gets.
 *   2. `libsql-remote` — `@libsql/client/web`, pure JavaScript over HTTP. No native module,
 *                        so it works anywhere, but it needs a remote Turso database because
 *                        it cannot open a local file. Native vectors, evaluated remotely.
 *   3. `node-sqlite`   — Node's built-in SQLite. Local file only, no replication and no
 *                        vector functions, so similarity is scored in this process instead.
 *
 * All three read and write the same schema, because libSQL is SQLite's file format and
 * dialect — the same file opens in Turso's client, in the `turso` CLI, and in Node.
 *
 * The interface is async even though `node:sqlite` is entirely synchronous. Shaping a seam
 * around the *less* demanding of the backends is how you end up unable to add the others;
 * libSQL's network calls genuinely are async, so the contract is async and the synchronous
 * driver resolves immediately.
 */

import { mkdir } from 'node:fs/promises';
import { dirname as hostDirname } from 'node:path';
import type { Client, Config } from '@libsql/client';
import { VfsError } from './errors.js';

/** Everything SQLite can store. Booleans are converted on the way in. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array | undefined;

export type SqlRow = Readonly<Record<string, string | number | bigint | null | Uint8Array>>;

export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
}

export type SqlDriverKind = 'libsql' | 'libsql-remote' | 'node-sqlite';

export interface SqlDriver {
  readonly kind: SqlDriverKind;
  /** Human label for `cache status`, e.g. "libSQL embedded replica of libsql://…". */
  readonly description: string;
  /**
   * True when the backend provides libSQL's `vector32`/`vector_distance_cos` functions,
   * so similarity can be computed in the database rather than in this process.
   *
   * Probed at open time rather than inferred from `kind`, because the answer depends on
   * the build that actually loaded and not on which package the module came from.
   * Guessing it would turn "your SQLite is older than you thought" into an unexplained
   * query error halfway through a search.
   */
  readonly nativeVector: boolean;

  /** Run one or more statements with no parameters. */
  exec(sql: string): Promise<void>;
  all(sql: string, params?: readonly SqlValue[]): Promise<readonly SqlRow[]>;
  get(sql: string, params?: readonly SqlValue[]): Promise<SqlRow | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** Run every statement in one transaction, rolling back the lot on failure. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
  /** Pull from / push to the remote replica. Absent unless replicating. */
  sync?(): Promise<void>;
  close(): Promise<void>;
}

export interface SqlDriverOptions {
  /** Local database file. `:memory:` is honoured by the local drivers. */
  readonly path: string;
  /**
   * Remote libSQL/Turso database, e.g. `libsql://mail-org.turso.io`.
   *
   * With the native client this makes the local file an embedded replica: reads stay
   * local and fast, writes go to the remote, and `sync()` reconciles the two. Without it
   * — on a platform with no prebuilt binary — the remote is used directly over HTTP.
   */
  readonly syncUrl?: string;
  readonly authToken?: string;
  /** How often the embedded replica pulls from the remote, in milliseconds. */
  readonly syncIntervalMs?: number;
  /** Pin a driver instead of taking the best one this platform can load. */
  readonly driver?: SqlDriverKind | 'auto';
  /** Injected by tests to stand in for the native client. */
  readonly loadLibsql?: () => Promise<LibsqlModule>;
  /** Injected by tests to stand in for the HTTP-only client. */
  readonly loadLibsqlWeb?: () => Promise<LibsqlModule>;
  readonly onWarning?: (message: string) => void;
}

/** The one export this module needs from either `@libsql/client` entry point. */
export interface LibsqlModule {
  createClient(config: Config): Client;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open the snapshot database with the best backend this platform can load.
 *
 * Throws {@link VfsError} with `ECONFIG` only when nothing at all can be opened. Callers
 * are expected to treat that as "run without a snapshot" rather than as fatal: the tool
 * worked before this store existed and has to keep working when it cannot be built.
 */
export async function openSqlDriver(options: SqlDriverOptions): Promise<SqlDriver> {
  const want = options.driver ?? 'auto';
  const warn = options.onWarning ?? (() => {});
  const failures: string[] = [];

  if (want === 'auto' || want === 'libsql') {
    try {
      return await openLibsql(options);
    } catch (error) {
      failures.push(`libsql: ${describe(error)}`);
      if (want === 'libsql') {
        throw VfsError.config(
          `Could not open the snapshot with @libsql/client: ${describe(error)}`,
          nativeUnavailable(error)
            ? `The native libSQL binary is not published for ${process.platform}-${process.arch}. ` +
                'Set `cache.driver` to "node-sqlite" for a local-only snapshot, or to ' +
                '"libsql-remote" with `cache.syncUrl` to use a Turso database directly.'
            : 'Check `cache.path`, `cache.syncUrl` and `cache.authToken`.',
        );
      }
    }
  }

  // Only worth trying when there is somewhere remote to talk to: this client has no local
  // storage at all, so without a URL it is not a snapshot, it is a network round trip per
  // keystroke — which is the exact thing the snapshot exists to remove.
  const remoteUrl = options.syncUrl;
  if (want === 'libsql-remote' && remoteUrl === undefined) {
    throw VfsError.config(
      'The libsql-remote driver has no local storage, so it needs a database to talk to.',
      'Set `cache.syncUrl` to your Turso database URL, or use the "libsql" or "node-sqlite" driver.',
    );
  }
  if ((want === 'auto' || want === 'libsql-remote') && remoteUrl !== undefined) {
    try {
      const driver = await openLibsqlRemote(options, remoteUrl);
      if (want === 'auto') {
        warn(
          `Using the Turso database at ${remoteUrl} directly: the native libSQL binary is ` +
            `not published for ${process.platform}-${process.arch}, so there is no local ` +
            'embedded replica and reads go over the network.',
        );
      }
      return driver;
    } catch (error) {
      failures.push(`libsql-remote: ${describe(error)}`);
      if (want === 'libsql-remote') {
        throw VfsError.config(
          `Could not reach the Turso database at ${remoteUrl}: ${describe(error)}`,
          'Check `cache.syncUrl` and `cache.authToken`.',
        );
      }
    }
  }

  if (want === 'auto' || want === 'node-sqlite') {
    if (options.syncUrl !== undefined && want === 'auto') {
      warn(
        `Replication to ${options.syncUrl} is unavailable on ${process.platform}-${process.arch}; ` +
          'the snapshot is local-only.',
      );
    }
    try {
      return await openNodeSqlite(options);
    } catch (error) {
      failures.push(`node-sqlite: ${describe(error)}`);
    }
  }

  throw VfsError.config(
    `No SQL driver could be opened for the local snapshot (${failures.join('; ')}).`,
    'node:sqlite needs Node 22.5 or newer. Set `cache.enabled` to false to run without a snapshot.',
  );
}

async function openLibsql(options: SqlDriverOptions): Promise<SqlDriver> {
  // Guarded rather than statically imported: on a platform with no prebuilt binary this
  // throws at module load, and a snapshot that cannot be built must degrade rather than
  // take the whole program down with it.
  const module =
    options.loadLibsql === undefined
      ? ((await import('@libsql/client')) as unknown as LibsqlModule)
      : await options.loadLibsql();

  await ensureParentDirectory(options.path);

  const syncUrl = options.syncUrl;
  const config = {
    url: toFileUrl(options.path),
    ...(syncUrl === undefined ? {} : { syncUrl }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    ...(options.syncIntervalMs === undefined
      ? {}
      : // libSQL counts this in seconds; the rest of this codebase counts milliseconds,
        // and silently reinterpreting 30_000 as eight hours would be a memorable bug.
        { syncInterval: Math.max(1, Math.round(options.syncIntervalMs / 1000)) }),
  } as Config;

  const client = module.createClient(config);

  // Pull once before anybody reads. Otherwise the first session against an existing
  // remote database looks like a cold cache and re-fetches everything it already has.
  if (syncUrl !== undefined) await client.sync();

  return await fromLibsqlClient(client, {
    kind: 'libsql',
    description:
      syncUrl === undefined
        ? `libSQL at ${options.path}`
        : `libSQL embedded replica of ${syncUrl} at ${options.path}`,
    canSync: syncUrl !== undefined,
  });
}

async function openLibsqlRemote(options: SqlDriverOptions, url: string): Promise<SqlDriver> {
  const module =
    options.loadLibsqlWeb === undefined
      ? ((await import('@libsql/client/web')) as unknown as LibsqlModule)
      : await options.loadLibsqlWeb();

  const client = module.createClient({
    url,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  } as Config);

  return await fromLibsqlClient(client, {
    kind: 'libsql-remote',
    description: `Turso at ${url} (no local replica)`,
    canSync: false,
  });
}

/** Both libSQL entry points expose the same `Client`, so they share one adapter. */
async function fromLibsqlClient(
  client: Client,
  meta: { kind: SqlDriverKind; description: string; canSync: boolean },
): Promise<SqlDriver> {
  const all = async (sql: string, params: readonly SqlValue[] = []): Promise<readonly SqlRow[]> => {
    const result = await client.execute({ sql, args: params.map(normalize) });
    return result.rows.map(toRow);
  };

  const driver: SqlDriver = {
    kind: meta.kind,
    description: meta.description,
    nativeVector: false, // replaced below, once probed
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    all,
    async get(sql, params) {
      const rows = await all(sql, params);
      return rows[0];
    },
    async run(sql, params = []) {
      const result = await client.execute({ sql, args: params.map(normalize) });
      return { changes: result.rowsAffected };
    },
    async batch(statements) {
      if (statements.length === 0) return;
      await client.batch(
        statements.map((statement) => ({ sql: statement.sql, args: (statement.params ?? []).map(normalize) })),
        'write',
      );
    },
    ...(meta.canSync
      ? {
          sync: async () => {
            await client.sync();
          },
        }
      : {}),
    async close() {
      client.close();
    },
  };

  return { ...driver, nativeVector: await probeNativeVector(driver) };
}

// ---------------------------------------------------------------------------
// Built-in SQLite
// ---------------------------------------------------------------------------

interface NodeSqliteStatement {
  all(...params: readonly SqlValue[]): unknown[];
  get(...params: readonly SqlValue[]): unknown;
  run(...params: readonly SqlValue[]): { changes: number | bigint };
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

// Held in a variable rather than written as a literal so this module still loads on Node
// 20.11, the floor in package.json, where `node:sqlite` does not exist yet.
const NODE_SQLITE_SPECIFIER = 'node:sqlite';

async function openNodeSqlite(options: SqlDriverOptions): Promise<SqlDriver> {
  const loaded = (await import(/* @vite-ignore */ NODE_SQLITE_SPECIFIER)) as {
    DatabaseSync?: new (path: string, opts?: Record<string, unknown>) => NodeSqliteDatabase;
  };
  if (loaded.DatabaseSync === undefined) throw new Error('node:sqlite has no DatabaseSync export');

  await ensureParentDirectory(options.path);
  const db = new loaded.DatabaseSync(options.path);

  // WAL lets the background preloader write while a foreground `ls` reads, which is the
  // entire access pattern here. `:memory:` has no journal to switch, hence the guard.
  if (options.path !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    } catch {
      // A filesystem that cannot do WAL (some network shares) still works, just slower.
    }
  }

  // Statements are re-run constantly — one per node per page — so re-preparing each time
  // is a measurable share of the store's cost.
  const prepared = new Map<string, NodeSqliteStatement>();
  const prepare = (sql: string): NodeSqliteStatement => {
    let statement = prepared.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      prepared.set(sql, statement);
    }
    return statement;
  };

  const driver: SqlDriver = {
    kind: 'node-sqlite',
    description: `node:sqlite at ${options.path} (local only, no vector functions)`,
    nativeVector: false,
    async exec(sql) {
      db.exec(sql);
    },
    async all(sql, params = []) {
      return prepare(sql)
        .all(...params.map(normalize))
        .map(toRow);
    },
    async get(sql, params = []) {
      const row = prepare(sql).get(...params.map(normalize));
      return row === undefined || row === null ? undefined : toRow(row);
    },
    async run(sql, params = []) {
      const result = prepare(sql).run(...params.map(normalize));
      return { changes: Number(result.changes) };
    },
    async batch(statements) {
      if (statements.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const statement of statements) {
          prepare(statement.sql).run(...(statement.params ?? []).map(normalize));
        }
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original error is the interesting one.
        }
        throw error;
      }
    },
    async close() {
      prepared.clear();
      db.close();
    },
  };

  return { ...driver, nativeVector: await probeNativeVector(driver) };
}

/**
 * Ask the database whether it can do vector maths, rather than assuming from the driver.
 *
 * libSQL ships `vector32`/`vector_distance_cos`; stock SQLite does not. Both answers are
 * fine — {@link ./vector.js} scores in this process when they are missing — but the store
 * has to know which one it is holding before writing a query that would otherwise fail.
 */
async function probeNativeVector(driver: SqlDriver): Promise<boolean> {
  try {
    const row = await driver.get("SELECT vector_distance_cos(vector32('[1,0]'), vector32('[1,0]')) AS d");
    return row !== undefined;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Value marshalling
// ---------------------------------------------------------------------------

/**
 * `node:sqlite` rejects a JavaScript boolean outright, and `undefined` means "parameter
 * not supplied" rather than NULL. Normalising here rather than at every call site is what
 * stops a single forgotten `? 1 : 0` from becoming a runtime type error deep inside a
 * background sync, where nobody is watching.
 *
 * The return type is the intersection both backends accept, not libSQL's wider `InValue`:
 * libSQL also takes `Date` and `ArrayBuffer`, and letting those through here would compile
 * cleanly and then fail at runtime on the built-in driver.
 */
function normalize(value: SqlValue): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function toRow(raw: unknown): SqlRow {
  if (raw === null || typeof raw !== 'object') return {};
  // libSQL rows are array-like *and* keyed; node:sqlite returns null-prototype objects.
  // Walking the string keys normalises both and drops the numeric aliases.
  const source = raw as Record<string, unknown>;
  const row: Record<string, string | number | bigint | null | Uint8Array> = {};
  for (const key of Object.keys(source)) {
    if (/^\d+$/.test(key)) continue;
    const value = source[key];
    if (value === undefined || value === null) row[key] = null;
    else if (
      value instanceof Uint8Array ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint'
    ) {
      row[key] = value;
    } else if (ArrayBuffer.isView(value)) {
      row[key] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (value instanceof ArrayBuffer) {
      row[key] = new Uint8Array(value);
    } else {
      row[key] = String(value);
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function ensureParentDirectory(path: string): Promise<void> {
  if (path === ':memory:' || path === '') return;
  await mkdir(hostDirname(path), { recursive: true }).catch(() => undefined);
}

function toFileUrl(path: string): string {
  if (path === ':memory:') return ':memory:';
  if (/^[a-z]+:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return path;
  // libSQL wants a URL; Windows drive letters need the extra slash and forward slashes.
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/** True when the failure is "this platform has no binary" rather than a real fault. */
function nativeUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (nativeUnavailable(error)) return `no native binary for ${process.platform}-${process.arch}`;
    return error.message;
  }
  return String(error);
}
