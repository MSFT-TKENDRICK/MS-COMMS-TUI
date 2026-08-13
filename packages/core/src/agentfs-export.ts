/**
 * Exporting the snapshot as an AgentFS filesystem.
 *
 * The cache already knows the shape of your mail; this writes that shape down in a form
 * anything can open. After an export, `agentfs mount cache.agentfs.db ./mnt` makes every
 * cached message a real file, so the tools you already have — `rg`, `fzf`, `less`, an
 * editor, another agent — work on your mail without going near a mail API.
 *
 * Two properties of the engine make this sound rather than merely plausible:
 *
 * The paths are already filenames. `NameAllocator` sanitises embedded slashes, neutralises
 * reserved Windows device names, strips right-to-left overrides, and disambiguates
 * collisions with a `~2` suffix. AgentFS enforces `UNIQUE(parent_ino, name)`, so two
 * messages with the same subject would otherwise collide and one would silently vanish —
 * the same failure the snapshot itself had before the naming fix.
 *
 * The body is optional. A cached listing without a cached body still exports, as a file
 * containing just the headers. A folder you have browsed but not read is more useful as a
 * directory of stubs than as nothing at all, and `rg` can still find a sender in it.
 */

import type { SnapshotStore } from './snapshot.js';
import type { SqlDriver } from './sql.js';
import type { Document, VNode } from './provider.js';
import { agentFsDatabase, loadAgentFs, type AgentFsLike, type KvStoreLike } from './agentfs.js';
import * as vpath from './vpath.js';

export interface AgentFsExportOptions {
  /** Where the exported filesystem is written. Usually a fresh file, not the snapshot. */
  readonly driver: SqlDriver;
  readonly snapshot: SnapshotStore;
  /** Called per item so a long export can show progress rather than appearing hung. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface AgentFsExportResult {
  readonly directories: number;
  readonly files: number;
  /** Files written with headers only, because no body was cached. */
  readonly stubs: number;
  readonly bytes: number;
  /** Paths that could not be written, with the reason. Never thrown — see below. */
  readonly skipped: ReadonlyArray<{ path: string; reason: string }>;
  readonly via: 'package' | 'submodule';
}

/**
 * Write the cache into an AgentFS database.
 *
 * A single unwritable item does not fail the export. The output is a convenience view of a
 * cache that is itself deliberately incomplete, so refusing to produce 4,000 usable files
 * because one had an unrepresentable name would be the wrong trade — and the caller still
 * learns exactly what was dropped, because `skipped` is part of the result rather than a
 * log line nobody reads.
 */
export async function exportToAgentFs(options: AgentFsExportOptions): Promise<AgentFsExportResult> {
  const { AgentFS, KvStore, via } = await loadAgentFs();
  const db = agentFsDatabase(options.driver);
  const fs = await AgentFS.fromDatabase(db);
  const kv = await KvStore.fromDatabase(db);

  const entries = await options.snapshot.entries();
  const made = new Set<string>(['/']);
  const skipped: Array<{ path: string; reason: string }> = [];
  let directories = 0;
  let files = 0;
  let stubs = 0;
  let bytes = 0;
  let done = 0;

  for (const { node, path } of entries) {
    try {
      if (node.kind === 'dir') {
        if (await ensureDir(fs, path, made)) directories += 1;
      } else {
        // The parent may be absent from `nodes` if only children were cached, so create
        // it rather than assume the ordering did it for us.
        await ensureDir(fs, vpath.dirname(path), made);
        const stored = await options.snapshot.document(path);
        const content = renderMessage(node, path, stored?.doc);
        if (stored === undefined) stubs += 1;
        await fs.writeFile(path, content);
        files += 1;
        bytes += Buffer.byteLength(content);
      }
    } catch (error) {
      skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
    done += 1;
    options.onProgress?.(done, entries.length);
  }

  await writeManifest(kv, { directories, files, stubs, bytes, skipped: skipped.length });
  return { directories, files, stubs, bytes, skipped, via };
}

/**
 * Create a directory and its parents, remembering what exists.
 *
 * AgentFS's `mkdir` is deliberately not recursive and throws `EEXIST` rather than being
 * idempotent, so the walk and the bookkeeping are ours to do. Returns whether anything was
 * created, so the caller can count directories without counting them twice.
 */
async function ensureDir(fs: AgentFsLike, path: string, made: Set<string>): Promise<boolean> {
  const normalized = vpath.normalize(path);
  if (made.has(normalized) || normalized === '/') return false;

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  let current = '';
  let created = false;
  for (const segment of segments) {
    current += `/${segment}`;
    if (made.has(current)) continue;
    try {
      await fs.mkdir(current);
      created = true;
    } catch (error) {
      // EEXIST means a previous export, or a concurrent branch of this one, already made
      // it. That is the goal state, not a failure.
      if (!isEexist(error)) throw error;
    }
    made.add(current);
  }
  return created;
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST';
}

/**
 * Render a node as message text.
 *
 * RFC 822-ish on purpose: a blank line between headers and body is what every tool that has
 * ever opened a `.eml` expects, and it costs nothing to be conventional. The headers come
 * from the cached document when there is one and from the listing when there is not, so a
 * stub still carries the sender and date that make it findable.
 */
function renderMessage(node: VNode, path: string, doc?: Document): string {
  const headers = new Map<string, string>();
  headers.set('Subject', node.title);
  if (node.author !== undefined) headers.set('From', node.author);
  if (node.mtime !== undefined) headers.set('Date', node.mtime.toUTCString());
  if (node.flags !== undefined && node.flags.length > 0) headers.set('X-Flags', node.flags.join(', '));
  headers.set('X-Snapshot-Path', path);
  for (const [label, value] of doc?.headers ?? []) {
    // Provider headers win: they are the real thing, and the listing's are a summary of it.
    if (value.length > 0) headers.set(label, value);
  }
  if (doc?.webUrl !== undefined) headers.set('X-Web-Url', doc.webUrl);
  for (const attachment of doc?.attachments ?? []) {
    // Repeated rather than joined, so a filename containing a comma stays one filename.
    headers.set(`X-Attachment-${String(headers.size)}`, attachment.name);
  }

  const rendered = [...headers].map(([key, value]) => `${key}: ${collapse(value)}`).join('\r\n');
  const body = doc?.body ?? '';
  return `${rendered}\r\n\r\n${body}`;
}

/** A newline inside a header value would end the header block early and split the message. */
function collapse(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Record what this export is, in the key-value store the specification provides for exactly
 * this kind of thing. An agent that opens the file can then tell a partial cache from a
 * complete mailbox without having to infer it from the file count.
 */
async function writeManifest(
  kv: KvStoreLike,
  counts: { directories: number; files: number; stubs: number; bytes: number; skipped: number },
): Promise<void> {
  await kv.set('mscomms:export', {
    exportedAt: new Date().toISOString(),
    source: 'mscomms-tui snapshot',
    ...counts,
    // Said plainly, because the alternative is someone treating this as an archive.
    completeness: 'Partial: the snapshot holds recent items only, and is not a backup.',
  });
}
