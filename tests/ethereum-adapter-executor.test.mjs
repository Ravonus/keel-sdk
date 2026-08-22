import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, hashTypedData, parseAbi } from "viem";

import { createKeelWalletLink } from "../packages/sdk/dist/index.js";
import {
  createKeelFactoryConfigDigest,
  executeKeelFactoryCollection,
} from "../packages/ethereum-adapter/dist/index.js";

const FACTORY = "0x3333333333333333333333333333333333333333";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const COLLECTION = "0x5555555555555555555555555555555555555555";
const TX_HASH = `0x${"ab".repeat(32)}`;
const FACTORY_VERSION = `0x${"44".repeat(32)}`;
const CREATION_CODE_HASH = `0x${"55".repeat(32)}`;
const EVENT_ABI = parseAbi([
  "event DieCastByAgent(address indexed collection,address indexed creator,address indexed agent,uint256 nonce,bytes32 authorizationDigest,bytes32 configDigest)",
  "event DieCast(address indexed collection,address indexed creator,address indexed admin,string name,string symbol,uint256 maxSupply)",
]);

const config = {
  name: "Agent Collection",
  symbol: "AGENT",
  admin: ACCOUNT,
  royaltyReceiver: ACCOUNT,
  royaltyBps: "250",
  maxSupply: "100",
  mintManager: "0x0000000000000000000000000000000000000000",
  keelIndex: "0x0000000000000000000000000000000000000000",
};

async function fixture() {
  const configDigest = createKeelFactoryConfigDigest(config);
  const link = await createKeelWalletLink({
    family: "ethereum",
    accountAddress: ACCOUNT,
    agentAddress: AGENT,
    target: {
      chainId: 1,
      factoryAddress: FACTORY,
      factoryVersion: FACTORY_VERSION,
      creationCodeHash: CREATION_CODE_HASH,
      operation: "keelFactory.castDie",
      configDigest,
      configEncoding: "keel-factory-config-keccak@1",
      authorizationNonce: "0",
    },
    scopes: ["create-collection", "prepare"],
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_003_600,
    nonce: "executor-0",
  });
  assert.equal(link.status, "review-only");
  return {
    link,
    config,
    collectionConfig: config,
    trustedDeployment: { chainId: 1, factoryAddress: FACTORY, factoryVersion: FACTORY_VERSION, creationCodeHash: CREATION_CODE_HASH },
    nowSeconds: 1_800_000_100,
    configDigest,
  };
}

function eventLog(digest, { includeByAgent = true, includeCreated = true, authorizationDigest = undefined, address = FACTORY, createdName = config.name, createdSymbol = config.symbol, createdMaxSupply = config.maxSupply } = {}) {
  const logs = [];
  if (includeCreated) {
    const topics = encodeEventTopics({ abi: EVENT_ABI, eventName: "DieCast", args: [COLLECTION, ACCOUNT, ACCOUNT] });
    const data = encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "uint256" }], [createdName, createdSymbol, BigInt(createdMaxSupply)]);
    logs.push({ address, topics, data });
  }
  if (includeByAgent) {
    const topics = encodeEventTopics({ abi: EVENT_ABI, eventName: "DieCastByAgent", args: [COLLECTION, ACCOUNT, AGENT] });
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }], [0n, authorizationDigest ?? `0x${"00".repeat(32)}`, digest]);
    logs.push({ address, topics, data });
  }
  return logs;
}

function clientFor(link, digest, overrides = {}) {
  const calls = [];
  let nonceReads = 0;
  const receipt = {
    status: "success",
    transactionHash: TX_HASH,
    to: FACTORY,
    logs: eventLog(digest, overrides),
  };
  return {
    calls,
    getChainId: async () => overrides.chainId ?? 1,
    getChainTimestamp: async () => overrides.timestamp ?? 1_800_000_100,
    readContract: async (request) => {
      calls.push(request);
      if (request.functionName === "FACTORY_VERSION") return overrides.factoryVersion ?? FACTORY_VERSION;
      if (request.functionName === "dieCreationCodeHash") return overrides.creationCodeHash ?? CREATION_CODE_HASH;
      nonceReads += 1;
      return overrides.nonce ?? (nonceReads >= 3 ? 1n : 0n);
    },
    simulateTransaction: async (request) => {
      calls.push({ functionName: "simulateTransaction", ...request });
      if (overrides.simulationError !== undefined) throw overrides.simulationError;
    },
    waitForTransactionReceipt: async () => overrides.receipt ?? receipt,
  };
}

async function executeFixture(overrides = {}) {
  const base = await fixture();
  const dry = await executeKeelFactoryCollection({ ...base, mode: "dry-run" });
  assert.equal(dry.status, "dry-run");
  const authorizationDigest = hashTypedData(dry.typedData);
  const client = clientFor(base.link, base.configDigest, { ...overrides, receipt: overrides.receipt ?? { status: "success", transactionHash: TX_HASH, to: FACTORY, logs: eventLog(base.configDigest, { ...overrides, authorizationDigest }) } });
  const sent = [];
  const signerCalls = [];
  const result = await executeKeelFactoryCollection({
    ...base,
    mode: "execute",
    accountSigner: {
      getAddress: async () => ACCOUNT,
      signTypedData: async (request) => { signerCalls.push(request); return "0x1234"; },
    },
    agentWallet: {
      account: AGENT,
      getChainId: async () => overrides.walletChainId ?? 1,
      sendTransaction: async (request) => { sent.push(request); return TX_HASH; },
    },
    publicClient: client,
  });
  return { result, dry, client, sent, signerCalls, base };
}

test("KeelFactory executor dry-run is deterministic and does not call connectors", async () => {
  const base = await fixture();
  let called = false;
  const result = await executeKeelFactoryCollection({
    ...base,
    mode: "dry-run",
    accountSigner: { getAddress: async () => { called = true; return ACCOUNT; }, signTypedData: async () => "0x1234" },
    agentWallet: { account: AGENT, getChainId: async () => 1, sendTransaction: async () => { called = true; return TX_HASH; } },
  });
  assert.equal(result.status, "dry-run");
  assert.equal(result.chainReady, false);
  assert.equal(result.walletApproval, "required");
  assert.equal(result.signing, "not-performed");
  assert.equal(result.simulation, "not-performed");
  assert.equal(result.submission, "not-performed");
  assert.equal(result.configDigestVerified, true);
  assert.match(result.unsignedTransaction.data, /^0x/u);
  assert.equal(called, false);
});

test("KeelFactory executor signs, submits, and verifies both creation events", async () => {
  const { result, sent, signerCalls, client } = await executeFixture();
  assert.equal(result.status, "executed");
  assert.equal(result.chainReady, true);
  assert.equal(result.walletApproval, "account-signed");
  assert.equal(result.signing, "performed");
  assert.equal(result.simulation, "performed");
  assert.equal(result.submission, "performed");
  assert.equal(result.collectionAddress, COLLECTION);
  assert.equal(result.transactionHash, TX_HASH);
  assert.equal(signerCalls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, FACTORY);
  assert.equal(sent[0].chainId, 1);
  assert.equal(client.calls.filter((call) => call.functionName === "simulateTransaction").length, 1);
  assert.equal(client.calls.filter((call) => call.functionName === "creatorNonces").length, 3);
  });

test("KeelFactory executor rejects connector identity, chain, factory, nonce, and expiry mismatches", async () => {
  const wrongSigner = await executeFixture();
  assert.equal((await executeKeelFactoryCollection({ ...wrongSigner.base, mode: "execute", accountSigner: { account: AGENT, signTypedData: async () => "0x1234" }, agentWallet: { account: AGENT, getChainId: async () => 1, sendTransaction: async () => TX_HASH }, publicClient: wrongSigner.client })).code, "factory-mismatch");
  assert.equal((await executeFixture({ chainId: 2 })).result.code, "chain-mismatch");
  assert.equal((await executeFixture({ factoryVersion: `0x${"66".repeat(32)}` })).result.code, "factory-mismatch");
  assert.equal((await executeFixture({ nonce: 7n })).result.code, "nonce-mismatch");
  assert.equal((await executeFixture({ nonce: 0n })).result.code, "nonce-mismatch");
  assert.equal((await executeFixture({ walletChainId: 2 })).result.code, "chain-mismatch");
  assert.equal((await executeFixture({ timestamp: 1_700_000_000 })).result.code, "link-invalid");
  const expired = await fixture();
  assert.equal((await executeKeelFactoryCollection({ ...expired, nowSeconds: expired.link.expiresAt, mode: "dry-run" })).code, "link-expired");
  const { trustedDeployment: _pin, ...withoutPin } = wrongSigner.base;
  assert.equal((await executeKeelFactoryCollection({ ...withoutPin, mode: "execute", accountSigner: { account: ACCOUNT, signTypedData: async () => "0x1234" }, agentWallet: { account: AGENT, getChainId: async () => 1, sendTransaction: async () => TX_HASH }, publicClient: wrongSigner.client })).code, "deployment-unverified");
  const signatureBase = await fixture();
  assert.equal((await executeKeelFactoryCollection({ ...signatureBase, mode: "execute", accountSigner: { account: ACCOUNT, signTypedData: async () => { throw new Error("user rejected"); } }, agentWallet: { account: AGENT, getChainId: async () => 1, sendTransaction: async () => TX_HASH }, publicClient: clientFor(signatureBase.link, signatureBase.configDigest) })).code, "signature-invalid");
  assert.equal((await executeKeelFactoryCollection({ ...wrongSigner.base, mode: "execute", trustedDeployment: wrongSigner.base.trustedDeployment })).code, "missing-connector");
  assert.equal((await executeKeelFactoryCollection(null)).code, "link-invalid");
});

test("KeelFactory executor fails closed for signature, submission, revert, hash, target, and event forgery", async () => {
  const base = await fixture();
  const dry = await executeKeelFactoryCollection({ ...base, mode: "dry-run" });
  const auth = hashTypedData(dry.typedData);
  const signer = { getAddress: async () => ACCOUNT, signTypedData: async () => "0x1234" };
  const wallet = (send) => ({ account: AGENT, getChainId: async () => 1, sendTransaction: send });
  const client = (receipt) => clientFor(base.link, base.configDigest, { receipt: { to: FACTORY, ...receipt } });
  const invoke = (publicClient, agentWallet = wallet(async () => TX_HASH), accountSigner = signer) => executeKeelFactoryCollection({ ...base, mode: "execute", accountSigner, agentWallet, publicClient });
  assert.equal((await invoke(client({ status: "success", transactionHash: TX_HASH, logs: eventLog(base.configDigest, { authorizationDigest: `0x${"99".repeat(32)}` }) }))).code, "event-mismatch");
  assert.equal((await invoke(client({ status: "success", transactionHash: TX_HASH, logs: eventLog(base.configDigest, { authorizationDigest: auth, createdName: "Mutated" }) }))).code, "event-mismatch");
  assert.equal((await invoke(client({ status: "success", transactionHash: `0x${"cd".repeat(32)}`, logs: eventLog(base.configDigest, { authorizationDigest: auth }) }))).code, "event-mismatch");
  assert.equal((await invoke(client({ status: "success", transactionHash: TX_HASH, logs: eventLog(base.configDigest, { authorizationDigest: auth, includeCreated: false }) }))).code, "event-missing");
  assert.equal((await invoke(client({ status: "reverted", transactionHash: TX_HASH, logs: [] }))).code, "transaction-reverted");
  assert.equal((await invoke(client({ status: "success", transactionHash: TX_HASH, to: "0x4444444444444444444444444444444444444444", logs: eventLog(base.configDigest, { authorizationDigest: auth }) }))).code, "event-mismatch");
  assert.equal((await invoke(client({ status: "success", transactionHash: TX_HASH, logs: eventLog(base.configDigest, { authorizationDigest: auth }) }), wallet(async () => { throw new Error("send uncertain"); }))).code, "submission-unknown");
  assert.equal((await invoke({ ...client({ status: "success", transactionHash: TX_HASH, logs: eventLog(base.configDigest, { authorizationDigest: auth }) }), waitForTransactionReceipt: async () => { throw new Error("receipt uncertain"); } })).code, "receipt-unknown");
});

test("KeelFactory executor rechecks nonce after signing and never sends stale authorizations", async () => {
  const base = await fixture();
  const client = clientFor(base.link, base.configDigest);
  let nonceReads = 0;
  const originalRead = client.readContract;
  client.readContract = async (request) => {
    if (request.functionName === "creatorNonces") {
      nonceReads += 1;
      return nonceReads === 1 ? 0n : 1n;
    }
    return originalRead(request);
  };
  let sent = 0;
  const result = await executeKeelFactoryCollection({
    ...base,
    mode: "execute",
    accountSigner: { account: ACCOUNT, signTypedData: async () => "0x1234" },
    agentWallet: { account: AGENT, getChainId: async () => 1, sendTransaction: async () => { sent += 1; return TX_HASH; } },
    publicClient: client,
  });
  assert.equal(result.code, "nonce-mismatch");
  assert.equal(nonceReads, 2);
  assert.equal(sent, 0);
});

test("KeelFactory executor simulates the signed call before agent submission", async () => {
  const { result, sent, signerCalls } = await executeFixture({ simulationError: new Error("execution reverted") });
  assert.equal(result.code, "simulation-rejected");
  assert.equal(result.walletApproval, "account-signed");
  assert.equal(result.signing, "performed");
  assert.equal(result.simulation, "rejected");
  assert.equal(result.submission, "not-performed");
  assert.equal(signerCalls.length, 1);
  assert.equal(sent.length, 0);
});
