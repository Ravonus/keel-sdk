import {
  EquipmentAssetStandard,
  EquipmentSlot,
  KeelCompression,
  KeelDigestAlgorithm,
  KeelFidelity,
  KeelLocatorScheme,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type KeelEquipmentDefinitionInput,
  type KeelFidelityLinkInput,
  type KeelViewerSlots,
} from "./types.js";
import {
  createKeelRpcClient,
  type KeelRpcClient,
  type KeelRpcHostList,
} from "@keel/protocol";
import { UINT64_MAX, enumValue, normalizedAddress, normalizedBytes32, normalizedHex, uint } from "./validation.js";
import type { Address, Hex } from "./types.js";

export const KEEL_MAX_VIEWER_SLOTS = 128;
export const KEEL_MAX_FIDELITY_LINKS = 3;
export const KEEL_EQUIPMENT_CAPACITY = 42;

/** EIP-1898 selector used for every hash-pinned Keel RPC read. A block
 * number is intentionally not accepted here: selecting by height after a
 * separate hash lookup permits a reorg/provider swap between the two calls. */
export interface KeelCanonicalBlockSelector {
  readonly blockHash: Hex;
  readonly requireCanonical: true;
}

export function keelCanonicalBlockSelector(blockHash: Hex): KeelCanonicalBlockSelector {
  return {
    blockHash: normalizedBytes32(blockHash, ZERO_BYTES32, "blockHash"),
    requireCanonical: true,
  };
}

export interface KeelCanonicalEthCallRequest {
  readonly method: "eth_call";
  readonly params: readonly [
    { readonly to: Address; readonly data: Hex },
    KeelCanonicalBlockSelector,
  ];
}

export async function keelCanonicalEthCall(
  request: (payload: KeelCanonicalEthCallRequest) => Promise<Hex>,
  call: { readonly to: Address; readonly data: Hex },
  blockHash: Hex,
): Promise<Hex> {
  return request({
    method: "eth_call",
    params: [{
      to: normalizedAddress(call.to, ZERO_ADDRESS, "call.to"),
      data: normalizedHex(call.data, "0x", "call.data"),
    }, keelCanonicalBlockSelector(blockHash)],
  });
}

export interface KeelRpcTransportOptions {
  /** Tried in order; each is held to the governed host list. */
  readonly endpoints: readonly string[];
  /**
   * The deployment's governed RPC host list, read from
   * `KeelManager.rpcHostList`. Defaults to the built-in genesis list.
   */
  readonly hostList?: KeelRpcHostList | readonly string[];
  readonly chainId?: number;
  readonly allowPrivateNetworkHosts?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface KeelRpcTransport {
  /** Pass straight to `keelCanonicalEthCall`. */
  readonly request: (payload: KeelCanonicalEthCallRequest) => Promise<Hex>;
  /** The full module, for reads that are not hash-pinned calls. */
  readonly client: KeelRpcClient;
}

/**
 * A hash-pinned read transport whose endpoints governance has blessed.
 *
 * `keelCanonicalEthCall` takes a `request` function precisely so a caller can
 * bring their own provider, and it will keep doing that — a wallet's injected
 * transport is not this module's business. What was missing was a way to build
 * that function for a plain URL without every caller inventing its own fetch
 * and its own idea of which endpoints are acceptable. This is that way, and it
 * refuses an endpoint the governed list does not name.
 */
export function createKeelRpcTransport(options: KeelRpcTransportOptions): KeelRpcTransport {
  const client = createKeelRpcClient({
    family: "ethereum",
    endpoints: options.endpoints,
    ...(options.chainId === undefined ? {} : { chainId: options.chainId }),
    ...(options.hostList === undefined ? {} : { hostList: options.hostList }),
    ...(options.allowPrivateNetworkHosts === undefined
      ? {}
      : { allowPrivateNetworkHosts: options.allowPrivateNetworkHosts }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return {
    client,
    request: async (payload) =>
      (await client.call({
        to: payload.params[0].to,
        data: payload.params[0].data,
        block: payload.params[1],
      })) as Hex,
  };
}

const MEDIA_TYPE = /^[a-z0-9!#$&+.^_-]+\/[a-z0-9!#$&+.^_-]+$/;
const URI_PREFIX: Readonly<Record<KeelLocatorScheme, string>> = {
  [KeelLocatorScheme.Https]: "https://",
  [KeelLocatorScheme.Ipfs]: "ipfs://",
  [KeelLocatorScheme.Ipns]: "ipns://",
  [KeelLocatorScheme.Arweave]: "ar://",
};

export function keelDigestAlgorithmName(value: KeelDigestAlgorithm): "sha256" | "keccak256" {
  return enumValue(
    value,
    [KeelDigestAlgorithm.Sha256, KeelDigestAlgorithm.Keccak256],
    "digestAlgorithm",
  ) === KeelDigestAlgorithm.Sha256
    ? "sha256"
    : "keccak256";
}

export function keelCompressionName(value: KeelCompression): "none" | "gzip" | "deflate" | "brotli" {
  const normalized = enumValue(
    value,
    [KeelCompression.None, KeelCompression.Gzip, KeelCompression.Deflate, KeelCompression.Brotli],
    "compression",
  );
  return ["none", "gzip", "deflate", "brotli"][normalized] as "none" | "gzip" | "deflate" | "brotli";
}

export function validateKeelViewerSlots(input: KeelViewerSlots): KeelViewerSlots {
  if (input.objectIds.length === 0 || input.objectIds.length > KEEL_MAX_VIEWER_SLOTS) {
    throw new RangeError(`viewer requires 1-${KEEL_MAX_VIEWER_SLOTS} object slots.`);
  }
  if (input.objectIds.length !== input.objectRevisions.length) {
    throw new RangeError("viewer object IDs and revisions must have equal length.");
  }
  return {
    objectIds: input.objectIds.map((value, index) => {
      const objectId = normalizedBytes32(value, ZERO_BYTES32, `objectIds[${index}]`);
      if (objectId === ZERO_BYTES32) throw new TypeError(`objectIds[${index}] cannot be zero.`);
      return objectId;
    }),
    objectRevisions: input.objectRevisions.map((value, index) => {
      const revision = uint(value, 0n, `objectRevisions[${index}]`, UINT64_MAX);
      if (revision === 0n) throw new RangeError(`objectRevisions[${index}] must be positive.`);
      return revision;
    }),
  };
}

export function validateKeelFidelityLinks(
  inputs: readonly KeelFidelityLinkInput[],
): readonly KeelFidelityLinkInput[] {
  if (inputs.length === 0 || inputs.length > KEEL_MAX_FIDELITY_LINKS) {
    throw new RangeError(`fidelity set requires 1-${KEEL_MAX_FIDELITY_LINKS} links.`);
  }
  let previous = -1;
  return inputs.map((input, index) => {
    const fidelity = enumValue(
      input.fidelity,
      [KeelFidelity.Preview, KeelFidelity.HighResolution, KeelFidelity.HybridMirror],
      `links[${index}].fidelity`,
    );
    if (fidelity <= previous) throw new RangeError("fidelity links must be strictly ordered and unique.");
    previous = fidelity;
    const scheme = enumValue(
      input.scheme,
      [KeelLocatorScheme.Https, KeelLocatorScheme.Ipfs, KeelLocatorScheme.Ipns, KeelLocatorScheme.Arweave],
      `links[${index}].scheme`,
    );
    if (!input.uri.startsWith(URI_PREFIX[scheme]) || input.uri.length === URI_PREFIX[scheme].length) {
      throw new TypeError(`links[${index}].uri does not match its locator scheme.`);
    }
    if (input.uri.length > 2_048 || [...input.uri].some((value) => value <= " " || value >= "\u007f" || "\"'\\".includes(value))) {
      throw new TypeError(`links[${index}].uri is not a canonical printable locator.`);
    }
    if (!MEDIA_TYPE.test(input.mediaType) || input.mediaType.length > 127) {
      throw new TypeError(`links[${index}].mediaType must be canonical lower-case type/subtype.`);
    }
    const decodedDigest = normalizedBytes32(input.decodedDigest, ZERO_BYTES32, `links[${index}].decodedDigest`);
    const provenanceDigest = normalizedBytes32(
      input.provenanceDigest,
      ZERO_BYTES32,
      `links[${index}].provenanceDigest`,
    );
    const byteLength = uint(input.byteLength, 0n, `links[${index}].byteLength`, UINT64_MAX);
    if (decodedDigest === ZERO_BYTES32 || provenanceDigest === ZERO_BYTES32 || byteLength === 0n) {
      throw new TypeError(`links[${index}] requires nonzero digest, provenance, and byte length.`);
    }
    return {
      ...input,
      fidelity,
      scheme,
      digestAlgorithm: enumValue(
        input.digestAlgorithm,
        [KeelDigestAlgorithm.Sha256, KeelDigestAlgorithm.Keccak256],
        `links[${index}].digestAlgorithm`,
      ),
      compression: enumValue(
        input.compression,
        [KeelCompression.None, KeelCompression.Gzip, KeelCompression.Deflate, KeelCompression.Brotli],
        `links[${index}].compression`,
      ),
      decodedDigest,
      provenanceDigest,
      byteLength,
    };
  });
}

export function validateEquipmentDefinition(
  input: KeelEquipmentDefinitionInput,
): KeelEquipmentDefinitionInput {
  const assetCollection = normalizedAddress(input.assetCollection, ZERO_ADDRESS, "assetCollection");
  if (assetCollection === ZERO_ADDRESS) throw new TypeError("assetCollection cannot be the zero address.");
  const objectRevision = uint(input.objectRevision, 0n, "objectRevision", UINT64_MAX);
  if (objectRevision === 0n) throw new RangeError("objectRevision must be positive.");
  const objectId = normalizedBytes32(input.objectId, ZERO_BYTES32, "objectId");
  const catalogMetadataDigest = normalizedBytes32(
    input.catalogMetadataDigest,
    ZERO_BYTES32,
    "catalogMetadataDigest",
  );
  if (objectId === ZERO_BYTES32 || catalogMetadataDigest === ZERO_BYTES32) {
    throw new TypeError("objectId and catalogMetadataDigest cannot be zero.");
  }
  return {
    assetCollection,
    assetTokenId: uint(input.assetTokenId, 0n, "assetTokenId"),
    standard: enumValue(
      input.standard,
      [EquipmentAssetStandard.ERC721, EquipmentAssetStandard.ERC1155],
      "standard",
    ),
    slot: enumValue(
      input.slot,
      [
        EquipmentSlot.Head,
        EquipmentSlot.Body,
        EquipmentSlot.Legs,
        EquipmentSlot.Shirt,
        EquipmentSlot.Eyes,
        EquipmentSlot.Weapon,
        EquipmentSlot.AddonOne,
        EquipmentSlot.AddonTwo,
        EquipmentSlot.AddonThree,
      ],
      "slot",
    ),
    objectId,
    objectRevision,
    catalogMetadataDigest,
  };
}

/** Browser-safe, read-only Keel method policy shared by Studio's direct
 * provider and API relay. Keeping one policy prevents a viewer runtime read
 * from passing mocks while being rejected by a real host transport. */
export const keelDirectReadPolicy = {
  "keel-object-registry": ["artifactRevisionSource", "artifactCreator"],
  "keel-attribution-registry": [
    "artifactRegistry",
    "harnessRegistry",
    "canManage",
    "attribution",
    "attributionById",
    "subjectAttributionIds",
    "attributionCount",
  ],
  "keel-ip-control": [
    "license",
    "policy",
    "rule",
    "authorizationStatus",
    "isAuthorized",
    "tokenRequirementCount",
    "tokenRequirement",
  ],
  "keel-viewer-registry": ["artifactRegistry", "keelIndex", "harnessCreator", "harnessCollection", "effectiveHarness"],
  "keel-link-registry": ["artifactRegistry", "linkExists", "fidelityLink"],
  "keel-seed-registry": [
    "harnessRegistry",
    "keelIndex",
    "seedSetForViewerRevision",
    "predictSeedSetId",
    "deriveTokenSeed",
  ],
  "keel-presentation-state-registry": [
    "presentationPolicy",
    "presentationRevision",
    "currentPresentation",
    "presentationMatches",
    "policyIsImmutable",
    "policyMaterialization",
  ],
  "keel-seasonal-grove-state": ["currentState", "owner", "timezoneName", "regionName"],
  "keel-equipment-inventory": [
    "artifactRegistry",
    "keelIndex",
    "characterCollection",
    "loadout",
    "equipmentSource",
  ],
  "keel-portable-anchor-registry": ["artifactRegistry", "sourceAnchor", "portableAnchor", "anchor"],
  "keel-attested-anchor-registry": [
    "artifactRegistry",
    "chainFamily",
    "anchorVerifier",
    "anchorState",
    "anchorTask",
    "anchorByRoot",
    "objectAttestedFamilyMask",
    "networkAnchor",
    "contributorStats",
    "anchorSummary",
    "anchorVerificationContext",
    "predictAnchorId",
    "computeAnchorRoot",
    "objectAnchorPolicy",
    "objectAnchorFamilyAllowed",
    "familyEmission",
    "networkEmission",
    "effectiveEmission",
    "objectAnchorStamp",
    "isChainAnchored",
    "objectChainAnchored",
    "objectFamilyAnchored",
    "objectAnchoredChains",
    "grip",
    "objectAnchoredChainAt",
  ],
  "keel-chainlink-functions-verifier": [
    "router",
    "anchorRegistry",
    "keelHold",
    "donId",
    "subscriptionId",
    "callbackGasLimit",
    "familyRoute",
    "pendingRequest",
    "taskRequest",
  ],
  "keel-anchor-replication-bridge": ["anchorRegistry"],
  "keel-cre-report-verifier": [
    "anchorRegistry",
    "forwarder",
    "expectedWorkflowOwner",
    "expectedWorkflowName",
    "expectedWorkflowId",
    "familyConfig",
  ],
  "keel-manager": ["governanceEpoch", "rpcHostList", "rpcHostCount", "computeRpcHostListDigest", "rpcHostListPreimage"],
  "onchaininator-proof-ledger": [
    "viewerCarriage",
    "viewerOf",
    "weakestLane",
    "ladderComplete",
    "assetCid",
    "preservedAsset",
    "imageStrategyOf",
    "linkedImageURI",
  ],
  "keel-crucible-registry": [
    "portableAnchorRegistry",
    "policy",
    "latestReceipt",
    "receipt",
    "receiptCurrent",
    "inspectCurrent",
    "approvedEvidenceRoot",
  ],
  "vault-character-registry": ["characterCollection", "portableAnchorRegistry", "renderRecipe"],
  "vault-arcade-registry": [
    "characterCollection",
    "mapCollection",
    "characterRegistry",
    "portableAnchorRegistry",
    "mapCharacterRuntime",
    "mapCharacterSeed",
  ],
} as const;

export type KeelDirectReadKind = keyof typeof keelDirectReadPolicy;

export function isKeelDirectReadAllowed(kind: KeelDirectReadKind, functionName: string): boolean {
  return (keelDirectReadPolicy[kind] as readonly string[]).includes(functionName);
}
