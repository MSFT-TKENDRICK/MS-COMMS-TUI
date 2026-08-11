/**
 * Device code authentication.
 *
 * The device code flow is the right choice here and the alternatives are not:
 *
 *   - Authorization code + PKCE needs a loopback HTTP listener. That breaks over SSH, in
 *     containers, and in WSL, which is where a terminal tool actually lives.
 *   - Client credentials needs an app secret and grants application-wide access to every
 *     mailbox in the tenant. Wildly disproportionate for reading your own mail.
 *   - Username/password (ROPC) does not survive MFA and is deprecated.
 *
 * Device code needs no listener, no secret, and no open port: the user is shown a short
 * code, authenticates in a browser anywhere, and the CLI polls. It is also the most
 * accessible option, because the code is plain linear text a screen reader reads normally.
 *
 * TOKEN STORAGE IS THE UNCOMFORTABLE PART, and it is documented rather than hidden. The
 * refresh token is written to the user's data directory with owner-only permissions where
 * the platform supports them. That is meaningfully weaker than a Keychain or DPAPI, both
 * of which would require a native dependency this project will not take. Anyone who is not
 * comfortable with that can set `MSCOMMS_GRAPH_TOKEN` from an external token source and no
 * credential is ever persisted.
 */

import { VfsError, type Logger, type StateStore } from '@mscomms/core';

export interface DeviceCodeAuthOptions {
  readonly clientId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly authority?: string;
  readonly state: StateStore;
  readonly logger: Logger;
  /** Where to show the device code. Defaults to stderr. */
  readonly prompt?: (message: string, verificationUri: string, userCode: string) => void;
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string;
}

/**
 * Microsoft Graph Command Line Tools — the first-party public client the Microsoft Graph
 * PowerShell SDK uses for exactly this purpose. Defaulting to it means the tool works
 * without anyone registering an app, while `clientId` remains configurable for tenants
 * that restrict it or for anyone who prefers their own registration.
 */
export const DEFAULT_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';

export const DEFAULT_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'MailboxSettings.Read',
  'Chat.Read',
  'ChannelMessage.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
];

const STATE_KEY = 'graph:tokens';

export class DeviceCodeAuthenticator {
  readonly #options: DeviceCodeAuthOptions;
  readonly #authority: string;
  #tokens: TokenSet | undefined;
  #inFlight: Promise<string> | undefined;

  constructor(options: DeviceCodeAuthOptions) {
    this.#options = options;
    this.#authority = (options.authority ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  }

  /**
   * Return a valid access token, refreshing or re-authenticating as needed.
   *
   * Concurrent callers share one attempt. Without that, the first `ls` after start — which
   * fires several requests at once — would trigger several simultaneous device code
   * prompts, which is both confusing and a good way to get throttled.
   */
  async getToken(): Promise<string> {
    const external = process.env['MSCOMMS_GRAPH_TOKEN'];
    if (external !== undefined && external.length > 0) return external;

    if (this.#inFlight !== undefined) return this.#inFlight;
    this.#inFlight = this.#acquire().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async signOut(): Promise<void> {
    this.#tokens = undefined;
    await this.#options.state.delete(STATE_KEY);
  }

  async #acquire(): Promise<string> {
    if (this.#tokens === undefined) this.#tokens = await this.#load();

    // Sixty seconds of headroom: a token that expires mid-request is a confusing 401.
    if (this.#tokens !== undefined && this.#tokens.expiresAt > Date.now() + 60_000) {
      return this.#tokens.accessToken;
    }

    if (this.#tokens?.refreshToken !== undefined) {
      try {
        const refreshed = await this.#refresh(this.#tokens.refreshToken);
        await this.#save(refreshed);
        return refreshed.accessToken;
      } catch (error) {
        this.#options.logger.warn('token refresh failed, falling back to device code', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const fresh = await this.#deviceCode();
    await this.#save(fresh);
    return fresh.accessToken;
  }

  async #load(): Promise<TokenSet | undefined> {
    const raw = await this.#options.state.get(STATE_KEY);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as TokenSet;
      // A change to the requested scopes invalidates the cache: a token issued for fewer
      // scopes would fail later with a confusing 403 rather than a clear re-consent.
      if (parsed.scopes !== this.#scopeString) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async #save(tokens: TokenSet): Promise<void> {
    this.#tokens = tokens;
    await this.#options.state.set(STATE_KEY, JSON.stringify(tokens));
  }

  get #scopeString(): string {
    return [...this.#options.scopes].sort().join(' ');
  }

  get #tokenEndpoint(): string {
    return `${this.#authority}/${this.#options.tenantId}/oauth2/v2.0/token`;
  }

  async #refresh(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: this.#options.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: this.#options.scopes.join(' '),
    });
    const response = await fetch(this.#tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new VfsError('EAUTH', `Refresh failed: ${String(payload['error_description'] ?? payload['error'])}`);
    }
    return this.#toTokenSet(payload, refreshToken);
  }

  async #deviceCode(): Promise<TokenSet> {
    const start = await fetch(`${this.#authority}/${this.#options.tenantId}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#options.clientId,
        scope: this.#options.scopes.join(' '),
      }),
    });

    const device = (await start.json()) as Record<string, unknown>;
    if (!start.ok) {
      const description = String(device['error_description'] ?? device['error'] ?? 'unknown error');
      throw new VfsError('EAUTH', `Could not start sign-in: ${description}`, {
        hint: String(device['error']) === 'invalid_client'
          ? 'This tenant does not allow the default client application. Set "clientId" on the mount to your own registered public client.'
          : 'Check the tenantId on the mount, and that the machine can reach login.microsoftonline.com.',
      });
    }

    const userCode = String(device['user_code'] ?? '');
    const verificationUri = String(device['verification_uri'] ?? 'https://microsoft.com/devicelogin');
    const interval = Number(device['interval'] ?? 5);
    const expiresIn = Number(device['expires_in'] ?? 900);

    const prompt = this.#options.prompt ?? defaultPrompt;
    prompt(String(device['message'] ?? ''), verificationUri, userCode);

    const deadline = Date.now() + expiresIn * 1000;
    let delay = Math.max(1, interval) * 1000;

    while (Date.now() < deadline) {
      await sleep(delay);

      const response = await fetch(this.#tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.#options.clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: String(device['device_code'] ?? ''),
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;

      if (response.ok) return this.#toTokenSet(payload, undefined);

      const error = String(payload['error'] ?? '');
      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') {
        delay += 5_000;
        continue;
      }
      if (error === 'authorization_declined') {
        throw new VfsError('EAUTH', 'Sign-in was declined.', { hint: 'Run the command again to retry.' });
      }
      if (error === 'expired_token') {
        throw new VfsError('EAUTH', 'The sign-in code expired.', { hint: 'Run the command again to get a fresh code.' });
      }
      throw new VfsError('EAUTH', `Sign-in failed: ${String(payload['error_description'] ?? error)}`);
    }

    throw new VfsError('ETIMEDOUT', 'Sign-in was not completed in time.');
  }

  #toTokenSet(payload: Record<string, unknown>, fallbackRefresh: string | undefined): TokenSet {
    const accessToken = String(payload['access_token'] ?? '');
    if (accessToken.length === 0) throw new VfsError('EAUTH', 'The identity service returned no access token.');
    const refresh = payload['refresh_token'];
    return {
      accessToken,
      ...(typeof refresh === 'string' ? { refreshToken: refresh } : fallbackRefresh === undefined ? {} : { refreshToken: fallbackRefresh }),
      expiresAt: Date.now() + Number(payload['expires_in'] ?? 3600) * 1000,
      scopes: this.#scopeString,
    };
  }
}

/**
 * The default prompt.
 *
 * Written to stderr, not stdout, so `mscomms ls /mail --json | jq` is never corrupted by
 * a sign-in prompt. Deliberately plain text with the code on its own line: no box drawing,
 * no colour, no spinner. A screen reader reads it as an ordinary sentence, and it survives
 * being piped, logged or copied.
 */
function defaultPrompt(_message: string, verificationUri: string, userCode: string): void {
  process.stderr.write(
    [
      '',
      'Sign in to Microsoft 365 to continue.',
      `  1. Open ${verificationUri}`,
      `  2. Enter this code: ${userCode}`,
      '  3. Complete sign-in in the browser. This will continue automatically.',
      '',
    ].join('\n'),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
