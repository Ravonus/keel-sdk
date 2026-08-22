import type { Compression, Hex, Integrity } from "./types.js";

export const KEEL_STORAGE_PROTOCOL = "keel-hold@1" as const;
export const KEEL_DIRECTORY_PROTOCOL = "keel-directory@1" as const;
export const KEEL_MEDIA_DERIVATIVE_PROTOCOL = "keel-media-derivative@1" as const;
export const KEEL_MARKETPLACE_API_PROTOCOL = "keel-marketplace-api@1" as const;
export const KEEL_MODULE_CATALOG_PROTOCOL = "keel-module-catalog@1" as const;

export type KeelCarrier =
  | {
      readonly kind: "keel";
      /** CAIP-2 network identifier, for example eip155:1 or tezos:NetXdQprcVkpaWU. */
      readonly network: string;
      readonly store: string;
      readonly objectId: Hex;
      /** Native recursive tree, or a same-store object bound to standard OnchFS chunks. */
      readonly reader: "recursive-object@1" | "onchfs-bound-object@1";
    }
  | {
      readonly kind: "onchfs";
      readonly network: string;
      readonly contract: string;
      /** OnchFS-compatible lower-case Keccak CID without a 0x prefix. */
      readonly cid: string;
      readonly path?: string;
    }
  | {
      readonly kind: "ipfs";
      readonly uri: `ipfs://${string}`;
      readonly immutable: true;
    }
  | {
      readonly kind: "https";
      readonly uri: `https://${string}`;
      readonly immutable: true;
    };

/** One independently compressed and reusable object in the canonical graph. */
export interface KeelStorageResource {
  readonly resourceId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly executable: boolean;
  /** SHA-256 of the exact bytes exposed to creator code after decompression. */
  readonly decodedIntegrity: Integrity;
  /** SHA-256 of the independently stored/compressed bytes. */
  readonly storedIntegrity: Integrity;
  readonly compression: Compression;
  /** Domain-separated recursive storage object identifier. */
  readonly objectId: Hex;
  readonly dependencies: readonly string[];
  readonly carriers: readonly KeelCarrier[];
}

/** Canonical storage graph. ZIPs and marketplace directories are derived views, never storage. */
export interface KeelStorageGraph {
  readonly protocol: typeof KEEL_STORAGE_PROTOCOL;
  readonly canonicalDigest: "sha256";
  readonly sourceManifest: Integrity;
  readonly entrypoint: string;
  readonly resources: readonly KeelStorageResource[];
}

export interface KeelDirectoryFile {
  readonly path: string;
  readonly resourceId?: string;
  readonly integrity: Integrity;
  readonly mediaType: string;
}

/** A same-origin HTML/module directory materialized from a verified Keel graph. */
export interface KeelDirectoryManifest {
  readonly protocol: typeof KEEL_DIRECTORY_PROTOCOL;
  readonly sourceManifest: Integrity;
  readonly storageGraph: Integrity;
  readonly root: "index.html";
  readonly files: readonly KeelDirectoryFile[];
}

export type KeelWebpProfile =
  | "preview-webp-512-v1"
  | "display-webp-1024-v1"
  | "display-webp-2048-v1";

export interface KeelMediaTransform {
  readonly profile: KeelWebpProfile;
  readonly codec: "webp";
  readonly width: 512 | 1024 | 2048;
  readonly height: 512 | 1024 | 2048;
  readonly fit: "inside";
  readonly withoutEnlargement: true;
  readonly colorSpace: "srgb";
  readonly quality: number;
  readonly effort: 6;
  readonly smartSubsample: true;
  readonly implementation: {
    readonly name: "sharp-libvips";
    readonly sharpVersion: string;
    readonly vipsVersion: string;
  };
  /** SHA-256 of the RFC-8785 transform object above, excluding this field. */
  readonly recipeDigest: Hex;
}

/** Exact lineage for a creator-approved or deterministic marketplace media derivative. */
export interface KeelMediaDerivative {
  readonly protocol: typeof KEEL_MEDIA_DERIVATIVE_PROTOCOL;
  readonly sourceResourceId: string;
  readonly sourceIntegrity: Integrity;
  /** Manifest resource containing the exact optimized output bytes. */
  readonly outputResourceId: string;
  readonly outputIntegrity: Integrity;
  readonly outputMediaType: "image/webp";
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly transform: KeelMediaTransform;
  /** Verification is against the committed output digest; transform metadata explains lineage. */
  readonly authority: "manifest-output-digest";
}

export type KeelModuleFormat = "es-module" | "classic-script" | "umd" | "commonjs" | "wasm";

export interface KeelModuleIdentity {
  readonly namespace: "npm" | "keel" | "github";
  readonly name: string;
  readonly version: string;
  readonly entry: string;
}

/** One exact reusable module release, discoverable across every byte-identical carrier. */
export interface KeelModuleRelease {
  readonly identity: KeelModuleIdentity;
  readonly mediaType: string;
  readonly format: KeelModuleFormat;
  readonly integrity: Integrity;
  readonly byteLength: number;
  readonly license?: string;
  readonly sourceRepository?: string;
  readonly carriers: readonly KeelCarrier[];
}

export interface KeelModuleCatalog {
  readonly protocol: typeof KEEL_MODULE_CATALOG_PROTOCOL;
  readonly canonicalDigest: "sha256";
  readonly releases: readonly KeelModuleRelease[];
}

function sha256Integrity(value: Integrity, label: string): void {
  if (
    value.algorithm !== "sha256" ||
    !/^0x[0-9a-f]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength ?? 0) <= 0
  ) {
    throw new TypeError(`${label} must be an exact non-empty SHA-256 integrity commitment.`);
  }
}

function identifier(value: string, label: string): void {
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function safePath(value: string, label: string): void {
  identifier(value, label);
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`${label} must be a safe relative path.`);
  }
}

function carrier(value: KeelCarrier, label: string): void {
  if (value.kind === "keel") {
    identifier(value.network, `${label}.network`);
    identifier(value.store, `${label}.store`);
    if (!/^0x[0-9a-f]{64}$/u.test(value.objectId)) throw new TypeError(`${label}.objectId must be canonical bytes32.`);
    if (value.reader !== "recursive-object@1" && value.reader !== "onchfs-bound-object@1") {
      throw new TypeError(`${label}.reader is unsupported.`);
    }
    return;
  }
  if (value.kind === "onchfs") {
    identifier(value.network, `${label}.network`);
    identifier(value.contract, `${label}.contract`);
    if (!/^[0-9a-f]{64}$/u.test(value.cid)) throw new TypeError(`${label}.cid must be a lower-case OnchFS CID.`);
    if (value.path !== undefined) safePath(value.path, `${label}.path`);
    return;
  }
  if (value.kind === "ipfs") {
    if (!value.uri.startsWith("ipfs://") || value.uri.length <= "ipfs://".length) throw new TypeError(`${label}.uri is invalid.`);
    return;
  }
  if (!value.uri.startsWith("https://")) throw new TypeError(`${label}.uri must use HTTPS.`);
}

export function assertValidKeelStorageGraph(graph: KeelStorageGraph): void {
  if (graph.protocol !== KEEL_STORAGE_PROTOCOL || graph.canonicalDigest !== "sha256") {
    throw new TypeError("Unsupported Keel storage graph.");
  }
  sha256Integrity(graph.sourceManifest, "sourceManifest");
  identifier(graph.entrypoint, "entrypoint");
  if (graph.resources.length === 0 || graph.resources.length > 4096) throw new RangeError("A Keel graph needs 1 through 4096 resources.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, resource] of graph.resources.entries()) {
    const label = `resources[${index}]`;
    identifier(resource.resourceId, `${label}.resourceId`);
    safePath(resource.path, `${label}.path`);
    identifier(resource.mediaType, `${label}.mediaType`);
    sha256Integrity(resource.decodedIntegrity, `${label}.decodedIntegrity`);
    sha256Integrity(resource.storedIntegrity, `${label}.storedIntegrity`);
    if (!/^0x[0-9a-f]{64}$/u.test(resource.objectId)) throw new TypeError(`${label}.objectId must be canonical bytes32.`);
    if (ids.has(resource.resourceId) || paths.has(resource.path)) throw new TypeError("Keel resource IDs and paths must be unique.");
    ids.add(resource.resourceId);
    paths.add(resource.path);
    for (const dependency of resource.dependencies) identifier(dependency, `${label}.dependencies`);
    resource.carriers.forEach((item, carrierIndex) => carrier(item, `${label}.carriers[${carrierIndex}]`));
  }
  if (!ids.has(graph.entrypoint)) throw new TypeError("Keel entrypoint does not name a stored resource.");
  for (const resource of graph.resources) {
    for (const dependency of resource.dependencies) {
      if (!ids.has(dependency)) throw new TypeError(`${resource.resourceId} depends on unknown resource ${dependency}.`);
    }
  }
}

export function assertValidKeelMediaDerivative(value: KeelMediaDerivative): void {
  if (value.protocol !== KEEL_MEDIA_DERIVATIVE_PROTOCOL || value.authority !== "manifest-output-digest") {
    throw new TypeError("Unsupported Keel media derivative.");
  }
  identifier(value.sourceResourceId, "sourceResourceId");
  identifier(value.outputResourceId, "outputResourceId");
  if (value.sourceResourceId === value.outputResourceId) throw new TypeError("A derivative output must be a distinct resource.");
  sha256Integrity(value.sourceIntegrity, "sourceIntegrity");
  sha256Integrity(value.outputIntegrity, "outputIntegrity");
  if (!Number.isSafeInteger(value.outputWidth) || value.outputWidth <= 0 || !Number.isSafeInteger(value.outputHeight) || value.outputHeight <= 0) {
    throw new RangeError("Derivative output dimensions must be positive safe integers.");
  }
  if (!/^0x[0-9a-f]{64}$/u.test(value.transform.recipeDigest)) throw new TypeError("Derivative recipe digest must be canonical bytes32.");
  if (!Number.isSafeInteger(value.transform.quality) || value.transform.quality < 1 || value.transform.quality > 100) {
    throw new RangeError("Derivative quality must be an integer from 1 through 100.");
  }
}

export function assertValidKeelModuleCatalog(catalog: KeelModuleCatalog): void {
  if (catalog.protocol !== KEEL_MODULE_CATALOG_PROTOCOL || catalog.canonicalDigest !== "sha256") {
    throw new TypeError("Unsupported Keel module catalog.");
  }
  const identities = new Set<string>();
  for (const [index, release] of catalog.releases.entries()) {
    const label = `releases[${index}]`;
    identifier(release.identity.name, `${label}.identity.name`);
    identifier(release.identity.version, `${label}.identity.version`);
    safePath(release.identity.entry, `${label}.identity.entry`);
    sha256Integrity(release.integrity, `${label}.integrity`);
    if (release.byteLength !== release.integrity.byteLength) throw new TypeError(`${label}.byteLength does not match its integrity commitment.`);
    const key = `${release.identity.namespace}:${release.identity.name}@${release.identity.version}/${release.identity.entry}`.toLowerCase();
    if (identities.has(key)) throw new TypeError(`Duplicate module release ${key}.`);
    identities.add(key);
    release.carriers.forEach((item, carrierIndex) => carrier(item, `${label}.carriers[${carrierIndex}]`));
  }
}
