import type {
  ArtifactPresentationRequest,
  ArtifactPresentationResult,
  ResolverAdapters,
} from "./types.js";

export interface RegistryContractReadRequest {
  readonly chainId: number;
  readonly address: `0x${string}`;
  readonly functionName: "activePresentation" | "presentationMatches";
  readonly args: readonly unknown[];
  readonly signal: AbortSignal;
}

/**
 * Minimal bridge that can be backed by viem, ethers, an RPC proxy, or a wallet
 * client. The viewer remains transport-neutral while still forcing an actual
 * KeelIndex read before a registry-trusted manifest can resolve.
 */
export type RegistryContractRead = (request: RegistryContractReadRequest) => Promise<unknown>;

export interface KeelIndexReaderOptions {
  /** Perform the registry's explicit presentationMatches check after reading. */
  readonly confirmMatch?: boolean;
}

const DIGEST = /^0x[0-9a-f]{64}$/;

function tupleValue(value: unknown, key: string, index: number): unknown {
  if (Array.isArray(value)) return value[index];
  if (value !== null && typeof value === "object") {
    const record = value as Record<string | number, unknown>;
    return record[key] ?? record[index];
  }
  return undefined;
}

function safeRevision(value: unknown): number {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError("KeelIndex revision exceeds safe client limits.");
    return number;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("KeelIndex returned an invalid revision.");
  }
  return value as number;
}

function parsePresentation(value: unknown): ArtifactPresentationResult {
  const manifestURI = tupleValue(value, "manifestURI", 0);
  const manifestDigest = tupleValue(value, "manifestDigest", 1);
  const revision = tupleValue(value, "revision", 2);
  if (typeof manifestURI !== "string" || manifestURI.length === 0) {
    throw new TypeError("KeelIndex returned an invalid manifest URI.");
  }
  if (typeof manifestDigest !== "string" || !DIGEST.test(manifestDigest)) {
    throw new TypeError("KeelIndex returned a non-canonical SHA-256 digest.");
  }
  return { manifestURI, manifestDigest: manifestDigest as `0x${string}`, revision: safeRevision(revision) };
}

/**
 * Create the readArtifactPresentation adapter used by
 * resolveArtifactFromRegistry(). With confirmMatch enabled (the default), the
 * adapter performs both activePresentation and presentationMatches calls.
 */
export function createKeelIndexPresentationReader(
  readContract: RegistryContractRead,
  options: KeelIndexReaderOptions = {},
): NonNullable<ResolverAdapters["readArtifactPresentation"]> {
  const confirmMatch = options.confirmMatch ?? true;
  return async (request: ArtifactPresentationRequest, signal: AbortSignal) => {
    const tokenId = BigInt(request.tokenId);
    const presentation = parsePresentation(
      await readContract({
        chainId: request.chainId,
        address: request.registry,
        functionName: "activePresentation",
        args: [request.collection, tokenId],
        signal,
      }),
    );
    if (request.revision !== undefined && request.revision !== presentation.revision) {
      throw new Error(
        `KeelIndex active revision ${presentation.revision} does not match requested revision ${request.revision}.`,
      );
    }
    if (confirmMatch) {
      const matches = await readContract({
        chainId: request.chainId,
        address: request.registry,
        functionName: "presentationMatches",
        args: [request.collection, tokenId, presentation.manifestDigest, BigInt(presentation.revision)],
        signal,
      });
      if (matches !== true) throw new Error("KeelIndex rejected its returned presentation commitment.");
    }
    return presentation;
  };
}
