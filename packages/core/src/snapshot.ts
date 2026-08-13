/**
 * The local snapshot: a libSQL/Turso database holding the recent past of every mount.
 *
 * This is the thing docs/ARCHITECTURE.md used to say was deliberately absent. The
 * reasoning for leaving it out was sound — "the cache is a cache, not a store; there is
 * no local mirror to fall out of date" — and it is worth being precise about which part
 * of that reasoning this store keeps and which part it spends.
 *
 * It keeps the part that matters: THE SNAPSHOT IS NEVER AUTHORITATIVE. It answers
 * questions the network would answer more slowly, and it is allowed to be wrong. Nothing
 * here decides that an item does not exist; a search consults the snapshot *and then* the
 * live provider, and a listing served from the snapshot is refreshed behind the user's
 * back. Deletions therefore converge rather than lingering, and the pathology the old
 * note warned about — "why does it show a message I deleted last week" — is bounded by
 * one refresh rather than by a reconciliation protocol nobody wants to own.
 *
 * It spends the part about not persisting anything, and buys three things with it:
 *
 *   - `ls` on a directory you have visited before returns from disk, in a millisecond,
 *     before any network call is made. A cold start stops being a cold start.
 *   - Search has a local index. `find -a` can answer from SQLite's own FTS5 and from a
 *     vector index over the same rows, and only then go to the network — which is the
 *     difference between "search is instant and then gets better" and "search is a
 *     four-second wait behind the slowest tenant you are signed in to".
 *   - `body:` terms become decidable offline. The live engine has to answer `unknown` for
 *     a content query it has not fetched bodies for; the snapshot has the bodies, so it
 *     answers.
 *
 * Two structural rules keep it honest, both borrowed from decisions already made here:
 *
 * THE SNAPSHOT NEVER CLAIMS `appliedQuery`. It returns *candidates*, and the engine
 * filters them with the same `evaluateQuery` it uses for everything else. A second
 * implementation of the query language in SQL would be a second thing to get wrong, and
 * the failure mode — SQL and the engine disagreeing about whether something matched — is
 * a mail client silently losing mail.
 *
 * RETENTION IS BOUNDED AND EXPLICIT. Only the N most recent items per directory are kept.
 * A mailbox is unbounded and a cache that mirrors it is a disk-filling bug with a
 * respectable name.
 */

import { evaluateQuery, type Query } from './query.js';
import type { AttachmentRef, Document, ListPage, Logger, MetaValue, VNode } from './provider.js';
import { NULL_LOGGER } from './logging.js';
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from './sql.js';
import {
  DEFAULT_DIMENSIONS,
  cosineSimilarity,
  decodeVector,
  embeddableText,
  encodeVector,
  hashEmbedder,
  type Embedder,
} from './vector.js';
import * as vpath from './vpath.js';

/** Bumped whenever the schema changes shape. A mismatch rebuilds; it is only a cache. */
const SCHEMA_VERSION = 1;

export interface SnapshotOptions {
  readonly driver: SqlDriver;
  /** Defaults to the built-in lexical embedder. Pass one of your own for real embeddings. */
  readonly embedder?: Embedder;
  readonly logger?: Logger;
  readonly now?: () => number;
  /**
   * How long a snapshotted listing counts as fresh. Past this it is still served — that
   * is the point — but the caller is told how old it is and refreshes behind the user.
   */
  readonly ttlMs?: number;
  /** The "n most recent" of the brief: how many items to keep per directory. */
  readonly maxNodesPerDirectory?: number;
  /** Ceiling across the whole snapshot, enforced after per-directory retention. */
  readonly maxNodes?: number;
  /** Skip embedding entirely. Halves write cost when nobody uses `--semantic`. */
  readonly vectors?: boolean;
}

/**
 * The "n most recent" default, shared by the store that retains and the sync loop that
 * fetches. One number, because `cache.recent` is one setting: if retention kept more than
 * sync refreshed, the tail of every folder would quietly go stale and stay that way.
 */
export const DEFAULT_RECENT = 200;

/** A directory as the snapshot last saw it. */
export interface SnapshotListing {
  readonly path: string;
  readonly entries: readonly VNode[];
  /** The provider cursor to resume paging from, when the directory was not exhausted. */
  readonly cursor?: string;
  readonly complete: boolean;
  readonly total?: number;
  readonly syncedAt: number;
  readonly ageMs: number;
  /** True when `ageMs` is within the configured TTL. */
  readonly fresh: boolean;
}

export interface SnapshotHit {
  readonly node: VNode;
  /** Stored body, when the document was snapshotted too. Lets `body:` terms be decided. */
  readonly body?: string;
  /** Relevance from the local indexes, before the engine re-ranks. */
  readonly score: number;
  readonly source: 'text' | 'vector' | 'both' | 'recent';
}

export interface SnapshotSearchOptions {
  /** Only consider nodes at or beneath this path. */
  readonly root?: string;
  readonly limit?: number;
  /** Include vector nearest-neighbours as candidates. Defaults to true. */
  readonly semantic?: boolean;
  /** How many rows to consider before the engine filters. Defaults to `limit * 8`. */
  readonly candidates?: number;
}

export interface SnapshotStats {
  readonly nodes: number;
  readonly documents: number;
  readonly directories: number;
  readonly vectors: number;
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  /** Whether the full-text index exists. False means text search is a LIKE scan. */
  readonly fts: boolean;
  readonly bytes?: number;
}

// ---------------------------------------------------------------------------

export class SnapshotStore {
  readonly #driver: SqlDriver;
  readonly #embedder: Embedder | undefined;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPerDirectory: number;
  readonly #maxNodes: number;

  #hits = 0;
  #misses = 0;
  #writes = 0;
  /** Whether this SQLite build has FTS5. Settled by `#ensureFts` before the store is used. */
  #fts = false;

  private constructor(options: SnapshotOptions) {
    this.#driver = options.driver;
    this.#embedder =
      options.vectors === false ? undefined : (options.embedder ?? hashEmbedder(DEFAULT_DIMENSIONS));
    this.#logger = options.logger ?? NULL_LOGGER;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maxPerDirectory = options.maxNodesPerDirectory ?? DEFAULT_RECENT;
    this.#maxNodes = options.maxNodes ?? 50_000;
  }

  static async open(options: SnapshotOptions): Promise<SnapshotStore> {
    const store = new SnapshotStore(options);
    await store.#migrate();
    return store;
  }

  get driver(): SqlDriver {
    return this.#driver;
  }

  get embedder(): Embedder | undefined {
    return this.#embedder;
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async #migrate(): Promise<void> {
    await this.#driver.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const row = await this.#driver.get('SELECT value FROM snapshot_meta WHERE key = ?', ['schema_version']);
    const found = row === undefined ? 0 : Number(row['value']);
    if (found === SCHEMA_VERSION) {
      // Schema is current, but two things still have to be checked on every open: the
      // embedder, which changes independently of the schema, and FTS5, which is a property
      // of the SQLite build rather than of the file — the same snapshot can be opened by
      // one Node that has the extension and another that does not.
      await this.#ensureFts();
      await this.#reconcileEmbedder();
      return;
    }

    if (found !== 0) {
      this.#logger.info('Snapshot schema changed; rebuilding the local cache.', { from: found, to: SCHEMA_VERSION });
      await this.#driver.exec(`
        DROP TABLE IF EXISTS nodes;
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS directories;
        DROP TABLE IF EXISTS vectors;
        DROP TABLE IF EXISTS navigation;
        DROP TABLE IF EXISTS node_fts;
      `);
    }

    await this.#driver.exec(SCHEMA);
    await this.#ensureFts();
    await this.#driver.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', [
      'schema_version',
      String(SCHEMA_VERSION),
    ]);

    await this.#reconcileEmbedder();
  }

  /**
   * Create the full-text index, and record it if we cannot.
   *
   * Losing FTS costs exact-phrase ranking, not search: `candidates` falls back to a LIKE
   * scan, and vector similarity is unaffected because it is our own arithmetic over blobs.
   * That is a far better outcome than refusing to cache anything, which is what a failure
   * here used to cause.
   */
  async #ensureFts(): Promise<void> {
    try {
      await this.#driver.exec(FTS_SCHEMA);
      // Creating is not enough to prove it works: a file written by an FTS5-capable build
      // already has the table, so the CREATE is a no-op that succeeds on a build which
      // will then fail the first time anyone searches. Query it once to be sure.
      await this.#driver.all("SELECT rowid FROM node_fts WHERE node_fts MATCH 'probe' LIMIT 1");
      this.#fts = true;
    } catch (error) {
      this.#fts = false;
      this.#logger.info('No FTS5 in this SQLite build; text search will use a slower scan.', {
        error: String(error),
      });
    }
  }

  /**
   * Throw away vectors written by a different embedding scheme.
   *
   * Two schemes are not comparable, and comparing them anyway does not fail — it produces
   * a plausible-looking ranking that is simply wrong, which is the worst kind of bug in a
   * search feature. Discarding is safe because vectors are derived data: the next sync
   * re-embeds from rows that are still here, so the cost is CPU, not mail.
   */
  async #reconcileEmbedder(): Promise<void> {
    // Vectors are disabled: leave whatever is stored alone rather than deleting it. The
    // user may simply have started one session with `vectors: false`, and throwing the
    // index away would mean paying to rebuild it the next time they don't.
    const active = this.#embedder?.id;
    if (active === undefined) return;

    const row = await this.#driver.get('SELECT value FROM snapshot_meta WHERE key = ?', ['embedder']);
    const stored = row === undefined ? undefined : String(row['value']);
    if (stored === active) return;

    if (stored !== undefined) {
      this.#logger.info('Embedding scheme changed; re-indexing for semantic search.', { from: stored, to: active });
    }
    await this.#driver.run('DELETE FROM vectors');
    await this.#driver.run('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)', ['embedder', active]);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Record one page of a directory listing.
   *
   * `isFirstPage` marks a listing that starts from the top, which is the only safe moment
   * to renumber. Ordinals matter because the provider's own order is information —
   * "priority, not recency" in the people graph, thread order in a chat — and re-sorting
   * by date on the way out of the snapshot would quietly replace the provider's opinion
   * with ours.
   */
  async putListing(input: {
    readonly mountId: string;
    readonly path: string;
    readonly entries: readonly VNode[];
    readonly page?: Pick<ListPage, 'cursor' | 'total'>;
    readonly isFirstPage: boolean;
    readonly complete?: boolean;
  }): Promise<void> {
    const now = this.#now();
    const base = input.isFirstPage ? 0 : await this.#directoryCount(input.path);
    const statements: SqlStatement[] = [];

    input.entries.forEach((entry, offset) => {
      // A display name is allocated per directory, so two different backend items can
      // arrive claiming the same path across separate syncs. Whoever claims it most
      // recently owns it; the loser keeps its row, addressable by id, and simply stops
      // being reachable by that path — which is exactly what the live engine does.
      statements.push({
        sql: 'DELETE FROM nodes WHERE path = ? AND NOT (mount_id = ? AND node_id = ?)',
        params: [entry.path ?? vpath.join(input.path, entry.name), input.mountId, entry.id],
      });
      statements.push(nodeUpsert(input.mountId, input.path, entry, base + offset, now));
    });

    statements.push({
      sql: `INSERT INTO directories (path, mount_id, cursor, complete, total, synced_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              mount_id = excluded.mount_id,
              cursor = excluded.cursor,
              complete = excluded.complete,
              total = COALESCE(excluded.total, directories.total),
              synced_at = excluded.synced_at`,
      params: [
        input.path,
        input.mountId,
        input.page?.cursor ?? null,
        (input.complete ?? input.page?.cursor === undefined) ? 1 : 0,
        input.page?.total ?? null,
        now,
      ],
    });

    await this.#driver.batch(statements);
    this.#writes += input.entries.length;

    await this.#indexNodes(input.mountId, input.entries);
    await this.#retainDirectory(input.path);
  }

  /** Record a fetched document body, so `cat` and `body:` work offline. */
  async putDocument(mountId: string, node: VNode, doc: Document): Promise<void> {
    const path = node.path;
    if (path === undefined) return;
    await this.#driver.run(
      `INSERT INTO documents (mount_id, node_id, path, title, headers_json, body, format,
                              attachments_json, web_url, thread_id, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mount_id, node_id) DO UPDATE SET
         path = excluded.path, title = excluded.title, headers_json = excluded.headers_json,
         body = excluded.body, format = excluded.format,
         attachments_json = excluded.attachments_json, web_url = excluded.web_url,
         thread_id = excluded.thread_id, stored_at = excluded.stored_at`,
      [
        mountId,
        node.id,
        path,
        doc.title,
        // `headers` and `format` are optional on Document — `{title, body}` is the minimum
        // legal one — so they are defaulted here rather than passed straight through. The
        // columns are NOT NULL, and a provider that omits them is not an error.
        JSON.stringify(doc.headers ?? {}),
        doc.body,
        doc.format ?? 'text',
        doc.attachments === undefined ? null : JSON.stringify(doc.attachments),
        doc.webUrl ?? null,
        doc.threadId ?? null,
        this.#now(),
      ],
    );
    this.#writes += 1;
    // Re-index with the body present: a document is far more findable than its listing
    // entry, and the whole point of holding bodies is that `body:` stops being undecidable.
    await this.#indexNodes(mountId, [node], doc.body);
  }

  /**
   * Write the search indexes for these nodes.
   *
   * Split out from `putListing` because it needs the surrogate keys SQLite assigned
   * during the insert, which means one extra round trip per page — not per node. FTS5
   * has no upsert, so each row is deleted and reinserted by rowid.
   */
  async #indexNodes(mountId: string, nodes: readonly VNode[], body?: string): Promise<void> {
    if (nodes.length === 0) return;

    const ids = nodes.map((node) => node.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await this.#driver.all(
      `SELECT seq, node_id FROM nodes WHERE mount_id = ? AND node_id IN (${placeholders})`,
      [mountId, ...ids],
    );
    const seqById = new Map<string, number>();
    for (const row of rows) seqById.set(String(row['node_id']), Number(row['seq']));

    const statements: SqlStatement[] = [];
    const vectorWork: Array<{ seq: number; text: string }> = [];

    for (const node of nodes) {
      const seq = seqById.get(node.id);
      if (seq === undefined) continue;
      const text = body ?? (await this.#storedBody(mountId, node.id));
      if (this.#fts) {
        statements.push({ sql: 'DELETE FROM node_fts WHERE rowid = ?', params: [seq] });
        statements.push({
          sql: 'INSERT INTO node_fts (rowid, title, author, summary, body) VALUES (?, ?, ?, ?, ?)',
          params: [seq, node.title, node.author ?? '', node.summary ?? '', text ?? ''],
        });
      }
      if (this.#embedder !== undefined) {
        vectorWork.push({
          seq,
          text: embeddableText({
            title: node.title,
            author: node.author,
            summary: node.summary,
            ...(text === undefined ? {} : { body: text }),
          }),
        });
      }
    }

    if (this.#embedder !== undefined) {
      const embedder = this.#embedder;
      for (const work of vectorWork) {
        const vector = await embedder.embed(work.text);
        statements.push({
          sql: 'INSERT OR REPLACE INTO vectors (seq, embedder, dims, embedding) VALUES (?, ?, ?, ?)',
          params: [work.seq, embedder.id, vector.length, encodeVector(vector)],
        });
      }
    }

    await this.#driver.batch(statements);
  }

  async #storedBody(mountId: string, nodeId: string): Promise<string | undefined> {
    const row = await this.#driver.get('SELECT body FROM documents WHERE mount_id = ? AND node_id = ?', [
      mountId,
      nodeId,
    ]);
    const body = row?.['body'];
    return typeof body === 'string' ? body : undefined;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** A directory as last snapshotted, or undefined when it has never been visited. */
  async listing(path: string, options: { limit?: number; offset?: number } = {}): Promise<SnapshotListing | undefined> {
    const normalized = vpath.normalize(path);
    const meta = await this.#driver.get(
      'SELECT cursor, complete, total, synced_at FROM directories WHERE path = ?',
      [normalized],
    );
    if (meta === undefined) {
      this.#misses += 1;
      return undefined;
    }

    // No caller limit means "the whole directory as we hold it". Defaulting to the
    // retention cap would be wrong: that cap governs how many *files* are kept, and
    // directories are exempt from it, so a folder of 40 subfolders under a cap of 20
    // would come back silently halved.
    const limit = options.limit ?? -1;
    const offset = options.offset ?? 0;
    const rows = await this.#driver.all(
      `SELECT * FROM nodes WHERE parent_path = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?`,
      [normalized, limit, offset],
    );
    if (rows.length === 0 && offset === 0) {
      this.#misses += 1;
      return undefined;
    }

    this.#hits += 1;
    const syncedAt = Number(meta['synced_at']);
    const ageMs = Math.max(0, this.#now() - syncedAt);
    const cursor = meta['cursor'];
    const total = meta['total'];

    return {
      path: normalized,
      entries: rows.map(rowToNode),
      ...(typeof cursor === 'string' ? { cursor } : {}),
      complete: Number(meta['complete']) === 1,
      ...(total === null || total === undefined ? {} : { total: Number(total) }),
      syncedAt,
      ageMs,
      fresh: ageMs <= this.#ttlMs,
    };
  }

  /** How many entries the snapshot holds for a directory, without materialising them. */
  async #directoryCount(path: string): Promise<number> {
    const row = await this.#driver.get('SELECT COUNT(*) AS n FROM nodes WHERE parent_path = ?', [path]);
    return row === undefined ? 0 : Number(row['n']);
  }

  /**
   * Every cached node, shallowest first, for callers that need the whole tree rather than
   * one directory — exporting to AgentFS, most obviously.
   *
   * Ordered by path depth then path so that a consumer building a filesystem meets `/mail`
   * before `/mail/Inbox`, and never has to create a parent it has not seen yet. Sorting in
   * SQL keeps the whole tree from being pulled into memory just to be re-sorted.
   *
   * This does not count as a cache hit or miss: it is bulk export, not a lookup that the
   * hit rate is trying to describe, and folding it in would flatter the statistics.
   */
  async entries(): Promise<ReadonlyArray<{ node: VNode; path: string; mountId: string }>> {
    const rows = await this.#driver.all(
      `SELECT *, (LENGTH(path) - LENGTH(REPLACE(path, '/', ''))) AS depth
         FROM nodes ORDER BY depth ASC, path ASC`,
    );
    return rows.map((row) => ({
      node: rowToNode(row),
      // Carried alongside rather than read back off the node: `VNode.path` is optional
      // because providers do not set it, and a caller building a filesystem needs a string
      // it can rely on, not one it has to assert.
      path: String(row['path']),
      mountId: String(row['mount_id']),
    }));
  }

  async node(path: string): Promise<VNode | undefined> {
    const row = await this.#driver.get('SELECT * FROM nodes WHERE path = ?', [vpath.normalize(path)]);
    if (row === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    return rowToNode(row);
  }

  async document(path: string): Promise<{ doc: Document; ageMs: number } | undefined> {
    const row = await this.#driver.get('SELECT * FROM documents WHERE path = ?', [vpath.normalize(path)]);
    if (row === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    const attachments = row['attachments_json'];
    const webUrl = row['web_url'];
    const threadId = row['thread_id'];
    return {
      doc: {
        title: String(row['title']),
        headers: safeParse(row['headers_json'], []) as ReadonlyArray<readonly [string, string]>,
        body: String(row['body']),
        format: String(row['format']) as Document['format'],
        ...(typeof attachments === 'string'
          ? { attachments: safeParse(attachments, []) as readonly AttachmentRef[] }
          : {}),
        ...(typeof webUrl === 'string' ? { webUrl } : {}),
        ...(typeof threadId === 'string' ? { threadId } : {}),
      },
      ageMs: Math.max(0, this.#now() - Number(row['stored_at'])),
    };
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Candidates for a query, from the local indexes.
   *
   * Deliberately *candidates* and not results. Three retrieval strategies are unioned —
   * FTS5 over the text, nearest-neighbour over the vectors, and plain recency as a floor
   * — and every survivor is then put through `evaluateQuery`, the same function the live
   * engine uses. So the snapshot can be generous about what it proposes without ever
   * being able to return something the query does not actually match.
   *
   * The recency floor is there because a structured query like `is:unread after:7d`
   * contains no text to match on at all. Without it, the most obviously cacheable class
   * of query — "what is new" — would be the one that never hit the cache.
   */
  async candidates(query: Query, options: SnapshotSearchOptions = {}): Promise<readonly SnapshotHit[]> {
    const limit = options.limit ?? 50;
    const budget = options.candidates ?? Math.max(limit * 8, 200);
    const root = options.root === undefined ? undefined : vpath.normalize(options.root);
    const scopeSql = root === undefined || root === vpath.ROOT ? '' : ' AND (n.path = ? OR n.path LIKE ?)';
    const scopeParams: SqlValue[] = root === undefined || root === vpath.ROOT ? [] : [root, `${root}/%`];

    const text = queryText(query);
    const scored = new Map<number, { row: SqlRow; text: number; vector: number }>();

    if (text !== '') {
      const match = this.#fts ? toFtsMatch(text) : undefined;
      if (match !== undefined) {
        try {
          const rows = await this.#driver.all(
            `SELECT n.*, d.body AS doc_body, bm25(node_fts) AS bm
             FROM node_fts
             JOIN nodes n ON n.seq = node_fts.rowid
             LEFT JOIN documents d ON d.mount_id = n.mount_id AND d.node_id = n.node_id
             WHERE node_fts MATCH ?${scopeSql}
             ORDER BY bm ASC
             LIMIT ?`,
            [match, ...scopeParams, budget],
          );
          for (const row of rows) {
            // bm25 is negative and smaller-is-better; map it onto a positive score so it
            // composes with the vector score instead of fighting it.
            scored.set(Number(row['seq']), { row, text: 1 / (1 + Math.abs(Number(row['bm']))), vector: 0 });
          }
        } catch (error) {
          // A malformed MATCH expression must not be fatal — the live search still runs.
          this.#logger.debug('Snapshot text search failed; falling back.', { error: String(error) });
        }
      } else if (!this.#fts) {
        for (const hit of await this.#likeSearch(text, budget, scopeSql, scopeParams)) {
          scored.set(hit.seq, { row: hit.row, text: hit.score, vector: 0 });
        }
      }
    }

    if (options.semantic !== false && this.#embedder !== undefined && text !== '') {
      for (const hit of await this.#vectorSearch(text, budget, scopeSql, scopeParams)) {
        const existing = scored.get(hit.seq);
        if (existing === undefined) scored.set(hit.seq, { row: hit.row, text: 0, vector: hit.score });
        else existing.vector = hit.score;
      }
    }

    if (scored.size < budget) {
      const rows = await this.#driver.all(
        `SELECT n.*, d.body AS doc_body
         FROM nodes n
         LEFT JOIN documents d ON d.mount_id = n.mount_id AND d.node_id = n.node_id
         WHERE n.kind = 'file'${scopeSql}
         ORDER BY COALESCE(n.mtime, n.stored_at) DESC
         LIMIT ?`,
        [...scopeParams, budget - scored.size],
      );
      for (const row of rows) {
        if (!scored.has(Number(row['seq']))) scored.set(Number(row['seq']), { row, text: 0, vector: 0 });
      }
    }

    const hits: SnapshotHit[] = [];
    for (const entry of scored.values()) {
      const node = rowToNode(entry.row);
      const raw = entry.row['doc_body'];
      const body = typeof raw === 'string' ? raw : undefined;
      // The one thing the snapshot is allowed to decide: does this actually match?
      const verdict = evaluateQuery(query, node, body === undefined ? {} : { body });
      if (verdict !== true) continue;
      hits.push({
        node,
        ...(body === undefined ? {} : { body }),
        score: entry.text + entry.vector,
        source: entry.text > 0 && entry.vector > 0 ? 'both' : entry.text > 0 ? 'text' : entry.vector > 0 ? 'vector' : 'recent',
      });
    }

    hits.sort((a, b) => b.score - a.score || recency(b.node) - recency(a.node));
    return hits.slice(0, limit);
  }

  /**
   * Text search without FTS5: a LIKE scan, ranked by where the term was found.
   *
   * This is the substitute when the SQLite build has no full-text extension. It is a table
   * scan and it cannot do phrase or prefix ranking, but retention caps the table at a size
   * where that is affordable, and the alternative — a snapshot that answers no text query
   * at all — would make the local half of search silently useless.
   *
   * Terms are ANDed, matching FTS5's default, so adding a word narrows rather than widens.
   */
  async #likeSearch(
    text: string,
    budget: number,
    scopeSql: string,
    scopeParams: readonly SqlValue[],
  ): Promise<ReadonlyArray<{ seq: number; row: SqlRow; score: number }>> {
    const terms = text
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .slice(0, 8);
    if (terms.length === 0) return [];

    const params: SqlValue[] = [];
    const clauses = terms.map((term) => {
      // LIKE's own wildcards have to be escaped or a subject containing % would match
      // everything. ESCAPE is explicit because SQLite has no default.
      const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      params.push(like, like, like, like);
      return `(lower(n.title) LIKE ? ESCAPE '\\' OR lower(COALESCE(n.author, '')) LIKE ? ESCAPE '\\'
               OR lower(COALESCE(n.summary, '')) LIKE ? ESCAPE '\\'
               OR lower(COALESCE(d.body, '')) LIKE ? ESCAPE '\\')`;
    });

    try {
      const rows = await this.#driver.all(
        `SELECT n.*, d.body AS doc_body
         FROM nodes n
         LEFT JOIN documents d ON d.mount_id = n.mount_id AND d.node_id = n.node_id
         WHERE ${clauses.join(' AND ')}${scopeSql}
         ORDER BY COALESCE(n.mtime, n.stored_at) DESC
         LIMIT ?`,
        [...params, ...scopeParams, budget],
      );
      return rows.map((row) => {
        // A hit in the title is worth more than one buried in a body. Without bm25 this
        // is the only ranking signal available, and it is the one that matters most.
        const haystack = String(row['title'] ?? '').toLowerCase();
        const inTitle = terms.filter((term) => haystack.includes(term)).length;
        return { seq: Number(row['seq']), row, score: 0.5 + (0.5 * inTitle) / terms.length };
      });
    } catch (error) {
      this.#logger.debug('Snapshot LIKE search failed.', { error: String(error) });
      return [];
    }
  }

  /**
   * Nearest neighbours for `text`.
   *
   * When the driver is a real libSQL build the distance is computed in the database,
   * which keeps the vectors out of this process entirely. Otherwise the blobs are read
   * back and scored here — linear in the number of stored vectors, which is fine at the
   * scale retention holds it to and is why retention is not optional.
   */
  async #vectorSearch(
    text: string,
    budget: number,
    scopeSql: string,
    scopeParams: readonly SqlValue[],
  ): Promise<ReadonlyArray<{ seq: number; row: SqlRow; score: number }>> {
    const embedder = this.#embedder;
    if (embedder === undefined) return [];
    const probe = await embedder.embed(text);

    if (this.#driver.nativeVector) {
      try {
        const rows = await this.#driver.all(
          `SELECT n.*, d.body AS doc_body,
                  vector_distance_cos(v.embedding, vector32(?)) AS distance
           FROM vectors v
           JOIN nodes n ON n.seq = v.seq
           LEFT JOIN documents d ON d.mount_id = n.mount_id AND d.node_id = n.node_id
           WHERE v.embedder = ?${scopeSql}
           ORDER BY distance ASC
           LIMIT ?`,
          [vectorLiteralOf(probe), embedder.id, ...scopeParams, budget],
        );
        return rows.map((row) => ({
          seq: Number(row['seq']),
          row,
          score: Math.max(0, 1 - Number(row['distance'])),
        }));
      } catch (error) {
        this.#logger.debug('Native vector search failed; scoring in process.', { error: String(error) });
      }
    }

    const rows = await this.#driver.all(
      `SELECT n.*, d.body AS doc_body, v.embedding AS embedding
       FROM vectors v
       JOIN nodes n ON n.seq = v.seq
       LEFT JOIN documents d ON d.mount_id = n.mount_id AND d.node_id = n.node_id
       WHERE v.embedder = ? AND v.dims = ?${scopeSql}
       LIMIT ?`,
      [embedder.id, probe.length, ...scopeParams, Math.max(budget * 10, 2_000)],
    );

    const scored: Array<{ seq: number; row: SqlRow; score: number }> = [];
    for (const row of rows) {
      const blob = row['embedding'];
      if (!(blob instanceof Uint8Array)) continue;
      const score = cosineSimilarity(probe, decodeVector(blob));
      if (score <= 0) continue;
      scored.push({ seq: Number(row['seq']), row, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, budget);
  }

  // -------------------------------------------------------------------------
  // Sync bookkeeping
  // -------------------------------------------------------------------------

  async pollCursor(mountId: string, path: string): Promise<string | undefined> {
    const row = await this.#driver.get('SELECT poll_cursor FROM sync_state WHERE mount_id = ? AND path = ?', [
      mountId,
      vpath.normalize(path),
    ]);
    const cursor = row?.['poll_cursor'];
    return typeof cursor === 'string' ? cursor : undefined;
  }

  async setPollCursor(mountId: string, path: string, cursor: string | undefined): Promise<void> {
    await this.#driver.run(
      `INSERT INTO sync_state (mount_id, path, poll_cursor, synced_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(mount_id, path) DO UPDATE SET poll_cursor = excluded.poll_cursor, synced_at = excluded.synced_at`,
      [mountId, vpath.normalize(path), cursor ?? null, this.#now()],
    );
  }

  /** Directories the preloader has touched, oldest first — its natural work queue. */
  async staleDirectories(olderThanMs: number, limit = 20): Promise<ReadonlyArray<{ path: string; mountId: string; syncedAt: number }>> {
    const rows = await this.#driver.all(
      'SELECT path, mount_id, synced_at FROM directories WHERE synced_at <= ? ORDER BY synced_at ASC LIMIT ?',
      [this.#now() - olderThanMs, limit],
    );
    return rows.map((row) => ({
      path: String(row['path']),
      mountId: String(row['mount_id']),
      syncedAt: Number(row['synced_at']),
    }));
  }

  // -------------------------------------------------------------------------
  // Navigation history
  //
  // Persisted rather than kept per session so that the *first* `cd /mail/Inbox` of the
  // morning is already warm. A predictor that has to relearn the same four folders on
  // every launch would only ever help the user who was going to stay in the shell all
  // day anyway, which is not who needs it.
  // -------------------------------------------------------------------------

  async navigationHistory(limit = 500): Promise<ReadonlyArray<{ from: string; to: string; count: number }>> {
    const rows = await this.#driver.all(
      'SELECT from_path, to_path, count FROM navigation ORDER BY count DESC LIMIT ?',
      [limit],
    );
    return rows.map((row) => ({
      from: String(row['from_path']),
      to: String(row['to_path']),
      count: Number(row['count']),
    }));
  }

  async saveNavigationHistory(transitions: ReadonlyArray<{ from: string; to: string; count: number }>): Promise<void> {
    if (transitions.length === 0) return;
    await this.#driver.batch(
      transitions.map((entry) => ({
        sql: `INSERT INTO navigation (from_path, to_path, count) VALUES (?, ?, ?)
              ON CONFLICT(from_path, to_path) DO UPDATE SET count = excluded.count`,
        params: [entry.from, entry.to, entry.count] as readonly SqlValue[],
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Invalidation and retention
  // -------------------------------------------------------------------------

  /** Drop everything at or beneath `path`, matching `Vfs.invalidate` semantics exactly. */
  async invalidate(path: string): Promise<void> {
    const normalized = vpath.normalize(path);
    if (normalized === vpath.ROOT) {
      await this.clear();
      return;
    }
    const like = `${normalized}/%`;
    await this.#driver.batch([
      ...(this.#fts
        ? [
            {
              sql: 'DELETE FROM node_fts WHERE rowid IN (SELECT seq FROM nodes WHERE path = ? OR path LIKE ?)',
              params: [normalized, like],
            },
          ]
        : []),
      { sql: 'DELETE FROM vectors WHERE seq IN (SELECT seq FROM nodes WHERE path = ? OR path LIKE ?)', params: [normalized, like] },
      { sql: 'DELETE FROM documents WHERE path = ? OR path LIKE ?', params: [normalized, like] },
      { sql: 'DELETE FROM nodes WHERE path = ? OR path LIKE ?', params: [normalized, like] },
      { sql: 'DELETE FROM directories WHERE path = ? OR path LIKE ?', params: [normalized, like] },
    ]);
  }

  async clear(): Promise<void> {
    await this.#driver.batch([
      ...(this.#fts ? [{ sql: 'DELETE FROM node_fts' }] : []),
      { sql: 'DELETE FROM vectors' },
      { sql: 'DELETE FROM documents' },
      { sql: 'DELETE FROM nodes' },
      { sql: 'DELETE FROM directories' },
    ]);
  }

  /**
   * Keep only the N most recent entries in one directory.
   *
   * "Most recent" is the item's own timestamp, falling back to when we stored it, because
   * a provider that reports no mtime — an exec plugin, say — would otherwise have its
   * whole directory treated as equally disposable and thrash.
   *
   * Directories are exempt: they are few, they are the skeleton the predictive prefetcher
   * walks, and evicting one costs a round trip to rediscover a folder that has been in the
   * same place for ten years.
   */
  async #retainDirectory(path: string): Promise<void> {
    const keep = this.#maxPerDirectory;
    const doomed = await this.#driver.all(
      `SELECT seq FROM nodes
       WHERE parent_path = ? AND kind = 'file'
       ORDER BY COALESCE(mtime, stored_at) DESC
       LIMIT -1 OFFSET ?`,
      [path, keep],
    );
    if (doomed.length === 0) return;
    await this.#deleteBySeq(doomed.map((row) => Number(row['seq'])));
    // Evicting anything means we no longer hold the whole directory, so the completeness
    // flag has to come back down. Leaving it set would let the engine serve a truncated
    // listing as if it were the entire folder and never offer `more` — the cache quietly
    // hiding mail, which is the one outcome worth any amount of bookkeeping to avoid.
    await this.#driver.run('UPDATE directories SET complete = 0 WHERE path = ?', [path]);
  }

  /** Enforce the global ceiling. Called by the background sync, not on every write. */
  async prune(): Promise<number> {
    const doomed = await this.#driver.all(
      `SELECT seq FROM nodes WHERE kind = 'file' ORDER BY COALESCE(mtime, stored_at) DESC LIMIT -1 OFFSET ?`,
      [this.#maxNodes],
    );
    if (doomed.length === 0) return 0;
    const seqs = doomed.map((row) => Number(row['seq']));
    await this.#deleteBySeq(seqs);
    return seqs.length;
  }

  async #deleteBySeq(seqs: readonly number[]): Promise<void> {
    // Chunked because SQLite's parameter limit is 999 by default and a large eviction
    // after a bulk sync would otherwise fail as one oversized statement.
    for (let i = 0; i < seqs.length; i += 200) {
      const chunk = seqs.slice(i, i + 200);
      const placeholders = chunk.map(() => '?').join(',');
      await this.#driver.batch([
        ...(this.#fts ? [{ sql: `DELETE FROM node_fts WHERE rowid IN (${placeholders})`, params: chunk }] : []),
        { sql: `DELETE FROM vectors WHERE seq IN (${placeholders})`, params: chunk },
        {
          sql: `DELETE FROM documents WHERE (mount_id, node_id) IN (SELECT mount_id, node_id FROM nodes WHERE seq IN (${placeholders}))`,
          params: chunk,
        },
        { sql: `DELETE FROM nodes WHERE seq IN (${placeholders})`, params: chunk },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  async stats(): Promise<SnapshotStats> {
    const count = async (table: string): Promise<number> => {
      const row = await this.#driver.get(`SELECT COUNT(*) AS n FROM ${table}`);
      return row === undefined ? 0 : Number(row['n']);
    };
    const bytes = await this.#driver
      .get('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
      .catch(() => undefined);
    const size = bytes?.['bytes'];
    return {
      nodes: await count('nodes'),
      documents: await count('documents'),
      directories: await count('directories'),
      vectors: await count('vectors'),
      hits: this.#hits,
      misses: this.#misses,
      writes: this.#writes,
      fts: this.#fts,
      ...(size === null || size === undefined ? {} : { bytes: Number(size) }),
    };
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  mount_id     TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  path         TEXT NOT NULL,
  parent_path  TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subtype      TEXT,
  title        TEXT NOT NULL,
  author       TEXT,
  author_id    TEXT,
  summary      TEXT,
  mtime        INTEGER,
  size         INTEGER,
  flags        TEXT,
  meta_json    TEXT,
  child_count  INTEGER,
  unread_count INTEGER,
  ordinal      INTEGER NOT NULL,
  stored_at    INTEGER NOT NULL,
  UNIQUE (mount_id, node_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_path ON nodes (path);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes (parent_path, ordinal);
CREATE INDEX IF NOT EXISTS nodes_recent ON nodes (mount_id, mtime DESC);

CREATE TABLE IF NOT EXISTS documents (
  mount_id         TEXT NOT NULL,
  node_id          TEXT NOT NULL,
  path             TEXT NOT NULL,
  title            TEXT NOT NULL,
  headers_json     TEXT NOT NULL,
  body             TEXT NOT NULL,
  format           TEXT NOT NULL,
  attachments_json TEXT,
  web_url          TEXT,
  thread_id        TEXT,
  stored_at        INTEGER NOT NULL,
  PRIMARY KEY (mount_id, node_id)
);
CREATE INDEX IF NOT EXISTS documents_path ON documents (path);

CREATE TABLE IF NOT EXISTS directories (
  path      TEXT PRIMARY KEY,
  mount_id  TEXT NOT NULL,
  cursor    TEXT,
  complete  INTEGER NOT NULL DEFAULT 0,
  total     INTEGER,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  mount_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  poll_cursor TEXT,
  synced_at   INTEGER NOT NULL,
  PRIMARY KEY (mount_id, path)
);

CREATE TABLE IF NOT EXISTS vectors (
  seq       INTEGER PRIMARY KEY,
  embedder  TEXT NOT NULL,
  dims      INTEGER NOT NULL,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS navigation (
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (from_path, to_path)
);
`;

/**
 * Kept out of {@link SCHEMA} because it is the one statement that can fail on an otherwise
 * working SQLite. Node's bundled build did not carry the FTS5 extension until v23, so on
 * Node 22 — an LTS, and inside this program's supported range — creating this table raises
 * "no such module: fts5". Running it separately lets that be a missing feature rather than
 * a snapshot that will not open at all.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5 (
  title, author, summary, body, tokenize = 'unicode61 remove_diacritics 2'
);
`;

// ---------------------------------------------------------------------------
// Row <-> node
// ---------------------------------------------------------------------------

function nodeUpsert(mountId: string, parentPath: string, node: VNode, ordinal: number, now: number): SqlStatement {
  const path = node.path ?? vpath.join(parentPath, node.name);
  return {
    sql: `INSERT INTO nodes (mount_id, node_id, path, parent_path, name, kind, subtype, title,
                             author, author_id, summary, mtime, size, flags, meta_json,
                             child_count, unread_count, ordinal, stored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(mount_id, node_id) DO UPDATE SET
            path = excluded.path, parent_path = excluded.parent_path, name = excluded.name,
            kind = excluded.kind, subtype = excluded.subtype, title = excluded.title,
            author = excluded.author, author_id = excluded.author_id, summary = excluded.summary,
            mtime = excluded.mtime, size = excluded.size, flags = excluded.flags,
            meta_json = excluded.meta_json, child_count = excluded.child_count,
            unread_count = excluded.unread_count, ordinal = excluded.ordinal,
            stored_at = excluded.stored_at`,
    params: [
      mountId,
      node.id,
      path,
      parentPath,
      node.name,
      node.kind,
      node.subtype ?? null,
      node.title,
      node.author ?? null,
      node.authorId ?? null,
      node.summary ?? null,
      node.mtime === undefined ? null : node.mtime.getTime(),
      node.size ?? null,
      node.flags === undefined ? null : node.flags.join(' '),
      node.meta === undefined ? null : JSON.stringify(node.meta),
      node.childCount ?? null,
      node.unreadCount ?? null,
      ordinal,
      now,
    ],
  };
}

function rowToNode(row: SqlRow): VNode {
  const subtype = row['subtype'];
  const author = row['author'];
  const authorId = row['author_id'];
  const summary = row['summary'];
  const mtime = row['mtime'];
  const size = row['size'];
  const flags = row['flags'];
  const meta = row['meta_json'];
  const childCount = row['child_count'];
  const unreadCount = row['unread_count'];

  return {
    name: String(row['name']),
    kind: String(row['kind']) === 'dir' ? 'dir' : 'file',
    title: String(row['title']),
    id: String(row['node_id']),
    path: String(row['path']),
    parentPath: String(row['parent_path']),
    ...(typeof subtype === 'string' ? { subtype } : {}),
    ...(typeof author === 'string' ? { author } : {}),
    ...(typeof authorId === 'string' ? { authorId } : {}),
    ...(typeof summary === 'string' ? { summary } : {}),
    ...(mtime === null || mtime === undefined ? {} : { mtime: new Date(Number(mtime)) }),
    ...(size === null || size === undefined ? {} : { size: Number(size) }),
    ...(typeof flags === 'string' && flags !== '' ? { flags: flags.split(' ') } : {}),
    ...(typeof meta === 'string' ? { meta: safeParse(meta, {}) as Readonly<Record<string, MetaValue>> } : {}),
    ...(childCount === null || childCount === undefined ? {} : { childCount: Number(childCount) }),
    ...(unreadCount === null || unreadCount === undefined ? {} : { unreadCount: Number(unreadCount) }),
  };
}

function safeParse(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function recency(node: VNode): number {
  return node.mtime === undefined ? 0 : node.mtime.getTime();
}

function vectorLiteralOf(vector: Float32Array): string {
  const parts: string[] = [];
  for (let i = 0; i < vector.length; i += 1) parts.push(String(Number((vector[i] as number).toPrecision(6))));
  return `[${parts.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Query -> index
// ---------------------------------------------------------------------------

/**
 * The searchable text inside a query.
 *
 * Only free text and the fields the FTS table actually holds contribute. A query that is
 * entirely structural (`is:unread after:7d`) yields nothing here, which is correct — it
 * should be answered by the recency floor rather than by an empty MATCH that returns
 * nothing and looks like "no results".
 */
function queryText(query: Query): string {
  const parts: string[] = [];
  const walk = (node: Query, negated: boolean): void => {
    if (negated) return;
    switch (node.type) {
      case 'text':
        parts.push(node.value);
        return;
      case 'term':
        if (INDEXED_FIELDS.has(node.field) && node.op === 'contains') parts.push(node.value);
        return;
      case 'and':
      case 'or':
        for (const clause of node.clauses) walk(clause, negated);
        return;
      case 'not':
        walk(node.clause, true);
        return;
      case 'all':
        return;
    }
  };
  walk(query, false);
  return parts.join(' ').trim();
}

const INDEXED_FIELDS = new Set(['title', 'subject', 'name', 'author', 'from', 'summary', 'body']);

/**
 * Build an FTS5 MATCH expression from plain terms.
 *
 * Every term is OR'd rather than AND'd, and the conjunction is left to `evaluateQuery`.
 * An AND here would be a second, subtly different implementation of the query language:
 * FTS5 tokenises on its own rules, so `budget-review` is two tokens to it and one term to
 * the parser, and an AND would drop rows the engine would have kept. Over-retrieving is
 * free — the engine filters — while under-retrieving is a lost message.
 *
 * Terms are quoted, and a trailing `*` is offered as a prefix search, which is what makes
 * a half-typed word find anything at all.
 */
export function toFtsMatch(text: string): string | undefined {
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}*]+/u)
    .map((term) => term.replace(/\*+/g, '*'))
    .filter((term) => term.replace(/\*/g, '').length >= 2);
  if (terms.length === 0) return undefined;
  const clauses = terms.map((term) =>
    term.endsWith('*') ? `"${term.slice(0, -1).replace(/"/g, '')}"*` : `"${term.replace(/"/g, '')}"*`,
  );
  return clauses.join(' OR ');
}
