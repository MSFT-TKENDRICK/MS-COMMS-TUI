/**
 * Azure DevOps work-item actions.
 *
 * Boards work items are shared records, not local notes. Every update therefore goes
 * through Azure DevOps' JSON Patch API with a revision test when the listing supplied one:
 * without that guard, assigning a stale node could silently overwrite somebody else's edit
 * and make the filesystem view look more authoritative than the system of record.
 */

import {
  ActionRegistry,
  metaNumber,
  metaText,
  requiredText,
  type ActionResult,
  type MetaValue,
  type VNode,
} from '@mscomms/core';

import { AdoClient, segment } from './client.js';

export interface AdoActionContext {
  readonly client: AdoClient;
}

type JsonPatchValue = string | number | boolean;

interface JsonPatchOperation {
  readonly op: 'add' | 'test';
  readonly path: string;
  readonly value: JsonPatchValue;
}

interface StateShape {
  readonly states: readonly string[];
  readonly closed: string;
}

const STATES_BY_TYPE = new Map<string, StateShape>([
  ['bug', { states: ['New', 'Active', 'Resolved', 'Closed'], closed: 'Closed' }],
  ['user story', { states: ['New', 'Active', 'Resolved', 'Closed'], closed: 'Closed' }],
  ['feature', { states: ['New', 'Active', 'Resolved', 'Closed'], closed: 'Closed' }],
  ['epic', { states: ['New', 'Active', 'Resolved', 'Closed'], closed: 'Closed' }],
  ['task', { states: ['New', 'Active', 'Closed', 'To Do', 'Doing', 'In Progress', 'Done'], closed: 'Done' }],
  ['issue', { states: ['To Do', 'Doing', 'Done'], closed: 'Done' }],
]);

const COMMON_STATES = [...new Set([...STATES_BY_TYPE.values()].flatMap((shape) => shape.states))];

const CLOSED_STATES = new Set(['closed', 'done', 'completed', 'removed', 'cut', 'abandoned']);

export const ADO_ACTIONS = new ActionRegistry<AdoActionContext>([
  {
    descriptor: {
      name: 'comment',
      label: 'Add a discussion comment',
      description: 'Add a comment to the Azure DevOps work item discussion.',
      group: 'discuss',
      key: 'c',
      params: [{ name: 'body', type: 'text', label: 'Comment body', required: true }],
    },
    applies: isWorkItem,
    async run({ node, params, context }) {
      const body = requiredText(params, 'body');
      const project = metaText(node, 'project');
      const id = metaNumber(node, 'workItemId');

      // The comments API is still preview, but the client already allows per-request
      // versions for the read path. Using the discussion endpoint preserves a real comment
      // instead of smuggling text through System.History, which Azure DevOps renders as an
      // update narrative rather than as a first-class discussion item.
      await context.client.post(
        `/${segment(project)}/_apis/wit/workItems/${String(id)}/comments`,
        { text: body },
        { apiVersion: '7.0-preview.3' },
      );

      return changed(node, `Added a comment to ${labelFor(node)}.`);
    },
  },
  {
    descriptor: {
      name: 'assign',
      label: 'Assign the work item',
      description: 'Assign this Azure DevOps work item to a person by email, UPN or display name.',
      group: 'triage',
      key: 'a',
      params: [{ name: 'to', type: 'string', label: 'Assignee', required: true }],
    },
    applies: isWorkItem,
    async run({ node, params, context }) {
      const to = requiredText(params, 'to');
      await patchFields(context.client, node, [{ op: 'add', path: '/fields/System.AssignedTo', value: to }]);
      return changed(node, `Assigned ${labelFor(node)} to ${to}.`);
    },
  },
  {
    descriptor: {
      name: 'state',
      label: 'Change the state',
      description: 'Move this work item to a common Azure DevOps process state.',
      group: 'triage',
      key: 's',
      params: [
        {
          name: 'state',
          type: 'choice',
          label: 'State',
          required: true,
          choices: COMMON_STATES,
        },
      ],
    },
    applies: isWorkItem,
    async run({ node, params, context }) {
      const state = requiredText(params, 'state');
      await patchFields(context.client, node, [{ op: 'add', path: '/fields/System.State', value: state }]);
      return changed(node, `Moved ${labelFor(node)} to ${state}.`);
    },
  },
  {
    descriptor: {
      name: 'close',
      label: 'Close the work item',
      description: 'Move this work item to the closed or done state for its type.',
      destructive: true,
      group: 'triage',
    },
    applies: (node) => {
      const state = metaTextOrEmpty(node, 'state');
      return isWorkItem(node) && state !== '' && !isClosed(state);
    },
    async run({ node, context }) {
      const state = closedStateFor(metaTextOrEmpty(node, 'type'));
      await patchFields(context.client, node, [{ op: 'add', path: '/fields/System.State', value: state }]);
      return changed(node, `Closed ${labelFor(node)} as ${state}.`);
    },
  },
  {
    descriptor: {
      name: 'title',
      label: 'Rename the work item',
      description: 'Update the Azure DevOps work item title.',
      group: 'edit',
      params: [{ name: 'title', type: 'string', label: 'Title', required: true }],
    },
    applies: isWorkItem,
    async run({ node, params, context }) {
      const title = requiredText(params, 'title');
      await patchFields(context.client, node, [{ op: 'add', path: '/fields/System.Title', value: title }]);
      return changed(node, `Renamed ${labelFor(node)} to "${title}".`);
    },
  },
  {
    descriptor: {
      name: 'tag',
      label: 'Add tags',
      description: 'Append one or more Azure DevOps tags without replacing the existing tag list.',
      group: 'triage',
      params: [{ name: 'tags', type: 'string', label: 'Tags', required: true }],
    },
    applies: isWorkItem,
    async run({ node, params, context }) {
      const additions = splitTags(requiredText(params, 'tags'));
      const existing = splitTags(metaTextOrEmpty(node, 'tagsRaw'));
      const seen = new Set(existing.map((tag) => tag.toLowerCase()));
      const merged = [...existing];
      for (const tag of additions) {
        if (seen.has(tag.toLowerCase())) continue;
        seen.add(tag.toLowerCase());
        merged.push(tag);
      }
      const value = merged.join('; ');
      await patchFields(context.client, node, [{ op: 'add', path: '/fields/System.Tags', value }]);
      return changed(node, `Added tags to ${labelFor(node)}: ${additions.join(', ')}.`);
    },
  },
  {
    descriptor: {
      name: 'url',
      label: 'Show the web URL',
      description: 'Print the canonical Azure DevOps URL for this work item.',
      group: 'link',
      key: 'u',
    },
    applies: (node) => isWorkItem(node) && node.meta?.['url'] !== undefined,
    async run({ node }) {
      return { ok: true, message: metaText(node, 'url') };
    },
  },
]);

function isWorkItem(node: VNode): boolean {
  return node.kind === 'file' && node.subtype === 'workitem' && node.meta?.['level'] === 'workitem';
}

async function patchFields(client: AdoClient, node: VNode, operations: readonly JsonPatchOperation[]): Promise<void> {
  const project = metaText(node, 'project');
  const id = metaNumber(node, 'workItemId');
  await client.patch(
    `/${segment(project)}/_apis/wit/workitems/${String(id)}`,
    [...revisionTest(node), ...operations],
    { contentType: 'application/json-patch+json' },
  );
}

function revisionTest(node: VNode): readonly JsonPatchOperation[] {
  if (node.meta?.['rev'] === undefined) return [];
  // A revision test turns a stale directory entry into a rejected update instead of a lost
  // update. Azure DevOps compares it before applying the remaining operations.
  return [{ op: 'test', path: '/rev', value: metaNumber(node, 'rev') }];
}

function closedStateFor(type: string): string {
  return STATES_BY_TYPE.get(type.toLowerCase())?.closed ?? 'Closed';
}

function isClosed(state: string): boolean {
  return CLOSED_STATES.has(state.toLowerCase());
}

function labelFor(node: VNode): string {
  const id = metaText(node, 'workItemId');
  const title = node.title.replace(new RegExp(`^#${id}\\s+`), '');
  return `#${id} "${title}"`;
}

function changed(node: VNode, message: string): ActionResult {
  return {
    ok: true,
    message,
    ...(node.path === undefined ? {} : { invalidates: [node.path] }),
  };
}

function metaTextOrEmpty(node: VNode, key: string): string {
  const value: MetaValue | undefined = node.meta?.[key];
  return value === undefined || value === null ? '' : String(value);
}

function splitTags(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}
