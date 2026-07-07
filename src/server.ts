import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  copyFile,
  deleteFile,
  extractSearchText,
  forgetMemory,
  getFileInfo,
  indexObject,
  indexObjectText,
  indexObjectVectors,
  listFiles,
  listMemory,
  MANIFEST_SLUG,
  MAX_MEMORY_LINES,
  moveFile,
  queryObjects,
  readFile,
  readMemory,
  reindexBucket,
  reindexObjectVectors,
  searchObjects,
  semanticSearch,
  unindexObjects,
  unindexObjectVectors,
  writeFile,
  writeMemory,
} from "@lemurkit/core";
import type { Embedder, VectorStore } from "@lemurkit/core";
import type { BucketToolkit } from "./bucket-registry.js";
import { VectorizeStore, WorkersAiEmbedder } from "./vector.js";

/**
 * The MCP server builder, shared by every entry point. An entry supplies its own bucket registry
 * (a {@link BucketToolkit}) and an env satisfying {@link ServerEnv}; everything else — the tool
 * set, the write-through index plumbing, the semantic tier gating — is defined once here, so a
 * tool added here ships in every build automatically.
 *
 * Deliberately free of `agents`/`cloudflare:` imports (the MCP HTTP handler lives in the entry
 * points): this module loads under the plain Node ESM loader, which is what lets the tool surface
 * be unit-tested end-to-end with in-memory fakes and no Worker runtime.
 */

/**
 * The bindings the server builder itself needs. `AI` + `VECTORIZE` are OPTIONAL — semantic search
 * is a tier, not the product: when both bindings exist the third search projection (vectors)
 * registers and write-through embeds; when either is absent the server runs the metadata +
 * full-text projections only, with no warnings and no dead tools. Entry-point envs (which carry
 * the R2 bindings and auth secrets on top) satisfy this structurally.
 */
export interface ServerEnv {
  /** KV namespace backing the transactive-memory tools. */
  MEMORY_KV: KVNamespace;
  /** D1 database holding the object-metadata + full-text (and, when enabled, chunk-map) indexes. */
  METADATA_DB: D1Database;
  /** Workers AI binding — the embedding half of the OPTIONAL semantic tier. */
  AI?: Ai;
  /** Vectorize index binding — the ANN half of the OPTIONAL semantic tier. */
  VECTORIZE?: Vectorize;
}

/** The semantic tier's two injected seams, present only when both bindings are configured. */
export interface SemanticSeams {
  embedder: Embedder;
  store: VectorStore;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Write-through index update after a successful R2 write/copy/move: head the object for its
 * canonical metadata (one consistent code path — D1 mirrors exactly what `get_file_info` reports)
 * and upsert its row, then re-index its searchable text (key tokens + extracted body, per
 * {@link extractSearchText}). Best-effort: a D1 failure is returned as a non-fatal warning rather
 * than thrown, so the R2 mutation (which already succeeded) isn't reported as failed — `index_bucket`
 * reconciles any drift. Returns a warning string, or `undefined` on success.
 *
 * The vector projection is gated on `semantic`: when the tier is off there is nothing to embed
 * and nothing to clean, so the vector calls are skipped entirely — a skipped tier must never
 * surface as a warning.
 */
async function indexAfterWrite(
  db: D1Database,
  semantic: SemanticSeams | undefined,
  bucket: string,
  r2: R2Bucket,
  key: string,
): Promise<string | undefined> {
  try {
    const info = await getFileInfo(r2, key);
    // The object should exist (we just wrote it); if a concurrent delete raced us, drop any stale row.
    if (info) {
      // One extraction feeds BOTH search projections (lexical + semantic), so they can't disagree
      // on what counts as text.
      const text = await extractSearchText(r2, info);
      await indexObject(db, bucket, info);
      await indexObjectText(db, bucket, key, text);
      if (semantic) {
        await indexObjectVectors(db, semantic.store, semantic.embedder, bucket, key, text);
      }
    } else {
      await unindexObjects(db, bucket, [key]);
      if (semantic) await unindexObjectVectors(db, semantic.store, bucket, [key]);
    }
    return undefined;
  } catch (e) {
    return `metadata index not updated for '${key}': ${errMsg(e)} (run index_bucket to reconcile)`;
  }
}

/** Write-through index delete after a successful R2 delete/move. Best-effort, like {@link indexAfterWrite}. */
async function indexAfterDelete(
  db: D1Database,
  semantic: SemanticSeams | undefined,
  bucket: string,
  keys: string[],
): Promise<string | undefined> {
  try {
    await unindexObjects(db, bucket, keys);
    if (semantic) await unindexObjectVectors(db, semantic.store, bucket, keys);
    return undefined;
  } catch (e) {
    return `metadata index not updated: ${errMsg(e)} (run index_bucket to reconcile)`;
  }
}

/** Attach a non-fatal `indexWarning` to a tool result only when write-through reported one. */
function withWarning<T extends object>(result: T, warning: string | undefined): T {
  return warning ? { ...result, indexWarning: warning } : result;
}

/** Wrap a value as an MCP text-content tool result. */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Cap on binary bodies returned inline. Above this, `read_file` returns metadata
 * only — a base64 (or image) payload past this size would overflow the model's
 * context. Tune as needed; large files want a download-URL tool instead.
 */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/**
 * A slug-safe name component for a memory ref. Lowercase, no slashes — `/` is the key delimiter
 * (`mem/<programme>/<codename>/<slug>`), so a stray slash would corrupt the keyspace.
 */
const memoryName = (what: string) =>
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/,
      `${what} must be slug-safe: lowercase letters, digits, '.', '_', '-', no slashes.`,
    );

const programmeArg = memoryName("programme").describe(
  "Programme the memory is scoped to — the taxonomy's top axis, e.g. 'acme' or 'labs'.",
);
const codenameArg = memoryName("codename").describe(
  "Code name (a stream's primary key) within the programme, e.g. 'apollo', 'hermes'.",
);
// `slug` is slug-safe like the others, with one deliberate exception: the reserved manifest slug
// ('_manifest') leads with '_', which `memoryName`'s regex forbids — so accept it explicitly rather
// than have the tool advertise a slug its own validator rejects. (programme/codename stay strict.)
const slugArg = z
  .string()
  .refine((s) => s === MANIFEST_SLUG || /^[a-z0-9][a-z0-9._-]*$/.test(s), {
    message:
      "slug must be slug-safe (lowercase letters, digits, '.', '_', '-', no slashes) " +
      `or the reserved '${MANIFEST_SLUG}'.`,
  })
  .describe(
    `Fragment id within the code name, e.g. 'supply-chain-stance'. Use '${MANIFEST_SLUG}' for the curated index.`,
  );

/**
 * Build the MCP server over the given bucket registry. Each tool resolves its target R2 bucket
 * per call via the `bucket` arg; the semantic tier registers only when the env carries BOTH the
 * `AI` and `VECTORIZE` bindings (a half-configured pair behaves as off).
 */
export function buildServer<E extends ServerEnv>(env: E, buckets: BucketToolkit<E>): McpServer {
  const server = new McpServer({ name: "lemurkit-storage", version: "0.1.0" });
  const { bucketArg, destBucketArg, resolveBucket, resolveBucketName, bucketDirectory } = buckets;

  // Semantic-search seams, bound to the live Workers AI + Vectorize bindings (see vector.ts) —
  // or absent as one unit when the tier is off. Shared by the write-through hooks, index_bucket,
  // and the semantic_search tool below.
  const semantic: SemanticSeams | undefined =
    env.AI && env.VECTORIZE
      ? { embedder: new WorkersAiEmbedder(env.AI), store: new VectorizeStore(env.VECTORIZE) }
      : undefined;

  server.registerTool(
    "list_buckets",
    {
      description:
        "List the storage buckets this connector can address — the valid values for the `bucket` " +
        "argument on every other tool, and which one is the default. A directory of stores, not " +
        "their contents (use list_files for a bucket's contents).",
      inputSchema: {},
    },
    async () => jsonResult({ buckets: bucketDirectory() }),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "List files and folders in the selected R2 store (see `bucket`). Returns objects under `prefix` plus " +
        "folder-style prefixes (default '/' delimiter). Use `cursor` to page; set `flat` to " +
        "list every key recursively.",
      inputSchema: {
        bucket: bucketArg,
        prefix: z
          .string()
          .optional()
          .describe("Key prefix to list under, e.g. 'docs/'. Omit to list the root."),
        cursor: z.string().optional().describe("Pagination cursor from a previous list call."),
        flat: z
          .boolean()
          .optional()
          .describe("List every key recursively instead of grouping into folders."),
      },
    },
    async ({ bucket, prefix, cursor, flat }) => {
      const listing = await listFiles(resolveBucket(env, bucket), {
        prefix,
        cursor,
        delimiter: flat ? null : "/",
      });
      return jsonResult(listing);
    },
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a file from the selected R2 store (see `bucket`) by key. Text returns as UTF-8 content; images " +
        "return as a viewable image; other binary returns base64. Always includes metadata " +
        "(size, etag, content type).",
      inputSchema: {
        bucket: bucketArg,
        key: z.string().describe("Full object key, e.g. 'docs/readme.md'."),
      },
    },
    async ({ bucket, key }) => {
      const file = await readFile(resolveBucket(env, bucket), key);
      if (file === null) return jsonResult({ error: "not_found", key });

      // Text: the JSON result carries the content directly.
      if (file.encoding === "utf8") return jsonResult(file);

      // Binary past the inline cap: metadata only, so we never overflow context.
      const meta = {
        key: file.key,
        size: file.size,
        etag: file.etag,
        contentType: file.contentType,
      };
      if (file.size > MAX_INLINE_BYTES) {
        return jsonResult({
          ...meta,
          error: "too_large_to_inline",
          message: `File is ${file.size} bytes, over the ${MAX_INLINE_BYTES}-byte inline limit. Use get_file_info for metadata.`,
        });
      }

      // Images: return a native image block the model can see, plus metadata.
      if (file.contentType?.startsWith("image/")) {
        return {
          content: [
            { type: "image" as const, data: file.content, mimeType: file.contentType },
            { type: "text" as const, text: JSON.stringify(meta, null, 2) },
          ],
        };
      }

      // Other binary (PDF, zip, …): base64 content + metadata.
      return jsonResult(file);
    },
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Create or overwrite a file in the selected R2 store (see `bucket`). Stores UTF-8 text by default; set " +
        "encoding to 'base64' to store binary content such as images or PDFs.",
      inputSchema: {
        bucket: bucketArg,
        key: z.string().describe("Full object key to write, e.g. 'docs/readme.md'."),
        content: z
          .string()
          .describe("File content — UTF-8 text, or a base64 string when encoding is 'base64'."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("How `content` is encoded: 'utf8' (default, text) or 'base64' (binary)."),
        contentType: z
          .string()
          .optional()
          .describe("MIME type, e.g. 'text/markdown' or 'image/png'. Defaults to none."),
      },
    },
    async ({ bucket, key, content, contentType, encoding }) => {
      const r2 = resolveBucket(env, bucket);
      const result = await writeFile(r2, key, content, { contentType, encoding });
      const warning = await indexAfterWrite(
        env.METADATA_DB,
        semantic,
        resolveBucketName(bucket),
        r2,
        key,
      );
      return jsonResult(withWarning(result, warning));
    },
  );

  server.registerTool(
    "delete_file",
    {
      description: "Delete one or more files from the selected R2 store (see `bucket`) by key.",
      inputSchema: {
        bucket: bucketArg,
        keys: z.array(z.string()).min(1).describe("One or more object keys to delete."),
      },
    },
    async ({ bucket, keys }) => {
      await deleteFile(resolveBucket(env, bucket), keys);
      const warning = await indexAfterDelete(
        env.METADATA_DB,
        semantic,
        resolveBucketName(bucket),
        keys,
      );
      return jsonResult(withWarning({ deleted: keys }, warning));
    },
  );

  server.registerTool(
    "get_file_info",
    {
      description:
        "Get metadata (size, etag, upload time, content type) for a file without reading its body.",
      inputSchema: {
        bucket: bucketArg,
        key: z.string().describe("Full object key, e.g. 'docs/readme.md'."),
      },
    },
    async ({ bucket, key }) => {
      const info = await getFileInfo(resolveBucket(env, bucket), key);
      return jsonResult(info ?? { error: "not_found", key });
    },
  );

  server.registerTool(
    "copy_file",
    {
      description:
        "Copy a file to a new key, optionally into a different R2 store (see `destBucket`). The " +
        "source is left in place. Content type and custom metadata carry over. Non-destructive: " +
        "returns status 'destination_exists' (and copies nothing) if the destination key already " +
        "exists, unless `overwrite` is true. Returns status 'source_not_found' if the source is missing.",
      inputSchema: {
        bucket: bucketArg,
        sourceKey: z.string().describe("Key of the file to copy, e.g. 'docs/readme.md'."),
        destKey: z.string().describe("Key to copy to, e.g. 'archive/readme.md'."),
        destBucket: destBucketArg,
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace the destination if it already exists (default false)."),
      },
    },
    async ({ bucket, sourceKey, destKey, destBucket, overwrite }) => {
      const destR2 = resolveBucket(env, destBucket ?? bucket);
      const result = await copyFile(resolveBucket(env, bucket), sourceKey, destR2, destKey, {
        overwrite,
      });
      // Write-through only on a real transfer; the guard cases (destination_exists,
      // source_not_found) changed nothing in R2, so the index stays as-is.
      const warning =
        result.status === "ok"
          ? await indexAfterWrite(
              env.METADATA_DB,
              semantic,
              resolveBucketName(destBucket ?? bucket),
              destR2,
              destKey,
            )
          : undefined;
      return jsonResult(withWarning(result, warning));
    },
  );

  server.registerTool(
    "move_file",
    {
      description:
        "Move a file to a new key, optionally into a different R2 store (see `destBucket`): copies " +
        "then deletes the source. Content type and custom metadata carry over. Non-destructive on " +
        "conflict: returns status 'destination_exists' and leaves BOTH files untouched (nothing is " +
        "deleted) if the destination key already exists, unless `overwrite` is true. Returns status " +
        "'source_not_found' if the source is missing. Moving a key onto itself is a no-op.",
      inputSchema: {
        bucket: bucketArg,
        sourceKey: z.string().describe("Key of the file to move, e.g. 'inbox/draft.md'."),
        destKey: z.string().describe("Key to move to, e.g. 'docs/draft.md'."),
        destBucket: destBucketArg,
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace the destination if it already exists (default false)."),
      },
    },
    async ({ bucket, sourceKey, destKey, destBucket, overwrite }) => {
      const destR2 = resolveBucket(env, destBucket ?? bucket);
      const result = await moveFile(resolveBucket(env, bucket), sourceKey, destR2, destKey, {
        overwrite,
      });
      // A move is copy-then-delete-source: on success, index the destination and drop the source
      // row. A self-move (same bucket + key) is a no-op in R2 and leaves its row correct, so skip
      // both — unindexing would wrongly evict the still-present object.
      let warning: string | undefined;
      if (result.status === "ok") {
        const srcName = resolveBucketName(bucket);
        const dstName = resolveBucketName(destBucket ?? bucket);
        if (srcName !== dstName || sourceKey !== destKey) {
          warning =
            (await indexAfterWrite(env.METADATA_DB, semantic, dstName, destR2, destKey)) ??
            (await indexAfterDelete(env.METADATA_DB, semantic, srcName, [sourceKey]));
        }
      }
      return jsonResult(withWarning(result, warning));
    },
  );

  // ── Object-metadata index (D1): query R2 by attributes, and reconcile from R2 ──────────────────
  server.registerTool(
    "query_files",
    {
      description:
        "Query the object-metadata index by attributes — content type, size range, upload date, " +
        "key prefix — across one bucket or ALL of them (omit `bucket`). Fast and filterable where " +
        "list_files only pages one prefix's raw listing. NOTE: the index reflects writes made " +
        "through this connector plus the last index_bucket run; objects uploaded out-of-band (e.g. " +
        "via the Cloudflare dashboard) appear only after index_bucket. Returns matching records " +
        "(bucket, key, size, etag, uploaded, contentType) and a `cursor` when more remain.",
      inputSchema: {
        bucket: bucketArg.describe(
          "Restrict to one bucket. Omit to query across every bucket (the index spans all of them).",
        ),
        prefix: z.string().optional().describe("Restrict to keys under this prefix, e.g. 'docs/'."),
        contentType: z.string().optional().describe("Exact MIME type to match, e.g. 'image/png'."),
        minSize: z.number().int().nonnegative().optional().describe("Minimum size in bytes."),
        maxSize: z.number().int().nonnegative().optional().describe("Maximum size in bytes."),
        modifiedAfter: z
          .string()
          .optional()
          .describe("Only objects uploaded at/after this ISO-8601 instant (inclusive)."),
        modifiedBefore: z
          .string()
          .optional()
          .describe("Only objects uploaded before this ISO-8601 instant (exclusive)."),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max records to return (default 100, max 1000)."),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous query_files call."),
      },
    },
    async ({
      bucket,
      prefix,
      contentType,
      minSize,
      maxSize,
      modifiedAfter,
      modifiedBefore,
      limit,
      cursor,
    }) => {
      const page = await queryObjects(env.METADATA_DB, {
        bucket,
        prefix,
        contentType,
        minSize,
        maxSize,
        modifiedAfter,
        modifiedBefore,
        limit,
        cursor,
      });
      return jsonResult(page);
    },
  );

  server.registerTool(
    "search_files",
    {
      description:
        "Full-text search the object index by WORDS — matches both file/key names and the extracted " +
        "text content of text-y objects (markdown, text, json, …), across one bucket or ALL of them " +
        "(omit `bucket`). Where query_files filters by attributes (type/size/date/prefix), this finds " +
        "objects by what they're called or what they contain, ranked by relevance with a highlighted " +
        "snippet. Lexical keyword search (terms are prefix-matched and AND-combined), not semantic. " +
        "NOTE: reflects writes through this connector plus the last index_bucket run; binary and " +
        "very large objects are searchable by name only. Returns matches (bucket, key, rank, snippet) " +
        "and a `cursor` when more remain.",
      inputSchema: {
        q: z
          .string()
          .describe(
            "Search words to match against object names and text content, e.g. 'roadmap draft'.",
          ),
        bucket: bucketArg.describe(
          "Restrict to one bucket. Omit to search across every bucket (the index spans all of them).",
        ),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max matches to return (default 20, max 100)."),
        cursor: z
          .string()
          .optional()
          .describe("Pagination cursor from a previous search_files call."),
      },
    },
    async ({ q, bucket, limit, cursor }) => {
      const page = await searchObjects(env.METADATA_DB, { q, bucket, limit, cursor });
      return jsonResult(page);
    },
  );

  // The third search lens registers only when the tier is on — an absent tool is honest; a
  // registered tool that always errors is not.
  if (semantic) {
    const seams = semantic;
    server.registerTool(
      "semantic_search",
      {
        description:
          "Semantic search the object index by MEANING — finds objects whose text content is " +
          "conceptually closest to your query, even when they share no keywords with it, across one " +
          "bucket or ALL of them (omit `bucket`). The third search lens: query_files filters by " +
          "attributes (type/size/date), search_files matches WORDS (lexical/BM25), this matches " +
          "MEANING (vector similarity). Ask in natural language — e.g. 'how we gate dependency " +
          "installs' surfaces the supply-chain notes without those exact words. NOTE: reflects writes " +
          "through this connector plus the last index_bucket run; only text-y objects under the size " +
          "cap are embedded — binary/oversized objects are NOT in the semantic index (find those via " +
          "search_files/query_files). Returns matches (bucket, key, score, snippet), best-first, and a " +
          "`cursor` when more remain.",
        inputSchema: {
          q: z
            .string()
            .describe(
              "Natural-language query — matched against object content by meaning, not keywords, " +
                "e.g. 'how do we block malicious package installs'.",
            ),
          bucket: bucketArg.describe(
            "Restrict to one bucket. Omit to search across every bucket (the index spans all of them).",
          ),
          limit: z
            .number()
            .int()
            .positive()
            .max(50)
            .optional()
            .describe("Max matches to return (default 10, max 50)."),
          cursor: z
            .string()
            .optional()
            .describe("Pagination cursor from a previous semantic_search call."),
        },
      },
      async ({ q, bucket, limit, cursor }) => {
        const page = await semanticSearch(env.METADATA_DB, seams.store, seams.embedder, {
          q,
          bucket,
          limit,
          cursor,
        });
        return jsonResult(page);
      },
    );
  }

  server.registerTool(
    "index_bucket",
    {
      // The description must tell the truth per-deployment: with the semantic tier off there is
      // no third index and no vector counts in the result.
      description: semantic
        ? "Rebuild ALL THREE indexes for a bucket from R2 itself — metadata (query_files), full-text " +
          "(search_files), AND semantic vectors (semantic_search): seeds an existing bucket and picks " +
          "up out-of-band writes the connector's own tools never recorded — run this after uploading " +
          "via the Cloudflare dashboard, or once to backfill. The storage tools keep all three indexes " +
          "current write-through, so this is only needed for changes made outside the connector. " +
          "Returns the objects indexed, plus the semantic embedding counts — `vectors.objects`/" +
          "`vectors.chunks` embedded and `vectors.failures` skipped (an object whose embed failed is " +
          "skipped, not fatal — still findable via search_files/query_files). A `vectorWarning` " +
          "instead means the whole vector rebuild failed; the metadata + full-text rebuild still succeeds."
        : "Rebuild BOTH indexes for a bucket from R2 itself — metadata (query_files) and full-text " +
          "(search_files): seeds an existing bucket and picks up out-of-band writes the connector's " +
          "own tools never recorded — run this after uploading via the Cloudflare dashboard, or once " +
          "to backfill. The storage tools keep both indexes current write-through, so this is only " +
          "needed for changes made outside the connector. Returns the objects indexed. (The semantic " +
          "tier is not enabled on this deployment — no vectors are built.)",
      inputSchema: { bucket: bucketArg },
    },
    async ({ bucket }) => {
      const name = resolveBucketName(bucket);
      const r2 = resolveBucket(env, bucket);
      const result = await reindexBucket(env.METADATA_DB, name, r2);
      // Tier off: the metadata + full-text rebuild IS the whole job — no vector counts, and no
      // warning (a skipped tier is not a failure).
      if (!semantic) return jsonResult(result);
      // The semantic rebuild calls Workers AI + Vectorize (network, and possibly not provisioned
      // yet): isolate it so an AI/Vectorize failure reports a warning rather than failing the whole
      // reconcile — the metadata + full-text indexes above are already rebuilt.
      try {
        const vectors = await reindexObjectVectors(
          env.METADATA_DB,
          semantic.store,
          semantic.embedder,
          name,
          r2,
        );
        return jsonResult({ ...result, vectors });
      } catch (e) {
        return jsonResult({ ...result, vectorWarning: `semantic index not rebuilt: ${errMsg(e)}` });
      }
    },
  );

  // ── Transactive memory: a fragmented shared context store across MCP-connected surfaces ────────
  server.registerTool(
    "write_memory",
    {
      description:
        "Write (create or overwrite) a shared memory fragment — a small doc in the cross-surface " +
        `memory, keyed by programme/codename/slug. Keep the body under ` +
        `${MAX_MEMORY_LINES} lines (single-topic; over that is refused with status 'too_long'). ` +
        `Store the curated index at slug '${MANIFEST_SLUG}'. title/tags/hook become the index ` +
        "metadata that list_memory returns without fetching bodies.",
      inputSchema: {
        programme: programmeArg,
        codename: codenameArg,
        slug: slugArg,
        body: z
          .string()
          .describe(
            `The memory doc (≤${MAX_MEMORY_LINES} lines): frontmatter + prose + [[links]].`,
          ),
        title: z.string().describe("One-line title, shown in the index (list_memory)."),
        tags: z.array(z.string()).optional().describe("Tags for grouping/filtering in the index."),
        hook: z.string().optional().describe("One-line hook/summary for the index."),
      },
    },
    async ({ programme, codename, slug, body, title, tags, hook }) => {
      const result = await writeMemory(env.MEMORY_KV, { programme, codename, slug }, body, {
        title,
        tags,
        hook,
      });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "read_memory",
    {
      description:
        "Read a shared memory fragment by programme/codename/slug. Returns the doc body plus its " +
        "metadata, or status 'not_found'.",
      inputSchema: { programme: programmeArg, codename: codenameArg, slug: slugArg },
    },
    async ({ programme, codename, slug }) => {
      const doc = await readMemory(env.MEMORY_KV, { programme, codename, slug });
      return jsonResult(doc ?? { error: "not_found", ref: { programme, codename, slug } });
    },
  );

  server.registerTool(
    "list_memory",
    {
      description:
        "List the memory index — the where-is-what directory: every fragment's ref plus its " +
        "title/tags/hook/updated, WITHOUT bodies (derived from the keyspace, so it's cheap). " +
        "Scope by programme, or programme+codename, to narrow; omit both for all memory. Read the " +
        `'${MANIFEST_SLUG}' fragment for the curated narrative index.`,
      inputSchema: {
        programme: programmeArg
          .optional()
          .describe("Narrow to one programme (omit for all programmes)."),
        codename: codenameArg
          .optional()
          .describe("Narrow to one code name within the programme (requires programme)."),
      },
    },
    async ({ programme, codename }) => {
      // `codename` narrows within a `programme`; without one it can't scope the prefix, so reject
      // rather than silently widening to all memory.
      if (codename && !programme) {
        return jsonResult({ error: "codename_requires_programme", codename });
      }
      const entries = await listMemory(env.MEMORY_KV, { programme, codename });
      return jsonResult({ entries });
    },
  );

  server.registerTool(
    "forget_memory",
    {
      description: "Delete a shared memory fragment by programme/codename/slug.",
      inputSchema: { programme: programmeArg, codename: codenameArg, slug: slugArg },
    },
    async ({ programme, codename, slug }) => {
      await forgetMemory(env.MEMORY_KV, { programme, codename, slug });
      return jsonResult({ forgotten: { programme, codename, slug } });
    },
  );

  return server;
}
