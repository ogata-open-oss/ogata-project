/** Shared types for the R2-backed project store. */

/** Metadata for a single stored object. */
export interface StoredFile {
  /** Full object key, e.g. `docs/readme.md`. */
  key: string;
  /** Size in bytes. */
  size: number;
  /** R2 entity tag. */
  etag: string;
  /** Upload time as an ISO-8601 string. */
  uploaded: string;
  /** MIME type, if one was stored. */
  contentType?: string;
}

/** Result of listing a prefix in the store. */
export interface Listing {
  /** The prefix that was listed (empty string for the root). */
  prefix: string;
  /** Files directly under the prefix. */
  files: StoredFile[];
  /** Folder-style prefixes under the prefix (when a delimiter is used). */
  folders: string[];
  /** Opaque cursor to pass to the next call; present only when `truncated`. */
  cursor?: string;
  /** True when more results remain beyond this page. */
  truncated: boolean;
}

/** Result of reading a file. */
export interface ReadResult {
  key: string;
  /**
   * How {@link content} is encoded: `utf8` for text bodies, `base64` for binary
   * (images, PDFs, …). The classification is by content-type, falling back to a
   * byte sniff when no content-type is stored.
   */
  encoding: "utf8" | "base64";
  /** The body — UTF-8 text when `encoding` is `utf8`, base64 otherwise. */
  content: string;
  size: number;
  etag: string;
  contentType?: string;
}

/** Result of writing a file. */
export interface WriteResult {
  key: string;
  size: number;
  etag: string;
}

// ── Transactive memory (KV) ──────────────────────────────────────────────────
// A fragmented shared context store spanning MCP-connected surfaces (webchat projects +
// coding agents on repos/VMs), keyed `mem/<programme>/<codename>/<slug>`. The two upper
// axes form a stable taxonomy: the top is the *programme* (e.g. `acme`, `labs`); the
// second is that programme's *code name* — a stream's primary key (e.g. `apollo`,
// `hermes`), drawn from whatever reserved namespace the team keeps. The where-is-what TOC
// is derived from the keyspace + per-key metadata; a curated manifest fragment layers
// narrative on top.

/** Identifies a single memory fragment. Maps to the KV key `mem/<programme>/<codename>/<slug>`. */
export interface MemoryRef {
  /** Programme the memory is scoped to — the taxonomy's top axis, e.g. `acme`, `labs`. */
  programme: string;
  /** Code name (a stream's primary key) within the programme, e.g. `apollo`, `hermes`. */
  codename: string;
  /** Fragment id within the code name, e.g. `supply-chain-stance`. */
  slug: string;
}

/** A prefix scope for listing — narrow to a programme, a programme+codename, or omit for all memory. */
export interface MemoryScope {
  programme?: string;
  codename?: string;
}

/**
 * The lean per-fragment metadata stored as KV per-key metadata (≤1 KiB) — so a
 * `list()` returns the whole index (title/tags/hook/updated) without fetching bodies.
 */
export interface MemoryMeta {
  /** One-line title shown in the index. */
  title: string;
  /** Tags for grouping/filtering in the index. */
  tags?: string[];
  /** One-line hook/summary for the index. */
  hook?: string;
  /** Last-write time, ISO-8601 (stamped on write). */
  updated: string;
}

/** A full memory fragment: its ref, its metadata, and the doc body. */
export interface MemoryDoc extends MemoryMeta {
  ref: MemoryRef;
  /** The memory doc — frontmatter + prose + `[[links]]`, ≤ {@link MAX_MEMORY_LINES} lines. */
  body: string;
}

/** One row of the index `listMemory` returns: a ref + its metadata, no body. */
export interface MemoryListEntry {
  ref: MemoryRef;
  meta?: MemoryMeta;
}

/**
 * Outcome of writing a memory fragment. The guard cases (`too_long`,
 * `metadata_too_large`) write nothing — they keep memory fragmented (single-topic
 * docs) and metadata under KV's 1 KiB cap.
 */
export type MemoryWriteResult =
  | { status: "ok"; ref: MemoryRef; updated: string; lines: number }
  | { status: "too_long"; lines: number; limit: number }
  | { status: "metadata_too_large"; bytes: number; limit: number };

/**
 * Outcome of a copy or move. A discriminated union (`status`) so a caller can tell
 * the non-destructive guard cases apart from a completed transfer without a
 * try/catch: `destination_exists` (refused — destination key already present and
 * `overwrite` not set) and `source_not_found` (nothing at the source key) both
 * leave the store untouched; `ok` reports the written object.
 */
export type TransferResult =
  | { status: "ok"; key: string; size: number; etag: string }
  | { status: "destination_exists"; key: string }
  | { status: "source_not_found"; key: string };

// ── Object metadata index (D1) ───────────────────────────────────────────────
// A queryable mirror of R2 object listings, spanning all buckets in a single
// `objects` table keyed `(bucket, key)`. KV answers "where is what" (the directory);
// D1 answers "which objects match these conditions" (filter by type/size/date without
// paging R2). Kept ONE table on purpose: a bucket is just a label that already lives in
// the connector's compile-time bucket registry, not a data row — so `bucket` is an
// indexed column here, not a foreign key to a (currently attribute-less) buckets table.
// That normalization point arrives with the per-bucket ACL layer, not before.

/** A single object's metadata as indexed in D1 — a {@link StoredFile} plus its bucket. */
export interface ObjectRecord extends StoredFile {
  /** The bucket the object lives in (the index spans every bucket). */
  bucket: string;
}

/**
 * Filters for {@link ObjectRecord} queries. Every field is optional; an omitted field
 * adds no constraint. `prefix` matches keys under a folder; the size/date bounds are
 * inclusive-min / inclusive-max and inclusive-after / exclusive-before respectively.
 */
export interface ObjectQuery {
  /** Restrict to one bucket. Omit to query across every bucket. */
  bucket?: string;
  /** Restrict to keys starting with this prefix, e.g. `docs/`. */
  prefix?: string;
  /** Exact content-type match, e.g. `image/png`. */
  contentType?: string;
  /** Minimum size in bytes (inclusive). */
  minSize?: number;
  /** Maximum size in bytes (inclusive). */
  maxSize?: number;
  /** Only objects uploaded at/after this ISO-8601 instant (inclusive). */
  modifiedAfter?: string;
  /** Only objects uploaded before this ISO-8601 instant (exclusive). */
  modifiedBefore?: string;
  /** Max rows to return (default 100, capped at 1000). */
  limit?: number;
  /** Opaque keyset cursor from a previous {@link ObjectPage}. */
  cursor?: string;
}

/** A page of {@link ObjectRecord}s plus the keyset cursor to fetch the next one. */
export interface ObjectPage {
  objects: ObjectRecord[];
  /** Opaque cursor to pass as {@link ObjectQuery.cursor}; present only when `truncated`. */
  cursor?: string;
  /** True when more rows remain beyond this page. */
  truncated: boolean;
}

/** Outcome of {@link reindexBucket}: which bucket was rebuilt and how many objects it now holds. */
export interface ReindexResult {
  bucket: string;
  indexed: number;
}

// ── Full-text search (D1 / FTS5) ─────────────────────────────────────────────
// A second projection over R2, beside the `objects` table: the `objects_fts` FTS5
// virtual table indexes each object's KEY tokens plus the extracted text body of
// text-y objects. `objects` answers "which objects match these attributes"; this
// answers "which objects contain these words" — filename OR content, one query.
// Lexical (BM25-ranked keyword match), not semantic — the vector/semantic layer is
// a separate, later build.

/** A free-text search over the object index. `q` is tokenised into a prefix-matched AND query. */
export interface SearchQuery {
  /** The search text — words to match against object keys and extracted content. */
  q: string;
  /** Restrict to one bucket. Omit to search across every bucket. */
  bucket?: string;
  /** Max matches to return (default 20, capped at 100). */
  limit?: number;
  /** Opaque cursor from a previous {@link SearchPage}. */
  cursor?: string;
}

/** One search hit: the object's location, its BM25 relevance, and a highlighted excerpt. */
export interface SearchMatch {
  bucket: string;
  key: string;
  /** BM25 relevance score; more negative = stronger match (the ranking order). */
  rank: number;
  /** A short excerpt around the match, with the matched terms wrapped in `[…]`. */
  snippet: string;
}

/** A page of {@link SearchMatch}es plus the cursor to fetch the next one. */
export interface SearchPage {
  matches: SearchMatch[];
  /** Opaque cursor to pass as {@link SearchQuery.cursor}; present only when `truncated`. */
  cursor?: string;
  /** True when more matches remain beyond this page. */
  truncated: boolean;
}

// ── Semantic search (D1 chunk map + Vectorize) ───────────────────────────────
// A THIRD projection over R2, beside `objects` (attributes) and `objects_fts` (words): vector
// search by MEANING. Each text-y object is chunked and embedded; the vectors live in a Cloudflare
// Vectorize index, and the `object_chunks` table (migration 0003) maps each vector's id back to its
// object + chunk text. `objects` answers "which attributes", `objects_fts` "which words", this
// "which meaning" — a query matches conceptually-near content even with no shared keywords.

/** A semantic search over the object index. `q` is embedded and matched by vector similarity. */
export interface SemanticQuery {
  /** Natural-language query — matched against object content by meaning, not keywords. */
  q: string;
  /** Restrict to one bucket. Omit to search across every bucket. */
  bucket?: string;
  /** Max matches to return (default 10, capped at 50). */
  limit?: number;
  /** Opaque cursor from a previous {@link SemanticPage}. */
  cursor?: string;
}

/** One semantic hit: the object's location, its similarity score, and a content excerpt. */
export interface SemanticMatch {
  bucket: string;
  key: string;
  /** Cosine similarity of the best-matching chunk; higher = closer in meaning (the ranking order). */
  score: number;
  /** A short excerpt of the matched chunk (no keyword to highlight — this is similarity, not lexical). */
  snippet: string;
}

/** A page of {@link SemanticMatch}es plus the cursor to fetch the next one. */
export interface SemanticPage {
  matches: SemanticMatch[];
  /** Opaque cursor to pass as {@link SemanticQuery.cursor}; present only when `truncated`. */
  cursor?: string;
  /** True when more matches remain beyond this page. */
  truncated: boolean;
}

/** Outcome of a semantic reindex: the bucket rebuilt, how many objects were embedded, and total chunks. */
export interface SemanticReindexResult {
  bucket: string;
  objects: number;
  chunks: number;
  /** Objects skipped because their embed failed (e.g. a chunk over the model window) — not embedded. */
  failures: number;
}
