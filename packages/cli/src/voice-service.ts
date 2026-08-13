/**
 * Attaching voice to a session.
 *
 * The voice package deliberately knows nothing about this program: it records audio, gets
 * text back, and turns that text into a command line. Everything that makes it *this*
 * program's voice control lives here — where the listing comes from, what confirmation looks
 * like, how a spoken command reaches the dispatcher, and how the pane finds out.
 *
 * That split is the point. It means the grammar can be tested without a session, the session
 * can be tested without a microphone, and the only thing joining them is this file, which is
 * small enough to read in one sitting.
 *
 * Two invariants it enforces:
 *
 * - A spoken command is dispatched exactly like a typed one, with `session.source` set to
 *   `voice` for the duration. It lands in the journal, it is undoable, and `history` can tell
 *   you afterwards which of your changes came from the microphone. That last property is
 *   worth more than it sounds: the first question anyone asks after a surprise is "did I do
 *   that, or did it mishear me?"
 * - The context handed to the grammar is built fresh at the moment of interpretation, never
 *   cached. "Open the third one" has to mean the third row on the screen *now*, not the third
 *   row of whatever was listed when the microphone was switched on.
 */

import {
  VoiceController,
  createTranscriber,
  resolveVoiceSettings,
  DEFAULT_VOICE_ENGINE,
  type Transcriber,
  type VoiceContext,
  type VoiceOutcome,
  type VoiceSettings,
} from '@mscomms/voice';
import { resolveSecret, type VoiceConfig } from '@mscomms/core';
import type { Session } from './session.js';
import { sanitizeForDisplay } from './format.js';

export interface VoiceServiceOptions {
  /** Runs a command line as if typed. Supplied by whichever interface is driving. */
  readonly dispatch: (line: string) => Promise<void>;
  /** Override the transcriber, for tests and for `voice test`. */
  readonly transcriber?: Transcriber;
}

/**
 * Stands in for a transcriber that could not be built.
 *
 * Carrying the original configuration error to the point of use means `voice say` works
 * with no setup at all, while `voice once` still fails with the message that actually
 * explains what to fix, rather than a generic "no transcriber".
 */
function unconfigured(reason: string): Transcriber {
  return {
    name: 'unconfigured',
    transcribe: () => Promise.reject(new Error(reason)),
  };
}

export class VoiceService {
  readonly #session: Session;
  readonly #dispatch: (line: string) => Promise<void>;
  readonly #override: Transcriber | undefined;
  #controller: VoiceController | undefined;
  #settings: VoiceSettings | undefined;
  #enabled = false;
  #unsubscribe: (() => void) | undefined;
  /**
   * Action names at the cursor, refreshed in the background.
   *
   * Cached rather than fetched during interpretation because the grammar is synchronous and
   * should stay that way — making it async to look up a list that only improves the wording
   * of a refusal would be a bad trade. Staleness here can never cause a wrong action: `do`
   * validates the verb against the provider itself before running anything. At worst the
   * grammar declines to pre-empt a refusal it could have made a moment sooner.
   */
  #actions: readonly string[] = [];

  constructor(session: Session, options: VoiceServiceOptions) {
    this.#session = session;
    this.#dispatch = options.dispatch;
    this.#override = options.transcriber;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get listening(): boolean {
    return this.#controller?.listening === true;
  }

  get continuous(): boolean {
    return this.#controller?.continuous === true;
  }

  get settings(): VoiceSettings | undefined {
    return this.#settings;
  }

  get lastTranscript(): string {
    return this.#controller?.lastTranscript ?? '';
  }

  get config(): VoiceConfig {
    return this.#session.voiceSettings;
  }

  /**
   * Prepare the transcriber, resolving the API key.
   *
   * Called by `voice on` rather than lazily at the first utterance, so a misconfiguration is
   * reported while the user is still looking at the command that caused it — not after they
   * have already spoken into a microphone that was never going to work.
   */
  async enable(): Promise<void> {
    await this.#build(true);
    this.#enabled = true;
  }

  /**
   * Build the controller, optionally without a working transcriber.
   *
   * `voice say` and `voice test` supply their own text, so demanding a Foundry endpoint and
   * an API key before either will run would make the grammar impossible to try — and the
   * grammar is the part worth trying first. When transcription is not needed, a failure to
   * configure it is deferred into a transcriber that explains itself if something ever does
   * reach for the microphone.
   */
  async #build(requireTranscriber: boolean): Promise<VoiceController> {
    const config = this.config;
    let transcriber = this.#override;

    if (transcriber === undefined) {
      try {
        const key = config.apiKey === undefined ? undefined : await resolveSecret(config.apiKey);
        if (config.apiKey !== undefined && key === undefined) {
          throw new Error(
            `voice.apiKey is set to ${config.apiKey} but that resolved to nothing. Export the variable it names, then run \`voice on\` again.`,
          );
        }
        this.#settings = resolveVoiceSettings(config, key);
        transcriber = createTranscriber(this.#settings);
      } catch (error) {
        if (requireTranscriber) throw error;
        transcriber = unconfigured(error instanceof Error ? error.message : String(error));
      }
    }

    const controller = new VoiceController({
      config,
      transcriber,
      context: () => this.context(),
      dispatch: (command) => this.#runAsVoice(command),
      onStatus: (event) => {
        this.#session.emit(
          event.text === undefined
            ? { kind: 'voice', phase: event.phase }
            : { kind: 'voice', phase: event.phase, text: event.text },
        );
      },
      confirm: (question) => this.#session.confirm(question),
    });
    this.#controller = controller;

    // Keep the cached action list roughly in step with where the user is. Subscribing rather
    // than polling means the refresh happens for the same reasons the view redraws.
    this.#unsubscribe?.();
    this.#unsubscribe = this.#session.subscribe((event) => {
      if (event.kind === 'cwd' || event.kind === 'listing' || event.kind === 'mutated') {
        void this.#refreshActions();
      }
    });
    void this.#refreshActions();
    return controller;
  }

  async #refreshActions(): Promise<void> {
    try {
      const available = await this.#session.vfs.actions(this.#session.cwd);
      this.#actions = available.map((descriptor) => descriptor.name);
    } catch {
      // A folder that cannot report its actions is not a reason to break the microphone.
      this.#actions = [];
    }
  }

  disable(): void {
    this.#controller?.stop();
    this.#controller = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#enabled = false;
    this.#session.emit({ kind: 'voice', phase: 'idle' });
  }

  /** Record one utterance and act on it. */
  async listenOnce(): Promise<VoiceOutcome> {
    if (this.#controller === undefined) await this.enable();
    return (this.#controller as VoiceController).listenOnce();
  }

  async listenContinuously(): Promise<void> {
    if (this.#controller === undefined) await this.enable();
    return (this.#controller as VoiceController).listenContinuously();
  }

  /** Interpret a phrase that was typed rather than spoken. Used by `voice say` and tests. */
  async handleTranscript(transcript: string): Promise<VoiceOutcome> {
    // Deliberately does not require a configured transcriber: the text is already here, so
    // there is nothing to transcribe. This is what lets `demo` plus `voice say` exercise the
    // whole path — grammar, confirmation, dispatch, journal — with no credentials at all.
    const controller = this.#controller ?? (await this.#build(false));
    return controller.handleTranscript(transcript);
  }

  stop(): void {
    this.#controller?.stop();
  }

  /**
   * A snapshot of what the user can currently see and do.
   *
   * `entries` comes from `lastListing`, which is the same memory that makes `cat 3` work
   * after `ls`. Reusing it rather than re-reading the folder is deliberate: the numbers the
   * grammar resolves must be the numbers on the screen, including when the listing is a page
   * of search results rather than a directory.
   */
  context(): VoiceContext {
    const session = this.#session;
    const listing = session.lastListing;
    const entries =
      listing === undefined
        ? []
        : listing.nodes.map((node, offset) => ({
            index: listing.startIndex + offset,
            name: node.name,
            // Lets the grammar tell "open the archive" from "open the budget review"
            // without guessing; `cd` on a message is an error the user cannot act on.
            kind: node.kind === 'dir' ? ('directory' as const) : ('file' as const),
          }));

    return {
      cwd: session.cwd,
      entries,
      mounts: session.vfs.mounts.map((mount) => mount.path.replace(/^\//, '')),
      actions: this.#actions,
      canUndo: session.journal.planUndo().ok,
    };
  }

  /** Dispatch a command line, marked as having come from the microphone. */
  async #runAsVoice(command: string): Promise<void> {
    const previous = this.#session.source;
    this.#session.source = 'voice';
    try {
      await this.#dispatch(command);
    } finally {
      this.#session.source = previous;
    }
  }

  /** One line for `voice status`, and for the pane's footer. */
  describe(): string {
    // When voice is off, this is a configuration report rather than a state report, because
    // "off" is exactly when somebody is trying to find out why. Answering only "voice is
    // off" would send a person setting up an endpoint and a key to `voice on` to learn
    // anything — and `voice on` needs a microphone they may not have yet.
    if (!this.#enabled) return ['Voice is off. Turn it on with `voice on`.', ...this.#configReport()].join('\n');

    const settings = this.#settings;
    const mode = this.config.mode ?? 'push';
    const engine = settings === undefined ? 'not configured' : `${settings.engine} / ${settings.model || 'default'}`;
    const state = this.listening ? 'listening' : this.continuous ? 'waiting for the wake word' : 'idle';
    const heard = this.lastTranscript;
    return [
      `Voice is on (${state}).`,
      `  Engine:  ${engine}`,
      `  Mode:    ${mode}${mode === 'continuous' ? ` (wake word "${this.config.wakeWord ?? '?'}")` : ''}`,
      `  Confirm: ${this.config.autoRun === true ? 'off — spoken changes run immediately' : 'on for anything that changes something'}`,
      heard === '' ? '  Heard:   (nothing yet)' : `  Heard:   "${sanitizeForDisplay(heard)}"`,
    ].join('\n');
  }

  /**
   * What is configured, without contacting anything or opening the microphone.
   *
   * The key line reports only whether the reference resolved. Printing the value would put
   * the key in scrollback, which is the thing `${env:NAME}` exists to avoid — and "did the
   * variable get exported" is the only question anyone actually has here.
   */
  #configReport(): readonly string[] {
    const config = this.config;
    const engine = config.engine ?? DEFAULT_VOICE_ENGINE;
    const lines = [`  Engine:   ${engine}${config.model === undefined ? '' : ` / ${config.model}`}`];

    if (engine === 'command') {
      lines.push(
        config.command === undefined
          ? '  Command:  not set — `set voice.command <program>` or add it to the config file'
          : `  Command:  ${config.command} (audio stays on this machine)`,
      );
    } else {
      lines.push(
        config.endpoint === undefined
          ? `  Endpoint: not set${engine === 'azure-speech' && config.region !== undefined ? ` — using region ${config.region}` : ''}`
          : `  Endpoint: ${config.endpoint}`,
      );
      lines.push(
        config.apiKey === undefined
          ? '  Key:      not set — add "apiKey": "${env:NAME}" to the config file'
          : `  Key:      ${config.apiKey} — ${keyReferenceResolves(config.apiKey) ? 'resolved' : 'that variable is not set in this environment'}`,
      );
    }

    lines.push(
      `  Confirm:  ${config.autoRun === true ? 'off — spoken changes run immediately' : 'on for anything that changes something'}`,
    );
    if (engine === 'mai') {
      lines.push(
        config.phraseBias === false
          ? '  Bias:     off — on-screen names are not sent to the recognizer'
          : '  Bias:     on — names on screen are sent as recognition hints',
      );
    }
    return lines;
  }
}

/**
 * Whether a `${env:NAME}` reference currently names something.
 *
 * Deliberately reports resolvability rather than returning the value: `voice status` needs
 * to answer "did you export it?" and must not put the answer on screen.
 */
function keyReferenceResolves(reference: string): boolean {
  const match = /^\$\{env:([^}]+)\}$/.exec(reference.trim());
  // A literal key is rejected at config load, so anything unparsed here is already in hand.
  if (match === null) return true;
  const value = process.env[match[1] as string];
  return value !== undefined && value !== '';
}
