/**
 * @mscomms/core — the provider-agnostic engine.
 *
 * Everything exported here is the stable surface a provider plugin or a frontend builds
 * against. See docs/PLUGINS.md for how to write a provider.
 */

export * as vpath from './vpath.js';

export {
  sanitizeSegment,
  collisionKey,
  inferExtension,
  truncateBytes,
  byteLength,
  timestampPrefix,
  NameAllocator,
  DEFAULT_MAX_BYTES,
  type SanitizeOptions,
} from './naming.js';

export {
  VfsError,
  isVfsError,
  toVfsError,
  type VfsErrorCode,
} from './errors.js';

export {
  FLAGS,
  CAPABILITIES,
  type ActionDescriptor,
  type ActionParam,
  type ActionParamType,
  type ActionResult,
  type AttachmentRef,
  type BodyFormat,
  type Capability,
  type ChangeEvent,
  type ChangeType,
  type Document,
  type ListOptions,
  type ListPage,
  type Logger,
  type MetaValue,
  type NodeKind,
  type PollOptions,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type ProviderPluginModule,
  type ReadOptions,
  type SortDirection,
  type SortField,
  type SortSpec,
  type StateStore,
  type UndoSpec,
  type VNode,
  type WellKnownFlag,
} from './provider.js';

// ---------------------------------------------------------------------------
// Interactions
//
// Every interaction is a value with a name, a command line and a stated inverse. That
// single decision is what makes the program undoable, voice-drivable and consistent
// between its two interfaces — see journal.ts for why those are the same problem.
// ---------------------------------------------------------------------------

export {
  ChangeBus,
  Journal,
  reversalFor,
  type JournalEntry,
  type JournalKind,
  type JournalOptions,
  type JournalStep,
  type JournalTarget,
  type RecordInput,
  type RedoStep,
  type Reversal,
  type SessionEvent,
  type SessionListener,
} from './journal.js';

export {
  parseQuery,
  tokenizeQuery,
  stringifyQuery,
  evaluateQuery,
  scoreQuery,
  queryFields,
  requiresContent,
  isMatchAll,
  parseDateValue,
  parseDateBoundEnd,
  parseSizeValue,
  MATCH_ALL,
  CONTENT_FIELDS,
  QUERY_FIELD_HELP,
  QUERY_SYNTAX_HELP,
  type AndQuery,
  type CompareOp,
  type EvaluateContext,
  type MatchAllQuery,
  type MatchModifiers,
  type NotQuery,
  type OrQuery,
  type Query,
  type TermQuery,
  type TextQuery,
  type Trilean,
} from './query.js';

export {
  ActionRegistry,
  metaNumber,
  metaText,
  optionalFlag,
  optionalText,
  requiredText,
  resolveParams,
  type ActionCommand,
  type ActionInvocation,
  type ActionParams,
} from './actions.js';

export { TtlCache, type CacheEntry, type CacheOptions, type CacheStats } from './cache.js';

// ---------------------------------------------------------------------------
// Local snapshot: background sync, cache-ahead, and offline search
// ---------------------------------------------------------------------------

export {
  openSqlDriver,
  type SqlDriver,
  type SqlDriverKind,
  type SqlDriverOptions,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from './sql.js';

export {
  DEFAULT_DIMENSIONS,
  cosineSimilarity,
  decodeVector,
  embeddableText,
  encodeVector,
  hashEmbed,
  hashEmbedder,
  vectorLiteral,
  type Embedder,
} from './vector.js';

export {
  SnapshotStore,
  DEFAULT_RECENT,
  type SnapshotHit,
  type SnapshotListing,
  type SnapshotOptions,
  type SnapshotSearchOptions,
  type SnapshotStats,
} from './snapshot.js';

export {
  NavigationPredictor,
  PREFETCH_PRIORITY,
  PrefetchQueue,
  type PredictedTarget,
  type PredictorOptions,
  type PrefetchQueueOptions,
  type PrefetchStats,
  type PrefetchTask,
} from './prefetch.js';

export {
  BackgroundSync,
  type BackgroundSyncOptions,
  type SyncHost,
  type SyncMount,
  type SyncStatus,
} from './sync.js';

export {
  ConsoleLogger,
  MemoryStateStore,
  FileStateStore,
  NULL_LOGGER,
  stateFileFor,
  type LogLevel,
  type LoggerOptions,
} from './logging.js';

export {
  Vfs,
  rankHits,
  sortNodes,
  type Mount,
  type PrefetchOptions,
  type SearchOptions,
  type SearchSourceReport,
  type VfsListResult,
  type VfsOptions,
  type VfsTarget,
} from './vfs.js';

export {
  Notifier,
  escapeXml,
  WINDOWS_POWERSHELL_AUMID,
  type Notification,
  type NotificationInput,
  type NotificationUrgency,
  type NotifierOptions,
} from './notify.js';

export {
  Watcher,
  type WatcherOptions,
  type WatchSpec,
  type WatchStatus,
} from './watcher.js';

export {
  DEFAULT_CONFIG,
  isSecretRef,
  loadConfig,
  parseJsonc,
  resolveAppPaths,
  resolveSecret,
  stripJsonc,
  validateConfig,
  type AppConfig,
  type AppPaths,
  type CacheConfig,
  type MountConfig,
  type NotificationConfig,
  type SavedQueryConfig,
  type UiConfig,
  type VoiceConfig,
  type WatchConfig,
} from './config.js';

export {
  PluginRegistry,
  buildFromConfig,
  buildMounts,
  editDistance,
  type BuiltMount,
  type MountBuilderOptions,
} from './registry.js';

// ---------------------------------------------------------------------------
// Graph model, mapping surface, and projections
//
// The tree is one view of the data, not the data. These four modules are what make
// that true: a graph model, a declarative way to map an integration onto it, a query
// parser, and an engine that turns a query back into a tree.
// ---------------------------------------------------------------------------

export {
  BUILTIN_NODE_FIELDS,
  GraphSpace,
  graphFieldText,
  graphFieldValue,
  isBuiltinNodeField,
  safeGraphName,
  treeGraphSource,
  type GraphArgDef,
  type GraphArgValue,
  type GraphEdgeDef,
  type GraphFieldDef,
  type GraphFieldValue,
  type GraphNode,
  type GraphRootDef,
  type GraphScalar,
  type GraphSchema,
  type GraphSelection,
  type GraphSource,
  type GraphSourceEntry,
  type GraphTreeHost,
  type GraphTypeDef,
  type TreeGraphOptions,
} from './graph.js';

export {
  MappedProvider,
  defineMapping,
  type MappedEdge,
  type MappedField,
  type MappedRoot,
  type MappedType,
  type Mapping,
  type MappingPluginSpec,
  type MappingRequest,
} from './mapping.js';

export {
  argsOf,
  findDirective,
  parseGraphQL,
  resolveVariables,
  responseName,
  tokenizeGraphQL,
  valueOf,
  type GqlArgument,
  type GqlDirective,
  type GqlDocument,
  type GqlField,
  type GqlFragment,
  type GqlFragmentSpread,
  type GqlInlineFragment,
  type GqlOperation,
  type GqlRuntimeValue,
  type GqlSelection,
  type GqlTypeRef,
  type GqlValue,
  type GqlVariableDef,
} from './graphql.js';

export {
  ProjectionProvider,
  UNIVERSAL_ROOTS,
  executeProjection,
  expandSelections,
  parseOrderBy,
  pickOperation,
  printProjectionSchema,
  projectionPlugin,
  resolveProjectionField,
  sortGraphNodes,
  type ExecuteOptions,
  type JsonValue,
  type ProjectionOptions,
  type ProjectionProviderOptions,
} from './projection.js';

export { agentFsDatabase, loadAgentFs, resetAgentFsCache } from './agentfs.js';
export type {
  AgentFsDatabase,
  AgentFsStatement,
  AgentFsLike,
  AgentFsModule,
  ToolCallsLike,
  KvStoreLike,
} from './agentfs.js';
export { exportToAgentFs } from './agentfs-export.js';
export type { AgentFsExportOptions, AgentFsExportResult } from './agentfs-export.js';
