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
  DEFAULT_FORMAT,
  displayWidth,
  formatBytes,
  formatDate,
  formatDocument,
  formatListing,
  formatRows,
  padTo,
  relativeTime,
  sanitizeForDisplay,
  truncateWidth,
  wrapBody,
} from '../format.js';
import type { VNode } from '@mscomms/core';

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

  /**
   * Hand-checked against what a terminal actually draws.
   *
   * These are pinned as literal numbers rather than derived from the same table the code
   * uses, because the bug being guarded against was in that table. Every one of these was
   * reported as a single column, and every one of them turns up in a corporate subject
   * line. The fixtures are pure ASCII, so a full suite passed while the real listing wrapped.
   */
  it('counts the emoji that actually appear in mail as two columns', () => {
    const cases: readonly (readonly [string, string, number])[] = [
      ['check', '\u2705', 2],
      ['cross', '\u274C', 2],
      ['rocket', '\u{1F680}', 2],
      ['green circle', '\u{1F7E2}', 2],
      ['red circle', '\u{1F534}', 2],
      ['bandage', '\u{1FA79}', 2],
      ['sparkles', '\u2728', 2],
      ['hourglass', '\u231B', 2],
      ['star', '\u2B50', 2],
      ['high voltage', '\u26A1', 2],
    ];
    for (const [label, char, want] of cases) {
      assert.equal(displayWidth(char), want, `${label} should be ${String(want)} columns`);
    }
  });

  /**
   * The warning sign is the awkward one, and the reason measuring cannot be done a
   * codepoint at a time. U+26A0 alone is a narrow text glyph; followed by U+FE0F it is an
   * emoji and takes two columns. Both forms are common — one comes from a human typing,
   * the other from anything that emits emoji programmatically.
   */
  it('widens a text symbol when the emoji presentation selector follows it', () => {
    assert.equal(displayWidth('\u26A0'), 1);
    assert.equal(displayWidth('\u26A0\uFE0F'), 2);
  });

  it('counts a skin-tone modifier as part of the glyph before it', () => {
    assert.equal(displayWidth('\u{1F44D}'), 2);
    assert.equal(displayWidth('\u{1F44D}\u{1F3FD}'), 2);
  });

  it('measures a whole subject line the way it will be drawn', () => {
    // 2 + 1 + 4 + 1 + 2 = 10.
    assert.equal(displayWidth('\u2705 Done \u{1F680}'), 10);
  });
});

/**
 * Truncation has to agree with measurement, because the layout asks one for a budget and
 * the other to fit it.
 *
 * They used to be written as separate loops — one over the whole string, one codepoint at a
 * time — and they disagreed on exactly the characters that matter. Asking for the width of
 * `\u26A0` and then of `\uFE0F` gives 1 + 0, while the string as a whole is 2. A row built
 * on the smaller number runs one column past the edge and wraps.
 */
describe('truncateWidth: agreeing with displayWidth', () => {
  const samples = [
    '\u2705 Done: Q3 budget approved \u{1F680}',
    '\u26A0\uFE0F Action required before Friday',
    '\u{1F7E2} Build green \u2728 shipping now',
    '\u{1F44D}\u{1F3FD} thanks!',
    'plain ascii subject line',
    '\u4E88\u7B97 review \u2705',
  ];

  for (const sample of samples) {
    for (const max of [1, 2, 3, 5, 8, 13, 21]) {
      it(`fits ${JSON.stringify(sample)} into ${String(max)}`, () => {
        const out = truncateWidth(sample, max);
        assert.ok(
          displayWidth(out) <= max,
          `truncated to ${String(displayWidth(out))} columns for a budget of ${String(max)}: ${JSON.stringify(out)}`,
        );
      });
    }
  }
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

/**
 * `formatDocument` had no direct tests, which is exactly why it silently dropped `title`.
 * The bug surfaced only when a real third-party plugin returned the minimum legal Document
 * — `{title, body}` with no headers — and its title vanished. These pin the contract.
 */
describe('formatDocument', () => {
  const base = { format: 'text' as const };

  it('shows a title that no header repeats', () => {
    // The minimum legal Document, and the shape the simplest plugin returns.
    const out = formatDocument(
      { ...base, title: 'Hello from Python', headers: [], body: 'Body text.' },
      { ...DEFAULT_FORMAT, color: false },
    );
    assert.match(out, /^Title: Hello from Python$/m);
    assert.match(out, /Body text\./);
  });

  it('does not lead with a blank line when there are no headers', () => {
    // Visually trivial; read aloud it is an unexplained pause before the content.
    const out = formatDocument(
      { ...base, title: '', headers: [], body: 'Body text.' },
      { ...DEFAULT_FORMAT, color: false },
    );
    assert.equal(out.split('\n')[0], 'Body text.');
  });

  it('does not repeat a title that a header already carries', () => {
    const out = formatDocument(
      {
        ...base,
        title: 'Q3 planning',
        headers: [
          ['From', 'Dana'],
          ['Subject', 'Q3 planning'],
        ],
        body: 'Body.',
      },
      { ...DEFAULT_FORMAT, color: false },
    );
    assert.equal(out.match(/Q3 planning/g)?.length, 1);
    assert.doesNotMatch(out, /^Title:/m);
  });

  it('aligns a synthesised Title with the real header labels', () => {
    // The reason the title is added before widths are measured rather than unshifted after.
    const out = formatDocument(
      { ...base, title: 'Fix the thing', headers: [['Author', 'dana']], body: 'Body.' },
      { ...DEFAULT_FORMAT, color: false, mode: 'table' },
    );
    const lines = out.split('\n');
    const title = lines.find((l) => l.startsWith('Title:'));
    const author = lines.find((l) => l.startsWith('Author:'));
    assert.ok(title !== undefined && author !== undefined);
    // Values start in the same column.
    assert.equal(title.indexOf('Fix the thing'), author.indexOf('dana'));
  });

  it('still separates headers from the body when there are headers', () => {
    const out = formatDocument(
      { ...base, title: 'T', headers: [['From', 'dana']], body: 'Body.' },
      { ...DEFAULT_FORMAT, color: false },
    );
    const lines = out.split('\n');
    assert.equal(lines[lines.indexOf('Body.') - 1], '');
  });

  it('keeps sanitising a hostile title', () => {
    // The title now reaches the screen, so it has to go through the same control as the rest.
    const out = formatDocument(
      { ...base, title: 'evil\u202Etxt.exe', headers: [], body: 'x' },
      { ...DEFAULT_FORMAT, color: false },
    );
    assert.doesNotMatch(out, /\u202E/);
  });
});

describe('formatRows in announce mode', () => {
  const opts = { ...DEFAULT_FORMAT, color: false, mode: 'announce' as const };

  it('ends each row with exactly one full stop', () => {
    // A doubled period is spoken as two pauses, which reads as a hesitation that is not
    // in the text. `doctor` produces cells that already end in "." and it showed.
    const out = formatRows(
      ['check', 'detail'],
      [['output mode', 'plain, colour off. Override with --plain.']],
      opts,
    );
    assert.doesNotMatch(out, /\.\.$/m);
    assert.match(out, /Override with --plain\.$/m);
  });

  it('still adds a full stop when the cell lacks one', () => {
    const out = formatRows(['check', 'detail'], [['sources', '2 mounted']], opts);
    assert.match(out, /2 mounted\.$/m);
  });

  it('respects a question mark or exclamation as sentence-final', () => {
    const out = formatRows(['subject'], [['Lunch?']], opts);
    assert.match(out, /Lunch\?$/m);
    assert.doesNotMatch(out, /Lunch\?\./);
  });
});

/**
 * The unread counter on a directory row.
 *
 * A folder that maps to a mailbox, a channel or a feed is the one place a number is worth
 * more than the listing beneath it — it is what decides whether you go in. These pin the
 * three properties that make it usable: it is a word and not only a digit, it holds its
 * column, and it never claims a count for a folder that never reported one.
 */
describe('formatListing: the unread counter', () => {
  const opts = { ...DEFAULT_FORMAT, color: false, width: 80 };

  function dir(name: string, extra: Partial<VNode> = {}): VNode {
    return { name, kind: 'dir', title: name, id: `id-${name}`, ...extra };
  }

  it('counts unread children on a folder row in the default table', () => {
    // The count used to require --long, which meant the default listing of a mailbox
    // showed nothing at all about where the new mail was.
    const out = formatListing([dir('Inbox', { unreadCount: 3, childCount: 40 })], opts);
    assert.match(out, /Inbox\/ +3 unread/);
  });

  it('says "unread" rather than leaving a bare number to be guessed at', () => {
    const out = formatListing([dir('Newsletters', { unreadCount: 12 })], opts);
    assert.doesNotMatch(out, /\(12\)/);
    assert.match(out, /12 unread/);
  });

  it('marks the folder in the same leading column an unread message uses', () => {
    // "Is there anything new in here" is the same question one level up, so it gets the
    // same answer in the same place rather than a second vocabulary.
    const out = formatListing([dir('Inbox', { unreadCount: 1 })], opts);
    assert.match(out, /^\s*1\.\s\*\sInbox\//);
  });

  it('says nothing for a folder with nothing unread', () => {
    const out = formatListing([dir('Archive', { unreadCount: 0, childCount: 900 })], opts);
    assert.doesNotMatch(out, /unread/);
  });

  it('says nothing for a folder whose source does not report the count', () => {
    // Silence and zero are different claims. A provider that cannot count must not be
    // made to look like one that counted and found nothing.
    const out = formatListing([dir('Projects')], opts);
    assert.doesNotMatch(out, /unread/);
  });

  it('keeps the counter in one column across rows that differ in magnitude', () => {
    const out = formatListing(
      [dir('Inbox', { unreadCount: 3629 }), dir('Junk', { unreadCount: 1 }), dir('Sent')],
      opts,
    );
    const columns = out
      .split('\n')
      .filter((line) => line.includes('unread'))
      .map((line) => line.indexOf('unread'));
    assert.equal(new Set(columns).size, 1, `counter is ragged: ${out}`);
  });

  it('does not let the counter push a row past the terminal width', () => {
    const out = formatListing(
      [dir('A folder with a rather long and inconvenient name', { unreadCount: 3629, childCount: 4000 })],
      { ...opts, width: 60, long: true },
    );
    for (const line of out.split('\n')) assert.ok(displayWidth(line) <= 60, `too wide: ${line}`);
  });

  it('spends --long on the total rather than repeating the count', () => {
    const out = formatListing([dir('Inbox', { unreadCount: 3, childCount: 40 })], { ...opts, long: true });
    assert.equal(out.match(/unread/g)?.length, 1);
    assert.match(out, /40 items/);
  });

  it('carries the count into plain mode, which is what gets piped', () => {
    const out = formatListing([dir('Inbox', { unreadCount: 3 })], { ...opts, mode: 'plain' });
    assert.match(out, /Inbox\/\t3 unread/);
  });

  it('never puts a count on a file, however the provider fills the field in', () => {
    const out = formatListing(
      [{ name: 'note.eml', kind: 'file', title: 'note', id: '1', unreadCount: 500 }],
      opts,
    );
    assert.doesNotMatch(out, /unread/);
  });
});


/**
 * A row must not be wider than the terminal.
 *
 * Reported as: "your right-alignment draws offscreen in different resolutions." The layout
 * floored the name at 20 columns and let everything to its right run past the edge, which was
 * survivable while the row was narrow and stopped being survivable the moment the counter
 * added a column — at 40 columns a row came out 63 wide. A row wider than the terminal wraps,
 * and a wrapped row turns a scannable list into a paragraph.
 *
 * These check the invariant at a spread of widths rather than one, because the failure was
 * width-dependent and a single 80-column case is exactly what missed it.
 */
describe('formatListing: fitting the terminal', () => {
  /**
   * A second, deliberately independent ruler.
   *
   * The rows below are checked against this rather than against `displayWidth`, because
   * `displayWidth` is what the layout used to allocate them: if its table undercounts a
   * character, the row is built too wide *and* measured too narrow, the two errors cancel,
   * and the assertion passes while the terminal wraps. That is not a hypothetical — it is
   * how a width bug affecting nine common emoji sat behind a green suite.
   *
   * So this covers only the characters these fixtures actually use, and is written from
   * what a terminal draws rather than from the production table. Two implementations that
   * agree are evidence; one implementation checking itself is not.
   */
  const columnsOf = (text: string): number => {
    const wide = new Set([0x2705, 0x274c, 0x26a1, 0x2728, 0x2b50, 0x231b, 0x1f680, 0x1f7e2, 0x1f534]);
    const emojiCapable = new Set([0x26a0]);
    const chars = [...text];
    let width = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const code = chars[i]?.codePointAt(0) ?? 0;
      if (code === 0xfe0f || code === 0x200d) continue;
      const next = chars[i + 1]?.codePointAt(0);
      const cjk = (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff);
      if (wide.has(code) || cjk) width += 2;
      else if (next === 0xfe0f && emojiCapable.has(code)) width += 2;
      else width += 1;
    }
    return width;
  };

  const WIDE = new Date('2026-08-11T12:00:00Z');
  const nodes: readonly VNode[] = [
    { name: 'Chats', title: 'Chats', kind: 'dir', id: '1', path: '/x/Chats', unreadCount: 3, mtime: WIDE },
    { name: 'Inbox', title: 'Inbox', kind: 'dir', id: '2', path: '/x/Inbox', unreadCount: 1247, mtime: WIDE },
    {
      name: 'A folder with a deliberately very long name that fits nowhere',
      title: 'A folder with a deliberately very long name that fits nowhere',
      kind: 'dir',
      id: '3',
      path: '/x/long',
      unreadCount: 9,
      mtime: WIDE,
      author: 'Dana Whitfield',
    },
    {
      name: '2026-08-11 FY26 budget review.eml',
      title: 'FY26 budget review',
      kind: 'file',
      id: '4',
      path: '/x/m.eml',
      mtime: WIDE,
      author: 'Tom Okafor',
      flags: ['unread'],
    },
    // Non-ASCII, because every fixture above is ASCII and that is precisely how a width
    // table that undercounted nine common emoji survived the whole suite. The subject on a
    // real row is not drawn from the printable ASCII range.
    {
      name: '2026-08-11 \u2705 Done: Q3 budget approved \u{1F680}.eml',
      title: '\u2705 Done: Q3 budget approved \u{1F680}',
      kind: 'file',
      id: '5',
      path: '/x/e.eml',
      mtime: WIDE,
      author: 'Lena Bj\u00F6rk',
      flags: ['unread'],
    },
    {
      name: '\u26A0\uFE0F Escalations',
      title: '\u26A0\uFE0F Escalations',
      kind: 'dir',
      id: '6',
      path: '/x/esc',
      unreadCount: 12,
      mtime: WIDE,
    },
    {
      name: '\u4E88\u7B97\u30EC\u30D3\u30E5\u30FC',
      title: '\u4E88\u7B97\u30EC\u30D3\u30E5\u30FC',
      kind: 'dir',
      id: '7',
      path: '/x/cjk',
      unreadCount: 4,
      mtime: WIDE,
    },
  ];

  for (const width of [20, 30, 40, 50, 60, 72, 80, 100, 120]) {
    it(`never exceeds ${String(width)} columns`, () => {
      const out = formatListing(nodes, { width, color: false, dateStyle: 'relative', mode: 'table' });
      for (const line of out.split('\n')) {
        assert.ok(
          columnsOf(line) <= width,
          `row is ${String(columnsOf(line))} columns in a ${String(width)}-column terminal: ${JSON.stringify(line)}`,
        );
      }
    });
  }

  it('measures rows the same way a terminal will', () => {
    // The bridge between the two rulers. If they ever disagree the fitting checks above stop
    // meaning anything, and this is what says so out loud rather than letting them pass.
    const out = formatListing(nodes, { width: 100, color: false, dateStyle: 'relative', mode: 'table' });
    for (const line of out.split('\n')) {
      assert.equal(displayWidth(line), columnsOf(line), `disagreement on ${JSON.stringify(line)}`);
    }
  });

  it('keeps the counter at a width where it has to drop the author and the date', () => {
    // The counter is the last optional column to go, because it is the reason to look at the
    // row. What gets given up first is the material that says nothing about what is new.
    const out = formatListing(nodes, { width: 30, color: false, dateStyle: 'relative', mode: 'table' });
    assert.match(out, /3 unread/);
    assert.doesNotMatch(out, /Dana Whitfield/);
  });

  it('shortens the counter rather than dropping it when the room runs out', () => {
    // `3 unread` becomes `(3)` — the same fact in a third of the room, and the form the pane
    // already uses at every width, so it is not a new vocabulary either.
    const narrow: readonly VNode[] = [
      { name: 'Chats', title: 'Chats', kind: 'dir', id: '1', path: '/x/Chats', unreadCount: 3, mtime: WIDE },
    ];
    const out = formatListing(narrow, { width: 24, color: false, dateStyle: 'relative', mode: 'table' });
    assert.ok(displayWidth(out) <= 24, out);
    assert.match(out, /\(3\)/);
  });

  it('still spells the word out when there is room for it', () => {
    const out = formatListing(nodes, { width: 100, color: false, dateStyle: 'relative', mode: 'table' });
    assert.match(out, /3 unread/);
    assert.doesNotMatch(out, /\(3\)/);
  });
});


