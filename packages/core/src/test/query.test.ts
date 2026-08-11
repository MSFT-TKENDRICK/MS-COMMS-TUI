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
  parseDateBoundEnd,
  parseDateValue,
  parseQuery,
  parseSizeValue,
  queryFields,
  requiresContent,
  scoreQuery,
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

  it('treats a partial date as the period it names, not the instant it starts', () => {
    // `date:<=2026-01` must include the whole of January. Taking the literal instant
    // would silently drop 30 days of mail, and the user has no way to see that happen.
    // The edges are local, because the month a user means is the month where they are.
    assert.equal(parseDateBoundEnd('2026-01').getTime(), new Date(2026, 1, 1).getTime());
    assert.equal(parseDateBoundEnd('2026').getTime(), new Date(2027, 0, 1).getTime());
    assert.equal(parseDateBoundEnd('2026-01-31').getTime(), new Date(2026, 1, 1).getTime());
  });
});

// ---------------------------------------------------------------------------
// Lucene syntax
// ---------------------------------------------------------------------------

/**
 * Every Lucene form is checked for three things at once: that it parses, that it decides
 * the same way a user would expect, and that it survives `stringifyQuery`.
 *
 * The third is not cosmetic. The engine compares stringified queries to decide whether a
 * provider really applied a filter server-side, so a modifier that vanishes on the round
 * trip makes two different queries look identical — and the engine then trusts a filter
 * that was never applied and hides mail without saying so.
 */
describe('Lucene syntax', () => {
  const target = node();

  function roundTrip(text: string): string {
    const once = stringifyQuery(parseQuery(text));
    assert.equal(stringifyQuery(parseQuery(once)), once, `"${text}" did not survive the round trip`);
    return once;
  }

  it('matches wildcards, and keeps them through the round trip', () => {
    assert.equal(evaluateQuery(parseQuery('subject:budg*'), target), true);
    assert.equal(evaluateQuery(parseQuery('subject:bud?et'), target), true);
    assert.equal(evaluateQuery(parseQuery('subject:xylo*'), target), false);
    assert.equal(roundTrip('subject:budg*'), 'subject:budg*');
    assert.equal(roundTrip('subject:bud?et'), 'subject:bud?et');
  });

  it('anchors a wildcard to whole words, so `budg*` is not a bare substring search', () => {
    // Otherwise `subject:budg*` would match "rebudgeting", and the user who typed a
    // wildcard to be *more* precise would get less precision than typing nothing.
    assert.equal(evaluateQuery(parseQuery('subject:udget*'), target), false);
  });

  it('finds a misspelling with fuzzy search', () => {
    assert.equal(evaluateQuery(parseQuery('budgt~'), target), true);
    assert.equal(evaluateQuery(parseQuery('budgt~1'), target), true);
    assert.equal(evaluateQuery(parseQuery('zzzzzz~1'), target), false);
    assert.equal(roundTrip('budgt~1'), 'budgt~1');
    assert.equal(roundTrip('budgt~'), 'budgt~2', 'a bare ~ means the Lucene default of 2');
  });

  it('grades fuzzy hits by the misspelling, not by the budget allowed', () => {
    // `budgt~1` and `budgt~2` found the same word by the same margin. Scoring them
    // differently would reorder results based on a number the user typed for safety.
    assert.equal(scoreQuery(parseQuery('budgt~1'), target), scoreQuery(parseQuery('budgt~2'), target));
  });

  it('matches a proximity phrase within the given slop', () => {
    assert.equal(evaluateQuery(parseQuery('"FY26 review"~3'), target), true);
    assert.equal(evaluateQuery(parseQuery('"FY26 review"~0'), target), false, 'the words are not adjacent');
    assert.equal(roundTrip('"FY26 review"~3'), '"FY26 review"~3');
  });

  it('matches a proximity phrase whichever order the words appear in', () => {
    // Someone typing `"budget review"~5` is asking whether the two words are near each
    // other. Text reading "review the budget" is exactly what they wanted, and making
    // them guess the author's word order turns a search into a false negative.
    const summary = node({ title: 'Offsite', summary: 'We should review the budget today.' });
    assert.equal(evaluateQuery(parseQuery('"budget review"~4'), summary), true);
    assert.equal(evaluateQuery(parseQuery('"review budget"~4'), summary), true);
    assert.equal(evaluateQuery(parseQuery('"budget review"~0'), summary), false, 'slop still bounds it');
  });

  it('keeps a quoted phrase a phrase even with a trailing slop marker', () => {
    const tokens = tokenizeQuery('"budget review"~5');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.quoted, true);
  });

  it('lowers a range into the two comparisons it already means', () => {
    // A dedicated range node would make every provider, every push-down translator and
    // the exec JSON protocol learn a third shape meaning what two existing shapes mean.
    assert.equal(roundTrip('size:[1k TO 10M]'), 'size:>=1k size:<=10M');
    assert.equal(roundTrip('size:{1k TO 10M}'), 'size:>1k size:<10M');
    assert.equal(roundTrip('date:[2026-01-01 TO *]'), 'date:>=2026-01-01');
    assert.equal(roundTrip('date:[* TO 2026-12-31]'), 'date:<=2026-12-31');
    assert.equal(evaluateQuery(parseQuery('size:[1k TO 10M]'), target), true);
    assert.equal(evaluateQuery(parseQuery('size:[10M TO 20M]'), target), false);
  });

  it('rejects an unbounded range instead of quietly matching everything', () => {
    assert.throws(() => parseQuery('size:[* TO *]'), /EINVAL|bound/i);
  });

  it('does not mistake a bracketed value for a range', () => {
    // `subject:[urgent]` is a real thing people type. Only a literal " TO " makes a range.
    assert.equal(roundTrip('subject:[urgent]'), 'subject:"[urgent]"');
  });

  it('accepts +, -, &&, || and ! as the operators Lucene users expect', () => {
    assert.equal(roundTrip('+is:unread -is:read'), 'is:unread NOT is:read');
    assert.equal(roundTrip('is:unread && subject:budget'), 'is:unread subject:budget');
    assert.equal(roundTrip('nothing || subject:budget'), 'nothing OR subject:budget');
    assert.equal(roundTrip('!is:read'), 'NOT is:read');
    assert.equal(evaluateQuery(parseQuery('+is:unread -is:read'), target), true);
    assert.equal(evaluateQuery(parseQuery('is:unread && subject:budget'), target), true);
    assert.equal(evaluateQuery(parseQuery('!is:read'), target), true);
  });

  it('treats an escaped operator as an ordinary word', () => {
    // Otherwise a user searching for the literal text "AND" cannot express it at all.
    const query = parseQuery('a \\AND b');
    assert.equal(stringifyQuery(query), 'a AND b'.replace('AND', '"AND"'));
  });

  it('escapes a wildcard so it can be searched for literally', () => {
    assert.equal(evaluateQuery(parseQuery('subject:bud\\*et'), target), false);
    assert.equal(evaluateQuery(parseQuery('subject:bud*et'), target), true);
    assert.equal(roundTrip('subject:bud\\*et'), 'subject:"bud*et"');
  });

  it('boosts a clause, and a whole group', () => {
    assert.equal(roundTrip('subject:budget^3'), 'subject:budget^3');
    assert.equal(roundTrip('(subject:budget OR subject:forecast)^2'), '(subject:budget OR subject:forecast)^2');
    assert.ok(
      scoreQuery(parseQuery('subject:budget^3'), target) > scoreQuery(parseQuery('subject:budget'), target),
      'a boost must actually change the score, or it is decoration',
    );
  });

  it('does not let a boost change whether something matched', () => {
    // Boosting is about order. If it could also decide membership, a user raising the
    // weight of one clause would silently lose results from another.
    assert.equal(
      evaluateQuery(parseQuery('subject:budget^9'), target),
      evaluateQuery(parseQuery('subject:budget'), target),
    );
  });
});

describe('scoreQuery', () => {
  it('ranks an exact title above a word above a substring', () => {
    const query = parseQuery('budget');
    const exact = scoreQuery(query, node({ title: 'budget' }));
    const word = scoreQuery(query, node({ title: 'FY26 budget review' }));
    const inside = scoreQuery(query, node({ title: 'Re: rebudgeting later' }));
    assert.ok(exact > word, 'an exact title is the best possible match');
    assert.ok(word > inside, 'a whole word beats a fragment of a longer word');
    assert.ok(inside > 0, 'a fragment still matched, so it still scores');
  });

  it('never scores something it also says does not match', () => {
    // A result at the top of the list that the tool separately claims is not a match is
    // the kind of contradiction that makes a user stop trusting the whole thing.
    const query = parseQuery('subject:xylophone');
    const item = node();
    assert.equal(evaluateQuery(query, item), false);
    assert.equal(scoreQuery(query, item), 0);
  });

  it('gives every item the same score for match-all, so ranking falls through to recency', () => {
    assert.equal(scoreQuery(MATCH_ALL, node({ title: 'a' })), scoreQuery(MATCH_ALL, node({ title: 'b' })));
  });
});


