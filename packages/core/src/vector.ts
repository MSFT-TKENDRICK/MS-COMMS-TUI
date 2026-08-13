/**
 * Vectors for the local snapshot.
 *
 * WHAT THIS IS, PLAINLY. There is no embedding model here. This module does the hashing
 * trick instead: a message becomes a fixed-width vector by hashing its terms and character
 * trigrams into buckets, weighting them, and normalising. That is a genuine vector index
 * — nearest-neighbour over it is real, fast, and useful — but it is *lexical*, not
 * semantic. It will find "budget forecast" from "forecasting the budgets" because the
 * stems and trigrams overlap. It will not find it from "how much money have we got",
 * because nothing in this file knows those mean the same thing.
 *
 * It is the default because it needs no model download, no GPU, no inference endpoint and
 * no network, so semantic-ish ranking works on a locked-down laptop on a plane. It is not
 * the ceiling.
 *
 * That distinction is stated this loudly because the failure mode of overselling it is
 * the worst one a mail tool has: a user who believes search is semantic stops scrolling,
 * and concludes a message does not exist when it was merely worded differently. Search
 * over the snapshot therefore *always* runs the exact query too, and vector similarity
 * only ever adds candidates and orders them — it never decides that something is absent.
 *
 * Anyone who wants real embeddings has a seam: {@link Embedder}. Point it at a local model
 * or an internal endpoint, keep the dimension count, and the snapshot stores and searches
 * those vectors instead with no other change — the store notices the scheme changed and
 * re-indexes itself. The stored format is little-endian float32, byte-identical to
 * libSQL's own `vector32`, so a snapshot built either way is directly queryable by Turso's
 * native vector functions.
 */

/** A fixed-width vector. Always L2-normalised, so cosine similarity is a dot product. */
export type Vector = Float32Array;

export interface Embedder {
  /**
   * Stable identifier for the embedding scheme, stored alongside every vector.
   *
   * Vectors from two different schemes are not comparable, and comparing them anyway
   * produces plausible-looking nonsense rather than an error. The store keeps this id
   * and discards vectors that do not match the active embedder, so changing schemes
   * degrades to "re-embed on next sync" rather than to silently wrong rankings.
   */
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): Vector | Promise<Vector>;
}

export const DEFAULT_DIMENSIONS = 256;

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * English function words, dropped before hashing.
 *
 * Not for the usual "they carry no meaning" reason — in a bag of 256 buckets they carry
 * something worse than no meaning. Every message contains "the" and "to", so those
 * buckets saturate, and after normalisation they crowd out the terms that actually
 * distinguish one message from another. The list is short on purpose: an aggressive one
 * starts removing words like "not" and "no" that reverse a sentence.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had',
  'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of',
  'on', 'or', 'our', 're', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'we', 'were', 'will', 'with', 'you', 'your',
]);

/** Words, numbers and `@`-joined handles. Unicode-aware so non-English mail survives. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}@._'-]+/u)) {
    const token = raw.replace(/^['._-]+|['._-]+$/g, '');
    if (token.length < 2 || token.length > 64) continue;
    if (STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Cheap, well-distributed, and identical on every platform. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Accumulate one feature into the vector.
 *
 * The second hash decides a sign. Without it, two unrelated terms landing in the same
 * bucket always reinforce each other, so collisions only ever inflate similarity; with
 * it they cancel in expectation, and the distortion stays unbiased. This is the standard
 * signed-hashing correction and it costs one extra multiply.
 */
function accumulate(vector: Float32Array, feature: string, weight: number): void {
  const dims = vector.length;
  const hash = fnv1a(feature);
  const index = hash % dims;
  const sign = (fnv1a(feature, 0x9e3779b1) & 1) === 0 ? 1 : -1;
  vector[index] = (vector[index] as number) + sign * weight;
}

/**
 * Hash text into a normalised vector.
 *
 * Term frequency is damped with `1 + log(count)` rather than used raw, because a message
 * that says "invoice" forty times is about invoices roughly as much as one that says it
 * five times, and the linear version lets one repeated word dominate the whole vector.
 *
 * Character trigrams are hashed alongside whole terms, at a lower weight. They are what
 * makes the index tolerate the things real mail is full of — plurals, inflections,
 * hyphenation, and the typo in the subject line — without a stemmer for every language.
 */
export function hashEmbed(text: string, dimensions: number = DEFAULT_DIMENSIONS): Vector {
  const vector = new Float32Array(dimensions);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);

  for (const [token, count] of counts) {
    const weight = 1 + Math.log(count);
    accumulate(vector, token, weight);
    if (token.length >= 4) {
      const padded = `^${token}$`;
      const trigramWeight = (weight * 0.5) / Math.max(1, padded.length - 2);
      for (let i = 0; i + 3 <= padded.length; i += 1) {
        accumulate(vector, `#${padded.slice(i, i + 3)}`, trigramWeight);
      }
    }
  }

  return normalize(vector);
}

/** Scale to unit length in place. An all-zero vector is left alone rather than divided by zero. */
export function normalize(vector: Float32Array): Vector {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2;
  if (sum === 0) return vector;
  const inverse = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) * inverse;
  return vector;
}

/** The built-in embedder: lexical, deterministic, dependency-free. */
export function hashEmbedder(dimensions: number = DEFAULT_DIMENSIONS): Embedder {
  return {
    id: `hash-v1-${dimensions}`,
    dimensions,
    embed: (text) => hashEmbed(text, dimensions),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Cosine similarity, in `[-1, 1]`.
 *
 * Both inputs are assumed normalised — everything this module produces is — so this is a
 * plain dot product. Mismatched lengths return 0 rather than throwing: that means a
 * stored vector from an older embedder, and one stale row must not take down a search.
 */
export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

// ---------------------------------------------------------------------------
// Storage format
// ---------------------------------------------------------------------------

/**
 * Little-endian float32, which is exactly what libSQL's `vector32` stores.
 *
 * Chosen so the snapshot is not a private format: `vector_distance_cos(embedding, ...)`
 * works against these blobs unchanged when the database is opened by a real Turso
 * client, and this process falls back to scoring the same bytes itself when it is not.
 * Explicit endianness because the file is expected to outlive the machine that wrote it.
 */
export function encodeVector(vector: Vector): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i += 1) view.setFloat32(i * 4, vector[i] as number, true);
  return bytes;
}

export function decodeVector(bytes: Uint8Array): Vector {
  const count = Math.floor(bytes.byteLength / 4);
  const vector = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) vector[i] = view.getFloat32(i * 4, true);
  return vector;
}

/** `[0.1,0.2,…]`, the argument form libSQL's `vector32()` accepts. */
export function vectorLiteral(vector: Vector): string {
  const parts: string[] = [];
  for (let i = 0; i < vector.length; i += 1) parts.push(formatComponent(vector[i] as number));
  return `[${parts.join(',')}]`;
}

function formatComponent(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // Six significant digits is well past float32's ~7-digit precision for values in
  // [-1,1], and keeps the literal short enough not to blow up a query for 256 dimensions.
  const text = value.toPrecision(6);
  return text.includes('e') ? String(Number(text)) : text.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Building the text that gets embedded
// ---------------------------------------------------------------------------

export interface EmbeddableFields {
  readonly title?: string | undefined;
  readonly author?: string | undefined;
  readonly summary?: string | undefined;
  readonly body?: string | undefined;
}

/**
 * The text a node is embedded from.
 *
 * The subject is repeated, which is a blunt way of weighting it and is deliberate: in
 * mail the subject is the single most reliable statement of what an item is about, and a
 * long quoted reply chain would otherwise drown it entirely. The body is truncated for
 * the same reason — the first few thousand characters are the message, and the rest is
 * usually a thread's worth of quoted history that would make every message in a thread
 * look identical.
 */
export function embeddableText(fields: EmbeddableFields, maxBodyChars = 4_000): string {
  const parts: string[] = [];
  if (fields.title !== undefined && fields.title !== '') parts.push(fields.title, fields.title);
  if (fields.author !== undefined && fields.author !== '') parts.push(fields.author);
  if (fields.summary !== undefined && fields.summary !== '') parts.push(fields.summary);
  if (fields.body !== undefined && fields.body !== '') parts.push(fields.body.slice(0, maxBodyChars));
  return parts.join('\n');
}
