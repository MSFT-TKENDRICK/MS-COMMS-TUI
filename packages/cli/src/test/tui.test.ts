/**
 * Tests for the full-screen view.
 *
 * The whole point of splitting the TUI into a pure reducer and a pure renderer was so this
 * file could exist without a terminal. Two classes of bug are worth catching here, and
 * neither is visible in a diff:
 *
 * 1. **Layout.** `displayWidth` counts ANSI escapes as columns, so colouring a string before
 *    padding it silently makes that row wider than the screen, and the row wraps, and every
 *    row beneath it is corrupted. The width assertions below strip escapes and check the
 *    visible width, which is the only measurement that matters.
 * 2. **Interaction.** Off-by-ones at list boundaries, a filter that only applies on Enter, a
 *    key that quietly does nothing. These are the things that make an interface feel broken.
 *
 * The `describeSelection` tests are accessibility tests, not cosmetics: that string is what
 * gets spoken, and it is what is printed to the real screen when the pane exits.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActionDescriptor, VNode } from '@mscomms/core';
import { DEFAULT_FORMAT, displayWidth } from '../format.js';
import { bodyRows, fit, render, renderHelp, workingLabel, CHROME_ROWS } from '../tui/render.js';
import type { RenderOptions } from '../tui/render.js';
import {
  accelerators,
  describeSelection,
  initialState,
  isFetching,
  reduce,
  selectedNode,
  shouldRefuseTui,
  visibleEntries,
  withActionResult,
  withActions,
  withError,
  withFreshListing,
  withListing,
  withPreview,
  withProgress,
  withRefusal,
  withRows,
} from '../tui/state.js';
import type { Key, TuiState } from '../tui/state.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replace(ANSI, '');
}

function node(name: string, extra: Partial<VNode> = {}): VNode {
  return {
    name,
    kind: 'file',
    title: name,
    id: `id-${name}`,
    ...extra,
  };
}

const ENTRIES: readonly VNode[] = [
  node('Inbox', { kind: 'dir', title: 'Inbox' }),
  node('2024-01-01-budget-review.eml', { title: 'Budget review', author: 'Ada Lovelace', flags: ['unread'] }),
  node('2024-01-02-lunch.eml', { title: 'Lunch?', author: 'Grace Hopper' }),
  node('2024-01-03-status.eml', { title: 'Status', author: 'Ada Lovelace' }),
];

function stateWith(entries: readonly VNode[] = ENTRIES, rows = 10): TuiState {
  return withListing(initialState('/mail', rows), '/mail', entries);
}

function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, ...extra };
}

function char(sequence: string): Key {
  return { sequence, name: sequence };
}

const OPTIONS: RenderOptions = { ...DEFAULT_FORMAT, color: false, columns: 80, rows: 24 };

// ---------------------------------------------------------------------------

describe('tui: movement', () => {
  it('moves down and back up', () => {
    let state = stateWith();
    assert.equal(state.selected, 0);
    state = reduce(state, key('down')).state;
    assert.equal(state.selected, 1);
    state = reduce(state, key('up')).state;
    assert.equal(state.selected, 0);
  });

  it('accepts j and k as well as arrows', () => {
    let state = stateWith();
    state = reduce(state, char('j')).state;
    assert.equal(state.selected, 1);
    state = reduce(state, char('k')).state;
    assert.equal(state.selected, 0);
  });

  it('stops at the top rather than wrapping', () => {
    // Wrapping is disorienting when you cannot see the whole list at once: you press up
    // once too often and are silently teleported to the far end.
    const state = reduce(stateWith(), key('up')).state;
    assert.equal(state.selected, 0);
  });

  it('stops at the bottom rather than wrapping', () => {
    let state = stateWith();
    for (let i = 0; i < 20; i += 1) state = reduce(state, key('down')).state;
    assert.equal(state.selected, ENTRIES.length - 1);
  });

  it('Home and End jump to the ends', () => {
    let state = reduce(stateWith(), key('end')).state;
    assert.equal(state.selected, ENTRIES.length - 1);
    state = reduce(state, key('home')).state;
    assert.equal(state.selected, 0);
  });

  it('never selects anything in an empty folder', () => {
    const state = reduce(stateWith([]), key('down')).state;
    assert.equal(state.selected, 0);
    assert.equal(selectedNode(state), undefined);
  });

  it('scrolls the window to keep the selection visible', () => {
    const many = Array.from({ length: 50 }, (_, i) => node(`m${String(i)}.eml`));
    let state = stateWith(many, 5);
    assert.equal(state.offset, 0);
    for (let i = 0; i < 7; i += 1) state = reduce(state, key('down')).state;
    assert.equal(state.selected, 7);
    assert.ok(state.offset > 0, 'window should have scrolled');
    assert.ok(state.selected >= state.offset && state.selected < state.offset + state.rows);
  });
});

describe('tui: opening things', () => {
  it('asks to list a folder, using the joined path', () => {
    const step = reduce(stateWith(), key('return'));
    assert.deepEqual(step.effects, [{ kind: 'list', path: '/mail/Inbox', nav: 'push' }]);
  });

  it('asks to read a file', () => {
    const state = reduce(stateWith(), key('down')).state;
    const step = reduce(state, key('return'));
    assert.equal(step.effects.length, 1);
    assert.equal(step.effects[0]?.kind, 'read');
  });

  it('goes up with Backspace, Left and h alike', () => {
    for (const k of ['backspace', 'left', 'h']) {
      const step = reduce(stateWith(), key(k));
      assert.deepEqual(step.effects, [{ kind: 'list', path: '/', nav: 'push' }], `${k} should go up`);
    }
  });

  it('refuses to go above the root, and says so instead of silently doing nothing', () => {
    const state = withListing(initialState('/', 10), '/', ENTRIES);
    const step = reduce(state, key('backspace'));
    assert.deepEqual(step.effects, [{ kind: 'bell' }]);
    assert.match(step.state.status, /root/i);
  });

  it('reports rather than throws when Enter lands on nothing', () => {
    const step = reduce(stateWith([]), key('return'));
    assert.deepEqual(step.effects, [{ kind: 'bell' }]);
    assert.match(step.state.status, /nothing/i);
  });
});

describe('tui: typeahead filter', () => {
  it('applies on every keystroke, not on Enter', () => {
    let state = reduce(stateWith(), char('/')).state;
    assert.equal(state.mode, 'filter');
    state = reduce(state, char('l')).state;
    assert.equal(state.filter, 'l');
    // "Lunch?" matches on title, "Lovelace" on author, "Inbox" on neither.
    assert.ok(visibleEntries(state).length < ENTRIES.length);
    assert.ok(visibleEntries(state).length > 0);
  });

  it('does NOT start a filter from a bare letter, so `q` cannot exit mid-word', () => {
    // The regression this guards: filtering for "quarterly" used to press `q` first, and
    // `q` quits. A rule with six invisible exceptions (q, r, h, j, k, l) is worse than a
    // rule with none, so letters are only ever text after `/` or `:`.
    const before = stateWith();
    const step = reduce(before, char('w'));
    assert.equal(step.state.mode, 'browse');
    assert.equal(step.state.filter, '');
    assert.deepEqual(step.effects, []);

    // And the specific catastrophe: `q` still quits, rather than silently becoming a letter.
    const quit = reduce(before, char('q'));
    assert.equal(quit.state.exiting, true);
    assert.deepEqual(
      quit.effects.map((e) => e.kind),
      ['quit'],
    );
  });

  it('starts a filter from /, which the footer advertises on every frame', () => {
    // `w` appears only in "budget-review" across this fixture.
    const state = reduce(reduce(stateWith(), char('/')).state, char('w')).state;
    assert.equal(state.mode, 'filter');
    assert.equal(state.filter, 'w');
    assert.deepEqual(
      visibleEntries(state).map((n) => n.name),
      ['2024-01-01-budget-review.eml'],
    );
  });

  it('matches name, title and author', () => {
    const byTitle = reduce(reduce(stateWith(), char('/')).state, char('L')).state;
    assert.ok(visibleEntries(byTitle).some((n) => n.title === 'Lunch?'));

    let byAuthor = reduce(stateWith(), char('/')).state;
    for (const c of 'hopper') byAuthor = reduce(byAuthor, char(c)).state;
    assert.deepEqual(
      visibleEntries(byAuthor).map((n) => n.author),
      ['Grace Hopper'],
    );
  });

  it('is case-insensitive', () => {
    let lower = reduce(stateWith(), char('/')).state;
    for (const c of 'budget') lower = reduce(lower, char(c)).state;
    let upper = reduce(stateWith(), char('/')).state;
    for (const c of 'BUDGET') upper = reduce(upper, char(c)).state;
    assert.deepEqual(
      visibleEntries(lower).map((n) => n.name),
      visibleEntries(upper).map((n) => n.name),
    );
  });

  it('backspaces a character at a time', () => {
    let state = reduce(stateWith(), char('/')).state;
    for (const c of 'bud') state = reduce(state, char(c)).state;
    assert.equal(state.filter, 'bud');
    state = reduce(state, key('backspace')).state;
    assert.equal(state.filter, 'bu');
  });

  it('Escape clears the filter and returns to browsing', () => {
    let state = reduce(stateWith(), char('/')).state;
    state = reduce(state, char('b')).state;
    state = reduce(state, key('escape')).state;
    assert.equal(state.mode, 'browse');
    assert.equal(state.filter, '');
    assert.equal(visibleEntries(state).length, ENTRIES.length);
  });

  it('Enter keeps the filter and returns to browsing', () => {
    let state = reduce(stateWith(), char('/')).state;
    state = reduce(state, char('b')).state;
    state = reduce(state, key('return')).state;
    assert.equal(state.mode, 'browse');
    assert.equal(state.filter, 'b');
  });

  it('lets arrows move the selection without leaving the filter', () => {
    let state = reduce(stateWith(), char('/')).state;
    state = reduce(state, char('e')).state;
    const before = state.selected;
    state = reduce(state, key('down')).state;
    assert.equal(state.mode, 'filter');
    assert.notEqual(state.selected, before);
  });

  it('keeps the selection in range when the filter shrinks the list', () => {
    let state = reduce(stateWith(), key('end')).state;
    assert.equal(state.selected, 3);
    state = reduce(state, char('/')).state;
    for (const c of 'budget') state = reduce(state, char(c)).state;
    assert.equal(visibleEntries(state).length, 1);
    assert.equal(state.selected, 0, 'selection must not dangle past the filtered list');
    assert.notEqual(selectedNode(state), undefined);
  });
});

describe('tui: the command escape hatch', () => {
  it(': opens a command line and Enter emits the command', () => {
    let state = reduce(stateWith(), char(':')).state;
    assert.equal(state.mode, 'command');
    for (const c of 'grep budget') state = reduce(state, char(c)).state;
    assert.equal(state.command, 'grep budget');

    const step = reduce(state, key('return'));
    assert.deepEqual(step.effects, [{ kind: 'command', line: 'grep budget' }]);
    assert.equal(step.state.mode, 'browse');
  });

  it('Escape cancels without running anything', () => {
    let state = reduce(stateWith(), char(':')).state;
    state = reduce(state, char('q')).state;
    const step = reduce(state, key('escape'));
    assert.deepEqual(step.effects, []);
    assert.equal(step.state.command, '');
    assert.equal(step.state.mode, 'browse');
  });

  it('an empty command line does nothing', () => {
    const state = reduce(stateWith(), char(':')).state;
    const step = reduce(state, key('return'));
    assert.deepEqual(step.effects, []);
  });

  it('letters that are browse bindings are literal text in command mode', () => {
    // `q` quits while browsing. If mode were not respected, typing `quit` would exit.
    let state = reduce(stateWith(), char(':')).state;
    for (const c of 'quit') state = reduce(state, char(c)).state;
    assert.equal(state.command, 'quit');
    assert.equal(state.exiting, false);
  });
});

describe('tui: help', () => {
  it('? opens help and any key closes it', () => {
    const opened = reduce(stateWith(), char('?')).state;
    assert.equal(opened.mode, 'help');
    assert.equal(reduce(opened, char('x')).state.mode, 'browse');
    assert.equal(reduce(opened, key('down')).state.mode, 'browse');
  });

  it('tells the reader the pane is optional', () => {
    const text = renderHelp(OPTIONS).join('\n');
    assert.match(text, /--tui/, 'help must name the flag that turns this off');
    assert.match(text, /line shell/i);
    assert.match(text, /adds no capability of its own/i);
  });

  it('documents every key the reducer actually implements', () => {
    const text = renderHelp(OPTIONS).join('\n');
    for (const fragment of ['Tab', 'Backspace', 'PageUp', 'Home', 'Enter', '/', ':', '?', 'q']) {
      assert.ok(text.includes(fragment), `help should mention ${fragment}`);
    }
  });
});

describe('tui: panes', () => {
  it('names the only way into a filter in the footer of both panes', () => {
    // `/` is the sole entry to filter mode, so a frame that does not name it is a frame
    // where the feature is undiscoverable.
    const list = render(stateWith(), { ...OPTIONS, columns: 100 });
    assert.ok(
      list.some((line) => line.includes('/ filter')),
      'list pane footer must advertise /',
    );

    const previewed = withPreview(stateWith(), 'Budget review', ['line one']);
    assert.equal(previewed.pane, 'preview');
    const preview = render(previewed, { ...OPTIONS, columns: 100 });
    assert.ok(
      preview.some((line) => line.includes('/ filter')),
      'preview pane footer must advertise / too, because / works there',
    );

    // And prove the claim: `/` really does open a filter from the preview pane.
    assert.equal(reduce(previewed, char('/')).state.mode, 'filter');
  });

  it('refuses to focus an empty preview, audibly', () => {
    const step = reduce(stateWith(), key('tab'));
    assert.equal(step.state.pane, 'list');
    assert.deepEqual(step.effects, [{ kind: 'bell' }]);
  });

  it('switches to the preview once there is one, and back again', () => {
    const previewed = withPreview(stateWith(), 'Budget review', ['line one', 'line two']);
    assert.equal(previewed.pane, 'preview');
    const back = reduce(previewed, key('tab')).state;
    assert.equal(back.pane, 'list');
    assert.equal(reduce(back, key('tab')).state.pane, 'preview');
  });

  it('scrolls the preview without moving the list selection', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`);
    let state = withPreview(stateWith(), 'Long', lines);
    const selected = state.selected;
    state = reduce(state, key('down')).state;
    assert.equal(state.previewOffset, 1);
    assert.equal(state.selected, selected, 'list selection must not move while reading');
  });

  it('clamps preview scrolling at both ends', () => {
    let state = withPreview(stateWith(), 'Short', ['a', 'b']);
    state = reduce(state, key('up')).state;
    assert.equal(state.previewOffset, 0);
    state = reduce(state, key('end')).state;
    assert.ok(state.previewOffset >= 0);
    assert.ok(state.previewOffset <= 2);
  });
});

describe('tui: quitting', () => {
  it('q, Escape and Ctrl+C all quit', () => {
    for (const k of [char('q'), key('escape'), key('c', { ctrl: true })]) {
      const step = reduce(stateWith(), k);
      assert.deepEqual(step.effects, [{ kind: 'quit' }], `${String(k.name)} should quit`);
      assert.equal(step.state.exiting, true);
    }
  });

  it('Ctrl+C escapes from every mode, including the ones where q is a letter', () => {
    // Without this there is a state a confused user cannot leave: in filter and command
    // mode `q` is literal text and Escape is the only way out, which is exactly the thing
    // they do not know if they are stuck.
    const base = stateWith();
    const modes: readonly [string, TuiState][] = [
      ['browse', base],
      ['filter', reduce(base, char('/')).state],
      ['command', reduce(base, char(':')).state],
      ['help', reduce(base, char('?')).state],
      ['preview', withPreview(base, 'Something', ['a', 'b'])],
    ];
    for (const [name, state] of modes) {
      const step = reduce(state, key('c', { ctrl: true }));
      assert.deepEqual(step.effects, [{ kind: 'quit' }], `Ctrl+C should quit from ${name}`);
      assert.equal(step.state.exiting, true, `Ctrl+C should set exiting from ${name}`);
    }
  });

  it('q does not quit while text is being typed', () => {
    const filtering = reduce(reduce(stateWith(), char('/')).state, char('q')).state;
    assert.equal(filtering.exiting, false);
    assert.equal(filtering.filter, 'q');
  });

  it('r and F5 refresh', () => {
    assert.deepEqual(reduce(stateWith(), char('r')).effects, [{ kind: 'refresh' }]);
    assert.deepEqual(reduce(stateWith(), key('f5')).effects, [{ kind: 'refresh' }]);
  });
});

describe('tui: the spoken description', () => {
  it('leads with position, because that is what you lose without sight', () => {
    const state = stateWith();
    assert.match(describeSelection(state), /^1 of 4, Inbox/);
  });

  it('names the author and the flags', () => {
    const state = reduce(stateWith(), key('down')).state;
    const text = describeSelection(state);
    assert.match(text, /Ada Lovelace/);
    assert.match(text, /unread/);
  });

  it('says a folder is a folder', () => {
    assert.match(describeSelection(stateWith()), /folder/);
  });

  it('explains an empty folder and an empty filter differently', () => {
    assert.match(describeSelection(stateWith([])), /empty/i);
    let filtered = reduce(stateWith(), char('/')).state;
    for (const c of 'zzzz') filtered = reduce(filtered, char(c)).state;
    assert.match(describeSelection(filtered), /nothing.*matches/i);
  });

  it('mentions the filter, so the count is never mysterious', () => {
    let state = reduce(stateWith(), char('/')).state;
    state = reduce(state, char('b')).state;
    assert.match(describeSelection(state), /filtered by "b"/);
  });

  it('is a plain sentence with no escape codes', () => {
    // It is printed to the real screen on exit and read aloud in between.
    const state = reduce(stateWith(), key('down')).state;
    assert.equal(describeSelection(state), strip(describeSelection(state)));
  });

  it('spells out what a folder\u2019s counter counts', () => {
    // The pane has room for `(3)` and no more. This sentence is where the number is told
    // what it is counting, so the digit on screen is never the only carrier.
    const state = stateWith([node('Inbox', { kind: 'dir', unreadCount: 3 })]);
    assert.match(describeSelection(state), /3 unread/);
  });

  it('does not invent a count for a folder that reported none', () => {
    const state = stateWith([node('Projects', { kind: 'dir' })]);
    assert.doesNotMatch(describeSelection(state), /unread/);
  });
});

/**
 * The unread counter in the list pane.
 *
 * It is a reserved column rather than a suffix on the name, so these check the two things
 * that go wrong with reserved columns: the row overflowing the pane, and the column being
 * paid for on screens that have nothing to put in it.
 */
describe('tui: the unread counter', () => {
  it('puts a folder\u2019s unread count on its row', () => {
    const state = stateWith([node('Inbox', { kind: 'dir', unreadCount: 3 })]);
    const lines = render(state, OPTIONS).map(strip);
    assert.ok(
      lines.some((line) => /Inbox\/\s+\(3\)/.test(line)),
      lines.join('\n'),
    );
  });

  it('marks the folder unread in the same column an unread message uses', () => {
    const state = stateWith([node('Inbox', { kind: 'dir', unreadCount: 3 })]);
    const row = render(state, OPTIONS).map(strip).find((line) => line.includes('Inbox/'));
    assert.match(row ?? '', /^> \*Inbox\//);
  });

  it('shows nothing for a folder with nothing unread', () => {
    const state = stateWith([node('Archive', { kind: 'dir', unreadCount: 0, childCount: 900 })]);
    const row = render(state, OPTIONS).map(strip).find((line) => line.includes('Archive/'));
    assert.doesNotMatch(row ?? '', /\(/);
  });

  it('costs no name width on a screenful with no counters in it', () => {
    // The column is measured over the rows actually drawn, so a mailbox elsewhere in the
    // tree with 3629 unread does not shrink every other listing in the session.
    const long = 'a-very-long-message-subject-line-that-will-not-fit-in-the-pane.eml';
    const narrow = { ...OPTIONS, columns: 40, rows: 24 };
    const plain = stateWith([node(long)]);
    const withCounter = stateWith([node(long), node('Inbox', { kind: 'dir', unreadCount: 3629 })]);

    /** How much of the name you actually get to read. */
    const shown = (state: TuiState): number => {
      const row = render(state, narrow).map(strip).find((line) => line.includes('a-very-long')) ?? '';
      let seen = 0;
      while (seen < long.length && row.includes(long.slice(0, seen + 1))) seen += 1;
      return seen;
    };

    assert.ok(shown(plain) > 0, 'the name should be visible at all');
    assert.ok(
      shown(plain) > shown(withCounter),
      `no counter on screen should buy back name width: ${String(shown(plain))} vs ${String(shown(withCounter))}`,
    );
  });

  it('keeps every row exactly the pane width, at every width and in colour', () => {
    const entries = [
      node('Inbox', { kind: 'dir', unreadCount: 3629, mtime: new Date('2026-08-11T10:00:00Z') }),
      node('An inconveniently long folder name that will not fit', { kind: 'dir', unreadCount: 7 }),
      node('2024-01-01-budget-review.eml', { author: 'Ada', flags: ['unread'] }),
    ];
    for (const columns of [40, 60, 80, 132]) {
      for (const color of [false, true]) {
        const state = withPreview(stateWith(entries), 'Budget review', ['body']);
        for (const [i, line] of render(state, { ...OPTIONS, color, columns, rows: 24 }).entries()) {
          assert.equal(strip(line).length, columns, `row ${String(i)} at ${String(columns)} columns`);
        }
      }
    }
  });
});

describe('tui: layout', () => {
  const widths = [40, 60, 80, 100, 132];

  it('emits lines of exactly the terminal width, monochrome', () => {
    for (const columns of widths) {
      const lines = render(stateWith(), { ...OPTIONS, columns, rows: 24 });
      for (const [i, line] of lines.entries()) {
        assert.equal(strip(line).length, columns, `row ${String(i)} at ${String(columns)} columns`);
      }
    }
  });

  it('emits lines of exactly the terminal width with colour on', () => {
    // The regression this guards: paint() before fit() makes a row wider than the screen,
    // it wraps, and every row below it is pushed out of place.
    for (const columns of widths) {
      const state = withPreview(stateWith(), 'Budget review', ['body line', 'another']);
      const lines = render(state, { ...OPTIONS, color: true, columns, rows: 24 });
      for (const [i, line] of lines.entries()) {
        assert.equal(strip(line).length, columns, `row ${String(i)} at ${String(columns)} columns`);
      }
    }
  });

  it('fills exactly the terminal height', () => {
    for (const rows of [10, 24, 50]) {
      assert.equal(render(stateWith(), { ...OPTIONS, rows }).length, rows);
    }
  });

  it('keeps both panes readable or does not split at all', () => {
    const state = withPreview(stateWith(), 'Budget review', ['body']);
    const narrow = render(state, { ...OPTIONS, columns: 40 });
    assert.ok(!narrow.some((line) => line.includes('\u2502')), 'should not split a 40-column terminal');
    const wide = render(state, { ...OPTIONS, columns: 100 });
    assert.ok(wide.some((line) => line.includes('\u2502')), 'should split a 100-column terminal');
  });

  it('marks the selection with a glyph, not only with colour', () => {
    const lines = render(stateWith(), OPTIONS).map(strip);
    const marked = lines.filter((line) => line.startsWith('> '));
    assert.equal(marked.length, 1);
    assert.match(marked[0] ?? '', /Inbox/);
  });

  it('keeps the marker while the preview has focus, so you do not lose your place', () => {
    const state = withPreview(stateWith(), 'Budget review', ['body']);
    const lines = render(state, OPTIONS).map(strip);
    assert.ok(lines.some((line) => line.startsWith('> ')));
  });

  it('marks unread with a glyph too', () => {
    const state = reduce(stateWith(), key('down')).state;
    const lines = render(state, OPTIONS).map(strip);
    assert.ok(lines.some((line) => line.includes('*') && line.includes('budget-review')));
  });

  it('shows the path and a count', () => {
    const title = strip(render(stateWith(), OPTIONS)[0] ?? '');
    assert.match(title, /\/mail/);
    assert.match(title, /4 items/);
  });

  it('shows how much of the list the filter kept', () => {
    let state = reduce(stateWith(), char('/')).state;
    for (const c of 'budget') state = reduce(state, char(c)).state;
    const title = strip(render(state, OPTIONS)[0] ?? '');
    assert.match(title, /1 of 4 match/);
  });

  it('never lets a hostile subject line repaint the terminal', () => {
    // A message subject is attacker-controlled text. Every row goes through
    // sanitizeForDisplay, so an escape sequence in a name cannot survive to the screen.
    const nasty = stateWith([node('evil\u001B[2Jname.eml', { title: 'x' })]);
    const lines = render(nasty, { ...OPTIONS, color: false });
    for (const line of lines) assert.ok(!line.includes('\u001B[2J'));
  });

  it('shows the status sentence verbatim', () => {
    const state = withError(stateWith(), 'Could not reach the server.');
    const lines = render(state, OPTIONS).map(strip);
    assert.ok(lines.some((line) => line.startsWith('Could not reach the server.')));
  });

  it('renders an empty folder without collapsing the layout', () => {
    const lines = render(stateWith([]), OPTIONS);
    assert.equal(lines.length, 24);
    assert.ok(lines.map(strip).some((line) => line.includes('(empty)')));
  });

  it('survives a terminal too small to be sensible', () => {
    for (const [columns, rows] of [
      [1, 1],
      [10, 3],
      [24, 6],
    ] as const) {
      const lines = render(stateWith(), { ...OPTIONS, columns, rows });
      assert.ok(lines.length >= 1);
      const width = strip(lines[0] ?? '').length;
      for (const line of lines) assert.equal(strip(line).length, width);
    }
  });
});

describe('tui: render helpers', () => {
  it('fit pads and truncates to an exact width', () => {
    assert.equal(fit('ab', 5), 'ab   ');
    assert.equal(fit('abcdefgh', 5).length, 5);
    assert.equal(fit('', 3), '   ');
    assert.equal(fit('anything', 0), '');
  });

  it('fit strips control characters before measuring', () => {
    assert.equal(fit('a\u001B[31mb', 6).length, 6);
  });

  it('bodyRows leaves room for the chrome and never returns zero', () => {
    assert.equal(bodyRows(24), 24 - CHROME_ROWS);
    assert.equal(bodyRows(1), 1);
    assert.equal(bodyRows(0), 1);
  });
});

describe('tui: refusing to start', () => {
  it('starts in a normal terminal', () => {
    assert.equal(shouldRefuseTui({ isTty: true, announce: false, plain: false }), undefined);
  });

  it('declines when output is redirected, and says what to do instead', () => {
    const reason = shouldRefuseTui({ isTty: false, announce: false, plain: false });
    assert.match(reason ?? '', /--tui/);
  });

  it('declines rather than silently ignoring --announce', () => {
    // Honouring one of two contradictory flags without saying so is the failure mode this
    // whole project is trying to avoid.
    const reason = shouldRefuseTui({ isTty: true, announce: true, plain: false });
    assert.match(reason ?? '', /announce/);
    assert.match(reason ?? '', /line shell/i);
  });

  it('declines rather than silently ignoring --plain', () => {
    assert.match(shouldRefuseTui({ isTty: true, announce: false, plain: true }) ?? '', /plain/);
  });
});

describe('tui: external transitions', () => {
  it('a new listing resets the filter, the selection and the pane', () => {
    let state = withPreview(stateWith(), 'Something', ['a']);
    state = reduce(state, char('/')).state;
    state = reduce(state, char('b')).state;

    const next = withListing(state, '/chat', [node('general', { kind: 'dir' })]);
    assert.equal(next.cwd, '/chat');
    assert.equal(next.filter, '');
    assert.equal(next.selected, 0);
    assert.equal(next.offset, 0);
    assert.equal(next.pane, 'list');
    assert.equal(next.busy, false);
  });

  it('a resize keeps the selection on screen', () => {
    const many = Array.from({ length: 100 }, (_, i) => node(`m${String(i)}.eml`));
    let state = stateWith(many, 40);
    for (let i = 0; i < 35; i += 1) state = reduce(state, key('down')).state;
    const shrunk = withRows(state, 5);
    assert.ok(shrunk.selected >= shrunk.offset && shrunk.selected < shrunk.offset + shrunk.rows);
  });

  it('an error clears busy so the view cannot wedge', () => {
    const state = withError({ ...stateWith(), busy: true }, 'Network unreachable.');
    assert.equal(state.busy, false);
    assert.equal(state.status, 'Network unreachable.');
  });
});

describe('tui: showing that it is alive', () => {
  it('advances the frame and the clock while busy', () => {
    const busy = { ...stateWith(), busy: true };
    const later = withProgress(withProgress(busy, 100), 250);
    assert.equal(later.tick, 2);
    assert.equal(later.busyMs, 250);
  });

  it('ignores a tick that arrives after the work finished', () => {
    // The repaint timer is cleared in a `finally`, but a timer that has already fired is
    // already queued. A settled screen must not start spinning again.
    const settled = withListing({ ...stateWith(), busy: true }, '/mail', ENTRIES);
    const stray = withProgress(settled, 9_000);
    assert.equal(stray.busy, false);
    assert.equal(stray.tick, 0);
    assert.equal(stray.busyMs, 0);
  });

  it('resets the clock when an operation ends, so the next one starts from zero', () => {
    const slow = withProgress({ ...stateWith(), busy: true }, 8_000);
    assert.ok(slow.busyMs > 0);
    for (const settled of [
      withListing(slow, '/mail', ENTRIES),
      withPreview(slow, 'Note', ['body']),
      withError(slow, 'Nope.'),
    ]) {
      assert.equal(settled.tick, 0, 'tick should be cleared');
      assert.equal(settled.busyMs, 0, 'elapsed should be cleared');
    }
  });

  it('changes what it draws from one tick to the next', () => {
    // The old view drew a static "— working" once and never touched it again, which for a
    // ten-second fetch is indistinguishable from a hang.
    const busy = { ...stateWith(), busy: true };
    const labels = new Set([0, 1, 2, 3].map((tick) => workingLabel({ ...busy, tick })));
    assert.equal(labels.size, 4);
  });

  it('shows the elapsed seconds only once they distinguish slow from stuck', () => {
    const busy = { ...stateWith(), busy: true };
    assert.doesNotMatch(workingLabel({ ...busy, busyMs: 1_500 }), /\ds/);
    assert.match(workingLabel({ ...busy, busyMs: 7_000 }), /7s/);
  });

  it('draws the indicator in the frame, not just in the state', () => {
    const busy = withProgress({ ...stateWith(), busy: true }, 5_000);
    const frame = strip(render(busy, OPTIONS).join('\n'));
    assert.match(frame, /working 5s/);
    assert.doesNotMatch(strip(render(stateWith(), OPTIONS).join('\n')), /working/);
  });
});

describe('tui: keys during a slow load', () => {
  it('knows which effects would cost a round trip', () => {
    // This predicate is what lets the view stay responsive: anything it calls false is safe
    // to honour while a request is outstanding.
    assert.equal(isFetching({ kind: 'list', path: '/mail' }), true);
    assert.equal(isFetching({ kind: 'read', node: ENTRIES[1] as VNode }), true);
    assert.equal(isFetching({ kind: 'refresh' }), true);
    assert.equal(isFetching({ kind: 'command', line: 'ls' }), true);
    assert.equal(isFetching({ kind: 'quit' }), false);
    assert.equal(isFetching({ kind: 'bell' }), false);
  });

  it('moving the selection asks for nothing, so it can always be honoured', () => {
    const step = reduce(stateWith(), key('down'));
    assert.equal(step.effects.some(isFetching), false);
  });

  it('quitting asks for nothing, so there is always a way out of a slow load', () => {
    for (const name of ['q', 'escape']) {
      const step = reduce(stateWith(), key(name));
      assert.equal(step.effects.some(isFetching), false);
      assert.ok(step.effects.some((effect) => effect.kind === 'quit'));
    }
  });

  it('opening something does ask, so it is the case that must be refused', () => {
    const step = reduce(stateWith(), key('return'));
    assert.equal(step.effects.some(isFetching), true);
  });

  it('a refusal explains itself and leaves the work running', () => {
    const busy = withProgress({ ...stateWith(), busy: true }, 3_000);
    const refused = withRefusal(busy);
    assert.equal(refused.busy, true, 'the outstanding request is untouched');
    assert.equal(refused.busyMs, busy.busyMs, 'and its clock keeps running');
    assert.match(refused.status, /still working/i);
    assert.match(refused.status, /q/, 'should say how to get out');
  });
});

// ---------------------------------------------------------------------------

describe('tui: going back and forth', () => {
  /** Walk the reducer the way the app does: press a key, then apply the listing it asked for. */
  function navigate(state: TuiState, k: Key, entries: readonly VNode[] = ENTRIES): TuiState {
    const step = reduce(state, k);
    const effect = step.effects.find((e) => e.kind === 'list');
    if (effect === undefined || effect.kind !== 'list') return step.state;
    return withListing(step.state, effect.path, entries, effect.nav === undefined ? {} : { nav: effect.nav });
  }

  it('remembers where it has been, and goes back there', () => {
    let state = stateWith();
    state = navigate(state, key('return')); // into /mail/Inbox
    assert.equal(state.cwd, '/mail/Inbox');

    state = navigate(state, char('['));
    assert.equal(state.cwd, '/mail', 'back should return to where we came from');
  });

  it('goes forward again after going back', () => {
    let state = stateWith();
    state = navigate(state, key('return'));
    state = navigate(state, char('['));
    state = navigate(state, char(']'));
    assert.equal(state.cwd, '/mail/Inbox');
  });

  it('back is not the same as up', () => {
    // The distinction that makes a history worth having. A `:` command can jump anywhere,
    // so back is wherever you were, while up is still the parent of where you are.
    let state = withListing(initialState('/', 10), '/teams/Chats', ENTRIES);
    state = withListing(state, '/mail/Inbox', ENTRIES);

    const afterBack = navigate(state, char('['));
    assert.equal(afterBack.cwd, '/teams/Chats', 'back follows the trail');

    const afterUp = navigate(state, key('backspace'));
    assert.equal(afterUp.cwd, '/mail', 'up follows the path');
  });

  it('a new move discards the forward trail', () => {
    // Otherwise forward offers a route the user has just abandoned.
    let state = stateWith();
    state = navigate(state, key('return'));
    state = navigate(state, char('['));
    state = navigate(state, key('backspace')); // somewhere new from here
    const step = reduce(state, char(']'));
    assert.deepEqual(step.effects, [{ kind: 'bell' }]);
    assert.match(step.state.status, /forward/i);
  });

  it('says so at the ends of the trail rather than ignoring the key', () => {
    const step = reduce(stateWith(), char('['));
    assert.deepEqual(step.effects, [{ kind: 'bell' }]);
    assert.match(step.state.status, /back/i);
  });

  it('accepts Alt+Left and Alt+Right as well', () => {
    let state = stateWith();
    state = navigate(state, key('return'));
    state = navigate(state, key('left', { meta: true }));
    assert.equal(state.cwd, '/mail', 'Alt+Left should go back, not up');
    state = navigate(state, key('right', { meta: true }));
    assert.equal(state.cwd, '/mail/Inbox');
  });

  it('puts the highlight back where it was', () => {
    // The difference between returning to a place and arriving at a new one. Without it,
    // stepping into a message and back out drops you at the top of a thousand-item Inbox.
    let state = stateWith();
    state = reduce(state, key('down')).state;
    state = reduce(state, key('down')).state;
    assert.equal(state.selected, 2);

    state = navigate(state, key('backspace')); // up to /
    assert.equal(state.selected, 0, 'a place never visited starts at the top');

    state = navigate(state, char('['));
    assert.equal(state.cwd, '/mail');
    assert.equal(state.selected, 2, 'returning should restore the selection');
  });
});

describe('tui: the last stage of a staged read', () => {
  const FRESH: readonly VNode[] = [
    node('urgent.eml', { title: 'Urgent', author: 'Ada Lovelace' }),
    ...ENTRIES,
  ];

  it('replaces the entries without moving the user', () => {
    // A snapshot answered instantly with something minutes old and the source has now said
    // what is really there. The list must catch up; the highlight must not.
    let state = stateWith();
    state = reduce(state, key('down')).state;
    const anchored = visibleEntries(state)[state.selected];

    const next = withFreshListing(state, '/mail', FRESH);
    assert.equal(next.entries.length, FRESH.length, 'the fresh listing should be shown');
    assert.equal(
      visibleEntries(next)[next.selected]?.name,
      anchored?.name,
      'the same item must still be selected, even though a row appeared above it',
    );
    assert.notEqual(next.selected, state.selected, 'which means the index had to move');
  });

  it('ignores news about somewhere else', () => {
    const state = stateWith();
    assert.equal(withFreshListing(state, '/teams', FRESH), state);
  });

  it('does not redraw underneath someone who is typing', () => {
    // Filter and command modes are the moments when the screen changing is most hostile:
    // the list is being narrowed keystroke by keystroke against what is on it.
    const filtering = reduce(stateWith(), char('/')).state;
    assert.equal(withFreshListing(filtering, '/mail', FRESH), filtering);

    const commanding = reduce(stateWith(), char(':')).state;
    assert.equal(withFreshListing(commanding, '/mail', FRESH), commanding);
  });

  it('does not pull the reader out of a message', () => {
    const reading = withPreview(stateWith(), 'Budget review', ['body']);
    assert.equal(withFreshListing(reading, '/mail', FRESH), reading);
  });

  it('copes with the selected item having gone away', () => {
    let state = stateWith();
    state = reduce(state, key('down')).state;
    state = reduce(state, key('down')).state;
    const next = withFreshListing(state, '/mail', [ENTRIES[0] as VNode]);
    assert.equal(next.entries.length, 1);
    assert.ok(next.selected >= 0 && next.selected < 1, 'the selection must stay on the list');
  });
});

// ---------------------------------------------------------------------------

/**
 * Tests for acting on the selection.
 *
 * The palette is the part of the pane that can do damage, so these lean on the two
 * questions that matter: can something be sent that the user did not mean to send, and can
 * the user get out of it. Every path into `invoke` is asserted to carry the exact
 * parameters that were typed, because the failure mode is not a crash — it is an approval
 * with the comment silently dropped.
 */
describe('tui: acting on the selection', () => {
  const REPLY: ActionDescriptor = {
    name: 'reply',
    label: 'Reply',
    group: 'reply',
    key: 'r',
    params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
  };
  const APPROVE: ActionDescriptor = { name: 'approve', label: 'Approve', group: 'review' };
  const MERGE: ActionDescriptor = { name: 'merge', label: 'Merge', group: 'review', destructive: true };
  const CLOSE: ActionDescriptor = {
    name: 'close',
    label: 'Close',
    destructive: true,
    params: [{ name: 'reason', type: 'choice', label: 'Reason', choices: ['completed', 'not-planned'] }],
  };
  const ALL = [APPROVE, MERGE, REPLY, CLOSE];

  function palette(descriptors: readonly ActionDescriptor[] = ALL): TuiState {
    const state = stateWith();
    return withActions(state, ENTRIES[1] as VNode, '/mail/2024-01-01-budget-review.eml', descriptors);
  }

  it('asks the provider what is possible instead of guessing', () => {
    const step = reduce(stateWith(), key('a'));
    assert.deepEqual(step.effects, [
      { kind: 'actions', node: ENTRIES[0], path: '/mail/Inbox' },
    ]);
    assert.equal(step.state.mode, 'browse', 'the palette opens only once the answer arrives');
  });

  it('works from the preview pane, so a reader never has to go back to the list', () => {
    const reading = withPreview(stateWith(), 'Inbox', ['body']);
    const step = reduce(reading, key('a'));
    assert.equal(step.effects[0]?.kind, 'actions');
  });

  it('says so rather than opening an empty menu', () => {
    const state = withActions(stateWith(), ENTRIES[1] as VNode, '/mail/x', []);
    assert.equal(state.mode, 'browse');
    assert.match(state.status, /nothing you can do/i);
  });

  it('names the item and the first action out loud when it opens', () => {
    const state = palette();
    assert.match(state.status, /4 actions for 2024-01-01-budget-review\.eml/);
    assert.match(state.status, /1 of 4, Approve/);
  });

  it('honours a provider\u2019s requested letter, and never assigns it twice', () => {
    // `reply` asks for `r`; `review`-group verbs would otherwise have taken it first.
    assert.deepEqual(accelerators(ALL), ['a', 'm', 'r', 'c']);
    assert.equal(new Set(accelerators(ALL)).size, ALL.length);
  });

  it('gives every action an accelerator even when the letters run out', () => {
    const same: readonly ActionDescriptor[] = [
      { name: 'aa', label: 'A' },
      { name: 'aa2', label: 'B', key: 'a' },
      { name: 'a', label: 'C' },
    ];
    const keys = accelerators(same);
    assert.equal(keys[1], 'a', 'the explicit request wins');
    assert.equal(new Set(keys).size, 3, keys.join(','));
    assert.ok(keys.every((k) => k !== ' '), keys.join(','));
  });

  it('runs a parameterless action straight away', () => {
    const step = reduce(palette(), char('a'));
    assert.deepEqual(step.effects, [
      {
        kind: 'invoke',
        action: 'approve',
        node: ENTRIES[1],
        path: '/mail/2024-01-01-budget-review.eml',
        params: {},
        label: 'Approve',
      },
    ]);
    assert.equal(step.state.mode, 'browse');
  });

  it('can also be driven with the arrows and Enter, for anyone who cannot see the letters', () => {
    let state = palette();
    state = reduce(state, key('down')).state;
    assert.match(state.status, /2 of 4, Merge/);
    const step = reduce(state, key('return'));
    assert.equal(step.state.mode, 'confirm', 'merge is destructive');
  });

  it('wraps rather than sticking at the ends', () => {
    let state = palette();
    state = reduce(state, key('up')).state;
    assert.equal(state.actionIndex, 3);
    state = reduce(state, key('down')).state;
    assert.equal(state.actionIndex, 0);
  });

  it('collects a parameter and passes exactly what was typed', () => {
    let state = palette();
    state = reduce(state, char('r')).state;
    assert.equal(state.mode, 'param');
    assert.match(state.status, /Reply.*required/);

    for (const c of 'on it') state = reduce(state, char(c)).state;
    const step = reduce(state, key('return'));

    assert.equal(step.effects.length, 1);
    const effect = step.effects[0];
    assert.ok(effect?.kind === 'invoke');
    assert.deepEqual(effect.params, { body: 'on it' });
  });

  it('turns a typed \\n into a real line break', () => {
    let state = reduce(palette(), char('r')).state;
    for (const c of 'one\\ntwo') state = reduce(state, char(c)).state;
    const effect = reduce(state, key('return')).effects[0];
    assert.ok(effect?.kind === 'invoke');
    assert.deepEqual(effect.params, { body: 'one\ntwo' });
  });

  it('will not send an empty answer to a required parameter', () => {
    const state = reduce(palette(), char('r')).state;
    const step = reduce(state, key('return'));
    assert.equal(step.state.mode, 'param', 'still asking');
    assert.match(step.state.status, /required/);
    assert.deepEqual(
      step.effects.map((effect) => effect.kind),
      ['bell'],
    );
  });

  it('lets an optional parameter be skipped, so the default applies', () => {
    let state = reduce(palette(), char('c')).state;
    assert.equal(state.mode, 'param');
    state = reduce(state, key('return')).state;
    assert.equal(state.mode, 'confirm', 'skipped straight to the confirmation');
    const step = reduce(state, key('y'));
    const effect = step.effects[0];
    assert.ok(effect?.kind === 'invoke');
    assert.deepEqual(effect.params, {}, 'absent, not blank — the provider applies its own default');
  });

  it('asks before doing something destructive', () => {
    const state = reduce(palette(), char('m')).state;
    assert.equal(state.mode, 'confirm');
    assert.match(state.status, /press y to confirm/);
    assert.deepEqual(reduce(state, char('m')).effects, [], 'anything but y cancels');
  });

  // Enter is the key someone is already pressing when a prompt appears, which is precisely
  // why it must not be the one that merges a pull request.
  it('does not accept Enter as a confirmation', () => {
    const state = reduce(palette(), char('m')).state;
    const step = reduce(state, key('return'));
    assert.deepEqual(step.effects, []);
    assert.match(step.state.status, /Nothing was sent/);
  });

  it('lets Escape out at every stage, sending nothing', () => {
    const chosen = reduce(palette(), char('r')).state;
    for (const state of [palette(), chosen, reduce(palette(), char('m')).state]) {
      const step = reduce(state, key('escape'));
      assert.deepEqual(step.effects, []);
      assert.equal(step.state.mode, 'browse');
      assert.equal(step.state.pending, undefined);
    }
  });

  it('keeps Ctrl+C working mid-parameter', () => {
    const state = reduce(palette(), char('r')).state;
    const step = reduce(state, key('c', { ctrl: true }));
    assert.deepEqual(
      step.effects.map((effect) => effect.kind),
      ['quit'],
    );
  });

  it('rings rather than silently ignoring a letter that is not bound', () => {
    const step = reduce(palette(), char('z'));
    assert.equal(step.state.mode, 'actions', 'the palette stays open');
    assert.deepEqual(
      step.effects.map((effect) => effect.kind),
      ['bell'],
    );
  });

  it('reports the result in the provider\u2019s own words', () => {
    const state = withActionResult(palette(), {
      ok: true,
      message: 'Approved #14.',
      details: ['Comment: looks right.'],
    });
    assert.equal(state.status, 'Approved #14. Comment: looks right.');
    assert.equal(state.mode, 'browse');
    assert.equal(state.busy, false);
  });

  it('abandons a half-filled action when something goes wrong', () => {
    const mid = reduce(palette(), char('r')).state;
    const state = withError(mid, 'The network went away.');
    assert.equal(state.mode, 'browse');
    assert.equal(state.pending, undefined);
  });

  it('treats acting as work, so keys are refused while it happens', () => {
    assert.equal(isFetching({ kind: 'actions', node: ENTRIES[0] as VNode, path: '/mail/Inbox' }), true);
    assert.equal(
      isFetching({ kind: 'invoke', action: 'approve', node: ENTRIES[0] as VNode, path: '/x', params: {}, label: 'Approve' }),
      true,
    );
  });
});

describe('tui: the palette on screen', () => {
  const ACTIONS: readonly ActionDescriptor[] = [
    { name: 'approve', label: 'Approve', group: 'review' },
    { name: 'merge', label: 'Merge', group: 'review', destructive: true },
    { name: 'reply', label: 'Reply', group: 'reply', key: 'r' },
  ];

  function palette(columns = 80): { state: TuiState; lines: string[] } {
    const state = withActions(stateWith(), ENTRIES[1] as VNode, '/mail/x', ACTIONS);
    return { state, lines: render(state, { ...OPTIONS, columns }) };
  }

  it('shows every action with the key that runs it', () => {
    const text = palette().lines.map(strip).join('\n');
    for (const [key, label] of [
      ['a', 'Approve'],
      ['m', 'Merge'],
      ['r', 'Reply'],
    ]) {
      assert.match(text, new RegExp(`${key as string}\\s+${label as string}`), `${label as string} needs its key shown`);
    }
  });

  it('groups them, and marks the ones that will ask first', () => {
    const text = palette().lines.map(strip).join('\n');
    assert.match(text, /review/);
    assert.match(text, /Merge !/);
    assert.doesNotMatch(text, /Approve !/);
  });

  it('names the item it is about', () => {
    assert.match(palette().lines.map(strip).join('\n'), /Actions .* Budget review/);
  });

  it('takes the whole width when there is no room to split', () => {
    const { lines } = palette(40);
    const text = lines.map(strip).join('\n');
    assert.match(text, /Approve/, 'the palette must still be reachable on a narrow terminal');
  });

  it('keeps every row exactly the terminal width', () => {
    for (const columns of [40, 60, 80, 120]) {
      for (const line of palette(columns).lines) {
        assert.equal(displayWidth(strip(line)), Math.max(24, columns), `${String(columns)}: ${strip(line)}`);
      }
    }
  });

  it('prompts on the input line while a parameter is being typed', () => {
    const withParam: readonly ActionDescriptor[] = [
      { name: 'reply', label: 'Reply', params: [{ name: 'body', type: 'text', label: 'Reply', required: true }] },
    ];
    let state = withActions(stateWith(), ENTRIES[1] as VNode, '/mail/x', withParam);
    state = reduce(state, char('r')).state;
    for (const c of 'hi') state = reduce(state, char(c)).state;

    const lines = render(state, OPTIONS).map(strip);
    assert.match(lines[lines.length - 1] ?? '', /Reply: hi/);
    // The chosen action stays highlighted, so the screen still answers "into what?".
    assert.match(lines.join('\n'), /> .*Reply/);
  });

  it('says what confirms and what cancels', () => {
    let state = withActions(stateWith(), ENTRIES[1] as VNode, '/mail/x', ACTIONS);
    state = reduce(state, char('m')).state;
    const lines = render(state, OPTIONS).map(strip);
    assert.match(lines[lines.length - 1] ?? '', /press y to go ahead, any other key to cancel/);
  });

  it('advertises the key in the footer and documents it in help', () => {
    assert.match(render(stateWith(), OPTIONS).map(strip).join('\n'), /a act/);
    assert.match(renderHelp(OPTIONS).map(strip).join('\n'), /what you can do with the selected item/);
  });
});


