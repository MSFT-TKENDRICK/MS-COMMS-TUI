/**
 * Naming is where every "X as a filesystem" project breaks, so it gets the harshest tests.
 *
 * The cases here are not hypothetical. Each one is a documented failure mode from the
 * prior art survey: subjects containing slashes that silently fabricated directory levels,
 * Windows device names that made a message unopenable, emoji that overflowed a byte limit
 * a character count said was fine, and case-insensitive filesystems that collapsed two
 * distinct messages into one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MAX_BYTES,
  NameAllocator,
  byteLength,
  collisionKey,
  inferExtension,
  sanitizeSegment,
  timestampPrefix,
  truncateBytes,
} from '../naming.js';

describe('sanitizeSegment', () => {
  it('preserves ordinary readable text, spaces included', () => {
    assert.equal(sanitizeSegment('Re: Quarterly planning'), 'Re- Quarterly planning');
    assert.equal(sanitizeSegment('Budget review 2026'), 'Budget review 2026');
  });

  it('never fabricates a directory level from a slash in a subject', () => {
    // The classic mail-FUSE bug: `ls Inbox` shows a directory that does not exist.
    assert.ok(!sanitizeSegment('Q3/Q4 forecast').includes('/'));
    assert.ok(!sanitizeSegment('C:\\Users\\report').includes('\\'));
    assert.ok(!sanitizeSegment('a/b/c/d').includes('/'));
  });

  it('replaces every character Windows rejects', () => {
    const result = sanitizeSegment('a<b>c:d"e|f?g*h');
    for (const bad of ['<', '>', ':', '"', '|', '?', '*']) {
      assert.ok(!result.includes(bad), `${bad} survived sanitization`);
    }
  });

  it('escapes reserved DOS device names, with or without an extension', () => {
    // `CON.txt` is as reserved as `CON`. Getting this wrong makes a message unopenable
    // on Windows with an error that names neither the message nor the reason.
    assert.equal(sanitizeSegment('CON'), '_CON');
    assert.equal(sanitizeSegment('con.eml'), '_con.eml');
    assert.equal(sanitizeSegment('LPT9.txt'), '_LPT9.txt');
    assert.equal(sanitizeSegment('NUL'), '_NUL');
    // Only the exact device names, not anything that starts with one.
    assert.equal(sanitizeSegment('CONTRACT'), 'CONTRACT');
    assert.equal(sanitizeSegment('COMMS'), 'COMMS');
  });

  it('strips control characters and bidi overrides', () => {
    // U+202E flips visual order, so `report\u202Egpj.exe` renders as `reportexe.jpg`.
    const spoofed = sanitizeSegment('report\u202Egpj.exe');
    assert.ok(!/[\u202A-\u202E]/.test(spoofed));
    assert.ok(!/[\u0000-\u001F]/.test(sanitizeSegment('bell\u0007tab\u0009')));
    assert.ok(!sanitizeSegment('zero\u200Bwidth').includes('\u200B'));
  });

  it('removes leading dots and trailing dots or spaces', () => {
    assert.ok(!sanitizeSegment('.hidden').startsWith('.'));
    assert.ok(!sanitizeSegment('trailing...').endsWith('.'));
    assert.ok(!sanitizeSegment('trailing   ').endsWith(' '));
  });

  it('collapses whitespace runs, including newlines in a subject', () => {
    assert.equal(sanitizeSegment('a\n\n   b\tc'), 'a b c');
  });

  it('never returns an empty string', () => {
    for (const input of ['', '...', '   ', '///', '\u0000', '\u200B', '\u202E']) {
      const result = sanitizeSegment(input);
      assert.ok(result.length > 0, `empty result for ${JSON.stringify(input)}`);
    }
  });

  it('budgets by UTF-8 bytes, not characters', () => {
    // 100 four-byte emoji is 400 bytes but only 100 characters. A `.slice(255)` here
    // produces a name the filesystem rejects.
    const emoji = '\u{1F600}'.repeat(100);
    const result = sanitizeSegment(emoji, { maxBytes: 40 });
    assert.ok(byteLength(result) <= 40, `${String(byteLength(result))} bytes exceeds 40`);
  });

  it('never splits a surrogate pair when truncating', () => {
    const result = sanitizeSegment('\u{1F600}'.repeat(20), { maxBytes: 11 });
    assert.ok(byteLength(result) <= 11);
    // Every retained code point must still be a whole emoji.
    assert.equal([...result].length * 4, byteLength(result));
  });

  it('protects the extension from truncation so globbing keeps working', () => {
    const long = `${'x'.repeat(500)}.eml`;
    const result = sanitizeSegment(long, { maxBytes: 40 });
    assert.ok(result.endsWith('.eml'), `lost the extension: ${result}`);
    assert.ok(byteLength(result) <= 40);
  });

  it('does not mistake a version number for an extension', () => {
    // `.4 release` is not an extension; `.eml` is. Both directions are user-visible.
    assert.equal(inferExtension('Re: v2.4 release'), '');
    assert.equal(inferExtension('2026-08-11 Budget.eml'), '.eml');
    assert.equal(inferExtension('no dot here'), '');
    assert.equal(inferExtension('trailing.'), '');
    assert.equal(inferExtension('long.extensionname'), '');
  });

  it('normalizes Unicode so identical-looking names compare equal', () => {
    const composed = sanitizeSegment('caf\u00E9');
    const decomposed = sanitizeSegment('cafe\u0301');
    assert.equal(composed, decomposed);
  });

  it('survives an extension larger than the whole byte budget', () => {
    const result = sanitizeSegment('note.eml', { maxBytes: 2, extension: '.eml' });
    assert.ok(result.length > 0);
    assert.ok(byteLength(result) <= 4);
  });

  it('uses the fallback when everything is stripped', () => {
    assert.equal(sanitizeSegment('...', { fallback: 'untitled' }), 'untitled');
    assert.equal(sanitizeSegment('\u200B\u200B', { fallback: 'no subject' }), 'no subject');
  });
});

describe('sanitizeSegment with allowSlashes', () => {
  it('keeps separators but sanitizes each segment on its own', () => {
    const result = sanitizeSegment('Inbox/Q3:Q4/budget.eml', { allowSlashes: true });
    assert.equal(result, 'Inbox/Q3-Q4/budget.eml');
  });

  it('applies the byte budget per segment, not to the whole path', () => {
    const result = sanitizeSegment(`${'a'.repeat(300)}/${'b'.repeat(300)}.eml`, {
      allowSlashes: true,
      maxBytes: 20,
    });
    for (const part of result.split('/')) {
      assert.ok(byteLength(part) <= 20, `segment too long: ${part}`);
    }
    assert.ok(result.endsWith('.eml'));
  });

  it('protects only the final segment from losing its extension', () => {
    const result = sanitizeSegment('folder.v2/message.eml', { allowSlashes: true });
    assert.ok(result.endsWith('.eml'));
    assert.equal(result.split('/').length, 2);
  });

  it('escapes a device name in any segment', () => {
    assert.equal(sanitizeSegment('CON/PRN/x.eml', { allowSlashes: true }), '_CON/_PRN/x.eml');
  });

  it('drops empty segments rather than emitting a double slash', () => {
    assert.ok(!sanitizeSegment('a//b', { allowSlashes: true }).includes('//'));
  });
});

describe('collisionKey', () => {
  it('is case-insensitive, because Windows and macOS are', () => {
    assert.equal(collisionKey('Re: Budget'), collisionKey('RE: BUDGET'));
  });

  it('folds Unicode encodings together', () => {
    assert.equal(collisionKey('caf\u00E9.eml'), collisionKey('cafe\u0301.eml'));
  });

  it('keeps genuinely different names apart', () => {
    assert.notEqual(collisionKey('budget.eml'), collisionKey('budgets.eml'));
  });
});

describe('NameAllocator', () => {
  it('leaves non-colliding names completely untouched', () => {
    const allocator = new NameAllocator();
    assert.equal(allocator.allocate('alpha.eml'), 'alpha.eml');
    assert.equal(allocator.allocate('beta.eml'), 'beta.eml');
  });

  it('adds ~N only to the duplicates', () => {
    const allocator = new NameAllocator();
    assert.equal(allocator.allocate('Budget.eml'), 'Budget.eml');
    assert.equal(allocator.allocate('Budget.eml'), 'Budget~2.eml');
    assert.equal(allocator.allocate('Budget.eml'), 'Budget~3.eml');
  });

  it('places the suffix before the extension so globs still match', () => {
    const allocator = new NameAllocator();
    allocator.allocate('note.eml');
    assert.ok(allocator.allocate('note.eml').endsWith('.eml'));
  });

  it('treats case-different duplicates as duplicates', () => {
    const allocator = new NameAllocator();
    assert.equal(allocator.allocate('Budget.eml'), 'Budget.eml');
    assert.equal(allocator.allocate('BUDGET.eml'), 'BUDGET~2.eml');
  });

  it('never hands out a name that a later literal input already claimed', () => {
    // The subtle one: `x~2.eml` arriving as a real subject must not be handed out again
    // when `x.eml` later needs a suffix.
    const allocator = new NameAllocator();
    assert.equal(allocator.allocate('x.eml'), 'x.eml');
    assert.equal(allocator.allocate('x~2.eml'), 'x~2.eml');
    const third = allocator.allocate('x.eml');
    assert.notEqual(third, 'x~2.eml');
    assert.equal(third, 'x~3.eml');
  });

  it('keeps the result within the byte budget once a suffix is added', () => {
    const allocator = new NameAllocator({ maxBytes: 24 });
    const long = `${'x'.repeat(200)}.eml`;
    for (let i = 0; i < 12; i += 1) {
      const name = allocator.allocate(long);
      assert.ok(byteLength(name) <= 24, `${name} is ${String(byteLength(name))} bytes`);
      assert.ok(name.endsWith('.eml'));
    }
  });

  it('produces unique names for a large run of identical subjects', () => {
    const allocator = new NameAllocator();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const name = allocator.allocate('Daily standup.eml');
      assert.ok(!seen.has(collisionKey(name)), `duplicate: ${name}`);
      seen.add(collisionKey(name));
    }
    assert.equal(seen.size, 500);
  });

  it('honours reserved literal names', () => {
    const allocator = new NameAllocator();
    allocator.reserve('attachments');
    assert.ok(allocator.has('Attachments'));
    assert.equal(allocator.allocate('attachments'), 'attachments~2');
  });

  it('dedupes multi-segment search-hit names', () => {
    const allocator = new NameAllocator({ allowSlashes: true });
    assert.equal(allocator.allocate('Inbox/note.eml'), 'Inbox/note.eml');
    assert.equal(allocator.allocate('Archive/note.eml'), 'Archive/note.eml');
    assert.equal(allocator.allocate('Inbox/note.eml'), 'Inbox/note~2.eml');
  });
});

describe('truncateBytes', () => {
  it('returns the input unchanged when it already fits', () => {
    assert.equal(truncateBytes('short', 100), 'short');
  });

  it('returns empty for a non-positive budget', () => {
    assert.equal(truncateBytes('anything', 0), '');
    assert.equal(truncateBytes('anything', -5), '');
  });

  it('cuts on a character boundary', () => {
    assert.equal(truncateBytes('\u{1F600}\u{1F600}', 7), '\u{1F600}');
    assert.equal(truncateBytes('\u{1F600}', 3), '');
  });

  it('counts multi-byte characters correctly', () => {
    assert.equal(byteLength('caf\u00E9'), 5);
    assert.equal(byteLength('\u{1F600}'), 4);
    assert.equal(byteLength(''), 0);
  });
});

describe('timestampPrefix', () => {
  it('sorts lexicographically in date order', () => {
    const early = timestampPrefix(new Date(2026, 0, 2));
    const late = timestampPrefix(new Date(2026, 10, 20));
    assert.ok(early < late);
    assert.equal(early, '2026-01-02');
  });

  it('never emits a colon, which Windows rejects', () => {
    const stamped = timestampPrefix(new Date(2026, 7, 11, 14, 3), true);
    assert.ok(!stamped.includes(':'));
    assert.equal(stamped, '2026-08-11T14-03');
  });

  it('degrades to a readable word for an invalid date', () => {
    assert.equal(timestampPrefix(new Date('nonsense')), 'undated');
  });
});

describe('defaults', () => {
  it('keeps the default budget under every common component limit', () => {
    assert.ok(DEFAULT_MAX_BYTES <= 255);
    assert.ok(DEFAULT_MAX_BYTES > 0);
  });
});
