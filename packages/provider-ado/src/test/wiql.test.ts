/**
 * WIQL translation, tested directly.
 *
 * `buildWiql` is where the push-down trust boundary is enforced, and the failure it guards
 * against is invisible: claim a query you did not evaluate exactly, and the engine stops
 * filtering, so matching work items vanish from a listing with no error anywhere. These
 * tests are therefore mostly about what is *not* claimed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MATCH_ALL, parseDateValue, parseQuery, stringifyQuery, VfsError } from '@mscomms/core';

import { buildWiql, literal, WORK_ITEM_FIELDS } from '../wiql.js';

const NOW = new Date('2026-08-11T12:00:00Z');

describe('buildWiql: scope', () => {
  it('always scopes to the project and orders stably', () => {
    const { statement } = buildWiql({ project: 'Contoso' }, undefined, NOW);

    assert.match(statement, /^SELECT \[System\.Id\] FROM WorkItems WHERE /);
    assert.match(statement, /\[System\.TeamProject\] = 'Contoso'/);
    // Ordering by date alone would let two items changed in the same second swap places
    // between pages, which makes cursor paging drop and repeat rows.
    assert.match(statement, /ORDER BY \[System\.ChangedDate\] DESC, \[System\.Id\] DESC$/);
  });

  it('adds the board column, @Me and work item type clauses', () => {
    const { statement } = buildWiql(
      { project: 'Contoso', boardColumn: 'Active', assignedToMe: true, workItemTypes: ['Bug', 'User Story'] },
      undefined,
      NOW,
    );

    assert.match(statement, /\[System\.BoardColumn\] = 'Active'/);
    assert.match(statement, /\[System\.AssignedTo\] = @Me/);
    assert.match(statement, /\[System\.WorkItemType\] IN \('Bug', 'User Story'\)/);
  });

  it('escapes a quote in a project or column name', () => {
    const { statement } = buildWiql({ project: "O'Brien's", boardColumn: "Needs 'work'" }, undefined, NOW);

    assert.match(statement, /\[System\.TeamProject\] = 'O''Brien''s'/);
    assert.match(statement, /\[System\.BoardColumn\] = 'Needs ''work'''/);
    assert.equal(literal("it's"), "'it''s'");
  });
});

describe('buildWiql: claiming', () => {
  const claims = (source: string): boolean => {
    const query = parseQuery(source);
    const { applied } = buildWiql({ project: 'Contoso' }, query, NOW);
    if (applied === undefined) return false;
    assert.equal(
      stringifyQuery(applied),
      stringifyQuery(query),
      'a claim must be the caller\u2019s own query object, or the engine sees a mismatch and re-filters',
    );
    return true;
  };

  it('claims date bounds, which translate exactly', () => {
    assert.equal(claims('after:2026-08-01'), true);
    assert.equal(claims('before:2026-08-10'), true);
    assert.equal(claims('on:2026-08-05'), true);
    assert.equal(claims('after:2026-08-01 before:2026-08-10'), true);
  });

  it('translates a date bound to the same instant the engine compares against', () => {
    // Compared against the engine's own parser rather than a hardcoded string: the whole
    // basis for claiming a date query is that both sides resolve it identically, including
    // the fact that `2026-08-01` means local midnight rather than UTC midnight.
    const midnight = parseDateValue('2026-08-01', NOW).toISOString();
    const { statement } = buildWiql({ project: 'Contoso' }, parseQuery('after:2026-08-01'), NOW);
    assert.ok(statement.includes(`[System.ChangedDate] >= '${midnight}'`), statement);

    const start = parseDateValue('2026-08-05', NOW);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const on = buildWiql({ project: 'Contoso' }, parseQuery('on:2026-08-05'), NOW);
    // `on:` is a half-open local day, exactly as the engine evaluates it.
    assert.ok(on.statement.includes(`[System.ChangedDate] >= '${start.toISOString()}'`), on.statement);
    assert.ok(on.statement.includes(`[System.ChangedDate] < '${end.toISOString()}'`), on.statement);
  });

  it('narrows on author without claiming it', () => {
    const query = parseQuery('author:dana');
    const { statement, applied } = buildWiql({ project: 'Contoso' }, query, NOW);

    // Azure DevOps matches identity fields on unique name too, so this is a superset of
    // what the engine keeps: safe to narrow with, unsafe to claim.
    assert.match(statement, /\[System\.CreatedBy\] CONTAINS 'dana'/);
    assert.equal(applied, undefined);
  });

  it('never claims a query with a term it cannot express', () => {
    for (const source of [
      'is:unread',
      'kind:file',
      'has:attachment',
      'budget',
      'after:2026-08-01 is:open',
      'subject:release',
    ]) {
      assert.equal(claims(source), false, `over-claimed for "${source}"`);
    }
  });

  it('never claims a compound query it cannot express as an AND of clauses', () => {
    for (const source of ['after:2026-08-01 OR before:2026-01-01', 'NOT after:2026-08-01']) {
      assert.equal(claims(source), false, `over-claimed for "${source}"`);
    }
    // Parentheses around a single term are pure grouping: the parsed query is the same
    // term, so claiming it is honest.
    assert.equal(claims('(after:2026-08-01)'), true);
  });

  it('claims match-all, because filtering nothing is exact', () => {
    const { applied } = buildWiql({ project: 'Contoso' }, MATCH_ALL, NOW);
    assert.equal(stringifyQuery(applied ?? parseQuery('x')), stringifyQuery(MATCH_ALL));
  });

  it('claims nothing when no query was given', () => {
    assert.equal(buildWiql({ project: 'Contoso' }, undefined, NOW).applied, undefined);
  });

  it('claims nothing once poll adds a bound the caller never asked for', () => {
    // The statement evaluates project AND changedSince AND after; claiming "after" would
    // describe a different query than the one that ran.
    const { statement, applied } = buildWiql(
      { project: 'Contoso', changedSince: '2026-08-10T00:00:00.000Z' },
      parseQuery('after:2026-08-01'),
      NOW,
    );

    assert.match(statement, /\[System\.ChangedDate\] >= '2026-08-10T00:00:00\.000Z'/);
    assert.equal(applied, undefined);
  });

  it('reports an unreadable date the same way the engine would', () => {
    // Not swallowed: the engine throws the identical EINVAL when it evaluates the same
    // term locally, so letting it through keeps one message rather than inventing a second.
    assert.throws(
      () => buildWiql({ project: 'Contoso' }, parseQuery('after:tuesday-ish'), NOW),
      (error: unknown) => error instanceof VfsError && error.code === 'EINVAL',
    );
  });

  it('resolves a relative date against the clock it was given', () => {
    const expected = parseDateValue('7d', NOW).toISOString();
    const { statement } = buildWiql({ project: 'Contoso' }, parseQuery('after:7d'), NOW);

    assert.ok(statement.includes(`[System.ChangedDate] >= '${expected}'`), statement);
    assert.equal(expected, '2026-08-04T12:00:00.000Z');
  });
});

describe('WORK_ITEM_FIELDS', () => {
  it('requests every field the listing renders, and no more', () => {
    // A field missing here reads as an empty value in `ls` and `stat` rather than as an
    // error, so the list is asserted rather than trusted.
    assert.deepEqual([...WORK_ITEM_FIELDS], [
      'System.Id',
      'System.Title',
      'System.WorkItemType',
      'System.State',
      'System.BoardColumn',
      'System.BoardColumnDone',
      'System.AssignedTo',
      'System.CreatedBy',
      'System.CreatedDate',
      'System.ChangedDate',
      'System.ChangedBy',
      'System.Tags',
      'System.AreaPath',
      'System.IterationPath',
      'System.CommentCount',
      'System.Description',
      'Microsoft.VSTS.Common.Priority',
    ]);
  });
});
