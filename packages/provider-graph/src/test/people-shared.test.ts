/**
 * Who owns shared work, and who merely waits for it.
 *
 * The people provider caches its expensive answers as promises and hands the same promise
 * to everyone who asks — the signed-in user, the signal index, the chat roster. That is the
 * right call: they are slow, and the second caller should not repeat them. It also creates
 * a trap, which these tests exist to keep shut.
 *
 * The trap is that a shared promise built with a *caller's* AbortSignal quietly makes the
 * first caller its owner. Everyone who arrives afterwards is waiting on work that answers
 * to somebody else's signal, so when the first caller walks away — which happens all the
 * time, not just at shutdown; the engine aborts a coalesced listing whenever a user
 * navigates off a pane mid-list — every other caller receives a cancellation for something
 * they never cancelled.
 *
 * The rule this file enforces: a caller's signal reaches `raceAbort` and nothing else, and
 * shared work is built with the provider's own lifetime signal instead.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStateStore, NULL_LOGGER, type ProviderContext, type VNode } from '@mscomms/core';
import type { GraphApi, GraphPage, GraphRequestOptions } from '../client.js';
import { GraphPeopleProvider } from '../people.js';

function context(): ProviderContext {
  return {
    mountPath: '/people',
    logger: NULL_LOGGER,
    state: new MemoryStateStore(),
    cacheDir: '.',
    secret: () => Promise.resolve(undefined),
  };
}

/**
 * A Graph that takes its time and takes signals seriously.
 *
 * Both halves matter. Slow, so two callers genuinely overlap on one shared promise rather
 * than the second arriving after the first has already resolved; and signal-honouring,
 * because a fake that ignores aborts would pass these tests no matter how the provider is
 * wired.
 *
 * Every request settles on a timer rather than on a manual release, because a single
 * listing makes several requests in sequence and a fake that has to be released by hand
 * deadlocks on the second one.
 */
class SlowGraph implements GraphApi {
  readonly requests: string[] = [];
  readonly #delayMs: number;

  constructor(delayMs = 60) {
    this.#delayMs = delayMs;
  }

  async #park(path: string, options: GraphRequestOptions | undefined): Promise<void> {
    this.requests.push(path);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.#delayMs);
      options?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted by caller signal'));
        },
        { once: true },
      );
    });
  }

  async get<T>(path: string, options?: GraphRequestOptions): Promise<T> {
    await this.#park(path, options);
    return {
      id: 'me',
      displayName: 'Ada Lovelace',
      mail: 'ada@contoso.com',
      userPrincipalName: 'ada@contoso.com',
    } as unknown as T;
  }

  async getPage<T>(path: string, options?: GraphRequestOptions): Promise<GraphPage<T>> {
    await this.#park(path, options);
    return { value: [] };
  }

  async getBytes(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async post<T>(): Promise<T> {
    return {} as T;
  }

  async patch<T>(): Promise<T> {
    return {} as T;
  }
}

async function provider(graph: GraphApi): Promise<GraphPeopleProvider> {
  const made = new GraphPeopleProvider({}, context(), graph);
  await made.init();
  return made;
}

/** The `/people/Me` node, resolved without going near the network. */
async function meNode(people: GraphPeopleProvider): Promise<VNode> {
  const roots = await people.list(null, { limit: 20 });
  const me = roots.entries.find((entry) => entry.name === 'Me');
  assert.ok(me !== undefined, 'the Me section should exist');
  return me;
}

describe('GraphPeopleProvider: shared work and caller signals', () => {
  it('does not cancel one caller because another gave up', { timeout: 20_000 }, async () => {
    const graph = new SlowGraph();
    const people = await provider(graph);
    const node = await meNode(people);

    const impatient = new AbortController();
    const patient = new AbortController();

    // Both callers land on the same cached `/me` promise. Only the first has a signal that
    // could plausibly be mistaken for the work's own.
    const first = people.list(node, { limit: 10, signal: impatient.signal }).catch((error: unknown) => ({
      failed: String(error),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = people.list(node, { limit: 10, signal: patient.signal });

    impatient.abort();
    await first;

    // The patient caller never aborted, so it must get an answer rather than the other
    // caller's cancellation.
    await second;
    assert.equal(patient.signal.aborted, false);
  });

  it('still shares: the second caller does not re-fetch', { timeout: 20_000 }, async () => {
    // The companion property. It would be easy to "fix" the test above by giving every
    // caller its own request, which would also throw away the reason any of this is cached.
    const graph = new SlowGraph();
    const people = await provider(graph);
    const node = await meNode(people);

    const a = people.list(node, { limit: 10 });
    const b = people.list(node, { limit: 10 });
    await Promise.all([a, b]);

    const meCalls = graph.requests.filter((path) => path.startsWith('/me?') || path === '/me').length;
    assert.equal(meCalls, 1, `fetched /me ${String(meCalls)} times`);
  });

  it('lets go of shared work when the provider is disposed', { timeout: 20_000 }, async () => {
    // Shared work deliberately answers to no caller, so disposal is the only thing that can
    // stop it. Without this, quitting waits on a request nobody is going to read.
    const graph = new SlowGraph();
    const people = await provider(graph);
    const node = await meNode(people);

    const inFlight = people.list(node, { limit: 10 }).then(
      () => 'resolved',
      () => 'rejected',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = Date.now();
    await people.dispose();
    assert.equal(await inFlight, 'rejected');
    assert.ok(Date.now() - started < 5_000, 'disposal did not reach the shared work');
  });
});
