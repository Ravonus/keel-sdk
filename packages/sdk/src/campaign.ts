import {
  AccessFlag,
  GateLogic,
  GateTokenStandard,
  SignatureMode,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type CampaignConfig,
  type CampaignInput,
} from "./types.js";
import {
  UINT64_MAX,
  UINT128_MAX,
  enumValue,
  hexByteLength,
  normalizedAddress,
  normalizedBytes32,
  normalizedHex,
  uint,
} from "./validation.js";

const MAX_CUSTOM_GATE_DATA_BYTES = 4_096;

export function buildCampaign(input: CampaignInput): CampaignConfig {
  const target = normalizedAddress(input.target, ZERO_ADDRESS, "target");
  if (target === ZERO_ADDRESS) throw new TypeError("target cannot be the zero address.");
  const payout = normalizedAddress(input.payout, ZERO_ADDRESS, "payout");
  if (payout === ZERO_ADDRESS) throw new TypeError("payout cannot be the zero address.");

  const startTime = uint(input.startTime, 0n, "startTime", UINT64_MAX);
  const endTime = uint(input.endTime, 0n, "endTime", UINT64_MAX);
  if (endTime !== 0n && endTime <= startTime) throw new RangeError("endTime must be zero or later than startTime.");

  const maxSupply = uint(input.maxSupply, 0n, "maxSupply", UINT64_MAX);
  const maxPerWallet = uint(input.maxPerWallet, 0n, "maxPerWallet", UINT64_MAX);
  if (maxSupply === 0n) throw new RangeError("maxSupply must be greater than zero.");
  if (maxPerWallet === 0n || maxPerWallet > maxSupply) {
    throw new RangeError("maxPerWallet must be between one and maxSupply.");
  }

  const merkleRoot = normalizedBytes32(input.merkleRoot, ZERO_BYTES32, "merkleRoot");
  const gateToken = normalizedAddress(input.gateToken, ZERO_ADDRESS, "gateToken");
  const gateMinBalance = uint(input.gateMinBalance, 0n, "gateMinBalance");
  const customGate = normalizedAddress(input.customGate, ZERO_ADDRESS, "customGate");
  const creatorSigner = normalizedAddress(input.creatorSigner, ZERO_ADDRESS, "creatorSigner");
  const signatureMode = enumValue(
    input.signatureMode ?? SignatureMode.None,
    [SignatureMode.None, SignatureMode.Creator, SignatureMode.Platform, SignatureMode.Either],
    "signatureMode",
  );
  const gateTokenStandard = enumValue(
    input.gateTokenStandard ?? GateTokenStandard.ERC20,
    [GateTokenStandard.ERC20, GateTokenStandard.ERC721Balance, GateTokenStandard.ERC721Token, GateTokenStandard.ERC1155],
    "gateTokenStandard",
  );
  const gateLogic = enumValue(input.gateLogic ?? GateLogic.All, [GateLogic.All, GateLogic.Any], "gateLogic");
  const customGateData = normalizedHex(input.customGateData, "0x", "customGateData");

  if ((signatureMode === SignatureMode.Creator || signatureMode === SignatureMode.Either) && creatorSigner === ZERO_ADDRESS) {
    throw new TypeError("creatorSigner is required by the selected signature mode.");
  }
  if (signatureMode === SignatureMode.None && creatorSigner !== ZERO_ADDRESS) {
    throw new TypeError("creatorSigner is configured while signatureMode is None.");
  }
  if (customGate === ZERO_ADDRESS && customGateData !== "0x") {
    throw new TypeError("customGateData requires a customGate contract.");
  }
  if (hexByteLength(customGateData) > MAX_CUSTOM_GATE_DATA_BYTES) {
    throw new RangeError(`customGateData cannot exceed ${MAX_CUSTOM_GATE_DATA_BYTES} bytes.`);
  }
  if (gateToken === ZERO_ADDRESS && (gateMinBalance !== 0n || input.gateTokenId !== undefined)) {
    throw new TypeError("gateTokenId/gateMinBalance require a gateToken contract.");
  }

  let accessFlags = 0;
  if (merkleRoot !== ZERO_BYTES32) accessFlags |= AccessFlag.Merkle;
  if (gateToken !== ZERO_ADDRESS) {
    if (gateMinBalance === 0n) throw new RangeError("gateMinBalance must be positive when gateToken is configured.");
    accessFlags |= AccessFlag.TokenBalance;
  }
  if (customGate !== ZERO_ADDRESS) accessFlags |= AccessFlag.CustomGate;

  return {
    target,
    adapter: normalizedAddress(input.adapter, ZERO_ADDRESS, "adapter"),
    payout,
    paymentToken: normalizedAddress(input.paymentToken, ZERO_ADDRESS, "paymentToken"),
    creatorSigner,
    startTime,
    endTime,
    maxSupply,
    maxPerWallet,
    unitPrice: uint(input.unitPrice, 0n, "unitPrice", UINT128_MAX),
    merkleRoot,
    gateToken,
    gateTokenId: uint(input.gateTokenId, 0n, "gateTokenId"),
    gateMinBalance,
    gateTokenStandard,
    customGate,
    customGateData,
    gateLogic,
    signatureMode,
    accessFlags,
    metadataHash: normalizedBytes32(input.metadataHash, ZERO_BYTES32, "metadataHash"),
  };
}

export function campaignIsPublic(config: CampaignConfig): boolean {
  return config.accessFlags === 0 && config.signatureMode === SignatureMode.None;
}

export function accessFlagNames(flags: number): readonly string[] {
  if (!Number.isSafeInteger(flags) || flags < 0 || (flags & ~7) !== 0) {
    throw new RangeError("flags contains unsupported access bits.");
  }
  const values: string[] = [];
  if ((flags & AccessFlag.Merkle) !== 0) values.push("merkle");
  if ((flags & AccessFlag.TokenBalance) !== 0) values.push("token-balance");
  if ((flags & AccessFlag.CustomGate) !== 0) values.push("custom-gate");
  return values;
}
