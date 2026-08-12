/**
 * `--demo` as a startup flag.
 *
 * The `demo` command has existed since early on, and for the line shell it is enough: the
 * banner says "type `demo`", and there is a prompt right there to type it at. The
 * full-screen view has no such prompt until it has already drawn itself, so on a machine
 * with no config file it opens onto "(empty)" — which a first-time user reads as a broken
 * build rather than an unconfigured one. The desktop app's Run button hits exactly that
 * path, so the mounts have to exist *before* an interface starts.
 *
 * These tests drive `main` rather than `parseGlobals`, because parsing the flag correctly
 * and acting on it are different failures and only the second one is visible to a user.
 * The config and data directories are redirected at a temporary path so a developer's real
 * mounts and sync state are neither read nor written.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../index.js';

describe('--demo', () => {
  const OVERRIDES = ['MSCOMMS_CONFIG_DIR', 'MSCOMMS_DATA_DIR'] as const;
  const saved = new Map<string, string | undefined>();
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mscomms-demo-'));
    for (const key of OVERRIDES) {
      saved.set(key, process.env[key]);
      process.env[key] = join(dir, key);
    }
  });

  after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function run(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await main({
      argv,
      write: (text) => {
        out += text;
      },
      writeError: (text) => {
        err += text;
      },
    });
    return { code, out, err };
  }

  it('mounts the sample data before the first command runs', async () => {
    const { code, out } = await run(['--no-config', '--demo', 'ls', '/demo-mail']);
    assert.equal(code, 0);
    assert.match(out, /Inbox/);
  });

  it('mounts all four sources, not just the mailbox', async () => {
    const { code, out } = await run(['--no-config', '--demo', 'ls', '/']);
    assert.equal(code, 0);
    for (const mount of ['demo-mail', 'demo-chat', 'demo-issues', 'demo-people']) {
      assert.match(out, new RegExp(mount), `${mount} should be mounted`);
    }
  });

  it('reaches real records, not just an empty mount point', async () => {
    // A mount that resolves but lists nothing would still show an empty pane, which is the
    // failure this flag exists to prevent.
    const { code, out } = await run(['--no-config', '--demo', 'ls', '/demo-mail/Inbox']);
    assert.equal(code, 0);
    assert.match(out, /\.eml/);
  });

  it('does nothing at all without the flag', async () => {
    // The sample mounts are opt-in in both directions: someone with real accounts must
    // never find four fictional ones sitting alongside them.
    const { code } = await run(['--no-config', 'ls', '/demo-mail']);
    assert.notEqual(code, 0);
  });
});
