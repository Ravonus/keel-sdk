import {
  canonicalJson,
  createIntegrity,
  encodeBase64,
  utf8ToBytes,
  type ArtifactManifest,
  type ArtifactResource,
  type Compression,
  type DigestAlgorithm,
  type Hex,
  type Integrity,
  type OnchainSource,
  type ResourceSource,
  type KeelStakeObject,
  type UriSource,
} from "@keel/protocol";
import type {
  CollectionFacetInput,
  CollectionVerificationInput,
} from "./collection-verification.js";
import { resolveArtifact } from "./resolver.js";
import type {
  ManifestCommitment,
  ResolveOptions,
  ResolverAdapters,
  ResolvedArtifact,
  ResolvedStakeObject,
  RuntimeContext,
  RuntimeStakeObjectContext,
  StakeObjectManagerProof,
  StakeObjectManagerProofRequest,
  StakeObjectReadRequest,
  StakeObjectReadResult,
  KeelPresentationStateResult,
  KeelSeasonalGroveStateResult,
} from "./types.js";

export const KEEL_RUNTIME_EXTENSION_KEY = "keel.runtime" as const;
export const KEEL_RUNTIME_PROTOCOL = "keel-runtime@1" as const;
export const KEEL_INJECTION_PROTOCOL = "keel-injection@1" as const;
export const KEEL_ANCHOR_TOKEN_ID = "$anchor.tokenId" as const;
export const KEEL_STAKED_CHARACTER_ID = "$staked.characterId" as const;

/**
 * How a bound resource reaches the reader.
 *
 *   `"off"`       chain only. The canonical KeelHold object is read over RPC
 *                 and no gateway is consulted for display. The default.
 *   `"fallback"`  chain first, a proven mirror behind it.
 *   `"preferred"` mirror first, the chain behind it. What Keel used to do.
 *
 * The RPC read is not free of hosts either — something answers the `eth_call` —
 * which is why the endpoint is itself governed (`keelRpcUrlAllowed`) and why
 * a viewer that reads the chain this way has to say so. What it buys is that
 * the bytes come from the ledger that proved them rather than from a copy
 * somebody else agreed to keep.
 */
export type KeelGatewayTransport = "off" | "fallback" | "preferred";

export const DEFAULT_GATEWAY_TRANSPORT: KeelGatewayTransport = "off";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const MEDIA_TYPE = /^[a-z0-9!#$&+.^_-]+\/[a-z0-9!#$&+.^_-]+$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export type KeelBindingMode = "live" | "exact";
export type KeelInjectionField =
  | "chain.id"
  | "block.number"
  | "block.hash"
  | "block.timestamp"
  | "token.id"
  | "token.seed"
  | "character.seed"
  | "character.packedAttributes"
  | "character.portableRoot"
  | "character.portableManifestObjectId"
  | "character.portableDecodedObjectId"
  | "character.portableAnchorRoot"
  | "character.portableManifestObjectRevision"
  | "character.portableDecodedObjectRevision"
  | "character.attestedAnchors"
  | "character.assetFamilyId"
  | "character.assetId"
  | "character.spriteObjectId"
  | "character.targetMapObjectId"
  | "character.effectProfileObjectId"
  | "character.soundProfileObjectId"
  | "character.emitterSpriteBundleId"
  | "character.emitterSpriteAssetId"
  | "character.emitterMaterialTargetId"
  | "character.catalogRevision"
  | "character.assetFamilyRevision"
  | "character.emitterPresetId"
  | "character.emitterRevision"
  | "character.emitterSpriteBundleRevision"
  | "character.emitterSpriteSelectionRevision"
  | "character.fxCatalogRevision"
  | "character.mapGenerationEpoch"
  | "character.emitterSeedDomainVersion"
  | "character.emitterPaletteMode"
  | "character.sceneId"
  | "collection.verification"
  | "map.characterSeed"
  | "map.seed"
  | "map.buildRevision"
  | "map.portableRoot"
  | "map.portableManifestObjectId"
  | "map.portableDecodedObjectId"
  | "map.portableAnchorRoot"
  | "map.portableManifestObjectRevision"
  | "map.portableDecodedObjectRevision";

export interface KeelExpectedContext {
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly blockTimestamp: string;
}

export interface KeelInjectionExtension {
  readonly protocol: typeof KEEL_INJECTION_PROTOCOL;
  readonly fields: readonly KeelInjectionField[];
  /** Manifest-committed chain snapshot required for reproducible replay. */
  readonly expectedContext?: KeelExpectedContext;
}

/**
 * One registry-verified anchored location for an object, read from the
 * attested-anchor registry's append-only constellation. Rows exist only for
 * fully verified anchors and are never removed.
 */
export interface KeelAnchoredChain {
  readonly family: number;
  readonly network: number;
  readonly objectRevision: number;
  readonly anchorId: Hex;
  readonly anchorRoot: Hex;
}

export interface KeelCharacterExtension {
  readonly registry: Hex;
  readonly collection: Hex;
  readonly characterId: string;
}

export interface KeelMapExtension {
  readonly registry: Hex;
  readonly collection: Hex;
  readonly mapId: string;
}

export interface KeelCollectionVerificationExtension {
  readonly registry: Hex;
  readonly policyId: Hex;
  readonly tokenId: string;
}

export interface KeelPresentationStateExtension {
  readonly registry: Hex;
  readonly policyId: Hex;
  /** Resource slot replaced with the latest verified inline policy value. */
  readonly resource: string;
  readonly mediaType?: string;
}

export interface KeelSeasonalGroveStateExtension {
  readonly contract: Hex;
  readonly collection: Hex;
  readonly tokenId: string;
  /** Resource slot replaced with the latest contract-owned state. */
  readonly resource: string;
}

export interface KeelExactViewerState {
  readonly harnessRevision: number;
  readonly forkRevision: number;
  readonly selectionDigest: Hex;
}

export interface KeelEquipmentResourceBinding {
  readonly slot: number;
  readonly resource: string;
}

export interface KeelEquipmentExtension {
  readonly inventory: Hex;
  readonly characterCollection: Hex;
  readonly characterId: string;
  readonly mode: KeelBindingMode;
  readonly expectedLoadoutDigest?: Hex;
  readonly resources: readonly KeelEquipmentResourceBinding[];
}

/**
 * Versioned manifest-to-contract binding. Slot resources are positional: the
 * first manifest resource maps to the first effective viewer object, including
 * a token fork's selected revision. Equipment mappings overlay those resources
 * only after the inventory's exact loadout and source descriptors are read.
 */
export interface KeelRuntimeExtension {
  readonly protocol: typeof KEEL_RUNTIME_PROTOCOL;
  readonly chainId: number;
  readonly mode: KeelBindingMode;
  readonly artifactRegistry: Hex;
  readonly harnessRegistry: Hex;
  readonly linkRegistry?: Hex;
  readonly seedRegistry?: Hex;
  readonly attestedAnchorRegistry?: Hex;
  readonly viewerId: Hex;
  readonly tokenId: string;
  readonly slotResources: readonly string[];
  readonly injection?: KeelInjectionExtension;
  readonly character?: KeelCharacterExtension;
  readonly map?: KeelMapExtension;
  readonly state?: KeelPresentationStateExtension;
  readonly seasonalGroveState?: KeelSeasonalGroveStateExtension;
  readonly collectionVerification?: KeelCollectionVerificationExtension;
  readonly expectedViewer?: KeelExactViewerState;
  readonly equipment?: KeelEquipmentExtension;
}

export type KeelContractFunction =
  | "keelIndex"
  | "approvedEvidenceRoot"
  | "characterCollection"
  | "characterRegistry"
  | "deriveTokenSeed"
  | "effectiveHarness"
  | "equipmentSource"
  | "fidelityLink"
  | "linkExists"
  | "loadout"
  | "inspectCurrent"
  | "latestReceipt"
  | "mapCharacterRuntime"
  | "mapCharacterSeed"
  | "mapCollection"
  | "objectAnchoredChains"
  | "artifactRegistry"
  | "ipLicense"
  | "ipPolicy"
  | "ipRule"
  | "ipAuthorizationStatus"
  | "ipIsAuthorized"
  | "ipTokenRequirementCount"
  | "ipTokenRequirement"
  | "artifactRevisionSource"
  | "ownerOf"
  | "portableAnchorRegistry"
  | "presentationPolicy"
  | "policy"
  | "predictSeedSetId"
  | "renderRecipe"
  | "receipt"
  | "receiptCurrent"
  | "sourceAnchor"
  | "anchor"
  | "seedSetForViewerRevision"
  | "harnessCollection"
  | "harnessRegistry"
  | "stakeObject"
  | "stakeObjectActive"
  | "stakeCounts"
  | "globalStakeCounts"
  | "stakeObjectController"
  | "stakeObjectState"
  | "stakeObjectRuntime";

export interface KeelContractReadRequest {
  readonly chainId: number;
  readonly address: Hex;
  readonly functionName: KeelContractFunction;
  readonly args: readonly unknown[];
  readonly blockNumber?: bigint;
  readonly blockHash?: Hex;
  readonly signal: AbortSignal;
}

/** Minimal transport bridge; callers may back it with viem, ethers, or RPC. */
export type KeelContractRead = (request: KeelContractReadRequest) => Promise<unknown>;

export interface EthereumStakeObjectReaderOptions {
  readonly readContract: KeelContractRead;
  readonly readManagerProof?: (
    request: StakeObjectManagerProofRequest,
    signal: AbortSignal,
  ) => Promise<StakeObjectManagerProof>;
}

function optionalAddress(value: unknown, label: string): Hex | undefined {
  const result = contractAddress(value, label);
  return result === `0x${"00".repeat(20)}` ? undefined : result;
}

/**
 * Build the official EVM manager reader. The reader never declares a manager
 * immutable by itself; callers must supply the independent code/evidence
 * proof callback, which is checked again by the generic resolver.
 */
export function createEthereumStakeObjectReader(
  options: EthereumStakeObjectReaderOptions,
): (request: StakeObjectReadRequest, signal: AbortSignal) => Promise<StakeObjectReadResult> {
  return async (request, signal): Promise<StakeObjectReadResult> => {
    if (request.chain.family !== "ethereum") throw new TypeError("The Ethereum stake reader cannot read a Tezos manager.");
    if (!DECIMAL_UINT.test(request.stakedTokenId)) throw new TypeError("EVM stake reads require a concrete decimal staked token ID.");
    const chain = request.chain;
    const read = (address_: Hex, functionName: KeelContractFunction, args: readonly unknown[] = []): Promise<unknown> =>
      options.readContract({
        chainId: chain.chainId,
        address: address_,
        functionName,
        args,
        signal,
      });
    const tokenId = BigInt(request.stakedTokenId);
    const active = bool(
      scalar(await read(chain.manager, "stakeObjectActive", [request.stakeObjectId, tokenId])),
      "stakeObjectActive",
    );
    const objectValue = await read(chain.manager, "stakeObject", [request.stakeObjectId]);
    const hostCollection = contractAddress(tupleValue(objectValue, "hostCollection", 1), "stakeObject.hostCollection");
    const hostTokenId = uintBig(tupleValue(objectValue, "hostTokenId", 2), "stakeObject.hostTokenId").toString();
    const stakedCollection = contractAddress(tupleValue(objectValue, "stakedCollection", 3), "stakeObject.stakedCollection");
    const [runtimeValue, countsValue, globalCountsValue, controllerValue, stateValue] = await Promise.all([
      read(chain.manager, "stakeObjectRuntime", [request.stakeObjectId]),
      read(chain.manager, "stakeCounts", [request.stakeObjectId, stakedCollection, tokenId]),
      read(chain.manager, "globalStakeCounts"),
      read(chain.manager, "stakeObjectController", [request.stakeObjectId]),
      active ? read(chain.manager, "stakeObjectState", [request.stakeObjectId, tokenId]) : Promise.resolve(undefined),
    ]);
    const activeTokenId = decimalUint(request.stakedTokenId, "stakeObjectState.activeTokenId");
    const proof = options.readManagerProof === undefined
      ? undefined
      : await options.readManagerProof({ chain, manager: chain.manager }, signal);
    const tokenOwner = active
      ? chain.manager
      : optionalAddress(await read(stakedCollection, "ownerOf", [BigInt(request.stakedTokenId)]), "stake.tokenOwner");
    const lockupValue = tupleValue(objectValue, "lockup", 7);
    const lockupMode = safeNumber(tupleValue(active ? stateValue : lockupValue, active ? "lockupMode" : "mode", active ? 14 : 0), "stakeObjectState.lockupMode");
    const minimumSeconds = safeNumber(tupleValue(active ? stateValue : lockupValue, active ? "minimumSeconds" : "minimumSeconds", active ? 15 : 1), "stakeObjectState.minimumSeconds");
    const lockup = lockupMode === 0
      ? { mode: "none" as const }
      : lockupMode === 1
        ? { mode: "minimum-duration" as const, seconds: minimumSeconds }
        : lockupMode === 2
          ? { mode: "until-disabled" as const }
          : (() => { throw new TypeError("stakeObjectState.lockupMode is invalid."); })();
    return {
      active,
      ...(active && optionalAddress(tupleValue(stateValue, "staker", 1), "stakeObjectState.staker") !== undefined
        ? { staker: optionalAddress(tupleValue(stateValue, "staker", 1), "stakeObjectState.staker")! }
        : {}),
      ...(tokenOwner === undefined ? {} : { tokenOwner }),
      hostOwner: active
        ? optionalAddress(tupleValue(stateValue, "hostOwner", 12), "stakeObjectState.hostOwner")!
        : optionalAddress(tupleValue(controllerValue, "hostOwner", 0), "stakeObjectController.hostOwner")!,
      stakedCollection,
      activeTokenId,
      viewerId: bytes32(tupleValue(objectValue, "viewerId", 4), "stakeObject.viewerId"),
      hostCollection,
      hostTokenId,
      slot: safeNumber(tupleValue(runtimeValue, "slot", 5), "stakeObjectRuntime.slot"),
      startedAt: active ? String(tupleValue(stateValue, "startedAt", 16)) : "0",
      lockup,
      counters: {
        objectTokenLifetime: safeNumber(tupleValue(active ? stateValue : countsValue, "objectTokenLifetime", active ? 4 : 0), "stake.objectTokenLifetime"),
        objectLifetime: safeNumber(tupleValue(active ? stateValue : countsValue, "objectLifetime", active ? 5 : 1), "stake.objectLifetime"),
        objectActive: safeNumber(tupleValue(active ? stateValue : countsValue, "objectActive", active ? 6 : 2), "stake.objectActive"),
        tokenLifetime: safeNumber(tupleValue(active ? stateValue : countsValue, "tokenLifetime", active ? 7 : 3), "stake.tokenLifetime"),
        tokenActive: safeNumber(tupleValue(active ? stateValue : countsValue, "tokenActive", active ? 8 : 4), "stake.tokenActive"),
        globalLifetime: safeNumber(tupleValue(active ? stateValue : globalCountsValue, active ? "globalLifetime" : "lifetime", active ? 9 : 0), "stake.globalLifetime"),
        globalActive: safeNumber(tupleValue(active ? stateValue : globalCountsValue, active ? "globalActive" : "active", active ? 10 : 1), "stake.globalActive"),
      },
      ...(proof === undefined ? {} : { managerProof: proof }),
      managerVerified: proof?.proofClass === "official",
      runtimeDigest: bytes32(tupleValue(runtimeValue, "runtimeDigest", 6), "stakeObjectRuntime.runtimeDigest"),
      codeObjectId: bytes32(tupleValue(runtimeValue, "codeObjectId", 0), "stakeObjectRuntime.codeObjectId"),
      codeObjectRevision: safeNumber(tupleValue(runtimeValue, "codeObjectRevision", 1), "stakeObjectRuntime.codeObjectRevision"),
      runtimeSeed: bytes32(tupleValue(runtimeValue, "seed", 2), "stakeObjectRuntime.seed"),
      argumentsDigest: bytes32(tupleValue(runtimeValue, "argumentsDigest", 3), "stakeObjectRuntime.argumentsDigest"),
      variablesDigest: bytes32(tupleValue(runtimeValue, "variablesDigest", 4), "stakeObjectRuntime.variablesDigest"),
    };
  };
}

export interface KeelTezosStakeViewRequest {
  readonly network: string;
  readonly address: string;
  readonly view:
    | "stake_object_active"
    | "stake_object_config"
    | "stake_object_runtime"
    | "stake_object_state"
    | "stake_counts"
    | "global_stake_counts";
  /** Semantic view input; the transport is responsible for Micheline encoding. */
  readonly input: unknown;
  readonly signal: AbortSignal;
}

export type KeelTezosStakeView = (request: KeelTezosStakeViewRequest) => Promise<unknown>;

export interface TezosStakeObjectReaderOptions {
  readonly runView: KeelTezosStakeView;
  readonly readManagerProof?: (
    request: StakeObjectManagerProofRequest,
    signal: AbortSignal,
  ) => Promise<StakeObjectManagerProof>;
}

function tezosBytes32(value: unknown, label: string): Hex {
  const source = text(value, label).toLowerCase();
  const normalized = source.startsWith("0x") ? source : `0x${source}`;
  return bytes32(normalized, label);
}

function tezosAddress(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^(?:KT1|tz[1-4])[1-9A-HJ-NP-Za-km-z]{33}$/u.test(result)) throw new TypeError(`${label} must be a Tezos address.`);
  return result;
}

function tezosBoolean(value: unknown, label: string): boolean {
  const result = scalar(value);
  if (result !== true && result !== false) throw new TypeError(`${label} must be boolean.`);
  return result;
}

/**
 * Build the official SmartPy/FA2 stake-object reader. The view transport may
 * be backed by Taquito, Octez, or `run_script_view`, but must return decoded
 * named records. Manager code approval remains an independent callback.
 */
export function createTezosStakeObjectReader(
  options: TezosStakeObjectReaderOptions,
): (request: StakeObjectReadRequest, signal: AbortSignal) => Promise<StakeObjectReadResult> {
  return async (request, signal): Promise<StakeObjectReadResult> => {
    if (request.chain.family !== "tezos") throw new TypeError("The Tezos stake reader cannot read an Ethereum manager.");
    if (!DECIMAL_UINT.test(request.stakedTokenId)) throw new TypeError("Tezos stake reads require a concrete decimal staked token ID.");
    const chain = request.chain;
    const view = (name: KeelTezosStakeViewRequest["view"], input: unknown): Promise<unknown> => options.runView({
      network: chain.network,
      address: chain.manager,
      view: name,
      input,
      signal,
    });
    const key = { stake_object_id: request.stakeObjectId, token_id: request.stakedTokenId };
    const [activeValue, configValue, runtimeValue, countsValue, globalCountsValue, proof] = await Promise.all([
      view("stake_object_active", key),
      view("stake_object_config", request.stakeObjectId),
      view("stake_object_runtime", request.stakeObjectId),
      view("stake_counts", key),
      view("global_stake_counts", null),
      options.readManagerProof?.({ chain, manager: chain.manager }, signal),
    ]);
    const active = tezosBoolean(activeValue, "stake_object_active");
    const stateValue = active ? await view("stake_object_state", key) : undefined;
    const stakedCollection = tezosAddress(tupleValue(configValue, "staked_fa2", 6), "stake_object_config.staked_fa2");
    const controller = tezosAddress(tupleValue(configValue, "creator", 0), "stake_object_config.creator");
    const lockupMode = safeNumber(tupleValue(configValue, "lockup_mode", 4), "stake_object_config.lockup_mode");
    const minimumSeconds = safeNumber(tupleValue(configValue, "minimum_seconds", 5), "stake_object_config.minimum_seconds");
    const lockup = lockupMode === 0
      ? { mode: "none" as const }
      : lockupMode === 1
        ? { mode: "minimum-duration" as const, seconds: minimumSeconds }
        : lockupMode === 2
          ? { mode: "until-disabled" as const }
          : (() => { throw new TypeError("stake_object_config.lockup_mode is invalid."); })();
    return {
      active,
      ...(active ? { staker: tezosAddress(tupleValue(stateValue, "staker", 1), "stake_object_state.staker") } : {}),
      controller,
      stakedCollection,
      activeTokenId: request.stakedTokenId,
      ...(active ? { tokenOwner: chain.manager } : {}),
      viewerId: tezosBytes32(tupleValue(configValue, "viewer_id", 7), "stake_object_config.viewer_id"),
      hostCollection: tezosAddress(tupleValue(configValue, "host_fa2", 2), "stake_object_config.host_fa2"),
      hostTokenId: String(tupleValue(configValue, "host_token_id", 3)),
      slot: safeNumber(tupleValue(runtimeValue, "slot", 5), "stake_object_runtime.slot"),
      ...(active ? { startedAt: String(tupleValue(stateValue, "started_at", 13)) } : {}),
      lockup,
      counters: {
        objectTokenLifetime: safeNumber(tupleValue(countsValue, "object_token_lifetime", 0), "stake.objectTokenLifetime"),
        objectLifetime: safeNumber(tupleValue(countsValue, "object_lifetime", 1), "stake.objectLifetime"),
        objectActive: safeNumber(tupleValue(countsValue, "object_active", 2), "stake.objectActive"),
        tokenLifetime: safeNumber(tupleValue(countsValue, "token_lifetime", 3), "stake.tokenLifetime"),
        tokenActive: safeNumber(tupleValue(countsValue, "token_active", 4), "stake.tokenActive"),
        globalLifetime: safeNumber(tupleValue(globalCountsValue, "lifetime", 0), "stake.globalLifetime"),
        globalActive: safeNumber(tupleValue(globalCountsValue, "active", 1), "stake.globalActive"),
      },
      ...(proof === undefined ? {} : { managerProof: proof }),
      managerVerified: proof?.proofClass === "official",
      codeObjectId: tezosBytes32(tupleValue(runtimeValue, "code_object_id", 0), "stake_object_runtime.code_object_id"),
      codeObjectRevision: safeNumber(tupleValue(runtimeValue, "code_object_revision", 1), "stake_object_runtime.code_object_revision", 1),
      runtimeSeed: tezosBytes32(tupleValue(runtimeValue, "seed", 2), "stake_object_runtime.seed"),
      argumentsDigest: tezosBytes32(tupleValue(runtimeValue, "arguments_digest", 3), "stake_object_runtime.arguments_digest"),
      variablesDigest: tezosBytes32(tupleValue(runtimeValue, "variables_digest", 4), "stake_object_runtime.variables_digest"),
      runtimeDigest: tezosBytes32(tupleValue(runtimeValue, "runtime_digest", 6), "stake_object_runtime.runtime_digest"),
    };
  };
}

export interface KeelObjectSourceDescriptor {
  readonly objectId: Hex;
  readonly objectRevision: number;
  readonly store: Hex;
  readonly contentObjectId: Hex;
  readonly digestAlgorithm: Exclude<DigestAlgorithm, "none">;
  readonly decodedDigest: Hex;
  readonly byteLength: number;
  readonly storageCompression: Compression;
  readonly mediaType: string;
}

export interface KeelFidelityLink {
  readonly objectId: Hex;
  readonly objectRevision: number;
  readonly fidelity: 0 | 1 | 2;
  readonly scheme: 0 | 1 | 2 | 3;
  readonly digestAlgorithm: Exclude<DigestAlgorithm, "none">;
  readonly compression: Compression;
  readonly uri: string;
  readonly mediaType: string;
  readonly decodedDigest: Hex;
  readonly provenanceDigest: Hex;
  readonly byteLength: number;
  readonly publisher: Hex;
  readonly revealer: Hex;
}

export interface KeelEffectiveViewer {
  readonly harnessRevision: number;
  readonly forkRevision: number;
  readonly keelIndexRevision: number;
  readonly manifestDigest: Hex;
  readonly selectionDigest: Hex;
  readonly slotObjectIds: readonly Hex[];
  readonly selectedObjectRevisions: readonly number[];
}

export interface KeelSeedBinding {
  readonly seedSetId: Hex;
  readonly rootSeed: Hex;
  readonly provenanceDigest: Hex;
  readonly derivedTokenSeed: Hex;
  readonly publisher: Hex;
  readonly revealer: Hex;
}

export interface KeelPresentationStateBinding {
  readonly registry: Hex;
  readonly policyId: Hex;
  readonly resource: string;
  readonly revision: number;
  readonly valueDigest: Hex;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sourceManifestDigest: Hex;
  readonly sourceSequence: number;
}

export interface KeelLoadoutEntry {
  readonly slot: number;
  readonly definitionId: Hex;
  readonly assetCollection: Hex;
  readonly assetTokenId: bigint;
  readonly standard: 0 | 1;
  readonly objectId: Hex;
  readonly objectRevision: number;
  readonly catalogMetadataDigest: Hex;
  readonly equipped: boolean;
}

export interface KeelEquipmentBinding {
  readonly characterId: string;
  readonly loadoutDigest: Hex;
  readonly entries: readonly KeelLoadoutEntry[];
  readonly sources: ReadonlyMap<number, KeelObjectSourceDescriptor>;
}

export interface KeelObjectBinding {
  readonly resource: string;
  readonly source: KeelObjectSourceDescriptor;
  readonly fidelityLinks: readonly KeelFidelityLink[];
}

export interface KeelRuntimeBinding {
  readonly protocol: typeof KEEL_RUNTIME_PROTOCOL;
  readonly chainId: number;
  readonly blockNumber?: bigint;
  readonly mode: KeelBindingMode;
  readonly effectiveHarness: KeelEffectiveViewer;
  readonly objects: readonly KeelObjectBinding[];
  readonly runtimeContext?: RuntimeContext;
  readonly seed?: KeelSeedBinding;
  readonly presentationState?: KeelPresentationStateBinding;
  readonly seasonalGroveState?: KeelSeasonalGroveStateResult;
  readonly equipment?: KeelEquipmentBinding;
  readonly characterRecipe?: RuntimeContext;
  readonly stakeObject?: ResolvedStakeObject;
}

export interface BindKeelManifestOptions {
  readonly readContract: KeelContractRead;
  readonly adapters?: ResolverAdapters;
  /**
   * Where the bytes a reader is shown are fetched from.
   *
   * `"off"` is the default: the artwork is read from KeelHold over RPC, and
   * a declared IPFS, Arweave, or HTTPS mirror is not consulted for display at
   * all. The bytes still come from the chain that proved them, and the reader
   * is not made to depend on a content host staying alive and honest.
   *
   * This does not touch IPFS as *proof*. A CID the original collection
   * committed to is still recomputed and still checked; `hybridSource` below
   * still refuses a mirror whose committed digest, length, or media type
   * disagrees with the object descriptor. What changes is only which of the
   * two equally-proven copies is actually fetched.
   *
   * `"fallback"` keeps the mirror as a second chance behind the chain read,
   * and `"preferred"` restores the old mirror-first order for a deployment
   * that wants a gateway to absorb the read traffic. Both are opt-in.
   */
  readonly gatewayTransport?: KeelGatewayTransport;
  /**
   * @deprecated Superseded by `gatewayTransport`. Honoured when supplied and
   * `gatewayTransport` is not, so an existing caller keeps its old behaviour
   * rather than being silently switched: `"hybrid-first"` maps to
   * `"preferred"`, `"onchain-first"` to `"fallback"`.
   */
  readonly sourcePreference?: "hybrid-first" | "onchain-first";
  /** Staked character selected for a collection-shared map viewer. The arcade
   * registry still proves that this character is assigned to the anchored map. */
  readonly stakedCharacterId?: string;
  /** Generic stake-object alias; stakedCharacterId remains for Vault compatibility. */
  readonly stakedTokenId?: string;
  readonly blockNumber?: bigint;
  readonly blockHash?: Hex;
  readonly blockTimestamp?: bigint;
  readonly signal?: AbortSignal;
}

export interface BoundKeelManifest {
  readonly manifest: ArtifactManifest;
  readonly binding: KeelRuntimeBinding;
}

export interface ResolveKeelArtifactOptions
  extends Omit<ResolveOptions, "commitment" | "signal">,
    BindKeelManifestOptions {}

export interface ResolvedKeelArtifact {
  readonly artifact: ResolvedArtifact;
  readonly binding: KeelRuntimeBinding;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function address(value: unknown, label: string): Hex {
  const result = text(value, label);
  if (!ADDRESS.test(result)) throw new TypeError(`${label} must be a canonical lower-case EVM address.`);
  return result as Hex;
}

/** RPC clients commonly checksum address return values; normalize contract state at the trust boundary. */
function contractAddress(value: unknown, label: string): Hex {
  const result = text(value, label);
  if (!/^0x[0-9a-fA-F]{40}$/u.test(result)) throw new TypeError(`${label} must be an EVM address.`);
  return result.toLowerCase() as Hex;
}

function bytes32(value: unknown, label: string, allowZero = false): Hex {
  const result = text(value, label);
  if (!BYTES32.test(result) || (!allowZero && result === ZERO_BYTES32)) {
    throw new TypeError(`${label} must be a nonzero lower-case bytes32.`);
  }
  return result as Hex;
}

function safeNumber(value: unknown, label: string, minimum = 0): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(result) || (result as number) < minimum) {
    throw new RangeError(`${label} exceeds safe client limits.`);
  }
  return result as number;
}

function uintBig(value: unknown, label: string): bigint {
  try {
    const result = typeof value === "bigint" ? value : BigInt(value as string | number);
    if (result < 0n || result > UINT256_MAX) throw new RangeError();
    return result;
  } catch {
    throw new RangeError(`${label} must be uint256.`);
  }
}

function decimalUint(value: unknown, label: string): string {
  const result = text(value, label);
  if (!DECIMAL_UINT.test(result) || BigInt(result) > UINT256_MAX) throw new TypeError(`${label} must be a uint256 decimal string.`);
  return result;
}

function mode(value: unknown, label: string): KeelBindingMode {
  if (value !== "live" && value !== "exact") throw new TypeError(`${label} must be live or exact.`);
  return value;
}

function tupleValue(value: unknown, key: string, index: number): unknown {
  let tuple = value;
  if (
    Array.isArray(tuple) &&
    tuple.length === 1 &&
    tuple[0] !== null &&
    typeof tuple[0] === "object"
  ) tuple = tuple[0];
  if (Array.isArray(tuple)) return tuple[index];
  if (tuple !== null && typeof tuple === "object") {
    const record = tuple as Record<string | number, unknown>;
    return record[key] ?? record[index];
  }
  return undefined;
}

function scalar(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function digestAlgorithm(value: unknown, label: string): Exclude<DigestAlgorithm, "none"> {
  switch (safeNumber(value, label)) {
    case 0:
      return "sha256";
    case 1:
      return "keccak256";
    default:
      throw new TypeError(`${label} is not a supported Keel digest algorithm.`);
  }
}

function compression(value: unknown, label: string): Compression {
  const code = safeNumber(value, label);
  const result = ["none", "gzip", "deflate", "brotli"][code];
  if (result === undefined) throw new TypeError(`${label} is not a supported compression.`);
  return result as Compression;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return value;
}

function exactViewer(value: unknown, label: string): KeelExactViewerState {
  const data = object(value, label);
  return {
    harnessRevision: safeNumber(data.harnessRevision, `${label}.harnessRevision`, 1),
    forkRevision: safeNumber(data.forkRevision, `${label}.forkRevision`),
    selectionDigest: bytes32(data.selectionDigest, `${label}.selectionDigest`),
  };
}

function injectionExtension(value: unknown, label: string): KeelInjectionExtension {
  const data = object(value, label);
  if (data.protocol !== KEEL_INJECTION_PROTOCOL) throw new TypeError(`Unsupported Keel injection protocol.`);
  const allowed = new Set<KeelInjectionField>([
    "chain.id",
    "block.number",
    "block.hash",
    "block.timestamp",
    "token.id",
    "token.seed",
    "character.seed",
    "character.packedAttributes",
    "character.portableRoot",
    "character.portableManifestObjectId",
    "character.portableDecodedObjectId",
    "character.portableAnchorRoot",
    "character.portableManifestObjectRevision",
    "character.portableDecodedObjectRevision",
    "character.attestedAnchors",
    "character.assetFamilyId",
    "character.assetId",
    "character.spriteObjectId",
    "character.targetMapObjectId",
    "character.effectProfileObjectId",
    "character.soundProfileObjectId",
    "character.emitterSpriteBundleId",
    "character.emitterSpriteAssetId",
    "character.emitterMaterialTargetId",
    "character.catalogRevision",
    "character.assetFamilyRevision",
    "character.emitterPresetId",
    "character.emitterRevision",
    "character.emitterSpriteBundleRevision",
    "character.emitterSpriteSelectionRevision",
    "character.fxCatalogRevision",
    "character.mapGenerationEpoch",
    "character.emitterSeedDomainVersion",
    "character.emitterPaletteMode",
    "character.sceneId",
    "collection.verification",
    "map.characterSeed",
    "map.seed",
    "map.buildRevision",
    "map.portableRoot",
    "map.portableManifestObjectId",
    "map.portableDecodedObjectId",
    "map.portableAnchorRoot",
    "map.portableManifestObjectRevision",
    "map.portableDecodedObjectRevision",
  ]);
  const fields = array(data.fields, `${label}.fields`).map((entry, index) => {
    const field = text(entry, `${label}.fields[${index}]`) as KeelInjectionField;
    if (!allowed.has(field)) throw new TypeError(`${label}.fields contains unsupported field ${field}.`);
    return field;
  });
  if (fields.length === 0 || new Set(fields).size !== fields.length) {
    throw new TypeError(`${label}.fields must be non-empty and unique.`);
  }
  const expectedContext =
    data.expectedContext === undefined
      ? undefined
      : (() => {
          const expected = object(data.expectedContext, `${label}.expectedContext`);
          return {
            blockNumber: decimalUint(expected.blockNumber, `${label}.expectedContext.blockNumber`),
            blockHash: bytes32(expected.blockHash, `${label}.expectedContext.blockHash`),
            blockTimestamp: decimalUint(expected.blockTimestamp, `${label}.expectedContext.blockTimestamp`),
          };
        })();
  return {
    protocol: KEEL_INJECTION_PROTOCOL,
    fields,
    ...(expectedContext === undefined ? {} : { expectedContext }),
  };
}

function characterExtension(value: unknown, label: string): KeelCharacterExtension {
  const data = object(value, label);
  const rawCharacterId = text(data.characterId, `${label}.characterId`);
  return {
    registry: address(data.registry, `${label}.registry`),
    collection: address(data.collection, `${label}.collection`),
    characterId: rawCharacterId === KEEL_ANCHOR_TOKEN_ID || rawCharacterId === KEEL_STAKED_CHARACTER_ID
      ? rawCharacterId
      : decimalUint(rawCharacterId, `${label}.characterId`),
  };
}

function mapExtension(value: unknown, label: string): KeelMapExtension {
  const data = object(value, label);
  const rawMapId = text(data.mapId, `${label}.mapId`);
  return {
    registry: address(data.registry, `${label}.registry`),
    collection: address(data.collection, `${label}.collection`),
    mapId: rawMapId === KEEL_ANCHOR_TOKEN_ID ? rawMapId : decimalUint(rawMapId, `${label}.mapId`),
  };
}

function presentationStateExtension(value: unknown, label: string): KeelPresentationStateExtension {
  const data = object(value, label);
  const mediaType = data.mediaType === undefined ? undefined : text(data.mediaType, `${label}.mediaType`);
  return {
    registry: address(data.registry, `${label}.registry`),
    policyId: bytes32(data.policyId, `${label}.policyId`),
    resource: text(data.resource, `${label}.resource`),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function seasonalGroveStateExtension(value: unknown, label: string): KeelSeasonalGroveStateExtension {
  const data = object(value, label);
  const rawTokenId = text(data.tokenId, `${label}.tokenId`);
  return {
    contract: address(data.contract, `${label}.contract`),
    collection: address(data.collection, `${label}.collection`),
    tokenId: rawTokenId === KEEL_ANCHOR_TOKEN_ID
      ? rawTokenId
      : decimalUint(rawTokenId, `${label}.tokenId`),
    resource: text(data.resource, `${label}.resource`),
  };
}

function collectionVerificationExtension(value: unknown, label: string): KeelCollectionVerificationExtension {
  const data = object(value, label);
  const rawTokenId = text(data.tokenId, `${label}.tokenId`);
  return {
    registry: address(data.registry, `${label}.registry`),
    policyId: bytes32(data.policyId, `${label}.policyId`),
    tokenId: rawTokenId === KEEL_ANCHOR_TOKEN_ID
      ? KEEL_ANCHOR_TOKEN_ID
      : decimalUint(rawTokenId, `${label}.tokenId`),
  };
}

function equipmentExtension(value: unknown, label: string): KeelEquipmentExtension {
  const data = object(value, label);
  const bindingMode = mode(data.mode, `${label}.mode`);
  const expectedLoadoutDigest =
    data.expectedLoadoutDigest === undefined
      ? undefined
      : bytes32(data.expectedLoadoutDigest, `${label}.expectedLoadoutDigest`);
  if (bindingMode === "exact" && expectedLoadoutDigest === undefined) {
    throw new TypeError(`${label}.expectedLoadoutDigest is required for exact equipment binding.`);
  }
  const seenSlots = new Set<number>();
  const seenResources = new Set<string>();
  const resources = array(data.resources, `${label}.resources`).map((entry, index) => {
    const item = object(entry, `${label}.resources[${index}]`);
    const slot = safeNumber(item.slot, `${label}.resources[${index}].slot`);
    if (slot > 8 || seenSlots.has(slot)) throw new TypeError(`${label}.resources contains an invalid or duplicate slot.`);
    const resource = text(item.resource, `${label}.resources[${index}].resource`);
    if (seenResources.has(resource)) throw new TypeError(`${label}.resources contains a duplicate resource.`);
    seenSlots.add(slot);
    seenResources.add(resource);
    return { slot, resource };
  });
  return {
    inventory: address(data.inventory, `${label}.inventory`),
    characterCollection: address(data.characterCollection, `${label}.characterCollection`),
    characterId: decimalUint(data.characterId, `${label}.characterId`),
    mode: bindingMode,
    ...(expectedLoadoutDigest === undefined ? {} : { expectedLoadoutDigest }),
    resources,
  };
}

export function parseKeelRuntimeExtension(manifest: ArtifactManifest): KeelRuntimeExtension {
  const value = manifest.extensions?.[KEEL_RUNTIME_EXTENSION_KEY];
  if (value === undefined) throw new TypeError(`Manifest is missing extensions[${KEEL_RUNTIME_EXTENSION_KEY}].`);
  const data = object(value, `extensions[${KEEL_RUNTIME_EXTENSION_KEY}]`);
  if (data.protocol !== KEEL_RUNTIME_PROTOCOL) throw new TypeError(`Unsupported Keel runtime protocol.`);
  const bindingMode = mode(data.mode, "keel.mode");
  const expectedViewer = data.expectedViewer === undefined ? undefined : exactViewer(data.expectedViewer, "keel.expectedViewer");
  if (bindingMode === "exact" && expectedViewer === undefined) {
    throw new TypeError("keel.expectedViewer is required for exact binding.");
  }
  const resourceIds = new Set(manifest.resources.map((resource) => resource.id));
  const slotResources = array(data.slotResources, "keel.slotResources").map((entry, index) => {
    const resource = text(entry, `keel.slotResources[${index}]`);
    if (!resourceIds.has(resource)) throw new TypeError(`Keel viewer slot references unknown resource ${resource}.`);
    return resource;
  });
  if (slotResources.length === 0 || new Set(slotResources).size !== slotResources.length) {
    throw new TypeError("keel.slotResources must be non-empty and unique.");
  }
  const state = data.state === undefined ? undefined : presentationStateExtension(data.state, "keel.state");
  if (state !== undefined && !resourceIds.has(state.resource)) {
    throw new TypeError(`Keel state references unknown resource ${state.resource}.`);
  }
  const seasonalGroveState = data.seasonalGroveState === undefined
    ? undefined
    : seasonalGroveStateExtension(data.seasonalGroveState, "keel.seasonalGroveState");
  if (seasonalGroveState !== undefined && !resourceIds.has(seasonalGroveState.resource)) {
    throw new TypeError(`Keel Seasonal Grove state references unknown resource ${seasonalGroveState.resource}.`);
  }
  const equipment = data.equipment === undefined ? undefined : equipmentExtension(data.equipment, "keel.equipment");
  const injection = data.injection === undefined ? undefined : injectionExtension(data.injection, "keel.injection");
  const character = data.character === undefined ? undefined : characterExtension(data.character, "keel.character");
  const map = data.map === undefined ? undefined : mapExtension(data.map, "keel.map");
  const collectionVerification = data.collectionVerification === undefined
    ? undefined
    : collectionVerificationExtension(data.collectionVerification, "keel.collectionVerification");
  for (const item of equipment?.resources ?? []) {
    if (!resourceIds.has(item.resource)) throw new TypeError(`Keel equipment references unknown resource ${item.resource}.`);
  }
  const result: KeelRuntimeExtension = {
    protocol: KEEL_RUNTIME_PROTOCOL,
    chainId: safeNumber(data.chainId, "keel.chainId", 1),
    mode: bindingMode,
    artifactRegistry: address(data.artifactRegistry, "keel.artifactRegistry"),
    harnessRegistry: address(data.harnessRegistry, "keel.harnessRegistry"),
    viewerId: bytes32(data.viewerId, "keel.viewerId"),
    tokenId: text(data.tokenId, "keel.tokenId") === KEEL_ANCHOR_TOKEN_ID
      ? KEEL_ANCHOR_TOKEN_ID
      : decimalUint(data.tokenId, "keel.tokenId"),
    slotResources,
    ...(injection === undefined ? {} : { injection }),
    ...(character === undefined ? {} : { character }),
    ...(map === undefined ? {} : { map }),
    ...(state === undefined ? {} : { state }),
    ...(seasonalGroveState === undefined ? {} : { seasonalGroveState }),
    ...(collectionVerification === undefined ? {} : { collectionVerification }),
    ...(data.linkRegistry === undefined ? {} : { linkRegistry: address(data.linkRegistry, "keel.linkRegistry") }),
    ...(data.seedRegistry === undefined ? {} : { seedRegistry: address(data.seedRegistry, "keel.seedRegistry") }),
    ...(data.attestedAnchorRegistry === undefined
      ? {}
      : { attestedAnchorRegistry: address(data.attestedAnchorRegistry, "keel.attestedAnchorRegistry") }),
    ...(expectedViewer === undefined ? {} : { expectedViewer }),
    ...(equipment === undefined ? {} : { equipment }),
  };
  if (manifest.runtime.determinism.mode === "replay" && result.mode !== "exact") {
    throw new TypeError("Replay manifests require exact Keel viewer binding.");
  }
  if (manifest.runtime.determinism.mode === "replay" && result.seedRegistry === undefined) {
    throw new TypeError("Replay manifests require a Keel seed registry.");
  }
  if (manifest.runtime.determinism.mode === "replay" && result.equipment?.mode === "live") {
    throw new TypeError("Replay manifests cannot use a live equipment loadout.");
  }
  if (manifest.runtime.determinism.mode === "replay" && result.injection !== undefined && result.injection.expectedContext === undefined) {
    throw new TypeError("Replay manifests with Keel injection require a manifest-committed expectedContext.");
  }
  if (result.injection?.fields.includes("token.seed") === true && result.seedRegistry === undefined) {
    throw new TypeError("Keel token.seed injection requires a seed registry.");
  }
  if (result.injection?.fields.includes("character.attestedAnchors") === true && result.attestedAnchorRegistry === undefined) {
    throw new TypeError("Keel character.attestedAnchors injection requires an attested-anchor registry binding.");
  }
  const characterFields = result.injection?.fields.some((field) => field.startsWith("character.")) === true;
  if (characterFields && result.character === undefined) {
    throw new TypeError("Keel character injection requires a character registry binding.");
  }
  if (
    result.injection?.fields.includes("collection.verification") === true
    && result.collectionVerification === undefined
  ) throw new TypeError("Keel collection.verification injection requires a verification registry binding.");
  if (
    result.collectionVerification !== undefined
    && result.injection?.fields.includes("collection.verification") !== true
  ) throw new TypeError("Keel collection verification binding must be explicitly injected.");
  if (
    result.injection?.fields.some((field) => field.startsWith("map.")) === true
    && (result.character === undefined || result.map === undefined)
  ) {
    throw new TypeError("Keel map injection requires character and map registry bindings.");
  }
  if (result.map !== undefined && result.character === undefined) {
    throw new TypeError("Keel map binding requires a character binding.");
  }
  return result;
}

function parseEffectiveViewer(value: unknown): KeelEffectiveViewer {
  const objectIds = array(tupleValue(value, "slotObjectIds", 5), "effectiveHarness.slotObjectIds").map((entry, index) =>
    bytes32(entry, `effectiveHarness.slotObjectIds[${index}]`),
  );
  const revisions = array(tupleValue(value, "selectedObjectRevisions", 6), "effectiveHarness.selectedObjectRevisions").map(
    (entry, index) => safeNumber(entry, `effectiveHarness.selectedObjectRevisions[${index}]`, 1),
  );
  if (objectIds.length === 0 || objectIds.length !== revisions.length) {
    throw new TypeError("Keel effective viewer returned an invalid slot selection.");
  }
  return {
    harnessRevision: safeNumber(tupleValue(value, "harnessRevision", 0), "effectiveHarness.harnessRevision", 1),
    forkRevision: safeNumber(tupleValue(value, "forkRevision", 1), "effectiveHarness.forkRevision"),
    keelIndexRevision: safeNumber(
      tupleValue(value, "keelIndexRevision", 2),
      "effectiveHarness.keelIndexRevision",
    ),
    manifestDigest: bytes32(tupleValue(value, "manifestDigest", 3), "effectiveHarness.manifestDigest"),
    selectionDigest: bytes32(tupleValue(value, "selectionDigest", 4), "effectiveHarness.selectionDigest"),
    slotObjectIds: objectIds,
    selectedObjectRevisions: revisions,
  };
}

function parseObjectSource(value: unknown, objectId: Hex, objectRevision: number): KeelObjectSourceDescriptor {
  const mediaType = text(tupleValue(value, "mediaType", 6), "artifactRevisionSource.mediaType");
  if (!MEDIA_TYPE.test(mediaType) || mediaType !== mediaType.toLowerCase()) {
    throw new TypeError("Keel object source returned a non-canonical media type.");
  }
  return {
    objectId,
    objectRevision,
    store: contractAddress(tupleValue(value, "store", 0), "artifactRevisionSource.store"),
    contentObjectId: bytes32(tupleValue(value, "contentObjectId", 1), "artifactRevisionSource.contentObjectId"),
    digestAlgorithm: digestAlgorithm(tupleValue(value, "digestAlgorithm", 2), "artifactRevisionSource.digestAlgorithm"),
    decodedDigest: bytes32(tupleValue(value, "decodedDigest", 3), "artifactRevisionSource.decodedDigest"),
    byteLength: safeNumber(tupleValue(value, "byteLength", 4), "artifactRevisionSource.byteLength", 1),
    storageCompression: compression(tupleValue(value, "compression", 5), "artifactRevisionSource.compression"),
    mediaType,
  };
}

function parseLink(value: unknown): KeelFidelityLink {
  const fidelity = safeNumber(tupleValue(value, "fidelity", 2), "fidelityLink.fidelity") as 0 | 1 | 2;
  const scheme = safeNumber(tupleValue(value, "scheme", 3), "fidelityLink.scheme") as 0 | 1 | 2 | 3;
  if (fidelity > 2 || scheme > 3) throw new TypeError("Keel fidelity link returned an invalid enum value.");
  if (!bool(tupleValue(value, "exists", 14), "fidelityLink.exists")) throw new TypeError("Keel fidelity link is missing.");
  const uri = text(tupleValue(value, "uri", 6), "fidelityLink.uri");
  const prefixes = ["https://", "ipfs://", "ipns://", "ar://"] as const;
  if (!uri.startsWith(prefixes[scheme]) || uri.length === prefixes[scheme].length) {
    throw new TypeError("Keel fidelity link URI does not match its scheme.");
  }
  const mediaType = text(tupleValue(value, "mediaType", 7), "fidelityLink.mediaType");
  if (!MEDIA_TYPE.test(mediaType) || mediaType !== mediaType.toLowerCase()) {
    throw new TypeError("Keel fidelity link returned a non-canonical media type.");
  }
  return {
    objectId: bytes32(tupleValue(value, "objectId", 0), "fidelityLink.objectId"),
    objectRevision: safeNumber(tupleValue(value, "objectRevision", 1), "fidelityLink.objectRevision", 1),
    fidelity,
    scheme,
    digestAlgorithm: digestAlgorithm(tupleValue(value, "digestAlgorithm", 4), "fidelityLink.digestAlgorithm"),
    compression: compression(tupleValue(value, "compression", 5), "fidelityLink.compression"),
    uri,
    mediaType,
    decodedDigest: bytes32(tupleValue(value, "decodedDigest", 8), "fidelityLink.decodedDigest"),
    provenanceDigest: bytes32(tupleValue(value, "provenanceDigest", 9), "fidelityLink.provenanceDigest"),
    byteLength: safeNumber(tupleValue(value, "byteLength", 10), "fidelityLink.byteLength", 1),
    publisher: contractAddress(tupleValue(value, "publisher", 12), "fidelityLink.publisher"),
    revealer: contractAddress(tupleValue(value, "revealer", 13), "fidelityLink.revealer"),
  };
}

function parseLoadoutEntry(value: unknown): KeelLoadoutEntry {
  const standard = safeNumber(tupleValue(value, "standard", 4), "loadout.standard") as 0 | 1;
  if (standard > 1) throw new TypeError("Keel loadout returned an invalid asset standard.");
  return {
    slot: safeNumber(tupleValue(value, "slot", 0), "loadout.slot"),
    definitionId: bytes32(tupleValue(value, "definitionId", 1), "loadout.definitionId", true),
    assetCollection: contractAddress(tupleValue(value, "assetCollection", 2), "loadout.assetCollection"),
    assetTokenId: BigInt(tupleValue(value, "assetTokenId", 3) as bigint | number | string),
    standard,
    objectId: bytes32(tupleValue(value, "objectId", 5), "loadout.objectId", true),
    objectRevision: safeNumber(tupleValue(value, "objectRevision", 6), "loadout.objectRevision"),
    catalogMetadataDigest: bytes32(tupleValue(value, "catalogMetadataDigest", 7), "loadout.catalogMetadataDigest", true),
    equipped: bool(tupleValue(value, "equipped", 8), "loadout.equipped"),
  };
}

function parseCharacterRecipe(value: unknown, label: string): RuntimeContext {
  return {
    protocol: "keel-context@1",
    derivedTokenSeed: bytes32(tupleValue(value, "derivedSeed", 0), `${label}.derivedSeed`),
    packedAttributes: bytes32(tupleValue(value, "packedAttributes", 1), `${label}.packedAttributes`, true),
    portableRoot: bytes32(tupleValue(value, "portableRoot", 4), `${label}.portableRoot`),
    portableManifestObjectId: bytes32(
      tupleValue(value, "portableManifestObjectId", 5), `${label}.portableManifestObjectId`,
    ),
    portableDecodedObjectId: bytes32(
      tupleValue(value, "portableDecodedObjectId", 6), `${label}.portableDecodedObjectId`,
    ),
    portableAnchorRoot: bytes32(tupleValue(value, "portableAnchorRoot", 7), `${label}.portableAnchorRoot`),
    portableManifestObjectRevision: safeNumber(
      tupleValue(value, "portableManifestObjectRevision", 8), `${label}.portableManifestObjectRevision`, 1,
    ),
    portableDecodedObjectRevision: safeNumber(
      tupleValue(value, "portableDecodedObjectRevision", 9), `${label}.portableDecodedObjectRevision`, 1,
    ),
    assetFamilyId: bytes32(tupleValue(value, "assetFamilyId", 10), `${label}.assetFamilyId`),
    assetId: bytes32(tupleValue(value, "assetId", 11), `${label}.assetId`),
    spriteObjectId: bytes32(tupleValue(value, "spriteObjectId", 12), `${label}.spriteObjectId`),
    targetMapObjectId: bytes32(tupleValue(value, "targetMapObjectId", 13), `${label}.targetMapObjectId`),
    effectProfileObjectId: bytes32(tupleValue(value, "effectProfileObjectId", 14), `${label}.effectProfileObjectId`),
    soundProfileObjectId: bytes32(tupleValue(value, "soundProfileObjectId", 15), `${label}.soundProfileObjectId`),
    emitterSpriteBundleId: safeNumber(
      tupleValue(value, "emitterSpriteBundleId", 16), `${label}.emitterSpriteBundleId`, 1,
    ),
    emitterSpriteAssetId: safeNumber(
      tupleValue(value, "emitterSpriteAssetId", 17), `${label}.emitterSpriteAssetId`, 1,
    ),
    emitterMaterialTargetId: bytes32(
      tupleValue(value, "emitterMaterialTargetId", 18), `${label}.emitterMaterialTargetId`,
    ),
    catalogRevision: safeNumber(tupleValue(value, "catalogRevision", 19), `${label}.catalogRevision`, 1),
    assetFamilyRevision: safeNumber(
      tupleValue(value, "assetFamilyRevision", 21),
      `${label}.assetFamilyRevision`,
      1,
    ),
    emitterPresetId: safeNumber(
      tupleValue(value, "emitterPresetId", 26), `${label}.emitterPresetId`, 1,
    ),
    emitterRevision: safeNumber(
      tupleValue(value, "emitterRevision", 27), `${label}.emitterRevision`, 1,
    ),
    emitterSpriteBundleRevision: safeNumber(
      tupleValue(value, "emitterSpriteBundleRevision", 28), `${label}.emitterSpriteBundleRevision`, 1,
    ),
    emitterSpriteSelectionRevision: safeNumber(
      tupleValue(value, "emitterSpriteSelectionRevision", 29), `${label}.emitterSpriteSelectionRevision`, 1,
    ),
    fxCatalogRevision: safeNumber(tupleValue(value, "fxCatalogRevision", 30), `${label}.fxCatalogRevision`, 1),
    mapGenerationEpoch: safeNumber(
      tupleValue(value, "mapGenerationEpoch", 31), `${label}.mapGenerationEpoch`, 1,
    ),
    emitterSeedDomainVersion: safeNumber(
      tupleValue(value, "emitterSeedDomainVersion", 32), `${label}.emitterSeedDomainVersion`, 1,
    ),
    emitterPaletteMode: safeNumber(
      tupleValue(value, "emitterPaletteMode", 33), `${label}.emitterPaletteMode`,
    ),
    sceneId: safeNumber(tupleValue(value, "sceneId", 34), `${label}.sceneId`),
  };
}

function sameCharacterRecipe(left: RuntimeContext, right: RuntimeContext): boolean {
  return left.derivedTokenSeed === right.derivedTokenSeed
    && left.packedAttributes === right.packedAttributes
    && left.portableRoot === right.portableRoot
    && left.portableManifestObjectId === right.portableManifestObjectId
    && left.portableDecodedObjectId === right.portableDecodedObjectId
    && left.portableAnchorRoot === right.portableAnchorRoot
    && left.portableManifestObjectRevision === right.portableManifestObjectRevision
    && left.portableDecodedObjectRevision === right.portableDecodedObjectRevision
    && left.assetFamilyId === right.assetFamilyId
    && left.assetId === right.assetId
    && left.spriteObjectId === right.spriteObjectId
    && left.targetMapObjectId === right.targetMapObjectId
    && left.effectProfileObjectId === right.effectProfileObjectId
    && left.soundProfileObjectId === right.soundProfileObjectId
    && left.emitterSpriteBundleId === right.emitterSpriteBundleId
    && left.emitterSpriteAssetId === right.emitterSpriteAssetId
    && left.emitterMaterialTargetId === right.emitterMaterialTargetId
    && left.catalogRevision === right.catalogRevision
    && left.assetFamilyRevision === right.assetFamilyRevision
    && left.emitterPresetId === right.emitterPresetId
    && left.emitterRevision === right.emitterRevision
    && left.emitterSpriteBundleRevision === right.emitterSpriteBundleRevision
    && left.emitterSpriteSelectionRevision === right.emitterSpriteSelectionRevision
    && left.fxCatalogRevision === right.fxCatalogRevision
    && left.mapGenerationEpoch === right.mapGenerationEpoch
    && left.emitterSeedDomainVersion === right.emitterSeedDomainVersion
    && left.emitterPaletteMode === right.emitterPaletteMode
    && left.sceneId === right.sceneId;
}

interface VerificationStateSnapshot {
  readonly expectedTokenURIHash: Hex;
  readonly resolver: Hex;
  readonly keelIndex: Hex;
  readonly presentationScope: bigint;
  readonly routeLocked: boolean;
  readonly pointerAuthority: Hex;
  readonly presentationRevision: number;
  readonly portableRoot: Hex;
  readonly manifestDigest: Hex;
  readonly revisionPolicy: number;
  readonly publisherAuthority: Hex;
  readonly activationAuthority: Hex;
  readonly governanceTimelock: Hex;
  readonly revisionLineageRoot: Hex;
  readonly appendOnlyRevisions: boolean;
  readonly revisionFrozen: boolean;
  readonly governanceVerifiable: boolean;
  readonly mintStatus: number;
  readonly mintAccessMode: number;
  readonly mintAuthority: Hex;
  readonly mintAuthoritiesRoot: Hex;
  readonly mintAuthorityCount: number;
  readonly mintPolicyAuthority: Hex;
  readonly mintTimelock: Hex;
  readonly mintVerifiable: boolean;
  readonly totalSupply: bigint;
  readonly lifetimeMinted: bigint;
  readonly burnedCount: bigint;
  readonly remainingMintable: bigint;
  readonly maxSupply: bigint;
  readonly reservedSupply: bigint;
  readonly supplyKnownFlags: number;
  readonly maxSupplyKind: number;
  readonly capMutable: boolean;
  readonly capAuthority: Hex;
  readonly supplyTimelock: Hex;
  readonly supplyVerifiable: boolean;
  readonly burnPolicy: number;
  readonly implementation: Hex;
  readonly proxyAdmin: Hex;
  readonly beacon: Hex;
  readonly upgradeMutable: boolean;
  readonly upgradeAuthority: Hex;
  readonly upgradeTimelock: Hex;
  readonly upgradeVerifiable: boolean;
}

type VerificationFacetId = "route" | "content" | "governance" | "mint" | "supply" | "upgrade";
type VerificationFacetCodes = Readonly<Record<VerificationFacetId, number>>;

interface VerificationReceiptSnapshot {
  readonly policyId: Hex;
  readonly evidenceRoot: Hex;
  readonly tokenURIHash: Hex;
  readonly portableRoot: Hex;
  readonly portableAnchorRoot: Hex;
  readonly presentationContentDigest: Hex;
  readonly manifestDigest: Hex;
  readonly runtimeCodeHash: Hex;
  readonly collection: Hex;
  readonly resolver: Hex;
  readonly keelIndex: Hex;
  readonly pointerAuthority: Hex;
  readonly publisherAuthority: Hex;
  readonly activationAuthority: Hex;
  readonly governanceTimelock: Hex;
  readonly mintAuthority: Hex;
  readonly mintPolicyAuthority: Hex;
  readonly mintTimelock: Hex;
  readonly capAuthority: Hex;
  readonly supplyTimelock: Hex;
  readonly implementation: Hex;
  readonly proxyAdmin: Hex;
  readonly beacon: Hex;
  readonly upgradeAuthority: Hex;
  readonly upgradeTimelock: Hex;
  readonly presentationScope: bigint;
  readonly tokenId: bigint;
  readonly chainId: bigint;
  readonly presentationRevision: number;
  readonly policyVersion: number;
  readonly observedBlock: bigint;
  readonly evidenceBlock: bigint;
  readonly evidenceBlockHash: Hex;
  readonly expiresAt: bigint;
  readonly lane: number;
  readonly facets: VerificationFacetCodes;
  readonly revoked: boolean;
  readonly exists: boolean;
}

function parseVerificationFacets(value: unknown, label: string): VerificationFacetCodes {
  const read = (key: VerificationFacetId, index: number): number => {
    const result = safeNumber(tupleValue(value, key, index), `${label}.${key}`);
    if (result > 3) throw new TypeError(`${label}.${key} is not a supported verdict.`);
    return result;
  };
  return {
    route: read("route", 0),
    content: read("content", 1),
    governance: read("governance", 2),
    mint: read("mint", 3),
    supply: read("supply", 4),
    upgrade: read("upgrade", 5),
  };
}

function parseVerificationState(value: unknown): VerificationStateSnapshot {
  const at = (key: string, index: number): unknown => tupleValue(value, key, index);
  return {
    expectedTokenURIHash: bytes32(at("expectedTokenURIHash", 0), "verificationState.expectedTokenURIHash"),
    resolver: contractAddress(at("resolver", 1), "verificationState.resolver"),
    keelIndex: contractAddress(at("keelIndex", 2), "verificationState.keelIndex"),
    presentationScope: uintBig(at("presentationScope", 3), "verificationState.presentationScope"),
    routeLocked: bool(at("routeLocked", 4), "verificationState.routeLocked"),
    pointerAuthority: contractAddress(at("pointerAuthority", 5), "verificationState.pointerAuthority"),
    presentationRevision: safeNumber(at("presentationRevision", 6), "verificationState.presentationRevision", 1),
    portableRoot: bytes32(at("portableRoot", 7), "verificationState.portableRoot"),
    manifestDigest: bytes32(at("manifestDigest", 8), "verificationState.manifestDigest"),
    revisionPolicy: safeNumber(at("revisionPolicy", 9), "verificationState.revisionPolicy"),
    publisherAuthority: contractAddress(at("publisherAuthority", 10), "verificationState.publisherAuthority"),
    activationAuthority: contractAddress(at("activationAuthority", 11), "verificationState.activationAuthority"),
    governanceTimelock: contractAddress(at("governanceTimelock", 12), "verificationState.governanceTimelock"),
    revisionLineageRoot: bytes32(at("revisionLineageRoot", 13), "verificationState.revisionLineageRoot", true),
    appendOnlyRevisions: bool(at("appendOnlyRevisions", 14), "verificationState.appendOnlyRevisions"),
    revisionFrozen: bool(at("revisionFrozen", 15), "verificationState.revisionFrozen"),
    governanceVerifiable: bool(at("governanceVerifiable", 16), "verificationState.governanceVerifiable"),
    mintStatus: safeNumber(at("mintStatus", 17), "verificationState.mintStatus"),
    mintAccessMode: safeNumber(at("mintAccessMode", 18), "verificationState.mintAccessMode"),
    mintAuthority: contractAddress(at("mintAuthority", 19), "verificationState.mintAuthority"),
    mintAuthoritiesRoot: bytes32(at("mintAuthoritiesRoot", 20), "verificationState.mintAuthoritiesRoot", true),
    mintAuthorityCount: safeNumber(at("mintAuthorityCount", 21), "verificationState.mintAuthorityCount"),
    mintPolicyAuthority: contractAddress(at("mintPolicyAuthority", 22), "verificationState.mintPolicyAuthority"),
    mintTimelock: contractAddress(at("mintTimelock", 23), "verificationState.mintTimelock"),
    mintVerifiable: bool(at("mintVerifiable", 24), "verificationState.mintVerifiable"),
    totalSupply: uintBig(at("totalSupply", 25), "verificationState.totalSupply"),
    lifetimeMinted: uintBig(at("lifetimeMinted", 26), "verificationState.lifetimeMinted"),
    burnedCount: uintBig(at("burnedCount", 27), "verificationState.burnedCount"),
    remainingMintable: uintBig(at("remainingMintable", 28), "verificationState.remainingMintable"),
    maxSupply: uintBig(at("maxSupply", 29), "verificationState.maxSupply"),
    reservedSupply: uintBig(at("reservedSupply", 30), "verificationState.reservedSupply"),
    supplyKnownFlags: safeNumber(at("supplyKnownFlags", 31), "verificationState.supplyKnownFlags"),
    maxSupplyKind: safeNumber(at("maxSupplyKind", 32), "verificationState.maxSupplyKind"),
    capMutable: bool(at("capMutable", 33), "verificationState.capMutable"),
    capAuthority: contractAddress(at("capAuthority", 34), "verificationState.capAuthority"),
    supplyTimelock: contractAddress(at("supplyTimelock", 35), "verificationState.supplyTimelock"),
    supplyVerifiable: bool(at("supplyVerifiable", 36), "verificationState.supplyVerifiable"),
    burnPolicy: safeNumber(at("burnPolicy", 37), "verificationState.burnPolicy"),
    implementation: contractAddress(at("implementation", 38), "verificationState.implementation"),
    proxyAdmin: contractAddress(at("proxyAdmin", 39), "verificationState.proxyAdmin"),
    beacon: contractAddress(at("beacon", 40), "verificationState.beacon"),
    upgradeMutable: bool(at("upgradeMutable", 41), "verificationState.upgradeMutable"),
    upgradeAuthority: contractAddress(at("upgradeAuthority", 42), "verificationState.upgradeAuthority"),
    upgradeTimelock: contractAddress(at("upgradeTimelock", 43), "verificationState.upgradeTimelock"),
    upgradeVerifiable: bool(at("upgradeVerifiable", 44), "verificationState.upgradeVerifiable"),
  };
}

function parseVerificationReceipt(value: unknown): VerificationReceiptSnapshot {
  const at = (key: string, index: number): unknown => tupleValue(value, key, index);
  const lane = safeNumber(at("lane", 52), "receipt.lane");
  if (lane > 2) throw new TypeError("receipt.lane is unsupported.");
  return {
    policyId: bytes32(at("policyId", 0), "receipt.policyId"),
    evidenceRoot: bytes32(at("evidenceRoot", 2), "receipt.evidenceRoot"),
    tokenURIHash: bytes32(at("tokenURIHash", 3), "receipt.tokenURIHash"),
    portableRoot: bytes32(at("portableRoot", 4), "receipt.portableRoot"),
    portableAnchorRoot: bytes32(at("portableAnchorRoot", 5), "receipt.portableAnchorRoot"),
    presentationContentDigest: bytes32(at("presentationContentDigest", 6), "receipt.presentationContentDigest"),
    manifestDigest: bytes32(at("manifestDigest", 7), "receipt.manifestDigest"),
    runtimeCodeHash: bytes32(at("runtimeCodeHash", 9), "receipt.runtimeCodeHash"),
    collection: contractAddress(at("collection", 11), "receipt.collection"),
    resolver: contractAddress(at("resolver", 12), "receipt.resolver"),
    keelIndex: contractAddress(at("keelIndex", 13), "receipt.keelIndex"),
    pointerAuthority: contractAddress(at("pointerAuthority", 14), "receipt.pointerAuthority"),
    publisherAuthority: contractAddress(at("publisherAuthority", 15), "receipt.publisherAuthority"),
    activationAuthority: contractAddress(at("activationAuthority", 16), "receipt.activationAuthority"),
    governanceTimelock: contractAddress(at("governanceTimelock", 17), "receipt.governanceTimelock"),
    mintAuthority: contractAddress(at("mintAuthority", 18), "receipt.mintAuthority"),
    mintPolicyAuthority: contractAddress(at("mintPolicyAuthority", 19), "receipt.mintPolicyAuthority"),
    mintTimelock: contractAddress(at("mintTimelock", 20), "receipt.mintTimelock"),
    capAuthority: contractAddress(at("capAuthority", 21), "receipt.capAuthority"),
    supplyTimelock: contractAddress(at("supplyTimelock", 22), "receipt.supplyTimelock"),
    implementation: contractAddress(at("implementation", 23), "receipt.implementation"),
    proxyAdmin: contractAddress(at("proxyAdmin", 24), "receipt.proxyAdmin"),
    beacon: contractAddress(at("beacon", 25), "receipt.beacon"),
    upgradeAuthority: contractAddress(at("upgradeAuthority", 26), "receipt.upgradeAuthority"),
    upgradeTimelock: contractAddress(at("upgradeTimelock", 27), "receipt.upgradeTimelock"),
    presentationScope: uintBig(at("presentationScope", 30), "receipt.presentationScope"),
    tokenId: uintBig(at("tokenId", 31), "receipt.tokenId"),
    chainId: uintBig(at("chainId", 32), "receipt.chainId"),
    presentationRevision: safeNumber(at("presentationRevision", 40), "receipt.presentationRevision", 1),
    policyVersion: safeNumber(at("policyVersion", 41), "receipt.policyVersion", 1),
    observedBlock: uintBig(at("observedBlock", 42), "receipt.observedBlock"),
    evidenceBlock: uintBig(at("evidenceBlock", 43), "receipt.evidenceBlock"),
    evidenceBlockHash: bytes32(at("evidenceBlockHash", 44), "receipt.evidenceBlockHash", lane === 0),
    expiresAt: uintBig(at("expiresAt", 45), "receipt.expiresAt"),
    lane,
    facets: parseVerificationFacets(at("facets", 53), "receipt.facets"),
    revoked: bool(at("revoked", 63), "receipt.revoked"),
    exists: bool(at("exists", 64), "receipt.exists"),
  };
}

function facetVerdict(value: number): CollectionFacetInput["verdict"] {
  const result = ["unknown", "green", "amber", "red"][value];
  if (result === undefined) throw new TypeError("Unsupported collection facet verdict.");
  return result as CollectionFacetInput["verdict"];
}

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;
function nonzeroAddress(...values: readonly Hex[]): Hex | undefined {
  return values.find((value) => value !== ZERO_ADDRESS);
}

function facetInput(
  id: VerificationFacetId,
  code: number,
  state: VerificationStateSnapshot,
  receiptCurrent: boolean,
): CollectionFacetInput {
  const verdict = id === "content" && !receiptCurrent && !state.routeLocked ? "red" : facetVerdict(code);
  if (id === "content" && !receiptCurrent) {
    return { verdict: "red", reason: "Recorded collection receipt is stale or no longer matches current onchain state." };
  }
  const authority = id === "route"
    ? nonzeroAddress(state.pointerAuthority, state.upgradeAuthority)
    : id === "governance"
      ? nonzeroAddress(state.publisherAuthority, state.activationAuthority)
      : id === "mint"
        ? nonzeroAddress(state.mintPolicyAuthority, state.mintAuthority)
        : id === "supply"
          ? nonzeroAddress(state.capAuthority)
          : id === "upgrade"
            ? nonzeroAddress(state.upgradeAuthority, state.proxyAdmin, state.beacon)
            : undefined;
  const timelock = id === "governance" ? nonzeroAddress(state.governanceTimelock)
    : id === "mint" ? nonzeroAddress(state.mintTimelock)
      : id === "supply" ? nonzeroAddress(state.supplyTimelock)
        : id === "upgrade" ? nonzeroAddress(state.upgradeTimelock) : undefined;
  const reason = id === "route"
    ? verdict === "green" ? "The ERC-721 tokenURI route is locked to the tracked Keel resolver."
      : verdict === "amber" ? "A named onchain authority can redirect the presentation route."
        : verdict === "unknown" ? "The presentation route is not verifiable by the approved policy."
          : "The route proof is contradictory or redirectable without a valid authority proof."
    : id === "content"
      ? "The current tokenURI, manifest digest, portable root, anchor, and receipt state match at the pinned block."
      : id === "governance"
        ? verdict === "unknown" ? "Revision governance authorities are not contract-provable by this hook."
          : verdict === "green" ? "Revision governance is fixed by the verified policy."
            : verdict === "amber" ? "Tracked Keel revisions remain controlled by the named publisher or timelock."
              : "Revision governance claims are contradictory."
        : id === "mint"
          ? verdict === "unknown" ? "Mint status and all mint authorities are not contract-provable by this hook."
            : verdict === "green" ? `Mint policy is fixed (status ${state.mintStatus}, access mode ${state.mintAccessMode}).`
              : verdict === "amber" ? "Mint policy remains controlled by the named authority or timelock."
                : "Mint status or authority claims are contradictory."
          : id === "supply"
            ? verdict === "unknown" ? "Supply and cap controls are not contract-provable by this hook."
              : verdict === "green" ? `Supply is verified: ${state.totalSupply} outstanding, cap ${state.maxSupply}, ${state.remainingMintable} remaining.`
                : verdict === "amber" ? "The verified supply cap remains controlled by the named authority or timelock."
                  : "Supply arithmetic or cap claims are contradictory."
            : verdict === "unknown" ? "Upgrade controls are not contract-provable by this hook."
              : verdict === "green" ? "The verified direct runtime has no mutable proxy or beacon path."
                : verdict === "amber" ? "The runtime remains upgradeable by the named authority."
                  : "Upgradeability claims are contradictory.";
  return {
    verdict,
    ...(authority === undefined ? {} : { authority }),
    ...(timelock === undefined ? {} : { timelock }),
    reason,
  };
}

function sameAddress(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameIntegrity(source: ResourceSource, integrity: Integrity): boolean {
  return (
    source.integrity.algorithm === integrity.algorithm &&
    source.integrity.digest === integrity.digest &&
    source.integrity.byteLength === integrity.byteLength
  );
}

function integrityFor(source: KeelObjectSourceDescriptor): Integrity {
  return {
    algorithm: source.digestAlgorithm,
    digest: source.decodedDigest,
    byteLength: source.byteLength,
  };
}

function onchainSource(chainId: number, source: KeelObjectSourceDescriptor): OnchainSource {
  return {
    kind: "onchain",
    chainId,
    store: source.store,
    objectId: source.contentObjectId,
    integrity: integrityFor(source),
  };
}

/**
 * A mirror is only a mirror if it is provably the same bytes. Every field here
 * is a proof input the fidelity link committed to on chain, and a link that
 * disagrees with the object descriptor on any of them is not a slower copy of
 * the artwork — it is a different artwork, and it is dropped.
 *
 * This check is unchanged by the transport default. Whether the mirror is ever
 * fetched is `gatewayTransport`'s business; whether it would have been the same
 * bytes is this function's, and those are separate questions.
 */
function hybridSource(link: KeelFidelityLink, source: KeelObjectSourceDescriptor): UriSource | undefined {
  if (
    link.fidelity !== 2 ||
    link.digestAlgorithm !== source.digestAlgorithm ||
    link.decodedDigest !== source.decodedDigest ||
    link.byteLength !== source.byteLength ||
    link.mediaType !== source.mediaType
  ) return undefined;
  return {
    kind: "uri",
    uri: link.uri,
    compression: link.compression,
    integrity: {
      algorithm: link.digestAlgorithm,
      digest: link.decodedDigest,
      byteLength: link.byteLength,
    },
    immutable: link.scheme === 1 || link.scheme === 3,
  };
}

/**
 * Resolve the two knobs into one. `gatewayTransport` wins when both are given;
 * a caller that has migrated should not have an old option quietly override the
 * new one.
 */
export function resolveGatewayTransport(options: {
  readonly gatewayTransport?: KeelGatewayTransport;
  readonly sourcePreference?: "hybrid-first" | "onchain-first";
}): KeelGatewayTransport {
  if (options.gatewayTransport !== undefined) return options.gatewayTransport;
  if (options.sourcePreference === "hybrid-first") return "preferred";
  if (options.sourcePreference === "onchain-first") return "fallback";
  return DEFAULT_GATEWAY_TRANSPORT;
}

function bindResource(
  resource: ArtifactResource,
  chainId: number,
  source: KeelObjectSourceDescriptor,
  links: readonly KeelFidelityLink[],
  transport: KeelGatewayTransport = DEFAULT_GATEWAY_TRANSPORT,
): ArtifactResource {
  if (resource.mediaType !== source.mediaType) {
    throw new TypeError(`Resource ${resource.id} media type does not match its Keel object descriptor.`);
  }
  const integrity = integrityFor(source);
  // A prior `uri` source is a gateway too, whatever it was declared for, so it
  // is held to the same toggle as the fidelity mirror. Everything else already
  // comes from the chain or from the document.
  const prior = resource.sources.filter(
    (candidate) => sameIntegrity(candidate, integrity) && (transport !== "off" || candidate.kind !== "uri"),
  );
  const hybrid = transport === "off"
    ? undefined
    : links.map((link) => hybridSource(link, source)).find((candidate) => candidate !== undefined);
  const canonical = onchainSource(chainId, source);
  return {
    ...resource,
    sources: transport === "preferred"
      ? [...(hybrid === undefined ? [] : [hybrid]), canonical, ...prior]
      : [canonical, ...(hybrid === undefined ? [] : [hybrid]), ...prior],
  };
}

function requireCommitment(manifest: ArtifactManifest, commitment: ManifestCommitment, extension: KeelRuntimeExtension): void {
  if (commitment.integrity.algorithm !== "sha256" || !BYTES32.test(commitment.integrity.digest)) {
    throw new TypeError("Keel manifests require a verified SHA-256 manifest commitment.");
  }
  const registry = commitment.registry;
  if (registry === undefined || !registry.verified || manifest.anchor === undefined) {
    throw new TypeError("Keel manifests require a verified KeelIndex commitment.");
  }
  const driveAnchor = registry.driveAnchor ?? registry.anchor;
  if (
    driveAnchor.chainId !== extension.chainId ||
    driveAnchor.tokenId !== extension.tokenId ||
    !sameAddress(driveAnchor.collection, manifest.anchor.collection)
  ) throw new TypeError("Keel extension does not match the verified KeelIndex anchor.");
  if (manifest.anchor.scope === "collection" && registry.driveAnchor === undefined) {
    throw new TypeError("Collection-scoped Keel manifests require the exact verified token request anchor.");
  }
}

function resolveRuntimeExtension(
  extension: KeelRuntimeExtension,
  commitment: ManifestCommitment,
  options: BindKeelManifestOptions,
): KeelRuntimeExtension {
  const driveAnchor = commitment.registry?.driveAnchor ?? commitment.registry?.anchor;
  const anchorTokenId = driveAnchor?.tokenId;
  if (extension.tokenId === KEEL_ANCHOR_TOKEN_ID && (anchorTokenId === undefined || !DECIMAL_UINT.test(anchorTokenId))) {
    throw new TypeError("Dynamic Keel token binding requires a verified decimal anchor tokenId.");
  }
  const tokenId = extension.tokenId === KEEL_ANCHOR_TOKEN_ID ? anchorTokenId! : extension.tokenId;
  const character = extension.character === undefined
    ? undefined
    : {
        ...extension.character,
        characterId: extension.character.characterId === KEEL_ANCHOR_TOKEN_ID
          ? tokenId
          : extension.character.characterId === KEEL_STAKED_CHARACTER_ID
            ? decimalUint(options.stakedCharacterId, "stakedCharacterId")
            : extension.character.characterId,
      };
  const map = extension.map === undefined
    ? undefined
    : {
        ...extension.map,
        mapId: extension.map.mapId === KEEL_ANCHOR_TOKEN_ID ? tokenId : extension.map.mapId,
      };
  const collectionVerification = extension.collectionVerification === undefined
    ? undefined
    : {
        ...extension.collectionVerification,
        tokenId: extension.collectionVerification.tokenId === KEEL_ANCHOR_TOKEN_ID
          ? tokenId
          : extension.collectionVerification.tokenId,
      };
  return {
    ...extension,
    tokenId,
    ...(character === undefined ? {} : { character }),
    ...(map === undefined ? {} : { map }),
    ...(collectionVerification === undefined ? {} : { collectionVerification }),
  };
}

export async function bindKeelManifest(
  manifest: ArtifactManifest,
  commitment: ManifestCommitment,
  options: BindKeelManifestOptions,
): Promise<BoundKeelManifest> {
  const extension = resolveRuntimeExtension(parseKeelRuntimeExtension(manifest), commitment, options);
  requireCommitment(manifest, commitment, extension);
  if (extension.mode === "exact" && options.blockNumber === undefined) {
    throw new TypeError("Exact Keel binding requires a pinned blockNumber.");
  }
  if (options.blockNumber !== undefined && options.blockNumber < 0n) throw new RangeError("blockNumber cannot be negative.");
  if (extension.injection !== undefined) {
    if (options.blockNumber === undefined || options.blockHash === undefined || options.blockTimestamp === undefined) {
      throw new TypeError("Keel live injection requires a pinned block number, hash, and timestamp.");
    }
    if (!BYTES32.test(options.blockHash)) throw new TypeError("Keel injection block hash must be canonical bytes32.");
    if (options.blockTimestamp < 0n) throw new RangeError("blockTimestamp cannot be negative.");
    const expected = extension.injection.expectedContext;
    if (
      expected !== undefined &&
      (options.blockNumber.toString() !== expected.blockNumber ||
        options.blockHash !== expected.blockHash ||
        options.blockTimestamp.toString() !== expected.blockTimestamp)
    ) {
      throw new Error("Keel chain context does not match the manifest-committed replay snapshot.");
    }
  }
  if (
    extension.collectionVerification !== undefined
    && (options.blockNumber === undefined || options.blockHash === undefined || options.blockTimestamp === undefined)
  ) throw new TypeError("Collection verification requires one pinned block number, hash, and timestamp.");
  const signal = options.signal ?? new AbortController().signal;
  const read = (address_: Hex, functionName: KeelContractFunction, args: readonly unknown[] = []): Promise<unknown> =>
    options.readContract({
      chainId: extension.chainId,
      address: address_,
      functionName,
      args,
      ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
      ...(options.blockHash === undefined ? {} : { blockHash: options.blockHash }),
      signal,
    });

  const anchor = commitment.registry?.anchor;
  if (anchor === undefined) throw new TypeError("Verified KeelIndex anchor is missing.");
  const [viewerObjectRegistry, viewerKeelIndex, harnessCollection, effectiveValue] = await Promise.all([
    read(extension.harnessRegistry, "artifactRegistry"),
    read(extension.harnessRegistry, "keelIndex"),
    read(extension.harnessRegistry, "harnessCollection", [extension.viewerId]),
    read(extension.harnessRegistry, "effectiveHarness", [extension.viewerId, BigInt(extension.tokenId)]),
  ]);
  if (!sameAddress(contractAddress(scalar(viewerObjectRegistry), "harnessRegistry.artifactRegistry"), extension.artifactRegistry)) {
    throw new Error("Keel HarnessRegistry is not bound to the declared ObjectRegistry.");
  }
  if (!sameAddress(contractAddress(scalar(viewerKeelIndex), "harnessRegistry.keelIndex"), anchor.registry)) {
    throw new Error("Keel HarnessRegistry is not bound to the verified KeelIndex.");
  }
  if (!sameAddress(contractAddress(scalar(harnessCollection), "harnessRegistry.harnessCollection"), anchor.collection)) {
    throw new Error("Keel viewer collection does not match the verified KeelIndex collection.");
  }

  const effective = parseEffectiveViewer(effectiveValue);
  if (effective.manifestDigest !== commitment.integrity.digest) {
    throw new Error("Effective Keel viewer does not commit the verified manifest digest.");
  }
  if (effective.slotObjectIds.length !== extension.slotResources.length) {
    throw new Error("Effective Keel viewer slot count does not match the manifest resource map.");
  }
  if (
    extension.expectedViewer !== undefined &&
    (extension.expectedViewer.harnessRevision !== effective.harnessRevision ||
      extension.expectedViewer.forkRevision !== effective.forkRevision ||
      extension.expectedViewer.selectionDigest !== effective.selectionDigest)
  ) throw new Error("Effective Keel viewer does not match the exact manifest snapshot.");

  if (extension.linkRegistry !== undefined) {
    const linkedObjectRegistry = contractAddress(
      scalar(await read(extension.linkRegistry, "artifactRegistry")),
      "linkRegistry.artifactRegistry",
    );
    if (!sameAddress(linkedObjectRegistry, extension.artifactRegistry)) {
      throw new Error("Keel LinkRegistry is not bound to the declared ObjectRegistry.");
    }
  }

  const objects: KeelObjectBinding[] = [];
  for (let index = 0; index < effective.slotObjectIds.length; index += 1) {
    const objectId = effective.slotObjectIds[index];
    const objectRevision = effective.selectedObjectRevisions[index];
    const resource = extension.slotResources[index];
    if (objectId === undefined || objectRevision === undefined || resource === undefined) {
      throw new Error("Effective Keel viewer returned an incomplete slot.");
    }
    const source = parseObjectSource(
      await read(extension.artifactRegistry, "artifactRevisionSource", [objectId, BigInt(objectRevision)]),
      objectId,
      objectRevision,
    );
    const fidelityLinks: KeelFidelityLink[] = [];
    if (extension.linkRegistry !== undefined) {
      for (const fidelity of [0, 1, 2] as const) {
        const exists = await read(extension.linkRegistry, "linkExists", [objectId, BigInt(objectRevision), fidelity]);
        if (scalar(exists) !== true) continue;
        const link = parseLink(await read(extension.linkRegistry, "fidelityLink", [objectId, BigInt(objectRevision), fidelity]));
        if (link.objectId !== objectId || link.objectRevision !== objectRevision || link.fidelity !== fidelity) {
          throw new Error("Keel LinkRegistry returned a link for a different object revision.");
        }
        fidelityLinks.push(link);
      }
    }
    objects.push({ resource, source, fidelityLinks });
  }

  let presentationState: KeelPresentationStateBinding | undefined;
  let seasonalGroveState: KeelSeasonalGroveStateResult | undefined;
  let seasonalGroveStateSource: ResourceSource | undefined;
  let boundManifest = manifest;
  if (extension.state !== undefined) {
    const stateReader = options.adapters?.readPresentationState;
    if (stateReader === undefined) {
      throw new TypeError("Keel state binding requires a presentation-state reader.");
    }
    const policyValue = await read(extension.state.registry, "presentationPolicy", [extension.state.policyId]);
    const policyBinding = tupleValue(policyValue, "binding", 2);
    if (
      !bool(tupleValue(policyValue, "exists", 10), "presentationState.policy.exists")
      || safeNumber(tupleValue(policyValue, "authority", 6), "presentationState.policy.authority") !== 2
      || safeNumber(tupleValue(policyValue, "updateKind", 7), "presentationState.policy.updateKind") !== 0
      || safeNumber(tupleValue(policyValue, "valueKind", 8), "presentationState.policy.valueKind") !== 5
      || !sameAddress(contractAddress(tupleValue(policyBinding, "collection", 0), "presentationState.binding.collection"), anchor.collection)
      || uintBig(tupleValue(policyBinding, "tokenId", 1), "presentationState.binding.tokenId") !== BigInt(extension.tokenId)
    ) throw new Error("Keel presentation state policy is not a token-owner canonical JSON policy for this token.");
    const stateResult: KeelPresentationStateResult = await stateReader(
      {
        chainId: extension.chainId,
        registry: extension.state.registry,
        policyId: extension.state.policyId,
        ...(extension.state.mediaType === undefined ? {} : { mediaType: extension.state.mediaType }),
      },
      signal,
    );
    if (
      stateResult.policyId !== extension.state.policyId
      || stateResult.revision < 1
      || stateResult.byteLength !== stateResult.value.byteLength
      || stateResult.mediaType.length === 0
      || (extension.state.mediaType !== undefined && stateResult.mediaType !== extension.state.mediaType)
      || stateResult.mediaTypeDigest !== bytes32(tupleValue(policyValue, "mediaTypeDigest", 3), "presentationState.policy.mediaTypeDigest")
      || safeNumber(tupleValue(policyValue, "latestRevision", 5), "presentationState.policy.latestRevision", 1) !== stateResult.revision
    ) throw new Error("Keel presentation state read does not match its policy metadata.");
    const stateIntegrity = await createIntegrity(stateResult.value);
    if (
      stateIntegrity.digest !== stateResult.valueDigest
      || stateIntegrity.byteLength !== stateResult.byteLength
    ) throw new Error("Keel presentation state digest does not match its canonical bytes.");
    const stateResource = manifest.resources.find((resource) => resource.id === extension.state!.resource);
    if (stateResource === undefined || stateResource.mediaType !== stateResult.mediaType) {
      throw new Error("Keel presentation state resource does not match the policy media type.");
    }
    const source: ResourceSource = {
      kind: "inline",
      data: encodeBase64(stateResult.value),
      encoding: "base64",
      integrity: stateIntegrity,
    };
    boundManifest = {
      ...manifest,
      resources: manifest.resources.map((resource) =>
        resource.id === extension.state!.resource ? { ...resource, sources: [source] } : resource,
      ),
    };
    presentationState = {
      registry: extension.state.registry,
      policyId: extension.state.policyId,
      resource: extension.state.resource,
      revision: stateResult.revision,
      valueDigest: stateResult.valueDigest,
      byteLength: stateResult.byteLength,
      mediaType: stateResult.mediaType,
      sourceManifestDigest: stateResult.sourceManifestDigest,
      sourceSequence: stateResult.sourceSequence,
    };
  }

  if (extension.seasonalGroveState !== undefined) {
    const reader = options.adapters?.readSeasonalGroveState;
    if (reader === undefined) {
      throw new TypeError("Keel Seasonal Grove binding requires a contract-state reader.");
    }
    if (
      !sameAddress(extension.seasonalGroveState.collection, anchor.collection)
      || extension.seasonalGroveState.tokenId !== extension.tokenId
    ) throw new Error("Seasonal Grove state contract is not bound to the anchored token.");
    const stateResult = await reader({
      chainId: extension.chainId,
      contract: extension.seasonalGroveState.contract,
      collection: extension.seasonalGroveState.collection,
      tokenId: extension.seasonalGroveState.tokenId,
    }, signal);
    if (
      !sameAddress(stateResult.contract, extension.seasonalGroveState.contract)
      || !sameAddress(stateResult.collection, anchor.collection)
      || stateResult.tokenId !== extension.tokenId
      || stateResult.revision < 1
      || stateResult.treeType < 0
      || stateResult.treeType > 5
      || stateResult.bornAt.length === 0
      || stateResult.deathAt.length === 0
      || stateResult.effectiveAt.length === 0
    ) throw new Error("Seasonal Grove state contract returned an invalid token-bound state.");
    const treeTypes = ["cherry", "oak", "pine", "birch", "willow", "acacia"] as const;
    const stateValue = {
      protocol: "keel-seasonal-grove-state@1",
      source: "contract",
      contract: stateResult.contract,
      collection: stateResult.collection,
      tokenId: stateResult.tokenId,
      owner: stateResult.owner,
      treeType: treeTypes[stateResult.treeType],
      treeTypeId: stateResult.treeType,
      seed: stateResult.treeSeed,
      bornAt: stateResult.bornAt,
      deathAt: stateResult.deathAt,
      timezoneId: stateResult.timezoneId,
      timezone: stateResult.timezone,
      regionId: stateResult.regionId,
      region: stateResult.region,
      revision: stateResult.revision,
      effectiveAt: stateResult.effectiveAt,
      dead: stateResult.dead,
      allowedOwnerMutations: ["timezone", "region"],
    };
    const value = utf8ToBytes(canonicalJson(stateValue));
    const integrity = await createIntegrity(value);
    const resource = manifest.resources.find((item) => item.id === extension.seasonalGroveState!.resource);
    if (resource === undefined || resource.mediaType !== "application/json") {
      throw new Error("Seasonal Grove state resource must be a declared JSON slot.");
    }
    seasonalGroveStateSource = {
      kind: "inline",
      data: encodeBase64(value),
      encoding: "base64",
      integrity,
    };
    seasonalGroveState = stateResult;
  }

  let seed: KeelSeedBinding | undefined;
  if (extension.seedRegistry !== undefined) {
    const [seedHarnessRegistry, seedKeelIndex, seedSetValue, seedSetIdValue] = await Promise.all([
      read(extension.seedRegistry, "harnessRegistry"),
      read(extension.seedRegistry, "keelIndex"),
      read(extension.seedRegistry, "seedSetForViewerRevision", [extension.viewerId, BigInt(effective.harnessRevision)]),
      read(extension.seedRegistry, "predictSeedSetId", [extension.viewerId, BigInt(effective.harnessRevision)]),
    ]);
    if (!sameAddress(contractAddress(scalar(seedHarnessRegistry), "seedRegistry.harnessRegistry"), extension.harnessRegistry)) {
      throw new Error("Keel SeedRegistry is not bound to the declared HarnessRegistry.");
    }
    if (!sameAddress(contractAddress(scalar(seedKeelIndex), "seedRegistry.keelIndex"), anchor.registry)) {
      throw new Error("Keel SeedRegistry is not bound to the verified KeelIndex.");
    }
    if (!bool(tupleValue(seedSetValue, "exists", 9), "seedSet.exists")) throw new Error("Keel seed set is missing.");
    if (
      bytes32(tupleValue(seedSetValue, "viewerId", 0), "seedSet.viewerId") !== extension.viewerId ||
      safeNumber(tupleValue(seedSetValue, "harnessRevision", 1), "seedSet.harnessRevision", 1) !== effective.harnessRevision ||
      !sameAddress(contractAddress(tupleValue(seedSetValue, "collection", 2), "seedSet.collection"), anchor.collection) ||
      bytes32(tupleValue(seedSetValue, "viewerManifestDigest", 3), "seedSet.viewerManifestDigest") !== effective.manifestDigest
    ) throw new Error("Keel seed set does not match the effective viewer.");
    const seedSetId = bytes32(scalar(seedSetIdValue), "seedSetId");
    const derivedTokenSeed = bytes32(
      scalar(await read(extension.seedRegistry, "deriveTokenSeed", [seedSetId, BigInt(extension.tokenId)])),
      "derivedTokenSeed",
    );
    seed = {
      seedSetId,
      rootSeed: bytes32(tupleValue(seedSetValue, "rootSeed", 4), "seedSet.rootSeed"),
      provenanceDigest: bytes32(tupleValue(seedSetValue, "provenanceDigest", 5), "seedSet.provenanceDigest"),
      derivedTokenSeed,
      publisher: contractAddress(tupleValue(seedSetValue, "publisher", 7), "seedSet.publisher"),
      revealer: contractAddress(tupleValue(seedSetValue, "revealer", 8), "seedSet.revealer"),
    };
    if (manifest.runtime.determinism.mode === "replay" && manifest.runtime.determinism.seed !== derivedTokenSeed) {
      throw new Error("Manifest replay seed does not match the Keel token seed.");
    }
  }

  let characterRecipe: RuntimeContext | undefined;
  let mapCharacterSeed: Hex | undefined;
  let mapSeed: Hex | undefined;
  let mapBuildRevision: number | undefined;
  let mapPortableRoot: Hex | undefined;
  let mapPortableManifestObjectId: Hex | undefined;
  let mapPortableDecodedObjectId: Hex | undefined;
  let mapPortableAnchorRoot: Hex | undefined;
  let mapPortableManifestObjectRevision: number | undefined;
  let mapPortableDecodedObjectRevision: number | undefined;
  const verifyPortableBinding = async (
    anchorRegistry: Hex,
    portable: {
      readonly root: Hex;
      readonly manifestObjectId: Hex;
      readonly manifestObjectRevision: number;
      readonly decodedObjectId: Hex;
      readonly decodedObjectRevision: number;
      readonly anchorRoot: Hex;
    },
    label: string,
  ): Promise<void> => {
    const [sourceAnchorValue, anchorValue] = await Promise.all([
      read(anchorRegistry, "sourceAnchor", [portable.manifestObjectId, BigInt(portable.manifestObjectRevision)]),
      read(anchorRegistry, "anchor", [portable.anchorRoot]),
    ]);
    if (bytes32(scalar(sourceAnchorValue), `${label}.sourceAnchor`) !== portable.anchorRoot) {
      throw new Error(`${label} portable source anchor does not match its pinned anchor root.`);
    }
    if (
      !bool(tupleValue(anchorValue, "exists", 7), `${label}.anchor.exists`)
      || bytes32(tupleValue(anchorValue, "manifestObjectId", 0), `${label}.anchor.manifestObjectId`) !== portable.manifestObjectId
      || safeNumber(tupleValue(anchorValue, "manifestObjectRevision", 1), `${label}.anchor.manifestObjectRevision`, 1)
        !== portable.manifestObjectRevision
      || bytes32(tupleValue(anchorValue, "decodedObjectId", 2), `${label}.anchor.decodedObjectId`) !== portable.decodedObjectId
      || safeNumber(tupleValue(anchorValue, "decodedObjectRevision", 3), `${label}.anchor.decodedObjectRevision`, 1)
        !== portable.decodedObjectRevision
      || bytes32(tupleValue(anchorValue, "portableRoot", 4), `${label}.anchor.portableRoot`) !== portable.root
    ) throw new Error(`${label} portable anchor does not match the pinned Keel revisions.`);
  };
  if (extension.character !== undefined) {
    const [configuredCollectionValue, characterPortableRegistryValue] = await Promise.all([
      read(extension.character.registry, "characterCollection"),
      read(extension.character.registry, "portableAnchorRegistry"),
    ]);
    const configuredCollection = contractAddress(scalar(configuredCollectionValue), "characterRegistry.characterCollection");
    const characterPortableRegistry = contractAddress(
      scalar(characterPortableRegistryValue), "characterRegistry.portableAnchorRegistry",
    );
    if (!sameAddress(configuredCollection, extension.character.collection)) {
      throw new Error("Vault character registry is not bound to the declared character collection.");
    }
    const directRecipe = parseCharacterRecipe(
      await read(extension.character.registry, "renderRecipe", [BigInt(extension.character.characterId)]),
      "characterRegistry.renderRecipe",
    );
    await verifyPortableBinding(characterPortableRegistry, {
      root: directRecipe.portableRoot!,
      manifestObjectId: directRecipe.portableManifestObjectId!,
      manifestObjectRevision: directRecipe.portableManifestObjectRevision!,
      decodedObjectId: directRecipe.portableDecodedObjectId!,
      decodedObjectRevision: directRecipe.portableDecodedObjectRevision!,
      anchorRoot: directRecipe.portableAnchorRoot!,
    }, "characterRegistry.renderRecipe");
    if (extension.map === undefined) {
      if (
        extension.character.characterId !== extension.tokenId
        || !sameAddress(extension.character.collection, anchor.collection)
      ) throw new Error("Standalone Vault character binding does not match the anchored token.");
      characterRecipe = directRecipe;
    } else {
      if (extension.map.mapId !== extension.tokenId || !sameAddress(extension.map.collection, anchor.collection)) {
        throw new Error("Vault map binding does not match the anchored token.");
      }
      const [mapCharacterCollection, mapCollection, mapCharacterRegistry, mapPortableRegistryValue, mapRuntime, mapSeedValue] = await Promise.all([
        read(extension.map.registry, "characterCollection"),
        read(extension.map.registry, "mapCollection"),
        read(extension.map.registry, "characterRegistry"),
        read(extension.map.registry, "portableAnchorRegistry"),
        read(extension.map.registry, "mapCharacterRuntime", [
          BigInt(extension.map.mapId),
          BigInt(extension.character.characterId),
        ]),
        read(extension.map.registry, "mapCharacterSeed", [
          BigInt(extension.map.mapId),
          BigInt(extension.character.characterId),
        ]),
      ]);
      if (
        !sameAddress(contractAddress(scalar(mapCharacterCollection), "arcade.characterCollection"), extension.character.collection)
        || !sameAddress(contractAddress(scalar(mapCollection), "arcade.mapCollection"), extension.map.collection)
        || !sameAddress(contractAddress(scalar(mapCharacterRegistry), "arcade.characterRegistry"), extension.character.registry)
      ) throw new Error("Vault arcade registry does not match the manifest-declared character/map graph.");
      const mapPortableRegistry = contractAddress(scalar(mapPortableRegistryValue), "arcade.portableAnchorRegistry");
      if (!sameAddress(mapPortableRegistry, characterPortableRegistry)) {
        throw new Error("Vault arcade and character registries do not share the same portable anchor registry.");
      }
      mapBuildRevision = safeNumber(
        tupleValue(mapRuntime, "mapBuildRevision", 0), "mapCharacterRuntime.mapBuildRevision", 1,
      );
      const mapBuild = tupleValue(mapRuntime, "build", 1);
      mapSeed = bytes32(
        tupleValue(mapBuild, "mapSeed", 7),
        "mapCharacterRuntime.build.mapSeed",
      );
      mapPortableRoot = bytes32(tupleValue(mapBuild, "portableRoot", 2), "mapCharacterRuntime.build.portableRoot");
      mapPortableManifestObjectId = bytes32(
        tupleValue(mapBuild, "portableManifestObjectId", 3), "mapCharacterRuntime.build.portableManifestObjectId",
      );
      mapPortableDecodedObjectId = bytes32(
        tupleValue(mapBuild, "portableDecodedObjectId", 4), "mapCharacterRuntime.build.portableDecodedObjectId",
      );
      mapPortableAnchorRoot = bytes32(
        tupleValue(mapBuild, "portableAnchorRoot", 5), "mapCharacterRuntime.build.portableAnchorRoot",
      );
      mapPortableManifestObjectRevision = safeNumber(
        tupleValue(mapBuild, "portableManifestObjectRevision", 8),
        "mapCharacterRuntime.build.portableManifestObjectRevision",
        1,
      );
      mapPortableDecodedObjectRevision = safeNumber(
        tupleValue(mapBuild, "portableDecodedObjectRevision", 9),
        "mapCharacterRuntime.build.portableDecodedObjectRevision",
        1,
      );
      await verifyPortableBinding(mapPortableRegistry, {
        root: mapPortableRoot,
        manifestObjectId: mapPortableManifestObjectId,
        manifestObjectRevision: mapPortableManifestObjectRevision,
        decodedObjectId: mapPortableDecodedObjectId,
        decodedObjectRevision: mapPortableDecodedObjectRevision,
        anchorRoot: mapPortableAnchorRoot,
      }, "mapCharacterRuntime.build");
      const stakedRecipe = parseCharacterRecipe(
        tupleValue(mapRuntime, "character", 2),
        "mapCharacterRuntime.character",
      );
      if (!sameCharacterRecipe(directRecipe, stakedRecipe)) {
        throw new Error("Vault staked character recipe does not match its character registry recipe.");
      }
      characterRecipe = stakedRecipe;
      mapCharacterSeed = bytes32(scalar(mapSeedValue), "mapCharacterSeed");
    }
  }
  if (
    seed !== undefined
    && characterRecipe !== undefined
    && extension.injection?.fields.includes("token.seed") === true
    && extension.injection.fields.includes("character.seed")
    && seed.derivedTokenSeed !== characterRecipe.derivedTokenSeed
  ) throw new Error("Keel token seed does not match the Vault character recipe seed.");

  let equipment: KeelEquipmentBinding | undefined;
  if (extension.equipment !== undefined) {
    if (extension.equipment.characterId !== extension.tokenId) {
      throw new TypeError("Keel equipment characterId must match the anchored tokenId.");
    }
    const [inventoryObjectRegistry, inventoryKeelIndex, inventoryCharacterCollection, loadoutValue] = await Promise.all([
      read(extension.equipment.inventory, "artifactRegistry"),
      read(extension.equipment.inventory, "keelIndex"),
      read(extension.equipment.inventory, "characterCollection"),
      read(extension.equipment.inventory, "loadout", [BigInt(extension.equipment.characterId)]),
    ]);
    if (!sameAddress(contractAddress(scalar(inventoryObjectRegistry), "inventory.artifactRegistry"), extension.artifactRegistry)) {
      throw new Error("Keel inventory is not bound to the declared ObjectRegistry.");
    }
    if (!sameAddress(contractAddress(scalar(inventoryKeelIndex), "inventory.keelIndex"), anchor.registry)) {
      throw new Error("Keel inventory is not bound to the verified KeelIndex.");
    }
    if (
      !sameAddress(
        contractAddress(scalar(inventoryCharacterCollection), "inventory.characterCollection"),
        extension.equipment.characterCollection,
      ) ||
      !sameAddress(extension.equipment.characterCollection, anchor.collection)
    ) throw new Error("Keel inventory character collection does not match the anchored collection.");

    const rawEntries = array(tupleValue(loadoutValue, "entries", 0), "loadout.entries");
    const entries = rawEntries.map(parseLoadoutEntry);
    if (entries.length !== 9 || entries.some((entry, index) => entry.slot !== index)) {
      throw new Error("Keel inventory returned a non-canonical nine-slot loadout.");
    }
    const loadoutDigest = bytes32(tupleValue(loadoutValue, "digest", 1), "loadout.digest");
    if (
      extension.equipment.expectedLoadoutDigest !== undefined &&
      extension.equipment.expectedLoadoutDigest !== loadoutDigest
    ) throw new Error("Keel loadout does not match the exact manifest snapshot.");

    const equipmentSources = new Map<number, KeelObjectSourceDescriptor>();
    for (const mapping of extension.equipment.resources) {
      const entry = entries[mapping.slot];
      if (entry === undefined || !entry.equipped) continue;
      const value = await read(extension.equipment.inventory, "equipmentSource", [
        BigInt(extension.equipment.characterId),
        mapping.slot,
      ]);
      const definitionId = bytes32(tupleValue(value, "definitionId", 0), "equipmentSource.definitionId");
      const objectId = bytes32(tupleValue(value, "objectId", 1), "equipmentSource.objectId");
      const objectRevision = safeNumber(tupleValue(value, "objectRevision", 2), "equipmentSource.objectRevision", 1);
      if (definitionId !== entry.definitionId || objectId !== entry.objectId || objectRevision !== entry.objectRevision) {
        throw new Error("Keel equipment source does not match the committed loadout entry.");
      }
      const source = parseObjectSource(
        [
          tupleValue(value, "store", 3),
          tupleValue(value, "contentObjectId", 4),
          tupleValue(value, "digestAlgorithm", 5),
          tupleValue(value, "decodedDigest", 6),
          tupleValue(value, "byteLength", 7),
          tupleValue(value, "compression", 8),
          tupleValue(value, "mediaType", 9),
        ],
        objectId,
        objectRevision,
      );
      equipmentSources.set(mapping.slot, source);
    }
    equipment = {
      characterId: extension.equipment.characterId,
      loadoutDigest,
      entries,
      sources: equipmentSources,
    };
  }

  const resources = new Map(manifest.resources.map((resource) => [resource.id, resource] as const));
  const gatewayTransport = resolveGatewayTransport(options);
  for (const item of objects) {
    const resource = resources.get(item.resource);
    if (resource === undefined) throw new Error(`Keel resource ${item.resource} disappeared during binding.`);
    resources.set(item.resource, bindResource(
      resource,
      extension.chainId,
      item.source,
      item.fidelityLinks,
      gatewayTransport,
    ));
  }
  for (const mapping of extension.equipment?.resources ?? []) {
    const source = equipment?.sources.get(mapping.slot);
    if (source === undefined) continue;
    const resource = resources.get(mapping.resource);
    if (resource === undefined) throw new Error(`Keel equipment resource ${mapping.resource} disappeared during binding.`);
    resources.set(mapping.resource, bindResource(resource, extension.chainId, source, [], gatewayTransport));
  }
  if (extension.seasonalGroveState !== undefined && seasonalGroveStateSource !== undefined) {
    const resource = resources.get(extension.seasonalGroveState.resource);
    if (resource === undefined) throw new Error("Seasonal Grove state resource disappeared during binding.");
    resources.set(extension.seasonalGroveState.resource, { ...resource, sources: [seasonalGroveStateSource] });
  }

  let collectionVerification: CollectionVerificationInput | undefined;
  if (extension.collectionVerification !== undefined) {
    const verification = extension.collectionVerification;
    if (verification.tokenId !== extension.tokenId) {
      throw new Error("Collection verification token does not match the anchored runtime token.");
    }
    const portableValue = manifest.extensions?.["keel.portable"];
    const portable = object(portableValue, "extensions[keel.portable]");
    if (portable.protocol !== "keel-presentation-portable-binding@1") {
      throw new TypeError("Collection verification requires the canonical presentation portable binding.");
    }
    const manifestPortableRoot = bytes32(portable.portableRoot, "keel.portable.portableRoot");
    const manifestPortableAnchor = bytes32(portable.portableAnchorRoot, "keel.portable.portableAnchorRoot");
    const verificationTokenId = BigInt(verification.tokenId);
    const [latestValue, policyValue] = await Promise.all([
      read(verification.registry, "latestReceipt", [anchor.collection, verificationTokenId]),
      read(verification.registry, "policy", [verification.policyId]),
    ]);
    const receiptId = bytes32(scalar(latestValue), "collectionVerification.latestReceipt");
    const policyInput = tupleValue(policyValue, "input", 0);
    const policyLane = safeNumber(tupleValue(policyInput, "lane", 0), "collectionVerification.policy.lane");
    const policyRuntimeCodeHash = bytes32(
      tupleValue(policyInput, "runtimeCodeHash", 1), "collectionVerification.policy.runtimeCodeHash",
    );
    const policyVersion = safeNumber(tupleValue(policyInput, "version", 9), "collectionVerification.policy.version", 1);
    if (
      policyLane > 2
      || !bool(tupleValue(policyValue, "enabled", 1), "collectionVerification.policy.enabled")
      || !bool(tupleValue(policyValue, "exists", 2), "collectionVerification.policy.exists")
    ) throw new Error("Collection verification policy is unavailable at the pinned block.");

    const [receiptValue, currentValue] = await Promise.all([
      read(verification.registry, "receipt", [receiptId]),
      read(verification.registry, "receiptCurrent", [receiptId]),
    ]);
    const receipt = parseVerificationReceipt(receiptValue);
    const isCurrent = bool(scalar(currentValue), "collectionVerification.receiptCurrent");
    if (
      !receipt.exists
      || receipt.policyId !== verification.policyId
      || receipt.collection !== anchor.collection.toLowerCase()
      || receipt.tokenId !== verificationTokenId
      || receipt.chainId !== BigInt(extension.chainId)
      || receipt.policyVersion !== policyVersion
      || receipt.lane !== policyLane
      || receipt.runtimeCodeHash !== policyRuntimeCodeHash
      || receipt.manifestDigest !== commitment.integrity.digest
      || receipt.portableRoot !== manifestPortableRoot
      || receipt.portableAnchorRoot !== manifestPortableAnchor
      || receipt.keelIndex !== anchor.registry.toLowerCase()
    ) throw new Error("Collection verification receipt does not bind this exact manifest, collection, policy, and portable anchor.");

    let facetCodes = receipt.facets;
    let state: VerificationStateSnapshot | undefined;
    if (receipt.lane !== 0) {
      const [inspectionValue, canonicalEvidenceValue] = await Promise.all([
        read(verification.registry, "inspectCurrent", [anchor.collection, verificationTokenId, verification.policyId]),
        read(verification.registry, "approvedEvidenceRoot", [anchor.collection, verificationTokenId, verification.policyId]),
      ]);
      state = parseVerificationState(tupleValue(inspectionValue, "state", 0));
      facetCodes = parseVerificationFacets(tupleValue(inspectionValue, "facets", 1), "collectionVerification.inspectCurrent.facets");
      const canonicalEvidence = bytes32(scalar(canonicalEvidenceValue), "collectionVerification.approvedEvidenceRoot");
      if (
        canonicalEvidence !== receipt.evidenceRoot
        || state.expectedTokenURIHash !== receipt.tokenURIHash
        || state.resolver !== receipt.resolver
        || state.keelIndex !== receipt.keelIndex
        || state.presentationScope !== receipt.presentationScope
        || state.presentationRevision !== receipt.presentationRevision
        || state.portableRoot !== receipt.portableRoot
        || state.manifestDigest !== receipt.manifestDigest
      ) {
        if (isCurrent) throw new Error("A current collection receipt disagrees with pinned inspectCurrent state.");
      }
      if (isCurrent && (Object.keys(facetCodes) as VerificationFacetId[]).some((id) => facetCodes[id] !== receipt.facets[id])) {
        throw new Error("A current collection receipt disagrees with pinned facet verdicts.");
      }
    }
    const expired = receipt.expiresAt !== 0n && options.blockTimestamp! > receipt.expiresAt;
    const contentOnlyFacet = (id: VerificationFacetId): CollectionFacetInput => id === "content"
      ? {
          verdict: isCurrent ? "green" : "red",
          reason: isCurrent
            ? "The current tokenURI, manifest digest, portable root, and anchor match the recorded content snapshot."
            : "The recorded content snapshot is stale, revoked, expired, or no longer current.",
        }
      : {
          verdict: "unknown",
          reason: "Not verifiable — this custom contract does not expose an approved Keel hook or adapter.",
        };
    const makeFacet = (id: VerificationFacetId): CollectionFacetInput => state === undefined
      ? contentOnlyFacet(id)
      : facetInput(id, facetCodes[id], state, isCurrent);
    collectionVerification = {
      proofClass: receipt.lane === 0 ? "content-only" : receipt.lane === 1 ? "native-proof" : "adapter-proof",
      receiptId,
      chainId: String(extension.chainId),
      blockNumber: options.blockNumber!.toString(),
      blockHash: options.blockHash!,
      observationBlockNumber: receipt.evidenceBlock.toString(),
      observationBlockHash: receipt.evidenceBlockHash,
      collection: anchor.collection.toLowerCase(),
      tokenId: verification.tokenId,
      policyVersion: String(receipt.policyVersion),
      evidenceRoot: receipt.evidenceRoot,
      presentationRevision: String(receipt.presentationRevision),
      portableRoot: receipt.portableRoot,
      portableAnchorRoot: receipt.portableAnchorRoot,
      presentationContentDigest: receipt.presentationContentDigest,
      revoked: receipt.revoked,
      expired,
      facets: {
        route: makeFacet("route"),
        content: makeFacet("content"),
        governance: makeFacet("governance"),
        mint: makeFacet("mint"),
        supply: makeFacet("supply"),
        upgrade: makeFacet("upgrade"),
      },
    };
  }

  let attestedAnchors: readonly KeelAnchoredChain[] | undefined;
  if (extension.injection?.fields.includes("character.attestedAnchors") === true) {
    const anchorRegistry = extension.attestedAnchorRegistry;
    if (anchorRegistry === undefined) {
      throw new TypeError("Keel character.attestedAnchors injection requires an attested-anchor registry binding.");
    }
    const anchoredObjectId = characterRecipe?.portableManifestObjectId;
    if (anchoredObjectId === undefined) {
      throw new Error("Keel attested-anchor injection requires the character's portable manifest object.");
    }
    attestedAnchors = array(
      await read(anchorRegistry, "objectAnchoredChains", [anchoredObjectId]),
      "attestedAnchorRegistry.objectAnchoredChains",
    ).map((entry, index) => {
      const label = `attestedAnchorRegistry.objectAnchoredChains[${index}]`;
      return {
        family: safeNumber(tupleValue(entry, "family", 0), `${label}.family`, 1),
        network: safeNumber(tupleValue(entry, "network", 1), `${label}.network`),
        objectRevision: safeNumber(tupleValue(entry, "objectRevision", 2), `${label}.objectRevision`, 1),
        anchorId: bytes32(tupleValue(entry, "anchorId", 3), `${label}.anchorId`),
        anchorRoot: bytes32(tupleValue(entry, "anchorRoot", 4), `${label}.anchorRoot`),
      };
    });
  }

  const runtimeContext =
    extension.injection === undefined
      ? undefined
      : (() => {
          const fields = new Set(extension.injection.fields);
          return {
          protocol: "keel-context@1" as const,
            ...(fields.has("chain.id") ? { chainId: extension.chainId } : {}),
            ...(fields.has("block.number") ? { blockNumber: options.blockNumber!.toString() } : {}),
            ...(fields.has("block.hash") ? { blockHash: options.blockHash! } : {}),
            ...(fields.has("block.timestamp") ? { blockTimestamp: options.blockTimestamp!.toString() } : {}),
            ...(fields.has("token.id") ? { tokenId: extension.tokenId } : {}),
            ...(fields.has("token.seed") ? { derivedTokenSeed: seed!.derivedTokenSeed } : {}),
            ...(fields.has("character.seed") ? { derivedTokenSeed: characterRecipe!.derivedTokenSeed } : {}),
            ...(fields.has("character.packedAttributes") ? { packedAttributes: characterRecipe!.packedAttributes } : {}),
            ...(fields.has("character.portableRoot") ? { portableRoot: characterRecipe!.portableRoot } : {}),
            ...(fields.has("character.portableManifestObjectId") ? { portableManifestObjectId: characterRecipe!.portableManifestObjectId } : {}),
            ...(fields.has("character.portableDecodedObjectId") ? { portableDecodedObjectId: characterRecipe!.portableDecodedObjectId } : {}),
            ...(fields.has("character.portableAnchorRoot") ? { portableAnchorRoot: characterRecipe!.portableAnchorRoot } : {}),
            ...(fields.has("character.portableManifestObjectRevision") ? { portableManifestObjectRevision: characterRecipe!.portableManifestObjectRevision } : {}),
            ...(fields.has("character.portableDecodedObjectRevision") ? { portableDecodedObjectRevision: characterRecipe!.portableDecodedObjectRevision } : {}),
            ...(fields.has("character.attestedAnchors") ? { attestedAnchors: attestedAnchors! } : {}),
            ...(fields.has("character.assetFamilyId") ? { assetFamilyId: characterRecipe!.assetFamilyId } : {}),
            ...(fields.has("character.assetId") ? { assetId: characterRecipe!.assetId } : {}),
            ...(fields.has("character.spriteObjectId") ? { spriteObjectId: characterRecipe!.spriteObjectId } : {}),
            ...(fields.has("character.targetMapObjectId") ? { targetMapObjectId: characterRecipe!.targetMapObjectId } : {}),
            ...(fields.has("character.effectProfileObjectId") ? { effectProfileObjectId: characterRecipe!.effectProfileObjectId } : {}),
            ...(fields.has("character.soundProfileObjectId") ? { soundProfileObjectId: characterRecipe!.soundProfileObjectId } : {}),
            ...(fields.has("character.emitterSpriteBundleId") ? { emitterSpriteBundleId: characterRecipe!.emitterSpriteBundleId } : {}),
            ...(fields.has("character.emitterSpriteAssetId") ? { emitterSpriteAssetId: characterRecipe!.emitterSpriteAssetId } : {}),
            ...(fields.has("character.emitterMaterialTargetId") ? { emitterMaterialTargetId: characterRecipe!.emitterMaterialTargetId } : {}),
            ...(fields.has("character.catalogRevision") ? { catalogRevision: characterRecipe!.catalogRevision } : {}),
            ...(fields.has("character.assetFamilyRevision") ? { assetFamilyRevision: characterRecipe!.assetFamilyRevision } : {}),
            ...(fields.has("character.emitterPresetId") ? { emitterPresetId: characterRecipe!.emitterPresetId } : {}),
            ...(fields.has("character.emitterRevision") ? { emitterRevision: characterRecipe!.emitterRevision } : {}),
            ...(fields.has("character.emitterSpriteBundleRevision") ? { emitterSpriteBundleRevision: characterRecipe!.emitterSpriteBundleRevision } : {}),
            ...(fields.has("character.emitterSpriteSelectionRevision") ? { emitterSpriteSelectionRevision: characterRecipe!.emitterSpriteSelectionRevision } : {}),
            ...(fields.has("character.fxCatalogRevision") ? { fxCatalogRevision: characterRecipe!.fxCatalogRevision } : {}),
            ...(fields.has("character.mapGenerationEpoch") ? { mapGenerationEpoch: characterRecipe!.mapGenerationEpoch } : {}),
            ...(fields.has("character.emitterSeedDomainVersion") ? { emitterSeedDomainVersion: characterRecipe!.emitterSeedDomainVersion } : {}),
            ...(fields.has("character.emitterPaletteMode") ? { emitterPaletteMode: characterRecipe!.emitterPaletteMode } : {}),
            ...(fields.has("character.sceneId") ? { sceneId: characterRecipe!.sceneId } : {}),
            ...(fields.has("collection.verification") ? { collectionVerification: collectionVerification! } : {}),
            ...(fields.has("map.characterSeed") ? { mapCharacterSeed: mapCharacterSeed! } : {}),
            ...(fields.has("map.seed") ? { mapSeed: mapSeed! } : {}),
            ...(fields.has("map.buildRevision") ? { mapBuildRevision: mapBuildRevision! } : {}),
            ...(fields.has("map.portableRoot") ? { mapPortableRoot: mapPortableRoot! } : {}),
            ...(fields.has("map.portableManifestObjectId") ? { mapPortableManifestObjectId: mapPortableManifestObjectId! } : {}),
            ...(fields.has("map.portableDecodedObjectId") ? { mapPortableDecodedObjectId: mapPortableDecodedObjectId! } : {}),
            ...(fields.has("map.portableAnchorRoot") ? { mapPortableAnchorRoot: mapPortableAnchorRoot! } : {}),
            ...(fields.has("map.portableManifestObjectRevision") ? { mapPortableManifestObjectRevision: mapPortableManifestObjectRevision! } : {}),
            ...(fields.has("map.portableDecodedObjectRevision") ? { mapPortableDecodedObjectRevision: mapPortableDecodedObjectRevision! } : {}),
          };
        })();

  return {
    manifest: {
      ...boundManifest,
      resources: boundManifest.resources.map((resource) => resources.get(resource.id) ?? resource),
    },
    binding: {
      protocol: KEEL_RUNTIME_PROTOCOL,
      chainId: extension.chainId,
      ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
      mode: extension.mode,
      effectiveHarness: effective,
      objects,
      ...(runtimeContext === undefined ? {} : { runtimeContext }),
      ...(seed === undefined ? {} : { seed }),
      ...(presentationState === undefined ? {} : { presentationState }),
      ...(seasonalGroveState === undefined ? {} : { seasonalGroveState }),
      ...(equipment === undefined ? {} : { equipment }),
      ...(characterRecipe === undefined ? {} : { characterRecipe }),
    },
  };
}

function stakeRuntimeContext(stake: ResolvedStakeObject): RuntimeStakeObjectContext {
  const declaration = stake.declaration;
  return {
    protocol: "keel-stake-context@1",
    stakeObjectId: declaration.stakeObjectId,
    viewerId: declaration.viewerId,
    chain: declaration.chain.family,
    manager: declaration.chain.manager,
    hostCollection: declaration.hostCollection,
    hostTokenId: declaration.hostTokenId,
    stakedTokenId: stake.stakedTokenId ?? declaration.stakedTokenId,
    active: stake.active,
    ...(stake.staker === undefined ? {} : { staker: stake.staker }),
    ...(stake.controller === undefined ? {} : { controller: stake.controller }),
    ...(stake.hostOwner === undefined ? {} : { hostOwner: stake.hostOwner }),
    ...(stake.tokenOwner === undefined ? {} : { tokenOwner: stake.tokenOwner }),
    ...(stake.stakedCollection === undefined ? {} : { stakedCollection: stake.stakedCollection }),
    ...(stake.activeTokenId === undefined ? {} : { activeTokenId: stake.activeTokenId }),
    ...(stake.startedAt === undefined ? {} : { startedAt: stake.startedAt }),
    slot: stake.slot,
    gatedResourceIds: declaration.gatedResources.map((item) => item.resource),
    stakedEntrypoint: declaration.stakedEntrypoint.resource,
    requireStaked: true,
    lockup: stake.lockup,
    counters: stake.counters,
    managerPolicy: stake.managerPolicy,
    managerVerified: stake.managerVerified,
    ...(stake.managerProof === undefined ? {} : { managerProof: stake.managerProof }),
    ...(stake.runtimeDigest === undefined ? {} : { runtimeDigest: stake.runtimeDigest }),
    ...(stake.codeObjectId === undefined ? {} : { codeObjectId: stake.codeObjectId }),
    ...(stake.codeObjectRevision === undefined ? {} : { codeObjectRevision: stake.codeObjectRevision }),
    ...(stake.runtimeSeed === undefined ? {} : { runtimeSeed: stake.runtimeSeed }),
    ...(stake.argumentsDigest === undefined ? {} : { argumentsDigest: stake.argumentsDigest }),
    ...(stake.variablesDigest === undefined ? {} : { variablesDigest: stake.variablesDigest }),
    ...(declaration.backpack === undefined ? {} : { backpack: declaration.backpack }),
  };
}

/** Bind contract state first, then resolve only sources that reproduce it. */
export async function resolveKeelArtifact(
  manifest: ArtifactManifest,
  commitment: ManifestCommitment,
  options: ResolveKeelArtifactOptions,
): Promise<ResolvedKeelArtifact> {
  const bound = await bindKeelManifest(manifest, commitment, options);
  const artifact = await resolveArtifact(bound.manifest, {
    ...(options.adapters === undefined ? {} : { adapters: options.adapters }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.ipfsGateways === undefined ? {} : { ipfsGateways: options.ipfsGateways }),
    ...(options.ipnsGateways === undefined ? {} : { ipnsGateways: options.ipnsGateways }),
    ...(options.arweaveGateways === undefined ? {} : { arweaveGateways: options.arweaveGateways }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.sourceAllowlist === undefined ? {} : { sourceAllowlist: options.sourceAllowlist }),
    ...(options.allowUriSources === undefined ? {} : { allowUriSources: options.allowUriSources }),
    ...(options.allowPrivateNetworkSources === undefined
      ? {}
      : { allowPrivateNetworkSources: options.allowPrivateNetworkSources }),
    ...(options.skipResourceIds === undefined ? {} : { skipResourceIds: options.skipResourceIds }),
    ...(options.stakeObjectTokenId === undefined ? {} : { stakeObjectTokenId: options.stakeObjectTokenId }),
    ...(options.stakeObjectReader === undefined ? {} : { stakeObjectReader: options.stakeObjectReader }),
    commitment,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const runtimeContext: RuntimeContext | undefined = artifact.stakeObject === undefined
    ? bound.binding.runtimeContext
    : {
        ...(bound.binding.runtimeContext ?? { protocol: "keel-context@1" as const }),
        stakeObject: stakeRuntimeContext(artifact.stakeObject),
      };
  return {
    artifact,
    binding: {
      ...bound.binding,
      ...(runtimeContext === undefined ? {} : { runtimeContext }),
      ...(artifact.stakeObject === undefined ? {} : { stakeObject: artifact.stakeObject }),
    },
  };
}
