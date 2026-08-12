/**
 * The GraphQL parser.
 *
 * Hand-written, because this project ships no runtime dependencies, and a parser nobody
 * else maintains has to be tested as if it were the one thing users notice — which it is.
 * A projection is written at a prompt, so the parser's error messages are part of the user
 * interface: "expected } at line 3, column 12" is help, "unexpected token" is not.
 *
 * The cases below cover the parts of the query language a projection actually uses, plus
 * the syntax people type by reflex from other GraphQL tools (fragments, block strings,
 * variables, comments) and would find mysterious if it silently failed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  argsOf,
  findDirective,
  parseGraphQL,
  resolveVariables,
  responseName,
  tokenizeGraphQL,
  type GqlField,
} from '../graphql.js';
import { isVfsError } from '../errors.js';

function firstField(source: string): GqlField {
  const document = parseGraphQL(source);
  const operation = document.operations[0];
  assert.ok(operation !== undefined);
  const selection = operation.selections[0];
  assert.ok(selection !== undefined && selection.kind === 'field');
  return selection;
}

describe('tokenizeGraphQL', () => {
  it('skips commas and comments, which GraphQL treats as whitespace', () => {
    const tokens = tokenizeGraphQL('{ a, b # trailing\n c }');
    assert.deepEqual(
      tokens.filter((t) => t.kind === 'name').map((t) => t.value),
      ['a', 'b', 'c'],
    );
  });

  it('reads block strings and strips the common indentation', () => {
    const tokens = tokenizeGraphQL('"""\n  line one\n  line two\n"""');
    const string = tokens.find((t) => t.kind === 'string');
    assert.equal(string?.value, 'line one\nline two');
  });

  it('reads escapes inside ordinary strings', () => {
    const tokens = tokenizeGraphQL('"a\\nb\\"c\\u0041"');
    assert.equal(tokens.find((t) => t.kind === 'string')?.value, 'a\nb"cA');
  });

  it('distinguishes ints from floats, so a limit stays a whole number', () => {
    const tokens = tokenizeGraphQL('1 1.5 1e3 -2');
    assert.deepEqual(
      tokens.filter((t) => t.kind === 'int' || t.kind === 'float').map((t) => [t.kind, t.value]),
      [
        ['int', '1'],
        ['float', '1.5'],
        ['float', '1e3'],
        ['int', '-2'],
      ],
    );
  });

  it('reports an unterminated string by position rather than crashing', () => {
    assert.throws(
      () => tokenizeGraphQL('{ a(b: "oops) }'),
      (error: unknown) => isVfsError(error) && /line 1/.test(error.message),
    );
  });
});

describe('parseGraphQL', () => {
  it('parses a shorthand query with no operation keyword', () => {
    const document = parseGraphQL('{ all { name } }');
    assert.equal(document.operations.length, 1);
    assert.equal(document.operations[0]?.operation, 'query');
    assert.equal(document.operations[0]?.name, undefined);
  });

  it('keeps aliases, which is how a projection names its directories', () => {
    const field = firstField('{ unread: all(filter: "is:unread") { name } }');
    assert.equal(field.name, 'all');
    assert.equal(field.alias, 'unread');
    assert.equal(responseName(field), 'unread');
  });

  it('falls back to the field name when there is no alias', () => {
    assert.equal(responseName(firstField('{ all { name } }')), 'all');
  });

  it('reads arguments of every scalar shape', () => {
    const field = firstField('{ all(filter: "is:unread", first: 10, deep: true, nothing: null) { name } }');
    const args = argsOf(field.args, {});
    assert.equal(args['filter'], 'is:unread');
    assert.equal(args['first'], 10);
    assert.equal(args['deep'], true);
    assert.equal(args['nothing'], null);
  });

  it('reads list and enum arguments', () => {
    const field = firstField('{ all(types: [MAIL, CHAT]) { name } }');
    assert.deepEqual(argsOf(field.args, {}), { types: ['MAIL', 'CHAT'] });
  });

  it('parses directives with and without arguments', () => {
    const field = firstField('{ all @flatten @group(by: "author") { name } }');
    assert.ok(findDirective(field.directives, 'flatten') !== undefined);
    const group = findDirective(field.directives, 'group');
    assert.ok(group !== undefined);
    assert.equal(argsOf(group.args, {})['by'], 'author');
  });

  it('parses named operations and variable definitions with defaults', () => {
    const document = parseGraphQL('query Inbox($limit: Int = 25, $who: String!) { all(first: $limit) { name } }');
    const operation = document.operations[0];
    assert.equal(operation?.name, 'Inbox');
    assert.deepEqual(
      operation?.variables.map((v) => v.name),
      ['limit', 'who'],
    );
    assert.equal(operation?.variables[0]?.type.kind, 'named');
    assert.equal(operation?.variables[0]?.type.name, 'Int');
    assert.notEqual(operation?.variables[0]?.defaultValue, undefined);
    // `String!` is a wrapper around the named type, which is what makes it "required".
    assert.equal(operation?.variables[1]?.type.kind, 'nonNull');
    assert.equal(operation?.variables[1]?.type.of?.name, 'String');
  });

  it('parses fragments and inline fragments', () => {
    const document = parseGraphQL(
      'query { all { ...Common ... on Message { author } } } fragment Common on Node { name mtime }',
    );
    assert.deepEqual([...document.fragments.keys()], ['Common']);
    const root = document.operations[0]?.selections[0];
    assert.ok(root !== undefined && root.kind === 'field');
    assert.deepEqual(
      root.selections.map((s) => s.kind),
      ['spread', 'inline'],
    );
  });

  it('rejects mutations in the words a user can act on', () => {
    assert.throws(
      () => parseGraphQL('mutation { delete { name } }'),
      (error: unknown) =>
        isVfsError(error) && /mutation/.test(error.message) && /read-only/.test(error.hint ?? ''),
    );
  });

  it('names the line and column of a syntax error', () => {
    assert.throws(
      () => parseGraphQL('{ all { name }'),
      (error: unknown) => isVfsError(error) && /line 1/.test(error.message),
    );
  });

  it('rejects an empty selection set rather than treating it as a leaf', () => {
    assert.throws(() => parseGraphQL('{ all { } }'), isVfsError);
  });

  it('rejects an empty document with a hint about what to write', () => {
    assert.throws(
      () => parseGraphQL('   '),
      (error: unknown) => isVfsError(error) && error.hint !== undefined,
    );
  });
});

describe('resolveVariables', () => {
  const operation = parseGraphQL('query Q($limit: Int = 25, $who: String!) { all { name } }').operations[0];

  it('applies declared defaults', () => {
    assert.ok(operation !== undefined);
    const values = resolveVariables(operation, { who: 'alice' });
    assert.equal(values['limit'], 25);
    assert.equal(values['who'], 'alice');
  });

  it('lets a supplied value win over the default', () => {
    assert.ok(operation !== undefined);
    assert.equal(resolveVariables(operation, { limit: 5, who: 'alice' })['limit'], 5);
  });

  it('leaves an unsupplied variable absent, so the error names it at the point of use', () => {
    // Defaulting it to null instead would produce an empty projection, which reads exactly
    // like a mailbox with nothing in it. A precise error is the whole point.
    assert.ok(operation !== undefined);
    const values = resolveVariables(operation, {});
    assert.equal(values['who'], undefined);
  });
});

describe('valueOf', () => {
  it('substitutes variables inside arguments, including in lists', () => {
    const field = firstField('query ($n: Int) { all(first: $n, both: [$n, 2]) { name } }');
    const args = argsOf(field.args, { n: 7 });
    assert.equal(args['first'], 7);
    assert.deepEqual(args['both'], [7, 2]);
  });

  it('names the variable when it was never supplied, rather than returning nothing', () => {
    const field = firstField('query ($n: Int) { all(first: $n) { name } }');
    assert.throws(
      () => argsOf(field.args, {}),
      (error: unknown) => isVfsError(error) && /\$n/.test(error.message),
    );
  });
});
