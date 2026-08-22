import {
  KEEL_MODULE_CATALOG_PROTOCOL,
  assertValidKeelModuleCatalog,
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  type Integrity,
  type KeelCarrier,
  type KeelModuleCatalog,
  type KeelModuleFormat,
  type KeelModuleIdentity,
  type KeelModuleRelease,
} from "@keel/protocol";

export interface CreateKeelModuleReleaseInput {
  readonly identity: KeelModuleIdentity;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly format: KeelModuleFormat;
  readonly license?: string;
  readonly sourceRepository?: string;
  readonly carriers?: readonly KeelCarrier[];
}

export interface BuiltKeelModuleCatalog {
  readonly catalog: KeelModuleCatalog;
  readonly integrity: Integrity;
}

export interface KeelModuleSearchResult {
  readonly name: string;
  readonly namespace: KeelModuleIdentity["namespace"];
  readonly versions: readonly KeelModuleRelease[];
  readonly carrierKinds: readonly KeelCarrier["kind"][];
}

function releaseKey(release: KeelModuleRelease): string {
  const identity = release.identity;
  return `${identity.namespace}:${identity.name}@${identity.version}/${identity.entry}`.toLowerCase();
}

function carrierKey(carrier: KeelCarrier): string {
  if (carrier.kind === "keel") return `${carrier.kind}:${carrier.network}:${carrier.store}:${carrier.objectId}`.toLowerCase();
  if (carrier.kind === "onchfs") return `${carrier.kind}:${carrier.network}:${carrier.contract}:${carrier.cid}:${carrier.path ?? ""}`.toLowerCase();
  return `${carrier.kind}:${carrier.uri}`.toLowerCase();
}

export async function createKeelModuleRelease(input: CreateKeelModuleReleaseInput): Promise<KeelModuleRelease> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new RangeError("A Keel module release cannot be empty.");
  const integrity = await createIntegrity(input.bytes);
  const release: KeelModuleRelease = {
    identity: input.identity,
    mediaType: input.mediaType,
    format: input.format,
    integrity,
    byteLength: input.bytes.byteLength,
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.sourceRepository === undefined ? {} : { sourceRepository: input.sourceRepository }),
    carriers: [...(input.carriers ?? [])],
  };
  assertValidKeelModuleCatalog({
    protocol: KEEL_MODULE_CATALOG_PROTOCOL,
    canonicalDigest: "sha256",
    releases: [release],
  });
  return release;
}

/**
 * Merge byte-identical module declarations from Ethereum, Tezos, OnchFS, and
 * IPFS. The same name/version with different bytes fails closed instead of
 * becoming an ambiguous search result.
 */
export async function buildKeelModuleCatalog(
  releases: readonly KeelModuleRelease[],
): Promise<BuiltKeelModuleCatalog> {
  const merged = new Map<string, KeelModuleRelease>();
  for (const release of releases) {
    const key = releaseKey(release);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...release, carriers: [...release.carriers] });
      continue;
    }
    if (
      existing.integrity.algorithm !== release.integrity.algorithm ||
      existing.integrity.digest !== release.integrity.digest ||
      existing.integrity.byteLength !== release.integrity.byteLength ||
      existing.mediaType !== release.mediaType ||
      existing.format !== release.format
    ) {
      throw new Error(`Cross-chain module ${key} resolves to different bytes or formats.`);
    }
    const carriers = new Map(existing.carriers.map((item) => [carrierKey(item), item] as const));
    for (const item of release.carriers) carriers.set(carrierKey(item), item);
    merged.set(key, { ...existing, carriers: [...carriers.values()] });
  }
  const catalog: KeelModuleCatalog = {
    protocol: KEEL_MODULE_CATALOG_PROTOCOL,
    canonicalDigest: "sha256",
    releases: [...merged.values()].sort((left, right) => releaseKey(left).localeCompare(releaseKey(right), "en", { numeric: true })),
  };
  assertValidKeelModuleCatalog(catalog);
  return { catalog, integrity: await createIntegrity(utf8ToBytes(canonicalJson(catalog))) };
}

export function searchKeelModuleCatalog(
  catalog: KeelModuleCatalog,
  query: string,
): readonly KeelModuleSearchResult[] {
  assertValidKeelModuleCatalog(catalog);
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = catalog.releases.filter((release) => {
    const searchable = [
      release.identity.namespace,
      release.identity.name,
      release.identity.version,
      release.identity.entry,
      release.license ?? "",
      release.sourceRepository ?? "",
    ].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const groups = new Map<string, KeelModuleRelease[]>();
  for (const release of matches) {
    const key = `${release.identity.namespace}:${release.identity.name}`.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(release);
    groups.set(key, group);
  }
  return [...groups.values()].map((versions) => {
    versions.sort((left, right) => right.identity.version.localeCompare(left.identity.version, "en", { numeric: true }));
    const first = versions[0] as KeelModuleRelease;
    return {
      name: first.identity.name,
      namespace: first.identity.namespace,
      versions,
      carrierKinds: [...new Set(versions.flatMap((release) => release.carriers.map((carrier) => carrier.kind)))].sort(),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export function selectKeelModuleCarrier(
  release: KeelModuleRelease,
  preference: readonly KeelCarrier["kind"][] = ["keel", "onchfs", "ipfs", "https"],
): KeelCarrier | undefined {
  for (const kind of preference) {
    const match = release.carriers.find((carrier) => carrier.kind === kind);
    if (match !== undefined) return match;
  }
  return undefined;
}
