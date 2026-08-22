import type {
  ArtifactEntrypoint,
  ArtifactResource,
  EthereumAddress,
  Hex,
  KeelProjectStack,
} from "./types.js";

export const KEEL_STAKE_OBJECT_PROTOCOL = "keel-stake-object@1" as const;

export type KeelStakeObjectChain =
  | {
      readonly family: "ethereum";
      readonly chainId: number;
      readonly manager: EthereumAddress;
    }
  | {
      readonly family: "tezos";
      /** CAIP-2 Tezos network, for example tezos:NetXdQprcVkpaWU. */
      readonly network: string;
      /** KT1 manager address or an explicitly named FA2-compatible adapter. */
      readonly manager: string;
    };

export type KeelStakeObjectBackpack =
  | { readonly kind: "none" }
  | {
      readonly kind: "erc-6551";
      readonly registry: EthereumAddress;
      readonly implementation: EthereumAddress;
      readonly salt?: Hex;
    }
  | {
      /** Tezos has no ERC-6551 registry; this is a manager-owned namespace. */
      readonly kind: "manager-scoped";
    };

export type KeelStakeObjectLockup =
  | { readonly mode: "none" }
  | { readonly mode: "minimum-duration"; readonly seconds: number }
  | { readonly mode: "until-disabled" };

/**
 * A custom manager is metadata only until the host verifies the exact adapter,
 * immutable runtime code hash, and review/payment receipt. The receipt pays
 * for verification work; it never turns an unsafe manager green by itself.
 */
export type KeelStakeObjectManagerPolicy =
  | { readonly mode: "official" }
  | {
      readonly mode: "verified-custom";
      readonly adapterId: string;
      readonly adapterVersion: number;
      readonly immutableCodeHash: Hex;
      readonly evidenceDigest: Hex;
      readonly reviewReceipt: Hex;
      readonly feeReceipt: Hex;
    };

/** A resource that is never selected until the manager reports an active stake. */
export interface KeelStakeObjectResource {
  readonly resource: string;
  /** Stable load position inside the viewer's declared object/module slots. */
  readonly slot: number;
  /** Optional exact object identity returned by the stake manager. */
  readonly objectId?: string;
  readonly objectRevision?: number;
}

export interface KeelStakeObjectRuntime {
  /** The active manager payload is exposed to the viewer as `context.stake`. */
  readonly injectSeed?: boolean;
  readonly argumentsResource?: string;
  readonly variablesResource?: string;
  /** Exact manager-held runtime commitments. These bind the map code bundle,
   * seed, arguments, and variables before any gated resource can load. */
  readonly seed: Hex;
  readonly argumentsDigest: Hex;
  readonly variablesDigest: Hex;
  readonly runtimeDigest: Hex;
}

/** Monotonic accounting values returned by the canonical stake manager. */
export interface KeelStakeObjectCounters {
  /** This character's lifetime entries into this exact object/map. */
  readonly objectTokenLifetime: number;
  /** Every lifetime entry into this object/map, across all characters. */
  readonly objectLifetime: number;
  /** Every character currently active in this object/map. */
  readonly objectActive: number;
  /** This character's lifetime entries across every object/map in the manager. */
  readonly tokenLifetime: number;
  /** Current active-object count for this character (normally zero or one). */
  readonly tokenActive: number;
  readonly globalLifetime: number;
  readonly globalActive: number;
}

export interface KeelStakeObject {
  readonly protocol: typeof KEEL_STAKE_OBJECT_PROTOCOL;
  readonly chain: KeelStakeObjectChain;
  readonly hostCollection: string;
  readonly hostTokenId: string;
  /** `$staked.tokenId` resolves from the host application's selected stake. */
  readonly stakedTokenId: string;
  /** The manager's stable logical stake-object ID, not a browser-local key. */
  readonly stakeObjectId: Hex;
  /** The HarnessRegistry/viewer slot identity that receives the gated payload. */
  readonly viewerId: Hex;
  /** The ordinary/base entrypoint remains the unstaked presentation. */
  readonly stakedEntrypoint: ArtifactEntrypoint;
  readonly gatedResources: readonly KeelStakeObjectResource[];
  readonly requireStaked: true;
  readonly lockup?: KeelStakeObjectLockup;
  readonly runtime: KeelStakeObjectRuntime;
  /** Explicitly removed from the staked project stack; every other component remains. */
  readonly removeComponentIds?: readonly string[];
  readonly backpack?: KeelStakeObjectBackpack;
  readonly managerPolicy?: KeelStakeObjectManagerPolicy;
}

export interface KeelStakeObjectStackPlan {
  readonly removeComponentIds?: readonly string[];
  readonly addComponents: readonly KeelProjectStack["components"][number][];
}

const HEX_32 = /^0x[0-9a-f]{64}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty identifier.`);
  }
}

function safeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}.`);
  }
}

function bytes32(value: unknown, label: string): asserts value is Hex {
  if (typeof value !== "string" || !HEX_32.test(value)) throw new TypeError(`${label} must be lower-case bytes32.`);
}

function evmAddress(value: unknown, label: string): asserts value is EthereumAddress {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${label} must be a lower-case EVM address.`);
}

function validateBackpack(value: KeelStakeObjectBackpack, chain: KeelStakeObjectChain): void {
  if (value.kind === "none" || value.kind === "manager-scoped") {
    if (value.kind === "manager-scoped" && chain.family !== "tezos") {
      throw new TypeError("manager-scoped backpacks are reserved for Tezos.");
    }
    return;
  }
  if (chain.family !== "ethereum") throw new TypeError("ERC-6551 backpacks require an Ethereum stake manager.");
  evmAddress(value.registry, "backpack.registry");
  evmAddress(value.implementation, "backpack.implementation");
  if (value.salt !== undefined) bytes32(value.salt, "backpack.salt");
}

function validateLockup(value: KeelStakeObjectLockup): void {
  if (value.mode === "none" || value.mode === "until-disabled") return;
  safeInteger(value.seconds, "stakeObject.lockup.seconds", 1);
}

function validateManagerPolicy(value: KeelStakeObjectManagerPolicy): void {
  if (value.mode === "official") return;
  identifier(value.adapterId, "stakeObject.managerPolicy.adapterId");
  safeInteger(value.adapterVersion, "stakeObject.managerPolicy.adapterVersion", 1);
  bytes32(value.immutableCodeHash, "stakeObject.managerPolicy.immutableCodeHash");
  bytes32(value.evidenceDigest, "stakeObject.managerPolicy.evidenceDigest");
  bytes32(value.reviewReceipt, "stakeObject.managerPolicy.reviewReceipt");
  bytes32(value.feeReceipt, "stakeObject.managerPolicy.feeReceipt");
}

/** Validate a manifest's first-class stake-object declaration. */
export function assertValidKeelStakeObject(
  value: KeelStakeObject,
  resources: ReadonlyMap<string, ArtifactResource> | ReadonlySet<string>,
  componentIds?: ReadonlySet<string>,
): void {
  if (value.protocol !== KEEL_STAKE_OBJECT_PROTOCOL || value.requireStaked !== true) {
    throw new TypeError("Unsupported Keel stake-object protocol.");
  }
  if (value.chain.family === "ethereum") {
    safeInteger(value.chain.chainId, "stakeObject.chain.chainId", 1);
    evmAddress(value.chain.manager, "stakeObject.chain.manager");
  } else {
    identifier(value.chain.network, "stakeObject.chain.network");
    identifier(value.chain.manager, "stakeObject.chain.manager");
  }
  identifier(value.hostCollection, "stakeObject.hostCollection");
  identifier(value.hostTokenId, "stakeObject.hostTokenId");
  identifier(value.stakedTokenId, "stakeObject.stakedTokenId");
  if (value.chain.family === "ethereum") {
    evmAddress(value.hostCollection, "stakeObject.hostCollection");
    if (!/^\$anchor\.tokenId$|^(?:0|[1-9][0-9]*)$/u.test(value.hostTokenId)) {
      throw new TypeError("stakeObject.hostTokenId must be $anchor.tokenId or a uint256.");
    }
  }
  bytes32(value.stakeObjectId, "stakeObject.stakeObjectId");
  bytes32(value.viewerId, "stakeObject.viewerId");
  identifier(value.stakedEntrypoint.resource, "stakeObject.stakedEntrypoint.resource");
  identifier(value.stakedEntrypoint.mode, "stakeObject.stakedEntrypoint.mode");

  const hasResource = (id: string): boolean => resources instanceof Map ? resources.has(id) : resources.has(id);
  if (!hasResource(value.stakedEntrypoint.resource)) {
    throw new TypeError("stakeObject.stakedEntrypoint must reference a manifest resource.");
  }
  const gatedIds = new Set<string>();
  const slots = new Set<number>();
  if (value.gatedResources.length === 0 || value.gatedResources.length > 128) {
    throw new RangeError("stakeObject.gatedResources must contain 1 through 128 resources.");
  }
  for (const [index, item] of value.gatedResources.entries()) {
    identifier(item.resource, `stakeObject.gatedResources[${index}].resource`);
    safeInteger(item.slot, `stakeObject.gatedResources[${index}].slot`);
    if (gatedIds.has(item.resource)) throw new TypeError("stakeObject.gatedResources cannot repeat a resource.");
    if (slots.has(item.slot)) throw new TypeError("stakeObject.gatedResources cannot repeat a load slot.");
    if (!hasResource(item.resource)) throw new TypeError(`Unknown gated resource ${item.resource}.`);
    if (item.objectId !== undefined) identifier(item.objectId, `stakeObject.gatedResources[${index}].objectId`);
    if (item.objectRevision !== undefined) safeInteger(item.objectRevision, `stakeObject.gatedResources[${index}].objectRevision`, 1);
    if ((item.objectId === undefined) !== (item.objectRevision === undefined)) {
      throw new TypeError("A gated object identity must include both objectId and objectRevision.");
    }
    gatedIds.add(item.resource);
    slots.add(item.slot);
  }
  if (!gatedIds.has(value.stakedEntrypoint.resource)) {
    throw new TypeError("The staked entrypoint must be gated and cannot load while unstaked.");
  }
  const stakedEntrypointBinding = value.gatedResources.find((item) => item.resource === value.stakedEntrypoint.resource);
  if (stakedEntrypointBinding?.objectId === undefined || stakedEntrypointBinding.objectRevision === undefined) {
    throw new TypeError("The staked entrypoint must pin its exact manager code object and revision.");
  }
  if (value.runtime === undefined || value.runtime === null || typeof value.runtime !== "object") {
    throw new TypeError("stakeObject.runtime must pin the active runtime commitments.");
  }
  bytes32(value.runtime.seed, "stakeObject.runtime.seed");
  bytes32(value.runtime.argumentsDigest, "stakeObject.runtime.argumentsDigest");
  bytes32(value.runtime.variablesDigest, "stakeObject.runtime.variablesDigest");
  bytes32(value.runtime.runtimeDigest, "stakeObject.runtime.runtimeDigest");
  if (value.runtime.argumentsResource !== undefined) {
    identifier(value.runtime.argumentsResource, "stakeObject.runtime.argumentsResource");
    if (!gatedIds.has(value.runtime.argumentsResource)) throw new TypeError("Stake arguments must be gated.");
  }
  if (value.runtime.variablesResource !== undefined) {
    identifier(value.runtime.variablesResource, "stakeObject.runtime.variablesResource");
    if (!gatedIds.has(value.runtime.variablesResource)) throw new TypeError("Stake variables must be gated.");
  }
  validateLockup(value.lockup ?? { mode: "none" });
  for (const [index, componentId] of (value.removeComponentIds ?? []).entries()) {
    identifier(componentId, `stakeObject.removeComponentIds[${index}]`);
    if (componentIds !== undefined && !componentIds.has(componentId)) {
      throw new TypeError(`Stake object removes unknown project component ${componentId}.`);
    }
  }
  validateBackpack(value.backpack ?? { kind: "none" }, value.chain);
  validateManagerPolicy(value.managerPolicy ?? { mode: "official" });
}

/**
 * Compose the map/game stack explicitly. Removing one component never causes
 * shared modules to be regenerated or copied: only the named IDs are removed,
 * and the additions are appended after the retained components.
 */
export function composeStakeObjectStack(
  base: KeelProjectStack,
  plan: KeelStakeObjectStackPlan,
): { readonly stack: KeelProjectStack; readonly removedComponentIds: readonly string[]; readonly keptComponentIds: readonly string[] } {
  const remove = new Set(plan.removeComponentIds ?? []);
  const existing = new Set<string>();
  const removed: string[] = [];
  const kept = base.components.filter((component) => {
    if (existing.has(component.id)) throw new TypeError(`Duplicate project component ID: ${component.id}`);
    existing.add(component.id);
    if (!remove.has(component.id)) return true;
    removed.push(component.id);
    return false;
  });
  for (const component of plan.addComponents) {
    if (existing.has(component.id)) throw new TypeError(`Stake object component collides with ${component.id}.`);
    existing.add(component.id);
  }
  const components = [...kept, ...plan.addComponents].map((component, order) => ({ ...component, order }));
  return {
    stack: { protocol: "keel-project-stack@1", components },
    removedComponentIds: removed,
    keptComponentIds: kept.map((component) => component.id),
  };
}
