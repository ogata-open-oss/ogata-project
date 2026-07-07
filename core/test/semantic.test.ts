import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  chunkId,
  chunkText,
  indexObjectVectors,
  MAX_VECTOR_CHUNK_CHARS,
  reindexObjectVectors,
  semanticSearch,
  unindexObjectVectors,
} from "../src/semantic";
import type { Embedder, VectorRecord, VectorStore } from "../src/semantic";
// The real migration, imported verbatim (vite ?raw) so the tests run against the actual schema.
// `@migrations` is a vitest alias (see vitest.config.ts) — the migrations directory sits at a
// different relative distance in the private workspace vs the flattened OSS tree.
import schemaChunks from "@migrations/0003_create_object_chunks.sql?raw";

/**
 * Three layers of test, mirroring metadata.test.ts:
 *  - the pure helpers (`chunkText`, `chunkId`) — bug-prone boundary logic — tested directly, no I/O;
 *  - the index → search → delete round-trip against a real-SQL D1 (node:sqlite + the actual 0003
 *    migration) with an in-memory `FakeVectorStore` + `FakeEmbedder` standing in for Vectorize +
 *    Workers AI (neither has local emulation, so the fakes are how this runs offline — the live
 *    round-trip is covered by the remote smoke runbook, not here);
 *  - `reindexObjectVectors` against the same IncludeGatedBucket R2 fake the metadata test uses.
 */

// ── Fakes ─────────────────────────────────────────────────────────────────────

/**
 * A deterministic embedder: a normalised bag-of-words vector over a fixed dimension (token → bucket
 * by hash). Texts sharing words get a higher cosine, so it exercises the ranking wiring without a
 * real model — it tests OUR plumbing, not embedding quality (that's the live smoke test's job).
 */
const DIM = 64;
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
function fakeVec(text: string): number[] {
  const v = Array.from({ length: DIM }, () => 0);
  for (const tok of tokenize(text)) {
    let h = 0;
    for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    const idx = h % DIM;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
class FakeEmbedder implements Embedder {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(fakeVec));
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** In-memory ANN store: brute-force cosine, namespace-scoped — the Vectorize seam for tests. */
class FakeVectorStore implements VectorStore {
  private vecs = new Map<string, { values: number[]; namespace?: string }>();
  upsert(records: VectorRecord[]): Promise<void> {
    for (const r of records) this.vecs.set(r.id, { values: r.values, namespace: r.namespace });
    return Promise.resolve();
  }
  query(values: number[], opts: { topK: number; namespace?: string }) {
    const scored = [...this.vecs.entries()]
      .filter(([, v]) => opts.namespace === undefined || v.namespace === opts.namespace)
      .map(([id, v]) => ({ id, score: cosine(values, v.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
    return Promise.resolve(scored);
  }
  deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.vecs.delete(id);
    return Promise.resolve();
  }
  /** Test-only: how many vectors are stored (asserts deletes actually evict). */
  get size() {
    return this.vecs.size;
  }
}

/**
 * Real-SQL D1 stand-in over node:sqlite — the slice semantic.ts touches: prepare → bind → all()/run()
 * and batch(). Copied from metadata.test.ts (test harnesses are intentionally local per file).
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

/** R2 fake — same include-gating + UTF-8 body serving as metadata.test.ts, for reindex tests. */
interface R2Entry {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  contentType?: string;
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

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("returns an empty array for empty / whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t ")).toEqual([]);
  });

  it("returns a single trimmed chunk when the text fits the window", () => {
    expect(chunkText("  hello world  ")).toEqual(["hello world"]);
  });

  it("splits oversized text into overlapping windows that cover all of it", () => {
    const text = "x".repeat(MAX_VECTOR_CHUNK_CHARS + 5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.length).toBe(MAX_VECTOR_CHUNK_CHARS);
    // The windows overlap, so concatenated length exceeds the original — but every char is covered.
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
    expect(chunks.at(-1)?.length).toBeGreaterThan(0);
  });
});

describe("chunkId", () => {
  it("is deterministic and stable across calls", () => {
    expect(chunkId("b", "docs/readme.md", 0)).toBe(chunkId("b", "docs/readme.md", 0));
  });

  it("differs by bucket, key, and ordinal", () => {
    const base = chunkId("b", "k", 0);
    expect(chunkId("b2", "k", 0)).not.toBe(base);
    expect(chunkId("b", "k2", 0)).not.toBe(base);
    expect(chunkId("b", "k", 1)).not.toBe(base);
  });

  it("stays within Vectorize's 64-byte id limit even for long keys", () => {
    const id = chunkId("bucket-b", "a/very/deeply/nested/" + "x".repeat(500) + ".md", 9);
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
  });
});

// ── index → search → delete (real SQL + fakes) ────────────────────────────────

describe("semanticSearch round-trip", () => {
  const newDb = () => new SqliteD1(schemaChunks) as unknown as D1Database;

  const seed = async (db: D1Database, store: VectorStore, embedder: Embedder) => {
    await indexObjectVectors(
      db,
      store,
      embedder,
      "lemurkit-storage",
      "notes/supply-chain.md",
      "We gate dependency installs to block malicious package publishes and supply chain worms.",
    );
    await indexObjectVectors(
      db,
      store,
      embedder,
      "lemurkit-storage",
      "notes/meditation.md",
      "Daily meditation breathing brings calm focus and spiritual clarity.",
    );
  };

  it("ranks the conceptually-closest object first, with score + snippet", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    await seed(db, store, embedder);

    const page = await semanticSearch(db, store, embedder, { q: "block dependency installs" });
    expect(page.matches[0]?.key).toBe("notes/supply-chain.md");
    expect(page.matches[0]?.score).toBeGreaterThan(0);
    expect(page.matches[0]?.snippet).toContain("dependency installs");
  });

  it("scopes to one bucket via the namespace, spanning all when omitted", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    await seed(db, store, embedder);
    await indexObjectVectors(
      db,
      store,
      embedder,
      "bucket-b",
      "briefs/threat.md",
      "Supply chain threat model: dependency install gating and worm containment.",
    );

    const all = await semanticSearch(db, store, embedder, { q: "dependency install gating" });
    expect(all.matches.map((m) => m.bucket).sort()).toContain("bucket-b");

    const scoped = await semanticSearch(db, store, embedder, {
      q: "dependency install gating",
      bucket: "bucket-b",
    });
    expect(scoped.matches.every((m) => m.bucket === "bucket-b")).toBe(true);
    expect(scoped.matches.map((m) => m.key)).toContain("briefs/threat.md");
  });

  it("returns one result per object even when it spans multiple chunks", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    // A body over the window → multiple chunks → multiple vectors for one object.
    const big = ("dependency install gating supply chain " + "filler ".repeat(50)).repeat(700);
    await indexObjectVectors(db, store, embedder, "lemurkit-storage", "notes/big.md", big);
    expect(store.size).toBeGreaterThan(1); // proves it chunked

    const page = await semanticSearch(db, store, embedder, { q: "dependency install gating" });
    expect(page.matches.filter((m) => m.key === "notes/big.md")).toHaveLength(1);
  });

  it("drops an object from results once its vectors are unindexed (both stores cleared)", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    await seed(db, store, embedder);

    await unindexObjectVectors(db, store, "lemurkit-storage", ["notes/supply-chain.md"]);
    const page = await semanticSearch(db, store, embedder, { q: "block dependency installs" });
    expect(page.matches.map((m) => m.key)).not.toContain("notes/supply-chain.md");
  });

  it("re-indexing an object replaces its vectors rather than duplicating them", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    await indexObjectVectors(
      db,
      store,
      embedder,
      "lemurkit-storage",
      "notes/a.md",
      "first version",
    );
    const after1 = store.size;
    await indexObjectVectors(
      db,
      store,
      embedder,
      "lemurkit-storage",
      "notes/a.md",
      "second version",
    );
    expect(store.size).toBe(after1); // same single-chunk object → same vector id, upserted in place
  });

  it("does not index binary/empty objects (no text → absent from the semantic index)", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    await indexObjectVectors(db, store, embedder, "lemurkit-storage", "img/logo.png", undefined);
    expect(store.size).toBe(0);
  });

  it("returns an empty page for a blank query", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const page = await semanticSearch(db, store, new FakeEmbedder(), { q: "   " });
    expect(page).toEqual({ matches: [], truncated: false });
  });

  it("paginates by offset cursor, signalling more with truncated", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    // Three single-chunk objects all matching the query term.
    for (const k of ["a", "b", "c"]) {
      await indexObjectVectors(
        db,
        store,
        embedder,
        "lemurkit-storage",
        `${k}.md`,
        "shared widget topic",
      );
    }
    const first = await semanticSearch(db, store, embedder, { q: "widget", limit: 2 });
    expect(first.matches).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBeDefined();

    const second = await semanticSearch(db, store, embedder, {
      q: "widget",
      limit: 2,
      cursor: first.cursor,
    });
    expect(second.matches).toHaveLength(1);
    expect(second.truncated).toBe(false);
  });
});

// ── reconcile (reindexObjectVectors against R2) ───────────────────────────────

describe("reindexObjectVectors (real SQL + R2 fake)", () => {
  const newDb = () => new SqliteD1(schemaChunks) as unknown as D1Database;

  it("embeds text-y objects from R2 and skips binary/oversized ones, then is searchable", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    const r2 = new IncludeGatedBucket([
      {
        key: "briefing/security.md",
        size: 80,
        etag: "a",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "text/markdown",
        body: "Supply-chain threat overview and dependency install gating.",
      },
      {
        key: "research/agentic.pdf",
        size: 2_661_139, // over the cap → no body extracted → not embedded
        etag: "b",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "application/pdf",
      },
    ]) as unknown as R2Bucket;

    const result = await reindexObjectVectors(db, store, embedder, "lemurkit-storage", r2);
    expect(result.objects).toBe(1); // only the markdown got embedded
    expect(result.chunks).toBeGreaterThanOrEqual(1);

    const page = await semanticSearch(db, store, embedder, { q: "dependency install gating" });
    expect(page.matches.map((m) => m.key)).toEqual(["briefing/security.md"]);
  });

  it("skips an object whose embed fails, counts it, and still indexes the rest", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    // An embedder that rejects a poison chunk — standing in for Workers AI's "3030 input too big"
    // on a token-dense body. The bucket reconcile must survive it, not abort.
    class FlakyEmbedder implements Embedder {
      embed(texts: string[]): Promise<number[][]> {
        if (texts.some((t) => t.includes("POISON"))) {
          return Promise.reject(new Error("3030 input too big"));
        }
        return Promise.resolve(texts.map(fakeVec));
      }
    }
    const embedder = new FlakyEmbedder();
    const r2 = new IncludeGatedBucket([
      {
        key: "good.md",
        size: 40,
        etag: "a",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "text/markdown",
        body: "dependency install gating notes",
      },
      {
        key: "bad.json",
        size: 50,
        etag: "b",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "text/plain", // text-y so it's extracted + reaches the embedder, which throws
        body: "POISON token-dense payload that overflows the model window",
      },
    ]) as unknown as R2Bucket;

    const result = await reindexObjectVectors(db, store, embedder, "lemurkit-storage", r2);
    expect(result.objects).toBe(1); // only the healthy object embedded
    expect(result.failures).toBe(1); // the poison one was skipped + counted, not fatal
    // The healthy object is still searchable; the failed one simply has no vectors.
    const page = await semanticSearch(db, store, embedder, { q: "dependency install gating" });
    expect(page.matches.map((m) => m.key)).toEqual(["good.md"]);
  });

  it("clears vectors for objects removed from R2 since the last index", async () => {
    const db = newDb();
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    const withDoc = new IncludeGatedBucket([
      {
        key: "gone.md",
        size: 30,
        etag: "a",
        uploaded: new Date("2026-06-21T00:00:00Z"),
        contentType: "text/markdown",
        body: "dependency install gating notes",
      },
    ]) as unknown as R2Bucket;
    await reindexObjectVectors(db, store, embedder, "lemurkit-storage", withDoc);
    expect(store.size).toBeGreaterThan(0);

    // The object is gone from R2 on the next reconcile → its vectors must be cleared.
    const empty = new IncludeGatedBucket([]) as unknown as R2Bucket;
    await reindexObjectVectors(db, store, embedder, "lemurkit-storage", empty);
    expect(store.size).toBe(0);
    const page = await semanticSearch(db, store, embedder, { q: "dependency install gating" });
    expect(page.matches).toEqual([]);
  });
});
