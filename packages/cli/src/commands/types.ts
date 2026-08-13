/**
 * The command table.
 *
 * Commands are data, not a switch statement, for one reason that matters: everything
 * discoverable has to be discoverable *the same way*. `help` reads this table, Tab
 * completion reads this table, `help <cmd>` reads this table, and the TUI's command
 * palette reads this table. A command that forgets to register its arguments is a command
 * that silently cannot be completed, and that is exactly the sort of hole that makes a
 * keyboard-only interface unusable.
 */

import type { Session } from '../session.js';
import { sanitizeForDisplay, type OutputMode } from '../format.js';

export interface CommandArgs {
  /** Positional arguments, in order, with flags removed. */
  readonly positional: readonly string[];
  /** Flags, `--name value` or `--name`. Bare flags are `true`. */
  readonly flags: Readonly<Record<string, string | boolean>>;
  /** The raw line, for commands that want it verbatim. */
  readonly raw: string;
}

export type ArgKind =
  | 'path'
  | 'node'
  | 'query'
  | 'command'
  | 'action'
  | 'mount'
  | 'watch'
  | 'setting'
  | 'none';

export interface CommandFlag {
  readonly name: string;
  readonly description: string;
  /** True when the flag takes a value; false for a bare switch. */
  readonly value?: boolean;
  readonly aliases?: readonly string[];
}

export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** One line. Shown by `help`, and read aloud verbatim, so it must be a sentence. */
  readonly summary: string;
  /** Multi-paragraph detail shown by `help <name>`. */
  readonly detail?: string;
  readonly usage: string;
  /** What each positional argument completes as. The last entry repeats. */
  readonly args?: readonly ArgKind[];
  /**
   * How many positional arguments the command can actually use.
   *
   * Opt-in, because plenty of commands are legitimately variadic (`cat 1 2 3`) and a
   * blanket rule would break them. Declare it on any command that reads a fixed number
   * of positionals and would otherwise discard the rest in silence.
   *
   * Silently dropping an argument is the most dangerous failure this program can have.
   * `find /blog deploy` used to ignore `deploy`, search for nothing in particular, and
   * print "(empty)" — which the user reads as "there are no matching messages". A wrong
   * answer indistinguishable from a right one is far worse than an error, and worse
   * again for someone who cannot glance back at what they typed.
   */
  readonly maxPositional?: number;
  /**
   * Turn a line that had too many positionals into the line the user probably meant.
   * Returned verbatim in the error, so it must be a runnable command.
   */
  correction?(positional: readonly string[]): string | undefined;
  readonly flags?: readonly CommandFlag[];
  /**
   * Treat an undeclared `--name value` as a flag with a value rather than a bare switch
   * followed by a positional.
   *
   * Set only by `do`, and only because the flags it accepts are not knowable when the line
   * is parsed: they are an action's parameters, declared by whichever provider owns the
   * item. Without this, `do approve 2 --body "looks right"` parses the comment as a third
   * positional and the approval goes out blank.
   */
  readonly openFlags?: boolean;
  readonly examples?: readonly string[];
  readonly group: 'navigate' | 'read' | 'search' | 'watch' | 'system';
  run(session: Session, args: CommandArgs): Promise<void>;
}

export class CommandTable {
  readonly #byName = new Map<string, Command>();
  readonly #canonical: Command[] = [];

  register(command: Command): void {
    this.#canonical.push(command);
    this.#byName.set(command.name, command);
    for (const alias of command.aliases ?? []) this.#byName.set(alias, command);
  }

  registerAll(commands: readonly Command[]): void {
    for (const command of commands) this.register(command);
  }

  get(name: string): Command | undefined {
    return this.#byName.get(name);
  }

  get all(): readonly Command[] {
    return [...this.#canonical].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every typeable word, including aliases. Used by completion. */
  get names(): readonly string[] {
    return [...this.#byName.keys()].sort();
  }

  byGroup(group: Command['group']): readonly Command[] {
    return this.all.filter((command) => command.group === group);
  }
}

/**
 * The correction to offer a command whose argument was typed unquoted.
 *
 * Extra positionals almost always mean one thing here: the user typed a name containing
 * spaces without quoting it. This program is *about* messages, and message subjects are
 * mostly spaces — `cat FY26 budget review.txt` is the natural thing to type and the
 * commonest mistake anyone will make with it.
 *
 * Answering that with "no such file: FY26" is technically true and useless. Answering it
 * with the exact quoted line that would have worked turns a dead end into the moment the
 * user learns the quoting rule, without having to go and read anything.
 *
 * `before` is how many leading positionals are *not* part of the spaced name, so `do`
 * (`do <action> <node>`) passes 1 and gets `do read "FY26 budget"` rather than the
 * nonsense `do "read FY26 budget"`. `trailingNumber` says a bare integer at the end is a
 * real argument rather than part of the name, which is what `save <node> [attachment]`
 * needs — but only when it really is an integer, so `save FY26 budget report.pdf` still
 * quotes the whole thing.
 *
 * It declines whenever the evidence contradicts the theory. `cd /blog /archive` is two
 * separate paths, not one name with a space in it, and suggesting `cd "/blog /archive"`
 * would send the user to a second failure wearing the costume of an answer. Likewise
 * `save 1 2 3` is someone using item numbers, not a subject that lost its quotes. A wrong
 * suggestion is worse than none, so those fall through to the usage line instead.
 */
export function quoteCorrection(
  name: string,
  options: { readonly before?: number; readonly trailingNumber?: boolean } = {},
): (positional: readonly string[]) => string | undefined {
  const before = options.before ?? 0;
  return (positional) => {
    const head = positional.slice(0, before);
    let rest = positional.slice(before);

    const tail: string[] = [];
    const last = rest[rest.length - 1];
    if (options.trailingNumber === true && rest.length > 1 && last !== undefined && /^\d+$/.test(last)) {
      tail.push(last);
      rest = rest.slice(0, -1);
    }

    if (rest.length < 2) return undefined;

    // A run of bare numbers is never a name that lost its quotes — `save 1 2 3` is
    // someone using item numbers, and suggesting `save "1 2" 3` is gibberish. Same for
    // arguments that begin with `/` or `-`: those are separate paths and flags, not words
    // in a subject. In all of these the honest answer is the usage line.
    const allNumbers = rest.every((v) => /^\d+$/.test(v));
    const separateThings = rest.slice(1).some((v) => v.startsWith('/') || v.startsWith('-'));
    if (allNumbers || separateThings) return undefined;

    return [name, ...head, `"${rest.join(' ')}"`, ...tail].join(' ');
  };
}

/**
 * The message to print when a line carries more positionals than the command can use, or
 * undefined when the line is fine.
 *
 * This lives here rather than in the dispatcher because a command line reaches `run` by
 * two independent routes — the shell's dispatcher and the one-shot `mscomms cd /a /b`
 * path — and a guard installed on only one of them is worse than no guard at all: it
 * teaches the user a rule that then fails to hold. The check belongs to the command, so
 * it is defined next to the field it enforces and both routes call it.
 *
 * It names the correction rather than only the rule. "cat takes at most 1 argument" is
 * true and unhelpful; `cat "FY26 budget review.txt"` can be acted on without going to
 * read the help, which matters most for the user who has to listen to it.
 */
export function surplusMessage(
  command: Command,
  positional: readonly string[],
): string | undefined {
  const max = command.maxPositional;
  if (max === undefined || positional.length <= max) return undefined;

  const extra = positional.slice(max).map((value) => sanitizeForDisplay(value));
  const listed = extra.map((value) => `"${value}"`).join(', ');
  const noun = extra.length === 1 ? 'argument' : 'arguments';

  const base = `\`${command.name}\` does not take the extra ${noun} ${listed}.`;
  const fix = command.correction?.(positional);
  if (fix !== undefined) return `${base} Did you mean: ${fix}`;
  return `${base}\nUsage: ${command.usage}`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Split a command line into words.
 *
 * Quoting is supported because subjects contain spaces and a user must be able to type
 * `cat "FY26 budget review.eml"`. Backslash is *not* an escape character: a Windows user
 * pasting a path, or anyone typing a subject containing a backslash, would otherwise get
 * silently mangled input. Quotes are the escape mechanism, and they are enough.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== '') tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current !== '') tokens.push(current);
  return tokens;
}

export interface ParsedLine {
  readonly command: string;
  readonly args: CommandArgs;
}

export function parseLine(line: string, known?: Command): ParsedLine {
  const tokens = tokenize(line);
  const command = tokens[0] ?? '';
  const rest = tokens.slice(1);

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set<string>();
  const switches = new Set<string>();
  for (const flag of known?.flags ?? []) {
    const target = flag.value === true ? valueFlags : switches;
    target.add(flag.name);
    for (const alias of flag.aliases ?? []) target.add(alias);
  }

  /**
   * Should `--name` swallow the token after it?
   *
   * Declared value-flags always do. Under {@link Command.openFlags} an undeclared name does
   * too, provided the next token is not itself a flag — `do close 2 --yes` must keep `yes`
   * a switch, and a trailing `--draft` with nothing after it is a switch by necessity.
   */
  const takesValue = (name: string, next: string | undefined): boolean => {
    if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next))) return false;
    if (valueFlags.has(name)) return true;
    return known?.openFlags === true && !switches.has(name);
  };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      if (takesValue(name, rest[i + 1])) {
        flags[name] = rest[i + 1] as string;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    // `-1` is a page size, not a flag; a leading digit disambiguates.
    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const name = token.slice(1);
      if (takesValue(name, rest[i + 1])) {
        flags[name] = rest[i + 1] as string;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positional.push(token);
  }

  return { command, args: { positional, flags, raw: line } };
}

// ---------------------------------------------------------------------------
// Shared flag helpers
// ---------------------------------------------------------------------------

/** Accepted by every command that prints. */
export const OUTPUT_FLAGS: readonly CommandFlag[] = [
  { name: 'json', description: 'Print machine-readable JSON.' },
  { name: 'tsv', description: 'Print tab-separated values, one record per line.' },
  { name: 'announce', description: 'Print one spoken sentence per item.' },
  { name: 'plain', description: 'Print without alignment or colour.' },
];

export function modeFrom(args: CommandArgs): OutputMode | undefined {
  if (args.flags['json'] === true) return 'json';
  if (args.flags['tsv'] === true) return 'tsv';
  if (args.flags['announce'] === true) return 'announce';
  if (args.flags['plain'] === true) return 'plain';
  return undefined;
}

export function flagString(args: CommandArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function flagNumber(args: CommandArgs, ...names: string[]): number | undefined {
  const raw = flagString(args, ...names);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number.`);
  return value;
}

export function flagBool(args: CommandArgs, ...names: string[]): boolean {
  return names.some((name) => args.flags[name] === true);
}
