/**
 * Starting up without making anyone wait for it.
 *
 * The behaviour under test is a promise about *time*: the pane is drawn, and a key can be
 * pressed, before the sources have connected. That promise is easy to make and easy to lose
 * — one `await` moved above the first paint puts the blank terminal straight back — so the
 * two assertions that matter here are wall-clock ones against a provider that never answers.
 *
 * The rest is the reporting. What a user is told while they wait is a decision rather than a
 * detail, and these functions are pure precisely so that decision can be asserted without a
 * terminal: which check is named, when "and 2 more" replaces the names, and whether a
 * session with one dead source out of four reads as working or as broken.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  NULL_LOGGER,
  PluginRegistry,
  DEFAULT_CONFIG,
  type AppConfig,
  type AppPaths,
  type Capability,
  type ListPage,
  type ProviderPlugin,
  type VNode,
} from '@mscomms/core';

import { Session } from '../session.js';
import {
  StartupTasks,
  bridgeLauncherTasks,
  externalTasks,
  isLauncherTaskMessage,
  isSettled,
  ownTasks,
  readySummary,
  startupLine,
  startupRows,
  type StartupTask,
} from '../startup.js';

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/startup/${name}`;
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

/**
 * The whole point, expressed as a number.
 *
 * Startup used to be seconds of blank terminal on a machine with real sources. This is the
 * budget for handing control back, and it is deliberately far below anything a human reads
 * as a pause: the test double below never answers at all, so anything that still waits for
 * a mount fails this by orders of magnitude rather than by a few milliseconds.
 */
const INSTANT_MS = 150;

const TEST_TIMEOUT_MS = 15_000;

/**
 * A source that never finishes connecting — the shape of a service that has stopped talking.
 *
 * The hang is in `create`, which is where a real one is: connecting is what costs the
 * seconds, and a provider that is still shaking hands is exactly the state startup used to
 * hold the whole terminal hostage for.
 */
const hangingPlugin: ProviderPlugin<Record<string, never>> = {
  type: 'hanging',
  displayName: 'Hanging feed',
  description: 'Test double: never finishes connecting.',
  validateOptions: () => ({}) as Record<string, never>,
  create: (): Promise<never> => new Promise<never>(() => undefined),
};

/** The same, but with a hand on the switch, so a test can decide when connecting finishes. */
function gatedPlugin(): { plugin: ProviderPlugin<Record<string, never>>; connect: () => void } {
  let release = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });

  return {
    connect: () => {
      release();
    },
    plugin: {
      type: 'gated',
      displayName: 'Gated feed',
      description: 'Test double: connects when the test says so.',
      validateOptions: () => ({}) as Record<string, never>,
      create: async () => {
        await opened;
        return {
          id: 'gated',
          displayName: 'Gated feed',
          capabilities: new Set<Capability>(['list']),
          list: async (_parent: VNode | null): Promise<ListPage> => ({ entries: [], total: 0 }),
        };
      },
    },
  };
}

function sessionWith(plugin: ProviderPlugin<Record<string, never>>, path: string): Session {
  const registry = new PluginRegistry(NULL_LOGGER);
  registry.register(plugin);

  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    mounts: [{ id: 'source', path, type: plugin.type, options: {} }],
    ui: { ...DEFAULT_CONFIG.ui, plain: true, color: 'never' },
  };

  return new Session({
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
}

function hangingSession(): Session {
  return sessionWith(hangingPlugin, '/stuck');
}

/** A task in a fixed state, so the reporters can be tested without running anything. */
function task(overrides: Partial<StartupTask> & { readonly id: string; readonly label: string }): StartupTask {
  return {
    state: 'pending',
    detail: undefined,
    blocking: false,
    external: false,
    startedAt: undefined,
    endedAt: undefined,
    ...overrides,
  };
}

/** Wait for a condition rather than for a duration, so a slow machine is not a failure. */
async function until(condition: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('condition never became true');
    await delay(5);
  }
}

// ---------------------------------------------------------------------------

describe('startup is not something the user waits for', () => {
  it('hands control back immediately, even when a source never answers', { timeout: TEST_TIMEOUT_MS }, async () => {
    const session = hangingSession();

    const startedAt = Date.now();
    session.begin();
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed < INSTANT_MS,
      `begin() took ${String(elapsed)}ms; it must not wait for the sources it starts`,
    );
    // …and it really is still going, or the assertion above proves nothing.
    assert.equal(session.tasks.ready, false, 'the mounts should still be outstanding');
    assert.ok(startupLine(session.tasks.snapshot()) !== undefined, 'should have something to report');

    await session.dispose();
  });

  it('says what it is checking while it checks it', { timeout: TEST_TIMEOUT_MS }, async () => {
    const session = hangingSession();
    session.begin();

    // Declared before they run, so the list is complete from the first frame rather than
    // appearing one entry at a time.
    const ids = session.tasks.snapshot().map((entry) => entry.id);
    assert.ok(ids.includes('workspace'), `should declare the workspace check; saw ${ids.join(', ')}`);
    assert.ok(ids.includes('mounts'), `should declare the mounts check; saw ${ids.join(', ')}`);

    const first = startupLine(session.tasks.snapshot()) ?? '';
    assert.match(first, /Preparing the workspace/, 'the first line should name the check that is running');
    assert.match(first, /queued/, 'and account for the ones behind it');

    // The line follows the work rather than being written once: by the time the sources are
    // the thing being waited for, that is what it says.
    await until(() => session.tasks.get('mounts')?.state === 'running');
    assert.match(startupLine(session.tasks.snapshot()) ?? '', /Connecting sources/);

    await session.dispose();
  });

  it('holds a command until the sources exist, then releases it', { timeout: TEST_TIMEOUT_MS }, async () => {
    const gate = gatedPlugin();
    const session = sessionWith(gate.plugin, '/gated');
    session.begin();

    let ready = false;
    const waiting = session.ready().then(() => {
      ready = true;
    });

    await delay(20);
    assert.equal(ready, false, 'a command must not be answered against sources that do not exist yet');

    gate.connect();
    await waiting;
    assert.equal(ready, true);
    // The cwd moves during this step — one source means the user lands inside it — which is
    // why anything reading it has to read it after the wait, not before.
    assert.equal(session.cwd, '/gated');
    assert.equal(session.tasks.get('mounts')?.detail, '1 source');

    await session.dispose();
  });

  it('lets go of a hung startup rather than making quit wait for it', { timeout: TEST_TIMEOUT_MS }, async () => {
    const session = hangingSession();
    session.begin();

    const startedAt = Date.now();
    await session.dispose();
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 2000, `dispose() took ${String(elapsed)}ms while startup was still running`);
  });
});

/**
 * `--demo` is the case this exists for, and it used to be written as `await session.ready()`
 * followed by mounting, in front of the user, before any interface was constructed. That is
 * the original bug wearing a different hat: the screen stayed blank for exactly as long as
 * connecting the real sources took.
 */
describe('a step the caller adds to startup', () => {
  it('is queued rather than waited for, and still runs after the mounts', { timeout: TEST_TIMEOUT_MS }, async () => {
    const gate = gatedPlugin();
    const session = sessionWith(gate.plugin, '/gated');

    const order: string[] = [];
    const startedAt = Date.now();
    session.enqueue(
      'extra',
      'Mounting the sample data',
      async () => {
        order.push('extra');
        return '4 sample mounts';
      },
      { blocking: true },
    );
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < INSTANT_MS, `enqueue() took ${String(elapsed)}ms; it must not run the step`);
    // In the list from the first frame, like everything else, so the pane can name it.
    assert.equal(session.tasks.get('extra')?.state, 'pending');
    assert.equal(session.tasks.ready, false, 'a blocking step must hold commands until it runs');

    gate.connect();
    await session.ready();

    assert.deepEqual(order, ['extra']);
    assert.equal(session.tasks.get('extra')?.detail, '4 sample mounts');
    // The ordering constraint is the whole reason it is a queue and not a second promise.
    const mountsEndedAt = session.tasks.get('mounts')?.endedAt ?? 0;
    const extraStartedAt = session.tasks.get('extra')?.startedAt ?? 0;
    assert.ok(extraStartedAt >= mountsEndedAt, 'the added step must run after the sources are connected');

    await session.dispose();
  });

  it('does not run a queued step for a session that is being torn down', { timeout: TEST_TIMEOUT_MS }, async () => {
    const gate = gatedPlugin();
    const session = sessionWith(gate.plugin, '/gated');

    let releaseFirst = (): void => undefined;
    const firstRunning = new Promise<void>((running) => {
      session.enqueue('first', 'Doing the first thing', async () => {
        running();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      });
    });

    let second = false;
    session.enqueue('second', 'Doing the second thing', async () => {
      second = true;
    });

    gate.connect();
    await firstRunning;

    // Quitting mid-step. What is already running has to finish on its own terms, but what
    // has not started must not: a queue that keeps working after dispose is a process that
    // does not exit, and steps like these touch the mounts it is tearing down.
    const disposing = session.dispose();
    releaseFirst();
    await disposing;
    await delay(20);

    assert.equal(second, false, 'quitting should abandon what has not started');
    assert.equal(session.tasks.get('second')?.state, 'pending');
  });
});

/**
 * Output redirection stopped nesting neatly the moment startup moved into the background.
 *
 * Before, the only thing that redirected was a command running inside the pane: one at a
 * time, in and finished. Now a startup step can start printing before the user types
 * something and stop in the middle of it, and the old save-and-restore pair got that case
 * catastrophically wrong — the outer frame reinstated a sink that had already been torn
 * down, and everything printed afterwards vanished.
 */
describe('two things redirecting output at once', () => {
  function quietSession(): Session {
    return sessionWith(hangingPlugin, '/stuck');
  }

  it('keeps the outer redirection when an inner one ends first', async () => {
    const written: string[] = [];
    const session = quietSession();
    const stop = session.redirect((text) => written.push(text));

    let endInner = (): void => undefined;
    const inner = session.capture(async () => {
      await new Promise<void>((resolve) => {
        endInner = resolve;
      });
    });

    // The inner frame ends while nothing else is nested on top of it.
    endInner();
    assert.equal(await inner, '');

    session.print('after');
    assert.deepEqual(written, ['after\n'], 'the pane must still own the terminal');

    stop();
    await session.dispose();
  });

  it('keeps the inner redirection when an outer one ends first', async () => {
    const written: string[] = [];
    const session = quietSession();
    const stop = session.redirect((text) => written.push(text));

    let endInner = (): void => undefined;
    const inner = session.capture(async () => {
      await new Promise<void>((resolve) => {
        endInner = resolve;
      });
      session.print('mine');
    });

    // The pane closes while a command it started is still running — the shape that used to
    // leave the session writing into a buffer nobody would ever read.
    stop();
    endInner();
    assert.equal(await inner, 'mine\n', 'the command should still be collecting its own output');

    session.print('after');
    assert.deepEqual(written, [], 'and the finished redirection must not still be collecting');

    await session.dispose();
  });

  it('still fires beforeFirstWrite when a background step prints in the middle', async () => {
    const session = quietSession();
    let fired = 0;

    await session.beforeFirstWrite(
      () => {
        fired += 1;
      },
      async () => {
        // A startup step captures and releases while the command is still running.
        await session.capture(async () => {
          session.print('background');
        });
        session.print('mine');
        session.print('again');
      },
    );

    assert.equal(fired, 1, 'the indicator is erased once, just before the first real byte');
    await session.dispose();
  });
});

describe('startup tasks', () => {
  it('moves a check from queued to running to finished', async () => {
    const tasks = new StartupTasks();
    tasks.declare('a', 'Checking things');
    assert.equal(tasks.get('a')?.state, 'pending');

    const seen: string[] = [];
    const done = tasks.run('a', 'Checking things', async () => {
      seen.push(tasks.get('a')?.state ?? '?');
      return '3 things';
    });
    await done;

    assert.deepEqual(seen, ['running'], 'the state should be observable while the body runs');
    assert.equal(tasks.get('a')?.state, 'ok');
    assert.equal(tasks.get('a')?.detail, '3 things', 'a bare string result is the detail');
  });

  it('records a thrown error as a failed check instead of taking the process down', async () => {
    const tasks = new StartupTasks();
    await tasks.run('a', 'Opening the cache', async () => {
      throw new Error('disk full');
    });

    assert.equal(tasks.get('a')?.state, 'failed');
    assert.equal(tasks.get('a')?.detail, 'disk full');
    assert.equal(tasks.settled, true, 'a failure still settles; nothing here is allowed to hang');
  });

  it('is ready once the blocking checks are done, whatever else is still running', async () => {
    const tasks = new StartupTasks();
    tasks.declare('mounts', 'Connecting sources', { blocking: true });
    tasks.declare('cache', 'Opening the local cache');

    assert.equal(tasks.ready, false);
    tasks.record('mounts', 'Connecting sources', { state: 'ok', detail: '2 sources' });

    assert.equal(tasks.ready, true, 'a background improvement must not gate interaction');
    assert.equal(tasks.settled, false, 'but it is not finished either');
  });

  it('waits again when a blocking check arrives after the first one finished', async () => {
    const tasks = new StartupTasks();
    tasks.record('mounts', 'Connecting sources', { state: 'ok' });
    await tasks.whenReady();

    tasks.declare('late', 'Connecting a source added later', { blocking: true });
    assert.equal(tasks.ready, false, 'readiness is a fact about now, not a latch');

    let resolved = false;
    const waiting = tasks.whenReady().then(() => {
      resolved = true;
    });
    await delay(10);
    assert.equal(resolved, false);

    tasks.record('late', 'Connecting a source added later', { state: 'ok' });
    await waiting;
    assert.equal(resolved, true);
  });

  it('tells watchers every time something changes, and stops when they leave', () => {
    const tasks = new StartupTasks();
    let calls = 0;
    const unsubscribe = tasks.subscribe(() => {
      calls += 1;
    });

    tasks.declare('a', 'Checking');
    tasks.record('a', 'Checking', { state: 'ok' });
    assert.equal(calls, 2);

    unsubscribe();
    tasks.record('b', 'Checking again', { state: 'ok' });
    assert.equal(calls, 2, 'an unsubscribed watcher must not still be painting');
  });

  it('knows which states are over', () => {
    assert.equal(isSettled(task({ id: 'a', label: 'A', state: 'running' })), false);
    assert.equal(isSettled(task({ id: 'a', label: 'A', state: 'pending' })), false);
    for (const state of ['ok', 'warn', 'failed', 'skipped'] as const) {
      assert.equal(isSettled(task({ id: 'a', label: 'A', state })), true, state);
    }
  });
});

describe('what the user is told while waiting', () => {
  it('names what is running rather than counting it', () => {
    const line = startupLine([
      task({ id: 'a', label: 'Connecting sources', state: 'running' }),
      task({ id: 'b', label: 'Opening the local cache', state: 'pending' }),
    ]);

    assert.match(line ?? '', /Connecting sources/);
    assert.match(line ?? '', /1 queued/, 'work that has not started yet should be acknowledged');
    assert.ok(!(line ?? '').includes('Opening the local cache'), 'a queued check is not what it is doing');
  });

  it('falls back to a count once naming everything would be a paragraph', () => {
    const line = startupLine([
      task({ id: 'a', label: 'Connecting sources', state: 'running' }),
      task({ id: 'b', label: 'Opening the local cache', state: 'running' }),
      task({ id: 'c', label: 'Restarting watches', state: 'running' }),
      task({ id: 'd', label: 'Rebuilding', state: 'running' }),
    ]);

    assert.match(line ?? '', /and 2 more/);
  });

  it('keeps moving, because a caption that never changes reads as a hang', () => {
    const tasks = [task({ id: 'a', label: 'Connecting sources', state: 'running' })];
    assert.notEqual(startupLine(tasks, 0), startupLine(tasks, 1));
  });

  it('says nothing at all once everything has settled', () => {
    assert.equal(startupLine([task({ id: 'a', label: 'A', state: 'ok' })]), undefined);
    assert.equal(startupLine([]), undefined);
  });

  it('reports what was found, not just that it finished', () => {
    const summary = readySummary([
      task({ id: 'mounts', label: 'Connecting sources', state: 'ok', detail: '4 sources' }),
      task({ id: 'cache', label: 'Opening the local cache', state: 'ok', detail: 'local cache on' }),
    ]);

    assert.match(summary, /^Ready\./);
    assert.match(summary, /4 sources and local cache on/);
  });

  it('names a problem after the successes, so a mostly-working session does not read as broken', () => {
    const summary = readySummary([
      task({ id: 'mounts', label: 'Connecting sources', state: 'ok', detail: '3 of 4 sources' }),
      task({ id: 'cache', label: 'Opening the local cache', state: 'failed', detail: 'disk full' }),
    ]);

    assert.ok(summary.startsWith('Ready. 3 of 4 sources.'), summary);
    assert.match(summary, /One problem: opening the local cache — disk full\./);
  });

  it('still says something useful when there was nothing to report', () => {
    assert.equal(readySummary([]), 'Ready.');
  });

  it('reports every check, with what it cost, for anyone asking', () => {
    const rows = startupRows([
      task({ id: 'a', label: 'Connecting sources', state: 'ok', detail: '2 sources', startedAt: 100, endedAt: 350 }),
      task({ id: 'b', label: 'Restarting watches', state: 'skipped' }),
      task({ id: 'c', label: 'Reading the config', state: 'ok', detail: '', startedAt: 10, endedAt: 10 }),
      task({ id: 'd', label: 'Opening the local cache', state: 'failed', detail: 'disk full' }),
    ]);

    assert.deepEqual(rows[0], {
      name: 'startup: connecting sources',
      status: 'ok',
      detail: '2 sources in 250 ms',
    });
    // Nothing ran, so there is no duration to invent and no detail to pad around.
    assert.deepEqual(rows[1], { name: 'startup: restarting watches', status: 'ok', detail: 'skipped' });
    // A check that succeeded with nothing to add still has to say *something*.
    assert.deepEqual(rows[2], { name: 'startup: reading the config', status: 'ok', detail: 'ok in 0 ms' });
    assert.equal(rows[3]?.status, 'fail', 'a failed check is a problem doctor should count');
  });
});

describe('checks performed by whatever launched us', () => {
  it('recognises a launcher message and rejects anything else', () => {
    assert.equal(isLauncherTaskMessage({ type: 'mscomms:task', id: 'build', label: 'Building', state: 'ok' }), true);
    assert.equal(isLauncherTaskMessage({ type: 'other', id: 'build', label: 'Building', state: 'ok' }), false);
    assert.equal(isLauncherTaskMessage({ type: 'mscomms:task', id: 'build', label: 'Building', state: 'nope' }), false);
    assert.equal(isLauncherTaskMessage('hello'), false);
    assert.equal(isLauncherTaskMessage(null), false);
  });

  it('shows the launcher’s work in the same list as its own', () => {
    const tasks = new StartupTasks();
    const source = new EventEmitter() as unknown as EventEmitter & { channel?: { unref?: () => void } };
    let unreffed = false;
    source.channel = {
      unref: () => {
        unreffed = true;
      },
    };

    const unbridge = bridgeLauncherTasks(tasks, source);
    // An IPC channel is a live handle. A process that stays up because its parent *might*
    // send another progress message is a process that does not exit when told to quit.
    assert.equal(unreffed, true, 'the channel MUST be unreferenced');

    source.emit('message', { type: 'mscomms:task', id: 'build', label: 'Checking for source changes', state: 'pending' });
    assert.equal(tasks.get('build')?.state, 'pending');
    assert.equal(tasks.get('build')?.external, true, 'anything arriving over IPC belongs to the launcher');
    assert.equal(tasks.settled, false, 'a launcher check counts as outstanding like any other');

    source.emit('message', {
      type: 'mscomms:task',
      id: 'build',
      label: 'Checking for source changes',
      state: 'warn',
      detail: 'rebuilt — restart to run the new code',
    });
    assert.equal(tasks.get('build')?.state, 'warn');
    assert.equal(tasks.get('build')?.external, true, 'the flag must survive the transition out of pending');
    assert.match(readySummary(tasks.snapshot()), /restart to run the new code/);

    source.emit('message', 'not for us');
    unbridge();
    source.emit('message', { type: 'mscomms:task', id: 'late', label: 'Too late', state: 'ok' });
    assert.equal(tasks.get('late'), undefined, 'unbridging should stop the listener');
  });

  /**
   * The reason `external` exists at all.
   *
   * The launcher now starts the app first and rebuilds behind it, and that rebuild is
   * measured in seconds. If it counted towards readiness, moving the compile off the
   * critical path would have achieved nothing: the "Ready" line — and, worse, every command
   * gated on it — would simply wait for the compile in its new home instead of its old one.
   */
  it('does not let the launcher hold up this session’s readiness', () => {
    const tasks = new StartupTasks();
    tasks.record('config', 'Reading the config', { state: 'ok' });
    tasks.declare('build', 'Checking for source changes', { external: true });

    assert.equal(tasks.finished, true, 'our own checks are done, so we are ready to be used');
    assert.equal(tasks.ready, true);
    assert.equal(tasks.settled, false, 'but something somewhere is still running');

    assert.deepEqual(
      ownTasks(tasks.snapshot()).map((t) => t.id),
      ['config'],
    );
    assert.deepEqual(
      externalTasks(tasks.snapshot()).map((t) => t.id),
      ['build'],
    );
  });

  it('keeps showing the launcher’s work after its own is done', () => {
    const tasks = new StartupTasks();
    tasks.record('config', 'Reading the config', { state: 'ok' });
    tasks.record('build', 'Checking for source changes', { state: 'running', external: true });

    assert.equal(startupLine(ownTasks(tasks.snapshot()), 0), undefined, 'nothing of ours left to report');
    assert.match(String(startupLine(externalTasks(tasks.snapshot()), 0)), /Checking for source changes/);
  });
});
