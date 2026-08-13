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
import type { ColorName } from '../format.js';

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
  /**
   * Per-row colour for {@link preview}, parallel to it and usually sparse.
   *
   * The preview holds *plain* text. Colour travels beside it rather than baked into it,
   * because the pane fits every row to an exact column count before painting, and an ANSI
   * escape is characters as far as fitting is concerned. A pre-coloured row would be
   * measured wrong and, worse, `sanitizeForDisplay` strips the ESC while leaving `[36m`
   * behind — so the escape would be printed as visible text.
   *
   * Fit first, paint last. This field is what makes that possible for content the pane did
   * not compose itself.
   */
  readonly previewStyles: readonly (ColorName | undefined)[];
  readonly previewOffset: number;
  readonly previewTitle: string;
  readonly status: string;
  readonly busy: boolean;
  /**
   * Frames elapsed since the current operation started. Drives the spinner.
   *
   * Kept in state rather than in the view so that "does the screen show it is alive" is a
   * property of the reducer, which is testable, instead of a property of a terminal, which
   * is not. Zero whenever {@link busy} is false.
   */
  readonly tick: number;
  /**
   * Milliseconds the current operation has been running, as last reported by the caller.
   *
   * The reducer has no clock — deliberately, because a reducer that reads the time cannot
   * be tested by comparing states. The app measures and passes it in.
   */
  readonly busyMs: number;
  readonly exiting: boolean;
  /** Rows available for the list body, set by the renderer from the real terminal size. */
  readonly rows: number;
  /**
   * Places visited, oldest first, with {@link historyIndex} pointing at the current one.
   *
   * Browser-shaped rather than a stack, because going back and then somewhere new has to
   * discard the forward entries — otherwise "forward" offers a route the user abandoned.
   * Going *up* is not the same as going *back*: from `/mail/Inbox` you might have arrived
   * from `/teams/Chats`, and back should return there rather than to `/mail`.
   */
  readonly history: readonly string[];
  readonly historyIndex: number;
  /**
   * Where the selection was, per folder.
   *
   * Returning to a folder and finding the highlight reset to the top is the difference
   * between navigation and re-navigation: it makes stepping into a message and back out
   * lose your place in a thousand-item Inbox, so people stop doing it.
   */
  readonly marks: ReadonlyMap<string, { readonly selected: number; readonly offset: number }>;
}

export type Effect =
  | {
      readonly kind: 'list';
      readonly path: string;
      /**
       * What this navigation does to the history. `push` is an ordinary move; `back` and
       * `forward` replay one that already happened and must not re-record it.
       */
      readonly nav?: 'push' | 'back' | 'forward';
    }
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

/**
 * Does this effect go and fetch something?
 *
 * The distinction matters because it is what lets keys keep working during a load. Moving
 * the selection, typing a filter and quitting cost nothing and can always be honoured;
 * opening, reading, refreshing and running a command must not be started on top of a
 * request already in flight, or a held-down arrow fires a burst that all lands after the
 * user has stopped moving.
 */
export function isFetching(effect: Effect): boolean {
  return effect.kind === 'list' || effect.kind === 'read' || effect.kind === 'refresh' || effect.kind === 'command';
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
    previewStyles: [],
    previewOffset: 0,
    previewTitle: '',
    status: 'Loading…',
    busy: true,
    tick: 0,
    busyMs: 0,
    exiting: false,
    rows,
    history: [cwd],
    historyIndex: 0,
    marks: new Map(),
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
      if (key.meta === true && (key.name === 'right' || key.name === 'l')) return goForward(state);
      const node = shown[state.selected];
      if (node === undefined) return { state: { ...state, status: 'Nothing selected.' }, effects: [{ kind: 'bell' }] };
      if (node.kind === 'dir') {
        return {
          state: { ...state, busy: true, status: `Opening ${node.name}…` },
          effects: [{ kind: 'list', path: joinPath(state.cwd, node.name), nav: 'push' }],
        };
      }
      return { state: { ...state, busy: true, status: `Reading ${node.name}…` }, effects: [{ kind: 'read', node }] };
    }

    case 'left':
    case 'h':
    case 'backspace': {
      // Alt+Left is "back" everywhere else, so it is back here too — distinct from Left,
      // which goes up. The two are genuinely different: arriving at /mail/Inbox from
      // /teams/Chats means back is /teams/Chats and up is /mail.
      if (key.meta === true) return goBack(state);
      if (state.cwd === '/') {
        return { state: { ...state, status: 'Already at the root.' }, effects: [{ kind: 'bell' }] };
      }
      return {
        state: { ...state, busy: true, status: 'Going up…' },
        effects: [{ kind: 'list', path: parentPath(state.cwd), nav: 'push' }],
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
  // Aliases for back and forward, because Alt+Arrow does not survive every terminal,
  // multiplexer and SSH session — and a navigation key that works only sometimes is worse
  // than one that looks unfamiliar. These are the browser bindings without the modifier.
  if (seq === '[') return goBack(state);
  if (seq === ']') return goForward(state);
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

/**
 * Step back to the previously visited place.
 *
 * Refuses at the end of the trail rather than silently doing nothing, because a key that
 * appears to be ignored is indistinguishable from a key that is broken.
 */
function goBack(state: TuiState): Step {
  const target = state.history[state.historyIndex - 1];
  if (target === undefined) {
    return { state: { ...state, status: 'Nothing to go back to.' }, effects: [{ kind: 'bell' }] };
  }
  return {
    state: { ...state, busy: true, status: `Back to ${target}…` },
    effects: [{ kind: 'list', path: target, nav: 'back' }],
  };
}

function goForward(state: TuiState): Step {
  const target = state.history[state.historyIndex + 1];
  if (target === undefined) {
    return { state: { ...state, status: 'Nothing to go forward to.' }, effects: [{ kind: 'bell' }] };
  }
  return {
    state: { ...state, busy: true, status: `Forward to ${target}…` },
    effects: [{ kind: 'list', path: target, nav: 'forward' }],
  };
}

/**
 * Record the history move for a navigation that has actually landed.
 *
 * Applied on arrival rather than on the keypress, so a folder that fails to load does not
 * leave a history entry pointing at a place the user never reached.
 */
function withHistory(
  state: TuiState,
  path: string,
  nav: 'push' | 'back' | 'forward' | undefined,
): { history: readonly string[]; historyIndex: number } {
  if (nav === 'back' || nav === 'forward') {
    const delta = nav === 'back' ? -1 : 1;
    const index = state.historyIndex + delta;
    // Trust the trail only if it still says what the reducer thought it said. A command
    // typed at `:` can move us somewhere else entirely between keypress and arrival.
    if (state.history[index] === path) return { history: state.history, historyIndex: index };
  }
  if (state.history[state.historyIndex] === path) {
    return { history: state.history, historyIndex: state.historyIndex };
  }
  // Anything else is a new move, and it discards the forward trail — keeping it would offer
  // a route the user has just abandoned.
  const history = [...state.history.slice(0, state.historyIndex + 1), path];
  return { history, historyIndex: history.length - 1 };
}

export function withListing(
  state: TuiState,
  path: string,
  entries: readonly VNode[],
  options: { readonly nav?: 'push' | 'back' | 'forward' } = {},
): TuiState {
  const { history, historyIndex } = withHistory(state, path, options.nav);

  // Remember where we were before leaving, and restore where we were last time if we have
  // been here before. Together these are what make going back and forth feel like returning
  // to a place rather than arriving at a new one.
  const marks = new Map(state.marks);
  if (state.cwd !== path && state.entries.length > 0) {
    marks.set(state.cwd, { selected: state.selected, offset: state.offset });
  }
  const mark = marks.get(path);

  const next = clampSelection(
    {
      ...settled(state),
      cwd: path,
      entries,
      filter: '',
      selected: mark?.selected ?? 0,
      offset: mark?.offset ?? 0,
      pane: 'list',
      history,
      historyIndex,
      marks,
    },
    mark?.selected ?? 0,
  );
  return { ...next, status: describeSelection(next) };
}

/**
 * Replace the entries under the user without moving them.
 *
 * This is the last stage of a staged read: the snapshot answered instantly with something a
 * few minutes old, and the source has now said what is actually there. Redrawing must not
 * feel like a navigation — the highlight stays on the *same item*, found by name rather
 * than by index, because the fresh listing may have gained or lost rows above it. Losing
 * someone's place to deliver news they did not ask for is worse than the staleness.
 *
 * Ignored when it is not about where the user currently is, and while they are typing a
 * filter or a command, which are moments when the screen changing underneath is hostile.
 */
export function withFreshListing(state: TuiState, path: string, entries: readonly VNode[]): TuiState {
  if (state.cwd !== path || state.mode !== 'browse' || state.pane !== 'list') return state;

  const anchor = visibleEntries(state)[state.selected];
  const candidate: TuiState = { ...state, entries };
  const shown = visibleEntries(candidate);
  const found = anchor === undefined ? -1 : shown.findIndex((entry) => entry.name === anchor.name);

  return clampSelection(candidate, found >= 0 ? found : state.selected);
}

/**
 * Show a document in the preview pane.
 *
 * `styles` is optional and parallel to `lines`. A caller with plain text omits it; a caller
 * rendering a card passes the tone colours alongside, never inside, the text.
 */
export function withPreview(
  state: TuiState,
  title: string,
  lines: readonly string[],
  styles: readonly (ColorName | undefined)[] = [],
): TuiState {
  return {
    ...settled(state),
    preview: lines,
    previewStyles: styles,
    previewTitle: title,
    previewOffset: 0,
    pane: 'preview',
    status: `${title}. Tab returns to the list.`,
  };
}

/** Replace the status line. The status line is the screen reader's primary channel, so
 *  callers should say something worth hearing rather than restating what's already visible. */
export function withStatus(state: TuiState, message: string): TuiState {
  return { ...settled(state), status: message };
}

/**
 * Advance the working indicator.
 *
 * Called on a timer while an operation is outstanding. A static "working" is
 * indistinguishable from a hang — the whole value of an indicator is that it *changes* —
 * so the frame counter and the elapsed clock both move, and the renderer shows the seconds
 * once they are worth showing.
 *
 * Ignored when nothing is outstanding, so a timer that fires once more after the work
 * finished cannot make a settled screen look busy.
 */
export function withProgress(state: TuiState, elapsedMs: number): TuiState {
  if (!state.busy) return state;
  return { ...state, tick: state.tick + 1, busyMs: Math.max(0, elapsedMs) };
}

/**
 * Refuse a key because something is already in flight.
 *
 * Distinct from dropping it silently: the previous behaviour was that every key did nothing
 * during a load, which reads exactly like a crash. This keeps the state untouched — the
 * point is that the request is *not* queued — while saying so, and reminding the user that
 * quitting still works.
 */
export function withRefusal(state: TuiState): TuiState {
  return { ...state, status: 'Still working — that key is ignored until it finishes. q quits.' };
}

/** Clear the working indicator. The one place `busy` goes false, so it cannot go stale. */
function settled(state: TuiState): TuiState {
  return { ...state, busy: false, tick: 0, busyMs: 0 };
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
