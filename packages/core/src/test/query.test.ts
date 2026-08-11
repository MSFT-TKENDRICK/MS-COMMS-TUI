/**
 * The query language, tested for the two things that actually matter:
 *
 *  1. Round-tripping. `stringifyQuery(parseQuery(x))` is what the engine compares to decide
 *     whether a provider genuinely applied the whole query server-side. If that comparison
 *     is wrong in the permissive direction, the engine trusts a filter that was never
 *     applied and silently hides mail. Every push-down safety property rests on it.
 *
 *  2. The trilean. `unknown` exists so that "I have not fetched the body, so I cannot tell"
 *     is representable. Collapsing it to false hides matches; collapsing it to true
 *     fabricates them. Both are worse than saying so.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MATCH_ALL,
  evaluateQuery,
  isMatchAll,
  parseDateValue,
  parseQuery,
  parseSizeValue,
  queryFields,
  requiresContent,
  stringifyQuery,
  tokenizeQuery,
} from '../query.js';
import type { VNode } from '../provider.js';

function node(overrides: Partial<VNode> = {}): VNode {
  return {
    name: 'budget.eml',
    id: 'id-1',
    kind: 'file',
    title: 'FY26 budget review',
    author: 'Dana Lee',
    authorId: 'dana@example.com',
    summary: 'Numbers for next year.',
    flags: ['unread'],
    size: 4096,
    mtime: new Date('2026-08-11T12:00:00Z'),
    ...overrides,
  };
}

describe('tokenizeQuery', () => {
  it('keeps a quoted phrase as one token', () => {
    const tokens = tokenizeQuery('"quarterly planning" from:dana');
    assert.equal(tokens.length, 2);
  });

  it('returns nothing for empty or whitespace input', () => {
    assert.equal(tokenizeQuery('').length, 0);
    assert.equal(tokenizeQuery('   ').length, 0);
  });

  it('rejects an unterminated quote with a legible message', () => {
    // Users type this constantly, so the failure must name the problem and the fix
    // rather than silently guessing at an interpretation the user did not ask for.
    assert.throws(
      () => tokenizeQuery('"unterminated'),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'EINVAL');
        assert.match((error as Error).message, /[Uu]nterminated quote/);
        return true;
      },
    );
  });

  it('separates a field from its quoted value', () => {
    // The regression this caught: treating `subject:"a b"` as a literal phrase turns
    // every `from:"Dana Lee"` into a full-text search for the string `from:Dana Lee`,
    // which matches nothing and gives the user no clue why.
    const tokens = tokenizeQuery('subject:"a b"');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.quoted, false, 'a field with a quoted value is not a phrase');
    const phrase = tokenizeQuery('"a b"');
    assert.equal(phrase[0]?.quoted, true, 'a bare quoted span is a phrase');
  });
});

describe('parseQuery', () => {
  it('treats an empty query as match-all', () => {
    assert.ok(isMatchAll(parseQuery('')));
    assert.ok(isMatchAll(parseQuery('   ')));
    assert.ok(isMatchAll(MATCH_ALL));
  });

  it('parses a field term', () => {
    const query = parseQuery('from:dana');
    assert.equal(query.type, 'term');
    if (query.type === 'term') {
      // rom is an alias; the canonical field is uthor, so a provider only ever
      // has to understand one spelling.
      assert.equal(query.field, 'author');
      assert.equal(query.value, 'dana');
    }
  });

  it('treats bare words as free text', () => {
    const query = parseQuery('budget');
    assert.equal(query.type, 'text');
  });

  it('ANDs adjacent terms implicitly', () => {
    const query = parseQuery('from:dana budget');
    assert.equal(query.type, 'and');
  });

  it('supports OR and NOT', () => {
    assert.equal(parseQuery('a OR b').type, 'or');
    const negated = parseQuery('-from:dana');
    assert.ok(negated.type === 'not' || negated.type === 'and');
  });

  it('binds implicit AND tighter than OR', () => {
    // `a OR b c` means `a OR (b AND c)`, which is what every search box does.
    assert.equal(stringifyQuery(parseQuery('a OR b c')), stringifyQuery(parseQuery('a OR (b c)')));
    assert.notEqual(stringifyQuery(parseQuery('(a OR b) c')), stringifyQuery(parseQuery('a OR b c')));
  });

  it('names the unknown field and lists the ones that exist', () => {
    assert.throws(
      () => parseQuery('nonsense:x'),
      (error: unknown) => {
        assert.match((error as Error).message, /nonsense/);
        assert.match(String((error as { hint?: string }).hint), /author/);
        return true;
      },
    );
  });

  it('parses comparison operators on numeric fields', () => {
    const query = parseQuery('size:>1000');
    assert.equal(query.type, 'term');
    if (query.type === 'term') assert.equal(query.op, 'gt');
  });
});

describe('stringifyQuery round-trip', () => {
  // This is the load-bearing property: the engine compares stringified queries to decide
  // whether a provider's server-side filtering can be trusted.
  const cases = [
    'from:dana',
    'is:unread',
    'budget',
    'from:dana is:unread',
    'a OR b',
    '-is:read',
    'size:>1000',
    '"quarterly planning"',
    'from:dana (a OR b)',
    'subject:budget from:dana is:flagged',
  ];

  for (const input of cases) {
    it(`is stable for ${input}`, () => {
      const once = stringifyQuery(parseQuery(input));
      const twice = stringifyQuery(parseQuery(once));
      assert.equal(twice, once, `not idempotent: ${input} -> ${once} -> ${twice}`);
    });
  }

  it('distinguishes queries that differ only in one term', () => {
    assert.notEqual(
      stringifyQuery(parseQuery('from:dana is:unread')),
      stringifyQuery(parseQuery('from:dana')),
    );
  });

  it('distinguishes AND from OR', () => {
    assert.notEqual(stringifyQuery(parseQuery('a b')), stringifyQuery(parseQuery('a OR b')));
  });

  it('distinguishes a term from its negation', () => {
    assert.notEqual(stringifyQuery(parseQuery('is:unread')), stringifyQuery(parseQuery('-is:unread')));
  });
});

describe('evaluateQuery', () => {
  it('matches on author by display name or address', () => {
    assert.equal(evaluateQuery(parseQuery('from:dana'), node()), true);
    assert.equal(evaluateQuery(parseQuery('from:dana@example.com'), node()), true);
    assert.equal(evaluateQuery(parseQuery('from:morgan'), node()), false);
  });

  it('matches flags via is:', () => {
    assert.equal(evaluateQuery(parseQuery('is:unread'), node()), true);
    assert.equal(evaluateQuery(parseQuery('is:flagged'), node()), false);
  });

  it('treats is:read as the absence of unread', () => {
    assert.equal(evaluateQuery(parseQuery('is:read'), node({ flags: [] })), true);
    assert.equal(evaluateQuery(parseQuery('is:read'), node({ flags: ['unread'] })), false);
  });

  it('is case-insensitive', () => {
    assert.equal(evaluateQuery(parseQuery('from:DANA'), node()), true);
    assert.equal(evaluateQuery(parseQuery('subject:BUDGET'), node()), true);
  });

  it('searches the untouched title, not the sanitized name', () => {
    // The name is lossy; searching it would silently miss anything sanitization changed.
    const hit = node({ title: 'Re: Q3/Q4 forecast', name: 'Re- Q3-Q4 forecast.eml' });
    assert.equal(evaluateQuery(parseQuery('subject:"Q3/Q4"'), hit), true);
  });

  it('returns unknown for a body term when the body is absent', () => {
    assert.equal(evaluateQuery(parseQuery('body:numbers'), node()), 'unknown');
  });

  it('decides a body term once the body is supplied', () => {
    assert.equal(evaluateQuery(parseQuery('body:numbers'), node(), { body: 'the numbers' }), true);
    assert.equal(evaluateQuery(parseQuery('body:missing'), node(), { body: 'the numbers' }), false);
  });

  it('propagates unknown through AND only when it could change the answer', () => {
    // false AND unknown is false: no body can rescue a failed metadata term.
    assert.equal(evaluateQuery(parseQuery('from:nobody body:x'), node()), false);
    // true AND unknown is still unknown.
    assert.equal(evaluateQuery(parseQuery('from:dana body:x'), node()), 'unknown');
  });

  it('propagates unknown through OR only when it could change the answer', () => {
    assert.equal(evaluateQuery(parseQuery('from:dana OR body:x'), node()), true);
    assert.equal(evaluateQuery(parseQuery('from:nobody OR body:x'), node()), 'unknown');
  });

  it('negates unknown to unknown, never to true', () => {
    assert.equal(evaluateQuery(parseQuery('-body:x'), node()), 'unknown');
  });

  it('matches everything with match-all', () => {
    assert.equal(evaluateQuery(MATCH_ALL, node()), true);
  });

  it('compares sizes numerically', () => {
    assert.equal(evaluateQuery(parseQuery('size:>1000'), node({ size: 4096 })), true);
    assert.equal(evaluateQuery(parseQuery('size:>1000'), node({ size: 10 })), false);
    assert.equal(evaluateQuery(parseQuery('larger:1k'), node({ size: 4096 })), true);
    assert.equal(evaluateQuery(parseQuery('smaller:1k'), node({ size: 4096 })), false);
    // Unknown, not false: an unsized node cannot answer a size question.
    const unsized: VNode = { name: 'x', id: 'x', kind: 'file', title: 'x' };
    assert.equal(evaluateQuery(parseQuery('larger:1k'), unsized), 'unknown');
  });

  it('does not crash on a node missing every optional field', () => {
    const bare: VNode = { name: 'x', id: 'x', kind: 'file', title: 'x' };
    assert.doesNotThrow(() => evaluateQuery(parseQuery('from:a is:unread larger:1 body:z'), bare));
  });
});

describe('query introspection', () => {
  it('reports which fields a query touches', () => {
    const fields = queryFields(parseQuery('from:dana is:unread body:x'));
    assert.ok(fields.has('author'));
    assert.ok(fields.has('is'));
    assert.ok(fields.has('body'));
  });

  it('flags queries that need the body downloaded', () => {
    assert.equal(requiresContent(parseQuery('body:x')), true);
    assert.equal(requiresContent(parseQuery('from:dana')), false);
    assert.equal(requiresContent(parseQuery('from:dana OR body:x')), true);
  });
});

describe('value parsing', () => {
  it('understands relative dates', () => {
    const now = new Date('2026-08-11T12:00:00Z');
    const week = parseDateValue('7d', now);
    assert.ok(week < now);
    assert.ok(week > new Date('2026-08-03T00:00:00Z'));
  });

  it('understands absolute dates', () => {
    const parsed = parseDateValue('2026-01-15');
    assert.equal(parsed.getFullYear(), 2026);
  });

  it('understands size suffixes', () => {
    assert.equal(parseSizeValue('1k'), 1024);
    assert.equal(parseSizeValue('2m'), 2 * 1024 * 1024);
    assert.equal(parseSizeValue('512'), 512);
  });
});
