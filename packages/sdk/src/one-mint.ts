import {
  OneMintStageKind,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type Address,
  type Hex,
  type OneMintDropInput,
  type OneMintStageConfig,
} from "./types.js";
import { enumValue, normalizedAddress, normalizedBytes32, normalizedHex, uint } from "./validation.js";

const UINT16_MAX = (1n << 16n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT96_MAX = (1n << 96n) - 1n;
const MAX_STAGES = 16;

export const ONE_MINT_SUPPORTED_STAGE_KINDS = Object.freeze([
  OneMintStageKind.Off,
  OneMintStageKind.Allowlist,
  OneMintStageKind.Public,
  OneMintStageKind.TokenPayment,
  OneMintStageKind.Claim,
  OneMintStageKind.Premint,
  OneMintStageKind.End,
  OneMintStageKind.Merkle,
] as const);

export interface NormalizedOneMintStage {
  readonly kind: OneMintStageKind;
  readonly startTime: bigint;
  readonly endTime: bigint;
  readonly unitPrice: bigint;
  readonly paymentAsset: Address;
  readonly signer: Address;
  readonly entitlementToken: Address;
  readonly maxPerTransaction: bigint;
  readonly maxPerWallet: bigint;
  readonly metadataDigest: Hex;
}

export interface NormalizedOneMintDrop {
  readonly target: Address;
  readonly payout: Address;
  readonly supply: bigint;
  readonly maxPerTransaction: bigint;
  readonly maxPerWallet: bigint;
  readonly stages: readonly NormalizedOneMintStage[];
  readonly metadataDigest: Hex;
}

export interface OneMintItemDropInput extends OneMintDropInput {
  /** ERC-1155 item fixed into the drop at creation; collector mintData cannot redirect it. */
  readonly targetTokenId: bigint | number;
}

export interface NormalizedOneMintItemDrop extends NormalizedOneMintDrop {
  readonly targetTokenId: bigint;
}

export interface OneMintPerTokenMintDataInput {
  readonly quantity: bigint | number;
  /** Exact bytes consumed by each token's pre-receiver hook, in token order. */
  readonly tokenMintData?: readonly Hex[];
}

export type NormalizedOneMintMintData =
  | { readonly mode: "single"; readonly quantity: 1n; readonly slices: readonly [Hex] }
  | { readonly mode: "empty-batch"; readonly quantity: bigint; readonly slices: readonly [] }
  | { readonly mode: "per-token-batch"; readonly quantity: bigint; readonly slices: readonly Hex[] };

function normalizeStage(stage: OneMintStageConfig, index: number): NormalizedOneMintStage {
  const label = `stages[${index}]`;
  const kind = enumValue(stage.kind, ONE_MINT_SUPPORTED_STAGE_KINDS, `${label}.kind`);
  const startTime = uint(stage.startTime, 0n, `${label}.startTime`, UINT64_MAX);
  const endTime = uint(stage.endTime, 0n, `${label}.endTime`, UINT64_MAX);
  const unitPrice = uint(stage.unitPrice, 0n, `${label}.unitPrice`, UINT96_MAX);
  const paymentAsset = normalizedAddress(stage.paymentAsset, ZERO_ADDRESS, `${label}.paymentAsset`);
  const signer = normalizedAddress(stage.signer, ZERO_ADDRESS, `${label}.signer`);
  const entitlementToken = normalizedAddress(
    stage.entitlementToken,
    ZERO_ADDRESS,
    `${label}.entitlementToken`,
  );
  const maxPerTransaction = uint(
    stage.maxPerTransaction,
    0n,
    `${label}.maxPerTransaction`,
    UINT32_MAX,
  );
  const maxPerWallet = uint(stage.maxPerWallet, 0n, `${label}.maxPerWallet`, UINT32_MAX);
  const metadataDigest = normalizedBytes32(stage.metadataDigest, ZERO_BYTES32, `${label}.metadataDigest`);

  if (startTime >= endTime) throw new RangeError(`${label} must end after it starts.`);
  if (metadataDigest === ZERO_BYTES32) throw new TypeError(`${label}.metadataDigest cannot be zero.`);

  const signed = kind === OneMintStageKind.Allowlist || kind === OneMintStageKind.Claim;
  if (signed !== (signer !== ZERO_ADDRESS)) {
    throw new TypeError(`${label}.signer must be set exactly for allowlist and claim stages.`);
  }
  if ((kind === OneMintStageKind.Claim) !== (entitlementToken !== ZERO_ADDRESS)) {
    throw new TypeError(`${label}.entitlementToken must be set exactly for claim stages.`);
  }
  if (kind === OneMintStageKind.TokenPayment && paymentAsset === ZERO_ADDRESS) {
    throw new TypeError(`${label}.paymentAsset is required for token-payment stages.`);
  }
  if (kind === OneMintStageKind.Public && paymentAsset !== ZERO_ADDRESS) {
    throw new TypeError(`${label}.paymentAsset must be native ETH for public stages.`);
  }
  if (
    (kind === OneMintStageKind.Off || kind === OneMintStageKind.End || kind === OneMintStageKind.Premint) &&
    (unitPrice !== 0n || paymentAsset !== ZERO_ADDRESS)
  ) {
    throw new TypeError(`${label} must be free and use the native zero-address asset.`);
  }

  return Object.freeze({
    kind,
    startTime,
    endTime,
    unitPrice,
    paymentAsset,
    signer,
    entitlementToken,
    maxPerTransaction,
    maxPerWallet,
    metadataDigest,
  });
}

/**
 * Mirrors OneMintController.createDrop validation and returns immutable,
 * ABI-ready values. This is a configuration builder only; it does not persist
 * drafts or claim a drop exists before a confirmed transaction receipt.
 */
export function buildOneMintDrop(input: OneMintDropInput): NormalizedOneMintDrop {
  const target = normalizedAddress(input.target, ZERO_ADDRESS, "target");
  const payout = normalizedAddress(input.payout, ZERO_ADDRESS, "payout");
  if (target === ZERO_ADDRESS) throw new TypeError("target cannot be the zero address.");
  if (payout === ZERO_ADDRESS) throw new TypeError("payout cannot be the zero address.");

  const supply = uint(input.supply, 0n, "supply", UINT64_MAX);
  const maxPerTransaction = uint(input.maxPerTransaction, 0n, "maxPerTransaction", UINT32_MAX);
  const maxPerWallet = uint(input.maxPerWallet, 0n, "maxPerWallet", UINT32_MAX);
  const metadataDigest = normalizedBytes32(input.metadataDigest, ZERO_BYTES32, "metadataDigest");
  if (supply === 0n) throw new RangeError("supply must be greater than zero.");
  if (maxPerTransaction === 0n || maxPerTransaction > maxPerWallet) {
    throw new RangeError("maxPerTransaction must be positive and no greater than maxPerWallet.");
  }
  if (maxPerWallet === 0n || maxPerWallet > supply) {
    throw new RangeError("maxPerWallet must be positive and no greater than supply.");
  }
  if (metadataDigest === ZERO_BYTES32) throw new TypeError("metadataDigest cannot be zero.");
  if (input.stages.length === 0 || input.stages.length > MAX_STAGES) {
    throw new RangeError(`stages must contain between 1 and ${MAX_STAGES} entries.`);
  }

  const stages = input.stages.map(normalizeStage);
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (stage === undefined) continue;
    if (index > 0 && stage.startTime !== stages[index - 1]?.endTime) {
      throw new RangeError(`stages[${index}].startTime must equal the previous stage endTime.`);
    }
    const transactionLimit = stage.maxPerTransaction === 0n ? maxPerTransaction : stage.maxPerTransaction;
    const walletLimit = stage.maxPerWallet === 0n ? maxPerWallet : stage.maxPerWallet;
    if (transactionLimit === 0n || transactionLimit > walletLimit || walletLimit > supply) {
      throw new RangeError(`stages[${index}] effective limits are inconsistent with the drop supply.`);
    }
  }

  return Object.freeze({
    target,
    payout,
    supply,
    maxPerTransaction,
    maxPerWallet,
    stages: Object.freeze(stages),
    metadataDigest,
  });
}

/**
 * Mirrors OneMintController.createItemDrop. The item id is part of the
 * reviewed operation itself, never inferred from collector-controlled
 * mintData.
 */
export function buildOneMintItemDrop(input: OneMintItemDropInput): NormalizedOneMintItemDrop {
  const drop = buildOneMintDrop(input);
  const targetTokenId = uint(input.targetTokenId, 0n, "targetTokenId");
  return Object.freeze({ ...drop, targetTokenId });
}

export function oneMintStageKindName(kind: OneMintStageKind): string {
  switch (enumValue(kind, ONE_MINT_SUPPORTED_STAGE_KINDS, "stage kind")) {
    case OneMintStageKind.Off: return "Off";
    case OneMintStageKind.Allowlist: return "Allowlist";
    case OneMintStageKind.Public: return "Public";
    case OneMintStageKind.TokenPayment: return "Token payment";
    case OneMintStageKind.Claim: return "Claim";
    case OneMintStageKind.Premint: return "Premint";
    case OneMintStageKind.End: return "End";
    case OneMintStageKind.Merkle: return "Merkle";
    default: throw new RangeError("stage kind has an unsupported enum value.");
  }
}

export function oneMintActiveStageIndex(
  stages: readonly Pick<NormalizedOneMintStage, "startTime" | "endTime">[],
  timestamp: bigint | number,
): number | undefined {
  const now = uint(timestamp, 0n, "timestamp", UINT64_MAX);
  const index = stages.findIndex((stage) => now >= stage.startTime && now < stage.endTime);
  if (index < 0 || BigInt(index) > UINT16_MAX) return undefined;
  return index;
}

/**
 * Validates the Keel per-token mint-data framing before a wallet library ABI
 * encodes it. For quantity > 1, callers encode non-empty slices as
 * `abi.encode(PER_TOKEN_MINT_DATA_DOMAIN, bytes[] slices)`; an entirely empty
 * batch remains `0x`. The SDK returns slices rather than importing a wallet
 * stack, preserving framework neutrality.
 */
export function normalizeOneMintPerTokenMintData(
  input: OneMintPerTokenMintDataInput,
): NormalizedOneMintMintData {
  const quantity = uint(input.quantity, 0n, "quantity", UINT32_MAX);
  if (quantity === 0n) throw new RangeError("quantity must be greater than zero.");
  const slices = (input.tokenMintData ?? []).map((value, index) =>
    normalizedHex(value, "0x", `tokenMintData[${index}]`),
  );
  if (quantity === 1n) {
    if (slices.length > 1) throw new RangeError("quantity 1 accepts exactly one mint-data slice.");
    return Object.freeze({
      mode: "single" as const,
      quantity: 1n,
      slices: Object.freeze([slices[0] ?? "0x"] as [Hex]),
    });
  }
  if (slices.length === 0 || slices.every((slice) => slice === "0x")) {
    return Object.freeze({ mode: "empty-batch" as const, quantity, slices: Object.freeze([] as const) });
  }
  if (BigInt(slices.length) !== quantity) {
    throw new RangeError("non-empty batch mint data requires one ordered slice per token.");
  }
  return Object.freeze({ mode: "per-token-batch" as const, quantity, slices: Object.freeze(slices) });
}
