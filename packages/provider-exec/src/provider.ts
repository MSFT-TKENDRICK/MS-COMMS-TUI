/**
 * The exec provider — any program, in any language, as a mounted filesystem.
 *
 * This is the second plugin tier. The first (a JS package exporting a `ProviderPlugin`)
 * is faster and better typed; this one asks nothing of the author but the ability to read
 * a line of JSON and write one back.
 *
 * A COMPLETE PLUGIN, IN BASH:
 *
 *   #!/usr/bin/env bash
 *   read -r request
 *   case "$(jq -r .method <<<"$request")" in
 *     initialize) echo '{"id":1,"result":{"protocol":1,"displayName":"Notes",
 *                        "capabilities":["list","read"]}}' ;;
 *     list)  echo '{"id":1,"result":{"entries":[{"name":"hello.txt","kind":"file","id":"1"}]}}' ;;
 *     read)  echo '{"id":1,"result":{"body":"Hello!","format":"text"}}' ;;
 *   esac
 *
 * SECURITY, STATED PLAINLY
 *
 * Mounting an exec provider runs a program on your machine with your privileges. That is
 * the entire point of the feature and it cannot be sandboxed away — the same is true of
 * every editor plugin and every git hook. What this implementation does is refuse to make
 * it worse:
 *
 *  - `command` is an array and is never passed through a shell, so a message subject
 *    containing a backtick cannot become a command. Remote data reaches the plugin only
 *    as JSON on stdin, never as shell text.
 *  - The environment is passed through explicitly, so a plugin gets tokens only when the
 *    config says so, via `${env:NAME}` references resolved by the host.
 *  - `mounts` shows exec mounts with the program being run, so an unexpected entry in a
 *    config file is visible rather than silent.
 *
 * WHAT THE HOST DOES NOT TRUST
 *
 * Query push-down is deliberately not offered. The query is passed to the plugin as a
 * hint it may use to fetch less, but the engine always re-applies the whole query locally.
 * A plugin that claimed to have filtered correctly and had not would silently hide mail
 * from its user, and "silently hides your mail" is not a failure mode worth the round trip
 * it saves.
 */

import {
  VfsError,
  type ActionDescriptor,
  type ActionResult,
  type Capability,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollOptions,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type ReadOptions,
  type VNode,
  stringifyQuery,
  CAPABILITIES,
} from '@mscomms/core';

import { JsonLineClient, PROTOCOL_VERSION } from './rpc.js';
import {
  decodeActionResult,
  decodeActions,
  decodeAttachmentBytes,
  decodeDocument,
  decodeListPage,
  decodeNode,
  decodePollResult,
} from './schema.js';

export interface ExecProviderOptions {
  /** Program and arguments. Never passed through a shell. */
  readonly command: readonly string[];
  readonly cwd?: string;
  /** Extra environment variables. Values may be `${env:NAME}` secret references. */
  readonly env?: Readonly<Record<string, string>>;
  /** Spawn one process per request instead of keeping one alive. Default false. */
  readonly oneshot?: boolean;
  /** Per-request deadline in seconds. Default 30. */
  readonly timeout?: number;
  /**
   * The capabilities this mount may use.
   *
   * Serves two purposes. When the plugin does not implement `initialize` — common for
   * one-shot scripts — this is what it is assumed to support. When the plugin *does*
   * declare capabilities, this acts as a ceiling and the two are intersected, so writing
   * `["list", "read"]` genuinely prevents `do` from offering actions.
   *
   * Omit it to accept whatever the plugin declares.
   */
  readonly capabilities?: readonly Capability[];
  readonly displayName?: string;
}

interface Handshake {
  readonly protocol?: number;
  readonly displayName?: string;
  readonly capabilities?: readonly string[];
}

export class ExecProvider implements Provider {
  readonly id: string;
  #displayName: string;
  #capabilities: ReadonlySet<Capability>;
  readonly #client: JsonLineClient;
  readonly #context: ProviderContext;
  readonly #options: ExecProviderOptions;
  #initialized = false;

  /**
   * Optional capabilities, installed by {@link ExecProvider.#syncMethods} only when the
   * plugin says it supports them. See that method for why they are properties and not
   * ordinary class methods.
   */
  search?: NonNullable<Provider['search']>;
  poll?: NonNullable<Provider['poll']>;
  readAttachment?: NonNullable<Provider['readAttachment']>;
  actions?: NonNullable<Provider['actions']>;
  invoke?: NonNullable<Provider['invoke']>;

  constructor(options: ExecProviderOptions, context: ProviderContext) {
    this.#options = options;
    this.#context = context;
    this.id = `exec:${options.command[0] ?? 'unknown'}`;
    this.#displayName = options.displayName ?? options.command[0] ?? 'External provider';
    // Assume the basics until the handshake says otherwise, so a plugin that skips
    // `initialize` entirely still works for the common read-only case.
    this.#capabilities = new Set<Capability>(options.capabilities ?? ['list', 'read']);
    this.#client = new JsonLineClient({
      command: options.command,
      timeoutMs: Math.max(1, options.timeout ?? 30) * 1000,
      logger: context.logger,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.oneshot === undefined ? {} : { oneshot: options.oneshot }),
    });
    this.#syncMethods();
  }

  get displayName(): string {
    return this.#displayName;
  }

  get capabilities(): ReadonlySet<Capability> {
    return this.#capabilities;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    let raw: unknown;
    try {
      raw = await this.#client.call('initialize', {
        protocol: PROTOCOL_VERSION,
        mountPath: this.#context.mountPath,
        cacheDir: this.#context.cacheDir,
      });
    } catch (error) {
      // A plugin that does not implement `initialize` is allowed. It just gets the
      // configured defaults. Only a hard startup failure is fatal.
      if (error instanceof VfsError && (error.code === 'ECONFIG' || error.code === 'EINTERNAL')) {
        this.#context.logger.warn(`Provider handshake failed: ${error.message}`);
        if (error.code === 'ECONFIG') throw error;
      }
      return;
    }
    if (typeof raw !== 'object' || raw === null) return;
    const shake = raw as Handshake;
    if (typeof shake.protocol === 'number' && shake.protocol > PROTOCOL_VERSION) {
      throw new VfsError(
        'ECONFIG',
        `"${this.#displayName}" speaks protocol ${String(shake.protocol)}, but this version of mscomms only understands ${String(PROTOCOL_VERSION)}.`,
        { hint: 'Update mscomms, or pin an older version of the provider program.' },
      );
    }
    if (typeof shake.displayName === 'string' && shake.displayName !== '') {
      this.#displayName = shake.displayName;
    }
    if (Array.isArray(shake.capabilities)) {
      const declared = new Set<Capability>();
      for (const item of shake.capabilities) {
        if ((CAPABILITIES as readonly string[]).includes(item)) declared.add(item as Capability);
        else this.#context.logger.warn(`Provider "${this.#displayName}" declared an unknown capability: ${item}`);
      }
      this.#capabilities = this.#applyCeiling(declared);
      this.#syncMethods();
    }
  }

  /**
   * Intersect what the plugin claims with what the config allows.
   *
   * When the mount does not list `capabilities`, the plugin's declaration stands. When it
   * does, that list is a ceiling rather than a hint: a user who writes
   * `"capabilities": ["list", "read"]` and then finds `do` offering to delete things has
   * been told one thing by their own config file and another by the program.
   *
   * This is emphatically *not* a security boundary. The plugin is an arbitrary program
   * already running with the user's privileges; withholding `actions` stops mscomms
   * offering the action, and stops nothing else. It is a safety and honesty boundary,
   * which is a smaller claim and a true one.
   */
  #applyCeiling(declared: ReadonlySet<Capability>): ReadonlySet<Capability> {
    const allowed = this.#options.capabilities;
    if (allowed === undefined) return declared;

    const ceiling = new Set<Capability>(allowed);
    const granted = new Set<Capability>();
    const withheld: Capability[] = [];
    for (const capability of declared) {
      if (ceiling.has(capability)) granted.add(capability);
      else withheld.push(capability);
    }
    if (withheld.length > 0) {
      this.#context.logger.info(
        `"${this.#displayName}" offers ${withheld.sort().join(', ')}, withheld by this mount's "capabilities". Remove that key to allow everything the plugin supports.`,
      );
    }
    return granted;
  }

  async dispose(): Promise<void> {
    await this.#client.close();
  }

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const raw = await this.#call(
      'list',
      {
        parent: wireNode(parent),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        // Informational only; the engine re-filters. See the header.
        ...(options.query === undefined ? {} : { query: stringifyQuery(options.query) }),
        ...(options.sort === undefined ? {} : { sort: options.sort }),
      },
      options.signal,
    );
    return decodeListPage(raw, 'list');
  }

  async resolveChild(
    parent: VNode | null,
    name: string,
    options?: { signal?: AbortSignal },
  ): Promise<VNode | undefined> {
    let raw: unknown;
    try {
      raw = await this.#call('resolveChild', { parent: wireNode(parent), name }, options?.signal);
    } catch (error) {
      // Optional method. Absence must fall back to paging, not fail the lookup.
      if (error instanceof VfsError && (error.code === 'ENOTSUP' || error.code === 'ENOENT')) return undefined;
      throw error;
    }
    if (raw === null || raw === undefined) return undefined;
    return decodeNode(raw, 'resolveChild');
  }

  async read(node: VNode, options: ReadOptions): Promise<ReturnType<typeof decodeDocument>> {
    const raw = await this.#call(
      'read',
      { node: wireNode(node), ...(options.format === undefined ? {} : { format: options.format }) },
      options.signal,
    );
    return decodeDocument(raw, node.title);
  }

  async #searchImpl(parent: VNode | null, query: Parameters<typeof stringifyQuery>[0], options: ListOptions): Promise<ListPage> {
    const raw = await this.#call(
      'search',
      {
        parent: wireNode(parent),
        query: stringifyQuery(query),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      },
      options.signal,
    );
    return decodeListPage(raw, 'search');
  }

  async #pollImpl(parent: VNode | null, cursor: string | undefined, options: PollOptions): Promise<PollResult> {
    const raw = await this.#call(
      'poll',
      { parent: wireNode(parent), ...(cursor === undefined ? {} : { cursor }) },
      options.signal,
    );
    return decodePollResult(raw);
  }

  async #actionsImpl(node: VNode): Promise<readonly ActionDescriptor[]> {
    const raw = await this.#call('actions', { node: wireNode(node) });
    return decodeActions(raw);
  }

  async #invokeImpl(
    action: string,
    node: VNode,
    params: Readonly<Record<string, MetaValue>>,
  ): Promise<ActionResult> {
    const raw = await this.#call('invoke', { action, node: wireNode(node), params });
    return decodeActionResult(raw, action);
  }

  async #readAttachmentImpl(node: VNode, attachmentId: string): Promise<{ name: string; contentType: string; data: Uint8Array }> {
    const raw = await this.#call('readAttachment', { node: wireNode(node), attachmentId });
    return decodeAttachmentBytes(raw);
  }

  /**
   * Make the object's shape match what the plugin says it can do.
   *
   * A proxy is tempting to write with every method always present, deferring the "not
   * supported" answer to call time. That is a trap: anything that feature-detects with
   * `typeof provider.search === 'function'` — the engine's own capability checks aside,
   * that includes third-party tooling and future code in this repo — would see a method the
   * plugin never promised, and the failure would surface as a runtime error deep inside a
   * search instead of a clean "this mount cannot search".
   *
   * Called once from the constructor with the configured defaults, and again after the
   * handshake, because that is when the truth arrives.
   */
  #syncMethods(): void {
    const has = (capability: Capability): boolean => this.#capabilities.has(capability);

    // `delete` rather than assigning `undefined`: an own property whose value is undefined
    // still answers true to `'search' in provider`, which is exactly the feature detection
    // this is meant to keep honest.
    if (has('search')) this.search = (parent, query, options) => this.#searchImpl(parent, query, options);
    else delete this.search;

    if (has('poll')) this.poll = (parent, cursor, options) => this.#pollImpl(parent, cursor, options);
    else delete this.poll;

    if (has('attachments')) this.readAttachment = (node, id) => this.#readAttachmentImpl(node, id);
    else delete this.readAttachment;

    if (has('actions')) {
      this.actions = (node) => this.#actionsImpl(node);
      this.invoke = (action, node, params) => this.#invokeImpl(action, node, params);
    } else {
      delete this.actions;
      delete this.invoke;
    }
  }

  async #call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.init();
    return this.#client.call(method, params, signal);
  }
}

/**
 * Trim a node down to what a plugin needs.
 *
 * `id` is the only field a plugin should key off; the rest is context so it can log
 * something legible. Engine-populated fields (`path`) are included because they are useful
 * for logging, but the contract is explicit that identity is `id`.
 */
function wireNode(node: VNode | null): Record<string, unknown> | null {
  if (node === null) return null;
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    title: node.title,
    ...(node.subtype === undefined ? {} : { subtype: node.subtype }),
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.meta === undefined ? {} : { meta: node.meta }),
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const execPlugin: ProviderPlugin<ExecProviderOptions> = {
  type: 'exec',
  displayName: 'External program',
  description: 'Run any program that speaks line-delimited JSON on stdio.',

  validateOptions(raw: unknown): ExecProviderOptions {
    if (typeof raw !== 'object' || raw === null) {
      throw VfsError.config('An exec mount needs options.', 'Add "options": { "command": ["my-plugin"] }.');
    }
    const options = raw as Record<string, unknown>;
    const command = normalizeCommand(options['command']);
    const capabilities = normalizeCapabilities(options['capabilities']);
    const env = normalizeEnv(options['env']);
    const timeout = options['timeout'];
    if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
      throw VfsError.config('"timeout" must be a positive number of seconds.');
    }
    if (options['shell'] !== undefined) {
      // Worth an explicit error rather than silent ignoring: someone who wrote this
      // believed it would work, and their plugin will not run without knowing why.
      throw VfsError.config(
        '"shell" is not supported for exec mounts.',
        'Give "command" as an array, e.g. ["python", "feed.py"]. Nothing is passed through a shell, on purpose.',
      );
    }
    return {
      command,
      ...(typeof options['cwd'] === 'string' ? { cwd: options['cwd'] } : {}),
      ...(env === undefined ? {} : { env }),
      ...(typeof options['oneshot'] === 'boolean' ? { oneshot: options['oneshot'] } : {}),
      ...(typeof timeout === 'number' ? { timeout } : {}),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(typeof options['displayName'] === 'string' ? { displayName: options['displayName'] } : {}),
    };
  },

  create(options: ExecProviderOptions, context: ProviderContext): Provider {
    return new ExecProvider(options, context);
  },
};

function normalizeCommand(raw: unknown): readonly string[] {
  if (typeof raw === 'string') {
    // Accepted, but only when it is a bare program name with no arguments. Splitting a
    // command string correctly is a genuinely hard problem (quoting, escapes, Windows vs
    // POSIX rules) and getting it subtly wrong here would be a security bug, not a bug.
    if (/[\s"'`$|&;<>()]/.test(raw)) {
      throw VfsError.config(
        '"command" must be an array when it has arguments.',
        `Write "command": ["${raw.split(/\s+/)[0] ?? 'program'}", "..."] instead of one string. Arguments are never split by a shell.`,
      );
    }
    return [raw];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw VfsError.config('An exec mount needs a "command" array.', 'For example: "command": ["python", "feed.py"].');
  }
  const command = raw.map((item) => {
    if (typeof item !== 'string') {
      throw VfsError.config('Every entry in "command" must be a string.');
    }
    return item;
  });
  return command;
}

function normalizeCapabilities(raw: unknown): readonly Capability[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw VfsError.config('"capabilities" must be an array.');
  return raw.map((item) => {
    if (typeof item !== 'string' || !(CAPABILITIES as readonly string[]).includes(item)) {
      throw VfsError.config(
        `"${String(item)}" is not a capability.`,
        `Known capabilities: ${CAPABILITIES.join(', ')}.`,
      );
    }
    return item as Capability;
  });
}

function normalizeEnv(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw VfsError.config('"env" must be an object of name/value pairs.');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw VfsError.config(`Environment variable "${key}" must be a string.`);
    out[key] = value;
  }
  return out;
}
