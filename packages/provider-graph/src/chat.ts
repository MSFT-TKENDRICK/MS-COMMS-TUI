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
  VfsError,
  isVfsError,
  timestampPrefix,
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
  type VNode,
} from '@mscomms/core';
import type { GraphClient, GraphPage } from './client.js';
import {
  createClient,
  GRAPH_SHARED_OPTION_KEYS,
  htmlToText,
  preview,
  type GraphSharedOptions,
} from './shared.js';

export interface GraphChatOptions extends GraphSharedOptions {
  /** Skip the Teams/channels tree entirely; useful when the tenant blocks those scopes. */
  readonly chatsOnly?: boolean;
  readonly pageSize?: number;
  /** Cap on replies fetched per thread. */
  readonly maxReplies?: number;
}

interface Chat {
  readonly id: string;
  readonly topic: string | null;
  readonly chatType: string;
  readonly lastUpdatedDateTime: string | null;
  readonly members?: ReadonlyArray<{ displayName?: string }>;
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
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['list', 'read', 'poll']);

  readonly #options: GraphChatOptions;
  readonly #context: ProviderContext;
  #client: GraphClient | undefined;

  constructor(options: GraphChatOptions, context: ProviderContext) {
    this.#options = options;
    this.#context = context;
    this.id = `graph-chat:${context.mountPath}`;
  }

  async init(): Promise<void> {
    this.#client = createClient(this.#options, this.#context.state, this.#context.logger);
  }

  get #api(): GraphClient {
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
    const page = await this.#api.getPage<Chat>(
      options.cursor ??
        `/me/chats?$expand=members($select=displayName)&$top=${String(limit)}&$orderby=lastMessagePreview/createdDateTime desc`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return {
      entries: page.value.map((chat) => chatNode(chat)),
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
    return {
      entries: page.value.filter(isVisible).map((message) => messageFileNode(message, { chatId: parent.id })),
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
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

function authorOf(message: ChatMessage): string {
  return (
    message.from?.user?.displayName ??
    message.from?.application?.displayName ??
    '(system)'
  );
}

function chatNode(chat: Chat): VNode {
  const names = (chat.members ?? [])
    .map((member) => member.displayName)
    .filter((name): name is string => name !== undefined && name !== '');
  const label =
    chat.topic !== null && chat.topic !== undefined && chat.topic !== ''
      ? chat.topic
      : names.length === 0
        ? 'Chat'
        : names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${String(names.length - 3)} more` : '');

  return {
    name: label,
    kind: 'dir',
    subtype: 'chat',
    title: label,
    id: chat.id,
    ...(chat.lastUpdatedDateTime === null || chat.lastUpdatedDateTime === undefined
      ? {}
      : { mtime: new Date(chat.lastUpdatedDateTime) }),
    meta: { chatType: chat.chatType },
  };
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
    return (raw ?? {}) as GraphChatOptions;
  },
  create(options, context) {
    return new GraphChatProvider(options, context);
  },
};
