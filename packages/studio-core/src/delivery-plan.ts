import type { Integrity } from "@keel/protocol";

import type { BuiltKeelDirectory, BuiltKeelStorageGraph } from "./keel-hold.js";

export const KEEL_DELIVERY_PLAN_PROTOCOL = "keel-delivery-plan@1" as const;

export interface KeelMeasuredReadProfile {
  readonly protocol: "keel-measured-read-profile@1";
  readonly network: string;
  readonly contract: string;
  readonly reader: "onchfs-compatible-view@1";
  readonly measuredAt: string;
  readonly pinnedBlock: string;
  readonly maxFileBytes: number;
  readonly maxDirectoryBytes: number;
  readonly maxFiles: number;
  readonly evidenceDigest: `0x${string}`;
}

export interface KeelDeliveryPlan {
  readonly protocol: typeof KEEL_DELIVERY_PLAN_PROTOCOL;
  readonly storageGraph: Integrity;
  readonly directory: Integrity;
  readonly metrics: {
    readonly files: number;
    readonly totalBytes: number;
    readonly largestFileBytes: number;
  };
  readonly canonical: "keel";
  readonly recommended: "onchfs" | "ipfs" | "keel";
  readonly onchfs: {
    readonly eligible: boolean;
    readonly profile?: KeelMeasuredReadProfile;
    readonly blockers: readonly string[];
  };
  readonly ipfs: { readonly enabled: boolean; readonly kind: "verified-module-directory" };
  readonly zip: { readonly enabled: boolean; readonly kind: "generated-compatibility-only" };
}

function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
}

export function assertValidKeelMeasuredReadProfile(value: KeelMeasuredReadProfile): void {
  if (value.protocol !== "keel-measured-read-profile@1" || value.reader !== "onchfs-compatible-view@1") throw new TypeError("Unsupported Keel measured read profile.");
  if (value.network.length === 0 || value.contract.length === 0 || value.pinnedBlock.length === 0) throw new TypeError("Measured read profile is missing its exact chain target.");
  if (Number.isNaN(Date.parse(value.measuredAt))) throw new TypeError("Measured read profile needs an ISO-compatible measuredAt time.");
  positive(value.maxFileBytes, "maxFileBytes");
  positive(value.maxDirectoryBytes, "maxDirectoryBytes");
  positive(value.maxFiles, "maxFiles");
  if (!/^0x[0-9a-f]{64}$/u.test(value.evidenceDigest)) throw new TypeError("Measured read evidence digest must be lower-case SHA-256 bytes32.");
}

/**
 * Select delivery projections without turning any projection into storage.
 * OnchFS eligibility is never guessed: it requires a pinned measured profile.
 */
export function planKeelDelivery(input: {
  readonly storage: BuiltKeelStorageGraph;
  readonly directory: BuiltKeelDirectory;
  readonly onchfsProfile?: KeelMeasuredReadProfile;
  readonly ipfsAvailable: boolean;
  readonly generateZipCompatibility?: boolean;
}): KeelDeliveryPlan {
  if (input.onchfsProfile !== undefined) assertValidKeelMeasuredReadProfile(input.onchfsProfile);
  const totalBytes = input.directory.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const largestFileBytes = input.directory.files.reduce((largest, file) => Math.max(largest, file.bytes.byteLength), 0);
  const blockers: string[] = [];
  if (input.onchfsProfile === undefined) blockers.push("No pinned measured OnchFS-compatible read profile is configured.");
  else {
    if (input.directory.files.length > input.onchfsProfile.maxFiles) blockers.push(`Directory has ${input.directory.files.length} files; measured limit is ${input.onchfsProfile.maxFiles}.`);
    if (totalBytes > input.onchfsProfile.maxDirectoryBytes) blockers.push(`Directory has ${totalBytes} bytes; measured limit is ${input.onchfsProfile.maxDirectoryBytes}.`);
    if (largestFileBytes > input.onchfsProfile.maxFileBytes) blockers.push(`Largest file has ${largestFileBytes} bytes; measured limit is ${input.onchfsProfile.maxFileBytes}.`);
  }
  const onchfsEligible = blockers.length === 0;
  const recommended = onchfsEligible ? "onchfs" : input.ipfsAvailable ? "ipfs" : "keel";
  return {
    protocol: KEEL_DELIVERY_PLAN_PROTOCOL,
    storageGraph: input.storage.integrity,
    directory: input.directory.integrity,
    metrics: { files: input.directory.files.length, totalBytes, largestFileBytes },
    canonical: "keel",
    recommended,
    onchfs: {
      eligible: onchfsEligible,
      ...(input.onchfsProfile === undefined ? {} : { profile: input.onchfsProfile }),
      blockers,
    },
    ipfs: { enabled: input.ipfsAvailable, kind: "verified-module-directory" },
    zip: { enabled: input.generateZipCompatibility === true, kind: "generated-compatibility-only" },
  };
}
