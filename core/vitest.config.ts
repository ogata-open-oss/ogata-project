import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The OSS-tree variant of `packages/core/vitest.config.ts` — the exporter ships this file to
 * `core/vitest.config.ts` in the flattened public repo, where the D1 migrations sit at
 * `../migrations` (repo root) instead of the private workspace's `../mcp-server/migrations`.
 * Same `@migrations` alias, so the test SOURCE files are byte-identical in both trees.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@migrations": fileURLToPath(new URL("../migrations", import.meta.url)),
    },
  },
});
