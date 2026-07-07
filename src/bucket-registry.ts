import { z } from "zod";

/**
 * The bucket-registry factory. A deployment's registry — which R2 stores its tools may address,
 * by what names — is instance configuration, not shared logic: the private deploy registers
 * several stores, the OSS build exactly one. `defineBuckets` holds the helper logic once so each
 * entry point (`src/index.ts`, the OSS entry) supplies only its own name → binding map.
 *
 * Names are deliberately decoupled from the underlying R2 bucket names: a registry name is the
 * tool-facing label (the `bucket` argument, the D1 index's `bucket` column), while the binding is
 * whatever `wrangler.jsonc` attaches — under auto-provisioning the real R2 bucket may not even
 * have a chosen name. Kept free of `cloudflare:` / `agents` runtime imports so registries load
 * under the plain Node ESM loader for unit tests.
 */
export interface BucketEntry<E> {
  /** Resolve this store's R2 binding from the Worker env. */
  get: (env: E) => R2Bucket;
  /** One-line description surfaced by `list_buckets` as the store directory. */
  description: string;
}

/** One entry in the {@link BucketToolkit.bucketDirectory} `list_buckets` returns. */
export interface BucketDirectoryEntry {
  name: string;
  description: string;
  default: boolean;
}

/**
 * The `bucket` / `destBucket` tool-argument schema shape: an optional enum over known names.
 * (zod 4 types an enum by its `{ name: name }` record; built from a plain `string[]` that
 * degrades to `Record<string, string>` — output stays `string | undefined`.)
 */
export type BucketArgSchema = z.ZodOptional<z.ZodEnum<Record<string, string>>>;

/** Everything the server builder needs to address a deployment's stores. */
export interface BucketToolkit<E> {
  /** The reusable `bucket` tool argument: an optional enum over the known bucket names. */
  bucketArg: BucketArgSchema;
  /**
   * The `destBucket` argument for copy/move: like {@link bucketArg}, but its default is the
   * *source* bucket, not the global default store — the caller resolves it as
   * `resolveBucket(env, destBucket ?? bucket)` so an omitted `destBucket` keeps a transfer
   * within the bucket being operated on.
   */
  destBucketArg: BucketArgSchema;
  /** Resolve a `bucket` argument to its R2 binding, falling back to the default store. */
  resolveBucket: (env: E, bucket: string | undefined) => R2Bucket;
  /**
   * The canonical bucket NAME a `bucket` argument resolves to (applying the default). The D1
   * index is keyed by this name, so write-through needs the string, not just the binding.
   */
  resolveBucketName: (bucket: string | undefined) => string;
  /**
   * The store directory `list_buckets` returns: every addressable bucket with its description
   * and whether it's the default. Pure metadata over the registry — it touches no binding,
   * which is why `list_buckets` can't fail at runtime.
   */
  bucketDirectory: () => BucketDirectoryEntry[];
}

/** Build a deployment's bucket toolkit from its name → binding registry. */
export function defineBuckets<E>(
  buckets: Record<string, BucketEntry<E>>,
  defaultBucket: string,
): BucketToolkit<E> {
  const names = Object.keys(buckets);
  if (names.length === 0) throw new Error("defineBuckets: the registry needs at least one bucket");
  if (!(defaultBucket in buckets)) {
    throw new Error(`defineBuckets: default bucket '${defaultBucket}' is not in the registry`);
  }
  const enumNames = names as [string, ...string[]];

  const bucketArg = z
    .enum(enumNames)
    .optional()
    .describe(
      `Which storage bucket to operate on (default '${defaultBucket}', the main project store). ` +
        `One of: ${names.join(", ")}.`,
    );

  const destBucketArg = z
    .enum(enumNames)
    .optional()
    .describe(
      `Destination bucket for the copy/move. Omit to stay in the source bucket. ` +
        `One of: ${names.join(", ")}.`,
    );

  return {
    bucketArg,
    destBucketArg,
    resolveBucket: (env, bucket) => {
      const name = bucket ?? defaultBucket;
      const entry = buckets[name];
      // The zod enum on every tool argument already rejects unknown names; this guards direct
      // programmatic callers.
      if (!entry) throw new Error(`unknown bucket '${name}'`);
      return entry.get(env);
    },
    resolveBucketName: (bucket) => bucket ?? defaultBucket,
    bucketDirectory: () =>
      names.map((name) => ({
        name,
        // `buckets[name]` is definitionally present for a key from Object.keys; the fallback
        // only satisfies noUncheckedIndexedAccess.
        description: buckets[name]?.description ?? "",
        default: name === defaultBucket,
      })),
  };
}
