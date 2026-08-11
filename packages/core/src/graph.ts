/**
 * The graph model — what a mapped integration actually is, underneath the tree.
 *
 * The VFS presents a tree because a tree is what `cd` and `ls` are for. But the things
 * being mapped are not trees. A message has an author, a thread, a set of recipients and
 * a repository; an issue has labels, a milestone and a project. Force that into one
 * hierarchy and you have to pick a single parent for every item, which is exactly the
 * complaint `query.ts` opens with: the same message is legitimately "from Alice",
 * "unread" and "about the budget" at once.
 *
 * So a mapping declares a GRAPH — typed nodes and named edges — and the tree is a *view*
 * of it. `childEdge` on a type names the edge the default `ls` view follows, and
 * everything else stays reachable. A user who thinks the default hierarchy is wrong is
 * not stuck with it: they write a projection (see `projection.ts`) that walks the same
 * graph a different way and mounts the result as another tree.
 *
 * Two properties make that possible and are worth stating as rules:
 *
 * 1. EVERY MAPPED SOURCE IS A GRAPH SOURCE, whether or not its author wrote one. A
 *    provider that only implements `list`/`read` gets {@link treeGraphSource}, which
 *    exposes exactly the graph its tree already implies — `children`, `descendants`,
 *    `parent`. Nobody has to opt in to be projectable, so a projection can be written
 *    against every mount the user has, including third-party ones.
 *
 * 2. A GRAPH NODE ALWAYS CARRIES ITS VNODE. Projections rearrange nodes; they never
 *    reimplement them. Whatever the projected tree looks like, `cat` on a leaf reads the
 *    same document, `do` offers the same actions, and the name the user sees is the name
 *    the owning provider chose.
 */

import type {
  ActionDescriptor,
  ActionResult,
  Document,
  ListOptions,
  MetaValue,
  ReadOptions,
  SortSpec,
  VNode,
} from './provider.js';
import type { Query } from './query.js';
import { VfsError } from './errors.js';
import * as vpath from './vpath.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Scalar types a mapped field may have.
 *
 * Deliberately tiny. This is the vocabulary a projection author has to learn, and every
 * addition is a thing they must know to write a query. `JSON` is the escape hatch for
 * genuinely unstructured provider metadata.
 */
export type GraphScalar = 'String' | 'Int' | 'Float' | 'Boolean' | 'DateTime' | 'JSON';

export interface GraphFieldDef {
  readonly name: string;
  readonly type: GraphScalar;
  readonly list?: boolean;
  readonly description?: string;
}

export interface GraphArgDef {
  readonly name: string;
  readonly type: GraphScalar;
  readonly description?: string;
}

/** A named, directed relation from one node type to another. */
export interface GraphEdgeDef {
  readonly name: string;
  /** Target type name, as declared within the same source. */
  readonly target: string;
  /** True when following the edge yields many nodes rather than at most one. */
  readonly list?: boolean;
  readonly description?: string;
  readonly args?: readonly GraphArgDef[];
}

export interface GraphTypeDef {
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly GraphFieldDef[];
  readonly edges: readonly GraphEdgeDef[];
  /**
   * Which edge the default tree view follows for `ls`.
   *
   * This is the single line that turns a graph into a filesystem, and keeping it as data
   * rather than as structure is the point: a projection overrides it by naming a
   * different edge, without the source having to be rewritten or even to know.
   */
  readonly childEdge?: string;
}

/** An entry point: where a traversal can start within a source. */
export interface GraphRootDef {
  readonly name: string;
  readonly type: string;
  readonly list?: boolean;
  readonly description?: string;
  readonly args?: readonly GraphArgDef[];
  /**
   * True when this root means "everything in this source", so cross-source roots can
   * fan out to it. Exactly one root per source should set it.
   */
  readonly universal?: boolean;
}

export interface GraphSchema {
  readonly types: readonly GraphTypeDef[];
  readonly roots: readonly GraphRootDef[];
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type GraphFieldValue = MetaValue | Date | readonly MetaValue[];

/**
 * One entity in the graph.
 *
 * `key` is identity within `(source, type)`; `node` is how it looks as a file. Both are
 * required, because a projection needs the first to deduplicate and the second to
 * display, and deriving either from the other is the mistake `provider.ts` spends a
 * paragraph warning about.
 */
export interface GraphNode {
  readonly source: string;
  readonly type: string;
  readonly key: string;
  readonly node: VNode;
  readonly fields: Readonly<Record<string, GraphFieldValue>>;
}

export type GraphArgValue = MetaValue | readonly MetaValue[];

export interface GraphSelection {
  readonly limit?: number;
  /** Parsed query, in the same language as `find`. Sources push it down when they can. */
  readonly query?: Query;
  readonly sort?: SortSpec;
  readonly args?: Readonly<Record<string, GraphArgValue>>;
  readonly signal?: AbortSignal;
}

/**
 * What a mapped integration exposes to projections.
 *
 * Note what is absent: paging cursors. A projection is a navigation aid, not a mailbox
 * dump, so traversal is bounded by `limit` and the caller's patience rather than by a
 * resumable cursor. Sources are expected to honour `limit` strictly — the same rule the
 * provider contract already imposes, for the same reason.
 */
export interface GraphSource {
  readonly id: string;
  readonly displayName: string;

  schema(): GraphSchema | Promise<GraphSchema>;

  /** Nodes at a named entry point. */
  roots(name: string, selection: GraphSelection): Promise<readonly GraphNode[]>;

  /** Nodes reached by following `edge` from `from`. */
  neighbors(from: GraphNode, edge: string, selection: GraphSelection): Promise<readonly GraphNode[]>;

  /** Re-fetch one node by identity. Used to rebuild a projection path from cold. */
  node?(type: string, key: string): Promise<GraphNode | undefined>;

  read?(node: GraphNode, options: ReadOptions): Promise<Document>;
  actions?(node: GraphNode): Promise<readonly ActionDescriptor[]>;
  invoke?(
    action: string,
    node: GraphNode,
    params: Readonly<Record<string, MetaValue>>,
  ): Promise<ActionResult>;
}

// ---------------------------------------------------------------------------
// Built-in node fields
// ---------------------------------------------------------------------------

/**
 * Fields every node has, whatever its type, derived from its `VNode`.
 *
 * Having a guaranteed set is what lets a projection be written against sources the author
 * has never seen — `{ nodes(filter: "is:unread") { name author mtime } }` works against a
 * mailbox, a feed and somebody's Jira plugin without knowing anything about them.
 */
export const BUILTIN_NODE_FIELDS: readonly GraphFieldDef[] = [
  { name: 'id', type: 'String', description: "The owning provider's stable identifier." },
  { name: 'name', type: 'String', description: 'Filename within its directory.' },
  { name: 'title', type: 'String', description: 'Unsanitized human title.' },
  { name: 'path', type: 'String', description: 'Absolute path in the source tree.' },
  { name: 'kind', type: 'String', description: '`dir` or `file`.' },
  { name: 'subtype', type: 'String', description: 'Provider label: message, issue, feed…' },
  { name: 'source', type: 'String', description: 'Mount the node came from.' },
  { name: 'mtime', type: 'DateTime' },
  { name: 'size', type: 'Int' },
  { name: 'author', type: 'String' },
  { name: 'authorId', type: 'String' },
  { name: 'summary', type: 'String' },
  { name: 'flags', type: 'String', list: true },
  { name: 'unread', type: 'Boolean' },
  { name: 'flagged', type: 'Boolean' },
  { name: 'childCount', type: 'Int' },
  { name: 'unreadCount', type: 'Int' },
  { name: 'meta', type: 'JSON', description: 'Provider metadata, addressable as meta_<key>.' },
];

const BUILTIN_NAMES = new Set(BUILTIN_NODE_FIELDS.map((f) => f.name));

export function isBuiltinNodeField(name: string): boolean {
  return BUILTIN_NAMES.has(name) || name.startsWith('meta_');
}

/**
 * Read one field off a node.
 *
 * Lookup order is declared fields, then built-ins, then `meta`. Declared fields win so a
 * mapping can give `author` a better answer than the VNode's. `meta` comes last, and by
 * then every built-in name has already been answered — including with `null` when the
 * value is absent — so a provider's metadata can never shadow a built-in by accident.
 *
 * Both `meta_project` and bare `project` reach the same metadata. The prefix is the
 * unambiguous spelling; the bare one is what people actually type, and refusing it would
 * make provider metadata effectively invisible to projections.
 */
export function graphFieldValue(node: GraphNode, field: string): GraphFieldValue | undefined {
  const declared = node.fields[field];
  if (declared !== undefined) return declared;

  const vnode = node.node;
  switch (field) {
    case 'id':
      return vnode.id;
    case 'name':
      return vnode.name;
    case 'title':
      return vnode.title;
    case 'path':
      return vnode.path ?? null;
    case 'kind':
      return vnode.kind;
    case 'subtype':
      return vnode.subtype ?? null;
    case 'source':
      return node.source;
    case 'mtime':
      return vnode.mtime ?? null;
    case 'size':
      return vnode.size ?? null;
    case 'author':
      return vnode.author ?? null;
    case 'authorId':
      return vnode.authorId ?? null;
    case 'summary':
      return vnode.summary ?? null;
    case 'flags':
      return [...(vnode.flags ?? [])];
    case 'unread':
      return vnode.flags?.includes('unread') ?? false;
    case 'flagged':
      return vnode.flags?.includes('flagged') ?? false;
    case 'childCount':
      return vnode.childCount ?? null;
    case 'unreadCount':
      return vnode.unreadCount ?? null;
    case 'meta':
      return vnode.meta === undefined ? null : JSON.stringify(vnode.meta);
    default:
      break;
  }

  if (field.startsWith('meta_')) {
    const value = vnode.meta?.[field.slice('meta_'.length)];
    return value === undefined ? null : value;
  }
  return vnode.meta?.[field];
}

/** Render a field value for use in a filename or a grouping key. */
export function graphFieldText(value: GraphFieldValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (Array.isArray(value)) return value.map((v) => graphFieldText(v as GraphFieldValue)).join(', ');
  return String(value);
}

// ---------------------------------------------------------------------------
// The tree adapter
// ---------------------------------------------------------------------------

/**
 * The subset of the VFS engine the tree adapter needs.
 *
 * Declared structurally rather than importing `Vfs` so that `vfs.ts` can depend on this
 * module and not the other way round. `Vfs` satisfies it without knowing it exists.
 */
export interface GraphTreeHost {
  list(
    target: string | VNode,
    options?: ListOptions & { refresh?: boolean },
  ): Promise<{ readonly entries: readonly VNode[]; readonly cursor?: string }>;
  read(target: string | VNode, options?: ReadOptions): Promise<Document>;
  search?(
    path: string,
    query: Query,
    options?: ListOptions & { maxNodes?: number; maxDepth?: number },
  ): Promise<{ readonly entries: readonly VNode[] }>;
  actions?(target: string | VNode): Promise<readonly ActionDescriptor[]>;
  invoke?(
    action: string,
    target: string | VNode,
    params: Readonly<Record<string, MetaValue>>,
  ): Promise<ActionResult>;
}

export interface TreeGraphOptions {
  /** Ceiling on nodes returned by a recursive traversal. */
  readonly maxNodes?: number;
  /** Ceiling on recursion depth. */
  readonly maxDepth?: number;
  readonly supportsSearch?: boolean;
}

const TREE_TYPE = 'Entry';
const DEFAULT_MAX_NODES = 500;
const DEFAULT_MAX_DEPTH = 6;

/**
 * Expose an ordinary tree-shaped mount as a graph source.
 *
 * This is what makes "every mount is projectable" true rather than aspirational. The
 * graph it exposes is the smallest honest one: the tree, plus the two edges the tree
 * already implies. A provider that wants a richer graph — messages linked to their
 * thread, issues to their labels — declares one, either by hand or via `mapping.ts`.
 */
export function treeGraphSource(
  host: GraphTreeHost,
  mount: { readonly id: string; readonly path: string; readonly description?: string },
  options: TreeGraphOptions = {},
): GraphSource {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const toGraphNode = (vnode: VNode): GraphNode => ({
    source: mount.id,
    type: TREE_TYPE,
    key: vnode.path ?? `${vnode.id}@${vnode.name}`,
    node: vnode,
    fields: {},
  });

  const walk = async (
    startPath: string,
    selection: GraphSelection,
    filesOnly: boolean,
  ): Promise<readonly GraphNode[]> => {
    const limit = Math.min(selection.limit ?? maxNodes, maxNodes);
    const out: GraphNode[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: startPath, depth: 0 }];
    const seen = new Set<string>([startPath]);

    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > maxDepth) continue;

      let entries: readonly VNode[];
      try {
        entries = (await host.list(current.path, { limit: Math.max(limit, 50) })).entries;
      } catch {
        // A single unreachable folder must not empty the whole projection. Skipping it is
        // the same containment rule a broken mount gets in `registry.ts`.
        continue;
      }

      for (const entry of entries) {
        const path = entry.path ?? vpath.join(current.path, entry.name);
        if (seen.has(path)) continue;
        seen.add(path);
        if (entry.kind === 'dir') {
          queue.push({ path, depth: current.depth + 1 });
          if (filesOnly) continue;
        }
        out.push(toGraphNode({ ...entry, path }));
        if (out.length >= limit) break;
      }
    }
    return out;
  };

  const source: GraphSource = {
    id: mount.id,
    displayName: mount.description ?? mount.id,

    schema(): GraphSchema {
      return {
        types: [
          {
            name: TREE_TYPE,
            description: `Any file or folder under ${mount.path}.`,
            fields: BUILTIN_NODE_FIELDS,
            edges: [
              { name: 'children', target: TREE_TYPE, list: true, description: 'Direct children.' },
              {
                name: 'descendants',
                target: TREE_TYPE,
                list: true,
                description: 'Everything beneath this node, breadth-first.',
              },
              { name: 'parent', target: TREE_TYPE, description: 'The containing folder.' },
            ],
            childEdge: 'children',
          },
        ],
        roots: [
          { name: 'entries', type: TREE_TYPE, list: true, description: 'Top-level entries of the mount.' },
          {
            name: 'all',
            type: TREE_TYPE,
            list: true,
            universal: true,
            description: 'Every node beneath the mount, breadth-first and bounded.',
          },
          {
            name: 'files',
            type: TREE_TYPE,
            list: true,
            description: 'Every file beneath the mount, skipping folders.',
          },
        ],
      };
    },

    async roots(name, selection) {
      switch (name) {
        case 'entries': {
          const page = await host.list(mount.path, {
            ...(selection.limit === undefined ? {} : { limit: selection.limit }),
            ...(selection.query === undefined ? {} : { query: selection.query }),
            ...(selection.sort === undefined ? {} : { sort: selection.sort }),
            ...(selection.signal === undefined ? {} : { signal: selection.signal }),
          });
          return page.entries.map((entry) =>
            toGraphNode({ ...entry, path: entry.path ?? vpath.join(mount.path, entry.name) }),
          );
        }
        case 'all':
        case 'files': {
          // Push the query down through `search` when the mount has it: walking a mailbox
          // client-side to answer `is:unread` is the exact failure mode `provider.ts`
          // exists to avoid.
          if (selection.query !== undefined && host.search !== undefined && options.supportsSearch === true) {
            const result = await host.search(mount.path, selection.query, {
              ...(selection.limit === undefined ? {} : { limit: selection.limit }),
              maxNodes,
              maxDepth,
            });
            const hits = result.entries.filter((entry) => name !== 'files' || entry.kind !== 'dir');
            return hits.map((entry) => toGraphNode(entry));
          }
          return walk(mount.path, selection, name === 'files');
        }
        default:
          throw VfsError.invalid(
            `"${name}" is not an entry point of the source "${mount.id}".`,
            'Run `schema` to see the entry points every mount offers.',
          );
      }
    },

    async neighbors(from, edge, selection) {
      const path = from.node.path;
      switch (edge) {
        case 'children': {
          if (from.node.kind !== 'dir') return [];
          const page = await host.list(from.node, {
            ...(selection.limit === undefined ? {} : { limit: selection.limit }),
            ...(selection.query === undefined ? {} : { query: selection.query }),
            ...(selection.sort === undefined ? {} : { sort: selection.sort }),
            ...(selection.signal === undefined ? {} : { signal: selection.signal }),
          });
          const base = path ?? mount.path;
          return page.entries.map((entry) =>
            toGraphNode({ ...entry, path: entry.path ?? vpath.join(base, entry.name) }),
          );
        }
        case 'descendants': {
          if (from.node.kind !== 'dir' || path === undefined) return [];
          return walk(path, selection, false);
        }
        case 'parent': {
          if (path === undefined) return [];
          const parentPath = vpath.dirname(path);
          if (!vpath.contains(mount.path, parentPath) || parentPath === path) return [];
          const page = await host.list(vpath.dirname(parentPath), { limit: 500 });
          const match = page.entries.find((entry) => (entry.path ?? '') === parentPath);
          return match === undefined ? [] : [toGraphNode(match)];
        }
        default:
          throw VfsError.invalid(
            `"${edge}" is not an edge of ${TREE_TYPE} in the source "${mount.id}".`,
            'Tree-shaped mounts expose children, descendants and parent.',
          );
      }
    },

    async node(_type, key) {
      // The key of a tree node is its path, so re-fetching one is a plain listing of its
      // parent. That is what makes a projected path resolvable from a cold start.
      if (!key.startsWith('/')) return undefined;
      const parentPath = vpath.dirname(key);
      const page = await host.list(parentPath, { limit: 500 });
      const match = page.entries.find(
        (entry) => (entry.path ?? vpath.join(parentPath, entry.name)) === key,
      );
      return match === undefined ? undefined : toGraphNode({ ...match, path: key });
    },

    async read(node, readOptions) {
      return host.read(node.node, readOptions);
    },
  };

  if (host.actions !== undefined) {
    source.actions = async (node) => host.actions?.(node.node) ?? [];
  }
  if (host.invoke !== undefined) {
    source.invoke = async (action, node, params) => {
      if (host.invoke === undefined) {
        throw VfsError.unsupported('Actions', mount.id);
      }
      return host.invoke(action, node.node, params);
    };
  }

  return source;
}

// ---------------------------------------------------------------------------
// The graph space
// ---------------------------------------------------------------------------

export interface GraphSourceEntry {
  /** GraphQL-safe alias, unique within the space. */
  readonly alias: string;
  readonly mountId: string;
  readonly mountPath: string;
  readonly source: GraphSource;
}

/**
 * Turn an arbitrary identifier into something a GraphQL name can be.
 *
 * Mount ids are user-chosen and routinely contain characters GraphQL forbids
 * (`demo-mail`, `octocat/hello-world`). Silently failing to expose such a mount would
 * make projections quietly incomplete, which is the failure mode this codebase treats as
 * the worst one available, so they are rewritten instead.
 */
export function safeGraphName(input: string): string {
  const replaced = input.replace(/[^_A-Za-z0-9]/g, '_');
  return /^[_A-Za-z]/.test(replaced) ? replaced : `_${replaced}`;
}

/**
 * Every graph-mapped source the user has, addressable as one graph.
 *
 * This is the "all sources" a projection is written against. It is built fresh from the
 * live mount table rather than cached, because a mount added by `mount` mid-session must
 * be projectable without restarting.
 */
export class GraphSpace {
  readonly #entries: readonly GraphSourceEntry[];

  constructor(entries: readonly GraphSourceEntry[]) {
    const used = new Set<string>();
    const deduped: GraphSourceEntry[] = [];
    for (const entry of entries) {
      let alias = safeGraphName(entry.alias);
      let suffix = 2;
      while (used.has(alias)) {
        alias = `${safeGraphName(entry.alias)}_${suffix}`;
        suffix += 1;
      }
      used.add(alias);
      deduped.push({ ...entry, alias });
    }
    this.#entries = deduped;
  }

  get entries(): readonly GraphSourceEntry[] {
    return this.#entries;
  }

  get isEmpty(): boolean {
    return this.#entries.length === 0;
  }

  find(alias: string): GraphSourceEntry | undefined {
    return this.#entries.find((entry) => entry.alias === alias || entry.mountId === alias);
  }

  /**
   * The same space minus anything at or beneath `path`.
   *
   * A projection is itself a mount, so without this a projection over "all sources" would
   * include itself and recurse until the stack gave out. Excluding by path rather than by
   * id also covers a projection of a projection, which is a reasonable thing to want.
   */
  without(path: string): GraphSpace {
    return new GraphSpace(this.#entries.filter((entry) => !vpath.contains(path, entry.mountPath)));
  }

  /** Just one source, by alias or mount id. Empty when there is no such source. */
  only(alias: string): GraphSpace {
    const entry = this.find(alias);
    return new GraphSpace(entry === undefined ? [] : [entry]);
  }

  /** Every source's schema, resolved together. */
  async schemas(): Promise<ReadonlyArray<{ entry: GraphSourceEntry; schema: GraphSchema }>> {
    return Promise.all(
      this.#entries.map(async (entry) => ({ entry, schema: await entry.source.schema() })),
    );
  }
}
