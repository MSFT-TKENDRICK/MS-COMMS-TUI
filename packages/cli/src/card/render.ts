/**
 * The card renderer — a {@link Card} in, an array of rows out.
 *
 * Pure. No writes, no cursor arithmetic, no terminal detection. The caller joins the rows
 * and paints them, exactly as `tui/render.ts` does for the list, and for the same reason:
 * layout bugs in a full-screen interface are invisible in a diff and obvious only to the
 * person using it, so every decision here has to be assertable in a test.
 *
 * THE WIDTH DISCIPLINE, INHERITED
 *
 * `tui/render.ts` documents the rule this file also obeys: an ANSI escape is characters, so
 * `paint()` makes a string five to nine columns "wider" as far as padding and truncation
 * are concerned. Every row is therefore built in two strictly ordered phases:
 *
 *   1. Compose plain text and fit it to an exact column count.
 *   2. Colour the fitted string, whole, as the last thing that happens to it.
 *
 * Colouring before fitting corrupts the layout, and only on the rows that happen to be
 * coloured. There is no step 3.
 *
 * Tone marks are applied in phase 1, not phase 2. The mark is content — it is what carries
 * the meaning when colour is unavailable — so it has to be measured like content.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * No scrolling, no focus, no event handling, no state. The pane already scrolls by slicing
 * the row array, and a renderer that owned a viewport would be a second, competing one.
 */

import type {
  ActionSet,
  BadgeSet,
  Card,
  CardElement,
  ColumnSet,
  Constraint,
  Container,
  FactSet,
  Prose,
  Table,
  TableCell,
  TextBlock,
  Tone,
} from '@mscomms/core';
import { displayWidth, padTo, paint, sanitizeForDisplay, truncateWidth } from '../format.js';
import type { ColorName } from '../format.js';
import { flowItems, splitWidth, wrapClamped, wrapText } from './layout.js';
import { DEFAULT_THEME, toneStyle, withMark } from './theme.js';
import type { Theme } from './theme.js';

export interface CardRenderOptions {
  readonly width: number;
  readonly color: boolean;
  readonly theme?: Theme;
}

/**
 * A row that has been composed but not yet coloured.
 *
 * Keeping the two apart until the end is what makes the width discipline mechanical rather
 * than a thing every branch has to remember. Internal renderers return `Row[]`; only the
 * final step turns them into strings.
 *
 * It is also the shape the TUI preview pane needs. That pane re-fits whatever it is handed,
 * and `sanitizeForDisplay` strips the ESC from an ANSI sequence while leaving `[36m` behind
 * as visible text — so handing it a pre-coloured string paints literal escape codes on the
 * screen. Handing it plain text plus a colour lets it fit first and paint last, which is
 * the only order that works.
 */
export interface CardRow {
  readonly text: string;
  readonly color?: ColorName;
}

type Row = CardRow;

const plainRow = (text: string): Row => ({ text });

/**
 * A row coloured by a tone, via the theme rather than a literal.
 *
 * Always use this rather than writing `color:` by hand. A theme that declares no colour for
 * a tone must produce no escape at all, and the only way to guarantee that everywhere is to
 * make the theme the single source.
 */
function toneRow(text: string, theme: Theme, tone: Tone): Row {
  const color = toneStyle(theme, tone).color;
  return color === undefined ? { text } : { text, color };
}

/**
 * Render a card to plain rows of exactly `width` columns, each with its colour alongside.
 *
 * The form the TUI preview pane consumes: text it can fit, and a colour it can apply after
 * fitting. See {@link CardRow} for why the two must stay apart.
 *
 * Rows are padded to the full width because the pane is a fixed region beside a list: a
 * short row would leave the previous frame's characters visible to its right.
 */
export function renderCardRows(value: Card, options: CardRenderOptions): CardRow[] {
  const theme = options.theme ?? DEFAULT_THEME;
  const width = Math.floor(options.width);
  // A pane with no columns gets no rows. Clamping up to 1 instead produced a column of
  // single characters, which is not a degraded rendering but a corrupted one — and the
  // case is reachable, because the TUI gives the preview no width at all below 60 columns.
  if (!Number.isFinite(width) || width <= 0) return [];

  const rows: Row[] = [];

  if (value.title !== undefined && value.title.trim() !== '') {
    for (const line of wrapText(sanitizeForDisplay(value.title), width)) {
      rows.push({ text: line, ...(theme.headingColor === undefined ? {} : { color: theme.headingColor }) });
    }
    rows.push(plainRow(''));
  }

  const body = renderElements(value.body, width, theme);
  rows.push(...body);

  // A card with a title and nothing else is a pane that looks broken. `fallbackText` is
  // Adaptive Cards' own answer to "this could not be rendered", so it is the right thing
  // to fall back to before inventing a message.
  if (body.length === 0) {
    const note = value.fallbackText?.trim();
    rows.push(plainRow(note === undefined || note === '' ? 'Nothing to show.' : note));
  }

  return rows.map((row) => ({
    ...row,
    text: padTo(truncateWidth(sanitizeForDisplay(row.text), width), width),
  }));
}

/**
 * Render a card to finished strings, colour included.
 *
 * For callers that write straight to a stream and do no further layout of their own.
 */
export function renderCard(value: Card, options: CardRenderOptions): string[] {
  return renderCardRows(value, options).map((row) =>
    row.color === undefined ? row.text : paint(row.text, row.color, options.color),
  );
}

function renderElements(elements: readonly CardElement[], width: number, theme: Theme): Row[] {
  const rows: Row[] = [];

  for (const element of elements) {
    const produced = renderElement(element, width, theme);
    // Spacing and separators are suppressed for an element that rendered nothing. A card
    // built from optional backend fields is mostly empty elements, and honouring their
    // spacing would open the pane with a run of blank rows and a rule over nothing.
    if (produced.length === 0) continue;

    if (rows.length > 0) {
      const gap = theme.spacing[element.spacing ?? 'default'];
      for (let i = 0; i < gap; i += 1) rows.push(plainRow(''));
    }

    if (element.separator === true && rows.length > 0) {
      // The rule's colour comes from the theme's `subtle` tone rather than a literal, so a
      // theme that declares no colours produces none. Hard-coding `dim` here meant the
      // monochrome theme still emitted an escape, which is precisely the leak that theme
      // exists to detect.
      rows.push(toneRow(theme.glyphs.rule.repeat(width), theme, 'subtle'));
    }

    rows.push(...produced);
  }

  return rows;
}

function renderElement(element: CardElement, width: number, theme: Theme): Row[] {
  switch (element.type) {
    case 'TextBlock':
      return renderTextBlock(element, width, theme);
    case 'FactSet':
      return renderFactSet(element, width, theme);
    case 'BadgeSet':
      return renderBadgeSet(element, width, theme);
    case 'Table':
      return renderTable(element, width, theme);
    case 'ColumnSet':
      return renderColumnSet(element, width, theme);
    case 'Container':
      return renderContainer(element, width, theme);
    case 'ActionSet':
      return renderActionSet(element, width, theme);
    case 'Prose':
      return renderProse(element, width, theme);
  }
}

function colorFor(theme: Theme, tone: Tone | undefined, style: TextBlock['style']): ColorName | undefined {
  if (style === 'heading') return theme.headingColor ?? toneStyle(theme, tone).color;
  return toneStyle(theme, tone).color;
}

function renderTextBlock(element: TextBlock, width: number, theme: Theme): Row[] {
  const raw = element.text.trim();
  if (raw === '') return [];

  const marked = withMark(theme, element.tone, raw);
  const color = colorFor(theme, element.tone, element.style);

  // `wrap` is opt-in, matching Adaptive Cards. An unwrapped block is a single line that
  // gets truncated, which is what a caller wants for a value that must not consume the pane.
  const lines =
    element.wrap === true ? wrapClamped(marked, width, element.maxLines) : [truncateWidth(marked, width)];

  return lines.map((line) => ({ text: line, ...(color === undefined ? {} : { color }) }));
}

/**
 * Facts, as an aligned two-column block.
 *
 * The label column is capped so one long label cannot squeeze the values into nothing —
 * the same cap the listing's own columns apply, for the same reason.
 */
function renderFactSet(element: FactSet, width: number, theme: Theme): Row[] {
  const facts = element.facts.filter((fact) => fact.value.trim() !== '');
  if (facts.length === 0) return [];

  const longest = Math.max(...facts.map((fact) => displayWidth(`${fact.title}:`)));
  const labelWidth = Math.min(longest, theme.maxFactLabel, Math.max(1, width - 4));
  const valueWidth = Math.max(1, width - labelWidth - theme.factGap);
  const gap = ' '.repeat(theme.factGap);

  const rows: Row[] = [];
  for (const fact of facts) {
    const label = padTo(truncateWidth(`${fact.title}:`, labelWidth), labelWidth);
    const value = withMark(theme, fact.tone, fact.value.trim());
    const wrapped = wrapText(value, valueWidth);
    const color = toneStyle(theme, fact.tone).color;

    wrapped.forEach((line, i) => {
      // Continuation lines are indented under the value, not the label, so a wrapped
      // value cannot be mistaken for a new fact.
      const prefix = i === 0 ? label : ' '.repeat(labelWidth);
      rows.push({ text: `${prefix}${gap}${line}`, ...(i === 0 && color !== undefined ? { color } : {}) });
    });
  }

  return rows;
}

/**
 * Badges, flowed across rows.
 *
 * Every badge is bracketed, so a set of them is legible as a set without colour, and each
 * carries its tone's mark inside the brackets. `[! needs-triage]` says what it means in a
 * monochrome terminal and in a screen reader.
 *
 * Badge rows are never coloured, and that is a deliberate limitation rather than an
 * oversight. A row usually holds badges of several tones, so painting the row whole would
 * state one badge's tone over all of them — actively misleading. Painting each badge in
 * place would mean embedding escapes in text the pane has yet to fit, which is exactly the
 * corruption {@link CardRow} exists to prevent.
 *
 * So badges are the case where the accessibility contract does all the work: because
 * `ToneStyle.mark` is mandatory, dropping the colour loses nothing that was not already
 * said in text.
 */
function renderBadgeSet(element: BadgeSet, width: number, theme: Theme): Row[] {
  const badges = element.badges.filter((badge) => badge.text.trim() !== '');
  if (badges.length === 0) return [];

  const label = element.label?.trim();
  const lead = label === undefined || label === '' ? '' : `${label}: `;
  const room = Math.max(1, width - displayWidth(lead));

  const rendered = badges.map((badge) => {
    const inner = withMark(theme, badge.tone, badge.text.trim());
    return `${theme.glyphs.badgeOpen}${inner}${theme.glyphs.badgeClose}`;
  });

  const flowed = flowItems(rendered, room, ' ');
  return flowed.map((row, i) => plainRow(i === 0 ? `${lead}${row}` : `${' '.repeat(displayWidth(lead))}${row}`));
}

/**
 * A table with aligned columns.
 *
 * Column widths come from the declared constraints, or are shared equally when the card did
 * not say. Cells are truncated rather than wrapped: a table whose rows have different
 * heights is far harder to read down a column, and the pane is narrow enough that a wrapped
 * cell would usually be taller than it is wide.
 */
function renderTable(element: Table, width: number, theme: Theme): Row[] {
  const columnCount = Math.max(
    element.header?.length ?? 0,
    ...element.rows.map((row) => row.length),
    0,
  );
  if (columnCount === 0 || element.rows.length === 0) return [];

  const gap = theme.glyphs.columnGap;
  const constraints: Constraint[] =
    element.columns !== undefined && element.columns.length === columnCount
      ? [...element.columns]
      : new Array<Constraint>(columnCount).fill({ kind: 'fill', weight: 1 });

  const widths = splitWidth(width, constraints, displayWidth(gap));

  const line = (cells: readonly TableCell[], heading: boolean): Row => {
    const text = widths
      .map((columnWidth, i) => {
        const cell = cells[i];
        if (columnWidth <= 0) return '';
        const value = cell === undefined ? '' : withMark(theme, cell.tone, cell.text.trim());
        return padTo(truncateWidth(value, columnWidth), columnWidth);
      })
      .join(gap);
    if (!heading || theme.headingColor === undefined) return plainRow(text);
    return { text, color: theme.headingColor };
  };

  const rows: Row[] = [];
  if (element.header !== undefined && element.header.length > 0) {
    rows.push(line(element.header, true));
    // A rule under the header rather than colour alone, so the header is identifiable as a
    // header without it.
    rows.push(
      toneRow(
        theme.glyphs.rule.repeat(
          Math.min(width, widths.reduce((a, b) => a + b, 0) + displayWidth(gap) * (widths.length - 1)),
        ),
        theme,
        'subtle',
      ),
    );
  }
  for (const row of element.rows) rows.push(line(row, false));

  return rows;
}

/**
 * Side-by-side columns, which stack when there is not enough room.
 *
 * The threshold is the same judgement the TUI makes when it stops splitting the screen at
 * 60 columns: two unreadable slivers are worse than two readable blocks. Stacking preserves
 * every word; splitting too narrow does not.
 */
function renderColumnSet(element: ColumnSet, width: number, theme: Theme): Row[] {
  const columns = element.columns.filter((column) => column.items.length > 0);
  if (columns.length === 0) return [];
  if (columns.length === 1) return renderElements(columns[0]?.items ?? [], width, theme);

  const gap = theme.glyphs.columnGap;
  const gapWidth = displayWidth(gap);
  const minimum = 12 * columns.length + gapWidth * (columns.length - 1);

  if (width < minimum) {
    const rows: Row[] = [];
    for (const column of columns) rows.push(...renderElements(column.items, width, theme));
    return rows;
  }

  const constraints = columns.map((column) => column.width ?? ({ kind: 'fill', weight: 1 } as Constraint));
  const widths = splitWidth(width, constraints, gapWidth);
  const blocks = columns.map((column, i) => renderElements(column.items, widths[i] ?? 0, theme));
  const height = Math.max(...blocks.map((block) => block.length));

  const rows: Row[] = [];
  for (let y = 0; y < height; y += 1) {
    // Each cell is padded to its own column width before joining, so a short block on the
    // left does not drag the right-hand column inwards on that row.
    const text = blocks
      .map((block, i) => {
        const columnWidth = widths[i] ?? 0;
        const cell = block[y];
        const plain = cell === undefined ? '' : cell.text;
        return padTo(truncateWidth(plain, columnWidth), columnWidth);
      })
      .join(gap);
    rows.push(plainRow(text));
  }

  return rows;
}

/** A titled, indented group. Nests, so a comment thread is containers inside a container. */
function renderContainer(element: Container, width: number, theme: Theme): Row[] {
  const title = element.title?.trim();
  const hasTitle = title !== undefined && title !== '';
  const indent = hasTitle ? Math.min(theme.containerIndent, Math.max(0, width - 8)) : 0;
  const inner = Math.max(1, width - indent);

  const body = renderElements(element.items, inner, theme);
  if (body.length === 0 && !hasTitle) return [];

  const rows: Row[] = [];
  if (hasTitle) {
    const marked = withMark(theme, element.tone, title);
    const color = toneStyle(theme, element.tone).color ?? theme.headingColor;
    rows.push({ text: truncateWidth(marked, width), ...(color === undefined ? {} : { color }) });
  }

  const pad = ' '.repeat(indent);
  for (const row of body) rows.push({ ...row, text: `${pad}${row.text}` });
  return rows;
}

/**
 * Links out.
 *
 * Rendered as labelled URLs rather than as buttons. There is nothing to click, and a button
 * that cannot be pressed is a worse lie than a URL that can be copied.
 */
function renderActionSet(element: ActionSet, width: number, theme: Theme): Row[] {
  const actions = element.actions.filter((action) => action.url.trim() !== '');
  if (actions.length === 0) return [];

  const rows: Row[] = [];
  for (const action of actions) {
    const title = action.title.trim();
    const text = title === '' ? action.url : `${title}: ${action.url}`;
    // URLs wrap rather than truncate. A truncated URL is not a URL, and copying it out of
    // the pane is the entire point of showing it.
    for (const wrapped of wrapText(text, width)) rows.push(plainRow(wrapped));
  }
  return rows;
}

function renderProse(element: Prose, width: number, theme: Theme): Row[] {
  const value = element.text.replace(/\s+$/, '');
  if (value.trim() === '') return [];
  return wrapText(value, width).map((line) => plainRow(line));
}
