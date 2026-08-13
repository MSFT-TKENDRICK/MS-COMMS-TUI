/**
 * The unread counter a fixture folder carries.
 *
 * This provider backs `demo`, which is how most people meet the tool and the only mount that
 * works with no credentials — so a counter that is wrong here is wrong in the first thing
 * anyone sees. It used to count only the items directly inside a folder, which reported a
 * confident `0` next to `Chats/` while three unread conversations sat one step below it,
 * because a chat list is a folder of folders and holds no loose messages at all.
 *
 * The fixture is entirely in memory, so counting the whole subtree is a walk and no I/O.
 * What needs pinning down is that the walk terminates on the cyclic people fixture and that
 * an item reachable by several routes is counted once.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VNode } from '@mscomms/core';

import { MemoryProvider } from '../provider.js';
import type { MemoryItem } from '../types.js';

const now = (): number => Date.UTC(2026, 7, 11, 12, 0, 0);

async function row(provider: MemoryProvider, parent: VNode | null, title: string): Promise<VNode> {
  const page = await provider.list(parent, { limit: 200 });
  const found = page.entries.find((entry) => entry.title === title);
  assert.ok(found !== undefined, `expected a row titled "${title}"`);
  return found;
}

describe('memory fixture: how many unread are in here', () => {
  it('counts through folders that contain only folders', async () => {
    // The exact shape that reported nothing: a chat list, whose children are conversations
    // rather than messages.
    const provider = new MemoryProvider({
      now,
      items: [
        {
          id: 'chats',
          title: 'Chats',
          children: [
            {
              id: 'priya',
              title: 'Priya Raman',
              children: [
                { id: 'm1', title: 'one', flags: ['unread'], body: 'a' },
                { id: 'm2', title: 'two', flags: ['unread'], body: 'b' },
              ],
            },
            {
              id: 'crew',
              title: 'Release crew',
              children: [{ id: 'm3', title: 'three', flags: ['unread'], body: 'c' }],
            },
          ],
        },
      ],
    });

    assert.equal((await row(provider, null, 'Chats')).unreadCount, 3);
  });

  it('adds up the loose items and the folders together', async () => {
    const provider = new MemoryProvider({
      now,
      items: [
        {
          id: 'inbox',
          title: 'Inbox',
          children: [
            { id: 'loose', title: 'loose', flags: ['unread'], body: 'a' },
            { id: 'read', title: 'read', body: 'b' },
            { id: 'sub', title: 'Projects', children: [{ id: 'deep', title: 'deep', flags: ['unread'], body: 'c' }] },
          ],
        },
      ],
    });

    assert.equal((await row(provider, null, 'Inbox')).unreadCount, 2);
  });

  it('reports zero for a folder that really has nothing new', async () => {
    // Zero is a real answer here, and distinct from the silence of a source that cannot
    // count at all. The fixture always knows.
    const provider = new MemoryProvider({
      now,
      items: [{ id: 'drafts', title: 'Drafts', children: [{ id: 'd1', title: 'draft', body: 'a' }] }],
    });

    assert.equal((await row(provider, null, 'Drafts')).unreadCount, 0);
  });

  it('terminates on a cyclic org chart', async () => {
    // Your manager's reports contain you. Counting naively down `children` never returns.
    const provider = new MemoryProvider({
      now,
      items: [
        {
          id: 'roster',
          title: 'Roster',
          children: [
            {
              id: 'ada',
              title: 'Ada',
              children: [
                { id: 'ada-manager', title: 'manager', refs: ['grace'] },
                { id: 'ada-note', title: 'note', flags: ['unread'], body: 'x' },
              ],
            },
            { id: 'grace', title: 'Grace', children: [{ id: 'grace-reports', title: 'reports', refs: ['ada'] }] },
          ],
        },
      ],
    });

    assert.equal((await row(provider, null, 'Roster')).unreadCount, 1);
  });

  it('counts an item once however many folders point at it', async () => {
    // References mean one item can hang in several places. Counting it per route would
    // inflate every folder above it, and the totals would stop agreeing with the messages
    // you can actually find.
    const items: readonly MemoryItem[] = [
      {
        id: 'roster',
        title: 'Roster',
        children: [{ id: 'ada', title: 'Ada', children: [{ id: 'note', title: 'note', flags: ['unread'], body: 'x' }] }],
      },
      { id: 'section', title: 'Everyone', refs: ['ada'] },
    ];
    const provider = new MemoryProvider({ items, now });

    assert.equal((await row(provider, null, 'Roster')).unreadCount, 1);
    assert.equal((await row(provider, null, 'Everyone')).unreadCount, 1);
  });

  it('follows a marked-read action, so the counter can reach zero', async () => {
    const provider = new MemoryProvider({
      now,
      items: [
        {
          id: 'inbox',
          title: 'Inbox',
          children: [{ id: 'sub', title: 'Sub', children: [{ id: 'm1', title: 'one', flags: ['unread'], body: 'a' }] }],
        },
      ],
    });

    assert.equal((await row(provider, null, 'Inbox')).unreadCount, 1);

    const sub = await row(provider, null, 'Inbox').then(async (inbox) => row(provider, inbox, 'Sub'));
    const message = await row(provider, sub, 'one');
    await provider.invoke('read', message, {});

    assert.equal((await row(provider, null, 'Inbox')).unreadCount, 0, 'the total above follows the item');
  });
});
