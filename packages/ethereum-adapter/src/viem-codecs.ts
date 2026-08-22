import {
  bytesToHex,
  decodeFunctionData as viemDecodeFunctionData,
  encodeAbiParameters as viemEncodeAbiParameters,
  encodeFunctionData as viemEncodeFunctionData,
  keccak256 as viemKeccak256,
  parseAbi,
  type AbiParameter,
  type Hex as ViemHex,
} from "viem";
import { keelHoldAbi } from "@keel/sdk";
import type { Hex } from "@keel/protocol";
import type { EthereumAdapterCodecs } from "./adapter.js";

const CHUNK_STORE_ABI = parseAbi([...keelHoldAbi]);

type FunctionSignature =
  | "castSlugs(bytes[])"
  | "weldObject(bytes32[],bytes32,uint64,uint8,string)"
  | "weldComposite(bytes32[],bytes32,uint64,string)";

function functionName(signature: string): "castSlugs" | "weldObject" | "weldComposite" {
  if (signature === "castSlugs(bytes[])") return "castSlugs";
  if (signature === "weldObject(bytes32[],bytes32,uint64,uint8,string)") return "weldObject";
  if (signature === "weldComposite(bytes32[],bytes32,uint64,string)") return "weldComposite";
  throw new TypeError(`Unsupported KeelHold function signature: ${signature}`);
}

function parameters(types: readonly string[]): readonly AbiParameter[] {
  return types.map((type) => ({ type })) as readonly AbiParameter[];
}

/**
 * Bridges the adapter's small codec interface to the real viem 2.x API.
 * The core adapter stays dependency-injectable; this helper is the tested
 * production wiring for applications that already use viem.
 */
export function createViemEthereumAdapterCodecs(): EthereumAdapterCodecs {
  return {
    keccak256: (bytes: Uint8Array): Hex => viemKeccak256(bytesToHex(bytes) as ViemHex) as Hex,
    encodeAbiParameters: (types: readonly string[], values: readonly unknown[]): Hex =>
      viemEncodeAbiParameters(parameters(types), values as never) as Hex,
    encodeFunctionData: (signature: string, args: readonly unknown[]): Hex =>
      viemEncodeFunctionData({
        abi: CHUNK_STORE_ABI,
        functionName: functionName(signature as FunctionSignature),
        args: args as never,
      }) as Hex,
    validateFunctionData: (signature: string, data: Hex, args: readonly unknown[]): boolean => {
      try {
        const expectedName = functionName(signature as FunctionSignature);
        const decoded = viemDecodeFunctionData({ abi: CHUNK_STORE_ABI, data: data as ViemHex });
        if (decoded.functionName !== expectedName) return false;
        const canonical = viemEncodeFunctionData({ abi: CHUNK_STORE_ABI, functionName: expectedName, args: args as never });
        return canonical.toLowerCase() === data.toLowerCase();
      } catch {
        return false;
      }
    },
  };
}

export type { FunctionSignature as EthereumKeelHoldFunctionSignature };
