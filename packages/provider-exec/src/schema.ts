/**
 * Defensive decoding of whatever the plugin program actually sent.
 *
 * Everything crossing this boundary is untrusted in the "written by a well-meaning person
 * at 1am in a language without types" sense. A plugin that emits `"size": "12kb"` or
 * forgets `id` must produce a legible complaint or a sensible default, never a TypeError
 * ten frames deep in the renderer.
 *
 * The rule applied throughout: reject when the field carries identity (a node with no
 * usable `id` is unusable), coerce or drop when it is decoration (a bad `size` is worth
 * less than the listing it would take down).
 */

import { VfsError, type AttachmentRef, type ChangeEvent, type Document, type ListPage, type MetaValue, type VNode } from '@mscomms/core';
import type { ActionDescriptor, ActionResult, PollResult } from '@mscomms/core';

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Tolerate "42" — JSON from shell pipelines is stringly-typed more often than not.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function date(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below 1e12 is far more likely to be seconds than 1970.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const text = str(value);
  if (text === undefined) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item !== '');
  return out.length === 0 ? undefined : out;
}

function meta(value: unknown): Readonly<Record<string, MetaValue>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, MetaValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      out[key] = item;
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      out[key] = item;
    } else if (item !== undefined) {
      // Nested structure flattened rather than dropped: `stat` showing
      // `labels: ["bug","p1"]` is more useful than showing nothing.
      out[key] = JSON.stringify(item);
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Decode one node.
 *
 * `id` and `name` are required because they are identity. Everything else is optional and
 * is quietly dropped when malformed.
 */
export function decodeNode(value: unknown, where: string): VNode {
  if (!isRecord(value)) {
    throw new VfsError('EINTERNAL', `The provider program returned something that is not an entry (in ${where}).`);
  }
  const name = str(value['name']);
  const id = str(value['id']) ?? name;
  if (name === undefined || id === undefined) {
    throw new VfsError('EINTERNAL', `The provider program returned an entry with no "name" (in ${where}).`, {
      hint: 'Every entry needs at least {"name": "...", "kind": "file"}.',
    });
  }
  const kindRaw = str(value['kind']);
  const kind = kindRaw === 'dir' || kindRaw === 'directory' || kindRaw === 'folder' ? 'dir' : 'file';
  const mtime = date(value['mtime'] ?? value['date'] ?? value['updated']);
  const size = num(value['size']);
  const childCount = num(value['childCount']);
  const unreadCount = num(value['unreadCount']);
  const flags = strings(value['flags']);
  const metaValue = meta(value['meta']);

  return {
    name,
    id,
    kind,
    title: str(value['title']) ?? name,
    ...(str(value['subtype']) === undefined ? {} : { subtype: str(value['subtype']) as string }),
    ...(str(value['parentPath']) === undefined ? {} : { parentPath: str(value['parentPath']) as string }),
    ...(mtime === undefined ? {} : { mtime }),
    ...(size === undefined ? {} : { size }),
    ...(flags === undefined ? {} : { flags }),
    ...(str(value['summary']) === undefined ? {} : { summary: str(value['summary']) as string }),
    ...(str(value['author']) === undefined ? {} : { author: str(value['author']) as string }),
    ...(str(value['authorId']) === undefined ? {} : { authorId: str(value['authorId']) as string }),
    ...(metaValue === undefined ? {} : { meta: metaValue }),
    ...(childCount === undefined ? {} : { childCount }),
    ...(unreadCount === undefined ? {} : { unreadCount }),
  };
}

export function decodeListPage(value: unknown, where: string): ListPage {
  // A plugin that just prints an array is doing the obvious thing; accept it.
  const raw: Raw = Array.isArray(value) ? { entries: value } : isRecord(value) ? value : {};
  const list = raw['entries'] ?? raw['items'] ?? raw['nodes'];
  if (!Array.isArray(list)) {
    throw new VfsError('EINTERNAL', `The provider program did not return a list of entries (in ${where}).`, {
      hint: 'Return {"entries": [ ... ]} or just an array.',
    });
  }
  const entries = list.map((entry) => decodeNode(entry, where));
  const cursor = str(raw['cursor']);
  const total = num(raw['total']);
  return {
    entries,
    ...(cursor === undefined ? {} : { cursor }),
    ...(total === undefined ? {} : { total }),
    ...(bool(raw['fromCache']) === undefined ? {} : { fromCache: bool(raw['fromCache']) as boolean }),
  };
}

export function decodeDocument(value: unknown, fallbackTitle: string): Document {
  if (typeof value === 'string') {
    // A plugin that returns the body as a bare string is unambiguous. Honour it.
    return { title: fallbackTitle, headers: [], body: value, format: 'text' };
  }
  if (!isRecord(value)) {
    throw new VfsError('EINTERNAL', 'The provider program did not return a document.');
  }
  const formatRaw = str(value['format']);
  const format = formatRaw === 'html' || formatRaw === 'markdown' ? formatRaw : 'text';
  const attachments = decodeAttachments(value['attachments']);
  return {
    title: str(value['title']) ?? fallbackTitle,
    headers: decodeHeaders(value['headers']),
    body: typeof value['body'] === 'string' ? value['body'] : '',
    format,
    ...(attachments === undefined ? {} : { attachments }),
    ...(str(value['webUrl']) === undefined ? {} : { webUrl: str(value['webUrl']) as string }),
    ...(str(value['threadId']) === undefined ? {} : { threadId: str(value['threadId']) as string }),
  };
}

/**
 * Headers, in the order the plugin gave them.
 *
 * Both an array of pairs and a plain object are accepted, because a plain object is what
 * everyone writes first. Object key order is preserved by every JSON parser in practice,
 * and header order is an accessibility concern — it is literally the order a screen reader
 * will speak the fields.
 */
function decodeHeaders(value: unknown): ReadonlyArray<readonly [string, string]> {
  if (Array.isArray(value)) {
    const out: Array<readonly [string, string]> = [];
    for (const item of value) {
      if (Array.isArray(item) && typeof item[0] === 'string') {
        out.push([item[0], String(item[1] ?? '')]);
      } else if (isRecord(item)) {
        const label = str(item['label']) ?? str(item['name']);
        if (label !== undefined) out.push([label, String(item['value'] ?? '')]);
      }
    }
    return out;
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([label, item]) => [label, String(item ?? '')] as const);
  }
  return [];
}

function decodeAttachments(value: unknown): readonly AttachmentRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: AttachmentRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = str(item['name']);
    if (name === undefined) continue;
    const size = num(item['size']);
    out.push({
      id: str(item['id']) ?? name,
      name,
      ...(size === undefined ? {} : { size }),
      ...(str(item['contentType']) === undefined ? {} : { contentType: str(item['contentType']) as string }),
      ...(bool(item['inline']) === undefined ? {} : { inline: bool(item['inline']) as boolean }),
    });
  }
  return out.length === 0 ? undefined : out;
}

export function decodePollResult(value: unknown): PollResult {
  const raw: Raw = Array.isArray(value) ? { changes: value } : isRecord(value) ? value : {};
  const list = Array.isArray(raw['changes']) ? raw['changes'] : [];
  const changes: ChangeEvent[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const path = str(item['path']);
    if (path === undefined) continue;
    const typeRaw = str(item['type']);
    const type = typeRaw === 'updated' || typeRaw === 'deleted' ? typeRaw : 'created';
    let node: VNode | undefined;
    if (isRecord(item['node'])) {
      try {
        node = decodeNode(item['node'], 'poll');
      } catch {
        node = undefined; // A malformed node costs the preview, not the notification.
      }
    }
    changes.push({
      type,
      path,
      at: date(item['at']) ?? new Date(),
      ...(node === undefined ? {} : { node }),
    });
  }
  const cursor = str(raw['cursor']);
  const retryAfter = num(raw['retryAfter']);
  return {
    changes,
    ...(cursor === undefined ? {} : { cursor }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

export function decodeActions(value: unknown): readonly ActionDescriptor[] {
  if (!Array.isArray(value)) return [];
  const out: ActionDescriptor[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      out.push({ name: item, label: item });
      continue;
    }
    if (!isRecord(item)) continue;
    const name = str(item['name']);
    if (name === undefined) continue;
    const params = decodeParams(item['params']);
    out.push({
      name,
      label: str(item['label']) ?? name,
      ...(str(item['description']) === undefined ? {} : { description: str(item['description']) as string }),
      ...(params === undefined ? {} : { params }),
      ...(bool(item['destructive']) === undefined ? {} : { destructive: bool(item['destructive']) as boolean }),
    });
  }
  return out;
}

function decodeParams(value: unknown): ActionDescriptor['params'] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<ActionDescriptor['params']>[number][] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = str(item['name']);
    if (name === undefined) continue;
    const typeRaw = str(item['type']) ?? 'string';
    const type =
      typeRaw === 'text' || typeRaw === 'boolean' || typeRaw === 'number' || typeRaw === 'path' || typeRaw === 'choice'
        ? typeRaw
        : 'string';
    const choices = strings(item['choices']);
    out.push({
      name,
      type,
      label: str(item['label']) ?? name,
      ...(bool(item['required']) === undefined ? {} : { required: bool(item['required']) as boolean }),
      ...(choices === undefined ? {} : { choices }),
    });
  }
  return out.length === 0 ? undefined : out;
}

export function decodeActionResult(value: unknown, action: string): ActionResult {
  if (!isRecord(value)) {
    return { ok: true, message: `${action} done.` };
  }
  const invalidates = strings(value['invalidates']);
  return {
    ok: bool(value['ok']) ?? true,
    message: str(value['message']) ?? `${action} done.`,
    ...(invalidates === undefined ? {} : { invalidates }),
  };
}

export function decodeAttachmentBytes(value: unknown): { name: string; contentType: string; data: Uint8Array } {
  if (!isRecord(value)) {
    throw new VfsError('EINTERNAL', 'The provider program did not return attachment data.');
  }
  const base64 = str(value['data']) ?? str(value['base64']);
  if (base64 === undefined) {
    throw new VfsError('EINTERNAL', 'The provider program returned an attachment with no data.', {
      hint: 'Return {"name": "...", "contentType": "...", "data": "<base64>"}.',
    });
  }
  return {
    name: str(value['name']) ?? 'attachment',
    contentType: str(value['contentType']) ?? 'application/octet-stream',
    data: Buffer.from(base64, 'base64'),
  };
}
