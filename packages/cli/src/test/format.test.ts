/**
 * Presentation-layer tests.
 *
 * Two things are load-bearing here and neither is cosmetic:
 *
 * 1. `sanitizeForDisplay` is a security control. Every string it handles came from a
 *    stranger who can put anything in a subject line.
 * 2. The date and size helpers are accessibility controls. They are what a screen reader
 *    actually speaks, and "2h" is spoken "two aitch".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  displayWidth,
  formatBytes,
  formatDate,
  padTo,
  relativeTime,
  sanitizeForDisplay,
  truncateWidth,
  wrapBody,
} from '../format.js';

describe('sanitizeForDisplay', () => {
  it('leaves ordinary text alone', () => {
    assert.equal(sanitizeForDisplay('Budget review Q3'), 'Budget review Q3');
  });

  it('strips an ANSI escape sequence so hostile mail cannot repaint the terminal', () => {
    // A subject of "\u001b[2J\u001b[H Gotcha" would clear the screen on display.
    const hostile = '\u001b[2J\u001b[H Gotcha';
    const clean = sanitizeForDisplay(hostile);
    assert.ok(!clean.includes('\u001b'), 'ESC must not survive');
    assert.match(clean, /Gotcha/);
  });

  it('strips a right-to-left override, which can disguise a file extension', () => {
    // "invoice\u202Efdp.exe" renders as "invoiceexe.pdf" in a terminal that honours bidi.
    const disguised = 'invoice\u202Efdp.exe';
    const clean = sanitizeForDisplay(disguised);
    assert.equal(clean, 'invoicefdp.exe');
  });

  it('strips the bidi isolate characters too', () => {
    assert.equal(sanitizeForDisplay('a\u2066b\u2069c'), 'abc');
  });

  it('strips zero-width direction marks', () => {
    assert.equal(sanitizeForDisplay('a\u200Eb\u200Fc'), 'abc');
  });

  it('collapses newlines and tabs so one item stays one line', () => {
    // A listing row that becomes three rows breaks numbered addressing: `cat 3` would
    // refer to something the user never saw announced as 3.
    assert.equal(sanitizeForDisplay('one\ntwo\tthree'), 'one two three');
    assert.equal(sanitizeForDisplay('a\r\n\r\nb'), 'a b');
  });

  it('strips the NUL and DEL bytes', () => {
    assert.equal(sanitizeForDisplay('a\u0000b\u007Fc'), 'abc');
  });

  it('keeps ordinary non-Latin text intact', () => {
    assert.equal(sanitizeForDisplay('予算のレビュー'), '予算のレビュー');
    assert.equal(sanitizeForDisplay('مراجعة الميزانية'), 'مراجعة الميزانية');
  });

  it('is idempotent', () => {
    const once = sanitizeForDisplay('\u001b[31mred\u202E\n');
    assert.equal(sanitizeForDisplay(once), once);
  });
});

describe('displayWidth', () => {
  it('counts plain ASCII one per character', () => {
    assert.equal(displayWidth('hello'), 5);
  });

  it('counts CJK as double width', () => {
    assert.equal(displayWidth('予算'), 4);
  });

  it('does not count combining marks', () => {
    assert.equal(displayWidth('e\u0301'), 1);
  });

  it('does not count variation selectors or zero-width joiners', () => {
    assert.equal(displayWidth('a\uFE0F'), 1);
    assert.equal(displayWidth('a\u200Db'), 2);
  });
});

describe('padTo and truncateWidth', () => {
  it('pads to the requested display width', () => {
    assert.equal(displayWidth(padTo('ab', 5)), 5);
  });

  it('pads wide characters correctly, so columns actually line up', () => {
    assert.equal(displayWidth(padTo('予算', 6)), 6);
  });

  it('never truncates text that already fits', () => {
    assert.equal(truncateWidth('short', 10), 'short');
  });

  it('truncates with an ellipsis and stays within budget', () => {
    const out = truncateWidth('a very long subject line indeed', 10);
    assert.ok(displayWidth(out) <= 10, `got width ${String(displayWidth(out))}`);
    assert.ok(out.endsWith('…'));
  });

  it('respects wide characters when truncating', () => {
    const out = truncateWidth('予算予算予算予算', 7);
    assert.ok(displayWidth(out) <= 7);
  });

  it('returns nothing for a nonsensical width', () => {
    assert.equal(truncateWidth('anything', 0), '');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-11T12:00:00Z');
  const ago = (ms: number): string => relativeTime(new Date(now.getTime() - ms), now);

  it('uses whole words, never abbreviations', () => {
    // "2h" is spoken "two aitch". Every unit here has to survive a speech synthesiser.
    assert.equal(ago(2 * 3600_000), '2 hours ago');
    assert.equal(ago(90 * 60_000), '2 hours ago');
    assert.equal(ago(3 * 86_400_000), '3 days ago');
  });

  it('says "just now" rather than "0 seconds ago"', () => {
    assert.equal(ago(1000), 'just now');
  });

  it('gets singular and plural right', () => {
    assert.equal(ago(60_000), '1 minute ago');
    assert.equal(ago(120_000), '2 minutes ago');
    assert.equal(ago(86_400_000), '1 day ago');
  });

  it('handles a future timestamp without producing a negative', () => {
    const future = relativeTime(new Date(now.getTime() + 3600_000), now);
    assert.equal(future, 'in 1 hour');
    assert.ok(!future.includes('-'));
  });

  it('scales up to months and years', () => {
    assert.equal(ago(60 * 86_400_000), '2 months ago');
    assert.equal(ago(400 * 86_400_000), '1 year ago');
  });
});

describe('formatDate', () => {
  const now = new Date('2026-08-11T12:00:00Z');

  it('returns an empty string rather than "Invalid Date"', () => {
    assert.equal(formatDate(undefined, 'relative', now), '');
    assert.equal(formatDate(new Date('nonsense'), 'relative', now), '');
  });

  it('produces a sortable ISO string when asked', () => {
    assert.equal(formatDate(now, 'iso', now), '2026-08-11T12:00:00.000Z');
  });

  it('produces an unambiguous absolute form', () => {
    // Not "08/11/26", which means two different days depending on the reader.
    assert.match(formatDate(now, 'absolute', now), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('formatBytes', () => {
  it('uses plain bytes below a kilobyte', () => {
    assert.equal(formatBytes(512), '512 B');
  });

  it('scales through the units', () => {
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    assert.equal(formatBytes(50 * 1024), '50 KB');
  });

  it('returns an empty string for an unknown size', () => {
    assert.equal(formatBytes(undefined), '');
  });
});

describe('wrapBody', () => {
  it('wraps at the requested width', () => {
    const wrapped = wrapBody('one two three four five six seven eight nine ten', 20);
    for (const line of wrapped.split('\n')) {
      assert.ok(displayWidth(line) <= 20, `line too long: ${line}`);
    }
  });

  it('preserves paragraph breaks', () => {
    // A screen reader uses blank lines to pause. Collapsing them turns a structured
    // message into one long undifferentiated utterance.
    const wrapped = wrapBody('first para\n\nsecond para', 40);
    assert.match(wrapped, /first para\n\nsecond para/);
  });

  it('does not lose a word that is longer than the width', () => {
    const long = 'https://example.com/a/very/long/url/that/exceeds/the/width';
    assert.ok(wrapBody(long, 20).includes(long.slice(0, 20)));
    assert.equal(wrapBody(long, 20).replace(/\n/g, '').length, long.length);
  });

  it('handles an empty body', () => {
    assert.equal(wrapBody('', 40), '');
  });
});
