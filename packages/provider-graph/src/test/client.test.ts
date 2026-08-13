/**
 * What the HTTP client promises a caller who walks away.
 *
 * These are shutdown tests wearing a network costume. A retry loop is the one place in this
 * package where a single call can outlive its usefulness several times over — it holds the
 * caller's signal across an unbounded number of attempts, and each attempt has three
 * separate places it can sit and wait: getting a token, the request itself, and the
 * back-off between attempts. Two of those three used to ignore the signal entirely, and the
 * listener that watched the third was re-registered every pass and never removed.
 *
 * Nothing here talks to Graph. `fetch` is replaced wholesale, because the point is not what
 * Graph says but what this loop does while it waits to hear it.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { VfsError } from '@mscomms/core';
import { GraphClient } from '../client.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A `fetch` that runs `onCall` and then does whatever the caller asked for. */
function stubFetch(handler: (call: number) => Promise<Response>): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls += 1;
    return handler(calls);
  }) as typeof fetch;
  return { calls: () => calls };
}

function ok(body: unknown = { value: [] }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function throttled(retryAfterSeconds: number): Response {
  return new Response('', { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } });
}

function client(overrides: { getToken?: () => Promise<string>; maxRetries?: number } = {}): GraphClient {
  return new GraphClient({
    getToken: overrides.getToken ?? ((): Promise<string> => Promise.resolve('token')),
    maxRetries: overrides.maxRetries ?? 2,
  });
}

describe('GraphClient: giving up', () => {
  it('does not accumulate abort listeners across retries', async () => {
    const signal = new AbortController().signal;
    const seen: number[] = [];

    stubFetch(async () => {
      seen.push(getEventListeners(signal, 'abort').length);
      throw new Error('connection reset');
    });

    await assert.rejects(client().get('/me', { signal }));

    // Three attempts, and the loop should be watching the signal exactly once during each.
    // Before the fix this read [1, 2, 3]: every pass added a listener that outlived it, so
    // a long-lived warm-up signal covering many requests grew a listener per attempt.
    assert.deepEqual(seen, [1, 1, 1], `listener count per attempt was ${JSON.stringify(seen)}`);
  });

  it('leaves no listener behind on a request that succeeded', async () => {
    const signal = new AbortController().signal;
    stubFetch(async () => ok());

    await client().get('/me', { signal });

    assert.equal(getEventListeners(signal, 'abort').length, 0);
  });

  it('leaves no listener behind on a request that failed', async () => {
    const signal = new AbortController().signal;
    stubFetch(async () => new Response('', { status: 404 }));

    await assert.rejects(client().get('/me', { signal }));

    assert.equal(getEventListeners(signal, 'abort').length, 0);
  });

  it('stops waiting on a throttle back-off instead of sitting out the retry-after', { timeout: 20_000 }, async () => {
    // Graph is entitled to say "come back in half a minute". It is not entitled to make
    // quitting take half a minute, which is exactly what a bare timer in the retry loop did.
    const controller = new AbortController();
    stubFetch(async () => throttled(30));

    const started = Date.now();
    const inFlight = client({ maxRetries: 5 }).get('/me', { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);

    await assert.rejects(inFlight, (error: unknown) => {
      assert.ok(error instanceof VfsError);
      assert.equal(error.code, 'ECANCELED');
      return true;
    });

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `took ${String(elapsed)}ms, so it sat through the back-off`);
  });

  it('does not issue another request after the caller has gone', { timeout: 20_000 }, async () => {
    const controller = new AbortController();
    const fetches = stubFetch(async () => throttled(1));

    const inFlight = client({ maxRetries: 5 }).get('/me', { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await assert.rejects(inFlight);

    const afterAbort = fetches.calls();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(fetches.calls(), afterAbort, 'the loop went round again after being cancelled');
  });

  it('stops waiting for a token nobody else is going to deliver', { timeout: 20_000 }, async () => {
    // `getToken` is shared between callers, so this promise belongs to whoever asked first
    // and may never settle for us. Waiting on it unguarded is how a quit during a pending
    // sign-in used to hang.
    const controller = new AbortController();
    stubFetch(async () => ok());

    const started = Date.now();
    const inFlight = client({ getToken: () => new Promise<string>(() => {}) }).get('/me', {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);

    await assert.rejects(inFlight, (error: unknown) => {
      assert.ok(error instanceof VfsError);
      assert.equal(error.code, 'ECANCELED');
      return true;
    });
    assert.ok(Date.now() - started < 5_000);
  });

  it('refuses a signal that was already aborted before the call', async () => {
    const fetches = stubFetch(async () => ok());

    await assert.rejects(client().get('/me', { signal: AbortSignal.abort() }), (error: unknown) => {
      assert.ok(error instanceof VfsError);
      assert.equal(error.code, 'ECANCELED');
      return true;
    });
    assert.equal(fetches.calls(), 0, 'it went to the network for a caller who had already left');
  });
});
