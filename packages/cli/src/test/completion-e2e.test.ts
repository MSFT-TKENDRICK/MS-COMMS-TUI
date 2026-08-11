/**
 * End-to-end completion tests.
 *
 * `completion.test.ts` tests the Completer in isolation: given a line, what does it
 * return. That is necessary but not sufficient, because the feature the user was
 * promised is not "a function returns candidates" — it is "pressing Tab in the shell
 * finishes my word". Between those two sits readline, and readline only consults a
 * completer when it believes it is attached to a terminal.
 *
 * That belief is worth testing, because it is the sort of wiring that fails silently:
 * everything still runs, no error is printed, Tab simply inserts a tab character and
 * the headline feature is gone. So these tests drive the real Shell through a fake TTY
 * with real bytes, exactly as the TUI tests do, and press a real Tab key.
 *
 * They also cover the two accessibility promises the completion path makes, which
 * cannot be checked from the Completer alone:
 *
 *   - Nothing about the completion list may be conveyed by colour, because for a screen
 *     reader colour does not exist and for a monochrome terminal it does not render.
 *   - The completed word has to end up in the buffer that is submitted, not merely be
 *     displayed, or the feature is a demo rather than a tool.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import {
  NULL_LOGGER,
  PluginRegistry,
  DEFAULT_CONFIG,
  type AppConfig,
  type AppPaths,
} from '@mscomms/core';
import { memoryPlugin, type MemoryItem } from '@mscomms/provider-memory';

import { Session } from '../session.js';
import { Shell } from '../shell.js';
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
  return `${process.cwd()}/.test-tmp/completion-e2e/${name}`;
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
      { id: 'm1', title: 'FY26 budget review', author: 'Tom Okafor', agoMinutes: 20 },
    ],
  },
  { id: 'important', title: 'Important', subtype: 'folder', children: [] },
  { id: 'invoices', title: 'Invoices', subtype: 'folder', children: [] },
];

interface FakeTty extends PassThrough {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (on: boolean) => FakeTty;
}

interface Harness {
  /** Bytes readline wrote to the fake terminal, escape codes included. */
  readonly raw: () => string;
  /** Command output and chrome, i.e. what the session itself emitted. */
  readonly out: () => string;
  readonly send: (keys: string) => Promise<void>;
  readonly done: Promise<number>;
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
    ui: { ...DEFAULT_CONFIG.ui, color: 'never' },
  };

  let out = '';
  const session = new Session({
    config,
    registry,
    logger: NULL_LOGGER,
    paths: PATHS,
    mode: 'table',
    color: false,
    width: 80,
    write: (text) => {
      out += text;
    },
    writeError: (text) => {
      out += text;
    },
  });
  await session.start();

  const stdin = new PassThrough() as FakeTty;
  stdin.isTTY = true;
  stdin.setRawMode = (): FakeTty => stdin;

  let raw = '';
  const stdout = new PassThrough() as FakeTty;
  stdout.isTTY = true;
  stdout.columns = 100;
  stdout.rows = 24;
  stdout.write = ((chunk: string | Uint8Array): boolean => {
    raw += String(chunk);
    return true;
  }) as typeof stdout.write;

  const table = new CommandTable();
  table.registerAll(navigationCommands);
  table.registerAll(readCommands);
  table.registerAll(searchCommands);
  table.registerAll(watchCommands);
  table.registerAll(systemCommands(table));

  const shell = new Shell({
    session,
    table,
    input: stdin as unknown as NodeJS.ReadableStream,
    output: stdout as unknown as NodeJS.WritableStream,
    quiet: true,
  });

  const done = shell.run();

  return {
    raw: () => raw,
    out: () => out,
    done,
    send: async (keys: string) => {
      stdin.write(keys);
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 15));
    },
  };
}

/** Terminates the shell and waits for the exit code, so no test leaves it running. */
async function finish(h: Harness): Promise<number> {
  // Ctrl+U first. With `terminal: true` readline keeps whatever the test left on the
  // line, so `exit` would be appended to it and never run — the shell would hang until
  // the test timeout, which looks like a product bug and is not one.
  await h.send('\u0015exit\r');
  return h.done;
}

/** Lists a folder so completion has something cached to work from. */
async function warm(h: Harness, path: string): Promise<void> {
  await h.send(`\u0015ls ${path}\r`);
}

describe('completion, end to end through the real shell', () => {
  it('completes a command name when Tab is pressed', async () => {
    const h = await harness();
    // `notif` is unambiguous, so readline should finish the word outright.
    await h.send('notif\t');
    const line = h.raw().replace(ANSI, '');
    assert.match(
      line,
      /notifications/,
      'Tab must reach the completer; if this fails the feature is silently dead',
    );
    await finish(h);
  });

  it('completes a path, so navigation does not require typing folder names', async () => {
    const h = await harness();
    await warm(h, '/mail');
    await h.send('cd /mail/Inb\t');
    assert.match(h.raw().replace(ANSI, ''), /Inbox/);
    await finish(h);
  });

  it('actually submits the completed word rather than only displaying it', async () => {
    // The difference between a working feature and a convincing demo.
    const h = await harness();
    await warm(h, '/mail');
    await h.send('cd /mail/Inb\t');
    await h.send('\r');
    await h.send('pwd\r');
    assert.match(h.out(), /\/mail\/Inbox/, 'the completed path must be what the shell acts on');
    await finish(h);
  });

  it('prints a plain, numbered list for an ambiguous prefix', async () => {
    const h = await harness();
    await warm(h, '/mail');
    // Two folders start with "I", so the first Tab cannot finish the word.
    await h.send('cd /mail/I\t');

    const shown = h.raw() + h.out();
    assert.match(shown, /Important/);
    assert.match(shown, /Invoices/);
    assert.match(shown, /1\./, 'the list has to be numbered so it can be referred to out loud');
    await finish(h);
  });

  it('emits no colour in the completion list', async () => {
    // Screen readers cannot see colour and monochrome terminals cannot show it, so
    // anything the list needs to convey has to survive as plain text.
    const h = await harness();
    await warm(h, '/mail');
    const before = h.out().length;
    await h.send('cd /mail/I\t');

    const listing = h.out().slice(before);
    assert.notEqual(listing, '', 'the list must actually have been printed');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(listing, /\u001B\[[0-9;]*m/, 'completion output must be free of SGR codes');
    await finish(h);
  });

  it('says something rather than nothing when a prefix matches nothing', async () => {
    // Silence and a broken key are the same experience through speech.
    const h = await harness();
    await warm(h, '/mail');
    const before = h.out().length;
    await h.send('cd /mail/zzzz\t');

    assert.match(h.out().slice(before), /No match for "zzzz"/);
    const code = await finish(h);
    assert.equal(code, 0);
  });
});

describe('completion is off when there is no terminal', () => {
  it('does not treat a piped stdin as a terminal', async () => {
    // A pipe has no cursor to redraw and no user to prompt. If readline believed it were
    // a terminal here it would emit cursor movement into whatever is consuming stdout.
    const registry = new PluginRegistry(NULL_LOGGER);
    registry.register(memoryPlugin);

    let out = '';
    const session = new Session({
      config: { ...DEFAULT_CONFIG, mounts: [], ui: { ...DEFAULT_CONFIG.ui, color: 'never' } },
      registry,
      logger: NULL_LOGGER,
      paths: PATHS,
      mode: 'table',
      color: false,
      width: 80,
      write: (text) => {
        out += text;
      },
      writeError: () => {},
    });
    await session.start();

    const stdin = new PassThrough();
    let raw = '';
    const stdout = new PassThrough();
    stdout.write = ((chunk: string | Uint8Array): boolean => {
      raw += String(chunk);
      return true;
    }) as typeof stdout.write;

    const table = new CommandTable();
    table.registerAll(navigationCommands);
    table.registerAll(systemCommands(table));

    const shell = new Shell({ session, table, input: stdin, output: stdout, quiet: true });
    const done = shell.run();

    stdin.write('pwd\nexit\n');
    stdin.end();
    const code = await done;

    assert.equal(code, 0);
    assert.doesNotMatch(raw, ANSI, 'a non-terminal input must not provoke cursor escape codes');
    assert.match(out, /\//, 'but the command still runs');
  });
});
