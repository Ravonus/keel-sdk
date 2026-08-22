import {
  createCollectionAuthorizationTypedData,
  parseKeelWalletLink,
  verifyKeelWalletLink,
  type CollectionAuthorizationMessage,
  type Address,
  type Eip712TypedData,
  type KeelWalletLinkEnvelope,
} from "@keel/sdk";
import type { Hex } from "@keel/protocol";
import {
  decodeEventLog,
  encodeFunctionData,
  hashTypedData,
  parseAbi,
  type Hex as ViemHex,
} from "viem";
import {
  createKeelFactoryConfigDigest,
  normalizeKeelFactoryCollectionConfig,
  type KeelFactoryCollectionConfig,
} from "./keel-factory-config.js";

const FACTORY_ABI = parseAbi([
  "function castDieFor(address creator,(string name,string symbol,address admin,address royaltyReceiver,uint96 royaltyBps,uint256 maxSupply,address mintManager,address keelIndex) config,uint64 deadline,uint256 nonce,bytes signature) returns (address collection)",
  "event DieCastByAgent(address indexed collection,address indexed creator,address indexed agent,uint256 nonce,bytes32 authorizationDigest,bytes32 configDigest)",
  "event DieCast(address indexed collection,address indexed creator,address indexed admin,string name,string symbol,uint256 maxSupply)",
]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/u;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/u;
const DIGEST = /^0x[0-9a-f]{64}$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const MAX_AUTHORIZATION_LIFETIME = 30 * 24 * 60 * 60;

type FactoryTypedData = Eip712TypedData<CollectionAuthorizationMessage>;

export interface KeelFactoryAccountSigner {
  readonly account?: Address;
  readonly address?: Address;
  readonly getAddress?: () => Promise<Address>;
  readonly signTypedData: (input: { readonly account: Address; readonly typedData: FactoryTypedData }) => Promise<Hex>;
}

export interface KeelFactoryAgentWallet {
  readonly account: Address;
  readonly getChainId: () => Promise<number>;
  readonly sendTransaction: (input: { readonly account: Address; readonly chainId: number; readonly to: Address; readonly data: Hex; readonly value: bigint }) => Promise<Hex>;
}

export interface KeelFactoryReceiptLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface KeelFactoryTransactionReceipt {
  readonly status: "success" | "reverted";
  readonly transactionHash: Hex;
  readonly to: Address | null;
  readonly logs: readonly KeelFactoryReceiptLog[];
}

export interface KeelFactoryPublicClient {
  readonly getChainId: () => Promise<number>;
  readonly getChainTimestamp: () => Promise<number>;
  readonly readContract: (input: {
    readonly address: Address;
    readonly functionName: "FACTORY_VERSION" | "dieCreationCodeHash" | "creatorNonces";
    readonly args?: readonly unknown[];
  }) => Promise<unknown>;
  readonly simulateTransaction: (input: {
    readonly account: Address;
    readonly chainId: number;
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
  }) => Promise<void>;
  readonly waitForTransactionReceipt: (input: { readonly hash: Hex }) => Promise<KeelFactoryTransactionReceipt>;
}

export interface KeelFactoryExecutionInput {
  readonly link: unknown;
  readonly collectionConfig: unknown;
  readonly nowSeconds: number;
  readonly mode?: "dry-run" | "execute";
  readonly trustedDeployment?: KeelFactoryTrustedDeployment;
  readonly accountSigner?: KeelFactoryAccountSigner;
  readonly agentWallet?: KeelFactoryAgentWallet;
  readonly publicClient?: KeelFactoryPublicClient;
}

export interface KeelFactoryTrustedDeployment {
  readonly chainId: number;
  readonly factoryAddress: Address;
  readonly factoryVersion: Hex;
  readonly creationCodeHash: Hex;
}

export interface KeelFactoryUnsignedTransaction {
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly valueWei: "0";
}

export interface KeelFactoryDryRun {
  readonly status: "dry-run";
  readonly execution: "not-performed";
  readonly chainReady: false;
  readonly link: KeelWalletLinkEnvelope;
  readonly collectionConfig: KeelFactoryCollectionConfig;
  readonly configDigestVerified: true;
  readonly walletApproval: "required";
  readonly signing: "not-performed";
  readonly simulation: "not-performed";
  readonly submission: "not-performed";
  readonly typedData: FactoryTypedData;
  readonly unsignedTransaction: KeelFactoryUnsignedTransaction;
}

export interface KeelFactoryExecuted {
  readonly status: "executed";
  readonly execution: "submitted-and-verified";
  readonly chainReady: true;
  readonly transactionHash: Hex;
  readonly collectionAddress: Address;
  readonly configDigestVerified: true;
  readonly walletApproval: "account-signed";
  readonly signing: "performed";
  readonly simulation: "performed";
  readonly submission: "performed";
  readonly link: KeelWalletLinkEnvelope;
  readonly collectionConfig: KeelFactoryCollectionConfig;
  readonly unsignedTransaction: KeelFactoryUnsignedTransaction;
}

export interface KeelFactoryExecutionDeferred {
  readonly status: "deferred";
  readonly execution: "not-performed";
  readonly chainReady: false;
  readonly walletApproval: "required" | "account-signed";
  readonly signing: "not-performed" | "performed";
  readonly simulation: "not-performed" | "rejected";
  readonly submission: "not-performed";
  readonly code: "link-invalid" | "link-expired" | "link-revoked" | "config-invalid" | "config-mismatch" | "deployment-unverified" | "missing-connector" | "chain-mismatch" | "factory-mismatch" | "nonce-mismatch" | "signature-invalid" | "simulation-rejected" | "submission-unknown" | "receipt-unknown" | "transaction-reverted" | "event-missing" | "event-mismatch";
  readonly issues: readonly string[];
}

export type KeelFactoryExecutionResult = KeelFactoryDryRun | KeelFactoryExecuted | KeelFactoryExecutionDeferred;

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${label} is not an Ethereum address.`);
  const normalized = value.toLowerCase();
  if (normalized === ZERO_ADDRESS) throw new TypeError(`${label} cannot be the zero address.`);
  return normalized as Address;
}

function digest(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !DIGEST.test(value) || value === ZERO_DIGEST) throw new TypeError(`${label} must be non-zero lower-case bytes32.`);
  return value as `0x${string}`;
}

function signature(value: unknown): Hex {
  if (typeof value !== "string" || !HEX.test(value)) throw new TypeError("account signature must be non-empty even-length hexadecimal.");
  return value.toLowerCase() as Hex;
}

function strictTransactionHash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new TypeError("transaction hash must be bytes32 hexadecimal.");
  return value.toLowerCase() as Hex;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a safe non-negative integer.`);
  return value;
}

function bigintValue(value: unknown, label: string): bigint {
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new TypeError();
    const result = typeof value === "bigint" ? value : BigInt(value as string | number);
    if (result < 0n) throw new TypeError();
    return result;
  } catch {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function deferred(code: KeelFactoryExecutionDeferred["code"], issues: readonly string[]): KeelFactoryExecutionDeferred {
  return { status: "deferred", execution: "not-performed", chainReady: false, walletApproval: "required", signing: "not-performed", simulation: "not-performed", submission: "not-performed", code, issues };
}

function simulationRejected(issues: readonly string[]): KeelFactoryExecutionDeferred {
  return { status: "deferred", execution: "not-performed", chainReady: false, walletApproval: "account-signed", signing: "performed", simulation: "rejected", submission: "not-performed", code: "simulation-rejected", issues };
}

function configTuple(config: KeelFactoryCollectionConfig): readonly unknown[] {
  return [config.name, config.symbol, config.admin, config.royaltyReceiver, config.royaltyBps, config.maxSupply, config.mintManager, config.keelIndex];
}

function unsignedTransaction(link: KeelWalletLinkEnvelope, config: KeelFactoryCollectionConfig, signatureValue: Hex): KeelFactoryUnsignedTransaction {
  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "castDieFor",
    args: [link.accountAddress, configTuple(config), BigInt(link.expiresAt), BigInt(link.target.authorizationNonce), signatureValue],
  } as never) as Hex;
  return { chainId: link.target.chainId, from: link.agentAddress as Address, to: link.target.factoryAddress, data, valueWei: "0" };
}

function typedData(link: KeelWalletLinkEnvelope): FactoryTypedData {
  return createCollectionAuthorizationTypedData(link.target.chainId, link.target.factoryAddress, {
    creator: link.accountAddress as Address,
    agent: link.agentAddress as Address,
    nonce: BigInt(link.target.authorizationNonce),
    deadline: BigInt(link.expiresAt),
    configDigest: link.target.configDigest,
  });
}

async function signerAddress(signer: KeelFactoryAccountSigner): Promise<Address | undefined> {
  if (signer.getAddress !== undefined) return address(await signer.getAddress(), "account signer account");
  if (signer.address !== undefined) return address(signer.address, "account signer account");
  if (signer.account !== undefined) return address(signer.account, "account signer account");
  return undefined;
}

async function normalizeInput(input: KeelFactoryExecutionInput): Promise<{ link: KeelWalletLinkEnvelope; config: KeelFactoryCollectionConfig; typed: FactoryTypedData; nowSeconds: number } | KeelFactoryExecutionDeferred> {
  const nowSeconds = numberValue(input.nowSeconds, "executor.nowSeconds");
  let link: KeelWalletLinkEnvelope;
  try {
    link = parseKeelWalletLink(input.link);
  } catch (error) {
    return deferred("link-invalid", [error instanceof Error ? error.message : String(error)]);
  }
  const verification = await verifyKeelWalletLink(link, { nowSeconds });
  if (!verification.valid) {
    if (verification.revoked) return deferred("link-revoked", verification.issues);
    if (verification.expired) return deferred("link-expired", verification.issues);
    return deferred("link-invalid", verification.issues);
  }
  let config: KeelFactoryCollectionConfig;
  try {
    config = normalizeKeelFactoryCollectionConfig(input.collectionConfig);
    const computed = createKeelFactoryConfigDigest(config);
    if (computed !== link.target.configDigest) return deferred("config-mismatch", ["collectionConfig digest does not match wallet-link.target.configDigest."]);
  } catch (error) {
    return deferred("config-invalid", [error instanceof Error ? error.message : String(error)]);
  }
  return { link, config, typed: typedData(link), nowSeconds };
}

async function validateChain(client: KeelFactoryPublicClient, wallet: KeelFactoryAgentWallet, link: KeelWalletLinkEnvelope): Promise<KeelFactoryExecutionDeferred | undefined> {
  const [chainId, walletChainId, chainTimestamp] = await Promise.all([client.getChainId(), wallet.getChainId(), client.getChainTimestamp()]);
  if (chainId !== link.target.chainId || walletChainId !== link.target.chainId) return deferred("chain-mismatch", [`Expected chain ${link.target.chainId}, got public=${chainId}, wallet=${walletChainId}.`]);
  numberValue(chainTimestamp, "connected chain timestamp");
  if (link.expiresAt <= chainTimestamp) return deferred("link-expired", ["The authorization deadline has expired on the connected chain."]);
  if (link.expiresAt > chainTimestamp + MAX_AUTHORIZATION_LIFETIME) return deferred("link-invalid", ["The authorization deadline exceeds the KeelFactory lifetime limit on the connected chain."]);
  const [version, creationCodeHash, nonce] = await Promise.all([
    client.readContract({ address: link.target.factoryAddress, functionName: "FACTORY_VERSION" }),
    client.readContract({ address: link.target.factoryAddress, functionName: "dieCreationCodeHash" }),
    client.readContract({ address: link.target.factoryAddress, functionName: "creatorNonces", args: [link.accountAddress] }),
  ]);
  if (typeof version !== "string" || version.toLowerCase() !== link.target.factoryVersion) return deferred("factory-mismatch", ["FACTORY_VERSION does not match the wallet-link target."]);
  if (typeof creationCodeHash !== "string" || creationCodeHash.toLowerCase() !== link.target.creationCodeHash) return deferred("factory-mismatch", ["dieCreationCodeHash does not match the wallet-link target."]);
  if (bigintValue(nonce, "creatorNonces") !== BigInt(link.target.authorizationNonce)) return deferred("nonce-mismatch", ["The creator nonce has changed or this authorization was already consumed."]);
  return undefined;
}

function typedAuthorizationDigest(typed: FactoryTypedData): `0x${string}` {
  return hashTypedData({
    domain: typed.domain,
    types: { CollectionAuthorization: typed.types.CollectionAuthorization },
    primaryType: "CollectionAuthorization",
    message: typed.message,
  } as never).toLowerCase() as `0x${string}`;
}

function validateTrustedDeployment(value: KeelFactoryTrustedDeployment | undefined, link: KeelWalletLinkEnvelope): KeelFactoryExecutionDeferred | undefined {
  if (value === undefined) return deferred("deployment-unverified", ["Execute mode requires an externally trusted factory deployment pin."]);
  try {
    if (numberValue(value.chainId, "trusted deployment chainId") !== link.target.chainId) return deferred("factory-mismatch", ["Trusted deployment chain does not match wallet-link.target.chainId."]);
    if (address(value.factoryAddress, "trusted deployment factoryAddress") !== link.target.factoryAddress) return deferred("factory-mismatch", ["Trusted deployment factory does not match wallet-link.target.factoryAddress."]);
    if (digest(value.factoryVersion.toLowerCase(), "trusted deployment factoryVersion") !== link.target.factoryVersion) return deferred("factory-mismatch", ["Trusted deployment FACTORY_VERSION does not match wallet-link.target.factoryVersion."]);
    if (digest(value.creationCodeHash.toLowerCase(), "trusted deployment creationCodeHash") !== link.target.creationCodeHash) return deferred("factory-mismatch", ["Trusted deployment creation code hash does not match wallet-link.target.creationCodeHash."]);
    return undefined;
  } catch (error) {
    return deferred("deployment-unverified", [error instanceof Error ? error.message : String(error)]);
  }
}

function eventFromReceipt(
  receipt: KeelFactoryTransactionReceipt,
  link: KeelWalletLinkEnvelope,
  config: KeelFactoryCollectionConfig,
  typed: FactoryTypedData,
  submittedHash: Hex,
): Address | KeelFactoryExecutionDeferred {
  if (receipt.status !== "success") return deferred("transaction-reverted", ["The KeelFactory transaction reverted."]);
  try {
    if (address(receipt.to, "receipt.to") !== link.target.factoryAddress) return deferred("event-mismatch", ["Receipt target does not match the pinned KeelFactory."]);
    if (strictTransactionHash(receipt.transactionHash) !== submittedHash.toLowerCase()) return deferred("event-mismatch", ["Receipt transaction hash does not match the submitted transaction."]);
    if (!Array.isArray(receipt.logs)) return deferred("event-mismatch", ["Receipt logs are malformed."]);
  } catch (error) {
    return deferred("event-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  const expectedAuthorizationDigest = typedAuthorizationDigest(typed);
  const factory = link.target.factoryAddress;
  let byAgent: Address | undefined;
  let created: Address | undefined;
  for (const log of receipt.logs) {
    if (log === null || typeof log !== "object" || !ADDRESS.test(log.address) || !BYTES.test(log.data) || !Array.isArray(log.topics)) return deferred("event-mismatch", ["Receipt contains a malformed event log."]);
    let decoded: { readonly eventName?: unknown; readonly args?: unknown };
    try {
      decoded = decodeEventLog({ abi: FACTORY_ABI, data: log.data as ViemHex, topics: log.topics as readonly ViemHex[] } as never) as typeof decoded;
    } catch {
      continue;
    }
    if (decoded.eventName !== "DieCastByAgent" && decoded.eventName !== "DieCast") continue;
    if (log.address.toLowerCase() !== factory) return deferred("event-mismatch", ["DieCast event came from the wrong factory address."]);
    const args = decoded.args as Record<string, unknown>;
    try {
      if (decoded.eventName === "DieCastByAgent") {
        const collection = address(args.collection, "DieCastByAgent.collection");
        const creator = address(args.creator, "DieCastByAgent.creator");
        const agent = address(args.agent, "DieCastByAgent.agent");
        const nonce = bigintValue(args.nonce, "DieCastByAgent.nonce");
        const authorizationDigest = digest(String(args.authorizationDigest).toLowerCase(), "DieCastByAgent.authorizationDigest");
        const configDigest = digest(String(args.configDigest).toLowerCase(), "DieCastByAgent.configDigest");
        if (creator !== link.accountAddress || agent !== link.agentAddress || nonce !== BigInt(link.target.authorizationNonce) || authorizationDigest !== expectedAuthorizationDigest || configDigest !== link.target.configDigest) return deferred("event-mismatch", ["DieCastByAgent fields do not match the signed wallet-link target."]);
        if (byAgent !== undefined) return deferred("event-mismatch", ["Receipt contains multiple DieCastByAgent events."]);
        byAgent = collection;
      } else {
        const collection = address(args.collection, "DieCast.collection");
        const creator = address(args.creator, "DieCast.creator");
        const admin = address(args.admin, "DieCast.admin");
        if (creator !== link.accountAddress || admin !== config.admin || args.name !== config.name || args.symbol !== config.symbol || bigintValue(args.maxSupply, "DieCast.maxSupply") !== BigInt(config.maxSupply)) return deferred("event-mismatch", ["DieCast fields do not match the reviewed collectionConfig."]);
        if (created !== undefined) return deferred("event-mismatch", ["Receipt contains multiple DieCast events."]);
        created = collection;
      }
    } catch {
      return deferred("event-mismatch", ["DieCast event fields could not be validated."]);
    }
  }
  if (byAgent === undefined || created === undefined) return deferred("event-missing", ["Receipt must contain matching DieCast and DieCastByAgent events."]);
  if (byAgent !== created) return deferred("event-mismatch", ["DieCast events refer to different collection addresses."]);
  return byAgent;
}

/** Prepare a review-only call or explicitly execute it through injected connectors. */
export async function executeKeelFactoryCollection(input: KeelFactoryExecutionInput): Promise<KeelFactoryExecutionResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return deferred("link-invalid", ["executor input must be an object."]);
  const normalized = await normalizeInput(input);
  if ("status" in normalized) return normalized;
  const { link, config, typed } = normalized;
  const mode = input.mode ?? "dry-run";
  if (mode !== "dry-run" && mode !== "execute") throw new TypeError("executor.mode must be dry-run or execute.");
  if (mode === "dry-run") {
    const unsigned = unsignedTransaction(link, config, "0x" as Hex);
    return { status: "dry-run", execution: "not-performed", chainReady: false, walletApproval: "required", signing: "not-performed", simulation: "not-performed", submission: "not-performed", link, collectionConfig: config, configDigestVerified: true, typedData: typed, unsignedTransaction: unsigned };
  }
  if (input.accountSigner === undefined || input.agentWallet === undefined || input.publicClient === undefined) return deferred("missing-connector", ["Execute mode requires injected account signer, agent wallet, and public read client."]);
  const deploymentError = validateTrustedDeployment(input.trustedDeployment, link);
  if (deploymentError !== undefined) return deploymentError;
  let agent: Address;
  try {
    agent = address(input.agentWallet.account, "agent wallet account");
  } catch (error) {
    return deferred("factory-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  if (agent !== link.agentAddress) return deferred("factory-mismatch", ["Injected agent wallet does not match wallet-link.agentAddress."]);
  let signer: Address | undefined;
  try {
    signer = await signerAddress(input.accountSigner);
  } catch (error) {
    return deferred("factory-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  if (signer === undefined) return deferred("missing-connector", ["Account signer must expose account, address, or getAddress()."]);
  if (signer !== link.accountAddress) return deferred("factory-mismatch", ["Injected account signer does not match wallet-link.accountAddress."]);
  let chainError: KeelFactoryExecutionDeferred | undefined;
  try {
    chainError = await validateChain(input.publicClient, input.agentWallet, link);
  } catch (error) {
    return deferred("factory-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  if (chainError !== undefined) return chainError;
  let signed: Hex;
  try {
    signed = signature(await input.accountSigner.signTypedData({ account: link.accountAddress as Address, typedData: typed }));
  } catch (error) {
    return deferred("signature-invalid", [error instanceof Error ? error.message : String(error)]);
  }
  try {
    const nonce = await input.publicClient.readContract({ address: link.target.factoryAddress, functionName: "creatorNonces", args: [link.accountAddress] });
    if (bigintValue(nonce, "creatorNonces") !== BigInt(link.target.authorizationNonce)) return deferred("nonce-mismatch", ["The creator nonce changed after signing; no transaction was sent."]);
  } catch (error) {
    return deferred("nonce-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  try {
    const walletChainId = numberValue(await input.agentWallet.getChainId(), "agent wallet chainId");
    if (walletChainId !== link.target.chainId) return deferred("chain-mismatch", ["The agent wallet changed chains after signing; no transaction was sent."]);
  } catch (error) {
    return deferred("chain-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  const unsigned = unsignedTransaction(link, config, signed);
  try {
    await input.publicClient.simulateTransaction({
      account: agent,
      chainId: link.target.chainId,
      to: unsigned.to,
      data: unsigned.data,
      value: 0n,
    });
  } catch (error) {
    return simulationRejected([error instanceof Error ? error.message : String(error)]);
  }
  let transactionHash: Hex;
  try {
    transactionHash = strictTransactionHash(await input.agentWallet.sendTransaction({ account: agent, chainId: link.target.chainId, to: unsigned.to, data: unsigned.data, value: 0n }));
  } catch (error) {
    return deferred("submission-unknown", [error instanceof Error ? error.message : String(error)]);
  }
  let receipt: KeelFactoryTransactionReceipt;
  try {
    receipt = await input.publicClient.waitForTransactionReceipt({ hash: transactionHash });
  } catch (error) {
    return deferred("receipt-unknown", [error instanceof Error ? error.message : String(error)]);
  }
  const event = eventFromReceipt(receipt, link, config, typed, transactionHash);
  if (typeof event !== "string") return event;
  try {
    const finalNonce = bigintValue(await input.publicClient.readContract({ address: link.target.factoryAddress, functionName: "creatorNonces", args: [link.accountAddress] }), "creatorNonces");
    if (finalNonce < BigInt(link.target.authorizationNonce) + 1n) return deferred("nonce-mismatch", ["The receipt did not advance the creator nonce past the authorized value."]);
  } catch (error) {
    return deferred("nonce-mismatch", [error instanceof Error ? error.message : String(error)]);
  }
  return { status: "executed", execution: "submitted-and-verified", chainReady: true, walletApproval: "account-signed", signing: "performed", simulation: "performed", submission: "performed", transactionHash, collectionAddress: event, configDigestVerified: true, link, collectionConfig: config, unsignedTransaction: unsigned };
}
