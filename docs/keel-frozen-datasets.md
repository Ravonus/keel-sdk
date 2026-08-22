# Keel frozen datasets

`keel-frozen-dataset@1` turns an unknown or changing API response into a revisioned, immutable data layer. It preserves the complete selected data; the source's page number or cursor is ingestion provenance, not the public query structure.

## What is frozen

Each chunk is canonical JSON containing complete rows. Its SHA-256 digest is both its public content hash and its integrity commitment. The manifest records the ordered hash list, exact row range, byte length, page/cursor spans, discovered JSON Pointer fields, optional immutable mirrors, and conservative per-chunk indexes.

Raw cursors do not need to be published. The builder records cursor digests so an authorized ingestion system can audit lineage without leaking a closed API token or cursor.

The manifest is the revision boundary. A new import creates a new manifest revision. Viewer caches are revision-scoped and activate the new revision before reading; content-addressed HTTP chunk routes may use `public, max-age=31536000, immutable`, while a moving manifest route must use `no-cache` or an explicit revisioned URL.

## Query behavior

Callers query rows with JSON Pointer paths such as `/weather/temperature`; they do not choose pages or chunks. The viewer plans the query from the manifest. It skips a chunk only when a complete value set or min/max range proves the chunk cannot match. Missing, capped, mixed, or unfamiliar indexes fall back to verified scanning, which preserves correctness for arbitrary API shapes.

The shared viewer query supports filters, cross-field text search, stable multi-column sorting, projection, offsets, and limits. Every loaded chunk is SHA-256 verified and checked against its dataset ID, revision, ordinal, row count, and canonical encoding before any row is returned. Results expose loaded and skipped hash lists so the verifier can explain exactly which frozen objects answered a query.

## Publishing flow

1. Feed complete page or cursor batches to `buildKeelFrozenDataset`.
2. Store every returned chunk byte array under its `contentHash` in Keel, another content-addressed carrier, or both.
3. Publish and anchor the returned manifest bytes and digest as the API snapshot's exact source manifest/revision.
4. Give the viewer a hash-to-bytes loader. The viewer handles selection, verification, caching, and table queries.

Large datasets can choose row and byte targets independently. Chunks may span source pages, and one source page may become several chunks. This keeps the data layer tuned for the site without changing the source API or the user's query API.
