/**
 * The opt-in full-screen view.
 *
 * Everything hard lives in `state.ts` (pure reducer) and `render.ts` (pure renderer). This
 * file is the part that cannot be tested without a terminal, so it is kept deliberately
 * thin: read keys, hand them to the reducer, perform the effects it asks for, paint the
 * lines the renderer returns. If logic accumulates here, it has escaped the tests.
 *
 * TERMINAL STATE IS BORROWED, NOT OWNED
 *
 * Raw mode, the alternate screen and a hidden cursor are three global changes to something
 * the user owns. Every one of them is undone by {@link Tui.#restore}, which is idempotent
 * and wired to normal exit, thrown errors and SIGINT alike. A TUI that leaves a terminal in
 * raw mode has done real damage — the user's next shell will be unusable and they may not
 * know why — so restoration is treated as more important than anything the view does.
 *
 * THE EXIT SUMMARY
 *
 * Leaving the alternate screen throws away everything drawn on it. So on the way out we
 * print, to the ordinary screen, where the user ended up and what they had selected. It
 * costs two lines and it means a full-screen session is not a hole in the scrollback.
 */

import { emitKeypressEvents } from 'node:readline';
import type { CommandTable } from '../commands/types.js';
import { Dispatcher } from '../dispatch.js';
import { formatDocument } from '../format.js';
import type { Session } from '../session.js';
import { bodyRows, render } from './render.js';
import type { RenderOptions } from './render.js';
import {
  applySessionEvent,
  describeSelection,
  initialState,
  reduce,
  shouldRefuseTui,
  withError,
  withListing,
  withPreview,
  withRows,
  withStatus,
} from './state.js';
import type { Effect, Key, TuiState } from './state.js';
import type { SessionEvent } from '@mscomms/core';

const ALT_SCREEN_ON = '\u001B[?1049h';
const ALT_SCREEN_OFF = '\u001B[?1049l';
const CURSOR_HIDE = '\u001B[?25l';
const CURSOR_SHOW = '\u001B[?25h';
const CURSOR_HOME = '\u001B[H';
const CLEAR_LINE = '\u001B[K';
const CLEAR_SCREEN = '\u001B[2J';

/**
 * How many entries to fetch per folder.
 *
 * The pane has no "next page" key on purpose: a screenful is a scroll, not a pagination
 * step, and a second concept of "more" alongside the shell's `more` would be one too many.
 * Folders larger than this are handled by `:find` or `:ls --limit`, which page properly.
 */
const LIST_LIMIT = 500;

export interface TuiOptions {
  readonly session: Session;
  readonly table: CommandTable;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

export class Tui {
  readonly #session: Session;
  readonly #dispatcher: Dispatcher;
  readonly #stdin: NodeJS.ReadStream;
  readonly #stdout: NodeJS.WriteStream;

  #state: TuiState;
  #restored = false;
  #resolve: ((code: number) => void) | undefined;
  #onKeypress: ((chunk: string, key: Key | undefined) => void) | undefined;
  #onResize: (() => void) | undefined;
  #onSigint: (() => void) | undefined;
  /** Set while an effect is in flight, so a held-down arrow cannot stack requests. */
  #working = false;
  #unsubscribe: (() => void) | undefined;
  /**
   * Session events that arrived while an effect was running.
   *
   * Queued rather than applied immediately because an event can ask for a re-list, and
   * re-entering the effect runner from inside itself would interleave two listings and
   * leave the pane showing a mixture of both.
   */
  readonly #pending: SessionEvent[] = [];
  /** Resolver for the confirmation line currently on screen, if any. */
  #confirming: ((answer: boolean) => void) | undefined;

  constructor(options: TuiOptions) {
    this.#session = options.session;
    this.#dispatcher = new Dispatcher(options.table);
    this.#stdin = options.stdin ?? process.stdin;
    this.#stdout = options.stdout ?? process.stdout;
    this.#state = initialState(options.session.cwd, bodyRows(this.#stdout.rows ?? 24));
  }

  async run(): Promise<number> {
    const refusal = shouldRefuseTui({
      isTty: this.#stdout.isTTY === true && this.#stdin.isTTY === true,
      announce: this.#session.format.mode === 'announce',
      plain: this.#session.format.mode === 'plain',
    });
    if (refusal !== undefined) {
      this.#session.status(refusal);
      return 2;
    }

    this.#enter();

    // The pane is an interface, not a separate program: say so, so the journal records how
    // each interaction arrived and `history` can tell a keypress from a spoken command.
    this.#session.source = 'tui';
    this.#session.confirm = (question) => this.#askConfirm(question);

    // Anything that changes the world announces it, and the pane listens. This is the whole
    // of the view-synchronization contract — see `applySessionEvent`.
    this.#unsubscribe = this.#session.subscribe((event) => {
      this.#pending.push(event);
      if (!this.#working) void this.#drain();
    });

    // The first listing is fetched before the first paint, so the user never sees an empty
    // frame that then fills in — a repaint a screen reader would announce twice.
    await this.#perform({ kind: 'list', path: this.#session.cwd });

    return new Promise<number>((resolve) => {
      this.#resolve = resolve;
      this.#listen();
      this.#paint();
    });
  }

  // -------------------------------------------------------------------------
  // Terminal lifecycle
  // -------------------------------------------------------------------------

  #enter(): void {
    this.#stdout.write(ALT_SCREEN_ON + CLEAR_SCREEN + CURSOR_HIDE);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(true);
    emitKeypressEvents(this.#stdin);
    this.#stdin.resume();
  }

  #restore(): void {
    if (this.#restored) return;
    this.#restored = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#session.voice?.stop();
    // Anything still waiting on an answer gets a "no". Leaving it unresolved would hold the
    // process open after the terminal has already been handed back.
    this.#confirming?.(false);
    this.#confirming = undefined;
    if (this.#onKeypress !== undefined) this.#stdin.off('keypress', this.#onKeypress);
    if (this.#onResize !== undefined) this.#stdout.off('resize', this.#onResize);
    if (this.#onSigint !== undefined) process.off('SIGINT', this.#onSigint);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(false);
    this.#stdin.pause();
    this.#stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  }

  #listen(): void {
    this.#onKeypress = (chunk, key): void => {
      void this.#handle(chunk, key);
    };
    this.#onResize = (): void => {
      this.#state = withRows(this.#state, bodyRows(this.#stdout.rows ?? 24));
      this.#stdout.write(CLEAR_SCREEN);
      this.#paint();
    };
    // SIGINT still arrives in raw mode on some platforms; treat it as quit rather than
    // letting the default handler kill us with the terminal still in raw mode.
    this.#onSigint = (): void => {
      this.#finish();
    };

    this.#stdin.on('keypress', this.#onKeypress);
    this.#stdout.on('resize', this.#onResize);
    process.on('SIGINT', this.#onSigint);
  }

  #finish(): void {
    const state = this.#state;
    this.#restore();
    // Printed after leaving the alternate screen, so it lands in the scrollback the user
    // keeps rather than the one the terminal is about to discard.
    this.#session.print(`${state.cwd}`);
    this.#session.status(describeSelection(state));
    this.#session.status('Tip: everything here is also a command. `mscomms` with no --tui gives you the same thing in plain text.');
    this.#resolve?.(0);
    this.#resolve = undefined;
  }

  // -------------------------------------------------------------------------
  // Key handling
  // -------------------------------------------------------------------------

  async #handle(chunk: string, key: Key | undefined): Promise<void> {
    if (this.#restored) return;

    // A confirmation on screen owns the keyboard until it is answered. Nothing else should
    // act on a keypress while the user is being asked whether to archive something.
    if (this.#confirming !== undefined) {
      const resolve = this.#confirming;
      this.#confirming = undefined;
      const answer = /^[yY]$/.test(chunk) || key?.name === 'y';
      this.#state = withStatus(this.#state, answer ? 'Confirmed.' : 'Cancelled.');
      this.#paint();
      resolve(answer);
      return;
    }

    // Keys arriving while a fetch is outstanding are dropped rather than queued. Queuing
    // means a held-down arrow fires a burst of requests that all resolve after the user has
    // stopped moving, and the selection then lurches somewhere they did not ask for.
    if (this.#working) return;

    const resolved: Key = key ?? { sequence: chunk };
    const step = reduce(this.#state, resolved);
    this.#state = step.state;

    for (const effect of step.effects) {
      if (effect.kind === 'quit') {
        this.#finish();
        return;
      }
      this.#paint();
      await this.#perform(effect);
    }
    this.#paint();
  }

  async #perform(effect: Effect): Promise<void> {
    if (effect.kind === 'quit') return;
    this.#working = true;
    try {
      switch (effect.kind) {
        case 'bell':
          if (this.#session.config.ui.bell === true) this.#stdout.write('\u0007');
          break;

        case 'list': {
          const result = await this.#session.vfs.list(effect.path, { limit: LIST_LIMIT });
          this.#state = withListing(this.#state, effect.path, result.entries);
          // Recorded, not just assigned. An arrow key that walks into a folder is an
          // interaction like any other: it belongs in `history`, and `undo` should walk back
          // out of it. Assigning `cwd` directly — which this used to do — made the pane the
          // one way to move around that left no trace and could not be undone.
          this.#session.navigate(effect.path, { command: `cd ${quoteForCommand(effect.path)}`, reason: 'pane' });
          // A first run with no config lands on an empty root. "/ is empty." is true but
          // useless — and unlike the line shell, a user in the pane can't just type `demo`,
          // so the way out has to name the `:` key explicitly.
          if (result.entries.length === 0 && this.#session.vfs.mounts.length === 0) {
            this.#state = withStatus(
              this.#state,
              'No sources configured. Press : then type demo for sample data, or : then doctor to find the config file.',
            );
          }
          // Keep the shell's numbering in step, so quitting the pane and typing `cat 3`
          // refers to the item that was third on screen.
          this.#session.setListing({
            path: effect.path,
            nodes: result.entries,
            startIndex: 1,
            source: 'ls',
          });
          break;
        }

        case 'read': {
          const doc = await this.#session.vfs.read(effect.node);
          const width = Math.max(20, Math.floor((this.#stdout.columns ?? 80) * 0.5) - 2);
          const text = formatDocument(doc, { ...this.#session.format, width });
          this.#state = withPreview(this.#state, effect.node.name, text.split('\n'));
          break;
        }

        case 'refresh': {
          this.#session.vfs.invalidate(this.#state.cwd);
          const result = await this.#session.vfs.list(this.#state.cwd, { limit: LIST_LIMIT });
          this.#state = withListing(this.#state, this.#state.cwd, result.entries);
          break;
        }

        case 'command':
          await this.#runCommand(effect.line);
          break;

        case 'listen': {
          const voice = this.#session.voice;
          if (voice === undefined || !voice.enabled) {
            // Turn it on rather than refusing. Somebody pressing the talk key has already
            // said what they want; making them run `:voice on` first is a pointless detour.
            await this.#runCommand('voice on');
          }
          if (this.#session.voice?.enabled === true) {
            await this.#runCommand('voice once');
          }
          break;
        }
      }
    } catch (error) {
      this.#state = withError(this.#state, messageOf(error));
    } finally {
      this.#working = false;
    }
    await this.#drain();
  }

  /**
   * Apply queued session events.
   *
   * Runs after every effect, and immediately when an event arrives with nothing in flight.
   * Each event may itself ask for a listing, so the queue is drained rather than iterated —
   * a re-list can legitimately arrive while an earlier one is still being applied.
   */
  async #drain(): Promise<void> {
    if (this.#working) return;
    while (this.#pending.length > 0) {
      const event = this.#pending.shift() as SessionEvent;
      const step = applySessionEvent(this.#state, event);
      this.#state = step.state;
      for (const effect of step.effects) {
        if (effect.kind === 'quit') continue;
        await this.#perform(effect);
      }
    }
    if (!this.#restored) this.#paint();
  }

  /**
   * Ask a yes/no question in the pane.
   *
   * Drawn as the status line and answered with a single key, rather than in the `:` prompt,
   * because a confirmation is not a command — it should not be editable, completable, or
   * recallable with the up arrow, and it should be answerable without composing anything.
   */
  #askConfirm(question: string): Promise<boolean> {
    if (this.#restored) return Promise.resolve(false);
    if (this.#confirming !== undefined) return Promise.resolve(false);
    this.#state = withStatus(this.#state, `${question}  [y/N]`);
    this.#paint();
    return new Promise<boolean>((resolve) => {
      this.#confirming = resolve;
    });
  }

  /**
   * Run a shell command and show its output in the preview.
   *
   * This is what makes the pane optional rather than a second, weaker interface. Nothing is
   * reimplemented: {@link Dispatcher} is the same object the line shell drives, so a command
   * behaves identically in both, including the bare-path and listing-number shorthands.
   */
  async #runCommand(line: string): Promise<void> {
    const output = await this.#session.capture(async () => {
      await this.#dispatcher.execute(this.#session, line);
    });

    if (this.#session.exiting) {
      this.#finish();
      return;
    }

    // A command that moved us is reported by the session's own `cwd` event and handled in
    // `#drain`, so there is deliberately no cwd comparison here any more. Doing both meant
    // two listings for one `cd`, and the pane briefly showing the old folder's contents
    // under the new folder's title.
    const trimmed = output.replace(/\n+$/, '');
    this.#state =
      trimmed.trim() === ''
        ? withStatus(this.#state, `${line} \u2014 done, no output.`)
        : withPreview(this.#state, line, trimmed.split('\n'));
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  #paint(): void {
    if (this.#restored) return;
    const options: RenderOptions = {
      ...this.#session.format,
      columns: this.#stdout.columns ?? 80,
      rows: this.#stdout.rows ?? 24,
    };
    const lines = render(this.#state, options);
    // Each line is already exactly one screen width, but the erase guards against a resize
    // landing between the measurement and the write.
    this.#stdout.write(CURSOR_HOME + lines.map((line) => line + CLEAR_LINE).join('\r\n'));
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Quote a path for a journal command line.
 *
 * The journal's lines have to survive a round trip back through the tokenizer, and this
 * program is about messages — folder names here are subject lines and chat titles, which are
 * mostly spaces.
 */
function quoteForCommand(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}
