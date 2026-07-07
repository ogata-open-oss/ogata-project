// The package is workers-types-only (a Worker, not a Node app), so node builtins and vite's `?raw`
// imports aren't typed. Minimal ambient shims for the slices the tests use — cheaper and
// conflict-free vs. pulling in @types/node (overlapping globals + a supply-chain dep). Same
// pattern as packages/core/test/shims.d.ts. node:sqlite ships in Node ≥ 22.5.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): unknown;
    };
  }
}
declare module "*?raw" {
  const content: string;
  export default content;
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean; isFile(): boolean }[];
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
// workers-types doesn't declare import.meta.url (a Worker bundle has no file URLs); the tests
// run under Node where it exists.
interface ImportMeta {
  url: string;
}
