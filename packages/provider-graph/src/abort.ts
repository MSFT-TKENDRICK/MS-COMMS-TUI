/**
 * Waiting for shared work without owning it.
 *
 * Its own module rather than a corner of `shared.ts` because `client.ts` needs it and
 * `shared.ts` already imports `client.ts`; putting it there would close an import cycle
 * for one small helper.
 */

import { VfsError } from '@mscomms/core';

/**
 * Wait for shared work, but no longer than this caller is willing to wait.
 *
 * Every expensive thing in this package is cached as a promise and shared: the MCP
 * handshake, the signed-in user, the chat roster, the cross-person signal index. Sharing is
 * right — they are slow, and the second caller should not repeat them — but it created a
 * class of bug that took a while to see. A cached promise was created with the *first*
 * caller's signal and then handed to everyone afterwards, so a later caller's abort had
 * nothing to abort: it was awaiting work that belonged to somebody else.
 *
 * That is invisible until shutdown, when it is the whole story. Background sync aborts its
 * cycle and waits for the workers to unwind; a worker awaiting a shared promise does not
 * unwind. Measured here, quitting took twenty-six seconds while `/people/Me` sat inside a
 * signal-index build it had no way to leave.
 *
 * So: this gives up *waiting* without cancelling the work. The shared promise carries on
 * and stays cached, because it is nearly always about to be useful to somebody, and
 * cancelling it would punish every other caller for one caller's impatience.
 *
 * The code is `ECANCELED` and not `ETIMEDOUT` because the two mean opposite things to the
 * person reading the screen. A timeout says the service was too slow and is worth a second
 * try; a cancellation says you pressed `q`, and the only correct response is silence. The
 * error mapper in `core` already draws that line for `AbortError` against `TimeoutError`,
 * and every abort raised by hand across the providers sits on the same side of it.
 */
export async function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  // A shared promise may end up with no observer at all once callers start walking away,
  // and an unobserved rejection is fatal under Node's default policy.
  work.catch(() => undefined);
  if (signal.aborted) throw new VfsError('ECANCELED', 'The request was cancelled.');

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          reject(new VfsError('ECANCELED', 'The request was cancelled.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
