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
import { vpath } from '@mscomms/core';
import { Completer } from './completion.js';
import { Dispatcher } from './dispatch.js';
import { relativeTime, sanitizeForDisplay } from './format.js';
import { Progress, progressLabel } from './progress.js';
import { externalTasks, isSettled, ownTasks, readySummary } from './startup.js';
import type { Session } from './session.js';
import type { CommandTable } from './commands/types.js';

export interface ShellOptions {
  readonly session: Session;
  readonly table: CommandTable;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /**
   * Where chrome goes: the prompt and the progress line. Defaults to stderr, and the
   * progress line writes here *directly* rather than through the session — see the
   * constructor for why that matters.
   */
  readonly errorOutput?: NodeJS.WritableStream;
  /** Skip the banner, for tests. */
  readonly quiet?: boolean;
}

export class Shell {
  readonly #session: Session;
  readonly #table: CommandTable;
  readonly #completer: Completer;
  readonly #dispatcher: Dispatcher;
  readonly #historyFile: string;
  #rl: Interface | undefined;
  /** Redraws the prompt in place; set while the REPL is running. */
  #promptAgain: ((preserveCursor?: boolean) => void) | undefined;
  /** Undefined when output is piped or announced — see the constructor. */
  readonly #progress: Progress | undefined;

  constructor(private readonly options: ShellOptions) {
    this.#session = options.session;
    this.#table = options.table;
    this.#dispatcher = new Dispatcher(options.table);
    this.#completer = new Completer({
      session: options.session,
      table: options.table,
      write: (text) => options.session.write(text),
    });
    this.#historyFile = join(options.session.paths.stateDir, 'history');

    // Only for an interactive terminal, and never in announce mode. Both exclusions are
    // about not writing chrome where it does damage: a pipe would have the spinner's escape
    // codes in its data, and a screen reader would hear every frame of it.
    const inputStream = (options.input ?? process.stdin) as { isTTY?: boolean };
    const interactive =
      process.stderr.isTTY === true && inputStream.isTTY === true && options.session.format.mode !== 'announce';
    // The spinner writes straight to the stream rather than through `session.writeError`,
    // and that indirection is load-bearing. `beforeFirstWrite` latches on the first byte
    // through the session's sinks so the progress line can be erased just ahead of the
    // command's output — but the spinner is chrome, not output. Routed through the session
    // it would trip its own latch on its first frame, the erase would be spent on nothing,
    // and the command's real output would land on top of the spinner: "⠋ ls…Inbox",
    // stranded in the scrollback forever. Which is the exact thing this mechanism exists
    // to prevent.
    this.#progress = interactive
      ? new Progress({ write: (text) => (options.errorOutput ?? process.stderr).write(text), enabled: true })
      : undefined;
  }

  async run(): Promise<number> {
    const session = this.#session;

    if (this.options.quiet !== true) this.#banner();

    // Watching startup, not waiting for it. The prompt below is drawn while sources are
    // still connecting, so the one thing owed to the user is a line — exactly one — saying
    // when that finished and what it found. See {@link #watchStartup}.
    const stopWatching = this.options.quiet === true ? () => undefined : this.#watchStartup(() => {
      this.#promptAgain?.(true);
    });

    const history = await this.#loadHistory();

    // The prompt is chrome, not data, and readline writes it to whichever stream it is
    // given. When stdout is a pipe, sending it there corrupts the output a script is
    // trying to parse: `ls --json` arrives with `/> ` glued to the front of the array.
    // Every other piece of chrome in this program — the banner, status lines, paging
    // footers — already goes to stderr, so the prompt follows it there. When stdout is a
    // terminal the two are the same device and nothing observable changes, which is why
    // the interactive path is deliberately left exactly as it was.
    const promptStream = process.stdout.isTTY === true ? process.stdout : process.stderr;

    // Terminal-ness must be read off the stream readline is actually given, not off
    // `process.stdin` regardless. They are the same thing in production, but when an
    // input is injected the two can disagree — and `terminal` is what decides whether
    // Tab reaches the completer at all. Deriving it from the wrong stream meant the
    // completion path could not be exercised end to end, which is exactly the kind of
    // gap that lets a headline feature ship untested.
    const input = this.options.input ?? process.stdin;
    const isTty = (input as { isTTY?: boolean }).isTTY === true;

    const rl = createInterface({
      input,
      output: this.options.output ?? promptStream,
      terminal: isTty,
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
    this.#promptAgain = promptAgain;

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
    stopWatching();
    this.#promptAgain = undefined;
    rl.close();
    return 0;
  }

  /**
   * Run one line.
   *
   * Errors are caught and printed as sentences. An unhandled stack trace at an interactive
   * prompt is noise at best; through speech it is thirty seconds of unreadable file paths.
   *
   * The progress indicator is wrapped around the whole thing rather than started by
   * individual slow commands: which commands are slow depends on what is mounted and what
   * is cached, so it is not something a command can know about itself.
   */
  async #execute(line: string): Promise<void> {
    const progress = this.#progress;
    if (progress === undefined) {
      await this.#dispatcher.execute(this.#session, line);
      return;
    }

    progress.start(progressLabel(line));
    try {
      await this.#session.beforeFirstWrite(
        () => {
          progress.clear();
        },
        async () => {
          await this.#dispatcher.execute(this.#session, line);
        },
      );
    } finally {
      progress.stop();
    }
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
    const lines = [
      'MS-COMMS-TUI — your messages as folders and files.',
      'Type `help` for commands. Tab completes. After `ls`, act on items by number: `cat 3`.',
      '',
    ];
    session.status(lines.join('\n'));
  }

  /**
   * Say one thing when startup finishes, and nothing while it runs.
   *
   * The temptation is a spinner. It would be wrong here for the same reason the pane is
   * opt-in: this shell is the interface a screen reader gets, and a status line rewritten
   * eight times a second is eight announcements of nothing. The line-oriented equivalent of
   * a progress indicator is silence followed by a result.
   *
   * So the banner no longer claims a source count — it could not know one, now that sources
   * connect in the background — and this prints it when it becomes true, above the prompt,
   * without disturbing whatever is being typed. A user who types `ls` before it appears
   * waits inside the command instead, where the progress indicator explains the delay.
   *
   * The prompt is redrawn afterwards because it may have changed: a session with exactly
   * one source lands the user inside it, and that only becomes true when the mounts do.
   *
   * Checks belonging to the launcher get their own line, later, and only when they have
   * something to say. They are not part of readiness — waiting for a rebuild before
   * admitting the mail is there would reintroduce the original complaint one level up — and
   * a no-op rebuild is not news, so the silent case stays silent.
   */
  #watchStartup(promptAgain: () => void): () => void {
    const session = this.#session;
    let announced = false;
    const told = new Set<string>();

    const report = (): void => {
      const snapshot = session.tasks.snapshot();

      if (!announced && session.tasks.finished) {
        announced = true;
        const summary = readySummary(ownTasks(snapshot));
        const mounts = session.vfs.mounts.length;
        session.status(
          mounts === 0
            ? `\n${summary} Type \`demo\` to try sample data, or \`doctor\` to see where the config file goes.`
            : `\n${summary} Type \`ls\` to look around.`,
        );
        for (const broken of session.brokenMounts) {
          session.status(`Warning: ${broken.config.path} could not start — ${broken.error?.message ?? 'unknown error'}`);
        }
        promptAgain();
      }

      for (const task of externalTasks(snapshot)) {
        if (!isSettled(task) || told.has(task.id)) continue;
        told.add(task.id);
        if (task.state === 'ok' || task.state === 'skipped') continue;
        session.status(`${task.label}: ${task.detail ?? task.state}`);
        promptAgain();
      }
    };

    const unsubscribe = session.tasks.subscribe(report);
    report();
    return unsubscribe;
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
