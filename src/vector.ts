import type { Embedder, VectorRecord, VectorStore } from "@lemurkit/core";

/**
 * The production adapters wiring the framework-agnostic semantic seams ({@link Embedder},
 * {@link VectorStore} in `@lemurkit/core`) onto the live Worker bindings: Workers AI for embeddings
 * and Vectorize for the ANN index. Kept thin and here (not in core) so core stays testable offline
 * with fakes — Workers AI and Vectorize have no local emulation, so these only run against the real
 * services (`wrangler dev --remote` or a deploy). `Ai` / `Vectorize` are globals from
 * `@cloudflare/workers-types`.
 */

/**
 * The embedding model: `@cf/qwen/qwen3-embedding-0.6b` — multilingual, 1024-dim, 8192-token window.
 * The Vectorize index must be created with dimension 1024 + the cosine metric to match.
 */
export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

/** Embeds text via Workers AI. The model returns `{ data: number[][] }` — one vector per input. */
export class WorkersAiEmbedder implements Embedder {
  constructor(private ai: Ai) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out = await this.ai.run(EMBEDDING_MODEL, { text: texts });
    if (!out.data) throw new Error("Workers AI returned no embedding data");
    return out.data;
  }
}

/** Reads/writes the Vectorize index. Stores only `{id, values, namespace=bucket}`; D1 holds the map. */
export class VectorizeStore implements VectorStore {
  constructor(private index: Vectorize) {}

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.index.upsert(
      records.map((r) => ({ id: r.id, values: r.values, namespace: r.namespace })),
    );
  }

  async query(
    values: number[],
    opts: { topK: number; namespace?: string },
  ): Promise<{ id: string; score: number }[]> {
    const res = await this.index.query(values, {
      topK: opts.topK,
      namespace: opts.namespace,
      returnValues: false,
      // V2 Vectorize indexes want the string enum here, not a boolean — passing `false` is rejected
      // by the query API ("returnMetadata: expected value"). We map id→object via D1, so we never
      // need Vectorize-side metadata: ask for none. (returnValues stays a boolean — that one's right.)
      returnMetadata: "none",
    });
    return res.matches.map((m) => ({ id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.index.deleteByIds(ids);
  }
}
