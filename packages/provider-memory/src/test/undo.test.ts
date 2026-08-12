/**
 * Undo round-trip tests for the memory provider.
 *
 * An `UndoSpec` is a promise the provider makes to the journal: "if you invoke this verb on
 * this node, the world goes back to how it was". Nothing else in the system can check that
 * promise — the journal takes it on trust and the shell just relays it — so it has to be
 * checked here, by actually making the round trip and comparing the state at both ends.
 *
 * The other half of the job is the promises the provider must *not* make. Marking an
 * already-read message as read changes nothing, so offering to undo it would put an entry on
 * the stack that reverses something the user never did — and `undo` would then quietly mark
 * unread a message that was read before they ever touched it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VNode } from '@mscomms/core';

import { MemoryProvider } from '../provider.js';
import type { MemoryItem } from '../types.js';

const now = (): number => Date.UTC(2026, 7, 11, 12, 0, 0);

const ITEMS: readonly MemoryItem[] = [
  {
    id: 'folder',
    title: 'Inbox',
    children: [
      { id: 'unread-one', title: 'Q3 budget review', flags: ['unread'], body: 'numbers' },
      { id: 'read-one', title: 'Lunch on Friday', body: 'sandwiches' },
      { id: 'flagged-one', title: 'Deploy plan', flags: ['flagged'], body: 'steps' },
    ],
  },
];

function provider(): MemoryProvider {
  return new MemoryProvider({ items: ITEMS, now });
}

async function nodeNamed(from: MemoryProvider, title: string): Promise<VNode> {
  const folder = (await from.list(null, { limit: 100 })).entries.find((entry) => entry.title === 'Inbox');
  assert.ok(folder !== undefined, 'expected the fixture folder');
  const page = await from.list(folder, { limit: 100 });
  const found = page.entries.find((entry) => entry.title === title);
  assert.ok(found !== undefined, `expected an item titled "${title}"`);
  return found;
}

async function flagsOf(from: MemoryProvider, title: string): Promise<readonly string[]> {
  return (await nodeNamed(from, title)).flags ?? [];
}

describe('memory provider: read and unread undo each other', () => {
  it('offers the inverse when the message really was unread', async () => {
    const memory = provider();
    const node = await nodeNamed(memory, 'Q3 budget review');
    const result = await memory.invoke('read', node, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.undo, { action: 'unread', label: 'mark it unread again' });
  });

  it('returns the message to unread when the inverse is invoked', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Q3 budget review');
    assert.ok(before.includes('unread'));

    const node = await nodeNamed(memory, 'Q3 budget review');
    const result = await memory.invoke('read', node, {});
    assert.ok(!(await flagsOf(memory, 'Q3 budget review')).includes('unread'));

    assert.ok(result.undo !== undefined);
    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Q3 budget review'), {});
    assert.deepEqual(await flagsOf(memory, 'Q3 budget review'), before);
  });

  it('offers no inverse for marking an already-read message read', async () => {
    // Nothing changed, so there is nothing to take back. Offering one would let `undo`
    // mark unread a message that was read long before the user arrived.
    const memory = provider();
    const result = await memory.invoke('read', await nodeNamed(memory, 'Lunch on Friday'), {});
    assert.equal(result.ok, true);
    assert.equal(result.undo, undefined);
  });

  it('offers no inverse for marking an already-unread message unread', async () => {
    const memory = provider();
    const result = await memory.invoke('unread', await nodeNamed(memory, 'Q3 budget review'), {});
    assert.equal(result.ok, true);
    assert.equal(result.undo, undefined);
  });

  it('makes the round trip in the other direction too', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Lunch on Friday');
    const result = await memory.invoke('unread', await nodeNamed(memory, 'Lunch on Friday'), {});
    assert.ok(result.undo !== undefined);
    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Lunch on Friday'), {});
    assert.deepEqual(await flagsOf(memory, 'Lunch on Friday'), before);
  });
});

describe('memory provider: flagging is its own inverse', () => {
  it('returns to unflagged after flag then undo', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Q3 budget review');

    const result = await memory.invoke('flag', await nodeNamed(memory, 'Q3 budget review'), {});
    assert.ok((await flagsOf(memory, 'Q3 budget review')).includes('flagged'));
    assert.ok(result.undo !== undefined);
    assert.equal(result.undo.action, 'flag');

    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Q3 budget review'), {});
    assert.deepEqual(await flagsOf(memory, 'Q3 budget review'), before);
  });

  it('returns to flagged after unflagging then undo', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Deploy plan');
    assert.ok(before.includes('flagged'));

    const result = await memory.invoke('flag', await nodeNamed(memory, 'Deploy plan'), {});
    assert.ok(!(await flagsOf(memory, 'Deploy plan')).includes('flagged'));
    assert.ok(result.undo !== undefined);

    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Deploy plan'), {});
    assert.deepEqual(await flagsOf(memory, 'Deploy plan'), before);
  });

  it('says which direction the undo goes, so the prompt can be read aloud', async () => {
    // "Undo" on its own is meaningless out loud. The label is what a screen reader says,
    // and a toggle needs opposite labels or the prompt tells the user the wrong thing.
    const memory = provider();
    const flagged = await memory.invoke('flag', await nodeNamed(memory, 'Q3 budget review'), {});
    const unflagged = await memory.invoke('flag', await nodeNamed(memory, 'Deploy plan'), {});
    assert.equal(flagged.undo?.label, 'remove the flag again');
    assert.equal(unflagged.undo?.label, 'put the flag back');
  });
});

describe('memory provider: tagging', () => {
  it('carries the tag into the inverse, since untag needs to know which one', async () => {
    const memory = provider();
    const result = await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.undo, { action: 'untag', params: { tag: 'urgent' }, label: 'remove the urgent tag' });
  });

  it('round trips a tag back off again', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Q3 budget review');

    const result = await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    assert.ok((await flagsOf(memory, 'Q3 budget review')).includes('urgent'));

    assert.ok(result.undo !== undefined);
    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Q3 budget review'), result.undo.params ?? {});
    assert.deepEqual(await flagsOf(memory, 'Q3 budget review'), before);
  });

  it('offers no inverse for a tag that was already there', async () => {
    const memory = provider();
    await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    const again = await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    assert.equal(again.undo, undefined);
  });

  it('offers no inverse for removing a tag that was not there', async () => {
    const memory = provider();
    const result = await memory.invoke('untag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'nope' });
    assert.equal(result.ok, true);
    assert.equal(result.undo, undefined);
  });

  it('puts a removed tag back, with the tag named in the inverse', async () => {
    const memory = provider();
    await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    const withTag = await flagsOf(memory, 'Q3 budget review');

    const removed = await memory.invoke('untag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    assert.ok(removed.undo !== undefined);
    assert.deepEqual(removed.undo.params, { tag: 'urgent' });

    await memory.invoke(removed.undo.action, await nodeNamed(memory, 'Q3 budget review'), removed.undo.params ?? {});
    assert.deepEqual(await flagsOf(memory, 'Q3 budget review'), withTag);
  });
});

describe('memory provider: what an action reports', () => {
  it('names the paths that went stale, so the view knows to refresh', async () => {
    const memory = provider();
    const node = await nodeNamed(memory, 'Q3 budget review');
    const result = await memory.invoke('read', node, {});
    assert.ok(result.invalidates !== undefined);
    assert.ok(result.invalidates.includes(node.path ?? ''));
  });

  it('describes what it did in words a person can hear', async () => {
    const memory = provider();
    const result = await memory.invoke('read', await nodeNamed(memory, 'Q3 budget review'), {});
    assert.match(result.message ?? '', /Q3 budget review/);
  });
});
