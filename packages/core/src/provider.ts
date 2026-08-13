/**
 * The provider contract — the plugin boundary of the whole system.
 *
 * A provider exposes some remote thing (a mailbox, a Teams channel, a repo's issues, an
 * RSS feed) as a tree of directories and files. Everything above this line — the shell,
 * the TUI, completion, queries, notifications — is provider-agnostic and works the same
 * for a mailbox and for a feed.
 *
 * Three constraints shaped this interface, each learned from prior art that got it wrong:
 *
 * 1. LISTING IS PAGED, NEVER "RETURN AN ARRAY". A real mailbox has hundreds of thousands
 *    of messages. FUSE mail filesystems became famous for hanging the terminal because a
 *    plain `ls` forced enumeration of everything. `list()` returns one page plus a cursor,
 *    and the shell tells the user there is more.
 *
 * 2. QUERIES PUSH DOWN. A provider is handed the parsed query and returns whatever part
 *    it could evaluate server-side, so the engine knows what it still has to filter
 *    locally. Downloading 200k messages to grep them client-side is not viable.
 *
 * 3. CHANGE DETECTION IS PULL-WITH-A-CURSOR, NOT PUSH. None of the real backends push to
 *    a CLI without a public webhook endpoint, but all of them expose a resumable cursor:
 *    Graph has `delta()` links, RSS has ETag/Last-Modified, GitHub has `since`. One
 *    `poll(cursor) -> {changes, cursor}` primitive covers every backend, and the engine
 *    owns scheduling, backoff and coalescing so providers stay trivial.
 */

import type { GraphSource, GraphSpace } from './graph.js';
import type { Query } from './query.js';

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind = 'dir' | 'file';
/**
 * Well-known flags. Providers may emit their own strings too; unknown flags are
 * displayed and are queryable via `is:`, they just have no built-in icon or colour.
 */
export const FLAGS = {
  unread: 'unread',
  flagged: 'flagged',
  attachment: 'attachment',
  mention: 'mention',
  draft: 'draft',
  important: 'important',
  reply: 'reply',
  closed: 'closed',
  open: 'open',
  pinned: 'pinned',
  /** Newest message in a thread came from somebody else: the ball is in your court. */
  unanswered: 'unanswered',
  /** Correspondent is outside your own tenant's mail domains. */
  external: 'external',
  /** You wrote it. Deliberately distinct from `read`, which only means you saw it. */
  sent: 'sent',
} as const;

export type WellKnownFlag = (typeof FLAGS)[keyof typeof FLAGS];

export type MetaValue = string | number | boolean | null;

/** A single entry in the virtual filesystem. */
export interface VNode {
  /** Sanitized, unique-within-parent path segment. */
  readonly name: string;
  readonly kind: NodeKind;
  /**
   * Free-form semantic label: `message`, `chat`, `channel`, `thread`, `issue`, `folder`,
   * `feed`, whatever the provider wants.
   *
   * Kept separate from `kind` on purpose. `kind` answers the one question the engine
   * genuinely needs a closed answer to — can you `cd` into this? Everything else is
   * presentation and querying, and hard-coding that set into the engine would mean a new
   * provider could not introduce a `gist` or a `bookmark` without a core change. That is
   * exactly the kind of coupling that makes a plugin system a plugin system in name only.
   */
  readonly subtype?: string;
  /**
   * The original, unsanitized human title. Retained so sanitization is never lossy:
   * `stat` and `ls -l` show this, and search matches against it.
   */
  readonly title: string;
  /** Opaque provider-stable identifier. Survives renames; used for caching and actions. */
  readonly id: string;
  /** Absolute VFS path. Populated by the engine, not the provider. */
  readonly path?: string;
  /**
   * Provider-relative path of the containing directory, e.g. `Inbox` or `Projects/Alpha`.
   *
   * Only meaningful on results returned from `search`, and only providers that implement
   * `search` need to set it. Everywhere else the engine already knows where a node came
   * from, because it asked for that directory.
   *
   * It exists because search is the one operation that returns entries from many
   * directories at once. Without it the engine has to guess, and its only available guess
   * — "it must live directly under the directory being searched" — is wrong for every
   * nested hit, which makes the results impossible to act on. Providers give the location
   * in their own naming; the engine sanitizes each segment and joins it under the mount.
   *
   * Best effort: it drives display and navigation, not identity. Identity is `id`, and
   * every operation can be handed the node itself rather than a reconstructed path.
   */
  readonly parentPath?: string;
  readonly mtime?: Date;
  /** Size in bytes of the rendered body, when known. */
  readonly size?: number;
  readonly flags?: readonly string[];
  /** One-line preview, e.g. the first line of a message body. */
  readonly summary?: string;
  /** Display name of the author/sender. */
  readonly author?: string;
  /** Address/handle of the author, e.g. an email address. */
  readonly authorId?: string;
  /** Arbitrary provider metadata; surfaced by `stat` and queryable via `meta:key=value`. */
  readonly meta?: Readonly<Record<string, MetaValue>>;
  /** Hint for directories whose child count is known cheaply (e.g. unread counts). */
  readonly childCount?: number;
  /** Number of unread children, when the backend reports it cheaply. */
  readonly unreadCount?: number;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export type SortField = 'name' | 'date' | 'author' | 'size';
export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  readonly field: SortField;
  readonly direction: SortDirection;
}

export interface ListOptions {
  /** Opaque continuation token from a previous page. */
  readonly cursor?: string;
  /** Maximum entries to return. Providers may return fewer, never more. */
  readonly limit?: number;
  /** Parsed query the provider should push down as far as it can. */
  readonly query?: Query;
  readonly sort?: SortSpec;
  readonly signal?: AbortSignal;
}

export interface ListPage {
  readonly entries: readonly VNode[];
  /** Present when more entries exist. Absent means this is the last page. */
  readonly cursor?: string;
  /** Total matching entries, when the backend reports it. May be approximate. */
  readonly total?: number;
  /**
   * Which parts of the query the provider evaluated server-side. The engine applies the
   * remainder locally. Omit (or leave empty) to declare "I filtered nothing" — the engine
   * then filters everything itself, which is always correct, just slower.
   */
  readonly appliedQuery?: Query;
  /** True when results came from a local cache rather than the network. */
  readonly fromCache?: boolean;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type BodyFormat = 'text' | 'markdown' | 'html';

export interface AttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly contentType?: string;
  readonly inline?: boolean;
}

/**
 * A rendered document.
 *
 * `headers` is an ordered list rather than an object because reading order is a real
 * accessibility concern: a screen reader announces the fields in array order, so the
 * provider decides that From comes before Subject, not V8's key ordering.
 */
export interface Document {
  readonly title: string;
  readonly headers: ReadonlyArray<readonly [label: string, value: string]>;
  readonly body: string;
  readonly format: BodyFormat;
  readonly attachments?: readonly AttachmentRef[];
  /** Canonical URL to open the item in its native web client. */
  readonly webUrl?: string;
  /** Thread/conversation identifier, for `thread` navigation. */
  readonly threadId?: string;
}

export interface ReadOptions {
  /** Preferred body format. Providers should degrade gracefully. */
  readonly format?: BodyFormat;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export type ChangeType = 'created' | 'updated' | 'deleted';

export interface ChangeEvent {
  readonly type: ChangeType;
  /** Provider-relative path of the changed node. */
  readonly path: string;
  readonly node?: VNode;
  readonly at: Date;
}

export interface PollResult {
  readonly changes: readonly ChangeEvent[];
  /**
   * Cursor to hand back on the next poll. Persisted across restarts, so it must be a
   * string the provider can resume from cold (a Graph deltaLink, an ETag, a timestamp).
   */
  readonly cursor?: string;
  /** Provider-requested delay before the next poll, in seconds (e.g. after a 429). */
  readonly retryAfter?: number;
}

export interface PollOptions {
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionParamType = 'string' | 'text' | 'boolean' | 'number' | 'path' | 'choice';

export interface ActionParam {
  readonly name: string;
  readonly type: ActionParamType;
  readonly label: string;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  readonly default?: MetaValue;
}

/**
 * A verb a provider exposes on a node (reply, mark read, archive, close issue).
 *
 * Actions are declared as data rather than wired into the UI so that the shell, the TUI
 * and the command palette all discover them the same way. A new provider gains a
 * fully keyboard-accessible, tab-completable, help-documented command for free.
 */
export interface ActionDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly params?: readonly ActionParam[];
  /** True when the action is destructive and should require confirmation. */
  readonly destructive?: boolean;
  /**
   * Advertise up front that this verb cannot be taken back.
   *
   * Purely for what the interface can say *before* the user commits — `actions` prints it
   * and the confirmation prompt quotes it. The authoritative answer is still
   * {@link ActionResult.undo}, because only the call itself knows what actually changed.
   */
  readonly irreversible?: boolean;
}

/**
 * How to reverse an action that has already happened.
 *
 * Returned by {@link ActionResult}, not declared on {@link ActionDescriptor}, and that
 * distinction is the whole design. An inverse is not a property of a verb, it is a
 * property of a verb *applied to a particular item at a particular moment*: "mark as
 * read" undoes to "mark as unread" only when the message was unread to begin with, and
 * `tag followup` undoes to `untag followup` only when the tag was not already there.
 *
 * The provider is the only party that knows the prior state, and it knows it at exactly
 * one instant — while it is performing the change. Anything computed later is a guess,
 * and a guessed undo silently writes the wrong state into somebody's mailbox.
 *
 * A provider that genuinely cannot reverse an action omits this. That is a supported
 * answer, and the engine treats it as a hard stop rather than reaching past it to undo
 * something older. See {@link Journal}.
 */
export interface UndoSpec {
  /** The action to invoke to get back to the prior state. */
  readonly action: string;
  readonly params?: Readonly<Record<string, MetaValue>>;
  /** Human phrase for the undo, e.g. "mark it unread again". Used in confirmations. */
  readonly label?: string;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
  /** Paths whose cached state is now stale and should be invalidated. */
  readonly invalidates?: readonly string[];
  /**
   * The exact inverse of what this call did, when there is one.
   *
   * Omit it when the action changed nothing (marking an already-read message read) or
   * when it cannot be taken back (sending a mail). Both are honest answers, and both are
   * better than an inverse that only usually works.
   */
  readonly undo?: UndoSpec;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  'list',
  'read',
  'search',
  'poll',
  'actions',
  'attachments',
  /**
   * Declares a first-class graph, via the `graph` property.
   *
   * Optional in a way the others are not: a provider without it is still projectable,
   * because the engine derives the graph its tree already implies. Declaring it means
   * "I have typed nodes and named edges of my own", which is what lets a projection
   * reorganize around a thread, an assignee or a label rather than only around folders.
   */
  'graph',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /**
   * A logger that prefixes its records with `scope`.
   *
   * Part of the interface rather than just of `ConsoleLogger`, because a provider only ever
   * receives a `Logger`, and a provider is exactly who needs this: with six mounts sharing
   * one stderr stream, unprefixed `--verbose` output cannot be attributed to the mount that
   * produced it, which defeats the point of turning it on.
   */
  child(scope: string): Logger;
}

/** Small persistent key/value store, scoped per mount (sync cursors, ETags, tokens). */
export interface StateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ProviderContext {
  /** Mount point this provider instance is attached to, e.g. `/mail`. */
  readonly mountPath: string;
  readonly logger: Logger;
  readonly state: StateStore;
  /** Directory the provider may use for larger caches. Created on demand. */
  readonly cacheDir: string;
  /**
   * Directory the config was loaded from, when there was one. Options that name a
   * companion file resolve against it so a config directory stays self-contained.
   */
  readonly configDir?: string;
  /**
   * Secret lookup. Resolves `${env:NAME}` style references from config and never returns
   * secrets that were written literally into a config file, so credentials stay out of
   * version control.
   */
  secret(ref: string): Promise<string | undefined>;
  /**
   * Every graph-mapped source the host has, resolved on demand.
   *
   * A function rather than a value because mounts are built in config order, and a
   * provider that composes the others — a projection — must not capture a half-built
   * mount table. Absent when the host does not compose providers at all, which is why
   * anything using it says so plainly rather than failing later.
   */
  graph?(): GraphSpace | Promise<GraphSpace>;
}

/**
 * The interface every backend implements.
 *
 * PROVIDERS NEVER PARSE PATHS. Every operation takes an already-resolved `VNode` (or
 * `null`, meaning the mount root). The engine owns the mapping from a textual path to a
 * node, by walking and caching directory listings.
 *
 * This is deliberate, and it is the second-most important decision in the codebase. The
 * naive alternative — handing providers a mount-relative string like
 * `Inbox/2026-08-11 Budget.eml` — forces every single provider to re-derive an item's
 * backend ID from its display name. That is genuinely impossible to do correctly: display
 * names are sanitized (lossy), they are deduplicated against their siblings (contextual),
 * and two messages can legitimately share a subject and a date. Every provider would
 * reimplement the same fragile reverse-lookup, and each would get it subtly wrong.
 *
 * Passing nodes instead means a provider only ever answers two questions it is actually
 * equipped to answer: "what are the children of this thing you already handed me?" and
 * "what is the body of this thing you already handed me?". The `id` field travels with
 * the node, so the provider indexes by its own native identifier and never guesses.
 *
 * It also matches the real usage pattern for free: the user runs `ls` and then `cat 3`,
 * and the engine already holds that node — so the common path performs zero extra lookups.
 */
export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<Capability>;

  /**
   * True when this mount's contents come from other mounts rather than from a backend of
   * its own — a projection being the built-in case.
   *
   * It exists for cross-source search. Fanning out across "every mount beneath here"
   * silently assumes every mount is an independent source, and a view breaks that in two
   * ways at once: it returns the same items a real source already returned, and it spends
   * a share of a merged, ranked result budget doing so. Searching `/` with one projection
   * over two sources gives back mostly duplicates, and the sources being duplicated are
   * the ones pushed out to make room.
   *
   * So a derived mount is left out of a fan-out that was not asked for by name. It is
   * still searched normally from inside (`find /by-person`), and still searched when named
   * explicitly (`find / --source by-person`), because at that point the user means it.
   */
  readonly derived?: boolean;

  init?(): Promise<void>;
  dispose?(): Promise<void>;

  /**
   * Pay one-time connection cost ahead of being asked for anything.
   *
   * Separate from {@link init} because `init` runs while the session is still starting and
   * everything waits for it, whereas this is explicitly allowed to be slow and is never
   * awaited on a path a user is watching. The Graph providers use it to bring up their MCP
   * server, which costs about seven seconds against roughly a quarter of a second for the
   * request that follows — so whether it is paid here or on the user's first keystroke is
   * the difference between a tool that feels instant and one that appears to hang.
   *
   * Must not throw, must not fetch anything, and must be safe to call more than once. A
   * provider with nothing expensive to set up simply omits it.
   *
   * The signal is a courtesy, not a contract: the engine stops waiting on abort whether or
   * not the provider honours it, because shutting the session down must not be held up by
   * a handshake nobody is waiting for. Honouring it just makes the teardown tidier.
   */
  warm?(signal?: AbortSignal): Promise<void>;

  /** Children of `parent`. `null` means the mount root. */
  list(parent: VNode | null, options: ListOptions): Promise<ListPage>;

  /**
   * Optional fast path for resolving a single child by name, so `cat /mail/Inbox/x.eml`
   * on a cold cache does not have to page through a 200k-message folder. The engine falls
   * back to paged listing when this is absent or returns undefined.
   */
  resolveChild?(parent: VNode | null, name: string, options?: { signal?: AbortSignal }): Promise<VNode | undefined>;

  read?(node: VNode, options: ReadOptions): Promise<Document>;

  /** Recursive search beneath `parent`. Only called when `search` is declared. */
  search?(parent: VNode | null, query: Query, options: ListOptions): Promise<ListPage>;

  /** Resumable change detection. Only called when `poll` is declared. */
  poll?(parent: VNode | null, cursor: string | undefined, options: PollOptions): Promise<PollResult>;

  actions?(node: VNode): Promise<readonly ActionDescriptor[]>;
  invoke?(
    action: string,
    node: VNode,
    params: Readonly<Record<string, MetaValue>>,
  ): Promise<ActionResult>;

  /** Raw bytes of an attachment. Only called when `attachments` is declared. */
  readAttachment?(
    node: VNode,
    attachmentId: string,
  ): Promise<{ name: string; contentType: string; data: Uint8Array }>;

  /**
   * A first-class graph over the same data. Only present when `graph` is declared.
   *
   * A provider that omits it loses nothing except expressiveness: the engine wraps the
   * tree in a graph source that exposes `children`, `descendants` and `parent`, so every
   * mount is projectable whether or not its author thought about projections. Declaring
   * one means naming your own types and edges, which is what lets a user's projection say
   * "group these by assignee" about a thing the engine has never heard of.
   */
  readonly graph?: GraphSource;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * A plugin is a named factory. Config references it by `type`, so adding a backend is
 * "publish a package exporting a plugin, add a mount entry" — no core changes.
 */
export interface ProviderPlugin<TOptions = unknown> {
  readonly type: string;
  readonly displayName: string;
  readonly description?: string;
  /**
   * Validate and normalize raw config. Throwing a VfsError with code ECONFIG here yields
   * a precise startup message instead of a mysterious failure on first use.
   */
  validateOptions?(raw: unknown): TOptions;
  /**
   * Every option key this plugin reads. Optional, and only worth declaring for a provider
   * with a closed set of options.
   *
   * Declaring it turns an option the provider does not understand into a visible warning
   * instead of a silent no-op. Leave it undefined for a provider whose options are open-ended
   * or pass-through; the check is skipped entirely rather than guessed at.
   */
  readonly optionKeys?: readonly string[];
  create(options: TOptions, context: ProviderContext): Provider | Promise<Provider>;
}

/** The shape a plugin package's entry point must have (default or named `plugin` export). */
export interface ProviderPluginModule {
  readonly plugin?: ProviderPlugin;
  readonly default?: ProviderPlugin;
}
