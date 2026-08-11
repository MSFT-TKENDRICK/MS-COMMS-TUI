/**
 * The TUI's state machine.
 *
 * Deliberately pure: keys go in, a new state and a list of effects come out. Nothing here
 * touches a terminal, a filesystem or a network, which is what makes the interaction model
 * testable without pretending to be a TTY. Everything that needs the outside world is
 * returned as an {@link Effect} for the shell around it to perform.
 *
 * WHY THE TUI IS OPT-IN
 *
 * A full-screen interface is hostile to a screen reader for reasons that are mechanical
 * rather than stylistic: the alternate screen buffer destroys scrollback, full-frame
 * repaints fragment speech mid-sentence, cursor tracking triggers announcement storms, and
 * ANSI has no equivalent of ARIA — no way to mark a region as a list, or an item as
 * selected. None of that can be fixed by being careful. So the line shell is the default,
 * this is opt-in, and {@link shouldRefuseTui} turns it down when the environment suggests
 * it would make things worse.
 *
 * WHAT THAT LEAVES US OBLIGED TO DO
 *
 * Every capability reachable by a keystroke is also reachable by typing a command, because
 * the `:` line dispatches into exactly the same command table as the shell. The TUI adds no
 * unique power, so no user is locked out of a feature by being unable to use the pane.
 */

import type { VNode } from '@mscomms/core';

export type Pane = 'list' | 'preview';
export type Mode = 'browse' | 'filter' | 'command' | 'help';

export interface TuiState {
  readonly cwd: string;
  readonly entries: readonly VNode[];
  /** Index into {@link visibleEntries}, not into `entries`. */
  readonly selected: number;
  readonly offset: number;
  readonly mode: Mode;
  readonly pane: Pane;
  /** The live typeahead string. Applied incrementally, never on submit only. */
  readonly filter: string;
  readonly command: string;
  readonly preview: readonly string[];
  readonly previewOffset: number;
  readonly previewTitle: string;
  readonly status: string;
  readonly busy: boolean;
  readonly exiting: boolean;
  /** Rows available for the list body, set by the renderer from the real terminal size. */
  readonly rows: number;
}

export type Effect =
  | { readonly kind: 'list'; readonly path: string }
  | { readonly kind: 'read'; readonly node: VNode }
  | { readonly kind: 'command'; readonly line: string }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'bell' };

export interface Key {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface Step {
  readonly state: TuiState;
  readonly effects: readonly Effect[];
}

export function initialState(cwd: string, rows = 20): TuiState {
  return {
    cwd,
    entries: [],
    selected: 0,
    offset: 0,
    mode: 'browse',
    pane: 'list',
    filter: '',
    command: '',
    preview: [],
    previewOffset: 0,
    previewTitle: '',
    status: 'Loading…',
    busy: true,
    exiting: false,
    rows,
  };
}

/**
 * The entries actually on screen.
 *
 * Filtering is a plain case-insensitive substring test, and it runs on every keystroke
 * rather than on Enter. Incremental is the whole point of typeahead: a filter you have to
 * commit before seeing the result is just a search box.
 */
export function visibleEntries(state: TuiState): readonly VNode[] {
  if (state.filter === '') return state.entries;
  const needle = state.filter.toLowerCase();
  return state.entries.filter(
    (node) =>
      node.name.toLowerCase().includes(needle) ||
      (node.title ?? '').toLowerCase().includes(needle) ||
      (node.author ?? '').toLowerCase().includes(needle),
  );
}

export function selectedNode(state: TuiState): VNode | undefined {
  return visibleEntries(state)[state.selected];
}

/**
 * A sentence describing the selection.
 *
 * Rendered into the status line and, more importantly, printed on exit. A TUI that returns
 * you to a blank prompt has thrown away everything you just looked at; one line of plain
 * text in the scrollback costs nothing and means the session leaves a trace you can scroll
 * back to, copy, or have read to you.
 */
export function describeSelection(state: TuiState): string {
  const shown = visibleEntries(state);
  if (shown.length === 0) {
    return state.filter === '' ? `${state.cwd} is empty.` : `Nothing in ${state.cwd} matches "${state.filter}".`;
  }
  const node = shown[state.selected];
  if (node === undefined) return `${String(shown.length)} items in ${state.cwd}.`;

  const parts = [`${String(state.selected + 1)} of ${String(shown.length)}`, node.name];
  if (node.kind === 'dir') parts.push('folder');
  if (node.author !== undefined && node.author !== '') parts.push(`from ${node.author}`);
  if (node.flags !== undefined && node.flags.length > 0) parts.push(node.flags.join(', '));
  if (state.filter !== '') parts.push(`filtered by "${state.filter}"`);
  return parts.join(', ') + '.';
}

function clampSelection(state: TuiState, next: number): TuiState {
  const shown = visibleEntries(state);
  const selected = shown.length === 0 ? 0 : Math.max(0, Math.min(next, shown.length - 1));
  const body = Math.max(1, state.rows);
  let offset = state.offset;
  if (selected < offset) offset = selected;
  else if (selected >= offset + body) offset = selected - body + 1;
  offset = Math.max(0, Math.min(offset, Math.max(0, shown.length - body)));
  return { ...state, selected, offset };
}

/** True for a key that inserts a character rather than issuing a command. */
function printable(key: Key): string | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  const seq = key.sequence;
  if (seq === undefined || seq.length !== 1) return undefined;
  const code = seq.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? seq : undefined;
}

export function reduce(state: TuiState, key: Key): Step {
  // Ctrl+C is checked before the mode, and this is load-bearing. Every other key is
  // mode-dependent — `q` quits while browsing but is a literal letter while typing a filter
  // — which means that without a mode-independent escape there is a state a confused user
  // can enter and not get out of. "Press Escape" is not an answer when they do not know
  // that. Ctrl+C is the one key every terminal user already knows means stop.
  if (key.ctrl === true && key.name === 'c') {
    return { state: { ...state, exiting: true }, effects: [{ kind: 'quit' }] };
  }
  if (state.mode === 'help') return reduceHelp(state, key);
  if (state.mode === 'filter') return reduceFilter(state, key);
  if (state.mode === 'command') return reduceCommand(state, key);
  return reduceBrowse(state, key);
}

function reduceHelp(state: TuiState, key: Key): Step {
  // Any key leaves help. Requiring a specific key to dismiss a help screen is a small
  // cruelty to the person who opened it because they did not know the keys.
  void key;
  return { state: { ...state, mode: 'browse', status: describeSelection(state) }, effects: [] };
}

function reduceFilter(state: TuiState, key: Key): Step {
  if (key.name === 'escape') {
    const cleared = clampSelection({ ...state, filter: '', mode: 'browse' }, 0);
    return { state: { ...cleared, status: 'Filter cleared.' }, effects: [] };
  }
  if (key.name === 'return' || key.name === 'enter') {
    const next: TuiState = { ...state, mode: 'browse' };
    return { state: { ...next, status: describeSelection(next) }, effects: [] };
  }
  if (key.name === 'backspace') {
    const filter = state.filter.slice(0, -1);
    const next = clampSelection({ ...state, filter }, 0);
    return { state: { ...next, status: describeSelection(next) }, effects: [] };
  }
  // Arrows still move while filtering, so you can narrow and pick without leaving the mode.
  if (key.name === 'up' || key.name === 'down') {
    const next = clampSelection(state, state.selected + (key.name === 'down' ? 1 : -1));
    return { state: { ...next, status: describeSelection(next) }, effects: [] };
  }
  const char = printable(key);
  if (char === undefined) return { state, effects: [] };
  const next = clampSelection({ ...state, filter: state.filter + char }, 0);
  return { state: { ...next, status: describeSelection(next) }, effects: [] };
}

function reduceCommand(state: TuiState, key: Key): Step {
  if (key.name === 'escape') {
    return { state: { ...state, mode: 'browse', command: '', status: 'Cancelled.' }, effects: [] };
  }
  if (key.name === 'return' || key.name === 'enter') {
    const line = state.command.trim();
    const next: TuiState = { ...state, mode: 'browse', command: '' };
    if (line === '') return { state: { ...next, status: describeSelection(next) }, effects: [] };
    return { state: { ...next, busy: true, status: `Running ${line}…` }, effects: [{ kind: 'command', line }] };
  }
  if (key.name === 'backspace') {
    return { state: { ...state, command: state.command.slice(0, -1) }, effects: [] };
  }
  const char = printable(key);
  if (char === undefined) return { state, effects: [] };
  return { state: { ...state, command: state.command + char }, effects: [] };
}

function reduceBrowse(state: TuiState, key: Key): Step {
  const shown = visibleEntries(state);
  const body = Math.max(1, state.rows);

  if (state.pane === 'preview') {
    const moved = movePreview(state, key, body);
    if (moved !== undefined) return moved;
  }

  switch (key.name) {
    case 'q':
    case 'escape':
      return { state: { ...state, exiting: true }, effects: [{ kind: 'quit' }] };

    case 'tab': {
      const pane: Pane = state.pane === 'list' ? 'preview' : 'list';
      if (pane === 'preview' && state.preview.length === 0) {
        return {
          state: { ...state, status: 'Nothing to preview yet. Press Enter on an item first.' },
          effects: [{ kind: 'bell' }],
        };
      }
      return { state: { ...state, pane, status: `${pane === 'list' ? 'List' : 'Preview'} pane.` }, effects: [] };
    }

    case 'down':
    case 'j': {
      const next = clampSelection(state, state.selected + 1);
      return { state: { ...next, status: describeSelection(next) }, effects: [] };
    }
    case 'up':
    case 'k': {
      const next = clampSelection(state, state.selected - 1);
      return { state: { ...next, status: describeSelection(next) }, effects: [] };
    }
    case 'pagedown': {
      const next = clampSelection(state, state.selected + body);
      return { state: { ...next, status: describeSelection(next) }, effects: [] };
    }
    case 'pageup': {
      const next = clampSelection(state, state.selected - body);
      return { state: { ...next, status: describeSelection(next) }, effects: [] };
    }
    case 'home': {
      const next = clampSelection(state, 0);
      return { state: { ...next, status: describeSelection(next) }, effects: [] };
    }
    case 'end': {
      const next = clampSelection(state, shown.length - 1);
      return { state: { ...next, status: describeSelection(next) }, effects: [] };
    }

    case 'return':
    case 'enter':
    case 'right':
    case 'l': {
      const node = shown[state.selected];
      if (node === undefined) return { state: { ...state, status: 'Nothing selected.' }, effects: [{ kind: 'bell' }] };
      if (node.kind === 'dir') {
        return {
          state: { ...state, busy: true, status: `Opening ${node.name}…` },
          effects: [{ kind: 'list', path: joinPath(state.cwd, node.name) }],
        };
      }
      return { state: { ...state, busy: true, status: `Reading ${node.name}…` }, effects: [{ kind: 'read', node }] };
    }

    case 'left':
    case 'h':
    case 'backspace': {
      if (state.cwd === '/') {
        return { state: { ...state, status: 'Already at the root.' }, effects: [{ kind: 'bell' }] };
      }
      return {
        state: { ...state, busy: true, status: 'Going up…' },
        effects: [{ kind: 'list', path: parentPath(state.cwd) }],
      };
    }

    case 'f5':
    case 'r':
      return { state: { ...state, busy: true, status: 'Refreshing…' }, effects: [{ kind: 'refresh' }] };

    default:
      break;
  }

  // `/`, `:` and `?` are matched by sequence because they are punctuation, and terminals
  // report punctuation key names inconsistently.
  const seq = key.sequence;
  if (seq === '/') {
    return {
      state: { ...state, mode: 'filter', filter: '', status: 'Filter: type to narrow, Enter to keep, Escape to clear.' },
      effects: [],
    };
  }
  if (seq === ':') {
    return {
      state: {
        ...state,
        mode: 'command',
        command: '',
        status: 'Command: any shell command, Enter to run, Escape to cancel.',
      },
      effects: [],
    };
  }
  if (seq === '?') {
    return { state: { ...state, mode: 'help', status: 'Help. Press any key to return.' }, effects: [] };
  }

  // Bare letters deliberately do NOT start a filter.
  //
  // That convenience was here, and it was a trap. `q` quits, `r` refreshes and `hjkl`
  // navigate, so "any letter starts a filter" was really "any letter except six" — and
  // someone filtering for "quarterly" would press `q` and watch the program exit. A rule
  // with six invisible exceptions is fine for a sighted power user who can see what
  // happened and undo it; it is hostile to everyone else.
  //
  // So the rule is now stateable in one sentence: letters are never text unless you have
  // explicitly entered a text mode. `/` is the way in, and it is named in the footer on
  // every single frame, so it is advertised rather than assumed.
  return { state, effects: [] };
}

function movePreview(state: TuiState, key: Key, body: number): Step | undefined {
  const max = Math.max(0, state.preview.length - body);
  const to = (n: number): Step => ({
    state: { ...state, previewOffset: Math.max(0, Math.min(n, max)) },
    effects: [],
  });
  switch (key.name) {
    case 'down':
    case 'j':
      return to(state.previewOffset + 1);
    case 'up':
    case 'k':
      return to(state.previewOffset - 1);
    case 'pagedown':
      return to(state.previewOffset + body);
    case 'pageup':
      return to(state.previewOffset - body);
    case 'home':
      return to(0);
    case 'end':
      return to(max);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transitions driven by the outside world
// ---------------------------------------------------------------------------

export function withListing(state: TuiState, path: string, entries: readonly VNode[]): TuiState {
  const next = clampSelection(
    { ...state, cwd: path, entries, filter: '', selected: 0, offset: 0, busy: false, pane: 'list' },
    0,
  );
  return { ...next, status: describeSelection(next) };
}

export function withPreview(state: TuiState, title: string, lines: readonly string[]): TuiState {
  return {
    ...state,
    preview: lines,
    previewTitle: title,
    previewOffset: 0,
    pane: 'preview',
    busy: false,
    status: `${title}. Tab returns to the list.`,
  };
}

/** Replace the status line. The status line is the screen reader's primary channel, so
 *  callers should say something worth hearing rather than restating what's already visible. */
export function withStatus(state: TuiState, message: string): TuiState {
  return { ...state, busy: false, status: message };
}

/** Same mechanics as {@link withStatus}, named separately so a reader can tell at the call
 *  site whether a message is a failure or a hint. */
export function withError(state: TuiState, message: string): TuiState {
  return withStatus(state, message);
}

export function withRows(state: TuiState, rows: number): TuiState {
  return clampSelection({ ...state, rows: Math.max(1, rows) }, state.selected);
}

// ---------------------------------------------------------------------------
// Path helpers, kept local so this module imports nothing but a type
// ---------------------------------------------------------------------------

function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/**
 * Whether to decline to start the full-screen interface.
 *
 * The signals are the user's own stated preferences, not a guess about their eyesight:
 * `--announce` and `--plain` mean "give me linear, unadorned output", and a full-screen
 * pane is the opposite of that. Refusing with an explanation is better than starting and
 * being unusable, and better than silently ignoring flags the user deliberately set.
 */
export function shouldRefuseTui(options: {
  readonly isTty: boolean;
  readonly announce: boolean;
  readonly plain: boolean;
}): string | undefined {
  if (!options.isTty) {
    return 'The full-screen interface needs a terminal, and output looks redirected. Run without --tui to get plain text you can pipe.';
  }
  if (options.announce) {
    return 'The full-screen interface and --announce contradict each other: one paints a screen, the other emits one sentence per item. The line shell is the better tool here — run without --tui.';
  }
  if (options.plain) {
    return 'The full-screen interface cannot honour --plain, which asks for no drawing and no alternate screen. Run without --tui for the line shell.';
  }
  return undefined;
}
