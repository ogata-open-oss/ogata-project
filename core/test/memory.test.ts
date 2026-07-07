import { describe, expect, it } from "vitest";
import {
  forgetMemory,
  listMemory,
  MANIFEST_SLUG,
  MAX_MEMORY_LINES,
  readMemory,
  writeMemory,
} from "../src/memory";

/**
 * Minimal in-memory stand-in for the subset of the KV binding the memory helpers use
 * (put with metadata, getWithMetadata, list with prefix + paging, delete). Stores the value and
 * its metadata together — like real KV — so the index path (metadata returned by list without a
 * body fetch) is exercised. list() pages two-at-a-time so the cursor loop in listMemory is tested.
 */
class FakeKV {
  private store = new Map<string, { value: string; metadata?: unknown }>();

  async put(key: string, value: string, options?: { metadata?: unknown }) {
    this.store.set(key, { value, metadata: options?.metadata });
  }

  async getWithMetadata<M>(key: string, _type?: "text") {
    const entry = this.store.get(key);
    return entry
      ? { value: entry.value, metadata: (entry.metadata ?? null) as M | null }
      : { value: null, metadata: null as M | null };
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list<M>(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const names = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

    const pageSize = 2; // small, to force pagination through the cursor loop
    const start = options?.cursor ? Number(options.cursor) : 0;
    const slice = names.slice(start, start + pageSize);
    const next = start + pageSize;
    const complete = next >= names.length;

    const keys = slice.map((name) => ({
      name,
      metadata: (this.store.get(name)?.metadata ?? undefined) as M | undefined,
    }));
    return complete
      ? { keys, list_complete: true as const }
      : { keys, list_complete: false as const, cursor: String(next) };
  }
}

function kv(): KVNamespace {
  return new FakeKV() as unknown as KVNamespace;
}

const ref = (programme: string, codename: string, slug: string) => ({
  programme,
  codename,
  slug,
});

describe("memory", () => {
  it("round-trips write -> read with body and metadata, stamping updated", async () => {
    const m = kv();
    const written = await writeMemory(
      m,
      ref("acme", "apollo", "supply-chain-stance"),
      "# Stance\nPin everything by SHA.",
      { title: "Supply-chain stance", tags: ["security"], hook: "Pin by SHA." },
    );
    expect(written).toMatchObject({ status: "ok", lines: 2 });
    expect(written).toHaveProperty("updated");

    const doc = await readMemory(m, ref("acme", "apollo", "supply-chain-stance"));
    expect(doc?.body).toBe("# Stance\nPin everything by SHA.");
    expect(doc?.title).toBe("Supply-chain stance");
    expect(doc?.tags).toEqual(["security"]);
    expect(doc?.hook).toBe("Pin by SHA.");
    expect(doc?.ref).toEqual(ref("acme", "apollo", "supply-chain-stance"));
  });

  it("returns null for a missing fragment", async () => {
    expect(await readMemory(kv(), ref("acme", "apollo", "nope"))).toBeNull();
  });

  it("refuses a body over the line cap, writing nothing", async () => {
    const m = kv();
    const tooLong = Array.from({ length: MAX_MEMORY_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    const result = await writeMemory(m, ref("acme", "hermes", "big"), tooLong, { title: "Big" });
    expect(result).toEqual({
      status: "too_long",
      lines: MAX_MEMORY_LINES + 1,
      limit: MAX_MEMORY_LINES,
    });
    // Nothing was stored.
    expect(await readMemory(m, ref("acme", "hermes", "big"))).toBeNull();

    // Exactly at the cap is allowed.
    const ok = Array.from({ length: MAX_MEMORY_LINES }, (_, i) => `line ${i}`).join("\n");
    expect((await writeMemory(m, ref("acme", "hermes", "big"), ok, { title: "Big" })).status).toBe(
      "ok",
    );
  });

  it("lists the index as a TOC (refs + metadata, no bodies) and scopes by prefix", async () => {
    const m = kv();
    await writeMemory(m, ref("acme", "hermes", "a"), "x", { title: "A" });
    await writeMemory(m, ref("acme", "hermes", "b"), "y", { title: "B", tags: ["t"] });
    await writeMemory(m, ref("acme", "lyra", "c"), "z", { title: "C" });
    await writeMemory(m, ref("labs", "platform", "d"), "w", { title: "D" });

    // Whole keyspace (pages through the cursor loop given pageSize 2).
    const all = await listMemory(m);
    expect(all).toHaveLength(4);

    // Scope to a programme.
    const programme = await listMemory(m, { programme: "acme" });
    expect(programme.map((e) => e.ref.slug).sort()).toEqual(["a", "b", "c"]);

    // Scope to a programme+codename — and confirm metadata rides along without a body.
    const codename = await listMemory(m, { programme: "acme", codename: "hermes" });
    expect(codename.map((e) => e.ref.slug).sort()).toEqual(["a", "b"]);
    const b = codename.find((e) => e.ref.slug === "b");
    expect(b?.meta?.title).toBe("B");
    expect(b?.meta?.tags).toEqual(["t"]);
    expect(b).not.toHaveProperty("body");
  });

  it("forgets a fragment", async () => {
    const m = kv();
    await writeMemory(m, ref("acme", "hermes", "tmp"), "x", { title: "tmp" });
    await forgetMemory(m, ref("acme", "hermes", "tmp"));
    expect(await readMemory(m, ref("acme", "hermes", "tmp"))).toBeNull();
  });

  it("stores the curated manifest as an ordinary fragment at the reserved slug", async () => {
    const m = kv();
    await writeMemory(m, ref("acme", "hermes", MANIFEST_SLUG), "- [A](a)", {
      title: "Index",
    });
    const manifest = await readMemory(m, ref("acme", "hermes", MANIFEST_SLUG));
    expect(manifest?.body).toBe("- [A](a)");
    // It shows up in the index like any other fragment.
    const listed = await listMemory(m, { programme: "acme", codename: "hermes" });
    expect(listed.map((e) => e.ref.slug)).toContain(MANIFEST_SLUG);
  });
});
