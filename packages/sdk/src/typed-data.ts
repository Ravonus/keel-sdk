import { ZERO_ADDRESS, ZERO_BYTES32, type Address, type Eip712TypedData, type Hex, type MintAuthorization } from "./types.js";
import { normalizedAddress, normalizedBytes32, uint, UINT64_MAX } from "./validation.js";

export const MINT_AUTHORIZATION_TYPE = [
  { name: "campaignId", type: "bytes32" },
  { name: "account", type: "address" },
  { name: "signer", type: "address" },
  { name: "maxQuantity", type: "uint256" },
  { name: "unitPrice", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "contextHash", type: "bytes32" },
] as const;

export interface MintAuthorizationMessage extends Readonly<Record<string, unknown>> {
  readonly campaignId: Hex;
  readonly account: Address;
  readonly signer: Address;
  readonly maxQuantity: bigint;
  readonly unitPrice: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly contextHash: Hex;
}

export function createMintAuthorizationTypedData(
  chainId: bigint | number,
  verifyingContract: Address,
  authorization: MintAuthorization,
): Eip712TypedData<MintAuthorizationMessage> {
  const normalizedChainId = uint(chainId, 0n, "chainId");
  if (normalizedChainId === 0n) throw new RangeError("chainId must be positive.");
  const contract = normalizedAddress(verifyingContract, ZERO_ADDRESS, "verifyingContract");
  if (contract === ZERO_ADDRESS) throw new TypeError("verifyingContract cannot be zero.");
  const maxQuantity = uint(authorization.maxQuantity, 0n, "maxQuantity");
  if (maxQuantity === 0n) throw new RangeError("maxQuantity must be positive.");

  return {
    domain: {
      name: "Keel Mint Access",
      version: "1",
      chainId: normalizedChainId,
      verifyingContract: contract,
    },
    primaryType: "MintAuthorization",
    types: { MintAuthorization: MINT_AUTHORIZATION_TYPE },
    message: {
      campaignId: normalizedBytes32(authorization.campaignId, ZERO_BYTES32, "campaignId"),
      account: normalizedAddress(authorization.account, ZERO_ADDRESS, "account"),
      signer: normalizedAddress(authorization.signer, ZERO_ADDRESS, "signer"),
      maxQuantity,
      unitPrice: uint(authorization.unitPrice, 0n, "unitPrice"),
      nonce: uint(authorization.nonce, 0n, "nonce"),
      deadline: uint(authorization.deadline, 0n, "deadline"),
      contextHash: normalizedBytes32(authorization.contextHash, ZERO_BYTES32, "contextHash"),
    },
  };
}

export const COLLECTION_AUTHORIZATION_TYPE = [
  { name: "creator", type: "address" },
  { name: "agent", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint64" },
  { name: "configDigest", type: "bytes32" },
] as const;

export interface CollectionAuthorizationMessage extends Readonly<Record<string, unknown>> {
  readonly creator: Address;
  readonly agent: Address;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly configDigest: Hex;
}

/**
 * Build the exact EIP-712 payload consumed by KeelFactory.castDieFor.
 * This is data-only: it never signs, contacts a chain, or approves an agent.
 */
export function createCollectionAuthorizationTypedData(
  chainId: bigint | number,
  verifyingContract: Address,
  authorization: {
    readonly creator: Address;
    readonly agent: Address;
    readonly nonce: bigint | number;
    readonly deadline: bigint | number;
    readonly configDigest: Hex;
  },
): Eip712TypedData<CollectionAuthorizationMessage> {
  const normalizedChainId = uint(chainId, 0n, "chainId");
  if (normalizedChainId === 0n) throw new RangeError("chainId must be positive.");
  const contract = normalizedAddress(verifyingContract, ZERO_ADDRESS, "verifyingContract");
  if (contract === ZERO_ADDRESS) throw new TypeError("verifyingContract cannot be zero.");
  const creator = normalizedAddress(authorization.creator, ZERO_ADDRESS, "creator");
  const agent = normalizedAddress(authorization.agent, ZERO_ADDRESS, "agent");
  if (creator === ZERO_ADDRESS || agent === ZERO_ADDRESS) throw new TypeError("creator and agent cannot be zero.");
  const deadline = uint(authorization.deadline, 0n, "deadline", UINT64_MAX);
  if (deadline === 0n) throw new RangeError("deadline must be positive.");
  return {
    domain: { name: "Keel Factory", version: "1", chainId: normalizedChainId, verifyingContract: contract },
    primaryType: "CollectionAuthorization",
    types: { CollectionAuthorization: COLLECTION_AUTHORIZATION_TYPE },
    message: {
      creator,
      agent,
      nonce: uint(authorization.nonce, 0n, "nonce"),
      deadline,
      configDigest: normalizedBytes32(authorization.configDigest, ZERO_BYTES32, "configDigest"),
    },
  };
}
