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
  type VNode,
  type WellKnownFlag,
} from './provider.js';

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

export { TtlCache, type CacheEntry, type CacheOptions, type CacheStats } from './cache.js';

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
  type MountConfig,
  type NotificationConfig,
  type SavedQueryConfig,
  type UiConfig,
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
