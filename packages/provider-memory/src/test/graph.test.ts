/**
 * Fixtures that are graphs rather than trees.
 *
 * The people mount is the reason this exists: an org chart is cyclic (your manager's
 * reports contain you) and the same person is reachable from half a dozen sections. A
 * fixture that modelled that with copies would be a comfortable lie — it would list, read
 * and search perfectly while hiding every problem the real shape causes. So the fixture
 * engine supports references, and these tests pin the three properties that make them
 * worth having: one identity, one canonical path, and a search that terminates.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseQuery, VfsError, type VNode } from '@mscomms/core';

import { MemoryProvider } from '../provider.js';
import type { MemoryItem } from '../types.js';

const now = (): number => Date.UTC(2026, 7, 11, 12, 0, 0);

/** Two people who report to each other's folders, plus one message to find. */
const GRAPH: readonly MemoryItem[] = [
  {
    id: 'section-team',
    title: 'Team',
    refs: ['person-ada', 'person-grace'],
  },
  {
    id: 'roster',
    title: 'Roster',
    children: [
      {
        id: 'person-ada',
        title: 'Ada Lovelace',
        children: [
          { id: 'ada-manager', title: 'manager', refs: ['person-grace'] },
          { id: 'ada-note', title: 'Analytical engine notes', flags: ['unanswered'], body: 'looping' },
        ],
      },
      {
        id: 'person-grace',
        title: 'Grace Hopper',
        children: [{ id: 'grace-reports', title: 'reports', refs: ['person-ada'] }],
      },
    ],
  },
];

function provider(items: readonly MemoryItem[] = GRAPH): MemoryProvider {
  return new MemoryProvider({ items, now });
}

async function child(from: MemoryProvider, parent: VNode | null, name: string): Promise<VNode> {
  const page = await from.list(parent, { limit: 100 });
  const found = page.entries.find((entry) => entry.name === name || entry.title === name);
  assert.ok(found !== undefined, `expected a child named "${name}"`);
  return found;
}

describe('memory fixture: references', () => {
  it('lists a referenced item as a child of the folder that points at it', async () => {
    const memory = provider();
    const team = await child(memory, null, 'Team');
    const page = await memory.list(team, { limit: 100 });
    assert.deepEqual(page.entries.map((entry) => entry.title).sort(), ['Ada Lovelace', 'Grace Hopper']);
  });

  it('gives the referenced item the same id from every direction', async () => {
    const memory = provider();
    const viaTeam = await child(memory, await child(memory, null, 'Team'), 'Ada Lovelace');
    const roster = await child(memory, null, 'Roster');
    const viaRoster = await child(memory, roster, 'Ada Lovelace');
    // Not a copy. This is what lets the engine dedupe search hits and what makes marking a
    // message read from one path mark it read from all of them.
    assert.equal(viaTeam.id, viaRoster.id);
  });

  it('treats a folder with only references as a directory', async () => {
    const memory = provider();
    const team = await child(memory, null, 'Team');
    assert.equal(team.kind, 'dir');
  });

  it('walks a cycle without looping forever', async () => {
    const memory = provider();
    const roster = await child(memory, null, 'Roster');
    const ada = await child(memory, roster, 'Ada Lovelace');
    const manager = await child(memory, ada, 'manager');
    const grace = await child(memory, manager, 'Grace Hopper');
    const reports = await child(memory, grace, 'reports');
    const backToAda = await child(memory, reports, 'Ada Lovelace');
    assert.equal(backToAda.id, ada.id);
  });

  it('returns one search hit per item however many paths reach it', async () => {
    const memory = provider();
    assert.ok(memory.search !== undefined);
    const page = await memory.search(null, parseQuery('is:unanswered'), { limit: 100 });
    assert.deepEqual(page.entries.map((entry) => entry.id), ['ada-note']);
  });

  it('reports the place an item was defined as its path, not the route taken', async () => {
    const memory = provider();
    assert.ok(memory.search !== undefined);
    const page = await memory.search(null, parseQuery('is:unanswered'), { limit: 100 });
    assert.equal(page.entries[0]?.parentPath, 'Roster/Ada Lovelace');
  });

  it('rejects a reference to an id that does not exist', () => {
    assert.throws(
      () => provider([{ id: 'a', title: 'A', refs: ['nope'] }]),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });

  it('rejects a folder that references itself', () => {
    assert.throws(
      () => provider([{ id: 'a', title: 'A', refs: ['a'] }]),
      (error: unknown) => error instanceof VfsError && error.code === 'ECONFIG',
    );
  });
});

describe('memory fixture: the people demo', () => {
  it('is cyclic, so your manager\u2019s reports contain you', async () => {
    const memory = new MemoryProvider({ fixture: 'people', now });
    const me = await child(memory, null, 'Me');
    const manager = await child(memory, me, 'manager');
    const dana = await child(memory, manager, 'Dana Whitfield');
    const reports = await child(memory, dana, 'reports');
    const names = (await memory.list(reports, { limit: 100 })).entries.map((entry) => entry.title);
    assert.ok(names.includes('Alex Kimura'), `expected to find myself again, got ${names.join(', ')}`);
  });

  it('finds each unanswered message once rather than once per route', async () => {
    const memory = new MemoryProvider({ fixture: 'people', now });
    assert.ok(memory.search !== undefined);
    const page = await memory.search(null, parseQuery('is:unanswered'), { limit: 100 });
    const ids = page.entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, `duplicated hits: ${ids.join(', ')}`);
  });

  it('orders people by what is waiting on them, not alphabetically', async () => {
    const memory = new MemoryProvider({ fixture: 'people', now });
    const recent = await child(memory, null, 'Recent');
    const names = (await memory.list(recent, { limit: 100 })).entries.map((entry) => entry.title);
    // Sam has an unanswered mail but nothing unread, so he ranks below everyone who does.
    assert.equal(names.at(-1), 'Sam Ito');
    assert.equal(names[0], 'Dana Whitfield');
  });
});
