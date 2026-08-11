/**
 * Watcher tests.
 *
 * The watcher is the one component whose output a user may never see on screen — it
 * arrives as a desktop toast, or is spoken aloud, while they are doing something else.
 * That makes its wording load-bearing in a way most strings are not: there is no
 * surrounding context to disambiguate it and no way to ask it to repeat itself.
 *
 * These tests exist because the notification body regressed to the literal text
 * "Something changed." for every third-party provider, and nothing caught it. The
 * `node` field on ChangeEvent is optional; `type` and `path` are not. A provider that
 * implements `poll` exactly as documented supplies the two required fields and omits
 * the optional one — which was precisely the case the summary did not handle.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Watcher } from '../watcher.js';
import { Notifier, type Notification } from '../notify.js';
import { Vfs } from '../vfs.js';
import type { ChangeEvent, ListPage, Provider, VNode } from '../provider.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A provider that reports changes exactly the way the wire protocol documents them:
 * the required `type` and `path`, and nothing else. This is what an external plugin
 * produces when it follows the docs, so it is the shape that matters most.
 */
function pollProvider(batches: readonly (readonly ChangeEvent[])[]): Provider {
  let call = 0;
  return {
    id: 'feed',
    displayName: 'Feed',
    capabilities: new Set(['list', 'read', 'poll'] as const),
    list(): Promise<ListPage> {
      return Promise.resolve({ entries: [] });
    },
    read(): Promise<{ body: string }> {
      return Promise.resolve({ body: '' });
    },
    poll(): Promise<{ changes: readonly ChangeEvent[]; cursor?: string }> {
      const changes = batches[call] ?? [];
      call += 1;
      return Promise.resolve({ changes, cursor: `c${String(call)}` });
    },
  } as unknown as Provider;
}

function change(type: ChangeEvent['type'], path: string, node?: VNode): ChangeEvent {
  const base = { type, path, at: new Date('2024-01-01T00:00:00Z') };
  return (node === undefined ? base : { ...base, node }) as ChangeEvent;
}

function node(overrides: Partial<VNode>): VNode {
  return {
    id: 'n1',
    name: 'n1',
    path: '/feed/n1',
    kind: 'message',
    title: 'A title',
    ...overrides,
  } as VNode;
}

/** Collects deliveries without touching the desktop or the terminal. */
function recorder(): { notifier: Notifier; sent: Notification[] } {
  const sent: Notification[] = [];
  const notifier = new Notifier({ desktop: false, bell: false, write: () => {} });
  notifier.onNotification((n) => sent.push(n));
  return { notifier, sent };
}

async function watchAndPoll(
  provider: Provider,
  polls: number,
  spec: { readonly includeUpdates?: boolean } = {},
): Promise<{ sent: Notification[]; changes: readonly (readonly ChangeEvent[])[] }> {
  const vfs = new Vfs();
  await vfs.mount({ id: 'feed', path: '/feed', provider });
  const { notifier, sent } = recorder();

  const watcher = new Watcher({
    vfs,
    notifier,
    // No real timers: every poll in these tests is explicit, so a forgotten interval
    // cannot make the suite flaky or leave the process alive.
    setTimer: () => undefined,
    clearTimer: () => {},
  });

  await watcher.add({ id: 'w', path: '/feed', ...spec });
  const changes: (readonly ChangeEvent[])[] = [];
  for (let i = 0; i < polls; i += 1) changes.push(await watcher.pollNow('w'));
  watcher.remove('w');
  return { sent, changes };
}

// ---------------------------------------------------------------------------

describe('watcher notification text', () => {
  it('names the item when a provider supplies only the required fields', async () => {
    // The exact shape the plugin protocol documents: type + path, no node.
    const { sent } = await watchAndPoll(
      pollProvider([[], [change('created', 'item-2')]]),
      2,
    );

    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]?.body,
      'New: item-2',
      'a provider that follows the documented protocol must not produce a contentless notification',
    );
    assert.doesNotMatch(
      sent[0]?.body ?? '',
      /something changed/i,
      'the fallback text carries no information and must not be reachable when a path was supplied',
    );
  });

  it('uses a verb that distinguishes arrival from edit from deletion', async () => {
    // Updates and deletions only reach the user when they asked for them (`--updates`),
    // so this exercises the opted-in path.
    for (const [type, expected] of [
      ['created', 'New: a'],
      ['updated', 'Updated: a'],
      ['deleted', 'Removed: a'],
    ] as const) {
      const { sent } = await watchAndPoll(pollProvider([[], [change(type, 'a')]]), 2, {
        includeUpdates: true,
      });
      assert.equal(sent[0]?.body, expected, `${type} should read as "${expected}"`);
    }
  });

  it('shows the last path segment, not the whole provider-relative path', async () => {
    // A deep path read aloud in full is worse than useless; the leaf is what is recognised.
    const { sent } = await watchAndPoll(
      pollProvider([[], [change('created', 'threads/2024/q1/kickoff')]]),
      2,
    );
    assert.equal(sent[0]?.body, 'New: kickoff');
  });

  it('still prefers the node when the provider supplies one', async () => {
    // Built-in providers do attach nodes, and their richer summary must not regress.
    const { sent } = await watchAndPoll(
      pollProvider([
        [],
        [change('created', 'm1', node({ title: 'Budget review', author: 'Ada' }))],
      ]),
      2,
    );
    assert.equal(sent[0]?.body, 'Ada: Budget review');
  });

  it('degrades to the generic phrase only when there is genuinely nothing to say', async () => {
    const { sent } = await watchAndPoll(pollProvider([[], [change('created', '')]]), 2);
    assert.equal(sent[0]?.body, 'Something changed.');
  });

  it('summarises a burst as one notification instead of one per change', async () => {
    // Fifty toasts is an accessibility failure, not just a nuisance: a screen reader
    // queues them all and the user cannot interrupt.
    const { sent } = await watchAndPoll(
      pollProvider([
        [],
        [change('created', 'a'), change('created', 'b'), change('created', 'c')],
      ]),
      2,
    );

    assert.equal(sent.length, 1, 'a burst must collapse to a single delivery');
    assert.match(sent[0]?.title ?? '', /3 updates/);
    assert.equal(sent[0]?.body, 'New: a and 2 more');
  });
});

describe('watcher relevance', () => {
  it('does not notify about edits and deletions unless the watch asked for them', async () => {
    // Discovered by writing a test that assumed the opposite. Backends emit `updated`
    // for things a person did not do and does not care about — a read receipt, a
    // re-indexed body — so an interruption for each one would train the user to ignore
    // the feature. `watch --updates` opts in.
    const { sent, changes } = await watchAndPoll(
      pollProvider([[], [change('updated', 'a'), change('deleted', 'b')]]),
      2,
    );

    assert.equal(sent.length, 0, 'nothing should be delivered by default');
    assert.equal(changes[1]?.length, 0, 'and they are filtered before reaching callers');
  });

  it('notifies about the same events once the watch opts in', async () => {
    const { sent } = await watchAndPoll(
      pollProvider([[], [change('updated', 'a'), change('deleted', 'b')]]),
      2,
      { includeUpdates: true },
    );
    assert.equal(sent.length, 1, 'the pair collapses into one summary');
    assert.match(sent[0]?.title ?? '', /2 updates/);
  });
});

describe('watcher priming', () => {
  it('stays silent on the first poll so watching a full mailbox is not a flood', async () => {
    const { sent, changes } = await watchAndPoll(
      pollProvider([[change('created', 'old-1'), change('created', 'old-2')]]),
      1,
    );

    assert.equal(sent.length, 0, 'the seeding poll must not notify');
    assert.equal(changes[0]?.length, 0, 'and must report no changes to callers either');
  });
});
