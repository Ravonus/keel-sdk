import {
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type Address,
  type Hex,
} from "./types.js";
import { normalizedAddress, normalizedBytes32, uint, UINT128_MAX } from "./validation.js";

const UINT96_MAX = (1n << 96n) - 1n;
const MAX_NAME_BYTES = 128;
const MAX_SYMBOL_BYTES = 32;
const ITEM_BITS = 128n;

export enum KeelCreatorTokenStandard {
  ERC721 = 0,
  ERC1155 = 1,
}

export enum KeelCreatorDeploymentKind {
  Dedicated = 0,
  Shared = 1,
  External = 2,
}

export interface KeelCreator721ConfigInput {
  readonly name: string;
  readonly symbol: string;
  readonly maxSupply: bigint | number;
  readonly royaltyReceiver?: Address;
  readonly royaltyBps?: bigint | number;
  readonly metadataDigest: Hex;
}

export interface KeelCreator1155ConfigInput {
  readonly name: string;
  readonly symbol: string;
  readonly royaltyReceiver?: Address;
  readonly royaltyBps?: bigint | number;
  readonly metadataDigest: Hex;
}

export interface NormalizedKeelCreator721Config {
  readonly name: string;
  readonly symbol: string;
  readonly maxSupply: bigint;
  readonly royaltyReceiver: Address;
  readonly royaltyBps: bigint;
  readonly metadataDigest: Hex;
}

export type NormalizedKeelCreator1155Config = Omit<NormalizedKeelCreator721Config, "maxSupply">;

function checkedText(value: string, maximum: number, label: string): string {
  const length = new TextEncoder().encode(value).length;
  if (length === 0 || length > maximum) {
    throw new RangeError(`${label} must contain between 1 and ${maximum} UTF-8 bytes.`);
  }
  return value;
}

function normalizedCommon(input: KeelCreator1155ConfigInput): NormalizedKeelCreator1155Config {
  const name = checkedText(input.name, MAX_NAME_BYTES, "name");
  const symbol = checkedText(input.symbol, MAX_SYMBOL_BYTES, "symbol");
  const royaltyReceiver = normalizedAddress(input.royaltyReceiver, ZERO_ADDRESS, "royaltyReceiver");
  const royaltyBps = uint(input.royaltyBps, 0n, "royaltyBps", UINT96_MAX);
  const metadataDigest = normalizedBytes32(input.metadataDigest, ZERO_BYTES32, "metadataDigest");
  if (royaltyBps > 10_000n) throw new RangeError("royaltyBps cannot exceed 10000.");
  if (royaltyBps !== 0n && royaltyReceiver === ZERO_ADDRESS) {
    throw new TypeError("royaltyReceiver is required when royaltyBps is non-zero.");
  }
  if (metadataDigest === ZERO_BYTES32) throw new TypeError("metadataDigest cannot be zero.");
  return Object.freeze({ name, symbol, royaltyReceiver, royaltyBps, metadataDigest });
}

export function buildKeelCreator721Config(
  input: KeelCreator721ConfigInput,
): NormalizedKeelCreator721Config {
  const common = normalizedCommon(input);
  const maxSupply = uint(input.maxSupply, 0n, "maxSupply");
  if (maxSupply === 0n) throw new RangeError("maxSupply must be greater than zero.");
  return Object.freeze({ ...common, maxSupply });
}

export function buildKeelCreator1155Config(
  input: KeelCreator1155ConfigInput,
): NormalizedKeelCreator1155Config {
  return normalizedCommon(input);
}

/** Shared ERC-1155 ids reserve the high 128 bits for KEEL's logical collection. */
export function keelSharedTokenId(
  collectionId: bigint | number,
  itemIndex: bigint | number,
): bigint {
  const group = uint(collectionId, 0n, "collectionId", UINT128_MAX);
  const item = uint(itemIndex, 0n, "itemIndex", UINT128_MAX);
  if (group === 0n || item === 0n) throw new RangeError("collectionId and itemIndex must be positive.");
  return (group << ITEM_BITS) | item;
}

export function keelSharedCollectionIdOf(tokenId: bigint | number): bigint {
  return uint(tokenId, 0n, "tokenId") >> ITEM_BITS;
}

export function keelSharedItemIndexOf(tokenId: bigint | number): bigint {
  return uint(tokenId, 0n, "tokenId") & UINT128_MAX;
}
