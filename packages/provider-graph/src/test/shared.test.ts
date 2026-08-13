/**
 * `raceAbort`, which is small and load-bearing.
 *
 * It exists because of a bug that cost twenty-six seconds on every quit: expensive work is
 * cached as a shared promise, the cached promise carries the *first* caller's signal, and
 * so a later caller's abort had nothing to abort. The fix is to stop waiting without
 * cancelling — and the three properties below are exactly the three things that made the
 * original bug so hard to see, so each one gets a test that fails if it regresses.
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { raceAbort } from '../abort.js';

/** A promise plus the handles to settle it, so a test can decide when work finishes. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('raceAbort', () => {
  it('returns the value when nothing aborts', async () => {
    assert.equal(await raceAbort(Promise.resolve('done'), new AbortController().signal), 'done');
  });

  it('passes the work straight through when there is no signal to watch', async () => {
    const work = Promise.resolve(7);
    assert.equal(await raceAbort(work), 7);
  });

  it('rejects immediately when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    // Work that never settles: if the already-aborted check were missing, this test would
    // time out rather than fail, which is its own kind of signal.
    await assert.rejects(raceAbort(deferred<string>().promise, controller.signal), /cancelled/i);
  });

  it('stops waiting promptly when the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = raceAbort(deferred<string>().promise, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 10);
    await assert.rejects(pending, /cancelled/i);
    // The point of the whole exercise. The real failure was 26_000ms.
    assert.ok(Date.now() - started < 1000, `waited ${String(Date.now() - started)}ms`);
  });

  it('leaves the shared work running, so other callers still get their answer', async () => {
    // This is the property that separates "stop waiting" from "cancel". The impatient
    // caller must not take the answer away from the patient one.
    const work = deferred<string>();
    const impatient = new AbortController();
    const patient = new AbortController();

    const first = raceAbort(work.promise, impatient.signal);
    const second = raceAbort(work.promise, patient.signal);
    impatient.abort();
    await assert.rejects(first, /cancelled/i);

    work.resolve('the expensive answer');
    assert.equal(await second, 'the expensive answer');
  });

  it('survives every caller walking away from work that then fails', async () => {
    // A shared promise with no observer left is a *process killer* under Node's default
    // --unhandled-rejections=throw. This exact hazard has bitten twice in this codebase,
    // so it gets a test rather than a comment.
    const work = deferred<string>();
    const controller = new AbortController();

    const abandoned = raceAbort(work.promise, controller.signal);
    controller.abort();
    await assert.rejects(abandoned, /cancelled/i);

    work.reject(new Error('the shared work failed after everyone left'));
    // If the rejection were unobserved, the process would die during this wait rather
    // than reach the assertion below.
    await delay(50);
    assert.ok(true, 'still alive');
  });

  it('unsubscribes from the signal once the work settles', async () => {
    // Long-lived signals are normal here — one abort controller covers a whole warm-up.
    // A listener leaked per call is a slow leak that nothing else would notice.
    const controller = new AbortController();
    for (let i = 0; i < 50; i += 1) await raceAbort(Promise.resolve(i), controller.signal);

    // `getEventListeners`, not `signal.listenerCount`: an AbortSignal is an EventTarget and
    // has no such method, so the earlier version of this check read `undefined`, skipped
    // itself, and passed against an implementation that leaked all fifty listeners.
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});
