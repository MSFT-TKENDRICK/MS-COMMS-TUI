/**
 * Global flag parsing.
 *
 * This file exists because of one bug, found by running the built binary rather than by
 * reading it: `mscomms --json ls /mail` reported `there is no command called "--json"`,
 * while `mscomms ls /mail --json` worked. The mode flags were being pushed into the
 * argument list in place, so a flag written before the command occupied the command-name
 * slot.
 *
 * The general rule it violated is worth stating, because it is easy to break again: a
 * boolean flag's meaning must not depend on where in the line it appears. Users do not
 * memorise argument grammars; they type the flag where they thought of it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGlobals } from '../index.js';

describe('parseGlobals: mode flags', () => {
  for (const [flag, mode] of [
    ['--json', 'json'],
    ['--tsv', 'tsv'],
    ['--announce', 'announce'],
    ['--plain', 'plain'],
  ] as const) {
    it(`${flag} means the same thing before and after the command`, () => {
      const before = parseGlobals([flag, 'ls', '/mail']);
      const after = parseGlobals(['ls', '/mail', flag]);

      assert.equal(before.mode, mode);
      assert.equal(after.mode, mode);

      // The command name is what matters: it must never be the flag.
      assert.equal(before.rest[0], 'ls');
      assert.equal(after.rest[0], 'ls');

      // And the flag still reaches the command's own parser in both cases.
      assert.ok(before.rest.includes(flag));
      assert.ok(after.rest.includes(flag));
    });
  }

  it('keeps a lone mode flag out of the command slot entirely', () => {
    // `mscomms --announce` with no command should start the shell in announce mode, not
    // try to run a command named "--announce".
    const globals = parseGlobals(['--announce']);
    assert.equal(globals.mode, 'announce');
    assert.deepEqual(globals.rest, []);
  });

  it('leaves positional arguments in their original order', () => {
    // Appending the flags must not disturb anything the command reads positionally.
    const globals = parseGlobals(['--json', 'find', '/mail', '-q', 'is:unread']);
    assert.deepEqual(globals.rest.slice(0, 4), ['find', '/mail', '-q', 'is:unread']);
  });

  it('handles several mode flags without losing the command', () => {
    // Contradictory, but it must not produce a nonsense command name.
    const globals = parseGlobals(['--json', '--tsv', 'ls']);
    assert.equal(globals.rest[0], 'ls');
  });
});

describe('parseGlobals: the rest', () => {
  it('reads --config and consumes its value', () => {
    const globals = parseGlobals(['--config', '/tmp/x.jsonc', 'ls']);
    assert.equal(globals.configPath, '/tmp/x.jsonc');
    assert.deepEqual(globals.rest, ['ls']);
  });

  it('treats init as a subcommand only as the first word', () => {
    assert.equal(parseGlobals(['init']).init, true);
    // A folder genuinely called `init` must still be reachable.
    const asArgument = parseGlobals(['ls', 'init']);
    assert.equal(asArgument.init, false);
    assert.deepEqual(asArgument.rest, ['ls', 'init']);
  });

  it('records --tui without swallowing a command', () => {
    const globals = parseGlobals(['--tui']);
    assert.equal(globals.tui, true);
    assert.deepEqual(globals.rest, []);
  });
});
