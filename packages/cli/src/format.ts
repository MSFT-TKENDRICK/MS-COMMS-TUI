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
 * Display width, counting East Asian wide characters and emoji as two columns and
 * combining marks as zero. Without this, a listing containing CJK subjects or emoji
 * misaligns, and the misalignment is far worse than no alignment at all.
 *
 * Undercounting is the dangerous direction, and it is not a cosmetic bug. Every column
 * this returns is a column the layout hands out; report a subject as narrower than it
 * really is and the row runs past the right edge, the terminal wraps it, one listing row
 * becomes two, and the list a screen reader is stepping through no longer agrees with the
 * arrow keys. An earlier table knew about CJK and about two emoji blocks and missed the
 * rest — including `✅`, `❌`, `⚠`, `🚀` and `🟢`, which is to say most of what actually
 * turns up in a corporate subject line. Sample data is pure ASCII, so nothing caught it.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(text)) width += cluster.width;
  return width;
}

/**
 * Walk the string in units that are drawn as a single glyph, reporting the columns each
 * one occupies.
 *
 * Measuring and truncating both go through here, and that is the point: they used to be
 * separate loops, one over the whole string and one code point at a time, and they
 * disagreed. `displayWidth('⚠️')` counted the warning sign and then added nothing for the
 * variation selector that follows it, while the truncation loop asked for the width of
 * each code point on its own and got 1 + 0. Any pair of loops like that drifts apart at
 * exactly the characters that matter.
 *
 * A variation selector is the interesting case. U+26A0 on its own is a narrow text symbol;
 * followed by U+FE0F it is an emoji, and a terminal draws it in two columns. The
 * difference is invisible in a subject line and worth a wrapped row.
 */
function* clusters(text: string): Generator<{ text: string; width: number }> {
  let current = '';
  let width = 0;
  let joining = false;
  let base = -1;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const zero = isZeroWidth(code);
    if (current !== '' && !zero && !joining) {
      yield { text: current, width };
      current = '';
      width = 0;
    }
    current += char;
    if (code === 0x200d) {
      // A joiner promises another codepoint belonging to the same glyph.
      joining = true;
      continue;
    }
    joining = false;
    if (code === 0xfe0f) {
      if (width === 1 && hasEmojiPresentation(base)) width = 2;
      continue;
    }
    if (zero) continue;
    base = code;
    width += isWide(code) ? 2 : 1;
  }
  if (current !== '') yield { text: current, width };
}

/**
 * Whether U+FE0F after this codepoint means anything.
 *
 * Only the symbol blocks have both a text and an emoji form, and only those get widened.
 * The selector is meaningless after a letter — `a\uFE0F` is one column, not two — so the
 * promotion has to be restricted rather than applied to whatever came last.
 */
function hasEmojiPresentation(code: number): boolean {
  return (
    code === 0x00a9 ||
    code === 0x00ae ||
    code === 0x203c ||
    code === 0x2049 ||
    code === 0x2122 ||
    code === 0x2139 ||
    (code >= 0x2190 && code <= 0x21ff) ||
    (code >= 0x2300 && code <= 0x23ff) ||
    code === 0x24c2 ||
    (code >= 0x25aa && code <= 0x25ff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2900 && code <= 0x297f) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    code === 0x3030 ||
    code === 0x303d ||
    code === 0x3297 ||
    code === 0x3299
  );
}

/**
 * Characters that take no room of their own because they modify the one before them.
 *
 * Getting these wrong is the *other* direction, and it costs a gap rather than a wrapped
 * row, so the list is deliberately the common cases rather than the whole Unicode
 * combining-mark database: a full table is the sort of thing one takes a dependency for,
 * and this program does not take dependencies.
 */
function isZeroWidth(code: number): boolean {
  return (
    code === 0x200d || // zero-width joiner, holding an emoji sequence together
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors, incl. the emoji one
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) // skin-tone modifiers, part of the glyph before
  );
}

/**
 * Two columns wide: East Asian Wide and Fullwidth, plus the codepoints that terminals
 * render as emoji at double width.
 *
 * The emoji ranges are the ones with Emoji_Presentation, which is what a terminal keys
 * off. The scattered singletons in the 0x2000 block are there because that is where the
 * everyday ones live — a tick, a cross, a warning sign — and they are wide despite sitting
 * among narrow symbols.
 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    isWideSymbol(code) ||
    isWideEmoji(code) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * The emoji planes, minus the parts of them terminals draw narrow.
 *
 * The blocks below 0x1f300 are mostly playing cards and mahjong tiles, which are narrow
 * apart from a couple of famous exceptions, so they are listed rather than swept up. Where
 * this is imprecise it errs high — a codepoint wrongly called wide leaves a blank column,
 * which is untidy, while one wrongly called narrow wraps the row, which is the bug.
 */
function isWideEmoji(code: number): boolean {
  return (
    code === 0x1f004 ||
    code === 0x1f0cf ||
    code === 0x1f18e ||
    (code >= 0x1f191 && code <= 0x1f19a) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff) || // regional indicators: flags
    (code >= 0x1f200 && code <= 0x1f251) || // enclosed CJK
    (code >= 0x1f300 && code <= 0x1faff) || // the emoji proper, through the newest blocks
    (code >= 0x1fc00 && code <= 0x1fffd)
  );
}

function isWideSymbol(code: number): boolean {
  return (
    (code >= 0x231a && code <= 0x231b) || // ⌚⌛
    (code >= 0x23e9 && code <= 0x23ec) ||
    code === 0x23f0 ||
    code === 0x23f3 ||
    (code >= 0x25fd && code <= 0x25fe) ||
    (code >= 0x2614 && code <= 0x2615) ||
    (code >= 0x2648 && code <= 0x2653) ||
    code === 0x267f ||
    code === 0x2693 ||
    code === 0x26a1 || // ⚡
    (code >= 0x26aa && code <= 0x26ab) ||
    (code >= 0x26bd && code <= 0x26be) ||
    (code >= 0x26c4 && code <= 0x26c5) ||
    code === 0x26ce ||
    code === 0x26d4 ||
    code === 0x26ea ||
    (code >= 0x26f2 && code <= 0x26f3) ||
    code === 0x26f5 ||
    code === 0x26fa ||
    code === 0x26fd ||
    code === 0x2705 || // ✅
    (code >= 0x270a && code <= 0x270b) ||
    code === 0x2728 || // ✨
    (code >= 0x274c && code <= 0x274e) || // ❌
    (code >= 0x2753 && code <= 0x2755) ||
    code === 0x2757 ||
    (code >= 0x2795 && code <= 0x2797) ||
    code === 0x27b0 ||
    code === 0x27bf ||
    (code >= 0x2b1b && code <= 0x2b1c) ||
    code === 0x2b50 || // ⭐
    code === 0x2b55
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
  for (const cluster of clusters(text)) {
    if (width + cluster.width > max - 1) break;
    out += cluster.text;
    width += cluster.width;
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
            unreadBadge(unreadOf(node)),
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
    // Spoken, "at least" beats a `+` a screen reader would either skip or read as "plus".
    parts.push(
      node.unreadPartial === true
        ? `At least ${String(node.unreadCount)} unread.`
        : `${String(node.unreadCount)} unread.`,
    );
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
    const count = unreadOf(node);
    const carriesUnread = flags.includes('unread') || count > 0;
    // A leading marker column, always in the same place, so it is scannable. The word
    // form is still present in `stat` and in announce mode, so no information is
    // colour- or glyph-only. A folder holding unread children earns the same mark as an
    // unread message: one level up, "is there anything new in here" is the same question.
    const marker = carriesUnread ? '*' : flags.includes('mention') ? '@' : ' ';
    const name = `${sanitizeForDisplay(node.name)}${node.kind === 'dir' ? '/' : ''}`;
    return {
      index: `${String(start + i)}.`,
      marker,
      name,
      count,
      partial: unreadIsPartial(node),
      when: formatDate(node.mtime, options.dateStyle),
      who: sanitizeForDisplay(node.author ?? ''),
      extra: options.long === true ? extraColumn(node) : '',
      dir: node.kind === 'dir',
      unread: carriesUnread,
    };
  });

  const indexWidth = Math.max(...rows.map((row) => row.index.length));
  const naturalBadge = Math.max(0, ...rows.map((row) => displayWidth(unreadBadge(row.count, row.partial))));
  const compactBadgeWidth = Math.max(
    0,
    ...rows.map((row) => displayWidth(compactUnreadBadge(row.count, row.partial))),
  );

  // Every column but the name has a width it wants; the name takes what is left. When what
  // is left is not enough, columns are given up in order of what a narrow terminal can most
  // afford to lose, because a row wider than the terminal wraps — and a wrapped row turns a
  // scannable list into a paragraph, which is the one thing this layout exists to prevent.
  //
  // The old rule floored the name at 20 columns and let the row run off the edge instead.
  // That was survivable while the row was narrow, and stopped being survivable when the
  // counter added a column: at 40 columns a row came out 63 wide.
  const budget = Math.max(1, options.width);
  const MIN_NAME = 12;
  let badgeWidth = naturalBadge;
  let whenWidth = Math.min(20, Math.max(0, ...rows.map((row) => displayWidth(row.when))));
  let whoWidth = Math.min(22, Math.max(0, ...rows.map((row) => displayWidth(row.who))));
  let extraWidth = Math.max(0, ...rows.map((row) => displayWidth(row.extra)));
  let compact = false;

  // index + gap + marker + gap, then one gap in front of each column that is present.
  const overhead = (): number =>
    indexWidth +
    2 +
    1 +
    (badgeWidth > 0 ? badgeWidth + 1 : 0) +
    (whenWidth > 0 ? whenWidth + 1 : 0) +
    (whoWidth > 0 ? whoWidth + 1 : 0) +
    (extraWidth > 0 ? extraWidth + 1 : 0);
  const cramped = (): boolean => budget - overhead() < MIN_NAME;

  if (cramped() && extraWidth > 0) extraWidth = 0;
  if (cramped() && whoWidth > 0) whoWidth = 0;
  if (cramped() && whenWidth > 0) whenWidth = 0;
  // The counter shortens before it disappears: `3 unread` becomes `(3)`, the same fact in a
  // third of the room, and the spelled-out form is still what `stat` and announce mode give.
  // It is the last column to be dropped because it is the reason to look at this row at all.
  if (cramped() && badgeWidth > 0) {
    compact = true;
    badgeWidth = compactBadgeWidth;
  }
  if (cramped() && badgeWidth > 0) badgeWidth = 0;

  const nameWidth = Math.max(1, budget - overhead());

  return rows
    .map((row) => {
      const name = padTo(truncateWidth(row.name, nameWidth), nameWidth);
      const painted = options.color
        ? paint(name, row.dir ? 'blue' : row.unread ? 'bold' : 'reset')
        : name;
      const pieces = [row.index.padStart(indexWidth), row.marker, painted];
      if (badgeWidth > 0) {
        const badge = compact
          ? compactUnreadBadge(row.count, row.partial)
          : unreadBadge(row.count, row.partial);
        // Right-aligned within its own column: it is a number, so the digits line up by
        // magnitude, and padding on the left keeps `unread` in a column of its own instead
        // of stepping sideways one place with every extra digit.
        //
        // Fit first, colour second — the rule the whole file runs on, because an escape
        // sequence counts as columns to the padding and silently shears the row after it.
        const text = truncateWidth(badge, badgeWidth);
        const cell = ' '.repeat(Math.max(0, badgeWidth - displayWidth(text))) + text;
        pieces.push(options.color && badge !== '' ? paint(cell, 'bold') : cell);
      }
      if (whenWidth > 0) pieces.push(padTo(truncateWidth(row.when, whenWidth), whenWidth));
      if (whoWidth > 0) pieces.push(padTo(truncateWidth(row.who, whoWidth), whoWidth));
      if (extraWidth > 0) pieces.push(row.extra);
      return pieces.join(' ').trimEnd();
    })
    .join('\n');
}

/** Unread children a directory is reporting. Zero for anything that is not a directory. */
function unreadOf(node: VNode): number {
  return node.kind === 'dir' ? (node.unreadCount ?? 0) : 0;
}

/** Whether that number is a floor rather than a total. Only the engine ever sets this. */
function unreadIsPartial(node: VNode): boolean {
  return node.kind === 'dir' && node.unreadPartial === true && unreadOf(node) > 0;
}

/**
 * The unread counter a directory carries into a listing.
 *
 * Spelled `3 unread` rather than a bare `(3)`. A number on its own is a picture of a
 * fact, and this listing gets read aloud, piped and grepped, so it has to say which fact
 * it is. It gets a column of its own rather than a suffix on the name for the same
 * reason the date does: appended to the name, the one row where the name is long is
 * exactly the row where the count is truncated away.
 *
 * `26+ unread` is the honest form for a count derived from a directory the source has not
 * finished handing over. It reads correctly aloud — "twenty-six plus unread" — and it is
 * the difference between a number the user can act on and one that quietly means something
 * else than it says.
 */
function unreadBadge(count: number, partial = false): string {
  if (count <= 0) return '';
  return `${String(count)}${partial ? '+' : ''} unread`;
}

/**
 * The same counter for a terminal that has no room for the word.
 *
 * Used only once the layout has already given up the author and the date; the alternative
 * at that width is dropping the count altogether, and a number in parentheses is a great
 * deal more use than nothing. This is the form the TUI pane uses at every width, for the
 * same reason, so it is not a new vocabulary either.
 */
function compactUnreadBadge(count: number, partial = false): string {
  if (count <= 0) return '';
  return `(${String(count)}${partial ? '+' : ''})`;
}

function extraColumn(node: VNode): string {
  const bits: string[] = [];
  // The unread count has a column of its own, so `--long` contributes the total rather
  // than repeating it.
  if (node.kind === 'dir' && node.childCount !== undefined) bits.push(`${String(node.childCount)} items`);
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
