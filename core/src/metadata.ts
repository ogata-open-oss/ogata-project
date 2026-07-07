import { isTextContentType, listFiles, readFile } from "./storage";
import type {
  ObjectPage,
  ObjectQuery,
  ObjectRecord,
  ReindexResult,
  SearchMatch,
  SearchPage,
  SearchQuery,
  StoredFile,
} from "./types";

/**
 * The D1 object-metadata index — a queryable mirror of R2 listings (see the note in
 * `types.ts`). `D1Database` / `R2Bucket` are globals via `@cloudflare/workers-types`, so
 * this module needs no runtime import and is pure data logic, like `storage.ts` for R2 and
 * `memory.ts` for KV.
 *
 * The index is a projection, NOT the source of truth: R2 is. The connector keeps it current
 * write-through (every mutation upserts/deletes its row), and {@link reindexBucket} rebuilds it
 * from R2 to cover the gap — objects written OUTSIDE the connector (e.g. a dashboard upload).
 */

/** Columns are snake_case in SQLite; this is the row shape `SELECT` returns. */
interface ObjectRow {
  bucket: string;
  key: string;
  size: number;
  content_type: string | null;
  etag: string;
  uploaded: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Clamp a requested page size to a sane, integer range. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Escape LIKE metacharacters so a literal prefix isn't read as a wildcard pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface Cursor {
  bucket: string;
  key: string;
}

/** Encode the last row of a page as an opaque keyset cursor (base64 of `[bucket, key]`). */
function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify([cursor.bucket, cursor.key]));
}

/** Decode a keyset cursor; a malformed/forged cursor yields `undefined` (treated as page 1). */
function decodeCursor(value: string): Cursor | undefined {
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { bucket: parsed[0], key: parsed[1] };
    }
  } catch {
    /* malformed cursor — fall through to undefined */
  }
  return undefined;
}

/** A SQL statement plus its positional bind values. */
export interface BuiltQuery {
  sql: string;
  binds: (string | number)[];
}

/**
 * Build the `SELECT` for an {@link ObjectQuery}. Pure (no DB) so the filter combinatorics —
 * which is where the bugs hide — are unit-testable without a live D1. Ordering is
 * `(bucket, key)` so the keyset cursor (`(bucket, key) > (?, ?)`) paginates deterministically;
 * it fetches `limit + 1` rows so the caller can tell whether a next page exists.
 */
export function buildQuery(query: ObjectQuery = {}): BuiltQuery {
  const where: string[] = [];
  const binds: (string | number)[] = [];

  if (query.bucket !== undefined) {
    where.push("bucket = ?");
    binds.push(query.bucket);
  }
  if (query.prefix !== undefined && query.prefix !== "") {
    where.push("key LIKE ? ESCAPE '\\'");
    binds.push(`${escapeLike(query.prefix)}%`);
  }
  if (query.contentType !== undefined) {
    where.push("content_type = ?");
    binds.push(query.contentType);
  }
  if (query.minSize !== undefined) {
    where.push("size >= ?");
    binds.push(query.minSize);
  }
  if (query.maxSize !== undefined) {
    where.push("size <= ?");
    binds.push(query.maxSize);
  }
  if (query.modifiedAfter !== undefined) {
    where.push("uploaded >= ?");
    binds.push(query.modifiedAfter);
  }
  if (query.modifiedBefore !== undefined) {
    where.push("uploaded < ?");
    binds.push(query.modifiedBefore);
  }

  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (cursor) {
    where.push("(bucket, key) > (?, ?)");
    binds.push(cursor.bucket, cursor.key);
  }

  const limit = clampLimit(query.limit);
  const sql =
    "SELECT bucket, key, size, content_type, etag, uploaded FROM objects" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    // `limit` is a clamped integer (never user text), so interpolating it is injection-safe
    // and keeps `binds` purely the filter values.
    ` ORDER BY bucket, key LIMIT ${limit + 1}`;
  return { sql, binds };
}

/** Map a DB row to the public {@link ObjectRecord} shape (snake_case → camelCase, NULL → undefined). */
function rowToRecord(row: ObjectRow): ObjectRecord {
  return {
    bucket: row.bucket,
    key: row.key,
    size: row.size,
    etag: row.etag,
    uploaded: row.uploaded,
    contentType: row.content_type ?? undefined,
  };
}

/** Query the object index. Returns a page plus a keyset cursor when more rows remain. */
export async function queryObjects(db: D1Database, query: ObjectQuery = {}): Promise<ObjectPage> {
  const { sql, binds } = buildQuery(query);
  const limit = clampLimit(query.limit);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ObjectRow>();
  const rows = results ?? [];

  // buildQuery asked for limit + 1: the extra row is the "is there a next page?" probe.
  const truncated = rows.length > limit;
  const objects = (truncated ? rows.slice(0, limit) : rows).map(rowToRecord);
  const last = objects[objects.length - 1];
  return {
    objects,
    truncated,
    cursor: truncated && last ? encodeCursor({ bucket: last.bucket, key: last.key }) : undefined,
  };
}

/** Upsert one object's metadata (called write-through after an R2 write/copy/move). */
export async function indexObject(db: D1Database, bucket: string, file: StoredFile): Promise<void> {
  await db
    .prepare(
      "INSERT INTO objects (bucket, key, size, content_type, etag, uploaded) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(bucket, key) DO UPDATE SET " +
        "size = excluded.size, content_type = excluded.content_type, " +
        "etag = excluded.etag, uploaded = excluded.uploaded",
    )
    .bind(bucket, file.key, file.size, file.contentType ?? null, file.etag, file.uploaded)
    .run();
}

/**
 * Delete index rows for the given keys in a bucket (called write-through after an R2 delete/move).
 * Removes the row from BOTH projections — the `objects` metadata table and the `objects_fts`
 * search table — so a delete can never leave a stale, unfindable search row behind.
 */
export async function unindexObjects(
  db: D1Database,
  bucket: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const placeholders = keys.map(() => "?").join(", ");
  await db.batch([
    db
      .prepare(`DELETE FROM objects WHERE bucket = ? AND key IN (${placeholders})`)
      .bind(bucket, ...keys),
    db
      .prepare(`DELETE FROM objects_fts WHERE bucket = ? AND key IN (${placeholders})`)
      .bind(bucket, ...keys),
  ]);
}

// ── Full-text search (D1 / FTS5) ─────────────────────────────────────────────
// The `objects_fts` virtual table (migration 0002) indexes each object's key tokens plus the
// extracted text body of text-y objects. Kept current write-through (via {@link indexObjectText}
// and {@link unindexObjects}) and rebuilt from R2 by {@link reindexBucket}, exactly like the
// `objects` metadata table — lexical (BM25 keyword) search, not semantic.

/**
 * Objects at/under this byte size have their content extracted for search; larger ones are
 * key-only (their filename is still searchable). A bound on both the R2 read and the FTS row.
 */
export const MAX_FTS_TEXT_BYTES = 1024 * 1024;

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}

/** Encode/decode the offset cursor — search pages by offset (BM25 rank order isn't keyset-friendly). */
function encodeOffset(offset: number): string {
  return btoa(JSON.stringify(offset));
}
function decodeOffset(value: string | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    /* malformed cursor — start from the first page */
  }
  return 0;
}

/**
 * The searchable text stored for an object: its key (so filename words are matchable) followed by
 * the extracted body, if any. Key-only when there's no text body (binary or oversized object).
 */
function buildFtsText(key: string, text: string | undefined): string {
  return text ? `${key}\n${text}` : key;
}

/**
 * Extract an object's searchable text body, or `undefined` for none. Used by BOTH the write-through
 * path and {@link reindexBucket} so the live index and a rebuild agree on what counts as text.
 * Skips a fetch entirely for objects whose content-type names a binary format, and for objects over
 * {@link MAX_FTS_TEXT_BYTES}; otherwise reads and lets {@link readFile}'s byte sniff decide (so an
 * untyped text object is still indexed). NOT key tokens — the caller adds those via {@link buildFtsText}.
 *
 * A read failure degrades the object to key-only (`undefined`) rather than throwing, so one
 * unreadable object can't abort a whole-bucket {@link reindexBucket}.
 */
export async function extractSearchText(
  r2: R2Bucket,
  file: StoredFile,
): Promise<string | undefined> {
  if (file.size > MAX_FTS_TEXT_BYTES) return undefined;
  if (file.contentType && !isTextContentType(file.contentType)) return undefined;
  try {
    const read = await readFile(r2, file.key);
    return read?.encoding === "utf8" ? read.content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Index (or re-index) one object's search row. FTS5 has no UPSERT, so this deletes the existing
 * (bucket, key) row then inserts the current one — `text` is the key tokens plus the extracted body.
 */
export async function indexObjectText(
  db: D1Database,
  bucket: string,
  key: string,
  text: string | undefined,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM objects_fts WHERE bucket = ? AND key = ?").bind(bucket, key),
    db
      .prepare("INSERT INTO objects_fts (bucket, key, text) VALUES (?, ?, ?)")
      .bind(bucket, key, buildFtsText(key, text)),
  ]);
}

/**
 * Turn raw user text into a safe FTS5 MATCH expression, or `null` when it has no usable terms.
 * Each whitespace-separated term is double-quoted (so punctuation can't be read as MATCH syntax —
 * `"` inside a term is doubled to escape it) and given a `*` prefix so `read` matches `readme`.
 * Terms are space-joined, which is FTS5's implicit AND: every term must be present (precision over recall).
 */
export function toMatchQuery(q: string): string | null {
  const terms = q.match(/\S+/g);
  if (!terms) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

/** A built search statement plus the page size and offset it was built for. */
export interface BuiltSearch {
  sql: string;
  binds: (string | number)[];
  limit: number;
  offset: number;
}

/**
 * Build the FTS5 `SELECT` for a {@link SearchQuery}, or `null` when the query has no usable terms
 * (so the caller can short-circuit to an empty page). Orders by BM25 rank (best first), tie-broken
 * by (bucket, key) for a stable order across pages, and fetches `limit + 1` to probe for a next page.
 * Pure (no DB) so the term-escaping and bind ordering are unit-testable without a live FTS table.
 */
export function buildSearchQuery(query: SearchQuery): BuiltSearch | null {
  const match = toMatchQuery(query.q);
  if (match === null) return null;

  const binds: (string | number)[] = [match];
  let where = "objects_fts MATCH ?";
  if (query.bucket !== undefined) {
    where += " AND bucket = ?";
    binds.push(query.bucket);
  }

  const limit = clampSearchLimit(query.limit);
  const offset = decodeOffset(query.cursor);
  const sql =
    "SELECT bucket, key, bm25(objects_fts) AS rank, " +
    "snippet(objects_fts, 2, '[', ']', '…', 12) AS snippet " +
    `FROM objects_fts WHERE ${where} ORDER BY rank, bucket, key ` +
    // limit/offset are clamped integers (never user text) — interpolating them is injection-safe.
    `LIMIT ${limit + 1} OFFSET ${offset}`;
  return { sql, binds, limit, offset };
}

/** One row the search SELECT returns (snake_case `content_type` isn't selected here). */
interface FtsRow {
  bucket: string;
  key: string;
  rank: number;
  snippet: string;
}

/** Run a full-text search over the object index. Returns a page plus an offset cursor when more remain. */
export async function searchObjects(db: D1Database, query: SearchQuery): Promise<SearchPage> {
  const built = buildSearchQuery(query);
  if (built === null) return { matches: [], truncated: false };

  const { results } = await db
    .prepare(built.sql)
    .bind(...built.binds)
    .all<FtsRow>();
  const rows = results ?? [];

  // buildSearchQuery asked for limit + 1: the extra row is the "is there a next page?" probe.
  const truncated = rows.length > built.limit;
  const matches: SearchMatch[] = (truncated ? rows.slice(0, built.limit) : rows).map((r) => ({
    bucket: r.bucket,
    key: r.key,
    rank: r.rank,
    snippet: r.snippet,
  }));
  return {
    matches,
    truncated,
    cursor: truncated ? encodeOffset(built.offset + built.limit) : undefined,
  };
}

/** Insert statements are chunked into batches this size to stay well under D1's per-batch limits. */
const REINDEX_BATCH = 50;

/**
 * Rebuild a bucket's index from R2 itself: list every object, clear the bucket's rows, then
 * re-insert the current set. This is the reconcile path — it seeds an existing bucket and picks
 * up out-of-band writes (e.g. dashboard uploads) the write-through hooks never saw.
 *
 * Not a single transaction: the clear and the insert chunks are separate batches, so a failure
 * mid-rebuild can leave the bucket under-indexed. That's acceptable here — re-running fully heals
 * it, and write-through keeps live connector changes correct meanwhile.
 *
 * Rebuilds BOTH projections — the `objects` metadata table and the `objects_fts` search table. The
 * search rebuild reads each text-y object under {@link MAX_FTS_TEXT_BYTES} to extract its body (the
 * reconcile path's main cost; binaries and oversized objects are key-only and skip the read).
 */
export async function reindexBucket(
  db: D1Database,
  bucket: string,
  r2: R2Bucket,
): Promise<ReindexResult> {
  const files: StoredFile[] = [];
  let cursor: string | undefined;
  do {
    const listing = await listFiles(r2, { delimiter: null, cursor });
    files.push(...listing.files);
    cursor = listing.cursor;
  } while (cursor);

  await db.batch([
    db.prepare("DELETE FROM objects WHERE bucket = ?").bind(bucket),
    db.prepare("DELETE FROM objects_fts WHERE bucket = ?").bind(bucket),
  ]);

  const insert = db.prepare(
    "INSERT INTO objects (bucket, key, size, content_type, etag, uploaded) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const ftsInsert = db.prepare("INSERT INTO objects_fts (bucket, key, text) VALUES (?, ?, ?)");
  for (let i = 0; i < files.length; i += REINDEX_BATCH) {
    const chunk = files.slice(i, i + REINDEX_BATCH);

    const metaStmts = chunk.map((f) =>
      insert.bind(bucket, f.key, f.size, f.contentType ?? null, f.etag, f.uploaded),
    );
    if (metaStmts.length) await db.batch(metaStmts);

    // Extract bodies for the chunk in parallel, then batch the FTS inserts.
    const ftsStmts = await Promise.all(
      chunk.map(async (f) =>
        ftsInsert.bind(bucket, f.key, buildFtsText(f.key, await extractSearchText(r2, f))),
      ),
    );
    if (ftsStmts.length) await db.batch(ftsStmts);
  }

  return { bucket, indexed: files.length };
}
