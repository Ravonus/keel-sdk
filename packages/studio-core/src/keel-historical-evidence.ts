import { decompressBytes } from "@keel/builder";
import {
  bytesToUtf8,
  concatBytes,
  createIntegrity,
  decodeBase85,
  equalBytes,
  packUint48Ids,
  verifyIntegrity,
  type Integrity,
} from "@keel/protocol";

const GAME_HEAD_MARKER = "var imgs = {";
const GAME_ATLAS_MARKER = "var seeds = {";
const GAME_TOKEN_TERMINATOR = /entities\s*:\s*\{\s*src\s*:\s*imgs\.e\s*,\s*columns\s*:\s*7\s*\}\s*\};/gu;

export class UnsupportedHistoricalGameVariant extends Error {
  constructor(readonly tokenId: string, message: string) {
    super(`Historical game ${tokenId} is unsupported: ${message}`);
    this.name = "UnsupportedHistoricalGameVariant";
  }
}

export interface HistoricalGameInput {
  readonly tokenId: string;
  readonly bytes: Uint8Array;
}

export interface HistoricalGameSplit {
  readonly head: Uint8Array;
  readonly atlas: Uint8Array;
  readonly token: Uint8Array;
  readonly engine: Uint8Array;
  readonly offsets: {
    readonly headEnd: number;
    readonly atlasEnd: number;
    readonly tokenEnd: number;
    readonly fullEnd: number;
  };
}

export interface HistoricalGameEvidenceReport {
  readonly schema: "keel-historical-game-evidence@1";
  readonly tokenCount: number;
  readonly tokens: readonly {
    readonly tokenId: string;
    readonly byteLength: number;
    readonly integrity: Integrity;
    readonly reassembledIntegrity: Integrity;
    readonly reassembledByteIdentical: true;
    readonly offsets: HistoricalGameSplit["offsets"];
    readonly fragmentDigests: readonly [string, string, string, string];
  }[];
  readonly fragments: readonly {
    readonly digest: string;
    readonly byteLength: number;
    readonly roles: readonly ("head" | "atlas" | "token" | "engine")[];
    readonly tokenIds: readonly string[];
  }[];
  readonly storage: {
    readonly naiveFullBytes: number;
    readonly uniqueFragmentBytes: number;
    readonly bytesSaved: number;
    readonly savingsRatio: number;
    readonly uniqueFragmentCount: number;
    readonly sharedFragmentCount: number;
    readonly perTokenFragmentCount: number;
    readonly model: "shared-fragments-once-plus-per-token-fragment";
  };
}

export interface HistoricalGameEvidenceBundle {
  readonly report: HistoricalGameEvidenceReport;
  readonly fragmentBytes: ReadonlyMap<string, Uint8Array>;
}

function byteOffset(source: string, characterOffset: number): number {
  return new TextEncoder().encode(source.slice(0, characterOffset)).byteLength;
}

/**
 * Splits the original UTF-8 bytes without reserializing them. Character
 * offsets are converted back to byte offsets because the captures are not
 * guaranteed to be ASCII.
 */
export function splitHistoricalGame(tokenId: string, bytes: Uint8Array): HistoricalGameSplit {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedHistoricalGameVariant(tokenId, "source is not valid UTF-8");
  }
  const headCharacterEnd = source.indexOf(GAME_HEAD_MARKER);
  const atlasCharacterEnd = source.indexOf(GAME_ATLAS_MARKER);
  if (headCharacterEnd < 0 || atlasCharacterEnd < 0 || atlasCharacterEnd <= headCharacterEnd) {
    throw new UnsupportedHistoricalGameVariant(tokenId, "standard image/seed boundaries are missing");
  }
  GAME_TOKEN_TERMINATOR.lastIndex = atlasCharacterEnd;
  const match = GAME_TOKEN_TERMINATOR.exec(source);
  GAME_TOKEN_TERMINATOR.lastIndex = 0;
  if (match === null) throw new UnsupportedHistoricalGameVariant(tokenId, "standard entity terminator is missing");

  const headEnd = byteOffset(source, headCharacterEnd);
  const atlasEnd = byteOffset(source, atlasCharacterEnd);
  const tokenEnd = byteOffset(source, match.index + match[0].length);
  if (headEnd <= 0 || atlasEnd <= headEnd || tokenEnd <= atlasEnd || tokenEnd >= bytes.byteLength) {
    throw new UnsupportedHistoricalGameVariant(tokenId, "computed byte boundaries are invalid");
  }
  return {
    head: bytes.slice(0, headEnd),
    atlas: bytes.slice(headEnd, atlasEnd),
    token: bytes.slice(atlasEnd, tokenEnd),
    engine: bytes.slice(tokenEnd),
    offsets: { headEnd, atlasEnd, tokenEnd, fullEnd: bytes.byteLength },
  };
}

export async function analyzeHistoricalGames(inputs: readonly HistoricalGameInput[]): Promise<HistoricalGameEvidenceBundle> {
  if (inputs.length === 0) throw new RangeError("At least one historical game is required.");
  const tokenIds = new Set<string>();
  const fragments = new Map<
    string,
    { bytes: Uint8Array; roles: Set<"head" | "atlas" | "token" | "engine">; tokenIds: Set<string> }
  >();
  const tokens: Array<HistoricalGameEvidenceReport["tokens"][number]> = [];

  for (const input of inputs) {
    if (tokenIds.has(input.tokenId)) throw new TypeError(`Duplicate historical game token ${input.tokenId}.`);
    tokenIds.add(input.tokenId);
    const split = splitHistoricalGame(input.tokenId, input.bytes);
    const parts = [
      ["head", split.head],
      ["atlas", split.atlas],
      ["token", split.token],
      ["engine", split.engine],
    ] as const;
    const fragmentDigests: string[] = [];
    for (const [role, bytes] of parts) {
      const integrity = await createIntegrity(bytes);
      const existing = fragments.get(integrity.digest);
      if (existing === undefined) {
        fragments.set(integrity.digest, { bytes: bytes.slice(), roles: new Set([role]), tokenIds: new Set([input.tokenId]) });
      } else {
        if (!equalBytes(existing.bytes, bytes)) throw new Error(`Digest collision while splitting game ${input.tokenId}.`);
        existing.roles.add(role);
        existing.tokenIds.add(input.tokenId);
      }
      fragmentDigests.push(integrity.digest);
    }
    const assembled = concatBytes(parts.map(([, bytes]) => bytes));
    const integrity = await createIntegrity(input.bytes);
    const reassembledIntegrity = await createIntegrity(assembled);
    if (!equalBytes(assembled, input.bytes) || !(await verifyIntegrity(assembled, integrity))) {
      throw new Error(`Historical game ${input.tokenId} did not reassemble byte-for-byte.`);
    }
    tokens.push({
      tokenId: input.tokenId,
      byteLength: input.bytes.byteLength,
      integrity,
      reassembledIntegrity,
      reassembledByteIdentical: true,
      offsets: split.offsets,
      fragmentDigests: fragmentDigests as unknown as readonly [string, string, string, string],
    });
  }

  const fragmentModels = [...fragments.entries()]
    .map(([digest, entry]) => ({
      digest,
      byteLength: entry.bytes.byteLength,
      roles: [...entry.roles].sort(),
      tokenIds: [...entry.tokenIds].sort((left, right) => Number(left) - Number(right)),
    }))
    .sort((left, right) => left.digest.localeCompare(right.digest)) as HistoricalGameEvidenceReport["fragments"];
  const naiveFullBytes = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
  const uniqueFragmentBytes = [...fragments.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  const bytesSaved = naiveFullBytes - uniqueFragmentBytes;
  const sharedFragmentCount = fragmentModels.filter((fragment) => fragment.tokenIds.length === inputs.length).length;
  const perTokenFragmentCount = fragmentModels.filter(
    (fragment) => fragment.roles.includes("token") && fragment.tokenIds.length === 1,
  ).length;
  return {
    report: {
      schema: "keel-historical-game-evidence@1",
      tokenCount: inputs.length,
      tokens,
      fragments: fragmentModels,
      storage: {
        naiveFullBytes,
        uniqueFragmentBytes,
        bytesSaved,
        savingsRatio: naiveFullBytes === 0 ? 0 : bytesSaved / naiveFullBytes,
        uniqueFragmentCount: fragments.size,
        sharedFragmentCount,
        perTokenFragmentCount,
        model: "shared-fragments-once-plus-per-token-fragment",
      },
    },
    fragmentBytes: new Map([...fragments].map(([digest, entry]) => [digest, entry.bytes.slice()])),
  };
}

export interface HistoricalThreeSerializedEvidence {
  readonly source: { readonly byteLength: number; readonly integrity: Integrity };
  readonly storedBrotli: { readonly byteLength: number; readonly integrity: Integrity };
  readonly resolved: { readonly byteLength: number; readonly integrity: Integrity };
  readonly filenameCompressionLabel: "misleading-deflate-name";
}

export interface HistoricalThreeEvidence {
  readonly schema: "keel-historical-three-evidence@1";
  readonly raw: {
    readonly byteLength: number;
    readonly integrity: Integrity;
    readonly historicalChunkBytes: 23_000;
    readonly historicalChunkCount: number;
  };
  readonly rootSerialized: HistoricalThreeSerializedEvidence & {
    readonly differsFromRawByLeadingCarriageReturnOnly: boolean;
  };
  readonly alternateSerialized?: HistoricalThreeSerializedEvidence & {
    readonly sourceDriftBytes: number;
  };
}

async function analyzeThreeSerialization(sourceBytes: Uint8Array): Promise<HistoricalThreeSerializedEvidence> {
  const payload = bytesToUtf8(sourceBytes);
  const storedBrotli = decodeBase85(payload);
  const resolved = await decompressBytes("brotli", storedBrotli);
  return {
    source: { byteLength: sourceBytes.byteLength, integrity: await createIntegrity(sourceBytes) },
    storedBrotli: { byteLength: storedBrotli.byteLength, integrity: await createIntegrity(storedBrotli) },
    resolved: { byteLength: resolved.byteLength, integrity: await createIntegrity(resolved) },
    filenameCompressionLabel: "misleading-deflate-name",
  };
}

export async function analyzeHistoricalThree(input: {
  readonly raw: Uint8Array;
  readonly rootSerialized: Uint8Array;
  readonly alternateSerialized?: Uint8Array;
}): Promise<HistoricalThreeEvidence> {
  const root = await analyzeThreeSerialization(input.rootSerialized);
  const rootResolved = await decompressBytes("brotli", decodeBase85(bytesToUtf8(input.rootSerialized)));
  const rawIntegrity = await createIntegrity(input.raw);
  const alternate = input.alternateSerialized === undefined ? undefined : await analyzeThreeSerialization(input.alternateSerialized);
  return {
    schema: "keel-historical-three-evidence@1",
    raw: {
      byteLength: input.raw.byteLength,
      integrity: rawIntegrity,
      historicalChunkBytes: 23_000,
      historicalChunkCount: Math.ceil(input.raw.byteLength / 23_000),
    },
    rootSerialized: {
      ...root,
      differsFromRawByLeadingCarriageReturnOnly:
        rootResolved.byteLength === input.raw.byteLength + 1 &&
        rootResolved[0] === 0x0d &&
        equalBytes(rootResolved.subarray(1), input.raw),
    },
    ...(alternate === undefined
      ? {}
      : {
          alternateSerialized: {
            ...alternate,
            sourceDriftBytes: alternate.source.byteLength - root.source.byteLength,
          },
        }),
  };
}

export interface HistoricalCometEvidence {
  readonly schema: "keel-historical-comet-evidence@1";
  readonly archive: { readonly byteLength: number; readonly integrity: Integrity };
  readonly historicalIndexConvention: {
    readonly objectIds: readonly [2, 3, 4, 5, 6];
    readonly packedWord: `0x${string}`;
    readonly byteToIdMapping: "not-proven-by-retained-chain-state";
  };
  readonly emittedRuntimeOrder: readonly ["brotli-loader", "de85", "seedGen", "p5@1.7.0", "start-p5", "seed"];
  readonly startP5PayloadMatchesCorpus: boolean;
  readonly externalRuntimeDependenciesPinnedLocally: false;
}

export async function analyzeHistoricalComet(
  archiveBytes: Uint8Array,
  startP5Base85Bytes: Uint8Array,
): Promise<HistoricalCometEvidence> {
  const archive = bytesToUtf8(archiveBytes);
  const markers = [
    "https://unpkg.com/brotli-wasm@1.3.1/index.web.js?module~module-default(brotli)",
    "function de85",
    "function seedGen",
    "https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.7.0/p5.min.js~script()",
    "<b85>",
  ] as const;
  const positions = markers.map((marker) => archive.indexOf(marker));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= (positions[index - 1] ?? -1))) {
    throw new Error("Historical Comet archive does not contain the expected emitted runtime order.");
  }
  const payloadStart = (positions[4] ?? -1) + "<b85>".length;
  const payloadEnd = archive.indexOf("</b85>", payloadStart);
  if (payloadEnd < payloadStart) throw new Error("Historical Comet start-p5 payload is not terminated.");
  const payload = archive.slice(payloadStart, payloadEnd);
  const expectedPayload = bytesToUtf8(startP5Base85Bytes);
  const packed = packUint48Ids([2, 3, 4, 5, 6]);
  const packedWord = packed[0];
  if (packedWord === undefined || packed.length !== 1) throw new Error("Canonical Comet IDs did not fit one packed word.");
  return {
    schema: "keel-historical-comet-evidence@1",
    archive: { byteLength: archiveBytes.byteLength, integrity: await createIntegrity(archiveBytes) },
    historicalIndexConvention: {
      objectIds: [2, 3, 4, 5, 6],
      packedWord: `0x${packedWord.value.toString(16).padStart(64, "0")}`,
      byteToIdMapping: "not-proven-by-retained-chain-state",
    },
    emittedRuntimeOrder: ["brotli-loader", "de85", "seedGen", "p5@1.7.0", "start-p5", "seed"],
    startP5PayloadMatchesCorpus: payload === expectedPayload,
    externalRuntimeDependenciesPinnedLocally: false,
  };
}
