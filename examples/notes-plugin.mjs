#!/usr/bin/env node
/**
 * A complete mscomms provider in one file, with no dependencies.
 *
 * It exposes the local filesystem as a message-like tree, which is a deliberately boring
 * choice: the point is to show the protocol, and a backend everyone already understands
 * makes the protocol the only new thing on screen.
 *
 * Mount it by adding this to your config:
 *
 *   {
 *     "path": "/notes",
 *     "type": "exec",
 *     "options": {
 *       "command": ["node", "examples/notes-plugin.mjs", "--root", "."],
 *       "capabilities": ["list", "read", "search", "poll", "actions"]
 *     }
 *   }
 *
 * PROTOCOL, IN FULL
 *
 *   Read one JSON object per line from stdin: {"id": N, "method": "...", "params": {...}}
 *   Write one JSON object per line to stdout:  {"id": N, "result": ...}
 *                                         or:  {"id": N, "error": {"code": "...", "message": "..."}}
 *
 * Anything written to stderr is logged by the host, not parsed, so `console.error` is a
 * safe debugging tool. `console.log` is NOT — it writes to the protocol stream.
 *
 * Methods, all optional except `list`:
 *   initialize     -> {protocol, displayName, capabilities}
 *   list           -> {entries: [node], cursor?}
 *   resolveChild   -> node | null
 *   read           -> {title, headers, body, format}
 *   search         -> {entries: [node]}          (nodes should carry `parentPath`)
 *   poll           -> {changes: [{type, path, at}], cursor}
 *   actions        -> [{name, label, params?, destructive?}]
 *   invoke         -> {ok, message, invalidates?}
 *   readAttachment -> {name, contentType, data: "<base64>"}
 *
 * A node is {name, id, kind: "dir"|"file", title?, mtime?, size?, flags?, summary?,
 * author?, meta?, childCount?, unreadCount?, parentPath?}. Only `name` is required;
 * `id` defaults to `name`, `kind` defaults to "file".
 */

import { createInterface } from 'node:readline';
import { readdir, readFile, stat, utimes } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const rootIndex = process.argv.indexOf('--root');
const ROOT = resolve(rootIndex === -1 ? process.cwd() : (process.argv[rootIndex + 1] ?? process.cwd()));

/** Text files only. A provider that offered to `cat` a 400 MB video would be unkind. */
const TEXT = new Set(['.md', '.txt', '.json', '.jsonc', '.ts', '.js', '.mjs', '.yml', '.yaml', '.toml', '.cfg', '.ini', '']);

const seen = new Set();

const handlers = {
  initialize() {
    return {
      protocol: 1,
      displayName: `Notes (${ROOT})`,
      capabilities: ['list', 'read', 'search', 'poll', 'actions'],
    };
  },

  async list({ parent, limit, cursor }) {
    const dir = dirOf(parent);
    const names = await readdir(dir, { withFileTypes: true });
    // Sort before slicing. A cursor is an offset into an ordering, so if the ordering is
    // not stable between calls, page 2 will skip and repeat entries at random. `readdir`
    // makes no ordering promise.
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const visible = names.filter((item) => !item.name.startsWith('.') && item.name !== 'node_modules');
    const offset = cursor ? Number(cursor) : 0;
    const take = Math.max(1, Math.min(Number(limit) || 100, 500));
    const window = visible.slice(offset, offset + take);

    const entries = [];
    for (const item of window) {
      const full = join(dir, item.name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue; // Raced with a delete. Skipping one entry beats failing the listing.
      }
      const id = relative(ROOT, full) || '.';
      entries.push({
        name: item.name,
        id,
        kind: item.isDirectory() ? 'dir' : 'file',
        title: item.name,
        subtype: item.isDirectory() ? 'folder' : 'note',
        mtime: info.mtime.toISOString(),
        size: item.isDirectory() ? undefined : info.size,
        flags: seen.has(id) || item.isDirectory() ? [] : ['unread'],
        meta: { fullPath: full },
      });
    }

    const next = offset + window.length;
    // Only send a cursor when there is genuinely more. A cursor that is always present is
    // how a client ends up paging forever.
    return {
      entries,
      total: visible.length,
      ...(next < visible.length ? { cursor: String(next) } : {}),
    };
  },

  async resolveChild({ parent, name }) {
    const full = join(dirOf(parent), name);
    if (!inRoot(full)) return null;
    try {
      const info = await stat(full);
      const id = relative(ROOT, full) || '.';
      return {
        name,
        id,
        kind: info.isDirectory() ? 'dir' : 'file',
        title: name,
        mtime: info.mtime.toISOString(),
        size: info.isDirectory() ? undefined : info.size,
      };
    } catch {
      return null;
    }
  },

  async read({ node }) {
    const full = join(ROOT, node.id);
    if (!inRoot(full)) throw fail('EACCES', 'That is outside the notes root.');
    const info = await stat(full);
    const ext = full.slice(full.lastIndexOf('.'));
    const readable = TEXT.has(ext.toLowerCase()) || !full.includes('.');
    const body = readable && info.size < 2_000_000 ? await readFile(full, 'utf8') : '(binary or very large file — not shown)';
    seen.add(node.id);
    return {
      title: node.title ?? node.name,
      headers: [
        ['Path', full],
        ['Size', `${info.size} bytes`],
        ['Modified', info.mtime.toISOString()],
      ],
      body,
      format: ext === '.md' ? 'markdown' : 'text',
    };
  },

  /**
   * Search by filename.
   *
   * Note `parentPath`: search is the one call that returns entries from many directories,
   * so each hit says where it lives. Without it the host has to assume every hit sits
   * directly under the directory being searched, and every nested result becomes
   * unopenable.
   */
  async search({ parent, query }) {
    const needle = String(query ?? '').toLowerCase().replace(/^text:/, '');
    const base = dirOf(parent);
    const entries = [];
    const walk = async (dir, depth) => {
      if (depth > 6 || entries.length >= 200) return;
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!item.name.toLowerCase().includes(needle)) continue;
        const parentRel = relative(base, dir).split(sep).join('/');
        entries.push({
          name: item.name,
          id: relative(ROOT, full),
          kind: 'file',
          title: item.name,
          parentPath: parentRel,
        });
        if (entries.length >= 200) return;
      }
    };
    await walk(base, 0);
    return { entries };
  },

  /** Change detection by mtime watermark — the pattern every pull-based backend uses. */
  async poll({ parent, cursor }) {
    const since = cursor ? Number(cursor) : 0;
    const dir = dirOf(parent);
    const changes = [];
    let newest = since;
    let items = [];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return { changes: [], cursor: String(since) };
    }
    for (const item of items) {
      if (item.isDirectory() || item.name.startsWith('.')) continue;
      const info = await stat(join(dir, item.name)).catch(() => null);
      if (!info) continue;
      const at = info.mtimeMs;
      if (at > newest) newest = at;
      if (since > 0 && at > since) {
        changes.push({ type: 'updated', path: item.name, at: new Date(at).toISOString() });
      }
    }
    return { changes, cursor: String(Math.floor(newest)) };
  },

  actions({ node }) {
    if (node?.kind === 'dir') return [];
    return [
      { name: 'touch', label: 'Mark as changed now', description: 'Set the modification time to now.' },
      { name: 'unread', label: 'Mark unread' },
    ];
  },

  async invoke({ action, node }) {
    const full = join(ROOT, node.id);
    if (!inRoot(full)) throw fail('EACCES', 'That is outside the notes root.');
    if (action === 'touch') {
      const now = new Date();
      await utimes(full, now, now);
      return { ok: true, message: `Touched ${node.name}.`, invalidates: [node.id] };
    }
    if (action === 'unread') {
      seen.delete(node.id);
      return { ok: true, message: `Marked ${node.name} unread.` };
    }
    throw fail('ENOTSUP', `Unknown action "${action}".`);
  },
};

function dirOf(parent) {
  if (!parent) return ROOT;
  const full = join(ROOT, parent.id);
  if (!inRoot(full)) throw fail('EACCES', 'That is outside the notes root.');
  return full;
}

/** Containment check, because `id` comes back from the host and a `..` must not escape. */
function inRoot(candidate) {
  const full = resolve(candidate);
  return full === ROOT || full.startsWith(ROOT + sep);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  void respond(line);
});

async function respond(line) {
  const text = line.trim();
  if (text === '') return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    console.error(`could not parse request: ${text.slice(0, 120)}`);
    return;
  }
  const handler = handlers[request.method];
  if (!handler) {
    reply({ id: request.id, error: { code: 'ENOTSUP', message: `Unsupported method "${request.method}".` } });
    return;
  }
  try {
    const result = await handler(request.params ?? {});
    reply({ id: request.id, result });
  } catch (error) {
    reply({
      id: request.id,
      error: { code: error.code ?? 'EINTERNAL', message: error.message ?? String(error) },
    });
  }
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
