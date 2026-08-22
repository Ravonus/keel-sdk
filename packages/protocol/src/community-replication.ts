export const KEEL_COMMUNITY_REPLICATION_PREFERENCE_PROTOCOL =
  "keel-community-replication-preference@1" as const;

export const KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY =
  "keel:community-replication" as const;

export const KEEL_COMMUNITY_REPLICATION_CARRIERS = [
  "evm",
  "tezos",
  "ordinals",
] as const;

export const KEEL_COMMUNITY_REPLICATION_MIN_LEASE_SECONDS = 5 * 60;
export const KEEL_COMMUNITY_REPLICATION_MAX_LEASE_SECONDS = 7 * 24 * 60 * 60;

export type KeelCommunityReplicationCarrier =
  (typeof KEEL_COMMUNITY_REPLICATION_CARRIERS)[number];

/**
 * Creator opt-in committed by one exact artifact revision. A later revision
 * must publish a new preference and new proofs; helpers never inherit stale
 * work from an earlier revision.
 */
export interface KeelCommunityReplicationPreference {
  readonly protocol: typeof KEEL_COMMUNITY_REPLICATION_PREFERENCE_PROTOCOL;
  readonly enabled: true;
  readonly carriers: readonly KeelCommunityReplicationCarrier[];
  readonly claimLeaseSeconds: number;
  readonly revisionPolicy: "require-new-proofs";
}

const CARRIER_SET = new Set<string>(KEEL_COMMUNITY_REPLICATION_CARRIERS);
const KEYS = new Set([
  "protocol",
  "enabled",
  "carriers",
  "claimLeaseSeconds",
  "revisionPolicy",
]);

/** Strict v1 validator used at form, manifest, and index boundaries. */
export function assertValidKeelCommunityReplicationPreference(
  value: unknown,
): asserts value is KeelCommunityReplicationPreference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Community replication preference must be an object.");
  }
  const preference = value as Record<string, unknown>;
  if (Object.keys(preference).some((key) => !KEYS.has(key))) {
    throw new TypeError("Community replication preference contains an unsupported field.");
  }
  if (preference.protocol !== KEEL_COMMUNITY_REPLICATION_PREFERENCE_PROTOCOL) {
    throw new TypeError("Unsupported community replication preference.");
  }
  if (preference.enabled !== true) {
    throw new TypeError("A stored community replication preference must be enabled.");
  }
  if (!Array.isArray(preference.carriers) || preference.carriers.length < 1 || preference.carriers.length > 3) {
    throw new RangeError("Community replication requires from one through three carriers.");
  }
  const positions = preference.carriers.map((carrier) =>
    typeof carrier === "string" && CARRIER_SET.has(carrier)
      ? KEEL_COMMUNITY_REPLICATION_CARRIERS.indexOf(carrier as KeelCommunityReplicationCarrier)
      : -1,
  );
  if (positions.some((position) => position < 0)) {
    throw new TypeError("Community replication carrier is unsupported.");
  }
  if (positions.some((position, index) => index > 0 && position <= (positions[index - 1] ?? -1))) {
    throw new TypeError("Community replication carriers must be unique and canonically ordered.");
  }
  if (
    !Number.isSafeInteger(preference.claimLeaseSeconds)
    || (preference.claimLeaseSeconds as number) < KEEL_COMMUNITY_REPLICATION_MIN_LEASE_SECONDS
    || (preference.claimLeaseSeconds as number) > KEEL_COMMUNITY_REPLICATION_MAX_LEASE_SECONDS
  ) {
    throw new RangeError("Community replication claim lease must be from 300 through 604800 seconds.");
  }
  if (preference.revisionPolicy !== "require-new-proofs") {
    throw new TypeError("Community replication must require new proofs for every revision.");
  }
}

/** Builds the only canonical carrier order accepted by the v1 protocol. */
export function createKeelCommunityReplicationPreference(input: {
  readonly carriers: readonly KeelCommunityReplicationCarrier[];
  readonly claimLeaseSeconds: number;
}): KeelCommunityReplicationPreference {
  const selected = new Set(input.carriers);
  const preference: KeelCommunityReplicationPreference = {
    protocol: KEEL_COMMUNITY_REPLICATION_PREFERENCE_PROTOCOL,
    enabled: true,
    carriers: KEEL_COMMUNITY_REPLICATION_CARRIERS.filter((carrier) => selected.has(carrier)),
    claimLeaseSeconds: input.claimLeaseSeconds,
    revisionPolicy: "require-new-proofs",
  };
  assertValidKeelCommunityReplicationPreference(preference);
  return preference;
}
