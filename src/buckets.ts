import { defineBuckets } from "./bucket-registry.js";
import type { BucketToolkit } from "./bucket-registry.js";
import type { Env } from "./env.js";

/**
 * THIS deployment's bucket registry. Out of the box there is exactly one store — the
 * auto-provisioned default bucket — but the registry is built for more: adding a store is one
 * entry here (name → binding + description), one `R2Bucket` field in `env.ts`, and one binding
 * in `wrangler.jsonc` (e.g. `BUCKET_ARCHIVE`, `BUCKET_MEDIA`). Every tool takes the registry
 * name as its `bucket` argument; `list_buckets` serves these descriptions as the store
 * directory. Registry names are tool-facing labels, decoupled from the underlying R2 bucket
 * names (which auto-provisioning chooses for you).
 */
export const buckets: BucketToolkit<Env> = defineBuckets<Env>(
  {
    storage: { get: (env) => env.BUCKET, description: "Default project store." },
  },
  "storage",
);
