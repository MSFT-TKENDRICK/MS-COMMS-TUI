/**
 * Sharing one request between everyone who wants it.
 *
 * Prefetch is a bet that the user will arrive at a folder *while the guess about it is
 * still in the air*. Without coalescing that is the worst case rather than the best: the
 * foreground issues a second identical request, waits the full latency over again, and
 * doubles the load on the rate limit the prefetcher is already spending. Measured against
 * the real account, a mail folder listing is two sequential Graph calls, so the window
 * where this matters is most of a second on every first visit.
 *
 * The hard part is not the sharing, it is the cancellation. The prefetch queue cancels
 * speculative work on every navigation — routinely, by design. If that cancellation
 * reached a foreground caller who had joined the same request, prefetching would actively
 * break the thing it exists to accelerate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vfs, type Mount } from '../vfs.js';
import type { Capability, ListOptions, ListPage, Provider, VNode } from '../provider.js';

/** A provider whose listings do not finish until the test says so. */
class GatedProvider implements Provider {
  readonly id = 'gated';
  readonly displayName = 'gated';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read']);

  calls = 0;
  aborts = 0;
  // Cleared whenever it fires, so `pending()` waits for the *next* listing rather than
  // being satisfied by the last one and letting a test release a call that already ended.
  #gate: { resolve: () => void; reject: (error: Error) => void } | undefined;

  async list(_parent: VNode | null, options: ListOptions): Promise<ListPage> {
    this.calls += 1;
    await new Promise<void>((resolve, reject) => {
      this.#gate = { resolve, reject };
      options.signal?.addEventListener('abort', () => {
        this.aborts += 1;
        this.#gate = undefined;
        reject(new Error('aborted'));
      });
    });
    return { entries: [{ name: 'item', id: 'item', kind: 'file', title: 'item' }] };
  }

  read(node: VNode) {
    return Promise.resolve({ title: node.title, headers: [] as const, body: '', format: 'text' as const });
  }

  /** Let the pending listing finish. */
  release(): void {
    const gate = this.#gate;
    this.#gate = undefined;
    gate?.resolve();
  }

  fail(message: string): void {
    const gate = this.#gate;
    this.#gate = undefined;
    gate?.reject(new Error(message));
  }

  /** Resolves once a listing is actually pending, so tests never race the provider. */
  async pending(): Promise<void> {
    for (let i = 0; i < 200 && this.#gate === undefined; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(this.#gate !== undefined, 'expected a listing to be in flight');
  }
}

function gatedVfs(): { vfs: Vfs; provider: GatedProvider } {
  const vfs = new Vfs();
  const provider = new GatedProvider();
  const mount: Mount = { path: '/mail', id: 'mail', provider };
  vfs.mount(mount);
  return { vfs, provider };
}

describe('one request, however many callers', () => {
  it('asks the backend once when two callers want the same listing', async () => {
    const { vfs, provider } = gatedVfs();
    const first = vfs.list('/mail');
    await provider.pending();
    const second = vfs.list('/mail');
    provider.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(provider.calls, 1, 'the second caller should have joined, not duplicated');
    assert.equal(a.entries.length, 1);
    assert.equal(b.entries.length, 1);
  });

  it('lets a speculative fetch answer the real one that arrives mid-flight', async () => {
    // This is the entire point of prefetching. Arriving while the guess is in the air must
    // mean waiting for what is left of it, not starting again from nothing.
    const { vfs, provider } = gatedVfs();
    const speculative = vfs.list('/mail', { speculative: true });
    await provider.pending();
    const real = vfs.list('/mail');
    provider.release();
    await Promise.all([speculative, real]);
    assert.equal(provider.calls, 1);
  });

  it('does not share between callers who are asking different questions', async () => {
    const { vfs, provider } = gatedVfs();
    void vfs.list('/mail', { limit: 10 }).catch(() => undefined);
    await provider.pending();
    void vfs.list('/mail', { limit: 25 }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(provider.calls, 2, 'a different page size is a different request');
    await vfs.dispose();
  });

  it('keeps going for the caller who stayed when another gives up', async () => {
    // The prefetch queue cancels speculative work on every navigation. If that reached the
    // foreground caller who joined it, prefetch would be a liability rather than a help.
    const { vfs, provider } = gatedVfs();
    const controller = new AbortController();
    const leaving = vfs.list('/mail', { speculative: true, signal: controller.signal });
    await provider.pending();
    const staying = vfs.list('/mail');

    controller.abort();
    await assert.rejects(leaving, 'the caller who aborted should be released');

    // Let the event loop turn before releasing. A wrongful cancellation is scheduled, not
    // immediate, so releasing straight away would finish the request before the bug could
    // show and the test would pass against a broken implementation.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(provider.aborts, 0, 'the shared request must not have been cancelled');

    provider.release();
    const result = await staying;
    assert.equal(result.entries.length, 1, 'the remaining caller must still get an answer');
  });

  it('abandons the request once every caller has gone', async () => {
    // The flip side: a shared request with nobody left waiting is pure waste, and on a
    // metered corporate API it is waste with a bill attached.
    const { vfs, provider } = gatedVfs();
    const one = new AbortController();
    const two = new AbortController();
    const a = vfs.list('/mail', { signal: one.signal });
    await provider.pending();
    const b = vfs.list('/mail', { signal: two.signal });

    one.abort();
    await assert.rejects(a);
    two.abort();
    await assert.rejects(b);

    // A turn later than the last departure, because the grace period that protects a
    // joining caller also delays this.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(provider.aborts, 1, 'nobody is waiting, so the work should stop');
  });

  it('reports a failure to everyone who was waiting on it', async () => {
    const { vfs, provider } = gatedVfs();
    const first = vfs.list('/mail');
    await provider.pending();
    const second = vfs.list('/mail');
    provider.fail('the mailbox is unavailable');
    await assert.rejects(first);
    await assert.rejects(second);
  });

  it('starts fresh once the shared request is finished', async () => {
    // Sharing is only for requests in flight. A completed one is the cache's business, and
    // an entry left behind would serve a stale answer forever.
    const { vfs, provider } = gatedVfs();
    const first = vfs.list('/mail');
    await provider.pending();
    provider.release();
    await first;

    vfs.invalidate('/mail');
    const second = vfs.list('/mail');
    await provider.pending();
    provider.release();
    await second;
    assert.equal(provider.calls, 2, 'a later request must not be answered by a finished one');
  });

  it('survives the only caller having already given up', async () => {
    // The crash this guards against. A caller whose signal aborts while `list()` is still
    // walking to the provider — `invalidate()` cancelling a running prefetch, a search
    // deadline expiring — reaches the shared request already aborted and returns without
    // ever attaching a handler to it. The shared work is then cancelled a turn later and
    // rejects with nobody listening, which Node treats as fatal: the whole process dies,
    // taking the user's session with it, because a speculative fetch was cancelled.
    const { vfs, provider } = gatedVfs();
    const controller = new AbortController();
    const doomed = vfs.list('/mail', { signal: controller.signal });
    controller.abort();
    await assert.rejects(doomed);

    // Let the deferred cancellation land, then confirm the process is still healthy enough
    // to answer the next question. Under the bug the test run itself does not get here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = vfs.list('/mail');
    await provider.pending();
    provider.release();
    assert.equal((await next).entries.length, 1);
  });

  it('survives the backend failing after everyone has gone', async () => {
    // The same shape arriving from the provider's side: the request fails on its own after
    // the last caller left.
    //
    // Worth stating plainly that this one is weaker than its neighbour. The catch added at
    // creation covers it, but so does the abort path's own handling, so it does not fail on
    // its own when that catch is removed. It is here to pin the behaviour — a request that
    // outlives its callers and then fails must not take the process with it — rather than
    // because it is the test that caught the bug.
    const { vfs, provider } = gatedVfs();
    const controller = new AbortController();
    const doomed = vfs.list('/mail', { signal: controller.signal });
    await provider.pending();
    controller.abort();
    await assert.rejects(doomed);
    provider.fail('the mailbox is unavailable');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = vfs.list('/mail');
    await provider.pending();
    provider.release();
    assert.equal((await next).entries.length, 1);
  });
});
