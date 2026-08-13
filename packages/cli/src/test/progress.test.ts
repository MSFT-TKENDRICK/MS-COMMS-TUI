/**
 * The shell's progress line.
 *
 * The interesting behaviour here is all about restraint. An indicator that appears for
 * every command is noise; one that appears and is never erased corrupts the scrollback; one
 * that appears on a pipe corrupts the data. Each of those is a way of making the tool worse
 * than the silence it replaced, so each gets a test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DELAY_MS, Progress, progressFrame, progressLabel } from '../progress.js';

describe('progress: when to speak', () => {
  it('says nothing at all before the delay', () => {
    assert.equal(progressFrame('ls', 0, 0), undefined);
    assert.equal(progressFrame('ls', DELAY_MS - 1, 0), undefined);
  });

  it('speaks once the command has outstayed its welcome', () => {
    const text = progressFrame('ls', DELAY_MS, 0);
    assert.ok(text !== undefined);
    assert.match(text, /ls…/);
  });

  it('withholds the second count until it means something', () => {
    // A command that finishes in 900ms would otherwise flash "0s" on its way past.
    assert.doesNotMatch(progressFrame('ls', 900, 0) ?? '', /\ds/);
    assert.match(progressFrame('ls', 2200, 0) ?? '', /2s/);
    assert.match(progressFrame('ls', 61_000, 0) ?? '', /61s/);
  });

  it('animates, because a caption that never changes reads as a hang', () => {
    const frames = new Set([0, 1, 2, 3].map((tick) => progressFrame('ls', 1000, tick)));
    assert.equal(frames.size, 4, 'consecutive ticks should differ');
  });

  it('names the command, since which thing is slow is most of the news', () => {
    assert.equal(progressLabel('search budget --limit 5'), 'search');
    assert.equal(progressLabel('  ls  '), 'ls');
    assert.equal(progressLabel(''), 'working');
  });
});

describe('progress: staying out of the way', () => {
  /** A clock the test advances by hand, so none of this depends on real time passing. */
  function harness(enabled = true): {
    readonly progress: Progress;
    readonly written: string[];
    readonly advance: (ms: number) => void;
  } {
    let now = 0;
    const written: string[] = [];
    const progress = new Progress({
      write: (text) => written.push(text),
      enabled,
      now: () => now,
      intervalMs: 1,
    });
    return {
      progress,
      written,
      advance: (ms) => {
        now += ms;
      },
    };
  }

  it('writes nothing when disabled, however long the command runs', async () => {
    const h = harness(false);
    h.progress.start('ls');
    h.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.progress.stop();
    assert.deepEqual(h.written, []);
  });

  it('erases what it drew, so nothing survives into the scrollback', async () => {
    const h = harness();
    h.progress.start('ls');
    h.advance(DELAY_MS + 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(h.progress.visible, 'should have drawn something by now');

    h.progress.stop();
    assert.ok(!h.progress.visible);
    const last = h.written[h.written.length - 1];
    assert.equal(last, '\r\u001B[K', 'the last thing written should be an erase');
  });

  it('does not erase when it never drew', () => {
    const h = harness();
    h.progress.start('ls');
    h.progress.stop();
    assert.deepEqual(h.written, [], 'a fast command should leave the terminal untouched');
  });

  it('clear() is idempotent, so a stop after a clear cannot double-erase', async () => {
    const h = harness();
    h.progress.start('ls');
    h.advance(DELAY_MS + 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.progress.clear();
    const afterClear = h.written.length;
    h.progress.clear();
    h.progress.stop();
    assert.equal(h.written.length, afterClear, 'no further writes');
  });

  it('starting twice does not leave the first timer running', async () => {
    const h = harness();
    h.progress.start('first');
    h.progress.start('second');
    h.advance(DELAY_MS + 100);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.progress.stop();
    // If the first interval had survived, frames labelled `first` would still be arriving.
    assert.ok(!h.written.some((text) => text.includes('first')));
    assert.ok(h.written.some((text) => text.includes('second')));
  });
});

describe('progress: wired the way the shell wires it', () => {
  /**
   * The shell runs every command inside `beforeFirstWrite`, which latches on the first byte
   * the *command* writes and erases the progress line just ahead of it. The spinner must
   * therefore not write through the session, or its own first frame trips the latch: the
   * erase is spent on nothing, the command's output is never preceded by one, and it lands
   * on top of the spinner — `⠋ ls…Inbox`, in the scrollback, permanently.
   *
   * This reproduces the whole arrangement with a fake session rather than a real one, so it
   * stays a test about the wiring and not about mounting anything.
   */
  function shellLike(progressWritesThroughSession: boolean): {
    readonly run: (durationMs: number, output: string) => Promise<void>;
    readonly terminal: string[];
  } {
    const terminal: string[] = [];
    let now = 0;
    let sink = (text: string): void => {
      terminal.push(text);
    };

    const progress = new Progress({
      write: (text) => {
        if (progressWritesThroughSession) sink(text);
        else terminal.push(text);
      },
      enabled: true,
      now: () => now,
      intervalMs: 1,
    });

    // `Session.beforeFirstWrite`, reduced to the part that matters here.
    const beforeFirstWrite = async (before: () => void, fn: () => Promise<void>): Promise<void> => {
      const previous = sink;
      let fired = false;
      sink = (text: string) => {
        if (!fired) {
          fired = true;
          before();
        }
        previous(text);
      };
      try {
        await fn();
      } finally {
        sink = previous;
      }
    };

    return {
      terminal,
      run: async (durationMs, output) => {
        progress.start('ls');
        try {
          await beforeFirstWrite(
            () => progress.clear(),
            async () => {
              now += durationMs;
              await new Promise((resolve) => setTimeout(resolve, 20));
              sink(output);
            },
          );
        } finally {
          progress.stop();
        }
      },
    };
  }

  it('erases the spinner immediately before the output it would otherwise sit on', async () => {
    const h = shellLike(false);
    await h.run(DELAY_MS + 200, 'Inbox\n');

    const outputAt = h.terminal.indexOf('Inbox\n');
    assert.ok(outputAt > 0, 'the command should have printed');
    assert.equal(
      h.terminal[outputAt - 1],
      '\r\u001B[K',
      'the write immediately before the output must be an erase, or the spinner is still on that row',
    );
  });

  it('leaves the spinner stranded if it writes through the session', async () => {
    // The bug, demonstrated. Kept as a test so the wiring cannot quietly revert: routing the
    // spinner through the session makes it consume its own erase.
    const h = shellLike(true);
    await h.run(DELAY_MS + 200, 'Inbox\n');

    const outputAt = h.terminal.indexOf('Inbox\n');
    assert.ok(outputAt > 0);
    assert.notEqual(
      h.terminal[outputAt - 1],
      '\r\u001B[K',
      'this arrangement is expected to be broken — if it now passes, the shell can use it',
    );
  });

  it('still prints nothing for a command fast enough not to need it', async () => {
    const h = shellLike(false);
    await h.run(0, 'Inbox\n');
    assert.deepEqual(h.terminal, ['Inbox\n'], 'a fast command should leave no chrome at all');
  });
});
