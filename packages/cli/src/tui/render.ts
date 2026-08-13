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
import type { VNode } from '@mscomms/core';
import { accelerators, currentParam, visibleEntries } from './state.js';
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
  // The palette earns a pane the same way the preview does, and takes the preview's when
  // both want one: you asked to act on the thing you are reading, so the thing you are
  // reading is not what needs the space.
  const choosing = isActing(state);
  const split = state.preview.length > 0 || choosing;
  // The 1 column is the divider. Below ~60 columns a split leaves neither pane readable,
  // so we stop splitting rather than render two useless slivers.
  const listWidth = split && width >= 60 ? Math.floor((width - 1) * 0.45) : width;
  const previewWidth = listWidth === width ? 0 : width - listWidth - 1;

  const lines: string[] = [titleLine(state, width, options), rule(width, options)];

  // On a narrow terminal there is one pane, so the palette has to take it outright —
  // otherwise choosing an action would mean choosing from a list you cannot see.
  const left =
    choosing && previewWidth <= 0
      ? renderActions(state, listWidth, body, options)
      : renderList(state, listWidth, body, options);
  const right =
    previewWidth <= 0
      ? []
      : choosing
        ? renderActions(state, previewWidth, body, options)
        : renderPreview(state, previewWidth, body, options);

  for (let i = 0; i < body; i += 1) {
    const listRow = left[i] ?? ' '.repeat(listWidth);
    if (previewWidth <= 0) {
      lines.push(listRow);
      continue;
    }
    lines.push(`${listRow}${paint('\u2502', 'dim', options.color)}${right[i] ?? ' '.repeat(previewWidth)}`);
  }

  lines.push(rule(width, options));
  lines.push(fit(statusRow(state), width));
  lines.push(inputLine(state, width, options));
  return lines;
}

/**
 * What the single status row says.
 *
 * Startup wins while it is running, and only then. The pane is drawn before the sources are
 * connected — that is what makes it feel instant — so for the first moment of a session the
 * most useful thing the row can hold is what is being waited for. The instant startup is
 * done the row goes back to the user's own business, and anything they did in the meantime
 * that produced a message is still there underneath, unclobbered.
 */
export function statusRow(state: TuiState): string {
  return state.startup === '' ? state.status : state.startup;
}

/** True while the user is choosing, filling in, or confirming an action. */
function isActing(state: TuiState): boolean {
  return state.mode === 'actions' || state.mode === 'param' || state.mode === 'confirm';
}

function rule(width: number, options: RenderOptions): string {
  return paint('\u2500'.repeat(width), 'dim', options.color);
}

/**
 * Braille spinner frames.
 *
 * Braille rather than ASCII `|/-\` because the glyphs are the same width and differ only in
 * which dots are lit, so the indicator animates in place instead of appearing to jitter.
 * They degrade to a box in a terminal without the font, which still visibly changes.
 */
const SPINNER = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

/**
 * What the title bar says while something is outstanding.
 *
 * The elapsed count is withheld for the first two seconds. Below that it is noise — every
 * operation would flash "0s" on its way past — and above it, it is the only thing that
 * distinguishes "slow" from "wedged", which is precisely the question a user staring at a
 * frozen-looking screen is asking.
 */
export function workingLabel(state: TuiState): string {
  const frame = SPINNER[state.tick % SPINNER.length] ?? '';
  const seconds = Math.floor(state.busyMs / 1000);
  return seconds >= 2 ? `${frame} working ${String(seconds)}s` : `${frame} working`;
}

function titleLine(state: TuiState, width: number, options: RenderOptions): string {
  // The counts are spelled out rather than implied by a scrollbar, because a scrollbar is
  // a picture of a number and this is the number.
  const shown = visibleEntries(state);
  const count =
    state.filter === ''
      ? `${String(shown.length)} items`
      : `${String(shown.length)} of ${String(state.entries.length)} match`;
  const right = state.busy ? `${count} ${workingLabel(state)}` : count;

  const rightWidth = Math.min(displayWidth(right), Math.max(0, width - 8));
  const leftWidth = width - rightWidth;
  return paint(fit(state.cwd, leftWidth), 'bold', options.color) + paint(fit(right, rightWidth), 'dim', options.color);
}

/** Room a name needs before the pane starts giving up other columns to find it some. */
const MIN_NAME_ROOM = 12;

function renderList(state: TuiState, width: number, body: number, options: RenderOptions): string[] {
  const shown = visibleEntries(state);
  const rows: string[] = [];

  if (shown.length === 0) {
    rows.push(fit(state.filter === '' ? '(empty)' : `(nothing matches "${state.filter}")`, width));
    while (rows.length < body) rows.push(' '.repeat(width));
    return rows;
  }

  const last = Math.min(shown.length, state.offset + body);

  // The unread counter is a reserved column rather than a suffix on the name, so it lands
  // in the same place on every row and survives a folder name long enough to be truncated.
  // Its width is measured over the rows actually on screen: one folder with 3629 unread
  // must not cost four columns of name on a screenful that does not contain it.
  let badgeWidth = 0;
  for (let i = state.offset; i < last; i += 1) {
    const node = shown[i];
    if (node !== undefined) badgeWidth = Math.max(badgeWidth, displayWidth(unreadBadge(node)));
  }
  const badgeRoom = badgeWidth === 0 ? 0 : badgeWidth + 1;

  for (let i = state.offset; i < last; i += 1) {
    const node = shown[i];
    if (node === undefined) continue;

    // The selection marker is drawn whichever pane has focus, so you never lose your place
    // while reading a message. Colour, the weaker signal, tracks focus instead.
    const marker = i === state.selected ? '> ' : '  ';
    const unread = node.flags?.includes('unread') === true || unreadOf(node) > 0 ? '*' : ' ';
    const focused = i === state.selected && state.pane === 'list';

    const date = formatDate(node.mtime, options.dateStyle);
    let dateRoom = date === '' ? 0 : Math.min(displayWidth(date) + 1, Math.max(0, width - 12));
    // The pane can be split narrow enough that the name, the counter and the date do not all
    // fit. The date goes first: it is the one thing here that says nothing about whether
    // there is anything new. Dropping it explicitly matters because the alternative is
    // letting `fit` shear the row, which silently eats whichever column happens to be last.
    if (width - 3 - badgeRoom - dateRoom < MIN_NAME_ROOM) dateRoom = 0;
    const nameRoom = Math.max(1, width - 3 - badgeRoom - dateRoom);

    const name = fit(node.name + (node.kind === 'dir' ? '/' : ''), nameRoom);
    const badge = badgeRoom === 0 ? '' : fit(` ${unreadBadge(node)}`, badgeRoom);
    const tail = dateRoom === 0 ? '' : fit(` ${date}`, dateRoom);
    const line = fit(`${marker}${unread}${name}${badge}${tail}`, width);
    rows.push(focused ? paint(line, 'cyan', options.color) : line);
  }

  while (rows.length < body) rows.push(' '.repeat(width));
  return rows;
}

/** Unread children a directory is reporting. Zero for anything that is not a directory. */
function unreadOf(node: VNode): number {
  return node.kind === 'dir' ? (node.unreadCount ?? 0) : 0;
}

/**
 * A folder's unread counter, in the shortest form that is still a number.
 *
 * `ls` spells it `3 unread`; this pane is routinely 35 columns wide, where that would
 * cost a quarter of the row. The word is not lost — `describeSelection` spells it out for
 * the selected row, and that sentence is both what the status line shows and what the
 * session prints to the scrollback on the way out.
 */
function unreadBadge(node: VNode): string {
  const count = unreadOf(node);
  if (count <= 0) return '';
  // `+` means the engine could only see part of the folder — a mount root is warmed one
  // page deep, so this is the common case, not the exotic one. `describeSelection` says
  // "at least" in words for whoever is listening rather than looking.
  return `(${String(count)}${node.unreadPartial === true ? '+' : ''})`;
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

  if (state.mode === 'param' && state.pending !== undefined) {
    const param = currentParam(state.pending);
    const name = param === undefined ? 'Value' : (param.label ?? param.name);
    return fit(`${name}: ${state.pending.input}\u2588`, width);
  }
  if (state.mode === 'confirm' && state.pending !== undefined) {
    const label = state.pending.descriptor.label ?? state.pending.descriptor.name;
    return paint(fit(`${label} \u2014 press y to go ahead, any other key to cancel`, width), 'bold', options.color);
  }
  if (state.mode === 'actions') {
    return paint(fit('Press the letter, or Up/Down then Enter   Escape cancels', width), 'dim', options.color);
  }

  // `/` appears in both hints. It is now the only way into a filter, so it has to be on
  // screen in every state it works in — which is both panes.
  const hint =
    state.pane === 'preview'
      ? 'Tab list   Up/Down scroll   a act   / filter   : command   ? help   q quit'
      : 'Enter open   a act   Backspace up   / filter   : command   ? help   q quit';
  return paint(fit(hint, width), 'dim', options.color);
}

/**
 * The action palette.
 *
 * Grouped, because a flat list of fourteen verbs on a pull request is a wall: the groups a
 * provider declares are the difference between "review, reply, triage" and fourteen equal
 * choices. The accelerator is shown against every row — a menu whose shortcuts are secret
 * is a menu nobody uses twice.
 */
function renderActions(state: TuiState, width: number, body: number, options: RenderOptions): string[] {
  const target = state.actionTarget;
  const heading = target === undefined ? 'Actions' : `Actions \u2014 ${target.title ?? target.name}`;
  const rows: string[] = [paint(fit(heading, width), 'bold', options.color), ' '.repeat(width)];

  const keys = accelerators(state.actions);
  // The chosen action stays highlighted while its parameters are collected, so the screen
  // still answers "what am I typing this into".
  const active = state.pending?.descriptor.name;
  let group: string | undefined;

  for (const [index, descriptor] of state.actions.entries()) {
    if (rows.length >= body) break;
    if (descriptor.group !== group) {
      group = descriptor.group;
      if (group !== undefined && rows.length < body) {
        rows.push(paint(fit(`  ${group}`, width), 'dim', options.color));
      }
    }
    if (rows.length >= body) break;

    const selected = active === undefined ? index === state.actionIndex : active === descriptor.name;
    const marker = selected ? '>' : ' ';
    const key = keys[index] ?? ' ';
    const label = descriptor.label ?? descriptor.name;
    // The exclamation is the only warning a destructive verb gets in the list itself; the
    // real guard is the confirmation, and this is what tells you it is coming.
    const warn = descriptor.destructive === true ? ' !' : '';
    const line = fit(`${marker} ${key}  ${label}${warn}`, width);
    rows.push(selected ? paint(line, 'cyan', options.color) : line);
  }

  while (rows.length < body) rows.push(' '.repeat(width));
  return rows;
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
    ['[  /  ]', 'back / forward through where you have been (also Alt+Left, Alt+Right)'],
    ['Tab', 'switch between the list and the preview'],
    ['/', 'filter as you type (Enter keeps it, Escape clears it)'],
    ['a', 'what you can do with the selected item \u2014 reply, approve, comment, flag\u2026'],
    [':', 'run any command \u2014 ls, find, grep, cat, open, mark, watch\u2026'],
    ['r, F5', 'refresh the current folder'],
    ['?', 'this screen'],
    ['Ctrl+C', 'always works, from any mode, even mid-filter'],
    ['q, Escape', 'leave (the folder and selection are printed on the way out)'],
  ];

  const keyWidth = keys.reduce((max, pair) => Math.max(max, displayWidth(pair[0])), 0);
  const out: string[] = [paint(fit('Keys', width), 'bold', options.color), ' '.repeat(width)];
  for (const [key, meaning] of keys) out.push(fit(`  ${padTo(key, keyWidth)}   ${meaning}`, width));

  out.push(' '.repeat(width));
  out.push(paint(fit('Acting on things', width), 'bold', options.color));
  for (const line of [
    '  a opens the actions the source says are possible for that item right now, so a',
    '  merged pull request does not offer to merge and a message you have read does not',
    '  offer to mark it read. Pick with the letter shown, or Up/Down then Enter.',
    '  Anything marked ! asks you to press y before it happens.',
    '  In a text answer, type \\n where you want a line break.',
    '',
    '  The same actions are available as commands: `actions` lists them and `do` runs',
    '  one, so nothing here needs the pane.',
  ]) {
    out.push(fit(line, width));
  }

  out.push(' '.repeat(width));
  out.push(paint(fit('The full-screen view adds no capability of its own.', width), 'bold', options.color));
  for (const line of [
    'Everything above is also a command, and `:` reaches the same command table as the',
    'line shell. If this pane is awkward to use, quit and run mscomms without --tui: the',
    'line shell does everything this does, in plain text, one line at a time.',
    '',
    'Press any key to go back.',
  ]) {
    out.push(fit(line, width));
  }
  return out;
}
