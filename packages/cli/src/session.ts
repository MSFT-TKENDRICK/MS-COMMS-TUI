/**
 * Session state: everything a command needs, in one object.
 *
 * The design constraint that shapes this file is `lastListing`. Numbered addressing
 * (`ls` then `cat 3`) means the shell has to remember what was last printed, and that
 * memory has to be shared identically by the shell, the completer and the one-shot CLI —
 * otherwise `3` means different things in different places, which would be worse than not
 * having numbers at all.
 *
 * The rule, stated once, enforced everywhere: **a number refers to the most recently
 * printed enumerated list of nodes.** `ls`, `find`, `grep`, `watches` and `notifications`
 * all set it. Command-name completion does not, because it produces strings, not nodes.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  BackgroundSync,
  FileStateStore,
  Notifier,
  PluginRegistry,
  SnapshotStore,
  Vfs,
  Watcher,
  buildMounts,
  hashEmbedder,
  openSqlDriver,
  parseQuery,
  resolveAppPaths,
  stateFileFor,
  vpath,
  agentFsDatabase,
  loadAgentFs,
  type AppConfig,
  type AppPaths,
  type BuiltMount,
  type Logger,
  type ToolCallsLike,
  type VNode,
  type VfsTarget,
} from '@mscomms/core';
import { closeAllMcpClients } from '@mscomms/provider-graph';
import { DEFAULT_FORMAT, type FormatOptions, type OutputMode } from './format.js';
import { StartupTasks, type TaskOutcome, type TaskResult } from './startup.js';

/**
 * How long teardown waits for a startup step that is still running.
 *
 * Generous enough for anything doing local work, short enough that a provider stuck on a
 * network call cannot make `q` feel broken. The steps check the abort signal between them,
 * so this only ever covers the single step in flight.
 */
const ABANDON_STARTUP_MS = 250;

/**
 * Wait for a promise, but not forever.
 *
 * The timer is unreferenced deliberately: a race that loses must not be the reason the
 * process stays alive, which would turn a guard against hanging into a cause of it.
 */
async function settleWithin(promise: Promise<void> | undefined, ms: number): Promise<void> {
  if (promise === undefined) return;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

export interface SessionOptions {
  readonly config: AppConfig;
  readonly registry: PluginRegistry;
  readonly logger: Logger;
  readonly paths?: AppPaths;
  readonly mode?: OutputMode;
  readonly color?: boolean;
  readonly width?: number;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

/** A remembered listing, so numbers keep meaning something after the output scrolls away. */
export interface LastListing {
  readonly path: string;
  readonly nodes: readonly VNode[];
  /** Number shown next to the first node. Paged listings continue, not restart. */
  readonly startIndex: number;
  readonly cursor?: string;
  readonly query?: string;
  /** How the listing was produced, so `more` can repeat it correctly. */
  readonly source: 'ls' | 'find' | 'grep' | 'other';
  readonly long?: boolean;
}

export class Session {
  readonly config: AppConfig;
  readonly registry: PluginRegistry;
  readonly logger: Logger;
  readonly paths: AppPaths;
  readonly vfs: Vfs;
  readonly notifier: Notifier;
  readonly watcher: Watcher;

  /** The local snapshot, once opened. Undefined when caching is off or unavailable. */
  snapshot: SnapshotStore | undefined;
  sync: BackgroundSync | undefined;
  /** Why the cache is not running, when it was asked for but could not start. */
  cacheError: string | undefined;

  /**
   * Where output actually lands when nothing has claimed it.
   *
   * Everything on top of this lives in {@link #frames}. See {@link redirect}.
   */
  #base: OutputFrame = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };

  /**
   * Redirections, innermost last.
   *
   * A stack rather than a save-and-restore pair because these no longer nest neatly. They
   * did when the only redirection was a command running inside the pane: one at a time, in
   * and out again. Startup running in the background broke that — a step that mounts sample
   * data can begin before the user types something and finish in the middle of it — and
   * save-and-restore gets that case catastrophically wrong. The inner frame restores the
   * sink it *saw* on the way in, which is the outer frame's sink, so the outer frame's own
   * restore then reinstates something that has already been torn down and every subsequent
   * write disappears into a discarded buffer.
   *
   * Removing by identity has no such failure mode: a frame that ends early is spliced out of
   * the middle and whatever is still on top keeps receiving writes.
   */
  readonly #frames: OutputFrame[] = [];

  /**
   * Where command output goes.
   *
   * These are stable function identities for the life of the session — the notifier and the
   * watcher capture them at construction — so redirection works by swapping what is
   * underneath rather than by reassigning the property. See {@link capture}.
   */
  readonly write: (text: string) => void = (text) => {
    (this.#frames.at(-1) ?? this.#base).out(text);
  };
  readonly writeError: (text: string) => void = (text) => {
    (this.#frames.at(-1) ?? this.#base).err(text);
  };

  /** Mounts that failed to start. Surfaced by `mounts` and `doctor` instead of at startup. */
  brokenMounts: readonly BuiltMount[] = [];

  /**
   * What startup is doing, for anything that wants to show it or wait for it.
   *
   * Public because both interfaces read it directly: the pane draws it on the status line,
   * the shell prints one line when it settles, and `doctor` lists the whole thing.
   */
  readonly tasks = new StartupTasks();

  /** The background startup pipeline; see {@link begin}. */
  #startup: Promise<void> | undefined;
  readonly #startAbort = new AbortController();

  /** Background startup warm-up; awaited only by {@link dispose}. */
  #warming: Promise<void> | undefined;
  readonly #warmAbort = new AbortController();

  cwd = vpath.ROOT;
  lastListing: LastListing | undefined;
  /** Paths visited, most recent last. Powers `back` and history-aware completion. */
  readonly history: string[] = [];
  format: FormatOptions;
  pageSize: number;
  /** Set by `quit`; the REPL checks it after each command. */
  exiting = false;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.registry = options.registry;
    this.logger = options.logger;
    this.paths = options.paths ?? resolveAppPaths();
    if (options.write !== undefined) this.#base = { ...this.#base, out: options.write };
    if (options.writeError !== undefined) this.#base = { ...this.#base, err: options.writeError };

    this.pageSize = options.config.ui.pageSize ?? 25;

    this.format = {
      ...DEFAULT_FORMAT,
      mode: options.mode ?? (options.config.ui.announce === true ? 'announce' : detectMode(options.config)),
      color: options.color ?? detectColor(options.config),
      width: options.width ?? detectWidth(),
      dateStyle: options.config.ui.dateStyle ?? 'relative',
      ...(options.config.ui.showHiddenMeta === undefined ? {} : { showMeta: options.config.ui.showHiddenMeta }),
    };

    this.vfs = new Vfs({
      ...(options.config.ttlMs === undefined ? {} : { ttlMs: options.config.ttlMs }),
      pageSize: this.pageSize,
      logger: options.logger,
      // Prefetching is deliberately *not* conditional on the snapshot being enabled. It
      // used to be, which meant a default install — no config file, no cache section —
      // preloaded nothing whatsoever: every mount root and every folder was a cold round
      // trip taken while the user waited. Speculative results land in the in-memory cache
      // perfectly well; the snapshot only decides whether they outlive the process.
      prefetch: {
        enabled: options.config.cache.prefetch ?? true,
        ...(options.config.cache.prefetchConcurrency === undefined
          ? {}
          : { concurrency: options.config.cache.prefetchConcurrency }),
      },
    });

    this.notifier = new Notifier({
      logger: options.logger,
      desktop: options.config.notifications.desktop ?? true,
      bell: options.config.ui.bell ?? false,
      storePath: join(this.paths.stateDir, 'notifications.json'),
      ...(options.config.notifications.appId === undefined ? {} : { appId: options.config.notifications.appId }),
      ...(options.config.notifications.appName === undefined
        ? {}
        : { appName: options.config.notifications.appName }),
      ...(options.config.notifications.maxEntries === undefined
        ? {}
        : { maxEntries: options.config.notifications.maxEntries }),
      write: this.writeError,
    });

    this.watcher = new Watcher({
      vfs: this.vfs,
      notifier: this.notifier,
      logger: options.logger,
      state: new FileStateStore(join(this.paths.stateDir, 'watches.json')),
    });
  }

  /**
   * Kick off startup and return, without waiting for any of it.
   *
   * This is the whole point: it is synchronous, it does no I/O of its own, and by the time
   * it returns the caller can draw a screen and accept keystrokes. Everything that used to
   * happen in front of the user — connecting sources, opening the local cache, restarting
   * watches — is queued behind {@link tasks}, which reports what each step is doing and
   * when the session becomes usable.
   *
   * Nothing here can fail in a way that matters. Each step records its own outcome, and a
   * step that throws is a task marked `failed` rather than a session that refuses to exist.
   */
  begin(): void {
    if (this.#startup !== undefined) return;

    // Declared up front, before any of them runs, so the first frame can already list what
    // is being checked instead of showing an unexplained pause.
    this.tasks.declare('workspace', 'Preparing the workspace');
    this.tasks.declare('mounts', 'Connecting sources', { blocking: true });
    if (this.config.cache.enabled === true) this.tasks.declare('cache', 'Opening the local cache');
    if (this.config.watches.length > 0) this.tasks.declare('watches', 'Restarting watches');

    this.#startup = this.#runStartup();
  }

  /**
   * Resolve when commands can be answered — that is, when the mounts exist.
   *
   * The one thing that genuinely gates a command. The cache and the watches make a session
   * faster and more useful, and waiting for either before honouring `ls` would put the
   * whole point of an optimisation on the critical path.
   */
  async ready(): Promise<void> {
    this.begin();
    await this.tasks.whenReady();
  }

  /**
   * Start everything and wait for it, as startup used to behave.
   *
   * Kept because a one-shot command has nobody to show progress to and nothing else to do
   * while it waits, and because it is the honest shape for a test. Interactive callers want
   * {@link begin} plus {@link ready} instead.
   */
  async start(): Promise<void> {
    this.begin();
    await this.#startup;
  }

  /**
   * Add a caller's own step to the end of startup.
   *
   * `--demo` is why this exists. Mounting the sample data has to happen after the configured
   * mounts — building on a half-finished tree is how the demo entries end up in a different
   * order than the ones `demo` typed by hand produces — and the obvious way to express that
   * is `await session.ready()` before mounting. That reintroduces the original bug one level
   * up: the interface is constructed after the await, so the screen stays blank for exactly
   * as long as connecting the sources takes, which is the thing this whole change is about.
   *
   * Appending to the chain says the same thing without the wait. The step is declared
   * immediately, so it is in the list from the first frame and is named while it runs; it is
   * sequenced after whatever is already queued, so the ordering constraint holds; and it can
   * be `blocking`, which is the honest description of sample data — a command answered
   * against a tree that is about to grow four more mounts has answered the wrong question.
   */
  enqueue(
    id: string,
    label: string,
    body: () => Promise<TaskResult>,
    options: { readonly blocking?: boolean } = {},
  ): void {
    this.begin();
    this.tasks.declare(id, label, options);
    const queued = this.#startup ?? Promise.resolve();
    this.#startup = queued.then(async () => {
      if (this.#startAbort.signal.aborted) return;
      await this.tasks.run(id, label, body, options);
    });
  }

  async #runStartup(): Promise<void> {
    const signal = this.#startAbort.signal;

    await this.tasks.run('workspace', 'Preparing the workspace', async () => {
      await mkdir(this.paths.stateDir, { recursive: true }).catch(() => undefined);
      await mkdir(this.paths.cacheDir, { recursive: true }).catch(() => undefined);
    });
    if (signal.aborted) return;

    await this.tasks.run('mounts', 'Connecting sources', async () => this.#startMounts(), { blocking: true });
    if (signal.aborted) return;

    if (this.config.cache.enabled === true) {
      await this.tasks.run('cache', 'Opening the local cache', async () => this.#startCache(signal));
      if (signal.aborted) return;
    }

    if (this.config.watches.length > 0) {
      await this.tasks.run('watches', 'Restarting watches', async () => this.#startWatches());
      if (signal.aborted) return;
    }

    // Deliberately not awaited, and not a task: warming spawns MCP servers and speculatively
    // lists mount roots, which takes seconds and finishes long after the session is usable.
    // Reporting it as outstanding would mean "ready" never arrived while the tool was, in
    // every sense the user cares about, ready.
    this.warmMounts();
  }

  /**
   * Warm every mount in the background.
   *
   * Called at startup, and again by anything that mounts a source afterwards — `demo` is the
   * one in the box. A mount that has never been listed has nothing in the directory cache,
   * and a mount with nothing in the cache cannot contribute an unread total to the row that
   * stands for it, so skipping this leaves the root listing — the first thing anyone sees —
   * as the one place with no counters on it.
   *
   * Safe to call repeatedly: the prefetch queue keys on the path, so a mount already warm is
   * not fetched twice.
   */
  warmMounts(): Promise<void> {
    const previous = this.#warming ?? Promise.resolve();
    this.#warming = previous.then(() =>
      this.vfs.warm({ signal: this.#warmAbort.signal }).catch((error: unknown) => {
        this.logger.debug('warm-up did not finish', { message: String(error) });
      }),
    );
    return this.#warming;
  }

  /** Build the configured mounts, and land the user somewhere sensible. */
  async #startMounts(): Promise<string> {
    const built = await buildMounts(this.config.mounts, {
      registry: this.registry,
      logger: this.logger,
      stateFor: (mountId) => new FileStateStore(stateFileFor(this.paths.stateDir, mountId)),
      cacheDirFor: (mountId) => join(this.paths.cacheDir, mountId),
      // Resolved lazily so a projection mounted before the sources it reads still sees
      // them: mounts are built in config order, but the space is asked for on use.
      graphSpace: () => this.vfs.graphSpace(),
      configDir:
        this.config.sourcePath === undefined
          ? this.paths.configDir
          : dirname(this.config.sourcePath),
    });

    const broken: BuiltMount[] = [];
    for (const result of built) {
      if (result.mount !== undefined) this.vfs.mount(result.mount);
      else broken.push(result);
    }
    this.brokenMounts = broken;

    // The cwd defaults to the only mount when there is exactly one. Landing in a root
    // that contains a single directory and making the user `cd` into it is pure ceremony.
    const mounts = this.vfs.mounts;
    if (mounts.length === 1 && mounts[0] !== undefined) this.cwd = mounts[0].path;

    const working = mounts.length;
    const counted = working === 0 ? 'no sources' : `${String(working)} source${working === 1 ? '' : 's'}`;
    return broken.length === 0
      ? counted
      : `${counted}, ${String(broken.length)} unavailable`;
  }

  async #startWatches(): Promise<string> {
    let started = 0;
    for (const watch of this.config.watches) {
      try {
        await this.watcher.add({
          id: watch.id,
          path: watch.path,
          ...(watch.query === undefined ? {} : { query: parseQuery(watch.query) }),
          ...(watch.intervalMs === undefined ? {} : { intervalMs: watch.intervalMs }),
          ...(watch.includeUpdates === undefined ? {} : { includeUpdates: watch.includeUpdates }),
          ...(watch.label === undefined ? {} : { label: watch.label }),
        });
        started += 1;
      } catch (error) {
        this.logger.warn('watch could not start', {
          id: watch.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return `${String(started)} watch${started === 1 ? '' : 'es'}`;
  }

  async dispose(): Promise<void> {
    this.watcher.stop();
    // Startup first: it is now running *behind* a live interface, so quitting can land in
    // the middle of it. Aborting is what makes the wait short — the signal is checked
    // between steps — and the wait is bounded on top of that, because the step in flight
    // may be a provider's `connect` that observes no signal at all. Tearing down under one
    // of those is the price of never making `q` wait for a machine that is not answering.
    this.#startAbort.abort();
    await settleWithin(this.#startup, ABANDON_STARTUP_MS);
    // Warm-up next, and awaited: it spawns MCP servers and writes listings through the
    // snapshot, so tearing down underneath it would close a database it is still using.
    // The abort is what makes this quick — without it, quitting during startup would block
    // on a seven-second handshake nobody is waiting for any more.
    this.#warmAbort.abort();
    await this.#warming?.catch(() => undefined);
    // Speculative work goes next, and it has to go *before* the flush. `flush()` waits for
    // the prefetch queue to drain, so leaving guesses running means quitting waits for
    // answers nobody will ever look at — including on one-shot commands, which start a
    // warm-up too. Aborting `#warmAbort` alone does not reach them: it covers connecting,
    // while the listings it schedules run on the queue's own signals.
    this.vfs.cancelSpeculative();
    // Order matters, and `stop()` must be awaited: it aborts the cycle *and waits for it
    // to unwind*. Dropping that promise would close the database under a sync still
    // writing to it, which is the same bug as not flushing, arriving from the other side.
    await this.sync?.stop();
    // Then settle the engine's outstanding snapshot writes before closing the database
    // under them, or the last thing the user did is the one thing not saved.
    await this.vfs.flush().catch(() => undefined);
    await this.snapshot?.close().catch(() => undefined);
    await this.vfs.dispose();
    // Shared across every Graph mount rather than owned by one, so it is released here
    // with the session that outlives them all.
    closeAllMcpClients();
  }

  /**
   * Open the local snapshot and start background sync.
   *
   * Every failure here is non-fatal and recorded rather than thrown. A cache that will not
   * open is a slower program, not a broken one, and refusing to start the shell because a
   * disk was full would turn an optimisation into a single point of failure. `cache status`
   * reports {@link cacheError} so the degradation is visible rather than mysterious.
   *
   * The abort checks are what make it safe to run this behind a live interface. Quitting
   * mid-open used to be impossible — nothing was interactive until it had finished — and
   * now it is ordinary, so a database that opens after teardown has begun is closed again
   * rather than attached to a session that no longer exists.
   */
  async #startCache(signal: AbortSignal): Promise<TaskOutcome> {
    const cache = this.config.cache;
    if (cache.enabled !== true) return { state: 'skipped', detail: 'not enabled' };

    try {
      const embedder = cache.vectors === false ? undefined : hashEmbedder();
      const driver = await openSqlDriver({
        path: cache.path ?? join(this.paths.cacheDir, 'snapshot.db'),
        ...(cache.driver === undefined ? {} : { driver: cache.driver }),
        onWarning: (message) => {
          this.logger.warn(message);
        },
      });

      const snapshot = await SnapshotStore.open({
        driver,
        ...(cache.recent === undefined ? {} : { maxNodesPerDirectory: cache.recent }),
        ...(cache.ttlMs === undefined ? {} : { ttlMs: cache.ttlMs }),
        ...(cache.vectors === undefined ? {} : { vectors: cache.vectors }),
        ...(embedder === undefined ? {} : { embedder }),
        logger: this.logger.child('snapshot'),
      });

      if (signal.aborted) {
        await snapshot.close().catch(() => undefined);
        return { state: 'skipped', detail: 'shutting down' };
      }

      this.snapshot = snapshot;
      this.vfs.attachSnapshot(snapshot, {
        enabled: cache.prefetch ?? true,
        ...(cache.prefetchConcurrency === undefined ? {} : { concurrency: cache.prefetchConcurrency }),
      });
      await this.vfs.warmPredictor().catch(() => undefined);

      // The audit log lives in the same database as the snapshot, so it needs no
      // configuration beyond being switched on. If AgentFS cannot load — no native
      // binding, an incompatible version — sync still runs, just without the record.
      let audit: ToolCallsLike | undefined;
      if (cache.audit === true) {
        try {
          const { ToolCalls } = await loadAgentFs();
          audit = (await ToolCalls.fromDatabase(agentFsDatabase(driver))) as ToolCallsLike;
        } catch (error) {
          this.logger.warn('audit log unavailable; syncing without it', { message: String(error) });
        }
      }

      if (signal.aborted) return { state: 'skipped', detail: 'shutting down' };

      this.sync = new BackgroundSync({
        host: this.vfs,
        snapshot,
        logger: this.logger.child('sync'),
        ...(cache.intervalMs === undefined ? {} : { intervalMs: cache.intervalMs }),
        ...(cache.recent === undefined ? {} : { recent: cache.recent }),
        ...(cache.depth === undefined ? {} : { depth: cache.depth }),
        ...(cache.bodies === undefined ? {} : { bodies: cache.bodies }),
        ...(audit === undefined ? {} : { audit }),
      });
      this.sync.start();
      return { detail: 'local cache on' };
    } catch (error) {
      this.cacheError = error instanceof Error ? error.message : String(error);
      this.logger.warn('local cache could not start', { message: this.cacheError });
      return { state: 'failed', detail: this.cacheError };
    }
  }

  // -------------------------------------------------------------------------
  // Paths and numbers
  // -------------------------------------------------------------------------

  /** Resolve a user-typed path against the cwd, expanding `~` and `-`. */
  resolvePath(input: string | undefined): string {
    if (input === undefined || input === '') return this.cwd;
    if (input === '-') return this.history[this.history.length - 1] ?? this.cwd;
    return vpath.resolve(this.cwd, input);
  }

  /**
   * Turn a token into a path.
   *
   * Resolution order matters and is deliberately "names win":
   *   1. `#3` — always the index, never a name. The unambiguous escape hatch.
   *   2. A token that is a real entry name in the last listing — a file genuinely called
   *      "2024" must be reachable by typing `2024`.
   *   3. A bare integer — the index.
   *   4. Anything else — an ordinary path.
   *
   * Putting names ahead of numbers is the safe order: the failure mode is "the number did
   * not work, use #3", which is discoverable. The reverse failure mode is "cat 2024 opened
   * the wrong message", which is silent and wrong.
   */
  resolveToken(token: string): string {
    const explicit = /^#(\d+)$/.exec(token);
    if (explicit !== null) {
      return this.#byIndex(Number(explicit[1]), token);
    }

    const listing = this.lastListing;
    if (listing !== undefined) {
      const named = listing.nodes.find((node) => node.name === token);
      if (named !== undefined) return named.path ?? vpath.join(listing.path, named.name);
    }

    if (/^\d+$/.test(token)) return this.#byIndex(Number(token), token);
    return this.resolvePath(token);
  }

  #byIndex(index: number, token: string): string {
    const listing = this.lastListing;
    if (listing === undefined) {
      throw new Error(`There is no listing to take "${token}" from. Run \`ls\` first.`);
    }
    const offset = index - listing.startIndex;
    const node = listing.nodes[offset];
    if (node === undefined) {
      const last = listing.startIndex + listing.nodes.length - 1;
      throw new Error(
        `There is no item ${String(index)}. The last listing showed ${String(listing.startIndex)} to ${String(last)}.`,
      );
    }
    return node.path ?? vpath.join(listing.path, node.name);
  }

  /** Look up the node for a token without re-fetching, when the last listing has it. */
  nodeForToken(token: string): VNode | undefined {
    const listing = this.lastListing;
    if (listing === undefined) return undefined;
    const explicit = /^#(\d+)$/.exec(token);
    const index = explicit !== null ? Number(explicit[1]) : /^\d+$/.test(token) ? Number(token) : undefined;
    if (index !== undefined) return listing.nodes[index - listing.startIndex];
    return listing.nodes.find((node) => node.name === token);
  }

  /**
   * Turn a token into something the VFS can act on, preferring the node itself.
   *
   * When the user says `cat 3` we already hold the exact node `ls` printed. Handing that
   * node straight to the VFS is both faster and *more correct* than handing over its
   * display name: display names are sanitized and deduplicated for human eyes, and a
   * search hit's name describes a location relative to the search root rather than the
   * directory the user happens to be standing in. Re-deriving identity from a name that
   * was produced for display is precisely the round trip this codebase exists to avoid.
   */
  resolveTarget(token: string): VfsTarget {
    return this.nodeForToken(token) ?? this.resolveToken(token);
  }

  setListing(listing: LastListing): void {
    this.lastListing = listing;
  }

  /** Resolve positional argument `index` as a path, defaulting to the cwd. */
  positionalPath(args: { readonly positional: readonly string[] }, index: number): string {
    const token = args.positional[index];
    return token === undefined ? this.cwd : this.resolveToken(token);
  }

  /** As `positionalPath`, but keeps the node when we already have it. */
  positionalTarget(args: { readonly positional: readonly string[] }, index: number): VfsTarget {
    const token = args.positional[index];
    return token === undefined ? this.cwd : this.resolveTarget(token);
  }

  /** The display path for a target, for messages and for `setCwd`. */
  static pathOf(target: VfsTarget): string {
    return typeof target === 'string' ? target : (target.path ?? vpath.ROOT);
  }

  setCwd(path: string): void {
    if (this.cwd !== path) this.history.push(this.cwd);
    if (this.history.length > 100) this.history.shift();
    this.cwd = path;
    // The old numbering referred to the old directory. Keeping it would make `cat 3` open
    // something from a directory the user has left, which is the kind of bug that erodes
    // trust in the whole numbering scheme.
    this.lastListing = undefined;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  print(text: string): void {
    if (text === '') return;
    this.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Status/progress text. Goes to stderr so `--json` output stays machine-parseable. */
  status(text: string): void {
    if (text === '') return;
    this.writeError(text.endsWith('\n') ? text : `${text}\n`);
  }

  withMode(mode: OutputMode | undefined): FormatOptions {
    return mode === undefined ? this.format : { ...this.format, mode };
  }

  /**
   * Send everything this session prints somewhere else, until the returned function is called.
   *
   * {@link capture} is for one operation whose output has a destination; this is for an
   * interface that owns the terminal for its whole life. The full-screen view cannot let a
   * single stray byte reach stdout — the alternate screen is drawn by absolute cursor
   * positioning, so one unexpected newline scrolls the frame out from under itself and every
   * subsequent paint lands in the wrong place.
   *
   * That used to be guaranteed by nothing except good luck: everything that printed did so
   * from inside a command, and commands run inside `capture`. It stopped being true the
   * moment startup moved into the background, because a step that mounts sample data or a
   * watch that fires now happens on its own schedule rather than the user's. Rather than
   * hunting down each writer, the interface states the invariant once.
   *
   * Removal is by identity rather than by restoring a saved value, so a redirection that
   * outlives a `capture` started after it — which is exactly what background startup makes
   * possible — is unwound correctly whichever of them finishes first.
   */
  redirect(sink: (text: string) => void): () => void {
    return this.#push({ out: sink, err: sink });
  }

  /**
   * Run something with all output collected instead of printed.
   *
   * This exists so the full-screen view can run a real command and show its real output,
   * rather than reimplementing a parallel set of half-commands that drift from the ones the
   * shell has. `:grep budget` in the pane runs the same `grep` as the shell does; the text
   * lands in the preview instead of scrolling the screen the pane is drawing on.
   *
   * Both streams are merged, deliberately. The split exists so that a pipe gets data on
   * stdout and chrome on stderr; here there is no pipe, and a user who typed a command
   * wants to see the warning that came with the answer.
   *
   * The frame is removed in a `finally`, so a throwing command cannot leave a session
   * permanently writing into a discarded buffer.
   */
  async capture(fn: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const collect = (text: string): void => {
      chunks.push(text);
    };
    const pop = this.#push({ out: collect, err: collect });
    try {
      await fn();
    } finally {
      pop();
    }
    return chunks.join('');
  }

  /**
   * Run `fn`, calling `before` once, immediately ahead of the first byte it prints.
   *
   * Exists for the shell's progress indicator, which occupies a line that has to be erased
   * before anything else is written to it. Doing that in a `finally` would be too late — the
   * command's output has already moved the cursor by then, and the spinner is stranded in
   * the scrollback. The only moment that works is the one just before the first write, and
   * only the sink knows when that is.
   *
   * `before` is called at most once, and the frame is removed in a `finally` so a throwing
   * command cannot leave the session writing through a filter that outlives it.
   *
   * What it delegates to is resolved per write rather than captured up front, because a
   * background startup step can push a frame of its own on top of this one and pull it off
   * again while the command is still running. Asking the stack each time is what makes the
   * indicator survive that.
   */
  async beforeFirstWrite(before: () => void, fn: () => Promise<void>): Promise<void> {
    let fired = false;
    const frame: OutputFrame = {
      out: (text) => {
        announce();
        this.#below(frame).out(text);
      },
      err: (text) => {
        announce();
        this.#below(frame).err(text);
      },
    };
    const announce = (): void => {
      if (fired) return;
      fired = true;
      before();
    };

    const pop = this.#push(frame);
    try {
      await fn();
    } finally {
      pop();
    }
  }

  #push(frame: OutputFrame): () => void {
    this.#frames.push(frame);
    return () => {
      const at = this.#frames.lastIndexOf(frame);
      if (at !== -1) this.#frames.splice(at, 1);
    };
  }

  /** Whatever `frame` sits on top of right now. */
  #below(frame: OutputFrame): OutputFrame {
    const at = this.#frames.lastIndexOf(frame);
    if (at <= 0) return this.#base;
    return this.#frames[at - 1] ?? this.#base;
  }
}

/** One layer of output redirection. See {@link Session.redirect}. */
interface OutputFrame {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Choose an output mode.
 *
 * `plain` is chosen aggressively. A pipe, `TERM=dumb`, or a terminal narrower than 60
 * columns all mean alignment is either useless or actively harmful. Guessing wrong toward
 * plain costs a sighted user some prettiness; guessing wrong toward table costs a screen
 * reader user their ability to read the output at all.
 */
function detectMode(config: AppConfig): OutputMode {
  if (config.ui.plain === true) return 'plain';
  if (process.env['MSCOMMS_ANNOUNCE'] === '1') return 'announce';
  if (process.env['MSCOMMS_PLAIN'] === '1') return 'plain';
  if (process.env['TERM'] === 'dumb' || process.env['TERM'] === undefined) return 'plain';
  if (!process.stdout.isTTY) return 'plain';
  if ((process.stdout.columns ?? 80) < 60) return 'plain';
  return 'table';
}

function detectColor(config: AppConfig): boolean {
  const setting = config.ui.color ?? 'auto';
  if (setting === 'never') return false;
  if (setting === 'always') return true;
  // https://no-color.org — any value at all means off.
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['TERM'] === 'dumb') return false;
  return process.stdout.isTTY === true;
}

function detectWidth(): number {
  const columns = process.stdout.columns;
  if (columns === undefined || columns < 20) return 80;
  return Math.min(columns, 200);
}

/** Where an unconfigured session should look for a config file. */
export function defaultConfigCandidates(paths: AppPaths): string[] {
  return [
    join(paths.configDir, 'config.jsonc'),
    join(paths.configDir, 'config.json'),
    join(homedir(), '.mscomms.jsonc'),
    join(homedir(), '.mscomms.json'),
  ];
}

