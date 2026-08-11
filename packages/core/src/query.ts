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
 */

import type { VNode } from './provider.js';
import { VfsError } from './errors.js';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type CompareOp = 'contains' | 'equals' | 'gt' | 'lt';

export interface TermQuery {
  readonly type: 'term';
  readonly field: string;
  readonly op: CompareOp;
  readonly value: string;
}

export interface TextQuery {
  readonly type: 'text';
  readonly value: string;
}

export interface AndQuery {
  readonly type: 'and';
  readonly clauses: readonly Query[];
}

export interface OrQuery {
  readonly type: 'or';
  readonly clauses: readonly Query[];
}

export interface NotQuery {
  readonly type: 'not';
  readonly clause: Query;
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
};

const KNOWN_FIELDS = new Set([
  'author', 'subject', 'name', 'is', 'kind', 'body',
  'before', 'after', 'on', 'larger', 'smaller', 'size', 'id', 'path',
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
  readonly start: number;
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
      tokens.push({ type: 'lparen', value: '(', quoted: false, start: i });
      i += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', value: ')', quoted: false, start: i });
      i += 1;
      continue;
    }

    // A word runs until whitespace or a paren, but quoted spans swallow both. This lets
    // `subject:"budget (final)"` work without escaping.
    const start = i;
    let value = '';
    let sawQuote = false;
    // Whether any character arrived from OUTSIDE a quoted span. This is what separates
    // `"Re: budget"` (a literal phrase) from `subject:"Re: budget"` (a field whose value
    // happened to need quoting). Treating both as literal text — which is what checking
    // "did a quote appear anywhere" does — silently turns every `from:"Dana Lee"` into a
    // full-text search for the string `from:Dana Lee`, which matches nothing and says so
    // in no way the user can see.
    let sawBareChar = false;

    while (i < input.length) {
      const c = input[i] as string;
      if (c === '"' || c === "'") {
        sawQuote = true;
        const quote = c;
        i += 1;
        while (i < input.length && input[i] !== quote) {
          // Backslash escapes the quote character itself.
          if (input[i] === '\\' && input[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          value += input[i] as string;
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
      if (/\s/.test(c) || c === '(' || c === ')') break;
      value += c;
      sawBareChar = true;
      i += 1;
    }

    if (value.length === 0 && !sawQuote) {
      i += 1;
      continue;
    }

    // `quoted` means "this token is a literal phrase", i.e. every character came from
    // inside quotes. `subject:"a b"` is therefore NOT quoted for parsing purposes: the
    // quotes protected the value, they did not make the whole thing literal text.
    const isPhrase = sawQuote && !sawBareChar;
    if (!sawQuote && value === 'AND') tokens.push({ type: 'and', value, quoted: false, start });
    else if (!sawQuote && value === 'OR') tokens.push({ type: 'or', value, quoted: false, start });
    else if (!sawQuote && value === 'NOT') tokens.push({ type: 'not', value, quoted: false, start });
    else tokens.push({ type: 'word', value, quoted: isPhrase, start });
  }

  return tokens;
}

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
      return inner;
    }
    if (token.type === 'rparen') {
      throw VfsError.invalid(`Unexpected ")" at position ${token.start}.`);
    }

    pos += 1;
    return parseWord(token);
  }

  const result = parseOr();
  if (pos < tokens.length) {
    const token = tokens[pos] as Token;
    throw VfsError.invalid(`Unexpected "${token.value}" at position ${token.start}.`);
  }
  return result;
}

function parseWord(token: Token): Query {
  let raw = token.value;

  // `-term` is shorthand for NOT term, but only when unquoted and followed by content.
  if (!token.quoted && raw.startsWith('-') && raw.length > 1) {
    return { type: 'not', clause: parseWord({ ...token, value: raw.slice(1) }) };
  }

  // A quoted token is always literal text, never a field expression.
  if (token.quoted) return { type: 'text', value: raw };

  const colon = raw.indexOf(':');
  if (colon <= 0) return { type: 'text', value: raw };

  const rawField = raw.slice(0, colon).toLowerCase();
  let value = raw.slice(colon + 1);

  // `meta.foo:bar` addresses arbitrary provider metadata.
  const field = rawField.startsWith('meta.') ? rawField : (FIELD_ALIASES[rawField] ?? rawField);

  if (!field.startsWith('meta.') && !KNOWN_FIELDS.has(field)) {
    throw VfsError.invalid(
      `Unknown query field "${rawField}".`,
      `Known fields: ${[...KNOWN_FIELDS].sort().join(', ')}, meta.*. Aliases: ${Object.keys(FIELD_ALIASES).sort().join(', ')}.`,
    );
  }

  if (value.length === 0) {
    throw VfsError.invalid(
      `Query field "${rawField}" has no value.`,
      `Write ${rawField}:something, or quote it if it contains spaces.`,
    );
  }

  let op: CompareOp = 'contains';
  if (value.startsWith('=')) {
    op = 'equals';
    value = value.slice(1);
  } else if (value.startsWith('>')) {
    op = 'gt';
    value = value.slice(1);
  } else if (value.startsWith('<')) {
    op = 'lt';
    value = value.slice(1);
  }

  return { type: 'term', field, op, value };
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

function contains(haystack: string | undefined, needle: string): boolean {
  if (haystack === undefined) return false;
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function equals(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
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

    case 'text': {
      const haystacks = [node.title, node.name, node.summary, node.author, node.authorId];
      return haystacks.some((h) => contains(h, query.value));
    }

    case 'term':
      return evaluateTerm(query, node, context);

    default:
      return 'unknown';
  }
}

function evaluateTerm(term: TermQuery, node: VNode, context: EvaluateContext): Trilean {
  const { field, op, value } = term;
  const now = context.now ?? new Date();

  if (field.startsWith('meta.')) {
    const key = field.slice('meta.'.length);
    const raw = node.meta?.[key];
    if (raw === undefined) return false;
    const text = String(raw);
    return op === 'equals' ? equals(text, value) : contains(text, value);
  }

  switch (field) {
    case 'author':
      return op === 'equals'
        ? equals(node.author, value) || equals(node.authorId, value)
        : contains(node.author, value) || contains(node.authorId, value);

    case 'subject':
      return op === 'equals' ? equals(node.title, value) : contains(node.title, value);

    case 'name':
      return op === 'equals' ? equals(node.name, value) : contains(node.name, value);

    case 'id':
      return equals(node.id, value);

    case 'path':
      return op === 'equals' ? equals(node.path, value) : contains(node.path, value);

    case 'kind':
      // Matches either the structural kind (dir/file) or the provider's semantic label,
      // so `kind:dir` and `kind:message` both do what the user meant.
      return equals(node.kind, value) || equals(node.subtype, value);

    case 'is': {
      const flags = node.flags ?? [];
      // `is:read` is the negation of the `unread` flag, not a flag of its own; encoding
      // it as a flag would force every provider to emit both halves of every boolean.
      if (value.toLowerCase() === 'read') return !flags.includes('unread');
      return flags.some((flag) => equals(flag, value));
    }

    case 'body': {
      if (context.body === undefined) return 'unknown';
      return contains(context.body, value);
    }

    case 'after': {
      if (node.mtime === undefined) return false;
      return node.mtime.getTime() >= parseDateValue(value, now).getTime();
    }

    case 'before': {
      if (node.mtime === undefined) return false;
      return node.mtime.getTime() < parseDateValue(value, now).getTime();
    }

    case 'on': {
      if (node.mtime === undefined) return false;
      const start = parseDateValue(value, now);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return node.mtime.getTime() >= start.getTime() && node.mtime.getTime() < end.getTime();
    }

    // size:>1M is what everyone types first, because that is what web mail clients use.
    // larger:/smaller: remain the preferred spelling because they are speakable —
    // `size colon greater-than one em` is not a phrase anyone wants to hear read back —
    // but rejecting the familiar form taught nobody anything.
    case 'size': {
      if (node.size === undefined) return 'unknown';
      const bound = parseSizeValue(value);
      if (op === 'gt') return node.size > bound;
      if (op === 'lt') return node.size < bound;
      return node.size === bound;
    }

    case 'larger': {
      if (node.size === undefined) return 'unknown';
      return node.size > parseSizeValue(value);
    }

    case 'smaller': {
      if (node.size === undefined) return 'unknown';
      return node.size < parseSizeValue(value);
    }

    default:
      return 'unknown';
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

/** Render a query back to source form. Round-trips through `parseQuery`. */
export function stringifyQuery(query: Query): string {
  const quote = (value: string): string =>
    /[\s()"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;

  switch (query.type) {
    case 'all': return '*';
    case 'text': return quote(query.value);
    case 'term': {
      const prefix = { contains: '', equals: '=', gt: '>', lt: '<' }[query.op];
      return `${query.field}:${quote(prefix + query.value)}`;
    }
    case 'not': {
      const inner = stringifyQuery(query.clause);
      return query.clause.type === 'and' || query.clause.type === 'or' ? `NOT (${inner})` : `NOT ${inner}`;
    }
    case 'and':
      return query.clauses
        .map((c) => (c.type === 'or' ? `(${stringifyQuery(c)})` : stringifyQuery(c)))
        .join(' ');
    case 'or':
      return query.clauses
        .map((c) => (c.type === 'and' ? `(${stringifyQuery(c)})` : stringifyQuery(c)))
        .join(' OR ');
    default:
      return '*';
  }
}

/** Field names offered by tab-completion, with one-line help. */
export const QUERY_FIELD_HELP: ReadonlyArray<readonly [string, string]> = [
  ['from:', 'sender name or address'],
  ['author:', 'sender name or address'],
  ['subject:', 'item title'],
  ['body:', 'item body (requires fetching content)'],
  ['is:', 'flag: unread, read, unanswered, external, sent, flagged, attachment, mention, draft'],
  ['has:', 'alias of is:'],
  ['kind:', 'dir or file'],
  ['after:', 'newer than a date or duration, e.g. 2026-01-01 or 7d'],
  ['before:', 'older than a date or duration'],
  ['on:', 'on a specific day'],
  ['larger:', 'bigger than a size, e.g. 1M'],
  ['smaller:', 'smaller than a size'],
  ['name:', 'path segment name'],
  ['meta.', 'provider-specific metadata, e.g. meta.importance:high'],
];
