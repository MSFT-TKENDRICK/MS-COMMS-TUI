/**
 * Projections — rebuilding the tree with a GraphQL query.
 *
 * The premise of this program is that a directory tree is a good way to navigate
 * messages. The honest objection, which `query.ts` opens by conceding, is that any single
 * hierarchy is somebody's opinion: mail by folder, issues by repository, chats by team.
 * Saved queries answer half of it — a query is a directory — but a query still produces a
 * flat list, and some people think in structures rather than in filters.
 *
 * A projection answers the other half. It is a GraphQL query over every graph-mapped
 * source the user has, and its SELECTION SHAPE IS THE DIRECTORY SHAPE:
 *
 * ```graphql
 * {
 *   urgent: nodes(filter: "is:unread is:flagged", orderBy: "date desc") { name author }
 *   people: nodes(filter: "kind:file") @group(by: "author") @flatten { name mtime }
 * }
 * ```
 *
 * mounted at `/my`, gives `/my/urgent/…` and `/my/<author>/…`. The rules are three:
 *
 *   - a field that selects nodes becomes a directory named after it (its alias, if given);
 *   - each node it yields becomes an entry inside that directory;
 *   - scalar fields become attributes of the entry, so `stat`, sorting and `find` see them.
 *
 * `@flatten` removes the wrapper directory, `@group(by:)` inserts one, and `@name` decides
 * what an entry is called. That is the whole language.
 *
 * Three properties are deliberate and worth defending:
 *
 * LAZY. A projection is evaluated one directory at a time, as it is listed. Materializing
 * the whole result up front would mean `cd /my` downloading a mailbox, which is the exact
 * behaviour that made FUSE mail filesystems notorious.
 *
 * FALL-THROUGH. An entry with no further selection keeps its own children. So
 * `{ folders: mail_entries { name } }` is a re-rooting rather than a truncation: you can
 * still descend into a projected folder and find everything that was in it.
 *
 * BORROWED, NOT COPIED. A projected leaf holds the graph node it came from, so `cat`
 * reads the real document and `do` offers the real actions. A projection changes where
 * things appear and never what they are.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { VfsError } from './errors.js';
import {
  BUILTIN_NODE_FIELDS,
  GraphSpace,
  graphFieldText,
  graphFieldValue,
  type GraphEdgeDef,
  type GraphFieldValue,
  type GraphNode,
  type GraphSchema,
  type GraphSelection,
  type GraphSourceEntry,
  type GraphTypeDef,
} from './graph.js';
import {
  argsOf,
  findDirective,
  parseGraphQL,
  resolveVariables,
  responseName,
  valueOf,
  type GqlDocument,
  type GqlField,
  type GqlOperation,
  type GqlRuntimeValue,
  type GqlSelection,
} from './graphql.js';
import { NameAllocator } from './naming.js';
import type {
  ActionDescriptor,
  ActionResult,
  Capability,
  Document,
  ListOptions,
  ListPage,
  MetaValue,
  Provider,
  ProviderContext,
  ProviderPlugin,
  ReadOptions,
  SortField,
  SortSpec,
  VNode,
} from './provider.js';
import { evaluateQuery, parseQuery, type Query } from './query.js';

// ---------------------------------------------------------------------------
// Root fields
// ---------------------------------------------------------------------------

/** The cross-source entry point. Aliased as `all` because both readings are natural. */
export const UNIVERSAL_ROOTS = ['nodes', 'all'] as const;

const ROOT_ARGS = [
  { name: 'filter', type: 'String' as const, description: 'A query in the same language as `find`.' },
  { name: 'first', type: 'Int' as const, description: 'Maximum entries. Aliased as `limit`.' },
  { name: 'orderBy', type: 'String' as const, description: '`name`, `date`, `author` or `size`, plus `asc`/`desc`.' },
];

const UNIVERSAL_ARGS = [
  ...ROOT_ARGS,
  { name: 'source', type: 'String' as const, description: 'Restrict to one mount.' },
  { name: 'type', type: 'String' as const, description: 'Restrict to one node type.' },
];

// ---------------------------------------------------------------------------
// Schema printing
// ---------------------------------------------------------------------------

function describe(text: string | undefined, indent: string): string {
  if (text === undefined || text === '') return '';
  return `${indent}"""${text.replace(/"""/g, '\\"""')}"""\n`;
}

function printArgs(args: ReadonlyArray<{ name: string; type: string }>): string {
  if (args.length === 0) return '';
  return `(${args.map((arg) => `${arg.name}: ${arg.type}`).join(', ')})`;
}

/**
 * The projectable schema, as SDL.
 *
 * Printed rather than merely computed because a projection is written by hand, and the
 * only alternative to showing people the field names is making them guess. `mscomms
 * schema` prints this; it is the documentation that cannot go out of date.
 */
export async function printProjectionSchema(space: GraphSpace): Promise<string> {
  const resolved = await space.schemas();
  const lines: string[] = [];

  lines.push('"""');
  lines.push('Every mapped source, as one graph. Write a projection against these fields and');
  lines.push('mount it with { "type": "projection", "options": { "query": "..." } }.');
  lines.push('"""');
  lines.push('type Query {');

  lines.push(describe('Everything in every mapped source.', '  ').trimEnd());
  for (const root of UNIVERSAL_ROOTS) {
    lines.push(`  ${root}${printArgs(UNIVERSAL_ARGS)}: [Node!]!`);
  }

  for (const { entry, schema } of resolved) {
    lines.push('');
    lines.push(`  # ${entry.source.displayName} — mounted at ${entry.mountPath}`);
    for (const root of schema.roots) {
      const args = [...ROOT_ARGS, ...(root.args ?? [])];
      const type = `${entry.alias}_${root.type}`;
      const suffix = root.list === false ? type : `[${type}!]!`;
      const description = describe(root.description, '  ');
      if (description !== '') lines.push(description.trimEnd());
      lines.push(`  ${entry.alias}_${root.name}${printArgs(args)}: ${suffix}`);
    }
  }
  lines.push('}');

  lines.push('');
  lines.push('"""Fields every node has, whatever it is or where it came from."""');
  lines.push('interface Node {');
  for (const field of BUILTIN_NODE_FIELDS) {
    const description = describe(field.description, '  ');
    if (description !== '') lines.push(description.trimEnd());
    lines.push(`  ${field.name}: ${field.list === true ? `[${field.type}!]` : field.type}`);
  }
  lines.push('}');

  for (const { entry, schema } of resolved) {
    for (const type of schema.types) {
      lines.push('');
      const description = describe(type.description, '');
      if (description !== '') lines.push(description.trimEnd());
      lines.push(`type ${entry.alias}_${type.name} implements Node {`);
      for (const field of type.fields) {
        lines.push(`  ${field.name}: ${field.list === true ? `[${field.type}!]` : field.type}`);
      }
      for (const edge of type.edges) {
        const target = `${entry.alias}_${edge.target}`;
        const args = [...ROOT_ARGS, ...(edge.args ?? [])];
        const returns = edge.list === false ? target : `[${target}!]!`;
        const edgeDescription = describe(
          edge.name === type.childEdge
            ? `${edge.description ?? 'Related nodes.'} Followed by \`ls\` in the default tree.`
            : edge.description,
          '  ',
        );
        if (edgeDescription !== '') lines.push(edgeDescription.trimEnd());
        lines.push(`  ${edge.name}${printArgs(args)}: ${returns}`);
      }
      lines.push('}');
    }
  }

  lines.push('');
  lines.push('"""Directives that decide the shape of the projected tree."""');
  lines.push('directive @flatten on FIELD                       # splice entries into the parent directory');
  lines.push('directive @group(by: String!, name: String) on FIELD  # one directory per distinct value');
  lines.push('directive @name(field: String, template: String) on FIELD  # what an entry is called');
  lines.push('directive @sort(by: String!, order: String) on FIELD  # order entries by any field');
  lines.push('directive @as(kind: String!) on FIELD             # force `dir` or `file`');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function selectionFrom(
  args: Readonly<Record<string, GqlRuntimeValue>>,
  signal?: AbortSignal,
): GraphSelection {
  const filter = args['filter'] ?? args['where'] ?? args['q'];
  const first = args['first'] ?? args['limit'];
  const orderBy = args['orderBy'] ?? args['sort'];

  const selection: {
    limit?: number;
    query?: Query;
    sort?: SortSpec;
    args: Record<string, GqlRuntimeValue>;
    signal?: AbortSignal;
  } = { args: { ...args } };

  if (typeof filter === 'string' && filter.trim() !== '') selection.query = parseQuery(filter);
  if (typeof first === 'number' && Number.isFinite(first) && first > 0) selection.limit = Math.floor(first);
  if (typeof orderBy === 'string' && orderBy.trim() !== '') selection.sort = parseOrderBy(orderBy);
  if (signal !== undefined) selection.signal = signal;

  return selection as GraphSelection;
}

export function parseOrderBy(input: string): SortSpec {
  const parts = input.trim().split(/[\s,]+/);
  const rawField = (parts[0] ?? 'name').toLowerCase();
  const rawDirection = (parts[1] ?? 'asc').toLowerCase();
  const field: SortField =
    rawField === 'date' || rawField === 'mtime' || rawField === 'time'
      ? 'date'
      : rawField === 'author' || rawField === 'from'
        ? 'author'
        : rawField === 'size'
          ? 'size'
          : 'name';
  return { field, direction: rawDirection.startsWith('desc') ? 'desc' : 'asc' };
}

interface ResolvedRootField {
  readonly entry: GraphSourceEntry;
  readonly root: string;
}

/**
 * Work out which source (or sources) a root field names.
 *
 * Three spellings are accepted, in order: the universal `nodes`/`all`, the explicit
 * `<source>_<root>`, and the bare `<source>` meaning that source's universal root. The
 * shorthand exists because `{ mail { name } }` is what people try first, and a projection
 * language that rejects the obvious guess is one people stop using.
 */
async function resolveRootTargets(
  space: GraphSpace,
  fieldName: string,
  args: Readonly<Record<string, GqlRuntimeValue>>,
): Promise<readonly ResolvedRootField[]> {
  const universal = (UNIVERSAL_ROOTS as readonly string[]).includes(fieldName);

  if (universal) {
    const only = args['source'];
    const schemas = await space.schemas();
    const targets: ResolvedRootField[] = [];
    for (const { entry, schema } of schemas) {
      if (typeof only === 'string' && only !== entry.alias && only !== entry.mountId) continue;
      const root = schema.roots.find((candidate) => candidate.universal === true) ?? schema.roots[0];
      if (root !== undefined) targets.push({ entry, root: root.name });
    }
    if (targets.length === 0 && typeof only === 'string') {
      throw VfsError.invalid(
        `No mapped source is called "${only}".`,
        'Run `mounts` for the list, or `schema` for the names a projection can use.',
      );
    }
    return targets;
  }

  const direct = space.find(fieldName);
  if (direct !== undefined) {
    const schema = await direct.source.schema();
    const root = schema.roots.find((candidate) => candidate.universal === true) ?? schema.roots[0];
    if (root === undefined) {
      throw VfsError.invalid(`The source "${fieldName}" declares no entry points.`);
    }
    return [{ entry: direct, root: root.name }];
  }

  for (const entry of space.entries) {
    if (!fieldName.startsWith(`${entry.alias}_`)) continue;
    const rootName = fieldName.slice(entry.alias.length + 1);
    const schema = await entry.source.schema();
    if (schema.roots.some((candidate) => candidate.name === rootName)) {
      return [{ entry, root: rootName }];
    }
  }

  const known = [
    ...UNIVERSAL_ROOTS,
    ...space.entries.map((entry) => entry.alias),
  ].join(', ');
  throw VfsError.invalid(
    `"${fieldName}" is not something a projection can select at the top level.`,
    `Available: ${known}. Run \`schema\` for the full list.`,
  );
}

/**
 * The nodes a field yields.
 *
 * Root fields fan out across sources; everything else follows an edge from the node it
 * was selected on. A source that does not have the requested edge is skipped rather than
 * fatal — a projection written against a mailbox should still work when the user also
 * mounts an RSS feed that has never heard of `thread`.
 */
export async function resolveProjectionField(
  space: GraphSpace,
  field: GqlField,
  variables: Readonly<Record<string, GqlRuntimeValue>>,
  parent: GraphNode | null,
  options: { signal?: AbortSignal; defaultLimit?: number } = {},
): Promise<readonly GraphNode[]> {
  const args = argsOf(field.args, variables);
  const selection = selectionFrom(args, options.signal);
  const limited: GraphSelection =
    selection.limit === undefined && options.defaultLimit !== undefined
      ? { ...selection, limit: options.defaultLimit }
      : selection;

  if (parent === null) {
    const targets = await resolveRootTargets(space, field.name, args);
    const typeFilter = args['type'];
    const out: GraphNode[] = [];
    for (const target of targets) {
      const nodes = await target.entry.source.roots(target.root, limited);
      for (const node of nodes) {
        if (typeof typeFilter === 'string' && node.type !== typeFilter) continue;
        out.push(node);
      }
    }
    return applyLocalFilter(out, limited);
  }

  const entry = space.find(parent.source);
  if (entry === undefined) return [];
  const schema = await entry.source.schema();
  const type = schema.types.find((candidate) => candidate.name === parent.type);
  const edge = type?.edges.find((candidate) => candidate.name === field.name);
  if (edge === undefined) {
    if (isScalarField(field.name, type)) return [];
    throw VfsError.invalid(
      `"${field.name}" is not an edge of ${parent.type} in the source "${entry.alias}".`,
      type === undefined
        ? 'Run `schema` to see what each source exposes.'
        : `Edges of ${type.name}: ${type.edges.map((e) => e.name).join(', ') || '(none)'}.`,
    );
  }
  const nodes = await entry.source.neighbors(parent, edge.name, limited);
  return applyLocalFilter(nodes, limited);
}

function isScalarField(name: string, type: GraphTypeDef | undefined): boolean {
  if (type === undefined) return false;
  return type.fields.some((field) => field.name === name);
}

/**
 * Re-apply the filter locally.
 *
 * The same trust boundary the VFS applies to `list`: a source may have pushed the query
 * down and may have got it wrong, so the engine checks. Filtering twice is cheap;
 * silently dropping a message is not.
 */
function applyLocalFilter(nodes: readonly GraphNode[], selection: GraphSelection): readonly GraphNode[] {
  let out = nodes;
  if (selection.query !== undefined) {
    out = out.filter((node) => evaluateQuery(selection.query as Query, node.node) !== false);
  }
  if (selection.sort !== undefined) out = sortGraphNodes(out, selection.sort.field, selection.sort.direction);
  if (selection.limit !== undefined) out = out.slice(0, selection.limit);
  return out;
}

function compareValues(a: GraphFieldValue | undefined, b: GraphFieldValue | undefined): number {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : 0;
    const bt = b instanceof Date ? b.getTime() : 0;
    return at - bt;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return graphFieldText(a).localeCompare(graphFieldText(b));
}

export function sortGraphNodes(
  nodes: readonly GraphNode[],
  field: string,
  direction: 'asc' | 'desc',
): readonly GraphNode[] {
  const key = field === 'date' ? 'mtime' : field;
  const sign = direction === 'desc' ? -1 : 1;
  return [...nodes].sort(
    (a, b) => sign * compareValues(graphFieldValue(a, key), graphFieldValue(b, key)),
  );
}

/**
 * Flatten a graph field into something that can live in a node's `meta`.
 *
 * `meta` is deliberately scalar-only — it is what `ls -l` columns and the query language
 * read from, and both want a value they can compare and print without a schema. A list
 * field is joined rather than dropped, because "labels: bug, p1" is what a user wanted to
 * see when they selected it.
 */
function scalarAttribute(value: GraphFieldValue): MetaValue {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return (value as readonly MetaValue[]).map(graphFieldText).join(', ');
  return value as MetaValue;
}

// ---------------------------------------------------------------------------
// Eager execution, for `graphql` and for validating a projection
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  readonly variables?: Readonly<Record<string, GqlRuntimeValue>>;
  readonly operationName?: string;
  readonly defaultLimit?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function pickOperation(document: GqlDocument, name?: string): GqlOperation {
  if (name !== undefined) {
    const found = document.operations.find((operation) => operation.name === name);
    if (found === undefined) {
      throw VfsError.invalid(
        `This projection has no operation called "${name}".`,
        `It defines: ${document.operations.map((o) => o.name ?? '(anonymous)').join(', ')}.`,
      );
    }
    return found;
  }
  if (document.operations.length > 1) {
    throw VfsError.invalid(
      'This projection defines more than one operation, so one has to be named.',
      `Pass --operation with one of: ${document.operations.map((o) => o.name ?? '(anonymous)').join(', ')}.`,
    );
  }
  return document.operations[0] as GqlOperation;
}

/** Expand fragment spreads into plain fields, so everything downstream sees one shape. */
export function expandSelections(
  selections: readonly GqlSelection[],
  document: GqlDocument,
  typeName?: string,
  seen: ReadonlySet<string> = new Set(),
): readonly GqlField[] {
  const out: GqlField[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
      continue;
    }
    if (selection.kind === 'inline') {
      if (matchesCondition(selection.typeCondition, typeName)) {
        out.push(...expandSelections(selection.selections, document, typeName, seen));
      }
      continue;
    }
    if (seen.has(selection.name)) {
      throw VfsError.invalid(
        `The fragment "${selection.name}" includes itself.`,
        'Fragments cannot be recursive.',
      );
    }
    const fragment = document.fragments.get(selection.name);
    if (fragment === undefined) {
      throw VfsError.invalid(
        `This projection uses the fragment "${selection.name}", which is never defined.`,
      );
    }
    if (!matchesCondition(fragment.typeCondition, typeName)) continue;
    out.push(
      ...expandSelections(fragment.selections, document, typeName, new Set([...seen, selection.name])),
    );
  }
  return out;
}

function matchesCondition(condition: string | undefined, typeName: string | undefined): boolean {
  // `Node` is the interface every node implements, so it always matches. Unknown
  // conditions match too: a projection spanning several sources cannot be expected to
  // name a type that only one of them has, and skipping would silently drop entries.
  if (condition === undefined || typeName === undefined) return true;
  if (condition === 'Node') return true;
  return condition === typeName || typeName.endsWith(`_${condition}`);
}

/**
 * Drop the source's own location from a node the projection is about to re-home.
 *
 * `path` and `parentPath` answer "where does this live", and inside a projection the
 * answer is "wherever the query put it" — not where the source keeps it. Carrying the
 * original through is not merely untidy: the engine prefers a hit's `path` when resolving
 * search results, so a `find` over `/by-person` would hand back `/mail/Archive/...` and the
 * tree the user built could not be navigated from its own results. The original is still
 * available, as `meta.origin`, which is where a "where did this come from" answer belongs.
 */
function withoutLocation(node: VNode): VNode {
  const { path: _path, parentPath: _parentPath, ...rest } = node;
  return rest;
}

/** Run a projection eagerly and return plain JSON. Used by the `graphql` command. */
export async function executeProjection(
  space: GraphSpace,
  source: string | GqlDocument,
  options: ExecuteOptions = {},
): Promise<JsonValue> {
  const document = typeof source === 'string' ? parseGraphQL(source) : source;
  const operation = pickOperation(document, options.operationName);
  const variables = resolveVariables(operation, options.variables ?? {});
  const defaultLimit = options.defaultLimit ?? 25;
  const maxDepth = options.maxDepth ?? 5;

  const walk = async (
    fields: readonly GqlField[],
    parent: GraphNode | null,
    depth: number,
  ): Promise<Record<string, JsonValue>> => {
    const out: Record<string, JsonValue> = {};
    for (const field of fields) {
      if (field.name === '__typename') {
        out[responseName(field)] = parent === null ? 'Query' : `${parent.source}_${parent.type}`;
        continue;
      }
      if (field.selections.length === 0 && parent !== null) {
        out[responseName(field)] = toJson(graphFieldValue(parent, field.name));
        continue;
      }
      if (depth >= maxDepth) {
        out[responseName(field)] = [];
        continue;
      }
      const nodes = await resolveProjectionField(space, field, variables, parent, {
        defaultLimit,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const rows: JsonValue[] = [];
      for (const node of nodes) {
        rows.push(
          await walk(
            expandSelections(field.selections, document, `${node.source}_${node.type}`),
            node,
            depth + 1,
          ),
        );
      }
      out[responseName(field)] = rows;
    }
    return out;
  };

  return walk(expandSelections(operation.selections, document), null, 0);
}

function toJson(value: GraphFieldValue | undefined): JsonValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => toJson(entry as GraphFieldValue));
  return value as JsonValue;
}

// ---------------------------------------------------------------------------
// Lazy materialization: frames
// ---------------------------------------------------------------------------

type Frame =
  | { readonly kind: 'root'; readonly id: string }
  | {
      readonly kind: 'field';
      readonly id: string;
      readonly field: GqlField;
      readonly parent: GraphNode | null;
    }
  | {
      readonly kind: 'group';
      readonly id: string;
      readonly field: GqlField;
      readonly parent: GraphNode | null;
      readonly value: string;
    }
  | {
      readonly kind: 'entity';
      readonly id: string;
      readonly field: GqlField;
      readonly entity: GraphNode;
    }
  | { readonly kind: 'passthrough'; readonly id: string; readonly entity: GraphNode };

interface ProjectedEntry {
  readonly frame: Frame;
  readonly node: VNode;
}

const MAX_FRAMES = 5_000;

function entityToken(node: GraphNode): string {
  return `${encodeURIComponent(node.source)}~${encodeURIComponent(node.type)}~${encodeURIComponent(node.key)}`;
}

function parseEntityToken(token: string): { source: string; type: string; key: string } | undefined {
  const parts = token.split('~');
  if (parts.length !== 3) return undefined;
  return {
    source: decodeURIComponent(parts[0] as string),
    type: decodeURIComponent(parts[1] as string),
    key: decodeURIComponent(parts[2] as string),
  };
}

/** Fields that produce entries rather than attributes. A selection set is the tell. */
function nodeFields(field: GqlField, document: GqlDocument, typeName: string): readonly GqlField[] {
  return expandSelections(field.selections, document, typeName).filter(
    (candidate) => candidate.selections.length > 0,
  );
}

function scalarFields(field: GqlField, document: GqlDocument, typeName: string): readonly GqlField[] {
  return expandSelections(field.selections, document, typeName).filter(
    (candidate) => candidate.selections.length === 0 && candidate.name !== '__typename',
  );
}

function applyTemplate(template: string, entity: GraphNode): string {
  return template.replace(/\{([_A-Za-z][_0-9A-Za-z]*)\}/g, (_match, key: string) =>
    graphFieldText(graphFieldValue(entity, key)),
  );
}

// ---------------------------------------------------------------------------
// The projection provider
// ---------------------------------------------------------------------------

export interface ProjectionOptions {
  /** The projection itself, as GraphQL. */
  readonly query?: string;
  /** Path to a file containing the projection, resolved by the caller. */
  readonly queryFile?: string;
  readonly operation?: string;
  readonly variables?: Readonly<Record<string, GqlRuntimeValue>>;
  /** Entries fetched per field when the query does not say. */
  readonly defaultLimit?: number;
}

export interface ProjectionProviderOptions extends ProjectionOptions {
  /** The live graph space. Called per operation so a mount added later is included. */
  readonly space: () => GraphSpace | Promise<GraphSpace>;
  readonly mountPath: string;
}

/**
 * A mount whose contents are a GraphQL view of the other mounts.
 *
 * It lives in `core` rather than in a `provider-*` package because it is not an
 * integration: it talks to no backend, and its whole substance is the engine's own graph
 * space. Shipping it as a provider anyway is what makes a re-organized tree an ordinary
 * mount — cached, searchable, watchable, completable, and indistinguishable from a real
 * one at the point of use.
 */
export class ProjectionProvider implements Provider {
  readonly id = 'projection';
  readonly displayName = 'GraphQL projection';
  /** A projection re-presents other mounts; it is not a source of its own. See `Provider`. */
  readonly derived = true;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'list',
    'read',
    'search',
    'actions',
  ]);

  readonly #document: GqlDocument;
  readonly #operation: GqlOperation;
  readonly #variables: Record<string, GqlRuntimeValue>;
  readonly #options: ProjectionProviderOptions;
  readonly #frames = new Map<string, Frame>();

  constructor(options: ProjectionProviderOptions) {
    const source = options.query;
    if (source === undefined || source.trim() === '') {
      throw VfsError.config(
        'A projection mount needs a query.',
        'Set "query" (or "queryFile") in the mount options. Run `schema` to see what you can select.',
      );
    }
    this.#options = options;
    this.#document = parseGraphQL(source);
    this.#operation = pickOperation(this.#document, options.operation);
    this.#variables = resolveVariables(this.#operation, options.variables ?? {});
    this.#frames.set('', { kind: 'root', id: '' });
  }

  // -------------------------------------------------------------------------
  // Provider surface
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const frame = parent === null ? ({ kind: 'root', id: '' } as Frame) : await this.#frameFor(parent);
    const entries = await this.#childrenOf(frame, options.signal);
    const limit = options.limit ?? entries.length;
    return {
      entries: entries.slice(0, limit).map((entry) => entry.node),
      ...(entries.length > limit ? { total: entries.length } : {}),
    };
  }

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    const { entry, entity } = await this.#entityFor(node);
    if (entry.source.read === undefined) {
      throw VfsError.unsupported('Reading', entry.source.id);
    }
    return entry.source.read(entity, options);
  }

  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    try {
      const { entry, entity } = await this.#entityFor(node);
      return (await entry.source.actions?.(entity)) ?? [];
    } catch {
      // A directory the projection invented has no underlying node, and offering an empty
      // action list is the honest answer rather than an error the user cannot act on.
      return [];
    }
  }

  async invoke(
    action: string,
    node: VNode,
    params: Readonly<Record<string, MetaValue>>,
  ): Promise<ActionResult> {
    const { entry, entity } = await this.#entityFor(node);
    if (entry.source.invoke === undefined) {
      throw VfsError.unsupported('Actions', entry.source.id);
    }
    const result = await entry.source.invoke(action, entity, params);
    // The underlying path is invalidated by the source's own mount; the projected copy
    // has a different path and has to be named separately or it goes stale on screen.
    const projected = node.path;
    if (projected === undefined) return result;
    return {
      ...result,
      invalidates: [...(result.invalidates ?? []), projected],
    };
  }

  /**
   * Search the projected tree.
   *
   * Bounded by node count and depth rather than exhaustive: a projection can span every
   * mount the user has, and an unbounded walk of that is a hang. The bound is generous
   * and the result is honest about being a page, which is the same bargain `list` makes.
   */
  async search(parent: VNode | null, query: Query, options: ListOptions): Promise<ListPage> {
    const limit = options.limit ?? 200;
    const start = parent === null ? ({ kind: 'root', id: '' } as Frame) : await this.#frameFor(parent);
    const out: VNode[] = [];
    const queue: Array<{ frame: Frame; path: string; depth: number }> = [
      { frame: start, path: '', depth: 0 },
    ];

    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift();
      if (current === undefined) break;
      if (current.depth > 6) continue;

      let entries: readonly ProjectedEntry[];
      try {
        entries = await this.#childrenOf(current.frame, options.signal);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (evaluateQuery(query, entry.node) !== false) {
          // Always report a location, including `''` for a hit at the mount root. A hit
          // with neither `path` nor `parentPath` is assumed to sit directly under the
          // search root, which for a nested hit means it opens with ENOENT.
          out.push({ ...entry.node, parentPath: current.path });
          if (out.length >= limit) break;
        }
        if (entry.node.kind === 'dir') {
          queue.push({
            frame: entry.frame,
            path: current.path === '' ? entry.node.name : `${current.path}/${entry.node.name}`,
            depth: current.depth + 1,
          });
        }
      }
    }

    return { entries: out };
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  async #space(): Promise<GraphSpace> {
    return this.#options.space();
  }

  #remember(frame: Frame): Frame {
    if (!this.#frames.has(frame.id) && this.#frames.size >= MAX_FRAMES) {
      const oldest = this.#frames.keys().next();
      if (oldest.done !== true && oldest.value !== '') this.#frames.delete(oldest.value);
    }
    this.#frames.set(frame.id, frame);
    return frame;
  }

  /**
   * Recover the frame a node stands for.
   *
   * Frames are cached because the engine lists a directory immediately before touching
   * anything in it, so the cache hits in practice. The rebuild path is what makes a cold
   * `cat /my/urgent/3` work anyway: frame ids are hierarchical, so the projection is
   * re-evaluated level by level until the id matches. Slower, never wrong.
   */
  async #frameFor(node: VNode): Promise<Frame> {
    const cached = this.#frames.get(node.id);
    if (cached !== undefined) return cached;

    const segments = node.id.split('/').filter((segment) => segment !== '');
    let frame: Frame = { kind: 'root', id: '' };
    let id = '';
    for (const segment of segments) {
      id = `${id}/${segment}`;
      const children = await this.#childrenOf(frame);
      const match = children.find((child) => child.frame.id === id);
      if (match === undefined) {
        throw VfsError.notFound(node.path ?? node.name, 'The projection no longer produces that entry.');
      }
      frame = match.frame;
    }
    return frame;
  }

  async #entityFor(node: VNode): Promise<{ entry: GraphSourceEntry; entity: GraphNode }> {
    const frame = await this.#frameFor(node);
    if (frame.kind !== 'entity' && frame.kind !== 'passthrough') {
      throw VfsError.isDirectory(node.path ?? node.name);
    }
    const space = await this.#space();
    const entry = space.find(frame.entity.source);
    if (entry === undefined) {
      throw VfsError.notFound(
        node.path ?? node.name,
        `The mount "${frame.entity.source}" this entry came from is no longer available.`,
      );
    }
    return { entry, entity: frame.entity };
  }

  // -------------------------------------------------------------------------
  // Children of a frame — the whole projection semantics, in one place
  // -------------------------------------------------------------------------

  async #childrenOf(frame: Frame, signal?: AbortSignal): Promise<readonly ProjectedEntry[]> {
    switch (frame.kind) {
      case 'root':
        return this.#fromFields(
          expandSelections(this.#operation.selections, this.#document),
          null,
          frame.id,
          signal,
        );

      case 'field':
        return this.#fromField(frame, undefined, signal);

      case 'group':
        return this.#fromField(
          { kind: 'field', id: frame.id, field: frame.field, parent: frame.parent },
          frame.value,
          signal,
        );

      case 'entity': {
        const typeName = `${frame.entity.source}_${frame.entity.type}`;
        const children = nodeFields(frame.field, this.#document, typeName);
        if (children.length > 0) {
          return this.#fromFields(children, frame.entity, frame.id, signal);
        }
        return this.#passthrough(frame.entity, frame.id, signal);
      }

      case 'passthrough':
        return this.#passthrough(frame.entity, frame.id, signal);

      default:
        return [];
    }
  }

  /** Turn a list of selected fields into directory entries, honouring `@flatten`. */
  async #fromFields(
    fields: readonly GqlField[],
    parent: GraphNode | null,
    parentId: string,
    signal?: AbortSignal,
  ): Promise<readonly ProjectedEntry[]> {
    const allocator = new NameAllocator();
    const out: ProjectedEntry[] = [];

    for (const field of fields) {
      if (field.selections.length === 0) continue;
      const id = `${parentId}/f:${encodeURIComponent(responseName(field))}`;
      const frame = this.#remember({ kind: 'field', id, field, parent });

      if (findDirective(field.directives, 'flatten') !== undefined) {
        for (const entry of await this.#childrenOf(frame, signal)) {
          out.push({ ...entry, node: { ...entry.node, name: allocator.allocate(entry.node.name) } });
        }
        continue;
      }

      out.push({
        frame,
        node: {
          name: allocator.allocate(responseName(field)),
          kind: 'dir',
          title: responseName(field),
          id,
          subtype: 'projection',
          meta: { projection: field.name },
        },
      });
    }
    return out;
  }

  /** The entries of one selected field: its nodes, or the group directories over them. */
  async #fromField(
    frame: Extract<Frame, { kind: 'field' }>,
    groupValue: string | undefined,
    signal?: AbortSignal,
  ): Promise<readonly ProjectedEntry[]> {
    const space = await this.#space();
    const nodes = await resolveProjectionField(space, frame.field, this.#variables, frame.parent, {
      defaultLimit: this.#options.defaultLimit ?? 200,
      ...(signal === undefined ? {} : { signal }),
    });

    const sorted = this.#applySort(frame.field, nodes);
    const group = findDirective(frame.field.directives, 'group');

    if (group !== undefined && groupValue === undefined) {
      const by = argsOf(group.args, this.#variables)['by'];
      if (typeof by !== 'string' || by === '') {
        throw VfsError.invalid(
          '@group needs a field to group by, as in @group(by: "author").',
          'Run `schema` to see which fields a node has.',
        );
      }
      const nameTemplate = argsOf(group.args, this.#variables)['name'];
      const allocator = new NameAllocator();
      const seen = new Map<string, number>();
      for (const node of sorted) {
        const key = graphFieldText(graphFieldValue(node, by)) || '(none)';
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen.entries()].map(([key, count]) => {
        const id = `${frame.id}/g:${encodeURIComponent(key)}`;
        const label = typeof nameTemplate === 'string' ? nameTemplate.replace(/\{value\}/g, key) : key;
        return {
          frame: this.#remember({ kind: 'group', id, field: frame.field, parent: frame.parent, value: key }),
          node: {
            name: allocator.allocate(label, { fallback: 'none' }),
            kind: 'dir' as const,
            title: label,
            id,
            subtype: 'group',
            childCount: count,
            meta: { groupedBy: by, value: key },
          },
        };
      });
    }

    const selected =
      groupValue === undefined
        ? sorted
        : sorted.filter((node) => {
            const by = argsOf(group?.args ?? [], this.#variables)['by'];
            const key = typeof by === 'string' ? graphFieldText(graphFieldValue(node, by)) || '(none)' : '';
            return key === groupValue;
          });

    return this.#toEntries(frame.field, selected, frame.id);
  }

  #applySort(field: GqlField, nodes: readonly GraphNode[]): readonly GraphNode[] {
    const sort = findDirective(field.directives, 'sort');
    if (sort === undefined) return nodes;
    const args = argsOf(sort.args, this.#variables);
    const by = args['by'];
    if (typeof by !== 'string' || by === '') {
      throw VfsError.invalid('@sort needs a field, as in @sort(by: "mtime", order: "desc").');
    }
    const order = args['order'];
    return sortGraphNodes(nodes, by, order === 'desc' || order === 'descending' ? 'desc' : 'asc');
  }

  /** Nodes to entries: naming, kind, and the attributes the selection asked for. */
  #toEntries(
    field: GqlField,
    nodes: readonly GraphNode[],
    parentId: string,
  ): readonly ProjectedEntry[] {
    const allocator = new NameAllocator();
    const nameDirective = findDirective(field.directives, 'name');
    const nameArgs = nameDirective === undefined ? {} : argsOf(nameDirective.args, this.#variables);
    const forced = findDirective(field.directives, 'as');
    const forcedKind = forced === undefined ? undefined : argsOf(forced.args, this.#variables)['kind'];

    return nodes.map((entity) => {
      const typeName = `${entity.source}_${entity.type}`;
      const children = nodeFields(field, this.#document, typeName);
      const kind =
        forcedKind === 'dir' || forcedKind === 'file'
          ? forcedKind
          : children.length > 0
            ? 'dir'
            : entity.node.kind;

      const base =
        typeof nameArgs['template'] === 'string'
          ? applyTemplate(nameArgs['template'], entity)
          : typeof nameArgs['field'] === 'string'
            ? graphFieldText(graphFieldValue(entity, nameArgs['field']))
            : entity.node.name;

      const id = `${parentId}/e:${entityToken(entity)}`;
      const attributes: Record<string, MetaValue> = { ...(entity.node.meta ?? {}) };
      for (const scalar of scalarFields(field, this.#document, typeName)) {
        const value = graphFieldValue(entity, scalar.name);
        if (value === undefined) continue;
        attributes[responseName(scalar)] = scalarAttribute(value);
      }
      attributes['source'] = entity.source;
      if (entity.node.path !== undefined) attributes['origin'] = entity.node.path;

      return {
        frame: this.#remember({ kind: 'entity', id, field, entity }),
        node: {
          ...withoutLocation(entity.node),
          name: allocator.allocate(base === '' ? entity.node.name : base, { fallback: entity.key }),
          kind,
          id,
          meta: attributes,
        },
      };
    });
  }

  /**
   * Children of an entry the projection stopped describing.
   *
   * This is the fall-through rule: an entry with no further selection keeps whatever the
   * owning source says its children are. Without it, `{ folders: mail_entries { name } }`
   * would show folders that cannot be opened, which is a worse answer than not projecting
   * at all — it looks like the mail has gone.
   */
  async #passthrough(
    entity: GraphNode,
    parentId: string,
    signal?: AbortSignal,
  ): Promise<readonly ProjectedEntry[]> {
    if (entity.node.kind !== 'dir') return [];
    const space = await this.#space();
    const entry = space.find(entity.source);
    if (entry === undefined) return [];

    const schema: GraphSchema = await entry.source.schema();
    const type = schema.types.find((candidate) => candidate.name === entity.type);
    const edge: GraphEdgeDef | undefined =
      type?.edges.find((candidate) => candidate.name === type.childEdge) ??
      type?.edges.find((candidate) => candidate.name === 'children');
    if (edge === undefined) return [];

    const children = await entry.source.neighbors(entity, edge.name, {
      limit: this.#options.defaultLimit ?? 200,
      ...(signal === undefined ? {} : { signal }),
    });

    const allocator = new NameAllocator();
    return children.map((child) => {
      const id = `${parentId}/p:${entityToken(child)}`;
      return {
        frame: this.#remember({ kind: 'passthrough', id, entity: child }),
        node: {
          ...withoutLocation(child.node),
          name: allocator.allocate(child.node.name),
          id,
          meta: { ...(child.node.meta ?? {}), source: child.source, ...(child.node.path === undefined ? {} : { origin: child.node.path }) },
        },
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function readVariables(raw: unknown): Record<string, GqlRuntimeValue> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw VfsError.config(
      '"variables" in a projection mount must be an object.',
      'For example: "variables": { "days": 7 }.',
    );
  }
  return raw as Record<string, GqlRuntimeValue>;
}

/**
 * The `projection` mount type.
 *
 * `create` needs the engine's graph space, which arrives through `ProviderContext.graph`.
 * That handle is a function rather than a value on purpose: mounts are built in config
 * order, so a projection constructed second must not capture a half-built mount table. It
 * asks for the space when a directory is listed, by which point everything is up.
 */
export const projectionPlugin: ProviderPlugin<ProjectionOptions> = {
  type: 'projection',
  displayName: 'GraphQL projection',
  description:
    'A tree built by a GraphQL query over your other mounts. Reorganize anything without moving it.',
  validateOptions(raw) {
    const options = (raw ?? {}) as Record<string, unknown>;
    const query = options['query'];
    const queryFile = options['queryFile'];
    if (typeof query !== 'string' && typeof queryFile !== 'string') {
      throw VfsError.config(
        'A projection mount needs "query" or "queryFile".',
        'Run `schema` to see what a projection can select, and `docs/PROJECTIONS.md` for examples.',
      );
    }
    if (typeof query === 'string') {
      // Parse at startup so a typo is reported when the config loads, naming the line,
      // rather than as a mysterious empty directory the first time someone lists it.
      parseGraphQL(query);
    }
    const variables = readVariables(options['variables']);
    return {
      ...(typeof query === 'string' ? { query } : {}),
      ...(typeof queryFile === 'string' ? { queryFile } : {}),
      ...(typeof options['operation'] === 'string' ? { operation: options['operation'] } : {}),
      ...(variables === undefined ? {} : { variables }),
      ...(typeof options['defaultLimit'] === 'number' ? { defaultLimit: options['defaultLimit'] } : {}),
    };
  },
  async create(options, context) {
    if (context.graph === undefined) {
      throw VfsError.config(
        'This host does not expose a graph space, so projections cannot run here.',
        'Projections need the engine to pass `graph` in the provider context.',
      );
    }
    const space = context.graph;
    // A query long enough to be worth writing lives better in its own `.graphql` file than
    // escaped into JSON, so `queryFile` is read here — relative to the config directory, so
    // a config and the projections it references move together.
    const query = options.query ?? (await readQueryFile(options.queryFile, context.configDir));
    return new ProjectionProvider({
      ...options,
      query,
      mountPath: context.mountPath,
      // A projection must not see itself, or "everything, everywhere" includes the tree
      // being built and the walk never terminates.
      space: async () => (await space()).without(context.mountPath),
    });
  },
};

async function readQueryFile(file: string | undefined, configDir?: string): Promise<string> {
  if (file === undefined) {
    throw VfsError.config(
      'A projection mount needs "query" or "queryFile".',
      'Run `schema` to see what a projection can select.',
    );
  }
  const resolved = isAbsolute(file) ? file : resolvePath(configDir ?? process.cwd(), file);
  try {
    return await readFile(resolved, 'utf8');
  } catch {
    throw VfsError.config(
      `Could not read the projection file "${resolved}".`,
      'Paths in "queryFile" resolve against the directory the config was loaded from.',
    );
  }
}
