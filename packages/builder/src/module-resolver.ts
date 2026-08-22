import {
  assertValidKeelModuleCatalog,
  canonicalJson,
  createIntegrity,
  verifyIntegrity,
  type Hex,
  type Integrity,
  type KeelCarrier,
  type KeelModuleCatalog,
  type KeelModuleIdentity,
  type KeelModuleRelease,
} from "@keel/protocol";

export const KEEL_MODULE_RESOLVER_SNAPSHOT_PROTOCOL = "keel-module-resolver-snapshot@1" as const;
export const KEEL_MODULE_LOCK_PROTOCOL = "keel-module-lock@1" as const;
export const KEEL_MODULE_RESOLUTION_RECEIPT_PROTOCOL = "keel-module-resolution-receipt@1" as const;

const MAX_QUERY_TEXT = 256;
const MAX_ARTIST_TEXT = 128;
const MAX_TAG_TEXT = 64;
const MAX_TAGS = 32;

export interface KeelModuleDisplayMetadata {
  readonly identity: KeelModuleIdentity;
  /** Display-only metadata; it is never included in the authoritative catalog digest. */
  readonly artist?: string;
  readonly tags?: readonly string[];
}

export interface KeelModuleResolverSnapshot {
  readonly protocol: typeof KEEL_MODULE_RESOLVER_SNAPSHOT_PROTOCOL;
  readonly catalog: KeelModuleCatalog;
  readonly display?: readonly KeelModuleDisplayMetadata[];
}

export interface KeelModuleHashSelector {
  readonly sha256: Hex;
  readonly byteLength: number;
}

export interface KeelModuleQuerySelector {
  readonly name?: string;
  readonly artist?: string;
  readonly tags?: readonly string[];
}

export type KeelModuleSelector = KeelModuleHashSelector | KeelModuleQuerySelector;

export interface KeelModuleCatalogDigest extends Integrity {
  readonly algorithm: "sha256";
  readonly digest: `0x${string}`;
  readonly byteLength: number;
}

export interface KeelModuleResolverCandidate {
  readonly release: KeelModuleRelease;
  readonly display?: {
    readonly artist?: string;
    readonly tags?: readonly string[];
  };
}

export interface KeelModuleLock {
  readonly protocol: typeof KEEL_MODULE_LOCK_PROTOCOL;
  readonly catalogDigest: KeelModuleCatalogDigest;
  readonly selector: KeelModuleSelector;
  readonly release: KeelModuleRelease;
}

type ModuleBytesStatus = "available" | "unavailable" | "invalid";

export interface KeelModuleResolutionReceipt {
  readonly protocol: typeof KEEL_MODULE_RESOLUTION_RECEIPT_PROTOCOL;
  readonly catalogDigest: KeelModuleCatalogDigest;
  readonly snapshotDigest: Integrity;
  readonly lockDigest: Integrity;
  readonly selector: KeelModuleSelector;
  readonly release: KeelModuleRelease;
  readonly bytes: {
    readonly status: ModuleBytesStatus;
    readonly integrity?: Integrity;
  };
}

interface ResolutionContext {
  readonly catalogDigest: KeelModuleCatalogDigest;
  readonly snapshotDigest: Integrity;
  readonly selector: KeelModuleSelector;
  readonly candidates: readonly KeelModuleResolverCandidate[];
}

export interface KeelModuleResolved {
  readonly schema: "keel-module-resolution@1";
  readonly status: "resolved";
  readonly catalogDigest: KeelModuleCatalogDigest;
  readonly snapshotDigest: Integrity;
  readonly selector: KeelModuleSelector;
  readonly release: KeelModuleRelease;
  readonly display?: {
    readonly artist?: string;
    readonly tags?: readonly string[];
  };
  readonly bytes: Uint8Array;
  readonly lock: KeelModuleLock;
  readonly lockDigest: Integrity;
  readonly receipt: KeelModuleResolutionReceipt;
  readonly receiptDigest: Integrity;
}

export interface KeelModuleBytesUnavailable {
  readonly schema: "keel-module-resolution@1";
  readonly status: "bytes-unavailable";
  readonly catalogDigest: KeelModuleCatalogDigest;
  readonly snapshotDigest: Integrity;
  readonly selector: KeelModuleSelector;
  readonly release: KeelModuleRelease;
  readonly display?: {
    readonly artist?: string;
    readonly tags?: readonly string[];
  };
  readonly lock: KeelModuleLock;
  readonly lockDigest: Integrity;
  readonly receipt: KeelModuleResolutionReceipt;
  readonly receiptDigest: Integrity;
}

export interface KeelModuleBytesInvalid {
  readonly schema: "keel-module-resolution@1";
  readonly status: "bytes-invalid";
  readonly catalogDigest: KeelModuleCatalogDigest;
  readonly snapshotDigest: Integrity;
  readonly selector: KeelModuleSelector;
  readonly release: KeelModuleRelease;
  readonly display?: {
    readonly artist?: string;
    readonly tags?: readonly string[];
  };
  readonly expected: Integrity;
  readonly actual: Integrity;
  readonly lock: KeelModuleLock;
  readonly lockDigest: Integrity;
  readonly receipt: KeelModuleResolutionReceipt;
  readonly receiptDigest: Integrity;
}

export interface KeelModuleNotFound extends ResolutionContext {
  readonly schema: "keel-module-resolution@1";
  readonly status: "not-found";
}

export interface KeelModuleAmbiguous extends ResolutionContext {
  readonly schema: "keel-module-resolution@1";
  readonly status: "ambiguous";
}

export type KeelModuleResolution =
  | KeelModuleResolved
  | KeelModuleBytesUnavailable
  | KeelModuleBytesInvalid
  | KeelModuleNotFound
  | KeelModuleAmbiguous;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(identity: KeelModuleIdentity): string {
  return `${identity.namespace}:${identity.name}@${identity.version}/${identity.entry}`.normalize("NFKC").toLowerCase();
}

function releaseSortKey(release: KeelModuleRelease): string {
  return [identityKey(release.identity), release.integrity.digest, String(release.byteLength), release.mediaType, release.format].join("\u0000");
}

function carrierSortKey(carrier: KeelCarrier): string {
  return canonicalJson(carrier);
}

function sortedRelease(release: KeelModuleRelease): KeelModuleRelease {
  return {
    ...release,
    identity: { ...release.identity },
    integrity: { ...release.integrity },
    carriers: [...release.carriers].sort((left, right) => compareText(carrierSortKey(left), carrierSortKey(right))),
  };
}

function canonicalCatalog(catalog: KeelModuleCatalog): KeelModuleCatalog {
  return {
    protocol: catalog.protocol,
    canonicalDigest: catalog.canonicalDigest,
    releases: [...catalog.releases].map(sortedRelease).sort((left, right) => compareText(releaseSortKey(left), releaseSortKey(right))),
  };
}

function canonicalDisplay(display: readonly KeelModuleDisplayMetadata[] | undefined): readonly KeelModuleDisplayMetadata[] {
  return (display ?? []).map((entry) => ({
    identity: { ...entry.identity },
    ...(entry.artist === undefined ? {} : { artist: entry.artist }),
    ...(entry.tags === undefined ? {} : { tags: [...entry.tags].sort(compareText) }),
  })).sort((left, right) => compareText(identityKey(left.identity), identityKey(right.identity)));
}

function canonicalSnapshot(snapshot: KeelModuleResolverSnapshot): KeelModuleResolverSnapshot {
  return {
    protocol: snapshot.protocol,
    catalog: canonicalCatalog(snapshot.catalog),
    ...(snapshot.display === undefined ? {} : { display: canonicalDisplay(snapshot.display) }),
  };
}

function validateDisplay(snapshot: KeelModuleResolverSnapshot): void {
  const releases = new Set(snapshot.catalog.releases.map((release) => identityKey(release.identity)));
  const seen = new Set<string>();
  for (const [index, entry] of (snapshot.display ?? []).entries()) {
    const displayInput = object(entry, `display[${index}]`);
    exactKeys(displayInput, ["identity", "artist", "tags"], `display[${index}]`);
    validateIdentity(entry.identity, `display[${index}].identity`);
    const key = identityKey(entry.identity);
    if (!releases.has(key)) throw new TypeError(`display[${index}] names an unknown module release.`);
    if (seen.has(key)) throw new TypeError(`display metadata duplicates module release ${key}.`);
    seen.add(key);
    if (entry.artist !== undefined) boundedText(entry.artist, `display[${index}].artist`, MAX_ARTIST_TEXT);
    if (entry.tags !== undefined) validateTags(entry.tags, `display[${index}].tags`);
  }
}

function validateTags(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw new RangeError(`${label} must contain at most ${MAX_TAGS} tags.`);
  const tags = value.map((tag, index) => boundedText(tag, `${label}[${index}]`, MAX_TAG_TEXT));
  const normalized = new Set(tags.map((tag) => tag.normalize("NFKC").toLowerCase()));
  if (normalized.size !== tags.length) throw new TypeError(`${label} must not contain duplicate tags.`);
  return tags;
}

function validateIdentity(value: unknown, label: string): KeelModuleIdentity {
  const input = object(value, label);
  exactKeys(input, ["namespace", "name", "version", "entry"], label);
  if (input.namespace !== "npm" && input.namespace !== "keel" && input.namespace !== "github") throw new TypeError(`${label}.namespace is unsupported.`);
  const name = boundedText(input.name, `${label}.name`, MAX_QUERY_TEXT);
  const version = boundedText(input.version, `${label}.version`, MAX_QUERY_TEXT);
  const entry = boundedText(input.entry, `${label}.entry`, MAX_QUERY_TEXT);
  if (entry.includes("\\") || entry.startsWith("/") || entry.endsWith("/") || entry.includes("//") || entry.split("/").some((part) => part === "." || part === "..")) throw new TypeError(`${label}.entry must be a safe relative path.`);
  return { namespace: input.namespace, name, version, entry };
}

function validateCatalogShape(catalog: KeelModuleCatalog): void {
  const catalogInput = object(catalog, "snapshot.catalog");
  exactKeys(catalogInput, ["protocol", "canonicalDigest", "releases"], "snapshot.catalog");
  const identities = new Set<string>();
  for (const [index, release] of catalog.releases.entries()) {
    const label = `snapshot.catalog.releases[${index}]`;
    const input = object(release, label);
    exactKeys(input, ["identity", "mediaType", "format", "integrity", "byteLength", "license", "sourceRepository", "carriers"], label);
    const checkedIdentity = validateIdentity(release.identity, `${label}.identity`);
    if (identities.has(identityKey(checkedIdentity))) throw new TypeError(`Duplicate module release ${identityKey(checkedIdentity)}.`);
    identities.add(identityKey(checkedIdentity));
    boundedText(release.mediaType, `${label}.mediaType`, 255);
    if (!["es-module", "classic-script", "umd", "commonjs", "wasm"].includes(release.format)) throw new TypeError(`${label}.format is unsupported.`);
    if (!Array.isArray(release.carriers)) throw new TypeError(`${label}.carriers must be an array.`);
    const carriers = new Set(release.carriers.map((carrier) => canonicalJson(carrier)));
    if (carriers.size !== release.carriers.length) throw new TypeError(`${label}.carriers must be unique.`);
    if (release.license !== undefined) boundedText(release.license, `${label}.license`, MAX_QUERY_TEXT);
    if (release.sourceRepository !== undefined) boundedText(release.sourceRepository, `${label}.sourceRepository`, MAX_QUERY_TEXT);
  }
}

function normalizeDisplay(entry: KeelModuleDisplayMetadata | undefined): KeelModuleResolverCandidate["display"] {
  if (entry === undefined) return undefined;
  return {
    ...(entry.artist === undefined ? {} : { artist: entry.artist.trim() }),
    ...(entry.tags === undefined ? {} : { tags: [...entry.tags].sort(compareText) }),
  };
}

function normalizedSelector(selector: KeelModuleSelector): KeelModuleSelector {
  const selectorInput = object(selector, "selector");
  if ("sha256" in selector) {
    exactKeys(selectorInput, ["sha256", "byteLength"], "hash selector");
    if (typeof selector.sha256 !== "string" || !/^0x[0-9a-f]{64}$/u.test(selector.sha256)) throw new TypeError("selector.sha256 must be lowercase SHA-256 hex.");
    if (!Number.isSafeInteger(selector.byteLength) || selector.byteLength <= 0) throw new RangeError("selector.byteLength must be a positive safe integer.");
    return { sha256: selector.sha256, byteLength: selector.byteLength };
  }
  exactKeys(selectorInput, ["name", "artist", "tags"], "query selector");
  const query = selector as KeelModuleQuerySelector;
  const name = query.name === undefined ? undefined : boundedText(query.name, "selector.name", MAX_QUERY_TEXT).toLowerCase();
  const artist = query.artist === undefined ? undefined : boundedText(query.artist, "selector.artist", MAX_ARTIST_TEXT).toLowerCase();
  const tags = query.tags === undefined ? undefined : validateTags(query.tags, "selector.tags").map((tag) => tag.toLowerCase()).sort(compareText);
  if (name === undefined && artist === undefined && (tags === undefined || tags.length === 0)) throw new TypeError("selector query must specify name, artist, or tags.");
  return { ...(name === undefined ? {} : { name }), ...(artist === undefined ? {} : { artist }), ...(tags === undefined ? {} : { tags }) };
}

function displayMap(snapshot: KeelModuleResolverSnapshot): ReadonlyMap<string, KeelModuleDisplayMetadata> {
  return new Map((snapshot.display ?? []).map((entry) => [identityKey(entry.identity), entry] as const));
}

function matches(release: KeelModuleRelease, display: KeelModuleDisplayMetadata | undefined, selector: KeelModuleSelector): boolean {
  if ("sha256" in selector) return release.integrity.algorithm === "sha256" && release.integrity.digest === selector.sha256 && release.byteLength === selector.byteLength;
  if (selector.name !== undefined && release.identity.name.toLowerCase() !== selector.name) return false;
  if (selector.artist !== undefined && display?.artist?.toLowerCase() !== selector.artist) return false;
  if (selector.tags !== undefined) {
    const available = new Set((display?.tags ?? []).map((tag) => tag.toLowerCase()));
    if (selector.tags.some((tag) => !available.has(tag))) return false;
  }
  return true;
}

function candidate(release: KeelModuleRelease, display: KeelModuleDisplayMetadata | undefined): KeelModuleResolverCandidate {
  const normalized = normalizeDisplay(display);
  return normalized === undefined ? { release: sortedRelease(release) } : { release: sortedRelease(release), display: normalized };
}

async function digestJson(value: unknown): Promise<Integrity> {
  return createIntegrity(new TextEncoder().encode(canonicalJson(value)), "sha256");
}

async function catalogDigest(catalog: KeelModuleCatalog): Promise<KeelModuleCatalogDigest> {
  return digestJson(canonicalCatalog(catalog)) as Promise<KeelModuleCatalogDigest>;
}

async function lockAndReceipt(
  context: ResolutionContext,
  release: KeelModuleRelease,
  display: KeelModuleResolverCandidate["display"],
  bytesStatus: ModuleBytesStatus,
  bytesIntegrity?: Integrity,
): Promise<Pick<KeelModuleResolved, "lock" | "lockDigest" | "receipt" | "receiptDigest">> {
  const lock: KeelModuleLock = {
    protocol: KEEL_MODULE_LOCK_PROTOCOL,
    catalogDigest: context.catalogDigest,
    selector: context.selector,
    release: sortedRelease(release),
  };
  const lockDigest = await digestJson(lock);
  const receipt: KeelModuleResolutionReceipt = {
    protocol: KEEL_MODULE_RESOLUTION_RECEIPT_PROTOCOL,
    catalogDigest: context.catalogDigest,
    snapshotDigest: context.snapshotDigest,
    lockDigest,
    selector: context.selector,
    release: sortedRelease(release),
    bytes: { status: bytesStatus, ...(bytesIntegrity === undefined ? {} : { integrity: bytesIntegrity }) },
  };
  const receiptDigest = await digestJson(receipt);
  return { lock, lockDigest, receipt, receiptDigest };
}

export function assertValidKeelModuleResolverSnapshot(value: unknown): asserts value is KeelModuleResolverSnapshot {
  const snapshot = object(value, "module resolver snapshot") as unknown as KeelModuleResolverSnapshot;
  exactKeys(snapshot as unknown as Record<string, unknown>, ["protocol", "catalog", "display"], "module resolver snapshot");
  if (snapshot.protocol !== KEEL_MODULE_RESOLVER_SNAPSHOT_PROTOCOL) throw new TypeError("Unsupported Keel module resolver snapshot.");
  assertValidKeelModuleCatalog(snapshot.catalog);
  validateCatalogShape(snapshot.catalog);
  if (snapshot.display !== undefined && !Array.isArray(snapshot.display)) throw new TypeError("snapshot.display must be an array.");
  validateDisplay(snapshot);
}

export async function moduleCatalogDigest(catalog: KeelModuleCatalog): Promise<KeelModuleCatalogDigest> {
  assertValidKeelModuleCatalog(catalog);
  return catalogDigest(catalog);
}

export async function moduleSnapshotDigest(snapshot: KeelModuleResolverSnapshot): Promise<Integrity> {
  assertValidKeelModuleResolverSnapshot(snapshot);
  return digestJson(canonicalSnapshot(snapshot));
}

export async function resolveModule(
  snapshot: KeelModuleResolverSnapshot,
  selector: KeelModuleSelector,
  options: { readonly bytes?: Uint8Array } = {},
): Promise<KeelModuleResolution> {
  assertValidKeelModuleResolverSnapshot(snapshot);
  const normalized = normalizedSelector(selector);
  const catalogDigestValue = await catalogDigest(snapshot.catalog);
  const snapshotDigest = await digestJson(canonicalSnapshot(snapshot));
  const display = displayMap(snapshot);
  const candidates = snapshot.catalog.releases
    .filter((release) => matches(release, display.get(identityKey(release.identity)), normalized))
    .sort((left, right) => compareText(releaseSortKey(left), releaseSortKey(right)))
    .map((release) => candidate(release, display.get(identityKey(release.identity))));
  const context: ResolutionContext = { catalogDigest: catalogDigestValue, snapshotDigest, selector: normalized, candidates };
  if (candidates.length === 0) return { schema: "keel-module-resolution@1", status: "not-found", ...context };
  if (candidates.length > 1) return { schema: "keel-module-resolution@1", status: "ambiguous", ...context };
  const selected = candidates[0];
  if (selected === undefined) throw new Error("Resolver selected no module release.");
  const bytes = options.bytes === undefined ? undefined : new Uint8Array(options.bytes);
  if (bytes === undefined) {
    const artifacts = await lockAndReceipt(context, selected.release, selected.display, "unavailable");
    return {
      schema: "keel-module-resolution@1",
      status: "bytes-unavailable",
      ...context,
      release: selected.release,
      ...(selected.display === undefined ? {} : { display: selected.display }),
      ...artifacts,
    };
  }
  const actual = await createIntegrity(bytes, "sha256");
  const valid = await verifyIntegrity(bytes, selected.release.integrity);
  if (!valid) {
    const artifacts = await lockAndReceipt(context, selected.release, selected.display, "invalid", actual);
    return {
      schema: "keel-module-resolution@1",
      status: "bytes-invalid",
      ...context,
      release: selected.release,
      ...(selected.display === undefined ? {} : { display: selected.display }),
      expected: selected.release.integrity,
      actual,
      ...artifacts,
    };
  }
  const artifacts = await lockAndReceipt(context, selected.release, selected.display, "available", actual);
  return {
    schema: "keel-module-resolution@1",
    status: "resolved",
    ...context,
    release: selected.release,
    ...(selected.display === undefined ? {} : { display: selected.display }),
    bytes,
    ...artifacts,
  };
}
