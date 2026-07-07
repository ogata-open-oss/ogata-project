import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server";
import type { ServerEnv } from "../src/server";
import { defineBuckets } from "../src/bucket-registry";
import { FakeBucket, FakeKV, SqliteD1 } from "./helpers";
// Relative on purpose (and it happens to be export-stable): test/ sits beside migrations/ at the
// same depth in the private package and in the flattened OSS tree.
import schema from "../migrations/0001_create_objects.sql?raw";
import schemaFts from "../migrations/0002_create_objects_fts.sql?raw";

/**
 * The semantic tier's GATING — the load-bearing OSS behavior: with the `AI`/`VECTORIZE` bindings
 * absent, the server must run the metadata + full-text projections cleanly, register no
 * `semantic_search`, and emit **no spurious warnings** — a skipped tier is not a failure. (The
 * naive implementation — fake no-op seams instead of helper-level gating — passes every other
 * test and taints EVERY write with an `indexWarning`; the write/delete/index_bucket assertions
 * here are the regression trap for exactly that.)
 *
 * Exercised end-to-end through a real MCP client over an in-memory transport: what a connected
 * Claude actually sees. Offline by construction — node:sqlite for D1, in-memory R2/KV fakes; the
 * tier-ON cases pin tool registration + metadata (the semantic pipeline itself is covered by
 * core's semantic.test.ts with the same seams).
 */

interface TestEnv extends ServerEnv {
  BUCKET: R2Bucket;
}

function makeEnv(options: { semantic: boolean }): { env: TestEnv; db: SqliteD1; r2: FakeBucket } {
  const db = new SqliteD1(`${schema}\n${schemaFts}`);
  const r2 = new FakeBucket();
  const env = {
    BUCKET: r2 as unknown as R2Bucket,
    MEMORY_KV: new FakeKV() as unknown as KVNamespace,
    METADATA_DB: db as unknown as D1Database,
    // Tier ON: the wrappers only need the bindings to EXIST for registration; the semantic
    // pipeline itself is core-tested with the same injected seams.
    ...(options.semantic ? { AI: {} as unknown as Ai, VECTORIZE: {} as unknown as Vectorize } : {}),
  } as TestEnv;
  return { env, db, r2 };
}

const testBuckets = defineBuckets<TestEnv>(
  { storage: { get: (env) => env.BUCKET, description: "Default project store." } },
  "storage",
);

/** Connect a real MCP client to the built server over an in-memory transport. */
async function connect(env: TestEnv) {
  const server = buildServer(env, testBuckets);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gating-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** Unwrap a jsonResult tool response back into the data object. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
  };
  const text = res.content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("semantic tier OFF (no AI/VECTORIZE bindings)", () => {
  it("does not register semantic_search; the other tools all remain", async () => {
    const { env } = makeEnv({ semantic: false });
    const client = await connect(env);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("semantic_search");
    for (const tool of ["list_buckets", "write_file", "search_files", "index_bucket"]) {
      expect(names).toContain(tool);
    }
  });

  it("index_bucket's description tells the truth: two indexes, no vectors", async () => {
    const { env } = makeEnv({ semantic: false });
    const client = await connect(env);
    const indexBucket = (await client.listTools()).tools.find((t) => t.name === "index_bucket");
    expect(indexBucket?.description).toContain("BOTH indexes");
    expect(indexBucket?.description).not.toContain("ALL THREE");
  });

  it("write_file succeeds with NO indexWarning, and both D1 projections update", async () => {
    const { env, db } = makeEnv({ semantic: false });
    const client = await connect(env);

    const result = await call(client, "write_file", {
      key: "docs/note.md",
      content: "# Note\nquarterly roadmap",
      contentType: "text/markdown",
    });

    expect(result.indexWarning).toBeUndefined();
    expect(db.rows("SELECT key FROM objects")).toEqual([{ key: "docs/note.md" }]);
    // The FTS projection sees the body: a content word must match.
    const hits = await call(client, "search_files", { q: "roadmap" });
    expect((hits.matches as { key: string }[]).map((m) => m.key)).toContain("docs/note.md");
  });

  it("delete_file succeeds with NO indexWarning and clears the rows", async () => {
    const { env, db } = makeEnv({ semantic: false });
    const client = await connect(env);
    await call(client, "write_file", { key: "a.txt", content: "hello", contentType: "text/plain" });

    const result = await call(client, "delete_file", { keys: ["a.txt"] });

    expect(result.indexWarning).toBeUndefined();
    expect(db.rows("SELECT key FROM objects")).toEqual([]);
  });

  it("index_bucket reconciles with NEITHER vector counts NOR a vectorWarning", async () => {
    const { env, r2 } = makeEnv({ semantic: false });
    await r2.put("seeded.md", "# Seeded\nout-of-band content", {
      httpMetadata: { contentType: "text/markdown" },
    });
    const client = await connect(env);

    const result = await call(client, "index_bucket", {});

    expect(result.indexed).toBe(1);
    expect(result.vectors).toBeUndefined();
    expect(result.vectorWarning).toBeUndefined();
  });

  it("treats a HALF-configured pair (AI without VECTORIZE) as off", async () => {
    const { env } = makeEnv({ semantic: false });
    (env as { AI?: Ai }).AI = {} as Ai;
    const client = await connect(env);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("semantic_search");
  });
});

describe("semantic tier ON (both bindings present)", () => {
  it("registers semantic_search and index_bucket advertises all three indexes", async () => {
    const { env } = makeEnv({ semantic: true });
    const client = await connect(env);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("semantic_search");
    const indexBucket = tools.tools.find((t) => t.name === "index_bucket");
    expect(indexBucket?.description).toContain("ALL THREE");
  });
});
