import type { Hex } from "./types.js";

export const KEEL_IP_CONTROL_EXTENSION_KEY = "keel.ip-control" as const;
export const KEEL_IP_CONTROL_PROTOCOL = "keel-ip-control@1" as const;

export type KeelIPControlChain = "ethereum" | "tezos";
export type KeelIPControlMode = "open" | "allowlist" | "token" | "creator-grant" | "external-rule";
export type KeelIPControlAction = "view" | "download" | "remint" | "mint-to-backpack";

export interface KeelIPLicenseDeclaration {
  readonly licenseId: Hex;
  readonly contentObjectId: Hex;
  readonly decodedDigest: Hex;
  readonly compression: "brotli";
  readonly identifier?: string;
}

export interface KeelIPResourceDeclaration {
  /** Manifest resource whose bytes are controlled by this exact Keel leaf. */
  readonly resource: string;
  readonly objectId: Hex;
  readonly objectRevision: number;
  /** Actions requested by this resource; chain state remains authoritative. */
  readonly actions: readonly KeelIPControlAction[];
  /**
   * Optional exact byte-delivery binding. It is required by a host before it
   * can construct a download URL for a resource that was withheld from the
   * render graph. The policy object and the delivered Keel object are kept
   * separate so a creator can gate a seed, endpoint, or membership payload
   * without pretending that compression is a confidentiality boundary.
   */
  readonly delivery?: KeelIPResourceDelivery;
}

export interface KeelIPResourceDelivery {
  readonly chain: KeelIPControlChain;
  readonly chainId: number;
  /** Tezos chain hash/name used by the server-side Taquito reader. */
  readonly network?: string;
  /** EVM KeelHold or Tezos Keel OnchFS store address. */
  readonly store: string;
  readonly contentObjectId: Hex;
  readonly decodedDigest: Hex;
  readonly fileName?: string;
}

/**
 * A manifest-side commitment to the separate Keel IP-control registry.
 * `resources` must use separate object IDs for portions that are meant to be
 * withheld; a composite or Brotli blob cannot hide a secret by itself.
 */
export interface KeelIPControlExtension {
  readonly protocol: typeof KEEL_IP_CONTROL_PROTOCOL;
  readonly chain: KeelIPControlChain;
  readonly chainId: number;
  /** Tezos chain hash/name used to pin Taquito view reads; Ethereum uses chainId. */
  readonly network?: string;
  readonly registry: string;
  /** Tezos keeps licenses in a separate registry to stay below Michelson size limits. */
  readonly licenseRegistry?: string;
  /** Tezos token-policy evaluator used for live FA2/ERC20/ERC721/ERC1155 parity. */
  readonly tokenGate?: string;
  /** Chain-local executor that rechecks the policy before downloads and mints. */
  readonly actionExecutor?: string;
  readonly policyId: Hex;
  readonly objectId: Hex;
  readonly objectRevision: number;
  readonly license: KeelIPLicenseDeclaration;
  readonly resources: readonly KeelIPResourceDeclaration[];
}

const BYTES32 = /^0x[0-9a-f]{64}$/u;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string.`);
  return value;
}

function uint(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${path} must be a positive safe integer.`);
  return value as number;
}

function bytes32(value: unknown, path: string): Hex {
  const normalized = text(value, path);
  if (!BYTES32.test(normalized)) throw new TypeError(`${path} must be lower-case bytes32 hex.`);
  return normalized as Hex;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], path: string): T {
  const resolved = text(value, path) as T;
  if (!values.includes(resolved)) throw new TypeError(`${path} has an unsupported value.`);
  return resolved;
}

/** Validate the untrusted manifest extension and its resource bindings. */
export function assertValidKeelIPControlExtension(
  value: unknown,
  resourceIds?: ReadonlySet<string>,
): asserts value is KeelIPControlExtension {
  const data = record(value, "$.extensions.keel.ip-control");
  if (data.protocol !== KEEL_IP_CONTROL_PROTOCOL) {
    throw new TypeError("$.extensions.keel.ip-control.protocol must be keel-ip-control@1.");
  }
  const chain = oneOf(data.chain, ["ethereum", "tezos"] as const, "$.extensions.keel.ip-control.chain");
  uint(data.chainId, "$.extensions.keel.ip-control.chainId");
  if (chain === "tezos") text(data.network, "$.extensions.keel.ip-control.network");
  if (chain === "ethereum" && data.network !== undefined) {
    throw new TypeError("Ethereum IP-control manifests must use chainId instead of network.");
  }
  text(data.registry, "$.extensions.keel.ip-control.registry");
  bytes32(data.policyId, "$.extensions.keel.ip-control.policyId");
  bytes32(data.objectId, "$.extensions.keel.ip-control.objectId");
  uint(data.objectRevision, "$.extensions.keel.ip-control.objectRevision");

  const license = record(data.license, "$.extensions.keel.ip-control.license");
  bytes32(license.licenseId, "$.extensions.keel.ip-control.license.licenseId");
  bytes32(license.contentObjectId, "$.extensions.keel.ip-control.license.contentObjectId");
  bytes32(license.decodedDigest, "$.extensions.keel.ip-control.license.decodedDigest");
  if (license.compression !== "brotli") {
    throw new TypeError("$.extensions.keel.ip-control.license.compression must be brotli.");
  }
  if (license.identifier !== undefined) text(license.identifier, "$.extensions.keel.ip-control.license.identifier");

  const resources = data.resources;
  if (!Array.isArray(resources) || resources.length === 0 || resources.length > 512) {
    throw new TypeError("$.extensions.keel.ip-control.resources must contain 1-512 bindings.");
  }
  const seen = new Set<string>();
  for (const [index, entry] of resources.entries()) {
    const path = `$.extensions.keel.ip-control.resources[${index}]`;
    const resource = record(entry, path);
    const resourceId = text(resource.resource, `${path}.resource`);
    if (seen.has(resourceId)) throw new TypeError(`${path}.resource is duplicated.`);
    seen.add(resourceId);
    if (resourceIds !== undefined && !resourceIds.has(resourceId)) {
      throw new TypeError(`${path}.resource is not declared in the manifest resources.`);
    }
    bytes32(resource.objectId, `${path}.objectId`);
    uint(resource.objectRevision, `${path}.objectRevision`);
    if (!Array.isArray(resource.actions) || resource.actions.length === 0 || resource.actions.length > 4) {
      throw new TypeError(`${path}.actions must contain 1-4 actions.`);
    }
    const actions = new Set<string>();
    for (const [actionIndex, action] of resource.actions.entries()) {
      const actionPath = `${path}.actions[${actionIndex}]`;
      const resolved = oneOf(
        action,
        ["view", "download", "remint", "mint-to-backpack"] as const,
        actionPath,
      );
      if (actions.has(resolved)) throw new TypeError(`${actionPath} is duplicated.`);
      actions.add(resolved);
    }
    if (resource.delivery !== undefined) {
      const delivery = record(resource.delivery, `${path}.delivery`);
      if (delivery.chain !== chain) throw new TypeError(`${path}.delivery.chain must match the IP-control chain.`);
      if (delivery.chainId !== data.chainId) throw new TypeError(`${path}.delivery.chainId must match the IP-control chainId.`);
      if (chain === "tezos") {
        text(delivery.network, `${path}.delivery.network`);
        if (!/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(delivery.store as string)) {
          throw new TypeError(`${path}.delivery.store must be a Tezos KT1 address.`);
        }
      } else {
        if (delivery.network !== undefined) throw new TypeError(`${path}.delivery.network is only valid for Tezos.`);
        if (!/^0x[0-9a-fA-F]{40}$/u.test(delivery.store as string)) {
          throw new TypeError(`${path}.delivery.store must be an EVM address.`);
        }
      }
      bytes32(delivery.contentObjectId, `${path}.delivery.contentObjectId`);
      bytes32(delivery.decodedDigest, `${path}.delivery.decodedDigest`);
      if (delivery.fileName !== undefined) {
        const fileName = text(delivery.fileName, `${path}.delivery.fileName`);
        if (fileName.length > 160 || /[\u0000-\u001f\u007f\\/]/u.test(fileName)) {
          throw new TypeError(`${path}.delivery.fileName contains unsupported characters.`);
        }
      }
    }
  }
  if (chain === "tezos" && !/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(data.registry as string)) {
    throw new TypeError("Tezos IP-control registry must be a KT1 address.");
  }
  const licenseRegistry = typeof data.licenseRegistry === "string" ? data.licenseRegistry : "";
  if (chain === "tezos" && !/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(licenseRegistry)) {
    throw new TypeError("Tezos IP-control licenseRegistry must be a KT1 address.");
  }
  if (chain === "ethereum" && data.licenseRegistry !== undefined) {
    throw new TypeError("Ethereum IP-control manifests must use the combined registry.");
  }
  if (chain === "ethereum" && !/^0x[0-9a-fA-F]{40}$/u.test(data.registry as string)) {
    throw new TypeError("Ethereum IP-control registry must be an address.");
  }
  if (data.tokenGate !== undefined) {
    if (chain !== "tezos" || !/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(data.tokenGate as string)) {
      throw new TypeError("IP-control tokenGate is only valid as a Tezos KT1 token evaluator.");
    }
  }
  if (data.actionExecutor !== undefined) {
    const valid = chain === "ethereum"
      ? /^0x[0-9a-fA-F]{40}$/u.test(data.actionExecutor as string)
      : /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(data.actionExecutor as string);
    if (!valid) throw new TypeError("IP-control actionExecutor must be a chain-local executor address.");
  }
}
