import { toDataUrl, utf8ToBytes } from "@keel/protocol";
import type { Address } from "./types.js";
import { normalizedAddress, uint } from "./validation.js";
import { ZERO_ADDRESS } from "./types.js";

/** Minimal ABI for a read-through adapter around a tokenJSON-only contract. */
export const keelMetadataResolverAbi = [
  "function source() view returns (address)",
  "function tokenJSON(uint256 tokenId) view returns (string)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function erc4804URI(uint256 tokenId) view returns (string)",
] as const;

export interface KeelTokenJSONURIInput {
  readonly chainId: bigint | number;
  readonly contract: Address;
  readonly tokenId: bigint | number;
}

/**
 * Build the canonical ERC-4804 route exposed by Keel metadata resolvers.
 * The route deliberately targets the contract that exposes `tokenJSON`, not
 * a gateway or an HTTP mirror.
 */
export function keelTokenJSONURI(input: KeelTokenJSONURIInput): string {
  const chainId = uint(input.chainId, 0n, "chainId");
  if (chainId === 0n) throw new RangeError("chainId must be positive.");
  const contract = normalizedAddress(input.contract, ZERO_ADDRESS, "contract");
  if (contract === ZERO_ADDRESS) throw new TypeError("contract cannot be the zero address.");
  const tokenId = uint(input.tokenId, 0n, "tokenId");
  return `web3://${contract}:${chainId.toString()}/tokenJSON/${tokenId.toString()}`;
}

/**
 * Preserve the legacy ERC-721 presentation for a raw `tokenJSON` response.
 * This is the client-side equivalent of the adapter's `tokenURI` method and
 * keeps the raw JSON bytes intact inside the standard data URI.
 */
export function keelTokenURIFromJSON(tokenJSON: string): string {
  if (typeof tokenJSON !== "string") throw new TypeError("tokenJSON must be a string.");
  return toDataUrl("application/json", utf8ToBytes(tokenJSON));
}
