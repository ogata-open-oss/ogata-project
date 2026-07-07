/**
 * Test-only stand-in for the `cloudflare:workers` runtime module, wired by the vitest alias in
 * vitest.config.ts. `@cloudflare/workers-oauth-provider` imports `WorkerEntrypoint` from it at
 * module scope, which the Node ESM loader can't resolve (the `cloudflare:` protocol exists only
 * in workerd) — the stub lets the entry points load in unit tests; the class is never
 * instantiated there.
 */
export class WorkerEntrypoint {}
