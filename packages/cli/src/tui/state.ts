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

import type { ActionDescriptor, ActionParam, ActionResult, MetaValue, SessionEvent, VNode } from '@mscomms/core';

export type Pane = 'list' | 'preview';
export type Mode = 'browse' | 'filter' | 'command' | 'help' | 'actions' | 'param' | 'confirm';

/**
 * An action the user has chosen but not yet finished asking for.
 *
 * Actions are not atomic from the interface's point of view: choosing `reply` starts a
 * conversation that continues through one prompt per parameter and possibly a confirmation
 * before anything is sent. Keeping the half-finished request in one value means Escape at
 * any point discards the whole thing cleanly, and nothing can be sent with a parameter list
 * assembled from two different attempts.
 */
export interface PendingAction {
  readonly descriptor: ActionDescriptor;
  readonly node: VNode;
  readonly path: string;
  /** Parameters answered so far. */
  readonly params: Readonly<Record<string, MetaValue>>;
  /** Which parameter is being asked for now. */
  readonly paramIndex: number;
  /** The live text of the current answer. */
  readonly input: string;
}

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
  /**
   * What startup is still doing, or `''` once it has finished.
   *
   * Separate from {@link status} rather than written into it, because the two have
   * different owners and different lifetimes: `status` answers "what happened when you
   * pressed that key" and must not be overwritten every time a background check ticks,
   * while this answers "why is the tree still empty" and has to disappear on its own. The
   * renderer decides which one the single status row shows; see `render.ts`.
   */
  readonly startup: string;
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
  /**
   * What the microphone is doing, if anything.
   *
   * Held in state rather than drawn ad hoc because a listening indicator that can disagree
   * with reality is worse than none at all — the whole question the user is asking is "is
   * this thing recording me right now?", and it deserves a single answer that the renderer
   * reads and the reducer owns.
   */
  readonly voice: VoiceIndicator;
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
  /**
   * What can be done to {@link actionTarget}, as the provider last reported it.
   *
   * Fetched per node rather than held as a fixed menu, because what is offered is the whole
   * point: a merged pull request must not offer to merge, and a message you have already
   * read must not offer to mark it read. A menu that lists everything and fails on most of
   * it teaches people to be afraid of it.
   */
  readonly actions: readonly ActionDescriptor[];
  readonly actionTarget: VNode | undefined;
  /** The path {@link actionTarget} was found at, which is what the engine needs to act on it. */
  readonly actionPath: string;
  readonly actionIndex: number;
  readonly pending: PendingAction | undefined;
}

export interface VoiceIndicator {
  readonly phase: 'off' | 'idle' | 'listening' | 'transcribing' | 'heard' | 'error';
  readonly text: string;
  /**
   * How the recording was started, when one is running.
   *
   * Separate from `phase` because "the microphone is open" and "letting go of the key will
   * close it" are different facts, and the second is the one a user needs before they decide
   * whether it is safe to stop holding the key. Conflating them is how a user ends up
   * whispering the rest of a sentence to a microphone that stopped listening.
   */
  readonly hold: 'none' | 'holding' | 'latched';
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
  /** Ask the provider what can be done to this node right now. */
  | { readonly kind: 'actions'; readonly node: VNode; readonly path: string }
  | {
      readonly kind: 'invoke';
      readonly action: string;
      readonly node: VNode;
      readonly path: string;
      readonly params: Readonly<Record<string, MetaValue>>;
      /** Carried through so the shell can name what it ran without re-deriving it. */
      readonly label: string;
    }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'quit' }
  /** Record one spoken phrase and act on it. See `voiceListening` in {@link TuiState}. */
  | { readonly kind: 'listen' }
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
  return (
    effect.kind === 'list' ||
    effect.kind === 'read' ||
    effect.kind === 'refresh' ||
    effect.kind === 'command' ||
    effect.kind === 'actions' ||
    effect.kind === 'invoke'
  );
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
    startup: '',
    busy: true,
    tick: 0,
    busyMs: 0,
    exiting: false,
    voice: { phase: 'off', text: '', hold: 'none' },
    rows,
    history: [cwd],
    historyIndex: 0,
    marks: new Map(),
    actions: [],
    actionTarget: undefined,
    actionPath: '',
    actionIndex: 0,
    pending: undefined,
  };
}

/**
 * Fold a session event into the view.
 *
 * This is the whole of "the view stays synchronized with the VFS", and it is deliberately a
 * pure function next to the key reducer rather than a set of callbacks in the app. Before it
 * existed, each half of the interface kept its own idea of the current folder and reconciled
 * them wherever somebody remembered to, so an action run from `:do` left the list showing a
 * message that had just been archived, and an undo moved nothing at all.
 *
 * Now there is one rule: whatever changes the world says so, and the view listens. It does
 * not matter whether the change came from a key, from `:`, from `undo`, or from somebody
 * speaking — they all arrive here as the same event.
 */
export function applySessionEvent(state: TuiState, event: SessionEvent): Step {
  switch (event.kind) {
    case 'cwd':
      // Already there — nothing to redraw, and re-listing would fight the pane's own move.
      if (event.path === state.cwd) return { state, effects: [] };
      return {
        state: { ...state, busy: true, status: `Moved to ${event.path}.` },
        effects: [{ kind: 'list', path: event.path }],
      };

    case 'mutated': {
      // Re-list only when the change touched what is on screen. Refreshing on every mutation
      // anywhere would make a background watch tick yank the selection out from under
      // somebody mid-read, which is precisely the bug this event was added to fix.
      const affected = event.paths.some((path) => path === state.cwd || parentPath(path) === state.cwd);
      if (!affected) return { state: { ...state, status: event.message }, effects: [] };
      return {
        state: { ...state, busy: true, status: event.message },
        effects: [{ kind: 'list', path: state.cwd }],
      };
    }

    case 'journal':
      return { state: { ...state, status: event.summary }, effects: [] };

    case 'voice': {
      const text = event.text ?? '';
      const status =
        event.phase === 'listening'
          ? text === ''
            ? 'Listening…'
            : `Listening — ${text}`
          : event.phase === 'transcribing'
            ? 'Transcribing…'
            : event.phase === 'heard'
              ? `Heard: "${text}"`
              : event.phase === 'error'
                ? `Voice error: ${text}`
                : state.status;
      // The hold only means anything while the microphone is actually open. Once we are
      // transcribing or idle there is no key to let go of, and leaving a stale "locked" on
      // screen would tell the user to press a key that now starts a recording instead of
      // ending one.
      const hold = event.phase === 'listening' ? state.voice.hold : 'none';
      return { state: { ...state, voice: { phase: event.phase, text, hold }, status }, effects: [] };
    }

    case 'listing':
      // The listing the pane itself just asked for. Redrawing again would loop.
      return { state, effects: [] };
  }
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
  if (state.mode === 'actions') return reduceActions(state, key);
  if (state.mode === 'param') return reduceParam(state, key);
  if (state.mode === 'confirm') return reduceConfirm(state, key);
  return reduceBrowse(state, key);
}

// ---------------------------------------------------------------------------
// Acting on the selection
// ---------------------------------------------------------------------------

/**
 * The single letter that runs each action from the palette.
 *
 * Providers may ask for one via `ActionDescriptor.key`, and asking is all it is: two
 * providers cannot coordinate, and the same node can offer actions from a provider and
 * from a plugin at once, so a requested letter is honoured only when it is still free.
 * Everything else falls back to the first free letter of its own name and then to a digit,
 * which means every action always has exactly one accelerator — a menu where some rows can
 * only be reached by arrowing is a menu people arrow through.
 */
export function accelerators(descriptors: readonly ActionDescriptor[]): readonly string[] {
  const used = new Set<string>();
  const assigned: string[] = [];
  const take = (candidate: string | undefined): string | undefined => {
    if (candidate === undefined || candidate.length !== 1) return undefined;
    const lower = candidate.toLowerCase();
    if (used.has(lower)) return undefined;
    used.add(lower);
    return lower;
  };

  // Requested letters are claimed in a first pass, so a provider's choice is not stolen by
  // an earlier action that merely happened to start with the same letter.
  const requested = descriptors.map((descriptor) => take(descriptor.key));

  for (const [index, descriptor] of descriptors.entries()) {
    let letter = requested[index];
    if (letter === undefined) {
      for (const char of descriptor.name.toLowerCase()) {
        if (char < 'a' || char > 'z') continue;
        letter = take(char);
        if (letter !== undefined) break;
      }
    }
    letter ??= take(String((index + 1) % 10));
    assigned.push(letter ?? ' ');
  }
  return assigned;
}

/** The parameter currently being asked for, or undefined when they have all been answered. */
export function currentParam(pending: PendingAction): ActionParam | undefined {
  return pending.descriptor.params?.[pending.paramIndex];
}

/**
 * A sentence describing where we are in the palette.
 *
 * Written to be heard rather than seen: it names the action, its position, and the fact
 * that it needs confirmation, because a screen reader user gets the status line and not the
 * highlight.
 */
export function describeAction(state: TuiState): string {
  const descriptor = state.actions[state.actionIndex];
  if (descriptor === undefined) return 'No actions available.';
  const keys = accelerators(state.actions);
  const parts = [
    `${String(state.actionIndex + 1)} of ${String(state.actions.length)}`,
    descriptor.label ?? descriptor.name,
  ];
  const key = keys[state.actionIndex];
  if (key !== undefined && key !== ' ') parts.push(`press ${key}`);
  if (descriptor.destructive === true) parts.push('asks for confirmation');
  if (descriptor.description !== undefined) parts.push(descriptor.description);
  return parts.join(', ') + '.';
}

/**
 * Move from a chosen action to whatever has to happen before it can run.
 *
 * One function for all three exits — ask for a parameter, ask for confirmation, or go —
 * because they are the same decision made at two different times: it is also what runs
 * after each answer, so a five-parameter action and a zero-parameter action follow the
 * identical path and cannot diverge.
 */
function advance(state: TuiState, pending: PendingAction): Step {
  const param = currentParam(pending);
  if (param !== undefined) {
    return {
      state: { ...state, mode: 'param', pending, status: promptFor(param) },
      effects: [],
    };
  }
  if (pending.descriptor.destructive === true) {
    return {
      state: {
        ...state,
        mode: 'confirm',
        pending,
        status: `${pending.descriptor.label ?? pending.descriptor.name}: press y to confirm, anything else to cancel.`,
      },
      effects: [],
    };
  }
  return run(state, pending);
}

function run(state: TuiState, pending: PendingAction): Step {
  const label = pending.descriptor.label ?? pending.descriptor.name;
  return {
    state: { ...state, mode: 'browse', pending: undefined, busy: true, status: `${label}…` },
    effects: [
      {
        kind: 'invoke',
        action: pending.descriptor.name,
        node: pending.node,
        path: pending.path,
        params: pending.params,
        label,
      },
    ],
  };
}

function promptFor(param: ActionParam): string {
  const name = param.label ?? param.name;
  const parts = [name];
  if (param.type === 'choice' && param.choices !== undefined) parts.push(`one of ${param.choices.join(', ')}`);
  if (param.type === 'boolean') parts.push('yes or no');
  if (param.default !== undefined) parts.push(`default ${String(param.default)}`);
  parts.push(param.required === true ? 'required' : 'optional, Enter to skip');
  return `${parts.join(' — ')}. Escape cancels.`;
}

function cancelled(state: TuiState): Step {
  return {
    state: { ...state, mode: 'browse', pending: undefined, status: 'Cancelled. Nothing was sent.' },
    effects: [],
  };
}

function reduceActions(state: TuiState, key: Key): Step {
  if (key.name === 'escape') return cancelled(state);

  if (key.name === 'down' || key.name === 'j' || key.name === 'tab') {
    const index = (state.actionIndex + 1) % Math.max(1, state.actions.length);
    const next: TuiState = { ...state, actionIndex: index };
    return { state: { ...next, status: describeAction(next) }, effects: [] };
  }
  if (key.name === 'up' || key.name === 'k') {
    const count = Math.max(1, state.actions.length);
    const next: TuiState = { ...state, actionIndex: (state.actionIndex - 1 + count) % count };
    return { state: { ...next, status: describeAction(next) }, effects: [] };
  }

  const start = (descriptor: ActionDescriptor, index: number): Step => {
    const target = state.actionTarget;
    if (target === undefined) return cancelled(state);
    return advance(
      { ...state, actionIndex: index },
      { descriptor, node: target, path: state.actionPath, params: {}, paramIndex: 0, input: '' },
    );
  };

  if (key.name === 'return' || key.name === 'enter') {
    const descriptor = state.actions[state.actionIndex];
    if (descriptor === undefined) return cancelled(state);
    return start(descriptor, state.actionIndex);
  }

  // Accelerators are matched only against a bare character, so Ctrl+A cannot silently
  // approve something on the way to whatever the user actually meant.
  const char = printable(key)?.toLowerCase();
  if (char !== undefined) {
    const index = accelerators(state.actions).indexOf(char);
    const descriptor = index < 0 ? undefined : state.actions[index];
    if (descriptor !== undefined) return start(descriptor, index);
    return { state: { ...state, status: `No action is bound to "${char}". Escape closes this list.` }, effects: [{ kind: 'bell' }] };
  }
  return { state, effects: [] };
}

function reduceParam(state: TuiState, key: Key): Step {
  const pending = state.pending;
  if (pending === undefined) return { state: { ...state, mode: 'browse' }, effects: [] };
  if (key.name === 'escape') return cancelled(state);

  const param = currentParam(pending);
  if (param === undefined) return advance(state, pending);

  if (key.name === 'return' || key.name === 'enter') {
    const value = pending.input.trim();
    if (value === '' && param.required === true) {
      return {
        state: { ...state, status: `${param.label ?? param.name} is required. Type a value, or press Escape to cancel.` },
        effects: [{ kind: 'bell' }],
      };
    }
    // Empty means "not supplied", which is exactly what the engine's parameter resolution
    // expects: it is what lets a default apply instead of being overwritten with a blank.
    const params = value === '' ? pending.params : { ...pending.params, [param.name]: unescapeNewlines(value) };
    return advance(state, { ...pending, params, paramIndex: pending.paramIndex + 1, input: '' });
  }
  if (key.name === 'backspace') {
    return { state: { ...state, pending: { ...pending, input: pending.input.slice(0, -1) } }, effects: [] };
  }
  const char = printable(key);
  if (char === undefined) return { state, effects: [] };
  return { state: { ...state, pending: { ...pending, input: pending.input + char } }, effects: [] };
}

function reduceConfirm(state: TuiState, key: Key): Step {
  const pending = state.pending;
  if (pending === undefined) return { state: { ...state, mode: 'browse' }, effects: [] };
  // Only `y` proceeds. Enter is deliberately not an accepted confirmation: it is the key
  // someone is already pressing when the prompt appears.
  if (key.name === 'y') return run(state, pending);
  return cancelled(state);
}

/**
 * Turn a typed `\n` into a real newline.
 *
 * A single-line prompt is the honest shape for a terminal input, but review comments and
 * replies genuinely want paragraphs, and telling someone to go and use the command line for
 * that is telling them the pane is a toy. Two characters is a small enough price that it can
 * be mentioned in the help and then forgotten by anyone who does not need it.
 */
function unescapeNewlines(value: string): string {
  return value.replace(/\\n/g, '\n');
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

    // `u` undoes, matching every editor anyone has used. It goes through the command table
    // rather than a bespoke path so the pane cannot undo something the shell could not.
    case 'u':
      return { state: { ...state, busy: true, status: 'Undoing…' }, effects: [{ kind: 'command', line: 'undo' }] };

    case 'a': {
      // Deliberately works from either pane and always means the item you are looking at.
      // Someone reading a pull request in the preview should not have to Tab back to the
      // list to approve it — that is the whole complaint about read-only detail panes.
      const node = shown[state.selected];
      if (node === undefined) {
        return { state: { ...state, status: 'Nothing selected, so there is nothing to act on.' }, effects: [{ kind: 'bell' }] };
      }
      const path = joinPath(state.cwd, node.name);
      return {
        state: { ...state, busy: true, status: `Finding out what you can do with ${node.name}…` },
        effects: [{ kind: 'actions', node, path }],
      };
    }

    default:
      break;
  }

  // The talk key is deliberately absent from this reducer. It is the one key whose meaning
  // depends on when it comes *up*, so it is handled on the raw input stream in `app.ts` —
  // both because releases never reach a keypress parser, and because a release must be acted
  // on while a recording is in flight, which is exactly when the pane drops ordinary keys.
  // See `push-to-talk.ts` for the state machine and `keyboard.ts` for how releases arrive.

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

export function withPreview(state: TuiState, title: string, lines: readonly string[]): TuiState {
  return {
    ...settled(state),
    preview: lines,
    previewTitle: title,
    previewOffset: 0,
    pane: 'preview',
    status: `${title}. Tab returns to the list, a shows what you can do with it.`,
  };
}

/**
 * Open the action palette with what the provider said is possible.
 *
 * An empty list is reported rather than shown as an empty menu, and it says *why* the list
 * is empty as far as we can tell — "nothing right now" reads like a bug, whereas naming the
 * node makes it clear the question was asked and answered.
 */
export function withActions(
  state: TuiState,
  node: VNode,
  path: string,
  descriptors: readonly ActionDescriptor[],
): TuiState {
  if (descriptors.length === 0) {
    return withStatus(state, `There is nothing you can do with ${node.name} from here.`);
  }
  const next: TuiState = {
    ...settled(state),
    mode: 'actions',
    actions: descriptors,
    actionTarget: node,
    actionPath: path,
    actionIndex: 0,
    pending: undefined,
  };
  return {
    ...next,
    status: `${String(descriptors.length)} actions for ${node.name}. ${describeAction(next)}`,
  };
}

/**
 * Report what an action did.
 *
 * `message` is used verbatim because the provider wrote it as a complete sentence for
 * exactly this moment, and paraphrasing it here would mean two places to keep honest.
 */
export function withActionResult(state: TuiState, result: ActionResult): TuiState {
  const details = result.details ?? [];
  const suffix = details.length === 0 ? '' : ` ${details.join(' ')}`;
  return { ...settled(state), mode: 'browse', pending: undefined, status: `${result.message}${suffix}` };
}

/** Replace the status line. The status line is the screen reader's primary channel, so
 *  callers should say something worth hearing rather than restating what's already visible. */
export function withStatus(state: TuiState, message: string): TuiState {
  return { ...settled(state), status: message };
}

/**
 * Replace the startup line, which takes the status row while it is non-empty.
 *
 * Deliberately not routed through {@link withStatus}: startup progress is not an answer to
 * anything the user did, so it must not clear the working indicator, and it must not
 * destroy a message they are still reading. Passing `''` hands the row back.
 */
export function withStartup(state: TuiState, message: string): TuiState {
  if (state.startup === message) return state;
  return { ...state, startup: message };
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
 *  site whether a message is a failure or a hint. Also abandons any half-collected action:
 *  a palette left open over a node whose state we no longer know is an invitation to send
 *  the wrong thing. */
export function withError(state: TuiState, message: string): TuiState {
  return { ...withStatus(state, message), mode: 'browse', pending: undefined };
}

export function withRows(state: TuiState, rows: number): TuiState {
  return clampSelection({ ...state, rows: Math.max(1, rows) }, state.selected);
}

/**
 * Record whether the open microphone is being held or has been latched.
 *
 * Set from the talk key rather than inferred from the voice phase, because only the key
 * knows which of the two it is — and the indicator that tells the user whether letting go
 * will stop the recording must not be a guess.
 */
export function withVoiceHold(state: TuiState, hold: VoiceIndicator['hold']): TuiState {
  if (state.voice.hold === hold) return state;
  return { ...state, voice: { ...state.voice, hold } };
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
