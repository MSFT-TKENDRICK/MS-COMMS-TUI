/**
 * The TUI's renderer.
 *
 * Pure: state in, an array of lines out. No writes, no cursor arithmetic — the caller joins
 * the lines and paints them. That keeps every layout decision assertable in a test, which
 * matters more here than usual, because layout bugs in a full-screen interface are
 * invisible in a diff and obvious only to the person using it.
 *
 * THE WIDTH DISCIPLINE
 *
 * `displayWidth` counts characters, and an ANSI escape is characters. `paint(x)` therefore
 * makes a string five to nine columns "wider" as far as any padding or truncation is
 * concerned. So every line in this file is built in two strictly ordered phases:
 *
 *   1. Compose plain text and {@link fit} it to an exact column count.
 *   2. Colour the fitted string, whole, as the last thing that happens to it.
 *
 * Colouring before fitting silently corrupts the layout, and the corruption appears only on
 * the rows that happen to be coloured. There is no step 3.
 *
 * THE OTHER TWO RULES
 *
 * Colour is decoration: every distinction it carries is also carried by a glyph or by word
 * order, so the display degrades to monochrome without losing meaning. The selected row is
 * marked `>`, not merely reverse-video.
 *
 * Every line is exactly the terminal's width. A line that overflows wraps, and a wrapped
 * line in a fixed-position pane corrupts every row beneath it.
 */

import { displayWidth, formatDate, padTo, paint, sanitizeForDisplay, truncateWidth } from '../format.js';
import type { FormatOptions } from '../format.js';
import { visibleEntries } from './state.js';
import type { TuiState } from './state.js';

export interface RenderOptions extends FormatOptions {
  readonly columns: number;
  readonly rows: number;
}

/** Rows consumed by furniture: title, rule, rule, status, input. */
export const CHROME_ROWS = 5;

/** How many body rows a terminal of this height leaves for the list. */
export function bodyRows(rows: number): number {
  return Math.max(1, rows - CHROME_ROWS);
}

/**
 * Sanitize, truncate and pad to exactly `width` columns of plain text.
 *
 * The one function every line goes through. If a string reaches the screen without passing
 * here, the pane is misaligned.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  return padTo(truncateWidth(sanitizeForDisplay(text), width), width);
}

export function render(state: TuiState, options: RenderOptions): string[] {
  const width = Math.max(24, options.columns);
  if (state.mode === 'help') return renderHelp({ ...options, columns: width });

  const body = bodyRows(options.rows);
  const split = state.preview.length > 0;
  // The 1 column is the divider. Below ~60 columns a split leaves neither pane readable,
  // so we stop splitting rather than render two useless slivers.
  const listWidth = split && width >= 60 ? Math.floor((width - 1) * 0.45) : width;
  const previewWidth = listWidth === width ? 0 : width - listWidth - 1;

  const lines: string[] = [titleLine(state, width, options), rule(width, options)];

  const left = renderList(state, listWidth, body, options);
  const right = previewWidth > 0 ? renderPreview(state, previewWidth, body, options) : [];

  for (let i = 0; i < body; i += 1) {
    const listRow = left[i] ?? ' '.repeat(listWidth);
    if (previewWidth <= 0) {
      lines.push(listRow);
      continue;
    }
    lines.push(`${listRow}${paint('\u2502', 'dim', options.color)}${right[i] ?? ' '.repeat(previewWidth)}`);
  }

  lines.push(rule(width, options));
  lines.push(fit(statusLine(state), width));
  lines.push(inputLine(state, width, options));
  return lines;
}

/**
 * The status line, with the microphone state prepended when it is on.
 *
 * A recording indicator is not decoration. The one thing a user must be able to check at a
 * glance, in a program that can hear them, is whether it is listening right now — and it has
 * to be a word rather than a coloured dot, because the people most likely to be using voice
 * control are the least likely to be able to see one.
 */
export function statusLine(state: TuiState): string {
  switch (state.voice.phase) {
    case 'listening':
      return `[MIC ON] ${state.status}`;
    case 'transcribing':
      return `[MIC …] ${state.status}`;
    case 'off':
    case 'idle':
      return state.status;
    default:
      return `[MIC] ${state.status}`;
  }
}

function rule(width: number, options: RenderOptions): string {
  return paint('\u2500'.repeat(width), 'dim', options.color);
}

function titleLine(state: TuiState, width: number, options: RenderOptions): string {
  // The counts are spelled out rather than implied by a scrollbar, because a scrollbar is
  // a picture of a number and this is the number.
  const shown = visibleEntries(state);
  const count =
    state.filter === ''
      ? `${String(shown.length)} items`
      : `${String(shown.length)} of ${String(state.entries.length)} match`;
  const right = state.busy ? `${count} \u2014 working` : count;

  const rightWidth = Math.min(displayWidth(right), Math.max(0, width - 8));
  const leftWidth = width - rightWidth;
  return paint(fit(state.cwd, leftWidth), 'bold', options.color) + paint(fit(right, rightWidth), 'dim', options.color);
}

function renderList(state: TuiState, width: number, body: number, options: RenderOptions): string[] {
  const shown = visibleEntries(state);
  const rows: string[] = [];

  if (shown.length === 0) {
    rows.push(fit(state.filter === '' ? '(empty)' : `(nothing matches "${state.filter}")`, width));
    while (rows.length < body) rows.push(' '.repeat(width));
    return rows;
  }

  for (let i = state.offset; i < Math.min(shown.length, state.offset + body); i += 1) {
    const node = shown[i];
    if (node === undefined) continue;

    // The selection marker is drawn whichever pane has focus, so you never lose your place
    // while reading a message. Colour, the weaker signal, tracks focus instead.
    const marker = i === state.selected ? '> ' : '  ';
    const unread = node.flags?.includes('unread') === true ? '*' : ' ';
    const focused = i === state.selected && state.pane === 'list';

    const date = formatDate(node.mtime, options.dateStyle);
    const dateRoom = date === '' ? 0 : Math.min(displayWidth(date) + 1, Math.max(0, width - 12));
    const nameRoom = Math.max(1, width - 3 - dateRoom);

    const name = fit(node.name + (node.kind === 'dir' ? '/' : ''), nameRoom);
    const tail = dateRoom === 0 ? '' : fit(` ${date}`, dateRoom);
    const line = fit(`${marker}${unread}${name}${tail}`, width);
    rows.push(focused ? paint(line, 'cyan', options.color) : line);
  }

  while (rows.length < body) rows.push(' '.repeat(width));
  return rows;
}

function renderPreview(state: TuiState, width: number, body: number, options: RenderOptions): string[] {
  const title = fit(state.previewTitle, width);
  const rows: string[] = [state.pane === 'preview' ? paint(title, 'bold', options.color) : title, ' '.repeat(width)];

  const room = Math.max(0, body - rows.length);
  for (let i = state.previewOffset; i < Math.min(state.preview.length, state.previewOffset + room); i += 1) {
    rows.push(fit(state.preview[i] ?? '', width));
  }
  while (rows.length < body) rows.push(' '.repeat(width));
  return rows;
}

function inputLine(state: TuiState, width: number, options: RenderOptions): string {
  // The block is a cursor stand-in; the app parks the real cursor here too, so a terminal
  // that reports cursor position to an assistive tool reports the position that matters.
  if (state.mode === 'filter') return fit(`Filter: ${state.filter}\u2588`, width);
  if (state.mode === 'command') return fit(`: ${state.command}\u2588`, width);

  // `/` appears in both hints. It is now the only way into a filter, so it has to be on
  // screen in every state it works in — which is both panes.
  const hint =
    state.pane === 'preview'
      ? 'Tab list   Up/Down scroll   / filter   : command   ? help   q quit'
      : 'Enter open   Backspace up   / filter   : command   ? help   q quit';
  return paint(fit(hint, width), 'dim', options.color);
}

/**
 * The help screen.
 *
 * It documents the escape hatch as prominently as the keys. Someone who reached this screen
 * because the pane is hard to use needs to be told, here, that they do not have to use it.
 */
export function renderHelp(options: RenderOptions): string[] {
  const width = Math.max(24, options.columns);
  const keys: readonly (readonly [string, string])[] = [
    ['Up / Down, j / k', 'move the selection'],
    ['PageUp / PageDown', 'move by a screenful'],
    ['Home / End', 'first / last item'],
    ['Enter, Right, l', 'open a folder, or read a message'],
    ['Backspace, Left, h', 'go up one level'],
    ['Tab', 'switch between the list and the preview'],
    ['/', 'filter as you type (Enter keeps it, Escape clears it)'],
    [':', 'run any command \u2014 ls, find, grep, cat, open, mark, watch\u2026'],
    ['r, F5', 'refresh the current folder'],
    ['u', 'undo the last change (anywhere \u2014 pane, shell, or voice)'],
    ['Ctrl+Space', 'push to talk: speak one command (needs `voice on`)'],
    ['?', 'this screen'],
    ['Ctrl+C', 'always works, from any mode, even mid-filter'],
    ['q, Escape', 'leave (the folder and selection are printed on the way out)'],
  ];

  const keyWidth = keys.reduce((max, pair) => Math.max(max, displayWidth(pair[0])), 0);
  const out: string[] = [paint(fit('Keys', width), 'bold', options.color), ' '.repeat(width)];
  for (const [key, meaning] of keys) out.push(fit(`  ${padTo(key, keyWidth)}   ${meaning}`, width));

  out.push(' '.repeat(width));
  out.push(paint(fit('The full-screen view adds no capability of its own.', width), 'bold', options.color));
  for (const line of [
    'Everything above is also a command, and `:` reaches the same command table as the',
    'line shell. If this pane is awkward to use, quit and run mscomms without --tui: the',
    'line shell does everything this does, in plain text, one line at a time.',
    '',
    'That includes speech. Voice does not drive the pane directly \u2014 it produces the same',
    'command line you would have typed, so anything you can say, you can type and undo.',
    '',
    'Press any key to go back.',
  ]) {
    out.push(fit(line, width));
  }
  return out;
}
