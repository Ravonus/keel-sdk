/**
 * KEEL presentation vocabulary and the fail-closed Inline eligibility check.
 *
 * Storage and presentation are separate decisions. A resource can remain in
 * native KEEL storage while its presentation is either Inline or Hybrid.
 */

/** Maximum complete tokenURI string returned through the public RPC read. */
export const KEEL_INLINE_MAX_TOKEN_URI_BYTES = 2_000_000;
/** @deprecated Use KEEL_INLINE_MAX_TOKEN_URI_BYTES; decoded browser bytes are not the RPC boundary. */
export const KEEL_INLINE_MAX_RECONSTRUCTED_BYTES = KEEL_INLINE_MAX_TOKEN_URI_BYTES;
/**
 * Upper bound KEEL will ever request for a read-only Inline reconstruction.
 * The caller must also cap this at the selected chain's latest block gas
 * limit; a hard-coded 30M ceiling incorrectly rejects valid reads on chains
 * whose public RPC execution boundary is higher.
 */
export const KEEL_INLINE_SAFE_RPC_GAS = 60_000_000n;
export const KEEL_INLINE_TOKEN_URI_FIXED_GAS = 5_000_000n;
export const KEEL_INLINE_TOKEN_URI_GAS_PER_BYTE = 90n;
export const KEEL_PREENCODED_TOKEN_URI_COLLECTION_MARGIN = 5_000_000n;

export function keelInlineReadGasLimit(blockGasLimit: bigint): bigint {
  if (blockGasLimit <= 0n) throw new RangeError("Inline read block gas limit must be positive.");
  return blockGasLimit < KEEL_INLINE_SAFE_RPC_GAS ? blockGasLimit : KEEL_INLINE_SAFE_RPC_GAS;
}

/**
 * Conservative pre-deployment budget for the complete ERC-721 read.
 *
 * The exact harness call is measured by the selected chain. `tokenURI` then
 * JSON-wraps that returned animation URI and Base64-encodes the complete JSON.
 * The 90 gas/byte allowance plus a 5M fixed margin bounds the measured KEEL721
 * path without pretending the cheaper harness-only call proves marketplace
 * readability.
 */
export function keelInlineTokenUriReadGasEstimate(input: {
  readonly harnessReadGas: bigint;
  readonly animationUriByteLength: number | bigint;
}): bigint {
  const byteLength = BigInt(input.animationUriByteLength);
  if (input.harnessReadGas < 0n) throw new RangeError("Inline harness read gas cannot be negative.");
  if (byteLength < 0n) throw new RangeError("Inline animation URI byte length cannot be negative.");
  return input.harnessReadGas
    + KEEL_INLINE_TOKEN_URI_FIXED_GAS
    + byteLength * KEEL_INLINE_TOKEN_URI_GAS_PER_BYTE;
}

/**
 * Complete collection-read budget for the direct pre-encoded lane. The
 * measured builder call already copies the final static tokenURI bytes, so it
 * must not be charged the old per-byte re-encoding allowance a second time.
 */
export function keelPreEncodedTokenUriReadGasEstimate(input: {
  readonly assemblyReadGas: bigint;
}): bigint {
  if (input.assemblyReadGas < 0n) throw new RangeError("Inline assembly read gas cannot be negative.");
  return input.assemblyReadGas + KEEL_PREENCODED_TOKEN_URI_COLLECTION_MARGIN;
}

export type KeelPresentationMode = "inline" | "hybrid" | "ipfs";

export const KEEL_PRESENTATION_TERMS = Object.freeze({
  bootShell: "Small, uncompressed HTML that starts the verified viewer.",
  resourceGraph: "Digest-bound scripts, modules, assets, and data used by the viewer. Child resources may be compressed.",
  browserDecoder: "A committed browser or WASM decoder that expands compressed child resources after their stored bytes are verified.",
  inline: "The complete animation_url is assembled onchain as a data:text/html URI. It has no gateway, IPFS, /content, or RPC fetch dependency.",
  hybrid: "The boot shell is onchain and resolves exact native KEEL objects through an RPC reader. The artwork remains fully onchain, but presentation needs RPC access.",
  ipfs: "The shell or resource graph is delivered from an explicitly selected IPFS URI and verified against its commitments.",
} as const);

/**
 * Codec policy exposed to Studio and agents. Compression belongs to graph
 * resources, not to the contract-readable boot shell.
 */
export const KEEL_PRESENTATION_CODEC_POLICY = Object.freeze({
  none: {
    decoder: "none",
    requirement: "Use for the boot shell and small resources that do not benefit from compression.",
  },
  gzip: {
    decoder: "browser-decompression-stream",
    requirement: "The committed shell must capability-check the browser Gzip decoder before exposing verified decoded bytes.",
  },
  deflate: {
    decoder: "browser-decompression-stream",
    requirement: "The committed shell must capability-check the browser Deflate decoder before exposing verified decoded bytes.",
  },
  brotli: {
    decoder: "declared-keel-module",
    requirement: "Reference an exact digest-locked KEEL Brotli decoder module, normally the reusable thin WASM decoder published once per chain. Do not make each creator upload it again or assume native browser Brotli support.",
  },
} as const);

export interface KeelInlinePresentationAssessment {
  readonly eligible: boolean;
  readonly recommendedMode: "inline" | "hybrid";
  readonly reason: string;
}

/**
 * Assess whether the current HTML can be returned as a complete Inline
 * animation_url by the configured contract builder.
 *
 * Only the boot shell must be uncompressed. Compressed child resources are
 * valid when the contract assembles their committed stored bytes into the
 * returned document and the shell's committed browser decoder expands them.
 * A shell that still fetches `/content`, `/api/onchain`, or an HTTP URL is
 * Hybrid, even when every referenced byte is native KEEL storage.
 */
export function assessKeelInlinePresentation(input: {
  readonly builderConfigured: boolean;
  readonly bootShellCompression: string;
  /** Prepared tokenURI return bytes, never the browser-decoded module size. */
  readonly tokenUriByteLength?: number | bigint;
  readonly mediaType: string;
  readonly html?: string;
}): KeelInlinePresentationAssessment {
  const tokenUriByteLength = input.tokenUriByteLength === undefined
    ? undefined
    : Number(input.tokenUriByteLength);
  if (tokenUriByteLength !== undefined && (!Number.isSafeInteger(tokenUriByteLength) || tokenUriByteLength < 0)) {
    return {
      eligible: false,
      recommendedMode: "hybrid",
      reason: "The prepared tokenURI return length could not be verified safely. Hybrid remains fail-closed and keeps the immutable bytes onchain.",
    };
  }
  if (!/^text\/html(?:;|$)/iu.test(input.mediaType.trim())) {
    return {
      eligible: false,
      recommendedMode: "hybrid",
      reason: "The selected boot shell is not HTML, so KEEL cannot return it as animation_url.",
    };
  }
  if (input.bootShellCompression !== "none") {
    return {
      eligible: false,
      recommendedMode: "hybrid",
      reason: "The boot shell is compressed. The current contract builder must read that root HTML directly; compress child modules and assets instead.",
    };
  }
  if (tokenUriByteLength !== undefined && tokenUriByteLength > KEEL_INLINE_MAX_TOKEN_URI_BYTES) {
    return {
      eligible: false,
      recommendedMode: "hybrid",
      reason: `The prepared tokenURI return is ${tokenUriByteLength.toLocaleString()} bytes, above KEEL's ${KEEL_INLINE_MAX_TOKEN_URI_BYTES.toLocaleString()}-byte public-read limit.`,
    };
  }
  if (input.html !== undefined) {
    // Module aliases are inert data until the verified shell replaces them
    // with digest-checked blob/data URLs. Do not reject an Inline document
    // merely because an alias string contains `/content/...`; reject only an
    // active URL-bearing HTML attribute or network call.
    const requiresNetworkResolution = /(?:src|href)\s*=\s*["'](?:https?:\/\/|\/(?:api\/onchain|content)\/)/iu.test(input.html)
      || /(?:fetch|import)\s*\(\s*["'](?:https?:\/\/|\/(?:api\/onchain|content)\/)/iu.test(input.html);
    if (requiresNetworkResolution) {
      return {
        eligible: false,
        recommendedMode: "hybrid",
        reason: "This boot shell still resolves resources at runtime. Its immutable bytes may all be native KEEL storage, but presentation requires the Hybrid RPC reader.",
      };
    }
  }
  if (!input.builderConfigured) {
    return {
      eligible: false,
      recommendedMode: "hybrid",
      reason: "This chain has no verified KEEL inline builder. Hybrid is available without changing where the immutable bytes are stored.",
    };
  }
  return {
    eligible: true,
    recommendedMode: "inline",
    reason: tokenUriByteLength === undefined
      ? "The HTML is self-contained. KEEL will build and measure the exact tokenURI return before wallet review."
      : "The prepared tokenURI return is under 2 MB. KEEL must still prove the exact builder read stays within the selected chain's current public RPC gas boundary before wallet review.",
  };
}
