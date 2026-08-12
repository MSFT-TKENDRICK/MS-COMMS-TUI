/**
 * The loop: listen, transcribe, interpret, confirm, dispatch.
 *
 * This is the only stateful part of voice, and it is stateful for one reason — a microphone
 * is a shared, exclusive, physically observable resource. Two overlapping recordings produce
 * garbage; a recording nobody knows is happening is a privacy incident. So there is exactly
 * one controller, it holds exactly one recording at a time, and every state change is
 * announced on the session's event bus rather than drawn to the screen here. The pane and the
 * plain shell then show the same thing, because they are both reading the same events.
 *
 * The controller never touches the VFS. It produces a command line and hands it to a
 * `dispatch` callback supplied by the caller. That is the same boundary the grammar keeps and
 * for the same reason: voice must be incapable of doing anything the keyboard cannot, and the
 * cheapest way to guarantee that is to give it no other route.
 *
 * Confirmation is the other half of the design. Anything that changes the world is read back
 * and waits for a yes, unless `voice.autoRun` is deliberately turned on. This is not timidity:
 * a transcription error in a text editor is a typo you see, and a transcription error here is
 * mail that has been archived. The confirmation is also where a screen reader user gets to
 * hear what was understood, which makes it an accessibility feature rather than a speed bump.
 * Navigation is never confirmed — asking "go to inbox?" every time would make voice slower
 * than the keyboard, and going to the wrong folder costs nothing to correct.
 */

import type { VoiceConfig } from '@mscomms/core';
import { captureUtterance, peakAmplitude, type CaptureOptions } from './capture.js';
import { interpret, type Interpretation, type VoiceContext } from './grammar.js';
import { speak } from './speak.js';
import type { Transcriber } from './stt.js';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'heard' | 'error';

export interface VoiceStatusEvent {
  readonly phase: VoicePhase;
  readonly text?: string;
}

export interface VoiceControllerOptions {
  readonly config: VoiceConfig;
  readonly transcriber: Transcriber;
  /** Snapshot of the world at the moment of interpretation, never cached. */
  readonly context: () => VoiceContext;
  /** Runs a command line exactly as if it had been typed. */
  readonly dispatch: (command: string) => Promise<void> | void;
  /** Report phase changes so the pane, the shell and the screen reader stay in step. */
  readonly onStatus: (event: VoiceStatusEvent) => void;
  /**
   * Ask before a mutation. Returning false cancels.
   *
   * Supplied by the caller because "ask the user" means a readline prompt in the shell and a
   * modal line in the pane, and the controller should not know which it is in.
   */
  readonly confirm: (question: string) => Promise<boolean>;
  readonly platform?: NodeJS.Platform;
}

export interface VoiceOutcome {
  readonly transcript: string;
  readonly interpretation: Interpretation;
  /** False when a mutation was understood but the user declined it. */
  readonly ran: boolean;
  readonly note?: string;
}

/**
 * Below this peak amplitude we treat a clip as silence.
 *
 * Worth distinguishing: "I heard nothing" and "I heard something I did not understand" send
 * the user to completely different fixes — one is a microphone problem, the other is a
 * phrasing problem. A single "sorry?" for both is the most common way voice interfaces waste
 * somebody's afternoon.
 */
const SILENCE_THRESHOLD = 0.012;

export class VoiceController {
  readonly #options: VoiceControllerOptions;
  #active: AbortController | undefined;
  #continuous = false;
  #stopping = false;
  #lastTranscript = '';

  constructor(options: VoiceControllerOptions) {
    this.#options = options;
  }

  get listening(): boolean {
    return this.#active !== undefined;
  }

  get continuous(): boolean {
    return this.#continuous;
  }

  get lastTranscript(): string {
    return this.#lastTranscript;
  }

  /**
   * Record one utterance and act on it.
   *
   * Refuses to start a second recording rather than queueing one. A queued utterance would be
   * interpreted against a listing that has since changed — "open three" meaning a different
   * message than the one on screen when it was said. Refusing is the honest answer.
   */
  async listenOnce(): Promise<VoiceOutcome> {
    if (this.#active !== undefined) {
      throw new Error('Already listening. Say "stop listening" or press Escape first.');
    }

    const config = this.#options.config;
    const controller = new AbortController();
    this.#active = controller;
    this.#status('listening');

    try {
      const captureOptions: CaptureOptions = {
        maxSeconds: config.maxSeconds ?? 15,
        signal: controller.signal,
        ...(config.recorder === undefined ? {} : { recorder: config.recorder }),
        ...(config.recorderArgs === undefined ? {} : { recorderArgs: config.recorderArgs }),
        ...(config.device === undefined ? {} : { device: config.device }),
        ...(this.#options.platform === undefined ? {} : { platform: this.#options.platform }),
      };
      const captured = await captureUtterance(captureOptions);

      if (peakAmplitude(captured.audio) < SILENCE_THRESHOLD) {
        this.#status('idle');
        return {
          transcript: '',
          interpretation: { ok: false, reason: 'I did not hear anything — is the right microphone selected?', suggestions: [] },
          ran: false,
          note: 'silence',
        };
      }

      this.#status('transcribing');
      const result = await this.#options.transcriber.transcribe({
        audio: captured.audio,
        ...(config.language === undefined ? {} : { language: config.language }),
        phrases: this.#biasPhrases(),
      });

      const transcript = result.text.trim();
      this.#lastTranscript = transcript;
      if (transcript === '') {
        this.#status('idle');
        return {
          transcript: '',
          interpretation: { ok: false, reason: 'The recognizer returned nothing for that clip.', suggestions: [] },
          ran: false,
        };
      }

      this.#status('heard', transcript);
      return await this.#act(transcript);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#status('error', message);
      throw error;
    } finally {
      this.#active = undefined;
      if (!this.#continuous) this.#status('idle');
    }
  }

  /** Stop the current recording. Safe to call when nothing is recording. */
  stop(): void {
    this.#continuous = false;
    this.#stopping = true;
    this.#active?.abort();
  }

  /**
   * Listen until told to stop.
   *
   * Requires a wake word, enforced by config validation rather than here, because the failure
   * mode of a hot mic without one is that a program which can archive mail obeys a
   * conversation happening near it. The wake word is stripped before interpretation, so
   * "computer, go to inbox" and "go to inbox" reach the grammar identically.
   */
  async listenContinuously(): Promise<void> {
    if (this.#continuous) return;
    const wakeWord = this.#options.config.wakeWord;
    if (wakeWord === undefined || wakeWord.trim() === '') {
      throw new Error(
        'Continuous listening needs a wake word, so the microphone is not acting on every conversation in the room. Set voice.wakeWord first.',
      );
    }

    this.#continuous = true;
    this.#stopping = false;
    let consecutiveFailures = 0;

    while (this.#continuous && !this.#stopping) {
      try {
        const outcome = await this.listenOnce();
        consecutiveFailures = 0;
        if (outcome.note === 'stop') break;
      } catch (error) {
        consecutiveFailures += 1;
        // A recorder that fails once may have lost the device for a moment. One that fails
        // three times in a row is not going to start working, and a tight retry loop against
        // a dead microphone will spin a core until somebody notices.
        if (consecutiveFailures >= 3) {
          this.#continuous = false;
          this.#status('error', error instanceof Error ? error.message : String(error));
          throw error;
        }
        await delay(500);
      }
    }

    this.#continuous = false;
    this.#status('idle');
  }

  /** Interpret an already-transcribed phrase. Used by continuous mode and by `voice say`. */
  async handleTranscript(transcript: string): Promise<VoiceOutcome> {
    this.#lastTranscript = transcript;
    return this.#act(transcript);
  }

  async #act(rawTranscript: string): Promise<VoiceOutcome> {
    const config = this.#options.config;
    let transcript = rawTranscript;

    // In continuous mode, a phrase without the wake word was not addressed to us.
    if (this.#continuous && config.wakeWord !== undefined) {
      const stripped = stripWakeWord(transcript, config.wakeWord);
      if (stripped === undefined) {
        return {
          transcript,
          interpretation: { ok: false, reason: `Ignored — no "${config.wakeWord}".`, suggestions: [] },
          ran: false,
          note: 'no-wake-word',
        };
      }
      transcript = stripped;
    }

    const interpretation = interpret(transcript, this.#options.context());
    if (!interpretation.ok) {
      if (config.speak === true) await speak(interpretation.reason, this.#platformOption());
      return { transcript, interpretation, ran: false };
    }

    if (interpretation.command === 'voice off') {
      this.stop();
      if (config.speak === true) await speak('Stopped listening.', this.#platformOption());
      return { transcript, interpretation, ran: true, note: 'stop' };
    }

    const needsConfirmation = interpretation.mutating && config.autoRun !== true;
    if (needsConfirmation) {
      const question = `${capitalize(interpretation.intent)}?`;
      const approved = await this.#confirm(question);
      if (!approved) {
        return { transcript, interpretation, ran: false, note: 'declined' };
      }
    }

    await this.#options.dispatch(interpretation.command);
    if (config.speak === true && !needsConfirmation) {
      await speak(interpretation.intent, this.#platformOption());
    }
    return { transcript, interpretation, ran: true };
  }

  #platformOption(): { platform?: NodeJS.Platform } {
    return this.#options.platform === undefined ? {} : { platform: this.#options.platform };
  }

  /**
   * Confirm a mutation, by voice if we can and by keyboard if we cannot.
   *
   * Asking somebody to reach for the keyboard to approve something they just said out loud
   * defeats the point of the feature — and for the users who need voice control most, "just
   * press y" may not be an option at all. So we ask, listen for an answer, and only fall
   * back to the caller's prompt when the answer was not clearly yes or no.
   *
   * Ambiguity always falls through to the keyboard rather than being resolved either way.
   * Treating an unclear noise as "yes" would archive mail on a cough; treating it as "no"
   * silently would leave the user waiting for something that already gave up.
   */
  async #confirm(question: string): Promise<boolean> {
    const config = this.#options.config;
    if (config.speak === true) await speak(question, { ...this.#platformOption(), wait: true });

    const spoken = await this.#listenForAnswer();
    if (spoken !== undefined) return spoken;

    return this.#options.confirm(question);
  }

  /**
   * Record a short yes/no.
   *
   * Uses capture directly rather than `listenOnce`, because that would re-enter the whole
   * interpret-and-dispatch pipeline and try to run "yes" as a command. Returns undefined for
   * anything that is not a clear answer, which is the signal to fall back.
   */
  async #listenForAnswer(): Promise<boolean | undefined> {
    const config = this.#options.config;
    // Nothing to listen with, or nothing was spoken in the first place: use the keyboard.
    if (config.enabled !== true && !this.#continuous && this.#lastTranscript === '') return undefined;

    const controller = new AbortController();
    const previous = this.#active;
    this.#active = controller;
    this.#status('listening', 'yes or no?');
    try {
      const captured = await captureUtterance({
        // Short: an answer is one word, and a long window is a long silence to sit through.
        maxSeconds: 4,
        signal: controller.signal,
        ...(config.recorder === undefined ? {} : { recorder: config.recorder }),
        ...(config.recorderArgs === undefined ? {} : { recorderArgs: config.recorderArgs }),
        ...(config.device === undefined ? {} : { device: config.device }),
        ...(this.#options.platform === undefined ? {} : { platform: this.#options.platform }),
      });
      if (peakAmplitude(captured.audio) < SILENCE_THRESHOLD) return undefined;

      this.#status('transcribing');
      const result = await this.#options.transcriber.transcribe({
        audio: captured.audio,
        ...(config.language === undefined ? {} : { language: config.language }),
        // The expected vocabulary here is two words, not the folder listing. Biasing toward
        // the names on screen would make "no" likelier to come back as a message subject.
        phrases: ['yes', 'no', 'yeah', 'nope', 'cancel', 'go ahead'],
      });
      return parseYesNo(result.text);
    } catch {
      // A failed confirmation recording is not a failed command. Ask on screen instead.
      return undefined;
    } finally {
      this.#active = previous;
    }
  }

  #status(phase: VoicePhase, text?: string): void {
    this.#options.onStatus(text === undefined ? { phase } : { phase, text });
  }

  /**
   * What is on screen right now, offered to the recognizer as a bias.
   *
   * Read fresh per utterance from the same `context()` the grammar uses, so the recognizer
   * and the interpreter are never biased toward different folders — a listing that changed
   * between them would produce a transcript naming something the grammar cannot resolve.
   *
   * Includes the phrases the grammar itself understands: "unread", "archive" and the rest
   * are ordinary words a recognizer will otherwise render as whatever the acoustics suggest.
   */
  #biasPhrases(): readonly string[] {
    const context = this.#options.context();
    return [
      ...context.entries.map((entry) => entry.name),
      ...context.mounts,
      ...context.actions,
      ...VOCABULARY,
    ];
  }
}

/** Command words the grammar matches on, biased so they survive recognition. */
const VOCABULARY = [
  'inbox',
  'unread',
  'archive',
  'flag',
  'reply',
  'undo',
  'redo',
  'open',
  'go back',
  'stop listening',
  'what can I say',
];

/**
 * Strip a wake word, or report that it was not there.
 *
 * Matched loosely — leading filler, an optional comma, and a fuzzy first token — because a
 * wake word that only works when enunciated perfectly trains people to shout at their laptop.
 * Returns undefined when absent, which is how continuous mode stays quiet.
 */
export function stripWakeWord(transcript: string, wakeWord: string): string | undefined {
  const wake = wakeWord.trim().toLowerCase();
  if (wake === '') return transcript;
  const text = transcript.trim().toLowerCase().replace(/^[\s,.]+/, '');
  if (!text.startsWith(wake)) return undefined;
  const rest = transcript.trim().replace(/^[\s,.]+/, '').slice(wake.length);
  return rest.replace(/^[\s,.]+/, '');
}

/**
 * Read a spoken yes or no, or admit that it was neither.
 *
 * Deliberately strict. The words listed here are unambiguous; anything else — "hmm", "I
 * think so", a half-sentence, a cough the recognizer rendered as a word — returns undefined
 * and sends the question to the keyboard. A confirmation prompt that guesses is not a
 * confirmation prompt.
 */
export function parseYesNo(transcript: string): boolean | undefined {
  const text = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (text === '') return undefined;
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|affirmative|correct|right)$/.test(text)) {
    return true;
  }
  if (/^(?:no|nope|nah|cancel|stop|don't|do not|negative|never mind|nevermind|wrong)$/.test(text)) {
    return false;
  }
  return undefined;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
