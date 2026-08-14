/**
 * Outlook mail as a filesystem.
 *
 * The mapping is the obvious one, which is the point: mail folders are directories,
 * messages are files, and a message's attachments hang off it. Plan 9's `upas/fs` reached
 * the same conclusion in 1995 and it has not been improved on.
 *
 * The two hard parts are both about scale:
 *
 *   - Listing is capped and cursor-paged. A real mailbox has six figures of messages, and
 *     the classic FUSE-mail-filesystem failure is that a bare `ls` tries to enumerate all
 *     of them and hangs the terminal for minutes.
 *   - Change detection uses Graph's `delta()` links, persisted across restarts, so
 *     re-opening the tool does not replay the whole mailbox as "new".
 */

import {
  ActionRegistry,
  VfsError,
  metaText,
  optionalText,
  requiredText,
  timestampPrefix,
  type ActionDescriptor,
  type ActionResult,
  type Capability,
  type ChangeEvent,
  type Document,
  type ListOptions,
  type ListPage,
  type MetaValue,
  type PollResult,
  type Provider,
  type ProviderContext,
  type ProviderPlugin,
  type Query,
  type ReadOptions,
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

export interface GraphMailOptions extends GraphSharedOptions {
  /** Include folders Outlook hides by default (Conversation History, and similar). */
  readonly includeHiddenFolders?: boolean;
  readonly pageSize?: number;
  /**
   * Enable the actions that write: replying, forwarding, marking read, flagging and moving.
   *
   * Off by default. A tool that reads corporate mail is easy to justify installing; a tool
   * that can send as you or move mail out of sight is a different conversation, and it
   * should be one the user opts into rather than discovers.
   */
  readonly allowSend?: boolean;
}

interface MailFolder {
  readonly id: string;
  readonly displayName: string;
  readonly childFolderCount: number;
  readonly totalItemCount: number;
  readonly unreadItemCount: number;
}

interface MailMessage {
  readonly id: string;
  readonly subject: string | null;
  readonly bodyPreview: string | null;
  readonly receivedDateTime: string;
  readonly isRead: boolean;
  readonly isDraft: boolean;
  readonly hasAttachments: boolean;
  readonly importance: string;
  readonly conversationId: string | null;
  readonly webLink: string | null;
  readonly from?: { emailAddress?: { name?: string; address?: string } };
  readonly toRecipients?: ReadonlyArray<{ emailAddress?: { name?: string; address?: string } }>;
  readonly ccRecipients?: ReadonlyArray<{ emailAddress?: { name?: string; address?: string } }>;
  readonly body?: { contentType?: string; content?: string };
  readonly flag?: { flagStatus?: string };
  readonly '@removed'?: unknown;
}

interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly isInline: boolean;
}

const LIST_SELECT =
  'id,subject,bodyPreview,receivedDateTime,isRead,isDraft,hasAttachments,importance,conversationId,from,flag';
const READ_SELECT = `${LIST_SELECT},body,toRecipients,ccRecipients,webLink`;

export class GraphMailProvider implements Provider {
  readonly id: string;
  readonly displayName = 'Outlook mail';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'list',
    'read',
    'search',
    'poll',
    'actions',
    'attachments',
  ]);

  readonly #options: GraphMailOptions;
  readonly #context: ProviderContext;
  readonly #registry = new ActionRegistry<GraphMailProvider>([
    {
      descriptor: {
        name: 'reply',
        label: 'Reply',
        description: 'Reply to this message.',
        group: 'reply',
        key: 'r',
        params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
      },
      applies: (node) => isMessageNode(node),
      run: ({ node, params, context }) => context.#reply(node, params),
    },
    {
      descriptor: {
        name: 'reply-all',
        label: 'Reply all',
        description: 'Reply to everyone on this message.',
        group: 'reply',
        params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
      },
      applies: (node) => isMessageNode(node),
      run: ({ node, params, context }) => context.#replyAll(node, params),
    },
    {
      descriptor: {
        name: 'forward',
        label: 'Forward',
        description: 'Forward this message to one or more recipients.',
        group: 'reply',
        key: 'f',
        params: [
          { name: 'to', type: 'text', label: 'Recipients', required: true },
          { name: 'body', type: 'text', label: 'Comment' },
        ],
      },
      applies: (node) => isMessageNode(node),
      run: ({ node, params, context }) => context.#forward(node, params),
    },
    {
      descriptor: { name: 'read', label: 'Mark as read' },
      applies: (node) => isMessageNode(node) && (node.flags ?? []).includes('unread'),
      run: ({ node, context }) => context.#setRead(node, true),
    },
    {
      descriptor: { name: 'unread', label: 'Mark as unread' },
      applies: (node) => isMessageNode(node) && !(node.flags ?? []).includes('unread'),
      run: ({ node, context }) => context.#setRead(node, false),
    },
    {
      descriptor: { name: 'flag', label: 'Flag for follow up' },
      applies: (node) => isMessageNode(node) && !(node.flags ?? []).includes('flagged'),
      run: ({ node, context }) => context.#setFlag(node, true),
    },
    {
      descriptor: { name: 'unflag', label: 'Clear follow-up flag' },
      applies: (node) => isMessageNode(node) && (node.flags ?? []).includes('flagged'),
      run: ({ node, context }) => context.#setFlag(node, false),
    },
    {
      descriptor: {
        name: 'move',
        label: 'Move to folder',
        description: 'Move this message to a well-known Outlook folder.',
        group: 'file',
        params: [{ name: 'folder', type: 'text', label: 'Folder', required: true }],
      },
      applies: (node) => isMessageNode(node),
      run: ({ node, params, context }) => context.#move(node, requiredText(params, 'folder')),
    },
    {
      descriptor: { name: 'archive', label: 'Archive', description: 'Move this message to Archive.', group: 'file', key: 'e' },
      applies: (node) => isMessageNode(node),
      run: ({ node, context }) => context.#move(node, 'archive'),
    },
    {
      descriptor: { name: 'delete', label: 'Delete', description: 'Move this message to Deleted Items.', destructive: true, group: 'file' },
      applies: (node) => isMessageNode(node),
      run: ({ node, context }) => context.#move(node, 'deleteditems', 'Deleted'),
    },
    {
      descriptor: { name: 'url', label: 'Show the web URL', description: 'Print the Outlook on the web link.', group: 'link', key: 'u' },
      applies: (node) => isMessageNode(node),
      run: ({ node, context }) => context.#urlAction(node),
    },
  ]);
  #client: GraphApi | undefined;

  constructor(options: GraphMailOptions, context: ProviderContext, client?: GraphApi) {
    this.#options = options;
    this.#context = context;
    this.id = `graph-mail:${context.mountPath}`;
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
    if (this.#client === undefined) throw VfsError.config('The mail mount was not initialised.');
    return this.#client;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(parent: VNode | null, options: ListOptions): Promise<ListPage> {
    const limit = Math.max(1, Math.min(options.limit ?? this.#options.pageSize ?? 50, 200));

    if (parent === null) {
      const hidden = this.#options.includeHiddenFolders === true ? '&includeHiddenFolders=true' : '';
      const page = await this.#api.getPage<MailFolder>(
        options.cursor ?? `/me/mailFolders?$top=100${hidden}`,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      return {
        entries: page.value.map((folder) => folderNode(folder)),
        ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
      };
    }

    if (parent.subtype !== 'folder') throw VfsError.notDirectory(parent.path ?? parent.name);

    // A cursor from a previous page already encodes exactly where to resume, including
    // which of the two collections (subfolders, then messages) is being paged.
    if (options.cursor !== undefined) return this.#continue(parent, options);

    const entries: VNode[] = [];
    if ((parent.meta?.['childFolderCount'] as number | undefined) !== 0) {
      const children = await this.#api.getPage<MailFolder>(
        `/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders?$top=100`,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      entries.push(...children.value.map((folder) => folderNode(folder)));
    }

    const { path, applied } = this.#messagesPath(parent.id, limit, options.query);
    const messages = await this.#api.getPage<MailMessage>(
      path,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    entries.push(...messages.value.map((message) => messageNode(message, parent.id)));

    return {
      entries,
      ...(messages.nextLink === undefined ? {} : { cursor: messages.nextLink }),
      ...(parent.meta?.['totalItemCount'] === undefined ? {} : { total: Number(parent.meta['totalItemCount']) }),
      ...(applied === undefined ? {} : { appliedQuery: applied }),
    };
  }

  async #continue(parent: VNode, options: ListOptions): Promise<ListPage> {
    const page = await this.#api.getPage<MailMessage>(
      options.cursor as string,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return {
      entries: page.value.map((message) => messageNode(message, parent.id)),
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  /**
   * Translate the query into Graph parameters where possible.
   *
   * `$filter` and `$search` are mutually exclusive on the messages endpoint and `$search`
   * disallows `$orderby`, so this deliberately handles only the simple, high-value cases
   * and lets the engine filter the rest locally. Claiming `appliedQuery` for anything more
   * would risk silently wrong results; the engine re-filters everything it was not told
   * was fully applied, so under-claiming is always safe.
   */
  #messagesPath(folderId: string, limit: number, query: Query | undefined): { path: string; applied?: Query } {
    const base = `/me/mailFolders/${encodeURIComponent(folderId)}/messages`;
    const common = `$select=${LIST_SELECT}&$top=${String(limit)}`;

    if (query !== undefined && query.type === 'term') {
      const value = query.value;
      if (query.field === 'is' && value.toLowerCase() === 'unread') {
        return { path: `${base}?${common}&$filter=isRead eq false&$orderby=receivedDateTime desc`, applied: query };
      }
      if (query.field === 'is' && value.toLowerCase() === 'read') {
        return { path: `${base}?${common}&$filter=isRead eq true&$orderby=receivedDateTime desc`, applied: query };
      }
      if (query.field === 'has' && value.toLowerCase() === 'attachment') {
        return { path: `${base}?${common}&$filter=hasAttachments eq true&$orderby=receivedDateTime desc`, applied: query };
      }
      if (query.field === 'subject' && query.op === 'contains') {
        const escaped = value.replace(/'/g, "''");
        return {
          path: `${base}?${common}&$filter=${encodeURIComponent(`contains(subject,'${escaped}')`)}&$orderby=receivedDateTime desc`,
          applied: query,
        };
      }
    }

    return { path: `${base}?${common}&$orderby=receivedDateTime desc` };
  }

  async search(parent: VNode | null, query: Query, options: ListOptions): Promise<ListPage> {
    // Graph's $search is KQL against the mailbox index and is far faster than walking
    // folders, but it returns relevance order and forbids $orderby, so results are not
    // date-sorted. That is a worthwhile trade for search specifically.
    const terms = collectSearchTerms(query);
    if (terms.length === 0) {
      throw VfsError.invalid('That query has nothing text-like to search for.', 'Try `find . -q "budget"` or `-q subject:budget`.');
    }
    const scope = parent === null ? '/me/messages' : `/me/mailFolders/${encodeURIComponent(parent.id)}/messages`;
    const search = encodeURIComponent(`"${terms.join(' ').replace(/"/g, '')}"`);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

    const page = await this.#api.getPage<MailMessage>(
      options.cursor ?? `${scope}?$search=${search}&$select=${LIST_SELECT}&$top=${String(limit)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    return {
      entries: page.value.map((message) => messageNode(message, parent?.id ?? '')),
      ...(page.nextLink === undefined ? {} : { cursor: page.nextLink }),
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async read(node: VNode, options: ReadOptions): Promise<Document> {
    if (node.kind === 'dir') throw VfsError.isDirectory(node.path ?? node.name);

    const message = await this.#api.get<MailMessage>(
      `/me/messages/${encodeURIComponent(node.id)}?$select=${READ_SELECT}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );

    const raw = message.body?.content ?? message.bodyPreview ?? '';
    const body = (message.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw;

    const headers: Array<readonly [string, string]> = [
      ['From', formatAddress(message.from?.emailAddress)],
      ['To', (message.toRecipients ?? []).map((r) => formatAddress(r.emailAddress)).join(', ')],
    ];
    if ((message.ccRecipients ?? []).length > 0) {
      headers.push(['Cc', (message.ccRecipients ?? []).map((r) => formatAddress(r.emailAddress)).join(', ')]);
    }
    headers.push(['Date', new Date(message.receivedDateTime).toISOString()]);
    headers.push(['Subject', message.subject ?? '(no subject)']);
    if (message.importance !== 'normal') headers.push(['Importance', message.importance]);

    let attachments: Attachment[] = [];
    if (message.hasAttachments) {
      try {
        const page = await this.#api.getPage<Attachment>(
          `/me/messages/${encodeURIComponent(node.id)}/attachments?$select=id,name,contentType,size,isInline`,
          options.signal === undefined ? {} : { signal: options.signal },
        );
        attachments = page.value;
      } catch (error) {
        this.#context.logger.warn('could not list attachments', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      title: message.subject ?? '(no subject)',
      headers,
      body,
      format: 'text',
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((a) => ({
              id: a.id,
              name: a.name,
              size: a.size,
              contentType: a.contentType,
              inline: a.isInline,
            })),
          }),
      ...(message.webLink === null || message.webLink === undefined ? {} : { webUrl: message.webLink }),
      ...(message.conversationId === null || message.conversationId === undefined
        ? {}
        : { threadId: message.conversationId }),
    };
  }

  async readAttachment(node: VNode, attachmentId: string): Promise<{ name: string; contentType: string; data: Uint8Array }> {
    const meta = await this.#api.get<Attachment>(
      `/me/messages/${encodeURIComponent(node.id)}/attachments/${encodeURIComponent(attachmentId)}?$select=id,name,contentType,size`,
    );
    const data = await this.#api.getBytes(
      `/me/messages/${encodeURIComponent(node.id)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    );
    return { name: meta.name, contentType: meta.contentType, data };
  }

  // -------------------------------------------------------------------------
  // Change detection
  // -------------------------------------------------------------------------

  async poll(parent: VNode | null, cursor: string | undefined, options: { signal?: AbortSignal }): Promise<PollResult> {
    if (parent === null || parent.subtype !== 'folder') {
      throw VfsError.unsupported('Watching', this.id);
    }

    // A stored deltaLink resumes exactly where the last poll stopped. Without it the first
    // poll after a restart would report the entire folder as new.
    const start =
      cursor ??
      `/me/mailFolders/${encodeURIComponent(parent.id)}/messages/delta?$select=${LIST_SELECT}&$top=50`;

    let link: string | undefined = start;
    const changes: ChangeEvent[] = [];
    let deltaLink: string | undefined;
    let guard = 0;

    while (link !== undefined && guard < 20) {
      guard += 1;
      const page: GraphPage<MailMessage> = await this.#api.getPage<MailMessage>(
        link,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      for (const message of page.value) {
        const removed = message['@removed'] !== undefined;
        const node = removed ? undefined : messageNode(message, parent.id);
        changes.push({
          type: removed ? 'deleted' : 'created',
          path: node?.name ?? message.id,
          ...(node === undefined ? {} : { node }),
          at: new Date(message.receivedDateTime ?? Date.now()),
        });
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
        'covers Mail.ReadWrite and Mail.Send.',
    });
  }

  async #reply(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    this.#requireSend('reply');
    await this.#api.post(`/me/messages/${encodeURIComponent(node.id)}/reply`, { comment: requiredText(params, 'body') });
    return { ok: true, message: `Replied to "${node.title}".`, invalidates: [parentOf(node)] };
  }

  async #replyAll(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    this.#requireSend('reply-all');
    await this.#api.post(`/me/messages/${encodeURIComponent(node.id)}/replyAll`, { comment: requiredText(params, 'body') });
    return { ok: true, message: `Replied to everyone on "${node.title}".`, invalidates: [parentOf(node)] };
  }

  async #forward(node: VNode, params: Readonly<Record<string, MetaValue>>): Promise<ActionResult> {
    this.#requireSend('forward');
    const toRecipients = parseRecipients(requiredText(params, 'to'));
    const comment = optionalText(params, 'body') ?? '';
    await this.#api.post(`/me/messages/${encodeURIComponent(node.id)}/forward`, { comment, toRecipients });
    return {
      ok: true,
      message: `Forwarded "${node.title}" to ${String(toRecipients.length)} recipient${toRecipients.length === 1 ? '' : 's'}.`,
      invalidates: [parentOf(node)],
    };
  }

  async #setRead(node: VNode, read: boolean): Promise<ActionResult> {
    this.#requireSend(read ? 'read' : 'unread');
    await this.#api.patch(`/me/messages/${encodeURIComponent(node.id)}`, { isRead: read });
    return { ok: true, message: `Marked "${node.title}" as ${read ? 'read' : 'unread'}.`, invalidates: [parentOf(node)] };
  }

  async #setFlag(node: VNode, flagged: boolean): Promise<ActionResult> {
    this.#requireSend(flagged ? 'flag' : 'unflag');
    await this.#api.patch(`/me/messages/${encodeURIComponent(node.id)}`, {
      flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
    });
    return { ok: true, message: `${flagged ? 'Flagged' : 'Unflagged'} "${node.title}".`, invalidates: [parentOf(node)] };
  }

  async #move(node: VNode, folder: string, verb = 'Moved'): Promise<ActionResult> {
    this.#requireSend(verb === 'Deleted' ? 'delete' : folder === 'archive' ? 'archive' : 'move');
    const destinationId = folder.trim().toLowerCase();
    if (destinationId === '') throw VfsError.invalid('The destination folder cannot be empty.');
    // Outlook delete moves a message to Deleted Items; modelling it as `move` avoids adding a
    // Graph DELETE transport for an operation whose user-visible semantics are not permanent.
    await this.#api.post(`/me/messages/${encodeURIComponent(node.id)}/move`, { destinationId });
    return {
      ok: true,
      message: `${verb} "${node.title}"${verb === 'Moved' ? ` to ${destinationId}.` : '.'}`,
      invalidates: [parentOf(node)],
    };
  }

  async #urlAction(node: VNode): Promise<ActionResult> {
    return { ok: true, message: metaText(node, 'webLink') };
  }
}

// ---------------------------------------------------------------------------
// Node mapping
// ---------------------------------------------------------------------------

function folderNode(folder: MailFolder): VNode {
  return {
    name: folder.displayName,
    kind: 'dir',
    subtype: 'folder',
    title: folder.displayName,
    id: folder.id,
    childCount: folder.totalItemCount,
    unreadCount: folder.unreadItemCount,
    ...(folder.unreadItemCount > 0 ? { flags: ['unread'] } : {}),
    meta: {
      childFolderCount: folder.childFolderCount,
      totalItemCount: folder.totalItemCount,
      unreadItemCount: folder.unreadItemCount,
    },
  };
}

function messageNode(message: MailMessage, folderId: string): VNode {
  const received = new Date(message.receivedDateTime);
  const subject = message.subject ?? '(no subject)';
  const flags: string[] = [];
  if (!message.isRead) flags.push('unread');
  if (message.isDraft) flags.push('draft');
  if (message.hasAttachments) flags.push('attachment');
  if (message.importance === 'high') flags.push('important');
  if (message.flag?.flagStatus === 'flagged') flags.push('flagged');

  const from = message.from?.emailAddress;

  return {
    name: `${timestampPrefix(received)} ${subject}.eml`,
    kind: 'file',
    subtype: 'message',
    title: subject,
    id: message.id,
    mtime: received,
    ...(flags.length === 0 ? {} : { flags }),
    ...(message.bodyPreview === null || message.bodyPreview === undefined
      ? {}
      : { summary: preview(message.bodyPreview) }),
    ...(from?.name === undefined ? {} : { author: from.name }),
    ...(from?.address === undefined ? {} : { authorId: from.address }),
    meta: {
      folderId,
      importance: message.importance,
      ...(message.conversationId === null || message.conversationId === undefined
        ? {}
        : { conversationId: message.conversationId }),
      ...(message.webLink === null || message.webLink === undefined ? {} : { webLink: message.webLink }),
    },
  };
}

function formatAddress(address: { name?: string; address?: string } | undefined): string {
  if (address === undefined) return '(unknown)';
  if (address.name === undefined) return address.address ?? '(unknown)';
  if (address.address === undefined) return address.name;
  return `${address.name} <${address.address}>`;
}

function isMessageNode(node: VNode): boolean {
  return node.kind === 'file' && node.subtype === 'message';
}

function parseRecipients(raw: string): Array<{ emailAddress: { address: string } }> {
  const recipients = raw
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
  if (recipients.length === 0) {
    throw VfsError.invalid('At least one forwarding recipient is required.', 'Pass --to with one or more comma-separated email addresses.');
  }
  return recipients.map((address) => ({ emailAddress: { address } }));
}

function parentOf(node: VNode): string {
  const path = node.path;
  if (path === undefined) return node.name;
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? path : path.slice(0, slash);
}

/** Pull the free-text and subject/body terms out of a query, for `$search`. */
function collectSearchTerms(query: Query): string[] {
  const terms: string[] = [];
  const walk = (q: Query): void => {
    switch (q.type) {
      case 'text':
        terms.push(q.value);
        break;
      case 'term':
        if (q.field === 'subject' || q.field === 'body' || q.field === 'author') terms.push(q.value);
        break;
      case 'and':
      case 'or':
        q.clauses.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(query);
  return terms;
}

export const graphMailPlugin: ProviderPlugin<GraphMailOptions> = {
  type: 'graph-mail',
  displayName: 'Outlook mail (Microsoft Graph)',
  description: 'Mail folders as directories and messages as files, read-only by default.',
  optionKeys: [...GRAPH_SHARED_OPTION_KEYS, 'includeHiddenFolders', 'pageSize'],
  validateOptions(raw) {
    validateSharedOptions(raw);
    return (raw ?? {}) as GraphMailOptions;
  },
  create(options, context) {
    return new GraphMailProvider(options, context);
  },
};
