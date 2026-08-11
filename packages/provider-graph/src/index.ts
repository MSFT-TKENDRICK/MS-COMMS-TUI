export { DeviceCodeAuthenticator, DEFAULT_CLIENT_ID, DEFAULT_SCOPES } from './auth.js';
export type { DeviceCodeAuthOptions } from './auth.js';
export { GraphClient } from './client.js';
export type { GraphClientOptions, GraphPage } from './client.js';
export { getAuthenticator, createClient, resetAllAuth, htmlToText, preview } from './shared.js';
export type { GraphSharedOptions } from './shared.js';
export { GraphMailProvider, graphMailPlugin } from './mail.js';
export type { GraphMailOptions } from './mail.js';
export { GraphChatProvider, graphChatPlugin } from './chat.js';
export type { GraphChatOptions } from './chat.js';

import { graphMailPlugin } from './mail.js';
import { graphChatPlugin } from './chat.js';

/** Both plugins, for bulk registration. */
export const graphPlugins = [graphMailPlugin, graphChatPlugin];

export default graphMailPlugin;
