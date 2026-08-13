/**
 * View-synchronization tests.
 *
 * `applySessionEvent` is the whole contract behind "the view stays in sync": nothing is
 * allowed to change the world and then separately tell the pane about it. The world says
 * what happened, and the pane folds that into its state. These tests pin the two decisions
 * in that fold that are easy to get wrong and impossible to notice — re-listing when the
 * pane already moved (which fights the user's own navigation) and re-listing on a change
 * somewhere else entirely (which yanks the selection out from under a reader).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { VNode } from '@mscomms/core';
import { applySessionEvent, initialState, reduce, withListing, type TuiState } from '../tui/state.js';

function node(name: string, extra: Partial<VNode> = {}): VNode {
  return { name, kind: 'file', title: name, id: `id-${name}`, ...extra };
}

function stateAt(cwd: string, overrides: Partial<TuiState> = {}): TuiState {
  return { ...initialState(cwd), busy: false, status: 'Ready.', ...overrides };
}

describe('a folder change somewhere else in the program', () => {
  it('re-lists so the pane shows where the session actually is', () => {
    const step = applySessionEvent(stateAt('/mail'), { kind: 'cwd', path: '/mail/Inbox', reason: 'cd' });
    assert.deepEqual(step.effects, [{ kind: 'list', path: '/mail/Inbox' }]);
    assert.equal(step.state.busy, true);
    assert.match(step.state.status, /\/mail\/Inbox/);
  });

  it('does nothing when the pane is already there', () => {
    // The pane moved itself and the session is echoing it back. Re-listing here would
    // fight the user's own navigation and could land them a page behind.
    const state = stateAt('/mail/Inbox', { selected: 4 });
    const step = applySessionEvent(state, { kind: 'cwd', path: '/mail/Inbox', reason: 'cd' });
    assert.deepEqual(step.effects, []);
    assert.equal(step.state, state);
  });
});

describe('data changing underneath', () => {
  it('refreshes when the change is in the folder on screen', () => {
    const step = applySessionEvent(stateAt('/mail/Inbox'), {
      kind: 'mutated',
      paths: ['/mail/Inbox/3'],
      message: 'Marked as read.',
    });
    assert.deepEqual(step.effects, [{ kind: 'list', path: '/mail/Inbox' }]);
    assert.equal(step.state.status, 'Marked as read.');
  });

  it('refreshes when the folder itself is the thing that changed', () => {
    const step = applySessionEvent(stateAt('/mail/Inbox'), {
      kind: 'mutated',
      paths: ['/mail/Inbox'],
      message: 'New mail.',
    });
    assert.deepEqual(step.effects, [{ kind: 'list', path: '/mail/Inbox' }]);
  });

  it('says so but does not re-list when the change is somewhere else', () => {
    // A background watch tick on another mount must not pull the selection away from
    // somebody who is halfway through reading a message.
    const step = applySessionEvent(stateAt('/mail/Inbox', { selected: 7 }), {
      kind: 'mutated',
      paths: ['/github/pulls/12'],
      message: 'A pull request was updated.',
    });
    assert.deepEqual(step.effects, []);
    assert.equal(step.state.selected, 7);
    assert.equal(step.state.status, 'A pull request was updated.');
  });
});

describe('the microphone indicator', () => {
  it('shows that it is listening, in words', () => {
    const step = applySessionEvent(stateAt('/mail'), { kind: 'voice', phase: 'listening' });
    assert.equal(step.state.voice.phase, 'listening');
    assert.match(step.state.status, /listening/i);
  });

  it('shows a partial transcript while it is still being spoken', () => {
    const step = applySessionEvent(stateAt('/mail'), { kind: 'voice', phase: 'listening', text: 'go to in' });
    assert.match(step.state.status, /go to in/);
  });

  it('repeats back what it heard, so a mishearing is visible before it acts', () => {
    const step = applySessionEvent(stateAt('/mail'), { kind: 'voice', phase: 'heard', text: 'archive it' });
    assert.match(step.state.status, /archive it/);
  });

  it('reports an error rather than falling silent', () => {
    const step = applySessionEvent(stateAt('/mail'), { kind: 'voice', phase: 'error', text: 'no microphone found' });
    assert.match(step.state.status, /no microphone found/);
    assert.equal(step.state.voice.phase, 'error');
  });

  it('leaves the status alone when the microphone goes idle', () => {
    // Going idle is not news. Overwriting the status would erase the result of whatever
    // the user just said, which is the one thing they are waiting to hear.
    const step = applySessionEvent(stateAt('/mail', { status: 'Marked as read.' }), { kind: 'voice', phase: 'idle' });
    assert.equal(step.state.status, 'Marked as read.');
  });

  it('never re-lists on a voice event, because hearing is not a change', () => {
    for (const phase of ['listening', 'transcribing', 'heard', 'idle', 'error'] as const) {
      assert.deepEqual(applySessionEvent(stateAt('/mail'), { kind: 'voice', phase }).effects, [], phase);
    }
  });
});

describe('listing events', () => {
  it('does not redraw, because the pane asked for this listing itself', () => {
    const state = stateAt('/mail');
    const step = applySessionEvent(state, { kind: 'listing', path: '/mail' });
    assert.deepEqual(step.effects, []);
    assert.equal(step.state, state);
  });
});

describe('journal events', () => {
  it('reports what happened without touching the listing', () => {
    const step = applySessionEvent(stateAt('/mail'), { kind: 'journal', summary: 'Undid: archived "Q3 budget".' });
    assert.equal(step.state.status, 'Undid: archived "Q3 budget".');
    assert.deepEqual(step.effects, []);
  });
});

describe('keys that reach the journal', () => {
  function browsing(entries: readonly VNode[]): TuiState {
    return withListing(initialState('/mail/Inbox', 10), '/mail/Inbox', entries);
  }

  it('asks the session to undo rather than mutating the view directly', () => {
    const step = reduce(browsing([node('Q3 budget review')]), { name: 'u', sequence: 'u' });
    assert.deepEqual(step.effects, [{ kind: 'command', line: 'undo' }]);
  });

  it('leaves the talk key alone, because a keypress reducer cannot see a key come up', () => {
    // Push-to-talk moved out of this reducer deliberately. Its meaning depends on the
    // release, which never reaches a keypress parser at all, so handling it here could only
    // ever have produced a toggle wearing a hold's name. See tui-push-to-talk.test.ts.
    const step = reduce(browsing([node('Q3 budget review')]), { name: 'space', ctrl: true, sequence: '\u0000' });
    assert.deepEqual(step.effects, []);
  });

  it('navigates through the session so arrow-key moves are undoable too', () => {
    // A pane that assigned `cwd` directly would be the one interaction in the program
    // that could not be undone, replayed, or spoken.
    const step = reduce(browsing([node('Archive', { kind: 'dir' })]), { name: 'return', sequence: '\r' });
    assert.deepEqual(step.effects, [{ kind: 'list', path: '/mail/Inbox/Archive' }]);
  });
});
