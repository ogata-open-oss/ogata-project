/**
 * The OSS-tree variant of `test/oss-under-test.ts` — the exporter ships this file to
 * `test/oss-under-test.ts` in the flattened public repo, where the OSS entry + registry ARE
 * `src/index.ts` / `src/buckets.ts`. (In the private tree these relative imports resolve to
 * `oss/src/*`, so this file typechecks here too.)
 */
export { default as ossEntry } from "../src/index.js";
export { buckets as ossBuckets } from "../src/buckets.js";
