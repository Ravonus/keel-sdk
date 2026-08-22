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

export const KEEL_MODULE_RESOLVER_VERSION = "keel-module-resolver@1" as const;
export const KEEL_MODULE_LEGACY_SNAPSHOT_SCHEMA = "keel-module-resolver-catalog@1" as const;
export const KEEL_MODULE_LEGACY_LOCK_SCHEMA = "keel-module-lock@1" as const;

export interface ModuleMetadata {
  readonly releaseKey: string;
  readonly artist?: string;
  readonly tags?: readonly string[];
}

export interface LegacyModuleResolverSnapshot {
  readonly schema: typeof KEEL_MODULE_LEGACY_SNAPSHOT_SCHEMA;
  readonly catalog: KeelModuleCatalog;
  readonly metadata: readonly ModuleMetadata[];
}

export type ModuleSpecifier =
  | { readonly kind: "hash"; readonly digest: Hex; readonly byteLength: number }
  | {
      readonly kind: "query";
      readonly name: string;
      readonly namespace?: KeelModuleIdentity["namespace"];
      readonly version?: string;
      readonly entry?: string;
      readonly artist?: string;
      readonly tags?: readonly string[];
    };

export interface ModuleResolution {
  readonly status: "resolved" | "not-found" | "ambiguous";
  readonly catalogIntegrity: Integrity;
  readonly specifier: ModuleSpecifier;
  readonly candidates: readonly string[];
  readonly releaseKey?: string;
  readonly release?: KeelModuleRelease;
  readonly metadata?: ModuleMetadata;
  readonly selectedCarrier?: KeelCarrier;
  /** Resolver selection never fetched a carrier; bytes are unavailable until supplied separately. */
  readonly bytes?: "unavailable";
  readonly message?: string;
}

export interface ModuleLockResolution {
  readonly releaseKey: string;
  readonly identity: KeelModuleIdentity;
  readonly mediaType: string;
  readonly format: KeelModuleRelease["format"];
  readonly integrity: Integrity;
  readonly byteLength: number;
  readonly selectedCarrier?: KeelCarrier;
}

export interface ModuleLock {
  readonly schema: typeof KEEL_MODULE_LEGACY_LOCK_SCHEMA;
  readonly resolverVersion: typeof KEEL_MODULE_RESOLVER_VERSION;
  readonly catalogIntegrity: Integrity;
  readonly requests: readonly ModuleSpecifier[];
  readonly resolutions: readonly ModuleLockResolution[];
}

export interface ModuleLockEnvelope {
  readonly lock: ModuleLock;
  readonly integrity: Integrity;
}

export interface ModuleLockVerification {
  readonly valid: boolean;
  readonly lockIntegrity: Integrity;
  readonly issues: readonly string[];
}

const MAX_TEXT = 256;
const MAX_TAGS = 32;
const carrierRank: Record<KeelCarrier["kind"], number> = { keel: 0, onchfs: 1, ipfs: 2, https: 3 };

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} is invalid.`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0xd800 && code <= 0xdbff && !(value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff)) || (code >= 0xdc00 && code <= 0xdfff)) throw new TypeError(`${label} contains invalid Unicode.`);
  }
  return value;
}

function safeEntry(value: unknown, label: string): string {
  const entry = text(value, label);
  if (entry.startsWith("/") || entry.endsWith("/") || entry.includes("\\") || entry.includes("//") || entry.split("/").some((part) => part === "." || part === "..")) throw new TypeError(`${label} must be a safe relative path.`);
  return entry;
}

function identity(value: unknown, label: string): KeelModuleIdentity {
  const input = record(value, label);
  keys(input, ["namespace", "name", "version", "entry"], label);
  if (input.namespace !== "npm" && input.namespace !== "keel" && input.namespace !== "github") throw new TypeError(`${label}.namespace is unsupported.`);
  return { namespace: input.namespace, name: text(input.name, `${label}.name`), version: text(input.version, `${label}.version`), entry: safeEntry(input.entry, `${label}.entry`) };
}

function releaseKeyOf(value: KeelModuleRelease | KeelModuleIdentity): string {
  const item = "identity" in value ? value.identity : value;
  return `${item.namespace}:${item.name}@${item.version}/${item.entry}`.toLowerCase();
}

function sortedCarrier(value: KeelCarrier): string { return canonicalJson(value); }

function normalizeRelease(value: KeelModuleRelease): KeelModuleRelease {
  return {
    ...value,
    identity: { ...value.identity },
    integrity: { ...value.integrity },
    carriers: [...value.carriers].sort((left, right) => {
      const rank = carrierRank[left.kind] - carrierRank[right.kind];
      return rank !== 0 ? rank : sortedCarrier(left) < sortedCarrier(right) ? -1 : sortedCarrier(left) > sortedCarrier(right) ? 1 : 0;
    }),
  };
}

function normalizeCatalog(value: KeelModuleCatalog): KeelModuleCatalog {
  return {
    protocol: value.protocol,
    canonicalDigest: value.canonicalDigest,
    releases: [...value.releases].map(normalizeRelease).sort((left, right) => releaseKeyOf(left).localeCompare(releaseKeyOf(right), "en")),
  };
}

function metadata(value: unknown, label: string): ModuleMetadata {
  const input = record(value, label);
  keys(input, ["releaseKey", "artist", "tags"], label);
  const result: ModuleMetadata = {
    releaseKey: text(input.releaseKey, `${label}.releaseKey`),
    ...(input.artist === undefined ? {} : { artist: text(input.artist, `${label}.artist`, 128) }),
    ...(input.tags === undefined ? {} : { tags: tags(input.tags, `${label}.tags`) }),
  };
  return result;
}

function tags(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw new RangeError(`${label} must contain at most ${MAX_TAGS} tags.`);
  const output = value.map((item, index) => text(item, `${label}[${index}]`, 64));
  const seen = new Set(output.map((item) => item.toLowerCase()));
  if (seen.size !== output.length) throw new TypeError(`${label} must contain unique tags.`);
  return [...output].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalSnapshot(value: LegacyModuleResolverSnapshot): LegacyModuleResolverSnapshot {
  return { schema: value.schema, catalog: normalizeCatalog(value.catalog), metadata: [...value.metadata].map((item) => ({ ...item, ...(item.tags === undefined ? {} : { tags: [...item.tags] }) })).sort((left, right) => left.releaseKey.toLowerCase().localeCompare(right.releaseKey.toLowerCase(), "en")) };
}

function validateSnapshot(value: unknown): LegacyModuleResolverSnapshot {
  const input = record(value, "module resolver snapshot");
  keys(input, ["schema", "catalog", "metadata"], "module resolver snapshot");
  if (input.schema !== KEEL_MODULE_LEGACY_SNAPSHOT_SCHEMA) throw new TypeError("Unsupported module resolver snapshot.");
  const rawCatalog = record(input.catalog, "snapshot.catalog");
  assertValidKeelModuleCatalog(rawCatalog as unknown as KeelModuleCatalog);
  const catalog = normalizeCatalog(rawCatalog as unknown as KeelModuleCatalog);
  const seenRelease = new Set<string>();
  for (const [index, release] of catalog.releases.entries()) {
    const id = identity(release.identity, `catalog.releases[${index}].identity`);
    if (releaseKeyOf(id) !== releaseKeyOf(release)) throw new TypeError(`catalog.releases[${index}] identity is invalid.`);
    if (seenRelease.has(releaseKeyOf(release))) throw new TypeError(`Duplicate module release ${releaseKeyOf(release)}.`);
    seenRelease.add(releaseKeyOf(release));
    const releaseInput = record(release, `catalog.releases[${index}]`);
    keys(releaseInput, ["identity", "mediaType", "format", "integrity", "byteLength", "license", "sourceRepository", "carriers"], `catalog.releases[${index}]`);
    text(release.mediaType, `catalog.releases[${index}].mediaType`, 255);
    text(release.format, `catalog.releases[${index}].format`, 64);
  }
  if (!Array.isArray(input.metadata)) throw new TypeError("snapshot.metadata must be an array.");
  const metadataValues = input.metadata.map((item, index) => metadata(item, `snapshot.metadata[${index}]`));
  const metadataKeys = new Set<string>();
  for (const item of metadataValues) {
    const key = item.releaseKey.toLowerCase();
    if (!seenRelease.has(key)) throw new TypeError(`Metadata names unknown release ${item.releaseKey}.`);
    if (metadataKeys.has(key)) throw new TypeError(`Duplicate metadata release key ${item.releaseKey}.`);
    metadataKeys.add(key);
  }
  return canonicalSnapshot({ schema: KEEL_MODULE_LEGACY_SNAPSHOT_SCHEMA, catalog, metadata: metadataValues });
}

export function createKeelModuleResolverSnapshot(catalog: KeelModuleCatalog, display: readonly ModuleMetadata[] = []): LegacyModuleResolverSnapshot {
  return validateSnapshot({ schema: KEEL_MODULE_LEGACY_SNAPSHOT_SCHEMA, catalog, metadata: display });
}

export function parseKeelModuleResolverSnapshot(value: unknown): LegacyModuleResolverSnapshot { return validateSnapshot(value); }

function normalizeSpecifier(value: ModuleSpecifier): ModuleSpecifier {
  const input = record(value, "module selector");
  if (input.kind === "hash") {
    keys(input, ["kind", "digest", "byteLength"], "hash selector");
    if (typeof input.digest !== "string" || !/^0x[0-9a-f]{64}$/u.test(input.digest) || !Number.isSafeInteger(input.byteLength) || (input.byteLength as number) <= 0) throw new TypeError("Hash selector requires lower-case SHA-256 and positive byteLength.");
    return { kind: "hash", digest: input.digest as Hex, byteLength: input.byteLength as number };
  }
  if (input.kind !== "query") throw new TypeError("module selector.kind is unsupported.");
  keys(input, ["kind", "name", "namespace", "version", "entry", "artist", "tags"], "query selector");
  const result: ModuleSpecifier = {
    kind: "query",
    name: text(input.name, "query.name").toLowerCase(),
    ...(input.namespace === undefined ? {} : { namespace: input.namespace as KeelModuleIdentity["namespace"] }),
    ...(input.version === undefined ? {} : { version: text(input.version, "query.version").toLowerCase() }),
    ...(input.entry === undefined ? {} : { entry: safeEntry(input.entry, "query.entry").toLowerCase() }),
    ...(input.artist === undefined ? {} : { artist: text(input.artist, "query.artist", 128).toLowerCase() }),
    ...(input.tags === undefined ? {} : { tags: tags(input.tags, "query.tags").map((item) => item.toLowerCase()) }),
  };
  if (result.namespace !== undefined && result.namespace !== "npm" && result.namespace !== "keel" && result.namespace !== "github") throw new TypeError("query.namespace is unsupported.");
  return result;
}

function catalogIntegrity(snapshot: LegacyModuleResolverSnapshot): Promise<Integrity> { return createIntegrity(new TextEncoder().encode(canonicalJson(normalizeCatalog(snapshot.catalog)))); }

function displayFor(snapshot: LegacyModuleResolverSnapshot, release: KeelModuleRelease): ModuleMetadata | undefined {
  return snapshot.metadata.find((item) => item.releaseKey.toLowerCase() === releaseKeyOf(release));
}

function matches(release: KeelModuleRelease, display: ModuleMetadata | undefined, selector: ModuleSpecifier): boolean {
  if (selector.kind === "hash") return release.integrity.digest === selector.digest && release.byteLength === selector.byteLength;
  const id = release.identity;
  if (id.name.toLowerCase() !== selector.name) return false;
  if (selector.namespace !== undefined && id.namespace !== selector.namespace) return false;
  if (selector.version !== undefined && id.version.toLowerCase() !== selector.version) return false;
  if (selector.entry !== undefined && id.entry.toLowerCase() !== selector.entry) return false;
  if (selector.artist !== undefined && !(display?.artist?.toLowerCase().includes(selector.artist))) return false;
  if (selector.tags !== undefined && selector.tags.some((tag) => !(display?.tags ?? []).some((candidate) => candidate.toLowerCase() === tag))) return false;
  return true;
}

function preferredCarrier(release: KeelModuleRelease): KeelCarrier | undefined {
  return [...release.carriers].sort((left, right) => {
    const rank = carrierRank[left.kind] - carrierRank[right.kind];
    return rank !== 0 ? rank : sortedCarrier(left) < sortedCarrier(right) ? -1 : sortedCarrier(left) > sortedCarrier(right) ? 1 : 0;
  })[0];
}

export async function resolveKeelModule(snapshotValue: LegacyModuleResolverSnapshot, selectorValue: ModuleSpecifier): Promise<ModuleResolution> {
  const snapshot = validateSnapshot(snapshotValue);
  const selector = normalizeSpecifier(selectorValue);
  const integrity = await catalogIntegrity(snapshot);
  const matchesFound = snapshot.catalog.releases.filter((release) => matches(release, displayFor(snapshot, release), selector));
  const candidates = matchesFound.map(releaseKeyOf).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (matchesFound.length === 0) return { status: "not-found", catalogIntegrity: integrity, specifier: selector, candidates };
  if (matchesFound.length !== 1) return { status: "ambiguous", catalogIntegrity: integrity, specifier: selector, candidates, message: "multiple module releases match the selector" };
  const release = matchesFound[0] as KeelModuleRelease;
  const display = displayFor(snapshot, release);
  const carrier = preferredCarrier(release);
  return { status: "resolved", catalogIntegrity: integrity, specifier: selector, candidates, releaseKey: releaseKeyOf(release), release, ...(display === undefined ? {} : { metadata: display }), ...(carrier === undefined ? {} : { selectedCarrier: carrier }), bytes: "unavailable" };
}

function sameIntegrity(left: Integrity, right: Integrity): boolean { return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength; }

function parseIntegrity(value: unknown, label: string): Integrity {
  const input = record(value, label);
  keys(input, ["algorithm", "digest", "byteLength"], label);
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !/^0x[0-9a-f]{64}$/u.test(input.digest) || !Number.isSafeInteger(input.byteLength) || (input.byteLength as number) <= 0) throw new TypeError(`${label} is invalid.`);
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: input.byteLength as number };
}

export async function verifyKeelModuleBytes(value: KeelModuleRelease | ModuleLockResolution, bytes: Uint8Array): Promise<"verified" | "mismatch"> {
  return await verifyIntegrity(bytes, value.integrity) ? "verified" : "mismatch";
}

export async function createKeelModuleLock(snapshotValue: LegacyModuleResolverSnapshot, selectors: readonly ModuleSpecifier[]): Promise<ModuleLockEnvelope> {
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 64) throw new RangeError("A module lock needs 1 through 64 selectors.");
  const snapshot = validateSnapshot(snapshotValue);
  const catalogDigest = await catalogIntegrity(snapshot);
  const requests: ModuleSpecifier[] = [];
  const resolutions: ModuleLockResolution[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    const result = await resolveKeelModule(snapshot, selector);
    if (result.status !== "resolved" || result.release === undefined || result.releaseKey === undefined) throw new Error(`Cannot lock module selector: ${result.status}; multiple or unavailable candidates (${result.candidates.join(", ")}).`);
    if (seen.has(result.releaseKey)) throw new Error(`Module lock contains duplicate release ${result.releaseKey}.`);
    seen.add(result.releaseKey);
    requests.push(result.specifier);
    resolutions.push({ releaseKey: result.releaseKey, identity: { ...result.release.identity }, mediaType: result.release.mediaType, format: result.release.format, integrity: { ...result.release.integrity }, byteLength: result.release.byteLength, ...(result.selectedCarrier === undefined ? {} : { selectedCarrier: result.selectedCarrier }) });
  }
  const lock: ModuleLock = { schema: KEEL_MODULE_LEGACY_LOCK_SCHEMA, resolverVersion: KEEL_MODULE_RESOLVER_VERSION, catalogIntegrity: catalogDigest, requests, resolutions };
  return { lock, integrity: await createIntegrity(new TextEncoder().encode(canonicalJson(lock))) };
}

function parseLock(value: unknown): ModuleLockEnvelope {
  const envelope = record(value, "module lock envelope");
  keys(envelope, ["lock", "integrity"], "module lock envelope");
  const lockValue = record(envelope.lock, "module lock");
  keys(lockValue, ["schema", "resolverVersion", "catalogIntegrity", "requests", "resolutions"], "module lock");
  if (lockValue.schema !== KEEL_MODULE_LEGACY_LOCK_SCHEMA || lockValue.resolverVersion !== KEEL_MODULE_RESOLVER_VERSION || !Array.isArray(lockValue.requests) || !Array.isArray(lockValue.resolutions)) throw new TypeError("Unsupported module lock.");
  const requests = lockValue.requests.map((item) => normalizeSpecifier(item as ModuleSpecifier));
  const resolutions = lockValue.resolutions.map((item, index) => {
    const input = record(item, `module lock resolutions[${index}]`);
    keys(input, ["releaseKey", "identity", "mediaType", "format", "integrity", "byteLength", "selectedCarrier"], `module lock resolutions[${index}]`);
    const id = identity(input.identity, `module lock resolutions[${index}].identity`);
    if (!Number.isSafeInteger(input.byteLength) || (input.byteLength as number) <= 0 || typeof input.mediaType !== "string" || typeof input.format !== "string") throw new TypeError("module lock resolution has invalid fields.");
    const result: ModuleLockResolution = { releaseKey: text(input.releaseKey, `module lock resolutions[${index}].releaseKey`), identity: id, mediaType: input.mediaType, format: input.format as KeelModuleRelease["format"], integrity: parseIntegrity(input.integrity, `module lock resolutions[${index}].integrity`), byteLength: input.byteLength as number, ...(input.selectedCarrier === undefined ? {} : { selectedCarrier: input.selectedCarrier as KeelCarrier }) };
    return result;
  });
  const lock: ModuleLock = { schema: KEEL_MODULE_LEGACY_LOCK_SCHEMA, resolverVersion: KEEL_MODULE_RESOLVER_VERSION, catalogIntegrity: parseIntegrity(lockValue.catalogIntegrity, "module lock.catalogIntegrity"), requests, resolutions };
  return { lock, integrity: parseIntegrity(envelope.integrity, "module lock envelope.integrity") };
}

export async function verifyKeelModuleLock(snapshotValue: LegacyModuleResolverSnapshot, envelope: ModuleLockEnvelope): Promise<ModuleLockVerification> {
  const issues: string[] = [];
  let parsed: ModuleLockEnvelope;
  try { parsed = parseLock(envelope); } catch (error) { const fallback = await createIntegrity(new Uint8Array()); return { valid: false, lockIntegrity: fallback, issues: [error instanceof Error ? error.message : String(error)] }; }
  let actual: Integrity;
  try { actual = await createIntegrity(new TextEncoder().encode(canonicalJson(parsed.lock))); } catch (error) {
    const fallback = await createIntegrity(new Uint8Array());
    return { valid: false, lockIntegrity: fallback, issues: [error instanceof Error ? error.message : String(error)] };
  }
  if (!sameIntegrity(actual, parsed.integrity)) issues.push("lock integrity does not match canonical lock bytes");
  let snapshot: LegacyModuleResolverSnapshot;
  try { snapshot = validateSnapshot(snapshotValue); } catch (error) {
    return { valid: false, lockIntegrity: actual, issues: [error instanceof Error ? error.message : String(error)] };
  }
  const catalog = await catalogIntegrity(snapshot);
  if (!sameIntegrity(catalog, parsed.lock.catalogIntegrity)) issues.push("lock catalog integrity does not match snapshot");
  if (parsed.lock.requests.length !== parsed.lock.resolutions.length) issues.push("lock requests and resolutions must have equal length");
  const seen = new Set<string>();
  for (let index = 0; index < parsed.lock.requests.length; index += 1) {
    const expected = parsed.lock.resolutions[index];
    if (expected === undefined) continue;
    const result = await resolveKeelModule(snapshot, parsed.lock.requests[index] as ModuleSpecifier);
    if (result.status !== "resolved" || result.release === undefined || result.releaseKey !== expected.releaseKey) { issues.push(`lock resolution ${index} no longer matches snapshot`); continue; }
    if (seen.has(expected.releaseKey)) issues.push(`lock contains duplicate release ${expected.releaseKey}`);
    seen.add(expected.releaseKey);
    if (expected.mediaType !== result.release.mediaType || expected.format !== result.release.format || expected.byteLength !== result.release.byteLength || !sameIntegrity(expected.integrity, result.release.integrity)) issues.push(`lock resolution ${index} release commitment changed`);
  }
  return { valid: issues.length === 0, lockIntegrity: actual, issues };
}
