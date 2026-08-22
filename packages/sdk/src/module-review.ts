import { canonicalJson, createIntegrity, utf8ToBytes, type Integrity } from "@keel/protocol";

/**
 * Review-only builder for KeelModuleReviewRegistry actions (on-chain trust
 * for non-contract modules). It prepares a canonical, user-reviewable descriptor
 * for submit / sanction / deprecate / revoke; it never signs, encodes final
 * calldata, or submits — the host/adapter does that after human approval,
 * exactly like the wallet-request and wallet-link builders.
 */
export const KEEL_MODULE_REVIEW_PROTOCOL = "keel-module-review@1" as const;

const DIGEST = /^0x[0-9a-f]{64}$/u;
const ETHEREUM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const ZERO_DIGEST = `0x${"0".repeat(64)}` as const;
const MAX_UINT64 = 2n ** 64n - 1n;

export const KEEL_MODULE_FORMATS = ["es-module", "classic-script", "umd", "commonjs", "wasm"] as const;
export type KeelModuleFormat = (typeof KEEL_MODULE_FORMATS)[number];

/** On-chain enum index for each format (matches KeelModuleReviewRegistry.ModuleFormat). */
export const KEEL_MODULE_FORMAT_INDEX: Readonly<Record<KeelModuleFormat, number>> = {
  "es-module": 0,
  "classic-script": 1,
  umd: 2,
  commonjs: 3,
  wasm: 4,
};

export type KeelModuleReviewAction = "submit" | "sanction" | "deprecate" | "revoke";

const REGISTRY_FUNCTION: Readonly<Record<KeelModuleReviewAction, string>> = {
  submit: "submitModule",
  sanction: "sanctionModule",
  deprecate: "deprecateModule",
  revoke: "revokeModule",
};

export interface KeelModuleSpec {
  readonly moduleId: `0x${string}`;
  readonly moduleVersion: number;
  readonly format: KeelModuleFormat;
  readonly graphId: `0x${string}`;
  readonly graphVersion: number;
  readonly manifestDigest: `0x${string}`;
  readonly resourceGraphDigest: `0x${string}`;
  readonly metadataDigest: `0x${string}`;
}

export interface KeelModuleReviewInput {
  readonly chainId: number;
  readonly registry: string;
  readonly action: KeelModuleReviewAction;
  /** Required for `submit`. */
  readonly spec?: KeelModuleSpec;
  /** Required for `sanction` / `deprecate` / `revoke`. */
  readonly specDigest?: `0x${string}`;
  /** Required for `sanction`. */
  readonly reviewDigest?: `0x${string}`;
  /** Required for `deprecate` / `revoke`. */
  readonly reasonDigest?: `0x${string}`;
  /** Optional for `deprecate` / `revoke`; defaults to the zero digest. */
  readonly replacementSpecDigest?: `0x${string}`;
  /** Optional expiry (unix seconds) for `sanction` / `deprecate`; 0 means no expiry. */
  readonly validUntil?: number;
}

export interface KeelModuleReviewEnvelope {
  readonly protocol: typeof KEEL_MODULE_REVIEW_PROTOCOL;
  readonly status: "review-only";
  readonly chainReady: false;
  readonly chainId: number;
  readonly registry: `0x${string}`;
  readonly action: KeelModuleReviewAction;
  /** The registry function and its ordered argument values for the host to encode. */
  readonly call: { readonly function: string; readonly args: readonly (string | number)[] };
  readonly spec?: KeelModuleSpec;
  readonly specDigest?: `0x${string}`;
  readonly integrity: Integrity;
  readonly walletApproval: "required";
  readonly approval: "not-granted";
  readonly signing: "not-performed";
  readonly submission: "not-performed";
  readonly caveat: "A module review descriptor records an exact registry action for human approval; it never signs, encodes final calldata, or submits.";
}

function requireDigest(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${label} must be a lower-case 32-byte hex digest.`);
  return value as `0x${string}`;
}

function requireUint64(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_UINT64) {
    throw new Error(`${label} must be a non-negative uint64.`);
  }
  return value;
}

function validateSpec(spec: KeelModuleSpec): void {
  requireDigest(spec.moduleId, "spec.moduleId");
  requireUint64(spec.moduleVersion, "spec.moduleVersion");
  if (!KEEL_MODULE_FORMATS.includes(spec.format)) throw new Error(`spec.format must be one of ${KEEL_MODULE_FORMATS.join(", ")}.`);
  requireDigest(spec.graphId, "spec.graphId");
  requireUint64(spec.graphVersion, "spec.graphVersion");
  requireDigest(spec.manifestDigest, "spec.manifestDigest");
  requireDigest(spec.resourceGraphDigest, "spec.resourceGraphDigest");
  requireDigest(spec.metadataDigest, "spec.metadataDigest");
  if (spec.moduleId === ZERO_DIGEST || spec.graphId === ZERO_DIGEST || spec.manifestDigest === ZERO_DIGEST) {
    throw new Error("spec.moduleId, spec.graphId, and spec.manifestDigest must be non-zero.");
  }
}

/** The ordered tuple encoding of a spec for the contract's ModuleSpec struct. */
function specTuple(spec: KeelModuleSpec): readonly (string | number)[] {
  return [
    spec.moduleId,
    spec.moduleVersion,
    KEEL_MODULE_FORMAT_INDEX[spec.format],
    spec.graphId,
    spec.graphVersion,
    spec.manifestDigest,
    spec.resourceGraphDigest,
    spec.metadataDigest,
  ];
}

/** Prepare a canonical, review-only module-review descriptor. Never signs or submits. */
export async function buildKeelModuleReviewRequest(
  input: KeelModuleReviewInput,
  algorithm: "sha256" = "sha256",
): Promise<KeelModuleReviewEnvelope> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("chainId must be a positive integer.");
  if (typeof input.registry !== "string" || !ETHEREUM_ADDRESS.test(input.registry)) {
    throw new Error("registry must be a 20-byte EVM address.");
  }
  const registry = input.registry.toLowerCase() as `0x${string}`;

  let call: { function: string; args: readonly (string | number)[] };
  let spec: KeelModuleSpec | undefined;
  let specDigest: `0x${string}` | undefined;

  switch (input.action) {
    case "submit": {
      if (input.spec === undefined) throw new Error("submit requires a spec.");
      validateSpec(input.spec);
      spec = input.spec;
      call = { function: REGISTRY_FUNCTION.submit, args: specTuple(input.spec) };
      break;
    }
    case "sanction": {
      specDigest = requireDigest(input.specDigest, "specDigest");
      const reviewDigest = requireDigest(input.reviewDigest, "reviewDigest");
      const validUntil = requireUint64(input.validUntil ?? 0, "validUntil");
      call = { function: REGISTRY_FUNCTION.sanction, args: [specDigest, reviewDigest, validUntil] };
      break;
    }
    case "deprecate": {
      specDigest = requireDigest(input.specDigest, "specDigest");
      const reasonDigest = requireDigest(input.reasonDigest, "reasonDigest");
      const replacement = input.replacementSpecDigest ?? ZERO_DIGEST;
      requireDigest(replacement, "replacementSpecDigest");
      const validUntil = requireUint64(input.validUntil ?? 0, "validUntil");
      call = { function: REGISTRY_FUNCTION.deprecate, args: [specDigest, reasonDigest, replacement, validUntil] };
      break;
    }
    case "revoke": {
      specDigest = requireDigest(input.specDigest, "specDigest");
      const reasonDigest = requireDigest(input.reasonDigest, "reasonDigest");
      const replacement = input.replacementSpecDigest ?? ZERO_DIGEST;
      requireDigest(replacement, "replacementSpecDigest");
      call = { function: REGISTRY_FUNCTION.revoke, args: [specDigest, reasonDigest, replacement] };
      break;
    }
    default:
      throw new Error(`Unknown module review action: ${String(input.action)}`);
  }

  const body = {
    protocol: KEEL_MODULE_REVIEW_PROTOCOL,
    status: "review-only" as const,
    chainReady: false as const,
    chainId: input.chainId,
    registry,
    action: input.action,
    call,
    ...(spec === undefined ? {} : { spec }),
    ...(specDigest === undefined ? {} : { specDigest }),
  };
  const integrity = await createIntegrity(utf8ToBytes(canonicalJson(body)), algorithm);

  return {
    ...body,
    integrity,
    walletApproval: "required",
    approval: "not-granted",
    signing: "not-performed",
    submission: "not-performed",
    caveat:
      "A module review descriptor records an exact registry action for human approval; it never signs, encodes final calldata, or submits.",
  };
}
