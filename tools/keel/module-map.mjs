/**
 * Authoritative Keel module map.
 *
 * A module is an independently releasable on-chain system: its own contracts,
 * its own test suite, its own per-chain deployment record, and its own entry in
 * the SDK's module registry. Modules form a DAG — `deps` lists the modules a
 * module is allowed to import from. The boundary checker (`keel check`) fails on
 * any import that crosses a boundary not declared here.
 *
 * Assignment rule: a shared file lives in the module of its sole consumer; when
 * consumers span modules it moves down into the lowest module they all depend on.
 *
 * `kind` separates reusable protocol infrastructure ("module") from the concrete
 * products built on it ("app"). Apps consume modules exactly as an outside
 * integrator would; a module may never depend on an app, and the checker enforces
 * that. Only modules ship as their own repositories.
 *
 * `group` labels the module's role. Each module still ships as its own repository;
 * the group is the topic those repositories are tagged and browsed by:
 *   core        the object/storage/graph substrate everything else builds on
 *   render      turning stored bytes into something a browser can load
 *   token       collections, minting, and creator identity
 *   assets      things a token owns or is composed from
 *   provenance  proving where content came from and who may use it
 *   market      trading
 *   apps        concrete products built on the stack
 */
export const MODULES = [
  {
    id: "keel-kernel",
    kind: "module",
    group: "core",
    title: "Kernel",
    summary: "Admin/access primitives and encoding helpers every other module is allowed to import.",
    deps: [],
    devDeps: [],
    contracts: ["SafeAdminAccessControl.sol", "libraries/JsonEscape.sol", "libraries/KeelCodeIdentity.sol", "libraries/KeelCollectionFreezeValidation.sol"],
  },
  {
    id: "keel-codecs",
    kind: "module",
    group: "core",
    title: "Codecs",
    summary: "Pure, stateless decoders: RLP, Merkle-Patricia, block headers, IPFS CIDs, base32/58, BLS12-381.",
    deps: [],
    devDeps: [],
    contracts: ["libraries/KeelRlp.sol", "libraries/KeelBlockHeader.sol", "libraries/KeelMerklePatricia.sol", "libraries/KeelEthAccount.sol", "libraries/KeelOpOutputRoot.sol", "libraries/KeelIpfsCid.sol", "libraries/KeelDagPb.sol", "libraries/KeelBase32.sol", "libraries/KeelBase58.sol", "libraries/Bls12381.sol"],
  },
  {
    id: "keel-hold",
    kind: "module",
    group: "core",
    title: "Storage",
    summary: "Immutable content-addressed chunk storage and the artifact registry that activates revisions.",
    deps: [],
    devDeps: ["keel-harness", "keel-die"],
    contracts: ["KeelHold.sol", "Ingot.sol", "KeelIndex.sol", "interfaces/IKeelHold.sol", "interfaces/IKeelIndex.sol"],
  },
  {
    id: "keel-artifacts",
    kind: "module",
    group: "core",
    title: "Object model",
    summary: "The Keel object graph: objects, viewers, links, seeds, and the manager that fronts them.",
    deps: ["keel-hold"],
    devDeps: [],
    contracts: ["KeelArtifactRegistry.sol", "KeelManager.sol", "KeelManagerProxy.sol", "KeelHarnessRegistry.sol", "KeelLinkRegistry.sol", "KeelSeedRegistry.sol", "interfaces/IKeelArtifactRegistry.sol", "interfaces/IKeelManager.sol", "interfaces/IKeelArtifactRevisionPolicy.sol", "interfaces/IKeelHarnessRegistry.sol"],
  },
  {
    id: "keel-graph",
    kind: "module",
    group: "core",
    title: "Graph trust lattice",
    summary: "Graph/plugin/library/module registries — the on-chain trust lattice the runtime re-derives against.",
    deps: [],
    devDeps: ["keel-market"],
    contracts: ["KeelGraphRegistry.sol", "KeelPluginRegistry.sol", "KeelModuleReviewRegistry.sol", "KeelLibraryRegistry.sol", "KeelAssetTagRegistry.sol", "interfaces/IKeelGraphRegistry.sol", "interfaces/IKeelContractPlugin.sol"],
  },
  {
    id: "keel-harness",
    kind: "module",
    group: "render",
    title: "On-chain HTML builder",
    summary: "Assembles viewer HTML from chunk-stored resources entirely on chain.",
    deps: ["keel-hold"],
    devDeps: [],
    contracts: ["KeelHarnessBuilder.sol", "interfaces/IKeelHarnessBuilder.sol", "libraries/KeelHarnessContextDispatch.sol", "libraries/KeelPreEncodedTokenURI.sol", "libraries/KeelPreparedTokenURI.sol"],
  },
  {
    id: "keel-presentation",
    kind: "module",
    group: "core",
    title: "Presentation state",
    summary: "Presentation/visual state ledgers that record what a token currently renders as.",
    deps: [],
    devDeps: ["keel-artifacts", "keel-hold"],
    contracts: ["KeelPresentationStateRegistry.sol", "KeelVisualStateLedger.sol", "interfaces/IKeelPresentationRegistry.sol"],
  },
  {
    id: "keel-die",
    kind: "module",
    group: "token",
    title: "Token base",
    summary: "Compact creator-owned ERC-721/ERC-1155 collections, a shared multi-creator ERC-1155, renderer boundaries, and factories that organize them.",
    deps: ["keel-kernel", "keel-harness", "keel-presentation", "keel-artifacts"],
    devDeps: ["keel-hold"],
    contracts: ["KEEL721.sol", "KEEL721Deployer.sol", "KeelFactory.sol", "KeelFactorySepolia.sol", "KeelCreator721.sol", "KeelCreator1155.sol", "KeelShared1155.sol", "KeelCreatorFactory.sol", "KeelArtifactTokenRenderer.sol", "interfaces/IKeelMintable.sol", "interfaces/IKeelMintCapacity.sol", "interfaces/IKeelCampaignAuthorizer.sol", "interfaces/IKeelItemMintTarget.sol", "interfaces/IKeelTokenRenderer.sol", "interfaces/IKeelCreatorDirectory.sol"],
  },
  {
    id: "keel-creator-identity",
    kind: "module",
    group: "token",
    title: "Creator identity",
    summary: "Creator profiles, commitments, and attribution records.",
    deps: ["keel-artifacts"],
    devDeps: ["keel-hold"],
    contracts: ["KeelCreatorProfileRegistry.sol", "KeelCreatorCommitmentRegistry.sol", "KeelAttributionRegistry.sol", "interfaces/IKeelCreatorProfileRegistry.sol"],
  },
  {
    id: "keel-mint-access",
    kind: "module",
    group: "token",
    title: "Mint access",
    summary: "Campaign-based mint authorization for ERC-721 collections and exact ERC-1155 items, with ordered shared-allocation stages.",
    deps: ["keel-die", "keel-creator-identity"],
    devDeps: [],
    contracts: ["KeelMintGate.sol", "OneMintController.sol", "OpenOneMintController.sol", "interfaces/IKeelAccessGate.sol", "interfaces/IKeelMintAdapter.sol"],
  },
  {
    id: "keel-equipment",
    kind: "module",
    group: "assets",
    title: "Equipment",
    summary: "Token-owned equipment: inventory custody, distribution lanes, reservations, and one-use duplication.",
    deps: ["keel-kernel", "keel-artifacts", "keel-hold"],
    devDeps: ["keel-die", "vault-runner"],
    contracts: ["KeelEquipmentInventory.sol", "KeelEquipmentDistributor.sol", "KeelEquipmentReservationEngine.sol", "KeelEquipmentDescriptorValidator.sol", "KeelEquipmentInventoryReader.sol", "KeelOneUseDuplicator.sol", "interfaces/IKeelERC1155EquipmentDescriptor.sol", "interfaces/IKeelReservableMint1155.sol", "libraries/KeelMintBoundEquipmentProvision.sol"],
  },
  {
    id: "keel-market",
    kind: "module",
    group: "market",
    title: "Market",
    summary: "The Keel marketplace plugin contract.",
    deps: ["keel-graph"],
    devDeps: [],
    contracts: ["KeelMarket.sol"],
  },
  {
    id: "keel-anchors",
    kind: "module",
    group: "provenance",
    title: "Anchors",
    summary: "Cross-chain and off-chain anchoring: attested/portable anchors, L2 state proofs, zk backends, oracle verifiers.",
    deps: ["keel-kernel", "keel-codecs", "keel-artifacts", "keel-graph"],
    devDeps: ["keel-crucible", "keel-hold"],
    contracts: ["KeelAttestedAnchorRegistry.sol", "KeelPortableAnchorRegistry.sol", "KeelAnchorReplicationBridge.sol", "KeelL2AnchorVerifier.sol", "KeelL2StateVerifier.sol", "KeelSettlementRegistry.sol", "KeelZkAnchorVerifier.sol", "KeelZkVerifyProofBackend.sol", "KeelZkVerifyProofVerifier.sol", "KeelSp1GatewayProofBackend.sol", "KeelSp1GatewayProofVerifier.sol", "KeelIpfsCidVerifier.sol", "KeelChainlinkFunctionsVerifier.sol", "KeelCreReportVerifier.sol", "KeelLocalFunctionsRouter.sol", "KeelNodeRegistry.sol", "interfaces/IKeelAnchorProofBackend.sol", "interfaces/IKeelAnchorProofVerifier.sol", "interfaces/IKeelAnchoredChainQueries.sol", "interfaces/IKeelSettlementSource.sol"],
  },
  {
    id: "keel-crucible",
    kind: "module",
    group: "provenance",
    title: "Collection verification",
    summary: "Third-party collection attestation, URI/pixel fingerprints, community replication, and preservation bounties.",
    deps: ["keel-kernel", "keel-hold", "keel-artifacts"],
    devDeps: [],
    contracts: ["KeelCollectionVerificationRegistry.sol", "KeelCollectionVerificationHookBase.sol", "KeelCollectionAttestationRegistry.sol", "KeelUriAttestationRegistry.sol", "KeelPixelFingerprintRegistry.sol", "KeelCommunityReplicationRegistry.sol", "interfaces/IKeelCollectionVerificationHook.sol", "interfaces/IKeelCollectionVerificationAdapter.sol", "interfaces/ICommunityHold.sol"],
  },
  {
    id: "keel-ip-control",
    kind: "module",
    group: "provenance",
    title: "IP control",
    summary: "On-chain IP rights control, wrapped-721 custody, and the executor that acts on granted rights.",
    deps: ["keel-hold", "keel-artifacts"],
    devDeps: [],
    contracts: ["KeelIPControl.sol", "KeelIPActionExecutor.sol", "KeelIPWrapped721.sol", "interfaces/IKeelIPControl.sol", "interfaces/IKeelIPMintTarget.sol"],
  },
  {
    id: "keel-sleeve",
    kind: "module",
    group: "core",
    title: "Metadata resolver",
    summary: "Token JSON resolution for collections that delegate metadata assembly.",
    deps: [],
    devDeps: [],
    contracts: ["KeelSleeve.sol", "interfaces/IKeelTokenJSONResolver.sol"],
  },
  {
    id: "keel-web3-url",
    kind: "module",
    group: "render",
    title: "web3:// adapter",
    summary: "ERC-5219/7617 resource adapter exposing Keel content over web3:// URLs, plus its demos.",
    deps: ["keel-hold"],
    devDeps: [],
    contracts: ["KeelWeb3ResourceAdapter.sol", "interfaces/IDecentralizedApp.sol", "interfaces/IERC7572.sol"],
  },
  {
    id: "keel-cross-chain-mint",
    kind: "module",
    group: "token",
    title: "Cross-chain mint",
    summary: "Bridged mint intents and the batcher that carries them between chains.",
    deps: ["keel-kernel", "keel-die"],
    devDeps: ["keel-anchors", "keel-artifacts", "keel-hold"],
    contracts: ["KeelCrossChainMintBridge.sol", "KeelCarrierBatcher.sol", "KeelHistoryPublicationJob.sol", "KeelPublicationJob.sol"],
  },
  {
    id: "keel-stake",
    kind: "module",
    group: "assets",
    title: "Stake objects",
    summary: "Stake-object custody and the seasonal grove state that consumes it.",
    deps: ["keel-artifacts"],
    devDeps: [],
    contracts: ["KeelStakeObjectManager.sol"],
  },
  {
    id: "keel-canvas",
    external: true, // sources live in their own repository since the 2026-08-22 split
    kind: "app",
    group: "apps",
    title: "Canvas",
    summary: "Shared canvas renderer/splitter/composer surface that both CoolS and LINE collections render through.",
    deps: ["keel-kernel", "keel-die", "keel-artifacts"],
    devDeps: ["line"],
    contracts: ["CoolSCanvas721.sol", "CoolSCanvasRenderer.sol", "CoolSCanvasSplitter.sol", "CoolSCanvasMintController.sol", "CoolSComposer.sol", "interfaces/ICoolSCanvasRenderer.sol", "interfaces/ICoolSCanvasSplitter.sol", "interfaces/ICoolSCanvasView.sol", "interfaces/ILINE721.sol", "interfaces/ILINEThumbnailSource.sol", "libraries/CoolSCanvasStorage.sol"],
  },
  {
    id: "cool-s",
    external: true, // sources live in their own repository since the 2026-08-22 split
    kind: "app",
    group: "apps",
    title: "CoolS",
    summary: "The CoolS collection: generative mint hook, metadata renderer, release resolver, novelty ledger, visual registry.",
    deps: ["keel-kernel", "keel-die", "keel-equipment", "keel-presentation"],
    devDeps: ["keel-creator-identity", "keel-harness", "keel-mint-access", "keel-artifacts", "keel-hold"],
    contracts: ["CoolS721.sol", "CoolSMetadataRendererV1.sol", "CoolSNoveltyLedgerV1.sol", "CoolSReleaseResolverV1.sol", "CoolSTargetTableV1.sol", "CoolSVisualRegistryV1.sol", "CoolSLocalVRFCoordinator.sol", "KeelGenerativeMintHookBase.sol", "interfaces/ICoolSReleaseResolverV1.sol", "libraries/CoolSVisualStateCodecV1.sol"],
  },
  {
    id: "line",
    external: true, // sources live in their own repository since the 2026-08-22 split
    kind: "app",
    group: "apps",
    title: "LINE",
    summary: "The LINE collection and its on-chain thumbnail renderer.",
    deps: ["keel-die", "keel-canvas", "keel-artifacts"],
    devDeps: [],
    contracts: ["LINE721.sol", "LINEThumbnail.sol", "LINEThumbnailRenderer.sol"],
  },
  {
    id: "vault-runner",
    external: true, // sources live in their own repository since the 2026-08-22 split
    kind: "app",
    group: "apps",
    title: "Vault Runner",
    summary: "The Vault Runner game system: characters, packs, items, arcade/achievement registries, run settlement, map auctions.",
    deps: ["keel-kernel", "keel-die", "keel-artifacts", "keel-hold", "keel-equipment", "keel-crucible", "keel-harness"],
    devDeps: [],
    contracts: ["VaultCharacter721.sol", "VaultCharacterMetadataRenderer.sol", "VaultCharacterRegistry.sol", "VaultCharacterPackV2.sol", "VaultCharacterStarterPack.sol", "VaultItem1155.sol", "VaultGameCard.sol", "VaultArcadeRegistry.sol", "VaultAchievementRegistry.sol", "VaultMapAuction.sol", "VaultRunLeaderboard.sol", "VaultRunLootExtraction.sol", "VaultRunSignatureAuthority.sol", "VaultSpriteAssetRegistry.sol", "interfaces/IVaultRunSource.sol", "interfaces/IVaultHardcoreRunSource.sol", "interfaces/IVaultRunSignatureAuthority.sol"],
  },
];

export const MODULE_BY_ID = new Map(MODULES.map((m) => [m.id, m]));

/** Directory tier a unit lives under: "modules" or "apps". */
export const TIER_OF = new Map(MODULES.map((m) => [m.id, m.kind === "app" ? "apps" : "modules"]));
export const isApp = (id) => TIER_OF.get(id) === "apps";

/** Import prefix a unit is addressed by from elsewhere in the tree. */
export const PREFIX_OF = new Map(MODULES.map((m) => [m.id, m.kind === "app" ? "@app" : "@keel"]));

/** module id that owns a given src-relative path, or undefined. */
export const OWNER_OF = new Map();
for (const m of MODULES) for (const c of m.contracts) OWNER_OF.set(c, m.id);
