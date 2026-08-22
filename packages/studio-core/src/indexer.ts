import type {
  IndexedBlockCheckpoint,
  IndexedEventIdentity,
  IndexedRange,
  IndexerCursorState,
  ReorgDecision,
} from "./types.js";

export function eventIdentityKey(identity: IndexedEventIdentity): string {
  if (!Number.isSafeInteger(identity.chainId) || identity.chainId <= 0) throw new RangeError("chainId is invalid.");
  if (!Number.isSafeInteger(identity.logIndex) || identity.logIndex < 0) throw new RangeError("logIndex is invalid.");
  return `${identity.chainId}:${identity.transactionHash.toLowerCase()}:${identity.logIndex}`;
}

export function nextIndexerRange(input: {
  readonly cursor: IndexerCursorState;
  readonly latestBlock: bigint;
  readonly confirmations?: bigint;
  readonly batchSize?: bigint;
}): IndexedRange | undefined {
  const confirmations = input.confirmations ?? 2n;
  const batchSize = input.batchSize ?? 1_000n;
  if (confirmations < 0n) throw new RangeError("confirmations cannot be negative.");
  if (batchSize <= 0n) throw new RangeError("batchSize must be positive.");
  const confirmedHead = input.latestBlock >= confirmations ? input.latestBlock - confirmations : 0n;
  if (input.cursor.nextBlock > confirmedHead) return undefined;
  const toBlock = input.cursor.nextBlock + batchSize - 1n;
  return {
    fromBlock: input.cursor.nextBlock,
    toBlock: toBlock > confirmedHead ? confirmedHead : toBlock,
  };
}

export function rewindBlock(nextBlock: bigint, depth = 24n): bigint {
  if (depth < 0n) throw new RangeError("rewind depth cannot be negative.");
  return nextBlock > depth ? nextBlock - depth : 0n;
}

export function detectReorg(
  previous: IndexedBlockCheckpoint | undefined,
  incoming: IndexedBlockCheckpoint,
  rewindDepth = 32n,
): ReorgDecision {
  if (rewindDepth < 1n) throw new RangeError("rewindDepth must be at least one block.");
  if (previous === undefined) {
    return {
      reorg: false,
      rewindTo: incoming.blockNumber,
      deleteFrom: incoming.blockNumber + 1n,
      reason: "initial-checkpoint",
    };
  }
  if (previous.chainId !== incoming.chainId) throw new TypeError("Cannot compare checkpoints from different chains.");
  if (incoming.blockNumber !== previous.blockNumber + 1n) {
    const rewindTo = incoming.blockNumber > rewindDepth ? incoming.blockNumber - rewindDepth : 0n;
    return {
      reorg: true,
      rewindTo,
      deleteFrom: rewindTo + 1n,
      reason: `non-contiguous block sequence ${previous.blockNumber.toString()} -> ${incoming.blockNumber.toString()}`,
    };
  }
  if (incoming.parentHash.toLowerCase() !== previous.blockHash.toLowerCase()) {
    const rewindTo = previous.blockNumber > rewindDepth ? previous.blockNumber - rewindDepth : 0n;
    return {
      reorg: true,
      rewindTo,
      deleteFrom: rewindTo + 1n,
      reason: `parent mismatch ${incoming.parentHash} != ${previous.blockHash}`,
    };
  }
  return {
    reorg: false,
    rewindTo: previous.blockNumber,
    deleteFrom: incoming.blockNumber + 1n,
    reason: "canonical-continuation",
  };
}
