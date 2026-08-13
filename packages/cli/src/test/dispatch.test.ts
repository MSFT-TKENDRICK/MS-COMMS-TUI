/**
 * Tests for the shared dispatcher and for output capture.
 *
 * These two things exist to keep one promise: that the full-screen view's `:` prompt is not
 * a second, weaker command language. The pane tells the user, on its help screen, that `:`
 * reaches the same commands the shell does. That claim is only true while both interfaces
 * route through one {@link Dispatcher}, so the tests below check the behaviours that would
 * otherwise drift apart — bare paths, listing numbers, the `!` escape, typo suggestions —
 * rather than only checking that a named command runs.
 *
 * {@link Session.capture} is the other half. It is the mechanism that lets the pane run a
 * real command and show its real output instead of reimplementing a display for each one.
 * Its failure mode is nasty and silent: if the sinks were not restored, a session would go
 * on writing into a discarded buffer and the user's terminal would simply stop responding.
 * So restoration is asserted on the throwing path as well as the happy one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NULL_LOGGER,
  PluginRegistry,
  DEFAULT_CONFIG,
  VfsError,
  type AppConfig,
  type AppPaths,
  type Capability,
  type ListPage,
  type ProviderPlugin,
  type VNode,
} from '@mscomms/core';
import { memoryPlugin, type MemoryItem } from '@mscomms/provider-memory';

import { Dispatcher, editDistance } from '../dispatch.js';
import { Session } from '../session.js';
import { CommandTable } from '../commands/types.js';
import { navigationCommands } from '../commands/navigate.js';
import { readCommands } from '../commands/read.js';
import { searchCommands } from '../commands/search.js';
import { systemCommands } from '../commands/system.js';
import { watchCommands } from '../commands/watch.js';

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/dispatch/${name}`;
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

const TREE: readonly MemoryItem[] = [
  {
    id: 'inbox',
    title: 'Inbox',
    subtype: 'folder',
    children: [
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
        title: 'Deployment window moved',
        author: 'Dana Whitfield',
        agoMinutes: 90,
        body: 'Moved to Friday.',
      },
    ],
  },
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
  readonly dispatcher: Dispatcher;
  readonly run: (line: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
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

  const dispatcher = new Dispatcher(buildTable());
  return {
    session,
    dispatcher,
    run: async (line) => session.capture(async () => dispatcher.execute(session, line)),
  };
}

// ---------------------------------------------------------------------------

describe('session: capture', () => {
  it('collects output instead of printing it', async () => {
    const { session, run } = await harness();
    const output = await run('ls');
    assert.ok(output.includes('Inbox'), `expected a listing, got: ${JSON.stringify(output)}`);
    assert.equal(session.cwd, '/mail');
  });

  it('merges stderr into the captured text', async () => {
    // The stdout/stderr split exists so a pipe gets clean data. There is no pipe here, and
    // a user who typed a command wants the warning that came with the answer.
    const { session } = await harness();
    const output = await session.capture(async () => {
      session.print('data');
      session.status('chrome');
      return Promise.resolve();
    });
    assert.ok(output.includes('data'));
    assert.ok(output.includes('chrome'));
  });

  it('restores the sinks afterwards', async () => {
    const { session } = await harness();
    const after: string[] = [];
    await session.capture(async () => {
      session.print('swallowed');
      return Promise.resolve();
    });
    // Re-point the real sink by capturing again; if restoration failed, the outer capture
    // would return nothing because the inner sink would still be installed.
    const output = await session.capture(async () => {
      session.print('visible');
      return Promise.resolve();
    });
    after.push(output);
    assert.ok(output.includes('visible'));
    assert.ok(!output.includes('swallowed'));
  });

  it('restores the sinks even when the command throws', async () => {
    // The silent-wedge failure mode: a throwing command leaves the session writing into a
    // buffer nobody reads, and the terminal appears to die.
    const { session } = await harness();
    await assert.rejects(
      session.capture(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    const output = await session.capture(async () => {
      session.print('still working');
      return Promise.resolve();
    });
    assert.ok(output.includes('still working'));
  });

  it('nests without losing the outer buffer', async () => {
    const { session } = await harness();
    let inner = '';
    const outer = await session.capture(async () => {
      session.print('outer-before');
      inner = await session.capture(async () => {
        session.print('inner');
        return Promise.resolve();
      });
      session.print('outer-after');
    });
    assert.ok(inner.includes('inner'));
    assert.ok(outer.includes('outer-before'));
    assert.ok(outer.includes('outer-after'));
    assert.ok(!outer.includes('inner'), 'the inner capture should have taken its own output');
  });
});

describe('session: beforeFirstWrite', () => {
  it('fires immediately ahead of the first byte, not before the command runs', async () => {
    // The ordering is the whole point. The shell uses this to erase a progress line that
    // occupies the cursor's current row: erase too early and it is erased before it has
    // finished animating, too late and the command's output has already scrolled past it,
    // stranding a spinner in the scrollback.
    const { session } = await harness();
    const events: string[] = [];
    await session.beforeFirstWrite(
      () => events.push('erase'),
      async () => {
        events.push('working');
        session.print('first');
        events.push('after-write');
        session.print('second');
        return Promise.resolve();
      },
    );
    assert.deepEqual(events, ['working', 'erase', 'after-write']);
  });

  it('fires once however much is printed', async () => {
    const { session } = await harness();
    let fired = 0;
    await session.beforeFirstWrite(
      () => (fired += 1),
      async () => {
        session.print('a');
        session.status('b');
        session.print('c');
        return Promise.resolve();
      },
    );
    assert.equal(fired, 1);
  });

  it('does not fire for a command that prints nothing', async () => {
    // A silent command never disturbed the line, so there is nothing to erase.
    const { session } = await harness();
    let fired = 0;
    await session.beforeFirstWrite(
      () => (fired += 1),
      async () => Promise.resolve(),
    );
    assert.equal(fired, 0);
  });

  it('watches stderr too, since a warning also lands on the line', async () => {
    const { session } = await harness();
    let fired = 0;
    await session.beforeFirstWrite(
      () => (fired += 1),
      async () => {
        session.status('warning');
        return Promise.resolve();
      },
    );
    assert.equal(fired, 1);
  });

  it('restores the sinks even when the command throws', async () => {
    // Same silent-wedge failure as `capture`: a throwing command must not leave the session
    // writing through a filter that outlives it, or every later line re-triggers `before`.
    const { session } = await harness();
    let fired = 0;
    await assert.rejects(
      session.beforeFirstWrite(
        () => (fired += 1),
        async () => {
          throw new Error('boom');
        },
      ),
      /boom/,
    );
    const output = await session.capture(async () => {
      session.print('still working');
      return Promise.resolve();
    });
    assert.ok(output.includes('still working'));
    assert.equal(fired, 0, 'nothing was printed, so nothing needed erasing');
  });
});

describe('dispatch: the shared command path', () => {
  it('runs a named command', async () => {
    const { run } = await harness();
    assert.ok((await run('pwd')).includes('/mail'));
  });

  it('parses that command\u2019s own flags', async () => {
    const { run } = await harness();
    const json = await run('ls --json');
    assert.doesNotThrow(() => JSON.parse(json) as unknown);
  });

  it('treats a bare folder name as cd', async () => {
    const { session, run } = await harness();
    await run('Inbox');
    assert.equal(session.cwd, '/mail/Inbox');
  });

  it('treats a bare file name as cat', async () => {
    const { session, run } = await harness();
    await run('Inbox');
    const listing = await run('ls');
    assert.ok(listing.includes('budget review'));

    const output = await run('1');
    assert.ok(output.includes('Thursday'), `expected the body, got: ${JSON.stringify(output)}`);
    assert.equal(session.cwd, '/mail/Inbox', 'reading a file should not move us');
  });

  it('addresses items by their listing number', async () => {
    // The load-bearing accessibility feature: `ls` then act on a number, with no cursor.
    const { run } = await harness();
    await run('cd Inbox');
    await run('ls');
    assert.ok((await run('cat 2')).includes('Friday'));
  });

  it('honours the ! escape for a path that looks like a command', async () => {
    const { session, run } = await harness();
    await run('!Inbox');
    assert.equal(session.cwd, '/mail/Inbox');
  });

  it('suggests a command after a typo instead of only refusing', async () => {
    const { run } = await harness();
    const output = await run('lss');
    assert.match(output, /do not know the command/i);
    assert.match(output, /did you mean `ls`/i);
  });

  it('distinguishes a bad command from a missing path', async () => {
    const { run } = await harness();
    const missing = await run('nope/deeper');
    assert.doesNotMatch(missing, /do not know the command/i);
  });

  it('reports errors as sentences rather than throwing', async () => {
    const { run } = await harness();
    // A stack trace at an interactive prompt is noise; through speech it is unusable.
    const output = await run('cat /mail/does-not-exist.txt');
    assert.ok(output.trim() !== '');
    assert.doesNotMatch(output, /\bat .*\.js:\d+/, 'no stack frames in user-facing errors');
  });

  it('does nothing at all for an empty line', async () => {
    const { session, run } = await harness();
    const before = session.cwd;
    await run('');
    assert.equal(session.cwd, before);
  });
});

describe('dispatch: typo suggestions', () => {
  it('measures edit distance', () => {
    assert.equal(editDistance('ls', 'ls'), 0);
    assert.equal(editDistance('lss', 'ls'), 1);
    assert.equal(editDistance('cta', 'cat'), 2);
    assert.equal(editDistance('', 'cat'), 3);
  });

  it('offers nothing when nothing is close', () => {
    const dispatcher = new Dispatcher(buildTable());
    assert.equal(dispatcher.suggestCommand('xyzzyplughquux'), undefined);
  });

  it('offers the obvious neighbour', () => {
    const dispatcher = new Dispatcher(buildTable());
    assert.equal(dispatcher.suggestCommand('lss'), 'ls');
    assert.equal(dispatcher.suggestCommand('cd '.trim()), 'cd');
  });
});

/**
 * `unwatch` used to accept only the derived watch id. Since `watch /mail/Inbox` names the
 * watch `mail.Inbox`, the string you typed to create a watch was not the string that would
 * remove it — you had to run `watches`, read an id off the screen, and type that instead.
 * That is a small amount of friction for someone reading a table at a glance and a large
 * amount for someone hearing it read aloud.
 */
describe('unwatch accepts whatever the user already typed', () => {
  it('removes a watch by the path it was created with', async () => {
    const h = await harness();
    await h.run('watch /mail/Inbox');
    const out = await h.run('unwatch /mail/Inbox');
    assert.match(out, /Stopped watching/);
    assert.equal(h.session.watcher.statuses.length, 0);
  });

  it('still removes a watch by its id', async () => {
    const h = await harness();
    await h.run('watch /mail/Inbox');
    const id = h.session.watcher.statuses[0]?.id;
    assert.ok(id !== undefined);
    await h.run(`unwatch ${id}`);
    assert.equal(h.session.watcher.statuses.length, 0);
  });

  it('resolves a relative path against the working directory', async () => {
    const h = await harness();
    await h.run('watch /mail/Inbox');
    await h.run('cd /mail');
    await h.run('unwatch Inbox');
    assert.equal(h.session.watcher.statuses.length, 0);
  });

  it('removes every watch on a path when there is more than one', async () => {
    const h = await harness();
    await h.run('watch /mail/Inbox');
    await h.run('watch /mail/Inbox -q is:unread --id unread-only');
    assert.equal(h.session.watcher.statuses.length, 2);
    const out = await h.run('unwatch /mail/Inbox');
    assert.match(out, /2 watches/);
    assert.equal(h.session.watcher.statuses.length, 0);
  });

  it('says both things it looked for when it finds neither', async () => {
    const h = await harness();
    const out = await h.run('unwatch /mail/Nope');
    // The message has to explain that an id *and* a path were tried, or the user cannot
    // tell which of the two they got wrong.
    assert.match(out, /no watch called/);
    assert.match(out, /nothing is watching that path/);
    assert.match(out, /watches/);
  });

  it('leaves unrelated watches alone', async () => {
    const h = await harness();
    await h.run('watch /mail/Inbox');
    await h.run('watch "/mail/Sent Items" --id sent');
    await h.run('unwatch /mail/Inbox');
    assert.deepEqual(
      h.session.watcher.statuses.map((s) => s.path),
      ['/mail/Sent Items'],
    );
  });
});

describe('watch refuses to start a watch that could never fire', () => {
  it('rejects a path that does not exist', async () => {
    // `watch`'s own help promises it fails immediately rather than appearing to work and
    // never firing. That was only true for sources that cannot poll at all; a typo'd path
    // was accepted and then reported `state ok` forever.
    const h = await harness();
    const out = await h.run('watch /mail/DoesNotExist');
    assert.match(out, /No such file or directory/);
    assert.equal(h.session.watcher.statuses.length, 0);
  });

  it('accepts a path that does exist', async () => {
    const h = await harness();
    const out = await h.run('watch /mail/Inbox');
    assert.match(out, /Watching \/mail\/Inbox/);
    assert.equal(h.session.watcher.statuses.length, 1);
  });

  it('accepts the working directory when given no path', async () => {
    const h = await harness();
    await h.run('cd /mail');
    await h.run('watch');
    assert.deepEqual(
      h.session.watcher.statuses.map((s) => s.path),
      ['/mail'],
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * Surplus arguments.
 *
 * These pin a rule that was learned the hard way: `cd /blog /nonexistent` used to print
 * "/blog" and exit zero, having thrown away half of what the user typed. Through speech
 * that is indistinguishable from success. Every command that declares `maxPositional` now
 * refuses the line instead, and — where it can tell what was meant — offers the exact
 * corrected line rather than only restating the rule.
 */
describe('dispatch: surplus arguments', () => {
  it('refuses to silently drop an extra argument', async () => {
    const h = await harness();
    const before = h.session.cwd;
    const out = await h.run('cd /mail/Inbox /nowhere');
    assert.match(out, /does not take the extra argument/);
    assert.match(out, /"\/nowhere"/);
    // The important half: it did not quietly do the first one. `/mail/Inbox` is a real
    // folder, so without the guard this line would have succeeded and moved.
    assert.equal(h.session.cwd, before);
    assert.notEqual(before, '/mail/Inbox');
  });

  it('suggests the quoted line when a name was typed unquoted', async () => {
    const h = await harness();
    const out = await h.run('cat FY26 budget review');
    assert.match(out, /Did you mean: cat "FY26 budget review"/);
  });

  it('declines to suggest a quoting fix that would also fail', async () => {
    // Two absolute paths are two things, not one name with a space in it. Suggesting
    // `cd "/mail /nowhere"` would be a second dead end dressed up as an answer.
    const h = await harness();
    const out = await h.run('cd /mail/Inbox /nowhere');
    assert.doesNotMatch(out, /Did you mean/);
    assert.match(out, /Usage: cd/);
  });

  it('keeps the leading argument out of the quotes for `do`', async () => {
    const h = await harness();
    const out = await h.run('do read FY26 budget review');
    assert.match(out, /Did you mean: do read "FY26 budget review"/);
  });

  it('keeps a trailing attachment number out of the quotes for `save`', async () => {
    const h = await harness();
    const out = await h.run('save FY26 budget review 2');
    assert.match(out, /Did you mean: save "FY26 budget review" 2/);
  });

  it('absorbs a trailing word that is not a number into the quoted name', async () => {
    const h = await harness();
    const out = await h.run('save FY26 budget report.pdf');
    assert.match(out, /Did you mean: save "FY26 budget report.pdf"/);
  });

  it('rejects arguments to a command that takes none', async () => {
    const h = await harness();
    const out = await h.run('pwd /mail');
    assert.match(out, /`pwd` does not take the extra argument/);
  });

  it('declines to suggest quoting a run of item numbers', async () => {
    // `save 1 2 3` is someone using listing numbers, not a subject that lost its quotes.
    // `save "1 2" 3` would be gibberish.
    const h = await harness();
    const out = await h.run('save 1 2 3');
    assert.doesNotMatch(out, /Did you mean/);
    assert.match(out, /Usage: save/);
  });

  it('declines to suggest quoting item numbers after a leading argument', async () => {
    const h = await harness();
    const out = await h.run('do read 1 2');
    assert.doesNotMatch(out, /Did you mean/);
    assert.match(out, /Usage: do/);
  });

  it('leaves commands without a declared limit alone', async () => {
    // `find` is deliberately variadic — its query is a phrase. The guard must not creep.
    const h = await harness();
    const out = await h.run('find budget review thursday');
    assert.doesNotMatch(out, /does not take the extra/);
  });

  it('names every surplus argument, not just the first', async () => {
    const h = await harness();
    const out = await h.run('pwd one two');
    assert.match(out, /"one", "two"/);
    assert.match(out, /extra arguments/);
  });
});

// ---------------------------------------------------------------------------

/**
 * Path-versus-query splitting in `find` and `grep`.
 *
 * The bug these exist for: `find /blog deploy` joined both words into the query, searched
 * for titles containing "/blog", and reported "(empty)". A false negative is the worst
 * answer this program can give, because the user concludes the message does not exist.
 *
 * The fix is deliberately evidence-based rather than shape-based — a leading word is only
 * treated as a folder when it really resolves to one — and it is always announced, so a
 * user who meant both words as search terms can hear that and reach for `-q`.
 */
describe('search: path and query', () => {
  it('treats a leading folder as the folder to search', async () => {
    const h = await harness();
    const out = await h.run('find /mail/Inbox budget');
    assert.match(out, /FY26 budget review/);
    assert.doesNotMatch(out, /Deployment window/);
  });

  it('says which folder it decided to search', async () => {
    const h = await harness();
    const out = await h.run('find /mail/Inbox budget');
    assert.match(out, /Searching \/mail\/Inbox for "budget"/);
    assert.match(out, /-q/);
  });

  it('keeps a multi-word query when the first word is not a folder', async () => {
    const h = await harness();
    await h.run('cd /mail/Inbox');
    const out = await h.run('find budget review');
    assert.match(out, /FY26 budget review/);
    assert.doesNotMatch(out, /Searching/);
  });

  it('leaves a single-word query alone', async () => {
    const h = await harness();
    await h.run('cd /mail/Inbox');
    const out = await h.run('find budget');
    assert.match(out, /FY26 budget review/);
  });

  it('still lets -q settle the query and a positional settle the path', async () => {
    const h = await harness();
    const out = await h.run('find -q budget /mail/Inbox');
    assert.match(out, /FY26 budget review/);
    assert.doesNotMatch(out, /Deployment window/);
  });

  it('grep takes a trailing folder as the folder, not as search text', async () => {
    const h = await harness();
    const out = await h.run('grep Thursday /mail/Inbox');
    assert.match(out, /FY26 budget review/);
  });

  it('grep joins words into the search text when the last is not a folder', async () => {
    const h = await harness();
    await h.run('cd /mail/Inbox');
    const out = await h.run('grep budget review');
    assert.match(out, /Searching for "budget review"/);
  });
});

/**
 * A provider whose root lists cleanly and whose one folder always fails to open.
 *
 * This is the failure that hides: nothing throws at the top level, so a search over it
 * "succeeds" while having seen none of the content. It exists here to prove the search
 * says so rather than returning a confident zero.
 */
const brokenPlugin: ProviderPlugin<Record<string, never>> = {
  type: 'broken',
  displayName: 'Broken feed',
  description: 'Test double: lists its root, then refuses to open anything inside it.',
  validateOptions: () => ({}) as Record<string, never>,
  create: () => ({
    id: 'broken',
    displayName: 'Broken feed',
    capabilities: new Set<Capability>(['list', 'read']),
    list(parent: VNode | null): Promise<ListPage> {
      if (parent === null) {
        return Promise.resolve({
          entries: [{ name: 'Headlines', id: 'headlines', kind: 'dir', title: 'Headlines' }],
          total: 1,
        });
      }
      return Promise.reject(new VfsError('ENETWORK', 'the feed did not answer'));
    },
    read: () => Promise.reject(new VfsError('ENETWORK', 'the feed did not answer')),
  }),
};

/**
 * `find` across every source.
 *
 * The harness mounts two independent memory providers so these exercise the real
 * fan-out, not a single-mount shortcut.
 */
describe('dispatcher: cross-source find', () => {
  async function twoMounts(): Promise<Harness> {
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
        {
          id: 'chat',
          path: '/chat',
          type: 'memory',
          options: {
            items: [
              {
                id: 'general',
                title: 'General',
                subtype: 'folder',
                children: [
                  { id: 'c1', title: 'the budget thread', author: 'Priya Raman', agoMinutes: 5, body: 'long' },
                ],
              },
            ],
            displayName: 'Test chat',
            now: () => NOW,
          },
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

    const dispatcher = new Dispatcher(buildTable());
    return {
      session,
      dispatcher,
      run: async (line) => session.capture(async () => dispatcher.execute(session, line)),
    };
  }

  /**
   * Two sources, one of which lists its root fine and then refuses to open the folder
   * inside it — the shape of a feed that is reachable but broken, or a scope that was
   * revoked for one folder only. The whole point is that the search still succeeds.
   */
  async function withBrokenSource(): Promise<Harness> {
    const registry = new PluginRegistry(NULL_LOGGER);
    registry.register(memoryPlugin);
    registry.register(brokenPlugin);

    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      mounts: [
        {
          id: 'mail',
          path: '/mail',
          type: 'memory',
          options: { items: TREE, displayName: 'Test mail', now: () => NOW },
        },
        { id: 'news', path: '/news', type: 'broken', options: {} },
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

    const dispatcher = new Dispatcher(buildTable());
    return {
      session,
      dispatcher,
      run: async (line) => session.capture(async () => dispatcher.execute(session, line)),
    };
  }

  it('-a reaches every source even from inside one of them', async () => {
    // Without this, a user who has cd'd into their mailbox and searches gets mail only,
    // with nothing to suggest the chat hit they were actually after even exists.
    const h = await twoMounts();
    await h.run('cd /mail/Inbox');
    const out = await h.run('find -a -q budget');
    assert.match(out, /chat\//, 'the other source must appear');
    assert.match(out, /mail\//);
  });

  it('without -a, a search stays where the user is', async () => {
    const h = await twoMounts();
    await h.run('cd /mail/Inbox');
    const out = await h.run('find -q budget');
    assert.doesNotMatch(out, /chat\//);
  });

  it('--source restricts to the named sources and implies searching them all', async () => {
    const h = await twoMounts();
    await h.run('cd /mail/Inbox');
    const out = await h.run('find --source chat -q budget');
    assert.match(out, /chat\//);
    assert.doesNotMatch(out, /mail\//);
  });

  it('names an unknown source instead of reporting an empty result', async () => {
    // "No matches" would read as "that mail does not exist", which is a false negative.
    const h = await twoMounts();
    const out = await h.run('find --source nope -q budget');
    assert.match(out, /No source matches/);
    assert.match(out, /chat|mail/);
  });

  it('offers a wider limit rather than `more`, since a merged search has no cursor', async () => {
    const h = await twoMounts();
    const out = await h.run('find -a -n 1 -q budget');
    assert.doesNotMatch(out, /Type `more`/, 'there is no cursor to resume from');
    assert.match(out, /raise `-n`|Raise `-n`/i);
  });

  it('accepts Lucene syntax end to end', async () => {
    const h = await twoMounts();
    const fuzzy = await h.run('find -a -q budgt~');
    assert.match(fuzzy, /budget/i, 'a misspelling should still find the item');
    const wildcard = await h.run('find -a -q subject:budg*');
    assert.match(wildcard, /budget/i);
  });

  it('ranks the better match first across sources', async () => {
    const h = await twoMounts();
    const out = await h.run('find -a -q "budget review"');
    const first = out.split('\n').find((line) => line.trim().startsWith('1.')) ?? '';
    assert.match(first, /FY26 budget review/, 'the phrase match belongs at the top');
  });

  it('says so when a source could only be searched in part', async () => {    // The quiet failure this guards against: a feed that will not answer contributes no
    // results, the merge succeeds, and "0 matches in news" reads as "nothing there".
    const h = await withBrokenSource();
    const out = await h.run('find -a -q budget');
    assert.match(out, /Searched only part of: news/);
    assert.match(out, /could not be read/);
    assert.match(out, /mail\//, 'the healthy source still reports its hits');
  });

  it('says so on a single-source search too', async () => {
    const h = await withBrokenSource();
    const out = await h.run('find /news -q budget');
    assert.match(out, /Could not read 1 folder/);
    assert.match(out, /may not be everything/);
  });

  it('stays quiet about unreadable folders when there were none', async () => {
    // The report has to be rare enough to mean something; printing it every time would
    // train the user to skip the line that matters.
    const h = await twoMounts();
    const out = await h.run('find -a -q budget');
    assert.doesNotMatch(out, /could not be read|may not be everything/);
  });
});


// ---------------------------------------------------------------------------

describe('do: passing an action its arguments', () => {
  /**
   * A tree with the subtypes the action commands look for, so the verbs under test are
   * actually offered. TREE above deliberately leaves subtype off, which makes every item
   * a plain note with only the state verbs.
   */
  const ACTIONABLE: readonly MemoryItem[] = [
    {
      id: 'inbox',
      title: 'Inbox',
      subtype: 'folder',
      children: [
        {
          id: 'am1',
          title: 'FY26 budget review',
          subtype: 'message',
          author: 'Tom Okafor',
          agoMinutes: 20,
          body: 'The budget review is on Thursday.',
          flags: ['unread'],
        },
      ],
    },
    {
      id: 'pulls',
      title: 'Pulls',
      subtype: 'folder',
      children: [
        {
          id: 'ap1',
          title: 'Cap default listings',
          subtype: 'pull',
          author: 'Dana Whitfield',
          agoMinutes: 60,
          body: 'Adds paging.',
          flags: ['open'],
        },
      ],
    },
  ];

  async function actionable(): Promise<Harness> {
    const registry = new PluginRegistry(NULL_LOGGER);
    registry.register(memoryPlugin);

    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      mounts: [
        {
          id: 'work',
          path: '/work',
          type: 'memory',
          options: { items: ACTIONABLE, displayName: 'Test work', now: () => NOW },
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

    const dispatcher = new Dispatcher(buildTable());
    return {
      session,
      dispatcher,
      run: async (line) => session.capture(async () => dispatcher.execute(session, line)),
    };
  }

  it('takes the token after --body as the body', async () => {
    // The regression: an action parameter is not a declared flag of `do`, so a parser that
    // only gives values to flags it knows about turns `--body "text"` into a bare switch
    // plus a stray positional. The approval then goes out with no comment on it, which is
    // both wrong and silent.
    const h = await actionable();
    await h.run('cd /work/Pulls');
    await h.run('ls');
    const out = await h.run('do approve 1 --body "Paging looks right."');
    assert.match(out, /Approved/);
    assert.match(out, /Paging looks right\./);
  });

  it('accepts --body=value too', async () => {
    const h = await actionable();
    await h.run('cd /work/Pulls');
    await h.run('ls');
    const out = await h.run('do approve 1 --body=Looks-good');
    assert.match(out, /Looks-good/);
  });

  it('keeps a declared switch a switch', async () => {
    // `--yes` must not eat the number after it, or confirming a merge would silently
    // retarget the command.
    const h = await actionable();
    await h.run('cd /work/Pulls');
    await h.run('ls');
    const out = await h.run('do merge 1 --yes');
    assert.match(out, /Merged/);
  });

  it('still asks first without --yes', async () => {
    const h = await actionable();
    await h.run('cd /work/Pulls');
    await h.run('ls');
    const out = await h.run('do merge 1');
    assert.match(out, /--yes/);
    assert.doesNotMatch(out, /Merged/);
  });

  it('names the parameter the user meant to type', async () => {
    const h = await actionable();
    await h.run('cd /work/Pulls');
    await h.run('ls');
    const out = await h.run('do approve 1 --boddy x');
    assert.match(out, /no parameter called "boddy"/);
    assert.match(out, /Did you mean "body"/);
  });

  it('refuses an action the item does not offer, and says what it does', async () => {
    const h = await actionable();
    await h.run('cd /work/Pulls');
    await h.run('ls');
    const out = await h.run('do reply 1 --body hello');
    assert.match(out, /no action called "reply"/);
    assert.match(out, /approve/);
  });

  it('reports a missing required argument rather than sending a blank one', async () => {
    const h = await actionable();
    await h.run('cd /work/Inbox');
    await h.run('ls');
    const out = await h.run('do reply 1');
    assert.match(out, /body/);
    assert.doesNotMatch(out, /Replied/);
  });

  it('lists the arguments an action wants', async () => {
    const h = await actionable();
    await h.run('cd /work/Inbox');
    await h.run('ls');
    const out = await h.run('actions 1');
    assert.match(out, /reply/);
    assert.match(out, /--body\*/, 'a required argument is marked');
  });

  it('applies the reply to the conversation, not to the message', async () => {
    // A reply hung off the message would turn a readable mail into a folder.
    const h = await actionable();
    await h.run('cd /work/Inbox');
    await h.run('ls');
    await h.run('do reply 1 --body "On it, thanks."');
    const out = await h.run('ls');
    // The listing sanitises `:` out of a file name, so the reply reads "Re- ...".
    assert.match(out, /Re[:-] FY26 budget review/);
    assert.match(out, /2 items|1 item/, 'the reply is a sibling, not a child');
  });
});
