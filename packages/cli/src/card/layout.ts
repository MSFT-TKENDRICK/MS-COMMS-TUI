/**
 * Layout — splitting a width between columns, and wrapping text to fit one.
 *
 * WHY NOT FLEXBOX
 *
 * The obvious move is to reach for a real layout engine. Ink uses Yoga, Facebook's C++
 * flexbox implementation, shipped as a WebAssembly binary. That buys `align-items`,
 * `flex-basis`, `flex-shrink`, absolute positioning, aspect ratios and a specification's
 * worth of edge cases — none of which a detail pane asks for. What it asks for is "this
 * column is 12 columns wide, that one takes what is left", plus wrapping.
 *
 * So the model here is Ratatui's, not CSS's: a {@link Rect} and a list of
 * {@link Constraint}s, split into child rects. Ratatui drives real, complex terminal
 * applications on this and it fits in a screenful of code. See docs/PRIOR-ART.md.
 *
 * WIDTHS ARE MEASURED, NOT COUNTED
 *
 * Every function here measures with `displayWidth`, never `String.length`. A CJK subject
 * line is twice as wide as it is long, an emoji with a variation selector is two code
 * points and one column, and a combining accent is one code point and no columns. Getting
 * this wrong misaligns a pane, and — because the misalignment is proportional to how much
 * non-Latin text a user reads — it is invisible in testing and constant in use.
 */

import type { Constraint } from '@mscomms/core';
import { displayWidth, truncateWidth } from '../format.js';

/** A rectangle in terminal cells. The unit of layout, borrowed from Ratatui. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Divide `total` columns among `constraints`.
 *
 * Fixed sizes are honoured first, then percentages of the original total, then whatever
 * remains is shared between `fill` weights. Ordering matters: resolving fills against the
 * pre-fixed total would over-commit and push the last column off the edge.
 *
 * Never returns a negative width, and never returns more in total than it was given —
 * a caller that trusted an over-wide answer would wrap a row and corrupt every row below,
 * which is the specific failure the TUI's width discipline exists to prevent.
 */
export function splitWidth(total: number, constraints: readonly Constraint[], gap = 0): number[] {
  if (constraints.length === 0 || total <= 0) return constraints.map(() => 0);

  const gaps = gap * Math.max(0, constraints.length - 1);
  const usable = Math.max(0, total - gaps);

  const sizes: number[] = new Array<number>(constraints.length).fill(0);
  let used = 0;

  constraints.forEach((constraint, i) => {
    if (constraint.kind === 'length') {
      sizes[i] = Math.max(0, Math.min(constraint.value, usable - used));
      used += sizes[i] ?? 0;
    } else if (constraint.kind === 'percent') {
      const want = Math.floor((usable * Math.max(0, constraint.value)) / 100);
      sizes[i] = Math.max(0, Math.min(want, usable - used));
      used += sizes[i] ?? 0;
    }
  });

  const fills = constraints
    .map((constraint, i) => ({ constraint, i }))
    .filter((entry) => entry.constraint.kind === 'fill');

  if (fills.length > 0) {
    const remaining = Math.max(0, usable - used);
    const totalWeight = fills.reduce(
      (sum, entry) => sum + Math.max(0, entry.constraint.kind === 'fill' ? entry.constraint.weight : 0),
      0,
    );

    if (totalWeight > 0) {
      let handed = 0;
      fills.forEach((entry, n) => {
        const weight = entry.constraint.kind === 'fill' ? Math.max(0, entry.constraint.weight) : 0;
        // The last fill takes the rounding remainder, so the columns sum exactly to the
        // space available instead of leaving a stray blank column on the right.
        const size =
          n === fills.length - 1 ? remaining - handed : Math.floor((remaining * weight) / totalWeight);
        sizes[entry.i] = Math.max(0, size);
        handed += sizes[entry.i] ?? 0;
      });
    }
  }

  return sizes;
}

/**
 * Break `value` into lines no wider than `width` columns.
 *
 * Breaks on spaces where it can and mid-word where it must, because a URL or a 40-character
 * identifier is not going to become shorter by being asked politely, and letting it
 * overflow corrupts the pane.
 *
 * Existing newlines are honoured, and an indented line is never re-flowed: indentation in a
 * message body means quoted text or code, and re-wrapping it destroys the only structure it
 * has. That rule is inherited from `wrapBody`, which has always applied it to mail.
 */
export function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];

  for (const raw of value.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') {
      out.push('');
      continue;
    }

    // Preserved verbatim, but still hard-capped: an over-wide line is a wrapped line, and
    // a wrapped line in a fixed-height pane pushes everything below it out of place.
    if (/^\s/.test(raw)) {
      out.push(displayWidth(raw) <= width ? raw : truncateWidth(raw, width));
      continue;
    }

    out.push(...wrapParagraph(raw, width));
  }

  return out;
}

/**
 * The longest prefix of `value` that fits in `width` columns, with nothing added.
 *
 * The counterpart to `truncateWidth`, and the distinction matters more than it looks.
 * `truncateWidth` marks that content was dropped, which is right when the rest is being
 * discarded and wrong when the rest is about to be shown on the next line: the marker then
 * claims a loss that did not happen, and — because the marker occupies a column — it
 * displaces a real character that then never appears anywhere.
 *
 * Measured by display width, so a CJK string is cut at the right column rather than the
 * right character count.
 */
export function sliceWidth(value: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;

  let out = '';
  let used = 0;
  // Iterating the string yields whole code points, so a surrogate pair is never split in
  // half — which would produce a replacement character rather than a narrower line.
  for (const char of value) {
    const w = displayWidth(char);
    if (used + w > width) break;
    out += char;
    used += w;
  }
  return out;
}

function wrapParagraph(paragraph: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of paragraph.split(/ +/)) {
    if (word === '') continue;

    const candidate = line === '' ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= width) {
      line = candidate;
      continue;
    }

    if (line !== '') {
      lines.push(line);
      line = '';
    }

    // A single word wider than the pane — almost always a URL. Slice it into full-width
    // pieces rather than letting it overflow; the alternative is a corrupted layout.
    //
    // Sliced with {@link sliceWidth} and emphatically not with `truncateWidth`, which
    // appends an ellipsis. Using the truncating version here was a real bug: the ellipsis
    // replaced a character *and* was counted in the length used to advance, so a wrapped
    // URL came out both marked and missing characters — `.../pul…` then `/4821`. A URL you
    // cannot copy is not a URL, which is the whole reason these wrap instead of truncating.
    let rest = word;
    while (displayWidth(rest) > width) {
      const head = sliceWidth(rest, width);
      // Nothing fits at all: the pane is narrower than a single character, which happens
      // with a wide character in a one-column space. Emitting the character anyway would
      // overflow and corrupt the layout, and dropping it silently would be a lie, so mark
      // the loss and stop. `truncateWidth` yields a bare ellipsis here, which is the widest
      // honest thing that fits.
      if (head === '') {
        lines.push(truncateWidth(rest, width));
        rest = '';
        break;
      }
      lines.push(head);
      rest = rest.slice(head.length);
    }
    line = rest;
  }

  if (line !== '') lines.push(line);
  return lines.length === 0 ? [''] : lines;
}

/**
 * Wrap, then cap at `maxLines`, marking the truncation.
 *
 * The marker is a word rather than an ellipsis. A reader who cannot see that content was
 * dropped will act on a partial document believing it complete, and in announce mode an
 * ellipsis is silent.
 *
 * The note is what gets protected when there is not room for both. An earlier version
 * appended the note and truncated the result, which at a narrow width cut the note off and
 * produced exactly the silent truncation this function exists to prevent — the reader saw
 * a clipped line and no reason to suspect there was more. So the *text* yields instead.
 */
export function wrapClamped(value: string, width: number, maxLines: number | undefined): string[] {
  const lines = wrapText(value, width);
  if (maxLines === undefined || maxLines <= 0 || lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  const hidden = lines.length - maxLines;
  const note = `(${String(hidden)} more line${hidden === 1 ? '' : 's'})`;
  // A short form for panes too narrow for the sentence. `(+3)` is four columns and still
  // unambiguous, where a truncated `(3 more l…` is neither the note nor the text.
  const short = `(+${String(hidden)})`;
  const last = kept[maxLines - 1] ?? '';

  const marker = displayWidth(note) + 1 < width ? note : short;
  // Room for the marker plus the space before it. When even the short form will not fit,
  // the marker still wins: a visible sign that something was cut matters more than one
  // more line of body text, because silent truncation is how a reader acts on a partial
  // document believing it complete.
  const room = width - displayWidth(marker) - 1;
  kept[maxLines - 1] =
    room <= 0 ? truncateWidth(marker, width) : `${truncateWidth(last, room)} ${marker}`;
  return kept;
}

/**
 * Lay items out across as many rows as needed, like inline-block elements.
 *
 * Used for badges. Anything wider than the pane goes on a row of its own and is truncated
 * rather than dropped: a label too long to display is still a label the reader needs to
 * know about, and dropping it silently would misrepresent the item.
 *
 * The truncation happens here rather than in the caller. It used to be the caller's job,
 * which meant a single over-long GitHub label produced a row wider than the pane, wrapped
 * the terminal, and displaced every row below it.
 */
export function flowItems(items: readonly string[], width: number, gap: string): string[] {
  if (width <= 0 || items.length === 0) return [];

  const rows: string[] = [];
  let row = '';

  for (const item of items) {
    const fitted = displayWidth(item) <= width ? item : truncateWidth(item, width);
    const candidate = row === '' ? fitted : `${row}${gap}${fitted}`;
    if (displayWidth(candidate) <= width) {
      row = candidate;
      continue;
    }
    if (row !== '') rows.push(row);
    row = fitted;
  }

  if (row !== '') rows.push(row);
  return rows;
}
