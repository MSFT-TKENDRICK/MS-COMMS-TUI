/**
 * What you can do to a fixture item.
 *
 * The fixture provider is the reference implementation of the contract, so it is also the
 * reference implementation of the *action* contract: every verb the real providers offer
 * has a counterpart here, against data that cannot be down, rate-limited or revoked. That
 * is what makes `demo` an honest rehearsal rather than a screenshot — approving a pull
 * request offline exercises the same descriptor list, the same parameter validation and
 * the same invalidation path that approving a real one does.
 *
 * THE VERBS ACTUALLY CHANGE SOMETHING
 *
 * A demo action that returns "Approved!" and mutates nothing teaches the interface a lie:
 * the listing does not change, so a user cannot tell a working action from a broken one,
 * and neither can a test. So replies really are appended to the conversation, states
 * really do move, and the next `ls` shows it. The fixture is in memory, so all of it is
 * forgotten when the process exits — which is the correct amount of persistence for
 * sample data.
 *
 * WHERE A REPLY GOES
 *
 * Into the *parent* of the message being replied to, never into the message itself. That
 * is both how conversations actually work and a hard constraint of the fixture model: a
 * node is a directory precisely when it has children, so hanging a reply off a message
 * would silently turn that message into a folder you can no longer `cat`.
 */

import {
  ActionRegistry,
  VfsError,
  optionalText,
  requiredText,
  type ActionCommand,
  type ActionResult,
  type MetaValue,
  type UndoSpec,
  type VNode,
} from '@mscomms/core';
import type { MemoryItem } from './types.js';

/**
 * The slice of the provider its commands are allowed to touch.
 *
 * An interface rather than the provider itself, so a command cannot reach past it into
 * paging, search or the fixture index — and so the whole action table stays testable
 * without standing up a provider.
 */
export interface MemoryActionHost {
  flagsOf(id: string): ReadonlySet<string>;
  setFlag(id: string, flag: string, on: boolean): void;
  metaOf(id: string): Readonly<Record<string, MetaValue>>;
  setMeta(id: string, key: string, value: MetaValue): void;
  titleOf(id: string): string;
  parentIdOf(id: string): string | null;
  /** Add a new item as a child of `parentId`, newest first. Returns its id. */
  append(parentId: string, item: MemoryItem): string;
}

type Command = ActionCommand<MemoryActionHost>;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Subtypes that behave like a piece of mail. */
const MAIL = new Set(['message', 'mail']);
/** Subtypes you can post a new message into. */
const CONVERSATION = new Set(['chat', 'channel', 'thread']);

function isMail(node: VNode): boolean {
  return MAIL.has(node.subtype ?? '');
}

function isConversation(node: VNode): boolean {
  return CONVERSATION.has(node.subtype ?? '');
}

function isPull(node: VNode): boolean {
  return node.subtype === 'pull';
}

function isIssue(node: VNode): boolean {
  return node.subtype === 'issue';
}

/** Open in the sense that matters to a verb: not closed, not merged. */
function isOpen(node: VNode, host: MemoryActionHost): boolean {
  const flags = host.flagsOf(node.id);
  return !flags.has('closed') && !flags.has('merged');
}

function label(node: VNode, host: MemoryActionHost): string {
  return host.titleOf(node.id);
}

/** Where a reply to this node belongs. */
function conversationOf(node: VNode, host: MemoryActionHost): string {
  if (isConversation(node)) return node.id;
  const parent = host.parentIdOf(node.id);
  if (parent === null) {
    throw VfsError.invalid(
      `"${node.title}" is not inside a conversation, so there is nowhere to put a reply.`,
      'Replies are added beside the message they answer.',
    );
  }
  return parent;
}

/**
 * Flags that belong to the model rather than to the user's tagging.
 *
 * `untag` refuses to touch these: removing `unread` through the tag mechanism would leave
 * the item in a state `read`/`unread` never produced, and the undo recorded for it would
 * name a verb that cannot restore it.
 */
const RESERVED_FLAGS = new Set(['unread', 'flagged', 'attachment', 'draft', 'sent']);

/** The tags a user actually added, which are the only ones `untag` will remove. */
function removableTags(node: VNode, host: MemoryActionHost): string[] {
  return [...host.flagsOf(node.id)].filter((flag) => !RESERVED_FLAGS.has(flag)).sort();
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now() % 100000)}`;
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

const markRead: Command = {
  descriptor: { name: 'read', label: 'Mark as read', description: 'Clear the unread flag.', group: 'state' },
  applies: (node, host) => host.flagsOf(node.id).has('unread'),
  async run({ node, context }) {
    context.setFlag(node.id, 'unread', false);
    // `applies` already established that the item was unread, and the registry refuses a
    // verb that does not apply — so unlike a free-standing toggle this inverse needs no
    // "did anything actually change" guard. The precondition is the gate.
    return done(`Marked "${label(node, context)}" as read.`, node, [], {
      action: 'unread',
      label: 'mark it unread again',
    });
  },
};

const markUnread: Command = {
  descriptor: { name: 'unread', label: 'Mark as unread', description: 'Set the unread flag.', group: 'state' },
  applies: (node, host) => !host.flagsOf(node.id).has('unread'),
  async run({ node, context }) {
    context.setFlag(node.id, 'unread', true);
    return done(`Marked "${label(node, context)}" as unread.`, node, [], {
      action: 'read',
      label: 'mark it read again',
    });
  },
};

const flag: Command = {
  descriptor: { name: 'flag', label: 'Flag for follow-up', group: 'state' },
  applies: (node, host) => !host.flagsOf(node.id).has('flagged'),
  async run({ node, context }) {
    context.setFlag(node.id, 'flagged', true);
    return done(`Flagged "${label(node, context)}".`, node, [], {
      action: 'unflag',
      label: 'remove the flag again',
    });
  },
};

const unflag: Command = {
  descriptor: { name: 'unflag', label: 'Remove the follow-up flag', group: 'state' },
  applies: (node, host) => host.flagsOf(node.id).has('flagged'),
  async run({ node, context }) {
    context.setFlag(node.id, 'flagged', false);
    return done(`Removed the flag from "${label(node, context)}".`, node, [], {
      action: 'flag',
      label: 'put the flag back',
    });
  },
};

const tag: Command = {
  descriptor: {
    name: 'tag',
    label: 'Add a tag',
    description: 'Attach an arbitrary flag, which is also how action parameters get exercised offline.',
    group: 'state',
    params: [{ name: 'tag', type: 'string', label: 'Tag name', required: true }],
  },
  async run({ node, params, context }) {
    const value = requiredText(params, 'tag');
    // `tag` is the one state verb with no `applies` gate, because it applies to anything.
    // So it can be asked to add a tag that is already there, which changes nothing, and an
    // undo for that would remove a tag the user never added.
    const alreadyThere = context.flagsOf(node.id).has(value);
    context.setFlag(node.id, value, true);
    return done(
      `Tagged "${label(node, context)}" with ${value}.`,
      node,
      [],
      alreadyThere ? undefined : { action: 'untag', params: { tag: value }, label: `remove the ${value} tag` },
    );
  },
};

/**
 * Offered only when there is something to remove, and it exists mainly so `tag` has a real
 * inverse to name. An undo that can only be expressed as a verb the provider does not
 * actually offer is an undo nobody can invoke by hand, which would make the undo stack the
 * only route to it: exactly the sort of capability asymmetry this project refuses.
 */
const untag: Command = {
  descriptor: {
    name: 'untag',
    label: 'Remove a tag',
    description: 'Remove a tag that was added with `tag`.',
    group: 'state',
    params: [{ name: 'tag', type: 'string', label: 'Tag name', required: true }],
  },
  applies: (node, host) => removableTags(node, host).length > 0,
  async run({ node, params, context }) {
    const value = requiredText(params, 'tag');
    if (RESERVED_FLAGS.has(value)) {
      throw VfsError.invalid(
        `"${value}" is a built-in marker, not a tag.`,
        `Use \`do ${value === 'unread' ? 'read' : value === 'flagged' ? 'unflag' : value} …\` instead.`,
      );
    }
    const removable = removableTags(node, context);
    if (!removable.includes(value)) {
      throw VfsError.invalid(
        `"${label(node, context)}" is not tagged ${value}.`,
        removable.length === 0 ? 'It has no tags to remove.' : `Tagged: ${removable.join(', ')}.`,
      );
    }
    context.setFlag(node.id, value, false);
    return done(`Removed the ${value} tag from "${label(node, context)}".`, node, [], {
      action: 'tag',
      params: { tag: value },
      label: `put the ${value} tag back`,
    });
  },
};

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const reply: Command = {
  descriptor: {
    name: 'reply',
    label: 'Reply',
    description: 'Add a reply beside this message.',
    group: 'reply',
    key: 'r',
    params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
  },
  applies: (node) => isMail(node),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    const parent = conversationOf(node, context);
    const title = `Re: ${stripRe(context.titleOf(node.id))}`;
    context.append(parent, {
      id: nextId('reply'),
      title,
      subtype: node.subtype ?? 'message',
      author: 'You',
      authorId: 'you@contoso.example',
      summary: firstLine(body),
      body,
      format: 'text',
      ...(node.meta?.['threadId'] === undefined ? {} : { threadId: String(node.meta['threadId']) }),
    });
    return done(`Replied to "${label(node, context)}".`, node, [`Sent: ${firstLine(body)}`]);
  },
};

const replyAll: Command = {
  descriptor: {
    name: 'reply-all',
    label: 'Reply to everyone',
    group: 'reply',
    params: [{ name: 'body', type: 'text', label: 'Reply', required: true }],
  },
  applies: (node) => isMail(node),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    context.append(conversationOf(node, context), {
      id: nextId('reply-all'),
      title: `Re: ${stripRe(context.titleOf(node.id))}`,
      subtype: node.subtype ?? 'message',
      author: 'You',
      authorId: 'you@contoso.example',
      summary: firstLine(body),
      body,
      format: 'text',
      meta: { replyAll: true },
    });
    return done(`Replied to everyone on "${label(node, context)}".`, node);
  },
};

const forward: Command = {
  descriptor: {
    name: 'forward',
    label: 'Forward',
    group: 'reply',
    key: 'f',
    params: [
      { name: 'to', type: 'string', label: 'Recipients, comma separated', required: true },
      { name: 'body', type: 'text', label: 'Note to add', required: false },
    ],
  },
  applies: (node) => isMail(node),
  async run({ node, params, context }) {
    const to = addresses(requiredText(params, 'to'));
    const note = optionalText(params, 'body') ?? '';
    context.append(conversationOf(node, context), {
      id: nextId('forward'),
      title: `Fw: ${stripRe(context.titleOf(node.id))}`,
      subtype: node.subtype ?? 'message',
      author: 'You',
      authorId: 'you@contoso.example',
      summary: `Forwarded to ${to.join(', ')}`,
      body: note === '' ? `Forwarded to ${to.join(', ')}.` : `${note}\n\n--- Forwarded ---\n`,
      format: 'text',
      meta: { forwardedTo: to.join(', ') },
    });
    return done(`Forwarded "${label(node, context)}" to ${to.join(', ')}.`, node);
  },
};

const send: Command = {
  descriptor: {
    name: 'send',
    label: 'Send a message',
    description: 'Post a new message into this conversation.',
    group: 'reply',
    key: 's',
    params: [{ name: 'body', type: 'text', label: 'Message', required: true }],
  },
  applies: (node) => isConversation(node),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    context.append(node.id, {
      id: nextId('sent'),
      title: firstLine(body),
      subtype: 'message',
      author: 'You',
      authorId: 'you@contoso.example',
      summary: firstLine(body),
      body,
      format: 'text',
    });
    return done(`Sent a message to "${label(node, context)}".`, node);
  },
};

const archive: Command = {
  descriptor: { name: 'archive', label: 'Archive', group: 'file', key: 'e' },
  applies: (node, host) => isMail(node) && !host.flagsOf(node.id).has('archived'),
  async run({ node, context }) {
    context.setFlag(node.id, 'archived', true);
    context.setFlag(node.id, 'unread', false);
    return done(`Archived "${label(node, context)}".`, node);
  },
};

const remove: Command = {
  descriptor: {
    name: 'delete',
    label: 'Delete',
    description: 'Mark this item deleted. The fixture keeps it so the effect is visible.',
    group: 'file',
    destructive: true,
  },
  applies: (node, host) => isMail(node) && !host.flagsOf(node.id).has('deleted'),
  async run({ node, context }) {
    context.setFlag(node.id, 'deleted', true);
    return done(`Deleted "${label(node, context)}".`, node);
  },
};

// ---------------------------------------------------------------------------
// Code review
// ---------------------------------------------------------------------------

/**
 * A review is recorded twice on purpose: as a flag, because that is what a listing and a
 * query can see, and as a comment in the conversation, because that is what a reviewer
 * reads. Real forges do exactly the same thing, and a demo that only did the first would
 * make the review pane look broken.
 */
function recordReview(
  node: VNode,
  host: MemoryActionHost,
  verdict: 'approved' | 'changes-requested' | 'commented',
  body: string | undefined,
): void {
  host.setFlag(node.id, 'approved', verdict === 'approved');
  host.setFlag(node.id, 'changes-requested', verdict === 'changes-requested');
  host.setMeta(node.id, 'review', verdict);
  host.setMeta(node.id, 'reviewedBy', 'you@contoso.example');
  const parent = host.parentIdOf(node.id);
  if (parent === null) return;
  host.append(parent, {
    id: nextId('review'),
    title: `Review on ${host.titleOf(node.id)}: ${verdict}`,
    subtype: 'review',
    author: 'You',
    authorId: 'you@contoso.example',
    summary: body === undefined ? verdict : firstLine(body),
    body: body ?? `Marked ${verdict}.`,
    format: 'text',
    meta: { verdict, reviewOf: node.id },
  });
}

const approve: Command = {
  descriptor: {
    name: 'approve',
    label: 'Approve this pull request',
    description: 'Submit an approving review.',
    group: 'review',
    key: 'a',
    params: [{ name: 'body', type: 'text', label: 'Comment to leave with the approval', required: false }],
  },
  applies: (node, host) => isPull(node) && isOpen(node, host),
  async run({ node, params, context }) {
    const body = optionalText(params, 'body');
    recordReview(node, context, 'approved', body);
    return done(`Approved ${label(node, context)}.`, node, body === undefined ? [] : [`Comment: ${firstLine(body)}`]);
  },
};

const requestChanges: Command = {
  descriptor: {
    name: 'request-changes',
    label: 'Request changes',
    description: 'Submit a review that blocks the merge until it is addressed.',
    group: 'review',
    key: 'x',
    // Required, and not merely conventional: a blocking review with no explanation is the
    // single most resented thing a reviewer can do, and the real GitHub API rejects it too.
    params: [{ name: 'body', type: 'text', label: 'What needs to change', required: true }],
  },
  applies: (node, host) => isPull(node) && isOpen(node, host),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    recordReview(node, context, 'changes-requested', body);
    return done(`Requested changes on ${label(node, context)}.`, node, [firstLine(body)]);
  },
};

const reviewComment: Command = {
  descriptor: {
    name: 'comment-review',
    label: 'Comment without approving',
    description: 'Leave review feedback that neither approves nor blocks.',
    group: 'review',
    params: [{ name: 'body', type: 'text', label: 'Review comment', required: true }],
  },
  applies: (node, host) => isPull(node) && isOpen(node, host),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    recordReview(node, context, 'commented', body);
    return done(`Left a review comment on ${label(node, context)}.`, node);
  },
};

const merge: Command = {
  descriptor: {
    name: 'merge',
    label: 'Merge this pull request',
    group: 'review',
    key: 'm',
    destructive: true,
    params: [
      { name: 'method', type: 'choice', label: 'How to merge', choices: ['merge', 'squash', 'rebase'], default: 'merge' },
    ],
  },
  // A draft is explicitly not ready, so offering to merge it is offering a mistake.
  applies: (node, host) => isPull(node) && isOpen(node, host) && !host.flagsOf(node.id).has('draft'),
  async run({ node, params, context }) {
    const method = optionalText(params, 'method') ?? 'merge';
    context.setFlag(node.id, 'open', false);
    context.setFlag(node.id, 'merged', true);
    context.setMeta(node.id, 'state', 'merged');
    context.setMeta(node.id, 'mergeMethod', method);
    return done(`Merged ${label(node, context)} with a ${method} commit.`, node);
  },
};

// ---------------------------------------------------------------------------
// Triage — shared by issues and pull requests
// ---------------------------------------------------------------------------

const comment: Command = {
  descriptor: {
    name: 'comment',
    label: 'Add a comment',
    group: 'discuss',
    key: 'c',
    params: [{ name: 'body', type: 'text', label: 'Comment', required: true }],
  },
  applies: (node) => isIssue(node) || isPull(node),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    const parent = context.parentIdOf(node.id);
    if (parent !== null) {
      context.append(parent, {
        id: nextId('comment'),
        title: `Comment on ${context.titleOf(node.id)}`,
        subtype: 'comment',
        author: 'You',
        authorId: 'you@contoso.example',
        summary: firstLine(body),
        body,
        format: 'text',
        meta: { commentOn: node.id },
      });
    }
    const previous = Number(context.metaOf(node.id)['comments'] ?? 0);
    context.setMeta(node.id, 'comments', previous + 1);
    return done(`Commented on ${label(node, context)}.`, node);
  },
};

const close: Command = {
  descriptor: {
    name: 'close',
    label: 'Close',
    group: 'triage',
    destructive: true,
    params: [
      {
        name: 'reason',
        type: 'choice',
        label: 'Why it is being closed',
        choices: ['completed', 'not-planned'],
        default: 'completed',
      },
    ],
  },
  applies: (node, host) => (isIssue(node) || isPull(node)) && isOpen(node, host),
  async run({ node, params, context }) {
    const reason = optionalText(params, 'reason') ?? 'completed';
    context.setFlag(node.id, 'open', false);
    context.setFlag(node.id, 'closed', true);
    context.setMeta(node.id, 'state', 'closed');
    context.setMeta(node.id, 'closedReason', reason);
    return done(`Closed ${label(node, context)} as ${reason}.`, node);
  },
};

const reopen: Command = {
  descriptor: { name: 'reopen', label: 'Reopen', group: 'triage' },
  // A merged pull request is not reopenable anywhere that has one, and offering it here
  // would teach a shortcut that fails against the real thing.
  applies: (node, host) =>
    (isIssue(node) || isPull(node)) &&
    host.flagsOf(node.id).has('closed') &&
    !host.flagsOf(node.id).has('merged'),
  async run({ node, context }) {
    context.setFlag(node.id, 'closed', false);
    context.setFlag(node.id, 'open', true);
    context.setMeta(node.id, 'state', 'open');
    return done(`Reopened ${label(node, context)}.`, node);
  },
};

const assign: Command = {
  descriptor: {
    name: 'assign',
    label: 'Assign to someone',
    group: 'triage',
    params: [{ name: 'to', type: 'string', label: 'Who to assign it to', required: true }],
  },
  applies: (node) => isIssue(node) || isPull(node),
  async run({ node, params, context }) {
    const to = requiredText(params, 'to');
    context.setMeta(node.id, 'assignees', to);
    return done(`Assigned ${label(node, context)} to ${to}.`, node);
  },
};

const addLabel: Command = {
  descriptor: {
    name: 'label',
    label: 'Add labels',
    group: 'triage',
    params: [{ name: 'labels', type: 'string', label: 'Labels, comma separated', required: true }],
  },
  applies: (node) => isIssue(node) || isPull(node),
  async run({ node, params, context }) {
    const added = addresses(requiredText(params, 'labels'));
    const existing = String(context.metaOf(node.id)['labels'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    const merged = [...new Set([...existing, ...added])];
    context.setMeta(node.id, 'labels', merged.join(','));
    return done(`Labelled ${label(node, context)} ${added.join(', ')}.`, node);
  },
};

// ---------------------------------------------------------------------------
// People and links
// ---------------------------------------------------------------------------

const mailPerson: Command = {
  descriptor: {
    name: 'mail',
    label: 'Send an email',
    group: 'reply',
    params: [
      { name: 'subject', type: 'string', label: 'Subject', required: true },
      { name: 'body', type: 'text', label: 'Message', required: true },
    ],
  },
  applies: (node) => node.subtype === 'person',
  async run({ node, params, context }) {
    const subject = requiredText(params, 'subject');
    return done(`Sent "${subject}" to ${label(node, context)}.`, node);
  },
};

const chatPerson: Command = {
  descriptor: {
    name: 'chat',
    label: 'Send a chat message',
    group: 'reply',
    params: [{ name: 'body', type: 'text', label: 'Message', required: true }],
  },
  applies: (node) => node.subtype === 'person',
  async run({ node, params, context }) {
    requiredText(params, 'body');
    return done(`Sent a chat message to ${label(node, context)}.`, node);
  },
};

const url: Command = {
  descriptor: { name: 'url', label: 'Show the web URL', group: 'link', key: 'u' },
  applies: (node) => node.meta?.['url'] !== undefined || node.meta?.['webUrl'] !== undefined,
  async run({ node }) {
    const link = node.meta?.['url'] ?? node.meta?.['webUrl'];
    return { ok: true, message: String(link) };
  },
};

// ---------------------------------------------------------------------------

/**
 * The order here is the order the shell and the pane offer them in, so it is chosen for
 * the reader: what you do most often first, what you cannot undo last.
 */
export const MEMORY_ACTIONS = new ActionRegistry<MemoryActionHost>([
  approve,
  requestChanges,
  reviewComment,
  reply,
  replyAll,
  forward,
  send,
  comment,
  markRead,
  markUnread,
  flag,
  unflag,
  assign,
  addLabel,
  tag,
  untag,
  archive,
  reopen,
  mailPerson,
  chatPerson,
  url,
  merge,
  close,
  remove,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function done(
  message: string,
  node: VNode,
  details: readonly string[] = [],
  undo?: UndoSpec,
): ActionResult {
  return {
    ok: true,
    message,
    // The item itself and, implicitly via the engine, its parent: a reply changes both the
    // message and the listing it lives in.
    invalidates: [node.path ?? ''],
    ...(details.length === 0 ? {} : { details }),
    // Omitted rather than sent as undefined, so a verb with no inverse reads as a hard stop
    // to the journal instead of an undo that resolves to nothing.
    ...(undo === undefined ? {} : { undo }),
  };
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 160);
}

/** `Re: Re: Subject` is noise nobody wants read aloud twice. */
function stripRe(title: string): string {
  return title.replace(/^((re|fw|fwd):\s*)+/i, '');
}

function addresses(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}
