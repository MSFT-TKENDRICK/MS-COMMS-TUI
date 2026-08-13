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
  describeSelection,
  initialState,
  isFetching,
  reduce,
  shouldRefuseTui,
  withError,
  withListing,
  withFreshListing,
  withPreview,
  withProgress,
  withRefusal,
  withRows,
  withStartup,
  withStatus,
} from './state.js';
import type { Effect, Key, TuiState } from './state.js';
import { externalTasks, ownTasks, readySummary, startupLine } from '../startup.js';

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

/**
 * How often the working indicator advances, in milliseconds.
 *
 * Fast enough to read as motion, slow enough that a repaint of the whole screen every frame
 * is nothing next to the network call it is reporting on.
 */
const TICK_MS = 120;

/**
 * How long the "ready" announcement stays on the status row before it gets out of the way.
 *
 * Long enough to be read, short enough that it is gone by the time it would be in the way of
 * the user's own business. It is the row's only permanent resident that is not about what
 * the user just did, so it does not get to keep it.
 */
const READY_MS = 2500;

/**
 * How many stray writes to hold for the exit summary.
 *
 * A watch on a busy mailbox can notify indefinitely, and nobody is going to read a thousand
 * lines of it after quitting. This keeps the first few, which is where an explanation of
 * something that went wrong will be.
 */
const ASIDE_LIMIT = 40;

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
  #unsubscribe: (() => void) | undefined;
  /** Set while an effect is in flight, so a held-down arrow cannot stack requests. */
  #working = false;
  /** Repaint timer that animates the working indicator. Only alive while {@link #working}. */
  #ticker: NodeJS.Timeout | undefined;
  /** The same, for the startup line, which runs on its own clock and often overlaps. */
  #startupTicker: NodeJS.Timeout | undefined;
  #startupTick = 0;
  /** Clears the "ready" announcement once it has been up long enough to read. */
  #startupClear: NodeJS.Timeout | undefined;
  /** Re-derives the startup row. Held as a field so the ticker and the watcher share one. */
  #refreshStartup: (() => void) | undefined;
  #unwatchStartup: (() => void) | undefined;
  #unredirect: (() => void) | undefined;
  /** Anything that printed while the pane owned the screen, to be shown after it lets go. */
  readonly #aside: string[] = [];

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
    this.#hush();

    return new Promise<number>((resolve) => {
      this.#resolve = resolve;
      this.#listen();
      this.#watchStartup();
      // Busy from the first frame, because it is: startup is running behind this one and the
      // listing cannot even be asked for until it finishes. Saying so up front is also what
      // keeps a key that would start a second fetch from being honoured against a VFS whose
      // mounts have not been attached yet.
      this.#working = true;
      this.#startTicking();
      // Painted *before* the first listing, not after. The initial state already says
      // "Loading…", and the whole complaint about this view was that a slow first fetch
      // showed a blank alternate screen for as long as it took — the frame existed, it was
      // just never drawn. A screen reader announcing "Loading" and then the result is the
      // correct behaviour here; announcing nothing at all was not.
      this.#paint();
      // The cwd is read when this runs rather than when the pane was constructed, because
      // startup can move it: a session with exactly one source lands the user inside it,
      // and that is decided by the mounts step, which is still running behind this frame.
      void this.#session
        .ready()
        .then(async () => this.#perform({ kind: 'list', path: this.#session.cwd }))
        .then(() => {
          this.#paint();
        });
    });
  }

  // -------------------------------------------------------------------------
  // Terminal lifecycle
  // -------------------------------------------------------------------------

  /**
   * Take the terminal away from anything that prints on its own schedule.
   *
   * The pane draws by absolute cursor positioning, so a single unexpected newline from
   * somewhere else scrolls the frame out from under itself and every paint after that lands
   * in the wrong place. Commands are already safe — they run inside `capture` — but startup
   * now runs in the background, which means a step that mounts sample data, a watch that
   * fires, or a warning from a source that gave up can all write while the pane is up.
   *
   * Silently discarding them would trade a corrupted screen for a lost warning, so they are
   * kept and printed on the way out, next to the exit summary and for the same reason: the
   * alternate screen is not a place things can be left. The cap is there because a watch on
   * a busy mailbox could otherwise fill memory with text nobody will read.
   */
  #hush(): void {
    this.#unredirect = this.#session.redirect((text) => {
      if (this.#aside.length >= ASIDE_LIMIT) return;
      this.#aside.push(text);
    });
  }

  #enter(): void {
    this.#stdout.write(ALT_SCREEN_ON + CLEAR_SCREEN + CURSOR_HIDE);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(true);
    emitKeypressEvents(this.#stdin);
    this.#stdin.resume();
  }

  #restore(): void {
    if (this.#restored) return;
    this.#restored = true;
    this.#stopTicking();
    this.#stopStartupTicking();
    this.#unwatchStartup?.();
    this.#unwatchStartup = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#onKeypress !== undefined) this.#stdin.off('keypress', this.#onKeypress);
    if (this.#onResize !== undefined) this.#stdout.off('resize', this.#onResize);
    if (this.#onSigint !== undefined) process.off('SIGINT', this.#onSigint);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(false);
    this.#stdin.pause();
    this.#stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF);
    // Only now is there a scrollback to write into again.
    this.#unredirect?.();
    this.#unredirect = undefined;
    const aside = this.#aside.join('').trimEnd();
    this.#aside.length = 0;
    if (aside !== '') this.#session.status(aside);
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

    // The last stage of a staged read. The first answer for a folder can come from the
    // local snapshot and be minutes old; when the engine has since checked with the source,
    // it says so here and the screen catches up on its own. Without this the user is left
    // reading a stale list with no way to know it, and pressing refresh — the one thing
    // preloading exists to make unnecessary.
    this.#unsubscribe = this.#session.vfs.onListingChanged((event) => {
      const next = withFreshListing(this.#state, event.path, event.entries);
      if (next === this.#state) return;
      this.#state = next;
      this.#paint();
    });
  }

  /**
   * Show what startup is doing, on the status row, until it stops doing it.
   *
   * This exists because the pane is now drawn *before* the sources are connected. That is
   * the fix for a blank terminal on launch, but it trades one confusion for another: a
   * first frame that is empty and says nothing looks like a mailbox with no mail in it.
   * So the row names the check that is running, the spinner keeps it visibly alive, and
   * the moment this session's own checks settle it says what was found.
   *
   * Three things can want the row, in this order: what the session is still doing, the
   * announcement that it has finished, and whatever the launcher is still doing behind it.
   * A rebuild in the launcher is worth showing — ten unexplained seconds of disk noise is
   * worse than ten explained ones — but it must not delay the announcement, because it is a
   * fact about the next launch rather than this one.
   *
   * All of it lives in `startup` rather than `status`, and none of it touches `busy`. Those
   * two belong to the user's own operation: writing an announcement about background work
   * into them would clobber the answer to whatever key they just pressed, and clearing
   * `busy` would drop the spinner in the middle of the first listing and claim the screen
   * was finished when it was not.
   *
   * Nothing is announced when startup was already over before the pane opened — a one-shot
   * run, or a test that started the session first. Announcing the end of something the user
   * never saw begin is noise, and it would sit where "Loading…" belongs.
   *
   * The timers are separate from the one that animates a fetch, and unreferenced for the
   * same reason: an indicator must never be why a process is still running.
   */
  #watchStartup(): void {
    const tasks = this.#session.tasks;
    let seen = false;
    let announcing = false;

    const refresh = (): void => {
      if (this.#restored) return;
      const snapshot = tasks.snapshot();
      const own = startupLine(ownTasks(snapshot), this.#startupTick);

      if (own !== undefined) {
        seen = true;
        this.#startStartupTicking();
        this.#state = withStartup(this.#state, own);
        this.#paint();
        return;
      }

      // Own checks are done. Say so, once, and only to someone who watched them run.
      if (seen && !announcing) {
        seen = false;
        announcing = true;
        this.#stopStartupTicking();
        this.#state = withStartup(this.#state, readySummary(ownTasks(snapshot)));
        this.#paint();
        this.#startupClear = setTimeout(() => {
          this.#startupClear = undefined;
          announcing = false;
          refresh();
        }, READY_MS);
        this.#startupClear.unref?.();
        return;
      }
      if (announcing) return;

      const external = startupLine(externalTasks(snapshot), this.#startupTick);
      if (external === undefined) {
        this.#stopStartupTicking();
        this.#state = withStartup(this.#state, '');
        this.#paint();
        return;
      }
      seen = true;
      this.#startStartupTicking();
      this.#state = withStartup(this.#state, external);
      this.#paint();
    };

    this.#refreshStartup = refresh;
    this.#unwatchStartup = tasks.subscribe(() => {
      refresh();
    });
    refresh();
  }

  #startStartupTicking(): void {
    if (this.#startupTicker !== undefined) return;
    this.#startupTicker = setInterval(() => {
      this.#startupTick += 1;
      // Only the spinner moved, but `refresh` is the single place that knows which of the
      // three things owns the row, and it is cheap and idempotent. Re-deriving beats
      // keeping a second, subtly different copy of that decision here.
      this.#refreshStartup?.();
    }, TICK_MS);
    this.#startupTicker.unref?.();
  }

  #stopStartupTicking(): void {
    if (this.#startupTicker !== undefined) {
      clearInterval(this.#startupTicker);
      this.#startupTicker = undefined;
    }
    if (this.#startupClear !== undefined) {
      clearTimeout(this.#startupClear);
      this.#startupClear = undefined;
    }
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

    const resolved: Key = key ?? { sequence: chunk };
    const step = reduce(this.#state, resolved);

    // A request is already in flight. Keys that only move the cursor or type into the filter
    // are still honoured — they cost nothing, and a browser that stops scrolling because a
    // message is loading is the frozen-feeling behaviour this view had. Keys that would
    // start a *second* fetch are refused, because queueing them is how a held-down arrow
    // turns into a burst of requests that all land after the user has stopped moving.
    //
    // Quit is the important exception: it is checked before the refusal, so there is always
    // a way out of a slow load.
    if (this.#working) {
      if (step.effects.some((effect) => effect.kind === 'quit')) {
        this.#finish();
        return;
      }
      this.#state = step.effects.some(isFetching) ? withRefusal(this.#state) : step.state;
      this.#paint();
      return;
    }

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

  /**
   * Repaint on a timer while an operation is outstanding.
   *
   * Without this the "working" marker is drawn once and then sits there, unchanged, for
   * however long the fetch takes — which is not meaningfully different from showing nothing,
   * because the thing a user reads as "alive" is motion, not text.
   *
   * `unref` matters: this timer must never be the reason the process stays up. If everything
   * else has finished, a spinner is not a reason to keep a terminal open.
   */
  #startTicking(): void {
    if (this.#ticker !== undefined) return;
    const startedAt = Date.now();
    this.#ticker = setInterval(() => {
      this.#state = withProgress(this.#state, Date.now() - startedAt);
      this.#paint();
    }, TICK_MS);
    this.#ticker.unref?.();
  }

  #stopTicking(): void {
    if (this.#ticker === undefined) return;
    clearInterval(this.#ticker);
    this.#ticker = undefined;
  }

  async #perform(effect: Effect): Promise<void> {
    if (effect.kind === 'quit') return;
    this.#working = true;
    this.#startTicking();
    try {
      switch (effect.kind) {
        case 'bell':
          if (this.#session.config.ui.bell === true) this.#stdout.write('\u0007');
          break;

        case 'list': {
          const result = await this.#session.vfs.list(effect.path, { limit: LIST_LIMIT });
          this.#session.cwd = effect.path;
          this.#state = withListing(this.#state, effect.path, result.entries, {
            ...(effect.nav === undefined ? {} : { nav: effect.nav }),
          });
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
      }
    } catch (error) {
      this.#state = withError(this.#state, messageOf(error));
    } finally {
      this.#working = false;
      this.#stopTicking();
    }
  }

  /**
   * Run a shell command and show its output in the preview.
   *
   * This is what makes the pane optional rather than a second, weaker interface. Nothing is
   * reimplemented: {@link Dispatcher} is the same object the line shell drives, so a command
   * behaves identically in both, including the bare-path and listing-number shorthands.
   */
  async #runCommand(line: string): Promise<void> {
    const before = this.#session.cwd;
    const output = await this.#session.capture(async () => {
      await this.#dispatcher.execute(this.#session, line);
    });

    if (this.#session.exiting) {
      this.#finish();
      return;
    }

    // A command that moved us (`cd`, `back`, a bare folder name) should move the pane too,
    // otherwise the two halves of the interface disagree about where the user is.
    if (this.#session.cwd !== before) {
      const result = await this.#session.vfs.list(this.#session.cwd, { limit: LIST_LIMIT });
      this.#state = withListing(this.#state, this.#session.cwd, result.entries);
      return;
    }

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
