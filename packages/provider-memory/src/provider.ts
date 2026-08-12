/**
 * The in-memory fixture provider.
 *
 * Every other provider talks to a network service that can be down, rate-limited, or
 * revoked. This one cannot, which makes it the reference implementation: it is what the
 * conformance suite runs against, what `mscomms demo` mounts, and what someone
 * evaluating the tool sees before they authorize anything against their real mailbox.
 *
 * It deliberately supports the awkward parts of the contract — cursor paging, query
 * push-down reporting, resumable polling, mutating actions, injected failures — because a
 * fixture that only implements the easy half would let real bugs through.
 */

import {
  VfsError,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
  type ChangeEvent,
  type Document,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollResult,
  type Provider,
  type ProviderPlugin,
  type Query,
  type ReadOptions,
  type VNode,
  evaluateQuery,
  isMatchAll,
} from '@mscomms/core';
import { FIXTURES } from './fixtures.js';
import type { MemoryAttachment, MemoryItem, MemoryProviderOptions } from './types.js';

interface Entry {
  readonly item: MemoryItem;
  readonly parentId: string | null;
  readonly children: string[];
  readonly mtime: Date;
  /** Mutable so actions (mark read, flag) have somewhere to land. */
  flags: Set<string>;
}

const CURSOR_PREFIX = 'mem:';

export class MemoryProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<import('@mscomms/core').Capability>;

  readonly #entries = new Map<string, Entry>();
  readonly #roots: string[] = [];
  readonly #pendingRefs: Array<[string, readonly string[]]> = [];
  readonly #options: MemoryProviderOptions;
  readonly #now: () => number;
  readonly #pageSize: number;
  #requestCount = 0;
  #syntheticCount = 0;

  /**
   * Installed in the constructor only when native search is enabled.
   *
   * A capability that is declared but not implemented crashes the engine; a method that is
   * implemented but not declared is worse, because an integrator who feature-detects with
   * `typeof provider.search === 'function'` will call a code path the provider never
   * promised to support. So the method has to genuinely not be there.
   */
  readonly search?: (parent: VNode | null, query: Query, options: ListOptions) => Promise<ListPage>;

  constructor(options: MemoryProviderOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#pageSize = options.pageSize ?? 25;
    this.id = `memory:${options.fixture ?? 'custom'}`;
    this.displayName = options.displayName ?? `Fixture (${options.fixture ?? 'custom'})`;

    const capabilities = new Set<import('@mscomms/core').Capability>(['list', 'read', 'poll', 'actions', 'attachments']);
    if (options.nativeSearch !== false) {
      capabilities.add('search');
      this.search = (parent, query, listOptions) => this.#searchImpl(parent, query, listOptions);
    }
    this.capabilities = capabilities;

    const items = options.items ?? FIXTURES[options.fixture ?? 'mail'] ?? [];
    const base = this.#now();
    for (const item of items) this.#roots.push(this.#index(item, null, base));
    this.#linkRefs();
  }

  #index(item: MemoryItem, parentId: string | null, base: number): string {
    if (this.#entries.has(item.id)) {
      throw VfsError.config(
        `Fixture contains two items with id "${item.id}".`,
        'Item ids must be unique across the whole fixture; they are the stable identity used for caching and for name allocation.',
      );
    }
    const mtime = new Date(base - (item.agoMinutes ?? 0) * 60_000);
    const entry: Entry = {
      item,
      parentId,
      children: [],
      mtime,
      flags: new Set(item.flags ?? []),
    };
    this.#entries.set(item.id, entry);
    for (const child of item.children ?? []) entry.children.push(this.#index(child, item.id, base));
    if (item.refs !== undefined) this.#pendingRefs.push([item.id, item.refs]);
    return item.id;
  }

  /**
   * Second pass: attach referenced children now that every id exists.
   *
   * It has to be a second pass because a reference is routinely backwards — `Colleagues`
   * lists people the `Directory` below it defines — and a fixture author should not have to
   * topologically sort their own org chart. A reference never sets `parentId`, so the
   * place an item was *defined* stays its canonical path however many folders point at it.
   */
  #linkRefs(): void {
    for (const [id, refs] of this.#pendingRefs) {
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      for (const ref of refs) {
        if (!this.#entries.has(ref)) {
          throw VfsError.config(
            `Fixture item "${id}" references "${ref}", which does not exist.`,
            'A `refs` entry must name the id of an item defined somewhere in the same fixture.',
          );
        }
        if (ref === id) {
          throw VfsError.config(
            `Fixture item "${id}" references itself.`,
            'A folder cannot be its own child; reference a different item.',
          );
        }
        if (!entry.children.includes(ref)) entry.children.push(ref);
      }
    }
    this.#pendingRefs.length = 0;
  }

  // -------------------------------------------------------------------------
  // Contract
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    await this.#simulate(options.signal);

    const childIds = parent === null ? this.#roots : (this.#entries.get(parent.id)?.children ?? []);
    if (parent !== null && !this.#entries.has(parent.id)) {
      throw VfsError.notFound(parent.path ?? parent.name);
    }

    let nodes = childIds.map((id) => this.#toNode(id));

    // Push-down is simulated but honest: the provider reports precisely what it filtered
    // so the engine knows what remains. Claiming to have applied a query it did not apply
    // is the single most damaging thing a provider can do here — the engine would trust it
    // and silently return wrong results.
    let applied: Query | undefined;
    const query = options.query;
    if (query !== undefined && !isMatchAll(query) && this.#options.nativeSearch !== false) {
      const before = nodes.length;
      const filtered = nodes.filter((node) => evaluateQuery(query, node) === true);
      // Only claim push-down when every clause was decidable from the node alone.
      const decidable = nodes.every((node) => evaluateQuery(query, node) !== 'unknown');
      if (decidable) {
        nodes = filtered;
        applied = query;
      }
      void before;
    }

    nodes = sortForListing(nodes);

    const offset = parseCursor(options.cursor);
    const limit = Math.max(1, Math.min(options.limit ?? this.#pageSize, 500));
    const slice = nodes.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;

    return {
      entries: slice,
      ...(nextOffset < nodes.length ? { cursor: `${CURSOR_PREFIX}${String(nextOffset)}` } : {}),
      total: nodes.length,
      ...(applied === undefined ? {} : { appliedQuery: applied }),
    };
  }

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    await this.#simulate(options.signal);
    const entry = this.#entries.get(node.id);
    if (entry === undefined) throw VfsError.notFound(node.path ?? node.name);
    if (entry.children.length > 0) throw VfsError.isDirectory(node.path ?? node.name);

    const item = entry.item;
    const headers: Array<readonly [string, string]> = [];
    if (item.author !== undefined) {
      headers.push(['From', item.authorId === undefined ? item.author : `${item.author} <${item.authorId}>`]);
    }
    headers.push(['Date', entry.mtime.toISOString()]);
    headers.push(['Subject', item.title]);
    if (entry.flags.size > 0) headers.push(['Flags', [...entry.flags].sort().join(', ')]);
    for (const [key, value] of Object.entries(item.meta ?? {})) {
      headers.push([key, String(value)]);
    }

    return {
      title: item.title,
      headers,
      body: item.body ?? item.summary ?? '',
      format: item.format ?? 'text',
      ...(item.attachments === undefined
        ? {}
        : {
            attachments: item.attachments.map((att: MemoryAttachment) => ({
              id: att.id,
              name: att.name,
              size: Buffer.byteLength(att.text, 'utf8'),
              ...(att.contentType === undefined ? {} : { contentType: att.contentType }),
            })),
          }),
      ...(item.webUrl === undefined ? {} : { webUrl: item.webUrl }),
      ...(item.threadId === undefined ? {} : { threadId: item.threadId }),
    };
  }

  async #searchImpl(parent: VNode | null, query: Query, options: ListOptions): Promise<ListPage> {
    await this.#simulate(options.signal);

    const startIds = parent === null ? this.#roots : (this.#entries.get(parent.id)?.children ?? []);
    const matches: VNode[] = [];
    const stack = [...startIds];
    // Breadth-ish traversal with an explicit stack: a fixture is small, but recursing on
    // provider-supplied data is how you get a stack overflow from a malformed config.
    // `seen` is what makes a referenced graph safe to search: without it an org chart walks
    // manager → reports → manager for ever, and reports the same unanswered message once
    // per route rather than once.
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      stack.push(...entry.children);
      const node = this.#toNode(id);
      const verdict = evaluateQuery(query, node, { body: entry.item.body ?? '' });
      // Search results come from all over the tree, so each one has to say where it came
      // from; without that the engine can only assume "directly under the search root",
      // which is wrong for every nested hit.
      if (verdict === true) matches.push({ ...node, parentPath: this.#parentPathOf(id) });
    }

    const sorted = sortForListing(matches);
    const offset = parseCursor(options.cursor);
    const limit = Math.max(1, Math.min(options.limit ?? this.#pageSize, 500));
    const slice = sorted.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;

    return {
      entries: slice,
      ...(nextOffset < sorted.length ? { cursor: `${CURSOR_PREFIX}${String(nextOffset)}` } : {}),
      total: sorted.length,
      appliedQuery: query,
    };
  }

  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    await this.#simulate(options.signal);

    if (this.#options.synthesizeChanges === true && cursor !== undefined) {
      const target = parent === null ? this.#roots[0] : parent.id;
      const parentEntry = target === undefined ? undefined : this.#entries.get(target);
      if (parentEntry !== undefined) {
        this.#syntheticCount += 1;
        const id = `synthetic-${String(this.#syntheticCount)}`;
        const item: MemoryItem = {
          id,
          title: `Simulated message ${String(this.#syntheticCount)}`,
          subtype: 'message',
          author: 'Fixture Robot',
          authorId: 'robot@contoso.example',
          flags: ['unread'],
          summary: 'Generated by the fixture provider so notifications can be demoed offline.',
          body: 'Generated by the fixture provider so notifications can be demoed offline.',
        };
        this.#index(item, parentEntry.item.id, this.#now());
        parentEntry.children.unshift(id);
        const node = this.#toNode(id);
        return {
          changes: [{ type: 'created', path: node.name, node, at: new Date(this.#now()) }],
          cursor: String(this.#now()),
        };
      }
    }

    const since = cursor === undefined ? undefined : Number(cursor);
    const changes: ChangeEvent[] = [];
    if (since !== undefined && Number.isFinite(since)) {
      for (const [id, entry] of this.#entries) {
        if (entry.mtime.getTime() > since && entry.children.length === 0) {
          const node = this.#toNode(id);
          changes.push({ type: 'created', path: node.name, node, at: entry.mtime });
        }
      }
    }

    return { changes, cursor: String(this.#now()) };
  }

  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    const entry = this.#entries.get(node.id);
    if (entry === undefined) return [];
    const descriptors: ActionDescriptor[] = [];

    if (entry.flags.has('unread')) {
      descriptors.push({ name: 'read', label: 'Mark as read', description: 'Clear the unread flag.' });
    } else {
      descriptors.push({ name: 'unread', label: 'Mark as unread', description: 'Set the unread flag.' });
    }
    descriptors.push({
      name: 'flag',
      label: entry.flags.has('flagged') ? 'Remove flag' : 'Flag',
      description: 'Toggle the flagged marker.',
    });
    descriptors.push({
      name: 'tag',
      label: 'Add a tag',
      description: 'Attach an arbitrary flag, to exercise action parameters.',
      params: [{ name: 'tag', type: 'string', label: 'Tag name', required: true }],
    });
    return descriptors;
  }

  async invoke(action: string, node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    const entry = this.#entries.get(node.id);
    if (entry === undefined) throw VfsError.notFound(node.path ?? node.name);

    switch (action) {
      case 'read':
        entry.flags.delete('unread');
        return { ok: true, message: `Marked "${entry.item.title}" as read.`, invalidates: [node.path ?? ''] };
      case 'unread':
        entry.flags.add('unread');
        return { ok: true, message: `Marked "${entry.item.title}" as unread.`, invalidates: [node.path ?? ''] };
      case 'flag': {
        const nowFlagged = !entry.flags.has('flagged');
        if (nowFlagged) entry.flags.add('flagged');
        else entry.flags.delete('flagged');
        return {
          ok: true,
          message: `${nowFlagged ? 'Flagged' : 'Unflagged'} "${entry.item.title}".`,
          invalidates: [node.path ?? ''],
        };
      }
      case 'tag': {
        const tag = params['tag'];
        if (typeof tag !== 'string' || tag.length === 0) {
          throw VfsError.invalid('The "tag" action needs a tag name.', 'Try: do tag 3 tag=followup');
        }
        entry.flags.add(tag);
        return { ok: true, message: `Tagged "${entry.item.title}" with ${tag}.`, invalidates: [node.path ?? ''] };
      }
      default:
        throw VfsError.unsupported(`Action "${action}"`, this.id);
    }
  }

  async readAttachment(node: VNode, attachmentId: string): Promise<{ name: string; contentType: string; data: Uint8Array }> {
    const entry = this.#entries.get(node.id);
    const attachment = entry?.item.attachments?.find((a) => a.id === attachmentId || a.name === attachmentId);
    if (attachment === undefined) {
      throw VfsError.notFound(attachmentId, 'Run `stat` on the message to list its attachment ids.');
    }
    return {
      name: attachment.name,
      contentType: attachment.contentType ?? 'application/octet-stream',
      data: new TextEncoder().encode(attachment.text),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Walk up the parent chain to build the provider-relative folder path for a node. */
  #parentPathOf(id: string): string {
    const parts: string[] = [];
    let current = this.#entries.get(id)?.parentId ?? null;
    while (current !== null && current !== undefined) {
      const entry = this.#entries.get(current);
      if (entry === undefined) break;
      parts.unshift(entry.item.title);
      current = entry.parentId;
    }
    return parts.join('/');
  }

  #toNode(id: string): VNode {    const entry = this.#entries.get(id);
    if (entry === undefined) throw VfsError.notFound(id);
    const item = entry.item;
    const isDir = item.children !== undefined || item.refs !== undefined;
    const body = item.body ?? '';

    const unread = entry.children.reduce((count, childId) => {
      const child = this.#entries.get(childId);
      return count + (child?.flags.has('unread') === true ? 1 : 0);
    }, 0);

    return {
      name: nameFor(item, entry.mtime, isDir),
      kind: isDir ? 'dir' : 'file',
      title: item.title,
      id: item.id,
      mtime: entry.mtime,
      ...(item.subtype === undefined ? {} : { subtype: item.subtype }),
      ...(isDir ? {} : { size: Buffer.byteLength(body, 'utf8') }),
      ...(entry.flags.size === 0 ? {} : { flags: [...entry.flags].sort() }),
      ...(item.summary === undefined ? {} : { summary: item.summary }),
      ...(item.author === undefined ? {} : { author: item.author }),
      ...(item.authorId === undefined ? {} : { authorId: item.authorId }),
      ...(item.meta === undefined ? {} : { meta: item.meta }),
      ...(isDir ? { childCount: entry.children.length, unreadCount: unread } : {}),
    };
  }

  async #simulate(signal: AbortSignal | undefined): Promise<void> {
    this.#requestCount += 1;

    const failEvery = this.#options.failEvery ?? 0;
    if (failEvery > 0 && this.#requestCount % failEvery === 0) {
      throw new VfsError('ENETWORK', 'Simulated backend failure.', {
        hint: 'The fixture provider is configured with failEvery, which injects this on purpose so error paths get exercised.',
      });
    }

    const latency = this.#options.latencyMs ?? 0;
    if (latency > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new VfsError('ECANCELED', 'Cancelled.'));
          },
          { once: true },
        );
      });
    }

    if (signal?.aborted === true) throw new VfsError('ECANCELED', 'Cancelled.');
  }
}

/**
 * A dated item is named for when it arrived, because that is how a listing of a hundred
 * near-identical subjects stays navigable. A singular document — a person's profile, of
 * which there is exactly one per folder — is named for what it is instead, so that the
 * obvious `cat .../profile.md` works without first running `ls` to discover the date.
 */
function nameFor(item: MemoryItem, mtime: Date, isDir: boolean): string {
  if (isDir) return item.title;
  if (item.subtype === 'profile') return `${item.title}${extensionFor(item)}`;
  return `${timestampPrefix(mtime)} ${item.title}${extensionFor(item)}`;
}

function extensionFor(item: MemoryItem): string {
  switch (item.subtype) {
    case 'issue':
    case 'profile':
    case 'chat':
      return '.md';
    case 'message':
      return '.eml';
    default:
      return item.body === undefined ? '' : '.txt';
  }
}

/** Directories first, then newest first. Matches what every mail client does. */
function sortForListing(nodes: readonly VNode[]): VNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    const at = a.mtime?.getTime() ?? 0;
    const bt = b.mtime?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return a.title.localeCompare(b.title);
  });
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw VfsError.invalid(`Unrecognised cursor "${cursor}".`, 'Cursors are opaque; do not construct them by hand.');
  }
  const offset = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

export const memoryPlugin: ProviderPlugin<MemoryProviderOptions> = {
  type: 'memory',
  displayName: 'In-memory fixture',
  description: 'Deterministic sample data for demos and tests. Needs no credentials and makes no network calls.',
  validateOptions(raw) {
    const options = (raw ?? {}) as MemoryProviderOptions;
    if (options.fixture !== undefined && FIXTURES[options.fixture] === undefined) {
      throw VfsError.config(
        `Unknown fixture "${String(options.fixture)}".`,
        `Available fixtures: ${Object.keys(FIXTURES).join(', ')}.`,
      );
    }
    return options;
  },
  create(options) {
    return new MemoryProvider(options);
  },
};
