export { DeviceCodeAuthenticator, DEFAULT_CLIENT_ID, DEFAULT_SCOPES } from './auth.js';
export type { DeviceCodeAuthOptions } from './auth.js';
export { GraphClient, graphFailure, toGraphPage, toRelativeGraphPath } from './client.js';
export type { GraphApi, GraphClientOptions, GraphPage, GraphRequestOptions } from './client.js';
export {
  McpGraphApi,
  McpStdioClient,
  getMcpClient,
  closeAllMcpClients,
  hasDiscoverableMcpServer,
  resolveMcpServer,
  mcpConfigCandidates,
} from './mcp.js';
export type { McpTransportOptions } from './mcp.js';
export {
  getAuthenticator,
  createClient,
  resetAllAuth,
  resolveTransport,
  validateSharedOptions,
  htmlToText,
  preview,
} from './shared.js';
export type { GraphSharedOptions, AuthenticatorIdentity, GraphTransport } from './shared.js';
export { GraphMailProvider, graphMailPlugin } from './mail.js';
export type { GraphMailOptions } from './mail.js';
export { GraphChatProvider, graphChatPlugin } from './chat.js';
export type { GraphChatOptions } from './chat.js';
export { GraphPeopleProvider, graphPeoplePlugin } from './people.js';
export type { GraphPeopleOptions } from './people.js';

import { graphMailPlugin } from './mail.js';
import { graphChatPlugin } from './chat.js';
import { graphPeoplePlugin } from './people.js';

/** Every Graph plugin, for bulk registration. */
export const graphPlugins = [graphMailPlugin, graphChatPlugin, graphPeoplePlugin];

export default graphMailPlugin;
