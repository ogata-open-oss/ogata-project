import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * One config runs the whole suite (`vitest run` at the repo root covers test/ AND core/test/).
 *
 * - `@lemurkit/core` mirrors the tsconfig paths alias — core is consumed as TS source, not an
 *   npm package.
 * - `@migrations` points the core tests at the D1 migration SQL (imported ?raw so tests run
 *   against the real schema).
 * - `cloudflare:workers` is a workerd-only protocol import (pulled in by
 *   `@cloudflare/workers-oauth-provider`); the alias points it at a one-line stub so the Worker
 *   entry point loads under the plain Node ESM loader — which requires inlining that dep so the
 *   alias can intercept it.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@lemurkit/core": fileURLToPath(new URL("./core/src/index.ts", import.meta.url)),
      "@migrations": fileURLToPath(new URL("./migrations", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
