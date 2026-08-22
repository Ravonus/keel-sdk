export type KeelFacetVerdict = "unknown" | "green" | "amber" | "red";
export type KeelProofClass = "native-proof" | "adapter-proof" | "content-only" | "attested-proof";

export interface KeelFacetEvidence {
  readonly verdict: KeelFacetVerdict;
  readonly authority?: `0x${string}`;
  readonly timelock?: `0x${string}`;
  readonly reason: string;
}

export interface KeelCollectionVerificationProfile {
  readonly proofClass: KeelProofClass;
  readonly chainId: bigint;
  readonly collection: `0x${string}`;
  readonly tokenId: bigint;
  readonly runtimeCodeHash: `0x${string}`;
  readonly implementationCodeHash: `0x${string}`;
  readonly evidenceBlock: bigint;
  readonly evidenceBlockHash: `0x${string}`;
  readonly evidenceRoot: `0x${string}`;
  readonly policyId: `0x${string}`;
  readonly policyVersion: bigint;
  readonly expiresAt: bigint;
  readonly revoked: boolean;
  readonly tokenURIHash: `0x${string}`;
  readonly resolver: `0x${string}`;
  readonly keelIndex: `0x${string}`;
  readonly presentationScope: bigint;
  readonly presentationRevision: bigint;
  readonly portableRoot: `0x${string}`;
  readonly portableAnchorRoot: `0x${string}`;
  readonly presentationContentDigest: `0x${string}`;
  readonly manifestDigest: `0x${string}`;
  readonly revisionLineageRoot: `0x${string}`;
  readonly currentSupply: bigint | null;
  readonly lifetimeMinted: bigint | null;
  readonly burnedCount: bigint | null;
  readonly remainingMintable: bigint | null;
  readonly maxSupply: bigint | null;
  readonly reservedSupply: bigint | null;
  readonly supplyKnownFlags: number;
  readonly maxSupplyKind: number | null;
  readonly burnPolicy: number | null;
  readonly mintStatus: number;
  readonly mintAuthoritiesRoot: `0x${string}`;
  readonly mintAuthorityCount: number;
  readonly implementation: `0x${string}`;
  readonly proxyAdmin: `0x${string}`;
  readonly beacon: `0x${string}`;
  readonly facets: Readonly<{
    route: KeelFacetEvidence;
    content: KeelFacetEvidence;
    governance: KeelFacetEvidence;
    mint: KeelFacetEvidence;
    supply: KeelFacetEvidence;
    upgrade: KeelFacetEvidence;
  }>;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const BYTES32 = /^0x[0-9a-f]{64}$/u;

function address(value: string, label: string): `0x${string}` {
  if (!ADDRESS.test(value)) throw new TypeError(`${label} must be a lower-case address.`);
  return value as `0x${string}`;
}

function bytes32(value: string, label: string): `0x${string}` {
  if (!BYTES32.test(value)) throw new TypeError(`${label} must be lower-case bytes32.`);
  return value as `0x${string}`;
}

function natural(value: bigint, label: string): bigint {
  if (value < 0n) throw new RangeError(`${label} cannot be negative.`);
  return value;
}

function validateFacet(value: KeelFacetEvidence, label: string): KeelFacetEvidence {
  if (!["unknown", "green", "amber", "red"].includes(value.verdict)) {
    throw new TypeError(`${label}.verdict is unsupported.`);
  }
  if (value.reason.trim().length === 0) throw new TypeError(`${label}.reason is required.`);
  if (value.authority !== undefined) address(value.authority, `${label}.authority`);
  if (value.timelock !== undefined) address(value.timelock, `${label}.timelock`);
  if (value.verdict === "amber" && value.authority === undefined && value.timelock === undefined) {
    throw new TypeError(`${label} amber must identify an authority or timelock.`);
  }
  return Object.freeze({ ...value });
}

export function validateKeelCollectionVerificationProfile(
  input: KeelCollectionVerificationProfile,
): KeelCollectionVerificationProfile {
  if (!["native-proof", "adapter-proof", "content-only", "attested-proof"].includes(input.proofClass)) {
    throw new TypeError("proofClass is unsupported.");
  }
  natural(input.chainId, "chainId");
  natural(input.tokenId, "tokenId");
  natural(input.evidenceBlock, "evidenceBlock");
  natural(input.policyVersion, "policyVersion");
  natural(input.expiresAt, "expiresAt");
  natural(input.presentationScope, "presentationScope");
  natural(input.presentationRevision, "presentationRevision");
  for (const [label, value] of Object.entries({
    currentSupply: input.currentSupply,
    lifetimeMinted: input.lifetimeMinted,
    burnedCount: input.burnedCount,
    remainingMintable: input.remainingMintable,
    maxSupply: input.maxSupply,
    reservedSupply: input.reservedSupply,
  })) if (value !== null) natural(value, label);
  if (!Number.isInteger(input.supplyKnownFlags) || input.supplyKnownFlags < 0 || input.supplyKnownFlags > 0xffff) {
    throw new RangeError("supplyKnownFlags must be uint16.");
  }
  const supplyValues = [input.currentSupply, input.lifetimeMinted, input.burnedCount, input.maxSupply, input.reservedSupply, input.remainingMintable];
  for (let bit = 0; bit < supplyValues.length; bit += 1) {
    if (((input.supplyKnownFlags >>> bit) & 1) !== Number(supplyValues[bit] !== null)) {
      throw new TypeError(`Supply known flag ${bit} does not match its value.`);
    }
  }
  address(input.collection, "collection");
  address(input.resolver, "resolver");
  address(input.keelIndex, "keelIndex");
  address(input.implementation, "implementation");
  address(input.proxyAdmin, "proxyAdmin");
  address(input.beacon, "beacon");
  for (const [label, value] of Object.entries({
    runtimeCodeHash: input.runtimeCodeHash,
    implementationCodeHash: input.implementationCodeHash,
    evidenceBlockHash: input.evidenceBlockHash,
    evidenceRoot: input.evidenceRoot,
    policyId: input.policyId,
    tokenURIHash: input.tokenURIHash,
    portableRoot: input.portableRoot,
    portableAnchorRoot: input.portableAnchorRoot,
    presentationContentDigest: input.presentationContentDigest,
    manifestDigest: input.manifestDigest,
    revisionLineageRoot: input.revisionLineageRoot,
    mintAuthoritiesRoot: input.mintAuthoritiesRoot,
  })) bytes32(value, label);
  if (input.proofClass === "content-only") {
    for (const facet of [input.facets.route, input.facets.governance, input.facets.mint, input.facets.supply, input.facets.upgrade]) {
      if (facet.verdict !== "unknown") {
        throw new TypeError("Content-only verification cannot infer collection-control facets.");
      }
    }
  }
  if (input.facets.route.verdict === "green" && input.facets.content.verdict !== "green") {
    throw new TypeError("A green Keel route requires verified current content.");
  }
  const facets = Object.freeze({
    route: validateFacet(input.facets.route, "route"),
    content: validateFacet(input.facets.content, "content"),
    governance: validateFacet(input.facets.governance, "governance"),
    mint: validateFacet(input.facets.mint, "mint"),
    supply: validateFacet(input.facets.supply, "supply"),
    upgrade: validateFacet(input.facets.upgrade, "upgrade"),
  });
  return Object.freeze({ ...input, facets });
}

export function keelCollectorSummary(profile: KeelCollectionVerificationProfile): string {
  const value = validateKeelCollectionVerificationProfile(profile);
  const route = value.facets.route.verdict === "green"
    ? "Keel route locked"
    : value.facets.route.verdict === "amber"
      ? `Keel route redirectable by ${value.facets.route.authority ?? value.facets.route.timelock}`
      : "Keel route not verifiable";
  const supply = value.facets.supply.verdict === "green"
    ? `supply capped at ${value.maxSupply ?? "a verified contract cap"}`
    : value.facets.supply.verdict === "amber"
      ? `supply expandable by ${value.facets.supply.authority ?? value.facets.supply.timelock}`
      : "supply not verifiable";
  return `${route} / Current revision r${value.presentationRevision} verified / ${supply}`;
}

export const KEEL_CUSTOM_CONTRACT_UNVERIFIED_REASON =
  "Not verifiable — this custom contract does not expose an approved Keel hook or adapter." as const;

export const KEEL_ZERO_ADDRESS = ZERO_ADDRESS as `0x${string}`;
