/**
 * Turning arbitrary human text (email subjects, Teams channel names, issue titles) into
 * safe, stable, navigable path segments.
 *
 * This module exists because every "X as a filesystem" project trips over the same rocks:
 *   - subjects contain `/` and `\`, which would silently fabricate directory levels
 *   - Windows rejects `< > : " | ? *`, trailing dots and trailing spaces
 *   - Windows still reserves the DOS device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 *     INCLUDING when they carry an extension: `CON.txt` is just as reserved as `CON`
 *   - most filesystems cap a component at 255 *bytes*, not characters, so emoji-laden
 *     subjects overflow far sooner than a naive `.slice(0, 255)` suggests
 *   - macOS (HFS+/APFS) and Windows are case-insensitive, so `Re: Budget` and `RE: budget`
 *     collide even though they are distinct strings
 *   - Unicode can be encoded several ways; without normalization the same visible name
 *     compares unequal
 *
 * Design decision: SPACES ARE PRESERVED. Hyphen-slugging ("re-quarterly-planning") is
 * actively worse for screen-reader users, who hear every hyphen announced as "dash".
 * Readable names win; the shell tokenizer and the completion engine are quote-aware so
 * spaces cost the user nothing.
 *
 * Sanitization is lossy by nature, so the untouched original is always retained on the
 * node as `title` and shown by `stat` and `ls -l`. Nothing is ever silently destroyed.
 */

/** Characters illegal in a Windows path component, plus the POSIX separator. */
const ILLEGAL = /[<>:"|?*/\\]/g;

/** C0 and C1 control characters. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/** Runs of whitespace (including exotic unicode spaces) collapse to a single space. */
const WHITESPACE_RUN = /[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

/**
 * Zero-width and bidirectional-control characters. These are invisible, so they create
 * names that look identical but do not compare equal, and the bidi overrides are a
 * genuine spoofing vector in a mail client (RLO can visually reverse an extension).
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** DOS device names reserved by Windows, with or without an extension. */
const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Conservative default: 255 bytes is the common component limit (ext4, APFS, NTFS). */
export const DEFAULT_MAX_BYTES = 180;

export interface SanitizeOptions {
  /** Maximum size of the produced segment, in UTF-8 bytes. */
  maxBytes?: number;
  /** Used when the input sanitizes down to nothing. */
  fallback?: string;
  /**
   * Extension to preserve (e.g. `.eml`). It is never truncated away, so
   * `ls *.eml` keeps working no matter how long the subject was.
   */
  extension?: string;
  /**
   * Treat `/` as a separator to preserve rather than an illegal character to replace,
   * sanitizing each segment independently.
   *
   * Only search results use this. They are drawn from many directories at once, so a bare
   * leaf name is neither unique nor informative — `Inbox/budget.eml` tells the user where
   * the hit actually lives. The per-segment guarantee still holds for every segment.
   */
  allowSlashes?: boolean;
}

const UTF8 = new TextEncoder();

/**
 * A trailing `.ext` that is worth protecting from truncation and from the dedupe suffix.
 *
 * Deliberately narrow: no spaces, one to eight ASCII alphanumerics. A subject like
 * `Re: v2.4 release` must not be read as having an extension of `.4 release`, while
 * `2026-08-11 Budget.eml` must be. Getting this wrong in either direction is visible to
 * the user — either `ls *.eml` misses long subjects, or names acquire nonsense suffixes.
 */
const TRAILING_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Infer the extension to preserve when the caller did not name one explicitly.
 *
 * This exists because the engine allocates names on the provider's behalf and has no idea
 * whether a given provider appends `.eml`, `.md` or nothing at all. Asking every provider
 * to thread an extension through the contract would be one more thing for each of them to
 * forget; inferring it from the name they already produced cannot be forgotten.
 */
export function inferExtension(name: string): string {
  const match = TRAILING_EXTENSION.exec(name);
  return match === null ? '' : (match[0] as string);
}

export function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a character.
 * Iterates by code point, so surrogate pairs (emoji) are never cut in half.
 */
export function truncateBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(value) <= maxBytes) return value;

  let out = '';
  let used = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * Convert arbitrary text into a single safe path segment.
 *
 * Guarantees on the result: never empty, contains no separator, no control or invisible
 * characters, is not a reserved device name, has no leading/trailing dot or space, and
 * fits within `maxBytes` UTF-8 bytes including the extension.
 */
export function sanitizeSegment(input: string, options: SanitizeOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fallback = options.fallback ?? 'untitled';

  // Multi-segment mode: each part is sanitized on its own terms, and only the final part
  // is allowed to keep an extension. The byte budget applies per segment, since it exists
  // to satisfy per-component filesystem limits rather than a whole-path limit.
  if (options.allowSlashes === true && input.includes('/')) {
    const parts = input.split('/').filter((part) => part !== '');
    if (parts.length === 0) return fallback;
    const { allowSlashes: _ignored, ...rest } = options;
    return parts
      .map((part, i) =>
        i === parts.length - 1
          ? sanitizeSegment(part, rest)
          : sanitizeSegment(part, { ...rest, extension: '' }),
      )
      .join('/');
  }

  let value = (input ?? '').normalize('NFC');
  value = value.replace(INVISIBLE, '');
  value = value.replace(CONTROL, ' ');
  value = value.replace(ILLEGAL, '-');
  value = value.replace(WHITESPACE_RUN, ' ');
  value = value.trim();

  // A leading dot would make the entry "hidden" and a trailing dot is illegal on Windows.
  value = value.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();

  if (value.length === 0) value = fallback;

  // Split the extension off only after sanitizing, so an extension that only exists
  // because an illegal character was replaced is not treated as meaningful.
  const extension = options.extension ?? inferExtension(value);
  if (extension.length > 0 && value.endsWith(extension)) {
    value = value.slice(0, -extension.length);
    if (value.length === 0) value = fallback;
  }

  // Reserved device names are matched on the stem, case-insensitively, because Windows
  // rejects `CON.txt` exactly as it rejects `CON`.
  const stem = (value.split('.')[0] ?? '').toUpperCase();
  if (RESERVED_DEVICE_NAMES.has(stem)) value = `_${value}`;

  const extensionBytes = byteLength(extension);
  const budget = maxBytes - extensionBytes;
  if (budget <= 0) {
    // Pathological configuration: the extension alone exceeds the budget.
    return truncateBytes(fallback + extension, maxBytes) || fallback;
  }

  if (byteLength(value) > budget) {
    value = truncateBytes(value, budget).replace(/[. ]+$/, '').trim();
    if (value.length === 0) value = truncateBytes(fallback, budget);
  }

  return value + extension;
}

/**
 * The key used for collision detection. Case-insensitive because Windows and macOS are,
 * and NFC-normalized so differently-encoded but identical-looking names collide (as they
 * would on disk) rather than producing two entries a user cannot tell apart.
 */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Assigns unique names within a directory listing.
 *
 * Uniqueness is deliberately NOT achieved by prefixing every name with an opaque ID.
 * Doing that is the single most common complaint levelled at synthetic filesystems: it
 * destroys readability and tab-completion for the 99% of names that never collide. Here
 * a disambiguating `~2` suffix is added only to the actual duplicates, and it is placed
 * before the extension so globbing still works.
 */
export class NameAllocator {
  readonly #used = new Map<string, number>();

  constructor(private readonly options: SanitizeOptions = {}) {}

  /** Sanitize `input` and return a name unique among everything allocated so far. */
  allocate(input: string, options: SanitizeOptions = {}): string {
    const merged = { ...this.options, ...options };
    const base = sanitizeSegment(input, merged);
    const key = collisionKey(base);

    const seen = this.#used.get(key);
    if (seen === undefined) {
      this.#used.set(key, 1);
      return base;
    }

    const extension = merged.extension ?? inferExtension(base);
    const stem = extension && base.endsWith(extension) ? base.slice(0, -extension.length) : base;
    const maxBytes = merged.maxBytes ?? DEFAULT_MAX_BYTES;

    // Probe upward: a previously-taken suffix must not be handed out twice.
    let counter = seen + 1;
    for (;;) {
      const suffix = `~${counter}`;
      const budget = maxBytes - byteLength(extension) - byteLength(suffix);
      const trimmed = truncateBytes(stem, Math.max(1, budget)).replace(/[. ]+$/, '');
      const candidate = `${trimmed}${suffix}${extension}`;
      const candidateKey = collisionKey(candidate);
      if (!this.#used.has(candidateKey)) {
        this.#used.set(key, counter);
        this.#used.set(candidateKey, 1);
        return candidate;
      }
      counter += 1;
    }
  }

  /** Reserve a literal name (used for fixed entries like `.meta` or `attachments`). */
  reserve(name: string): void {
    this.#used.set(collisionKey(name), 1);
  }

  has(name: string): boolean {
    return this.#used.has(collisionKey(name));
  }
}

/**
 * Format a timestamp as a sortable `YYYY-MM-DD` or `YYYY-MM-DDTHH-MM` prefix.
 * Colons are illegal on Windows, hence `T14-03` rather than `T14:03`.
 * Always rendered in local time so the name matches what the user saw in Outlook.
 */
export function timestampPrefix(date: Date, includeTime = false): string {
  if (Number.isNaN(date.getTime())) return 'undated';
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (!includeTime) return ymd;
  return `${ymd}T${pad(date.getHours())}-${pad(date.getMinutes())}`;
}
