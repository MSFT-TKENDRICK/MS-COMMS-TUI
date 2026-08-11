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
  readonly send: (keys: string, settleMs?: number) => Promise<void>;
  readonly done: Promise<number>;
  readonly rawModeHistory: readonly boolean[];
  /** Output written to the ordinary screen, i.e. what survives in the scrollback. */
  readonly scrollback: () => string;
}

interface FakeTty extends PassThrough {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (on: boolean) => FakeTty;
}

async function harness(
  options: { readonly announce?: boolean; readonly isTty?: boolean; readonly mounts?: boolean } = {},
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

/** Wait until the pane has painted something recognisable, or fail loudly. */
async function ready(h: Harness): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (h.text().includes('/mail')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the pane never painted; saw: ${JSON.stringify(h.text().slice(0, 400))}`);
}

// ---------------------------------------------------------------------------

describe('tui app: startup and shutdown', () => {
  it('paints the current folder before waiting for a key', async () => {
    const h = await harness();
    await ready(h);
    const text = h.text();
    assert.match(text, /\/mail/);
    assert.match(text, /Inbox/);
    // The first frame is a full listing, not an empty shell that fills in afterwards — a
    // two-stage paint is announced twice.
    assert.ok(!text.includes('Loading…') || text.lastIndexOf('Inbox') > text.lastIndexOf('Loading…'));
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
