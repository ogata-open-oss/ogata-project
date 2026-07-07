import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildQuery,
  buildSearchQuery,
  queryObjects,
  reindexBucket,
  searchObjects,
  unindexObjects,
} from "../src/metadata";
// The real migrations, imported verbatim (vite ?raw) so the tests run against the actual schema.
// `@migrations` is a vitest alias (see vitest.config.ts) rather than a relative path, because the
// migrations directory sits at a DIFFERENT relative distance in the private workspace vs the
// flattened OSS tree — the alias keeps this specifier valid in both.
import schema from "@migrations/0001_create_objects.sql?raw";
import schemaFts from "@migrations/0002_create_objects_fts.sql?raw";

/**
 * Two layers of test:
 *  - `buildQuery` — the bug-prone surface (optional filters, bind ordering, keyset paging) —
 *    is tested directly and purely (no DB at all).
 *  - The execution path (`reindexBucket` → `queryObjects`) runs against a real-SQL `FakeD1`
 *    backed by node:sqlite (built into Node ≥ 22.5, zero install). This executes the *actual*
 *    0001 migration and the real generated SQL, so it catches the content_type-NULL class of
 *    bug end-to-end — which a canned-row fake cannot. (We use node:sqlite, not better-sqlite3:
 *    the latter compiles at install via node-gyp/binding.gyp and is blocked by our
 *    `ignore-scripts=true` posture; true D1-driver fidelity is a later vitest-pool-workers step.)
 */

/** A keyset cursor as `metadata.ts` encodes it — base64 of `[bucket, key]`. */
const cursorFor = (bucket: string, key: string) => btoa(JSON.stringify([bucket, key]));

describe("buildQuery", () => {
  it("selects everything with default paging when no filters are given", () => {
    const { sql, binds } = buildQuery();
    expect(sql).toBe(
      "SELECT bucket, key, size, content_type, etag, uploaded FROM objects ORDER BY bucket, key LIMIT 101",
    );
    expect(binds).toEqual([]);
  });

  it("adds a bucket equality filter", () => {
    const { sql, binds } = buildQuery({ bucket: "bucket-b" });
    expect(sql).toContain("WHERE bucket = ?");
    expect(binds).toEqual(["bucket-b"]);
  });

  it("turns a prefix into an escaped LIKE", () => {
    const { sql, binds } = buildQuery({ prefix: "docs/" });
    expect(sql).toContain("key LIKE ? ESCAPE '\\'");
    expect(binds).toEqual(["docs/%"]);
  });

  it("escapes LIKE metacharacters in the prefix so they stay literal", () => {
    const { binds } = buildQuery({ prefix: "report_50%/" });
    expect(binds).toEqual(["report\\_50\\%/%"]);
  });

  it("ignores an empty-string prefix", () => {
    const { sql, binds } = buildQuery({ prefix: "" });
    expect(sql).not.toContain("LIKE");
    expect(binds).toEqual([]);
  });

  it("combines every filter with AND, binding values in clause order", () => {
    const { sql, binds } = buildQuery({
      bucket: "lemurkit-storage",
      prefix: "img/",
      contentType: "image/png",
      minSize: 10,
      maxSize: 2000,
      modifiedAfter: "2026-01-01T00:00:00Z",
      modifiedBefore: "2026-07-01T00:00:00Z",
    });
    expect(sql).toContain(
      "WHERE bucket = ? AND key LIKE ? ESCAPE '\\' AND content_type = ? AND " +
        "size >= ? AND size <= ? AND uploaded >= ? AND uploaded < ?",
    );
    expect(binds).toEqual([
      "lemurkit-storage",
      "img/%",
      "image/png",
      10,
      2000,
      "2026-01-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
    ]);
  });

  it("clamps the page size and always fetches one extra row", () => {
    expect(buildQuery({ limit: 5 }).sql).toContain("LIMIT 6");
    expect(buildQuery({ limit: 99999 }).sql).toContain("LIMIT 1001"); // capped at 1000 (+1)
    expect(buildQuery({ limit: 0 }).sql).toContain("LIMIT 2"); // floored at 1 (+1)
  });

  it("appends a keyset clause for a valid cursor, after the filter binds", () => {
    const { sql, binds } = buildQuery({ bucket: "b", cursor: cursorFor("b", "k9") });
    expect(sql).toContain("AND (bucket, key) > (?, ?)");
    expect(binds).toEqual(["b", "b", "k9"]);
  });

  it("ignores a malformed cursor rather than erroring", () => {
    const { sql, binds } = buildQuery({ cursor: "not-base64-json" });
    expect(sql).not.toContain("(bucket, key) >");
    expect(binds).toEqual([]);
  });
});

interface FakeRow {
  bucket: string;
  key: string;
  size: number;
  content_type: string | null;
  etag: string;
  uploaded: string;
}

/** Minimal stand-in for the slice of D1 `queryObjects` uses: prepare → bind → all(). */
class FakeD1 {
  constructor(private rows: FakeRow[]) {}
  prepare() {
    const rows = this.rows;
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: rows, success: true, meta: {} }),
    };
    return stmt as unknown as D1PreparedStatement;
  }
}

const row = (bucket: string, key: string, over: Partial<FakeRow> = {}): FakeRow => ({
  bucket,
  key,
  size: 1,
  content_type: "text/plain",
  etag: "e",
  uploaded: "2026-01-01T00:00:00Z",
  ...over,
});

describe("queryObjects", () => {
  it("maps rows to records, mapping NULL content_type to undefined", async () => {
    const db = new FakeD1([
      row("b", "k", { content_type: null, size: 42 }),
    ]) as unknown as D1Database;
    const page = await queryObjects(db, { limit: 10 });
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeUndefined();
    expect(page.objects).toEqual([
      {
        bucket: "b",
        key: "k",
        size: 42,
        etag: "e",
        uploaded: "2026-01-01T00:00:00Z",
        contentType: undefined,
      },
    ]);
  });

  it("trims to the page size and returns a cursor pointing at the last kept row", async () => {
    // Three rows returned for a limit of 2 → the extra row signals a next page.
    const db = new FakeD1([
      row("b", "k1"),
      row("b", "k2"),
      row("b", "k3"),
    ]) as unknown as D1Database;
    const page = await queryObjects(db, { limit: 2 });
    expect(page.truncated).toBe(true);
    expect(page.objects.map((o) => o.key)).toEqual(["k1", "k2"]);
    expect(page.cursor).toBe(cursorFor("b", "k2"));
  });
});

// ── Real-SQL integration layer (node:sqlite + ?raw schema; ambient shims in shims.d.ts) ──────

/**
 * A real-SQL D1 stand-in over node:sqlite. Implements just the surface metadata.ts touches:
 * prepare → bind → all()/run(), and batch(). `bind` returns a fresh bound statement each call
 * (D1 semantics — the prepared statement is a reusable template), which reindexBucket relies on
 * when it binds one INSERT template per row and batches them.
 */
class SqliteD1 {
  private db: DatabaseSync;
  constructor(schema: string) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(schema);
  }
  prepare(sql: string) {
    const db = this.db;
    const bound = (params: unknown[]) => ({
      bind: (...p: unknown[]) => bound(p),
      run: async () => (db.prepare(sql).run(...params), { success: true, meta: {} }),
      all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    });
    return bound([]);
  }
  async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

/**
 * R2 fake that mirrors the load-bearing real-R2 quirk this fix is about: list() only attaches
 * httpMetadata (where contentType lives) when `include: ["httpMetadata"]` is requested. If
 * listFiles ever drops that option again, contentType arrives undefined here and the assertion
 * below fails — that's the regression guard.
 */
interface R2Entry {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  contentType?: string;
  /** UTF-8 body, served by get() — so reindex's search-text extraction has something to read. */
  body?: string;
}
class IncludeGatedBucket {
  constructor(private entries: R2Entry[]) {}
  async list(options?: { include?: ("httpMetadata" | "customMetadata")[] }) {
    const withMeta = options?.include?.includes("httpMetadata") ?? false;
    const objects = this.entries.map((e) => ({
      key: e.key,
      size: e.size,
      etag: e.etag,
      uploaded: e.uploaded,
      httpMetadata: withMeta && e.contentType ? { contentType: e.contentType } : undefined,
    }));
    return { objects, delimitedPrefixes: [], truncated: false };
  }
  // reindexBucket reads each text-y object under the size cap to extract its searchable body.
  async get(key: string) {
    const e = this.entries.find((x) => x.key === key);
    if (!e) return null;
    const bytes = new TextEncoder().encode(e.body ?? "");
    return {
      key: e.key,
      size: e.size,
      etag: e.etag,
      uploaded: e.uploaded,
      httpMetadata: e.contentType ? { contentType: e.contentType } : undefined,
      arrayBuffer: async () => bytes.buffer,
    };
  }
}

describe("reindexBucket → queryObjects (real SQL via node:sqlite)", () => {
  // Both migrations: reindexBucket now writes the objects_fts table (0002) as well as objects (0001).
  const newDb = () => new SqliteD1(`${schema}\n${schemaFts}`) as unknown as D1Database;
  const r2 = () =>
    new IncludeGatedBucket([
      {
        key: "research-materials/State-of-Agentic-AI-Security.pdf",
        size: 2661139,
        etag: "9d91e1699749cb616b07f93062fd2efe",
        uploaded: new Date("2026-06-21T04:48:43.699Z"),
        contentType: "application/pdf",
      },
      {
        key: "security-briefing/security-briefing-2026-06-21.md",
        size: 17709,
        etag: "88f053abb92eb342b500a41f2953f9c5",
        uploaded: new Date("2026-06-21T00:52:45.517Z"),
        contentType: "text/markdown",
        body: "# Security briefing\nQuarterly roadmap and supply-chain threat overview.",
      },
    ]) as unknown as R2Bucket;

  it("captures contentType from R2 list metadata so query_files can filter by it", async () => {
    const db = newDb();
    const result = await reindexBucket(db, "lemurkit-storage", r2());
    expect(result.indexed).toBe(2);

    const pdfs = await queryObjects(db, {
      bucket: "lemurkit-storage",
      contentType: "application/pdf",
    });
    expect(pdfs.objects.map((o) => o.key)).toEqual([
      "research-materials/State-of-Agentic-AI-Security.pdf",
    ]);
    expect(pdfs.objects[0]?.contentType).toBe("application/pdf");
  });

  it("runs the generated prefix + size SQL against a real engine", async () => {
    const db = newDb();
    await reindexBucket(db, "lemurkit-storage", r2());

    const briefings = await queryObjects(db, { prefix: "security-briefing/", minSize: 1000 });
    expect(briefings.objects.map((o) => o.key)).toEqual([
      "security-briefing/security-briefing-2026-06-21.md",
    ]);
  });
});

// ── Full-text search (FTS5) ──────────────────────────────────────────────────────────────────

describe("buildSearchQuery", () => {
  it("returns null when the query has no usable terms", () => {
    expect(buildSearchQuery({ q: "" })).toBeNull();
    expect(buildSearchQuery({ q: "   \t " })).toBeNull();
  });

  it("turns terms into a prefix-matched AND match expression, bound first", () => {
    const built = buildSearchQuery({ q: "road map" });
    if (!built) throw new Error("expected a built query");
    expect(built.binds[0]).toBe('"road"* "map"*');
    expect(built.sql).toContain("objects_fts MATCH ?");
    expect(built.sql).toContain("ORDER BY rank, bucket, key");
  });

  it("escapes an embedded double-quote so it can't break out of the term", () => {
    const built = buildSearchQuery({ q: 'a"b' });
    if (!built) throw new Error("expected a built query");
    expect(built.binds[0]).toBe('"a""b"*');
  });

  it("adds a bucket filter bound after the match expression", () => {
    const built = buildSearchQuery({ q: "x", bucket: "lemurkit-storage" });
    if (!built) throw new Error("expected a built query");
    expect(built.sql).toContain("AND bucket = ?");
    expect(built.binds).toEqual(['"x"*', "lemurkit-storage"]);
  });

  it("clamps the limit and pages by the cursor's offset", () => {
    const five = buildSearchQuery({ q: "x", limit: 5 });
    expect(five?.sql).toContain("LIMIT 6 OFFSET 0"); // limit + 1
    expect(buildSearchQuery({ q: "x", limit: 9999 })?.sql).toContain("LIMIT 101"); // capped at 100 (+1)
    const cursor = btoa(JSON.stringify(20));
    expect(buildSearchQuery({ q: "x", cursor })?.sql).toContain("OFFSET 20");
  });
});

describe("searchObjects (real SQL via node:sqlite FTS5)", () => {
  const newDb = () => new SqliteD1(`${schema}\n${schemaFts}`) as unknown as D1Database;
  const bucketWith = (entries: R2Entry[]) => new IncludeGatedBucket(entries) as unknown as R2Bucket;

  const lemurkit = () =>
    bucketWith([
      {
        key: "security-briefing/security-briefing-2026-06-21.md",
        size: 200,
        etag: "a",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "text/markdown",
        body: "# Briefing\nQuarterly roadmap and supply-chain threat overview.",
      },
      {
        key: "research-materials/State-of-Agentic-AI-Security.pdf",
        size: 2661139, // over the cap → key-only (no body read, no content indexed)
        etag: "b",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "application/pdf",
      },
    ]);

  it("finds an object by a word in its content, ranked, with a highlighted snippet", async () => {
    const db = newDb();
    await reindexBucket(db, "lemurkit-storage", lemurkit());

    const page = await searchObjects(db, { q: "roadmap" });
    expect(page.matches.map((m) => m.key)).toEqual([
      "security-briefing/security-briefing-2026-06-21.md",
    ]);
    expect(page.matches[0]?.snippet).toContain("[roadmap]");
  });

  it("finds an object by a word in its KEY even with no indexed content (binary/oversized)", async () => {
    const db = newDb();
    await reindexBucket(db, "lemurkit-storage", lemurkit());

    // "agentic" appears only in the PDF's key — proves key tokens are searchable without a body.
    const page = await searchObjects(db, { q: "agentic" });
    expect(page.matches.map((m) => m.key)).toEqual([
      "research-materials/State-of-Agentic-AI-Security.pdf",
    ]);
  });

  it("scopes results to one bucket when asked, across all buckets otherwise", async () => {
    const db = newDb();
    await reindexBucket(db, "lemurkit-storage", lemurkit());
    await reindexBucket(
      db,
      "bucket-b",
      bucketWith([
        {
          key: "notes/threat.md",
          size: 50,
          etag: "c",
          uploaded: new Date("2026-06-20T00:00:00Z"),
          contentType: "text/markdown",
          body: "Threat model notes.",
        },
      ]),
    );

    const all = await searchObjects(db, { q: "threat" });
    expect(all.matches.map((m) => m.bucket).sort()).toEqual(["bucket-b", "lemurkit-storage"]);

    const scoped = await searchObjects(db, { q: "threat", bucket: "bucket-b" });
    expect(scoped.matches.map((m) => m.key)).toEqual(["notes/threat.md"]);
  });

  it("returns an empty page for a query with no usable terms", async () => {
    const page = await searchObjects(newDb(), { q: "   " });
    expect(page).toEqual({ matches: [], truncated: false });
  });

  it("drops an object from search once it's unindexed (FTS row cleared too)", async () => {
    const db = newDb();
    await reindexBucket(db, "lemurkit-storage", lemurkit());
    await unindexObjects(db, "lemurkit-storage", [
      "security-briefing/security-briefing-2026-06-21.md",
    ]);

    const page = await searchObjects(db, { q: "roadmap" });
    expect(page.matches).toEqual([]);
  });

  it("paginates by offset cursor, signalling more with truncated", async () => {
    const db = newDb();
    await reindexBucket(
      db,
      "lemurkit-storage",
      bucketWith([
        {
          key: "a.md",
          size: 30,
          etag: "1",
          uploaded: new Date("2026-06-21T00:00:00Z"),
          contentType: "text/markdown",
          body: "shared widget alpha",
        },
        {
          key: "b.md",
          size: 30,
          etag: "2",
          uploaded: new Date("2026-06-21T00:00:00Z"),
          contentType: "text/markdown",
          body: "shared widget beta",
        },
      ]),
    );

    const first = await searchObjects(db, { q: "widget", limit: 1 });
    expect(first.matches).toHaveLength(1);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBeDefined();

    const second = await searchObjects(db, { q: "widget", limit: 1, cursor: first.cursor });
    expect(second.matches).toHaveLength(1);
    expect(second.truncated).toBe(false);
    // Different object on the second page — the offset advanced.
    expect(second.matches[0]?.key).not.toBe(first.matches[0]?.key);
  });
});
