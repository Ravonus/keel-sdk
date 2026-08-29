import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { sha256Hex, type Compression } from "@keel/protocol";

/**
 * Chain-agnostic planning and recovery rules for managed KEEL publications.
 *
 * Deployed contracts may retain their historical `Stratus*` names. Those are
 * wire identifiers only; product code should use the KEEL names in this file.
 */

export const KEEL_NATIVE_CHUNK_BYTES = 23_000 as const;
export const KEEL_NATIVE_CHUNKS_PER_TRANSACTION = 3 as const;
export const ETHEREUM_TRANSACTION_BASE_GAS = 21_000 as const;
export const ETHEREUM_ZERO_CALLDATA_BYTE_GAS = 4 as const;
export const ETHEREUM_NONZERO_CALLDATA_BYTE_GAS = 16 as const;
export const MAX_KEEL_CARRIER_TRANSACTIONS_PER_WAVE = 4 as const;
/** `KeelPublicationJob.executeOperations` is capped at four calls per tx. */
export const KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH = 4 as const;
export const KEEL_PUBLICATION_OPERATION_ROUTES = ["packed-v2", "single-v1"] as const;
export type KeelPublicationOperationRoute = (typeof KEEL_PUBLICATION_OPERATION_ROUTES)[number];
export const KEEL_MANAGED_JOB_LIFETIME_SECONDS = 24 * 60 * 60;
/** Compatibility domain used by the currently deployed KEEL publication job. */
export const KEEL_PUBLICATION_JOB_WIRE_DOMAIN = "stratus-publication-job@3" as const;

/**
 * Conservative fit for the deployed Ingot carrier path. Runtime bytecode costs
 * 200 gas/byte; the remaining terms cover CREATE, hashing, mappings, events,
 * and the publication-job cursor. The fit is intentionally just above both
 * the exact 138 B + 1,541 B modular-viewer benchmark and the 1/2/3 x 23 KB
 * carrier matrix, instead of charging every partial carrier as a full 23 KB.
 */
const KEEL_NATIVE_CARRIER_GAS_PER_STORED_BYTE = 204;
const KEEL_NATIVE_CARRIER_GAS_PER_CHUNK = 10_200;
const KEEL_NATIVE_CARRIER_GAS_PER_TRANSACTION = 115_000;
const KEEL_NATIVE_OBJECT_CREATION_GAS = 150_000;
const KEEL_LOGICAL_REGISTRY_OPERATION_GAS = 150_000;
/** Bounded allowance for fundExecutor plus completeJob; shown separately. */
const KEEL_EXECUTOR_CONTROL_GAS = 200_000;

/** Versioned, explicit publication routes. Omitting a mode always means the native route. */
export const KEEL_NATIVE_CARRIER_V1 = "native-carrier-v1" as const;
export const KEEL_HISTORY_INSCRIPTION_V1 = "history-inscription-v1" as const;
export const KEEL_DEFAULT_PUBLICATION_STORAGE_MODE = KEEL_NATIVE_CARRIER_V1;
export const KEEL_PUBLICATION_STORAGE_MODES = [
  KEEL_NATIVE_CARRIER_V1,
  KEEL_HISTORY_INSCRIPTION_V1,
] as const;
export type KeelPublicationStorageMode = (typeof KEEL_PUBLICATION_STORAGE_MODES)[number];
/** Pre-versioned journals are accepted only when they explicitly identified the native route. */
type KeelLegacyNativeStorageMode = "native";

export interface KeelNativePublicationGasEstimate {
  readonly storageMode: typeof KEEL_NATIVE_CARRIER_V1;
  readonly storedByteLength: number;
  readonly chunkCount: number;
  readonly carrierTransactionCount: number;
  /** EVM transaction base plus the ABI-encoded executeCarrier calldata. */
  readonly calldataIntrinsicGas: number;
  /** Contract execution used to deploy immutable KEEL carrier code. */
  readonly nativeCarrierWriteGas: number;
  readonly objectCreationGas: number;
  readonly logicalRegistryOperationGas: number;
  readonly executorControlGas: number;
  readonly totalExecutorGas: number;
}

export function estimateKeelNativePublicationGas(input: {
  readonly storedByteLength: number;
  readonly storedBytes?: Uint8Array;
  /** Exact immutable carrier payload lengths, including leaf-boundary splits. */
  readonly chunkByteLengths?: readonly number[];
  readonly contentObjectCount: number;
  readonly logicalOperationCount?: number;
  readonly includeExecutorControlGas?: boolean;
}): KeelNativePublicationGasEstimate {
  const storedByteLength = nonNegativeSafeInteger(input.storedByteLength, "stored byte length");
  const contentObjectCount = nonNegativeSafeInteger(input.contentObjectCount, "content object count");
  const logicalOperationCount = nonNegativeSafeInteger(
    input.logicalOperationCount ?? 1,
    "logical operation count",
  );
  if (storedByteLength === 0 && contentObjectCount === 0 && logicalOperationCount === 0) {
    throw new RangeError("A KEEL native publication gas estimate cannot be empty.");
  }
  if (input.storedBytes !== undefined && input.storedBytes.byteLength !== storedByteLength) {
    throw new RangeError("The stored KEEL bytes do not match the declared byte length.");
  }
  const chunkByteLengths = input.chunkByteLengths === undefined
    ? derivedChunkByteLengths(storedByteLength)
    : validatedChunkByteLengths(input.chunkByteLengths, storedByteLength);
  const chunkCount = chunkByteLengths.length;
  const carrierTransactionCount = Math.ceil(chunkCount / KEEL_NATIVE_CHUNKS_PER_TRANSACTION);
  const calldataIntrinsicGas = estimateKeelExecuteCarrierIntrinsicGas(
    storedByteLength,
    input.storedBytes,
    chunkByteLengths,
  );
  const nativeCarrierWriteGas = storedByteLength * KEEL_NATIVE_CARRIER_GAS_PER_STORED_BYTE
    + chunkCount * KEEL_NATIVE_CARRIER_GAS_PER_CHUNK
    + carrierTransactionCount * KEEL_NATIVE_CARRIER_GAS_PER_TRANSACTION;
  const totalCarrierGas = calldataIntrinsicGas + nativeCarrierWriteGas;
  const objectCreationGas = contentObjectCount * KEEL_NATIVE_OBJECT_CREATION_GAS;
  const logicalRegistryOperationGas = logicalOperationCount * KEEL_LOGICAL_REGISTRY_OPERATION_GAS;
  const executorControlGas = input.includeExecutorControlGas === true ? KEEL_EXECUTOR_CONTROL_GAS : 0;

  return Object.freeze({
    storageMode: KEEL_NATIVE_CARRIER_V1,
    storedByteLength,
    chunkCount,
    carrierTransactionCount,
    calldataIntrinsicGas,
    nativeCarrierWriteGas,
    objectCreationGas,
    logicalRegistryOperationGas,
    executorControlGas,
    totalExecutorGas: totalCarrierGas + objectCreationGas + logicalRegistryOperationGas + executorControlGas,
  });
}

/**
 * Models the exact ABI envelope and transaction base for the executor's
 * `executeCarrier(uint256,bytes[])` calls. Before a job id exists, one
 * non-zero byte is reserved for it; that differs from the eventual id by at
 * most a few intrinsic gas units and never changes the executor maximum.
 */
function estimateKeelExecuteCarrierIntrinsicGas(
  storedByteLength: number,
  storedBytes?: Uint8Array,
  chunkByteLengths: readonly number[] = derivedChunkByteLengths(storedByteLength),
): number {
  let totalGas = 0;
  let payloadOffset = 0;
  for (let chunkIndex = 0; chunkIndex < chunkByteLengths.length; chunkIndex += KEEL_NATIVE_CHUNKS_PER_TRANSACTION) {
    const batchLengths = chunkByteLengths.slice(chunkIndex, chunkIndex + KEEL_NATIVE_CHUNKS_PER_TRANSACTION);
    let zeroBytes = 0;
    let nonZeroBytes = 4; // executeCarrier(uint256,bytes[]) selector 0xada7a692
    ({ zeroBytes, nonZeroBytes } = addAbiWord(zeroBytes, nonZeroBytes, 1n)); // future job id
    ({ zeroBytes, nonZeroBytes } = addAbiWord(zeroBytes, nonZeroBytes, 64n)); // bytes[] head offset
    ({ zeroBytes, nonZeroBytes } = addAbiWord(zeroBytes, nonZeroBytes, BigInt(batchLengths.length)));

    let elementOffset = batchLengths.length * 32;
    for (const length of batchLengths) {
      ({ zeroBytes, nonZeroBytes } = addAbiWord(zeroBytes, nonZeroBytes, BigInt(elementOffset)));
      elementOffset += 32 + paddedAbiByteLength(length);
    }
    for (const length of batchLengths) {
      ({ zeroBytes, nonZeroBytes } = addAbiWord(zeroBytes, nonZeroBytes, BigInt(length)));
      if (storedBytes === undefined) {
        nonZeroBytes += length;
      } else {
        for (const byte of storedBytes.subarray(payloadOffset, payloadOffset + length)) {
          if (byte === 0) zeroBytes += 1;
          else nonZeroBytes += 1;
        }
      }
      zeroBytes += paddedAbiByteLength(length) - length;
      payloadOffset += length;
    }
    totalGas += ETHEREUM_TRANSACTION_BASE_GAS
      + zeroBytes * ETHEREUM_ZERO_CALLDATA_BYTE_GAS
      + nonZeroBytes * ETHEREUM_NONZERO_CALLDATA_BYTE_GAS;
  }
  return totalGas;
}

function derivedChunkByteLengths(storedByteLength: number): readonly number[] {
  const lengths: number[] = [];
  for (let offset = 0; offset < storedByteLength; offset += KEEL_NATIVE_CHUNK_BYTES) {
    lengths.push(Math.min(KEEL_NATIVE_CHUNK_BYTES, storedByteLength - offset));
  }
  return lengths;
}

function validatedChunkByteLengths(lengths: readonly number[], storedByteLength: number): readonly number[] {
  const validated = lengths.map((length) => positiveSafeInteger(length, "chunk byte length"));
  if (validated.some((length) => length > KEEL_NATIVE_CHUNK_BYTES)) {
    throw new RangeError(`A KEEL native carrier chunk cannot exceed ${KEEL_NATIVE_CHUNK_BYTES} bytes.`);
  }
  if (validated.reduce((total, length) => total + length, 0) !== storedByteLength) {
    throw new RangeError("The KEEL native carrier chunk lengths do not match the stored byte length.");
  }
  return validated;
}

function addAbiWord(
  zeroBytes: number,
  nonZeroBytes: number,
  value: bigint,
): { readonly zeroBytes: number; readonly nonZeroBytes: number } {
  let remaining = value;
  let valueBytes = 0;
  let valueZeroBytes = 0;
  do {
    if ((remaining & 0xffn) === 0n) valueZeroBytes += 1;
    valueBytes += 1;
    remaining >>= 8n;
  } while (remaining > 0n);
  return {
    zeroBytes: zeroBytes + (32 - valueBytes) + valueZeroBytes,
    nonZeroBytes: nonZeroBytes + valueBytes - valueZeroBytes,
  };
}

function paddedAbiByteLength(byteLength: number): number {
  return Math.ceil(byteLength / 32) * 32;
}

export interface EthereumCalldataIntrinsicGasEstimate {
  readonly transactionCount: number;
  readonly payloadByteLength: number;
  readonly envelopeByteLength: number;
  readonly zeroByteCount: number;
  readonly nonZeroByteCount: number;
  readonly transactionBaseGas: number;
  readonly calldataByteGas: number;
  /** Transaction base plus calldata bytes; contract execution is excluded. */
  readonly calldataIntrinsicGas: number;
}

export function estimateEthereumCalldataIntrinsicGas(input: {
  readonly bytes: Uint8Array;
  readonly transactionCount?: number;
  readonly envelopeByteLengthPerTransaction?: number;
  readonly envelopeZeroByteCountPerTransaction?: number;
}): EthereumCalldataIntrinsicGasEstimate {
  const transactionCount = positiveSafeInteger(input.transactionCount ?? 1, "transaction count");
  const envelopeByteLengthPerTransaction = nonNegativeSafeInteger(
    input.envelopeByteLengthPerTransaction ?? 0,
    "envelope byte length",
  );
  const envelopeZeroByteCountPerTransaction = nonNegativeSafeInteger(
    input.envelopeZeroByteCountPerTransaction ?? 0,
    "envelope zero-byte count",
  );
  if (envelopeZeroByteCountPerTransaction > envelopeByteLengthPerTransaction) {
    throw new RangeError("The calldata envelope zero-byte count exceeds its byte length.");
  }

  let payloadZeroByteCount = 0;
  for (const byte of input.bytes) {
    if (byte === 0) payloadZeroByteCount += 1;
  }
  const payloadNonZeroByteCount = input.bytes.byteLength - payloadZeroByteCount;
  const zeroByteCount = payloadZeroByteCount
    + envelopeZeroByteCountPerTransaction * transactionCount;
  const nonZeroByteCount = payloadNonZeroByteCount
    + (envelopeByteLengthPerTransaction - envelopeZeroByteCountPerTransaction) * transactionCount;
  const transactionBaseGas = transactionCount * ETHEREUM_TRANSACTION_BASE_GAS;
  const calldataByteGas = zeroByteCount * ETHEREUM_ZERO_CALLDATA_BYTE_GAS
    + nonZeroByteCount * ETHEREUM_NONZERO_CALLDATA_BYTE_GAS;

  return Object.freeze({
    transactionCount,
    payloadByteLength: input.bytes.byteLength,
    envelopeByteLength: envelopeByteLengthPerTransaction * transactionCount,
    zeroByteCount,
    nonZeroByteCount,
    transactionBaseGas,
    calldataByteGas,
    calldataIntrinsicGas: transactionBaseGas + calldataByteGas,
  });
}

/** Maximum executor lock at the selected chain gas price. No hidden multiplier. */
export function executorEscrowWei(maximumExecutorGas: number | bigint, selectedGasPriceWei: bigint): bigint {
  const gas = typeof maximumExecutorGas === "bigint"
    ? maximumExecutorGas
    : BigInt(nonNegativeSafeInteger(maximumExecutorGas, "maximum executor gas"));
  if (gas < 0n) throw new RangeError("The maximum executor gas must be non-negative.");
  if (selectedGasPriceWei < 0n) throw new RangeError("The selected gas price must be non-negative.");
  return gas * selectedGasPriceWei;
}

export function actualEthereumTransactionFeeWei(gasUsed: bigint, effectiveGasPriceWei: bigint): bigint {
  if (gasUsed < 0n || effectiveGasPriceWei < 0n) {
    throw new RangeError("Transaction gas and price must be non-negative.");
  }
  return gasUsed * effectiveGasPriceWei;
}

export interface KeelCalldataGasEstimate {
  readonly carrierCount: number;
  readonly payloadByteLength: number;
  readonly envelopeByteLength: number;
  readonly zeroByteCount: number;
  readonly nonZeroByteCount: number;
  readonly transactionBaseGas: number;
  readonly calldataGas: number;
  readonly totalIntrinsicGas: number;
}

export interface KeelGasSavingsEstimate {
  readonly baselineGas: number;
  readonly candidateGas: number;
  readonly savedGas: number;
  readonly savedPercent: number;
}

/** Intrinsic gas for immutable bytes carried directly in transaction input. */
export function estimateKeelCalldataGas(input: {
  readonly bytes: Uint8Array;
  readonly carrierCount?: number;
  readonly envelopeByteLength?: number;
  readonly envelopeZeroByteCount?: number;
}): KeelCalldataGasEstimate {
  const carrierCount = input.carrierCount ?? 1;
  const envelopeByteLength = input.envelopeByteLength ?? 0;
  const envelopeZeroByteCount = input.envelopeZeroByteCount ?? 0;
  const estimate = estimateEthereumCalldataIntrinsicGas({
    bytes: input.bytes,
    transactionCount: carrierCount,
    envelopeByteLengthPerTransaction: envelopeByteLength,
    envelopeZeroByteCountPerTransaction: envelopeZeroByteCount,
  });
  return Object.freeze({
    carrierCount,
    payloadByteLength: input.bytes.byteLength,
    envelopeByteLength: estimate.envelopeByteLength,
    zeroByteCount: estimate.zeroByteCount,
    nonZeroByteCount: estimate.nonZeroByteCount,
    transactionBaseGas: estimate.transactionBaseGas,
    calldataGas: estimate.calldataByteGas,
    totalIntrinsicGas: estimate.calldataIntrinsicGas,
  });
}

export function compareKeelGas(baselineGas: number, candidateGas: number): KeelGasSavingsEstimate {
  const baseline = nonNegativeSafeInteger(baselineGas, "baseline gas");
  const candidate = nonNegativeSafeInteger(candidateGas, "candidate gas");
  return Object.freeze({
    baselineGas: baseline,
    candidateGas: candidate,
    savedGas: baseline - candidate,
    savedPercent: baseline === 0 ? 0 : ((baseline - candidate) / baseline) * 100,
  });
}

export function fitsSingleKeelCalldataCarrier(input: {
  readonly bytes: Uint8Array;
  readonly gasLimit: number;
  readonly envelopeByteLength?: number;
  readonly envelopeZeroByteCount?: number;
}): boolean {
  const gasLimit = nonNegativeSafeInteger(input.gasLimit, "calldata carrier gas limit");
  return estimateKeelCalldataGas({
    bytes: input.bytes,
    ...(input.envelopeByteLength === undefined ? {} : { envelopeByteLength: input.envelopeByteLength }),
    ...(input.envelopeZeroByteCount === undefined ? {} : { envelopeZeroByteCount: input.envelopeZeroByteCount }),
  }).totalIntrinsicGas <= gasLimit;
}

export interface KeelPublicationJobOperation {
  readonly target: Address;
  readonly value?: bigint;
  readonly data: Hex;
}

export interface KeelPublicationJobManifest {
  readonly planDigest: Hex;
  readonly storageMode: KeelPublicationStorageMode;
  readonly objectCommitmentDigest?: Hex;
  readonly chunkDigests: readonly Hex[];
  readonly operationDigests: readonly Hex[];
  readonly allowedTargets: readonly Address[];
  readonly batchDigests: readonly Hex[];
  readonly carrierBatches: readonly (readonly Hex[])[];
  readonly operations: readonly KeelPublicationJobOperation[];
}

/** Builds the small immutable commitment used by the one wallet approval. */
export function buildKeelPublicationJobManifest(input: {
  readonly owner: Address;
  readonly executor: Address;
  readonly deadline: bigint;
  /** Omitted only for compatibility with the original native job wire format. */
  readonly storageMode?: KeelPublicationStorageMode;
  readonly objectCommitmentDigest?: Hex;
  /** Batch-level commitments bind history offsets and ordering in the plan. */
  readonly batchDigests?: readonly Hex[];
  /** History mode supplies the contract's SHA-256 chunk commitments explicitly. */
  readonly chunkDigests?: readonly Hex[];
  readonly carrierBatches: readonly (readonly Hex[])[];
  readonly operations: readonly KeelPublicationJobOperation[];
}): KeelPublicationJobManifest {
  if (input.deadline <= 0n || input.deadline > (1n << 64n) - 1n) {
    throw new RangeError("The KEEL managed job deadline is invalid.");
  }
  for (const batch of input.carrierBatches) {
    if (batch.length === 0 || batch.length > KEEL_NATIVE_CHUNKS_PER_TRANSACTION) {
      throw new RangeError("A KEEL carrier batch must contain one through three chunks.");
    }
  }
  const payloads = input.carrierBatches.flat();
  if (payloads.length === 0 && input.operations.length === 0) {
    throw new Error("A KEEL publication job must contain a carrier or operation.");
  }
  const storageMode = selectKeelPublicationStorageMode(input.storageMode);
  const objectCommitmentDigest = input.objectCommitmentDigest;
  if (objectCommitmentDigest !== undefined && !isBytes32(objectCommitmentDigest)) {
    throw new TypeError("The KEEL object commitment digest must be a bytes32 value.");
  }
  const batchDigests = input.batchDigests === undefined
    ? []
    : input.batchDigests.map((batchDigest) => {
      if (!isBytes32(batchDigest)) throw new TypeError("A KEEL batch digest must be a bytes32 value.");
      return batchDigest;
    });
  if (batchDigests.length > 0 && batchDigests.length !== input.carrierBatches.length) {
    throw new RangeError("The KEEL batch digest count must match the carrier batch count.");
  }
  const chunkDigests = input.chunkDigests === undefined
    ? payloads.map((payload) => keccak256(payload))
    : input.chunkDigests.map((digest) => {
      if (!isBytes32(digest)) throw new TypeError("A KEEL chunk digest must be a bytes32 value.");
      return digest;
    });
  if (chunkDigests.length !== payloads.length) throw new RangeError("The KEEL chunk digest count must match the payload count.");
  const operationDigests = input.operations.map(({ target, value = 0n, data }) => keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [target, value, data],
    ),
  ));
  const allowedTargets = [...new Map(input.operations.map(({ target }) => [target.toLowerCase(), target])).values()];
  // The original native route keeps its deployed wire digest exactly. New
  // versioned routes append explicit mode/commitment/batch evidence, so a
  // history plan can never collide with a native job or silently downgrade.
  const versioned = input.storageMode !== undefined
    || objectCommitmentDigest !== undefined
    || batchDigests.length > 0;
  const planDigest = versioned
    ? keccak256(encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32[]" },
        { type: "bytes32[]" },
        { type: "address[]" },
        { type: "bytes32[]" },
      ],
      [
        keccak256(stringToHex(KEEL_PUBLICATION_JOB_WIRE_DOMAIN)),
        input.owner,
        input.executor,
        input.deadline,
        keccak256(stringToHex(storageMode)),
        objectCommitmentDigest ?? keccak256(stringToHex("keel.object-commitment.none")),
        chunkDigests,
        operationDigests,
        allowedTargets,
        batchDigests,
      ],
    ))
    : keccak256(encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "bytes32[]" },
        { type: "bytes32[]" },
        { type: "address[]" },
      ],
      [
        keccak256(stringToHex(KEEL_PUBLICATION_JOB_WIRE_DOMAIN)),
        input.owner,
        input.executor,
        input.deadline,
        chunkDigests,
        operationDigests,
        allowedTargets,
      ],
    ));
  return Object.freeze({
    planDigest,
    storageMode,
    ...(objectCommitmentDigest === undefined ? {} : { objectCommitmentDigest }),
    chunkDigests: Object.freeze(chunkDigests),
    operationDigests: Object.freeze(operationDigests),
    allowedTargets: Object.freeze(allowedTargets),
    batchDigests: Object.freeze(batchDigests),
    carrierBatches: Object.freeze(input.carrierBatches.map((batch) => Object.freeze([...batch]))),
    operations: Object.freeze(input.operations.map((operation) => Object.freeze({ ...operation }))),
  });
}

/** Receipt evidence wins over a stale saved job id; ambiguity fails closed. */
export function selectResumableKeelJobId(input: {
  readonly savedJobId?: string;
  readonly confirmedJobIds: readonly bigint[];
}): bigint | undefined {
  const savedJobId = input.savedJobId === undefined
    ? undefined
    : /^(0|[1-9]\d*)$/u.test(input.savedJobId)
      ? BigInt(input.savedJobId)
      : (() => { throw new Error("The saved KEEL publication job id is invalid. No new wallet approval was requested."); })();
  const confirmed = [...new Set(input.confirmedJobIds.map((jobId) => jobId.toString()))].map(BigInt);
  if (confirmed.length === 0) return savedJobId;
  if (savedJobId !== undefined && confirmed.some((jobId) => jobId === savedJobId)) return savedJobId;
  if (confirmed.length === 1) return confirmed[0];
  throw new Error("The saved KEEL publication receipts are ambiguous. No new wallet approval was requested.");
}

export interface KeelCarrierDispatch {
  readonly batchIndex: number;
  readonly firstChunk: number;
  readonly lastChunkExclusive: number;
  readonly payloads: readonly Hex[];
  readonly nonce: number;
}

/** Bounded executor wave beginning exactly at the contract's confirmed cursor. */
export function buildKeelCarrierDispatchPlan(input: {
  readonly batches: readonly (readonly Hex[])[];
  readonly nextChunk: number;
  readonly startingNonce: number;
  readonly maximumTransactions?: number;
}): readonly KeelCarrierDispatch[] {
  const nextChunk = nonNegativeSafeInteger(input.nextChunk, "KEEL carrier cursor");
  const startingNonce = nonNegativeSafeInteger(input.startingNonce, "KEEL executor nonce");
  const maximumTransactions = positiveSafeInteger(
    input.maximumTransactions ?? MAX_KEEL_CARRIER_TRANSACTIONS_PER_WAVE,
    "maximum carrier transactions per wave",
  );
  const totalChunks = input.batches.reduce((total, batch) => total + batch.length, 0);
  if (nextChunk > totalChunks) throw new RangeError("The KEEL carrier cursor exceeds the publication plan.");
  const dispatches: KeelCarrierDispatch[] = [];
  let batchOffset = 0;
  for (let batchIndex = 0; batchIndex < input.batches.length; batchIndex += 1) {
    const batch = input.batches[batchIndex] ?? [];
    if (batch.length === 0 || batch.length > KEEL_NATIVE_CHUNKS_PER_TRANSACTION) {
      throw new RangeError("The KEEL publication plan contains an invalid carrier batch.");
    }
    const batchEnd = batchOffset + batch.length;
    const startInBatch = Math.max(0, nextChunk - batchOffset);
    const payloads = batch.slice(startInBatch);
    if (payloads.length > 0) {
      dispatches.push(Object.freeze({
        batchIndex,
        firstChunk: batchOffset + startInBatch,
        lastChunkExclusive: batchEnd,
        payloads: Object.freeze([...payloads]),
        nonce: startingNonce + dispatches.length,
      }));
    }
    if (dispatches.length >= maximumTransactions) break;
    batchOffset = batchEnd;
  }
  return Object.freeze(dispatches);
}

export interface KeelPublicationOperationBatchBase {
  /** Absolute operation cursor at the start of this executor transaction. */
  readonly firstOperation: number;
  /** Absolute operation cursor immediately after this executor transaction. */
  readonly lastOperationExclusive: number;
  readonly batchIndex: number;
  readonly nonce: number;
  readonly operations: readonly KeelPublicationJobOperation[];
  readonly targets: readonly Address[];
  readonly values: readonly bigint[];
  /** Contract argument name used by `executeOperations`. */
  readonly operationData: readonly Hex[];
}

/** A packed operation transaction supported by the v2 publication job. */
export interface KeelPublicationPackedOperationBatch extends KeelPublicationOperationBatchBase {
  readonly route: "packed-v2";
  readonly method: "executeOperations";
}

/** One-operation transaction for a v1 publication job without packing. */
export interface KeelPublicationSingleOperationBatch extends KeelPublicationOperationBatchBase {
  readonly route: "single-v1";
  readonly method: "executeOperation";
}

export type KeelPublicationOperationBatch =
  | KeelPublicationPackedOperationBatch
  | KeelPublicationSingleOperationBatch;

/**
 * Builds a bounded executor wave beginning exactly at `nextOperation`.
 *
 * The route is explicit: `packed-v2` uses the atomic four-operation contract
 * entrypoint, while `single-v1` emits one operation per transaction for older
 * deployments. The SDK never probes a deployment or silently downgrades a
 * packed plan. Every returned batch starts at the previous batch's confirmed
 * cursor, so a caller can persist and resume the same range after a timeout.
 */
export function buildKeelPublicationOperationBatches(input: {
  readonly operations: readonly KeelPublicationJobOperation[];
  readonly nextOperation: number;
  readonly startingNonce: number;
  readonly route?: KeelPublicationOperationRoute;
  /** Maximum executor transactions in this wave; it does not alter cursors. */
  readonly maximumTransactions?: number;
  /** Packed v2 only; values above the contract maximum are rejected. */
  readonly maximumOperationsPerTransaction?: number;
}): readonly KeelPublicationOperationBatch[] {
  const nextOperation = nonNegativeSafeInteger(input.nextOperation, "KEEL operation cursor");
  const startingNonce = nonNegativeSafeInteger(input.startingNonce, "KEEL executor nonce");
  const route = selectKeelPublicationOperationRoute(input.route);
  const maximumTransactions = positiveSafeInteger(
    input.maximumTransactions ?? MAX_KEEL_CARRIER_TRANSACTIONS_PER_WAVE,
    "maximum operation transactions per wave",
  );
  const requestedBatchSize = positiveSafeInteger(
    input.maximumOperationsPerTransaction ?? KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH,
    "maximum operations per transaction",
  );
  if (requestedBatchSize > KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH) {
    throw new RangeError(`A packed KEEL operation batch cannot exceed ${KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH} operations.`);
  }
  if (!Array.isArray(input.operations)) throw new TypeError("KEEL publication operations must be an array.");
  if (nextOperation > input.operations.length) {
    throw new RangeError("The KEEL operation cursor exceeds the publication plan.");
  }

  // Validate and snapshot caller-owned operation records before exposing any
  // arrays to an async executor. Missing values have the contract's zero value.
  const operations = input.operations.map((operation, index) => snapshotKeelPublicationOperation(operation, index));
  const batchSize = route === "packed-v2" ? requestedBatchSize : 1;
  const batches: KeelPublicationOperationBatch[] = [];
  let cursor = nextOperation;
  while (cursor < operations.length && batches.length < maximumTransactions) {
    const end = Math.min(cursor + batchSize, operations.length);
    const batchOperations = operations.slice(cursor, end);
    const targets = batchOperations.map((operation) => operation.target);
    const values = batchOperations.map((operation) => operation.value ?? 0n);
    const operationData = batchOperations.map((operation) => operation.data);
    const common = {
      batchIndex: Math.floor(cursor / batchSize),
      firstOperation: cursor,
      lastOperationExclusive: end,
      nonce: startingNonce + batches.length,
      operations: Object.freeze(batchOperations),
      targets: Object.freeze(targets),
      values: Object.freeze(values),
      operationData: Object.freeze(operationData),
    } as const;
    batches.push(Object.freeze(route === "packed-v2"
      ? { ...common, route, method: "executeOperations" as const }
      : { ...common, route, method: "executeOperation" as const }));
    cursor = end;
  }
  return Object.freeze(batches);
}

/** Exact calldata for one managed publication operation batch; no RPC or
 * wallet action is performed. The job ID is read-only recovery state supplied
 * by the caller after the one-time openJob receipt is reconciled. */
export function encodeKeelPublicationOperationBatch(input: {
  readonly jobId: bigint;
  readonly batch: KeelPublicationOperationBatch;
}): Hex {
  if (typeof input.jobId !== "bigint" || input.jobId < 0n) {
    throw new RangeError("The KEEL publication job ID must be a non-negative bigint.");
  }
  const { batch } = input;
  if (batch.firstOperation < 0 || batch.lastOperationExclusive !== batch.firstOperation + batch.operations.length) {
    throw new RangeError("The KEEL operation batch cursor range is not contiguous.");
  }
  if (batch.operations.length === 0 || batch.operations.length !== batch.targets.length
    || batch.operations.length !== batch.values.length || batch.operations.length !== batch.operationData.length) {
    throw new RangeError("The KEEL operation batch arrays are inconsistent.");
  }
  if (batch.route === "packed-v2") {
    if (batch.operations.length > KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH) {
      throw new RangeError(`A packed KEEL operation batch cannot exceed ${KEEL_PUBLICATION_JOB_MAX_OPERATION_BATCH} operations.`);
    }
    return encodeFunctionData({
      abi: KEEL_PUBLICATION_JOB_OPERATION_ABI,
      functionName: "executeOperations",
      args: [input.jobId, batch.targets, batch.values, batch.operationData],
    });
  }
  if (batch.operations.length !== 1) {
    throw new RangeError("A v1 KEEL operation batch must contain exactly one operation.");
  }
  return encodeFunctionData({
    abi: KEEL_PUBLICATION_JOB_OPERATION_ABI,
    functionName: "executeOperation",
    args: [input.jobId, batch.targets[0] as Address, batch.values[0] as bigint, batch.operationData[0] as Hex],
  });
}

/** Resolve the operation ABI route without inspecting chain state. */
export function selectKeelPublicationOperationRoute(value?: unknown): KeelPublicationOperationRoute {
  if (value === undefined || value === "packed-v2") return "packed-v2";
  if (value === "single-v1") return value;
  throw new TypeError(`Unsupported KEEL publication operation route: ${String(value)}.`);
}

export interface KeelSubmittedTransactionReceipt {
  readonly transactionHash: Hex;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}

export type KeelReceiptReconciliation =
  | { readonly status: "pending"; readonly transactionHash: Hex }
  | { readonly status: "confirmed"; readonly transactionHash: Hex; readonly blockNumber: bigint; readonly actualTransactionFeeWei: bigint }
  | { readonly status: "reverted"; readonly transactionHash: Hex; readonly blockNumber: bigint; readonly actualTransactionFeeWei: bigint };

/** A timeout is pending evidence, never permission to resubmit the same work. */
export function reconcileKeelSubmittedTransaction(input: {
  readonly transactionHash: Hex;
  readonly receipt?: KeelSubmittedTransactionReceipt;
}): KeelReceiptReconciliation {
  if (!/^0x[0-9a-f]{64}$/iu.test(input.transactionHash)) throw new TypeError("The KEEL transaction hash is invalid.");
  if (input.receipt === undefined) return Object.freeze({ status: "pending", transactionHash: input.transactionHash });
  if (input.receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
    throw new Error("The KEEL receipt does not belong to the submitted transaction.");
  }
  if (input.receipt.blockNumber < 0n || input.receipt.gasUsed < 0n || input.receipt.effectiveGasPrice < 0n) {
    throw new RangeError("The KEEL receipt contains invalid gas or block values.");
  }
  return Object.freeze({
    status: input.receipt.status === "success" ? "confirmed" : "reverted",
    transactionHash: input.receipt.transactionHash,
    blockNumber: input.receipt.blockNumber,
    actualTransactionFeeWei: actualEthereumTransactionFeeWei(
      input.receipt.gasUsed,
      input.receipt.effectiveGasPrice,
    ),
  });
}

export interface KeelManagedPublicationJob {
  readonly jobId: bigint;
  readonly owner: string;
  readonly executor: string;
  readonly planDigest: string;
  readonly chunkCount: number;
  readonly operationCount: number;
  readonly nextChunk: number;
  readonly nextOperation: number;
  readonly deadline: bigint;
  readonly open: boolean;
}

export interface KeelManagedPublicationCarrierIdentity extends KeelManagedPublicationJob {
  /** Digest of the operation that creates the immutable content object. */
  readonly immutableOperationDigest: string;
}

/** Finds older matching carrier plans whose confirmed cursor must not replay. */
export function findKeelCarrierReplayBlockers(input: {
  readonly selected: KeelManagedPublicationCarrierIdentity;
  readonly candidates: readonly KeelManagedPublicationCarrierIdentity[];
}): readonly KeelManagedPublicationCarrierIdentity[] {
  return Object.freeze(input.candidates
    .filter((candidate) =>
      candidate.jobId !== input.selected.jobId
      && candidate.owner.toLowerCase() === input.selected.owner.toLowerCase()
      && candidate.executor.toLowerCase() === input.selected.executor.toLowerCase()
      && candidate.chunkCount === input.selected.chunkCount
      && candidate.immutableOperationDigest.toLowerCase() === input.selected.immutableOperationDigest.toLowerCase()
      && candidate.nextChunk > input.selected.nextChunk,
    )
    .sort((left, right) => right.nextChunk - left.nextChunk || compareBigInt(left.jobId, right.jobId)));
}

export interface KeelExpectedJobPlanDigest {
  readonly jobId: bigint;
  readonly planDigest: string;
}

interface KeelJobProgress {
  readonly job: KeelManagedPublicationJob;
  readonly completedChunks: number;
  readonly completedOperations: number;
}

export type KeelManagedPublicationSelection =
  | ({ readonly status: "selected" } & KeelJobProgress)
  | ({ readonly status: "complete" } & KeelJobProgress)
  | ({ readonly status: "expired" } & KeelJobProgress)
  | { readonly status: "none" }
  | { readonly status: "ambiguous"; readonly jobIds: readonly bigint[] }
  | { readonly status: "invalid"; readonly jobIds: readonly bigint[] };

/**
 * Selects an existing logical operation without using job recency as identity.
 * The caller supplies plan digests recomputed for each scanned job because old
 * deployed manifests bind their deadline into the digest.
 */
export function selectKeelManagedPublicationJob(input: {
  readonly candidates: readonly KeelManagedPublicationJob[];
  readonly owner: string;
  readonly executor: string;
  readonly chunkCount: number;
  readonly operationCount: number;
  readonly expectedPlanDigests: readonly KeelExpectedJobPlanDigest[];
  readonly evidenceJobIds: readonly bigint[];
  readonly chainTimestamp: bigint;
}): KeelManagedPublicationSelection {
  const expectedChunkCount = nonNegativeSafeInteger(input.chunkCount, "chunk count");
  const expectedOperationCount = nonNegativeSafeInteger(input.operationCount, "operation count");
  const expectedDigests = new Map(
    input.expectedPlanDigests.map((entry) => [entry.jobId.toString(), entry.planDigest.toLowerCase()]),
  );
  const matched = input.candidates.filter((candidate) =>
    candidate.owner.toLowerCase() === input.owner.toLowerCase()
    && candidate.executor.toLowerCase() === input.executor.toLowerCase()
    && candidate.chunkCount === expectedChunkCount
    && candidate.operationCount === expectedOperationCount
    && candidate.planDigest.toLowerCase() === expectedDigests.get(candidate.jobId.toString()),
  );
  if (matched.length === 0) return Object.freeze({ status: "none" });

  const invalid = matched.filter((candidate) =>
    !validCursor(candidate.nextChunk, expectedChunkCount)
    || !validCursor(candidate.nextOperation, expectedOperationCount)
    || (candidate.nextOperation > 0 && candidate.nextChunk !== expectedChunkCount)
    || (!candidate.open
      && (candidate.nextChunk !== expectedChunkCount || candidate.nextOperation !== expectedOperationCount)),
  );
  if (invalid.length > 0) {
    return Object.freeze({
      status: "invalid",
      jobIds: Object.freeze(invalid.map((candidate) => candidate.jobId).sort(compareBigInt)),
    });
  }

  /* Progress wins before recency or deadline. A fresh duplicate at cursor zero
     must never make the executor replay chunks already confirmed by an older
     matching job. An advanced expired job therefore blocks safely. */
  const leader = selectProgress("selected", matched, input.evidenceJobIds, input.chainTimestamp);
  if (leader.status === "ambiguous") return leader;
  if (leader.status !== "selected") return Object.freeze({ status: "none" });
  if (!leader.job.open) return Object.freeze({ ...leader, status: "complete" });
  if (leader.job.deadline < input.chainTimestamp) return Object.freeze({ ...leader, status: "expired" });
  return leader;
}

export interface KeelPublicationRecovery {
  readonly jobId?: string;
  readonly completedChunks: number;
  readonly completedOperations: number;
  readonly failedChunkIndexes: readonly number[];
  readonly failedOperationIndexes: readonly number[];
  readonly transactionHashes: readonly string[];
}

export interface KeelPublicationCheckpoint {
  readonly storageMode: KeelPublicationStorageMode | KeelLegacyNativeStorageMode;
  readonly jobPlanDigest: string;
  readonly totalChunks: number;
  readonly completedChunks: number;
  readonly totalOperations: number;
  readonly completedOperations: number;
  readonly failedChunkIndexes: readonly number[];
  readonly failedOperationIndexes: readonly number[];
  readonly actualTransactionFeeWei?: string | undefined;
}

export function isKeelPublicationCheckpoint(value: unknown): value is KeelPublicationCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const counts = [candidate.totalChunks, candidate.completedChunks, candidate.totalOperations, candidate.completedOperations];
  // Accept the old native journal spelling only for recovery compatibility.
  // New planners never emit it, and calldata/hybrid are deliberately rejected
  // because they have no unambiguous protocol semantics.
  if (![...KEEL_PUBLICATION_STORAGE_MODES, "native"].includes(String(candidate.storageMode) as never)) return false;
  if (typeof candidate.jobPlanDigest !== "string" || !/^0x[0-9a-f]{64}$/iu.test(candidate.jobPlanDigest)) return false;
  if (!validCheckpointCounts(counts)) return false;
  const [totalChunks, completedChunks, totalOperations, completedOperations] = counts;
  if (completedChunks > totalChunks || completedOperations > totalOperations) return false;
  if (!validFailedIndexes(candidate.failedChunkIndexes, totalChunks)) return false;
  if (!validFailedIndexes(candidate.failedOperationIndexes, totalOperations)) return false;
  return candidate.actualTransactionFeeWei === undefined
    || (typeof candidate.actualTransactionFeeWei === "string" && /^(0|[1-9]\d*)$/u.test(candidate.actualTransactionFeeWei));
}

/** Monotonic merge for one immutable job plan. Identity mismatches fail closed. */
export function mergeKeelPublicationCheckpoints(
  current: KeelPublicationCheckpoint | undefined,
  incoming: KeelPublicationCheckpoint,
  preferIncoming = true,
): KeelPublicationCheckpoint {
  if (current === undefined) return Object.freeze(incoming);
  if (canonicalCheckpointStorageMode(current.storageMode) !== canonicalCheckpointStorageMode(incoming.storageMode)
    || current.jobPlanDigest.toLowerCase() !== incoming.jobPlanDigest.toLowerCase()) {
    throw new Error("KEEL publication checkpoints identify different immutable job plans.");
  }
  const preferred = preferIncoming ? incoming : current;
  const actualTransactionFeeWei = maximumDecimalValue(
    current.actualTransactionFeeWei,
    incoming.actualTransactionFeeWei,
  );
  return Object.freeze({
    ...preferred,
    totalChunks: Math.max(current.totalChunks, incoming.totalChunks),
    completedChunks: Math.max(current.completedChunks, incoming.completedChunks),
    totalOperations: Math.max(current.totalOperations, incoming.totalOperations),
    completedOperations: Math.max(current.completedOperations, incoming.completedOperations),
    failedChunkIndexes: mergeNumbers(current.failedChunkIndexes, incoming.failedChunkIndexes),
    failedOperationIndexes: mergeNumbers(current.failedOperationIndexes, incoming.failedOperationIndexes),
    ...(actualTransactionFeeWei === undefined ? {} : { actualTransactionFeeWei }),
  });
}

/** Monotonic recovery merge: stale clients cannot erase progress, IDs, or receipts. */
export function mergeKeelPublicationRecovery(
  current: KeelPublicationRecovery | undefined,
  incoming: KeelPublicationRecovery,
): KeelPublicationRecovery {
  const jobId = maximumDecimalId(current?.jobId, incoming.jobId);
  const merged = {
    ...(jobId === undefined ? {} : { jobId }),
    completedChunks: Math.max(current?.completedChunks ?? 0, incoming.completedChunks),
    completedOperations: Math.max(current?.completedOperations ?? 0, incoming.completedOperations),
    failedChunkIndexes: mergeNumbers(current?.failedChunkIndexes ?? [], incoming.failedChunkIndexes),
    failedOperationIndexes: mergeNumbers(current?.failedOperationIndexes ?? [], incoming.failedOperationIndexes),
    transactionHashes: mergeHashes(current?.transactionHashes ?? [], incoming.transactionHashes),
  } satisfies KeelPublicationRecovery;
  return Object.freeze(merged);
}

export function normalizeFailedIndexes(indexes: readonly number[], upperBound: number): readonly number[] {
  const bound = nonNegativeSafeInteger(upperBound, "failed-index upper bound");
  return Object.freeze([...new Set(indexes.filter((index) =>
    Number.isSafeInteger(index) && index >= 0 && index < bound,
  ))].sort((left, right) => left - right));
}

function selectProgress(
  status: "selected" | "complete" | "expired",
  candidates: readonly KeelManagedPublicationJob[],
  evidenceJobIds: readonly bigint[],
  chainTimestamp?: bigint,
): KeelManagedPublicationSelection {
  const maximumChunk = Math.max(...candidates.map((candidate) => candidate.nextChunk));
  const chunkLeaders = candidates.filter((candidate) => candidate.nextChunk === maximumChunk);
  const maximumOperation = Math.max(...chunkLeaders.map((candidate) => candidate.nextOperation));
  const progressLeaders = chunkLeaders.filter((candidate) => candidate.nextOperation === maximumOperation);
  const completedLeaders = progressLeaders.filter((candidate) => !candidate.open);
  const activeLeaders = chainTimestamp === undefined
    ? []
    : progressLeaders.filter((candidate) => candidate.open && candidate.deadline >= chainTimestamp);
  const leaders = completedLeaders.length > 0
    ? completedLeaders
    : activeLeaders.length > 0
      ? activeLeaders
      : progressLeaders;
  const evidence = new Set(evidenceJobIds.map((jobId) => jobId.toString()));
  const evidencedLeaders = leaders.filter((candidate) => evidence.has(candidate.jobId.toString()));
  const resolved = leaders.length === 1
    ? leaders[0]
    : evidencedLeaders.length === 1
      ? evidencedLeaders[0]
      : undefined;
  if (resolved === undefined) {
    return Object.freeze({
      status: "ambiguous",
      jobIds: Object.freeze(leaders.map((candidate) => candidate.jobId).sort(compareBigInt)),
    });
  }
  return Object.freeze({
    status,
    job: resolved,
    completedChunks: resolved.nextChunk,
    completedOperations: resolved.nextOperation,
  });
}

function maximumDecimalId(left: string | undefined, right: string | undefined): string | undefined {
  const values = [left, right].filter((value): value is string => value !== undefined);
  if (values.length === 0) return undefined;
  const parsed = values.map((value) => {
    if (!/^(0|[1-9]\d*)$/u.test(value)) throw new RangeError(`Invalid KEEL job id: ${value}`);
    return BigInt(value);
  });
  return parsed.reduce((maximum, value) => value > maximum ? value : maximum).toString();
}

function maximumDecimalValue(left: string | undefined, right: string | undefined): string | undefined {
  const values = [left, right].filter((value): value is string => value !== undefined);
  if (values.length === 0) return undefined;
  const parsed = values.map((value) => {
    if (!/^(0|[1-9]\d*)$/u.test(value)) throw new RangeError(`Invalid decimal value: ${value}`);
    return BigInt(value);
  });
  return parsed.reduce((maximum, value) => value > maximum ? value : maximum).toString();
}

function snapshotKeelPublicationOperation(
  operation: KeelPublicationJobOperation,
  index: number,
): KeelPublicationJobOperation {
  if (operation === null || typeof operation !== "object") {
    throw new TypeError(`KEEL publication operation ${index} is invalid.`);
  }
  if (!ADDRESS_PATTERN.test(operation.target)) {
    throw new TypeError(`KEEL publication operation ${index} target is not an Ethereum address.`);
  }
  if (operation.value !== undefined && (typeof operation.value !== "bigint" || operation.value < 0n)) {
    throw new RangeError(`KEEL publication operation ${index} value must be a non-negative bigint.`);
  }
  if (!HEX_BYTES_PATTERN.test(operation.data)) {
    throw new TypeError(`KEEL publication operation ${index} data is not valid hex bytes.`);
  }
  return Object.freeze({
    target: operation.target,
    ...(operation.value === undefined ? {} : { value: operation.value }),
    data: operation.data,
  });
}

function mergeNumbers(left: readonly number[], right: readonly number[]): readonly number[] {
  return Object.freeze([...new Set([...left, ...right])].sort((a, b) => a - b));
}

function mergeHashes(left: readonly string[], right: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hash of [...left, ...right]) {
    const key = hash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hash);
  }
  return Object.freeze(result);
}

function validCursor(value: number, upperBound: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= upperBound;
}

function validFailedIndexes(value: unknown, upperBound: number): boolean {
  return Array.isArray(value)
    && value.every((index) => Number.isSafeInteger(index) && index >= 0 && index < upperBound);
}

function validCheckpointCounts(values: unknown[]): values is [number, number, number, number] {
  return values.length === 4
    && values.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`The ${label} must be a positive integer.`);
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`The ${label} must be a non-negative integer.`);
  return value;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Selects exactly one versioned route. `undefined` is the only value that
 * selects native storage implicitly; unknown or legacy calldata names fail
 * closed instead of becoming an accidental fallback.
 */
export function selectKeelPublicationStorageMode(value?: unknown): KeelPublicationStorageMode {
  if (value === undefined) return KEEL_DEFAULT_PUBLICATION_STORAGE_MODE;
  if (value === KEEL_NATIVE_CARRIER_V1 || value === KEEL_HISTORY_INSCRIPTION_V1) return value;
  throw new TypeError(`Unsupported KEEL publication storage mode: ${String(value)}.`);
}

export const KEEL_OBJECT_COMMITMENT_PROTOCOL = "keel-object-commitment@1" as const;
export const KEEL_HISTORY_BATCH_COMMITMENT_PROTOCOL = "keel-history-batch@1" as const;
/** The history coordinator deliberately shares the native 23,000-byte bound. */
export const KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES = 23_000 as const;
export const KEEL_HISTORY_INSCRIPTION_CHUNKS_PER_BATCH = 3 as const;
export const KEEL_HISTORY_MAX_CHUNKS = 4096 as const;
export const KEEL_HISTORY_MAX_BATCHES = 4096 as const;
export const KEEL_EIP_7825_TRANSACTION_GAS_CAP = 16_777_216 as const;
export const ETHEREUM_EIP_7623_ZERO_CALLDATA_BYTE_GAS = 10 as const;
export const ETHEREUM_EIP_7623_NONZERO_CALLDATA_BYTE_GAS = 40 as const;
export const ETHEREUM_LOG_TOPIC_GAS = 375 as const;
export const ETHEREUM_LOG_DATA_BYTE_GAS = 8 as const;
/** Transparent quote assumptions for the experimental history route. */
export const KEEL_HISTORY_EVENT_TOPIC_COUNT = 4 as const;
/** Fixed ABI/event fields; each committed chunk adds one 32-byte digest. */
export const KEEL_HISTORY_EVENT_DATA_BYTES = 256 as const;
export const KEEL_HISTORY_BATCH_VALIDATION_GAS = 50_000 as const;
export const KEEL_HISTORY_COMMITMENT_STATE_GAS = 200_000 as const;
export const KEEL_HISTORY_EXECUTOR_CONTROL_GAS = 200_000 as const;
export const KEEL_HISTORY_INSCRIPTION_STORAGE_MODE = keccak256(stringToHex(KEEL_HISTORY_INSCRIPTION_V1));

export type KeelEip155ChainId = number | bigint;

const KEEL_OBJECT_COMMITMENT_DOMAIN = keccak256(stringToHex(KEEL_OBJECT_COMMITMENT_PROTOCOL));
const KEEL_HISTORY_BATCH_COMMITMENT_DOMAIN = keccak256(stringToHex(KEEL_HISTORY_BATCH_COMMITMENT_PROTOCOL));
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/iu;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/iu;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-f]{2})*$/iu;

const KEEL_PUBLICATION_JOB_OPERATION_ABI = [
  {
    type: "function",
    name: "executeOperations",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "operationData", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeOperation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "operation", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const KEEL_HISTORY_PUBLISH_BATCH_ABI = [{
  type: "function",
  name: "publishBatch",
  stateMutability: "nonpayable",
  inputs: [
    { name: "publicationId", type: "uint256" },
    { name: "storageMode", type: "bytes32" },
    { name: "planDigest", type: "bytes32" },
    { name: "batchIndex", type: "uint256" },
    { name: "firstChunkIndex", type: "uint256" },
    { name: "storedByteOffset", type: "uint256" },
    { name: "payloads", type: "bytes[]" },
  ],
  outputs: [],
}] as const;

const KEEL_HISTORY_OPEN_PUBLICATION_ABI = [{
  type: "function",
  name: "openPublication",
  stateMutability: "payable",
  inputs: [
    { name: "expectedPublicationId", type: "uint256" },
    { name: "storageMode", type: "bytes32" },
    { name: "executor", type: "address" },
    { name: "deadline", type: "uint64" },
    { name: "planDigest", type: "bytes32" },
    { name: "decodedDigest", type: "bytes32" },
    { name: "storedDigest", type: "bytes32" },
    { name: "decodedByteLength", type: "uint64" },
    { name: "storedByteLength", type: "uint64" },
    { name: "compression", type: "uint8" },
    { name: "mediaTypeHash", type: "bytes32" },
    { name: "chunkDigests", type: "bytes32[]" },
    { name: "batchChunkCounts", type: "uint8[]" },
  ],
  outputs: [{ name: "publicationId", type: "uint256" }],
}] as const;

export function computeKeelHistoryPublicationCommitmentDigest(input: {
  readonly chainId: KeelEip155ChainId;
  readonly coordinator: Address;
  readonly publicationId: bigint;
  /** The immutable Publication.initialExecutor, not a rotated current executor. */
  readonly owner: Address;
  readonly executor: Address;
  readonly planDigest: Hex;
  readonly decodedDigest: Hex;
  readonly storedDigest: Hex;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  /** Solidity's uint8 compression code: none=0, gzip=1, deflate=2, brotli=3. */
  readonly compression: number;
  readonly mediaTypeHash: Hex;
  readonly chunkDigests: readonly Hex[];
  readonly batchChunkCounts: readonly number[];
}): Hex {
  const chainId = normalizeKeelChainId(input.chainId);
  if (chainId <= 0n) throw new RangeError("History commitment chain ID must be positive.");
  if (!ADDRESS_PATTERN.test(input.coordinator)) {
    throw new TypeError("History commitment coordinator must be an Ethereum address.");
  }
  if (input.publicationId < 0n) throw new RangeError("The history publication ID cannot be negative.");
  if (!ADDRESS_PATTERN.test(input.owner) || !ADDRESS_PATTERN.test(input.executor)) {
    throw new TypeError("History commitment owner and executor must be Ethereum addresses.");
  }
  assertBytes32(input.planDigest, "history plan digest");
  assertBytes32(input.decodedDigest, "history decoded digest");
  assertBytes32(input.storedDigest, "history stored digest");
  const decodedByteLength = nonNegativeSafeInteger(input.decodedByteLength, "history decoded byte length");
  const storedByteLength = nonNegativeSafeInteger(input.storedByteLength, "history stored byte length");
  if (!Number.isSafeInteger(input.compression) || input.compression < 0 || input.compression > 3) {
    throw new RangeError("History commitment compression must be a uint8 code from zero through three.");
  }
  assertBytes32(input.mediaTypeHash, "history media type hash");
  input.chunkDigests.forEach((digest) => assertBytes32(digest, "history chunk digest"));
  input.batchChunkCounts.forEach((count) => {
    if (!Number.isSafeInteger(count) || count <= 0 || count > 3) throw new RangeError("History batch chunk counts must be one through three.");
  });
  if (input.batchChunkCounts.reduce((total, count) => total + count, 0) !== input.chunkDigests.length) {
    throw new RangeError("History batch chunk counts must equal the chunk digest count.");
  }
  return keccak256(encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "uint8" },
      { type: "bytes32" },
      { type: "bytes32[]" },
      { type: "uint8[]" },
    ],
    [
      chainId,
      input.coordinator,
      input.publicationId,
      input.owner,
      input.executor,
      KEEL_HISTORY_INSCRIPTION_STORAGE_MODE,
      input.planDigest,
      input.decodedDigest,
      input.storedDigest,
      BigInt(decodedByteLength),
      BigInt(storedByteLength),
      input.compression,
      input.mediaTypeHash,
      input.chunkDigests,
      input.batchChunkCounts,
    ],
  ));
}

export interface KeelObjectCommitment {
  readonly protocol: typeof KEEL_OBJECT_COMMITMENT_PROTOCOL;
  readonly storageMode: KeelPublicationStorageMode;
  /** History mode needs the chain and immutable initial authority fields because they are contract-bound. */
  readonly chainId?: KeelEip155ChainId;
  readonly coordinator?: Address;
  readonly publicationId?: bigint;
  readonly owner?: Address;
  /** This is the contract's immutable initialExecutor. */
  readonly executor?: Address;
  readonly planDigest?: Hex;
  readonly decodedDigest: Hex;
  readonly storedDigest: Hex;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly compression: Compression;
  /** Solidity uint8 representation retained for exact chain verification. */
  readonly compressionCode?: number;
  readonly mediaType: string;
  /** keccak256(UTF-8 mediaType), as committed by the history coordinator. */
  readonly mediaTypeHash?: Hex;
  readonly batchCount: number;
  readonly chunkCount: number;
  /** History mode retains the exact SHA-256 chunk manifest used by the coordinator. */
  readonly chunkDigests?: readonly Hex[];
  readonly batchChunkCounts?: readonly number[];
  /** Keccak commitment to the canonical fields above. */
  readonly commitmentDigest: Hex;
}

export function buildKeelObjectCommitment(input: {
  readonly storageMode: KeelPublicationStorageMode;
  readonly chainId?: KeelEip155ChainId;
  readonly coordinator?: Address;
  readonly publicationId?: bigint;
  readonly owner?: Address;
  readonly executor?: Address;
  readonly decodedDigest: Hex;
  readonly storedDigest: Hex;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly compression: Compression;
  readonly compressionCode?: number;
  readonly mediaType: string;
  readonly mediaTypeHash?: Hex;
  readonly batchCount: number;
  readonly chunkCount: number;
  readonly planDigest?: Hex;
  readonly chunkDigests?: readonly Hex[];
  readonly batchChunkCounts?: readonly number[];
}): KeelObjectCommitment {
  const storageMode = selectKeelPublicationStorageMode(input.storageMode);
  assertBytes32(input.decodedDigest, "decoded digest");
  assertBytes32(input.storedDigest, "stored digest");
  const decodedByteLength = nonNegativeSafeInteger(input.decodedByteLength, "decoded byte length");
  const storedByteLength = nonNegativeSafeInteger(input.storedByteLength, "stored byte length");
  const batchCount = nonNegativeSafeInteger(input.batchCount, "batch count");
  const chunkCount = nonNegativeSafeInteger(input.chunkCount, "chunk count");
  if (!isKeelCompression(input.compression)) throw new TypeError("The KEEL compression is unsupported.");
  if (typeof input.mediaType !== "string" || input.mediaType.length === 0 || input.mediaType.length > 512) {
    throw new RangeError("The KEEL media type must contain one through 512 characters.");
  }
  const chunkDigests = input.chunkDigests === undefined ? undefined : input.chunkDigests.map((digest) => {
    assertBytes32(digest, "object chunk digest");
    return digest;
  });
  const batchChunkCounts = input.batchChunkCounts === undefined ? undefined : input.batchChunkCounts.map((count) => positiveSafeInteger(count, "batch chunk count"));
  if (storageMode === KEEL_HISTORY_INSCRIPTION_V1) {
    if (input.chainId === undefined || input.coordinator === undefined || input.publicationId === undefined
      || input.owner === undefined || input.executor === undefined || input.planDigest === undefined
      || chunkDigests === undefined || batchChunkCounts === undefined) {
      throw new TypeError("History commitments require chain, coordinator, publication ID, owner, executor, plan digest, SHA-256 chunk digests, and batch chunk counts.");
    }
    normalizeKeelChainId(input.chainId);
    if (!ADDRESS_PATTERN.test(input.coordinator)) {
      throw new TypeError("History commitment coordinator must be an Ethereum address.");
    }
    if (input.publicationId < 0n) throw new RangeError("The history publication ID cannot be negative.");
    if (!ADDRESS_PATTERN.test(input.owner) || !ADDRESS_PATTERN.test(input.executor)) {
      throw new TypeError("History commitment owner and executor must be Ethereum addresses.");
    }
    if (input.mediaTypeHash === undefined) throw new TypeError("History commitments require a media type hash.");
    assertBytes32(input.mediaTypeHash, "history media type hash");
    const compressionCode = input.compressionCode ?? keelCompressionCode(input.compression);
    if (!Number.isSafeInteger(compressionCode) || compressionCode < 0 || compressionCode > 3) {
      throw new RangeError("History commitment compression must be a uint8 code from zero through three.");
    }
    if (chunkDigests.length !== chunkCount || batchChunkCounts.length !== batchCount || batchChunkCounts.reduce((total, count) => total + count, 0) !== chunkCount) {
      throw new RangeError("History commitment chunk and batch counts are inconsistent.");
    }
  } else if (input.chainId !== undefined || input.coordinator !== undefined || input.publicationId !== undefined
    || input.compressionCode !== undefined || input.mediaTypeHash !== undefined || input.owner !== undefined || input.executor !== undefined) {
    throw new TypeError("Native commitments do not accept history-only chain fields.");
  }
  const historyChunkDigests = chunkDigests as readonly Hex[] | undefined;
  const historyBatchChunkCounts = batchChunkCounts as readonly number[] | undefined;
  const compressionCode = input.compressionCode ?? keelCompressionCode(input.compression);
  const mediaTypeHash = input.mediaTypeHash ?? keccak256(stringToHex(input.mediaType));
  const commitmentDigest = storageMode === KEEL_HISTORY_INSCRIPTION_V1
    ? computeKeelHistoryPublicationCommitmentDigest({
      owner: input.owner as Address,
      executor: input.executor as Address,
      chainId: input.chainId as KeelEip155ChainId,
      coordinator: input.coordinator as Address,
      publicationId: input.publicationId as bigint,
      planDigest: input.planDigest as Hex,
      decodedDigest: input.decodedDigest,
      storedDigest: input.storedDigest,
      decodedByteLength,
      storedByteLength,
      compression: compressionCode,
      mediaTypeHash: mediaTypeHash as Hex,
      chunkDigests: historyChunkDigests as readonly Hex[],
      batchChunkCounts: historyBatchChunkCounts as readonly number[],
    })
    : keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint32" },
      { type: "uint32" },
    ],
    [
      KEEL_OBJECT_COMMITMENT_DOMAIN,
      keccak256(stringToHex(storageMode)),
      input.decodedDigest,
      input.storedDigest,
      BigInt(decodedByteLength),
      BigInt(storedByteLength),
      keccak256(stringToHex(input.compression)),
      keccak256(stringToHex(input.mediaType)),
      batchCount,
      chunkCount,
    ],
    ));
  return Object.freeze({
    protocol: KEEL_OBJECT_COMMITMENT_PROTOCOL,
    storageMode,
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
    ...(input.coordinator === undefined ? {} : { coordinator: input.coordinator }),
    ...(input.publicationId === undefined ? {} : { publicationId: input.publicationId }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.executor === undefined ? {} : { executor: input.executor }),
    ...(input.planDigest === undefined ? {} : { planDigest: input.planDigest }),
    decodedDigest: input.decodedDigest,
    storedDigest: input.storedDigest,
    decodedByteLength,
    storedByteLength,
    compression: input.compression,
    ...(storageMode === KEEL_HISTORY_INSCRIPTION_V1 ? { compressionCode } : {}),
    mediaType: input.mediaType,
    ...(storageMode === KEEL_HISTORY_INSCRIPTION_V1 ? { mediaTypeHash } : {}),
    batchCount,
    chunkCount,
    ...(historyChunkDigests === undefined ? {} : { chunkDigests: Object.freeze(historyChunkDigests) }),
    ...(historyBatchChunkCounts === undefined ? {} : { batchChunkCounts: Object.freeze(historyBatchChunkCounts) }),
    commitmentDigest,
  });
}

export function verifyKeelObjectCommitment(commitment: KeelObjectCommitment): boolean {
  if (commitment.protocol !== KEEL_OBJECT_COMMITMENT_PROTOCOL) return false;
  try {
    return buildKeelObjectCommitment(commitment).commitmentDigest.toLowerCase() === commitment.commitmentDigest.toLowerCase();
  } catch {
    return false;
  }
}

export interface KeelHistoryInscriptionBatch {
  readonly batchIndex: number;
  readonly firstChunkIndex: number;
  readonly orderedChunkCount: number;
  readonly storedByteOffset: number;
  readonly storedByteLength: number;
  readonly chunkDigests: readonly Hex[];
  readonly payloads: readonly Hex[];
  readonly batchDigest: Hex;
  /** Exact publishBatch calldata, present when a publication ID was supplied. */
  readonly transactionInput?: Hex;
}

/** Chain-read batches may omit the SDK's optional plan-level batch digest. */
export interface KeelHistoryVerificationBatch extends Omit<KeelHistoryInscriptionBatch, "batchDigest"> {
  readonly batchDigest?: Hex;
}

/** Builds deterministic, bounded history batches from precomputed SHA-256 digests. */
export function buildKeelHistoryInscriptionBatches(input: {
  readonly storedBytes: Uint8Array;
  readonly chunkByteLength?: number;
  readonly chunksPerBatch?: number;
  readonly chunkDigests: readonly Hex[];
  readonly publicationId?: bigint;
  readonly planDigest?: Hex;
}): readonly KeelHistoryInscriptionBatch[] {
  const chunkByteLength = positiveSafeInteger(
    input.chunkByteLength ?? KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES,
    "history inscription chunk byte length",
  );
  if (chunkByteLength > KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES) {
    throw new RangeError(`History inscription chunks cannot exceed ${KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES} bytes.`);
  }
  const chunksPerBatch = positiveSafeInteger(
    input.chunksPerBatch ?? KEEL_HISTORY_INSCRIPTION_CHUNKS_PER_BATCH,
    "history inscription chunks per batch",
  );
  if (chunksPerBatch > KEEL_HISTORY_INSCRIPTION_CHUNKS_PER_BATCH) throw new RangeError("A history inscription batch cannot contain more than three chunks.");
  assertBytes32Array(input.chunkDigests, "history chunk digest");
  const expectedChunkCount = input.storedBytes.byteLength === 0 ? 0 : Math.ceil(input.storedBytes.byteLength / chunkByteLength);
  if (input.chunkDigests.length !== expectedChunkCount) throw new RangeError("History chunk digest count does not match the stored bytes.");
  if (expectedChunkCount > KEEL_HISTORY_MAX_CHUNKS) throw new RangeError(`History publications cannot contain more than ${KEEL_HISTORY_MAX_CHUNKS} chunks.`);
  const hasPublicationId = input.publicationId !== undefined;
  const hasPlan = input.planDigest !== undefined;
  if (hasPublicationId !== hasPlan) throw new TypeError("History transaction encoding requires both publication ID and plan digest.");
  if (hasPublicationId && (input.publicationId as bigint) < 0n) throw new RangeError("The history publication ID cannot be negative.");
  if (hasPlan) assertBytes32(input.planDigest as Hex, "history plan digest");
  const batches: KeelHistoryInscriptionBatch[] = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < input.storedBytes.byteLength) {
    const payloads: Hex[] = [];
    const chunkDigests: Hex[] = [];
    const storedByteOffset = offset;
    while (payloads.length < chunksPerBatch && offset < input.storedBytes.byteLength) {
      const payload = bytesToHex(input.storedBytes.subarray(offset, Math.min(offset + chunkByteLength, input.storedBytes.byteLength)));
      payloads.push(payload);
      const committedDigest = input.chunkDigests[chunkIndex];
      if (committedDigest === undefined) throw new RangeError("History chunk digest manifest ended early.");
      chunkDigests.push(committedDigest);
      offset += (payload.length - 2) / 2;
      chunkIndex += 1;
    }
    const storedByteLength = offset - storedByteOffset;
    const batchIndex = batches.length;
    const batchDigest = keccak256(encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32[]" },
      ],
      [
        KEEL_HISTORY_BATCH_COMMITMENT_DOMAIN,
        batchIndex,
        chunkIndex - payloads.length,
        BigInt(storedByteOffset),
        BigInt(storedByteLength),
        chunkDigests,
      ],
    ));
    const batch: KeelHistoryInscriptionBatch = {
      batchIndex,
      firstChunkIndex: chunkIndex - payloads.length,
      orderedChunkCount: payloads.length,
      storedByteOffset,
      storedByteLength,
      chunkDigests: Object.freeze(chunkDigests),
      payloads: Object.freeze(payloads),
      batchDigest,
    };
    batches.push(hasPublicationId
      ? Object.freeze({
        ...batch,
        transactionInput: encodeKeelHistoryInscriptionBatch({
          publicationId: input.publicationId as bigint,
          planDigest: input.planDigest as Hex,
          batch,
        }),
      })
      : Object.freeze(batch));
    if (batches.length > KEEL_HISTORY_MAX_BATCHES) throw new RangeError(`History publications cannot contain more than ${KEEL_HISTORY_MAX_BATCHES} batches.`);
  }
  return Object.freeze(batches);
}

/** Computes SHA-256 chunk commitments before constructing deterministic batches. */
export async function buildKeelHistoryInscriptionBatchesAsync(input: {
  readonly storedBytes: Uint8Array;
  readonly chunkByteLength?: number;
  readonly chunksPerBatch?: number;
  readonly publicationId?: bigint;
  readonly planDigest?: Hex;
}): Promise<readonly KeelHistoryInscriptionBatch[]> {
  const chunkByteLength = input.chunkByteLength ?? KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkByteLength) || chunkByteLength <= 0 || chunkByteLength > KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES) {
    throw new RangeError(`History inscription chunks cannot exceed ${KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES} bytes.`);
  }
  const digests: Hex[] = [];
  for (let offset = 0; offset < input.storedBytes.byteLength; offset += chunkByteLength) {
    digests.push(await sha256Hex(input.storedBytes.subarray(offset, Math.min(offset + chunkByteLength, input.storedBytes.byteLength))));
  }
  return buildKeelHistoryInscriptionBatches({
    storedBytes: input.storedBytes,
    chunkByteLength,
    ...(input.chunksPerBatch === undefined ? {} : { chunksPerBatch: input.chunksPerBatch }),
    chunkDigests: digests,
    ...(input.publicationId === undefined ? {} : { publicationId: input.publicationId }),
    ...(input.planDigest === undefined ? {} : { planDigest: input.planDigest }),
  });
}

/** Exact `publishBatch` calldata; payload bytes occur once and include the selector. */
export function encodeKeelHistoryInscriptionBatch(input: {
  readonly publicationId: bigint;
  readonly planDigest: Hex;
  readonly batch: Pick<KeelHistoryInscriptionBatch, "batchIndex" | "firstChunkIndex" | "orderedChunkCount" | "storedByteOffset" | "chunkDigests" | "payloads">;
}): Hex {
  if (input.publicationId < 0n) throw new RangeError("The history publication ID cannot be negative.");
  assertBytes32(input.planDigest, "history plan digest");
  const batch = input.batch;
  if (batch.payloads.length !== batch.orderedChunkCount || batch.chunkDigests.length !== batch.payloads.length) {
    throw new RangeError("History batch payload and digest counts do not match.");
  }
  return encodeFunctionData({
    abi: KEEL_HISTORY_PUBLISH_BATCH_ABI,
    functionName: "publishBatch",
    args: [
      input.publicationId,
      KEEL_HISTORY_INSCRIPTION_STORAGE_MODE,
      input.planDigest,
      BigInt(batch.batchIndex),
      BigInt(batch.firstChunkIndex),
      BigInt(batch.storedByteOffset),
      batch.payloads,
    ],
  });
}

/** Exact payable `openPublication` calldata for one history plan. */
export function encodeKeelHistoryPublicationOpen(input: {
  /** Read-only nextPublicationId quote; the contract rejects a stale value. */
  readonly expectedPublicationId: bigint;
  readonly executor: Address;
  readonly deadline: bigint;
  readonly planDigest: Hex;
  readonly decodedDigest: Hex;
  readonly storedDigest: Hex;
  readonly decodedByteLength: number;
  readonly storedByteLength: number;
  readonly compression: number;
  readonly mediaTypeHash: Hex;
  readonly chunkDigests: readonly Hex[];
  readonly batchChunkCounts: readonly number[];
}): Hex {
  if (input.expectedPublicationId < 0n) throw new RangeError("The expected history publication ID cannot be negative.");
  if (!ADDRESS_PATTERN.test(input.executor)) throw new TypeError("The history executor must be an Ethereum address.");
  if (input.deadline <= 0n || input.deadline > (1n << 64n) - 1n) throw new RangeError("The history deadline is invalid.");
  assertBytes32(input.planDigest, "history plan digest");
  assertBytes32(input.decodedDigest, "history decoded digest");
  assertBytes32(input.storedDigest, "history stored digest");
  const decodedByteLength = nonNegativeSafeInteger(input.decodedByteLength, "history decoded byte length");
  const storedByteLength = nonNegativeSafeInteger(input.storedByteLength, "history stored byte length");
  if (BigInt(decodedByteLength) > (1n << 64n) - 1n || BigInt(storedByteLength) > (1n << 64n) - 1n) {
    throw new RangeError("History byte lengths exceed uint64.");
  }
  if (!Number.isSafeInteger(input.compression) || input.compression < 0 || input.compression > 3) {
    throw new RangeError("History compression must be a uint8 code from zero through three.");
  }
  assertBytes32(input.mediaTypeHash, "history media type hash");
  assertBytes32Array(input.chunkDigests, "history chunk digest");
  if (input.chunkDigests.length > KEEL_HISTORY_MAX_CHUNKS) {
    throw new RangeError(`History publications cannot contain more than ${KEEL_HISTORY_MAX_CHUNKS} chunks.`);
  }
  if (input.batchChunkCounts.length > KEEL_HISTORY_MAX_BATCHES) {
    throw new RangeError(`History publications cannot contain more than ${KEEL_HISTORY_MAX_BATCHES} batches.`);
  }
  input.batchChunkCounts.forEach((count) => {
    if (!Number.isSafeInteger(count) || count <= 0 || count > 3) throw new RangeError("History batch chunk counts must be one through three.");
  });
  if (input.batchChunkCounts.reduce((total, count) => total + count, 0) !== input.chunkDigests.length) {
    throw new RangeError("History batch chunk counts must equal the chunk digest count.");
  }
  return encodeFunctionData({
    abi: KEEL_HISTORY_OPEN_PUBLICATION_ABI,
    functionName: "openPublication",
    args: [
      input.expectedPublicationId,
      KEEL_HISTORY_INSCRIPTION_STORAGE_MODE,
      input.executor,
      input.deadline,
      input.planDigest,
      input.decodedDigest,
      input.storedDigest,
      BigInt(decodedByteLength),
      BigInt(storedByteLength),
      input.compression,
      input.mediaTypeHash,
      input.chunkDigests,
      input.batchChunkCounts,
    ],
  });
}

export interface KeelEip7623CalldataGasEstimate extends EthereumCalldataIntrinsicGasEstimate {
  readonly standardCalldataGas: number;
  readonly floorCalldataGas: number;
  readonly standardTotalGas: number;
  readonly floorTotalGas: number;
  readonly chargedCalldataIntrinsicGas: number;
  readonly executionGas: number;
  /** `base + max(standard calldata + execution, EIP-7623 floor)`. */
  readonly chargedTotalGas: number;
  readonly standardTotalGasWithExecution: number;
  readonly calldataFloorApplied: boolean;
}

/** Charged calldata gas under EIP-7623, including the transaction base. */
export function estimateEthereumCalldataIntrinsicGasWithEip7623(input: {
  readonly bytes: Uint8Array;
  readonly transactionCount?: number;
  readonly envelopeByteLengthPerTransaction?: number;
  readonly envelopeZeroByteCountPerTransaction?: number;
  readonly executionGas?: number;
}): KeelEip7623CalldataGasEstimate {
  const standard = estimateEthereumCalldataIntrinsicGas(input);
  const executionGas = nonNegativeSafeInteger(input.executionGas ?? 0, "EIP-7623 execution gas");
  const floorCalldataGas = standard.zeroByteCount * ETHEREUM_EIP_7623_ZERO_CALLDATA_BYTE_GAS
    + standard.nonZeroByteCount * ETHEREUM_EIP_7623_NONZERO_CALLDATA_BYTE_GAS;
  const standardTotalGas = standard.calldataIntrinsicGas;
  const floorTotalGas = standard.transactionBaseGas + floorCalldataGas;
  const chargedCalldataIntrinsicGas = Math.max(standardTotalGas, floorTotalGas);
  const standardTotalGasWithExecution = standardTotalGas + executionGas;
  const chargedTotalGas = Math.max(standardTotalGasWithExecution, floorTotalGas);
  return Object.freeze({
    ...standard,
    standardCalldataGas: standard.calldataByteGas,
    floorCalldataGas,
    standardTotalGas,
    floorTotalGas,
    chargedCalldataIntrinsicGas,
    executionGas,
    chargedTotalGas,
    standardTotalGasWithExecution,
    calldataFloorApplied: floorTotalGas > standardTotalGasWithExecution,
    calldataIntrinsicGas: chargedCalldataIntrinsicGas,
  });
}

export interface KeelHistoryBatchGasEstimate {
  readonly batchIndex: number;
  readonly payloadByteLength: number;
  readonly normalCalldataIntrinsicGas: number;
  readonly eip7623FloorGas: number;
  readonly chargedCalldataIntrinsicGas: number;
  readonly eventTopicGas: number;
  readonly eventDataGas: number;
  readonly validationGas: number;
  readonly totalBatchGas: number;
  readonly chargedTransactionGas: number;
  readonly calldataFloorApplied: boolean;
}

export interface KeelHistoryInscriptionGasEstimate {
  readonly storageMode: typeof KEEL_HISTORY_INSCRIPTION_V1;
  readonly storedByteLength: number;
  readonly chunkCount: number;
  readonly batchCount: number;
  readonly normalCalldataIntrinsicGas: number;
  readonly eip7623FloorGas: number;
  readonly chargedCalldataIntrinsicGas: number;
  readonly eventTopicGas: number;
  readonly eventDataGas: number;
  readonly hashingValidationGas: number;
  readonly nativeCommitmentStateGas: number;
  readonly logicalRegistryOperationGas: number;
  readonly executorControlGas: number;
  readonly transactionGasCap: number;
  readonly transactionGasHeadroom: number;
  readonly calldataFloorApplied: boolean;
  readonly totalExecutorGas: number;
  readonly batches: readonly KeelHistoryBatchGasEstimate[];
}

/**
 * Quotes history calldata with the EIP-7623 floor and reports event and
 * execution costs separately. Payload duplication in an event is intentionally
 * not assumed: eventDataByteLength must be supplied explicitly when used.
 */
export function estimateKeelHistoryInscriptionGas(input: {
  readonly batches: readonly KeelHistoryInscriptionBatch[];
  readonly eventTopicCount?: number;
  readonly eventDataByteLength?: number;
  readonly validationGasPerBatch?: number;
  readonly commitmentStateGas?: number;
  readonly logicalRegistryOperationGas?: number;
  readonly executorControlGas?: number;
  readonly transactionGasCap?: number;
}): KeelHistoryInscriptionGasEstimate {
  const eventTopicCount = nonNegativeSafeInteger(input.eventTopicCount ?? KEEL_HISTORY_EVENT_TOPIC_COUNT, "history event topic count");
  const validationGasPerBatch = nonNegativeSafeInteger(input.validationGasPerBatch ?? KEEL_HISTORY_BATCH_VALIDATION_GAS, "history batch validation gas");
  const commitmentStateGas = nonNegativeSafeInteger(input.commitmentStateGas ?? KEEL_HISTORY_COMMITMENT_STATE_GAS, "history commitment state gas");
  const logicalRegistryOperationGas = nonNegativeSafeInteger(input.logicalRegistryOperationGas ?? 0, "history logical operation gas");
  const executorControlGas = nonNegativeSafeInteger(input.executorControlGas ?? KEEL_HISTORY_EXECUTOR_CONTROL_GAS, "history executor control gas");
  const transactionGasCap = positiveSafeInteger(input.transactionGasCap ?? KEEL_EIP_7825_TRANSACTION_GAS_CAP, "history transaction gas cap");
  const batchEstimates: KeelHistoryBatchGasEstimate[] = [];
  let storedByteLength = 0;
  let chunkCount = 0;
  let normalCalldataIntrinsicGas = 0;
  let eip7623FloorGas = 0;
  let chargedCalldataIntrinsicGas = 0;
  let eventTopicGas = 0;
  let eventDataGas = 0;
  let hashingValidationGas = 0;
  for (const batch of input.batches) {
    if (batch.transactionInput === undefined) throw new TypeError("History gas quotes require exact transaction-input encodings.");
    const batchEventDataByteLength = input.eventDataByteLength === undefined
      ? 256 + batch.orderedChunkCount * 32
      : nonNegativeSafeInteger(input.eventDataByteLength, "history event data byte length");
    const batchEventTopicGas = eventTopicCount * ETHEREUM_LOG_TOPIC_GAS;
    const batchEventDataGas = batchEventDataByteLength * ETHEREUM_LOG_DATA_BYTE_GAS;
    const executionGas = batchEventTopicGas + batchEventDataGas + validationGasPerBatch;
    const calldata = estimateEthereumCalldataIntrinsicGasWithEip7623({
      bytes: hexToBytes(batch.transactionInput),
      executionGas,
    });
    const totalBatchGas = calldata.chargedTotalGas;
    if (totalBatchGas > transactionGasCap) {
      throw new RangeError(`History batch ${batch.batchIndex} exceeds the EIP-7825 transaction gas cap.`);
    }
    const estimate: KeelHistoryBatchGasEstimate = Object.freeze({
      batchIndex: batch.batchIndex,
      payloadByteLength: batch.payloads.reduce((total, payload) => total + (payload.length - 2) / 2, 0),
      normalCalldataIntrinsicGas: calldata.standardTotalGas,
      eip7623FloorGas: calldata.floorTotalGas,
      chargedCalldataIntrinsicGas: calldata.chargedCalldataIntrinsicGas,
      eventTopicGas: batchEventTopicGas,
      eventDataGas: batchEventDataGas,
      validationGas: validationGasPerBatch,
      totalBatchGas,
      chargedTransactionGas: calldata.chargedTotalGas,
      calldataFloorApplied: calldata.calldataFloorApplied,
    });
    batchEstimates.push(estimate);
    storedByteLength += batch.storedByteLength;
    chunkCount += batch.orderedChunkCount;
    normalCalldataIntrinsicGas += calldata.standardTotalGas;
    eip7623FloorGas += calldata.floorTotalGas;
    chargedCalldataIntrinsicGas += calldata.chargedCalldataIntrinsicGas;
    eventTopicGas += batchEventTopicGas;
    eventDataGas += batchEventDataGas;
    hashingValidationGas += validationGasPerBatch;
  }
  const totalExecutorGas = batchEstimates.reduce((total, estimate) => total + estimate.totalBatchGas, 0)
    + commitmentStateGas
    + logicalRegistryOperationGas
    + executorControlGas;
  return Object.freeze({
    storageMode: KEEL_HISTORY_INSCRIPTION_V1,
    storedByteLength,
    chunkCount,
    batchCount: batchEstimates.length,
    normalCalldataIntrinsicGas,
    eip7623FloorGas,
    chargedCalldataIntrinsicGas,
    eventTopicGas,
    eventDataGas,
    hashingValidationGas,
    nativeCommitmentStateGas: commitmentStateGas,
    logicalRegistryOperationGas,
    executorControlGas,
    transactionGasCap,
    transactionGasHeadroom: batchEstimates.length === 0
      ? transactionGasCap
      : Math.min(...batchEstimates.map((estimate) => transactionGasCap - estimate.totalBatchGas)),
    calldataFloorApplied: batchEstimates.some((estimate) => estimate.calldataFloorApplied),
    totalExecutorGas,
    batches: Object.freeze(batchEstimates),
  });
}

export interface KeelPublicationPlan {
  readonly storageMode: KeelPublicationStorageMode;
  readonly owner: Address;
  readonly executor: Address;
  readonly deadline: bigint;
  readonly decodedDigest: Hex;
  readonly storedDigest: Hex;
  readonly commitment: KeelObjectCommitment;
  readonly planDigest: Hex;
  readonly manifest: KeelPublicationJobManifest;
  readonly operations: readonly KeelPublicationJobOperation[];
  readonly nativeCarrierBatches?: readonly (readonly Hex[])[];
  readonly historyBatches?: readonly KeelHistoryInscriptionBatch[];
  /** Exact payable openPublication calldata for the quoted publication. */
  readonly historyOpenTransactionInput?: Hex;
  readonly gas: KeelNativePublicationGasEstimate | KeelHistoryInscriptionGasEstimate;
}

/** One planner selects exactly one adapter and never falls back. */
export async function buildKeelPublicationPlan(input: {
  readonly storageMode?: KeelPublicationStorageMode;
  readonly owner: Address;
  readonly executor: Address;
  readonly deadline: bigint;
  readonly decodedDigest: Hex;
  readonly storedDigest: Hex;
  readonly decodedByteLength: number;
  readonly storedBytes: Uint8Array;
  readonly compression: Compression;
  readonly mediaType: string;
  readonly operations?: readonly KeelPublicationJobOperation[];
  readonly contentObjectCount?: number;
  readonly logicalOperationCount?: number;
  readonly includeExecutorControlGas?: boolean;
  readonly history?: {
    /** EIP-155 chain identity used by the contract commitment. */
    readonly chainId?: KeelEip155ChainId;
    /** Deployed history coordinator address used by the contract commitment. */
    readonly coordinator?: Address;
    readonly chunkByteLength?: number;
    readonly chunksPerBatch?: number;
    readonly eventTopicCount?: number;
    readonly eventDataByteLength?: number;
    readonly validationGasPerBatch?: number;
    readonly commitmentStateGas?: number;
    readonly logicalRegistryOperationGas?: number;
    readonly executorControlGas?: number;
    readonly transactionGasCap?: number;
    /** Read-only nextPublicationId used to bind the exact future publication. */
    readonly publicationIdForQuote?: bigint;
  };
}): Promise<KeelPublicationPlan> {
  const storageMode = selectKeelPublicationStorageMode(input.storageMode);
  if (!ADDRESS_PATTERN.test(input.owner) || !ADDRESS_PATTERN.test(input.executor)) {
    throw new TypeError("The KEEL publication owner and executor must be Ethereum addresses.");
  }
  if (input.storedBytes.byteLength < 0) throw new RangeError("The stored KEEL bytes are invalid.");
  if (input.storedBytes.byteLength === 0 && (input.operations?.length ?? 0) === 0) {
    throw new Error("An empty KEEL publication still requires a committed operation.");
  }
  if (storageMode === KEEL_HISTORY_INSCRIPTION_V1) {
    if (input.history?.chainId === undefined || input.history.coordinator === undefined
      || input.history.publicationIdForQuote === undefined) {
      throw new TypeError("History planning requires chainId, coordinator, and a read-only nextPublicationId quote.");
    }
    if (!ADDRESS_PATTERN.test(input.history.coordinator)) {
      throw new TypeError("The history coordinator must be an Ethereum address.");
    }
    if (input.history.publicationIdForQuote < 0n) throw new RangeError("The history publication ID cannot be negative.");
    const actualStoredDigest = await sha256Hex(input.storedBytes);
    if (actualStoredDigest.toLowerCase() !== input.storedDigest.toLowerCase()) {
      throw new Error("The history stored digest does not match the supplied stored bytes.");
    }
  }
  const operations = Object.freeze((input.operations ?? []).map((operation) => Object.freeze({ ...operation })));
  const initialChunks = storageMode === KEEL_NATIVE_CARRIER_V1
    ? splitKeelBytes(input.storedBytes, KEEL_NATIVE_CHUNK_BYTES)
    : await buildKeelHistoryInscriptionBatchesAsync({
      storedBytes: input.storedBytes,
      ...(input.history?.chunkByteLength === undefined ? {} : { chunkByteLength: input.history.chunkByteLength }),
      ...(input.history?.chunksPerBatch === undefined ? {} : { chunksPerBatch: input.history.chunksPerBatch }),
    });
  const payloadBatches = storageMode === KEEL_NATIVE_CARRIER_V1
    ? initialChunks as readonly (readonly Hex[])[]
    : (initialChunks as readonly KeelHistoryInscriptionBatch[]).map((batch) => batch.payloads);
  const batchDigests = storageMode === KEEL_NATIVE_CARRIER_V1
    ? payloadBatches.map((payloads) => keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "bytes32[]" }],
      [KEEL_HISTORY_BATCH_COMMITMENT_DOMAIN, payloads.length, payloads.map((payload) => keccak256(payload))],
    )))
    : (initialChunks as readonly KeelHistoryInscriptionBatch[]).map((batch) => batch.batchDigest);
  const chunkCount = payloadBatches.reduce((total, batch) => total + batch.length, 0);
  const historyChunkDigests = storageMode === KEEL_HISTORY_INSCRIPTION_V1
    ? (initialChunks as readonly KeelHistoryInscriptionBatch[]).flatMap((batch) => batch.chunkDigests)
    : undefined;
  const historyBatchChunkCounts = storageMode === KEEL_HISTORY_INSCRIPTION_V1
    ? (initialChunks as readonly KeelHistoryInscriptionBatch[]).map((batch) => batch.orderedChunkCount)
    : undefined;
  // The history coordinator derives its commitment from the publication
  // authority, opaque plan digest, object metadata, SHA-256 chunks, and batch
  // counts. Therefore the plan digest is built first without recursively
  // embedding that commitment.
  const provisionalManifest = buildKeelPublicationJobManifest({
    owner: input.owner,
    executor: input.executor,
    deadline: input.deadline,
    storageMode,
    ...(storageMode === KEEL_NATIVE_CARRIER_V1 ? {} : {}),
    batchDigests,
    carrierBatches: payloadBatches,
    ...(storageMode === KEEL_HISTORY_INSCRIPTION_V1 && historyChunkDigests !== undefined
      ? { chunkDigests: historyChunkDigests }
      : {}),
    operations,
  });
  const commitment = buildKeelObjectCommitment({
    storageMode,
    ...(storageMode === KEEL_HISTORY_INSCRIPTION_V1 ? {
      chainId: input.history?.chainId as KeelEip155ChainId,
      coordinator: input.history?.coordinator as Address,
      publicationId: input.history?.publicationIdForQuote as bigint,
      owner: input.owner,
      executor: input.executor,
      compressionCode: keelCompressionCode(input.compression),
      mediaTypeHash: keccak256(stringToHex(input.mediaType)),
    } : {}),
    decodedDigest: input.decodedDigest,
    storedDigest: input.storedDigest,
    decodedByteLength: input.decodedByteLength,
    storedByteLength: input.storedBytes.byteLength,
    compression: input.compression,
    mediaType: input.mediaType,
    batchCount: payloadBatches.length,
    chunkCount,
    ...(storageMode === KEEL_HISTORY_INSCRIPTION_V1 && historyChunkDigests !== undefined && historyBatchChunkCounts !== undefined
      ? {
        planDigest: provisionalManifest.planDigest,
        chunkDigests: historyChunkDigests,
        batchChunkCounts: historyBatchChunkCounts,
      }
      : {}),
  });
  const manifest = storageMode === KEEL_HISTORY_INSCRIPTION_V1
    ? provisionalManifest
    : buildKeelPublicationJobManifest({
      owner: input.owner,
      executor: input.executor,
      deadline: input.deadline,
      storageMode,
      objectCommitmentDigest: commitment.commitmentDigest,
      batchDigests,
      carrierBatches: payloadBatches,
      operations,
    });
  if (storageMode === KEEL_NATIVE_CARRIER_V1) {
    const gas = estimateKeelNativePublicationGas({
      storedByteLength: input.storedBytes.byteLength,
      storedBytes: input.storedBytes,
      chunkByteLengths: splitKeelBytes(input.storedBytes, KEEL_NATIVE_CHUNK_BYTES)
        .flatMap((batch) => batch.map((payload) => (payload.length - 2) / 2)),
      contentObjectCount: input.contentObjectCount ?? 1,
      logicalOperationCount: input.logicalOperationCount ?? operations.length,
      ...(input.includeExecutorControlGas === undefined ? {} : { includeExecutorControlGas: input.includeExecutorControlGas }),
    });
    return Object.freeze({
      storageMode,
      owner: input.owner,
      executor: input.executor,
      deadline: input.deadline,
      decodedDigest: input.decodedDigest,
      storedDigest: input.storedDigest,
      commitment,
      planDigest: manifest.planDigest,
      manifest,
      operations,
      nativeCarrierBatches: payloadBatches,
      gas,
    });
  }
  const historyBatches = (initialChunks as readonly KeelHistoryInscriptionBatch[]).map((batch) => Object.freeze({
    ...batch,
    transactionInput: encodeKeelHistoryInscriptionBatch({
      publicationId: input.history?.publicationIdForQuote ?? 0n,
      planDigest: manifest.planDigest,
      batch,
    }),
  }));
  const historyOpenTransactionInput = encodeKeelHistoryPublicationOpen({
    expectedPublicationId: input.history?.publicationIdForQuote ?? 0n,
    executor: input.executor,
    deadline: input.deadline,
    planDigest: manifest.planDigest,
    decodedDigest: input.decodedDigest,
    storedDigest: input.storedDigest,
    decodedByteLength: input.decodedByteLength,
    storedByteLength: input.storedBytes.byteLength,
    compression: keelCompressionCode(input.compression),
    mediaTypeHash: keccak256(stringToHex(input.mediaType)),
    chunkDigests: historyChunkDigests as readonly Hex[],
    batchChunkCounts: historyBatchChunkCounts as readonly number[],
  });
  const gas = estimateKeelHistoryInscriptionGas({
    batches: historyBatches,
    ...(input.history?.eventTopicCount === undefined ? {} : { eventTopicCount: input.history.eventTopicCount }),
    ...(input.history?.eventDataByteLength === undefined ? {} : { eventDataByteLength: input.history.eventDataByteLength }),
    ...(input.history?.validationGasPerBatch === undefined ? {} : { validationGasPerBatch: input.history.validationGasPerBatch }),
    ...(input.history?.commitmentStateGas === undefined ? {} : { commitmentStateGas: input.history.commitmentStateGas }),
    ...(input.history?.logicalRegistryOperationGas === undefined ? {} : { logicalRegistryOperationGas: input.history.logicalRegistryOperationGas }),
    ...(input.history?.executorControlGas === undefined ? {} : { executorControlGas: input.history.executorControlGas }),
    ...(input.history?.transactionGasCap === undefined ? {} : { transactionGasCap: input.history.transactionGasCap }),
  });
  return Object.freeze({
    storageMode,
    owner: input.owner,
    executor: input.executor,
    deadline: input.deadline,
    decodedDigest: input.decodedDigest,
    storedDigest: input.storedDigest,
    commitment,
    planDigest: manifest.planDigest,
    manifest,
    operations,
    historyBatches: Object.freeze(historyBatches),
    historyOpenTransactionInput,
    gas,
  });
}

/** Short alias for callers that describe the operation as planning. */
export const planKeelPublication = buildKeelPublicationPlan;

export interface KeelHistoryVerificationBundle {
  readonly storageMode: typeof KEEL_HISTORY_INSCRIPTION_V1;
  readonly chainId: KeelEip155ChainId;
  readonly coordinator: Address;
  readonly publicationId: bigint;
  readonly owner: Address;
  /** Immutable Publication.initialExecutor used by the commitment hash. */
  readonly executor: Address;
  /** Current executor after any verified rotation event; not used for the hash. */
  readonly currentExecutor?: Address;
  readonly planDigest: Hex;
  readonly commitmentDigest: Hex;
  readonly storedDigest: Hex;
  readonly decodedDigest: Hex;
  readonly storedByteLength: number;
  readonly decodedByteLength: number;
  readonly compression: number;
  readonly mediaTypeHash: Hex;
  readonly chunkDigests: readonly Hex[];
  readonly batchChunkCounts: readonly number[];
  readonly batches: readonly KeelHistoryVerificationBatch[];
  /** Optional higher-level proof; basic Wake read-back does not require it. */
  readonly planProof?: {
    readonly owner: Address;
    readonly executor: Address;
    readonly deadline: bigint;
    readonly operations: readonly KeelPublicationJobOperation[];
  };
}

export function buildKeelHistoryVerificationBundle(plan: KeelPublicationPlan): KeelHistoryVerificationBundle {
  if (plan.storageMode !== KEEL_HISTORY_INSCRIPTION_V1 || plan.historyBatches === undefined) {
    throw new TypeError("A history verification bundle requires history-inscription-v1.");
  }
  return Object.freeze({
    storageMode: KEEL_HISTORY_INSCRIPTION_V1,
    chainId: plan.commitment.chainId as KeelEip155ChainId,
    coordinator: plan.commitment.coordinator as Address,
    publicationId: plan.commitment.publicationId as bigint,
    owner: plan.commitment.owner ?? plan.owner,
    executor: plan.commitment.executor ?? plan.executor,
    planDigest: plan.planDigest,
    commitmentDigest: plan.commitment.commitmentDigest,
    storedDigest: plan.commitment.storedDigest,
    decodedDigest: plan.commitment.decodedDigest,
    storedByteLength: plan.commitment.storedByteLength,
    decodedByteLength: plan.commitment.decodedByteLength,
    compression: plan.commitment.compressionCode ?? keelCompressionCode(plan.commitment.compression),
    mediaTypeHash: plan.commitment.mediaTypeHash ?? keccak256(stringToHex(plan.commitment.mediaType)),
    chunkDigests: Object.freeze([...(plan.commitment.chunkDigests ?? [])]),
    batchChunkCounts: Object.freeze([...(plan.commitment.batchChunkCounts ?? [])]),
    batches: Object.freeze(plan.historyBatches.map((batch) => Object.freeze({ ...batch }))),
    planProof: {
      owner: plan.owner,
      executor: plan.executor,
      deadline: plan.deadline,
      operations: plan.operations,
    },
  });
}

export interface KeelHistoryExecutorRotationEvidence {
  readonly publicationId: bigint;
  readonly owner: Address;
  readonly previousExecutor: Address;
  readonly newExecutor: Address;
  readonly nextBatch: number;
  readonly nextChunk: number;
  readonly nextStoredOffset: number;
}

/** Replays only canonical rotation evidence; conflicting or regressing events fail closed. */
export function replayKeelHistoryExecutorRotations(input: {
  readonly publicationId: bigint;
  readonly owner: Address;
  readonly initialExecutor: Address;
  readonly rotations: readonly KeelHistoryExecutorRotationEvidence[];
}): Address {
  if (input.publicationId < 0n) throw new RangeError("The history publication ID cannot be negative.");
  if (!ADDRESS_PATTERN.test(input.owner) || !ADDRESS_PATTERN.test(input.initialExecutor)) {
    throw new TypeError("History rotation evidence requires Ethereum addresses.");
  }
  let currentExecutor = input.initialExecutor;
  let previousCursor = { nextBatch: 0, nextChunk: 0, nextStoredOffset: 0 };
  for (const rotation of input.rotations) {
    if (rotation.publicationId !== input.publicationId || rotation.owner.toLowerCase() !== input.owner.toLowerCase()) {
      throw new Error("History executor rotation evidence belongs to a different publication.");
    }
    if (!ADDRESS_PATTERN.test(rotation.previousExecutor) || !ADDRESS_PATTERN.test(rotation.newExecutor)) {
      throw new TypeError("History rotation evidence contains an invalid executor address.");
    }
    if (rotation.previousExecutor.toLowerCase() !== currentExecutor.toLowerCase()) {
      throw new Error("History executor rotation evidence is conflicting or duplicated.");
    }
    if (!Number.isSafeInteger(rotation.nextBatch) || rotation.nextBatch < previousCursor.nextBatch
      || !Number.isSafeInteger(rotation.nextChunk) || rotation.nextChunk < previousCursor.nextChunk
      || !Number.isSafeInteger(rotation.nextStoredOffset) || rotation.nextStoredOffset < previousCursor.nextStoredOffset) {
      throw new Error("History executor rotation evidence regresses the publication cursor.");
    }
    currentExecutor = rotation.newExecutor;
    previousCursor = {
      nextBatch: rotation.nextBatch,
      nextChunk: rotation.nextChunk,
      nextStoredOffset: rotation.nextStoredOffset,
    };
  }
  return currentExecutor;
}

/** Reconstructs from canonical chain evidence without requiring hidden plan preimages. */
export function reconstructKeelHistoryStoredBytes(bundle: KeelHistoryVerificationBundle): Uint8Array {
  if (bundle.storageMode !== KEEL_HISTORY_INSCRIPTION_V1) throw new Error("The history verification bundle has an invalid storage mode.");
  assertBytes32(bundle.commitmentDigest, "history commitment digest");
  if (bundle.batches.length !== bundle.batchChunkCounts.length) throw new Error("The history batch count does not match the commitment.");
  if (bundle.chunkDigests.length !== bundle.batches.reduce((total, batch) => total + batch.orderedChunkCount, 0)) throw new Error("The history chunk count does not match the commitment.");
  if (bundle.batchChunkCounts.reduce((total, count) => total + count, 0) !== bundle.chunkDigests.length) throw new Error("The history batch chunk counts do not match the commitment.");
  if (computeKeelHistoryPublicationCommitmentDigest({
    chainId: bundle.chainId,
    coordinator: bundle.coordinator,
    publicationId: bundle.publicationId,
    owner: bundle.owner,
    executor: bundle.executor,
    planDigest: bundle.planDigest,
    decodedDigest: bundle.decodedDigest,
    storedDigest: bundle.storedDigest,
    decodedByteLength: bundle.decodedByteLength,
    storedByteLength: bundle.storedByteLength,
    compression: bundle.compression,
    mediaTypeHash: bundle.mediaTypeHash,
    chunkDigests: bundle.chunkDigests,
    batchChunkCounts: bundle.batchChunkCounts,
  }).toLowerCase() !== bundle.commitmentDigest.toLowerCase()) throw new Error("The history publication commitment does not match chain evidence.");
  const rawPayloadBatches: readonly (readonly Hex[])[] = bundle.batches.map((batch, batchIndex) => {
    if (batch.batchIndex !== batchIndex) throw new Error("History batches are not ordered contiguously.");
    if (batch.payloads.length !== batch.orderedChunkCount || batch.chunkDigests.length !== batch.orderedChunkCount || batch.orderedChunkCount !== bundle.batchChunkCounts[batchIndex]) {
      throw new Error("History batch chunk counts are inconsistent.");
    }
    if (batch.batchDigest !== undefined
      && batch.batchDigest.toLowerCase() !== computeKeelHistoryBatchDigest(batch).toLowerCase()) {
      throw new Error(`History batch ${batchIndex} commitment mismatch.`);
    }
    if (batch.firstChunkIndex !== bundle.batches.slice(0, batchIndex).reduce((total, prior) => total + prior.orderedChunkCount, 0)) {
      throw new Error(`History batch ${batchIndex} has a skipped or duplicated chunk index.`);
    }
    if (batch.storedByteOffset !== bundle.batches.slice(0, batchIndex).reduce((total, prior) => total + prior.storedByteLength, 0)) {
      throw new Error(`History batch ${batchIndex} has a skipped or duplicated byte offset.`);
    }
    if (!Number.isSafeInteger(batch.storedByteOffset) || batch.storedByteOffset < 0
      || !Number.isSafeInteger(batch.storedByteLength) || batch.storedByteLength <= 0) {
      throw new Error(`History batch ${batchIndex} has invalid byte offsets or lengths.`);
    }
    const actualBatchByteLength = batch.payloads.reduce((total, payload) => total + (payload.length - 2) / 2, 0);
    if (actualBatchByteLength !== batch.storedByteLength
      || batch.storedByteOffset + actualBatchByteLength > bundle.storedByteLength) {
      throw new Error(`History batch ${batchIndex} byte lengths do not match its payload evidence.`);
    }
    const globalStart = batch.firstChunkIndex;
    for (let chunkIndex = 0; chunkIndex < batch.payloads.length; chunkIndex += 1) {
      const payload = batch.payloads[chunkIndex];
      if (payload === undefined || payload.length <= 2 || (payload.length - 2) / 2 > KEEL_HISTORY_INSCRIPTION_CHUNK_BYTES) {
        throw new Error(`History batch ${batchIndex} contains an empty or oversized chunk.`);
      }
      if (batch.chunkDigests[chunkIndex]?.toLowerCase() !== bundle.chunkDigests[globalStart + chunkIndex]?.toLowerCase()) {
        throw new Error(`History batch ${batchIndex} has a conflicting chunk commitment.`);
      }
    }
    if (batch.transactionInput !== undefined && bundle.publicationId !== undefined) {
      const expectedInput = encodeKeelHistoryInscriptionBatch({ publicationId: bundle.publicationId, planDigest: bundle.planDigest, batch });
      if (batch.transactionInput.toLowerCase() !== expectedInput.toLowerCase()) {
      throw new Error(`History batch ${batchIndex} transaction evidence mismatch.`);
      }
    }
    return batch.payloads;
  });
  if (bundle.planProof !== undefined) {
    const batchDigests = bundle.batches.map((batch) => {
      if (batch.batchDigest === undefined) throw new Error("The optional history plan proof requires SDK batch digests.");
      return batch.batchDigest;
    });
    const manifest = buildKeelPublicationJobManifest({
      owner: bundle.planProof.owner,
      executor: bundle.planProof.executor,
      deadline: bundle.planProof.deadline,
      storageMode: KEEL_HISTORY_INSCRIPTION_V1,
      batchDigests,
      carrierBatches: rawPayloadBatches,
      chunkDigests: bundle.chunkDigests,
      operations: bundle.planProof.operations,
    });
    if (manifest.planDigest.toLowerCase() !== bundle.planDigest.toLowerCase()) throw new Error("The history plan digest does not match the optional plan proof.");
  }
  const output = new Uint8Array(bundle.storedByteLength);
  let offset = 0;
  for (const batch of bundle.batches) {
    for (const payload of batch.payloads) {
      const bytes = hexToBytes(payload);
      output.set(bytes, offset);
      offset += bytes.byteLength;
    }
  }
  if (offset !== output.byteLength || bundle.batches.reduce((total, batch) => total + batch.orderedChunkCount, 0) !== bundle.chunkDigests.length) {
    throw new Error("The reconstructed history bytes do not match the committed lengths.");
  }
  return output;
}

export interface KeelHistoryVerificationResult {
  readonly storedBytes: Uint8Array;
  readonly storedDigest: Hex;
  readonly decodedDigest?: Hex;
  readonly storedVerified: true;
  readonly decodedVerified: boolean;
}

/** SHA-256 verification is asynchronous so the same helper works in browser and Node runtimes. */
export async function verifyKeelHistoryVerificationBundle(input: {
  readonly bundle: KeelHistoryVerificationBundle;
  readonly decodedBytes?: Uint8Array;
}): Promise<KeelHistoryVerificationResult> {
  for (const batch of input.bundle.batches) {
    for (let chunkIndex = 0; chunkIndex < batch.payloads.length; chunkIndex += 1) {
      const actualDigest = await sha256Hex(hexToBytes(batch.payloads[chunkIndex] as Hex));
      if (actualDigest.toLowerCase() !== batch.chunkDigests[chunkIndex]?.toLowerCase()) throw new Error(`History batch ${batch.batchIndex} contains a corrupt SHA-256 chunk.`);
    }
  }
  const storedBytes = reconstructKeelHistoryStoredBytes(input.bundle);
  const storedDigest = await sha256Hex(storedBytes);
  if (storedDigest.toLowerCase() !== input.bundle.storedDigest.toLowerCase()) {
    throw new Error("The reconstructed history bytes do not match the committed stored digest.");
  }
  if (input.decodedBytes === undefined) {
    return Object.freeze({ storedBytes, storedDigest, storedVerified: true, decodedVerified: false });
  }
  if (input.decodedBytes.byteLength !== input.bundle.decodedByteLength) throw new Error("The decoded bytes do not match the committed decoded length.");
  const decodedDigest = await sha256Hex(input.decodedBytes);
  if (decodedDigest.toLowerCase() !== input.bundle.decodedDigest.toLowerCase()) throw new Error("The decoded bytes do not match the committed decoded digest.");
  return Object.freeze({ storedBytes, storedDigest, decodedDigest, storedVerified: true, decodedVerified: true });
}

function splitKeelBytes(bytes: Uint8Array, chunkByteLength: number): readonly (readonly Hex[])[] {
  const chunks: Hex[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkByteLength) {
    chunks.push(bytesToHex(bytes.subarray(offset, Math.min(offset + chunkByteLength, bytes.byteLength))));
  }
  const batches: Hex[][] = [];
  for (let index = 0; index < chunks.length; index += KEEL_NATIVE_CHUNKS_PER_TRANSACTION) {
    batches.push(chunks.slice(index, index + KEEL_NATIVE_CHUNKS_PER_TRANSACTION));
  }
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

export function computeKeelHistoryBatchDigest(input: Pick<KeelHistoryInscriptionBatch, "batchIndex" | "firstChunkIndex" | "storedByteOffset" | "storedByteLength" | "chunkDigests">): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "bytes32[]" },
    ],
    [
      KEEL_HISTORY_BATCH_COMMITMENT_DOMAIN,
      input.batchIndex,
      input.firstChunkIndex,
      BigInt(input.storedByteOffset),
      BigInt(input.storedByteLength),
      input.chunkDigests,
    ],
  ));
}

function isKeelCompression(value: unknown): value is Compression {
  return value === "none" || value === "gzip" || value === "deflate" || value === "brotli";
}

function normalizeKeelChainId(value: KeelEip155ChainId): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError("The KEEL chain ID cannot be negative.");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("The KEEL chain ID must be a non-negative safe integer.");
  return BigInt(value);
}

/** Encodes the SDK compression label exactly as the history contract's uint8. */
export function keelCompressionCode(compression: Compression): number {
  switch (compression) {
    case "none": return 0;
    case "gzip": return 1;
    case "deflate": return 2;
    case "brotli": return 3;
    default: throw new TypeError("The KEEL compression is unsupported.");
  }
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && BYTES32_PATTERN.test(value);
}

function assertBytes32(value: unknown, label: string): asserts value is Hex {
  if (!isBytes32(value)) throw new TypeError(`The KEEL ${label} must be a bytes32 value.`);
}

function assertBytes32Array(value: readonly Hex[], label: string): void {
  value.forEach((digest) => assertBytes32(digest, label));
}

function canonicalCheckpointStorageMode(mode: KeelPublicationStorageMode | KeelLegacyNativeStorageMode): KeelPublicationStorageMode {
  if (mode === "native") return KEEL_NATIVE_CARRIER_V1;
  return selectKeelPublicationStorageMode(mode);
}
