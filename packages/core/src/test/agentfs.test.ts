/**
 * AgentFS, running for real.
 *
 * Every test here drives the genuine `agentfs-sdk` — no fakes, no stubs, no reimplemented
 * schema. That is the point of the exercise: this platform has no `@tursodatabase/database`
 * build, and the claim being tested is that the gap is the *driver* and not the filesystem.
 * A test that substituted its own filesystem would prove nothing about that claim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { agentFsDatabase, loadAgentFs, type AgentFsLike } from '../agentfs.js';
import { exportToAgentFs } from '../agentfs-export.js';
import { SnapshotStore } from '../snapshot.js';
import { openSqlDriver, type SqlDriver } from '../sql.js';
import type { Capability, Document, ListPage, Provider, VNode } from '../provider.js';
import { Vfs } from '../vfs.js';

async function newDriver(): Promise<SqlDriver> {
  return openSqlDriver({ path: ':memory:' });
}

async function newFs(): Promise<{ fs: AgentFsLike; driver: SqlDriver }> {
  const driver = await newDriver();
  const { AgentFS } = await loadAgentFs();
  return { fs: await AgentFS.fromDatabase(agentFsDatabase(driver)), driver };
}

const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

// ---------------------------------------------------------------------------

describe('loading the SDK on a platform it does not ship a binding for', () => {
  it('loads, and says how', async () => {
    const mod = await loadAgentFs();
    assert.ok(mod.via === 'package' || mod.via === 'submodule');
    assert.equal(typeof mod.AgentFS.fromDatabase, 'function');
    assert.equal(typeof mod.ToolCalls.fromDatabase, 'function');
    assert.equal(typeof mod.KvStore.fromDatabase, 'function');
  });

  it('is the real implementation, which we can tell because it stamps its own schema version', async () => {
    const { driver } = await newFs();
    // Written by the SDK's `ensureRoot`, not by us. If this is ever absent, something in
    // this file has quietly started testing itself instead of AgentFS.
    const row = await driver.get("SELECT value FROM fs_config WHERE key = 'schema_version'");
    assert.equal(row?.['value'], '0.4');
    const root = await driver.get('SELECT ino, mode FROM fs_inode WHERE ino = 1');
    assert.equal(Number(root?.['ino']), 1);
    await driver.close();
  });

  it('caches the resolution so a cold import happens once', async () => {
    const a = await loadAgentFs();
    const b = await loadAgentFs();
    assert.equal(a, b);
  });
});

describe('the driver adapter', () => {
  it('round-trips a file through the real filesystem', async () => {
    const { fs, driver } = await newFs();
    await fs.writeFile('/mail/Inbox/hello.eml', 'From: Ada\r\n\r\nbody');
    assert.deepEqual([...(await fs.readdir('/mail'))], ['Inbox']);
    assert.equal(utf8(await fs.readFile('/mail/Inbox/hello.eml')), 'From: Ada\r\n\r\nbody');

    const stat = await fs.stat('/mail/Inbox/hello.eml');
    assert.ok(stat.isFile());
    assert.equal(stat.size, 17);
    await driver.close();
  });

  it('handles a file larger than one chunk, so chunking is genuinely exercised', async () => {
    const { fs, driver } = await newFs();
    // Chunk boundaries are where a naive adapter breaks: one chunk hides every off-by-one
    // in offset maths, and a mail body of 10 KB is not unusual.
    const body = 'x'.repeat(fs.getChunkSize() * 2 + 7);
    await fs.writeFile('/big.txt', body);
    assert.equal(utf8(await fs.readFile('/big.txt')), body);
    assert.equal((await fs.stat('/big.txt')).size, body.length);

    const chunks = await driver.all('SELECT chunk_index FROM fs_data WHERE ino = (SELECT ino FROM fs_dentry WHERE name = ?)', ['big.txt']);
    assert.equal(chunks.length, 3);
    await driver.close();
  });

  it('preserves bytes that are not text', async () => {
    const { fs, driver } = await newFs();
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 0, 255]);
    await fs.writeFile('/raw.bin', bytes);
    assert.deepEqual([...(await fs.readFile('/raw.bin'))], [...bytes]);
    await driver.close();
  });

  it('surfaces the SDK errors rather than swallowing them', async () => {
    const { fs, driver } = await newFs();
    await assert.rejects(() => fs.readFile('/nope.eml'), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
    await driver.close();
  });
});

describe('the tool-call audit trail and key-value store', () => {
  it('records calls that can be queried back', async () => {
    const driver = await newDriver();
    const { ToolCalls } = await loadAgentFs();
    const calls = await ToolCalls.fromDatabase(agentFsDatabase(driver));

    await calls.record('provider.list', 1_700_000_000, 1_700_000_001, { path: '/mail' }, { entries: 42 });
    await calls.record('provider.read', 1_700_000_002, 1_700_000_003, { path: '/mail/a' }, undefined, 'ENOTFOUND');

    const recent = await calls.getRecent(0, 10);
    assert.equal(recent.length, 2);
    const stats = await calls.getStats();
    assert.equal(stats.length, 2);
    await driver.close();
  });

  it('stores structured values', async () => {
    const driver = await newDriver();
    const { KvStore } = await loadAgentFs();
    const kv = await KvStore.fromDatabase(agentFsDatabase(driver));
    await kv.set('mscomms:test', { recent: 200, nested: { ok: true } });
    assert.deepEqual(await kv.get('mscomms:test'), { recent: 200, nested: { ok: true } });
    await driver.close();
  });
});

// ---------------------------------------------------------------------------
// Exporting the cache
// ---------------------------------------------------------------------------

/** Names chosen to break a filesystem: a slash, a reserved device, an RTL spoof, a clash. */
const hostile: ReadonlyArray<{ id: string; title: string; body?: string }> = [
  { id: 'plain', title: 'Weekly notes', body: 'the body of the weekly notes' },
  { id: 'slash', title: 'Q3/Q4 planning: infra/tooling split' },
  { id: 'con', title: 'CON' },
  { id: 'rtl', title: 'Invoice \u202Efdp.exe' },
  { id: 'dup-a', title: 'FY26 budget review', body: 'from Tom' },
  { id: 'dup-b', title: 'FY26 budget review', body: 'from Priya' },
];

function hostileProvider(): Provider {
  return {
    id: 'mail',
    displayName: 'Mail',
    capabilities: new Set<Capability>(['list', 'read']),
    async list(): Promise<ListPage> {
      return {
        entries: hostile.map((item, index) => ({
          id: item.id,
          name: item.title,
          kind: 'file' as const,
          title: item.title,
          author: `Sender ${String(index)}`,
          mtime: new Date(1_700_000_000_000 + index * 1_000),
        })),
      };
    },
    async read(node: VNode): Promise<Document> {
      const item = hostile.find((candidate) => candidate.id === node.id);
      if (item?.body === undefined) throw new Error('no body');
      return { title: node.title, headers: [['From', 'a@b.c']], body: item.body, format: 'text' };
    },
  };
}

/** Populate a snapshot through the engine, so the names are the engine's own. */
async function populated(): Promise<SnapshotStore> {
  const snapshot = await SnapshotStore.open({ driver: await newDriver() });
  const vfs = new Vfs({ snapshot });
  vfs.mount({ id: 'mail', path: '/mail', provider: hostileProvider() });
  const page = await vfs.list('/mail');
  for (const entry of page.entries) {
    if (entry.path !== undefined) await vfs.read(entry.path).catch(() => undefined);
  }
  await vfs.flush();
  return snapshot;
}

describe('exporting the snapshot as a mountable filesystem', () => {
  it('writes every cached item, and the names still resolve', async () => {
    const snapshot = await populated();
    const target = await newDriver();
    const result = await exportToAgentFs({ driver: target, snapshot });

    assert.equal(result.files, hostile.length);
    assert.deepEqual(result.skipped, []);

    const { AgentFS } = await loadAgentFs();
    const fs = await AgentFS.fromDatabase(agentFsDatabase(target));
    const names = await fs.readdir('/mail');
    assert.equal(names.length, hostile.length);

    // The engine's sanitised names are what got written: a slash in a subject would
    // otherwise become a directory, and AgentFS would have built the wrong tree.
    for (const name of names) {
      assert.ok(!name.includes('/'), `${name} would have become a directory`);
      assert.ok(!name.includes('\u202E'), `${name} still carries a right-to-left override`);
      const stat = await fs.stat(`/mail/${name}`);
      assert.ok(stat.isFile());
    }
    await target.close();
    await snapshot.close();
  });

  it('keeps both messages when two subjects collide', async () => {
    const snapshot = await populated();
    const target = await newDriver();
    await exportToAgentFs({ driver: target, snapshot });

    const { AgentFS } = await loadAgentFs();
    const fs = await AgentFS.fromDatabase(agentFsDatabase(target));
    const names = await fs.readdir('/mail');

    // `UNIQUE(parent_ino, name)` means a collision does not error here, it *overwrites* —
    // one message would simply cease to exist. This is the same failure the snapshot had
    // before names went through the allocator, and it is silent, so it gets its own test.
    const budget = names.filter((name) => name.includes('FY26 budget review'));
    assert.equal(budget.length, 2, `expected both budget messages, got ${JSON.stringify(budget)}`);

    const bodies = await Promise.all(
      budget.map(async (name) => utf8(await fs.readFile(`/mail/${name}`))),
    );
    assert.ok(bodies.some((body) => body.includes('from Tom')));
    assert.ok(bodies.some((body) => body.includes('from Priya')));
    await target.close();
    await snapshot.close();
  });

  it('exports a header-only stub when no body was cached', async () => {
    const snapshot = await populated();
    const target = await newDriver();
    const result = await exportToAgentFs({ driver: target, snapshot });

    // Derived from the fixture rather than written as a number, so adding a fixture with
    // a body cannot quietly turn this into an assertion about nothing.
    const withoutBody = hostile.filter((item) => item.body === undefined).length;
    assert.equal(result.stubs, withoutBody);

    const { AgentFS } = await loadAgentFs();
    const fs = await AgentFS.fromDatabase(agentFsDatabase(target));
    const names = await fs.readdir('/mail');
    const conName = names.find((name) => name.includes('CON'));
    assert.ok(conName !== undefined);
    const text = utf8(await fs.readFile(`/mail/${conName}`));
    assert.match(text, /^Subject: CON\r\n/);
    assert.match(text, /\r\n\r\n$/, 'a stub should still have the header/body separator');
    await target.close();
    await snapshot.close();
  });

  it('renders headers a mail tool would recognise', async () => {
    const snapshot = await populated();
    const target = await newDriver();
    await exportToAgentFs({ driver: target, snapshot });

    const { AgentFS } = await loadAgentFs();
    const fs = await AgentFS.fromDatabase(agentFsDatabase(target));
    const names = await fs.readdir('/mail');
    const notes = names.find((name) => name.includes('Weekly notes'));
    assert.ok(notes !== undefined);
    const text = utf8(await fs.readFile(`/mail/${notes}`));

    const [head, body] = text.split('\r\n\r\n');
    assert.equal(body, 'the body of the weekly notes');
    assert.match(head ?? '', /Subject: Weekly notes/);
    assert.match(head ?? '', /From: /);
    assert.match(head ?? '', /Date: /);
    await target.close();
    await snapshot.close();
  });

  it('never lets a newline in a subject forge a header', async () => {
    const snapshot = await SnapshotStore.open({ driver: await newDriver() });
    const vfs = new Vfs({ snapshot });
    vfs.mount({
      id: 'mail',
      path: '/mail',
      provider: {
        id: 'mail',
        displayName: 'Mail',
        capabilities: new Set<Capability>(['list']),
        async list(): Promise<ListPage> {
          return {
            entries: [
              {
                id: 'inject',
                // If this reached the output unfolded, a reader would see a message that
                // claims to be from someone it is not. Header injection is the oldest
                // trick in mail, and an export is exactly where it would land.
                name: 'Hello\r\nFrom: ceo@example.com',
                kind: 'file',
                title: 'Hello\r\nFrom: ceo@example.com',
              },
            ],
          };
        },
      },
    });
    await vfs.list('/mail');
    await vfs.flush();

    const target = await newDriver();
    await exportToAgentFs({ driver: target, snapshot });
    const { AgentFS } = await loadAgentFs();
    const fs = await AgentFS.fromDatabase(agentFsDatabase(target));
    const names = await fs.readdir('/mail');
    const text = utf8(await fs.readFile(`/mail/${String(names[0])}`));
    const [head] = text.split('\r\n\r\n');
    assert.ok(!/^From: ceo@example\.com/m.test(head ?? ''), 'a subject forged a From header');
    await target.close();
    await snapshot.close();
  });

  it('records a manifest saying the export is partial', async () => {
    const snapshot = await populated();
    const target = await newDriver();
    await exportToAgentFs({ driver: target, snapshot });

    const { KvStore } = await loadAgentFs();
    const kv = await KvStore.fromDatabase(agentFsDatabase(target));
    const manifest = await kv.get<{ files: number; completeness: string }>('mscomms:export');
    assert.equal(manifest?.files, hostile.length);
    assert.match(manifest?.completeness ?? '', /not a backup/i);
    await target.close();
    await snapshot.close();
  });

  it('exports an empty snapshot to an empty filesystem rather than failing', async () => {
    const snapshot = await SnapshotStore.open({ driver: await newDriver() });
    const target = await newDriver();
    const result = await exportToAgentFs({ driver: target, snapshot });
    assert.equal(result.files, 0);
    assert.equal(result.directories, 0);
    await target.close();
    await snapshot.close();
  });

  it('is idempotent, so re-exporting over yesterday\u2019s file is safe', async () => {
    const snapshot = await populated();
    const target = await newDriver();
    const first = await exportToAgentFs({ driver: target, snapshot });
    const second = await exportToAgentFs({ driver: target, snapshot });

    assert.deepEqual(second.skipped, []);
    assert.equal(second.files, first.files);
    const { AgentFS } = await loadAgentFs();
    const fs = await AgentFS.fromDatabase(agentFsDatabase(target));
    assert.equal((await fs.readdir('/mail')).length, hostile.length);
    await target.close();
    await snapshot.close();
  });
});
