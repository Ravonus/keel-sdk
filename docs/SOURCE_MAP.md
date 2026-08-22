# Legacy-to-Modern Source Map

## `Keel-demo`

| Original concept | Modern location |
| --- | --- |
| Viewer type, multi-seed, mutability, head and seed IDs | `KeelHarnessRegistry`, `KeelSeedRegistry`, and the versioned `keel.runtime@1` manifest extension. |
| Five uint48 IDs packed per uint256 | `@keel/protocol/packing`; retained only as an explicit compatibility utility. |
| Standard/layer/hybrid objects | `KeelArtifactRegistry`, `KeelLinkRegistry`, inline/URI/on-chain sources, and recursive `KeelHold` objects. |
| Preview/high-resolution links | Typed immutable fidelity records; Hybrid is accepted only when it reproduces the exact on-chain decoded bytes. |
| Parent/history/accepted upgrade ranges | Linear Object/Viewer revisions, token viewer forks, and `KeelIndex` activation/compatibility. |
| Brotli/Base85 pipeline | Builder compression with byte-accurate chunks plus Z85 corpus support and wrapper-aware historical decoding. |

## `oca_whitepaper`

| Original concept | Modern location |
| --- | --- |
| Browser as renderer | `@keel/viewer`. |
| On-chain installer/multiple calls | `KeelHold` leaf/composite upload model. |
| Scripts, shaders, sounds, sprites, libraries | Typed resource roles. |
| Reusable compressed components | Content-addressed chunks/objects and composite resources. |
| Transparent storage provenance | Resolution audit and source descriptors. |

## `oca_snake`

| Original concept | Modern location |
| --- | --- |
| Interactive HTML/JS in `animation_url` | Keel entrypoint plus stable viewer URL. |
| On-chain + IPFS hybrid | Ordered source fallbacks, with the chain read first. `@keel/protocol`'s RPC module is the default transport; a gateway is opt-in per `gatewayTransport`. See `docs/KEEL_RPC_TRANSPORT.md`. |
| Generated SVG fallback | Conventional fallback resource/`image`. |
| Game/audio runtime | Sandboxed capability-aware viewer. |
| QTER staking/economics | Intentionally outside core; requires separate redesign. |

## `Mafia`

| Original concept | Modern location |
| --- | --- |
| `OneMint` drop modes | `OneMintController` ordered shared-allocation stages alongside `KeelMintGate` campaigns. |
| Bring creator signer / service signer | Creator, platform, or either signature policy. |
| Bitmap/component traits | Manifest data resources; project-specific renderer. |
| SVG assembly | Chunked resources/composites, not token bytecode monolith. |
| Custom ERC-721 variants | OpenZeppelin `KEEL721`. |
| Rule-set plugins | Custom access gate and mint adapter interfaces; gameplay remains separate. |
| Familiar/staking transfer coupling | Removed from ERC-721 transfer path. |

## `AboutOCA`

The repository is preserved as historical presentation/branding input. Product copy and frontend design are not treated as protocol authority; the whitepaper and executable prototypes carry the technical intent.

## 0.3.0 product layer

| Original need | Modern implementation |
| --- | --- |
| Creator uploads and compression experiments | `apps/studio/src/server/services/creator-service.ts`, `asset-preparation.ts`, and `@keel/studio-core` |
| Multi-call installer | persisted `resource_upload_plans`, `upload-wizard.tsx`, and `onchain-panel.tsx` |
| Viewer audit screen | `ArtifactViewer`, artifact detail resource graph, and persisted verification runs |
| Existing-collection discovery | `/collect/[chainId]/[collection]/[tokenId]` and `collector-service.ts` |
| Contract/system manager | `/system`, explicit `chain_contracts` allowlist, and deployment service |
| Platform mint manager | `/launch`, `@keel/sdk`, `KeelMintGate`, and indexed campaigns/mints |
| Fast browsing without trusting a centralized API | reorg-aware indexer for discovery plus live registry/content verification for rendering |
| Token-owned objects, viewer forks, fidelity links, seeds, and equipment | additive Keel registries plus `keel.runtime@1` browser binding |
