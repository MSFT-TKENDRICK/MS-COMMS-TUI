/**
 * Tests for the fixture provider's actions.
 *
 * These are the offline proof that the action surface works end to end, and they are
 * written to catch the specific way a demo goes wrong: an action that reports success and
 * changes nothing. So almost every assertion here is made *after* re-listing or re-reading
 * — the question is never "did invoke resolve" but "does the next thing the user looks at
 * show what they just did".
 *
 * The applicability tests matter for the same reason from the other direction. Offering to
 * merge a merged pull request, or to mark an already-read message read, is how a menu
 * teaches people that it cannot be trusted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VfsError, type VNode } from '@mscomms/core';

import { MemoryProvider } from '../provider.js';

const now = (): number => Date.UTC(2026, 7, 11, 12, 0, 0);

function provider(fixture: 'mail' | 'chat' | 'issues' | 'people'): MemoryProvider {
  return new MemoryProvider({ fixture, now, pageSize: 200 });
}

async function children(source: MemoryProvider, parent: VNode | null): Promise<readonly VNode[]> {
  const page = await source.list(parent, {});
  return page.entries;
}

/** Walk to a node by title, which is how the fixtures are readable. */
async function find(source: MemoryProvider, ...titles: readonly string[]): Promise<VNode> {
  let parent: VNode | null = null;
  let found: VNode | undefined;
  for (const title of titles) {
    const entries = await children(source, parent);
    found = entries.find((entry) => entry.title === title || entry.title.startsWith(title));
    assert.ok(found !== undefined, `no child titled "${title}" among ${entries.map((e) => e.title).join(', ')}`);
    parent = found;
  }
  assert.ok(found !== undefined);
  return found;
}

/** Re-fetch a node from its parent, so assertions see the provider's current view of it. */
async function refetch(source: MemoryProvider, parent: VNode, id: string): Promise<VNode> {
  const found = (await children(source, parent)).find((entry) => entry.id === id);
  assert.ok(found !== undefined, `${id} is gone from ${parent.title}`);
  return found;
}

async function names(source: MemoryProvider, node: VNode): Promise<readonly string[]> {
  return (await source.actions(node)).map((descriptor) => descriptor.name);
}

describe('fixture actions: pull requests', () => {
  it('offers the review verbs on an open pull request', async () => {
    const source = provider('issues');
    const pr = await find(source, 'pulls', '#14');

    const offered = await names(source, pr);
    for (const verb of ['approve', 'request-changes', 'comment-review', 'merge', 'close', 'comment', 'assign']) {
      assert.ok(offered.includes(verb), `expected ${verb} in ${offered.join(', ')}`);
    }
  });

  it('does not offer to merge a draft', async () => {
    const source = provider('issues');
    const draft = await find(source, 'pulls', '#15');

    const offered = await names(source, draft);
    assert.ok(!offered.includes('merge'), 'a draft is explicitly not ready to merge');
    assert.ok(offered.includes('approve'), 'but it can still be reviewed');
  });

  it('offers no review verbs on a merged pull request', async () => {
    const source = provider('issues');
    const merged = await find(source, 'pulls', '#11');

    const offered = await names(source, merged);
    for (const verb of ['approve', 'request-changes', 'merge', 'close', 'reopen']) {
      assert.ok(!offered.includes(verb), `${verb} should be gone once merged`);
    }
    assert.ok(offered.includes('comment'), 'you can still comment on it');
  });

  it('records an approval where the listing and the reader can both see it', async () => {
    const source = provider('issues');
    const pulls = await find(source, 'pulls');
    const pr = await find(source, 'pulls', '#14');

    const result = await source.invoke('approve', pr, { body: 'Paging looks right.' });
    assert.equal(result.ok, true);
    assert.match(result.message, /^Approved/);

    const after = await refetch(source, pulls, 'pr-14');
    assert.ok(after.flags?.includes('approved'), 'the flag a listing can filter on');
    assert.equal(after.meta?.['review'], 'approved', 'the metadata a reader sees');

    // And the review is a real item in the conversation, not just a flag.
    const review = (await children(source, pulls)).find((entry) => entry.subtype === 'review');
    assert.ok(review !== undefined, 'the review should appear beside the pull request');
    const document = await source.read(review, {});
    assert.match(document.body, /Paging looks right\./);
  });

  it('will not block a merge without saying why', async () => {
    const source = provider('issues');
    const pr = await find(source, 'pulls', '#14');

    await assert.rejects(
      () => source.invoke('request-changes', pr, {}),
      (error: VfsError) => error.code === 'EINVAL' && /needs body/.test(error.message),
    );
  });

  it('merges, and then stops offering to', async () => {
    const source = provider('issues');
    const pulls = await find(source, 'pulls');
    const pr = await find(source, 'pulls', '#14');

    const result = await source.invoke('merge', pr, { method: 'squash' });
    assert.match(result.message, /squash/);

    const after = await refetch(source, pulls, 'pr-14');
    assert.ok(after.flags?.includes('merged'));
    assert.equal(after.meta?.['state'], 'merged');
    assert.deepEqual(
      (await names(source, after)).filter((name) => name === 'merge' || name === 'approve'),
      [],
    );
  });

  it('refuses a merge method it never offered', async () => {
    const source = provider('issues');
    const pr = await find(source, 'pulls', '#14');
    await assert.rejects(
      () => source.invoke('merge', pr, { method: 'cherry-pick' }),
      (error: VfsError) => /must be one of merge, squash, rebase/.test(error.message),
    );
  });

  it('explains that a verb does not apply rather than that it does not exist', async () => {
    const source = provider('issues');
    const merged = await find(source, 'pulls', '#11');
    await assert.rejects(
      () => source.invoke('merge', merged, {}),
      (error: VfsError) => {
        assert.equal(error.code, 'EINVAL');
        assert.match(error.message, /does not apply/);
        return true;
      },
    );
  });
});

describe('fixture actions: issues', () => {
  it('closes with a reason and can be reopened', async () => {
    const source = provider('issues');
    const folder = await find(source, 'issues');
    const issue = await find(source, 'issues', '#13');

    await source.invoke('close', issue, { reason: 'not-planned' });
    let after = await refetch(source, folder, 'issue-13');
    assert.ok(after.flags?.includes('closed'));
    assert.equal(after.meta?.['closedReason'], 'not-planned');
    assert.ok(!(await names(source, after)).includes('close'));

    await source.invoke('reopen', after, {});
    after = await refetch(source, folder, 'issue-13');
    assert.ok(!after.flags?.includes('closed'));
    assert.equal(after.meta?.['state'], 'open');
  });

  it('adds labels without discarding the ones already there', async () => {
    const source = provider('issues');
    const folder = await find(source, 'issues');
    const issue = await find(source, 'issues', '#12');

    await source.invoke('label', issue, { labels: 'needs-triage, performance' });

    const after = await refetch(source, folder, 'issue-12');
    const labels = String(after.meta?.['labels']).split(',');
    assert.deepEqual(labels, ['bug', 'performance', 'needs-triage'], 'existing kept, duplicates not repeated');
  });

  it('counts a comment and leaves it where it can be read', async () => {
    const source = provider('issues');
    const folder = await find(source, 'issues');
    const issue = await find(source, 'issues', '#12');

    await source.invoke('comment', issue, { body: 'Reproduced on a 40k folder.' });

    const after = await refetch(source, folder, 'issue-12');
    assert.equal(after.meta?.['comments'], 4, 'the fixture started at 3');
    const comment = (await children(source, folder)).find((entry) => entry.subtype === 'comment');
    assert.ok(comment !== undefined);
    assert.match((await source.read(comment, {})).body, /Reproduced/);
  });
});

describe('fixture actions: mail', () => {
  it('puts a reply beside the message rather than inside it', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    const entries = await children(source, inbox);
    const message = entries.find((entry) => entry.kind === 'file');
    assert.ok(message !== undefined);

    const before = entries.length;
    await source.invoke('reply', message, { body: 'On it.' });

    const after = await children(source, inbox);
    assert.equal(after.length, before + 1, 'the reply lands in the folder');

    // The message itself must still be readable — appending to it would have turned it
    // into a directory, which is the exact bug this arrangement exists to avoid.
    const original = after.find((entry) => entry.id === message.id);
    assert.ok(original !== undefined);
    assert.equal(original.kind, 'file');
    await source.read(original, {});

    const reply = after.find((entry) => entry.title.startsWith('Re: '));
    assert.ok(reply !== undefined);
    assert.match((await source.read(reply, {})).body, /On it\./);
  });

  it('does not stack Re: prefixes', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    const message = (await children(source, inbox)).find((entry) => entry.kind === 'file');
    assert.ok(message !== undefined);

    // Tracked by id, because the fixture deliberately contains a subject that already
    // reads `Re: Re: Re: FWD: …` — the mess this strip exists to avoid adding to.
    const before = new Set((await children(source, inbox)).map((entry) => entry.id));
    await source.invoke('reply', message, { body: 'one' });
    const reply = (await children(source, inbox)).find((entry) => !before.has(entry.id));
    assert.ok(reply !== undefined);
    assert.ok(reply.title.startsWith('Re: '), reply.title);

    const second = new Set((await children(source, inbox)).map((entry) => entry.id));
    await source.invoke('reply', reply, { body: 'two' });
    const nested = (await children(source, inbox)).find((entry) => !second.has(entry.id));
    assert.ok(nested !== undefined);
    assert.ok(!nested.title.startsWith('Re: Re:'), nested.title);
  });

  it('needs somewhere to send a forward', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    const message = (await children(source, inbox)).find((entry) => entry.kind === 'file');
    assert.ok(message !== undefined);

    await assert.rejects(() => source.invoke('forward', message, { body: 'fyi' }));

    const result = await source.invoke('forward', message, { to: 'ada@contoso.example, grace@contoso.example' });
    assert.match(result.message, /ada@contoso\.example, grace@contoso\.example/);
  });

  it('offers read or unread, never both', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    const message = (await children(source, inbox)).find((entry) => entry.kind === 'file');
    assert.ok(message !== undefined);

    const offered = await names(source, message);
    assert.equal(offered.filter((name) => name === 'read' || name === 'unread').length, 1);
  });

  it('archiving also clears unread, because that is what archiving means', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    const unread = (await children(source, inbox)).find((entry) => entry.flags?.includes('unread') === true);
    assert.ok(unread !== undefined, 'the mail fixture should have something unread');

    await source.invoke('archive', unread, {});
    const after = await refetch(source, inbox, unread.id);
    assert.ok(after.flags?.includes('archived'));
    assert.ok(!after.flags?.includes('unread'));
  });
});

describe('fixture actions: chat', () => {
  it('sends into a conversation and the conversation grows', async () => {
    const source = provider('chat');
    const chat = await find(source, 'Chats', 'Release crew');

    const before = (await children(source, chat)).length;
    const result = await source.invoke('send', chat, { body: 'Running five minutes late.' });
    assert.match(result.message, /Sent a message/);

    const after = await children(source, chat);
    assert.equal(after.length, before + 1);
    assert.equal(after[0]?.title, 'Running five minutes late.', 'newest first, where you expect to find it');
  });

  it('offers send on a channel and a thread as well as a chat', async () => {
    const source = provider('chat');
    for (const path of [
      ['Chats', 'Priya Raman'],
      ['Teams', 'Platform Engineering', 'General'],
      ['Teams', 'Platform Engineering', 'General', 'Deprecating'],
    ]) {
      const node = await find(source, ...path);
      assert.ok((await names(source, node)).includes('send'), `${path.join('/')} should accept a message`);
    }
  });

  it('does not offer send on an individual message', async () => {
    const source = provider('chat');
    const chat = await find(source, 'Chats', 'Priya Raman');
    const message = (await children(source, chat)).find((entry) => entry.kind === 'file');
    assert.ok(message !== undefined);

    const offered = await names(source, message);
    assert.ok(!offered.includes('send'), offered.join(', '));
    assert.ok(offered.includes('reply'), 'but it can be replied to');
  });

  it('does not offer send on the folder the chats are in', async () => {
    const source = provider('chat');
    const folder = await find(source, 'Chats');
    assert.ok(!(await names(source, folder)).includes('send'));
  });
});

describe('fixture actions: the contract', () => {
  it('reports an unknown verb as unsupported, not as inapplicable', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    await assert.rejects(
      () => source.invoke('detonate', inbox, {}),
      (error: VfsError) => error.code === 'ENOTSUP',
    );
  });

  it('marks the destructive verbs as destructive', async () => {
    const source = provider('issues');
    const pr = await find(source, 'pulls', '#14');
    const descriptors = await source.actions(pr);

    for (const name of ['merge', 'close']) {
      const descriptor = descriptors.find((candidate) => candidate.name === name);
      assert.ok(descriptor?.destructive === true, `${name} should ask for confirmation`);
    }
  });

  it('names every action it invalidates, so a frontend knows what to redraw', async () => {
    const source = provider('mail');
    const inbox = await find(source, 'Inbox');
    const message = (await children(source, inbox)).find((entry) => entry.kind === 'file');
    assert.ok(message !== undefined);

    const result = await source.invoke('flag', { ...message, path: '/demo-mail/Inbox/x' }, {});
    assert.deepEqual(result.invalidates, ['/demo-mail/Inbox/x']);
  });

  // The fixtures are module-level constants shared by every provider in the process, so an
  // action that wrote through to one would leak this test's approvals into the next.
  it('does not let one provider\u2019s actions affect another\u2019s data', async () => {
    const first = provider('issues');
    const second = provider('issues');

    await first.invoke('merge', await find(first, 'pulls', '#14'), {});

    const untouched = await find(second, 'pulls', '#14');
    assert.ok(!untouched.flags?.includes('merged'));
    assert.equal(untouched.meta?.['state'], 'open');
  });
});
