export const KEEL_DRAFT_ANNUAL_QUOTA_BYTES = 500_000_000;
export const KEEL_IPFS_BASE_TIER_BYTES = 500_000_000;
export const KEEL_IPFS_MINIMUM_TIER_BYTES = 25_000_000;
export const KEEL_IPFS_MINIMUM_USD_CENTS = 200;
export const KEEL_IPFS_BASE_TIER_USD_CENTS = 2_000;
export const KEEL_IPFS_PIN_TERM_SECONDS = 2 * 365 * 24 * 60 * 60;

export type KeelIpfsFunding =
  | { readonly mode: "not-pinned" }
  | { readonly mode: "keel-paid" }
  | { readonly mode: "drop-proceeds"; readonly maximumUsdCents: number }
  | { readonly mode: "creator-provider"; readonly providerId: string; readonly credentialRef: string };

export interface KeelStudioPublicationIntent {
  readonly schema: "keel-studio-publication-intent@1";
  readonly viewer: {
    readonly mode: "keel-sandbox";
    readonly required: true;
    readonly verifyManifest: true;
    readonly verifyChunks: true;
  };
  readonly draftStorage: {
    readonly provider: "keel-socket-local";
    readonly persistence: "temporary-unpinned";
    readonly annualQuotaBytes: 500_000_000;
  };
  readonly ipfs: KeelIpfsFunding;
}

export interface KeelIpfsVerifiedReceipt {
  readonly schema: "keel-ipfs-verified-receipt@1";
  readonly cid: string;
  readonly requestDigest: `0x${string}`;
  readonly manifestDigest: `0x${string}`;
  readonly verifiedChunkDigests: readonly `0x${string}`[];
  readonly pin: {
    readonly providerId: string;
    readonly fundedBy: "creator" | "drop-proceeds";
    readonly startsAt: string;
    readonly expiresAt: string;
    readonly billedBytes: number;
    readonly priceUsdCents: number;
  };
}

/**
 * Provider boundary for either KEEL-managed IPFS or a creator's own pinning
 * service. Credentials stay behind the adapter and are never serialized into
 * a Studio handoff or onchain publication plan.
 */
export interface KeelIpfsPinningProvider {
  readonly id: string;
  pin(input: {
    readonly requestDigest: `0x${string}`;
    readonly manifestDigest: `0x${string}`;
    readonly files: readonly { readonly path: string; readonly bytes: Uint8Array; readonly digest: `0x${string}` }[];
    readonly fundedBy: "creator" | "drop-proceeds";
  }): Promise<KeelIpfsVerifiedReceipt>;
}

export function defaultKeelStudioPublicationIntent(ipfs: KeelIpfsFunding = { mode: "not-pinned" }): KeelStudioPublicationIntent {
  if (ipfs.mode === "creator-provider" && (ipfs.providerId.trim() === "" || ipfs.credentialRef.trim() === "")) {
    throw new TypeError("Creator IPFS pinning requires a provider ID and a non-secret credential reference.");
  }
  const intent: KeelStudioPublicationIntent = {
    schema: "keel-studio-publication-intent@1",
    viewer: { mode: "keel-sandbox", required: true, verifyManifest: true, verifyChunks: true },
    draftStorage: { provider: "keel-socket-local", persistence: "temporary-unpinned", annualQuotaBytes: KEEL_DRAFT_ANNUAL_QUOTA_BYTES },
    ipfs,
  };
  return Object.freeze(intent);
}

export function keelIpfsOffer(byteLength: number, funding: KeelIpfsFunding): {
  readonly requiresImmediatePayment: boolean;
  readonly reserveFromDropProceeds: boolean;
  readonly priceUsdCents: number;
  readonly termSeconds: number;
  readonly minimumTierBytes: number;
  readonly baseTierBytes: number;
  readonly overageBytes: number;
} {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new RangeError("IPFS byte length must be a non-negative safe integer.");
  const ceilDivide = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;
  const bytes = BigInt(byteLength);
  const minimumBytes = BigInt(KEEL_IPFS_MINIMUM_TIER_BYTES);
  const baseBytes = BigInt(KEEL_IPFS_BASE_TIER_BYTES);
  const scalingBytes = baseBytes - minimumBytes;
  const baseVariableCents = BigInt(KEEL_IPFS_BASE_TIER_USD_CENTS - KEEL_IPFS_MINIMUM_USD_CENTS);
  const priceUsdCents = bytes <= minimumBytes
    ? KEEL_IPFS_MINIMUM_USD_CENTS
    : bytes <= baseBytes
      ? KEEL_IPFS_MINIMUM_USD_CENTS + Number(ceilDivide((bytes - minimumBytes) * baseVariableCents, scalingBytes))
      : KEEL_IPFS_BASE_TIER_USD_CENTS + Number(ceilDivide((bytes - baseBytes) * baseVariableCents * 2n, scalingBytes));
  return {
    requiresImmediatePayment: funding.mode === "keel-paid",
    reserveFromDropProceeds: funding.mode === "drop-proceeds",
    priceUsdCents,
    termSeconds: KEEL_IPFS_PIN_TERM_SECONDS,
    minimumTierBytes: KEEL_IPFS_MINIMUM_TIER_BYTES,
    baseTierBytes: KEEL_IPFS_BASE_TIER_BYTES,
    overageBytes: Math.max(0, byteLength - KEEL_IPFS_BASE_TIER_BYTES),
  };
}
