import type {
  ArtifactManifest,
  KeelIndexAnchor,
  ArtifactResource,
  Compression,
  CustomDigest,
  Hex,
  Integrity,
  ResourceSource,
  RuntimeCapabilities,
  RuntimeViewerMirror,
  RuntimeViewport,
  KeelLibraryReference,
  KeelIPControlAction,
  KeelIPControlExtension,
  KeelIPControlMode,
  KeelStakeObject,
  KeelStakeObjectBackpack,
  KeelStakeObjectChain,
  KeelStakeObjectCounters,
  KeelStakeObjectLockup,
  KeelStakeObjectManagerPolicy,
} from "@keel/protocol";
import type { CollectionVerificationInput } from "./collection-verification.js";

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  input: string,
  init?: { readonly signal?: AbortSignal; readonly redirect?: "follow" | "error" },
) => Promise<FetchResponseLike>;

export interface OnchainObjectRequest {
  readonly chainId: number;
  readonly store: Hex;
  readonly objectId: Hex;
  readonly chunks?: readonly Hex[];
}

export interface WakeObjectRequest {
  readonly chainId: number;
  readonly coordinator: Hex;
  readonly publicationId: bigint;
  /** The expected decoded-byte digest supplied by the manifest or caller. */
  readonly expectedIntegrity: Integrity;
}

export interface VerifiedWakeProvenance {
  readonly protocol: "keel-wake@1";
  readonly storageMode: "history-inscription-v1";
  readonly chainId: number;
  readonly coordinator: Hex;
  readonly publicationId: bigint;
  readonly storedDigest: Hex;
  readonly decodedDigest: Hex;
  readonly storedByteLength: number;
  readonly decodedByteLength: number;
  readonly compression: "none" | "gzip" | "deflate" | "brotli";
  readonly batchCount: number;
  readonly chunkCount: number;
  readonly retrievalSource: "rpc-history" | "archive" | "cache";
  readonly archivalStatus?: "replicated" | "unreplicated" | "unknown";
  readonly verified: true;
}

/** A reader must verify chain evidence and decompression before returning bytes. */
export interface WakeObjectReadResult {
  readonly bytes: Uint8Array;
  readonly provenance: VerifiedWakeProvenance;
}

export interface ContractCallRequest {
  readonly chainId: number;
  readonly to: Hex;
  readonly data: Hex;
}

/** Canonical typed state read performed by a host chain adapter. */
export interface KeelPresentationStateRequest {
  readonly chainId: number;
  readonly registry: Hex;
  readonly policyId: Hex;
  /** The manifest-declared media type whose digest is checked by the host. */
  readonly mediaType?: string;
}

export interface KeelPresentationStateResult {
  readonly policyId: Hex;
  readonly revision: number;
  readonly value: Uint8Array;
  readonly valueDigest: Hex;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly mediaTypeDigest: Hex;
  readonly sourceManifestDigest: Hex;
  readonly sourceSequence: number;
}

/** Typed state returned by a contract-owned Seasonal Grove controller. */
export interface KeelSeasonalGroveStateResult {
  readonly contract: Hex;
  readonly collection: Hex;
  readonly tokenId: string;
  readonly treeType: number;
  readonly treeSeed: Hex;
  readonly bornAt: string;
  readonly deathAt: string;
  readonly timezoneId: number;
  readonly timezone: string;
  readonly regionId: number;
  readonly region: string;
  readonly revision: number;
  readonly effectiveAt: string;
  readonly dead: boolean;
  readonly owner: Hex;
}

export interface ArtifactPresentationRequest {
  readonly chainId: number;
  readonly registry: Hex;
  readonly collection: Hex;
  readonly tokenId: string;
  readonly revision?: number;
}

export interface ArtifactPresentationResult {
  readonly manifestURI: string;
  readonly manifestDigest: Hex;
  readonly revision: number;
}

export interface LibraryAccessRequest {
  readonly reference: KeelLibraryReference;
  readonly account?: Hex;
}

export interface LibraryAccessResult {
  readonly allowed: boolean;
  readonly policyCommitment: Hex;
  readonly graphId: Hex;
  readonly graphVersion: number;
  readonly manifestDigest: Hex;
  readonly resourceGraphDigest: Hex;
}

export interface IPControlReadRequest {
  readonly declaration: KeelIPControlExtension;
  /** Optional connected account used for live token/allowlist/grant decisions. */
  readonly account?: string;
  /** Optional canonical snapshot selector supplied by a chain adapter. */
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
}

export interface IPControlLicenseResult {
  readonly licenseId: Hex;
  readonly contentObjectId: Hex;
  readonly decodedDigest: Hex;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly compression: "brotli";
  readonly identifier: string;
  readonly name: string;
  readonly publisher: string;
  readonly standard: boolean;
}

export interface IPControlResourceResult {
  readonly resource: string;
  readonly objectId: Hex;
  readonly objectRevision: number;
  readonly ruleId?: Hex;
  readonly mode: KeelIPControlMode;
  readonly actionMask: number;
  readonly allowedActions: readonly KeelIPControlAction[];
  readonly allowed: boolean;
  readonly currentAccount?: string;
}

export interface IPControlReadResult {
  readonly chain: "ethereum" | "tezos";
  readonly chainId: number;
  readonly registry: string;
  readonly licenseRegistry?: string;
  readonly policyId: Hex;
  readonly objectId: Hex;
  readonly objectRevision: number;
  readonly creator: string;
  readonly version: number;
  readonly configFrozen: boolean;
  readonly license: IPControlLicenseResult;
  readonly resources: readonly IPControlResourceResult[];
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
}

export interface ResolvedIPControl {
  readonly declaration: KeelIPControlExtension;
  readonly verified: boolean;
  readonly license?: IPControlLicenseResult;
  readonly creator?: string;
  readonly version?: number;
  readonly configFrozen?: boolean;
  readonly resources: readonly IPControlResourceResult[];
  readonly deniedResourceIds: readonly string[];
  readonly warnings: readonly string[];
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
}

export interface ResolverAdapters {
  readonly fetch?: FetchLike;
  /**
   * Optional trusted-host hook for DNS resolution, outbound firewall policy,
   * certificate pinning, or other checks before any declared remote fetch.
   */
  readonly authorizeRemoteSource?: (url: string, signal: AbortSignal) => Promise<void> | void;
  readonly readOnchainObject?: (request: OnchainObjectRequest, signal: AbortSignal) => Promise<Uint8Array>;
  /** Reads and fully verifies one history-inscribed KEEL Wake object. */
  readonly readWakeObject?: (request: WakeObjectRequest, signal: AbortSignal) => Promise<WakeObjectReadResult>;
  readonly callContract?: (request: ContractCallRequest, signal: AbortSignal) => Promise<Uint8Array | string>;
  readonly readPresentationState?: (
    request: KeelPresentationStateRequest,
    signal: AbortSignal,
  ) => Promise<KeelPresentationStateResult>;
  readonly readSeasonalGroveState?: (
    request: { readonly chainId: number; readonly contract: Hex; readonly collection: Hex; readonly tokenId: string },
    signal: AbortSignal,
  ) => Promise<KeelSeasonalGroveStateResult>;
  readonly readArtifactPresentation?: (
    request: ArtifactPresentationRequest,
    signal: AbortSignal,
  ) => Promise<ArtifactPresentationResult>;
  readonly readLibraryAccess?: (
    request: LibraryAccessRequest,
    signal: AbortSignal,
  ) => Promise<LibraryAccessResult>;
  /** Chain-specific IP-control reader. It must verify the exact manifest binding. */
  readonly readIPControl?: (
    request: IPControlReadRequest,
    signal: AbortSignal,
  ) => Promise<IPControlReadResult>;
  /** Chain-specific reader for ETH managers or Tezos FA2/SmartPy managers. */
  readonly readStakeObject?: (
    request: StakeObjectReadRequest,
    signal: AbortSignal,
  ) => Promise<StakeObjectReadResult>;
  readonly readStakeObjectManagerProof?: (
    request: StakeObjectManagerProofRequest,
    signal: AbortSignal,
  ) => Promise<StakeObjectManagerProof>;
  readonly decompress?: (compression: Exclude<Compression, "none">, bytes: Uint8Array) => Promise<Uint8Array>;
  readonly customDigest?: CustomDigest;
  readonly now?: () => number;
}

export interface StakeObjectReadRequest {
  readonly chain: KeelStakeObjectChain;
  readonly stakeObjectId: Hex;
  readonly hostCollection: string;
  readonly hostTokenId: string;
  readonly stakedTokenId: string;
}

export interface StakeObjectManagerProofRequest {
  readonly chain: KeelStakeObjectChain;
  readonly manager: string;
}

export interface StakeObjectManagerProof {
  readonly manager: string;
  readonly proofClass: "official" | "verified-custom";
  readonly immutable: true;
  readonly codeHash: Hex;
  readonly paid?: true;
  readonly adapterId?: string;
  readonly adapterVersion?: number;
  readonly evidenceDigest?: Hex;
  readonly reviewReceipt?: Hex;
  readonly feeReceipt?: Hex;
}

export interface StakeObjectReadResult {
  readonly active: boolean;
  readonly staker?: string;
  readonly controller?: string;
  readonly hostOwner?: string;
  readonly stakedCollection?: string;
  readonly activeTokenId?: string;
  /** Current NFT owner/custodian. While escrowed this is the manager address. */
  readonly tokenOwner?: string;
  readonly viewerId: Hex;
  readonly hostCollection: string;
  readonly hostTokenId: string;
  readonly slot: number;
  readonly startedAt?: string;
  readonly lockup: KeelStakeObjectLockup;
  readonly counters: KeelStakeObjectCounters;
  readonly managerVerified?: boolean;
  readonly managerPolicy?: KeelStakeObjectManagerPolicy;
  readonly managerProof?: StakeObjectManagerProof;
  readonly runtimeDigest?: Hex;
  readonly codeObjectId?: Hex;
  readonly codeObjectRevision?: number;
  readonly runtimeSeed?: Hex;
  readonly argumentsDigest?: Hex;
  readonly variablesDigest?: Hex;
}

export interface ResolverLimits {
  readonly maxResourceBytes: number;
  readonly maxTotalBytes: number;
  /** Aggregate encoded/stored-byte ceiling; defaults to maxTotalBytes. */
  readonly maxStoredBytes?: number;
  readonly maxRecursionDepth: number;
  readonly maxResources: number;
  readonly timeoutMs: number;
}

export type AuditStatus = "loaded" | "rejected" | "failed" | "skipped";

export interface SourceAuditEntry {
  readonly resourceId: string;
  readonly sourceIndex: number;
  readonly sourceKind: ResourceSource["kind"];
  readonly status: AuditStatus;
  readonly location?: string;
  readonly byteLength?: number;
  readonly integrityVerified?: boolean;
  readonly elapsedMs: number;
  readonly message?: string;
}

export interface ResolutionAudit {
  readonly schema: "keel-resolution-audit@2";
  readonly manifestId: string;
  readonly manifestDigest?: Hex;
  readonly anchorVerified: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly totalBytes: number;
  readonly totalStoredBytes: number;
  readonly resolvedResources: number;
  readonly entries: readonly SourceAuditEntry[];
  readonly warnings: readonly string[];
  readonly ipControl?: {
    readonly status: "verified" | "unavailable";
    readonly policyId: Hex;
    readonly licenseId: Hex;
    readonly deniedResourceIds: readonly string[];
  };
}

export interface ResolvedResource {
  readonly resource: ArtifactResource;
  readonly bytes: Uint8Array;
  readonly source: ResourceSource;
  readonly sourceIndex: number;
  readonly mediaType: string;
  readonly verified: true;
  /** Exact host-side location that produced the accepted bytes, when applicable. */
  readonly location?: string;
}

export interface VerifiedRegistryAnchor {
  /** Manifest-declared scope, which may be collection-wide. */
  readonly anchor: KeelIndexAnchor;
  /** Exact collection/token request whose active presentation produced it. */
  readonly driveAnchor?: KeelIndexAnchor;
  readonly presentation: ArtifactPresentationResult;
  readonly verified: true;
}

export interface ManifestCommitment {
  readonly integrity: Integrity;
  readonly digestVerified: true;
  readonly sourceUrl?: string;
  readonly registry?: VerifiedRegistryAnchor;
  readonly wake?: VerifiedWakeProvenance;
}

export interface ResolvedArtifact {
  readonly manifest: ArtifactManifest;
  readonly entrypoint: ResolvedResource;
  readonly resources: ReadonlyMap<string, ResolvedResource>;
  readonly stakeObject?: ResolvedStakeObject;
  readonly commitment?: ManifestCommitment;
  readonly libraryAccess?: readonly VerifiedLibraryAccess[];
  readonly ipControl?: ResolvedIPControl;
  readonly audit: ResolutionAudit;
}

export interface ResolvedStakeObject {
  readonly declaration: KeelStakeObject;
  readonly active: boolean;
  readonly stakedTokenId?: string;
  readonly staker?: string;
  readonly controller?: string;
  readonly hostOwner?: string;
  readonly stakedCollection?: string;
  readonly activeTokenId?: string;
  readonly tokenOwner?: string;
  readonly startedAt?: string;
  readonly slot: number;
  readonly lockup: KeelStakeObjectLockup;
  readonly counters: KeelStakeObjectCounters;
  readonly managerPolicy: KeelStakeObjectManagerPolicy;
  readonly managerVerified: boolean;
  readonly managerProof?: StakeObjectManagerProof;
  readonly runtimeDigest?: Hex;
  readonly codeObjectId?: Hex;
  readonly codeObjectRevision?: number;
  readonly runtimeSeed?: Hex;
  readonly argumentsDigest?: Hex;
  readonly variablesDigest?: Hex;
  readonly gatedResourceIds: readonly string[];
}

export interface VerifiedLibraryAccess {
  readonly reference: KeelLibraryReference;
  readonly verified: true;
}

export interface ResolveOptions {
  readonly adapters?: ResolverAdapters;
  readonly limits?: Partial<ResolverLimits>;
  readonly ipfsGateways?: readonly string[];
  readonly ipnsGateways?: readonly string[];
  readonly arweaveGateways?: readonly string[];
  readonly baseUrl?: string;
  /** Optional host/path allowlist for fetching declared sources. Runtime access is always virtualized. */
  readonly sourceAllowlist?: readonly string[];
  /** Disable host retrieval of declared URI sources. */
  readonly allowUriSources?: boolean;
  /** Private, loopback, link-local, and metadata-network targets are denied by default. */
  readonly allowPrivateNetworkSources?: boolean;
  readonly commitment?: ManifestCommitment;
  /** Connected top-frame account used only by the trusted Library adapter. */
  readonly libraryAccessAccount?: Hex;
  /** Optional connected account used by the IP-control verifier. */
  readonly ipControlAccount?: string;
  /** Internal host gate: skip resources that are only legal while staked. */
  readonly skipResourceIds?: ReadonlySet<string>;
  readonly stakeObjectTokenId?: string;
  readonly stakeObjectReader?: ResolverAdapters["readStakeObject"];
  readonly signal?: AbortSignal;
}

export interface ManifestLoadOptions {
  readonly adapters?: ResolverAdapters;
  readonly maxManifestBytes?: number;
  readonly timeoutMs?: number;
  readonly ipfsGateways?: readonly string[];
  readonly ipnsGateways?: readonly string[];
  readonly arweaveGateways?: readonly string[];
  readonly baseUrl?: string;
  readonly sourceAllowlist?: readonly string[];
  readonly allowPrivateNetworkSources?: boolean;
  readonly signal?: AbortSignal;
}

export interface LoadedArtifactManifest {
  readonly manifest: ArtifactManifest;
  readonly integrity: Integrity;
  readonly integrityVerified: true;
  readonly commitment: ManifestCommitment;
  readonly sourceUrl: string;
  readonly baseUrl: string;
  readonly byteLength: number;
}

export interface ResolveManifestOptions extends ManifestLoadOptions {
  readonly resolver?: Omit<ResolveOptions, "baseUrl" | "signal" | "commitment">;
}

export interface SandboxDocument {
  readonly html: string;
  readonly sandboxTokens: readonly string[];
  readonly allow: string;
  readonly csp: string;
  readonly warnings: readonly string[];
  readonly viewport?: RuntimeViewport;
  readonly routeCount: number;
}

/**
 * Host-read chain context supplied only after a Keel manifest and its
 * contract graph have been verified at the same pinned block.
 */
export interface RuntimeContext {
  readonly protocol: "keel-context@1";
  readonly chainId?: number;
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
  readonly blockTimestamp?: string;
  readonly tokenId?: string;
  readonly derivedTokenSeed?: Hex;
  readonly packedAttributes?: Hex;
  readonly portableRoot?: Hex;
  readonly portableManifestObjectId?: Hex;
  readonly portableDecodedObjectId?: Hex;
  readonly portableAnchorRoot?: Hex;
  readonly portableManifestObjectRevision?: number;
  readonly portableDecodedObjectRevision?: number;
  readonly assetFamilyId?: Hex;
  readonly assetId?: Hex;
  readonly spriteObjectId?: Hex;
  readonly targetMapObjectId?: Hex;
  readonly effectProfileObjectId?: Hex;
  readonly soundProfileObjectId?: Hex;
  readonly emitterSpriteBundleId?: number;
  readonly emitterSpriteAssetId?: number;
  readonly emitterMaterialTargetId?: Hex;
  readonly catalogRevision?: number;
  readonly assetFamilyRevision?: number;
  readonly emitterPresetId?: number;
  readonly emitterRevision?: number;
  readonly emitterSpriteBundleRevision?: number;
  readonly emitterSpriteSelectionRevision?: number;
  readonly fxCatalogRevision?: number;
  readonly mapGenerationEpoch?: number;
  readonly emitterSeedDomainVersion?: number;
  readonly emitterPaletteMode?: number;
  readonly sceneId?: number;
  readonly mapCharacterSeed?: Hex;
  readonly mapSeed?: Hex;
  readonly mapBuildRevision?: number;
  readonly mapPortableRoot?: Hex;
  readonly mapPortableManifestObjectId?: Hex;
  readonly mapPortableDecodedObjectId?: Hex;
  readonly mapPortableAnchorRoot?: Hex;
  readonly mapPortableManifestObjectRevision?: number;
  readonly mapPortableDecodedObjectRevision?: number;
  readonly collectionVerification?: CollectionVerificationInput;
  /** Host-verified stake state made available to the shared verifier chrome. */
  readonly stakeObject?: RuntimeStakeObjectContext;
}

export interface RuntimeStakeObjectContext {
  readonly protocol: "keel-stake-context@1";
  readonly stakeObjectId: Hex;
  readonly viewerId: Hex;
  readonly chain: "ethereum" | "tezos";
  readonly manager: string;
  readonly hostCollection: string;
  readonly hostTokenId: string;
  readonly stakedTokenId: string;
  readonly active: boolean;
  readonly staker?: string;
  readonly controller?: string;
  readonly hostOwner?: string;
  readonly tokenOwner?: string;
  readonly stakedCollection?: string;
  readonly activeTokenId?: string;
  readonly startedAt?: string;
  readonly slot: number;
  readonly gatedResourceIds: readonly string[];
  readonly stakedEntrypoint: string;
  readonly requireStaked: true;
  readonly lockup: KeelStakeObjectLockup;
  readonly counters: KeelStakeObjectCounters;
  readonly managerPolicy: KeelStakeObjectManagerPolicy;
  readonly managerVerified: boolean;
  readonly managerProof?: StakeObjectManagerProof;
  readonly runtimeDigest?: Hex;
  readonly codeObjectId?: Hex;
  readonly codeObjectRevision?: number;
  readonly runtimeSeed?: Hex;
  readonly argumentsDigest?: Hex;
  readonly variablesDigest?: Hex;
  readonly backpack?: KeelStakeObjectBackpack;
}

export interface SandboxOptions {
  readonly runtimeContext?: RuntimeContext;
  /** Consumer/gallery presentation: remove embedded editor chrome. */
  readonly consumer?: boolean;
  /**
   * Host capability ceiling. When present, each browser capability is enabled
   * only if the manifest declares it AND the ceiling allows it (`true`) — a host
   * can narrow the manifest's requested capabilities but never widen them. Absent
   * keys default to denied. Omit the whole field to impose no ceiling.
   * Pair with `effectiveRuntimeCapabilities()` from the capability-policy layer.
   */
  readonly capabilityCeiling?: Readonly<Partial<Record<keyof RuntimeCapabilities, boolean>>>;
}

export interface MountOptions {
  readonly className?: string;
  readonly title?: string;
  readonly loading?: "eager" | "lazy";
  readonly referrerPolicy?: ReferrerPolicy;
  /**
   * `scale` preserves the replay viewport and scales it inside the host. `fixed`
   * keeps exact pixels and may overflow. `host` uses host dimensions and is not
   * suitable for reproducible captures.
   */
  readonly deterministicViewport?: "scale" | "fixed" | "host";
  readonly runtimeContext?: RuntimeContext;
  /** Consumer/gallery presentation: remove embedded editor chrome. */
  readonly consumer?: boolean;
}

export interface MountedArtifact {
  readonly iframe: HTMLIFrameElement;
  readonly root: HTMLElement;
  readonly audit: ResolutionAudit;
  destroy(): void;
}

export interface VerifiedViewerBundle {
  readonly mirror: RuntimeViewerMirror;
  readonly bytes: Uint8Array;
  readonly sourceUrl: string;
  readonly integrityVerified: true;
}

export interface ViewerBundleLoadOptions {
  readonly fetch?: FetchLike;
  readonly authorizeRemoteSource?: (url: string, signal: AbortSignal) => Promise<void> | void;
  readonly customDigest?: CustomDigest;
  readonly ipfsGateways?: readonly string[];
  readonly ipnsGateways?: readonly string[];
  readonly arweaveGateways?: readonly string[];
  readonly sourceAllowlist?: readonly string[];
  readonly allowPrivateNetworkSources?: boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ViewerLaunch {
  readonly mirrorId: string;
  readonly bundleUri: string;
  readonly launchUrl?: string;
  readonly integrity: Integrity;
}

export interface VerifiedContentRoute {
  readonly path: string;
  readonly resourceId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly aliases: readonly string[];
}

export interface VerifiedContentResponse {
  readonly status: 200 | 403 | 404 | 405;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly resourceId?: string;
}

export interface VerifiedContentGateway {
  readonly protocol: "keel-content-gateway@1";
  readonly manifestId: string;
  readonly routes: readonly VerifiedContentRoute[];
  resolve(input: string, method?: string): VerifiedContentResponse;
}
