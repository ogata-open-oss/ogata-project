import { DatabaseSync } from "node:sqlite";

/**
 * In-memory stand-ins for the Worker bindings the server-level tests exercise. Test harnesses
 * are intentionally local per package (same convention as packages/core/test) — these mirror the
 * core tests' fakes, trimmed to the slices `buildServer`'s tools touch.
 */

/** Real-SQL D1 stand-in over node:sqlite — prepare → bind → run()/all(), plus batch(). */
export class SqliteD1 {
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
  /** Test-only escape hatch for asserting on raw rows. */
  rows(sql: string): Record<string, unknown>[] {
    return this.db.prepare(sql).all();
  }
}

interface Entry {
  body: Uint8Array;
  contentType?: string;
  uploaded: Date;
  etag: string;
}

async function readBody(value: string | Uint8Array | ReadableStream<Uint8Array>) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  const chunks: Uint8Array[] = [];
  const reader = value.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (chunk) chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Minimal in-memory R2 fake: put/get/head/delete/list — enough for write_file, delete_file, and
 * index_bucket's reconcile walk (list always attaches httpMetadata, like listFiles requests).
 */
export class FakeBucket {
  private store = new Map<string, Entry>();
  private seq = 0;

  async put(
    key: string,
    value: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    this.seq += 1;
    const entry: Entry = {
      body: await readBody(value),
      contentType: options?.httpMetadata?.contentType,
      uploaded: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)),
      etag: `etag-${this.seq}`,
    };
    this.store.set(key, entry);
    return this.toObject(key, entry);
  }

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const body = entry.body;
    return {
      ...this.toObject(key, entry),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }

  async head(key: string) {
    const entry = this.store.get(key);
    return entry ? this.toObject(key, entry) : null;
  }

  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) this.store.delete(k);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const objects = [...this.store.entries()]
      .filter(([k]) => !options?.prefix || k.startsWith(options.prefix))
      .map(([k, e]) => this.toObject(k, e));
    return { objects, truncated: false, delimitedPrefixes: [] };
  }

  private toObject(key: string, entry: Entry) {
    return {
      key,
      size: entry.body.length,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
      customMetadata: undefined,
    };
  }
}

/** Minimal KV fake for the memory tools (put/getWithMetadata/list/delete). */
export class FakeKV {
  private store = new Map<string, { value: string; metadata?: unknown }>();
  async put(key: string, value: string, options?: { metadata?: unknown }) {
    this.store.set(key, { value, metadata: options?.metadata });
  }
  async getWithMetadata(key: string) {
    const e = this.store.get(key);
    return e ? { value: e.value, metadata: e.metadata ?? null } : { value: null, metadata: null };
  }
  async list(options?: { prefix?: string; cursor?: string }) {
    void options?.cursor;
    const keys = [...this.store.entries()]
      .filter(([k]) => !options?.prefix || k.startsWith(options.prefix))
      .map(([name, e]) => ({ name, metadata: e.metadata }));
    return { keys, list_complete: true as const, cursor: undefined };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}
