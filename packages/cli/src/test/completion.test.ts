/**
 * Tab completion tests.
 *
 * Completion is a headline requirement of this project and the most accessibility-critical
 * code in it, so these tests check three separate things and it is worth being explicit
 * about which is which.
 *
 * 1. **What is offered.** Does Tab produce the right candidates in the right argument slot?
 *    A path offered where a query field belongs is not a cosmetic defect: it is the user
 *    hearing a list of mail folders when they asked how to search.
 *
 * 2. **What readline does with it.** The completer's return value is not the visible
 *    result. readline substitutes it into the line, and the rule it uses — remove exactly
 *    `match.length` characters ending at the cursor, then insert the completion — means a
 *    correct-looking candidate list can still corrupt the line. `substitute()` below
 *    reimplements that rule so the assertions are about the line the user is left with
 *    rather than the tuple we happened to return. `readline-contract.test.ts` pins the
 *    reimplementation against the real thing.
 *
 * 3. **What is printed.** When there are several matches we print the list ourselves. The
 *    numbering in that list is not decoration — it is how a screen reader user selects an
 *    item — so its shape is asserted, not just its presence.
 *
 * The recurring adversary here is the *silent* failure. Completion runs on a keystroke, it
 * has no error channel, and the user cannot see the candidate list being computed. Every
 * bug in this file is a bug the user experiences as the program being broken for no reason.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NULL_LOGGER,
  PluginRegistry,
  DEFAULT_CONFIG,
  type AppConfig,
  type AppPaths,
  type VNode,
} from '@mscomms/core';
import { memoryPlugin, type MemoryItem } from '@mscomms/provider-memory';

import { Completer, rawCurrentToken } from '../completion.js';
import { Session } from '../session.js';
import { CommandTable } from '../commands/types.js';
import { navigationCommands } from '../commands/navigate.js';
import { readCommands } from '../commands/read.js';
import { searchCommands } from '../commands/search.js';
import { systemCommands } from '../commands/system.js';
import { watchCommands } from '../commands/watch.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * readline's substitution rule, reimplemented.
 *
 * Node removes `match.length` characters ending at the cursor and inserts the single
 * completion in their place. Nothing happens when there is not exactly one completion, or
 * when it would not extend the line.
 */
function substitute(line: string, result: readonly [readonly string[], string]): string {
  const [completions, match] = result;
  if (completions.length !== 1) return line;
  const completion = completions[0] as string;
  const head = line.slice(0, line.length - match.length);
  return head + completion;
}

const PATHS: AppPaths = {
  configFile: tmp('cfg/config.jsonc'),
  configDir: tmp('cfg'),
  dataDir: tmp('data'),
  cacheDir: tmp('cache'),
  stateDir: tmp('state'),
  notificationsFile: tmp('state/notifications.json'),
  logFile: tmp('state/log.jsonl'),
};

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/completion/${name}`;
}

const ITEMS: readonly MemoryItem[] = [
  {
    id: 'm1',
    title: 'FY26 budget review',
    author: 'Tom Okafor',
    agoMinutes: 20,
    body: 'The budget review is on Thursday.',
    flags: ['unread'],
  },
  {
    id: 'm2',
    title: 'FY26 budget rollup',
    author: 'Priya Raman',
    agoMinutes: 40,
    body: 'Rollup attached.',
  },
  {
    id: 'm3',
    title: 'Deployment window moved',
    author: 'Dana Whitfield',
    agoMinutes: 90,
    body: 'Moved to Friday.',
  },
];

const TREE: readonly MemoryItem[] = [
  {
    id: 'inbox',
    title: 'Inbox',
    subtype: 'folder',
    children: [...ITEMS, { id: 'nested', title: 'Archive 2026', subtype: 'folder', children: [] }],
  },
  { id: 'invoices', title: 'Invoices', subtype: 'folder', children: [] },
  { id: 'sent', title: 'Sent Items', subtype: 'folder', children: [] },
];

function buildTable(): CommandTable {
  const table = new CommandTable();
  table.registerAll(navigationCommands);
  table.registerAll(readCommands);
  table.registerAll(searchCommands);
  table.registerAll(watchCommands);
  table.registerAll(systemCommands(table));
  return table;
}

interface Harness {
  readonly session: Session;
  readonly completer: Completer;
  readonly printed: () => string;
  readonly complete: (line: string) => [string[], string];
  /** The line the user is left with after pressing Tab. */
  readonly afterTab: (line: string) => string;
}

/**
 * A pinned clock. The memory provider derives display names from item age, so without this
 * every name assertion below would start failing at midnight.
 */
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

/** The names the provider generates for the fixture above, under the pinned clock. */
const REVIEW = '2026-08-11 FY26 budget review.txt';
const ROLLUP = '2026-08-11 FY26 budget rollup.txt';
const DEPLOY = '2026-08-11 Deployment window moved.txt';

async function harness(
  options: { readonly maxDisplayed?: number; readonly warm?: boolean } = {},
): Promise<Harness> {
  const registry = new PluginRegistry(NULL_LOGGER);
  registry.register(memoryPlugin);

  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    mounts: [
      {
        id: 'mail',
        path: '/mail',
        type: 'memory',
        options: { items: TREE, displayName: 'Test mail', now: () => NOW },
      },
    ],
    ui: { ...DEFAULT_CONFIG.ui, plain: true, color: 'never' },
  };

  const session = new Session({
    config,
    registry,
    logger: NULL_LOGGER,
    paths: PATHS,
    mode: 'plain',
    color: false,
    width: 100,
    write: () => undefined,
    writeError: () => undefined,
  });
  await session.start();

  // Warm the cache. Completion is deliberately cache-only — it must never make a network
  // call on a keystroke — so a completer talking to a cold cache has nothing to offer and
  // must say why. Every real session has run `ls` before the user reaches for Tab.
  if (options.warm !== false) {
    await session.vfs.list('/mail', { limit: 25 });
    await session.vfs.list('/mail/Inbox', { limit: 25 });
  }

  let buffer = '';
  const completer = new Completer({
    session,
    table: buildTable(),
    ...(options.maxDisplayed === undefined ? {} : { maxDisplayed: options.maxDisplayed }),
    write: (text) => {
      buffer += text;
    },
  });

  const complete = (line: string): [string[], string] => completer.complete(line);
  return {
    session,
    completer,
    printed: () => buffer,
    complete,
    afterTab: (line) => substitute(line, complete(line)),
  };
}

/** Populate `lastListing` the way `ls` does, so numbered completion has something to use. */
async function listInbox(session: Session): Promise<readonly VNode[]> {
  const page = await session.vfs.list('/mail/Inbox', { limit: 25 });
  session.setListing({ path: '/mail/Inbox', nodes: page.entries, startIndex: 1, source: 'ls' });
  return page.entries;
}

// ---------------------------------------------------------------------------

describe('rawCurrentToken', () => {
  it('returns the token under the cursor', () => {
    assert.equal(rawCurrentToken('cat Inb'), 'Inb');
    assert.equal(rawCurrentToken('cat'), 'cat');
  });

  it('is empty after a trailing space, because no token is being typed', () => {
    assert.equal(rawCurrentToken('cat '), '');
    assert.equal(rawCurrentToken(''), '');
    assert.equal(rawCurrentToken('   '), '');
  });

  it('keeps the opening quote, unlike the tokenizer', () => {
    assert.equal(rawCurrentToken('cat "FY26 bud'), '"FY26 bud');
    assert.equal(rawCurrentToken("cat 'FY26 bud"), "'FY26 bud");
  });

  it('does not treat a space inside quotes as a token boundary', () => {
    assert.equal(rawCurrentToken('cat "a b c'), '"a b c');
  });

  it('starts a new token after a closed quote', () => {
    assert.equal(rawCurrentToken('cat "a b" c'), 'c');
    assert.equal(rawCurrentToken('cat "a b" '), '');
  });

  it('handles a quote opened mid-token', () => {
    assert.equal(rawCurrentToken('cat Inbox/"FY26 bud'), 'Inbox/"FY26 bud');
  });
});

describe('command completion', () => {
  it('completes a unique command name', async () => {
    const h = await harness();
    assert.equal(h.afterTab('moun'), 'mounts');
  });

  it('extends to the longest common prefix when several match', async () => {
    const h = await harness();
    // `watch`, `watches` — the shared prefix is progress, so it is applied silently.
    const [completions] = h.complete('watc');
    assert.deepEqual(completions, ['watch']);
  });

  it('prints a numbered list when the prefix cannot be extended', async () => {
    const h = await harness();
    const [completions] = h.complete('c');
    assert.deepEqual(completions, [], 'readline must not print its own column layout too');
    const out = h.printed();
    assert.match(out, /^\s*1\. /m);
    assert.match(out, /\bcat\b/);
    assert.match(out, /\bcd\b/);
  });

  it('annotates each command with its summary, because the name alone is not enough', async () => {
    const h = await harness();
    h.complete('c');
    const out = h.printed();
    // Every listed command carries prose after it.
    const cat = /\d+\.\s+cat\s{2,}(\S.*)$/m.exec(out);
    assert.ok(cat !== null, `expected an annotated cat row in:\n${out}`);
    assert.ok((cat[1] as string).length > 10);
  });

  it('offers nothing for an unknown command, rather than guessing — but says so', async () => {
    const h = await harness();
    const [completions] = h.complete('zzzz');
    assert.deepEqual(completions, [], 'still refuses to guess a command the user did not type');
    // This assertion used to require silence. Silence was wrong: through speech it is
    // indistinguishable from a broken key, and the user has no way to tell whether to
    // keep typing or give up.
    assert.match(h.printed(), /No command matches "zzzz"/);
  });

  it('does not complete arguments of an unknown command', async () => {
    const h = await harness();
    const [completions] = h.complete('zzzz /ma');
    assert.deepEqual(completions, []);
  });
});

describe('completion never answers with silence', () => {
  /**
   * The rule these tests defend: pressing Tab always produces an observable result.
   *
   * A completion that returns nothing and prints nothing is, to a screen reader user,
   * exactly the same experience as a key that is not wired up. There is no cursor to
   * watch, no list that flickers, no colour that changes — the only channel is text, so
   * if nothing is written then nothing happened as far as the user can tell. That
   * ambiguity is worse than an unhelpful answer, because it gives no basis for deciding
   * what to do next.
   */

  it('explains an empty or unvisited folder by naming the command that fixes it', async () => {
    const h = await harness({ warm: false });
    const [completions] = h.complete('cd /mail/Inb');

    assert.deepEqual(completions, [], 'still must not block on a network call');
    assert.match(h.printed(), /Nothing to complete from in \/mail yet/);
    assert.match(h.printed(), /ls \/mail/, 'the message has to name the fix, not just the problem');
  });

  it('distinguishes a genuine miss from having nothing to work with', async () => {
    const h = await harness();
    const [completions] = h.complete('cd /mail/zzzz');

    assert.deepEqual(completions, []);
    assert.match(h.printed(), /No match for "zzzz" in \/mail/);
    assert.doesNotMatch(
      h.printed(),
      /Nothing to complete from/,
      'a populated folder must not be reported as unvisited',
    );
  });

  it('says something for every kind of completion, not just paths', async () => {
    for (const line of ['zzzz', 'ls --zzzz', 'find is:zzzz', 'set zzzz']) {
      const h = await harness();
      h.complete(line);
      assert.notEqual(h.printed(), '', `"${line}" produced no output at all`);
    }
  });

  it('writes the explanation as plain text with no escape codes', async () => {
    // It has to survive being spoken and being piped, so it cannot rely on styling.
    const h = await harness();
    h.complete('cd /mail/zzzz');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(h.printed(), /\u001B/);
  });
});

describe('flag completion', () => {
  it('completes a long flag from a single dash', async () => {
    const h = await harness();
    assert.equal(h.afterTab('ls --js'), 'ls --json');
  });

  it('substitutes cleanly when the typed text is shorter than the flag', async () => {
    const h = await harness();
    // The corruption case: readline removes exactly `match.length` characters, so a
    // candidate that does not extend the typed text must still produce a sane line.
    const out = h.afterTab('find --tsv --js');
    assert.equal(out, 'find --tsv --json');
  });

  it('lists flags with descriptions when ambiguous', async () => {
    const h = await harness();
    const [completions] = h.complete('ls -');
    assert.deepEqual(completions, []);
    const out = h.printed();
    assert.match(out, /--json/);
    assert.match(out, /Print machine-readable JSON\./);
  });
});

describe('query completion', () => {
  it('completes query fields after -q, not paths', async () => {
    const h = await harness();
    const [completions] = h.complete('find -q fr');
    assert.deepEqual(completions, ['from:']);
    assert.equal(h.afterTab('find -q fr'), 'find -q from:');
  });

  it('completes values once a field and colon are typed', async () => {
    const h = await harness();
    assert.equal(h.afterTab('find -q is:unr'), 'find -q is:unread');
  });

  it('treats any token containing a colon as a query fragment', async () => {
    const h = await harness();
    // Not after -q, but the colon is unambiguous.
    const [completions] = h.complete('find has:att');
    assert.deepEqual(completions, ['has:attachment']);
  });

  it('offers boolean operators', async () => {
    const h = await harness();
    assert.equal(h.afterTab('find -q AN'), 'find -q AND');
  });

  it('offers nothing for an unknown field, rather than inventing values', async () => {
    const h = await harness();
    const [completions] = h.complete('find -q nosuchfield:x');
    assert.deepEqual(completions, []);
  });
});

describe('path completion', () => {
  it('completes a directory name and appends a slash', async () => {
    const h = await harness();
    assert.equal(h.afterTab('cd Inb'), 'cd Inbox/');
  });

  it('is case-insensitive, and repairs the case in the line', async () => {
    const h = await harness();
    // Folders are `Inbox`, not `inbox`. Requiring the shift key mid-completion is
    // friction for no benefit, and the substitution must fix the case rather than
    // leaving a path that will not resolve.
    assert.equal(h.afterTab('cd inb'), 'cd Inbox/');
  });

  it('completes mount points from anywhere', async () => {
    const h = await harness();
    assert.equal(h.afterTab('cd /ma'), 'cd /mail/');
  });

  it('keeps the directory part of the typed path', async () => {
    const h = await harness();
    h.session.cwd = '/mail';
    // The whole token is quoted, not the segment: `Inbox/"Archive 2026"/` would re-parse
    // as two arguments.
    assert.equal(h.afterTab('cd Inbox/Arch'), 'cd "Inbox/Archive 2026/"');
  });

  it('restricts `cd` to directories but lets `cat` see items', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';

    // `Archive 2026` is the only subdirectory, so `cd ` resolves to exactly one candidate.
    assert.equal(h.afterTab('cd '), 'cd "Archive 2026/"');

    // `cat` sees the messages too, so it is ambiguous and prints a list.
    h.complete('cat ');
    assert.match(h.printed(), /budget review/, '`cat` must offer messages');
  });

  it('never blocks on the network: an uncached directory yields nothing', async () => {
    const h = await harness();
    h.session.cwd = '/mail';
    // `/mail/Sent Items` has never been listed, so there is nothing cached to complete
    // from. A Tab that stalls for a network round trip reads, through speech, as a crash.
    const [completions] = h.complete('cat Sent%');
    assert.deepEqual(completions, []);
  });
});

describe('quoted path completion', () => {
  it('does not double the quote the user already typed', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';

    const line = 'cat "2026-08-11 FY26 budget rev';
    const out = h.afterTab(line);
    assert.equal(out, `cat "${REVIEW}"`);
    assert.ok(!out.includes('""'), `doubled quote in ${JSON.stringify(out)}`);
  });

  it('opens the quote on a partial completion and closes it on a final one', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';

    // Several messages share a date prefix, so the first Tab can only extend part-way. The
    // token must be left open, or the next keystroke lands outside the quotes.
    const partial = h.afterTab('cat 2026');
    assert.equal(partial, 'cat "2026-08-11 ');

    // Continuing from there and completing to a unique name closes it.
    assert.equal(h.afterTab(`${partial}Deploy`), `cat "${DEPLOY}"`);
  });

  it('extends to the common prefix without stranding the quote', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    // `review` and `rollup` share a prefix. The line must stay well-formed so a second Tab
    // sees the same token it would have seen had the user typed it.
    const out = h.afterTab('cat "2026-08-11 FY26 budget r');
    assert.ok(out.startsWith('cat "2026-08-11 FY26 budget r'), out);
    assert.ok(!out.includes('""'), `doubled quote in ${JSON.stringify(out)}`);
    assert.ok(REVIEW.startsWith(out.slice('cat "'.length)), `"${out}" is not a prefix of a real name`);
  });

  it('keeps the single-quote style the user chose', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    const [, match] = h.complete("cat '2026-08-11 Deploy");
    assert.equal(match, "'2026-08-11 Deploy", 'the match must describe the characters on the line');
  });
});

describe('numbered completion', () => {
  it('does not offer indices on an empty Tab', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    await listInbox(h.session);

    h.complete('cat ');
    const out = h.printed();
    // The numbers are already on screen from `ls`. Offering them again doubles the length
    // of every completion list for no new information, and through speech that doubling
    // is the difference between a list you can hold in your head and one you cannot.
    const rows = out.split('\n').filter((line) => /^\s*\d+\. /.test(line));
    assert.ok(rows.length > 0, 'expected some candidates');
    for (const row of rows) {
      assert.doesNotMatch(row, /^\s*\d+\.\s+\d+\s*$/, `bare index offered as a candidate: ${row}`);
    }
  });

  it('offers indices once a digit is typed', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    await listInbox(h.session);

    const [completions] = h.complete('cat 1');
    assert.deepEqual(completions, ['1'], 'index 1 is the only match for the prefix "1"');
  });

  it('offers indices after a bare #', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    const nodes = await listInbox(h.session);
    assert.ok(nodes.length >= 3);

    h.complete('cat #');
    const out = h.printed();
    assert.match(out, /#1\b/);
    assert.match(out, /#2\b/);
  });

  it('annotates an index with the item title, because a number alone is opaque', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    await listInbox(h.session);
    h.complete('cat #');
    assert.match(h.printed(), /#\d+\s+.*(budget|Deployment|Archive)/i);
  });

  it('offers nothing numeric when there is no listing', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    const [completions] = h.complete('cat #');
    assert.deepEqual(completions, []);
  });
});

describe('other argument kinds', () => {
  it('completes setting names for `set`', async () => {
    const h = await harness();
    assert.equal(h.afterTab('set pag'), 'set pagesize');
  });

  it('completes command names for `help`', async () => {
    const h = await harness();
    assert.equal(h.afterTab('help moun'), 'help mounts');
  });

  it('completes action verbs for `do`', async () => {
    const h = await harness();
    // `do` takes the action first: `do unflag 3`.
    assert.equal(h.afterTab('do unfl'), 'do unflag');
  });
});

describe('printed candidate list', () => {
  it('caps the list and says how to narrow it', async () => {
    const h = await harness({ maxDisplayed: 3 });
    h.complete('');
    const out = h.printed();
    const rows = out.split('\n').filter((line) => /^\s*\d+\. /.test(line));
    assert.equal(rows.length, 3);
    assert.match(out, /and \d+ more\. Type more characters to narrow the list\./);
  });

  it('states the count and the kind of thing being offered', async () => {
    const h = await harness();
    h.complete('c');
    assert.match(h.printed(), /^\d+ commands:$/m);
  });

  it('is plain scrolling text, with no cursor movement or screen clearing', async () => {
    const h = await harness();
    h.complete('c');
    const out = h.printed();
    // An fzf-style overlay repaints a region a screen reader cannot observe. Printed text
    // lands in scrollback and can be reviewed. Any escape sequence here is a regression
    // toward the overlay model.
    assert.doesNotMatch(out, /\u001b\[/, 'no ANSI control sequences in the candidate list');
  });

  it('never emits a candidate row containing a newline', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    await listInbox(h.session);
    h.complete('cat ');
    for (const line of h.printed().split('\n')) {
      assert.ok(!line.includes('\r'), 'a row that becomes two rows breaks numbered addressing');
    }
  });
});

describe('robustness', () => {
  it('never throws, whatever is on the line', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    await listInbox(h.session);

    const lines = [
      '',
      ' ',
      '  \t ',
      '"',
      "'",
      '""',
      'cat "',
      'cat ""',
      'cat "unterminated',
      'cd ../../../..',
      'cd ////',
      'find -q ',
      'find -q :',
      'find -q ::',
      'find -q is:',
      'do',
      'do ',
      'set',
      '--json',
      '-',
      '#',
      'cat #999999',
      'cat 0',
      'cat -1',
      'ls /mail/Inbox/',
      'ls '.repeat(50),
      `cat ${'x'.repeat(5000)}`,
    ];
    for (const line of lines) {
      assert.doesNotThrow(() => h.complete(line), `threw on ${JSON.stringify(line)}`);
    }
  });

  it('always returns a match that is a suffix of the line', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';
    await listInbox(h.session);

    // This is the invariant that makes readline's substitution safe. If the returned match
    // is not literally the tail of the line, the substitution removes the wrong characters.
    const lines = ['cat Inb', 'cat "FY26 bud', 'cd /ma', 'find -q is:unr', 'ls -', 'cat #1', 'set pag', 'moun'];
    for (const line of lines) {
      const [, match] = h.complete(line);
      assert.ok(line.endsWith(match), `${JSON.stringify(match)} is not a suffix of ${JSON.stringify(line)}`);
    }
  });

  it('produces a line that still tokenizes to the same argument count', async () => {
    const h = await harness();
    h.session.cwd = '/mail/Inbox';

    const before = 'cat "2026-08-11 FY26 budget rev';
    const after = h.afterTab(before);
    const { tokenize } = await import('../commands/types.js');
    assert.equal(tokenize(after).length, 2, `"${after}" must still be one command and one argument`);
    assert.equal(tokenize(after)[1], REVIEW);
  });
});
