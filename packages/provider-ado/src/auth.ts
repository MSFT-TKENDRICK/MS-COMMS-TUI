/**
 * Credentials for Azure DevOps.
 *
 * Two mechanisms, because the two populations who will use this mount are genuinely
 * different:
 *
 *   PAT — what CI already has, what `az devops` documents, and the only option for a
 *   service account. Sent as HTTP Basic with an empty username, which is the scheme Azure
 *   DevOps documents and the reason the token looks like a password in a URL.
 *
 *   AAD device code — what a person at a terminal wants, because it needs no token to
 *   create, no token to rotate, and no token written down anywhere. It reuses the
 *   authenticator from the Graph provider: Azure DevOps is a different *resource*, not a
 *   different identity provider, so the flow, the token cache and the refresh logic are
 *   already written and already tested.
 *
 * Default is `auto`: use a PAT when one is present, otherwise sign in interactively. That
 * ordering matters for CI, where a device-code prompt would hang a pipeline forever with
 * no terminal to read the code from.
 */

import { VfsError, type Logger, type ProviderContext, type StateStore } from '@mscomms/core';
import { getAuthenticator } from '@mscomms/provider-graph';

export type AdoAuthMode = 'auto' | 'pat' | 'aad';

export interface AdoAuthOptions {
  readonly auth?: AdoAuthMode;
  /** A PAT, or a `${env:NAME}` reference resolved through the host's secret lookup. */
  readonly token?: string;
  readonly clientId?: string;
  readonly tenantId?: string;
  readonly authority?: string;
}

/**
 * The Azure CLI's public client.
 *
 * Azure DevOps only issues tokens to applications that are pre-authorized for it, and the
 * Graph Command Line Tools client used elsewhere in this repo is not one of them. This is
 * the first-party public client `az devops` itself authenticates with, so it works in any
 * tenant that has not explicitly blocked it — and `clientId` remains configurable for the
 * tenants that have.
 */
export const DEFAULT_ADO_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

/**
 * The Azure DevOps resource id. Constant across every organization and every cloud; the
 * `/.default` suffix asks for whatever the user has already consented to.
 */
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

export const ADO_SCOPES = [`${ADO_RESOURCE_ID}/.default`, 'offline_access'];

/**
 * Environment variables checked for a PAT, in order.
 *
 * The first two are what the `azure-devops` CLI extension and its documentation use, so a
 * machine already set up for `az devops` needs no new configuration. `SYSTEM_ACCESSTOKEN`
 * is the job token an Azure Pipelines run can opt into, which makes this mount usable from
 * a pipeline step without minting anything.
 */
const PAT_ENV_VARS = ['AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'SYSTEM_ACCESSTOKEN'] as const;

/** Produces a complete `Authorization` header value. */
export type AuthorizationSource = () => Promise<string>;

export interface ResolvedCredential {
  readonly authorization: AuthorizationSource;
  /** For diagnostics and the `mounts` listing. */
  readonly mode: 'pat' | 'aad';
}

export async function resolveCredential(
  options: AdoAuthOptions,
  context: Pick<ProviderContext, 'secret' | 'logger' | 'state'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCredential> {
  const mode = options.auth ?? 'auto';
  const pat = await findPat(options.token, context.secret, env);

  if (mode === 'pat') {
    if (pat === undefined) {
      throw VfsError.config('This Azure DevOps mount is set to "auth": "pat" but no token was found.', `Set "token" on the mount, or one of ${PAT_ENV_VARS.join(', ')}.`);
    }
    return { mode: 'pat', authorization: basic(pat) };
  }

  if (mode === 'auto' && pat !== undefined) {
    return { mode: 'pat', authorization: basic(pat) };
  }

  return { mode: 'aad', authorization: bearer(options, context.state, context.logger) };
}

async function findPat(
  configured: string | undefined,
  secret: (ref: string) => Promise<string | undefined>,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (configured !== undefined && configured.length > 0) {
    const resolved = await secret(configured);
    if (resolved !== undefined && resolved.length > 0) return resolved;
    throw VfsError.config('The Azure DevOps mount\'s "token" resolved to nothing.', 'Secret references look like "${env:AZURE_DEVOPS_EXT_PAT}", and the variable has to be set in the environment this process was started from.');
  }
  for (const name of PAT_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function basic(pat: string): AuthorizationSource {
  // Azure DevOps expects an empty username and the PAT as the password.
  const encoded = Buffer.from(`:${pat}`, 'utf8').toString('base64');
  const header = `Basic ${encoded}`;
  return () => Promise.resolve(header);
}

function bearer(options: AdoAuthOptions, state: StateStore, logger: Logger): AuthorizationSource {
  const authenticator = getAuthenticator(
    {
      clientId: options.clientId ?? DEFAULT_ADO_CLIENT_ID,
      scopes: ADO_SCOPES,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(options.authority === undefined ? {} : { authority: options.authority }),
    },
    state,
    logger,
    // A Graph access token is not an Azure DevOps access token. Without a distinct
    // environment variable, anyone using MSCOMMS_GRAPH_TOKEN for mail would silently send
    // that token here and get a 401 that reads like an expired sign-in.
    { tokenEnvVar: 'MSCOMMS_ADO_TOKEN', stateKey: 'ado:tokens' },
  );
  return async () => `Bearer ${await authenticator.getToken()}`;
}
