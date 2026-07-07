import { describe, expect, it } from "vitest";
import {
  copyFile,
  deleteFile,
  getFileInfo,
  listFiles,
  moveFile,
  readFile,
  writeFile,
} from "../src/storage";

interface Entry {
  body: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
  uploaded: Date;
  etag: string;
}

/**
 * Minimal in-memory stand-in for the subset of the R2 binding our storage
 * helpers use (put/get/head/delete/list with prefix, delimiter, cursor, limit).
 * Bodies are stored as raw bytes — like real R2 — so the binary path is exercised.
 */
class FakeBucket {
  private store = new Map<string, Entry>();
  private seq = 0;

  async put(
    key: string,
    value: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ) {
    this.seq += 1;
    const entry: Entry = {
      body: await readBody(value),
      contentType: options?.httpMetadata?.contentType,
      customMetadata: options?.customMetadata,
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
      // R2ObjectBody exposes the body as a stream — copyFile pipes it straight into put().
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

  async list(options?: {
    prefix?: string;
    cursor?: string;
    delimiter?: string;
    limit?: number;
    include?: ("httpMetadata" | "customMetadata")[];
  }) {
    const prefix = options?.prefix ?? "";
    const { delimiter, include } = options ?? {};
    const limit = options?.limit ?? 1000;

    const matching = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

    const folders = new Set<string>();
    const fileKeys: string[] = [];
    for (const key of matching) {
      if (delimiter) {
        const idx = key.slice(prefix.length).indexOf(delimiter);
        if (idx !== -1) {
          folders.add(key.slice(0, prefix.length + idx + delimiter.length));
          continue;
        }
      }
      fileKeys.push(key);
    }

    let start = 0;
    if (options?.cursor) {
      const found = fileKeys.indexOf(options.cursor);
      start = found === -1 ? 0 : found + 1;
    }
    const page = fileKeys.slice(start, start + limit);
    const truncated = start + limit < fileKeys.length;

    // Real R2 only attaches httpMetadata/customMetadata to list() results when `include`
    // requests it — otherwise those fields are undefined. Mirror that, so a missing `include`
    // can't be papered over by an over-generous fake (this is the contentType-NULL bug class).
    const objects = page.map((k) => {
      const obj = this.toObject(k, this.store.get(k) as Entry);
      return {
        ...obj,
        httpMetadata: include?.includes("httpMetadata") ? obj.httpMetadata : undefined,
        customMetadata: include?.includes("customMetadata") ? obj.customMetadata : undefined,
      };
    });
    const delimitedPrefixes = [...folders].sort();
    return truncated
      ? { objects, delimitedPrefixes, truncated: true, cursor: page[page.length - 1] }
      : { objects, delimitedPrefixes, truncated: false };
  }

  private toObject(key: string, entry: Entry) {
    return {
      key,
      size: entry.body.byteLength,
      etag: entry.etag,
      uploaded: entry.uploaded,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
      customMetadata: entry.customMetadata,
    };
  }
}

/** Collapse a put() body — string, bytes, or a stream (as copyFile pipes) — to raw bytes. */
async function readBody(
  value: string | Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function bucket(): R2Bucket {
  return new FakeBucket() as unknown as R2Bucket;
}

describe("storage", () => {
  it("round-trips write -> read -> delete", async () => {
    const b = bucket();
    const written = await writeFile(b, "docs/readme.md", "hello", { contentType: "text/markdown" });
    expect(written).toMatchObject({ key: "docs/readme.md", size: 5 });

    const read = await readFile(b, "docs/readme.md");
    expect(read?.encoding).toBe("utf8");
    expect(read?.content).toBe("hello");
    expect(read?.contentType).toBe("text/markdown");

    await deleteFile(b, "docs/readme.md");
    expect(await readFile(b, "docs/readme.md")).toBeNull();
  });

  it("returns metadata via getFileInfo and null for a missing key", async () => {
    const b = bucket();
    await writeFile(b, "a.txt", "12345");
    expect((await getFileInfo(b, "a.txt"))?.size).toBe(5);
    expect(await getFileInfo(b, "missing.txt")).toBeNull();
  });

  it("groups keys into folders with the default delimiter", async () => {
    const b = bucket();
    await writeFile(b, "root.txt", "x");
    await writeFile(b, "docs/a.md", "x");
    await writeFile(b, "docs/b.md", "x");
    await writeFile(b, "img/logo.png", "x");

    const top = await listFiles(b);
    expect(top.files.map((f) => f.key)).toEqual(["root.txt"]);
    expect(top.folders).toEqual(["docs/", "img/"]);

    const docs = await listFiles(b, { prefix: "docs/" });
    expect(docs.files.map((f) => f.key)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(docs.folders).toEqual([]);
  });

  it("paginates flat listings with a cursor", async () => {
    const b = bucket();
    for (const key of ["f1", "f2", "f3"]) await writeFile(b, key, "x");

    const first = await listFiles(b, { delimiter: null, limit: 2 });
    expect(first.files.map((f) => f.key)).toEqual(["f1", "f2"]);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe("f2");

    const second = await listFiles(b, { delimiter: null, limit: 2, cursor: first.cursor });
    expect(second.files.map((f) => f.key)).toEqual(["f3"]);
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeUndefined();
  });

  // Bytes that are NOT valid UTF-8 (PNG magic 0x89, 0xFF, a NUL) — a blind
  // `.text()` decode would replace these with U+FFFD and lose them.
  const binaryFixture = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff, 0xfe, 0x42,
  ]);
  const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  it("round-trips binary content losslessly via base64", async () => {
    const b = bucket();
    const base64 = toBase64(binaryFixture);
    await writeFile(b, "img/logo.png", base64, { encoding: "base64", contentType: "image/png" });

    const read = await readFile(b, "img/logo.png");
    expect(read?.encoding).toBe("base64");
    expect(read?.content).toBe(base64);
    expect(read?.size).toBe(binaryFixture.length);
    // The decisive check: the exact bytes survive — no U+FFFD corruption.
    expect(fromBase64(read!.content)).toEqual(binaryFixture);
  });

  it("treats a binary content-type as base64 even when the bytes look like text", async () => {
    const b = bucket();
    await writeFile(b, "data.bin", "plain text", { contentType: "application/octet-stream" });
    const read = await readFile(b, "data.bin");
    expect(read?.encoding).toBe("base64");
    expect(read?.content).toBe(toBase64(new TextEncoder().encode("plain text")));
  });

  it("sniffs encoding when no content-type is stored", async () => {
    const b = bucket();
    await writeFile(b, "notes", "just text"); // no content-type
    await writeFile(b, "blob", toBase64(binaryFixture), { encoding: "base64" }); // no content-type

    expect((await readFile(b, "notes"))?.encoding).toBe("utf8");
    expect((await readFile(b, "blob"))?.encoding).toBe("base64");
  });

  describe("copy and move", () => {
    it("copies within a bucket, preserving content and leaving the source", async () => {
      const b = bucket();
      await writeFile(b, "docs/a.md", "hello", { contentType: "text/markdown" });

      const result = await copyFile(b, "docs/a.md", b, "archive/a.md");
      expect(result).toMatchObject({ status: "ok", key: "archive/a.md", size: 5 });

      expect((await readFile(b, "archive/a.md"))?.content).toBe("hello");
      // Source untouched.
      expect((await readFile(b, "docs/a.md"))?.content).toBe("hello");
    });

    it("copies binary across buckets losslessly", async () => {
      const src = bucket();
      const dst = bucket();
      const base64 = toBase64(binaryFixture);
      await writeFile(src, "img/logo.png", base64, {
        encoding: "base64",
        contentType: "image/png",
      });

      const result = await copyFile(src, "img/logo.png", dst, "logos/logo.png");
      expect(result.status).toBe("ok");

      const read = await readFile(dst, "logos/logo.png");
      expect(read?.contentType).toBe("image/png");
      expect(fromBase64(read!.content)).toEqual(binaryFixture);
    });

    it("refuses to overwrite an existing destination unless overwrite is set", async () => {
      const b = bucket();
      await writeFile(b, "src.txt", "new");
      await writeFile(b, "dst.txt", "old");

      const guarded = await copyFile(b, "src.txt", b, "dst.txt");
      expect(guarded).toEqual({ status: "destination_exists", key: "dst.txt" });
      // Destination is untouched by the refused copy.
      expect((await readFile(b, "dst.txt"))?.content).toBe("old");

      const forced = await copyFile(b, "src.txt", b, "dst.txt", { overwrite: true });
      expect(forced.status).toBe("ok");
      expect((await readFile(b, "dst.txt"))?.content).toBe("new");
    });

    it("reports source_not_found for a missing source key", async () => {
      const b = bucket();
      expect(await copyFile(b, "nope.txt", b, "dst.txt")).toEqual({
        status: "source_not_found",
        key: "nope.txt",
      });
    });

    it("moves a file: destination gains it, source is gone", async () => {
      const b = bucket();
      await writeFile(b, "inbox/draft.md", "wip");

      const result = await moveFile(b, "inbox/draft.md", b, "docs/draft.md");
      expect(result).toMatchObject({ status: "ok", key: "docs/draft.md" });

      expect((await readFile(b, "docs/draft.md"))?.content).toBe("wip");
      expect(await readFile(b, "inbox/draft.md")).toBeNull();
    });

    it("move refuses to clobber an existing destination, preserving the source", async () => {
      const b = bucket();
      await writeFile(b, "a.txt", "from");
      await writeFile(b, "b.txt", "keep");

      const result = await moveFile(b, "a.txt", b, "b.txt");
      expect(result).toEqual({ status: "destination_exists", key: "b.txt" });
      // Neither file changed — the source must NOT have been deleted.
      expect((await readFile(b, "a.txt"))?.content).toBe("from");
      expect((await readFile(b, "b.txt"))?.content).toBe("keep");
    });

    it("moving a key onto itself is a no-op (source is not deleted)", async () => {
      const b = bucket();
      await writeFile(b, "self.txt", "stay");

      const result = await moveFile(b, "self.txt", b, "self.txt");
      expect(result).toMatchObject({ status: "ok", key: "self.txt" });
      expect((await readFile(b, "self.txt"))?.content).toBe("stay");
    });
  });
});
