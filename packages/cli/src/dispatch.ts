/**
 * The one place a typed line becomes a command call.
 *
 * Both interfaces route through here: the line shell's REPL and the full-screen view's `:`
 * prompt. That is not tidiness for its own sake — the TUI's help screen tells the user that
 * `:` reaches the same commands as the shell, and if this logic were duplicated that claim
 * would quietly stop being true the first time one copy grew a feature.
 *
 * Three behaviours live here, in this order:
 *
 *   1. `!path` — an escape hatch for the rare path that collides with a command name.
 *   2. A known command — parsed with that command's own flag table.
 *   3. Anything else — treated as a path or a listing number, and turned into `cd` for a
 *      folder or `cat` for a file. "Show me that" should be one token.
 */

import { isVfsError } from '@mscomms/core';
import { sanitizeForDisplay } from './format.js';
import type { Session } from './session.js';
import { parseLine, surplusMessage, type CommandTable } from './commands/types.js';

export class Dispatcher {
  readonly #table: CommandTable;

  constructor(table: CommandTable) {
    this.#table = table;
  }

  /**
   * Run a line. Errors are reported to the session rather than thrown, because both callers
   * want to keep going: the REPL prints the next prompt, the pane draws the next frame.
   *
   * The first thing it does is wait for the session to be ready, which is what makes a
   * background startup safe. Both interfaces now accept input while the sources are still
   * connecting — that is the point of it — and a command that ran anyway would see an empty
   * tree and answer "no such folder" about a mailbox that exists. Waiting here means the
   * worst case is the wait the user used to have before the prompt appeared, except that
   * now it only happens if they typed something that needs it, and the shell's progress
   * indicator is already saying so.
   */
  async execute(session: Session, line: string): Promise<void> {
    await session.ready();

    const source = line.startsWith('!') ? `cd ${line.slice(1)}` : line;

    const head = source.split(/\s+/)[0] ?? '';
    const command = this.#table.get(head);

    if (command === undefined) {
      await this.#implicit(session, source);
      return;
    }

    const { args } = parseLine(source, command);

    // Refuse to run rather than quietly use part of what was typed. See `maxPositional`.
    const surplus = surplusMessage(command, args.positional);
    if (surplus !== undefined) {
      session.writeError(`${surplus}\n`);
      return;
    }

    try {
      await command.run(session, args);
    } catch (error) {
      this.reportError(session, error);
    }
  }

  async #implicit(session: Session, source: string): Promise<void> {
    const token = source.trim();
    try {
      const path = session.resolveToken(token);
      const node = await session.vfs.stat(path);
      const command = this.#table.get(node.kind === 'dir' ? 'cd' : 'cat');
      await command?.run(session, { positional: [token], flags: {}, raw: source });
    } catch (error) {
      // Distinguish "you typed a bad command" from "that path does not exist" — they need
      // completely different advice.
      if (isVfsError(error) && error.code === 'ENOENT' && !token.includes('/')) {
        const suggestion = this.suggestCommand(token);
        session.writeError(
          `I do not know the command "${sanitizeForDisplay(token)}".${suggestion === undefined ? '' : ` Did you mean \`${suggestion}\`?`} Type \`help\` for the list.\n`,
        );
        return;
      }
      this.reportError(session, error);
    }
  }

  suggestCommand(input: string): string | undefined {
    let best: string | undefined;
    let bestScore = Infinity;
    for (const name of this.#table.names) {
      const score = editDistance(input.toLowerCase(), name);
      if (score < bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
  }

  reportError(session: Session, error: unknown): void {
    if (isVfsError(error)) {
      session.writeError(`${error.message}\n`);
      if (error.hint !== undefined) session.writeError(`${error.hint}\n`);
      if (error.retryAfter !== undefined) {
        session.writeError(`Try again in about ${String(error.retryAfter)} seconds.\n`);
      }
      return;
    }
    session.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Levenshtein distance, used only to suggest a command after a typo. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min(
          (current[j - 1] as number) + 1,
          (previous[j] as number) + 1,
          (previous[j - 1] as number) + cost,
        ),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}
