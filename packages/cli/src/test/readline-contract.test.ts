/**
 * The readline substitution contract.
 *
 * `completion.test.ts` asserts against the line the user is left with after pressing Tab,
 * which it computes with a small reimplementation of readline's substitution rule. That
 * reimplementation is only worth anything if it matches the real thing, and the rule is
 * not written down in Node's public documentation — it is an implementation detail that
 * the completer's correctness nevertheless depends on completely.
 *
 * So this file drives an actual `readline.Interface` with an actual Tab keypress and pins
 * the behaviour. If a future Node release changes it, this fails loudly and in one place,
 * rather than turning every quoting test in the suite into a puzzle.
 *
 * The rule, as it stands: when the completer returns exactly one completion, readline
 * deletes `match.length` characters ending at the cursor and inserts the completion in
 * their place. It is a *replacement*, not an append — which is what makes it safe to
 * return a completion that does not extend what the user typed, and which is why the
 * returned match must describe the characters literally on the line.
 */

import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

/** Type `typed`, press Tab against a completer returning `[completions, match]`. */
function pressTab(typed: string, completions: readonly string[], match: string): string {
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
  output.columns = 200;
  output.rows = 40;
  output.isTTY = true;
  output.resume();

  const rl = createInterface({
    input,
    output,
    terminal: true,
    completer: (): [string[], string] => [[...completions], match],
  });
  try {
    input.write(typed);
    input.write('\t');
    return (rl as unknown as { line: string }).line;
  } finally {
    rl.close();
  }
}

describe('readline substitution contract', () => {
  it('replaces the trailing match, it does not append to it', () => {
    // If readline appended, this would be `cd Inbinbox/`.
    assert.equal(pressTab('cd Inb', ['Inbox/'], 'Inb'), 'cd Inbox/');
  });

  it('replaces exactly match.length characters, counted back from the cursor', () => {
    // A short match leaves the earlier characters untouched, which is precisely the
    // failure mode that a stale or tokenizer-derived match produces.
    assert.equal(pressTab('cd ab/ab', ['ab/abc/'], 'ab'), 'cd ab/ab/abc/');
    assert.equal(pressTab('cd ab/ab', ['ab/abc/'], 'ab/ab'), 'cd ab/abc/');
  });

  it('lets a completion correct the case of what was typed', () => {
    assert.equal(pressTab('cd inb', ['Inbox/'], 'inb'), 'cd Inbox/');
  });

  it('lets a completion be shorter or differently shaped than the typed text', () => {
    assert.equal(pressTab('ls -j', ['--json'], '-j'), 'ls --json');
    assert.equal(pressTab('find -q a', ['AND'], 'a'), 'find -q AND');
  });

  it('inserts at the cursor when the match is empty', () => {
    assert.equal(pressTab('cd ', ['Inbox/'], ''), 'cd Inbox/');
  });

  it('leaves the line alone when there are no completions', () => {
    assert.equal(pressTab('cd zz', [], 'zz'), 'cd zz');
  });

  it('leaves the line alone when several completions are returned', () => {
    // This is why the completer returns `[[], raw]` and prints its own list: handing
    // readline several candidates makes it print a column layout we cannot control.
    assert.equal(pressTab('cd In', ['Inbox/', 'Invoices/'], 'In'), 'cd In');
  });

  it('strands a quote when the match omits it — the bug this contract exists to catch', () => {
    // The tokenizer's view of `cat "FY26 bud` is `FY26 bud`. Returning that as the match
    // deletes only the last eight characters, leaving the user's own opening quote behind.
    assert.equal(pressTab('cat "FY26 bud', ['"FY26 budget review.txt"'], 'FY26 bud'), 'cat ""FY26 budget review.txt"');
    // Including the quote in the match is what makes it correct.
    assert.equal(pressTab('cat "FY26 bud', ['"FY26 budget review.txt"'], '"FY26 bud'), 'cat "FY26 budget review.txt"');
  });
});
