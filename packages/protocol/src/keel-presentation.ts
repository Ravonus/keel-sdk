import type { Hex } from "./types.js";

export const KEEL_PRESENTATION_POLICY_PROTOCOL = "keel-presentation-policy@1" as const;

export type KeelPresentationAuthority =
  | "immutable"
  | "creator"
  | "token-owner"
  | "creator-or-token-owner"
  | "oracle";

export type KeelPresentationUpdateKind =
  | "typed-state"
  | "resource-revision"
  | "api-snapshot"
  | "viewer-revision";

export type KeelPresentationValueType =
  | "boolean"
  | "uint"
  | "rgb24"
  | "utf8"
  | "bytes32"
  | "canonical-json"
  | "binary";

/**
 * One independently governed part of a Keel presentation. A policy says
 * what collectors bought: it does not pretend an authorized mutable value is
 * immutable, and it never lets a mutable CSS/state policy silently authorize
 * executable-code replacement.
 */
export interface KeelPresentationPolicy {
  readonly protocol: typeof KEEL_PRESENTATION_POLICY_PROTOCOL;
  readonly policyId: string;
  readonly key: string;
  readonly scope: "collection" | "token";
  readonly authority: KeelPresentationAuthority;
  readonly updateKind: KeelPresentationUpdateKind;
  readonly valueType: KeelPresentationValueType;
  readonly executable: boolean;
  readonly sourceVisibility: "readable" | "opaque";
  readonly allowedMediaTypes: readonly string[];
  readonly constraints?: {
    readonly minimum?: bigint;
    readonly maximum?: bigint;
    readonly maxBytes?: number;
  };
}

export interface KeelPresentationRevision {
  readonly policyId: string;
  readonly revision: number;
  readonly parentRevision: number;
  readonly publisher: string;
  readonly valueDigest: Hex;
  readonly byteLength: number;
  readonly mediaType: string;
  /** Canonical scalar text for typed state; absent for binary resources. */
  readonly canonicalValue?: string;
  /** Monotonic source sequence required for committed API snapshots. */
  readonly sourceSequence?: number;
  /** Digest of the API/source manifest, not of the response bytes. */
  readonly sourceManifestDigest?: Hex;
}

export interface KeelPresentationActor {
  readonly address: string;
  readonly creator: boolean;
  readonly tokenOwner: boolean;
  readonly oracle: boolean;
}

export interface KeelPresentationObservation {
  readonly digest: Hex;
  readonly byteLength: number;
  readonly mediaType: string;
}

export type KeelPresentationVerificationCode =
  | "verified-authorized-revision"
  | "policy-invalid"
  | "revision-invalid"
  | "authority-denied"
  | "value-invalid"
  | "media-type-denied"
  | "observation-mismatch"
  | "api-manifest-missing"
  | "api-sequence-stale";

export interface KeelPresentationAssessment {
  readonly verified: boolean;
  readonly code: KeelPresentationVerificationCode;
  readonly message: string;
}

export type KeelDeliveryMode = "onchain-recursive" | "marketplace-packed" | "hybrid-proxy";

export type KeelDeliveryAction =
  | "same-package-new-query-state"
  | "new-shared-package-root"
  | "new-token-package-root"
  | "new-onchain-revision"
  | "stable-proxy-new-verified-revision"
  | "token-config-root";

export interface KeelDeliveryDecision {
  readonly action: KeelDeliveryAction;
  readonly packageUploadCount: 0 | 1;
  readonly reason: string;
}

function identifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function digest(value: string | undefined): value is Hex {
  return value !== undefined && /^0x[0-9a-f]{64}$/u.test(value);
}

function safeInteger(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function authorityAllows(authority: KeelPresentationAuthority, actor: KeelPresentationActor): boolean {
  if (authority === "immutable") return false;
  if (authority === "creator") return actor.creator;
  if (authority === "token-owner") return actor.tokenOwner;
  if (authority === "creator-or-token-owner") return actor.creator || actor.tokenOwner;
  return actor.oracle;
}

function validateCanonicalValue(policy: KeelPresentationPolicy, revision: KeelPresentationRevision): boolean {
  const value = revision.canonicalValue;
  if (policy.valueType === "binary") return value === undefined;
  if (value === undefined) return false;
  if (policy.valueType === "boolean") return value === "true" || value === "false";
  if (policy.valueType === "rgb24") return /^#[0-9a-f]{6}$/u.test(value);
  if (policy.valueType === "bytes32") return /^0x[0-9a-f]{64}$/u.test(value);
  if (policy.valueType === "uint") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
    const integer = BigInt(value);
    if (policy.constraints?.minimum !== undefined && integer < policy.constraints.minimum) return false;
    if (policy.constraints?.maximum !== undefined && integer > policy.constraints.maximum) return false;
  }
  if (policy.valueType === "canonical-json") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed === null || typeof parsed !== "object") return false;
    } catch {
      return false;
    }
  }
  return new TextEncoder().encode(value).byteLength <= (policy.constraints?.maxBytes ?? Number.MAX_SAFE_INTEGER);
}

export function assessKeelPresentationRevision(
  policy: KeelPresentationPolicy,
  previous: KeelPresentationRevision | undefined,
  candidate: KeelPresentationRevision,
  actor: KeelPresentationActor,
  observation: KeelPresentationObservation,
): KeelPresentationAssessment {
  if (
    policy.protocol !== KEEL_PRESENTATION_POLICY_PROTOCOL ||
    !identifier(policy.policyId) ||
    !identifier(policy.key) ||
    policy.allowedMediaTypes.length === 0 ||
    policy.allowedMediaTypes.some((item) => !identifier(item)) ||
    (policy.executable && policy.updateKind === "typed-state")
  ) {
    return { verified: false, code: "policy-invalid", message: "The declared presentation policy is invalid." };
  }
  const expectedRevision = (previous?.revision ?? 0) + 1;
  if (
    candidate.policyId !== policy.policyId ||
    !safeInteger(candidate.revision, 1) ||
    candidate.revision !== expectedRevision ||
    candidate.parentRevision !== (previous?.revision ?? 0) ||
    !identifier(candidate.publisher) ||
    !digest(candidate.valueDigest) ||
    !safeInteger(candidate.byteLength)
  ) {
    return { verified: false, code: "revision-invalid", message: "The candidate is not the next exact parented revision." };
  }
  const authorized = policy.authority === "immutable"
    ? previous === undefined && actor.creator
    : authorityAllows(policy.authority, actor);
  if (candidate.publisher.toLowerCase() !== actor.address.toLowerCase() || !authorized) {
    return { verified: false, code: "authority-denied", message: "The publisher is not authorized by this presentation policy." };
  }
  if (!policy.allowedMediaTypes.includes(candidate.mediaType)) {
    return { verified: false, code: "media-type-denied", message: "The candidate media type is not enabled by this policy." };
  }
  if (candidate.byteLength > (policy.constraints?.maxBytes ?? Number.MAX_SAFE_INTEGER) || !validateCanonicalValue(policy, candidate)) {
    return { verified: false, code: "value-invalid", message: "The candidate value violates the declared type or bounds." };
  }
  if (
    observation.digest !== candidate.valueDigest ||
    observation.byteLength !== candidate.byteLength ||
    observation.mediaType !== candidate.mediaType
  ) {
    return { verified: false, code: "observation-mismatch", message: "Observed bytes do not match the committed revision." };
  }
  if (policy.updateKind === "api-snapshot") {
    if (
      !digest(candidate.sourceManifestDigest) ||
      candidate.sourceSequence === undefined ||
      !safeInteger(candidate.sourceSequence, 1)
    ) {
      return { verified: false, code: "api-manifest-missing", message: "API snapshots require an exact source manifest and sequence." };
    }
    if ((previous?.sourceSequence ?? 0) >= (candidate.sourceSequence ?? 0)) {
      return { verified: false, code: "api-sequence-stale", message: "The API snapshot sequence did not advance." };
    }
  }
  return {
    verified: true,
    code: "verified-authorized-revision",
    message: "The changed value is authorized, revisioned, and byte-for-byte verified.",
  };
}

/**
 * Decide whether a Tezos update needs new package bytes. This makes the
 * important product distinction explicit: changing contract state is not the
 * same operation as changing CSS, media, or executable code.
 */
export function decideKeelDeliveryUpdate(
  policy: KeelPresentationPolicy,
  mode: KeelDeliveryMode,
  marketplacePreservesQuery: boolean,
): KeelDeliveryDecision {
  if (mode === "hybrid-proxy") {
    return {
      action: "stable-proxy-new-verified-revision",
      packageUploadCount: 0,
      reason: "The proxy URL is transport; the contract revision and digest remain the authority.",
    };
  }
  if (mode === "onchain-recursive") {
    return {
      action: "new-onchain-revision",
      packageUploadCount: 0,
      reason: "The recursive viewer resolves the new contract revision directly.",
    };
  }
  if (policy.updateKind === "typed-state") {
    return marketplacePreservesQuery
      ? {
          action: "same-package-new-query-state",
          packageUploadCount: 0,
          reason: "Only token state changed; the shared self-contained package bytes are unchanged.",
        }
      : {
          action: "token-config-root",
          packageUploadCount: 1,
          reason: "The marketplace stripped query state, so only a tiny token config root must change.",
        };
  }
  return policy.scope === "collection"
    ? {
        action: "new-shared-package-root",
        packageUploadCount: 1,
        reason: "One changed shared resource creates one new collection package root; unchanged DAG blocks are reused.",
      }
    : {
        action: "new-token-package-root",
        packageUploadCount: 1,
        reason: "Only this token's resource graph changed.",
      };
}
