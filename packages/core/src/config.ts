/**
 * Configuration.
 *
 * Format is JSONC — JSON with `//` comments and trailing commas. TOML would be marginally
 * nicer to hand-edit and is what most terminal tools have converged on, but a correct TOML
 * parser is a few thousand lines and this project holds runtime dependencies at zero on
 * purpose: it reads corporate mail, so every transitive package is attack surface someone
 * has to justify. JSONC gets the two things that actually matter for a hand-edited file
 * (comments, forgiving commas) for about eighty lines of well-tested code.
 *
 * Secrets are never stored in the file. A value written as `${env:GITHUB_TOKEN}` is
 * resolved from the environment at use time, so a config file is safe to commit and safe
 * to paste into a bug report.
 */

import { homedir } from 'node:os';
import { join as hostJoin, isAbsolute as hostIsAbsolute, resolve as hostResolve, posix as posixPath, win32 as win32Path } from 'node:path';
import { readFile } from 'node:fs/promises';
import { VfsError } from './errors.js';
import * as vpath from './vpath.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface MountConfig {
  readonly path: string;
  readonly type: string;
  readonly id?: string;
  readonly description?: string;
  readonly options?: Record<string, unknown>;
  readonly ttlMs?: number;
  readonly pageSize?: number;
}

export interface SavedQueryConfig {
  readonly name: string;
  readonly query: string;
  /** Paths to search. Defaults to every mount. */
  readonly scope?: readonly string[];
  readonly description?: string;
}

export interface WatchConfig {
  readonly id: string;
  readonly path: string;
  readonly query?: string;
  readonly intervalMs?: number;
  readonly includeUpdates?: boolean;
  readonly label?: string;
}

export interface UiConfig {
  /** Force plain output: no colour, no box drawing, no spinners, no alternate screen. */
  readonly plain?: boolean;
  readonly color?: 'auto' | 'always' | 'never';
  readonly pageSize?: number;
  readonly bell?: boolean;
  /**
   * Emacspeak-style output: render listings as spoken sentences rather than aligned
   * columns, because column alignment is a purely visual affordance.
   */
  readonly announce?: boolean;
  readonly dateStyle?: 'relative' | 'absolute' | 'iso';
  readonly prompt?: string;
  readonly showHiddenMeta?: boolean;
}

export interface NotificationConfig {
  readonly desktop?: boolean;
  readonly appId?: string;
  readonly appName?: string;
  readonly maxEntries?: number;
}

/**
 * Speech input.
 *
 * Off unless configured, and that default is not timidity. A microphone left listening in
 * an open-plan office, in a program that has the user's mail open, is a privacy incident
 * waiting for a quiet afternoon — so voice is opt-in, push-to-talk is the default mode,
 * and continuous listening has to be asked for by name.
 *
 * Credentials follow the same rule as everywhere else in this file: `apiKey` holds a
 * `${env:NAME}` reference, never the key itself, so a config file stays safe to commit.
 */
export interface VoiceConfig {
  readonly enabled?: boolean;
  /**
   * Which speech-to-text backend to use.
   *
   * `mai` is the default: Microsoft Foundry's LLM Speech API running MAI-Transcribe-1.5.
   * It is a different request shape from the OpenAI one — `speechtotext/transcriptions:transcribe`
   * with a JSON `definition` part — and it is the only engine here that accepts a phrase
   * list, which matters because the words most often spoken to this program are folder
   * names and people's names rather than dictionary words.
   *
   * `foundry` is the same tenant's OpenAI-compatible surface, for a Whisper or
   * gpt-4o-transcribe deployment. `azure-speech` is the classic Azure AI Speech REST
   * endpoint, for tenants that already have one. `openai` covers Whisper and any other
   * OpenAI-compatible host, `xai` covers Grok, and `command` shells out to a local binary
   * so the audio never leaves the machine at all.
   */
  readonly engine?: 'mai' | 'foundry' | 'azure-speech' | 'openai' | 'xai' | 'command';
  readonly endpoint?: string;
  readonly model?: string;
  /** A `${env:NAME}` reference. A literal key here is rejected at load time. */
  readonly apiKey?: string;
  /** BCP-47 tag, e.g. `en-US`. Sent to engines that accept a language hint. */
  readonly language?: string;
  readonly region?: string;
  /** Local binary for `engine: "command"`. Receives WAV on stdin, prints the transcript. */
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  /** `push` waits for a key; `continuous` listens until told to stop. */
  readonly mode?: 'push' | 'continuous';
  /** Required prefix in continuous mode, so ambient speech is not obeyed. */
  readonly wakeWord?: string;
  /** Seconds of audio to capture per utterance before giving up. */
  readonly maxSeconds?: number;
  /** Recording program to spawn. Auto-detected when omitted. */
  readonly recorder?: string;
  readonly recorderArgs?: readonly string[];
  /** Input device name to pass to the recorder. */
  readonly device?: string;
  /**
   * Speak confirmations back through the operating system's own text-to-speech.
   *
   * The OS, deliberately, rather than a cloud voice: it works offline, adds no latency to
   * a confirmation the user is waiting on, and keeps the contents of a mailbox off a
   * network that speech synthesis has no reason to touch.
   */
  readonly speak?: boolean;
  /**
   * Run recognized commands without reading them back first.
   *
   * Off by default, and it only ever governs commands that change something — confirming
   * every "go to inbox" would make voice slower than typing, while confirming every
   * "archive it" is the entire safety story. Speech recognition is probabilistic, and a
   * misheard `archive` is not a typo you can see before pressing Enter.
   */
  readonly autoRun?: boolean;
  /**
   * Send the names on screen to the recognizer as a phrase list.
   *
   * On by default, and only ever used by engines that support biasing. The vocabulary of a
   * mail client is mostly proper nouns — folder names, colleagues, project code names — and
   * a general recognizer has no reason to prefer "Contoso" over "can't so". Telling it what
   * is actually in front of the user is the difference between voice navigation working and
   * being a party trick.
   *
   * Names are already on the user's screen and go to the same endpoint that is about to
   * receive a recording of them saying those names out loud, so this leaks nothing new.
   * Turn it off if you would rather send audio and nothing else.
   */
  readonly phraseBias?: boolean;
  /**
   * What the talk key does in the full-screen pane.
   *
   * `auto` holds where the terminal can report key releases and latches where it cannot,
   * which is the honest default: the gesture is the same everywhere, and only its ending
   * differs. `hold` and `toggle` pin one behaviour for a user who would rather have a
   * predictable key than the best one their terminal can manage.
   */
  readonly pushToTalk?: 'auto' | 'hold' | 'toggle';
  /**
   * Milliseconds to keep recording after the talk key is released.
   *
   * People finish a word slightly after they decide to stop, so cutting at the instant of
   * release clips the last syllable and hands the recognizer a truncated sentence.
   */
  readonly releaseDelayMs?: number;
  /** The key to hold, written as `ctrl+space` or `alt+t`. */
  readonly talkKey?: string;
}

export interface AppConfig {
  readonly plugins: readonly string[];
  readonly mounts: readonly MountConfig[];
  readonly queries: readonly SavedQueryConfig[];
  readonly watches: readonly WatchConfig[];
  readonly ui: UiConfig;
  readonly notifications: NotificationConfig;
  readonly voice: VoiceConfig;
  readonly keymap: Readonly<Record<string, string>>;
  readonly ttlMs?: number;
  /** Where this config was loaded from; undefined when defaults were used. */
  readonly sourcePath?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  plugins: [],
  mounts: [],
  queries: [],
  watches: [],
  ui: {},
  notifications: {},
  voice: {},
  keymap: {},
};

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * Strip `//` and block comments and trailing commas, preserving string contents and
 * character offsets so that a JSON syntax error still points at the right place.
 */
export function stripJsonc(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';

  while (i < input.length) {
    const char = input[i] as string;
    const next = input[i + 1];

    if (inString) {
      out += char;
      if (char === '\\') {
        // Copy the escaped character verbatim so `\"` does not end the string.
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      } else if (char === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') {
        // Preserve the byte count so error offsets remain meaningful.
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }

    out += char;
    i += 1;
  }

  // Trailing commas: a comma whose next non-whitespace character closes the container.
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

export function parseJsonc(text: string, sourcePath?: string): unknown {
  const stripped = stripJsonc(text);
  // An empty or comment-only file means "no configuration", not "corrupt file". People
  // comment their whole config out to test something, and getting "Unexpected end of JSON
  // input" for it is a needless dead end.
  if (stripped.trim() === '') return {};
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw VfsError.config(
      `Could not parse config${sourcePath === undefined ? '' : ` at ${sourcePath}`}: ${detail}`,
      'Comments and trailing commas are allowed; check for an unclosed brace, bracket or quote.',
    );
  }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface AppPaths {
  readonly configFile: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly stateDir: string;
  readonly notificationsFile: string;
  readonly logFile: string;
}

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AppPaths {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  // Join with the separator of the *target* platform, not the host's. Without this the
  // `platform` argument only half works — it picks the layout but writes host separators
  // into it — which makes the function impossible to test and its contract a lie.
  const join = platform === 'win32' ? win32Path.join : posixPath.join;

  const configDir =
    env['MSCOMMS_CONFIG_DIR'] ??
    (platform === 'win32'
      ? join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'mscomms')
      : join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'mscomms'));

  const dataDir =
    env['MSCOMMS_DATA_DIR'] ??
    (platform === 'win32'
      ? join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'mscomms')
      : join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'mscomms'));

  return {
    configDir,
    configFile: env['MSCOMMS_CONFIG'] ?? join(configDir, 'config.jsonc'),
    dataDir,
    // State is deliberately not under the cache directory. Sync cursors live in state, and
    // a cache-clearing script that wiped them would make the next poll report every
    // existing message as new.
    cacheDir: join(dataDir, 'cache'),
    stateDir: join(dataDir, 'state'),
    notificationsFile: join(dataDir, 'notifications.json'),
    logFile: join(dataDir, 'mscomms.log'),
  };
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

/**
 * Every setting the top level of a config file may contain.
 *
 * Kept next to {@link validateConfig} because the two must never drift: a key added to the
 * shape and forgotten here becomes an error message telling the user their own
 * documentation is wrong.
 */
const KNOWN_CONFIG_KEYS = new Set([
  'plugins',
  'mounts',
  'queries',
  'watches',
  'ui',
  'notifications',
  'voice',
  'keymap',
  'ttlMs',
  // Conventional no-ops, so a file can carry an editor schema reference or a note.
  '$schema',
  'comment',
]);

/**
 * The closest known key, when the user's key is plausibly a typo of it.
 *
 * Plain Levenshtein with a distance cap. The cap matters more than the algorithm: a
 * confident wrong suggestion ("did you mean 'ui'?" for "watchers") is worse than none.
 */
function nearestKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_CONFIG_KEYS) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const budget = Math.max(2, Math.floor(key.length / 3));
  return bestDistance <= budget ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] as number) + 1, (current[j - 1] as number) + 1);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

export async function loadConfig(
  filePath: string,
  options: { required?: boolean } = {},
): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (options.required === true) {
      throw VfsError.config(`Could not read config at ${filePath}.`, `Run \`mscomms init\` to create one. (${String(error)})`);
    }
    return DEFAULT_CONFIG;
  }
  return validateConfig(parseJsonc(text, filePath), filePath);
}

/**
 * Validate and normalize raw config.
 *
 * Every failure names the offending key and says what to do about it. Configuration
 * errors are the first thing a new user hits, and "unexpected token" is a terrible
 * welcome; a wrong mount path should read like a code review comment, not a stack trace.
 */
export function validateConfig(raw: unknown, sourcePath?: string): AppConfig {
  try {
    return validateConfigBody(raw, sourcePath);
  } catch (error) {
    // Every configuration error should say which file to open. The individual checks
    // report the offending key, which is the harder half; adding the filename here means
    // no check has to remember to.
    if (
      sourcePath !== undefined &&
      error instanceof VfsError &&
      error.code === 'ECONFIG' &&
      !error.message.includes(sourcePath)
    ) {
      throw VfsError.config(`${error.message} (in ${sourcePath})`, error.hint);
    }
    throw error;
  }
}

function validateConfigBody(raw: unknown, sourcePath?: string): AppConfig {
  const where = sourcePath === undefined ? '' : ` in ${sourcePath}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw VfsError.config(
      `Config${where} must be a JSON object.`,
      'The top level should look like: { "mounts": [ ... ] }',
    );
  }
  const root = raw as Record<string, unknown>;

  // Reject unknown top-level keys rather than ignoring them.
  //
  // Silently dropping a key the user believed in is the worst outcome available: someone
  // who writes "savedQueries" instead of "queries" gets no error, no queries, and no way
  // to tell the difference between "my config is wrong" and "this feature is broken". A
  // near-miss suggestion costs one line and saves an afternoon.
  for (const key of Object.keys(root)) {
    if (KNOWN_CONFIG_KEYS.has(key)) continue;
    const suggestion = nearestKey(key);
    throw VfsError.config(
      `Unknown setting "${key}"${where}.`,
      suggestion === undefined
        ? `Known settings are: ${[...KNOWN_CONFIG_KEYS].sort().join(', ')}.`
        : `Did you mean "${suggestion}"?`,
    );
  }

  const plugins = asStringArray(root['plugins'], 'plugins');
  const mounts = asArray(root['mounts'], 'mounts').map((entry, index) => validateMount(entry, index));

  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  for (const mount of mounts) {
    if (seenPaths.has(mount.path)) {
      throw VfsError.config(`Two mounts share the path "${mount.path}".`, 'Mount paths must be unique.');
    }
    seenPaths.add(mount.path);
    const id = mount.id ?? mount.path;
    if (seenIds.has(id)) {
      throw VfsError.config(`Two mounts share the id "${id}".`, 'Give one of them an explicit unique "id".');
    }
    seenIds.add(id);
  }

  const queries = asArray(root['queries'], 'queries').map((entry, index) => validateSavedQuery(entry, index));
  const watches = asArray(root['watches'], 'watches').map((entry, index) => validateWatch(entry, index));

  return {
    plugins,
    mounts,
    queries,
    watches,
    ui: asObject(root['ui'], 'ui') as UiConfig,
    notifications: asObject(root['notifications'], 'notifications') as NotificationConfig,
    voice: validateVoice(root['voice']),
    keymap: asObject(root['keymap'], 'keymap') as Record<string, string>,
    ...(typeof root['ttlMs'] === 'number' ? { ttlMs: root['ttlMs'] } : {}),
    ...(sourcePath === undefined ? {} : { sourcePath }),
  };
}

const VOICE_ENGINES = ['mai', 'foundry', 'azure-speech', 'openai', 'xai', 'command'] as const;

/**
 * Validate the voice block.
 *
 * The one check worth its weight is the credential check. Every other mistake here is
 * recoverable by editing a file; a literal API key written into `voice.apiKey` is a
 * secret that has probably already been committed by the time anyone notices, and this is
 * the last moment the program can say so. The rest of this codebase resolves secrets
 * through `${env:NAME}` for exactly that reason, and voice does not get an exemption for
 * being new.
 */
function validateVoice(raw: unknown): VoiceConfig {
  const record = asObject(raw, 'voice') as Record<string, unknown>;

  const engine = record['engine'];
  if (engine !== undefined && !VOICE_ENGINES.includes(engine as (typeof VOICE_ENGINES)[number])) {
    throw VfsError.config(
      `voice.engine "${String(engine)}" is not a speech backend I know.`,
      `Use one of: ${VOICE_ENGINES.join(', ')}. "mai" is Microsoft Foundry's LLM Speech API with MAI-Transcribe-1.5.`,
    );
  }

  const apiKey = record['apiKey'];
  if (typeof apiKey === 'string' && apiKey !== '' && !isSecretRef(apiKey)) {
    throw VfsError.config(
      'voice.apiKey looks like a literal key rather than a reference to one.',
      'Write it as "${env:AZURE_SPEECH_KEY}" and put the value in your environment, so the config file stays safe to commit and to paste into a bug report.',
    );
  }

  const mode = record['mode'];
  if (mode !== undefined && mode !== 'push' && mode !== 'continuous') {
    throw VfsError.config(
      `voice.mode "${String(mode)}" is not valid.`,
      '"push" waits for a key before listening; "continuous" listens until you stop it and needs a wakeWord.',
    );
  }

  // Continuous listening without a wake word means every sentence spoken near the machine
  // is a candidate command, in a program that can archive mail. Refusing is kinder than
  // the incident.
  if (mode === 'continuous' && typeof record['wakeWord'] !== 'string') {
    throw VfsError.config(
      'voice.mode is "continuous" but no voice.wakeWord is set.',
      'Continuous listening obeys anything it hears, so it requires a wake word: try "wakeWord": "computer".',
    );
  }

  const pushToTalk = record['pushToTalk'];
  if (pushToTalk !== undefined && pushToTalk !== 'auto' && pushToTalk !== 'hold' && pushToTalk !== 'toggle') {
    throw VfsError.config(
      `voice.pushToTalk "${String(pushToTalk)}" is not valid.`,
      '"auto" holds where the terminal reports key releases and latches where it does not; "hold" insists; "toggle" never holds.',
    );
  }

  // Checked because a negative delay is not a slower stop, it is a stop in the past — the
  // recording would end before the key came up, clipping the words the delay exists to keep.
  const releaseDelay = record['releaseDelayMs'];
  if (releaseDelay !== undefined && (typeof releaseDelay !== 'number' || !Number.isFinite(releaseDelay) || releaseDelay < 0)) {
    throw VfsError.config(
      `voice.releaseDelayMs must be a number of milliseconds, zero or more, not ${JSON.stringify(releaseDelay)}.`,
      'It keeps the microphone open briefly after the talk key comes up, so the last syllable is not clipped. 250 is the default.',
    );
  }

  // Deliberately not validated here: `voice.talkKey`, whose meaning depends on how a terminal
  // encodes keys and so is parsed by the pane rather than by config loading. An unusable one
  // falls back to Ctrl+Space, and `voice status` says so rather than leaving the user with a
  // key that does nothing and a config file that says it should.

  return record as VoiceConfig;
}

function validateMount(entry: unknown, index: number): MountConfig {
  const where = `mounts[${String(index)}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw VfsError.config(`${where} must be an object.`, 'Example: { "path": "/mail", "type": "graph-mail" }');
  }
  const record = entry as Record<string, unknown>;

  const rawPath = record['path'];
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw VfsError.config(`${where}.path is required.`, 'Example: "path": "/mail"');
  }
  const path = vpath.normalize(rawPath);
  if (!vpath.isAbsolute(path) || path === vpath.ROOT) {
    throw VfsError.config(
      `${where}.path must be an absolute path below the root, not "${rawPath}".`,
      'Use something like "/mail" or "/gh/myorg". "/" is reserved for the mount list itself.',
    );
  }

  const type = record['type'];
  if (typeof type !== 'string' || type.length === 0) {
    throw VfsError.config(`${where}.type is required.`, 'Run `mscomms plugins` to list the available provider types.');
  }

  return {
    path,
    type,
    ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
    ...(typeof record['options'] === 'object' && record['options'] !== null
      ? { options: record['options'] as Record<string, unknown> }
      : {}),
    ...(typeof record['ttlMs'] === 'number' ? { ttlMs: record['ttlMs'] } : {}),
    ...(typeof record['pageSize'] === 'number' ? { pageSize: record['pageSize'] } : {}),
  };
}

function validateSavedQuery(entry: unknown, index: number): SavedQueryConfig {
  const where = `queries[${String(index)}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw VfsError.config(`${where} must be an object.`, 'Example: { "name": "unread", "query": "is:unread" }');
  }
  const record = entry as Record<string, unknown>;
  const name = record['name'];
  const query = record['query'];
  if (typeof name !== 'string' || name.length === 0) {
    throw VfsError.config(`${where}.name is required.`, 'This becomes a directory under /q, so keep it short.');
  }
  if (typeof query !== 'string' || query.length === 0) {
    throw VfsError.config(`${where}.query is required.`, 'Example: "query": "is:unread from:alice"');
  }
  return {
    name,
    query,
    ...(Array.isArray(record['scope']) ? { scope: asStringArray(record['scope'], `${where}.scope`) } : {}),
    ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
  };
}

function validateWatch(entry: unknown, index: number): WatchConfig {
  const where = `watches[${String(index)}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw VfsError.config(`${where} must be an object.`, 'Example: { "id": "inbox", "path": "/mail/Inbox" }');
  }
  const record = entry as Record<string, unknown>;
  const id = record['id'];
  const path = record['path'];
  if (typeof id !== 'string' || id.length === 0) {
    throw VfsError.config(`${where}.id is required.`, 'Any short unique string, e.g. "inbox".');
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw VfsError.config(`${where}.path is required.`, 'Example: "path": "/mail/Inbox"');
  }
  const intervalMs = record['intervalMs'];
  if (intervalMs !== undefined) {
    // A zero or negative interval is a busy loop against someone's mail API. Rejecting it
    // costs one message; accepting it costs a rate-limit ban that looks like a bug in the
    // tool.
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 1000) {
      throw VfsError.config(
        `${where}.intervalMs must be at least 1000.`,
        'Polling faster than once a second will get you rate-limited. 60000 (one minute) is a sensible default.',
      );
    }
  }

  return {
    id,
    path: vpath.normalize(path),
    ...(typeof record['query'] === 'string' ? { query: record['query'] } : {}),
    ...(typeof intervalMs === 'number' ? { intervalMs } : {}),
    ...(typeof record['includeUpdates'] === 'boolean' ? { includeUpdates: record['includeUpdates'] } : {}),
    ...(typeof record['label'] === 'string' ? { label: record['label'] } : {}),
  };
}

function asArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw VfsError.config(`"${name}" must be an array.`);
  }
  return value;
}

function asStringArray(value: unknown, name: string): string[] {
  return asArray(value, name).map((entry, index) => {
    if (typeof entry !== 'string') {
      throw VfsError.config(`${name}[${String(index)}] must be a string.`);
    }
    return entry;
  });
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw VfsError.config(`"${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const SECRET_REF = /^\$\{(env|file):([^}]+)\}$/;

/**
 * Resolve a secret reference.
 *
 * `${env:NAME}` reads the environment; `${file:/path}` reads a file (trimmed), which
 * suits `gh auth token > ~/.mscomms-token` style setups and Docker secrets. Anything else
 * is returned as a literal, so a user who really wants to inline a token can — but the
 * docs and the generated config only ever show the indirection.
 */
export async function resolveSecret(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const match = SECRET_REF.exec(reference.trim());
  if (match === null) return reference;

  const kind = match[1] as string;
  const target = (match[2] as string).trim();

  if (kind === 'env') {
    const value = env[target];
    return value === undefined || value.length === 0 ? undefined : value;
  }

  try {
    const expanded = target.startsWith('~')
      ? hostJoin(env['HOME'] ?? env['USERPROFILE'] ?? homedir(), target.slice(1))
      : hostIsAbsolute(target)
        ? target
        : hostResolve(target);
    return (await readFile(expanded, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** True when a config value is an unresolved indirection rather than a literal secret. */
export function isSecretRef(value: string): boolean {
  return SECRET_REF.test(value.trim());
}
