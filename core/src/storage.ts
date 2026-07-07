import type { Listing, ReadResult, StoredFile, TransferResult, WriteResult } from "./types";

// workers-types 4.20260527.1 omits `include` from R2ListOptions, but the R2 *runtime* supports it:
// list() returns httpMetadata/customMetadata only when explicitly asked. We model the real API so
// listFiles() below can request httpMetadata — without it, reindexBucket indexes every content_type
// as NULL and query_files can't filter by type. Declared here (a module both core and the Worker
// import) so the augmentation travels into every program. Remove if workers-types adds it natively.
declare global {
  interface R2ListOptions {
    include?: ("httpMetadata" | "customMetadata")[];
  }
}

/** Default delimiter used to present R2's flat keyspace as folders. */
const DEFAULT_DELIMITER = "/";

function toStoredFile(object: R2Object): StoredFile {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded.toISOString(),
    contentType: object.httpMetadata?.contentType,
  };
}

/** Base64-encode raw bytes (chunked so large bodies don't blow the call stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 back to raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Content-types we treat as UTF-8 text. Everything else is binary (base64). */
const TEXT_CONTENT_TYPE =
  /^(text\/|application\/(json|xml|javascript|ld\+json|yaml|x-yaml))|\+(json|xml)$/i;

/**
 * Whether a content-type names a UTF-8 text format (strips any `; charset=…`
 * parameter first). Used both to classify reads and, by the search indexer, as a
 * cheap pre-check to skip fetching obvious binaries (PDF/image/…). Returns false
 * for an absent content-type — callers that can afford a byte sniff use {@link isText}.
 */
export function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return TEXT_CONTENT_TYPE.test((contentType.split(";")[0] ?? "").trim());
}

/**
 * Decide whether an object should be returned as text or base64.
 *
 * Content-type is authoritative when present (an explicit `image/png` is binary
 * even if the bytes happen to decode). When it's absent, we sniff: a NUL byte or
 * any invalid UTF-8 sequence means binary.
 */
function isText(contentType: string | undefined, bytes: Uint8Array): boolean {
  if (contentType) {
    return isTextContentType(contentType);
  }
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface ListOptions {
  /** Restrict to keys under this prefix, e.g. `docs/`. */
  prefix?: string;
  /** Pagination cursor from a previous {@link Listing}. */
  cursor?: string;
  /**
   * Folder delimiter. Defaults to `/` (folder-style browsing). Pass `null` to
   * list every matching key flat, with no folder grouping.
   */
  delimiter?: string | null;
  /** Max objects per page (R2 default/max is 1000). */
  limit?: number;
}

/** List files and folder prefixes under an optional prefix. */
export async function listFiles(bucket: R2Bucket, options: ListOptions = {}): Promise<Listing> {
  const delimiter =
    options.delimiter === null ? undefined : (options.delimiter ?? DEFAULT_DELIMITER);

  const result = await bucket.list({
    prefix: options.prefix,
    cursor: options.cursor,
    delimiter,
    limit: options.limit,
    // Ask R2 for httpMetadata so contentType survives into the index (see the R2ListOptions note
    // above). With `include`, R2 may return fewer than `limit` objects per page to fit the metadata,
    // so callers must page off `truncated`/`cursor` (not a count) — which listFiles/reindexBucket do.
    include: ["httpMetadata"],
  });

  return {
    prefix: options.prefix ?? "",
    files: result.objects.map(toStoredFile),
    folders: result.delimitedPrefixes,
    cursor: result.truncated ? result.cursor : undefined,
    truncated: result.truncated,
  };
}

/**
 * Read a file by key. Returns `null` when the key does not exist.
 *
 * Binary-safe: the body is read as raw bytes and returned UTF-8-decoded for text
 * content, or base64-encoded for binary — so images/PDFs round-trip losslessly
 * instead of being mangled by a blind UTF-8 decode. See {@link isText}.
 */
export async function readFile(bucket: R2Bucket, key: string): Promise<ReadResult | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  const contentType = object.httpMetadata?.contentType;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const asText = isText(contentType, bytes);
  return {
    key: object.key,
    encoding: asText ? "utf8" : "base64",
    content: asText ? new TextDecoder().decode(bytes) : bytesToBase64(bytes),
    size: object.size,
    etag: object.etag,
    contentType,
  };
}

export interface WriteOptions {
  /** MIME type to store as the object's content type. */
  contentType?: string;
  /**
   * How `content` is encoded: `utf8` (default) stores it as text; `base64`
   * decodes it to raw bytes first, so binary (images, PDFs, …) can be written.
   */
  encoding?: "utf8" | "base64";
}

/** Create or overwrite a file. Pass `encoding: "base64"` to store binary content. */
export async function writeFile(
  bucket: R2Bucket,
  key: string,
  content: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const body = options.encoding === "base64" ? base64ToBytes(content) : content;
  const object = await bucket.put(key, body, {
    httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
  });
  if (object === null) {
    throw new Error(`Failed to write file: ${key}`);
  }
  return { key: object.key, size: object.size, etag: object.etag };
}

/** Delete one or more files by key. */
export async function deleteFile(bucket: R2Bucket, key: string | string[]): Promise<void> {
  await bucket.delete(key);
}

export interface CopyOptions {
  /**
   * Replace the destination if a key already exists there. Default `false` —
   * non-destructive: the transfer is refused (`destination_exists`) rather than
   * silently clobbering an existing object.
   */
  overwrite?: boolean;
}

/**
 * Copy an object to a new key, optionally into another bucket (pass a different
 * `destination` binding — both are plain `R2Bucket`s, so cross-store copy is the
 * same code as same-store). R2 has no native server-side copy, so this is a
 * **streamed** `get` → `put`: the source body (`R2ObjectBody.body`, a
 * `ReadableStream`) is piped straight into the destination without buffering the
 * whole object in the Worker's memory. Content-type and custom metadata carry over.
 *
 * Non-destructive by default — see {@link CopyOptions.overwrite}.
 */
export async function copyFile(
  source: R2Bucket,
  sourceKey: string,
  destination: R2Bucket,
  destKey: string,
  options: CopyOptions = {},
): Promise<TransferResult> {
  if (!options.overwrite) {
    const existing = await destination.head(destKey);
    if (existing !== null) return { status: "destination_exists", key: destKey };
  }

  const object = await source.get(sourceKey);
  if (object === null) return { status: "source_not_found", key: sourceKey };

  const written = await destination.put(destKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
  if (written === null) throw new Error(`Failed to copy to ${destKey}`);
  return { status: "ok", key: written.key, size: written.size, etag: written.etag };
}

/**
 * Move an object: {@link copyFile} then delete the source. The copy's
 * non-destructive guard applies, so a move that would clobber an existing
 * destination fails with `destination_exists` and the source is left **intact**
 * (nothing is deleted unless the copy succeeded). Moving a key onto itself
 * (same bucket, same key) is a no-op — the source is never deleted.
 */
export async function moveFile(
  source: R2Bucket,
  sourceKey: string,
  destination: R2Bucket,
  destKey: string,
  options: CopyOptions = {},
): Promise<TransferResult> {
  if (source === destination && sourceKey === destKey) {
    const head = await source.head(sourceKey);
    return head === null
      ? { status: "source_not_found", key: sourceKey }
      : { status: "ok", key: sourceKey, size: head.size, etag: head.etag };
  }

  const result = await copyFile(source, sourceKey, destination, destKey, options);
  if (result.status === "ok") await source.delete(sourceKey);
  return result;
}

/** Fetch metadata for a key without reading its body. Returns `null` if missing. */
export async function getFileInfo(bucket: R2Bucket, key: string): Promise<StoredFile | null> {
  const object = await bucket.head(key);
  return object === null ? null : toStoredFile(object);
}
