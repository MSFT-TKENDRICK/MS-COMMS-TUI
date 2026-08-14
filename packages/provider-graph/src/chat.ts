/**
 * Microsoft Teams and Outlook chats as a filesystem.
 *
 * Layout:
 *
 *   /teams/Chats/<chat name>/<timestamp> <author> — <preview>.md
 *   /teams/Teams/<team>/<channel>/<timestamp> <author> — <topic>/     (a thread)
 *                                                        000 <author>.md   (the root post)
 *                                                        001 <author>.md   (a reply)
 *
 * The thread-as-directory shape is the interesting decision. Teams conversations are
 * genuinely a tree, and the alternatives — one flat file per message, or one giant file
 * per channel — either destroy the reply structure or make it impossible to address a
 * single message. Plan 9's upas/fs represented a multipart message as a directory for the
 * same reason.
 *
 * Every Teams call is wrapped so a 403 degrades to an explanatory empty listing rather
 * than killing the mount. Teams application permissions are frequently withheld by tenant
 * administrators, and a user whose chats work but whose channels do not should still have
 * a working tool.
 */

import {
  ActionRegistry,
  VfsError,
  isVfsError,
  metaText,
  requiredText,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
  type Capability,
  type ChangeEvent,
  type Document,
  type ListOptions,
  type ListPage,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type Query,
  type ReadOptions,
  type MetaValue,
  type VNode,
} from '@mscomms/core';
import type { GraphApi, GraphPage } from './client.js';
import {
  createClient,
  GRAPH_SHARED_OPTION_KEYS,
  htmlToText,
  preview,
  validateSharedOptions,
  type GraphSharedOptions,
} from './shared.js';

export interface GraphChatOptions extends GraphSharedOptions {
  /** Skip the Teams/channels tree entirely; useful when the tenant blocks those scopes. */
  readonly chatsOnly?: boolean;
  readonly pageSize?: number;
  /** Cap on replies fetched per thread. */
  readonly maxReplies?: number;
  /**
   * Enable the actions that write: sending new chat and channel messages.
   *
   * Off by default. A tool that reads corporate Teams messages is easy to justify
   * installing; a tool that can speak as you is a different conversation, and it should be
   * one the user opts into rather than discovers.
   */
  readonly allowSend?: boolean;
}

interface Chat {
  readonly id: string;
  readonly topic: string | null;
  readonly chatType: string;
  readonly lastUpdatedDateTime: string | null;
  readonly members?: ReadonlyArray<{ displayName?: string }>;
  /**
   * Where you had read up to. This is the only read state Teams exposes — there is no unread
   * count on a chat, and none on a channel at all — so it is the whole basis for the counter.
   */
  readonly viewpoint?: { readonly lastMessageReadDateTime?: string | null; readonly isHidden?: boolean } | null;
  readonly lastMessagePreview?: {
    readonly createdDateTime?: string | null;
    readonly body?: { readonly content?: string | null } | null;
    readonly from?: { readonly user?: { readonly displayName?: string | null; readonly id?: string | null } | null } | null;
  } | null;
}

interface Team {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
}

interface Channel {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly membershipType: string;
}

interface ChatMessage {
  readonly id: string;
  readonly messageType: string;
  readonly createdDateTime: string;
  readonly lastModifiedDateTime: string | null;
  readonly deletedDateTime: string | null;
  readonly subject: string | null;
  readonly importance: string;
  readonly webUrl: string | null;
  readonly replyToId: string | null;
  readonly from?: { user?: { displayName?: string; id?: string }; application?: { displayName?: string } };
  readonly body?: { contentType?: string; content?: string };
  readonly attachments?: ReadonlyArray<{ id?: string; name?: string; contentType?: string; contentUrl?: string }>;
  readonly mentions?: ReadonlyArray<{ mentionText?: string }>;
  readonly reactions?: ReadonlyArray<{ reactionType?: string }>;
}

export class GraphChatProvider implements Provider {
  readonly id: string;
  readonly displayName = 'Teams and chats';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll', 'actions']);

  readonly #options: GraphChatOptions;
  readonly #context: ProviderContext;
  readonly #registry = new ActionRegistry<GraphChatProvider>([
    {
      descriptor: {
        name: 'send',
        label: 'Send a message',
        description: 'Post a new Teams message here.',
        group: 'reply',
        key: 's',
        params: [{ name: 'body', type: 'text', label: 'Message', required: true }],
      },
      applies: (node) => node.subtype === 'chat' || node.subtype === 'channel' || node.subtype === 'thread',
      run: ({ node, params, context }) => context.#send(node, params),
    },
    {
      descriptor: {
        name: 'reply',
        label: 'Reply',
        description: 'Reply in the containing chat or thread.',
        group: 'reply',
        key: 'r',
        params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
      },
      applies: (node) => isMessageNode(node),
      run: ({ node, params, context }) => context.#reply(node, params),
    },
    {
      descriptor: { name: 'url', label: 'Show the web URL', description: 'Print the Teams web link.', group: 'link', key: 'u' },
      applies: (node) => typeof node.meta?.['webUrl'] === 'string' || typeof node.meta?.['webLink'] === 'string',
      run: ({ node, context }) => context.#urlAction(node),
    },
  ]);
  #client: GraphApi | undefined;
  #me: Promise<string | undefined> | undefined;

  constructor(options: GraphChatOptions, context: ProviderContext, client?: GraphApi) {
    this.#options = options;
    this.#context = context;
    this.id = `graph-chat:${context.mountPath}`;
    this.#client = client;
  }

  async init(): Promise<void> {
    this.#client ??= createClient(this.#options, this.#context.state, this.#context.logger);
  }

  /** Bring the transport up in the background. See `Provider.warm`. */
  async warm(): Promise<void> {
    await this.#client?.warm?.();
  }

  get #api(): GraphApi {
    if (this.#client === undefined) throw VfsError.config('The Teams mount was not initialised.');
    return this.#client;
  }

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    if (parent === null) {
      const roots: VNode[] = [
        {
          name: 'Chats',
          kind: 'dir',
          subtype: 'section',
          title: 'Chats',
          id: 'section:chats',
          meta: { section: 'chats' },
        },
      ];
      if (this.#options.chatsOnly !== true) {
        roots.push({
          name: 'Teams',
          kind: 'dir',
          subtype: 'section',
          title: 'Teams',
          id: 'section:teams',
          meta: { section: 'teams' },
        });
      }
      return { entries: roots };
    }

    switch (parent.subtype) {
      case 'section':
        return parent.meta?.['section'] === 'chats' ? this.#listChats(options) : this.#listTeams(options);
      case 'chat':
        return this.#listChatMessages(parent, options);
      case 'team':
        return this.#listChannels(parent, options);
      case 'channel':
        return this.#listThreads(parent, options);
      case 'thread':
        return this.#listReplies(parent, options);
      default:
        throw VfsError.notDirectory(parent.path ?? parent.name);
    }
  }

  // -------------------------------------------------------------------------

  async #listChats(options: ListOptions): Promise<ListPage> {
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.pageSize ?? 50, 50));
    // `$expand=members`, not `$expand=members($select=displayName)`: Graph rejects a nested
    // `$select` inside an expand on this collection outright, with a 400 that takes the whole
    // listing down. Expanding the whole member is a few hundred bytes more per chat and is
    // what makes a group chat nameable at all.
    //
    // `lastMessagePreview` is expanded because it is what the list is *sorted* by, and
    // showing `lastUpdatedDateTime` instead made a correctly ordered list look shuffled: that
    // field tracks roster and topic edits, so a chat last spoken in minutes ago can carry a
    // six-month-old date. Sorting by one field and displaying another is indistinguishable
    // from not sorting at all.
    const page = await this.#api.getPage<Chat>(
      options.cursor ??
        `/me/chats?$expand=members,lastMessagePreview&$top=${String(limit)}&$orderby=lastMessagePreview/createdDateTime desc`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const me = await this.#selfId(options.signal);
    return {
      entries: page.value.map((chat) => chatNode(chat, me)),
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  async #listTeams(options: ListOptions): Promise<ListPage> {
    const page = await this.#degrade(
      () => this.#api.getPage<Team>('/me/joinedTeams', options.signal === undefined ? {} : { signal: options.signal }),
      'joined teams',
    );
    if (page === undefined) return { entries: [] };
    return {
      entries: page.value.map((team) => ({
        name: team.displayName,
        kind: 'dir' as const,
        subtype: 'team',
        title: team.displayName,
        id: team.id,
        ...(team.description === null || team.description === undefined ? {} : { summary: team.description }),
      })),
    };
  }

  async #listChannels(parent: VNode, options: ListOptions): Promise<ListPage> {
    const page = await this.#degrade(
      () =>
        this.#api.getPage<Channel>(
          `/teams/${encodeURIComponent(parent.id)}/channels`,
          options.signal === undefined ? {} : { signal: options.signal },
        ),
      `channels in ${parent.title}`,
    );
    if (page === undefined) return { entries: [] };
    return {
      entries: page.value.map((channel) => ({
        name: channel.displayName,
        kind: 'dir' as const,
        subtype: 'channel',
        title: channel.displayName,
        id: channel.id,
        ...(channel.description === null || channel.description === undefined
          ? {}
          : { summary: channel.description }),
        meta: { teamId: parent.id, membershipType: channel.membershipType },
      })),
    };
  }

  async #listChatMessages(parent: VNode, options: ListOptions): Promise<ListPage> {
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.pageSize ?? 50, 50));
    const page = await this.#api.getPage<ChatMessage>(
      options.cursor ?? `/me/chats/${encodeURIComponent(parent.id)}/messages?$top=${String(limit)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    // The chat carried its own read watermark down from the listing, so the messages can be
    // marked without asking Graph a second time.
    const readUpTo = watermarkOf(parent);
    const me = await this.#selfId(options.signal);
    return {
      entries: page.value
        .filter(isVisible)
        .map((message) => messageFileNode(message, { chatId: parent.id }, isUnread(message, readUpTo, me))),
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  /**
   * The signed-in user's id, fetched once.
   *
   * Needed only to answer "did I write this", which is what stops your own messages counting
   * as unread to you — Graph moves the read watermark lazily, so without this the last thing
   * you said in a chat routinely reads back as something new. One `/me` per session, and a
   * failure degrades to `undefined` rather than taking the listing down with it: the cost of
   * being wrong here is one over-counted message, which is not worth a broken chat list.
   */
  async #selfId(signal?: AbortSignal): Promise<string | undefined> {
    this.#me ??= this.#api
      .get<{ id?: string }>('/me', signal === undefined ? {} : { signal })
      .then((user) => user.id)
      .catch((error: unknown) => {
        this.#me = undefined;
        this.#context.logger.debug('could not identify the signed-in user', { message: String(error) });
        return undefined;
      });
    return this.#me;
  }

  /**
   * A channel's children are its threads. Graph models a thread as a root message plus a
   * `replies` collection, so the root message doubles as the directory: it carries the
   * topic, the author and the timestamp that make a speakable name.
   */
  async #listThreads(parent: VNode, options: ListOptions): Promise<ListPage> {
    const teamId = parent.meta?.['teamId'];
    if (typeof teamId !== 'string') throw VfsError.invalid('That channel is missing its team id.');
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.pageSize ?? 30, 50));

    const page = await this.#degrade(
      () =>
        this.#api.getPage<ChatMessage>(
          options.cursor ??
            `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(parent.id)}/messages?$top=${String(limit)}`,
          options.signal === undefined ? {} : { signal: options.signal },
        ),
      `messages in ${parent.title}`,
    );
    if (page === undefined) return { entries: [] };

    return {
      entries: page.value.filter(isVisible).map((message) => threadNode(message, teamId, parent.id)),
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  async #listReplies(parent: VNode, options: ListOptions): Promise<ListPage> {
    const teamId = parent.meta?.['teamId'];
    const channelId = parent.meta?.['channelId'];
    if (typeof teamId !== 'string' || typeof channelId !== 'string') {
      throw VfsError.invalid('That thread is missing its team or channel id.');
    }
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.maxReplies ?? 50, 50));

    const page = await this.#degrade(
      () =>
        this.#api.getPage<ChatMessage>(
          options.cursor ??
            `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(parent.id)}/replies?$top=${String(limit)}`,
          options.signal === undefined ? {} : { signal: options.signal },
        ),
      `replies in ${parent.title}`,
    );

    // The root post is the thread's own content and belongs in the listing, numbered
    // first, so `cat 1` reads the thing the thread is named after.
    const root: VNode = {
      name: `000 ${parent.author ?? 'unknown'}.md`,
      kind: 'file',
      subtype: 'post',
      title: parent.title,
      id: parent.id,
      ...(parent.mtime === undefined ? {} : { mtime: parent.mtime }),
      ...(parent.author === undefined ? {} : { author: parent.author }),
      ...(parent.summary === undefined ? {} : { summary: parent.summary }),
      meta: { teamId, channelId, root: true },
    };

    const replies = (page?.value ?? [])
      .filter(isVisible)
      .slice()
      .sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime))
      .map((message, index) => {
        const node = messageFileNode(message, { teamId, channelId, threadId: parent.id });
        const author = node.author ?? 'unknown';
        return { ...node, name: `${String(index + 1).padStart(3, '0')} ${author}.md`, subtype: 'reply' };
      });

    return {
      entries: [root, ...replies],
      ...(page?.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  // -------------------------------------------------------------------------

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    if (node.kind === 'dir' && node.subtype !== 'thread') throw VfsError.isDirectory(node.path ?? node.name);

    const path = this.#messagePath(node);
    const message = await this.#api.get<ChatMessage>(
      path,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const raw = message.body?.content ?? '';
    const body = (message.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw;
    const author = authorOf(message);

    const headers: Array<readonly [string, string]> = [
      ['From', author],
      ['Date', new Date(message.createdDateTime).toISOString()],
    ];
    if (message.subject !== null && message.subject !== undefined && message.subject !== '') {
      headers.push(['Subject', message.subject]);
    }
    if (message.lastModifiedDateTime !== null && message.lastModifiedDateTime !== undefined) {
      const edited = Date.parse(message.lastModifiedDateTime);
      if (Number.isFinite(edited) && edited - Date.parse(message.createdDateTime) > 1000) {
        headers.push(['Edited', new Date(edited).toISOString()]);
      }
    }
    const reactions = (message.reactions ?? []).length;
    if (reactions > 0) headers.push(['Reactions', String(reactions)]);

    const attachments = (message.attachments ?? []).filter((a) => a.name !== undefined && a.name !== '');

    return {
      title: message.subject ?? `${author}: ${preview(body, 60)}`,
      headers,
      body: body === '' ? '(no text content)' : body,
      format: 'text',
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((a) => ({
              id: a.id ?? a.name ?? 'attachment',
              name: a.name ?? 'attachment',
              ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
            })),
          }),
      ...(message.webUrl === null || message.webUrl === undefined ? {} : { webUrl: message.webUrl }),
    };
  }

  #messagePath(node: VNode): string {
    const chatId = node.meta?.['chatId'];
    if (typeof chatId === 'string') {
      return `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(node.id)}`;
    }
    const teamId = node.meta?.['teamId'];
    const channelId = node.meta?.['channelId'];
    const threadId = node.meta?.['threadId'];
    if (typeof teamId !== 'string' || typeof channelId !== 'string') {
      throw VfsError.invalid('That message is missing the ids needed to fetch it.');
    }
    const base = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
    if (typeof threadId === 'string' && threadId !== node.id) {
      return `${base}/${encodeURIComponent(threadId)}/replies/${encodeURIComponent(node.id)}`;
    }
    return `${base}/${encodeURIComponent(node.id)}`;
  }

  async search(_parent: VNode | null, _query: Query, _options: ListOptions): Promise<ListPage> {
    // Deliberately absent from `capabilities`. Graph has no supported message-search
    // endpoint for chats on delegated permissions, and pretending otherwise would mean
    // silently walking every chat — slow, throttled, and surprising. The engine's own
    // walk-and-filter fallback handles `find` correctly and visibly.
    throw VfsError.unsupported('Server-side search', this.id);
  }

  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    if (parent === null || parent.subtype !== 'chat') {
      throw VfsError.unsupported('Watching anything other than a chat', this.id);
    }

    const start = cursor ?? `/chats/${encodeURIComponent(parent.id)}/messages/delta`;
    let link: string | undefined = start;
    const changes: ChangeEvent[] = [];
    let deltaLink: string | undefined;
    let guard = 0;

    while (link !== undefined && guard < 10) {
      guard += 1;
      const page: GraphPage<ChatMessage> = await this.#api.getPage<ChatMessage>(
        link,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      for (const message of page.value.filter(isVisible)) {
        const node = messageFileNode(message, { chatId: parent.id });
        changes.push({ type: 'created', path: node.name, node, at: new Date(message.createdDateTime) });
      }
      deltaLink = page.deltaLink;
      link = page.nextLink;
    }

    return { changes, ...(deltaLink === undefined ? {} : { cursor: deltaLink }) };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async actions(node: VNode): Promise<readonly ActionDescriptor[]> {
    return this.#registry.descriptors(node, this);
  }

  async invoke(action: string, node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    return this.#registry.invoke(action, node, params, this, this.id);
  }

  /**
   * The gate on everything that writes.
   *
   * Named as one place rather than repeated per action so there is no way to add a writing
   * action later and forget it, and so the message can name both halves of what is needed:
   * the config switch *and* the Graph scopes, because having one without the other produces
   * a failure that is otherwise very hard to diagnose.
   */
  #requireSend(action: string): void {
    if (this.#options.allowSend === true) return;
    throw new VfsError('ENOTSUP', `"${action}" is disabled: the ${this.id} mount is read-only.`, {
      hint:
        'Set "allowSend": true on this mount in your config, then re-run `login` so consent ' +
        'covers Chat.ReadWrite and ChatMessage.Send.',
    });
  }

  async #send(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    this.#requireSend('send');
    const body = requiredText(params, 'body');
    await this.#api.post(postTargetOf(node), { body: { contentType: 'text', content: body } });
    return { ok: true, message: `Sent a message to "${node.title}".`, invalidates: [node.path ?? node.name] };
  }

  async #reply(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    this.#requireSend('reply');
    const body = requiredText(params, 'body');
    await this.#api.post(replyTargetOf(node), { body: { contentType: 'text', content: body } });
    return { ok: true, message: `Replied to "${node.title}".`, invalidates: [parentOf(node)] };
  }

  async #urlAction(node: VNode): Promise<ActionResult> {
    const web = node.meta?.['webUrl'] ?? node.meta?.['webLink'];
    if (typeof web === 'string') return { ok: true, message: web };
    return { ok: true, message: metaText(node, 'webUrl') };
  }

  /**
   * Run a Teams call, converting "the tenant will not let you do this" into an empty
   * result plus one warning, rather than an error that takes the whole mount down.
   */
  async #degrade<T>(operation: () => Promise<T>, what: string): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (isVfsError(error) && (error.code === 'EACCES' || error.code === 'ENOTSUP')) {
        this.#context.logger.warn(`no permission to read ${what}`, { hint: error.hint });
        return undefined;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------

function isVisible(message: ChatMessage): boolean {
  // systemEventMessage is "X added Y to the chat" noise with an empty body; deleted
  // messages are tombstones. Neither is worth a line in a listing.
  if (message.deletedDateTime !== null && message.deletedDateTime !== undefined) return false;
  return message.messageType === 'message';
}

function isMessageNode(node: VNode): boolean {
  return node.kind === 'file' && (node.subtype === 'post' || node.subtype === 'reply');
}

function postTargetOf(node: VNode): string {
  if (node.subtype === 'chat') return `/chats/${encodeURIComponent(node.id)}/messages`;

  const teamId = node.meta?.['teamId'];
  const channelId = node.subtype === 'channel' ? node.id : node.meta?.['channelId'];
  if (typeof teamId !== 'string' || typeof channelId !== 'string') {
    throw VfsError.invalid(
      'That Teams location is missing the ids needed to post into it.',
      'Refresh the listing and try the action from the chat, channel or thread node again.',
    );
  }
  const channel = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
  if (node.subtype === 'thread') return `${channel}/${encodeURIComponent(node.id)}/replies`;
  return channel;
}

function replyTargetOf(node: VNode): string {
  const chatId = node.meta?.['chatId'];
  if (typeof chatId === 'string') return `/chats/${encodeURIComponent(chatId)}/messages`;

  const teamId = node.meta?.['teamId'];
  const channelId = node.meta?.['channelId'];
  const threadId = node.meta?.['threadId'];
  if (typeof teamId !== 'string' || typeof channelId !== 'string') {
    throw VfsError.invalid(
      'That Teams message is missing the ids needed to reply to it.',
      'Refresh the listing and try the action from the message again.',
    );
  }
  const root = typeof threadId === 'string' ? threadId : node.id;
  return `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(root)}/replies`;
}

function parentOf(node: VNode): string {
  const path = node.path;
  if (path === undefined) return node.name;
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? path : path.slice(0, slash);
}

function authorOf(message: ChatMessage): string {
  return (
    message.from?.user?.displayName ??
    message.from?.application?.displayName ??
    '(system)'
  );
}

function chatNode(chat: Chat, meId: string | undefined): VNode {
  const names = (chat.members ?? [])
    .map((member) => member.displayName)
    .filter((name): name is string => name !== undefined && name !== '');
  const label =
    chat.topic !== null && chat.topic !== undefined && chat.topic !== ''
      ? chat.topic
      : names.length === 0
        ? 'Chat'
        : names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${String(names.length - 3)} more` : '');

  // The time of the last message, falling back to the roster/topic timestamp only when the
  // preview is missing. This is the field the list is ordered by, so showing anything else
  // makes a sorted list look shuffled.
  const spoke = chat.lastMessagePreview?.createdDateTime;
  const stamp = spoke !== null && spoke !== undefined && spoke !== '' ? spoke : chat.lastUpdatedDateTime;
  const said = summaryOf(chat);
  const who = chat.lastMessagePreview?.from?.user?.displayName;

  const readUpTo = parseWatermark(chat.viewpoint?.lastMessageReadDateTime);
  // Flagged, but deliberately not counted. Teams will tell you *that* a chat has moved since
  // you last read it and never *how far*, so the flag is the honest end of what one listing
  // knows. The number arrives once the messages themselves have been listed, and the engine
  // totals them onto this row — a claim of "1 unread" here would be a guess dressed as a
  // count.
  const unread = isUnread(
    {
      createdDateTime: spoke ?? '',
      from: { user: { ...(chat.lastMessagePreview?.from?.user?.id == null ? {} : { id: chat.lastMessagePreview.from.user.id }) } },
    },
    readUpTo,
    meId,
  );

  return {
    name: label,
    kind: 'dir',
    subtype: 'chat',
    title: label,
    id: chat.id,
    ...(stamp === null || stamp === undefined ? {} : { mtime: new Date(stamp) }),
    ...(said === undefined ? {} : { summary: said }),
    ...(who === null || who === undefined || who === '' ? {} : { author: who }),
    ...(unread ? { flags: ['unread'] } : {}),
    meta: {
      chatType: chat.chatType,
      ...(readUpTo === undefined ? {} : { readUpTo: new Date(readUpTo).toISOString() }),
    },
  };
}

/** The read watermark a chat directory carried down to its messages. */
function watermarkOf(node: VNode): number | undefined {
  const raw = node.meta?.['readUpTo'];
  return typeof raw === 'string' ? parseWatermark(raw) : undefined;
}

function parseWatermark(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Whether a message arrived after you last read the chat.
 *
 * A missing watermark means Teams has no record of you reading this chat, which is treated
 * as unread — it is the state a chat is in before you have ever opened it. Your own messages
 * never count: Graph updates the watermark lazily, so the last thing you said would otherwise
 * come back as something new every time.
 */
function isUnread(
  message: { readonly createdDateTime: string; readonly from?: { user?: { id?: string } } },
  readUpTo: number | undefined,
  meId: string | undefined,
): boolean {
  const at = Date.parse(message.createdDateTime);
  if (!Number.isFinite(at)) return false;
  const from = message.from?.user?.id;
  if (meId !== undefined && from !== undefined && from === meId) return false;
  return readUpTo === undefined || at > readUpTo;
}

/** The last thing said in a chat, as one line, for the listing. */
function summaryOf(chat: Chat): string | undefined {
  const body = chat.lastMessagePreview?.body?.content;
  if (body === null || body === undefined || body === '') return undefined;
  const text = preview(htmlToText(body));
  return text === '' ? undefined : text;
}

function threadNode(message: ChatMessage, teamId: string, channelId: string): VNode {
  const created = new Date(message.createdDateTime);
  const author = authorOf(message);
  const bodyText =
    (message.body?.contentType ?? '').toLowerCase() === 'html'
      ? htmlToText(message.body?.content ?? '')
      : (message.body?.content ?? '');
  const topic =
    message.subject !== null && message.subject !== undefined && message.subject !== ''
      ? message.subject
      : preview(bodyText, 70);

  const flags: string[] = [];
  if ((message.mentions ?? []).length > 0) flags.push('mention');
  if (message.importance === 'high' || message.importance === 'urgent') flags.push('important');

  return {
    name: `${timestampPrefix(created)} ${author} — ${topic === '' ? '(no text)' : topic}`,
    kind: 'dir',
    subtype: 'thread',
    title: topic === '' ? `${author} (no text)` : topic,
    id: message.id,
    mtime: created,
    author,
    ...(flags.length === 0 ? {} : { flags }),
    ...(bodyText === '' ? {} : { summary: preview(bodyText) }),
    meta: {
      teamId,
      channelId,
      ...(message.webUrl === null || message.webUrl === undefined ? {} : { webUrl: message.webUrl }),
    },
  };
}

function messageFileNode(
  message: ChatMessage,
  scope: { chatId?: string; teamId?: string; channelId?: string; threadId?: string },
  unread = false,
): VNode {
  const created = new Date(message.createdDateTime);
  const author = authorOf(message);
  const bodyText =
    (message.body?.contentType ?? '').toLowerCase() === 'html'
      ? htmlToText(message.body?.content ?? '')
      : (message.body?.content ?? '');
  const topic =
    message.subject !== null && message.subject !== undefined && message.subject !== ''
      ? message.subject
      : preview(bodyText, 60);

  const flags: string[] = [];
  if (unread) flags.push('unread');
  if ((message.mentions ?? []).length > 0) flags.push('mention');
  if ((message.attachments ?? []).length > 0) flags.push('attachment');
  if (message.importance === 'high' || message.importance === 'urgent') flags.push('important');
  if (message.replyToId !== null && message.replyToId !== undefined) flags.push('reply');

  return {
    name: `${timestampPrefix(created)} ${author} — ${topic === '' ? '(no text)' : topic}.md`,
    kind: 'file',
    subtype: 'post',
    title: topic === '' ? `${author} (no text)` : topic,
    id: message.id,
    mtime: created,
    author,
    ...(message.from?.user?.id === undefined ? {} : { authorId: message.from.user.id }),
    ...(flags.length === 0 ? {} : { flags }),
    ...(bodyText === '' ? {} : { summary: preview(bodyText) }),
    meta: {
      ...(scope.chatId === undefined ? {} : { chatId: scope.chatId }),
      ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
      ...(scope.channelId === undefined ? {} : { channelId: scope.channelId }),
      ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
      ...(message.webUrl === null || message.webUrl === undefined ? {} : { webUrl: message.webUrl }),
    },
  };
}

export const graphChatPlugin: ProviderPlugin<GraphChatOptions> = {
  type: 'graph-chat',
  displayName: 'Teams and chats (Microsoft Graph)',
  description: 'Chats, teams, channels and threads as directories; messages as files.',
  optionKeys: [...GRAPH_SHARED_OPTION_KEYS, 'chatsOnly', 'pageSize', 'maxReplies'],
  validateOptions(raw) {
    validateSharedOptions(raw);
    return (raw ?? {}) as GraphChatOptions;
  },
  create(options, context) {
    return new GraphChatProvider(options, context);
  },
};
