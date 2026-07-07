// The package is workers-types-only (a Worker, not a Node app), so node builtins and vite's `?raw`
// imports aren't typed. Minimal ambient shims for the slice the metadata integration test uses —
// cheaper and conflict-free vs. pulling in @types/node (overlapping globals + a supply-chain dep).
// node:sqlite ships in Node ≥ 22.5. These live in a script-context .d.ts (no import/export) so the
// `declare module` blocks are ambient declarations, not augmentations of a non-existent module.
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
