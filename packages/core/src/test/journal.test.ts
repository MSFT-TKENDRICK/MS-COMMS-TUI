/**
 * Journal tests.
 *
 * The journal is the piece that makes "everything is commandable" and "everything is
 * undoable" the same statement, so most of what is worth asserting here is about the
 * boundaries of undo rather than the happy path. In particular: that undo refuses to reach
 * past something it cannot reverse, and that it does not treat looking at a message as a
 * change worth taking back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeBus, Journal, reversalFor, type SessionEvent } from '../journal.js';

function fixedClock(): () => number {
  let tick = 0;
  return () => {
    tick += 1000;
    return tick;
  };
}

function journal(): Journal {
  return new Journal({ now: fixedClock() });
}

describe('recording', () => {
  it('numbers entries in the order they happened', () => {
    const log = journal();
    const first = log.record({ kind: 'read', command: 'ls', summary: 'listed /mail' });
    const second = log.record({ kind: 'read', command: 'cat 1', summary: 'read a message' });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
  });

  it('defaults the source to the shell but keeps voice honest', () => {
    const log = journal();
    assert.equal(log.record({ kind: 'read', command: 'ls', summary: 'listed' }).source, 'shell');
    const spoken = log.record({ kind: 'read', command: 'ls', summary: 'listed', source: 'voice' });
    assert.equal(spoken.source, 'voice');
  });

  it('drops the oldest entries rather than growing without bound', () => {
    const log = new Journal({ limit: 3, now: fixedClock() });
    for (let i = 1; i <= 5; i += 1) log.record({ kind: 'read', command: `ls ${i}`, summary: `listed ${i}` });
    assert.equal(log.entries.length, 3);
    assert.deepEqual(
      log.entries.map((entry) => entry.command),
      ['ls 3', 'ls 4', 'ls 5'],
    );
  });

  it('lists recent entries newest first, the way the question is asked', () => {
    const log = journal();
    log.record({ kind: 'read', command: 'ls', summary: 'listed' });
    log.record({ kind: 'navigate', command: 'cd /mail', summary: 'went to /mail' });
    assert.deepEqual(
      log.recent(2).map((entry) => entry.command),
      ['cd /mail', 'ls'],
    );
  });
});

describe('planning an undo', () => {
  it('says there is nothing to undo on an empty log', () => {
    const step = journal().planUndo();
    assert.equal(step.ok, false);
    if (!step.ok) assert.match(step.reason, /nothing to undo/i);
  });

  it('steps over reads, because undoing a look at something is a no-op', () => {
    // If undo appeared to do nothing, users would learn it is unreliable and stop using it.
    const log = journal();
    log.record({
      kind: 'navigate',
      command: 'cd /mail',
      summary: 'went to /mail',
      reversal: { kind: 'navigate', path: '/' },
    });
    log.record({ kind: 'read', command: 'ls', summary: 'listed /mail' });
    log.record({ kind: 'view', command: 'set page 50', summary: 'changed the page size' });

    const step = log.planUndo();
    assert.equal(step.ok, true);
    if (step.ok) assert.equal(step.entry.command, 'cd /mail');
  });

  it('refuses at an irreversible change instead of reaching past it', () => {
    // The dangerous version of this is a skipping undo: archive, then reply, then undo
    // silently un-archives the message you just replied to. Two steps back, unasked.
    const log = journal();
    log.record({
      kind: 'mutate',
      command: 'do archive 1',
      summary: 'archived "Q3 budget"',
      reversal: { kind: 'invoke', action: 'unarchive', target: { path: '/mail/Inbox/1' } },
    });
    log.record({ kind: 'mutate', command: 'do reply 1', summary: 'sent a reply', irreversible: 'A sent reply cannot be unsent.' });

    const step = log.planUndo();
    assert.equal(step.ok, false);
    if (!step.ok) {
      assert.match(step.reason, /cannot be unsent/i);
      assert.equal(step.blockedBy?.command, 'do reply 1');
    }
  });

  it('explains itself even when the provider gave no reason', () => {
    const log = journal();
    log.record({ kind: 'mutate', command: 'do send', summary: 'sent a message' });
    const step = log.planUndo();
    assert.equal(step.ok, false);
    if (!step.ok) assert.match(step.reason, /cannot be undone/i);
  });

  it('steps past an irreversible entry only when explicitly asked', () => {
    const log = journal();
    log.record({
      kind: 'mutate',
      command: 'do archive 1',
      summary: 'archived "Q3 budget"',
      reversal: { kind: 'invoke', action: 'unarchive', target: { path: '/mail/Inbox/1' } },
    });
    log.record({ kind: 'mutate', command: 'do reply 1', summary: 'sent a reply' });

    const step = log.planUndo({ skipIrreversible: true });
    assert.equal(step.ok, true);
    if (step.ok) assert.equal(step.entry.command, 'do archive 1');
  });

  it('does not remove the entry until the reversal is committed', () => {
    // Deciding and committing are separate so a backend failure on the way back leaves the
    // journal describing the world as it is, not as we hoped it would be.
    const log = journal();
    log.record({
      kind: 'navigate',
      command: 'cd /mail',
      summary: 'went to /mail',
      reversal: { kind: 'navigate', path: '/' },
    });
    const step = log.planUndo();
    assert.equal(log.entries.length, 1);
    assert.equal(step.ok, true);
    if (step.ok) {
      log.commitUndo(step.entry);
      assert.equal(log.entries.length, 0);
      assert.equal(log.redoable.length, 1);
    }
  });
});

describe('redo', () => {
  function undone(): Journal {
    const log = journal();
    log.record({
      kind: 'navigate',
      command: 'cd /mail',
      summary: 'went to /mail',
      reversal: { kind: 'navigate', path: '/' },
    });
    const step = log.planUndo();
    if (step.ok) log.commitUndo(step.entry);
    return log;
  }

  it('re-runs the original command line rather than inventing one', () => {
    const step = undone().planRedo();
    assert.equal(step.ok, true);
    if (step.ok) assert.equal(step.command, 'cd /mail');
  });

  it('says there is nothing to redo when nothing was undone', () => {
    const step = journal().planRedo();
    assert.equal(step.ok, false);
    if (!step.ok) assert.match(step.reason, /nothing to redo/i);
  });

  it('discards the redo stack once the user does something new', () => {
    // Otherwise redo would reapply a change on top of a world that has since moved.
    const log = undone();
    log.record({ kind: 'mutate', command: 'do flag 2', summary: 'flagged an item' });
    assert.equal(log.redoable.length, 0);
    assert.equal(log.planRedo().ok, false);
  });

  it('keeps the redo stack when the new entry is itself an undo or redo', () => {
    const log = undone();
    log.record({ kind: 'navigate', command: 'cd /', summary: 'went back to /', source: 'undo' });
    assert.equal(log.redoable.length, 1);
  });

  it('clears the entry from the stack once redo has been committed', () => {
    const log = undone();
    const step = log.planRedo();
    assert.equal(step.ok, true);
    if (step.ok) {
      log.commitRedo(step.entry);
      assert.equal(log.redoable.length, 0);
    }
  });
});

describe('building a reversal from what a provider reported', () => {
  it('produces nothing when the provider named no inverse', () => {
    assert.equal(reversalFor({ path: '/mail/Inbox/1' }, undefined), undefined);
  });

  it('carries the target, because an inverse verb alone cannot undo anything', () => {
    const reversal = reversalFor({ path: '/mail/Inbox/1', id: 'abc' }, { action: 'unread' });
    assert.deepEqual(reversal, { kind: 'invoke', action: 'unread', target: { path: '/mail/Inbox/1', id: 'abc' } });
  });

  it('passes through the parameters the inverse needs', () => {
    const reversal = reversalFor({ path: '/mail/Inbox/1' }, { action: 'untag', params: { tag: 'urgent' } });
    assert.equal(reversal?.kind, 'invoke');
    if (reversal?.kind === 'invoke') assert.deepEqual(reversal.params, { tag: 'urgent' });
  });
});

describe('the change bus', () => {
  it('delivers events to every subscriber', () => {
    const bus = new ChangeBus();
    const seen: SessionEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.subscribe((event) => seen.push(event));
    bus.emit({ kind: 'cwd', path: '/mail', reason: 'cd' });
    assert.equal(seen.length, 2);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new ChangeBus();
    const seen: SessionEvent[] = [];
    const off = bus.subscribe((event) => seen.push(event));
    off();
    bus.emit({ kind: 'cwd', path: '/mail', reason: 'cd' });
    assert.equal(seen.length, 0);
    assert.equal(bus.size, 0);
  });

  it('survives a subscriber that unsubscribes itself mid-notification', () => {
    // The TUI pane does exactly this on exit.
    const bus = new ChangeBus();
    const seen: string[] = [];
    const off = bus.subscribe(() => {
      seen.push('first');
      off();
    });
    bus.subscribe(() => seen.push('second'));
    bus.emit({ kind: 'journal', summary: 'did a thing' });
    assert.deepEqual(seen, ['first', 'second']);
  });

  it('does not let a broken subscriber take down the interaction', () => {
    // The user asked to open a folder, not to hear about a rendering bug.
    const bus = new ChangeBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('render failed');
    });
    bus.subscribe(() => seen.push('still ran'));
    assert.doesNotThrow(() => bus.emit({ kind: 'listing', path: '/mail' }));
    assert.deepEqual(seen, ['still ran']);
  });
});
