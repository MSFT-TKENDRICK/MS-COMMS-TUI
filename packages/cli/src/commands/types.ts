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
import type { OutputMode } from '../format.js';

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
  readonly flags?: readonly CommandFlag[];
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
  for (const flag of known?.flags ?? []) {
    if (flag.value === true) {
      valueFlags.add(flag.name);
      for (const alias of flag.aliases ?? []) valueFlags.add(alias);
    }
  }

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      if (valueFlags.has(name) && i + 1 < rest.length) {
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
      if (valueFlags.has(name) && i + 1 < rest.length) {
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
