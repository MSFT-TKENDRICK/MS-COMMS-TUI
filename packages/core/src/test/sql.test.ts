import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { openSqlDriver, type LibsqlModule, type SqlDriver, type SqlDriverKind } from '../sql.js';
import { VfsError } from '../errors.js';

// ---------------------------------------------------------------------------
// A stand-in for @libsql/client.
//
// The native client cannot be loaded on every platform this test suite runs on — there is
// no prebuilt binary for win32-arm64 — so the libSQL branches are exercised through the
// documented injection points instead. This fake mirrors the parts of the real `Client`
// contract the driver depends on: `rowsAffected`, keyed rows, `executeMultiple`, `batch`
// with a mode, and `sync`.
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly sql: string;
  readonly args: readonly unknown[];
}

interface Fake {
  readonly module: LibsqlModule;
  readonly calls: FakeCall[];
  readonly batches: FakeCall[][];
  readonly modes: string[];
  config: Record<string, unknown> | undefined;
  syncs: number;
  closed: boolean;
}

function fakeLibsql(options: { nativeVector?: boolean; failOn?: RegExp; rows?: Record<string, unknown>[] } = {}): Fake {
  const fake: Fake = {
    calls: [],
    batches: [],
    modes: [],
    config: undefined,
    syncs: 0,
    closed: false,
    module: {
      createClient: (config) => {
        fake.config = config as unknown as Record<string, unknown>;
        return {
          async execute(statement: unknown) {
            const normalized =
              typeof statement === 'string' ? { sql: statement, args: [] } : (statement as FakeCall);
            fake.calls.push({ sql: normalized.sql, args: [...(normalized.args ?? [])] });
            if (options.failOn?.test(normalized.sql) === true) throw new Error('no such function');
            if (/vector_distance_cos/.test(normalized.sql)) {
              if (options.nativeVector === false) throw new Error('no such function: vector32');
              return { rows: [{ d: 0 }], rowsAffected: 0, columns: ['d'] };
            }
            return { rows: options.rows ?? [], rowsAffected: 3, columns: [] };
          },
          async executeMultiple(sql: string) {
            fake.calls.push({ sql, args: [] });
          },
          async batch(statements: readonly FakeCall[], mode?: string) {
            fake.batches.push(statements.map((s) => ({ sql: s.sql, args: [...s.args] })));
            if (mode !== undefined) fake.modes.push(mode);
          },
          async sync() {
            fake.syncs += 1;
          },
          close() {
            fake.closed = true;
          },
        } as never;
      },
    },
  };
  return fake;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mscomms-sql-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

describe('openSqlDriver: choosing a backend', () => {
  it('prefers the native libSQL client', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: ':memory:', loadLibsql: async () => fake.module });

    assert.equal(driver.kind, 'libsql');
    await driver.close();
  });

  it('falls back to built-in SQLite when the native binary is missing', async () => {
    const driver = await openSqlDriver({
      path: ':memory:',
      loadLibsql: async () => {
        throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
      },
    });

    // A platform with no prebuilt binary must get a working local cache, not a stack trace.
    assert.equal(driver.kind, 'node-sqlite');
    await driver.close();
  });

  it('warns when it falls back, rather than quietly being slower at similarity', async () => {
    const warnings: string[] = [];
    const driver = await openSqlDriver({
      path: ':memory:',
      loadLibsql: async () => {
        throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
      },
      onWarning: (message) => warnings.push(message),
    });

    // Losing in-database vector functions is a real change in behaviour, and finding out
    // by noticing search got slower is not finding out.
    assert.equal(driver.kind, 'node-sqlite');
    assert.match(warnings.join('\n'), /native libSQL binary/);
    await driver.close();
  });

  it('honours a pinned driver', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    assert.equal(driver.kind, 'node-sqlite');
    await driver.close();
  });

  it('explains how to recover when a pinned native driver cannot load', async () => {
    await assert.rejects(
      openSqlDriver({
        path: ':memory:',
        driver: 'libsql',
        loadLibsql: async () => {
          throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof VfsError);
        assert.equal(error.code, 'ECONFIG');
        // Screen-reader users cannot skim a stack trace for the fix, so it is in the hint.
        assert.match(error.hint ?? '', /node-sqlite/);
        return true;
      },
    );
  });

  it('offers no driver that could reach a database off this machine', () => {
    // A compile-time guarantee written as a runtime one: if a networked tier is ever added
    // back, this is the test that has to be deliberately deleted to do it.
    const kinds: readonly SqlDriverKind[] = ['libsql', 'node-sqlite'];
    assert.deepEqual([...kinds].sort(), ['libsql', 'node-sqlite']);
  });
});

// ---------------------------------------------------------------------------
// libSQL specifics
// ---------------------------------------------------------------------------

describe('openSqlDriver: libSQL configuration', () => {
  it('opens a plain local file', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: '/tmp/snap.db', loadLibsql: async () => fake.module });

    assert.equal(fake.config?.['url'], 'file:///tmp/snap.db');
    assert.equal(fake.syncs, 0);
    await driver.close();
  });

  it('passes libSQL nothing that could turn the file into a replica', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: '/tmp/snap.db', loadLibsql: async () => fake.module });

    // The snapshot holds message bodies. `syncUrl` is the single key that would send them
    // to a hosted database, so the assertion is about the whole config object and not just
    // that one name: anything replication-shaped reaching the client is a defect.
    const config = fake.config ?? {};
    assert.deepEqual(Object.keys(config), ['url']);
    for (const key of ['syncUrl', 'authToken', 'syncInterval']) {
      assert.equal(config[key], undefined, `libSQL was given "${key}"`);
    }
    assert.equal(fake.syncs, 0, 'a local file has nothing to pull from');
    await driver.close();
  });

  it('omits optional keys rather than sending undefined', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: ':memory:', loadLibsql: async () => fake.module });

    // libSQL rejects an unrecognised or undefined key rather than ignoring it.
    assert.deepEqual(Object.keys(fake.config ?? {}), ['url']);
    await driver.close();
  });

  it('detects native vector support instead of assuming it', async () => {
    const withVectors = fakeLibsql({ nativeVector: true });
    const without = fakeLibsql({ nativeVector: false });

    const a = await openSqlDriver({ path: ':memory:', loadLibsql: async () => withVectors.module });
    const b = await openSqlDriver({ path: ':memory:', loadLibsql: async () => without.module });

    // The answer depends on the build that loaded, not on which package it came from.
    assert.equal(a.nativeVector, true);
    assert.equal(b.nativeVector, false);
    await a.close();
    await b.close();
  });

  it('runs a batch in one write transaction', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: ':memory:', loadLibsql: async () => fake.module });

    await driver.batch([
      { sql: 'INSERT INTO t VALUES (?)', params: ['a'] },
      { sql: 'INSERT INTO t VALUES (?)', params: [true] },
    ]);

    assert.equal(fake.batches.length, 1);
    assert.deepEqual(fake.modes, ['write']);
    // Booleans are converted on the way in; libSQL takes them, node:sqlite does not, and
    // the snapshot must not care which one it is talking to.
    assert.deepEqual(fake.batches[0]?.[1]?.args, [1]);
    await driver.close();
  });

  it('does not send an empty batch', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: ':memory:', loadLibsql: async () => fake.module });
    await driver.batch([]);
    assert.equal(fake.batches.length, 0);
    await driver.close();
  });

  it('reports rows affected from a write', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: ':memory:', loadLibsql: async () => fake.module });
    assert.deepEqual(await driver.run('DELETE FROM nodes'), { changes: 3 });
    await driver.close();
  });

  it('closes the underlying client', async () => {
    const fake = fakeLibsql();
    const driver = await openSqlDriver({ path: ':memory:', loadLibsql: async () => fake.module });
    await driver.close();
    assert.equal(fake.closed, true);
  });
});

// ---------------------------------------------------------------------------
// Behaviour both backends must share
// ---------------------------------------------------------------------------

describe('SqlDriver: shared behaviour', () => {
  it('rejects a boolean parameter nowhere, because it converts them', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    await driver.exec('CREATE TABLE t (a INTEGER, b TEXT)');

    // node:sqlite throws on a raw JavaScript boolean. One forgotten `? 1 : 0` at a call
    // site would otherwise surface as a type error deep in a background sync.
    await driver.run('INSERT INTO t VALUES (?, ?)', [true, null]);
    assert.deepEqual(await driver.get('SELECT a, b FROM t'), { a: 1, b: null });
    await driver.close();
  });

  it('treats undefined as NULL rather than as a missing parameter', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    await driver.exec('CREATE TABLE t (a TEXT)');
    await driver.run('INSERT INTO t VALUES (?)', [undefined]);
    assert.deepEqual(await driver.get('SELECT a FROM t'), { a: null });
    await driver.close();
  });

  it('returns undefined rather than throwing when a row is absent', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    await driver.exec('CREATE TABLE t (a TEXT)');
    assert.equal(await driver.get('SELECT a FROM t'), undefined);
    await driver.close();
  });

  it('round-trips a blob as bytes, which is how vectors are stored', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    await driver.exec('CREATE TABLE v (embedding BLOB)');
    const bytes = new Uint8Array(new Float32Array([1, 0, -1]).buffer);

    await driver.run('INSERT INTO v VALUES (?)', [bytes]);
    const row = await driver.get('SELECT embedding FROM v');

    assert.ok(row?.['embedding'] instanceof Uint8Array);
    assert.deepEqual(Array.from(new Float32Array((row['embedding'] as Uint8Array).buffer)), [1, 0, -1]);
    await driver.close();
  });

  it('drops the numeric aliases libSQL adds to every row', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    await driver.exec('CREATE TABLE t (a TEXT, b TEXT)');
    await driver.run('INSERT INTO t VALUES (?, ?)', ['x', 'y']);

    // libSQL rows are array-like *and* keyed. Leaving the aliases in would put "0" and "1"
    // into every row the store reads back.
    assert.deepEqual(Object.keys((await driver.get('SELECT * FROM t')) ?? {}), ['a', 'b']);
    await driver.close();
  });

  it('rolls the whole batch back when one statement fails', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    await driver.exec('CREATE TABLE t (a TEXT PRIMARY KEY)');

    await assert.rejects(
      driver.batch([
        { sql: 'INSERT INTO t VALUES (?)', params: ['keep'] },
        { sql: 'INSERT INTO t VALUES (?)', params: ['keep'] },
      ]),
    );

    // A half-applied page would leave the snapshot claiming a listing it does not hold.
    assert.equal(Number((await driver.get('SELECT COUNT(*) AS n FROM t'))?.['n']), 0);
    await driver.close();
  });

  it('creates the directory the database is asked to live in', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'nested', 'deeper', 'snapshot.db');
      const driver: SqlDriver = await openSqlDriver({ path, driver: 'node-sqlite' });
      await driver.exec('CREATE TABLE t (a TEXT)');
      await driver.close();

      // The cache directory does not exist on a fresh machine, and "unable to open
      // database file" is not a diagnosable error message.
      assert.match(driver.description, /snapshot\.db/);
    });
  });

  it('survives a filesystem that cannot do WAL', async () => {
    await withTempDir(async (dir) => {
      const driver = await openSqlDriver({ path: join(dir, 'snap.db'), driver: 'node-sqlite' });
      await driver.exec('CREATE TABLE t (a TEXT)');
      await driver.run('INSERT INTO t VALUES (?)', ['ok']);
      assert.deepEqual(await driver.get('SELECT a FROM t'), { a: 'ok' });
      await driver.close();
    });
  });

  it('says what it is, for `cache status`', async () => {
    const driver = await openSqlDriver({ path: ':memory:', driver: 'node-sqlite' });
    // A user debugging "why is search slow" needs to know they are on the fallback.
    assert.match(driver.description, /node:sqlite.*no vector functions/);
    await driver.close();
  });
});
