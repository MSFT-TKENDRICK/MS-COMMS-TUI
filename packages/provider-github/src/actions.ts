/**
 * GitHub node actions.
 *
 * The tree is intentionally read-shaped, but reviewing a pull request is not a read-only
 * activity: the useful next step from the PR document is often "approve", "request changes"
 * or "merge". Keeping those verbs next to the node mapping means the shell can present a
 * keyboard- and screen-reader-friendly review flow without knowing GitHub's endpoint split.
 */

import {
  ActionRegistry,
  metaNumber,
  metaText,
  optionalText,
  requiredText,
  VfsError,
  type ActionCommand,
  type ActionResult,
  type VNode,
} from '@mscomms/core';

import type { GitHubClient } from './client.js';

export interface GitHubActionContext {
  readonly client: GitHubClient;
}

interface AddDiscussionCommentResponse {
  readonly addDiscussionComment?: { readonly comment?: { readonly id?: string } | null } | null;
}

const bodyParam = { name: 'body', type: 'text' as const, label: 'Comment body' };
const requiredBodyParam = { ...bodyParam, required: true };
const ownPath = (node: VNode): readonly string[] => [node.path ?? ''];

function isSubtype(node: VNode, ...subtypes: readonly string[]): boolean {
  return node.kind === 'file' && node.subtype !== undefined && subtypes.includes(node.subtype);
}

function isOpen(node: VNode): boolean {
  return node.flags?.includes('open') === true || node.meta?.['state'] === 'open';
}

function isClosed(node: VNode): boolean {
  return node.flags?.includes('closed') === true || node.meta?.['state'] === 'closed';
}

function isMerged(node: VNode): boolean {
  return node.flags?.includes('merged') === true || node.meta?.['state'] === 'merged';
}

function isDraft(node: VNode): boolean {
  return node.flags?.includes('draft') === true;
}

function issuePath(node: VNode): string {
  return `/repos/${encodeURIComponent(metaText(node, 'owner'))}/${encodeURIComponent(metaText(node, 'repo'))}/issues/${String(metaNumber(node, 'number'))}`;
}

function pullPath(node: VNode): string {
  return `/repos/${encodeURIComponent(metaText(node, 'owner'))}/${encodeURIComponent(metaText(node, 'repo'))}/pulls/${String(metaNumber(node, 'number'))}`;
}

function splitComma(value: string, what: string): readonly string[] {
  const items = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (items.length === 0) {
    throw VfsError.invalid(`${what} must name at least one value.`, `Pass a comma-separated list, for example: ${what}=alice,bob.`);
  }
  return items;
}

function titleOf(node: VNode): string {
  return node.title === '' ? node.name : node.title;
}

function acted(action: string, node: VNode): ActionResult {
  return { ok: true, message: `${action} ${titleOf(node)}.`, invalidates: ownPath(node) };
}

const approve: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'approve',
    label: 'Approve this pull request',
    description: 'Submit an approving pull request review.',
    params: [bodyParam],
    group: 'review',
    key: 'a',
  },
  applies: (node) => isSubtype(node, 'pull') && isOpen(node),
  async run({ node, params, context }) {
    const body = optionalText(params, 'body');
    await context.client.post(`${pullPath(node)}/reviews`, {
      event: 'APPROVE',
      ...(body === undefined ? {} : { body }),
    });
    return acted('Approved', node);
  },
};

const requestChanges: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'request-changes',
    label: 'Request changes on this pull request',
    description: 'Submit a pull request review that asks for changes.',
    params: [requiredBodyParam],
    group: 'review',
    key: 'x',
  },
  applies: (node) => isSubtype(node, 'pull') && isOpen(node),
  async run({ node, params, context }) {
    await context.client.post(`${pullPath(node)}/reviews`, {
      event: 'REQUEST_CHANGES',
      body: requiredText(params, 'body'),
    });
    return acted('Requested changes on', node);
  },
};

const commentReview: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'comment-review',
    label: 'Leave a pull request review comment',
    description: 'Submit a non-approving pull request review comment.',
    params: [requiredBodyParam],
    group: 'review',
  },
  applies: (node) => isSubtype(node, 'pull') && isOpen(node),
  async run({ node, params, context }) {
    await context.client.post(`${pullPath(node)}/reviews`, {
      event: 'COMMENT',
      body: requiredText(params, 'body'),
    });
    return acted('Commented on the review for', node);
  },
};

const comment: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'comment',
    label: 'Add a comment',
    description: 'Post a comment to this GitHub conversation.',
    params: [requiredBodyParam],
    group: 'discuss',
    key: 'c',
  },
  applies: (node) => isSubtype(node, 'issue', 'pull', 'discussion'),
  async run({ node, params, context }) {
    const body = requiredText(params, 'body');
    if (node.subtype === 'discussion') {
      await context.client.graphql<AddDiscussionCommentResponse>(
        `
mutation AddDiscussionComment($discussionId: ID!, $body: String!) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
    comment { id }
  }
}`,
        { discussionId: metaText(node, 'discussionId'), body },
      );
    } else {
      await context.client.post(`${issuePath(node)}/comments`, { body });
    }
    return acted('Commented on', node);
  },
};

const merge: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'merge',
    label: 'Merge this pull request',
    description: 'Merge the pull request using the selected GitHub merge method.',
    params: [
      { name: 'method', type: 'choice', label: 'Merge method', choices: ['merge', 'squash', 'rebase'], default: 'merge' },
      { name: 'title', type: 'string', label: 'Commit title' },
      { name: 'message', type: 'text', label: 'Commit message' },
    ],
    destructive: true,
    group: 'land',
    key: 'm',
  },
  applies: (node) => isSubtype(node, 'pull') && isOpen(node) && !isDraft(node),
  async run({ node, params, context }) {
    const title = optionalText(params, 'title');
    const message = optionalText(params, 'message');
    await context.client.put(`${pullPath(node)}/merge`, {
      merge_method: requiredText(params, 'method'),
      ...(title === undefined ? {} : { commit_title: title }),
      ...(message === undefined ? {} : { commit_message: message }),
    });
    return acted('Merged', node);
  },
};

const close: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'close',
    label: 'Close this item',
    description: 'Close this issue or pull request.',
    params: [{ name: 'reason', type: 'choice', label: 'Close reason', choices: ['completed', 'not_planned'] }],
    destructive: true,
    group: 'land',
  },
  applies: (node) => isSubtype(node, 'issue', 'pull') && isOpen(node),
  async run({ node, params, context }) {
    if (node.subtype === 'pull') {
      await context.client.patch(pullPath(node), { state: 'closed' });
    } else {
      const reason = optionalText(params, 'reason');
      await context.client.patch(issuePath(node), {
        state: 'closed',
        ...(reason === undefined ? {} : { state_reason: reason }),
      });
    }
    return acted('Closed', node);
  },
};

const reopen: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'reopen',
    label: 'Reopen this item',
    description: 'Reopen this issue or pull request.',
    group: 'land',
  },
  applies: (node) => isSubtype(node, 'issue', 'pull') && isClosed(node) && !isMerged(node),
  async run({ node, context }) {
    await context.client.patch(node.subtype === 'pull' ? pullPath(node) : issuePath(node), { state: 'open' });
    return acted('Reopened', node);
  },
};

const requestReview: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'request-review',
    label: 'Request a pull request review',
    description: 'Ask GitHub users to review this pull request.',
    params: [{ name: 'reviewers', type: 'string', label: 'Reviewer logins', required: true }],
    group: 'review',
  },
  applies: (node) => isSubtype(node, 'pull') && isOpen(node),
  async run({ node, params, context }) {
    await context.client.post(`${pullPath(node)}/requested_reviewers`, {
      reviewers: splitComma(requiredText(params, 'reviewers'), 'reviewers'),
    });
    return acted('Requested reviewers for', node);
  },
};

const assign: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'assign',
    label: 'Assign this item',
    description: 'Assign one or more GitHub users.',
    params: [{ name: 'assignees', type: 'string', label: 'Assignee logins', required: true }],
    group: 'triage',
  },
  applies: (node) => isSubtype(node, 'issue', 'pull'),
  async run({ node, params, context }) {
    await context.client.post(`${issuePath(node)}/assignees`, {
      assignees: splitComma(requiredText(params, 'assignees'), 'assignees'),
    });
    return acted('Assigned', node);
  },
};

const label: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'label',
    label: 'Label this item',
    description: 'Add one or more labels.',
    params: [{ name: 'labels', type: 'string', label: 'Labels', required: true }],
    group: 'triage',
  },
  applies: (node) => isSubtype(node, 'issue', 'pull'),
  async run({ node, params, context }) {
    await context.client.post(`${issuePath(node)}/labels`, {
      labels: splitComma(requiredText(params, 'labels'), 'labels'),
    });
    return acted('Labeled', node);
  },
};

const readNotification: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'read',
    label: 'Mark this notification as read',
    description: 'Mark the GitHub notification thread as read.',
    group: 'triage',
  },
  applies: (node) => isSubtype(node, 'notification'),
  async run({ node, context }) {
    await context.client.patch(`/notifications/threads/${encodeURIComponent(metaText(node, 'threadId'))}`, {});
    return acted('Marked as read', node);
  },
};

const unsubscribe: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'unsubscribe',
    label: 'Unsubscribe from this notification',
    description: 'Ignore future notifications from this thread.',
    destructive: true,
    group: 'triage',
  },
  applies: (node) => isSubtype(node, 'notification'),
  async run({ node, context }) {
    await context.client.put(`/notifications/threads/${encodeURIComponent(metaText(node, 'threadId'))}/subscription`, {
      ignored: true,
    });
    return acted('Unsubscribed from', node);
  },
};

const url: ActionCommand<GitHubActionContext> = {
  descriptor: {
    name: 'url',
    label: 'Show the web URL',
    description: 'Print the canonical GitHub URL for this item.',
    group: 'link',
    key: 'u',
  },
  applies: (node) => node.meta?.['url'] !== undefined,
  async run({ node }) {
    return { ok: true, message: String(node.meta?.['url'] ?? '') };
  },
};

export const GITHUB_ACTIONS = new ActionRegistry<GitHubActionContext>([
  approve,
  requestChanges,
  commentReview,
  comment,
  merge,
  close,
  reopen,
  requestReview,
  assign,
  label,
  readNotification,
  unsubscribe,
  url,
]);
