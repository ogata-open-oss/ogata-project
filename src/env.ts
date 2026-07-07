import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Worker bindings + configuration for the OSS deployment.
 *
 * `OAUTH_PROVIDER` is injected at runtime by the OAuthProvider library (it is not declared in
 * `wrangler.jsonc`). All GitHub values are **Worker secrets** set via `wrangler secret put`
 * (never committed): the client secret and state-signing key are credentials, and the allowlist
 * (login + id) is held as secrets so the single authorized identity never appears in the repo.
 * `GITHUB_CLIENT_ID` is a secret too — not because OAuth treats it as confidential, but to keep
 * it out of public code (a leaked client id eases consent-screen spoofing + recon). For local
 * `wrangler dev`, secrets come from a gitignored `.dev.vars`.
 */
export interface Env {
  /**
   * The default R2 store. Auto-provisioned on first deploy (the binding carries no bucket name
   * in `wrangler.jsonc`). Add more stores = one binding here + one entry in `buckets.ts`.
   */
  BUCKET: R2Bucket;
  /** KV namespace the OAuth provider uses to store tokens, grants, and registered clients. */
  OAUTH_KV: KVNamespace;
  /**
   * KV namespace backing the shared-memory tools. Separate from `OAUTH_KV` on purpose (never
   * mix app memory with auth tokens).
   */
  MEMORY_KV: KVNamespace;
  /**
   * D1 database holding the object-metadata + full-text indexes — the queryable mirror of R2
   * listings behind `query_files`/`search_files`, kept current write-through by the storage
   * tools. A projection over R2, never the source of truth.
   */
  METADATA_DB: D1Database;
  /**
   * Workers AI binding — the embedding half of the OPTIONAL semantic tier. Absent until you
   * uncomment the `ai` binding in `wrangler.jsonc`; with it absent, `semantic_search` simply
   * doesn't register and write-through skips embedding.
   */
  AI?: Ai;
  /**
   * Vectorize index binding — the ANN half of the OPTIONAL semantic tier. Create the index
   * first (`wrangler vectorize create …`), then uncomment the binding. Both `AI` and
   * `VECTORIZE` must be present for the tier to switch on.
   */
  VECTORIZE?: Vectorize;
  /** Callback API into the OAuth provider (parseAuthRequest / completeAuthorization / …). */
  OAUTH_PROVIDER: OAuthHelpers;
  /** GitHub OAuth app client id (secret — kept out of public code to reduce disclosure). */
  GITHUB_CLIENT_ID: string;
  /** GitHub OAuth app client secret (secret). */
  GITHUB_CLIENT_SECRET: string;
  /** Allowlisted GitHub login — defence-in-depth half of the gate (secret). */
  GITHUB_ALLOWED_USERNAME: string;
  /** Allowlisted GitHub immutable numeric id, as a string — primary half of the gate (secret). */
  GITHUB_ALLOWED_USER_ID: string;
  /** HMAC key used to sign the OAuth `state` carried across the GitHub round-trip (secret). */
  STATE_SIGNING_KEY: string;
}
