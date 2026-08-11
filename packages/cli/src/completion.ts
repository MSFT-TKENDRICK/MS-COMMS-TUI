/**
 * Tab completion.
 *
 * This is the single most accessibility-sensitive piece of the interface, so the reasoning
 * is worth stating in full.
 *
 * The dominant pattern in modern terminal tools is the fzf-style overlay: a floating pane
 * that appears below the prompt, filters as you type, and is navigated with arrow keys.
 * It is architecturally inaccessible, and not by accident of implementation. It works by
 * repainting a region of the terminal on every keystroke; a screen reader observes the
 * terminal through its own buffer and has no way to know that region is a live list, which
 * item is "selected", or that a repaint even happened. There is no ARIA equivalent in
 * ANSI. Users report the overlay as either total silence or a garbled re-reading of the
 * whole screen. No amount of polish fixes it, because the problem is the architecture.
 *
 * GNU Readline solved this correctly in the 1980s and the solution has not been improved
 * on: when there is one match, insert it; when there are many, extend by the longest
 * common prefix and print the candidates as ordinary scrolling text. Printed text is
 * exactly what a screen reader is built to read, it lands in scrollback, and the review
 * cursor can go back over it. So that is what this does — with one addition.
 *
 * The addition is numbering. Readline prints candidates in columns, which read badly. We
 * print one per line with a number, and that number is immediately usable as an argument.
 * The user hears "3. FY26 budget review", types `cat 3`, and is done. It also resolves the
 * ambiguity that sanitized names inevitably create: two messages can share a subject and a
 * date, but never a number.
 *
 * The remaining constraint is latency. Completion runs on the keystroke, so it must never
 * make a slow network call — it completes from what is already cached, and says so when it
 * has nothing. A Tab that hangs for four seconds is worse than a Tab that does nothing.
 */

import { vpath, QUERY_FIELD_HELP, type VNode } from '@mscomms/core';
import type { Session } from './session.js';
import { displayWidth, padTo, sanitizeForDisplay, truncateWidth } from './format.js';
import { tokenize, type ArgKind, type Command, type CommandTable } from './commands/types.js';

export type CompletionResult = [completions: string[], match: string];

export interface CompleterOptions {
  readonly session: Session;
  readonly table: CommandTable;
  /** How many candidates to print before saying "narrow it down". */
  readonly maxDisplayed?: number;
  readonly write?: (text: string) => void;
}

/** Query fields, offered after `-q ` and on any token containing a colon. */
const QUERY_FIELDS = QUERY_FIELD_HELP.map(([field]) => field.replace(/[<>].*$/, '').trim());
const QUERY_VALUES: Readonly<Record<string, readonly string[]>> = {
  'is:': ['is:unread', 'is:read', 'is:flagged', 'is:draft', 'is:important', 'is:open', 'is:closed'],
  'has:': ['has:attachment', 'has:mention'],
  'kind:': ['kind:message', 'kind:chat', 'kind:thread', 'kind:issue', 'kind:folder', 'kind:article'],
  'after:': ['after:7d', 'after:30d', 'after:today', 'after:2026-01-01'],
  'before:': ['before:7d', 'before:today', 'before:2026-01-01'],
};

export class Completer {
  readonly #session: Session;
  readonly #table: CommandTable;
  readonly #maxDisplayed: number;
  readonly #write: (text: string) => void;
  /**
   * The raw text of the token being completed, set at the top of `complete`.
   *
   * Held as a field rather than threaded through every `#respond` call site because every
   * one of them needs it and none of them can meaningfully choose a different value.
   */
  #raw = '';
  /** The same token as the tokenizer sees it: quotes removed. Candidates are matched against this. */
  #logical = '';

  constructor(options: CompleterOptions) {
    this.#session = options.session;
    this.#table = options.table;
    this.#maxDisplayed = options.maxDisplayed ?? 40;
    this.#write = options.write ?? ((text) => process.stdout.write(text));
  }

  /**
   * readline's completer contract. Returns `[matches, prefix]`.
   *
   * When there are several matches we print our own numbered list and return `[[], line]`,
   * which stops readline printing its own column layout. Two lists would be confusing in
   * any mode and unusable through speech.
   *
   * The returned prefix is the *raw* token text — see `rawCurrentToken`. It is deliberately
   * not the tokenizer's view of it.
   */
  complete(line: string): CompletionResult {
    const tokens = tokenize(line);
    // Whether a token is under the cursor is decided by the raw text, not by a trailing
    // space: in `cat "FY26 budget ` the trailing space is *inside* an open quote and is
    // part of the token being typed. Testing `/\s$/` here would silently start a new
    // argument mid-word.
    const raw = rawCurrentToken(line);
    const inToken = raw !== '';
    const currentIndex = inToken ? Math.max(0, tokens.length - 1) : tokens.length;
    const current = inToken ? (tokens[tokens.length - 1] ?? '') : '';
    this.#raw = raw;
    this.#logical = current;

    // First word: a command name.
    if (currentIndex === 0) {
      return this.#respond(this.#commandCandidates(current), 'command');
    }

    const command = this.#table.get(tokens[0] as string);
    if (command === undefined) return [[], line];

    // A flag.
    if (current.startsWith('-')) {
      return this.#respond(this.#flagCandidates(command, current), 'flag');
    }

    const kind = this.#argKindFor(command, tokens, currentIndex, current);
    switch (kind) {
      case 'query':
        return this.#respond(this.#queryCandidates(current), 'query field');
      case 'command':
        return this.#respond(this.#commandCandidates(current), 'command');
      case 'action':
        return this.#respond(this.#actionCandidates(current), 'action');
      case 'watch':
        return this.#respond(
          this.#session.watcher.statuses.map((status) => status.id).filter((id) => id.startsWith(current)),
          'watch',
        );
      case 'setting':
        return this.#respond(
          ['mode', 'color', 'width', 'pagesize', 'dates', 'bell'].filter((name) => name.startsWith(current)),
          'setting',
        );
      case 'mount':
        return this.#respond(
          this.#session.vfs.mounts.map((mount) => mount.path).filter((path) => path.startsWith(current)),
          'source',
        );
      case 'path':
      case 'node':
        return this.#completePath(current, kind);
      default:
        return [[], line];
    }
  }

  /**
   * Which argument slot is being typed.
   *
   * Flags with values consume the following token, so `find -q <TAB>` completes a query
   * field rather than a path. Getting this wrong is the difference between Tab being
   * useful and Tab being noise.
   */
  #argKindFor(command: Command, tokens: readonly string[], currentIndex: number, current: string): ArgKind {
    const valueFlags = new Set<string>();
    for (const flag of command.flags ?? []) {
      if (flag.value === true) {
        valueFlags.add(`--${flag.name}`);
        valueFlags.add(`-${flag.name}`);
        for (const alias of flag.aliases ?? []) {
          valueFlags.add(`--${alias}`);
          valueFlags.add(`-${alias}`);
        }
      }
    }

    const previous = tokens[currentIndex - 1];
    if (previous !== undefined && valueFlags.has(previous)) {
      return previous.replace(/^-+/, '') === 'q' || previous.endsWith('query') ? 'query' : 'none';
    }

    // A colon in the token means the user is writing a query fragment wherever they are.
    if (current.includes(':')) return 'query';

    let positionalIndex = 0;
    for (let i = 1; i < currentIndex; i += 1) {
      const token = tokens[i] as string;
      if (token.startsWith('-')) {
        if (valueFlags.has(token)) i += 1;
        continue;
      }
      positionalIndex += 1;
    }

    const kinds = command.args ?? [];
    if (kinds.length === 0) return 'none';
    return (kinds[Math.min(positionalIndex, kinds.length - 1)] ?? 'none') as ArgKind;
  }

  #commandCandidates(prefix: string): Candidate[] {
    return this.#table.all
      .filter((command) => command.name.startsWith(prefix))
      .map((command) => ({ value: command.name, description: command.summary }));
  }

  #flagCandidates(command: Command, prefix: string): Candidate[] {
    const bare = prefix.replace(/^-+/, '');
    const out: Candidate[] = [];
    for (const flag of command.flags ?? []) {
      for (const name of [flag.name, ...(flag.aliases ?? [])]) {
        if (!name.startsWith(bare)) continue;
        out.push({ value: name.length === 1 ? `-${name}` : `--${name}`, description: flag.description });
      }
    }
    return out;
  }

  #queryCandidates(prefix: string): string[] {
    const colon = prefix.lastIndexOf(':');
    if (colon !== -1) {
      const field = `${prefix.slice(0, colon + 1)}`;
      const values = QUERY_VALUES[field];
      if (values !== undefined) return values.filter((value) => value.startsWith(prefix));
      return [];
    }
    const fields = QUERY_FIELDS.filter((field) => field.startsWith(prefix));
    const operators = ['AND', 'OR', 'NOT'].filter((operator) => operator.startsWith(prefix.toUpperCase()));
    return [...fields, ...operators];
  }

  #actionCandidates(prefix: string): string[] {
    // Actions are per-node and fetching them needs a round trip, so this offers the verbs
    // that are common across the built-in providers. `actions` prints the authoritative
    // list, and the error message from `do` names them all.
    return ['read', 'unread', 'flag', 'unflag', 'close', 'reopen', 'comment', 'url', 'archive'].filter((name) =>
      name.startsWith(prefix),
    );
  }

  /**
   * Complete a path.
   *
   * Only cached listings are consulted. Tab must not block on the network: a user pressing
   * Tab expects an answer in milliseconds, and a four-second stall while a mailbox page
   * loads reads, through speech, as the program having crashed.
   */
  #completePath(current: string, kind: ArgKind): CompletionResult {
    const candidates: Candidate[] = [];
    const listing = this.#session.lastListing;

    // Numbers from the last listing.
    //
    // Only offered once the user has actually started typing one (or the `#` prefix),
    // never on an empty Tab. On an empty Tab the names are the useful answer — the numbers
    // are already on screen from `ls` — and offering both doubles the length of every
    // completion list for no new information. Through speech, that doubling is the
    // difference between a list you can hold in your head and one you cannot.
    if (listing !== undefined && /^#\d*$|^\d+$/.test(current)) {
      const bare = current.replace(/^#/, '');
      listing.nodes.forEach((node, offset) => {
        const label = String(listing.startIndex + offset);
        if (!label.startsWith(bare)) return;
        candidates.push({
          value: current.startsWith('#') ? `#${label}` : label,
          description: node.title,
        });
      });
    }

    const slash = current.lastIndexOf('/');
    const dirPart = slash === -1 ? '' : current.slice(0, slash + 1);
    const namePart = slash === -1 ? current : current.slice(slash + 1);
    const base = dirPart === '' ? this.#session.cwd : vpath.resolve(this.#session.cwd, dirPart);

    for (const node of this.#cachedChildren(base)) {
      if (kind === 'path' && node.kind !== 'dir') continue;
      if (!startsWithFold(node.name, namePart)) continue;
      const suffix = node.kind === 'dir' ? '/' : '';
      candidates.push({ value: `${dirPart}${node.name}${suffix}` });
    }

    // Mount points, so `cd /ma<TAB>` works from anywhere.
    if (current.startsWith('/')) {
      for (const mount of this.#session.vfs.mounts) {
        if (mount.path.startsWith(current)) {
          candidates.push({ value: `${mount.path}/`, description: mount.description ?? mount.provider.displayName });
        }
      }
    }

    for (const special of ['..', '~', '-']) {
      if (special.startsWith(current) && current !== '') candidates.push({ value: special });
    }

    return this.#respond(candidates, kind === 'path' ? 'folder' : 'item', true);
  }

  /**
   * Children of a path from cache only.
   *
   * The last listing is checked first because it is both the freshest and the one whose
   * numbering is live. Falling back to the VFS cache lets `cd Inbox/<TAB>` work for
   * directories visited earlier in the session.
   */
  #cachedChildren(path: string): readonly VNode[] {
    const listing = this.#session.lastListing;
    if (listing !== undefined && vpath.normalize(listing.path) === vpath.normalize(path)) {
      return listing.nodes;
    }
    return this.#session.vfs.cachedChildren(path) ?? [];
  }

  /**
   * Build the readline response.
   *
   * Two different strings are in play and conflating them causes real corruption:
   *
   * - `#raw` is what is **on the line**. readline substitutes a completion by deleting
   *   exactly `match.length` characters ending at the cursor, so the returned match must be
   *   this. Return the tokenizer's view instead and the user's own opening quote survives
   *   the deletion: `cat "FY26 bud` completes to `cat ""FY26 budget review.txt"`.
   * - `#logical` is what the tokenizer will **parse the line back into**. Candidates are
   *   matched and prefix-extended against this, because that is the text the user is
   *   actually spelling.
   *
   * Quoting therefore happens here, at emission, and never in candidate construction.
   * Quoting earlier breaks two things at once: the longest common prefix of a set of
   * already-quoted names begins with `"`, so the first Tab inserts a lone quote and prints
   * no list at all; and a per-segment quote such as `Inbox/"Archive 2026"/` re-parses as
   * two arguments once the user presses Enter.
   */
  #respond(candidates: readonly (string | Candidate)[], label: string, quote = false): CompletionResult {
    const raw = this.#raw;
    const seen = new Set<string>();
    const unique: Candidate[] = [];
    for (const candidate of candidates) {
      const item = typeof candidate === 'string' ? { value: candidate } : candidate;
      if (seen.has(item.value)) continue;
      seen.add(item.value);
      unique.push(item);
    }

    if (unique.length === 0) {
      return [[], raw];
    }
    if (unique.length === 1) {
      const value = (unique[0] as Candidate).value;
      return [[quote ? quoteToken(value, true) : value], raw];
    }

    const common = longestCommonPrefix(unique.map((item) => item.value));
    if (common.length > this.#logical.length) {
      // Progress can be made silently; readline substitutes the shared prefix and the user
      // presses Tab again to see the remaining choices. The partial keeps its opening quote
      // but not a closing one, so the next Tab sees a token that is still open.
      return [[quote ? quoteToken(common, false) : common], raw];
    }

    this.#printCandidates(unique, label);
    return [[], raw];
  }

  /**
   * Print the choices as ordinary scrolling text.
   *
   * Deliberately not an fzf-style overlay. An overlay repaints a region of the screen that
   * a screen reader has no way to observe — there is no event, no role, nothing to
   * announce — so the candidates simply do not exist for that user. Printing them as text
   * is what readline has always done, it lands in scrollback, and it can be reviewed at
   * leisure.
   *
   * Each entry is numbered so it can be referred to out loud, and annotated where the
   * value alone would be opaque: "3" means nothing, "3. FY26 budget review" means
   * everything.
   */
  #printCandidates(candidates: readonly Candidate[], label: string): void {
    const shown = candidates.slice(0, this.#maxDisplayed);
    if (shown.length === 0) return;
    const width = Math.max(...shown.map((item) => displayWidth(item.value)));
    const lines = [
      '',
      `${String(candidates.length)} ${label}${candidates.length === 1 ? '' : 's'}:`,
      ...shown.map((item, index) => {
        const value = sanitizeForDisplay(item.value);
        if (item.description === undefined || item.description === '') {
          return `${String(index + 1).padStart(2)}. ${value}`;
        }
        return `${String(index + 1).padStart(2)}. ${padTo(value, width)}  ${truncateWidth(sanitizeForDisplay(item.description), 60)}`;
      }),
    ];
    if (candidates.length > shown.length) {
      lines.push(`… and ${String(candidates.length - shown.length)} more. Type more characters to narrow the list.`);
    }
    lines.push('');
    this.#write(lines.join('\n'));
  }
}

/** A completion, plus optional human context for the printed list. */
interface Candidate {
  readonly value: string;
  readonly description?: string;
}

/**
 * The literal text of the token being completed, opening quote included.
 *
 * `tokenize` returns the *logical* token: it strips quotes, because that is what a command
 * wants. Completion needs the opposite. readline substitutes a completion by removing
 * exactly `match.length` characters ending at the cursor, so `match` has to describe the
 * characters actually on screen. Hand it the logical token and the user's own opening
 * quote survives the substitution, so `cat "FY26 bud` + Tab becomes
 * `cat ""FY26 budget review.eml"` — an unusable line, and one a screen reader user has no
 * easy way to see has gone wrong.
 *
 * This walks the line exactly as `tokenize` does, but records where the current token
 * started rather than what it contained.
 */
export function rawCurrentToken(line: string): string {
  let start = line.length;
  let quote: '"' | "'" | undefined;
  let started = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (/\s/.test(char)) {
      started = false;
      start = i + 1;
      continue;
    }
    if (!started) {
      start = i;
      started = true;
    }
    if (char === '"' || char === "'") quote = char;
  }

  return started ? line.slice(start) : '';
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] as string;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  return prefix;
}

/**
 * Case-insensitive prefix matching. Mail folders are `Inbox`, not `inbox`, and forcing
 * someone to remember which is which — or to reach for Shift mid-completion — is friction
 * for no benefit.
 */
function startsWithFold(value: string, prefix: string): boolean {
  if (prefix === '') return true;
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * Wrap a completed token in quotes when it needs them.
 *
 * The whole token is wrapped, never a segment of it. `Inbox/"Archive 2026"/` happens to
 * survive this codebase's tokenizer, but it re-parses as two arguments under any
 * conventional one, and it reads as noise through speech.
 *
 * `closed` is false for a partial completion — the longest common prefix of several
 * candidates — so that the token stays open and the next Tab still sees the user mid-word.
 */
function quoteToken(value: string, closed: boolean): string {
  if (!/[\s"']/.test(value)) return value;
  const inner = value.replace(/"/g, '');
  return closed ? `"${inner}"` : `"${inner}`;
}
