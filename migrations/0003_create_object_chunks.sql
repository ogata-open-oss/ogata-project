-- Migration 0003 — the object-chunk map backing semantic (vector) search.
--
-- A THIRD projection over R2, alongside `objects` (0001, attributes) and `objects_fts` (0002,
-- lexical words): this one answers "which objects are about this MEANING". The vectors themselves
-- live in Cloudflare Vectorize (the ANN index `lemurkit-objects`), NOT in D1 — Vectorize stores
-- `{id, values, namespace=bucket}` and nothing else. This table is the id → object map Vectorize
-- lacks: it turns a vector hit (a `chunk_id` + score) back into a (bucket, key) and the chunk's
-- text for the result snippet.
--
-- Why D1 holds this and not Vectorize metadata: deletes. Vectorize has no "delete where bucket=X
-- and key=Y" — only deleteByIds. So before removing an object's vectors we look its chunk_ids up
-- here (SELECT … WHERE bucket=? AND key=?), then deleteByIds. Keeping the map in D1 also keeps the
-- snippet source legible and lets the same node:sqlite test harness cover the logic offline.
--
-- An object is chunked (long bodies → several rows, `ord` 0,1,2,…); each chunk is one vector. Only
-- text-y objects under the extraction cap are embedded — binaries/oversized aren't in the semantic
-- index at all (find those via search_files/query_files). Like the other two projections this is a
-- projection over R2, kept current write-through and rebuilt from R2 by `index_bucket`.
CREATE TABLE object_chunks (
  chunk_id TEXT    NOT NULL PRIMARY KEY,  -- deterministic hash of (bucket,key,ord); also the Vectorize vector id
  bucket   TEXT    NOT NULL,              -- bucket name from the registry
  key      TEXT    NOT NULL,              -- full R2 object key
  ord      INTEGER NOT NULL,              -- chunk ordinal within the object (0-based)
  text     TEXT    NOT NULL               -- the chunk's text (the snippet source; embedded into the vector)
);

-- The delete/reindex lookup path: "every chunk of this object" and "every chunk of this bucket".
CREATE INDEX idx_object_chunks_bucket_key ON object_chunks (bucket, key);
