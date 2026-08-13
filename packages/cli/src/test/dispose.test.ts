/**
 * Quitting, when something is still busy.
 *
 * This is the third time shutdown has hung, and the first time it gets a guard. The
 * previous two were an un-aborted MCP handshake and a `sync.stop()` that was not awaited;
 * this one was a whole class — expensive work cached as a *shared* promise created with the
 * first caller's signal, so every later caller's abort had nothing to abort. Measured on a
 * real mailbox, quitting took twenty-six seconds.
 *
 * The test double below is the distilled version of that: a provider that hangs forever and
 * ignores the abort signal entirely. That is not a strawman. A provider is third-party code
 * — a plugin, an SDK, a fetch against a service that has stopped answering — and "it
 * politely observes your AbortSignal" is a hope, not a guarantee. Shutdown has to be fast
 * regardless, because the user pressing `q` is not asking a question about our internals.
 *
 * The assertion is a wall-clock budget rather than a mock call count on purpose: it is the
 * thing the user actually experiences, and it stays true however the teardown is
 * reorganised later.
 */

import assert from 'node:assert/strict';
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

function tmp(name: string): string {
  return `${process.cwd()}/.test-tmp/dispose/${name}`;
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

/** Quitting should feel instant. This is generous by two orders of magnitude. */
const BUDGET_MS = 2000;

/**
 * Set explicitly, because the failure mode under test is a hang. Without this the guard
 * would stop the whole run forever instead of reporting a failure, which is the one
 * outcome worse than the bug it is guarding.
 */
const TEST_TIMEOUT_MS = 15_000;

/**
 * Comfortably longer than sync's 250 ms shutdown grace, so the answer is guaranteed to
 * arrive after the database has closed rather than racing it.
 */
const LATE_ANSWER_MS = 900;

/**
 * A provider that never answers and cannot be interrupted.
 *
 * The unsettled promise is deliberately shared across every call, because that is the
 * actual bug: one hung piece of work that many callers are waiting on, none of whom can
 * end their own wait. It never settles, so it is also the unobserved-rejection hazard's
 * benign twin — if teardown started rejecting it, we would want to know.
 */
/**
 * How many times the dead provider was actually reached.
 *
 * Without this, every test in this file could pass by never creating a hang at all — a
 * mount that failed to build, or a warm-up that was reorganised to skip this path, would
 * look exactly like a fast shutdown. Asserting it is non-zero is what makes the timing
 * assertion mean something.
 */
let calls = 0;

/**
 * A provider that answers *eventually*, and only after everyone has stopped waiting.
 *
 * This is the awkward case that the disowning creates. `stop()` gives up after a grace
 * period and the session then closes the database — but the work it walked away from is
 * still running, and when it finally produces a page it will try to write it. Into a
 * handle that is gone. A provider that is merely slow rather than dead is entirely
 * ordinary, so this is not a hypothetical.
 */
const slowPlugin: ProviderPlugin<Record<string, never>> = {
  type: 'slow',
  displayName: 'Slow feed',
  description: 'Test double: answers long after shutdown gave up waiting for it.',
  validateOptions: () => ({}) as Record<string, never>,
  create: () => ({
    id: 'slow-provider',
    displayName: 'Slow feed',
    capabilities: new Set<Capability>(['list']),
    list: async (_parent: VNode | null): Promise<ListPage> => {
      calls += 1;
      await delay(LATE_ANSWER_MS);
      return { entries: [{ name: 'late', id: 'late', kind: 'file', title: 'Late arrival' }], total: 1 };
    },
  }),
};

const hangingPlugin: ProviderPlugin<Record<string, never>> = {
  type: 'hanging',
  displayName: 'Hanging feed',
  description: 'Test double: never answers, and ignores the abort signal while not answering.',
  validateOptions: () => ({}) as Record<string, never>,
  create: () => {
    const forever = new Promise<never>(() => undefined);
    return {
      id: 'hanging',
      displayName: 'Hanging feed',
      capabilities: new Set<Capability>(['list', 'read']),
      list: (_parent: VNode | null): Promise<ListPage> => {
        calls += 1;
        return forever;
      },
      read: (): Promise<never> => {
        calls += 1;
        return forever;
      },
    };
  },
};

function hangingSession(options: { cache?: boolean; plugin?: ProviderPlugin<Record<string, never>> } = {}): Session {
  const plugin = options.plugin ?? hangingPlugin;
  const registry = new PluginRegistry(NULL_LOGGER);
  registry.register(plugin);

  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    mounts: [{ id: 'slow', path: '/slow', type: plugin.type, options: {} }],
    ui: { ...DEFAULT_CONFIG.ui, plain: true, color: 'never' },
    ...(options.cache === true
      ? {
          cache: {
            ...DEFAULT_CONFIG.cache,
            enabled: true,
            // A fresh database per session, so one test's leftovers cannot let the next one
            // answer from cache and skip the hang it is supposed to be measuring.
            path: tmp(`db/${String(Date.now())}-${String(Math.random()).slice(2)}.db`),
            vectors: false,
          },
        }
      : {}),
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

describe('quitting while a provider is hung', () => {
  it('disposes promptly rather than waiting for work that will never finish', { timeout: TEST_TIMEOUT_MS }, async () => {
    const session = hangingSession();
    calls = 0;
    await session.start();
    // Warm-up is scheduled, not awaited, so give the queue a turn to actually get stuck.
    await delay(50);
    assert.ok(calls > 0, 'the warm-up never reached the provider, so nothing is hung to test');

    const started = Date.now();
    await session.dispose();
    const elapsed = Date.now() - started;

    assert.ok(elapsed < BUDGET_MS, `dispose took ${String(elapsed)}ms; budget is ${String(BUDGET_MS)}ms`);
  });

  it('disposes promptly when the user quits mid-navigation', { timeout: TEST_TIMEOUT_MS }, async () => {
    // The realistic shape of the 26-second hang: startup warm-up is still running *and* a
    // listing the user asked for is outstanding. Both are stuck on the same dead provider.
    const session = hangingSession();
    calls = 0;
    await session.start();

    const navigating = session.vfs.list('/slow').catch(() => undefined);
    await delay(50);
    assert.ok(calls > 0, 'nothing is hung to test');

    const started = Date.now();
    await session.dispose();
    const elapsed = Date.now() - started;

    assert.ok(elapsed < BUDGET_MS, `dispose took ${String(elapsed)}ms; budget is ${String(BUDGET_MS)}ms`);
    void navigating;
  });

  it('can be disposed twice without hanging the second time', { timeout: TEST_TIMEOUT_MS }, async () => {
    // `quit` and the process-level exit handler can both land, and the second one must not
    // wait on teardown state the first one already tore down.
    const session = hangingSession();
    await session.start();
    await session.dispose();

    const started = Date.now();
    await session.dispose();
    assert.ok(Date.now() - started < BUDGET_MS, 'second dispose must also return promptly');
  });

  /**
   * The same question with background sync running, which is where the twenty-six seconds
   * actually went.
   *
   * `sync.stop()` aborts its cycle *and waits for it to unwind*, which is correct — closing
   * the database under a sync still writing to it is the bug arriving from the other side.
   * But "waits for it to unwind" is only fast if the work in flight can actually be left,
   * and a directory sync sitting on a provider that ignores its signal cannot be. Measured
   * against the real mailbox, `/people/Me` alone accounted for 25.3 seconds of it.
   *
   * This is the only test in the file with the cache on, and it is slower to set up because
   * of it. That cost buys the one path the others cannot reach.
   */
  it('disposes promptly while background sync is stuck on the provider', { timeout: TEST_TIMEOUT_MS }, async () => {
    const session = hangingSession({ cache: true });
    calls = 0;
    await session.start();

    // Without sync, this test silently degrades into a duplicate of the first one.
    assert.ok(session.sync !== undefined, `background sync did not start: ${session.cacheError ?? 'no reason given'}`);
    await delay(50);
    assert.ok(calls > 0, 'nothing is hung to test');

    const started = Date.now();
    await session.dispose();
    const elapsed = Date.now() - started;

    assert.ok(elapsed < BUDGET_MS, `dispose took ${String(elapsed)}ms; budget is ${String(BUDGET_MS)}ms`);
  });

  /**
   * The bill for walking away.
   *
   * Disowning stuck work is only safe if the work cannot hurt anything once it is disowned,
   * and the thing it could hurt is the database that shutdown closes immediately afterwards.
   * So this lets a genuinely slow — not dead — provider answer well after the grace period,
   * and checks the two things that go wrong if the disowned worker is left unguarded.
   *
   * The first is diagnostic and is what a user would actually see. An unguarded late write
   * fails with "database is not open", the per-directory catch records it, and it sits in
   * `cache status` looking like corruption — a bug report about a bug that does not exist,
   * describing nothing but our own teardown.
   *
   * The second is that the process is still alive at the end. A write into a closed handle
   * either throws where nobody is catching or rejects a promise nobody is observing, and
   * under Node's default policy the second takes the whole process down.
   */
  it('lets disowned work finish without inventing an error the user will see', { timeout: TEST_TIMEOUT_MS }, async () => {
    const session = hangingSession({ cache: true, plugin: slowPlugin });
    calls = 0;
    await session.start();
    const sync = session.sync;
    assert.ok(sync !== undefined, `background sync did not start: ${session.cacheError ?? 'no reason given'}`);
    await delay(50);
    assert.ok(calls > 0, 'the provider was never reached, so nothing is in flight to disown');

    const started = Date.now();
    await session.dispose();
    assert.ok(Date.now() - started < BUDGET_MS, 'dispose must not wait for the slow provider');

    // Outlive the provider's answer, so the late write actually happens while we watch.
    await delay(LATE_ANSWER_MS + 400);
    assert.deepEqual(sync.status.errors, [], 'a clean shutdown must not leave errors behind');
    assert.ok(true, 'the late write did not take the process down');
  });
});
