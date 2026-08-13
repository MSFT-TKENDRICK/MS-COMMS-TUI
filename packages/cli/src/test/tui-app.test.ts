/**
 * Integration tests for the terminal-facing half of the full-screen view.
 *
 * `state.ts` and `render.ts` are pure and tested exhaustively elsewhere. `app.ts` is the
 * part that cannot be, so it is driven here through fake TTY streams: real bytes go in, are
 * decoded by the real `readline.emitKeypressEvents`, and the real frames come out. That
 * matters because the bugs left in a thin wiring layer are exactly the ones a pure test
 * cannot see — a key that never reaches the reducer, a frame that is never painted, and
 * above all a terminal that is not put back the way it was found.
 *
 * The restoration assertions are the important ones. Raw mode, the alternate screen and a
 * hidden cursor are three global changes to something the user owns. Leaving any of them
 * behind breaks the shell the user returns to, and they will have no idea why.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import { NULL_LOGGER, PluginRegistry, DEFAULT_CONFIG, type AppConfig, type AppPaths } from '@mscomms/core';
import { memoryPlugin, type MemoryItem } from '@mscomms/provider-memory';

import { Session } from '../session.js';
import { Tui } from '../tui/app.js';
import { CommandTable } from '../commands/types.js';
import { navigationCommands } from '../commands/navigate.js';
import { readCommands } from '../commands/read.js';
import { searchCommands } from '../commands/search.js';
import { systemCommands } from '../commands/system.js';
import { watchCommands } from '../commands/watch.js';

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[a-zA-Z]/g;

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/tui-app/${name}`;
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
        body: 'Moved to Friday at noon.',
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
  /** Everything written to the fake terminal, escape codes included. */
  readonly raw: () => string;
  /** The same, with escape codes removed — what a person would see. */
  readonly text: () => string;
  /** Only the most recent paint, decoded. What is on screen *now*. */
  readonly frame: () => string;
  readonly send: (keys: string, settleMs?: number) => Promise<void>;
  readonly done: Promise<number>;
  readonly rawModeHistory: readonly boolean[];
  /** Output written to the ordinary screen, i.e. what survives in the scrollback. */
  readonly scrollback: () => string;
}

const CURSOR_HOME = '\u001B[H';

interface FakeTty extends PassThrough {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (on: boolean) => FakeTty;
}

async function harness(
  options: {
    readonly announce?: boolean;
    readonly isTty?: boolean;
    readonly mounts?: boolean;
    /**
     * Held in front of every listing, so a test can hold the pane in its loading state and
     * ask what the user can do while it is there. The memory provider is instant, which is
     * exactly wrong for testing behaviour that only exists because real sources are not.
     */
    readonly hold?: () => Promise<void>;
  } = {},
): Promise<Harness> {
  const registry = new PluginRegistry(NULL_LOGGER);
  registry.register(memoryPlugin);

  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    mounts:
      options.mounts === false
        ? []
        : [
            {
              id: 'mail',
              path: '/mail',
              type: 'memory',
              options: { items: TREE, displayName: 'Test mail', now: () => NOW },
            },
          ],
    ui: { ...DEFAULT_CONFIG.ui, color: 'never' },
  };

  let scrollback = '';
  const session = new Session({
    config,
    registry,
    logger: NULL_LOGGER,
    paths: PATHS,
    mode: options.announce === true ? 'announce' : 'table',
    color: false,
    width: 80,
    write: (text) => {
      scrollback += text;
    },
    writeError: (text) => {
      scrollback += text;
    },
  });
  await session.start();

  if (options.hold !== undefined) {
    const { hold } = options;
    const real = session.vfs.list.bind(session.vfs);
    session.vfs.list = (async (target, listOptions) => {
      await hold();
      return real(target, listOptions);
    }) as typeof session.vfs.list;
  }

  const rawModeHistory: boolean[] = [];
  const stdin = new PassThrough() as FakeTty;
  stdin.isTTY = options.isTty ?? true;
  stdin.setRawMode = (on: boolean): FakeTty => {
    rawModeHistory.push(on);
    return stdin;
  };

  let painted = '';
  const stdout = new PassThrough() as FakeTty;
  stdout.isTTY = options.isTty ?? true;
  stdout.columns = 100;
  stdout.rows = 24;
  stdout.setRawMode = (): FakeTty => stdout;
  const realWrite = stdout.write.bind(stdout);
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    painted += String(chunk);
    // Drain, or the PassThrough's buffer fills and back-pressure stalls the paint.
    void realWrite;
    return true;
  }) as typeof stdout.write;

  const tui = new Tui({
    session,
    table: buildTable(),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  const done = tui.run();

  return {
    session,
    raw: () => painted,
    text: () => painted.replace(ANSI, ''),
    frame: () => {
      // Every paint starts by homing the cursor, so the last frame is everything after the
      // last home. Tests that assert on `text()` see the whole history concatenated, which
      // is right for "did this ever appear" but wrong for "what is on screen now".
      const all = painted;
      const start = all.lastIndexOf(CURSOR_HOME);
      return (start === -1 ? all : all.slice(start)).replace(ANSI, '');
    },
    scrollback: () => scrollback,
    rawModeHistory,
    done,
    send: async (keys: string, settleMs = 25) => {
      stdin.write(keys);
      // Two macrotask turns: one for the keypress to be decoded and handled, one for any
      // effect the reducer asked for to settle.
      //
      // A lone ESC needs longer. At the byte level `ESC` followed by `q` within readline's
      // escapeCodeTimeout (500ms) is indistinguishable from Alt+Q — that ambiguity is in
      // the terminal protocol, not in this program — so a test that means "the user pressed
      // Escape" has to leave a gap after it, exactly as a human hand does.
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    },
  };
}

/**
 * Wait until the first listing has landed, or fail loudly.
 *
 * "The pane has painted" is no longer the same question as "the pane has data": the first
 * frame is deliberately drawn before the fetch, so that a slow source shows a loading screen
 * instead of a blank one. Tests that want data have to wait for the load to settle, which is
 * what the absence of the working indicator means.
 */
async function ready(h: Harness): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const frame = h.frame();
    if (frame.includes('/mail') && !frame.includes('working')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the pane never settled; saw: ${JSON.stringify(h.frame().slice(0, 400))}`);
}

// ---------------------------------------------------------------------------

describe('tui app: startup and shutdown', () => {
  it('shows a loading frame first, then the folder', async () => {
    const h = await harness();
    await ready(h);
    const text = h.text();
    assert.match(text, /\/mail/);
    assert.match(text, /Inbox/);
    // The loading frame comes *first* and the listing replaces it. This is the opposite of
    // what this view used to do: it fetched before the first paint, which meant a source
    // taking seven seconds to answer showed a blank alternate screen for seven seconds,
    // with the "Loading…" frame fully computed and never drawn.
    assert.ok(text.includes('Loading…'), 'should say what it is doing before it has an answer');
    assert.ok(
      text.indexOf('Loading…') < text.indexOf('Inbox'),
      'the loading frame should precede the listing, not follow it',
    );
    // …and it must not still be claiming to load once the answer is in.
    assert.ok(!h.frame().includes('working'), 'the settled frame should not show the working indicator');
    await h.send('q');
    assert.equal(await h.done, 0);
  });

  it('enters and leaves the alternate screen, and re-shows the cursor', async () => {
    const h = await harness();
    await ready(h);
    assert.ok(h.raw().includes('\u001B[?1049h'), 'should enter the alternate screen');
    assert.ok(h.raw().includes('\u001B[?25l'), 'should hide the cursor');

    await h.send('q');
    await h.done;
    assert.ok(h.raw().includes('\u001B[?1049l'), 'MUST leave the alternate screen');
    assert.ok(h.raw().includes('\u001B[?25h'), 'MUST re-show the cursor');
    assert.ok(
      h.raw().lastIndexOf('\u001B[?25h') < h.raw().lastIndexOf('\u001B[?1049l'),
      'cursor should be restored before the screen is handed back',
    );
  });

  it('turns raw mode on at the start and off at the end', async () => {
    const h = await harness();
    await ready(h);
    assert.deepEqual(h.rawModeHistory, [true]);
    await h.send('q');
    await h.done;
    assert.deepEqual(h.rawModeHistory, [true, false], 'a terminal left in raw mode is broken');
  });

  it('leaves a trace in the scrollback on the way out', async () => {
    // Leaving the alternate screen discards everything drawn on it. Without this, a
    // full-screen session is a hole in the user's history.
    const h = await harness();
    await ready(h);
    await h.send('q');
    await h.done;
    const trail = h.scrollback();
    assert.match(trail, /\/mail/);
    assert.match(trail, /Inbox/);
    assert.match(trail, /--tui/, 'should point at the interface that does not need a screen');
  });

  it('refuses to start when output is not a terminal, and explains why', async () => {
    const h = await harness({ isTty: false });
    assert.equal(await h.done, 2);
    assert.match(h.scrollback(), /--tui/);
    assert.equal(h.raw(), '', 'must not touch a non-terminal at all');
  });

  it('refuses rather than silently ignoring --announce', async () => {
    const h = await harness({ announce: true });
    assert.equal(await h.done, 2);
    assert.match(h.scrollback(), /announce/i);
    assert.equal(h.rawModeHistory.length, 0);
  });
});

describe('tui app: navigating', () => {
  it('moves the selection with a real arrow-key byte sequence', async () => {
    const h = await harness();
    await ready(h);
    const before = h.text();
    await h.send('\u001B[B'); // Down
    const after = h.text().slice(before.length);
    assert.match(after, /2 of 2|Sent Items/, `selection did not move; saw ${JSON.stringify(after.slice(0, 300))}`);
    await h.send('q');
    await h.done;
  });

  it('descends into a folder on Enter and comes back on Backspace', async () => {
    const h = await harness();
    await ready(h);

    await h.send('\r');
    assert.match(h.text(), /\/mail\/Inbox/);
    assert.match(h.text(), /budget review/);

    await h.send('\u007F'); // Backspace
    const tail = h.text().slice(h.text().lastIndexOf('\u001B[H'));
    assert.ok(h.text().includes('/mail'), `did not return; tail was ${JSON.stringify(tail.slice(0, 200))}`);
    await h.send('q');
    await h.done;
  });

  it('reads a message into the preview', async () => {
    const h = await harness();
    await ready(h);
    await h.send('\r'); // into Inbox
    await h.send('\r'); // read the first message
    assert.match(h.text(), /Thursday/, 'the message body should be on screen');
    await h.send('q');
    await h.done;
  });

  it('filters as you type', async () => {
    const h = await harness();
    await ready(h);
    await h.send('\r');
    await h.send('/');
    await h.send('d');
    const text = h.text();
    assert.match(text, /Filter: d/);
    assert.match(text, /1 of 2 match|Deployment/);
    // Enter commits the filter and returns to browsing; `q` is a literal letter until then.
    await h.send('\r');
    await h.send('q');
    await h.done;
  });

  it('Escape clears a filter and returns to browsing', async () => {    const h = await harness();
    await ready(h);
    await h.send('\r');
    await h.send('/');
    await h.send('d');
    assert.match(h.text(), /Filter: d/);

    await h.send('\u001B', 700); // a real Escape needs the escape-sequence timeout to lapse
    assert.match(h.text(), /Filter cleared|2 of 2|budget review/);

    await h.send('q');
    assert.equal(await h.done, 0);
  });

  it('lets Ctrl+C out of filter mode, where q is a literal letter', async () => {
    // The trap this guards: every other key is mode-dependent, so without one
    // mode-independent escape a user who does not know about Escape is stuck.
    const h = await harness();
    await ready(h);
    await h.send('/');
    await h.send('abc');
    assert.match(h.text(), /Filter: abc/);
    await h.send('\u0003');
    assert.equal(await h.done, 0);
    assert.deepEqual(h.rawModeHistory, [true, false]);
  });

  it('lets Ctrl+C out of command mode too', async () => {
    const h = await harness();
    await ready(h);
    await h.send(':');
    await h.send('quit');
    await h.send('\u0003');
    assert.equal(await h.done, 0);
    assert.deepEqual(h.rawModeHistory, [true, false]);
  });

  it('shows help and returns from it', async () => {
    const h = await harness();
    await ready(h);
    await h.send('?');
    assert.match(h.text(), /adds no capability of its own/i);
    await h.send('x');
    await h.send('q');
    await h.done;
  });
});

describe('tui app: the command escape hatch', () => {
  it('tells a first-time user with no sources what to press', async () => {
    // The line shell's banner says "type demo". A user in the pane can't type anything until
    // they know about `:`, so an empty root has to name that key or it is a dead end.
    const h = await harness({ mounts: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const text = h.text();
    assert.match(text, /No sources configured/);
    assert.match(text, /:\s*then type demo/);
    assert.match(text, /doctor/);
    await h.send('q');
    assert.equal(await h.done, 0);
  });

  it('runs a real command and shows its real output', async () => {
    const h = await harness();
    await ready(h);
    await h.send('\r'); // into Inbox
    await h.send(':');
    await h.send('grep Friday');
    await h.send('\r');
    assert.match(h.text(), /Deployment|Friday/, 'grep output should appear in the preview');
    await h.send('q');
    await h.done;
  });

  it('follows a cd issued from the command line', async () => {
    // The two halves of the interface must not disagree about where the user is.
    const h = await harness();
    await ready(h);
    await h.send(':');
    await h.send('cd Inbox');
    await h.send('\r');
    assert.match(h.text(), /\/mail\/Inbox/);
    assert.equal(h.session.cwd, '/mail/Inbox');
    await h.send('q');
    await h.done;
  });

  it('reports an unknown command without dying', async () => {
    const h = await harness();
    await ready(h);
    await h.send(':');
    await h.send('flibbertigibbet');
    await h.send('\r');
    assert.match(h.text(), /do not know the command|no output/i);
    await h.send('q');
    await h.done;
    assert.deepEqual(h.rawModeHistory, [true, false]);
  });

  it('quits cleanly when the command line says quit', async () => {
    const h = await harness();
    await ready(h);
    await h.send(':');
    await h.send('quit');
    await h.send('\r');
    assert.equal(await h.done, 0);
    assert.deepEqual(h.rawModeHistory, [true, false]);
  });
});

describe('tui app: frames', () => {
  it('keeps the shell numbering in step, so `cat 2` still means the second row', async () => {
    const h = await harness();
    await ready(h);
    await h.send('\r');
    await h.send('q');
    await h.done;

    const listing = h.session.lastListing;
    assert.notEqual(listing, undefined);
    assert.equal(listing?.path, '/mail/Inbox');
    assert.equal(listing?.startIndex, 1);
    assert.equal(listing?.nodes.length, 2);
  });

  it('paints frames that are all the same width', async () => {
    const h = await harness();
    await ready(h);
    await h.send('\u001B[B');

    // Take the last frame: everything after the final cursor-home.
    const raw = h.raw();
    const frame = raw.slice(raw.lastIndexOf('\u001B[H') + 3);
    const rows = frame.split('\r\n').map((line) => line.replace(ANSI, ''));
    const widths = new Set(rows.slice(0, -1).map((line) => line.length));
    assert.equal(widths.size, 1, `frame rows disagree on width: ${JSON.stringify([...widths])}`);
    assert.equal([...widths][0], 100);

    await h.send('q');
    await h.done;
  });

  it('ignores keys after quitting instead of painting onto a restored terminal', async () => {
    const h = await harness();
    await ready(h);
    await h.send('q');
    await h.done;
    const after = h.raw().length;
    await h.send('jjjj');
    assert.equal(h.raw().length, after, 'must not write to a terminal it has handed back');
  });
});

/**
 * What the user can do while a source is being slow.
 *
 * This is the behaviour the whole loading-indicator change exists for, and none of it can
 * be seen with an instant provider — so every test here holds the listing open by hand.
 *
 * The old contract was "every key is dropped until the fetch returns". For a source taking
 * seven seconds that is a program which has, from the outside, crashed: nothing on screen
 * changes and nothing you press does anything, including quit.
 */
describe('tui app: while a source is slow', () => {
  /** A listing that does not return until the test says so. */
  function gate(): { readonly hold: () => Promise<void>; readonly release: () => void } {
    let open = false;
    const waiters: Array<() => void> = [];
    return {
      hold: async () => {
        if (open) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      },
      release: () => {
        open = true;
        for (const resolve of waiters.splice(0)) resolve();
      },
    };
  }

  /** Wait for the pane to be visibly loading, rather than assuming a timing. */
  async function loading(h: Harness): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (h.frame().includes('working')) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`the pane never showed it was working; saw: ${JSON.stringify(h.frame().slice(0, 300))}`);
  }

  it('says it is loading instead of showing a blank screen', async () => {
    const g = gate();
    const h = await harness({ hold: g.hold });
    await loading(h);

    assert.match(h.frame(), /Loading…/);
    assert.match(h.frame(), /working/);

    g.release();
    await ready(h);
    await h.send('q');
    await h.done;
  });

  it('keeps animating, because a caption that never changes reads as a hang', async () => {
    const g = gate();
    const h = await harness({ hold: g.hold });
    await loading(h);

    const first = h.frame();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const later = h.frame();
    assert.notEqual(first, later, 'the indicator should have advanced on its own');
    assert.match(later, /working/);

    g.release();
    await ready(h);
    await h.send('q');
    await h.done;
  });

  it('lets the user quit rather than trapping them until the fetch returns', async () => {
    const g = gate();
    const h = await harness({ hold: g.hold });
    await loading(h);

    await h.send('q');
    // Bounded, so that the old behaviour — `q` dropped outright, leaving no way out of a
    // slow load but killing the process — shows up as a failure rather than as a test run
    // that never finishes.
    const code = await Promise.race([
      h.done,
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 2000)),
    ]);
    assert.equal(code, 0, 'q should quit even while a fetch is outstanding');
    g.release();
  });

  it('still scrolls, because moving the cursor costs nothing', async () => {
    // The first listing has to land before there is anything to scroll, so the gate is
    // released and then re-armed around a second, held, navigation.
    const g = gate();
    const h = await harness();
    await ready(h);

    const real = h.session.vfs.list.bind(h.session.vfs);
    h.session.vfs.list = (async (target, listOptions) => {
      await g.hold();
      return real(target, listOptions);
    }) as typeof h.session.vfs.list;

    try {
      await h.send('r'); // refresh — held open by the gate
      await loading(h);

      await h.send('\u001B[B'); // down
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(h.frame(), /2 of 2, Sent Items/, 'the selection should have moved during the load');
      assert.match(h.frame(), /working/, 'and the load should still be running');
    } finally {
      // Always, or a failing assertion leaves a listing parked forever and the runner with
      // a handle it cannot close.
      g.release();
    }

    await h.send('q');
    await h.done;
  });

  it('refuses a second fetch out loud rather than silently queueing it', async () => {
    const g = gate();
    const h = await harness();
    await ready(h);

    const real = h.session.vfs.list.bind(h.session.vfs);
    let calls = 0;
    h.session.vfs.list = (async (target, listOptions) => {
      calls += 1;
      await g.hold();
      return real(target, listOptions);
    }) as typeof h.session.vfs.list;

    try {
      await h.send('r');
      await loading(h);
      const during = calls;

      // A held-down arrow used to be the reason keys were dropped: queueing these would
      // fire a burst of requests that all land after the user has stopped moving.
      await h.send('\r\r\r');
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(calls, during, 'no extra request should have been started');
      assert.match(h.frame(), /Still working/i, 'and the user should be told why nothing happened');
    } finally {
      g.release();
    }

    await h.send('q');
    await h.done;
  });
});
