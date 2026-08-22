export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export enum GateLogic {
  All = 0,
  Any = 1,
}

export enum SignatureMode {
  None = 0,
  Creator = 1,
  Platform = 2,
  Either = 3,
}

export enum AccessFlag {
  Merkle = 1 << 0,
  TokenBalance = 1 << 1,
  CustomGate = 1 << 2,
}

export enum GateTokenStandard {
  ERC20 = 0,
  ERC721Balance = 1,
  ERC721Token = 2,
  ERC1155 = 3,
}

export enum KeelDigestAlgorithm {
  Sha256 = 0,
  Keccak256 = 1,
}

export enum KeelCompression {
  None = 0,
  Gzip = 1,
  Deflate = 2,
  Brotli = 3,
}

export enum KeelObjectEditPolicy {
  Immutable = 0,
  Creator = 1,
  TokenOwner = 2,
  CreatorOrTokenOwner = 3,
}

export enum KeelViewerEditPolicy {
  Immutable = 0,
  Creator = 1,
}

export enum KeelForkPolicy {
  Disabled = 0,
  TokenOwner = 1,
}

export enum KeelFidelity {
  Preview = 0,
  HighResolution = 1,
  HybridMirror = 2,
}

export enum KeelLocatorScheme {
  Https = 0,
  Ipfs = 1,
  Ipns = 2,
  Arweave = 3,
}

export enum EquipmentAssetStandard {
  ERC721 = 0,
  ERC1155 = 1,
}

/** Slot 8 is the intentional v1 completion of the prototype's documented third add-on. */
export enum EquipmentSlot {
  Head = 0,
  Body = 1,
  Legs = 2,
  Shirt = 3,
  Eyes = 4,
  Weapon = 5,
  AddonOne = 6,
  AddonTwo = 7,
  AddonThree = 8,
}

/** Values preserve the historical OneMint numeric mode assignments. */
export enum OneMintStageKind {
  Off = 0,
  Allowlist = 1,
  Public = 2,
  ProofOfWorkUnsupported = 3,
  AuctionUnsupported = 4,
  NeuralPaymentUnsupported = 5,
  TokenPayment = 6,
  AirdropUnsupported = 7,
  Claim = 8,
  Premint = 9,
  End = 10,
  CustomGateUnsupported = 11,
  /** Onchain Merkle root plus per-wallet allowance; no signer is required. */
  Merkle = 12,
}

export interface KeelViewerSlots {
  readonly objectIds: readonly Hex[];
  readonly objectRevisions: readonly (bigint | number)[];
}

export interface KeelFidelityLinkInput {
  readonly fidelity: KeelFidelity;
  readonly scheme: KeelLocatorScheme;
  readonly digestAlgorithm: KeelDigestAlgorithm;
  readonly compression: KeelCompression;
  readonly uri: string;
  readonly mediaType: string;
  readonly decodedDigest: Hex;
  readonly provenanceDigest: Hex;
  readonly byteLength: bigint | number;
}

export interface KeelEquipmentDefinitionInput {
  readonly assetCollection: Address;
  readonly assetTokenId: bigint | number;
  readonly standard: EquipmentAssetStandard;
  readonly slot: EquipmentSlot;
  readonly objectId: Hex;
  readonly objectRevision: bigint | number;
  /** Character-catalog metadata, independent of the verified object revision metadata. */
  readonly catalogMetadataDigest: Hex;
}

export interface OneMintStageConfig {
  readonly kind: OneMintStageKind;
  readonly startTime: bigint | number;
  readonly endTime: bigint | number;
  readonly unitPrice?: bigint | number;
  readonly paymentAsset?: Address;
  readonly signer?: Address;
  readonly entitlementToken?: Address;
  readonly maxPerTransaction?: bigint | number;
  readonly maxPerWallet?: bigint | number;
  readonly metadataDigest: Hex;
}

export interface OneMintDropInput {
  readonly target: Address;
  readonly payout: Address;
  readonly supply: bigint | number;
  readonly maxPerTransaction: bigint | number;
  readonly maxPerWallet: bigint | number;
  readonly stages: readonly OneMintStageConfig[];
  readonly metadataDigest: Hex;
}

export interface CampaignInput {
  readonly target: Address;
  readonly adapter?: Address;
  readonly payout: Address;
  readonly paymentToken?: Address;
  readonly creatorSigner?: Address;
  readonly startTime?: bigint | number;
  readonly endTime?: bigint | number;
  readonly maxSupply: bigint | number;
  readonly maxPerWallet: bigint | number;
  readonly unitPrice?: bigint | number;
  readonly merkleRoot?: Hex;
  readonly gateToken?: Address;
  readonly gateTokenId?: bigint | number;
  readonly gateMinBalance?: bigint | number;
  readonly gateTokenStandard?: GateTokenStandard;
  readonly customGate?: Address;
  readonly customGateData?: Hex;
  readonly gateLogic?: GateLogic;
  readonly signatureMode?: SignatureMode;
  readonly metadataHash?: Hex;
}

export interface CampaignConfig {
  readonly target: Address;
  readonly adapter: Address;
  readonly payout: Address;
  readonly paymentToken: Address;
  readonly creatorSigner: Address;
  readonly startTime: bigint;
  readonly endTime: bigint;
  readonly maxSupply: bigint;
  readonly maxPerWallet: bigint;
  readonly unitPrice: bigint;
  readonly merkleRoot: Hex;
  readonly gateToken: Address;
  readonly gateTokenId: bigint;
  readonly gateMinBalance: bigint;
  readonly gateTokenStandard: GateTokenStandard;
  readonly customGate: Address;
  readonly customGateData: Hex;
  readonly gateLogic: GateLogic;
  readonly signatureMode: SignatureMode;
  readonly accessFlags: number;
  readonly metadataHash: Hex;
}

export interface MintAuthorization {
  readonly campaignId: Hex;
  readonly account: Address;
  readonly signer: Address;
  readonly maxQuantity: bigint | number;
  readonly unitPrice: bigint | number;
  readonly nonce: bigint | number;
  readonly deadline: bigint | number;
  readonly contextHash?: Hex;
}

export interface MintProof {
  readonly allowance: bigint | number;
  readonly merkleProof?: readonly Hex[];
  readonly authorization?: MintAuthorization;
  readonly signature?: Hex;
  readonly customData?: Hex;
  readonly mintData?: Hex;
}

export interface Eip712TypedData<TMessage extends Readonly<Record<string, unknown>>> {
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: bigint | number;
    readonly verifyingContract: Address;
  };
  readonly primaryType: string;
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly message: TMessage;
}
