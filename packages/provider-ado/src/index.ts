export { AdoBoardsProvider, adoBoardsPlugin, orgUrlFor } from './provider.js';
export type { AdoBoardsOptions } from './provider.js';
export { AdoClient, DEFAULT_API_VERSION, segment } from './client.js';
export type { AdoClientOptions, AdoResponse, FetchLike } from './client.js';
export {
  resolveCredential,
  ADO_RESOURCE_ID,
  ADO_SCOPES,
  DEFAULT_ADO_CLIENT_ID,
} from './auth.js';
export type { AdoAuthMode, AdoAuthOptions, AuthorizationSource, ResolvedCredential } from './auth.js';
export { buildWiql, literal, WORK_ITEM_FIELDS } from './wiql.js';
export type { WiqlBuild, WiqlScope } from './wiql.js';

import { adoBoardsPlugin } from './provider.js';

export default adoBoardsPlugin;
