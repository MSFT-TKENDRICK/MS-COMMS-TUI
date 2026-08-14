/**
 * The interaction journal: one record of everything the user did, and the undo stack
 * built out of it.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Two features that look unrelated turn out to be the same feature. "Every interaction is
 * a command" and "every interaction can be undone" both require that an interaction be a
 * *value* — something with a name, arguments, and a stated inverse — rather than a
 * side-effect performed somewhere in a key handler. Once interactions are values, undo is
 * a stack of them, the audit log is a list of them, and a voice transcript is just another
 * way to produce one. None of that is possible while `cd` is a line of code that assigns
 * to a field.
 *
 * So this module defines the value, and everything above it — the shell, the pane, the
 * voice grammar — funnels through {@link Journal.record}.
 *
 * WHY UNDO REFUSES INSTEAD OF SKIPPING
 *
 * The tempting design is "undo reverses the most recent thing that happens to have an
 * inverse", quietly stepping over anything that does not. It is wrong, and dangerously so.
 * Suppose the user archives a message and then sends a reply. The send has no inverse, so
 * a skipping undo would silently un-archive the message the user has just replied to — an
 * edit they did not ask for, two steps back, reported as if it were the obvious one.
 *
 * This implementation stops at the first irreversible entry and says what it is. The user
 * can then step past it deliberately with `undo --skip`, which is a decision they made
 * rather than one the program made for them. Refusing loudly is always recoverable;
 * guessing quietly is not.
 *
 * WHY READS ARE LOGGED BUT NOT UNDOABLE
 *
 * `ls`, `cat` and `find` change nothing, so there is nothing to reverse and putting them
 * on the stack would mean `undo` mostly did nothing visible — which teaches the user that
 * undo is unreliable. They are still recorded, because the log doubles as the answer to
 * "what did I just do?", a question a screen reader user cannot answer by glancing up.
 */

import type { MetaValue, UndoSpec } from './provider.js';

/**
 * What an entry did to the world.
 *
 * - `navigate` moved the user. Reversible by moving back.
 * - `mutate`   changed data in a backend. Reversible only if the provider said how.
 * - `read`     observed something. Never reversible, because nothing changed.
 * - `view`     changed presentation only (page size, output mode, selection).
 */
export type JournalKind = 'navigate' | 'mutate' | 'read' | 'view';

export interface JournalTarget {
  /** VFS path the interaction applied to. */
  readonly path: string;
  /** Provider-stable id, when the interaction had a specific node in hand. */
  readonly id?: string;
  /** Display name, for saying out loud what was undone. */
  readonly name?: string;
}

/**
 * How to reverse one journal entry.
 *
 * Two shapes, because there are exactly two kinds of reversal in this system: put the
 * user back where they were, or ask a provider to invoke the inverse verb it named.
 */
export type Reversal =
  | { readonly kind: 'navigate'; readonly path: string }
  | {
      readonly kind: 'invoke';
      readonly action: string;
      readonly target: JournalTarget;
      readonly params?: Readonly<Record<string, MetaValue>>;
    };

export interface JournalEntry {
  readonly seq: number;
  readonly at: Date;
  readonly kind: JournalKind;
  /**
   * The command line that would repeat this interaction.
   *
   * Every entry carries one, including the ones that arrived by arrow key or by voice.
   * That is the mechanical guarantee behind "everything is commandable": if an interaction
   * cannot be written down as a line the dispatcher would accept, it cannot be recorded,
   * so the gap shows up here rather than as a feature the keyboard-only user cannot reach.
   */
  readonly command: string;
  /** One sentence, past tense, for `history` and for spoken confirmation. */
  readonly summary: string;
  /** Where the interaction came from. Voice entries are marked so the log stays honest. */
  readonly source: 'shell' | 'tui' | 'voice' | 'script' | 'undo' | 'redo';
  readonly target?: JournalTarget;
  /** Present when the entry can be taken back. */
  readonly reversal?: Reversal;
  /** Why it cannot be taken back, when it cannot. Quoted verbatim by `undo`. */
  readonly irreversible?: string;
}

export interface RecordInput {
  readonly kind: JournalKind;
  readonly command: string;
  readonly summary: string;
  readonly source?: JournalEntry['source'];
  readonly target?: JournalTarget;
  readonly reversal?: Reversal;
  readonly irreversible?: string;
}

/** What `undo` decided to do, so the caller can perform it and say so. */
export type JournalStep =
  | { readonly ok: true; readonly entry: JournalEntry; readonly reversal: Reversal }
  | { readonly ok: false; readonly reason: string; readonly blockedBy?: JournalEntry };

/**
 * What `redo` decided to do.
 *
 * Separate from {@link JournalStep} because redo is not a reversal: it re-runs the entry's
 * own command line. Sharing one type would have meant inventing a meaningless `Reversal`
 * to satisfy it, which is how a type stops describing anything.
 */
export type RedoStep =
  | { readonly ok: true; readonly entry: JournalEntry; readonly command: string }
  | { readonly ok: false; readonly reason: string };

export interface JournalOptions {
  /** How many entries to keep. Old ones fall off the bottom. */
  readonly limit?: number;
  readonly now?: () => number;
}

/**
 * Build the inverse of a completed provider action from what the provider reported.
 *
 * Kept as a function rather than inlined so the "an inverse must name a target" rule is
 * enforced in one place: an `UndoSpec` on its own is not enough to undo anything, because
 * it does not say *what* to apply it to.
 */
export function reversalFor(target: JournalTarget, undo: UndoSpec | undefined): Reversal | undefined {
  if (undo === undefined) return undefined;
  return {
    kind: 'invoke',
    action: undo.action,
    target,
    ...(undo.params === undefined ? {} : { params: undo.params }),
  };
}

export class Journal {
  readonly #entries: JournalEntry[] = [];
  /** Entries that have been undone, newest last. Cleared by any new interaction. */
  readonly #redoable: JournalEntry[] = [];
  readonly #limit: number;
  readonly #now: () => number;
  #seq = 0;

  constructor(options: JournalOptions = {}) {
    this.#limit = options.limit ?? 200;
    this.#now = options.now ?? (() => Date.now());
  }

  get entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  get redoable(): readonly JournalEntry[] {
    return this.#redoable;
  }

  record(input: RecordInput): JournalEntry {
    this.#seq += 1;
    const entry: JournalEntry = {
      seq: this.#seq,
      at: new Date(this.#now()),
      kind: input.kind,
      command: input.command,
      summary: input.summary,
      source: input.source ?? 'shell',
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.reversal === undefined ? {} : { reversal: input.reversal }),
      ...(input.irreversible === undefined ? {} : { irreversible: input.irreversible }),
    };

    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) this.#entries.shift();

    // A fresh interaction invalidates the redo stack, exactly as in a text editor. Keeping
    // it would let `redo` reapply a change on top of a world that has since moved.
    if (input.source !== 'undo' && input.source !== 'redo' && this.#redoable.length > 0) {
      this.#redoable.length = 0;
    }
    return entry;
  }

  /**
   * Decide what `undo` should reverse.
   *
   * Walks back over entries that changed nothing — reads and view tweaks — because
   * reversing those is a no-op the user would experience as "undo is broken". Stops dead
   * at anything that changed the world but cannot be reversed. See the file header.
   */
  planUndo(options: { readonly skipIrreversible?: boolean } = {}): JournalStep {
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.kind === 'read' || entry.kind === 'view') continue;
      if (entry.reversal === undefined) {
        if (options.skipIrreversible === true) continue;
        return {
          ok: false,
          reason:
            entry.irreversible ??
            `"${entry.summary}" cannot be undone, and I will not reach past it to undo something older.`,
          blockedBy: entry,
        };
      }
      return { ok: true, entry, reversal: entry.reversal };
    }
    return { ok: false, reason: 'There is nothing to undo.' };
  }

  /**
   * Move an entry from the log onto the redo stack.
   *
   * Called by the host *after* the reversal has actually succeeded. Splitting "decide" from
   * "commit" means a failed backend call — an archive that 429s on the way back — leaves
   * the journal describing the world as it really is rather than as we hoped.
   */
  commitUndo(entry: JournalEntry): void {
    const index = this.#entries.lastIndexOf(entry);
    if (index === -1) return;
    this.#entries.splice(index, 1);
    this.#redoable.push(entry);
  }

  planRedo(): RedoStep {
    const entry = this.#redoable[this.#redoable.length - 1];
    if (entry === undefined) return { ok: false, reason: 'There is nothing to redo.' };
    // Redo re-runs the original command line, which is why every entry carries one.
    return { ok: true, entry, command: entry.command };
  }

  commitRedo(entry: JournalEntry): void {
    const index = this.#redoable.lastIndexOf(entry);
    if (index !== -1) this.#redoable.splice(index, 1);
  }

  /** Most recent first, which is the order a person asks the question in. */
  recent(count: number): readonly JournalEntry[] {
    return this.#entries.slice(-count).reverse();
  }

  clear(): void {
    this.#entries.length = 0;
    this.#redoable.length = 0;
  }
}

// ---------------------------------------------------------------------------
// The change bus
// ---------------------------------------------------------------------------

/**
 * What the interface needs to hear about.
 *
 * A deliberately small, closed set. The alternative — letting the view re-read session
 * fields whenever it feels like it — is what produces the class of bug where the pane and
 * the shell disagree about which folder you are in, and it is unfixable by testing because
 * the two halves are never wrong at the same moment.
 */
export type SessionEvent =
  | { readonly kind: 'cwd'; readonly path: string; readonly reason: string }
  | { readonly kind: 'listing'; readonly path: string }
  /** Data changed underneath. `paths` are the VFS paths whose contents are now stale. */
  | { readonly kind: 'mutated'; readonly paths: readonly string[]; readonly message: string }
  | { readonly kind: 'journal'; readonly summary: string }
  | {
      readonly kind: 'voice';
      readonly phase: 'listening' | 'transcribing' | 'idle' | 'error' | 'heard';
      readonly text?: string;
    };

export type SessionListener = (event: SessionEvent) => void;

/**
 * The smallest emitter that does the job.
 *
 * Node's own EventEmitter would work, but it is untyped at the event-name level, and the
 * whole point of the closed {@link SessionEvent} union is that adding a case makes every
 * subscriber fail to compile until it decides what to do about it.
 */
export class ChangeBus {
  readonly #listeners = new Set<SessionListener>();

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: SessionEvent): void {
    // Copied first: a listener that unsubscribes itself while being notified — which the
    // pane does on exit — must not corrupt the iteration it is inside.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take down the interaction that notified it. The
        // user asked to open a folder, not to hear about a rendering bug.
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}
