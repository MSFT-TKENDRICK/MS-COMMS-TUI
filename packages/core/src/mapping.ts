/**
 * The mapping surface — how a developer attaches a new integration to the VFS.
 *
 * `Provider` is the low-level contract, and it is the right shape for a mailbox: paging
 * cursors, query push-down, resumable polling. It is the wrong shape for the far commoner
 * case, which is "I can already fetch a list of things from an API and I want them to show
 * up as files". Written against `Provider`, that job means implementing name allocation,
 * cursor arithmetic, recursive search and a tree walk — several hundred lines that every
 * integration author would write again, slightly differently, and get subtly wrong in the
 * same places (the conformance suite exists because they did).
 *
 * So this module inverts it. A developer DESCRIBES the mapping — what a record is, what
 * identifies it, what it is called, and what it is connected to — and gets a conforming
 * `Provider` and a `GraphSource` synthesized from the same description:
 *
 * ```ts
 * export const jiraPlugin = defineMapping({
 *   type: 'jira',
 *   displayName: 'Jira',
 *   setup: (options) => ({
 *     types: [{
 *       name: 'Issue',
 *       key: (i: Issue) => i.key,
 *       title: (i: Issue) => i.fields.summary,
 *       extension: '.md',
 *       fields: [{ name: 'status', type: 'String', value: (i: Issue) => i.fields.status.name }],
 *       edges: [{ name: 'comments', target: 'Comment', list: true, resolve: (i: Issue) => fetchComments(i) }],
 *       read: (i: Issue) => ({ title: i.fields.summary, headers: [...], body: i.fields.description, format: 'markdown' }),
 *     }],
 *     roots: [{ name: 'issues', type: 'Issue', resolve: () => fetchIssues(options) }],
 *   }),
 * });
 * ```
 *
 * The decision that makes this more than a convenience wrapper is that a mapping is a
 * GRAPH, not a tree. `edges` are named relations, and `childEdge` picks which one the
 * default `ls` follows. Everything else stays traversable, so a projection
 * (`projection.ts`) can rebuild the hierarchy around comments, or assignees, or status,
 * without the integration author having anticipated it. A mapping author who only ever
 * wanted a tree writes `childEdge` and never thinks about the graph; a user who wants a
 * different tree gets one anyway.
 */

import { VfsError } from './errors.js';
import {
  BUILTIN_NODE_FIELDS,
  graphFieldValue,
  type GraphArgDef,
  type GraphArgValue,
  type GraphEdgeDef,
  type GraphFieldDef,
  type GraphFieldValue,
  type GraphNode,
  type GraphScalar,
  type GraphSchema,
  type GraphSelection,
  type GraphSource,
  type GraphTypeDef,
} from './graph.js';
import { NameAllocator, inferExtension, timestampPrefix } from './naming.js';
import type {
  ActionDescriptor,
  ActionResult,
  Capability,
  Document,
  ListOptions,
  ListPage,
  MetaValue,
  NodeKind,
  Provider,
  ProviderContext,
  ProviderPlugin,
  ReadOptions,
  VNode,
} from './provider.js';
import { evaluateQuery, isMatchAll, type Query } from './query.js';

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

/** What a resolver is being asked for. The same shape a graph traversal passes down. */
export interface MappingRequest {
  readonly limit?: number;
  /**
   * The user's query, parsed. Push it down to your API if you can and ignore it if you
   * cannot: the engine re-filters locally either way, so returning too much is safe.
   */
  readonly query?: Query;
  readonly args: Readonly<Record<string, GraphArgValue>>;
  readonly signal?: AbortSignal;
}

export interface MappedField<TRecord> {
  readonly name: string;
  readonly type: GraphScalar;
  readonly list?: boolean;
  readonly description?: string;
  value(record: TRecord): GraphFieldValue | undefined;
}

export interface MappedEdge<TRecord> {
  readonly name: string;
  /** Name of the target type, as declared in the same mapping. */
  readonly target: string;
  readonly list?: boolean;
  readonly description?: string;
  readonly args?: readonly GraphArgDef[];
  resolve(record: TRecord, request: MappingRequest): Promise<readonly unknown[]> | readonly unknown[];
}

/**
 * One kind of thing an integration has: an issue, a message, a folder, a run.
 *
 * Every resolver here is written in METHOD syntax rather than as an arrow-function
 * property, and that is deliberate. TypeScript checks method parameters bivariantly and
 * property-position function parameters contravariantly, so method syntax is what lets a
 * `MappedType<Issue>` sit in a `readonly MappedType[]` alongside a `MappedType<Comment>`
 * without a cast. The container erases the record type; each type keeps its own.
 *
 * The cost is that record parameters need an explicit annotation — `(i: Issue) => …` —
 * since there is nothing for TypeScript to infer them from. That is a fair trade for a
 * heterogeneous list that type-checks honestly rather than through `any`.
 */
export interface MappedType<TRecord = unknown> {
  readonly name: string;
  readonly description?: string;
  /**
   * Defaults to `dir` when the type has a `childEdge`, and `file` otherwise. Return a
   * constant when it does not depend on the record.
   */
  kind?(record: TRecord): NodeKind;
  /** Free-form semantic label, e.g. `issue`. Defaults to the lowercased type name. */
  readonly subtype?: string;
  /** Stable identity. Must survive a rename; this is what caching and paths key on. */
  key(record: TRecord): string;
  title(record: TRecord): string;
  /**
   * The filename. Defaults to the title, sanitized, with `extension` appended and — when
   * `datePrefix` is set — the date in front. Overriding it is rarely necessary and
   * `naming.ts` documents why the default is shaped the way it is.
   */
  filename?(record: TRecord): string;
  readonly extension?: string;
  /** Prefix names with `YYYY-MM-DD`, which sorts usefully and disambiguates repeats. */
  readonly datePrefix?: boolean;
  mtime?(record: TRecord): Date | undefined;
  author?(record: TRecord): string | undefined;
  authorId?(record: TRecord): string | undefined;
  summary?(record: TRecord): string | undefined;
  size?(record: TRecord): number | undefined;
  flags?(record: TRecord): readonly string[] | undefined;
  meta?(record: TRecord): Readonly<Record<string, MetaValue>> | undefined;
  childCount?(record: TRecord): number | undefined;
  unreadCount?(record: TRecord): number | undefined;

  readonly fields?: readonly MappedField<TRecord>[];
  readonly edges?: readonly MappedEdge<TRecord>[];
  /** The edge `ls` follows. Omit for a leaf. */
  readonly childEdge?: string;

  read?(record: TRecord, options: ReadOptions): Document | Promise<Document>;
  actions?(record: TRecord): readonly ActionDescriptor[] | Promise<readonly ActionDescriptor[]>;
  invoke?(
    action: string,
    record: TRecord,
    params: Readonly<Record<string, MetaValue>>,
  ): ActionResult | Promise<ActionResult>;
  /**
   * Re-fetch a record from its key.
   *
   * Only needed for keys that can be reached without walking there first — a projection
   * resolving a deep path from a cold cache, for instance. Everything else is served from
   * the records already handed out.
   */
  lookup?(key: string): Promise<TRecord | undefined> | TRecord | undefined;
}

export interface MappedRoot {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly args?: readonly GraphArgDef[];
  /** Marks this root as "everything here", so cross-source projections can fan out to it. */
  readonly universal?: boolean;
  /** Set false to keep the root out of the default tree while leaving it projectable. */
  readonly mount?: boolean;
  readonly resolve: (request: MappingRequest) => Promise<readonly unknown[]> | readonly unknown[];
}

export interface Mapping {
  readonly displayName?: string;
  readonly types: readonly MappedType[];
  readonly roots: readonly MappedRoot[];
  /**
   * How the roots appear at the mount point.
   *
   * `auto` (the default) puts a single root's records directly at the mount, because
   * making a user `cd notes` inside `/notes` is pure ceremony, and gives each root its own
   * folder when there is more than one.
   */
  readonly rootMode?: 'auto' | 'folders' | 'flat';
  readonly dispose?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type AnyType = MappedType<unknown>;

interface Bound {
  readonly type: AnyType;
  readonly record: unknown;
  readonly key: string;
}

const ROOT_PREFIX = 'root:';
const MAX_REMEMBERED = 5_000;

/**
 * A `Provider` and a `GraphSource` over one mapping.
 *
 * Both views are generated from the same declaration on purpose. When the tree and the
 * graph are written separately they drift, and a projection that disagrees with `ls`
 * about what exists is worse than having no projection at all.
 */
export class MappedProvider implements Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly graph: GraphSource;

  /**
   * Installed in the constructor only when some type declares the matching resolver.
   *
   * These cannot be plain methods. A method lives on the prototype, so it is present on
   * every instance no matter what the mapping declared, and the engine's capability probe
   * — `typeof provider.read === 'function'` — would then call a code path this mapping
   * never promised to support. `delete` cannot take a prototype method off one instance,
   * so the method has to genuinely never be installed. Same reasoning as `MemoryProvider`.
   */
  readonly read?: (node: VNode, options: ReadOptions) => Promise<Document>;
  readonly actions?: (node: VNode) => Promise<readonly ActionDescriptor[]>;
  readonly invoke?: (
    action: string,
    node: VNode,
    params: Readonly<Record<string, MetaValue>>,
  ) => Promise<ActionResult>;

  readonly #mapping: Mapping;
  readonly #types = new Map<string, AnyType>();
  readonly #roots = new Map<string, MappedRoot>();
  readonly #mountPath: string;
  /**
   * Records handed out, by `type:key`.
   *
   * The engine resolves paths by walking, so a node is nearly always looked up moments
   * after the listing that produced it. This map is what turns that into a hit; `lookup`
   * on the type is the honest fallback for everything else, and its absence is reported
   * rather than guessed at.
   */
  readonly #records = new Map<string, unknown>();

  constructor(id: string, mapping: Mapping, context: Pick<ProviderContext, 'mountPath'>) {
    this.id = id;
    this.displayName = mapping.displayName ?? id;
    this.#mapping = mapping;
    this.#mountPath = context.mountPath;

    for (const type of mapping.types) {
      if (this.#types.has(type.name)) {
        throw VfsError.config(
          `The mapping "${id}" declares the type "${type.name}" twice.`,
          'Type names must be unique within a mapping.',
        );
      }
      this.#types.set(type.name, type);
    }
    for (const root of mapping.roots) {
      if (!this.#types.has(root.type)) {
        throw VfsError.config(
          `The root "${root.name}" of mapping "${id}" refers to the unknown type "${root.type}".`,
          `Declared types: ${[...this.#types.keys()].join(', ') || '(none)'}.`,
        );
      }
      this.#roots.set(root.name, root);
    }
    for (const type of this.#types.values()) {
      for (const edge of type.edges ?? []) {
        if (!this.#types.has(edge.target)) {
          throw VfsError.config(
            `The edge "${type.name}.${edge.name}" of mapping "${id}" points at the unknown type "${edge.target}".`,
            `Declared types: ${[...this.#types.keys()].join(', ')}.`,
          );
        }
      }
      if (type.childEdge !== undefined && !(type.edges ?? []).some((e) => e.name === type.childEdge)) {
        throw VfsError.config(
          `The type "${type.name}" of mapping "${id}" names "${type.childEdge}" as its childEdge, but has no such edge.`,
          'childEdge must name one of the type\'s own edges.',
        );
      }
    }

    const capabilities = new Set<Capability>(['list', 'search', 'graph']);
    if ([...this.#types.values()].some((type) => type.read !== undefined)) capabilities.add('read');
    if ([...this.#types.values()].some((type) => type.actions !== undefined)) capabilities.add('actions');
    this.capabilities = capabilities;

    // Shape must match the declared capability set, so the optional methods are installed
    // only where the mapping actually backs them.
    if (capabilities.has('read')) {
      this.read = (node, options) => this.#readImpl(node, options);
    }
    if (capabilities.has('actions')) {
      this.actions = (node) => this.#actionsImpl(node);
      this.invoke = (action, node, params) => this.#invokeImpl(action, node, params);
    }

    this.graph = this.#buildGraphSource();
  }

  async dispose(): Promise<void> {
    await this.#mapping.dispose?.();
  }

  // -------------------------------------------------------------------------
  // Tree view
  // -------------------------------------------------------------------------

  get #mountableRoots(): readonly MappedRoot[] {
    return this.#mapping.roots.filter((root) => root.mount !== false);
  }

  get #flatRoot(): MappedRoot | undefined {
    const mode = this.#mapping.rootMode ?? 'auto';
    if (mode === 'folders') return undefined;
    const mountable = this.#mountableRoots;
    if (mode === 'flat') return mountable[0];
    return mountable.length === 1 ? mountable[0] : undefined;
  }

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const request = toRequest(options);

    if (parent === null) {
      const flat = this.#flatRoot;
      if (flat !== undefined) return this.#page(await this.#resolveRoot(flat, request), options);
      return { entries: this.#rootFolders() };
    }

    if (parent.id.startsWith(ROOT_PREFIX)) {
      const name = parent.id.slice(ROOT_PREFIX.length);
      const root = this.#roots.get(name);
      if (root === undefined) throw VfsError.notFound(parent.path ?? name);
      return this.#page(await this.#resolveRoot(root, request), options);
    }

    const bound = await this.#bind(parent);
    if (bound === undefined) throw VfsError.notFound(parent.path ?? parent.name);
    const childEdge = bound.type.childEdge;
    if (childEdge === undefined) return { entries: [] };
    return this.#page(await this.#follow(bound, childEdge, request), options);
  }

  async #readImpl(node: VNode, options: ReadOptions): Promise<Document> {
    const bound = await this.#bind(node);
    if (bound === undefined) throw VfsError.notFound(node.path ?? node.name);
    if (bound.type.read === undefined) {
      throw VfsError.unsupported(`Reading a ${bound.type.name}`, this.id);
    }
    return bound.type.read(bound.record, options);
  }

  async #actionsImpl(node: VNode): Promise<readonly ActionDescriptor[]> {
    const bound = await this.#bind(node);
    if (bound?.type.actions === undefined) return [];
    return bound.type.actions(bound.record);
  }

  async #invokeImpl(
    action: string,
    node: VNode,
    params: Readonly<Record<string, MetaValue>>,
  ): Promise<ActionResult> {
    const bound = await this.#bind(node);
    if (bound === undefined) throw VfsError.notFound(node.path ?? node.name);
    if (bound.type.invoke === undefined) {
      throw VfsError.unsupported(`Actions on a ${bound.type.name}`, this.id);
    }
    return bound.type.invoke(action, bound.record, params);
  }

  /**
   * Recursive search.
   *
   * Filtering happens locally and `appliedQuery` is deliberately NOT echoed back, so the
   * engine re-filters. That costs a second pass over a page of results and buys the
   * guarantee `ARCHITECTURE.md` calls the push-down trust boundary: a mapping author who
   * misreads a query cannot silently drop a message.
   */
  async search(parent: VNode | null, query: Query, options: ListOptions): Promise<ListPage> {
    const limit = options.limit ?? 200;
    const request = toRequest({ ...options, query });
    const out: VNode[] = [];
    const seen = new Set<string>();

    const start: readonly Bound[] =
      parent === null ? await this.#allRootRecords(request) : await this.#childrenOf(parent, request);

    const queue: Array<{ bound: Bound; depth: number; path: string }> = start.map((bound) => ({
      bound,
      depth: 0,
      path: parent?.path ?? this.#mountPath,
    }));

    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift();
      if (current === undefined) break;
      const identity = `${current.bound.type.name}:${current.bound.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      const vnode = this.#toVNode(current.bound, new NameAllocator());
      // Always report a location. A hit with neither `path` nor `parentPath` is assumed by
      // the engine to sit directly under the search root, so a nested hit would open with
      // ENOENT. `''` is the honest answer for a hit that really is at the mount root, and
      // the engine reads it as exactly that.
      const parentPath = relativeToMount(current.path, this.#mountPath);
      if (evaluateQuery(query, vnode) !== false) out.push({ ...vnode, parentPath });

      if (current.depth < 6 && current.bound.type.childEdge !== undefined) {
        const children = await this.#follow(current.bound, current.bound.type.childEdge, request);
        const childPath = joinPath(current.path, vnode.name);
        for (const child of children) queue.push({ bound: child, depth: current.depth + 1, path: childPath });
      }
    }

    return { entries: out };
  }

  // -------------------------------------------------------------------------
  // Graph view
  // -------------------------------------------------------------------------

  #buildGraphSource(): GraphSource {
    const provider = this;

    const source: GraphSource = {
      id: this.id,
      displayName: this.displayName,

      schema(): GraphSchema {
        const types: GraphTypeDef[] = [...provider.#types.values()].map((type) => {
          const fields: GraphFieldDef[] = [
            ...BUILTIN_NODE_FIELDS,
            ...(type.fields ?? []).map((field) => ({
              name: field.name,
              type: field.type,
              ...(field.list === undefined ? {} : { list: field.list }),
              ...(field.description === undefined ? {} : { description: field.description }),
            })),
          ];
          const edges: GraphEdgeDef[] = (type.edges ?? []).map((edge) => ({
            name: edge.name,
            target: edge.target,
            ...(edge.list === undefined ? {} : { list: edge.list }),
            ...(edge.description === undefined ? {} : { description: edge.description }),
            ...(edge.args === undefined ? {} : { args: edge.args }),
          }));
          return {
            name: type.name,
            ...(type.description === undefined ? {} : { description: type.description }),
            fields,
            edges,
            ...(type.childEdge === undefined ? {} : { childEdge: type.childEdge }),
          };
        });

        return {
          types,
          roots: provider.#mapping.roots.map((root) => ({
            name: root.name,
            type: root.type,
            list: true,
            ...(root.description === undefined ? {} : { description: root.description }),
            ...(root.args === undefined ? {} : { args: root.args }),
            ...(root.universal === undefined ? {} : { universal: root.universal }),
          })),
        };
      },

      async roots(name, selection) {
        const root = provider.#roots.get(name);
        if (root === undefined) {
          throw VfsError.invalid(
            `"${name}" is not an entry point of the source "${provider.id}".`,
            `Entry points: ${[...provider.#roots.keys()].join(', ') || '(none)'}.`,
          );
        }
        const bounds = await provider.#resolveRoot(root, toRequest(selection));
        return provider.#toGraphNodes(capped(bounds, selection.limit));
      },

      async neighbors(from, edge, selection) {
        const bound = await provider.#bind(from.node);
        if (bound === undefined) return [];
        const bounds = await provider.#follow(bound, edge, toRequest(selection));
        return provider.#toGraphNodes(capped(bounds, selection.limit));
      },

      async node(type, key) {
        const bound = await provider.#bindKey(type, key);
        if (bound === undefined) return undefined;
        return provider.#toGraphNodes([bound])[0];
      },
    };

    if (this.capabilities.has('read')) {
      source.read = async (node, options) => provider.#readImpl(node.node, options);
    }
    if (this.capabilities.has('actions')) {
      source.actions = async (node) => provider.#actionsImpl(node.node);
      source.invoke = async (action, node, params) => provider.#invokeImpl(action, node.node, params);
    }
    return source;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #rootFolders(): readonly VNode[] {
    const allocator = new NameAllocator();
    return this.#mountableRoots.map((root) => ({
      name: allocator.allocate(root.name),
      kind: 'dir' as const,
      title: root.name,
      id: `${ROOT_PREFIX}${root.name}`,
      subtype: 'folder',
      ...(root.description === undefined ? {} : { summary: root.description }),
    }));
  }

  async #resolveRoot(root: MappedRoot, request: MappingRequest): Promise<readonly Bound[]> {
    const type = this.#types.get(root.type);
    if (type === undefined) throw VfsError.config(`Unknown type "${root.type}".`);
    const records = await root.resolve(request);
    return records.map((record) => this.#remember(type, record));
  }

  async #allRootRecords(request: MappingRequest): Promise<readonly Bound[]> {
    const out: Bound[] = [];
    for (const root of this.#mountableRoots) out.push(...(await this.#resolveRoot(root, request)));
    return out;
  }

  async #childrenOf(parent: VNode, request: MappingRequest): Promise<readonly Bound[]> {
    if (parent.id.startsWith(ROOT_PREFIX)) {
      const root = this.#roots.get(parent.id.slice(ROOT_PREFIX.length));
      return root === undefined ? [] : this.#resolveRoot(root, request);
    }
    const bound = await this.#bind(parent);
    if (bound?.type.childEdge === undefined) return [];
    return this.#follow(bound, bound.type.childEdge, request);
  }

  async #follow(bound: Bound, edgeName: string, request: MappingRequest): Promise<readonly Bound[]> {
    const edge = (bound.type.edges ?? []).find((candidate) => candidate.name === edgeName);
    if (edge === undefined) {
      throw VfsError.invalid(
        `"${edgeName}" is not an edge of ${bound.type.name} in the source "${this.id}".`,
        `Edges of ${bound.type.name}: ${(bound.type.edges ?? []).map((e) => e.name).join(', ') || '(none)'}.`,
      );
    }
    const target = this.#types.get(edge.target);
    if (target === undefined) throw VfsError.config(`Unknown type "${edge.target}".`);
    const records = await edge.resolve(bound.record, request);
    return records.map((record) => this.#remember(target, record));
  }

  #remember(type: AnyType, record: unknown): Bound {
    const key = type.key(record);
    const identity = `${type.name}:${key}`;
    if (!this.#records.has(identity) && this.#records.size >= MAX_REMEMBERED) {
      // Oldest first. Map preserves insertion order, so this is a plain FIFO and the
      // recently-walked path — the one the user is standing in — is what survives.
      const oldest = this.#records.keys().next();
      if (oldest.done !== true) this.#records.delete(oldest.value);
    }
    this.#records.set(identity, record);
    return { type, record, key };
  }

  async #bind(node: VNode): Promise<Bound | undefined> {
    const separator = node.id.indexOf(':');
    if (separator <= 0) return undefined;
    return this.#bindKey(node.id.slice(0, separator), node.id.slice(separator + 1));
  }

  async #bindKey(typeName: string, key: string): Promise<Bound | undefined> {
    const type = this.#types.get(typeName);
    if (type === undefined) return undefined;

    const remembered = this.#records.get(`${typeName}:${key}`);
    if (remembered !== undefined) return { type, record: remembered, key };

    if (type.lookup === undefined) return undefined;
    const record = await type.lookup(key);
    if (record === undefined) return undefined;
    return this.#remember(type, record);
  }

  #page(bounds: readonly Bound[], options: ListOptions): ListPage {
    const limit = options.limit ?? bounds.length;
    const allocator = new NameAllocator();
    const entries = bounds.slice(0, limit).map((bound) => this.#toVNode(bound, allocator));
    return {
      entries,
      ...(bounds.length > limit ? { total: bounds.length } : {}),
    };
  }

  #toVNode(bound: Bound, allocator: NameAllocator): VNode {
    const { type, record, key } = bound;
    const kind: NodeKind = type.kind?.(record) ?? (type.childEdge === undefined ? 'file' : 'dir');

    const title = type.title(record);
    const mtime = type.mtime?.(record);
    const extension = type.extension ?? (kind === 'dir' ? '' : inferExtension(title));

    const base =
      type.filename?.(record) ??
      (type.datePrefix === true && mtime !== undefined ? `${timestampPrefix(mtime)} ${title}` : title);

    const name = allocator.allocate(base, {
      fallback: key,
      ...(extension === '' ? {} : { extension }),
    });

    const flags = type.flags?.(record);
    const meta = type.meta?.(record);

    return {
      name,
      kind,
      title,
      id: `${type.name}:${key}`,
      subtype: type.subtype ?? type.name.toLowerCase(),
      ...(mtime === undefined ? {} : { mtime }),
      ...(flags === undefined || flags.length === 0 ? {} : { flags: [...flags] }),
      ...(meta === undefined ? {} : { meta }),
      ...emptyOr('summary', type.summary?.(record)),
      ...emptyOr('author', type.author?.(record)),
      ...emptyOr('authorId', type.authorId?.(record)),
      ...emptyOr('size', type.size?.(record)),
      ...emptyOr('childCount', type.childCount?.(record)),
      ...emptyOr('unreadCount', type.unreadCount?.(record)),
    };
  }

  #toGraphNodes(bounds: readonly Bound[]): readonly GraphNode[] {
    const allocator = new NameAllocator();
    return bounds.map((bound) => {
      const vnode = this.#toVNode(bound, allocator);
      const fields: Record<string, GraphFieldValue> = {};
      for (const field of bound.type.fields ?? []) {
        const value = field.value(bound.record);
        if (value !== undefined) fields[field.name] = value;
      }
      return {
        source: this.id,
        type: bound.type.name,
        key: bound.key,
        node: { ...vnode, path: joinPath(this.#mountPath, vnode.name) },
        fields,
      };
    });
  }
}

function emptyOr<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function toRequest(selection: ListOptions | GraphSelection): MappingRequest {
  const query = 'query' in selection ? selection.query : undefined;
  const args = 'args' in selection && selection.args !== undefined ? selection.args : {};
  return {
    args,
    ...(selection.limit === undefined ? {} : { limit: selection.limit }),
    ...(query === undefined || isMatchAll(query) ? {} : { query }),
    ...(selection.signal === undefined ? {} : { signal: selection.signal }),
  };
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

/**
 * `limit` in a selection is a promise to the caller, not a hint to the backend.
 *
 * `toRequest` passes it down so a mapping *can* push it into its API call, but a mapping
 * that ignores it — most will, since the underlying client often has no such knob — must
 * not cause a projection asking for 5 items to receive 500.
 */
function capped(bounds: readonly Bound[], limit: number | undefined): readonly Bound[] {
  return limit === undefined || bounds.length <= limit ? bounds : bounds.slice(0, limit);
}

function relativeToMount(path: string, mountPath: string): string {
  if (path === mountPath) return '';
  return path.startsWith(`${mountPath}/`) ? path.slice(mountPath.length + 1) : '';
}

// ---------------------------------------------------------------------------
// The plugin factory
// ---------------------------------------------------------------------------

export interface MappingPluginSpec<TOptions> {
  readonly type: string;
  readonly displayName: string;
  readonly description?: string;
  readonly validateOptions?: (raw: unknown) => TOptions;
  readonly setup: (options: TOptions, context: ProviderContext) => Mapping | Promise<Mapping>;
}

/**
 * Turn a mapping description into a registrable plugin.
 *
 * The result is an ordinary `ProviderPlugin`, so a mapped integration is mounted, cached,
 * searched, watched, completed and projected exactly like a hand-written one. There is no
 * second-class tier — the whole point is that the easy path produces a first-class mount.
 */
export function defineMapping<TOptions = unknown>(
  spec: MappingPluginSpec<TOptions>,
): ProviderPlugin<TOptions> {
  const plugin: ProviderPlugin<TOptions> = {
    type: spec.type,
    displayName: spec.displayName,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    async create(options, context) {
      const mapping = await spec.setup(options, context);
      return new MappedProvider(spec.type, { displayName: spec.displayName, ...mapping }, context);
    },
  };
  if (spec.validateOptions !== undefined) plugin.validateOptions = spec.validateOptions;
  return plugin;
}
