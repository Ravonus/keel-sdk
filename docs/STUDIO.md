# Keel Studio

Keel Studio is the reference T3 application for creating, publishing, indexing, verifying, and collecting browser-native artifacts. It demonstrates how a product can use the reusable Keel packages without making its own database or webserver part of the trust model.

## Stack

- Next.js App Router and React.
- Strict TypeScript with `noUncheckedIndexedAccess` and exact optional property handling inherited from the workspace configuration.
- tRPC for end-to-end typed application reads and mutations.
- Drizzle ORM and PostgreSQL.
- Tailwind CSS.
- Zustand for creator workflow state.
- viem for wallet calls, read-only RPC, deployment, publication, and event decoding.
- Sharp for optional custom WebP marketplace posters while retaining the complete HTML system and exact original bytes.

## Product flow

```text
creator file or URL
       ↓
input validation and safe path normalization
       ↓
exact HTML-system resources + optional custom poster
       ↓
compression candidates and exact decompression check
       ↓
content-addressed decoded/stored blobs
       ↓
canonical manifest + resource hashes
       ↓
balanced recursive KeelHold plans
       ↓
creator preview through the verified sandbox
       ↓
wallet uploads objects and publishes registry revision
       ↓
reorg-aware indexer discovers history
       ↓
collector resolves live registry commitment and re-verifies bytes
```

## Creator ingestion

The creator wizard accepts files, folders, and one remote source. Folder paths are preserved so HTML projects keep their relative resource graph.

Studio uses the SDK's presentation vocabulary exactly: **Inline** is a
self-contained onchain `data:text/html` `animation_url`; **Hybrid** resolves
native KEEL objects through a declared RPC reader and can still be fully
onchain; **IPFS** is an explicit external delivery choice. Onchain modules are
shown as existing dependencies and are not counted as new creator upload
bytes. See [`KEEL_PRESENTATION.md`](./KEEL_PRESENTATION.md).

Every resource has two independently committed forms:

- **decoded bytes** are the bytes the browser ultimately receives;
- **stored bytes** are the bytes transported or stored after optional compression.

Studio evaluates supported compression methods and only selects one after decompression reproduces the decoded commitment exactly. Originals are retained as downloadable resources. Custom image posters are separate resources and never replace the HTML entrypoint. When no custom poster exists, KEEL721 supplies a manifest-bound on-chain SVG for the standard ERC-721 `image` field. The full HTML system remains the `animation_url`.

With verified-mirror delivery, Studio publishes the deterministic directory containing `manifest.json`, the HTML entrypoint, every dependent resource, and any custom poster. It re-reads every file through the configured IPFS gateway and accepts the CID only after every digest and byte length matches. The resulting IPFS animation URI is a delivery mirror of the complete HTML system; canonical recursive bytes remain on-chain.

### Remote imports

Remote imports are fetched by the trusted Studio host. The importer rejects credentials, redirects, unsupported schemes, private/special IPs, oversized responses, invalid DNS results, and unexpected content lengths. The resulting bytes are stored and hashed before the remote URI is added as an alternate verified source.

For production, put outbound retrieval behind a dedicated egress proxy or firewall that performs DNS resolution and connection pinning. Application-level DNS checks alone are not a complete defense against rebinding in every runtime.

## Storage planning

Each resource and the manifest receive their own `RecursiveUploadPlan`. Plans use byte-bounded leaf chunks and a balanced tree with no more than 128 children per object. The client can resume publication because local object IDs, chunk indexes, transaction hashes, resulting object IDs, and errors are persisted.

The deployment UI never treats a submitted transaction as sufficient. Completion records require the resulting `KeelHold` root object IDs and the manifest is rewritten to point at verified on-chain sources before registry publication.

## Collector resolution

There are two collector paths:

- `/artifacts/[artifactId]` resolves a locally managed Studio artifact;
- `/collect/[chainId]/[collection]/[tokenId]` resolves any artifact found in an enabled registry.

The generic path:

1. loads enabled registry contracts for the configured chain;
2. calls `activePresentation(collection, tokenId)`;
3. calls `presentationMatches` with the returned digest and revision;
4. passes an `KeelIndexAnchor` to `resolveArtifactFromRegistry`;
5. verifies the canonical manifest digest;
6. retrieves resources through approved host adapters;
7. verifies stored and decoded byte commitments;
8. mounts the result in the unique-origin sandbox.

The database index is used only for history and discovery. The live contract and content commitments remain authoritative.

## Verified same-origin gateways

Studio exposes narrowly scoped gateways so browser artifacts do not need direct RPC or internet access:

| Route | Purpose |
| --- | --- |
| `/api/content/[artifactId]/...` | Locally stored, hash-committed decoded resources and manifests. |
| `/api/onchain/[chainId]/[store]/[objectId]` | Recursive reads from an enabled `KeelHold`. |
| `/api/contract-call/[chainId]/[to]` | Read-only `eth_call` against an explicitly enabled content contract. |
| `/api/presentation/[chainId]/[registry]/[collection]/[tokenId]` | Live, confirmed KeelIndex commitment. |
| `/api/keel/read/[chainId]/[address]` | Explicitly allowlisted view calls on enabled typed Keel registries. |
| `/api/keel-demo/manifest` | Local mirror for the seeded contract-union demo; its registry digest remains authoritative. |

The `onchain`, `contract-call`, and `presentation` gateways reject contracts that are not present and enabled in `chain_contracts`. Creator code only receives verified virtual resources; it never receives those transport endpoints as unrestricted network capability.

## Database model

The checked-in Drizzle schema and migration define 18 tables:

- creators and artifacts;
- content-addressed blobs;
- resources and immutable revision snapshots;
- recursive upload plans and upload jobs;
- chains and approved contracts;
- indexer cursors, canonical blocks, and raw events;
- indexed collections, objects, presentations, campaigns, and mints;
- persisted verification runs.

The blob table deduplicates exact bytes. Artifact rows contain convenient active-state projections, while revision rows preserve immutable historical manifests.

## Indexer and reorg handling

The indexer processes only enabled contracts and stores block hashes alongside each cursor. Before extending a chain, it compares the stored canonical hash to the RPC block. A mismatch triggers deletion of orphaned blocks and cascading derived events, followed by replay.

Campaign totals are derived from canonical indexed mint events rather than trusted denormalized counters. Active presentation projections are rebuilt after a rewind.

The indexer decodes the Keel and Keel protocol ABIs by registered contract
kind. Raw Keel events are canonical/reorg-safe even where no denormalized
projection is needed. Event projection also checks contract kind, so the
ObjectRegistry and KeelHold `ObjectWelded` names cannot collide.

## Write security

All mutating REST routes and tRPC procedures share one write-access guard:

- same-origin validation when the request carries an `Origin` header;
- unrestricted local development/test writes;
- disabled production writes unless `STUDIO_WRITE_TOKEN` is configured;
- constant-time comparison of the `x-keel-studio-write-token` value.

This protects the reference/demo deployment from becoming an open upload or index-control endpoint. It is not a replacement for user authentication. A multi-user service should add normal sessions, project ownership, role checks, rate limits, quotas, malware/content policy, and audit logging.

## Local environment

```bash
corepack enable
pnpm install --no-frozen-lockfile
cp .env.example .env
pnpm local:setup
pnpm studio
```

Run an index pass in another terminal:

```bash
pnpm studio:index
```

After installing the Playwright browser, run the creator/collector smoke suite:

```bash
pnpm exec playwright install chromium
pnpm studio:test:e2e
```

The local deployment script deploys `KeelHold`, `KeelIndex`, both mint
controllers, the capacity-aware `KeelFactory`/`KEEL721`, and the Keel Object,
Viewer, Link, Seed, and Equipment registries. It grants both reviewed managers
`MINTER_ROLE`, mints token 1, resets stale local-chain projections, and writes
all deployed contracts into the system allowlist.

Seed and verify the contract-union browser demo separately:

```bash
pnpm --filter @keel/studio contracts:verify-local
pnpm --filter @keel/studio contracts:seed-keel
pnpm --filter @keel/studio contracts:verify-keel-demo
pnpm --filter @keel/studio contracts:seed-historical-keel
PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @keel/studio test:e2e:keel
```

## Production checklist

- Use managed PostgreSQL with backups and least-privilege credentials.
- Put blob storage in durable object storage instead of the local filesystem.
- Replace the demo write token with application authentication and authorization.
- Run remote fetches through a pinned egress service.
- Run the viewer on a dedicated origin or an Electron partition with the egress guard.
- Add durable background jobs for upload and indexing retries.
- Use multiple RPC endpoints and monitor finality/reorg depth.
- Transfer all on-chain roles to intended multisigs or timelocks.
- Run exact compilation, Foundry, fuzz/invariant, static analysis, and an independent audit.
