/**
 * Embedding tests.
 *
 * The thing being defended here is honesty about what these vectors are. They are a
 * hashing trick over words, not a language model, so the tests assert the properties that
 * actually hold — same words rank together, unrelated words do not, encoding survives a
 * round trip through the database — and deliberately do not assert semantic similarity,
 * because the module does not provide it and a test claiming otherwise would be the first
 * step towards someone believing it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DIMENSIONS,
  cosineSimilarity,
  decodeVector,
  embeddableText,
  encodeVector,
  hashEmbed,
  hashEmbedder,
  vectorLiteral,
} from '../vector.js';

describe('hashEmbed', () => {
  it('produces a unit vector of the requested width', () => {
    const vector = hashEmbed('quarterly budget review', 64);
    assert.equal(vector.length, 64);
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-6, `expected unit length, got ${String(magnitude)}`);
  });

  it('is deterministic', () => {
    assert.deepEqual([...hashEmbed('budget', 32)], [...hashEmbed('budget', 32)]);
  });

  it('ranks shared vocabulary above unrelated vocabulary', () => {
    const budget = hashEmbed('quarterly budget review meeting');
    const overlapping = hashEmbed('budget review for the quarter');
    const unrelated = hashEmbed('server outage incident postmortem');

    assert.ok(
      cosineSimilarity(budget, overlapping) > cosineSimilarity(budget, unrelated),
      'shared words should score higher than unrelated ones',
    );
  });

  it('gives an empty string a zero vector rather than throwing', () => {
    const vector = hashEmbed('   ', 16);
    assert.equal(vector.length, 16);
    assert.ok(vector.every((value) => value === 0));
    // And a zero vector must not poison similarity with a NaN from dividing by zero.
    assert.equal(cosineSimilarity(vector, hashEmbed('anything', 16)), 0);
  });

  it('matches a word against a longer word containing it, via trigrams', () => {
    // "budget" vs "budgeting" share no whole token, so a pure bag-of-words embedding
    // would call them unrelated. Character trigrams are what make prefix-ish matches work.
    const similarity = cosineSimilarity(hashEmbed('budget'), hashEmbed('budgeting'));
    assert.ok(similarity > 0, `expected some overlap, got ${String(similarity)}`);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for a vector against itself', () => {
    const vector = hashEmbed('anything at all');
    assert.ok(Math.abs(cosineSimilarity(vector, vector) - 1) < 1e-6);
  });

  it('returns 0 for mismatched widths rather than reading past the end', () => {
    assert.equal(cosineSimilarity(hashEmbed('a', 16), hashEmbed('a', 32)), 0);
  });
});

describe('encodeVector', () => {
  it('round-trips through the little-endian float32 layout libSQL uses', () => {
    const original = hashEmbed('budget review', 32);
    const decoded = decodeVector(encodeVector(original));

    assert.equal(decoded.length, original.length);
    for (const [index, value] of original.entries()) {
      // float32 loses precision against the float64 source; the tolerance is that loss,
      // not slack in the test.
      assert.ok(Math.abs((decoded[index] as number) - value) < 1e-6);
    }
  });

  it('uses four bytes per dimension, so a real Turso client can read it', () => {
    assert.equal(encodeVector(hashEmbed('x', 8)).byteLength, 32);
  });

  it('survives an unaligned buffer', () => {
    // A blob read back from SQLite is not guaranteed to start on a 4-byte boundary, and
    // a naive Float32Array view over it throws. This is that case, deliberately.
    const encoded = encodeVector(hashEmbed('budget', 16));
    const shifted = new Uint8Array(encoded.byteLength + 1);
    shifted.set(encoded, 1);
    const decoded = decodeVector(shifted.subarray(1));
    assert.equal(decoded.length, 16);
  });
});

describe('vectorLiteral', () => {
  it('renders the JSON array form libSQL vector32() accepts', () => {
    const literal = vectorLiteral(Float32Array.from([1, -0.5, 0]));
    assert.equal(literal.startsWith('['), true);
    assert.equal(literal.endsWith(']'), true);
    assert.deepEqual((JSON.parse(literal) as number[]).length, 3);
  });

  it('never emits a bare NaN or Infinity, which are not valid JSON', () => {
    const literal = vectorLiteral(Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY, 1]));
    assert.doesNotThrow(() => JSON.parse(literal));
  });
});

describe('hashEmbedder', () => {
  it('reports a scheme id that includes its width', () => {
    assert.match(hashEmbedder(128).id, /128/);
    assert.notEqual(hashEmbedder(128).id, hashEmbedder(256).id);
  });

  it('defaults to the documented width', () => {
    assert.equal(hashEmbedder().dimensions, DEFAULT_DIMENSIONS);
  });
});

describe('embeddableText', () => {
  it('draws on the fields a person would actually search', () => {
    const text = embeddableText({
      title: 'Q3 budget review',
      author: 'alice@example.com',
      summary: 'Numbers for the quarter',
      body: 'The forecast is attached.',
    });

    assert.match(text, /budget review/);
    assert.match(text, /alice/);
    assert.match(text, /forecast/);
  });

  it('repeats the subject, because a long quoted reply would otherwise drown it', () => {
    const text = embeddableText({ title: 'Budget' });
    assert.equal(text, 'Budget\nBudget');
  });

  it('caps how much body it takes', () => {
    const text = embeddableText({ title: 'x', body: 'word '.repeat(50_000) });
    assert.ok(text.length < 20_000, `body should be truncated, got ${String(text.length)} chars`);
  });
});
