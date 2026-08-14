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
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { CommandTable } from '../commands/types.js';
import { Dispatcher } from '../dispatch.js';
import { formatDocument } from '../format.js';
import type { Session } from '../session.js';
import {
  DEFAULT_TALK_KEY,
  KEYBOARD_POP,
  KEYBOARD_PUSH,
  KEYBOARD_QUERY,
  KeyboardDecoder,
  describeTalkKey,
  parseTalkKey,
} from './keyboard.js';
import type { TalkKeyEvent, TalkKeySpec } from './keyboard.js';
import {
  INITIAL_PUSH_TO_TALK,
  PUSH_TO_TALK_DEFAULTS,
  isTalking,
  pressTalkKey,
  releaseTalkKey,
  resetTalkKey,
  tickTalkKey,
} from './push-to-talk.js';
import type { PushToTalkAction, PushToTalkOptions, PushToTalkState } from './push-to-talk.js';
import { bodyRows, render } from './render.js';
import type { RenderOptions } from './render.js';
import {
  applySessionEvent,
  describeSelection,
  initialState,
  isFetching,
  reduce,
  selectedNode,
  shouldRefuseTui,
  withActionResult,
  withActions,
  withError,
  withListing,
  withFreshListing,
  withPreview,
  withProgress,
  withRefusal,
  withRows,
  withStartup,
  withStatus,
  withVoiceHold,
} from './state.js';
import type { Effect, Key, TuiState } from './state.js';
import type { SessionEvent } from '@mscomms/core';
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

  /**
   * Key parsing is fed from here rather than straight from stdin.
   *
   * Readline's parser attaches itself to the stream it is given and consumes every byte, so
   * the only way to normalize the enhanced key reporting we ask for — and to lift the talk
   * key out before it becomes an ordinary keypress — is to own the stream in between.
   */
  readonly #keys = new PassThrough({ encoding: 'utf8' });
  /** Holds a multi-byte character split across two reads. */
  readonly #bytes = new StringDecoder('utf8');
  readonly #decoder: KeyboardDecoder;
  readonly #talkKey: TalkKeySpec;
  readonly #talkOptions: PushToTalkOptions;
  #talk: PushToTalkState = INITIAL_PUSH_TO_TALK;
  #talkTimer: NodeJS.Timeout | undefined;
  /**
   * Whether the user has let go since the current recording was asked for.
   *
   * Needed because starting a recording is not instant and letting go is. Opening the
   * microphone means turning voice on if it is off and then dispatching a command, and a
   * push-to-talk release — a few hundred milliseconds — routinely beats that. `stop()` at
   * that moment aborts nothing, because there is no capture to abort yet, and the abort is
   * simply lost: the microphone then opens with the key already up, no timer pending and no
   * held key to end it, and stays open until it times out.
   *
   * So the intent to stop is remembered rather than acted on and dropped. It is honoured at
   * both of the moments it can be: before the recording is started at all, and — if it
   * arrived too late for that — the instant the microphone reports itself open.
   */
  #talkStopped = false;
  #supportTimer: NodeJS.Timeout | undefined;
  #onData: ((chunk: Buffer | string) => void) | undefined;
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

    const voice = options.session.config.voice;
    // An unparseable talk key falls back to the default rather than leaving the user with no
    // talk key at all. `voice status` reports which one is in force, so a typo is visible
    // there instead of only as a key that mysteriously does nothing.
    this.#talkKey = (voice.talkKey === undefined ? undefined : parseTalkKey(voice.talkKey)) ?? DEFAULT_TALK_KEY;
    this.#decoder = new KeyboardDecoder(this.#talkKey);
    this.#talkOptions = {
      mode: voice.pushToTalk ?? PUSH_TO_TALK_DEFAULTS.mode,
      tapMs: PUSH_TO_TALK_DEFAULTS.tapMs,
      releaseDelayMs: Math.max(0, voice.releaseDelayMs ?? PUSH_TO_TALK_DEFAULTS.releaseDelayMs),
    };
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

    // The pane is an interface, not a separate program: say so, so the journal records how
    // each interaction arrived and `history` can tell a keypress from a spoken command.
    this.#session.source = 'tui';
    this.#session.confirm = (question) => this.#askConfirm(question);

    // Anything that changes the world announces it, and the pane listens. This is the whole
    // of the view-synchronization contract — see `applySessionEvent`.
    this.#unsubscribe = this.#session.subscribe((event) => {
      // Voice phase is the one thing that cannot wait its turn, because the effect it is
      // reporting on is the one currently holding the queue shut. A recording is started by
      // `#perform`, which sets `#working` for as long as it runs, and `#drain` refuses to run
      // while `#working` — so a queued "the microphone is open" would be applied after the
      // microphone had already closed. The indicator would be dark for exactly the span it
      // exists to cover, which is worse than having no indicator at all.
      //
      // Safe to apply out of band precisely because a voice event asks for nothing: it moves
      // the indicator and repaints, and produces no effects to interleave with the running
      // one. `tui-sync.test.ts` asserts that emptiness for every phase, so this stays true.
      if (event.kind === 'voice') {
        const step = applySessionEvent(this.#state, event);
        this.#state = step.state;
        if (!this.#restored) this.#paint();
        // The microphone has just opened, and this is the first instant at which a stop can
        // do anything. If the user let go while it was still opening, that release had
        // nothing to abort — so it is applied here instead of being lost, which is what
        // otherwise leaves a mic open with no key held and no timer pending to close it.
        if (event.phase === 'listening' && this.#talkStopped) this.#session.voice?.stop();
        return;
      }
      this.#pending.push(event);
      if (!this.#working) void this.#drain();
    });


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

    // Ask for key releases, then ask the terminal to describe itself. Both replies are
    // swallowed by the decoder; see `KEYBOARD_QUERY` for why the second one is what makes
    // the answer trustworthy rather than a guess with a timer attached.
    //
    // Written after the alternate screen is entered, and this is load-bearing rather than
    // incidental: the protocol requires terminals to keep separate keyboard-mode stacks for
    // the main and alternate screens. Pushing here means we change the mode only on the
    // screen we own, and the shell we were launched from keeps whatever it had — even if we
    // die without cleaning up.
    this.#stdout.write(KEYBOARD_PUSH + KEYBOARD_QUERY);
    // The timer is only a backstop for a terminal that answers neither query. Without it,
    // `support` would sit at `unknown` forever and the help text could never settle on
    // telling the user whether holding the key actually works here.
    this.#supportTimer = setTimeout(() => {
      this.#decoder.settleUnsupported();
    }, 250);
    this.#supportTimer.unref?.();

    emitKeypressEvents(this.#keys);
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
    this.#session.voice?.stop();
    if (this.#talkTimer !== undefined) clearTimeout(this.#talkTimer);
    this.#talkTimer = undefined;
    if (this.#supportTimer !== undefined) clearTimeout(this.#supportTimer);
    this.#supportTimer = undefined;
    // Anything still waiting on an answer gets a "no". Leaving it unresolved would hold the
    // process open after the terminal has already been handed back.
    this.#confirming?.(false);
    this.#confirming = undefined;
    if (this.#onKeypress !== undefined) this.#keys.off('keypress', this.#onKeypress);
    if (this.#onData !== undefined) this.#stdin.off('data', this.#onData);
    if (this.#onResize !== undefined) this.#stdout.off('resize', this.#onResize);
    if (this.#onSigint !== undefined) process.off('SIGINT', this.#onSigint);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(false);
    this.#stdin.pause();
    // Popped before leaving the alternate screen, so the shell we hand back to is reading
    // keys the same way it was before we started. A terminal left reporting key releases
    // would feed stray escape sequences to every program the user runs next.
    this.#stdout.write(KEYBOARD_POP + CURSOR_SHOW + ALT_SCREEN_OFF);
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
    // Raw bytes are split here rather than in the keypress handler because a key release has
    // to be acted on even while an effect is in flight — and `#handle` deliberately drops
    // keys in exactly that window. Releasing the talk key during the recording it started is
    // that window, every single time.
    this.#onData = (chunk): void => {
      const text = typeof chunk === 'string' ? chunk : this.#bytes.write(chunk);
      if (text === '') return;
      const decoded = this.#decoder.decode(text);
      for (const event of decoded.talk) this.#onTalkKey(event);
      if (decoded.passthrough !== '') this.#keys.write(decoded.passthrough);
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

    this.#keys.on('keypress', this.#onKeypress);
    this.#stdin.on('data', this.#onData);
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
  // Push to talk
  // -------------------------------------------------------------------------

  /**
   * A press, repeat or release of the talk key.
   *
   * Repeats are ignored: they only say the key is still down, which we already know, and
   * acting on them would restart a recording sixty times a second.
   */
  #onTalkKey(event: TalkKeyEvent): void {
    if (this.#restored) return;
    if (event.type === 'repeat') return;

    const now = Date.now();
    if (event.type === 'release') {
      const released = releaseTalkKey(this.#talk, now, this.#talkOptions);
      this.#talk = released.state;
      // A latched recording is the one the user has to be told about, because from here the
      // key they are no longer holding is what ends it.
      if (this.#talk.phase === 'latched') {
        this.#state = withVoiceHold(this.#state, 'latched');
        this.#paint();
      }
      this.#applyTalkAction(released.action);
      return;
    }

    // A press while nothing is recording is a request to start, and starting is real work.
    // Refusing it while something else is in flight matches every other key in the pane; a
    // press while we *are* recording is a stop, which must always get through — that is the
    // whole point of handling this off the raw stream.
    if (!isTalking(this.#talk) && this.#working) return;

    const pressed = pressTalkKey(this.#talk, now);
    this.#talk = pressed.state;
    this.#applyTalkAction(pressed.action);
  }

  #applyTalkAction(action: PushToTalkAction): void {
    if (this.#talkTimer !== undefined) {
      clearTimeout(this.#talkTimer);
      this.#talkTimer = undefined;
    }

    switch (action.kind) {
      case 'start':
        // A terminal that will not report releases will never end this recording on its own,
        // so it is locked from the moment it starts and the indicator says so immediately.
        // Showing "hold to talk" on a terminal that cannot tell us the key came up would be
        // an instruction that quietly does not work.
        this.#talkStopped = false;
        this.#state = withVoiceHold(this.#state, this.#decoder.support === 'unsupported' ? 'latched' : 'holding');
        this.#paint();
        void this.#perform({ kind: 'listen' });
        break;

      case 'stop':
        this.#talkStopped = true;
        this.#state = withVoiceHold(this.#state, 'none');
        this.#paint();
        // Stopping is an abort of the capture, which the recorder treats as "finished
        // speaking" rather than "throw this away" — the audio up to the release is exactly
        // the audio we want, and it goes on to be transcribed and run.
        this.#session.voice?.stop();
        break;

      case 'schedule': {
        const wait = Math.max(0, action.at - Date.now());
        this.#talkTimer = setTimeout(() => {
          this.#talkTimer = undefined;
          const step = tickTalkKey(this.#talk, Date.now());
          this.#talk = step.state;
          this.#applyTalkAction(step.action);
        }, wait);
        this.#talkTimer.unref?.();
        break;
      }

      case 'none':
        break;
    }
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

    // Keys arriving while a fetch is outstanding are handled below, where cursor movement is
    // still honoured and only a second fetch is refused.

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
          this.#state = withListing(this.#state, effect.path, result.entries, {
            ...(effect.nav === undefined ? {} : { nav: effect.nav }),
          });
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
          try {
            const voice = this.#session.voice;
            if (voice === undefined || !voice.enabled) {
              // Turn it on rather than refusing. Somebody pressing the talk key has already
              // said what they want; making them run `:voice on` first is a pointless detour.
              await this.#runCommand('voice on');
            }
            // Turning voice on is the slowest thing here on first use, and a release lands in
            // the middle of it easily. Opening the microphone now would open it for a key that
            // is already up — so if the user has let go, the recording is simply not started.
            if (!this.#talkStopped && this.#session.voice?.enabled === true) {
              await this.#runCommand('voice once');
            }
          } finally {
            // The recording is over by the time this returns, however it ended — released,
            // stopped, timed out or failed. The machine has to be told, or it would keep
            // believing a microphone is open and answer the next press with a stop. In a
            // `finally` because a failure to start one is exactly the case where being left
            // believing otherwise would wedge the talk key for the rest of the session.
            this.#talk = resetTalkKey();
            this.#talkStopped = false;
            this.#state = withVoiceHold(this.#state, 'none');
          }
          break;
        }

        case 'actions': {
          const descriptors = await this.#session.vfs.actions(effect.node);
          this.#state = withActions(this.#state, effect.node, effect.path, descriptors);
          break;
        }

        case 'invoke': {
          const result = await this.#session.vfs.invoke(effect.action, effect.node, effect.params);
          this.#state = withActionResult(this.#state, result);
          // Acting on something changes it, and the whole point of doing it here rather than
          // in a browser tab is seeing that immediately: the engine has already dropped the
          // stale entries, so re-listing shows the reply that was just sent and the review
          // that was just left. The status line survives it, because the result sentence is
          // the only report the user gets.
          await this.#refreshAfterAction(effect.node);
          break;
        }
      }
    } catch (error) {
      this.#state = withError(this.#state, messageOf(error));
    } finally {
      this.#working = false;
      this.#stopTicking();
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
   * Bring the screen back in line with what an action just changed.
   *
   * Failures here are deliberately swallowed down to the status line the action already
   * produced. The action succeeded; a refresh that then fails is a lesser, separate problem,
   * and replacing "Approved #14." with a listing error would tell the user the thing they
   * care about did not happen.
   */
  async #refreshAfterAction(node: { readonly name: string }): Promise<void> {
    const announced = this.#state.status;
    try {
      const result = await this.#session.vfs.list(this.#state.cwd, { limit: LIST_LIMIT });
      this.#state = withFreshListing(this.#state, this.#state.cwd, result.entries);
      this.#session.setListing({ path: this.#state.cwd, nodes: result.entries, startIndex: 1, source: 'ls' });

      // Re-read only what is already open, and only if it is still the same item: replacing
      // the preview with something the user did not ask to see is worse than leaving it.
      if (this.#state.preview.length > 0 && this.#state.previewTitle === node.name) {
        const fresh = selectedNode(this.#state);
        if (fresh !== undefined && fresh.name === node.name) {
          const doc = await this.#session.vfs.read(fresh);
          const width = Math.max(20, Math.floor((this.#stdout.columns ?? 80) * 0.5) - 2);
          this.#state = withPreview(this.#state, fresh.name, formatDocument(doc, { ...this.#session.format, width }).split('\n'));
        }
      }
    } catch {
      // Intentionally ignored; see above.
    }
    this.#state = withStatus(this.#state, announced);
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
      talkKey: describeTalkKey(this.#talkKey),
      // Only reported once the terminal has answered. While it is still `unknown` the help
      // screen keeps the optimistic wording rather than flickering between two claims.
      ...(this.#decoder.support === 'unknown' ? {} : { holdSupported: this.#decoder.support === 'supported' }),
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
