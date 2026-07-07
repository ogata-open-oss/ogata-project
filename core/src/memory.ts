import type {
  MemoryDoc,
  MemoryListEntry,
  MemoryMeta,
  MemoryRef,
  MemoryScope,
  MemoryWriteResult,
} from "./types";

/**
 * KV-backed transactive memory — the fragmented "shared CLAUDE.local.md" that spans Claude
 * surfaces (webchat projects + Claude Code across repos/VMs for one operator). Framework-agnostic,
 * KV-shaped (takes a `KVNamespace`, mirroring how `storage.ts` takes an `R2Bucket`), so it
 * unit-tests against an in-memory KV fake with no live namespace.
 *
 * Design (see the `kv-tms-design` note): each fragment is a small ≤200-line doc stored as the KV
 * *value*, with a lean `{title, tags, hook, updated}` as the KV per-key *metadata*. The
 * where-is-what index is **derived from the keyspace** — a prefix `list()` returns every fragment's
 * ref + metadata without fetching a single body. A curated manifest fragment (slug
 * {@link MANIFEST_SLUG}) layers ordering/links on top, but it's just another doc — KV stays dumb
 * (get/put/list); anything relational/queryable is D1's job, not a KV epicycle.
 */

/** Top-level key namespace. Keys are `mem/<programme>/<codename>/<slug>`. */
const NAMESPACE = "mem";

/**
 * Max body length, in lines, for one fragment. The cap is the whole point: it keeps memory
 * fragmented and single-topic so retrieval stays precise. Over the cap, the write is refused.
 */
export const MAX_MEMORY_LINES = 200;

/** KV caps per-key metadata at 1 KiB; we refuse a write whose metadata would exceed it. */
const MAX_META_BYTES = 1024;

/**
 * Reserved slug for a project's curated index — the namespace's `MEMORY.md`: ordering, one-line
 * hooks, and `[[links]]` between fragments. Just a normal memory doc at a conventional slug.
 */
export const MANIFEST_SLUG = "_manifest";

/** Build the KV key for a ref: `mem/<programme>/<codename>/<slug>`. */
function keyFor(ref: MemoryRef): string {
  return `${NAMESPACE}/${ref.programme}/${ref.codename}/${ref.slug}`;
}

/** Build the list prefix for a scope: all memory, one programme, or one programme+codename. */
function prefixFor(scope: MemoryScope): string {
  const parts = [NAMESPACE];
  if (scope.programme) {
    parts.push(scope.programme);
    if (scope.codename) parts.push(scope.codename);
  }
  return `${parts.join("/")}/`;
}

/** Parse a KV key back into a ref — the inverse of {@link keyFor}. */
function refFromKey(key: string): MemoryRef {
  const [, programme = "", codename = "", ...rest] = key.split("/");
  return { programme, codename, slug: rest.join("/") };
}

/** Line count of a body (0 for empty). A fragment of N lines has N-1 newlines. */
function countLines(body: string): number {
  return body === "" ? 0 : body.split("\n").length;
}

/** Byte size of the serialized metadata, against the KV 1 KiB cap. */
function metaBytes(meta: MemoryMeta): number {
  return new TextEncoder().encode(JSON.stringify(meta)).length;
}

/** Drop undefined fields so stored metadata stays minimal (and within the byte cap). */
function buildMeta(input: { title: string; tags?: string[]; hook?: string }): MemoryMeta {
  const meta: MemoryMeta = { title: input.title, updated: new Date().toISOString() };
  if (input.tags && input.tags.length > 0) meta.tags = input.tags;
  if (input.hook) meta.hook = input.hook;
  return meta;
}

/** Fields a caller supplies when writing a fragment (the `updated` stamp is added here). */
export interface MemoryInput {
  title: string;
  tags?: string[];
  hook?: string;
}

/**
 * Create or overwrite a memory fragment. Non-fragmenting guards: refuses (writing nothing) if the
 * body exceeds {@link MAX_MEMORY_LINES} or the metadata would exceed KV's 1 KiB cap. The `updated`
 * timestamp is stamped here.
 */
export async function writeMemory(
  kv: KVNamespace,
  ref: MemoryRef,
  body: string,
  input: MemoryInput,
): Promise<MemoryWriteResult> {
  const lines = countLines(body);
  if (lines > MAX_MEMORY_LINES) {
    return { status: "too_long", lines, limit: MAX_MEMORY_LINES };
  }

  const meta = buildMeta(input);
  const bytes = metaBytes(meta);
  if (bytes > MAX_META_BYTES) {
    return { status: "metadata_too_large", bytes, limit: MAX_META_BYTES };
  }

  await kv.put(keyFor(ref), body, { metadata: meta });
  return { status: "ok", ref, updated: meta.updated, lines };
}

/** Read a fragment by ref — body + metadata, or `null` if there is none. */
export async function readMemory(kv: KVNamespace, ref: MemoryRef): Promise<MemoryDoc | null> {
  const { value, metadata } = await kv.getWithMetadata<MemoryMeta>(keyFor(ref), "text");
  if (value === null) return null;
  const meta = metadata ?? { title: ref.slug, updated: "" };
  return { ref, body: value, ...meta };
}

/**
 * The index (where-is-what TOC): every fragment's ref + metadata for the scope, **no bodies**.
 * Reconstructed from prefix `list()` + per-key metadata, paging through the full keyspace. This is
 * the transactive metamemory — that something exists and where to fetch it by handle.
 */
export async function listMemory(
  kv: KVNamespace,
  scope: MemoryScope = {},
): Promise<MemoryListEntry[]> {
  const entries: MemoryListEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<MemoryMeta>({ prefix: prefixFor(scope), cursor, limit: 1000 });
    for (const k of page.keys) {
      entries.push({ ref: refFromKey(k.name), meta: k.metadata ?? undefined });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

/** Delete a fragment by ref. */
export async function forgetMemory(kv: KVNamespace, ref: MemoryRef): Promise<void> {
  await kv.delete(keyFor(ref));
}
