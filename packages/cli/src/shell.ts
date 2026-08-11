/**
 * The interactive shell.
 *
 * This is the *default* interface, and the full-screen TUI is opt-in. That inversion is
 * the central accessibility decision of the whole project, so here is the reasoning.
 *
 * A full-screen TUI is hostile to screen readers for four mechanical reasons, none of
 * which can be fixed by trying harder:
 *
 *   1. It switches to the alternate screen buffer, which destroys scrollback. A screen
 *      reader user's primary tool for reviewing output is gone.
 *   2. It repaints whole frames. The reader sees "the screen changed" and either says
 *      nothing or re-reads everything, fragmenting speech mid-word.
 *   3. Cursor movement drives announcements, so moving a selection bar fires a
 *      per-cell announcement storm.
 *   4. ANSI has no semantics. There is no way to say "this is a list, this item is
 *      selected, there are 40 of them" — the concepts do not exist in the protocol.
 *
 * A line-oriented shell has none of these problems, because it only ever appends text.
 * That is the same channel a screen reader was built for, it keeps scrollback intact, and
 * it works over SSH, in `tmux`, in a serial console and piped into a file.
 *
 * The cost is that it is less pretty for sighted users. That is the correct trade for a
 * tool that reads someone's mail, and the TUI is one flag away for anyone who wants it.
 */

import { createInterface, type Interface } from 'node:readline';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isVfsError, vpath } from '@mscomms/core';
import { Completer } from './completion.js';
import { relativeTime, sanitizeForDisplay } from './format.js';
import type { Session } from './session.js';
import { parseLine, type CommandTable } from './commands/types.js';

export interface ShellOptions {
  readonly session: Session;
  readonly table: CommandTable;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Skip the banner, for tests. */
  readonly quiet?: boolean;
}

export class Shell {
  readonly #session: Session;
  readonly #table: CommandTable;
  readonly #completer: Completer;
  readonly #historyFile: string;
  #rl: Interface | undefined;

  constructor(private readonly options: ShellOptions) {
    this.#session = options.session;
    this.#table = options.table;
    this.#completer = new Completer({
      session: options.session,
      table: options.table,
      write: (text) => options.session.write(text),
    });
    this.#historyFile = join(options.session.paths.stateDir, 'history');
  }

  async run(): Promise<number> {
    const session = this.#session;

    if (this.options.quiet !== true) this.#banner();

    const history = await this.#loadHistory();

    // The prompt is chrome, not data, and readline writes it to whichever stream it is
    // given. When stdout is a pipe, sending it there corrupts the output a script is
    // trying to parse: `ls --json` arrives with `/> ` glued to the front of the array.
    // Every other piece of chrome in this program — the banner, status lines, paging
    // footers — already goes to stderr, so the prompt follows it there. When stdout is a
    // terminal the two are the same device and nothing observable changes, which is why
    // the interactive path is deliberately left exactly as it was.
    const promptStream = process.stdout.isTTY === true ? process.stdout : process.stderr;

    const rl = createInterface({
      input: this.options.input ?? process.stdin,
      output: this.options.output ?? promptStream,
      terminal: process.stdin.isTTY === true,
      historySize: 500,
      history,
      // readline calls this on Tab. It must be synchronous and fast; see completion.ts.
      completer: (line: string): [string[], string] => {
        try {
          return this.#completer.complete(line);
        } catch {
          return [[], line];
        }
      },
      prompt: this.#prompt(),
    });
    this.#rl = rl;

    // readline closes itself when its input stream ends — which happens mid-loop whenever
    // the shell is driven from a pipe or a here-doc, because the input is exhausted long
    // before the queued commands have finished running. Prompting a closed interface
    // throws, so closure is tracked and every later prompt becomes a no-op. Without this
    // the whole batch dies at the first command that awaits anything slow, and the
    // remaining lines are silently lost.
    let closed = false;
    rl.on('close', () => {
      closed = true;
    });
    const promptAgain = (preserveCursor = false): void => {
      if (closed) return;
      rl.setPrompt(this.#prompt());
      rl.prompt(preserveCursor);
    };

    // Ctrl+C cancels the current line rather than exiting. Exiting on Ctrl+C loses the
    // session — and its numbering — for what is usually a typo.
    rl.on('SIGINT', () => {
      session.write('\n');
      promptAgain();
    });

    // A live announcement of anything that arrives while the user is at the prompt. It is
    // written above the prompt line so the line being typed is never disturbed.
    const unsubscribe = session.notifier.onNotification((notification) => {
      session.status(`\n[${relativeTime(new Date(notification.at))}] ${sanitizeForDisplay(notification.title)}: ${sanitizeForDisplay(notification.body)}`);
      promptAgain(true);
    });

    promptAgain();

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed !== '') {
        await this.#execute(trimmed);
        void this.#appendHistory(trimmed);
      }
      if (session.exiting) break;
      promptAgain();
    }

    unsubscribe();
    rl.close();
    return 0;
  }

  /**
   * Run one line.
   *
   * Errors are caught and printed as sentences. An unhandled stack trace at an interactive
   * prompt is noise at best; through speech it is thirty seconds of unreadable file paths.
   */
  async #execute(line: string): Promise<void> {
    const session = this.#session;

    // `!` escapes to a raw path, for the rare case where a path collides with a command.
    const source = line.startsWith('!') ? `cd ${line.slice(1)}` : line;

    const head = source.split(/\s+/)[0] ?? '';
    const command = this.#table.get(head);

    if (command === undefined) {
      // A bare path or number is a `cd` if it is a folder, otherwise a `cat`. This makes
      // the common case — "show me that" — a single token.
      await this.#implicit(source);
      return;
    }

    const { args } = parseLine(source, command);
    try {
      await command.run(session, args);
    } catch (error) {
      this.#reportError(error);
    }
  }

  async #implicit(source: string): Promise<void> {
    const session = this.#session;
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
        const suggestion = this.#suggestCommand(token);
        session.writeError(
          `I do not know the command "${sanitizeForDisplay(token)}".${suggestion === undefined ? '' : ` Did you mean \`${suggestion}\`?`} Type \`help\` for the list.\n`,
        );
        return;
      }
      this.#reportError(error);
    }
  }

  #suggestCommand(input: string): string | undefined {
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

  #reportError(error: unknown): void {
    const session = this.#session;
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

  /**
   * The prompt.
   *
   * Kept short and ending in a stable character. A long prompt is re-read in full by a
   * screen reader on every keystroke in some configurations, so the current folder is
   * abbreviated to its last component rather than shown in full — `pwd` gives the full
   * path on demand.
   */
  #prompt(): string {
    const session = this.#session;
    const configured = session.config.ui.prompt;
    if (configured !== undefined) return configured;
    const where = session.cwd === vpath.ROOT ? '/' : vpath.basename(session.cwd);
    return `${where}> `;
  }

  #banner(): void {
    const session = this.#session;
    const mountCount = session.vfs.mounts.length;
    const lines = [
      'MS-COMMS-TUI — your messages as folders and files.',
      mountCount === 0
        ? 'No sources configured. Type `demo` to try sample data, or `doctor` to see where the config file goes.'
        : `${String(mountCount)} source${mountCount === 1 ? '' : 's'} available. Type \`ls\` to look around.`,
      'Type `help` for commands. Tab completes. After `ls`, act on items by number: `cat 3`.',
      '',
    ];
    session.status(lines.join('\n'));

    for (const broken of session.brokenMounts) {
      session.status(`Warning: ${broken.config.path} could not start — ${broken.error?.message ?? 'unknown error'}`);
    }
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /** Newest first, which is the order readline expects. */
  async #loadHistory(): Promise<string[]> {
    try {
      const text = await readFile(this.#historyFile, 'utf8');
      return text.split('\n').filter((line) => line.trim() !== '').slice(-500).reverse();
    } catch {
      return [];
    }
  }

  async #appendHistory(line: string): Promise<void> {
    try {
      await mkdir(dirname(this.#historyFile), { recursive: true });
      await appendFile(this.#historyFile, `${line}\n`, 'utf8');
    } catch {
      // History is a convenience. Failing to write it must never interrupt the session.
    }
  }

  close(): void {
    this.#rl?.close();
  }
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((current[j - 1] as number) + 1, (previous[j] as number) + 1, (previous[j - 1] as number) + cost));
    }
    previous = current;
  }
  return previous[b.length] as number;
}
