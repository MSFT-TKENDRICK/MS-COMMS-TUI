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
 *
 * Most of those bad promises are now impossible to make, because the action registry refuses
 * a verb whose `applies` says no. A gated verb has its precondition guaranteed before `run`
 * is entered, so its inverse is unconditional and the tests below assert the refusal instead
 * of a missing undo. `tag` is the exception — it applies to anything — so it is the one verb
 * that still has to decide for itself whether anything changed.
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

  it('will not mark an already-read message read, so no false inverse can exist', async () => {
    // Nothing would change, so there would be nothing to take back. This used to be checked
    // inside the verb and reported as a missing undo; the gate is the better place for it,
    // because now `undo` cannot mark unread a message that was read before the user arrived
    // even if a future edit to the verb forgot to guard.
    const memory = provider();
    const node = await nodeNamed(memory, 'Lunch on Friday');
    await assert.rejects(() => memory.invoke('read', node, {}), /"read" does not apply/);
  });

  it('will not mark an already-unread message unread', async () => {
    const memory = provider();
    const node = await nodeNamed(memory, 'Q3 budget review');
    await assert.rejects(() => memory.invoke('unread', node, {}), /"unread" does not apply/);
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

describe('memory provider: flag and unflag undo each other', () => {
  it('returns to unflagged after flag then undo', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Q3 budget review');

    const result = await memory.invoke('flag', await nodeNamed(memory, 'Q3 budget review'), {});
    assert.ok((await flagsOf(memory, 'Q3 budget review')).includes('flagged'));
    assert.ok(result.undo !== undefined);
    assert.equal(result.undo.action, 'unflag');

    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Q3 budget review'), {});
    assert.deepEqual(await flagsOf(memory, 'Q3 budget review'), before);
  });

  it('returns to flagged after unflagging then undo', async () => {
    const memory = provider();
    const before = await flagsOf(memory, 'Deploy plan');
    assert.ok(before.includes('flagged'));

    const result = await memory.invoke('unflag', await nodeNamed(memory, 'Deploy plan'), {});
    assert.ok(!(await flagsOf(memory, 'Deploy plan')).includes('flagged'));
    assert.ok(result.undo !== undefined);
    assert.equal(result.undo.action, 'flag');

    await memory.invoke(result.undo.action, await nodeNamed(memory, 'Deploy plan'), {});
    assert.deepEqual(await flagsOf(memory, 'Deploy plan'), before);
  });

  it('says which direction the undo goes, so the prompt can be read aloud', async () => {
    // "Undo" on its own is meaningless out loud. The label is what a screen reader says,
    // and the two directions need opposite labels or the prompt tells the user the wrong
    // thing. They are separate verbs now rather than one toggle, which is what makes each
    // label a fixed property of the verb instead of something to work out at run time.
    const memory = provider();
    const flagged = await memory.invoke('flag', await nodeNamed(memory, 'Q3 budget review'), {});
    const unflagged = await memory.invoke('unflag', await nodeNamed(memory, 'Deploy plan'), {});
    assert.equal(flagged.undo?.label, 'remove the flag again');
    assert.equal(unflagged.undo?.label, 'put the flag back');
  });

  it('offers only the one that applies, so neither can be a no-op', async () => {
    const memory = provider();
    const unflaggedNode = await nodeNamed(memory, 'Q3 budget review');
    const flaggedNode = await nodeNamed(memory, 'Deploy plan');
    const onUnflagged = (await memory.actions(unflaggedNode)).map((descriptor) => descriptor.name);
    const onFlagged = (await memory.actions(flaggedNode)).map((descriptor) => descriptor.name);

    assert.ok(onUnflagged.includes('flag'));
    assert.ok(!onUnflagged.includes('unflag'));
    assert.ok(onFlagged.includes('unflag'));
    assert.ok(!onFlagged.includes('flag'));
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

  it('is not offered at all on an item with no tags to remove', async () => {
    // The old shape of this test asked `untag` to remove a tag that was not there and
    // checked that it offered no inverse. The gate now refuses before `run`, which is the
    // better answer: a verb that cannot do anything should not be on the menu either.
    const memory = provider();
    const node = await nodeNamed(memory, 'Q3 budget review');
    const offered = (await memory.actions(node)).map((descriptor) => descriptor.name);
    assert.ok(!offered.includes('untag'));
    await assert.rejects(() => memory.invoke('untag', node, { tag: 'nope' }), /"untag" does not apply/);
  });

  it('names the tags it could remove when asked for one it cannot', async () => {
    // `ActionDescriptor` is static, so `untag` cannot offer the tags as a list of choices
    // the way a per-node descriptor could. The names have to reach the user somehow, so
    // they are in the hint — which is the moment they are actually needed, and the hint is
    // the half of an error this program is built to read out loud.
    const memory = provider();
    await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    const node = await nodeNamed(memory, 'Q3 budget review');
    await assert.rejects(
      () => memory.invoke('untag', node, { tag: 'nope' }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /is not tagged nope/);
        assert.equal((error as { hint?: string }).hint, 'Tagged: urgent.');
        return true;
      },
    );
  });

  it('refuses to remove a built-in marker through the tag mechanism', async () => {
    const memory = provider();
    await memory.invoke('tag', await nodeNamed(memory, 'Q3 budget review'), { tag: 'urgent' });
    const node = await nodeNamed(memory, 'Q3 budget review');
    await assert.rejects(() => memory.invoke('untag', node, { tag: 'unread' }), /built-in marker/);
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
