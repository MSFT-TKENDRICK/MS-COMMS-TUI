/**
 * The query language.
 *
 * This module is the direct answer to the strongest criticism of the "messages as a
 * filesystem" idea: a strict directory tree is the wrong shape for a mailbox. The same
 * message is legitimately "from Alice", "unread", "about the budget" and "has an
 * attachment" at once, and a tree forces you to pick one. Tools that bet purely on
 * hierarchy (classic IMAP folder browsers) lose to tools that bet on saved searches
 * (notmuch's virtual folders, newsboat's query feeds, Gmail labels).
 *
 * So this tool refuses the choice. Directories remain the navigation primitive, because
 * that is the muscle memory being borrowed, but a *query is also a directory*: mount a
 * query at `/q/unread` and `cd /q/unread` works exactly like any other directory. The
 * query language below is what those virtual directories are made of, and it is the same
 * language used by `find`, `grep` and the `ls -q` filter — one syntax to learn, not three.
 *
 * Syntax:
 *   from:alice                     field match (substring, case-insensitive)
 *   from:=alice@contoso.com        exact match
 *   subject:"quarterly budget"     quoted phrase
 *   is:unread  is:flagged          flag predicate
 *   has:attachment                 flag predicate (alias of is:)
 *   after:2026-01-01  before:7d    date bounds; relative durations allowed
 *   larger:1M  smaller:100k        size bounds
 *   kind:dir | kind:file           node kind
 *   meta.importance:high           arbitrary provider metadata
 *   budget review                  bare words: full-text over title/summary/author
 *   -is:read       NOT is:read     negation
 *   a OR b         a AND b         explicit boolean operators (uppercase only)
 *   (a OR b) c                     grouping; adjacency means AND
 *
 * LUCENE COMPATIBILITY
 *
 * The syntax above is deliberately the terse mail-client dialect, because that is what
 * fingers already know. But the moment search spans every source at once — mail, chats,
 * issues and feeds in one result list — people reach for the syntax they use against
 * every other search box they own, and that syntax is Lucene's. So the same parser
 * accepts it:
 *
 *   subject:bud*                   wildcards: * is any run, ? is exactly one character
 *   budgt~   budgt~2               fuzzy match, by edit distance (default 2)
 *   "budget review"~5              proximity: the words within 5 positions of each other, in any order
 *   date:[2026-01-01 TO 2026-03-31]  inclusive range
 *   size:{1M TO 10M}               exclusive range; [1M TO *] leaves an end open
 *   subject:budget^3 body:budget   boost: weights a clause when results are ranked
 *   +is:unread  -is:read           required / prohibited
 *   a && b       a || b      !c    the punctuation spellings of AND, OR and NOT
 *   sub\*ject                      backslash makes any special character literal
 *
 * Three divergences from Lucene, all on purpose:
 *
 *   - Adjacency means AND, not OR. `budget review` finds items with both words, which is
 *     what every mail client does and what users demonstrably expect. `+` is therefore
 *     accepted and ignored: it already is the default.
 *   - A bare `field:value` is a substring match, not a whole-token match, because
 *     `from:dana` has to find `dana.whitfield@contoso.com`. Ask for a whole-token match
 *     with a wildcard (`from:dana*`) or an exact one with `=` (`from:=dana`).
 *   - Proximity ignores word order. Lucene allows a transposition but charges slop for
 *     it; here it is free. See `withinSlop`.
 */

import type { VNode } from './provider.js';
import { VfsError } from './errors.js';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type CompareOp = 'contains' | 'equals' | 'gt' | 'lt' | 'gte' | 'lte';

/**
 * Modifiers that change how a value is matched, shared by field terms and free text so
 * `subject:budg*` and a bare `budg*` behave identically.
 */
export interface MatchModifiers {
  /** Lucene `^n`. Multiplies this clause's contribution when results are ranked. */
  readonly boost?: number;
  /** Lucene `~n`. Maximum edit distance for a fuzzy match. */
  readonly fuzzy?: number;
  /** True when the value carries live `*` / `?` wildcards. */
  readonly wildcard?: boolean;
  /** Lucene `"a b"~n`. How far apart a phrase's words may drift. */
  readonly slop?: number;
}

export interface TermQuery extends MatchModifiers {
  readonly type: 'term';
  readonly field: string;
  readonly op: CompareOp;
  readonly value: string;
}

export interface TextQuery extends MatchModifiers {
  readonly type: 'text';
  readonly value: string;
}

export interface AndQuery {
  readonly type: 'and';
  readonly clauses: readonly Query[];
  readonly boost?: number;
}

export interface OrQuery {
  readonly type: 'or';
  readonly clauses: readonly Query[];
  readonly boost?: number;
}

export interface NotQuery {
  readonly type: 'not';
  readonly clause: Query;
  readonly boost?: number;
}

export interface MatchAllQuery {
  readonly type: 'all';
}

export type Query = TermQuery | TextQuery | AndQuery | OrQuery | NotQuery | MatchAllQuery;

export const MATCH_ALL: MatchAllQuery = { type: 'all' };

/** Fields that can only be decided by fetching the item body. */
export const CONTENT_FIELDS = new Set(['body']);

/** Field aliases, so both `author:` and `from:` work. */
const FIELD_ALIASES: Record<string, string> = {
  from: 'author',
  sender: 'author',
  by: 'author',
  has: 'is',
  flag: 'is',
  tag: 'is',
  title: 'subject',
  name: 'name',
  text: 'body',
  sent: 'date',
  received: 'date',
  modified: 'date',
  mtime: 'date',
  updated: 'date',
};

const KNOWN_FIELDS = new Set([
  'author', 'subject', 'name', 'is', 'kind', 'body',
  'before', 'after', 'on', 'date', 'larger', 'smaller', 'size', 'id', 'path',
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = 'word' | 'lparen' | 'rparen' | 'and' | 'or' | 'not';

interface Token {
  readonly type: TokenType;
  readonly value: string;
  /** True when the value arrived inside quotes, so `AND` stays a literal word. */
  readonly quoted: boolean;
  /**
   * Per-character companion to `value`: `1` where the character arrived bare and may
   * therefore act as syntax (`:`, `*`, `?`, `[`, a leading `-`), `0` where it came from
   * inside quotes or from behind a backslash and can only ever be itself.
   *
   * Without this, there is no way to tell `sub*ject` (a wildcard) from `sub\*ject` and
   * `"sub*ject"` (a literal asterisk), and a user who escapes a character gets the
   * opposite of what they asked for — silently, as a wrong result rather than an error.
   */
  readonly mask: string;
  /** Lucene `^n`, stripped from the end of the token. */
  readonly boost?: number;
  /** Lucene `~n`, stripped from the end of the token. Fuzziness, or phrase slop. */
  readonly tilde?: number;
  readonly start: number;
}

/** True when every character of the token arrived bare, so it may be an operator. */
function allBare(token: { value: string; mask: string }): boolean {
  return token.value.length > 0 && !token.mask.includes('0');
}

const DEFAULT_FUZZINESS = 2;

/**
 * Peel `^boost` and `~fuzziness` off the end of a token.
 *
 * Lucene allows either order and either may be absent, so this loops rather than trying
 * to match one grand regex. Only bare characters count: `budget\~2` is a filename.
 */
function stripModifiers(value: string, mask: string): {
  value: string;
  mask: string;
  boost?: number;
  tilde?: number;
} {
  let text = value;
  let bits = mask;
  let boost: number | undefined;
  let tilde: number | undefined;

  for (;;) {
    const match = /([\^~])(\d+(?:\.\d+)?)?$/.exec(text);
    if (match === null) break;
    const at = text.length - (match[0] as string).length;
    // The marker itself must be bare, and something must be left in front of it.
    if (bits[at] !== '1' || at === 0) break;
    const amount = match[2] === undefined ? undefined : Number(match[2]);
    if (match[1] === '^') {
      if (amount === undefined || !Number.isFinite(amount) || amount <= 0) break;
      if (boost !== undefined) break;
      boost = amount;
    } else {
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) break;
      if (tilde !== undefined) break;
      tilde = amount ?? DEFAULT_FUZZINESS;
    }
    text = text.slice(0, at);
    bits = bits.slice(0, at);
  }

  return {
    value: text,
    mask: bits,
    ...(boost === undefined ? {} : { boost }),
    ...(tilde === undefined ? {} : { tilde }),
  };
}

const CLOSER: Record<string, string> = { '[': ']', '{': '}' };

/**
 * Length of a `[a TO b]` span starting at `input[i]`, or 0 when this bracket is just a
 * bracket.
 *
 * Requiring a literal ` TO ` inside is what keeps `subject:[urgent]` — which people
 * genuinely type, because people genuinely write it in subject lines — from being read
 * as a malformed range and rejected.
 */
function rangeSpanLength(input: string, i: number): number {
  const closer = CLOSER[input[i] as string];
  if (closer === undefined) return 0;
  const end = input.indexOf(closer, i + 1);
  if (end === -1) return 0;
  const inner = input.slice(i + 1, end);
  return / TO /.test(inner) ? end - i + 1 : 0;
}

export function tokenizeQuery(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i] as string;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', value: '(', quoted: false, mask: '1', start: i });
      i += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', value: ')', quoted: false, mask: '1', start: i });
      i += 1;
      continue;
    }

    // A word runs until whitespace or a paren, but quoted spans and `[a TO b]` ranges
    // swallow both. This lets `subject:"budget (final)"` work without escaping.
    const start = i;
    let value = '';
    let mask = '';
    let sawQuote = false;

    while (i < input.length) {
      const c = input[i] as string;

      // A backslash makes the next character literal, whatever it is.
      if (c === '\\' && i + 1 < input.length) {
        value += input[i + 1] as string;
        mask += '0';
        i += 2;
        continue;
      }

      if (c === '"' || c === "'") {
        sawQuote = true;
        const quote = c;
        i += 1;
        while (i < input.length && input[i] !== quote) {
          // Backslash escapes the quote character itself.
          if (input[i] === '\\' && i + 1 < input.length) {
            value += input[i + 1] as string;
            mask += '0';
            i += 2;
            continue;
          }
          value += input[i] as string;
          mask += '0';
          i += 1;
        }
        if (i >= input.length) {
          throw VfsError.invalid(
            `Unterminated quote in query at position ${start}.`,
            'Close the quote, e.g. subject:"quarterly budget".',
          );
        }
        i += 1; // closing quote
        continue;
      }

      const span = rangeSpanLength(input, i);
      if (span > 0) {
        value += input.slice(i, i + span);
        mask += '1'.repeat(span);
        i += span;
        continue;
      }

      if (/\s/.test(c) || c === '(' || c === ')') break;
      value += c;
      mask += '1';
      i += 1;
    }

    if (value.length === 0 && !sawQuote) {
      i += 1;
      continue;
    }

    const stripped = stripModifiers(value, mask);

    // `quoted` means "this token is a literal phrase", i.e. every character that is not a
    // trailing modifier came from inside quotes. `subject:"a b"` is therefore NOT quoted
    // for parsing purposes: the quotes protected the value, they did not make the whole
    // thing literal text. `"a b"~3` still is: `~3` is syntax, not content.
    const isPhrase = sawQuote && !stripped.mask.includes('1');
    const base = { value: stripped.value, mask: stripped.mask, start };
    const modifiers = {
      ...(stripped.boost === undefined ? {} : { boost: stripped.boost }),
      ...(stripped.tilde === undefined ? {} : { tilde: stripped.tilde }),
    };

    if (!isPhrase && allBare(base) && OPERATOR_TOKENS[base.value] !== undefined) {
      tokens.push({
        type: OPERATOR_TOKENS[base.value] as TokenType,
        value: base.value,
        quoted: false,
        mask: base.mask,
        start,
      });
    } else {
      tokens.push({ type: 'word', quoted: isPhrase, ...base, ...modifiers });
    }
  }

  return tokens;
}

/**
 * The words and punctuation that are boolean operators rather than search terms. The
 * uppercase-only rule is Lucene's and is worth keeping: `mail and packages` is a search,
 * not a conjunction.
 */
const OPERATOR_TOKENS: Record<string, TokenType> = {
  AND: 'and',
  '&&': 'and',
  OR: 'or',
  '||': 'or',
  NOT: 'not',
  '!': 'not',
};


// ---------------------------------------------------------------------------
// Parser  (recursive descent; precedence: NOT > implicit AND > AND > OR)
// ---------------------------------------------------------------------------

export function parseQuery(input: string): Query {
  const tokens = tokenizeQuery(input);
  if (tokens.length === 0) return MATCH_ALL;

  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];

  function parseOr(): Query {
    const clauses: Query[] = [parseAnd()];
    while (peek()?.type === 'or') {
      pos += 1;
      clauses.push(parseAnd());
    }
    return clauses.length === 1 ? (clauses[0] as Query) : { type: 'or', clauses };
  }

  function parseAnd(): Query {
    const clauses: Query[] = [];
    for (;;) {
      const token = peek();
      if (token === undefined || token.type === 'rparen' || token.type === 'or') break;
      if (token.type === 'and') {
        pos += 1;
        continue;
      }
      clauses.push(parseUnary());
    }
    if (clauses.length === 0) {
      throw VfsError.invalid('Empty group in query.', 'Remove the empty () or add a term inside it.');
    }
    return clauses.length === 1 ? (clauses[0] as Query) : { type: 'and', clauses };
  }

  function parseUnary(): Query {
    const token = peek();
    if (token === undefined) {
      throw VfsError.invalid('Unexpected end of query.');
    }
    if (token.type === 'not') {
      pos += 1;
      return { type: 'not', clause: parseUnary() };
    }
    if (token.type === 'lparen') {
      pos += 1;
      const inner = parseOr();
      const closing = peek();
      if (closing?.type !== 'rparen') {
        throw VfsError.invalid('Missing closing parenthesis in query.');
      }
      pos += 1;
      return applyGroupBoost(inner, closing);
    }
    if (token.type === 'rparen') {
      throw VfsError.invalid(`Unexpected ")" at position ${token.start}.`);
    }

    pos += 1;
    return parseWord(token);
  }

  /**
   * Lucene's `(a b)^2`. Only a `^n` welded directly onto the closing paren counts, so a
   * genuine search for the character `^` a space later is left alone.
   */
  function applyGroupBoost(inner: Query, closing: Token): Query {
    const next = peek();
    if (next === undefined || next.type !== 'word' || next.start !== closing.start + 1) return inner;
    if (!allBare(next)) return inner;
    const match = /^\^(\d+(?:\.\d+)?)$/.exec(next.value);
    if (match === null) return inner;
    const boost = Number(match[1]);
    if (!Number.isFinite(boost) || boost <= 0) return inner;
    pos += 1;
    return withBoost(inner, boost);
  }

  const result = parseOr();
  if (pos < tokens.length) {
    const token = tokens[pos] as Token;
    throw VfsError.invalid(`Unexpected "${token.value}" at position ${token.start}.`);
  }
  return result;
}

/** True when `value` holds a live wildcard at a bare position. */
function hasWildcard(value: string, mask: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (mask[i] === '1' && (value[i] === '*' || value[i] === '?')) return true;
  }
  return false;
}

/** Attach a boost to any clause that can carry one. Match-all cannot be made more true. */
function withBoost(query: Query, boost: number): Query {
  switch (query.type) {
    case 'term': return { ...query, boost };
    case 'text': return { ...query, boost };
    case 'and': return { ...query, boost };
    case 'or': return { ...query, boost };
    case 'not': return { ...query, boost };
    default: return query;
  }
}

function parseWord(token: Token): Query {
  const value = token.value;
  const mask = token.mask;

  // `+term` means "required", which is already what adjacency means here, so it is
  // accepted and dropped rather than rejected. `-term` and `!term` are NOT.
  if (!token.quoted && mask[0] === '1' && value.length > 1) {
    const lead = value[0] as string;
    if (lead === '+') {
      return parseWord({ ...token, value: value.slice(1), mask: mask.slice(1) });
    }
    if (lead === '-' || lead === '!') {
      return { type: 'not', clause: parseWord({ ...token, value: value.slice(1), mask: mask.slice(1) }) };
    }
  }

  // A quoted token is always literal text, never a field expression. `~n` on it is
  // proximity between its words, not fuzziness.
  if (token.quoted) {
    return textQuery(value, false, {
      ...(token.boost === undefined ? {} : { boost: token.boost }),
      ...(token.tilde === undefined ? {} : { slop: token.tilde }),
    });
  }

  const colon = indexOfBare(value, mask, ':');
  if (colon <= 0) {
    return textQuery(value, hasWildcard(value, mask), {
      ...(token.boost === undefined ? {} : { boost: token.boost }),
      ...(token.tilde === undefined ? {} : { fuzzy: token.tilde }),
    });
  }

  const rawField = value.slice(0, colon).toLowerCase();
  let rest = value.slice(colon + 1);
  let restMask = mask.slice(colon + 1);

  // `meta.foo:bar` addresses arbitrary provider metadata.
  const field = rawField.startsWith('meta.') ? rawField : (FIELD_ALIASES[rawField] ?? rawField);

  if (!field.startsWith('meta.') && !KNOWN_FIELDS.has(field)) {
    throw VfsError.invalid(
      `Unknown query field "${rawField}".`,
      `Known fields: ${[...KNOWN_FIELDS].sort().join(', ')}, meta.*. Aliases: ${Object.keys(FIELD_ALIASES).sort().join(', ')}.`,
    );
  }

  if (rest.length === 0) {
    throw VfsError.invalid(
      `Query field "${rawField}" has no value.`,
      `Write ${rawField}:something, or quote it if it contains spaces.`,
    );
  }

  const boost = token.boost;
  const range = parseRange(field, rest, restMask, rawField, boost);
  if (range !== undefined) return range;

  let op: CompareOp = 'contains';
  // Longest first: `>=` must win over `>`.
  for (const [prefix, candidate] of OP_PREFIXES) {
    if (rest.startsWith(prefix)) {
      op = candidate;
      rest = rest.slice(prefix.length);
      restMask = restMask.slice(prefix.length);
      break;
    }
  }

  if (rest.length === 0) {
    throw VfsError.invalid(
      `Query field "${rawField}" has a comparison but nothing to compare to.`,
      `Write ${rawField}:>1M, or drop the operator.`,
    );
  }

  return {
    type: 'term',
    field,
    op,
    value: rest,
    ...(boost === undefined ? {} : { boost }),
    ...(token.tilde === undefined ? {} : { fuzzy: token.tilde }),
    ...(hasWildcard(rest, restMask) ? { wildcard: true } : {}),
  };
}

const OP_PREFIXES: ReadonlyArray<readonly [string, CompareOp]> = [
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['=', 'equals'],
  ['>', 'gt'],
  ['<', 'lt'],
];

function textQuery(value: string, wildcard: boolean, modifiers: MatchModifiers): Query {
  return {
    type: 'text',
    value,
    ...modifiers,
    ...(wildcard ? { wildcard: true } : {}),
  };
}

function indexOfBare(value: string, mask: string, char: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (mask[i] === '1' && value[i] === char) return i;
  }
  return -1;
}

/**
 * `field:[a TO b]` and `field:{a TO b}`, including the half-open `[a TO *]` forms.
 *
 * Ranges are lowered to the ordinary comparison terms the rest of the engine and every
 * provider already understand, rather than becoming a new node type. A range is exactly
 * two bounds; giving it its own shape would oblige every provider, every push-down
 * translator and every serializer to learn a third thing that means what two of the
 * things they have already mean.
 */
function parseRange(
  field: string,
  value: string,
  mask: string,
  rawField: string,
  boost: number | undefined,
): Query | undefined {
  const open = value[0];
  const close = value[value.length - 1];
  if (mask[0] !== '1' || mask[mask.length - 1] !== '1') return undefined;
  if (open !== '[' && open !== '{') return undefined;
  if (close !== ']' && close !== '}') return undefined;

  const inner = value.slice(1, -1);
  const split = inner.indexOf(' TO ');
  if (split === -1) return undefined;

  const lower = inner.slice(0, split).trim();
  const upper = inner.slice(split + 4).trim();
  const boosted = boost === undefined ? {} : { boost };

  const clauses: Query[] = [];
  if (lower !== '' && lower !== '*') {
    clauses.push({ type: 'term', field, op: open === '[' ? 'gte' : 'gt', value: lower, ...boosted });
  }
  if (upper !== '' && upper !== '*') {
    clauses.push({ type: 'term', field, op: close === ']' ? 'lte' : 'lt', value: upper, ...boosted });
  }

  if (clauses.length === 0) {
    throw VfsError.invalid(
      `The range on "${rawField}" has no bounds.`,
      `Give at least one end, e.g. ${rawField}:[2026-01-01 TO *].`,
    );
  }

  return clauses.length === 1 ? (clauses[0] as Query) : { type: 'and', clauses };
}


// ---------------------------------------------------------------------------
// Date and size parsing
// ---------------------------------------------------------------------------

const DURATION = /^(\d+)\s*([hdwmy])$/i;

/**
 * Parse a date bound. Accepts ISO dates (`2026-01-31`, `2026-01`, `2026`), relative
 * durations (`7d`, `2w`, `3h`, `6m`, `1y`) meaning "ago", and the keywords `today`,
 * `yesterday` and `now`.
 */
export function parseDateValue(value: string, now: Date = new Date()): Date {
  const trimmed = value.trim().toLowerCase();

  if (trimmed === 'now') return new Date(now);
  if (trimmed === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (trimmed === 'yesterday') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  }

  const duration = DURATION.exec(trimmed);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = (duration[2] as string).toLowerCase();
    const date = new Date(now);
    switch (unit) {
      case 'h': date.setHours(date.getHours() - amount); break;
      case 'd': date.setDate(date.getDate() - amount); break;
      case 'w': date.setDate(date.getDate() - amount * 7); break;
      case 'm': date.setMonth(date.getMonth() - amount); break;
      case 'y': date.setFullYear(date.getFullYear() - amount); break;
      default: break;
    }
    return date;
  }

  // Year / year-month / full date, interpreted in local time so `after:2026-01-01`
  // means midnight where the user is, not UTC.
  const ymd = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(trimmed);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = ymd[2] === undefined ? 0 : Number(ymd[2]) - 1;
    const day = ymd[3] === undefined ? 1 : Number(ymd[3]);
    return new Date(year, month, day);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw VfsError.invalid(
      `Cannot understand the date "${value}".`,
      'Try 2026-01-31, or a relative duration like 7d, 2w, 3h, 1y, or today/yesterday.',
    );
  }
  return parsed;
}

const SIZE = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i;

/**
 * The instant a date expression *ends*.
 *
 * `date:<=2026-01` has to mean "through the end of January", not "before midnight on the
 * 1st". A user who writes a month means the month; answering with one instant of it and
 * calling that an upper bound loses thirty days of mail without saying so. Relative
 * durations and `now` name an instant already, so for them this is the identity.
 */
export function parseDateBoundEnd(value: string, now: Date = new Date()): Date {
  const trimmed = value.trim().toLowerCase();
  const start = parseDateValue(value, now);

  if (trimmed === 'today') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  if (trimmed === 'yesterday') return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);

  const ymd = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(trimmed);
  if (ymd) {
    if (ymd[3] !== undefined) return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    if (ymd[2] !== undefined) return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return new Date(start.getFullYear() + 1, 0, 1);
  }

  return start;
}

export function parseSizeValue(value: string): number {
  const match = SIZE.exec(value.trim());
  if (!match) {
    throw VfsError.invalid(`Cannot understand the size "${value}".`, 'Try 500, 100k, 2M or 1G.');
  }
  const amount = Number(match[1]);
  const multiplier = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[2] as string).toLowerCase()] ?? 1;
  return Math.round(amount * multiplier);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluateContext {
  /** Item body, when already loaded. Absent means `body:` terms cannot be decided. */
  readonly body?: string;
  readonly now?: Date;
}

/**
 * Three-valued result. `unknown` is essential for honesty: if a query asks about the
 * message body and the body has not been fetched, the correct answer is "I cannot tell",
 * not a silent false (which hides matches) or a silent true (which fabricates them).
 * Callers decide what to do — `grep` fetches the body, `ls` reports that it skipped.
 */
export type Trilean = true | false | 'unknown';

function and(a: Trilean, b: Trilean): Trilean {
  if (a === false || b === false) return false;
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return true;
}

function or(a: Trilean, b: Trilean): Trilean {
  if (a === true || b === true) return true;
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return false;
}

function equals(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

// ---------------------------------------------------------------------------
// Graded text matching
// ---------------------------------------------------------------------------

/**
 * How well a value matched, from 0 (not at all) to 1 (exactly).
 *
 * Matching and ranking share this one function on purpose. The alternative — a boolean
 * `matches()` beside a separate `score()` — is two implementations of the same rules that
 * will eventually disagree, and the day they do, the tool shows an item at the top of the
 * results that it also claims does not match.
 */
const NO_MATCH = 0;

const QUALITY = {
  exact: 1,
  word: 0.8,
  prefix: 0.6,
  substring: 0.45,
  phrase: 0.75,
  fuzzy: 0.5,
} as const;

/** Compiled matchers, cached per query node: a search re-tests one clause per item. */
const MATCHERS = new WeakMap<object, (haystack: string) => number>();

function matcherFor(spec: TermQuery | TextQuery): (haystack: string) => number {
  const cached = MATCHERS.get(spec);
  if (cached !== undefined) return cached;
  const built = buildMatcher(spec);
  MATCHERS.set(spec, built);
  return built;
}

function buildMatcher(spec: TermQuery | TextQuery): (haystack: string) => number {
  const needle = spec.value.toLocaleLowerCase();
  const exactOnly = spec.type === 'term' && spec.op === 'equals';

  if (spec.wildcard === true) {
    const full = new RegExp(`^${wildcardToSource(needle)}$`, 'u');
    return (haystack) => {
      const hay = haystack.toLocaleLowerCase();
      if (full.test(hay)) return QUALITY.exact;
      if (exactOnly) return NO_MATCH;
      for (const word of words(hay)) {
        if (full.test(word)) return QUALITY.word;
      }
      return NO_MATCH;
    };
  }

  if (spec.fuzzy !== undefined && spec.fuzzy > 0) {
    const maxDistance = Math.min(spec.fuzzy, Math.max(1, needle.length - 1));
    return (haystack) => {
      const hay = haystack.toLocaleLowerCase();
      const exact = plainQuality(hay, needle, exactOnly);
      if (exact > NO_MATCH) return exact;
      let best = NO_MATCH;
      for (const word of words(hay)) {
        const distance = boundedEditDistance(word, needle, maxDistance);
        if (distance === undefined) continue;
        // Graded by how far off the spelling actually was, not by how far off it was
        // allowed to be: `budgt~1` and `budgt~2` both found the same word equally well.
        const quality = QUALITY.fuzzy * (1 - distance / (needle.length + 1));
        if (quality > best) best = quality;
      }
      return best;
    };
  }

  if (spec.slop !== undefined && /\s/.test(needle)) {
    const terms = words(needle);
    return (haystack) => {
      const hay = haystack.toLocaleLowerCase();
      const direct = plainQuality(hay, needle, exactOnly);
      if (direct > NO_MATCH) return direct;
      return withinSlop(words(hay), terms, spec.slop as number) ? QUALITY.phrase : NO_MATCH;
    };
  }

  return (haystack) => plainQuality(haystack.toLocaleLowerCase(), needle, exactOnly);
}

function plainQuality(hay: string, needle: string, exactOnly: boolean): number {
  if (hay === needle) return QUALITY.exact;
  if (exactOnly) return NO_MATCH;
  const at = hay.indexOf(needle);
  if (at === -1) return NO_MATCH;
  // A whole-word hit beats one that happened to fall inside a longer word: searching for
  // "budget" should rank "the budget" above "rebudgeting". This covers multi-word
  // phrases too, which is why it is a boundary test rather than a word-list scan.
  if (isWordBoundary(hay, at, needle.length)) {
    return at === 0 && at + needle.length === hay.length ? QUALITY.exact : QUALITY.word;
  }
  if (hay.startsWith(needle) || startsAWord(hay, at)) return QUALITY.prefix;
  return QUALITY.substring;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordBoundary(hay: string, at: number, length: number): boolean {
  return startsAWord(hay, at) && !WORD_CHAR.test(hay[at + length] ?? '');
}

function startsAWord(hay: string, at: number): boolean {
  return !WORD_CHAR.test(hay[at - 1] ?? '');
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function words(text: string): string[] {
  return text.split(WORD_SPLIT).filter((word) => word.length > 0);
}

/** Translate `*` and `?` into a regular expression, quoting everything else. */
function wildcardToSource(pattern: string): string {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * Bounded rather than complete because this runs once per candidate word per item per
 * clause; the unbounded version turns a fuzzy search of a large mailbox into a hang, and
 * a hang is indistinguishable from a crash to someone listening to a screen reader.
 */
function boundedEditDistance(a: string, b: string, max: number): number | undefined {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return undefined;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowBest = current[0] as number;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < rowBest) rowBest = value;
    }
    if (rowBest > max) return undefined;
    const swap = previous;
    previous = current;
    current = swap;
  }

  const distance = previous[b.length] as number;
  return distance > max ? undefined : distance;
}

/**
 * Lucene proximity: all of `terms` appear in `haystack`, in order, spread over no more
 * than `slop` extra positions.
 */
/**
 * Whether the terms all appear close enough together, in any order.
 *
 * Order-insensitive on purpose, and this is the one place the implementation diverges
 * from Lucene's exact arithmetic. Lucene permits a transposition but charges 2 slop for
 * it; here a reordering is free. Someone typing `"budget review"~5` is asking "are these
 * two words near each other", and text that reads "review the budget" is exactly what
 * they were looking for. Making them guess the author's word order turns a search into a
 * false negative — the one answer this program must never give — and there is no
 * corresponding harm in the other direction, because slop is already an explicit request
 * for looseness.
 *
 * The span is measured between the leftmost and rightmost term of a candidate window, so
 * `slop` keeps its Lucene meaning: the number of extra words tolerated between them.
 */
function withinSlop(haystack: readonly string[], terms: readonly string[], slop: number): boolean {
  if (terms.length === 0) return true;
  const width = terms.length - 1 + slop;

  // Anchor on each occurrence of the rarest-to-find term by simply trying every position:
  // a window is only ever `width + 1` wide, so this stays linear in the haystack.
  for (let start = 0; start < haystack.length; start += 1) {
    if (!terms.includes(haystack[start] as string)) continue;

    const limit = Math.min(haystack.length, start + width + 1);
    const outstanding = new Set(terms);
    let last = start;
    for (let k = start; k < limit; k += 1) {
      const word = haystack[k] as string;
      if (!outstanding.delete(word)) continue;
      last = k;
      if (outstanding.size === 0) break;
    }
    if (outstanding.size === 0 && last - start <= width) return true;
  }

  return false;
}

/** Relative weight of each place a bare word is looked for. */
const TEXT_HAYSTACKS: ReadonlyArray<readonly [keyof VNode, number]> = [
  ['title', 1],
  ['name', 0.7],
  ['summary', 0.6],
  ['author', 0.7],
  ['authorId', 0.5],
];

function textQuality(query: TextQuery, node: VNode): number {
  const match = matcherFor(query);
  let best = NO_MATCH;
  for (const [field, weight] of TEXT_HAYSTACKS) {
    const value = node[field];
    if (typeof value !== 'string' || value === '') continue;
    const quality = match(value) * weight;
    if (quality > best) best = quality;
  }
  return best;
}


export function evaluateQuery(query: Query, node: VNode, context: EvaluateContext = {}): Trilean {
  switch (query.type) {
    case 'all':
      return true;

    case 'and':
      return query.clauses.reduce<Trilean>((acc, clause) => and(acc, evaluateQuery(clause, node, context)), true);

    case 'or':
      return query.clauses.reduce<Trilean>((acc, clause) => or(acc, evaluateQuery(clause, node, context)), false);

    case 'not': {
      const inner = evaluateQuery(query.clause, node, context);
      return inner === 'unknown' ? 'unknown' : !inner;
    }

    case 'text':
      return textQuality(query, node) > NO_MATCH;

    case 'term':
      return judgeTerm(query, node, context).verdict;

    default:
      return 'unknown';
  }
}

/**
 * Relevance, for ordering results that came from more than one place.
 *
 * A single folder has an obvious order — newest first — but a result list drawn from
 * mail, chats, issues and feeds at once does not: "newest" puts a trivial feed item above
 * the message that actually answers the question. So clauses contribute graded scores,
 * `^n` weights them, and the caller sorts. Zero means "did not match", so this never
 * disagrees with `evaluateQuery` about what belongs in the list at all.
 */
export function scoreQuery(query: Query, node: VNode, context: EvaluateContext = {}): number {
  switch (query.type) {
    case 'all':
      return 1;

    case 'and': {
      let total = 0;
      for (const clause of query.clauses) {
        const score = scoreQuery(clause, node, context);
        if (score <= NO_MATCH) return NO_MATCH;
        total += score;
      }
      return total * (query.boost ?? 1);
    }

    case 'or': {
      let total = 0;
      for (const clause of query.clauses) total += Math.max(0, scoreQuery(clause, node, context));
      return total * (query.boost ?? 1);
    }

    case 'not':
      // A satisfied negation says nothing about how relevant an item is, only that it is
      // still eligible, so it contributes a flat amount rather than a graded one.
      return evaluateQuery(query.clause, node, context) === true ? NO_MATCH : (query.boost ?? 1);

    case 'text':
      return textQuality(query, node) * (query.boost ?? 1);

    case 'term': {
      const { verdict, quality } = judgeTerm(query, node, context);
      if (verdict !== true) return NO_MATCH;
      return quality * (query.boost ?? 1);
    }

    default:
      return NO_MATCH;
  }
}

interface TermVerdict {
  readonly verdict: Trilean;
  readonly quality: number;
}

const MATCHED: TermVerdict = { verdict: true, quality: 1 };
const MISSED: TermVerdict = { verdict: false, quality: NO_MATCH };
const UNDECIDED: TermVerdict = { verdict: 'unknown', quality: NO_MATCH };

function decide(matched: boolean): TermVerdict {
  return matched ? MATCHED : MISSED;
}

function graded(quality: number): TermVerdict {
  return quality > NO_MATCH ? { verdict: true, quality } : MISSED;
}

/** The best quality this term achieves against any of the given haystacks. */
function bestOf(term: TermQuery, values: ReadonlyArray<string | undefined>): TermVerdict {
  // `name:[a TO m]` and `subject:>q` are ordering questions, not matching ones, so they
  // compare rather than search. Lucene ranges over text fields work exactly this way.
  if (term.op === 'gt' || term.op === 'gte' || term.op === 'lt' || term.op === 'lte') {
    const bound = term.value.toLocaleLowerCase();
    for (const value of values) {
      if (value === undefined) continue;
      const compared = value.toLocaleLowerCase().localeCompare(bound);
      const satisfied =
        term.op === 'gt' ? compared > 0
          : term.op === 'gte' ? compared >= 0
            : term.op === 'lt' ? compared < 0
              : compared <= 0;
      if (satisfied) return MATCHED;
    }
    return MISSED;
  }

  const match = matcherFor(term);
  let best = NO_MATCH;
  for (const value of values) {
    if (value === undefined || value === '') continue;
    const quality = match(value);
    if (quality > best) best = quality;
  }
  return graded(best);
}

function judgeTerm(term: TermQuery, node: VNode, context: EvaluateContext): TermVerdict {
  const { field, op, value } = term;
  const now = context.now ?? new Date();

  if (field.startsWith('meta.')) {
    const key = field.slice('meta.'.length);
    const raw = node.meta?.[key];
    if (raw === undefined) return MISSED;
    return bestOf(term, [String(raw)]);
  }

  switch (field) {
    case 'author':
      return bestOf(term, [node.author, node.authorId]);

    case 'subject':
      return bestOf(term, [node.title]);

    case 'name':
      return bestOf(term, [node.name]);

    case 'id':
      return decide(equals(node.id, value));

    case 'path':
      return bestOf(term, [node.path]);

    case 'kind':
      // Matches either the structural kind (dir/file) or the provider's semantic label,
      // so `kind:dir` and `kind:message` both do what the user meant.
      return decide(equals(node.kind, value) || equals(node.subtype, value));

    case 'is': {
      const flags = node.flags ?? [];
      // `is:read` is the negation of the `unread` flag, not a flag of its own; encoding
      // it as a flag would force every provider to emit both halves of every boolean.
      if (value.toLowerCase() === 'read') return decide(!flags.includes('unread'));
      return decide(flags.some((flag) => equals(flag, value)));
    }

    case 'body': {
      if (context.body === undefined) return UNDECIDED;
      return bestOf(term, [context.body]);
    }

    case 'after': {
      if (node.mtime === undefined) return MISSED;
      return decide(node.mtime.getTime() >= parseDateValue(value, now).getTime());
    }

    case 'before': {
      if (node.mtime === undefined) return MISSED;
      return decide(node.mtime.getTime() < parseDateValue(value, now).getTime());
    }

    case 'on': {
      if (node.mtime === undefined) return MISSED;
      const start = parseDateValue(value, now);
      const end = parseDateBoundEnd(value, now);
      return decide(node.mtime.getTime() >= start.getTime() && node.mtime.getTime() < end.getTime());
    }

    // The general-purpose date field, and the one ranges are written against:
    // `date:[2026-01-01 TO 2026-03-31]`. A bare date names a whole day, so an upper bound
    // includes it and a strict lower bound excludes all of it.
    case 'date': {
      if (node.mtime === undefined) return MISSED;
      const at = node.mtime.getTime();
      switch (op) {
        case 'gt': return decide(at >= parseDateBoundEnd(value, now).getTime());
        case 'gte': return decide(at >= parseDateValue(value, now).getTime());
        case 'lt': return decide(at < parseDateValue(value, now).getTime());
        case 'lte': return decide(at < parseDateBoundEnd(value, now).getTime());
        default: {
          const start = parseDateValue(value, now);
          const end = parseDateBoundEnd(value, now);
          return decide(at >= start.getTime() && at < end.getTime());
        }
      }
    }

    // size:>1M is what everyone types first, because that is what web mail clients use.
    // larger:/smaller: remain the preferred spelling because they are speakable —
    // `size colon greater-than one em` is not a phrase anyone wants to hear read back —
    // but rejecting the familiar form taught nobody anything.
    case 'size': {
      if (node.size === undefined) return UNDECIDED;
      const bound = parseSizeValue(value);
      switch (op) {
        case 'gt': return decide(node.size > bound);
        case 'gte': return decide(node.size >= bound);
        case 'lt': return decide(node.size < bound);
        case 'lte': return decide(node.size <= bound);
        default: return decide(node.size === bound);
      }
    }

    case 'larger': {
      if (node.size === undefined) return UNDECIDED;
      return decide(node.size > parseSizeValue(value));
    }

    case 'smaller': {
      if (node.size === undefined) return UNDECIDED;
      return decide(node.size < parseSizeValue(value));
    }

    default:
      return UNDECIDED;
  }
}


/** Every field name referenced anywhere in the query. */
export function queryFields(query: Query): Set<string> {
  const fields = new Set<string>();
  const walk = (q: Query): void => {
    switch (q.type) {
      case 'term': fields.add(q.field); break;
      case 'and':
      case 'or': q.clauses.forEach(walk); break;
      case 'not': walk(q.clause); break;
      default: break;
    }
  };
  walk(query);
  return fields;
}

/** True when the query can only be decided by downloading item bodies. */
export function requiresContent(query: Query): boolean {
  for (const field of queryFields(query)) {
    if (CONTENT_FIELDS.has(field)) return true;
  }
  return false;
}

export function isMatchAll(query: Query | undefined): boolean {
  return query === undefined || query.type === 'all';
}

/**
 * Render a query back to source form. Round-trips through `parseQuery`.
 *
 * This is load-bearing rather than cosmetic: the engine decides whether to trust a
 * provider's claim to have applied a query server-side by comparing stringified forms. If
 * two genuinely different queries render the same, the engine trusts a filter that was
 * never applied and silently hides mail. So every field that changes what a clause
 * matches — the boost, the fuzziness, the slop, the wildcards — has to survive the trip.
 */
export function stringifyQuery(query: Query): string {
  switch (query.type) {
    case 'all': return '*';
    case 'text': return renderValue(query.value, query.wildcard === true) + renderModifiers(query);
    case 'term': {
      const prefix = OP_SPELLING[query.op];
      return `${query.field}:${renderValue(query.value, query.wildcard === true, prefix)}${renderModifiers(query)}`;
    }
    case 'not': {
      const inner = stringifyQuery(query.clause);
      const grouped = query.clause.type === 'and' || query.clause.type === 'or';
      return `NOT ${grouped ? `(${inner})` : inner}${renderBoost(query.boost)}`;
    }
    case 'and': {
      const body = query.clauses
        .map((c) => (c.type === 'or' ? `(${stringifyQuery(c)})` : stringifyQuery(c)))
        .join(' ');
      return query.boost === undefined ? body : `(${body})^${String(query.boost)}`;
    }
    case 'or': {
      const body = query.clauses
        .map((c) => (c.type === 'and' ? `(${stringifyQuery(c)})` : stringifyQuery(c)))
        .join(' OR ');
      return query.boost === undefined ? body : `(${body})^${String(query.boost)}`;
    }
    default:
      return '*';
  }
}

const OP_SPELLING: Record<CompareOp, string> = {
  contains: '',
  equals: '=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Characters that would end or re-shape a token if they were let out unprotected. */
const NEEDS_QUOTING = /[\s()"'\\*?^~:[\]{}&|]/;
const RESERVED_WORDS = new Set(['AND', 'OR', 'NOT', 'TO', '&&', '||', '!']);

function renderValue(value: string, wildcard: boolean, prefix = ''): string {
  if (value === '') return `"${prefix}"`;

  if (wildcard) {
    // Quoting would kill the wildcards, so every other special character is escaped
    // one at a time instead.
    const escaped = value.replace(/[\s()"'\\^~:+[\]{}&|!]/g, (char) => `\\${char}`);
    return prefix + (/^[-]/.test(escaped) ? `\\${escaped}` : escaped);
  }

  if (NEEDS_QUOTING.test(value) || RESERVED_WORDS.has(value)) {
    return `"${prefix}${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
  }

  if (prefix === '' && /^[-+!]/.test(value)) return `\\${value}`;
  return prefix + value;
}

function renderModifiers(query: TermQuery | TextQuery): string {
  const tilde = query.fuzzy ?? query.slop;
  return (tilde === undefined ? '' : `~${String(tilde)}`) + renderBoost(query.boost);
}

function renderBoost(boost: number | undefined): string {
  return boost === undefined ? '' : `^${String(boost)}`;
}


/** Field names offered by tab-completion, with one-line help. */
export const QUERY_FIELD_HELP: ReadonlyArray<readonly [string, string]> = [
  ['from:', 'sender name or address'],
  ['author:', 'sender name or address'],
  ['subject:', 'item title'],
  ['body:', 'item body (requires fetching content)'],
  ['is:', 'flag: unread, read, flagged, attachment, mention, draft'],
  ['has:', 'alias of is:'],
  ['kind:', 'dir or file'],
  ['after:', 'newer than a date or duration, e.g. 2026-01-01 or 7d'],
  ['before:', 'older than a date or duration'],
  ['on:', 'on a specific day'],
  ['date:', 'a date comparison or range, e.g. date:[2026-01-01 TO 2026-03-31]'],
  ['larger:', 'bigger than a size, e.g. 1M'],
  ['smaller:', 'smaller than a size'],
  ['size:', 'a size comparison or range, e.g. size:[1M TO 10M]'],
  ['name:', 'path segment name'],
  ['meta.', 'provider-specific metadata, e.g. meta.importance:high'],
];

/** The Lucene modifiers, for `queries` and for Tab completion's help listing. */
export const QUERY_SYNTAX_HELP: ReadonlyArray<readonly [string, string]> = [
  ['budg*', 'wildcard: * is any run of characters, ? is exactly one'],
  ['budgt~', 'fuzzy: allow spelling mistakes; ~1 is stricter, ~2 is the default'],
  ['"a b"~5', 'proximity: the words within 5 positions of each other, in either order'],
  ['[a TO b]', 'inclusive range; {a TO b} excludes the ends, and * leaves one open'],
  ['term^3', 'boost: weight this clause when results are ranked'],
  ['+term  -term', 'required (the default here) and prohibited'],
  ['a && b  a || b  !c', 'the punctuation spellings of AND, OR and NOT'],
  ['sub\\*ject', 'backslash makes the next character literal'],
];

