/**
 * The `gh auth login` fallback.
 *
 * The token itself lives in an OS keychain, so these tests inject the runner rather than
 * invoking the real CLI: a suite whose result depends on whether the machine happens to
 * have `gh` installed and signed in is a suite that fails on someone else's laptop for
 * reasons that have nothing to do with their change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ghToken } from '../gh.js';

/** Records what was asked for, and answers from a script of replies. */
function runner(replies: readonly (string | undefined)[]) {
  const calls: { command: string; args: readonly string[] }[] = [];
  let index = 0;
  const run = async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return replies[index++];
  };
  return { calls, run };
}

/** A runner that fails the way a missing executable does. */
async function throwingRunner(): Promise<string | undefined> {
  throw new Error('spawn ENOENT');
}

describe('ghToken', () => {
  it('returns the token the CLI prints, without its trailing newline', async () => {
    const { run } = runner(['gho_0123456789abcdef\n']);
    assert.equal(await ghToken({ run }), 'gho_0123456789abcdef');
  });

  it('asks for the token and nothing else', async () => {
    // The argument vector is the security boundary: no shell, no interpolation, no config
    // value ever reaching a command line.
    const { calls, run } = runner(['tok']);
    await ghToken({ run });
    assert.deepEqual(calls[0]?.args, ['auth', 'token']);
  });

  it('reports nothing when the CLI is absent or not signed in', async () => {
    const { run } = runner([undefined, undefined]);
    assert.equal(await ghToken({ run }), undefined);
  });

  it('treats a rejecting runner as an absent token rather than propagating', async () => {
    // Callers use this to decide between authenticated and anonymous access. Throwing here
    // would turn a missing optional credential into a mount that refuses to start.
    assert.equal(await ghToken({ run: throwingRunner }), undefined);
  });

  it('ignores output that cannot be a token', async () => {
    // A `gh` that printed usage text to stdout would otherwise put a paragraph of English
    // into an Authorization header.
    const { run } = runner(['Usage:  gh auth token [flags]\n']);
    assert.equal(await ghToken({ run }), undefined);
  });

  it('ignores an empty line', async () => {
    const { run } = runner(['   \n']);
    assert.equal(await ghToken({ run }), undefined);
  });

  it('stops at the first candidate that answers', async () => {
    const { calls, run } = runner(['tok', 'second']);
    assert.equal(await ghToken({ run }), 'tok');
    assert.equal(calls.length, 1);
  });
});
