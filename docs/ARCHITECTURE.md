# Architecture

Keel separates ownership, presentation, storage, retrieval, verification, and execution. This prevents one contract or frontend from becoming the permanent authority over every concern.

## End-to-end flow

```text
ERC-721 / existing collection
          │
          ├── conventional tokenURI image + animation_url
          │
          └── KeelIndex lookup
                    │
                    │ activePresentation(collection, tokenId)
                    ▼
        manifest URI + SHA-256 digest + revision
                    │
                    │ host retrieves, parses, RFC 8785 canonicalizes
                    ▼
             verified manifest@2
                    │
                    ├── on-chain object source
                    ├── contract-call source
                    ├── IPFS/IPNS source
                    ├── Arweave source
                    ├── HTTPS/relative URI source
                    ├── inline source
                    └── composite source
                              │
                              │ retrieve → decompress → hash decoded bytes
                              ▼
                     verified resource graph
                              │
                              ▼
                   virtual content gateway
          oca://  /content/  /ipfs/  /onchain/
                              │
                              ▼
                unique-origin deterministic iframe
```

## Trust domains

### Ownership plane

ERC-721 establishes token ownership. Existing collections can remain unchanged. `KEEL721` is available for new collections and retains conventional metadata compatibility.

### Presentation plane

`KeelIndex` records collection-level and token-level presentation revisions. A revision commits to a manifest URI and digest and declares compatibility, parent, policy, activation time, and freeze state.

Important rules:

- Pending revisions activate under the currently active policy.
- A candidate cannot grant itself activation authority.
- Collection defaults and token overrides are separate.
- A token freeze snapshots the effective active presentation.
- `presentationMatches` provides an explicit contract check for digest and revision.

The optional Keel layer adds logical object revisions, ordered viewer
revisions, token viewer forks, committed fidelity locators, exact
viewer-revision seed roots, and escrowed equipment. `keel.runtime@1` binds
those registries to manifest resources; the KeelIndex digest remains the
outer execution boundary.

### Storage plane

`KeelHold` stores content chunks and ordered child indexes in immutable bytecode. Leaf objects reference chunks. Composite objects reference other objects. Each node has at most 128 children, so builders create balanced trees rather than giant transactions.

On-chain storage is one source type, not a special execution path. The viewer still verifies the final decoded digest.

### Retrieval plane

The trusted host—not creator code—retrieves declared resources. It can use:

- an Ethereum RPC client;
- an IPFS/IPNS gateway;
- Arweave;
- HTTPS;
- local release files;
- a contract-call adapter;
- custom decompression and digest adapters.

Location filtering, no-redirect fetching, private-network denial, source allowlists, and an optional `authorizeRemoteSource` hook protect the host from arbitrary outbound retrieval.

### Verification plane

The manifest is canonicalized with RFC 8785 and checked against its committed SHA-256 digest. Each source is checked after decompression against its own decoded-byte digest. A resource enters the resolved graph only after successful verification.

Audit entries record:

- source kind and index;
- accepted location;
- loaded/rejected/failed status;
- elapsed time;
- decoded byte length;
- integrity success;
- failure reason.

### Execution plane

The viewer exposes only the completed verified graph. Static references are rewritten to data URLs. Dynamic references resolve through an embedded content gateway. The iframe has an opaque unique origin and receives no wallet/provider.

The runtime declares either live browser state or deterministic replay inputs. Hash-verified viewer mirrors let a future client obtain the intended viewer bundle from multiple locations without trusting one domain.

### Distribution plane

`KeelMintGate` handles public and gated campaigns independently from
presentation and storage. `OneMintController` handles ordered stages that share
one drop allocation. Both use the KEEL721 target-side capacity ledger so one
manager cannot consume another manager's reserved supply.

## Why the manifest is the boundary

A token does not need to know whether an artifact is a PNG, movie, game, 3D scene, synthesizer, or application. It commits to a manifest. The manifest describes the resources and runtime needed to reproduce the artifact.

That gives the protocol a stable abstraction:

```text
ownership token → presentation commitment → content graph → browser runtime
```

New media types can be added as resource roles or runtime conventions without modifying ERC-721.

## Registry-trusted versus digest-trusted

`runtime.content.manifestTrust` is explicit:

- `digest`: the caller supplies a trusted expected manifest digest. Suitable for local development, direct token metadata, or another commitment system.
- `registry`: the viewer must obtain and verify an `KeelIndex` presentation before resources resolve or a gateway is created.

A manifest that declares registry trust cannot silently fall back to direct unanchored resolution.

## Deployment patterns

### Web

Use a dedicated viewer origin. Fetch and verify resources in trusted application code. Serve or embed only verified bytes. Add server-side outbound DNS/IP and egress controls. Do not trust messages posted by artifact iframes without strict origin/source/schema validation.

### Electron

Use a dedicated session/partition for the viewer WebContents. Resolve resources in the main process or another trusted session. Install `installElectronViewerEgressGuard()` on the viewer session before loading creator content.

### Static/offline

Bundle a verified viewer, manifest, and resources. The same content gateway works without a public network because sources may be inline, local-relative, or pre-resolved.

## Compatibility path

Conventional consumers see ordinary metadata. Keel-aware consumers gain the verified artifact. Existing collections can adopt the registry without token migration, while new `KEEL721` collections can emit Keel fields directly.
