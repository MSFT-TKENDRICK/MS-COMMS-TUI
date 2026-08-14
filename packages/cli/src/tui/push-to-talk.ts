/**
 * The talk key's behaviour: hold to speak, tap to latch.
 *
 * Push-to-talk is one gesture with two endings, and which one happened is only knowable
 * *after* the key comes back up. So recording starts the moment the key goes down, and the
 * release decides what that press meant:
 *
 *   held down, then released  ->  stop, the way Discord does
 *   pressed and let go quickly ->  stay recording until the next press
 *
 * Starting on the press rather than on the classification is the whole trick. It means no
 * audio is ever lost to a decision we could not have made yet, and a user who taps when they
 * meant to hold does not lose the first half of their sentence — they just get a session that
 * ends on the next tap instead of on the release.
 *
 * WHY THIS ALSO SOLVES THE TERMINALS THAT CANNOT DO IT
 *
 * A terminal that will not report key releases produces presses and nothing else. Feed that
 * through this machine and every press is, by definition, never released, so every press
 * latches — which is exactly the press-to-start, press-to-stop toggle this program had
 * before. The degraded path is not a separate mode with separate bugs; it is this one mode
 * with an event that never arrives. Nothing has to detect anything for it to be right.
 *
 * WHY THERE IS A DELAY AFTER RELEASE
 *
 * Discord keeps transmitting for a moment after the key comes up, because people finish a
 * word slightly after they finish deciding to stop. Cutting audio at the instant of release
 * clips the last syllable, and a clipped last syllable is a transcript that says "archive
 * thi" — which this program would refuse to act on, correctly, and the user would blame the
 * microphone. The tail costs a fraction of a second per utterance and buys the end of every
 * sentence.
 */

/** How the talk key should behave. */
export type PushToTalkMode = 'auto' | 'hold' | 'toggle';

export interface PushToTalkOptions {
  readonly mode: PushToTalkMode;
  /**
   * Below this, a press is a tap and latches instead of stopping on release.
   *
   * Generous on purpose. The failure it prevents — a hold too short to be recognized as one,
   * so speech is cut off at the moment the user started talking — is far more annoying than
   * the failure it causes, which is a latch the user ends with a second tap.
   */
  readonly tapMs: number;
  /** How long to keep recording after the key comes up. */
  readonly releaseDelayMs: number;
}

export const PUSH_TO_TALK_DEFAULTS: PushToTalkOptions = {
  mode: 'auto',
  tapMs: 350,
  releaseDelayMs: 250,
};

/** What the talk key is doing right now, for the machine and for the indicator. */
export type PushToTalkPhase =
  /** Not recording. */
  | 'idle'
  /** Recording, key still down. */
  | 'holding'
  /** Recording, key up, kept open by the release delay. */
  | 'trailing'
  /** Recording, key up, staying open until the next press. */
  | 'latched';

export interface PushToTalkState {
  readonly phase: PushToTalkPhase;
  /** When the current press went down, for telling a tap from a hold. */
  readonly pressedAt: number;
  /** When the trailing tail should end. Only meaningful while trailing. */
  readonly stopAt: number;
}

export type PushToTalkAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'start' }
  | { readonly kind: 'stop' }
  /** Ask to be called back at `at`, so the trailing tail can end on time. */
  | { readonly kind: 'schedule'; readonly at: number };

export interface PushToTalkStep {
  readonly state: PushToTalkState;
  readonly action: PushToTalkAction;
}

export const INITIAL_PUSH_TO_TALK: PushToTalkState = { phase: 'idle', pressedAt: 0, stopAt: 0 };

/**
 * The talk key went down.
 *
 * A press while already recording always stops, whatever put us there. The key is the one
 * control the user has over the microphone, so pressing it when something is listening has
 * to mean "stop" — including during the trailing tail, where the alternative is a press that
 * appears to do nothing because a timer is about to stop the recording anyway.
 */
export function pressTalkKey(state: PushToTalkState, now: number): PushToTalkStep {
  if (state.phase !== 'idle') {
    return { state: INITIAL_PUSH_TO_TALK, action: { kind: 'stop' } };
  }
  return { state: { phase: 'holding', pressedAt: now, stopAt: 0 }, action: { kind: 'start' } };
}

/**
 * The talk key came up.
 *
 * In `toggle` mode the release is ignored entirely, which is what a user who has asked for a
 * toggle means: the key should not stop anything just because they stopped leaning on it.
 */
export function releaseTalkKey(state: PushToTalkState, now: number, options: PushToTalkOptions): PushToTalkStep {
  if (state.phase !== 'holding') return { state, action: { kind: 'none' } };
  if (options.mode === 'toggle') return { state: { ...state, phase: 'latched' }, action: { kind: 'none' } };

  if (now - state.pressedAt < options.tapMs) {
    return { state: { ...state, phase: 'latched' }, action: { kind: 'none' } };
  }

  const stopAt = now + options.releaseDelayMs;
  if (options.releaseDelayMs <= 0) return { state: INITIAL_PUSH_TO_TALK, action: { kind: 'stop' } };
  return { state: { ...state, phase: 'trailing', stopAt }, action: { kind: 'schedule', at: stopAt } };
}

/** Time passed. Ends the trailing tail once it is due. */
export function tickTalkKey(state: PushToTalkState, now: number): PushToTalkStep {
  if (state.phase !== 'trailing') return { state, action: { kind: 'none' } };
  if (now < state.stopAt) return { state, action: { kind: 'schedule', at: state.stopAt } };
  return { state: INITIAL_PUSH_TO_TALK, action: { kind: 'stop' } };
}

/**
 * Something other than the talk key ended the recording.
 *
 * Recording can finish on its own — the maximum length elapses, the recognizer fails, or a
 * spoken "stop listening" is obeyed. The machine has to hear about it, or it would hold a
 * `latched` it can no longer end and the next press would send a stop to a microphone that
 * was already off.
 */
export function resetTalkKey(): PushToTalkState {
  return INITIAL_PUSH_TO_TALK;
}

/** Whether the machine currently believes it is recording. */
export function isTalking(state: PushToTalkState): boolean {
  return state.phase !== 'idle';
}
