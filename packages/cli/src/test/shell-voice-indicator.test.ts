/**
 * The microphone indicator on the line shell's prompt.
 *
 * The prompt is this interface's input bar. It is the row the cursor sits on, and it is the
 * only piece of chrome guaranteed to be on screen at the moment somebody is deciding whether
 * to speak — so "is this thing recording me right now?" has to be answerable there.
 *
 * The full-screen pane got this first, and it would have been easy to stop there. It should
 * not have been: the pane is opt-in and the shell is the default, so shipping the indicator
 * only in the pane would mean the majority of users — including everyone using a screen
 * reader, for whom the pane is the wrong interface — had no way to tell a live microphone
 * from a dead one without running a command to ask.
 *
 * These tests drive the real Shell through a fake TTY and read the bytes it writes, because
 * the failure being guarded against is silent: a prompt that never redraws still works
 * perfectly as a prompt, and the missing indicator is invisible until somebody is recorded
 * without realizing it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import { NULL_LOGGER, PluginRegistry, DEFAULT_CONFIG, type AppConfig, type AppPaths } from '@mscomms/core';

import { Session } from '../session.js';
import { Shell } from '../shell.js';
import { CommandTable } from '../commands/types.js';
import { systemCommands } from '../commands/system.js';

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/shell-voice-indicator/${name}`;
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

interface FakeTty extends PassThrough {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (on: boolean) => FakeTty;
}

interface Harness {
  readonly session: Session;
  /** Everything readline wrote to the terminal, prompts included. */
  readonly raw: () => string;
  /** Forget what has been written so far, so an assertion is about one redraw. */
  readonly clear: () => void;
  readonly settle: () => Promise<void>;
  readonly finish: () => Promise<number>;
}

async function harness(ui: Partial<AppConfig['ui']> = {}): Promise<Harness> {
  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    ui: { ...DEFAULT_CONFIG.ui, color: 'never', ...ui },
  };

  const session = new Session({
    config,
    registry: new PluginRegistry(NULL_LOGGER),
    logger: NULL_LOGGER,
    paths: PATHS,
    mode: 'table',
    color: false,
    width: 80,
    write: () => undefined,
    writeError: () => undefined,
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
  table.registerAll(systemCommands(table));

  const shell = new Shell({
    session,
    table,
    input: stdin as unknown as NodeJS.ReadableStream,
    output: stdout as unknown as NodeJS.WritableStream,
    quiet: true,
  });
  const done = shell.run();

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
  };

  // Wait for the first prompt rather than for a fixed delay. The shell reads its history
  // file before it subscribes to anything, so a timed wait is a race that a loaded test
  // runner loses — and losing it means the event under test is emitted into a shell that is
  // not listening yet, which fails as an empty screen and looks like the feature is missing.
  for (let waited = 0; raw === '' && waited < 4000; waited += 5) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.notEqual(raw, '', 'the shell never drew its first prompt');

  return {
    session,
    raw: () => raw,
    clear: () => {
      raw = '';
    },
    settle,
    finish: async () => {
      stdin.write('\u0015exit\r');
      await settle();
      return done;
    },
  };
}

describe('the microphone indicator on the shell prompt', () => {
  it('is absent until voice is actually listening', async () => {
    // A permanent "MIC OFF" is clutter charged to every user, including everyone who will
    // never say a word to this program — and on a screen reader it is re-read on keystrokes.
    const h = await harness();
    assert.match(h.raw(), />/, 'the prompt should have been drawn at all');
    assert.doesNotMatch(h.raw(), /MIC/);
    await h.finish();
  });

  it('appears on the prompt the moment the microphone opens', async () => {
    const h = await harness();
    h.clear();
    h.session.emit({ kind: 'voice', phase: 'listening' });
    await h.settle();
    assert.match(h.raw(), /\[MIC LIVE\]/);
    await h.finish();
  });

  it('says something different while the audio is being transcribed', async () => {
    // The distinction matters: recording is over, so it is safe to stop talking, but the
    // program is not idle either. Users who cannot tell will either keep talking into a
    // closed microphone or assume it crashed.
    const h = await harness();
    h.session.emit({ kind: 'voice', phase: 'listening' });
    await h.settle();
    h.clear();
    h.session.emit({ kind: 'voice', phase: 'transcribing' });
    await h.settle();
    assert.match(h.raw(), /\[MIC WORKING\]/);
    assert.doesNotMatch(h.raw(), /\[MIC LIVE\]/);
    await h.finish();
  });

  it('goes away again when listening ends', async () => {
    const h = await harness();
    h.session.emit({ kind: 'voice', phase: 'listening' });
    await h.settle();
    h.clear();
    h.session.emit({ kind: 'voice', phase: 'idle' });
    await h.settle();
    assert.doesNotMatch(h.raw(), /MIC/);
    await h.finish();
  });

  it('does not redraw the prompt for events that do not change the indicator', async () => {
    // Voice emits a run of events per utterance. Repainting for each one makes a screen
    // reader read the whole line again every time, which is the announcement storm the line
    // shell exists to avoid — so only a real change is allowed to touch the prompt.
    const h = await harness();
    h.session.emit({ kind: 'voice', phase: 'listening' });
    await h.settle();
    h.clear();
    h.session.emit({ kind: 'voice', phase: 'listening', text: 'go to' });
    h.session.emit({ kind: 'voice', phase: 'listening', text: 'go to inbox' });
    await h.settle();
    assert.equal(h.raw(), '', 'a partial transcript must not redraw the prompt');
    await h.finish();
  });

  it('still shows through a custom prompt rather than being replaced by it', async () => {
    // `ui.prompt` used to return early, which would have meant anybody with a configured
    // prompt silently lost the indicator — the users most likely to have customized their
    // setup losing the safety signal is exactly backwards.
    const h = await harness({ prompt: 'mail$ ' });
    h.clear();
    h.session.emit({ kind: 'voice', phase: 'listening' });
    await h.settle();
    assert.match(h.raw(), /\[MIC LIVE\] mail\$/);
    await h.finish();
  });

  it('carries the state in words, not only in colour', async () => {
    // Colour is never load-bearing here. A screen reader gets none of it, and neither does
    // a monochrome terminal, a log file, or a pipe.
    const h = await harness({ color: 'always' });
    h.clear();
    h.session.emit({ kind: 'voice', phase: 'listening' });
    await h.settle();
    // eslint-disable-next-line no-control-regex
    const plain = h.raw().replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, '');
    assert.match(plain, /\[MIC LIVE\]/, 'the words must survive with every escape code removed');
    await h.finish();
  });
});
