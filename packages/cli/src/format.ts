/**
 * Output rendering.
 *
 * This module is where the accessibility promise is actually kept, so the reasoning is
 * worth stating plainly.
 *
 * Karl Dahlke, who is blind and wrote edbrowse, put it best: "Output is measured and
 * conserved like a precious commodity as it passes through the narrow channel of speech or
 * braille." A sighted user skims a 25-line table in a second and their eye lands on the
 * one row that matters. A screen reader user hears all 25 rows, in order, at roughly 300
 * words per minute, and column padding is announced as silence or, worse, as a stream of
 * spaces. Everything visual about a table — alignment, colour, box drawing, right-aligned
 * numbers — is not merely useless in that channel, it is actively expensive.
 *
 * So there are three renderers, not one:
 *
 *   table    aligned columns for sighted terminal users (the default on a TTY)
 *   plain    tab-separated, no padding, no colour (NO_COLOR, TERM=dumb, or a pipe)
 *   announce short sentences, one item per line, front-loaded with what matters
 *
 * `announce` is the Emacspeak lesson: do not describe the picture, state the fact. It puts
 * the number first, because the number is what the user is about to type.
 *
 * All three are line-oriented and append-only. Nothing here ever moves the cursor, clears
 * the screen, or repaints, so scrollback stays intact and a screen reader's review cursor
 * keeps working.
 */

import type { Document, VNode } from '@mscomms/core';

export type OutputMode = 'table' | 'plain' | 'announce' | 'json' | 'tsv';

export interface FormatOptions {
  readonly mode: OutputMode;
  readonly color: boolean;
  readonly width: number;
  readonly dateStyle: 'relative' | 'absolute' | 'iso';
  readonly showMeta?: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = {
  mode: 'table',
  color: false,
  width: 80,
  dateStyle: 'relative',
};

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Colour is decoration, never information. Every place a colour is used, a word is used
 * too — an unread item says "unread", it is not merely bold. Roughly 8% of men have some
 * form of colour vision deficiency, and terminal themes vary wildly, so colour alone
 * cannot be load-bearing.
 */
const CODES = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
} as const;

export type ColorName = keyof typeof CODES;

export function paint(text: string, color: ColorName, enabled = true): string {
  if (!enabled) return text;
  return `${CODES[color]}${text}${CODES.reset}`;
}

// ---------------------------------------------------------------------------
// Widths
// ---------------------------------------------------------------------------

/**
 * Display width, counting East Asian wide characters as two columns and combining marks
 * as zero. Without this, a listing containing CJK subjects or emoji misaligns, and the
 * misalignment is far worse than no alignment at all.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    if (code >= 0x0300 && code <= 0x036f) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function padTo(text: string, width: number): string {
  const current = displayWidth(text);
  return current >= width ? text : text + ' '.repeat(width - current);
}

export function truncateWidth(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > max - 1) break;
    out += char;
    width += charWidth;
  }
  return `${out}…`;
}

/**
 * Strip characters that would corrupt a single-line, screen-reader-safe listing: control
 * codes (a subject can legitimately contain a stray escape sequence, and printing it
 * verbatim lets hostile mail repaint the terminal), and bidi overrides (U+202E can make a
 * ".txt.exe" attachment read as ".exe.txt"). This is a security control, not cosmetics.
 */
export function sanitizeForDisplay(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '')
    .replace(/[\r\n\t]+/g, ' ');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function formatDate(date: Date | undefined, style: FormatOptions['dateStyle'], now = new Date()): string {
  if (date === undefined || Number.isNaN(date.getTime())) return '';
  if (style === 'iso') return date.toISOString();
  if (style === 'absolute') {
    return `${date.getFullYear().toString().padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return relativeTime(date, now);
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Spelled out in full words. "2h" is three keystrokes to read visually and a puzzle to a
 * speech synthesiser, which renders it "two aitch".
 */
export function relativeTime(date: Date, now = new Date()): string {
  const deltaMs = now.getTime() - date.getTime();
  const future = deltaMs < 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);

  const say = (value: number, unit: string): string => {
    const plural = value === 1 ? unit : `${unit}s`;
    return future ? `in ${String(value)} ${plural}` : `${String(value)} ${plural} ago`;
  };

  if (seconds < 45) return future ? 'shortly' : 'just now';
  if (seconds < 3600) return say(Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return say(Math.round(seconds / 3600), 'hour');
  if (seconds < 2_592_000) return say(Math.round(seconds / 86_400), 'day');
  if (seconds < 31_536_000) return say(Math.round(seconds / 2_592_000), 'month');
  return say(Math.round(seconds / 31_536_000), 'year');
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] as string}`;
}

// ---------------------------------------------------------------------------
// Node listings
// ---------------------------------------------------------------------------

export interface ListingOptions extends FormatOptions {
  /** 1-based index of the first row, so paged listings keep numbering continuous. */
  readonly startIndex?: number;
  readonly long?: boolean;
}

/**
 * Render a directory listing.
 *
 * Every row is prefixed with its number, in every mode, because the number is the primary
 * addressing mechanism: after `ls` the user types `cat 3`. That design exists because
 * fuzzy overlay pickers (fzf and everything modelled on it) are architecturally
 * inaccessible — they repaint a region the screen reader has no way to observe. A stable
 * printed number needs no repainting at all, and it doubles as the answer to ambiguous
 * names: two messages can share a subject, but never a number.
 */
export function formatListing(nodes: readonly VNode[], options: ListingOptions): string {
  const start = options.startIndex ?? 1;
  if (nodes.length === 0) return options.mode === 'json' ? '[]' : '(empty)';

  switch (options.mode) {
    case 'json':
      return JSON.stringify(nodes.map((node, i) => ({ index: start + i, ...node })), null, 2);
    case 'tsv':
      return nodes
        .map((node, i) =>
          [
            String(start + i),
            node.kind,
            node.subtype ?? '',
            node.name,
            node.mtime?.toISOString() ?? '',
            node.author ?? '',
            (node.flags ?? []).join(','),
            node.id,
          ].join('\t'),
        )
        .join('\n');
    case 'announce':
      return nodes.map((node, i) => announceNode(node, start + i, options)).join('\n');
    case 'plain':
      return nodes
        .map((node, i) => {
          const marker = node.kind === 'dir' ? '/' : '';
          const flags = (node.flags ?? []).join(',');
          return [
            `${String(start + i)}.`,
            `${sanitizeForDisplay(node.name)}${marker}`,
            formatDate(node.mtime, options.dateStyle),
            node.author ?? '',
            flags,
          ]
            .filter((part) => part !== '')
            .join('\t');
        })
        .join('\n');
    default:
      return formatTable(nodes, start, options);
  }
}

/** One spoken sentence per item, most important information first. */
function announceNode(node: VNode, index: number, options: ListingOptions): string {
  const parts: string[] = [`${String(index)}.`];

  const flags = node.flags ?? [];
  if (flags.includes('unread')) parts.push('unread');
  if (flags.includes('mention')) parts.push('mentions you');
  if (flags.includes('important')) parts.push('important');

  parts.push(node.kind === 'dir' ? `${node.subtype ?? 'folder'},` : `${node.subtype ?? 'item'},`);
  parts.push(`${sanitizeForDisplay(node.title)}.`);

  if (node.author !== undefined) parts.push(`From ${sanitizeForDisplay(node.author)}.`);
  const when = formatDate(node.mtime, options.dateStyle);
  if (when !== '') parts.push(`${when.charAt(0).toUpperCase()}${when.slice(1)}.`);

  if (node.kind === 'dir' && node.unreadCount !== undefined && node.unreadCount > 0) {
    parts.push(`${String(node.unreadCount)} unread.`);
  } else if (node.kind === 'dir' && node.childCount !== undefined) {
    parts.push(`${String(node.childCount)} items.`);
  }

  if (flags.includes('attachment')) parts.push('Has an attachment.');
  if (node.summary !== undefined && node.summary !== '') {
    parts.push(truncateWidth(sanitizeForDisplay(node.summary), 100));
  }

  return parts.join(' ');
}

function formatTable(nodes: readonly VNode[], start: number, options: ListingOptions): string {
  const rows = nodes.map((node, i) => {
    const flags = node.flags ?? [];
    // A leading marker column, always in the same place, so it is scannable. The word
    // form is still present in `stat` and in announce mode, so no information is
    // colour- or glyph-only.
    const marker = flags.includes('unread') ? '*' : flags.includes('mention') ? '@' : ' ';
    const name = `${sanitizeForDisplay(node.name)}${node.kind === 'dir' ? '/' : ''}`;
    return {
      index: `${String(start + i)}.`,
      marker,
      name,
      when: formatDate(node.mtime, options.dateStyle),
      who: sanitizeForDisplay(node.author ?? ''),
      extra: options.long === true ? extraColumn(node) : '',
      dir: node.kind === 'dir',
      unread: flags.includes('unread'),
    };
  });

  const indexWidth = Math.max(...rows.map((row) => row.index.length));
  const whenWidth = Math.min(20, Math.max(0, ...rows.map((row) => displayWidth(row.when))));
  const whoWidth = Math.min(22, Math.max(0, ...rows.map((row) => displayWidth(row.who))));
  const extraWidth = Math.max(0, ...rows.map((row) => displayWidth(row.extra)));

  const fixed = indexWidth + 1 + 1 + 1 + whenWidth + 2 + whoWidth + 2 + extraWidth + (extraWidth > 0 ? 2 : 0);
  const nameWidth = Math.max(20, options.width - fixed - 1);

  return rows
    .map((row) => {
      const name = padTo(truncateWidth(row.name, nameWidth), nameWidth);
      const painted = options.color
        ? paint(name, row.dir ? 'blue' : row.unread ? 'bold' : 'reset')
        : name;
      const pieces = [
        row.index.padStart(indexWidth),
        row.marker,
        painted,
        padTo(truncateWidth(row.when, whenWidth), whenWidth),
        padTo(truncateWidth(row.who, whoWidth), whoWidth),
      ];
      if (extraWidth > 0) pieces.push(row.extra);
      return pieces.join(' ').trimEnd();
    })
    .join('\n');
}

function extraColumn(node: VNode): string {
  const bits: string[] = [];
  if (node.kind === 'dir') {
    if (node.unreadCount !== undefined && node.unreadCount > 0) bits.push(`${String(node.unreadCount)} unread`);
    else if (node.childCount !== undefined) bits.push(`${String(node.childCount)} items`);
  }
  const flags = (node.flags ?? []).filter((flag) => flag !== 'unread');
  if (flags.length > 0) bits.push(flags.join(','));
  if (node.size !== undefined) bits.push(formatBytes(node.size));
  return bits.join('  ');
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Render a message.
 *
 * Headers come first as `Label: value` lines. That order is chosen by the provider and
 * preserved exactly, because a screen reader reads it in that order and "who is this
 * from" is almost always the first question. A blank line separates headers from body —
 * the one piece of structure every terminal reader, human or synthetic, understands.
 */
export function formatDocument(doc: Document, options: FormatOptions): string {
  if (options.mode === 'json') return JSON.stringify(doc, null, 2);

  // `title` is required on Document, and it used to be silently discarded whenever a provider
  // supplied one without also repeating it in `headers`. The built-in mail providers happen to
  // emit a `Subject:` header, so the loss never showed there — but the simplest possible
  // plugin returns `{title, body}` and nothing else, and its document rendered anonymously,
  // led by a stray blank line. Synthesise the label here, before widths are measured, so it
  // aligns with the real headers instead of hanging off the left of them.
  const titleShownAlready = doc.headers.some(
    ([, value]) => value.trim() !== '' && value.trim() === doc.title.trim(),
  );
  const headers: ReadonlyArray<readonly [string, string]> =
    titleShownAlready || doc.title.trim() === ''
      ? doc.headers
      : [['Title', doc.title] as const, ...doc.headers];

  const lines: string[] = [];
  const labelWidth = Math.max(0, ...headers.map(([label]) => label.length));

  for (const [label, value] of headers) {
    if (value === '') continue;
    const paintedLabel = options.color ? paint(`${label}:`, 'cyan') : `${label}:`;
    const padding = options.mode === 'table' ? ' '.repeat(labelWidth - label.length) : '';
    lines.push(`${paintedLabel}${padding} ${sanitizeForDisplay(value)}`);
  }

  if ((doc.attachments ?? []).length > 0) {
    const names = (doc.attachments ?? [])
      .map((a, i) => `${String(i + 1)}. ${sanitizeForDisplay(a.name)}${a.size === undefined ? '' : ` (${formatBytes(a.size)})`}`)
      .join('; ');
    lines.push(`${options.color ? paint('Attachments:', 'cyan') : 'Attachments:'} ${names}`);
  }

  // Only separate the headers from the body when there are headers. A leading blank line is
  // visually trivial and, read aloud, is an unexplained pause before the content starts.
  if (lines.length > 0) lines.push('');
  lines.push(wrapBody(doc.body, options.mode === 'plain' || options.mode === 'tsv' ? 0 : options.width));

  if (doc.webUrl !== undefined) {
    lines.push('');
    lines.push(`Web link: ${doc.webUrl}`);
  }

  return lines.join('\n');
}

/**
 * Wrap at the terminal width, but never re-wrap what is already short, and never touch
 * indented lines — those are usually quoted text or code, and reflowing them destroys the
 * only structure they have.
 */
export function wrapBody(body: string, width: number): string {
  const normalized = body.replace(/\r\n?/g, '\n');
  if (width <= 0) return normalized;
  // Stop one short of the width: a line that exactly fills the terminal makes some
  // emulators emit an extra blank line, which a screen reader reads as a paragraph break
  // that isn't there.
  //
  // The floor is 8, not something comfortable like 40. A refreshable braille display is
  // commonly 40 cells but 32- and 20-cell units are ordinary, and a reader who has set
  // their width to match their hardware means it. Overriding that would force the terminal
  // to do the wrapping instead, at arbitrary points, which is the fragmented-output
  // problem this whole layer exists to avoid. Only genuinely pathological widths are
  // clamped.
  const limit = Math.max(8, width - 1);

  return normalized
    .split('\n')
    .flatMap((line) => {
      if (displayWidth(line) <= limit) return [line];
      if (/^\s/.test(line) || /^[>|]/.test(line)) return [line];
      return wrapLine(line, limit);
    })
    .join('\n');
}

function wrapLine(line: string, limit: number): string[] {
  const words = line.split(/(\s+)/);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (displayWidth(current + word) > limit && current.trim() !== '') {
      out.push(current.trimEnd());
      current = /^\s+$/.test(word) ? '' : word;
    } else {
      current += word;
    }
  }
  if (current.trim() !== '') out.push(current.trimEnd());
  return out.length === 0 ? [''] : out;
}

// ---------------------------------------------------------------------------
// Key/value blocks
// ---------------------------------------------------------------------------

export function formatPairs(
  pairs: ReadonlyArray<readonly [string, string]>,
  options: FormatOptions,
): string {
  const visible = pairs.filter(([, value]) => value !== '');
  if (options.mode === 'json') return JSON.stringify(Object.fromEntries(visible), null, 2);
  if (options.mode === 'tsv') return visible.map(([k, v]) => `${k}\t${v}`).join('\n');
  if (options.mode === 'announce' || options.mode === 'plain') {
    return visible.map(([k, v]) => `${k}: ${sanitizeForDisplay(v)}`).join('\n');
  }
  const width = Math.max(0, ...visible.map(([k]) => k.length));
  return visible
    .map(([k, v]) => `${options.color ? paint(`${k}:`, 'cyan') : `${k}:`}${' '.repeat(width - k.length)} ${sanitizeForDisplay(v)}`)
    .join('\n');
}

/**
 * A simple text table for command output that is not a node listing (mounts, watches,
 * plugins). Same three-mode discipline as `formatListing`.
 */
export function formatRows(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  options: FormatOptions,
): string {
  if (rows.length === 0) return '(none)';
  if (options.mode === 'json') {
    return JSON.stringify(
      rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? '']))),
      null,
      2,
    );
  }
  if (options.mode === 'tsv') return rows.map((row) => row.join('\t')).join('\n');
  if (options.mode === 'announce' || options.mode === 'plain') {
    return rows
      .map((row, index) => {
        const sentence =
          `${String(index + 1)}. ` +
          headers
            .map((header, i) => `${header} ${sanitizeForDisplay(row[i] ?? '')}`)
            .filter((part) => !part.endsWith(' '))
            .join(', ');
        // Only add the full stop when the last cell did not already end the sentence.
        // A doubled period is spoken as a pause and then another pause, which reads as a
        // hesitation that is not in the text.
        return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
      })
      .join('\n');
  }

  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => padTo(sanitizeForDisplay(cell), widths[i] as number)).join('  ').trimEnd();

  return [
    options.color ? paint(line(headers), 'bold') : line(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map((row) => line(row)),
  ].join('\n');
}
