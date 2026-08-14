/**
 * Asking the terminal for key releases, so "hold to talk" can mean what it says.
 *
 * A terminal, by default, tells a program that a key went down and never that it came back
 * up. Discord gets key-up from the window system; a program reading a pty gets a byte and
 * nothing else. That single missing event is the whole reason push-to-talk in a terminal is
 * usually a toggle wearing a hold's clothing — which is what this program shipped before, in
 * a help line that told the user to "hold Ctrl+Space" when holding it did nothing.
 *
 * There is a real fix. The kitty keyboard protocol lets a program ask the terminal to report
 * repeat and release events, and it is now implemented widely enough to rely on: kitty, foot,
 * WezTerm, Ghostty, rio, Alacritty, and Windows Terminal from 1.25. It is negotiated with
 * escape codes and costs no dependency, which matters in a program that refuses to add any.
 *
 * WHY THIS FILE IS A NORMALIZER AND NOT A KEY DECODER
 *
 * Turning on event reporting changes the shape of input for *every* key, not just the one we
 * care about: auto-repeat stops arriving as a repeated press and starts arriving as a repeat
 * event, and every key gains a release event. Handed to Node's readline unchanged, releases
 * would be read as phantom keypresses — releasing Up would scroll the list — and holding a
 * key to scroll would quietly stop working.
 *
 * So this file does the smallest thing that can be correct: it rewrites the stream back into
 * the shape readline already understands. Releases are removed, repeats have their event
 * marker stripped so they read as ordinary presses, and the talk key is lifted out entirely
 * and reported separately. Everything else is passed through byte for byte. We do not
 * reimplement key decoding, because the existing decoding works and the bug we are fixing is
 * not in it.
 *
 * WHAT WE DELIBERATELY DO NOT ASK FOR
 *
 * Only the "report event types" flag (0b10) is requested. The neighbouring "disambiguate"
 * flag is more tempting than it looks: it would also re-encode Escape, Tab and every ctrl
 * combination into a form readline does not know, and we would have to own key decoding
 * forever to get one feature. Asking for less keeps every other key on the path that already
 * works, so the blast radius of this file is the talk key and nothing else.
 *
 * Asking for less has one consequence worth stating, because it is the reason the talk key
 * has to be recognized in two encodings at once. Under this flag alone the protocol leaves
 * text-producing keys as plain text and leaves keys that have legacy encodings using them —
 * so the *press* of Ctrl+Space can still arrive as the control code 0x00. A release has no
 * legacy form, so it arrives as an escape sequence regardless. A decoder that understood
 * only the modern form would therefore never see the press, decline to stop on the release,
 * and leave the microphone open: the exact failure this feature exists to prevent.
 */

/** Report key repeat and release events. See the kitty keyboard protocol. */
const FLAG_REPORT_EVENT_TYPES = 0b10;

/**
 * Ask what the terminal is currently reporting, then ask who it is.
 *
 * The device-attributes request is the load-bearing half. A terminal that does not know the
 * keyboard query simply ignores it, and silence is not something a program can wait on
 * safely. Every terminal answers device attributes, so its reply is a marker meaning "I have
 * answered everything you sent" — if it arrives and the keyboard reply did not, the feature
 * is absent rather than slow. This is the detection method the protocol itself recommends.
 */
export const KEYBOARD_QUERY = '\u001b[?u\u001b[c';

/** Push our flags, leaving whatever was there to be restored on the way out. */
export const KEYBOARD_PUSH = `\u001b[>${String(FLAG_REPORT_EVENT_TYPES)}u`;

/** Pop back to the flags that were in force before us. */
export const KEYBOARD_POP = '\u001b[<u';

export type KeyEventType = 'press' | 'repeat' | 'release';

export interface TalkKeyEvent {
  readonly type: KeyEventType;
}

/** What the terminal said when asked, if it said anything. */
export type KeyboardSupport = 'unknown' | 'supported' | 'unsupported';

export interface DecodedInput {
  /** Input to hand to the existing key parser, with event reporting normalized away. */
  readonly passthrough: string;
  /** Talk-key transitions, in arrival order. */
  readonly talk: readonly TalkKeyEvent[];
  /** Set when this chunk answered the support question. */
  readonly support?: KeyboardSupport;
}

/**
 * A key to hold, as the protocol encodes it.
 *
 * `code` is the unshifted Unicode codepoint of the key — 32 for space — and `modifiers` is
 * the raw modifier bitfield, not the wire value, which is this plus one.
 */
export interface TalkKeySpec {
  readonly code: number;
  readonly modifiers: number;
}

const MOD_SHIFT = 0b1;
const MOD_ALT = 0b10;
const MOD_CTRL = 0b100;
const MOD_SUPER = 0b1000;

/** Modifiers that are locks rather than held keys, and so are not part of a shortcut. */
const LOCK_MODIFIERS = 0b11000000;

/** The default talk key: Ctrl+Space. */
export const DEFAULT_TALK_KEY: TalkKeySpec = { code: 32, modifiers: MOD_CTRL };

/**
 * Parse a key description like `ctrl+space` or `alt+t`.
 *
 * Returns undefined rather than a guess for anything unrecognized, so a typo in a config
 * file becomes a message naming the setting instead of a talk key that silently is not the
 * one the user asked for.
 */
/**
 * Ctrl combinations whose control code is another key entirely.
 *
 * In a terminal Ctrl+M is not "M with a modifier held" — it is the byte 0x0d, which is also
 * exactly what Enter sends. Nothing downstream can tell the two apart, so accepting Ctrl+M as
 * the talk key would mean every Enter opened the microphone and no Enter ever submitted a
 * line. The same collision makes Ctrl+I indistinguishable from Tab and Ctrl+H from Backspace.
 *
 * Ctrl+C and Ctrl+[ are refused for a related reason rather than an identical one: they are
 * the two documented ways out of the pane, and a talk key that consumed them would take away
 * the user's escape hatch in exchange for a microphone.
 *
 * Refused at parse time, because the alternative is a config file that looks accepted and a
 * pane in which Enter has silently stopped working.
 */
const RESERVED_CTRL_KEYS: ReadonlyMap<string, string> = new Map([
  ['m', 'Enter'],
  ['i', 'Tab'],
  ['h', 'Backspace'],
  ['j', 'a line feed'],
  ['c', 'Ctrl+C, which always cancels'],
  ['[', 'Escape'],
]);

interface TalkKeyParts {
  readonly modifiers: number;
  readonly base: string | undefined;
}

function splitTalkKey(text: string): TalkKeyParts | undefined {
  const parts = text
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return undefined;

  let modifiers = 0;
  let base: string | undefined;
  for (const part of parts) {
    switch (part) {
      case 'ctrl':
      case 'control':
        modifiers |= MOD_CTRL;
        break;
      case 'alt':
      case 'option':
        modifiers |= MOD_ALT;
        break;
      case 'shift':
        modifiers |= MOD_SHIFT;
        break;
      case 'super':
      case 'cmd':
      case 'command':
      case 'win':
        modifiers |= MOD_SUPER;
        break;
      default:
        // Two names for one key would be two ways to write the same config, so the last
        // non-modifier wins only if there was not already one — `ctrl+a+b` is a mistake.
        if (base !== undefined) return undefined;
        base = part;
    }
  }
  return { modifiers, base };
}

/**
 * What a terminal sends instead, for a key it cannot send as itself.
 *
 * Its own constant because the caller has to tell this case apart from a collision to give
 * useful advice: "pick another key" is the wrong thing to say to someone who typed `t`, since
 * `v` and `b` would fail in exactly the same way. What they need is a modifier.
 */
export const PLAIN_KEY_CONFLICT = 'ordinary typed text';

/**
 * The key this description would collide with, if it would collide with one.
 *
 * Separate from parsing so the refusal can say which key is in the way. "I cannot read
 * ctrl+m as a key" would be a lie — it is perfectly readable, and it is being refused for a
 * reason the user cannot be expected to know unless told.
 */
export function talkKeyConflict(text: string): string | undefined {
  const parts = splitTalkKey(text);
  if (parts === undefined || parts.base === undefined) return undefined;
  // A bare key is refused for a reason of its own, and one worth stating plainly: a terminal
  // sends an unmodified key as the character it types, in both directions and with no event
  // reporting attached. There is nothing for the decoder to lift out of the stream, so the
  // key would never start a recording — and would go on doing whatever it already does in the
  // pane. `q` as the talk key would quit. That is a setting that looks accepted and is not
  // merely useless but actively misleading.
  if (parts.modifiers === 0) return PLAIN_KEY_CONFLICT;
  if (parts.modifiers !== MOD_CTRL) return undefined;
  return RESERVED_CTRL_KEYS.get(parts.base);
}

export function parseTalkKey(text: string): TalkKeySpec | undefined {
  const parts = splitTalkKey(text);
  if (parts === undefined) return undefined;
  if (talkKeyConflict(text) !== undefined) return undefined;

  const code = talkKeyCode(parts.base);
  if (code === undefined) return undefined;
  return { code, modifiers: parts.modifiers };
}

function talkKeyCode(base: string | undefined): number | undefined {
  if (base === undefined) return undefined;
  if (base === 'space') return 32;
  // Only single characters beyond that. Function keys live in a private-use range that
  // varies by key and would need a table we have no user asking for yet.
  if ([...base].length !== 1) return undefined;
  return base.codePointAt(0);
}

/** Render a spec the way a user would type it, for help text and error messages. */
export function describeTalkKey(spec: TalkKeySpec): string {
  const parts: string[] = [];
  if ((spec.modifiers & MOD_CTRL) !== 0) parts.push('Ctrl');
  if ((spec.modifiers & MOD_ALT) !== 0) parts.push('Alt');
  if ((spec.modifiers & MOD_SHIFT) !== 0) parts.push('Shift');
  if ((spec.modifiers & MOD_SUPER) !== 0) parts.push('Super');
  parts.push(spec.code === 32 ? 'Space' : String.fromCodePoint(spec.code).toUpperCase());
  return parts.join('+');
}

/**
 * The plain bytes a terminal sends for this key when it is not reporting events.
 *
 * The talk key has to be recognized in both encodings at once, and not because some
 * terminals are old. A terminal can report the *release* of Ctrl+Space through the enhanced
 * protocol while still sending the *press* as the control code it has always been. Handling
 * only the enhanced form would mean the machine never saw the press that started a
 * recording, and so declined to stop it — the microphone would stay open after the user let
 * go, which is the exact failure push-to-talk exists to prevent.
 *
 * Undefined for keys with no control-code form, which are then recognized only when the
 * terminal reports events — the same keys for which holding could never have worked anyway.
 */
export function legacyTalkSequence(spec: TalkKeySpec): string | undefined {
  if (spec.modifiers !== MOD_CTRL) return undefined;
  if (spec.code === 32) return '\u0000';
  if (spec.code >= 0x61 && spec.code <= 0x7a) return String.fromCharCode(spec.code - 0x60);
  return undefined;
}

/**
 * Control sequence shape: ESC [, parameter bytes, intermediate bytes, one final byte.
 *
 * Matched structurally rather than by listing the sequences we expect, because the point is
 * to find every sequence carrying an event marker — including ones from keys we have never
 * thought about — and pass the rest through untouched.
 */
const CSI = /\u001b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/;

/**
 * Reads a byte stream and hands back one readline already understands.
 *
 * Stateful for one reason: a control sequence can be split across two reads. A decoder that
 * ignored that would, rarely and unreproducibly, leak half an escape sequence into whatever
 * the user was typing. So a trailing partial sequence is held back until the rest arrives.
 */
export class KeyboardDecoder {
  #pending = '';
  #support: KeyboardSupport = 'unknown';
  readonly #talkKey: TalkKeySpec;
  readonly #legacy: string | undefined;

  constructor(talkKey: TalkKeySpec = DEFAULT_TALK_KEY) {
    this.#talkKey = talkKey;
    this.#legacy = legacyTalkSequence(talkKey);
  }

  get support(): KeyboardSupport {
    return this.#support;
  }

  /** Give up waiting for an answer. Used when a terminal answers neither query. */
  settleUnsupported(): void {
    if (this.#support === 'unknown') this.#support = 'unsupported';
  }

  decode(chunk: string): DecodedInput {
    let rest = this.#pending + chunk;
    this.#pending = '';

    let passthrough = '';
    const talk: TalkKeyEvent[] = [];
    let support: KeyboardSupport | undefined;

    for (;;) {
      const at = rest.indexOf('\u001b[');
      if (at < 0) {
        passthrough += this.#takeLegacy(rest, talk);
        break;
      }
      passthrough += this.#takeLegacy(rest.slice(0, at), talk);
      const tail = rest.slice(at);

      const match = CSI.exec(tail);
      if (match === null || match.index !== 0) {
        // An escape that is not yet a complete sequence. Hold it: the remainder is almost
        // certainly in the next read, and guessing now is how half-sequences reach the UI.
        if (isPartialCsi(tail)) {
          this.#pending = tail;
          break;
        }
        passthrough += tail.slice(0, 2);
        rest = tail.slice(2);
        continue;
      }

      const [whole, params = '', intermediates = '', final = ''] = match;
      rest = tail.slice(whole.length);

      const answer = readSupportAnswer(params, final);
      if (answer !== undefined) {
        // Both replies are consumed. Either one reaching the pane would be typed into
        // whatever had focus, which is the classic "my terminal printed ^[[?1u" bug.
        if (this.#support === 'unknown') {
          this.#support = answer;
          support = answer;
        }
        continue;
      }

      const event = readKeyEvent(params, intermediates, final);
      if (event === undefined) {
        passthrough += whole;
        continue;
      }

      if (event.code === this.#talkKey.code && sameModifiers(event.modifiers, this.#talkKey.modifiers)) {
        talk.push({ type: event.type });
        continue;
      }

      // Not the talk key, so it has to go back to being an ordinary keypress. Sequences the
      // terminal never marked are already in that shape and are left exactly as they came —
      // rewriting them would be churn with a chance of being wrong — with one exception. Once
      // the enhancement is on, a terminal folds Caps Lock and Num Lock into the modifier
      // number, and `CSI 1;69C` is not "Ctrl+Right with Caps Lock" to the ordinary key parser,
      // it is unparseable: readline gives up and leaks the tail as literal `c`. So a sequence
      // carrying lock bits is normalized, and one without them is passed through byte for byte.
      if (!event.explicit) {
        passthrough += hasLockModifiers(params) ? `\u001b[${normalizeParams(params)}${intermediates}${final}` : whole;
        continue;
      }
      // A release has no ordinary form and is dropped. A repeat becomes a press, which is
      // what auto-repeat was before we asked for the difference — and what holding a key
      // down to scroll a long folder depends on.
      if (event.type === 'release') continue;
      // Two shapes reach here, and only one can keep its shape. A legacy-CSI sequence like
      // `CSI 1;5:2D` is an arrow with a marker bolted on, and dropping the marker leaves the
      // arrow the key parser has always understood. A `u`-form sequence has no such original:
      // `CSI 127;1:2u` stripped is `CSI 127;1u`, which is not Backspace to any parser — it is
      // an unreadable sequence, and the pane would ignore it. That is why holding Backspace
      // to climb several folders used to climb exactly one: the first press arrived as the
      // ordinary 0x7f byte and every repeat after it arrived as this.
      if (final === 'u') {
        const legacy = legacyKeySequence(event.code, event.modifiers);
        // Dropped when there is no legacy form to fall back to. A repeat we cannot express is
        // one repeat not delivered — the key still works, it just does not auto-repeat. Byte
        // soup in the middle of a filter box would be worse than that by a wide margin.
        if (legacy !== undefined) passthrough += legacy;
        continue;
      }
      passthrough += `\u001b[${normalizeParams(params)}${intermediates}${final}`;
    }

    return support === undefined ? { passthrough, talk } : { passthrough, talk, support };
  }

  /**
   * Lift the talk key's control-code form out of ordinary text.
   *
   * Removed from the passthrough rather than left in it, so the key has exactly one route
   * into the state machine. Leaving it would mean a press counted twice on terminals that
   * send both forms, and a recording that started and immediately stopped.
   */
  #takeLegacy(text: string, talk: TalkKeyEvent[]): string {
    const legacy = this.#legacy;
    if (legacy === undefined || text === '' || !text.includes(legacy)) return text;

    const parts = text.split(legacy);
    for (let i = 1; i < parts.length; i += 1) talk.push({ type: 'press' });
    return parts.join('');
  }
}

/** True when `text` could still become a control sequence once more bytes arrive. */
function isPartialCsi(text: string): boolean {
  if (!text.startsWith('\u001b[')) return false;
  for (const char of text.slice(2)) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x40 && code <= 0x7e) return false;
    if (code < 0x20 || code > 0x3f) return false;
  }
  return true;
}

/**
 * Recognize the two replies that answer "can this terminal report releases?".
 *
 * `CSI ? flags u` is the keyboard protocol answering, which only a terminal that implements
 * it will send. `CSI ? … c` is device attributes, which everything sends — so it means the
 * terminal has finished replying, and if the keyboard answer is not already in hand it is
 * never coming.
 */
function readSupportAnswer(params: string, final: string): KeyboardSupport | undefined {
  if (!params.startsWith('?')) return undefined;
  if (final === 'u') return 'supported';
  if (final === 'c') return 'unsupported';
  return undefined;
}

interface ParsedKeyEvent {
  readonly code: number;
  readonly modifiers: number;
  readonly type: KeyEventType;
  /**
   * Whether the terminal actually marked the event type.
   *
   * A press is the default and is usually sent without a marker, so "this is a press" and
   * "the terminal told me this is a press" are different facts. Only the second one means a
   * sequence needs rewriting before the ordinary key parser sees it.
   */
  readonly explicit: boolean;
}

/**
 * Pull a key event out of a control sequence.
 *
 * Returns something for any sequence that could be a key, not only ones carrying an event
 * marker, because the talk key's press typically arrives unmarked — a decoder that only
 * looked at marked sequences would see the release of a press it never noticed.
 */
function readKeyEvent(params: string, intermediates: string, final: string): ParsedKeyEvent | undefined {
  if (intermediates !== '') return undefined;
  if (params === '' || /[?<>=]/.test(params)) return undefined;

  const fields = params.split(';');
  const [modifierText, eventText] = (fields[1] ?? '').split(':');

  const type = eventText === undefined ? 'press' : eventTypeOf(eventText);
  if (type === undefined) return undefined;

  // A functional key reports its identity in the final byte rather than the first parameter
  // — `CSI 1;5:3A` is an arrow, whose first field is a placeholder. Those can never be the
  // talk key, so they only need to be recognized as events, not identified.
  const code = final === 'u' ? Number.parseInt(fields[0] ?? '', 10) : Number.NaN;
  const wireModifiers = Number.parseInt(modifierText ?? '', 10);
  const modifiers = Number.isFinite(wireModifiers) && wireModifiers > 0 ? wireModifiers - 1 : 0;

  return { code: Number.isFinite(code) ? code : -1, modifiers, type, explicit: eventText !== undefined };
}

function eventTypeOf(text: string): KeyEventType | undefined {
  switch (text) {
    case '1':
      return 'press';
    case '2':
      return 'repeat';
    case '3':
      return 'release';
    default:
      return undefined;
  }
}

/** Compare modifiers ignoring Caps Lock and Num Lock, which are states rather than chords. */
function sameModifiers(actual: number, wanted: number): boolean {
  return (actual & ~LOCK_MODIFIERS) === wanted;
}

/**
 * Rewrite a sequence's parameters into the shape the ordinary key parser expects.
 *
 * Two things are removed, both of which exist only because this program asked for them.
 *
 * The `:event` marker is the obvious one — without it the sequence reads as a plain press.
 *
 * The lock bits are the subtle one. With the enhancement on, a terminal reports Caps Lock and
 * Num Lock in the same modifier number as Ctrl and Alt, so Ctrl+Right becomes `CSI 1;69C` with
 * Caps Lock on and `CSI 1;133C` with Num Lock on. Node's readline only understands modifier
 * numbers up to 16, so it does not merely lose the modifier — it fails to match the sequence
 * at all and leaks the tail as literal text: `c` in the first case, `3c` in the second, typed
 * into whatever had focus. Num Lock is on by default on most desktop keyboards, so this is the
 * common case rather than the exotic one. Locks are states rather than chords and were never
 * part of the shortcut, which is the same reason {@link sameModifiers} ignores them.
 */
function normalizeParams(params: string): string {
  const fields = params.split(';');
  const modifierField = fields[1];
  if (modifierField === undefined) return params;

  const [base = modifierField] = modifierField.split(':');
  const wire = Number.parseInt(base, 10);
  if (!Number.isFinite(wire) || wire <= 0) {
    fields[1] = base;
    return fields.join(';');
  }

  // The wire number is the modifier bitfield plus one, so it has to come back down before the
  // mask and go up again after it — masking 69 directly would give 5 by luck and 133 give 5
  // by accident, and neither would be arithmetic anyone could follow.
  const masked = ((wire - 1) & ~LOCK_MODIFIERS) + 1;
  fields[1] = String(masked);
  return fields.join(';');
}

/** True when the modifier parameter carries Caps Lock or Num Lock. */
function hasLockModifiers(params: string): boolean {
  const modifierField = params.split(';')[1];
  if (modifierField === undefined) return false;
  const wire = Number.parseInt(modifierField.split(':')[0] ?? '', 10);
  return Number.isFinite(wire) && wire > 0 && ((wire - 1) & LOCK_MODIFIERS) !== 0;
}

/**
 * The bytes a terminal would have sent for this key if we had never asked for event reporting.
 *
 * Needed because the enhanced `u`-form is a one-way door: it can express a repeat, which no
 * legacy encoding can, but nothing downstream can read it. So a repeat that arrives in that
 * form has to be translated back rather than merely unmarked.
 *
 * Deliberately conservative. Undefined means "no faithful legacy form exists", and the caller
 * drops the repeat rather than inventing bytes — a key that does not auto-repeat is a small
 * disappointment, and a key that types garbage into a filter box is a bug report.
 *
 * Separate from {@link legacyTalkSequence} despite the overlap, because that one decides which
 * bytes to *remove* from the user's input. Widening this to unmodified keys is right; widening
 * that one would mean a talk key of `t` silently ate every `t` the user typed.
 */
function legacyKeySequence(code: number, modifiers: number): string | undefined {
  // Caps Lock and Num Lock are states, not part of the chord, and a terminal reports them in
  // the same bitfield. Left in, Num Lock alone would make `modifiers` 128 and every branch
  // below would fall through to "no legacy form" — which is to say that with Num Lock on, the
  // default for most desktop keyboards, this whole fix would quietly do nothing.
  const held = modifiers & ~LOCK_MODIFIERS;

  if (held === MOD_CTRL) {
    if (code === 32) return '\u0000';
    if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
    return undefined;
  }
  // Anything else modified — Alt, Shift, Super, or combinations — has no single-byte form
  // worth guessing at, and the terminal would have sent those as legacy CSI sequences anyway.
  if (held !== 0) return undefined;

  switch (code) {
    case 13:
      return '\r';
    case 9:
      return '\t';
    case 27:
      return '\u001b';
    case 127:
      return '\u007f';
    default:
      break;
  }
  // Printable characters are their own encoding. Reachable only in theory — a terminal sends
  // text keys as plain text under the flag we ask for — but a repeat of `j` arriving this way
  // should scroll, not vanish.
  //
  // The upper bound is load-bearing. The keyboard protocol numbers functional keys it has no
  // character for — F13 and up, the keypad, media and modifier keys — inside the Private Use
  // Area, so `String.fromCodePoint` would cheerfully turn a repeat of F13 into U+E00E and type
  // it into whatever had focus. Those keys have no legacy form, which is the whole reason they
  // are numbered this way, so the honest answer is that there is nothing to fall back to.
  if (code >= 0x20 && code !== 0x7f && code < 0xe000) return String.fromCodePoint(code);
  return undefined;
}
