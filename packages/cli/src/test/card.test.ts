/**
 * Tests for card layout and rendering.
 *
 * The invariant that matters more than any single assertion is this: **no rendered row may
 * ever be wider than the width it was given.** A single over-wide row wraps in the terminal
 * and every row below it is displaced, so the failure is not "one line looks wrong" but
 * "the pane is destroyed from here down". Most of this file is that one property, checked
 * against every element type, several themes, and widths narrow enough to be hostile.
 *
 * The second theme running through these tests is that colour is decoration. The monochrome
 * theme is not tested because someone might use it; it is tested because if a card is
 * unambiguous without colour then colour was never carrying information, which is what
 * `docs/ACCESSIBILITY.md` requires and what is otherwise easy to break by accident.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Card, badges, card, facts, fill, len, percent, prose, text } from '@mscomms/core';
import { displayWidth } from '../format.js';
import { flowItems, splitWidth, wrapClamped, wrapText } from '../card/layout.js';
import { renderCard, renderCardRows } from '../card/render.js';
import { ASCII_THEME, COMPACT_THEME, DEFAULT_THEME, MONO_THEME, THEMES, themeByName, themeFor } from '../card/theme.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/g;
const visible = (line: string): number => displayWidth(line.replace(ANSI, ''));

describe('splitWidth', () => {
  it('honours fixed lengths first', () => {
    assert.deepEqual(splitWidth(30, [len(10), fill(1)]), [10, 20]);
  });

  it('shares the remainder between fill weights', () => {
    assert.deepEqual(splitWidth(30, [fill(1), fill(2)]), [10, 20]);
  });

  it('gives rounding to the last fill rather than losing or inventing a column', () => {
    const widths = splitWidth(10, [fill(1), fill(1), fill(1)]);
    assert.equal(
      widths.reduce((a, b) => a + b, 0),
      10,
    );
  });

  it('resolves percentages against the original total, not the remainder', () => {
    assert.deepEqual(splitWidth(100, [percent(25), fill(1)]), [25, 75]);
  });

  it('subtracts the gaps before dividing, so the gutters fit too', () => {
    const gap = 2;
    const widths = splitWidth(30, [fill(1), fill(1)], gap);
    assert.equal(widths.reduce((a, b) => a + b, 0) + gap, 30);
  });

  it('never over-commits when the fixed columns alone exceed the total', () => {
    const widths = splitWidth(10, [len(8), len(8), len(8)]);
    assert.ok(
      widths.reduce((a, b) => a + b, 0) <= 10,
      `over-committed: ${JSON.stringify(widths)}`,
    );
    assert.ok(widths.every((w) => w >= 0));
  });

  it('returns zeroes rather than negatives for a zero or negative total', () => {
    assert.deepEqual(splitWidth(0, [fill(1), fill(1)]), [0, 0]);
    assert.deepEqual(splitWidth(-5, [len(4)]), [0]);
  });

  it('treats a zero total weight as no fill rather than dividing by zero', () => {
    const widths = splitWidth(20, [fill(0), fill(0)]);
    assert.ok(widths.every((w) => Number.isFinite(w) && w >= 0), JSON.stringify(widths));
  });
});

describe('wrapText', () => {
  it('never emits a line wider than the width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12);
    for (const line of lines) assert.ok(displayWidth(line) <= 12, `too wide: ${line}`);
  });

  it('breaks a word that cannot fit rather than overflowing', () => {
    const lines = wrapText('supercalifragilistic', 8);
    for (const line of lines) assert.ok(displayWidth(line) <= 8, `too wide: ${line}`);
    assert.ok(lines.length > 1);
  });

  /**
   * A wrapped URL has to survive being reassembled.
   *
   * The first version sliced long words with `truncateWidth`, which appends an ellipsis.
   * The marker replaced a real character *and* was counted when advancing, so
   * `https://github.com/contoso/platform/pull/4821` came back as `.../pul…` + `/4821` —
   * both marked as truncated when nothing was dropped, and missing a character that then
   * appeared nowhere. Copying a URL out of the pane is the entire reason it is shown.
   */
  it('wraps a long URL without losing or marking a single character', () => {
    const url = 'https://github.com/contoso/platform/pull/4821';
    for (const width of [10, 20, 24, 40, 44]) {
      const lines = wrapText(url, width);
      for (const line of lines) assert.ok(displayWidth(line) <= width, `too wide at ${width}: ${line}`);
      assert.equal(lines.join(''), url, `URL corrupted at width ${width}: ${lines.join('|')}`);
      assert.ok(!lines.join('').includes('\u2026'), `ellipsis inserted at width ${width}`);
    }
  });

  it('does not split a surrogate pair when breaking a long word', () => {
    const word = '\u{1F600}'.repeat(10);
    for (const width of [3, 4, 5, 9]) {
      const lines = wrapText(word, width);
      assert.equal(lines.join(''), word, `emoji run corrupted at width ${width}`);
      assert.ok(!lines.join('').includes('\uFFFD'), 'a surrogate pair was split');
    }
  });

  /**
   * The width contract has to hold even when it cannot be honoured with the content intact.
   *
   * A two-column character in a one-column pane cannot be drawn. Emitting it anyway
   * overflows and corrupts every row below it; the honest answer is to mark the loss. This
   * was silently broken: the guard against an infinite loop simply stopped slicing, and the
   * whole unsliced word was then emitted as one twelve-column line.
   */
  it('keeps to the width even when a single character cannot fit', () => {
    for (const width of [1, 2, 3]) {
      const lines = wrapText('\u6f22\u5b57\u6f22\u5b57\u6f22\u5b57', width);
      for (const line of lines) {
        assert.ok(displayWidth(line) <= width, `overflowed a ${String(width)}-column pane: ${line}`);
      }
    }
  });

  it('marks the loss rather than dropping a character it cannot draw', () => {
    assert.deepEqual(wrapText('\u6f22\u5b57', 1), ['\u2026']);
  });

  it('keeps blank lines, because a paragraph break is content', () => {
    assert.deepEqual(wrapText('one\n\ntwo', 20), ['one', '', 'two']);
  });

  it('preserves indentation instead of reflowing it, so quotes survive', () => {
    const lines = wrapText('> quoted text', 40);
    assert.deepEqual(lines, ['> quoted text']);
  });

  it('still caps an indented line, because an over-wide row wraps the pane', () => {
    const lines = wrapText(`  ${'x'.repeat(80)}`, 20);
    for (const line of lines) assert.ok(displayWidth(line) <= 20, `too wide: ${line}`);
  });

  it('measures wide characters as two columns', () => {
    const lines = wrapText('東京都新宿区西新宿二丁目八番一号', 10);
    for (const line of lines) assert.ok(displayWidth(line) <= 10, `too wide: ${line}`);
  });

  it('terminates on wide characters in a one-column space', () => {
    // The guard against an infinite loop: a two-column glyph can never fit in one column,
    // so a naive "slice what fits and recurse" spins forever.
    const lines = wrapText('東京', 1);
    assert.ok(Array.isArray(lines));
  });

  it('returns nothing for a non-positive width', () => {
    assert.deepEqual(wrapText('anything', 0), []);
  });

  it('normalises CRLF, which arrives from every Windows mail client', () => {
    assert.deepEqual(wrapText('one\r\ntwo', 20), ['one', 'two']);
  });
});

describe('wrapClamped', () => {
  it('says how much it hid rather than trailing off', () => {
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
    const lines = wrapClamped(long, 30, 2);
    assert.equal(lines.length, 2);
    assert.ok(/\(\d+ more lines?\)/.test(lines[1] ?? ''), lines[1]);
  });

  it('falls back to a short marker when the sentence will not fit', () => {
    const lines = wrapClamped('one two three four five six seven eight', 10, 2);
    assert.equal(lines.length, 2);
    // Never a partially truncated note, which reads as neither the note nor the text.
    assert.ok(/\(\+\d+\)$/.test(lines[1] ?? ''), lines[1]);
  });

  it('keeps the marker inside the width at every width', () => {
    for (let width = 1; width <= 40; width += 1) {
      for (const line of wrapClamped('one two three four five six seven eight nine ten', width, 2)) {
        assert.ok(displayWidth(line) <= width, `too wide at ${String(width)}: ${line}`);
      }
    }
  });

  it('leaves short text alone', () => {
    assert.deepEqual(wrapClamped('short', 20, 5), ['short']);
  });
});

describe('flowItems', () => {
  it('packs items across rows without exceeding the width', () => {
    const rows = flowItems(['[aaa]', '[bbb]', '[ccc]', '[ddd]'], 13, ' ');
    for (const row of rows) assert.ok(displayWidth(row) <= 13, `too wide: ${row}`);
  });

  it('gives an over-wide item its own row and truncates it', () => {
    const rows = flowItems([`[${'x'.repeat(50)}]`, '[ok]'], 12, ' ');
    for (const row of rows) assert.ok(displayWidth(row) <= 12, `too wide: ${row}`);
  });

  it('returns nothing for no items', () => {
    assert.deepEqual(flowItems([], 20, ' '), []);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One card holding every element type, which is what makes the width sweep meaningful. */
function kitchenSink(): Card {
  return card(
    [
      text('A wrapping text block that is long enough to need more than one row at any sane width.', {
        wrap: true,
      }),
      text('A clamped block that goes on and on and on and should be cut off after two lines.', {
        wrap: true,
        maxLines: 2,
      }),
      facts([
        { title: 'Author', value: 'octocat' },
        { title: 'A very long label indeed', value: 'and a very long value to go with it' },
        { title: 'State', value: 'open', tone: 'good' },
      ]),
      badges([
        { text: 'enhancement' },
        { text: 'needs-triage', tone: 'warning' },
        { text: 'security', tone: 'attention' },
      ], { label: 'Labels' }),
      {
        type: 'Table',
        columns: [fill(2), fill(2), len(10)],
        header: [{ text: 'Reviewer' }, { text: 'Verdict' }, { text: 'When' }],
        rows: [
          [{ text: 'alice' }, { text: 'approved', tone: 'good' }, { text: '2024-03-10' }],
          [{ text: 'bob' }, { text: 'changes requested', tone: 'warning' }, { text: '2024-03-11' }],
        ],
      },
      {
        type: 'ColumnSet',
        columns: [
          { width: fill(1), items: [text('left column')] },
          { width: fill(1), items: [text('right column')] },
        ],
      },
      {
        type: 'Container',
        title: 'Description',
        separator: true,
        items: [prose('Body text.\n\n> A quoted line that is quite long and should not be reflowed away.')],
      },
      { type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'Open', url: 'https://example.com/a/very/long/path' }] },
    ],
    { title: 'A card title that is itself long enough to wrap at a narrow width' },
  );
}

describe('renderCard', () => {
  /**
   * The load-bearing test. Every element, every theme, every width from absurdly narrow to
   * comfortable. If a row is ever wider than its budget the pane wraps and everything below
   * is displaced, so this is the one failure that cannot be allowed to be subtle.
   */
  it('never emits a row wider than the width it was given', () => {
    const sink = kitchenSink();
    for (const theme of Object.values(THEMES)) {
      for (let width = 1; width <= 100; width += 1) {
        for (const color of [false, true]) {
          for (const line of renderCard(sink, { width, color, theme })) {
            assert.ok(
              visible(line) <= width,
              `${theme.name} at ${String(width)} produced ${String(visible(line))} columns: ${JSON.stringify(line)}`,
            );
          }
        }
      }
    }
  });

  it('emits no ANSI escapes when colour is off', () => {
    for (const line of renderCard(kitchenSink(), { width: 60, color: false, theme: DEFAULT_THEME })) {
      assert.ok(!ANSI.test(line), `escape leaked: ${JSON.stringify(line)}`);
      ANSI.lastIndex = 0;
    }
  });

  it('emits no ANSI escapes under the monochrome theme even when colour is on', () => {
    for (const line of renderCard(kitchenSink(), { width: 60, color: true, theme: MONO_THEME })) {
      assert.ok(!ANSI.test(line), `escape leaked: ${JSON.stringify(line)}`);
      ANSI.lastIndex = 0;
    }
  });

  it('uses no characters outside ASCII under the ascii theme', () => {
    const plain = card([
      text('plain'),
      badges([{ text: 'bug', tone: 'attention' }]),
      { type: 'Container', title: 'Group', separator: true, items: [text('inside')] },
    ]);
    for (const line of renderCard(plain, { width: 40, color: false, theme: ASCII_THEME })) {
      // eslint-disable-next-line no-control-regex
      assert.ok(/^[\u0000-\u007F]*$/.test(line), `non-ASCII: ${JSON.stringify(line)}`);
    }
  });

  it('renders nothing at all for a zero width instead of throwing', () => {
    assert.deepEqual(renderCard(kitchenSink(), { width: 0, color: false, theme: DEFAULT_THEME }), []);
  });

  it('is stable: the same card renders the same rows twice', () => {
    const sink = kitchenSink();
    const options = { width: 55, color: false, theme: DEFAULT_THEME } as const;
    assert.deepEqual(renderCard(sink, options), renderCard(sink, options));
  });

  it('drops an empty badge set rather than leaving a stray label', () => {
    const rows = renderCard(card([badges([], { label: 'Labels' })]), {
      width: 40,
      color: false,
      theme: DEFAULT_THEME,
    });
    assert.ok(!rows.join('\n').includes('Labels'));
  });

  it('shows a tone mark, so meaning survives without colour', () => {
    const rows = renderCard(card([badges([{ text: 'security', tone: 'attention' }])]), {
      width: 40,
      color: false,
      theme: MONO_THEME,
    });
    assert.ok(rows.join('\n').includes('x security'), rows.join('\n'));
  });

  /**
   * The accessibility contract as an executable claim: strip the colour and no two tones
   * become indistinguishable, because each status tone carries its own mark.
   */
  it('distinguishes every status tone without colour', () => {
    const rendered = renderCard(
      card([
        badges([
          { text: 'alpha', tone: 'good' },
          { text: 'alpha', tone: 'warning' },
          { text: 'alpha', tone: 'attention' },
        ]),
      ]),
      { width: 60, color: false, theme: MONO_THEME },
    ).join('\n');
    assert.ok(rendered.includes('+ alpha'), rendered);
    assert.ok(rendered.includes('! alpha'), rendered);
    assert.ok(rendered.includes('x alpha'), rendered);
  });

  it('stacks a column set when the pane is too narrow to split it', () => {
    const columns = card([
      {
        type: 'ColumnSet',
        columns: [{ items: [text('leftmost')] }, { items: [text('rightmost')] }],
      },
    ]);
    const narrow = renderCard(columns, { width: 14, color: false, theme: DEFAULT_THEME }).join('\n');
    assert.ok(narrow.includes('leftmost'), narrow);
    assert.ok(narrow.includes('rightmost'), narrow);
  });

  it('keeps a quoted line quoted instead of reflowing it into the paragraph', () => {
    const rows = renderCard(card([prose('Reply text.\n\n> original message')]), {
      width: 40,
      color: false,
      theme: DEFAULT_THEME,
    });
    assert.ok(rows.some((r) => r.trimStart().startsWith('> original message')), rows.join('\n'));
  });

  it('honours the compact theme by producing no more rows than the default', () => {
    const sink = kitchenSink();
    const compact = renderCard(sink, { width: 60, color: false, theme: COMPACT_THEME });
    const normal = renderCard(sink, { width: 60, color: false, theme: DEFAULT_THEME });
    assert.ok(compact.length <= normal.length, `${String(compact.length)} > ${String(normal.length)}`);
  });
});

describe('renderCardRows', () => {
  /**
   * The regression test for a real bug. The pane used to receive rows that had already been
   * coloured, then re-fit each one; `sanitizeForDisplay` strips the ESC byte but leaves the
   * `[36m` behind, so the escape was printed as visible text. Rows must be plain, with the
   * colour carried beside them.
   */
  it('returns plain text with the colour carried alongside, never embedded', () => {
    const rows = renderCardRows(
      card([facts([{ title: 'State', value: 'open', tone: 'good' }])], { title: 'Heading' }),
      { width: 40, color: true, theme: DEFAULT_THEME },
    );
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(!row.text.includes('\u001B'), `escape in text: ${JSON.stringify(row.text)}`);
      assert.ok(!row.text.includes('[3'), `escape residue in text: ${JSON.stringify(row.text)}`);
    }
  });

  it('assigns a colour to at least one row when the card has tone', () => {
    const rows = renderCardRows(card([facts([{ title: 'State', value: 'open', tone: 'good' }])]), {
      width: 40,
      color: true,
      theme: DEFAULT_THEME,
    });
    assert.ok(rows.some((row) => row.color !== undefined));
  });

  it('assigns no colour at all under the monochrome theme', () => {
    const rows = renderCardRows(card([facts([{ title: 'State', value: 'open', tone: 'good' }])]), {
      width: 40,
      color: true,
      theme: MONO_THEME,
    });
    assert.ok(rows.every((row) => row.color === undefined));
  });

  it('agrees with renderCard on the visible text', () => {
    const sink = kitchenSink();
    const rows = renderCardRows(sink, { width: 50, color: false, theme: DEFAULT_THEME });
    const lines = renderCard(sink, { width: 50, color: false, theme: DEFAULT_THEME });
    assert.deepEqual(rows.map((r) => r.text), lines);
  });
});

describe('themes', () => {
  it('falls back to the default rather than failing on an unknown name', () => {
    assert.equal(themeByName('no-such-theme').name, 'default');
    assert.equal(themeByName(undefined).name, 'default');
  });

  it('selects ascii for plain mode, because plain promises no box drawing', () => {
    assert.equal(themeFor({ plain: true }).name, 'ascii');
    assert.equal(themeFor({}).name, 'default');
  });

  it('lets an explicit choice override plain mode', () => {
    assert.equal(themeFor({ plain: true, cardTheme: 'compact' }).name, 'compact');
  });

  /**
   * The structural guarantee. A theme that gave a status tone no mark would be encoding
   * meaning in colour alone, which `docs/ACCESSIBILITY.md` forbids. The type makes `mark`
   * mandatory; this makes sure no theme sets it to the empty string for a status.
   */
  it('gives every status tone a mark in every theme', () => {
    for (const theme of Object.values(THEMES)) {
      for (const tone of ['good', 'warning', 'attention'] as const) {
        assert.notEqual(
          theme.tones[tone].mark,
          '',
          `${theme.name} has no mark for ${tone}, so its meaning would be colour-only`,
        );
      }
    }
  });

  it('gives the status tones distinct marks, so they stay distinguishable', () => {
    for (const theme of Object.values(THEMES)) {
      const marks = (['good', 'warning', 'attention'] as const).map((t) => theme.tones[t].mark);
      assert.equal(new Set(marks).size, marks.length, `${theme.name} reuses a mark: ${marks.join(' ')}`);
    }
  });
});
