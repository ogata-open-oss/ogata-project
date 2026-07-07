-- Migration 0002 — the full-text search index over object keys + extracted text content.
--
-- A SECOND projection over R2, alongside the `objects` table from 0001: that one answers
-- "which objects match these attributes" (type/size/date); this one answers "which objects
-- contain these words" — both filename tokens and the extracted text body of text-y objects.
--
-- Standalone FTS5, NOT external-content: the `objects` table stores metadata but no body text,
-- so there is nothing for an external-content FTS table to mirror. This table stores its own
-- searchable `text` (key tokens + extracted content). `bucket` and `key` are UNINDEXED so they
-- are stored for retrieval and usable in WHERE (bucket filter, delete-by-key) without being
-- tokenised into the search index. The `text` column carries `"<key>\n<extracted body>"`, so a
-- search for a filename word and a search for a content word are the same MATCH query.
--
-- Like `objects`, this is a projection kept current write-through (every storage mutation
-- re-indexes or removes the row) and rebuilt from R2 by `index_bucket`. FTS5 has no UPSERT, so
-- the write-through path deletes the (bucket, key) row then re-inserts it.
CREATE VIRTUAL TABLE objects_fts USING fts5(
  bucket UNINDEXED,                       -- bucket name (filter + delete key, not searched)
  key UNINDEXED,                          -- full R2 object key (returned + delete key, not searched)
  text,                                   -- searchable: "<key>\n<extracted text body>"
  tokenize = 'unicode61 remove_diacritics 2'
);
