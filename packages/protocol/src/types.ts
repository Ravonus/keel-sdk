import type { KeelMediaDerivative } from "./keel-hold.js";
import type { KeelStakeObject } from "./stake-object.js";
import type { KeelAttribution } from "./keel-attribution.js";

export const OCA_MANIFEST_SCHEMA = "oca-manifest@2" as const;
export const OCA_LEGACY_MANIFEST_SCHEMA = "oca-manifest@1" as const;
export const OCA_CANONICALIZATION = "RFC8785" as const;
export const OCA_RUNTIME_PROTOCOL = "oca-runtime@1" as const;
export const OCA_VIEWER_PROTOCOL = "oca-viewer@1" as const;
export const OCA_CONTENT_GATEWAY_PROTOCOL = "oca-content-gateway@1" as const;
export const OCA_REGISTRY_ANCHOR_PROTOCOL = "oca-artifact-registry@1" as const;
export const OCA_THUMBNAIL_PROTOCOL = "oca-thumbnail@1" as const;
export const OCA_THUMBNAIL_CAPTURE_PROTOCOL = "oca-thumbnail-capture@1" as const;
export const OCA_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const KEEL_PLUGIN_BINDINGS_PROTOCOL = "keel-plugin-bindings@1" as const;
export const KEEL_CONTRACT_PLUGIN_PROTOCOL = "keel-contract-plugin@1" as const;
export const KEEL_GRAPH_ANCHOR_PROTOCOL = "keel-graph-registry@1" as const;
export const KEEL_PLUGIN_TRUST_PROTOCOL = "keel-plugin-registry@1" as const;
export const KEEL_WALLET_INTENTS_PROTOCOL = "keel-wallet-intents@1" as const;
export const KEEL_LIBRARY_BINDINGS_PROTOCOL = "keel-library-bindings@1" as const;
export const KEEL_BUILD_PROVENANCE_PROTOCOL = "keel-build-provenance@1" as const;
export const KEEL_PROJECT_STACK_PROTOCOL = "keel-project-stack@1" as const;
export const OCA_OBJECT_INDEX_ENCODING = "oca-object-index@1" as const;
export const OCA_MAX_OBJECT_CHILDREN = 128 as const;

export type Hex = `0x${string}`;
export type EthereumAddress = `0x${string}`;

export type DigestAlgorithm = "sha256" | "keccak256" | "none";
export type Compression = "none" | "gzip" | "deflate" | "brotli";
/**
 * `base85` is Z85 (the ZeroMQ alphabet), which is what the original Keel
 * `de85` decoder used. It costs 5 characters per 4 bytes against base64's 4 per
 * 3, so a payload lands ~6.25% smaller — the difference the Keel whitepaper
 * measured when three.js went from 175 KB to 163 KB.
 */
export type TextEncoding = "utf8" | "base64" | "base64url" | "base85";
export type ResourceRole =
  | "entrypoint"
  | "fallback"
  | "preview"
  | "original"
  | "script"
  | "style"
  | "font"
  | "image"
  | "audio"
  | "video"
  | "model"
  | "shader"
  | "data"
  | "library"
  | "other";

export interface Integrity {
  readonly algorithm: DigestAlgorithm;
  /**
   * Lower-case hexadecimal with a 0x prefix. `none` must use `0x`.
   * Resolvers verify decoded bytes after decompression.
   */
  readonly digest: Hex;
  readonly byteLength?: number;
}

export interface InlineSource {
  readonly kind: "inline";
  readonly data: string;
  readonly encoding: TextEncoding;
  readonly compression?: Compression;
  readonly integrity: Integrity;
}

export interface UriSource {
  readonly kind: "uri";
  /** HTTPS, IPFS, IPNS, Arweave, or a manifest-relative URI. */
  readonly uri: string;
  readonly gateways?: readonly string[];
  readonly compression?: Compression;
  /** Required: the host retrieves the bytes and verifies this before exposure. */
  readonly integrity: Integrity;
  readonly immutable?: boolean;
}

export interface OnchainSource {
  readonly kind: "onchain";
  readonly chainId: number;
  readonly store: EthereumAddress;
  readonly objectId: Hex;
  /**
   * Optional immutable leaf chunk hints. The canonical child index is recovered
   * from the object-index bytecode committed by objectId.
   */
  readonly chunks?: readonly Hex[];
  readonly compression?: Compression;
  readonly integrity: Integrity;
}

export interface ContractCallSource {
  readonly kind: "contract-call";
  readonly chainId: number;
  readonly to: EthereumAddress;
  readonly data: Hex;
  readonly decode: "bytes" | "string" | "base64";
  readonly compression?: Compression;
  readonly integrity: Integrity;
}

export interface CompositeSource {
  readonly kind: "composite";
  readonly parts: readonly string[];
  readonly separator?: string;
  readonly integrity: Integrity;
}

export type ResourceSource =
  | InlineSource
  | UriSource
  | OnchainSource
  | ContractCallSource
  | CompositeSource;

export interface ArtifactResource {
  readonly id: string;
  readonly role: ResourceRole;
  readonly mediaType: string;
  readonly executable?: boolean;
  readonly originalName?: string;
  readonly description?: string;
  /**
   * Optional virtual routes such as `/content/models/hero.glb`. The viewer only
   * serves these aliases after the resource has been resolved and verified.
   */
  readonly aliases?: readonly string[];
  /** Ordered fallbacks. The first source that loads and verifies wins. */
  readonly sources: readonly ResourceSource[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type KeelStorageTier = "remote-pinned" | "content-addressed" | "onchain";

export interface KeelGraphAnchor {
  readonly protocol: typeof KEEL_GRAPH_ANCHOR_PROTOCOL;
  readonly chainId: number;
  readonly registry: EthereumAddress;
  readonly graphId: Hex;
  readonly version: number;
  readonly storageTier: KeelStorageTier;
}

export interface KeelPluginTrustBinding {
  readonly protocol: typeof KEEL_PLUGIN_TRUST_PROTOCOL;
  readonly chainId: number;
  readonly registry: EthereumAddress;
  readonly specDigest: Hex;
  /** Trust is read from the registry; a plugin can never declare itself sanctioned. */
  readonly requiredStatus: "sanctioned";
}

/** Reference from an NFT/artifact manifest to an exact nested plugin manifest. */
export interface KeelPluginReference {
  readonly id: string;
  readonly manifestResource: string;
  readonly manifestIntegrity: Integrity;
  readonly graph: KeelGraphAnchor;
  readonly trust: KeelPluginTrustBinding;
}

export interface KeelPluginBindings {
  readonly protocol: typeof KEEL_PLUGIN_BINDINGS_PROTOCOL;
  readonly plugins: readonly KeelPluginReference[];
}

/** Exact reusable-asset dependency recorded by a consumer manifest. */
export interface KeelLibraryReference {
  readonly id: string;
  /** Resource whose verified bytes are supplied by this Library version. */
  readonly resource: string;
  readonly resourceIntegrity: Integrity;
  readonly chainId: number;
  readonly registry: EthereumAddress;
  readonly assetId: Hex;
  readonly policyVersion: number;
  readonly policyCommitment: Hex;
  readonly graph: KeelGraphAnchor;
  readonly manifestDigest: Hex;
  readonly resourceGraphDigest: Hex;
  /** Update intent never mutates this manifest; it governs creation of a child project revision. */
  readonly updates: {
    readonly mode: "locked" | "manual" | "auto-compatible";
    readonly compatibleGraphVersions?: {
      readonly min: number;
      readonly max: number;
    };
  };
}

/** Searchable dependency edges and reader access requirements. */
export interface KeelLibraryBindings {
  readonly protocol: typeof KEEL_LIBRARY_BINDINGS_PROTOCOL;
  readonly assets: readonly KeelLibraryReference[];
}

/** Human-readable purpose chosen by the project creator for one exact component. */
export type KeelComponentRole =
  | "entrypoint"
  | "renderer"
  | "runtime"
  | "script"
  | "module"
  | "style"
  | "shader"
  | "sprite-atlas"
  | "sprite-loader"
  | "audio-engine"
  | "wallet-runtime"
  | "audio"
  | "image"
  | "font"
  | "model"
  | "data"
  | "plugin"
  | "library"
  | "other";

/** Format of the exact bytes bound into the project stack. */
export type KeelComponentFormat =
  | "asset"
  | "classic-script"
  | "es-module"
  | "commonjs"
  | "umd"
  | "wasm";

export interface KeelComponentUpdatePolicy {
  /**
   * Updates always create a normal parented project revision. `auto-compatible`
   * merely authorizes the updater to propose the next exact Library version.
   */
  readonly mode: "locked" | "manual" | "auto-compatible";
  readonly compatibleGraphVersions?: { readonly min: number; readonly max: number };
}

/** One stable, named slot in an artifact's creator-defined stack. */
export interface KeelProjectComponent {
  readonly id: string;
  readonly label: string;
  readonly role: KeelComponentRole;
  /** Explicit assembly/order lane. Moving a locked component changes its descriptor. */
  readonly order: number;
  readonly resource: string;
  readonly resourceIntegrity: Integrity;
  /** Optional exact Library reference supplying this component. */
  readonly library?: string;
  /** Records whether the creator typed the label or accepted a Library suggestion. */
  readonly labelOrigin?: "creator" | "library-default";
  readonly format: KeelComponentFormat;
  readonly updates: KeelComponentUpdatePolicy;
}

/**
 * Per-component commitments for a revisioned project. The registry still uses
 * its ordinary whole-manifest publish method; an updater compares this stack to
 * the immutable parent before publishing a child revision.
 */
export interface KeelProjectStack {
  readonly protocol: typeof KEEL_PROJECT_STACK_PROTOCOL;
  readonly components: readonly KeelProjectComponent[];
}

export type KeelBuildOperation =
  | "normalize"
  | "transpile"
  | "bundle"
  | "minify"
  | "compress"
  | "encode"
  | "package";

export interface KeelBuildStep {
  readonly id: string;
  readonly operation: KeelBuildOperation;
  readonly tool: { readonly name: string; readonly version: string };
  readonly input: Integrity;
  readonly output: Integrity;
  /** Canonical digest of all behavior-affecting build options. */
  readonly optionsDigest: Hex;
  readonly deterministic: true;
}

/** Git-like reproducible chain from readable source to the exact stored resource. */
export interface KeelBuildProvenance {
  readonly protocol: typeof KEEL_BUILD_PROVENANCE_PROTOCOL;
  readonly source: {
    readonly availability: "included" | "digest-only";
    readonly resource?: string;
    readonly integrity: Integrity;
  };
  readonly steps: readonly KeelBuildStep[];
  readonly final: { readonly resource: string; readonly integrity: Integrity };
  readonly storage?: {
    readonly compression: Exclude<Compression, "none">;
    readonly input: Integrity;
    readonly stored: Integrity;
    readonly tool: { readonly name: string; readonly version: string };
    readonly optionsDigest: Hex;
    readonly deterministic: true;
  };
}

export type KeelPluginIntentTarget = "plugin-contract" | "artifact-collection";
export type KeelPluginValuePolicy = "zero" | "exact-quote";

/**
 * An iframe requests only this symbolic operation ID. The verified host adapter
 * constructs target, calldata, arguments, and value; creator code never does.
 */
export interface KeelPluginWalletIntent {
  readonly id: string;
  readonly label: string;
  readonly target: KeelPluginIntentTarget;
  /** Exact 4-byte selector, included for independent ABI/adapter comparison. */
  readonly selector: Hex;
  readonly stateMutability: "view" | "nonpayable" | "payable";
  readonly valuePolicy: KeelPluginValuePolicy;
  readonly confirmation: string;
}

export interface KeelPinnedPluginResource {
  readonly resource: string;
  readonly integrity: Integrity;
}

/** Descriptor present only on a nested plugin ArtifactManifest. */
export interface KeelContractPluginDescriptor {
  readonly protocol: typeof KEEL_CONTRACT_PLUGIN_PROTOCOL;
  readonly pluginId: Hex;
  readonly version: number;
  readonly parent?: {
    readonly version: number;
    readonly manifestDigest: Hex;
  };
  readonly graph: KeelGraphAnchor;
  readonly contract: {
    readonly chainId: number;
    readonly address: EthereumAddress;
    readonly runtimeCodeHash: Hex;
    readonly requiredInterfaceId: Hex;
  };
  readonly runtime: {
    readonly abi: KeelPinnedPluginResource;
    readonly adapter: KeelPinnedPluginResource;
    /** Auditable copy of the exact privileged host runtime build. */
    readonly walletLibrary: KeelPinnedPluginResource;
  };
  readonly permissions: {
    readonly protocol: typeof KEEL_WALLET_INTENTS_PROTOCOL;
    readonly digest: Hex;
    readonly intents: readonly KeelPluginWalletIntent[];
  };
}

export type EntrypointMode = "html" | "module" | "svg" | "image" | "video" | "audio" | "model";

export interface ArtifactEntrypoint {
  readonly resource: string;
  readonly mode: EntrypointMode;
  readonly mount?: string;
}

export interface RuntimeCapabilities {
  readonly downloads?: boolean;
  readonly pointerLock?: boolean;
  readonly fullscreen?: boolean;
  readonly clipboardWrite?: boolean;
  readonly gamepad?: boolean;
  readonly audioAutoplay?: boolean;
  /** Permit WebAssembly compilation inside the sandbox. */
  readonly webAssembly?: boolean;
}

/**
 * A complete, single-file viewer implementation. Mirrors may be HTTP, IPFS,
 * Arweave, or another URI scheme understood by the launcher. The bundle digest
 * is verified before execution, so no individual host is a trust root.
 */
export interface RuntimeViewerMirror {
  readonly id: string;
  readonly uri: string;
  readonly integrity: Integrity;
  readonly immutable?: boolean;
  /** Optional launch URL with `{manifest}` and `{digest}` placeholders. */
  readonly launchUrlTemplate?: string;
}

export interface RuntimeEngine {
  readonly protocol: typeof OCA_RUNTIME_PROTOCOL;
  readonly viewerProtocol: typeof OCA_VIEWER_PROTOCOL;
  readonly renderer: "browser";
  readonly viewerMirrors?: readonly RuntimeViewerMirror[];
}

export interface RuntimeViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export type RuntimeClock =
  | {
      readonly mode: "fixed";
      readonly epochMs: number;
    }
  | {
      readonly mode: "frame";
      readonly epochMs: number;
      readonly frameDurationMs: number;
    };

export type RuntimeDeterminism =
  | {
      /** Live browser state is intentional and snapshots may differ. */
      readonly mode: "live";
    }
  | {
      /** Reproducible runtime inputs for captures, replay, and long-term audit. */
      readonly mode: "replay";
      readonly seed: Hex;
      readonly randomAlgorithm: "xoshiro128ss";
      readonly viewport: RuntimeViewport;
      readonly clock: RuntimeClock;
      readonly locale: string;
      readonly timezone: string;
    };

export interface RuntimeContentPolicy {
  readonly protocol: typeof OCA_CONTENT_GATEWAY_PROTOCOL;
  /** Creator code receives only verified resources through the virtual gateway. */
  readonly mode: "verified-only";
  /** Remote bytes are fetched by the trusted host, never by creator code. */
  readonly externalSources: "host-verified";
  /** `registry` requires a KeelIndex contract proof before mounting. */
  readonly manifestTrust: "digest" | "registry";
  readonly blockUndeclared: true;
  readonly resourcePathPrefix?: "/content/";
  readonly onchainPathPrefix?: "/onchain/";
  readonly ipfsPathPrefix?: "/ipfs/";
}

export interface RuntimePolicy {
  /** Explicit protocol and viewer compatibility lock. */
  readonly engine: RuntimeEngine;
  /** Explicitly live or reproducible runtime inputs. */
  readonly determinism: RuntimeDeterminism;
  /** Content-addressed, deny-by-default virtual routing policy. */
  readonly content: RuntimeContentPolicy;
  /**
   * `strict` is a unique-origin iframe with no same-origin privilege.
   * `isolated-origin` is reserved for a separately deployed viewer origin but
   * remains sandboxed and still receives no direct network capability.
   */
  readonly sandbox: "strict" | "isolated-origin";
  readonly capabilities?: RuntimeCapabilities;
  readonly maxResourceBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxRecursionDepth?: number;
  readonly maxResources?: number;
  readonly timeoutMs?: number;
}

export interface KeelIndexAnchor {
  readonly protocol: typeof OCA_REGISTRY_ANCHOR_PROTOCOL;
  readonly kind: "artifact-registry";
  readonly chainId: number;
  readonly registry: EthereumAddress;
  readonly collection: EthereumAddress;
  /** Collection manifests use `scope: "collection"` plus the `*` sentinel;
   * token manifests use a canonical decimal uint256. */
  readonly tokenId: string;
  readonly scope?: "token" | "collection";
  /** Optional exact revision. When omitted, the active presentation is used. */
  readonly revision?: number;
}

export interface ArtifactFallback {
  readonly image: string;
  readonly animation?: string;
  readonly externalUrl?: string;
  readonly backgroundColor?: string;
}

export type ArtifactThumbnailMediaType =
  | "image/gif"
  | "image/avif"
  | "image/webp"
  | "image/png"
  | "image/jpeg"
  | "video/mp4";

/**
 * Exact poster/motion resources and an optional deterministic capture recipe.
 * Creator code can use the injected `__OCA_THUMBNAIL__` API or post the same
 * protocol messages itself; neither path grants network or wallet access.
 */
export interface ArtifactThumbnail {
  readonly protocol: typeof OCA_THUMBNAIL_PROTOCOL;
  readonly image?: string;
  readonly animation?: string;
  readonly maxBytes: typeof OCA_MAX_THUMBNAIL_BYTES;
  readonly capture?: {
    readonly mode: "signal" | "after-init" | "time";
    readonly target: "canvas" | "viewport";
    /** Delay after init/DOMContentLoaded before the hero frame is captured. */
    readonly delayMs?: number;
    /** Motion recording duration; omitted for a still capture. */
    readonly durationMs?: number;
    readonly frameRate?: number;
    readonly label?: string;
  };
}

export type RevisionPolicy = "immutable" | "creator" | "token-owner" | "creator-or-token-owner" | "timelocked";

export interface RevisionCompatibility {
  readonly min: number;
  readonly max: number;
}

export interface ArtifactRevision {
  readonly number: number;
  readonly parent?: number;
  readonly parentDigest?: Integrity;
  readonly compatibility: RevisionCompatibility;
  readonly policy: RevisionPolicy;
  readonly activationTime?: string;
  readonly frozen?: boolean;
  readonly notes?: string;
}

export interface ArtifactProvenance {
  readonly creator?: EthereumAddress | string;
  readonly createdAt: string;
  readonly collection?: EthereumAddress;
  readonly tokenId?: string;
  readonly chainId?: number;
  readonly sourceRepository?: string;
  readonly license?: string;
}

export interface ArtifactAttribute {
  readonly trait_type: string;
  readonly value: string | number;
  readonly display_type?: string;
}

export interface ArtifactDownload {
  readonly resource: string;
  readonly label: string;
  readonly filename?: string;
}

export interface ArtifactManifest {
  readonly schema: typeof OCA_MANIFEST_SCHEMA;
  /** RFC 8785 JSON Canonicalization Scheme, used for manifest commitments. */
  readonly canonicalization: typeof OCA_CANONICALIZATION;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly entrypoint: ArtifactEntrypoint;
  readonly resources: readonly ArtifactResource[];
  readonly fallback: ArtifactFallback;
  /** Marketplace-ready media capped at 2 MiB, plus a script capture handshake. */
  readonly thumbnail?: ArtifactThumbnail;
  /** Exact reproducible media outputs a marketplace may serve instead of source bytes. */
  readonly mediaDerivatives?: readonly KeelMediaDerivative[];
  /** Optional manager-controlled payload that is resolvable only while staked. */
  readonly stakeObject?: KeelStakeObject;
  readonly runtime: RuntimePolicy;
  /** Exact nested plugin manifests requested by this artifact. */
  readonly plugins?: KeelPluginBindings;
  /** Exact reusable Library versions consumed by this artifact. */
  readonly libraries?: KeelLibraryBindings;
  /** Creator-labelled, independently lockable project components. */
  readonly stack?: KeelProjectStack;
  /** Reproducible source-to-stored-byte build receipt. */
  readonly build?: KeelBuildProvenance;
  /** Present when this artifact manifest itself is a contract plugin. */
  readonly contractPlugin?: KeelContractPluginDescriptor;
  /** Required when runtime.content.manifestTrust is `registry`. */
  readonly anchor?: KeelIndexAnchor;
  readonly revision: ArtifactRevision;
  readonly provenance: ArtifactProvenance;
  readonly downloads?: readonly ArtifactDownload[];
  readonly attributes?: readonly ArtifactAttribute[];
  /** Creator-authored people/role labels; these do not grant runtime or edit access. */
  readonly attributions?: readonly KeelAttribution[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ManifestValidationIssue {
  readonly level: "error" | "warning";
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ManifestValidationIssue[];
}

export interface ByteChunk {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
  readonly bytes: Uint8Array;
}

export interface PackedUint48Group {
  readonly value: bigint;
  readonly ids: readonly bigint[];
}
