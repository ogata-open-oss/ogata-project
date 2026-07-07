-- Migration 0001 — the object-metadata index.
--
-- ONE table on purpose: a bucket is a label that already lives in the connector's compile-time
-- bucket registry (src/buckets.ts), not a data row — so `bucket` is an indexed column here, not a
-- foreign key to a (currently attribute-less) buckets table. Normalize into a `buckets` table when
-- the per-bucket ACL layer lands and buckets gain real queryable attributes — not before.
--
-- A projection over R2, never the source of truth: kept current write-through by the storage tools,
-- and rebuilt from R2 by `index_bucket` to absorb out-of-band writes (e.g. dashboard uploads).
CREATE TABLE objects (
  bucket       TEXT    NOT NULL,        -- bucket name from the registry (the partitioning column)
  key          TEXT    NOT NULL,        -- full R2 object key
  size         INTEGER NOT NULL,        -- bytes
  content_type TEXT,                    -- MIME type, NULL if none was stored
  etag         TEXT    NOT NULL,        -- R2 entity tag
  uploaded     TEXT    NOT NULL,        -- ISO-8601 upload time (sortable as text)
  PRIMARY KEY (bucket, key)             -- also the keyset-pagination order
);

-- Match the common filtered queries: "objects of type X in bucket B" and "objects in B by date".
CREATE INDEX idx_objects_content_type ON objects (bucket, content_type);
CREATE INDEX idx_objects_uploaded ON objects (bucket, uploaded);
