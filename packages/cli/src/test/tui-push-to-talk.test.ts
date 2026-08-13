/**
 * Tests for hold-to-talk: the keyboard negotiation, the decoder, and the state machine.
 *
 * The decoder tests are written against literal byte strings rather than helper builders on
 * purpose. What is being asserted is a wire format we do not control and cannot renegotiate,
 * so a test that constructed the bytes with the same code that parses them would agree with
 * itself about a format the terminal might not share.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';

import {
  DEFAULT_TALK_KEY,
  KEYBOARD_POP,
  KEYBOARD_PUSH,
  KEYBOARD_QUERY,
  KeyboardDecoder,
  describeTalkKey,
  legacyTalkSequence,
  parseTalkKey,
  talkKeyConflict,
} from '../tui/keyboard.js';
import {
  INITIAL_PUSH_TO_TALK,
  PUSH_TO_TALK_DEFAULTS,
  isTalking,
  pressTalkKey,
  releaseTalkKey,
  tickTalkKey,
} from '../tui/push-to-talk.js';
import type { PushToTalkOptions } from '../tui/push-to-talk.js';

const ESC = '\u001b';

describe('the escape codes we send the terminal', () => {
  it('asks only for event reporting, so every other key keeps the encoding that works', () => {
    // Flag 1 (disambiguate) would re-encode Escape, Tab and every ctrl combination into a
    // form the existing key parser does not read. Asking for 0b10 alone is what keeps the
    // blast radius of this feature to the talk key.
    assert.equal(KEYBOARD_PUSH, `${ESC}[>2u`);
  });

  it('follows the keyboard query with a device-attributes request', () => {
    // The second request is the load-bearing one: every terminal answers it, so its reply
    // is the marker meaning "I have answered everything you sent". Without it, a terminal
    // that does not know the keyboard query is indistinguishable from one that is slow.
    assert.equal(KEYBOARD_QUERY, `${ESC}[?u${ESC}[c`);
  });

  it('pops rather than clearing, so the terminal goes back to what it was', () => {
    assert.equal(KEYBOARD_POP, `${ESC}[<u`);
  });
});

describe('reading the terminal reply', () => {
  it('treats a keyboard-protocol reply as support', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`${ESC}[?2u`);
    assert.equal(decoded.support, 'supported');
    assert.equal(decoder.support, 'supported');
  });

  it('treats device attributes arriving alone as a refusal', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`${ESC}[?62;c`);
    assert.equal(decoded.support, 'unsupported');
  });

  it('believes the keyboard reply even though device attributes follow it', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`${ESC}[?2u${ESC}[?62;22c`);
    assert.equal(decoded.support, 'supported');
    assert.equal(decoder.support, 'supported');
  });

  it('never lets either reply reach the screen', () => {
    // A reply printed into whatever had focus is the classic "my terminal typed ^[[?1u into
    // my search box" bug, and it is only ever visible to the user, never to the author.
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`${ESC}[?2u${ESC}[?62;22c`);
    assert.equal(decoded.passthrough, '');
  });

  it('settles on unsupported when the terminal answers nothing at all', () => {
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.support, 'unknown');
    decoder.settleUnsupported();
    assert.equal(decoder.support, 'unsupported');
  });

  it('does not let the backstop overrule an answer that already arrived', () => {
    const decoder = new KeyboardDecoder();
    decoder.decode(`${ESC}[?2u`);
    decoder.settleUnsupported();
    assert.equal(decoder.support, 'supported');
  });
});

describe('the talk key', () => {
  it('reports a press, a repeat and a release of Ctrl+Space', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`${ESC}[32;5u${ESC}[32;5:2u${ESC}[32;5:3u`);
    assert.deepEqual(decoded.talk, [{ type: 'press' }, { type: 'repeat' }, { type: 'release' }]);
    assert.equal(decoded.passthrough, '');
  });

  it('recognizes the control code a terminal sends when it is not reporting events', () => {
    // The press can arrive in the old encoding while the release arrives in the new one. A
    // decoder that only understood the new form would miss the press that started the
    // recording, and then decline to stop it when the key came up.
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode('\u0000');
    assert.deepEqual(decoded.talk, [{ type: 'press' }]);
    assert.equal(decoded.passthrough, '');
  });

  it('pairs a legacy press with an enhanced release', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`\u0000${ESC}[32;5:3u`);
    assert.deepEqual(decoded.talk, [{ type: 'press' }, { type: 'release' }]);
  });

  it('ignores caps lock and num lock, which are states rather than chords', () => {
    // Modifier 69 is ctrl + caps_lock + 1. A user with caps lock on still pressed the talk
    // key, and refusing to notice would be a bug they could not possibly diagnose.
    const decoder = new KeyboardDecoder();
    assert.deepEqual(decoder.decode(`${ESC}[32;69:3u`).talk, [{ type: 'release' }]);
  });

  it('does not fire on Space without Ctrl', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`${ESC}[32;1:3u`);
    assert.deepEqual(decoded.talk, []);
  });

  it('follows a reconfigured talk key', () => {
    const spec = parseTalkKey('ctrl+t');
    assert.ok(spec !== undefined);
    const decoder = new KeyboardDecoder(spec);
    assert.deepEqual(decoder.decode(`${ESC}[116;5:3u`).talk, [{ type: 'release' }]);
    assert.deepEqual(decoder.decode('\u0014').talk, [{ type: 'press' }]);
    assert.deepEqual(decoder.decode('\u0000').talk, []);
  });
});

describe('normalizing everything that is not the talk key', () => {
  it('drops release events, which would otherwise read as phantom keypresses', () => {
    // This is the regression that makes the whole feature unusable if it slips: with event
    // reporting on, letting go of Up would scroll the list a second time.
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[1;1:3A`).passthrough, '');
  });

  it('turns a repeat back into a press, so holding a key still scrolls', () => {
    // Asking for event types is what stops auto-repeat arriving as a repeated press. Left
    // alone, holding j to move down a long folder would move exactly one row.
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[1;1:2B`).passthrough, `${ESC}[1;1B`);
  });

  it('keeps the modifiers when it strips the event marker', () => {
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[1;5:2C`).passthrough, `${ESC}[1;5C`);
  });

  it('gives a repeat back its old encoding when stripping the marker would not be enough', () => {
    // Backspace, Enter and Tab have no legacy *escape sequence* — they are single bytes — so a
    // repeat of one arrives in kitty's `u` form, and `CSI 127;1u` is not Backspace to anything
    // downstream. Unmarking it is not normalizing it. The measured symptom was holding
    // Backspace to climb out of a deep folder and climbing exactly one level.
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[127;1:2u`).passthrough, '\u007f');
    assert.equal(decoder.decode(`${ESC}[13;1:2u`).passthrough, '\r');
    assert.equal(decoder.decode(`${ESC}[9;1:2u`).passthrough, '\t');
    assert.equal(decoder.decode(`${ESC}[27;1:2u`).passthrough, '\u001b');
  });

  it('gives a modified repeat back its control code', () => {
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[100;5:2u`).passthrough, '\u0004');
  });

  it('drops a repeat it cannot express rather than emitting bytes nothing can read', () => {
    // Alt+Backspace has no faithful single encoding to fall back to. One repeat not delivered
    // is a key that does not auto-repeat; a guess is byte soup in whatever had focus.
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[127;3:2u`).passthrough, '');
  });

  it('emits nothing readable-looking for a functional key it cannot express', () => {
    // The keyboard protocol numbers keys it has no character for — F13, the keypad, media
    // keys — inside the Private Use Area. Turning 57358 into a character would type U+E00E
    // into whatever had focus, which is a worse outcome than the repeat not arriving.
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[57358;1:2u`).passthrough, '');
    assert.equal(decoder.decode(`${ESC}[57441;1:2u`).passthrough, '');
  });

  it('translates a repeat the same way whether or not a lock is on', () => {
    // Caps Lock is 64 and Num Lock is 128 in the same modifier number as Ctrl and Alt, so a
    // Backspace repeat is `;1` with no locks, `;65` with Caps Lock and `;129` with Num Lock.
    // Num Lock is on by default on most desktop keyboards — treating its bit as "some modifier
    // I do not recognize" would mean the auto-repeat fix worked only on laptops.
    const decoder = new KeyboardDecoder();
    for (const wire of [1, 65, 129, 193]) {
      assert.equal(decoder.decode(`${ESC}[127;${String(wire)}:2u`).passthrough, '\u007f', `;${String(wire)}`);
    }
    // And the same for a chord, where the lock rides along with the Ctrl bit: 5, 69, 133.
    for (const wire of [5, 69, 133]) {
      assert.equal(decoder.decode(`${ESC}[100;${String(wire)}:2u`).passthrough, '\u0004', `;${String(wire)}`);
    }
  });

  it('strips lock bits out of a sequence it passes through', () => {
    // Not churn for its own sake: `CSI 1;69C` is not a modified arrow to the ordinary key
    // parser, it is unparseable, and the leftovers arrive as literal typed characters.
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[1;69C`).passthrough, `${ESC}[1;5C`);
    assert.equal(decoder.decode(`${ESC}[1;133C`).passthrough, `${ESC}[1;5C`);
    assert.equal(decoder.decode(`${ESC}[1;69:2C`).passthrough, `${ESC}[1;5C`);
    // A sequence with no lock bits is left exactly as it came.
    assert.equal(decoder.decode(`${ESC}[1;5C`).passthrough, `${ESC}[1;5C`);
    assert.equal(decoder.decode(`${ESC}[A`).passthrough, `${ESC}[A`);
  });

  it('never emits a u-form sequence or a private-use character, whatever it was given', () => {
    // The invariant behind the tests above, checked directly: anything in the `u` form is by
    // definition something the ordinary key parser cannot read, so it must be translated into
    // a real legacy encoding or dropped — never forwarded, and never approximated.
    const decoder = new KeyboardDecoder();
    for (const code of [9, 13, 27, 32, 100, 127, 57358, 57441, 63743]) {
      for (const modifiers of [1, 3, 5, 9, 65, 69, 129, 133, 193]) {
        const { passthrough } = decoder.decode(`${ESC}[${code};${modifiers}:2u`);
        const label = `CSI ${code};${modifiers}:2u leaked as ${JSON.stringify(passthrough)}`;
        assert.ok(!passthrough.endsWith('u'), label);
        for (const char of passthrough) {
          const point = char.codePointAt(0) ?? 0;
          assert.ok(point < 0xe000 || point > 0xf8ff, label);
        }
      }
    }
  });

  it('passes ordinary sequences through untouched', () => {
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[A${ESC}[B`).passthrough, `${ESC}[A${ESC}[B`);
  });

  it('passes plain typing through untouched', () => {
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode('budget').passthrough, 'budget');
  });

  it('holds a sequence split across two reads instead of leaking half of it', () => {
    const decoder = new KeyboardDecoder();
    assert.equal(decoder.decode(`${ESC}[32;5`).passthrough, '');
    assert.deepEqual(decoder.decode(':3u').talk, [{ type: 'release' }]);
  });

  it('keeps text that arrives in the same read as a talk-key event', () => {
    const decoder = new KeyboardDecoder();
    const decoded = decoder.decode(`ab${ESC}[32;5:3ucd`);
    assert.equal(decoded.passthrough, 'abcd');
    assert.deepEqual(decoded.talk, [{ type: 'release' }]);
  });
});

describe('what comes out is something the real key parser can read', () => {
  /**
   * The other tests here compare strings, which proves the decoder does what it was written
   * to do and not that what it does is useful. This one feeds the output to the same
   * `readline` that the pane feeds it to, because "normalized" is only true relative to a
   * parser — a sequence can look perfectly reasonable and still arrive as `name: undefined`.
   *
   * That is not hypothetical. Rewriting a repeat into kitty's own `CSI 106;1u` form looks
   * like the obvious normalization and is a dead end: readline has no idea what it is, so
   * holding a key would do nothing at all. Only the legacy encodings survive the trip.
   */
  function keysFrom(bytes: string): Promise<readonly (string | undefined)[]> {
    const stream = new PassThrough();
    emitKeypressEvents(stream);
    const names: (string | undefined)[] = [];
    stream.on('keypress', (_char: string, key: { name?: string } | undefined) => {
      names.push(key?.name);
    });
    stream.write(bytes);
    return new Promise((resolve) => {
      setImmediate(() => {
        resolve(names);
      });
    });
  }

  it('a normalized repeat of an arrow key still reads as that arrow key', async () => {
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`${ESC}[1;1:2A`);
    assert.deepEqual(await keysFrom(passthrough), ['up']);
  });

  it('a repeat of Backspace still reads as backspace, so holding it keeps climbing', async () => {
    // The failure this pins is quiet, which is why it is pinned here and not only as a string
    // comparison: the first press of Backspace arrives as the plain byte and works, so the
    // feature looks fine. Only the second folder up never happens.
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`\u007f${ESC}[127;1:2u${ESC}[127;1:2u`);
    assert.deepEqual(await keysFrom(passthrough), ['backspace', 'backspace', 'backspace']);
  });

  it('a repeat of Enter and Tab reads as the key it is', async () => {
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`${ESC}[13;1:2u${ESC}[9;1:2u`);
    assert.deepEqual(await keysFrom(passthrough), ['return', 'tab']);
  });

  it('a lock being on does not turn an arrow key into typed letters', async () => {
    // The failure being pinned is that readline does not understand modifier numbers above
    // 16, so it declines to match `CSI 1;133C` at all and hands back the tail as text — the
    // user holding Ctrl+Right with Num Lock on would watch "3c" appear in the filter box.
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`${ESC}[1;69C${ESC}[1;133C${ESC}[1;69:2C`);
    assert.deepEqual(await keysFrom(passthrough), ['right', 'right', 'right']);
  });

  it('a repeat of Backspace with Num Lock on still reads as backspace', async () => {
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`${ESC}[127;129:2u${ESC}[127;65:2u`);
    assert.deepEqual(await keysFrom(passthrough), ['backspace', 'backspace']);
  });

  it('a normalized repeat keeps its modifier', async () => {
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`${ESC}[1;5:2B`);
    const stream = new PassThrough();
    emitKeypressEvents(stream);
    const keys: { name?: string; ctrl?: boolean }[] = [];
    stream.on('keypress', (_char: string, key: { name?: string; ctrl?: boolean }) => keys.push(key));
    stream.write(passthrough);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(keys.map((key) => [key.name, key.ctrl]), [['down', true]]);
  });

  it('a release of an arrow key reaches the parser as nothing at all', async () => {
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode(`${ESC}[1;1:3A`);
    assert.deepEqual(await keysFrom(passthrough), []);
  });

  it('ordinary typing is unchanged all the way through', async () => {
    const decoder = new KeyboardDecoder();
    const { passthrough } = decoder.decode('abc');
    assert.deepEqual(await keysFrom(passthrough), ['a', 'b', 'c']);
  });
});

describe('reading a talk key from configuration', () => {
  it('understands the default', () => {
    assert.deepEqual(parseTalkKey('ctrl+space'), DEFAULT_TALK_KEY);
  });

  it('is not case sensitive', () => {
    assert.deepEqual(parseTalkKey('Ctrl+Space'), DEFAULT_TALK_KEY);
  });

  it('accepts the names a Mac user would reach for', () => {
    assert.deepEqual(parseTalkKey('option+t'), parseTalkKey('alt+t'));
  });

  it('refuses a typo rather than guessing at it', () => {
    // A talk key that silently is not the one in the config file is a key the user presses
    // repeatedly while nothing happens, with no way to tell why.
    assert.equal(parseTalkKey('ctrl+spcae'), undefined);
    assert.equal(parseTalkKey('ctrl+'), undefined);
    assert.equal(parseTalkKey(''), undefined);
    assert.equal(parseTalkKey('ctrl+a+b'), undefined);
  });

  it('refuses a key whose control code is another key', () => {
    // Not a style rule — a measurement. Ctrl+M and Enter are the same byte on the wire, so a
    // decoder that stripped the talk key from the stream would strip every Enter with it.
    // The collision is demonstrated here rather than asserted from a list, so the refusal
    // stays tied to the reason for it.
    for (const [key, code] of [
      ['ctrl+m', '\r'],
      ['ctrl+i', '\t'],
      ['ctrl+h', '\b'],
      ['ctrl+j', '\n'],
      ['ctrl+c', '\u0003'],
    ] as const) {
      assert.equal(legacyTalkSequence({ code: key.charCodeAt(5), modifiers: 0b100 }), code, key);
      assert.equal(parseTalkKey(key), undefined, key);
      assert.ok(talkKeyConflict(key), key);
    }
    assert.equal(parseTalkKey('ctrl+['), undefined);

    // Neighbouring keys are fine — only the collisions are refused.
    assert.deepEqual(parseTalkKey('ctrl+k'), { code: 107, modifiers: 0b100 });
    assert.equal(talkKeyConflict('ctrl+k'), undefined);
    // And the letters are only reserved with Ctrl, which is what creates the collision.
    assert.deepEqual(parseTalkKey('alt+m'), { code: 109, modifiers: 0b10 });
  });

  it('refuses a key with no modifier, which could never be held', () => {
    // A terminal sends an unmodified key as the character it types — there is no press, no
    // release and nothing for the decoder to lift out of the stream. `q` as the talk key
    // would not start a recording; it would quit the pane. Accepting it would be accepting a
    // setting that does the opposite of what it says.
    for (const key of ['t', 'space', 'q', 'F1']) {
      assert.equal(parseTalkKey(key), undefined, key);
      assert.equal(talkKeyConflict(key), 'ordinary typed text', key);
    }
    // The same keys are fine the moment they carry a modifier the terminal has to report.
    assert.deepEqual(parseTalkKey('ctrl+t'), { code: 116, modifiers: 0b100 });
    assert.deepEqual(parseTalkKey('alt+space'), { code: 32, modifiers: 0b10 });
  });

  it('describes a key the way the user would type it', () => {
    assert.equal(describeTalkKey(DEFAULT_TALK_KEY), 'Ctrl+Space');
  });

  it('knows which keys have a control-code form and which do not', () => {
    assert.equal(legacyTalkSequence(DEFAULT_TALK_KEY), '\u0000');
    assert.equal(legacyTalkSequence({ code: 116, modifiers: 0b100 }), '\u0014');
    // Alt+T has no control code, so it can only ever be seen through the enhanced protocol.
    assert.equal(legacyTalkSequence({ code: 116, modifiers: 0b10 }), undefined);
  });
});

describe('hold, tap and latch', () => {
  const options: PushToTalkOptions = { mode: 'auto', tapMs: 350, releaseDelayMs: 250 };

  it('starts recording the moment the key goes down', () => {
    // Before classification, deliberately. Waiting to find out whether this was a tap or a
    // hold would throw away the beginning of the sentence either way.
    const step = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    assert.equal(step.action.kind, 'start');
    assert.equal(step.state.phase, 'holding');
  });

  it('stops after the release delay when the key was held', () => {
    const down = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    const up = releaseTalkKey(down.state, 2000, options);
    assert.deepEqual(up.action, { kind: 'schedule', at: 2250 });
    assert.equal(up.state.phase, 'trailing');

    assert.equal(tickTalkKey(up.state, 2100).action.kind, 'schedule');
    const done = tickTalkKey(up.state, 2250);
    assert.equal(done.action.kind, 'stop');
    assert.equal(done.state.phase, 'idle');
  });

  it('keeps recording after a quick tap, and stops on the next press', () => {
    const down = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    const up = releaseTalkKey(down.state, 1100, options);
    assert.equal(up.action.kind, 'none');
    assert.equal(up.state.phase, 'latched');

    const again = pressTalkKey(up.state, 3000);
    assert.equal(again.action.kind, 'stop');
    assert.equal(again.state.phase, 'idle');
  });

  it('latches when the terminal never reports a release', () => {
    // The degraded path is not a second mode with its own bugs. It is this mode with an
    // event that never arrives, which is why nothing has to detect anything for it to work.
    const down = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    assert.ok(isTalking(down.state));
    const again = pressTalkKey(down.state, 9000);
    assert.equal(again.action.kind, 'stop');
  });

  it('stops immediately when the release delay is zero', () => {
    const down = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    const up = releaseTalkKey(down.state, 2000, { ...options, releaseDelayMs: 0 });
    assert.equal(up.action.kind, 'stop');
    assert.equal(up.state.phase, 'idle');
  });

  it('ignores the release entirely when the user asked for a toggle', () => {
    const down = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    const up = releaseTalkKey(down.state, 5000, { ...options, mode: 'toggle' });
    assert.equal(up.action.kind, 'none');
    assert.equal(up.state.phase, 'latched');
  });

  it('lets a press during the trailing tail stop the recording', () => {
    // Otherwise the key appears to do nothing for a quarter of a second, which reads as a
    // dropped keypress rather than as a recording that was already ending.
    const down = pressTalkKey(INITIAL_PUSH_TO_TALK, 1000);
    const up = releaseTalkKey(down.state, 2000, options);
    const again = pressTalkKey(up.state, 2100);
    assert.equal(again.action.kind, 'stop');
  });

  it('does nothing on a release it never saw the press for', () => {
    assert.equal(releaseTalkKey(INITIAL_PUSH_TO_TALK, 1000, options).action.kind, 'none');
  });

  it('defaults to a tail long enough to keep the last word', () => {
    assert.ok(PUSH_TO_TALK_DEFAULTS.releaseDelayMs > 0);
    assert.equal(PUSH_TO_TALK_DEFAULTS.mode, 'auto');
  });
});
