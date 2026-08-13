/**
 * Shutdown has to survive an empty event loop.
 *
 * Everything long-lived in this process is deliberately unref'd — the sync interval, the
 * MCP child and its pipes — so that a one-shot command can print its answer and exit
 * without being held open by machinery it never used. That is the right default, and it
 * makes one particular mistake unusually dangerous: an unref'd timer on the path that
 * *completes* shutdown.
 *
 * `stop()` races the in-flight cycle against a grace timer. When the cycle is stuck — the
 * case the grace timer exists for — that timer is the only thing that can settle the race,
 * and a stuck cycle is a pending promise, which keeps nothing alive. Unref that timer and
 * Node finds an empty loop and exits *while `stop()` is still pending*, abandoning the rest
 * of `dispose()`: the snapshot is never flushed and the database is closed by process
 * teardown rather than by us.
 *
 * That cannot be observed from inside the process it happens to, because the failure is the
 * process ending. So this runs a real child and reads how far it got.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dist = pathToFileURL(join(import.meta.dirname, '..')).href;

const CHILD = `
import { openSqlDriver } from '${dist}/sql.js';
import { SnapshotStore } from '${dist}/snapshot.js';
import { BackgroundSync } from '${dist}/sync.js';

const driver = await openSqlDriver({ path: ':memory:' });
const snapshot = await SnapshotStore.open({ driver });

let markStarted;
const started = new Promise((resolve) => { markStarted = resolve; });

// Hangs forever, holding no handle of its own — so once the main line is parked inside
// stop(), the grace timer is the only referenced thing left in the process.
const provider = {
  id: 'held',
  displayName: 'Held',
  capabilities: new Set(['list']),
  async list() {
    markStarted();
    await new Promise(() => {});
    return { entries: [] };
  },
};

const host = {
  mounts: [{ id: 'mail', path: '/mail', provider }],
  async resolve(path) {
    return { node: { id: path, name: 'mail', kind: 'dir', title: 'mail', path } };
  },
  canonicalize(path, entries) {
    return entries.map((entry) => ({ ...entry, path: path + '/' + entry.name }));
  },
};

const sync = new BackgroundSync({ host, snapshot });
sync.start();
await started;

console.log('MARK:calling-stop');
await sync.stop();
console.log('MARK:stopped');
await snapshot.close();
console.log('MARK:closed');
`;

describe('BackgroundSync: shutdown survives an idle event loop', () => {
  it('finishes stop() even when nothing else keeps the process alive', { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mscomms-exit-'));
    const script = join(dir, 'child.mjs');
    try {
      await writeFile(script, CHILD, 'utf8');
      const { stdout } = await run(process.execPath, [script], { timeout: 20_000 });

      // The first marker proves the child really did reach a stuck stop(); without it a
      // silent early failure would look identical to success on the assertions below.
      assert.match(stdout, /MARK:calling-stop/, 'the child never reached stop()');
      assert.match(stdout, /MARK:stopped/, 'the process exited while stop() was still pending');
      assert.match(stdout, /MARK:closed/, 'the database was never closed by us');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
