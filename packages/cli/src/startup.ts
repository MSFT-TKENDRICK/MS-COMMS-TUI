/**
 * What the program is doing before it is ready, and how it says so.
 *
 * Startup used to be a single `await` with nothing on the screen behind it. Everything a
 * session needs — a compiled `dist/`, a config file, mounts connected, a local cache
 * opened, watches restarted — was checked in a row, in front of the user, and the first
 * frame was painted only once the last of them had finished. On a machine with four real
 * sources that is a double-digit number of seconds of a blank terminal, which is
 * indistinguishable from a program that has crashed on launch.
 *
 * None of that work is actually a precondition for *interaction*. A key can be pressed, a
 * command can be typed and a pane can be drawn long before any of it is done. So the work
 * moved into the background and this file is what makes that honest:
 *
 * 1. **Every check is declared before it runs.** The list exists — with labels — from the
 *    first frame, so the answer to "what is it doing?" is on screen rather than inferred
 *    from a spinner.
 * 2. **Only some of them gate anything.** A task is `blocking` when a command genuinely
 *    cannot be answered without it — in practice that is mounts and nothing else. The
 *    cache, the watches and a rebuild are improvements, and an improvement that delays the
 *    first keystroke has been mis-classified.
 * 3. **"Ready" is a moment that gets announced.** {@link StartupTasks.whenReady} is what
 *    commands wait on and what the interfaces report, so a user is told when the tool is
 *    fully awake instead of having to guess by trying something.
 *
 * The reporting functions at the bottom are pure and exported for the same reason the
 * reducer is: what the user is told during startup is a decision, decisions deserve tests,
 * and none of these should need a terminal to assert.
 */

/**
 * Where a check has got to.
 *
 * `warn` and `failed` are separate because they mean different things to a reader: `warn`
 * is "this finished, imperfectly, and the session is fine" (a source that would not
 * connect), `failed` is "this did not happen at all" (the cache could not be opened).
 * Neither is fatal — nothing during startup is allowed to be — but collapsing them would
 * make the report either alarming or dishonest.
 */
export type TaskState = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped';

export interface StartupTask {
  readonly id: string;
  /**
   * What it is checking, as a present participle: "Connecting sources".
   *
   * Present participle rather than a noun because this string is read while the thing is
   * happening, and "Sources" on a status line says nothing about whether they are being
   * counted, connected or given up on.
   */
  readonly label: string;
  readonly state: TaskState;
  /** The outcome in a few words — "4 sources", "disk full" — for the ready summary. */
  readonly detail: string | undefined;
  /** Whether {@link StartupTasks.whenReady} waits for it. */
  readonly blocking: boolean;
  /**
   * Performed by something other than this session — in practice, by whatever launched it.
   *
   * The distinction is about what "ready" is allowed to mean. A rebuild running in the
   * launcher is worth showing, because an unexplained ten seconds of disk activity is worse
   * than an explained one, but it says nothing about whether *this* session can answer a
   * command. Folding it into readiness would hold the announcement hostage to a check about
   * the next launch rather than this one.
   */
  readonly external: boolean;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
}

/** What a task body may return instead of just finishing. A bare string means `ok`. */
export interface TaskOutcome {
  readonly state?: Exclude<TaskState, 'pending' | 'running'>;
  readonly detail?: string;
}

export type TaskResult = TaskOutcome | string | void;

const SETTLED: readonly TaskState[] = ['ok', 'warn', 'failed', 'skipped'];

export function isSettled(task: StartupTask): boolean {
  return SETTLED.includes(task.state);
}

/** Nothing in this set is still outstanding. */
export function allSettled(tasks: readonly StartupTask[]): boolean {
  return tasks.every(isSettled);
}

/**
 * The checks this session ran itself.
 *
 * What "Ready" is a statement about. See {@link StartupTask.external}.
 */
export function ownTasks(tasks: readonly StartupTask[]): readonly StartupTask[] {
  return tasks.filter((task) => !task.external);
}

/** The checks somebody else ran and told us about. */
export function externalTasks(tasks: readonly StartupTask[]): readonly StartupTask[] {
  return tasks.filter((task) => task.external);
}

/**
 * The set of background checks a session runs, and who is watching them.
 *
 * Deliberately not a general-purpose job queue. It has no scheduling, no concurrency
 * control and no retries, because the ordering constraints between these particular steps
 * are real (the cache is opened after the mounts it caches) and belong in the one place
 * that knows them. What this owns is the *record*: what was asked, where it got to, and
 * telling anyone who is drawing a screen that the answer changed.
 */
export class StartupTasks {
  readonly #tasks = new Map<string, StartupTask>();
  readonly #listeners = new Set<(tasks: readonly StartupTask[]) => void>();
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Announce a check before it starts.
   *
   * The point of declaring separately from running: the list of what is coming is on the
   * screen from the first frame, so a slow first step reads as "three things to do, on the
   * first" rather than as one unexplained pause.
   */
  declare(id: string, label: string, options: { readonly blocking?: boolean; readonly external?: boolean } = {}): void {
    if (this.#tasks.has(id)) return;
    this.#tasks.set(id, {
      id,
      label,
      state: 'pending',
      detail: undefined,
      blocking: options.blocking ?? false,
      external: options.external ?? false,
      startedAt: undefined,
      endedAt: undefined,
    });
    this.#emit();
  }

  /**
   * Run one check, recording where it got to.
   *
   * Never throws. A thrown error is recorded as `failed` with its message, because the
   * caller is a startup pipeline whose next step is usually still worth doing, and because
   * an unhandled rejection from a background task would take the process down for something
   * the user was told to expect might not work.
   */
  async run(
    id: string,
    label: string,
    body: () => Promise<TaskResult>,
    options: { readonly blocking?: boolean; readonly external?: boolean } = {},
  ): Promise<void> {
    this.declare(id, label, options);
    this.#patch(id, { state: 'running', startedAt: this.#now() });
    try {
      const outcome = await body();
      const resolved: TaskOutcome = typeof outcome === 'string' ? { detail: outcome } : (outcome ?? {});
      this.#patch(id, {
        state: resolved.state ?? 'ok',
        ...(resolved.detail === undefined ? {} : { detail: resolved.detail }),
        endedAt: this.#now(),
      });
    } catch (error) {
      this.#patch(id, {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        endedAt: this.#now(),
      });
    }
  }

  /** Record a check that has already happened, or one performed somewhere else entirely. */
  record(
    id: string,
    label: string,
    outcome: { readonly state: Exclude<TaskState, 'pending'>; readonly detail?: string; readonly external?: boolean },
  ): void {
    const existing = this.#tasks.get(id);
    this.#tasks.set(id, {
      id,
      label,
      state: outcome.state,
      detail: outcome.detail,
      blocking: existing?.blocking ?? false,
      external: outcome.external ?? existing?.external ?? false,
      startedAt: existing?.startedAt ?? this.#now(),
      endedAt: outcome.state === 'running' ? undefined : this.#now(),
    });
    this.#emit();
  }

  snapshot(): readonly StartupTask[] {
    return [...this.#tasks.values()];
  }

  get(id: string): StartupTask | undefined {
    return this.#tasks.get(id);
  }

  /** Every blocking check has settled: commands can be answered. */
  get ready(): boolean {
    return this.snapshot().every((task) => !task.blocking || isSettled(task));
  }

  /** Nothing is outstanding at all, including checks somebody else is running for us. */
  get settled(): boolean {
    return allSettled(this.snapshot());
  }

  /** This session's own checks are done. What an interface announces as "Ready". */
  get finished(): boolean {
    return allSettled(ownTasks(this.snapshot()));
  }

  /**
   * Resolve when interaction is safe.
   *
   * A fresh promise per call rather than one shared latch, because a task added later — the
   * launcher's rebuild arriving over IPC, a mount added by `demo` — can make the session
   * un-ready again, and a latch would answer for the wrong moment.
   */
  whenReady(): Promise<void> {
    return this.#when(() => this.ready);
  }

  whenSettled(): Promise<void> {
    return this.#when(() => this.settled);
  }

  subscribe(listener: (tasks: readonly StartupTask[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #when(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (!predicate()) return;
        unsubscribe();
        resolve();
      });
    });
  }

  #patch(id: string, changes: Partial<StartupTask>): void {
    const task = this.#tasks.get(id);
    if (task === undefined) return;
    this.#tasks.set(id, { ...task, ...changes });
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

/** Braille frames, matching the shell's and the pane's. */
const FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

/** How many checks to name before falling back to a count. */
const NAMED_LIMIT = 2;

/**
 * One line describing what is still outstanding, or `undefined` when nothing is.
 *
 * Names the work rather than counting it. "Starting up (2 of 4)" tells a user how long to
 * wait but not what is being waited for, and "what is it doing?" is the question a startup
 * indicator exists to answer — particularly here, where the honest answer is sometimes
 * "asking Microsoft for a token" and the user is the only one who can do anything about it.
 */
export function startupLine(tasks: readonly StartupTask[], tick = 0): string | undefined {
  const outstanding = tasks.filter((task) => !isSettled(task));
  if (outstanding.length === 0) return undefined;

  const running = outstanding.filter((task) => task.state === 'running');
  const shown = running.length > 0 ? running : outstanding;
  const names = shown.slice(0, NAMED_LIMIT).map((task) => task.label);
  const hidden = shown.length - names.length;
  const spinner = FRAMES[Math.abs(tick) % FRAMES.length] ?? '';

  const rest = hidden > 0 ? `, and ${String(hidden)} more` : '';
  const queued = running.length > 0 && outstanding.length > running.length
    ? ` (${String(outstanding.length - running.length)} queued)`
    : '';
  return `${spinner} ${names.join(', ')}${rest}\u2026${queued}`;
}

/**
 * What to say the moment the last check finishes.
 *
 * The good news is stated as a list of what actually happened — "4 sources, local cache on"
 * — because "Ready" alone leaves a user who configured five sources unable to tell that one
 * of them silently did not appear. Problems are named after the successes rather than
 * instead of them, so a session that is 90% working does not read as a failure.
 */
export function readySummary(tasks: readonly StartupTask[]): string {
  const good = tasks
    .filter((task) => task.state === 'ok' && task.detail !== undefined && task.detail !== '')
    .map((task) => task.detail as string);
  const bad = tasks
    .filter((task) => task.state === 'failed' || task.state === 'warn')
    .map((task) => `${task.label.toLowerCase()}${task.detail === undefined ? '' : ` \u2014 ${task.detail}`}`);

  const head = good.length === 0 ? 'Ready.' : `Ready. ${sentence(good)}.`;
  return bad.length === 0 ? head : `${head} ${bad.length === 1 ? 'One problem' : `${String(bad.length)} problems`}: ${sentence(bad)}.`;
}

/**
 * Every check, as rows something can display or serialize.
 *
 * Structured rather than pre-formatted because the only consumer is `doctor`, which renders
 * a table and also has to answer `--json`. A function that returned finished lines would be
 * useless to the second of those, and two functions that formatted the same list differently
 * would eventually disagree about it.
 *
 * This is the only place the whole list survives past startup. Both interfaces show it while
 * it runs and then deliberately get out of the way, so "why did it take so long to start?"
 * has nowhere else to be answered — including when the answer is a check the launcher ran.
 */
export function startupRows(tasks: readonly StartupTask[]): readonly StartupRow[] {
  return tasks.map((task) => {
    const took =
      task.startedAt === undefined || task.endedAt === undefined
        ? ''
        : ` in ${String(Math.round(task.endedAt - task.startedAt))} ms`;
    const said = task.detail === undefined || task.detail === '' ? task.state : task.detail;
    return {
      name: `startup: ${task.label.toLowerCase()}`,
      status: task.state === 'failed' ? 'fail' : task.state === 'warn' ? 'warn' : 'ok',
      detail: `${said}${took}`,
    };
  });
}

export interface StartupRow {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

function sentence(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
}

// ---------------------------------------------------------------------------
// Checks that happen outside this process
// ---------------------------------------------------------------------------

/**
 * A startup check reported by whatever launched us.
 *
 * `npm start` has work of its own to do — is this checkout installed, is `dist/` older than
 * `src/` — and it used to do all of it *before* handing over, which is why pressing Run
 * meant staring at a bare terminal for ten seconds. Now it launches first and keeps
 * checking afterwards, which only works if it can say so somewhere the user is looking. So
 * it sends its progress down the IPC channel it already has and the interfaces show it in
 * the same list as everything else: one place to look, whichever side of the process
 * boundary the work is on.
 */
export interface LauncherTaskMessage {
  readonly type: 'mscomms:task';
  readonly id: string;
  readonly label: string;
  readonly state: TaskState;
  readonly detail?: string;
}

export function isLauncherTaskMessage(value: unknown): value is LauncherTaskMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<LauncherTaskMessage>;
  return (
    message.type === 'mscomms:task' &&
    typeof message.id === 'string' &&
    typeof message.label === 'string' &&
    typeof message.state === 'string' &&
    (['pending', 'running', 'ok', 'warn', 'failed', 'skipped'] as readonly string[]).includes(message.state)
  );
}

export interface MessageSource {
  on: (event: 'message', listener: (message: unknown) => void) => unknown;
  off: (event: 'message', listener: (message: unknown) => void) => unknown;
  readonly channel?: { unref?: () => void } | undefined;
}

/**
 * Mirror the launcher's checks into this session's list. Returns an unsubscribe.
 *
 * `unref` on the channel is not optional: an IPC channel is a live handle, and a process
 * that stays alive because its parent *might* send another progress message is a process
 * that does not exit when the user types `quit`.
 */
export function bridgeLauncherTasks(tasks: StartupTasks, source: MessageSource): () => void {
  const listener = (message: unknown): void => {
    if (!isLauncherTaskMessage(message)) return;
    if (message.state === 'pending') {
      tasks.declare(message.id, message.label, { external: true });
      return;
    }
    tasks.record(message.id, message.label, {
      state: message.state,
      external: true,
      ...(message.detail === undefined ? {} : { detail: message.detail }),
    });
  };

  source.on('message', listener);
  source.channel?.unref?.();
  return () => {
    source.off('message', listener);
  };
}
