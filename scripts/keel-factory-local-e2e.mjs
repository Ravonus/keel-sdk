import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createOcaFactoryConfigDigest, createViemOcaFactoryConnectors, executeOcaFactoryCollection } from "@keel/ethereum-adapter";
import { createKeelWalletLink, keelFactoryAbi } from "@keel/sdk";

const PORT = Number(process.env.OCA_LOCAL_E2E_PORT ?? 18_545);
const RPC_URL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 31_337;
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CREATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ABI = parseAbi(keelFactoryAbi);
const artifactPath = path.resolve("packages/contracts/out/KeelFactory.sol/KeelFactory.json");
const LOCAL_CHAIN = {
  id: CHAIN_ID,
  name: "Keel local Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

function asHex(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) throw new TypeError("Expected a hexadecimal chain value.");
  return value;
}

async function waitForRpc(publicClient) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if (await publicClient.getChainId() === CHAIN_ID) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Anvil did not become ready: ${lastError instanceof Error ? lastError.message : "unknown RPC error"}`);
}

async function deployFactory(wallet, publicClient) {
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.contractAddress === null) throw new Error("KeelFactory deployment failed.");
  return receipt.contractAddress;
}

async function main() {
  if (!Number.isSafeInteger(PORT) || PORT <= 0 || PORT > 65_535) throw new TypeError("OCA_LOCAL_E2E_PORT is invalid.");
  const anvil = spawn("anvil", ["--silent", "--host", "127.0.0.1", "--port", String(PORT), "--chain-id", String(CHAIN_ID), "--accounts", "3", "--balance", "1000", "--disable-code-size-limit"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  anvil.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const publicClient = createPublicClient({ chain: LOCAL_CHAIN, transport: http(RPC_URL, { retryCount: 0, timeout: 5_000 }) });
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const creator = privateKeyToAccount(CREATOR_KEY);
  const agent = privateKeyToAccount(AGENT_KEY);
  const deployerWallet = createWalletClient({ account: deployer, chain: LOCAL_CHAIN, transport: http(RPC_URL) });
  const creatorWallet = createWalletClient({ account: creator, chain: LOCAL_CHAIN, transport: http(RPC_URL) });
  const agentWallet = createWalletClient({ account: agent, chain: LOCAL_CHAIN, transport: http(RPC_URL) });

  try {
    await waitForRpc(publicClient);
    const factoryAddress = await deployFactory(deployerWallet, publicClient);
    const factoryVersion = await publicClient.readContract({ address: factoryAddress, abi: ABI, functionName: "FACTORY_VERSION" });
    const creationCodeHash = await publicClient.readContract({ address: factoryAddress, abi: ABI, functionName: "dieCreationCodeHash" });
    const block = await publicClient.getBlock();
    const config = {
      name: "Local agent collection",
      symbol: "LAG",
      admin: creator.address,
      royaltyReceiver: "0x0000000000000000000000000000000000000000",
      royaltyBps: "0",
      maxSupply: "1000",
      mintManager: agent.address,
      keelIndex: "0x0000000000000000000000000000000000000000",
    };
    const configDigest = createOcaFactoryConfigDigest(config);
    const trustedDeployment = { chainId: CHAIN_ID, factoryAddress, factoryVersion: asHex(factoryVersion), creationCodeHash: asHex(creationCodeHash) };
    const connectors = createViemOcaFactoryConnectors({
      accountClient: creatorWallet,
      agentClient: agentWallet,
      publicClient,
    });

    async function linkFor(nonce) {
      const now = Number(block.timestamp);
      const result = await createKeelWalletLink({
        family: "ethereum",
        accountAddress: creator.address,
        agentAddress: agent.address,
        target: {
          chainId: CHAIN_ID,
          factoryAddress,
          factoryVersion: trustedDeployment.factoryVersion,
          creationCodeHash: trustedDeployment.creationCodeHash,
          operation: "keelFactory.castDie",
          configDigest,
          configEncoding: "keel-factory-config-keccak@1",
          authorizationNonce: String(nonce),
        },
        scopes: ["create-collection"],
        issuedAt: now - 1,
        expiresAt: now + 3_600,
        nonce: `local-e2e-${nonce}`,
        transport: "injected",
      });
      if (result.status !== "review-only") throw new Error(`Wallet-link creation deferred: ${result.code}`);
      return result;
    }

    const firstLink = await linkFor(0);
    const first = await executeOcaFactoryCollection({
      mode: "execute",
      link: firstLink,
      collectionConfig: config,
      nowSeconds: Number(block.timestamp),
      trustedDeployment,
      ...connectors,
    });
    if (first.status !== "executed") throw new Error(`First create did not execute: ${first.code} ${first.issues.join("; ")}`);

    const replay = await executeOcaFactoryCollection({
      mode: "execute",
      link: firstLink,
      collectionConfig: config,
      nowSeconds: Number(block.timestamp),
      trustedDeployment,
      ...connectors,
    });
    if (replay.status !== "deferred" || replay.code !== "nonce-mismatch") throw new Error(`Replay was not rejected by the creator nonce: ${JSON.stringify(replay)}`);

    const secondLink = await linkFor(1);
    const invalidateHash = await creatorWallet.writeContract({ address: factoryAddress, abi: ABI, functionName: "invalidateCreatorNonce", args: [2n] });
    await publicClient.waitForTransactionReceipt({ hash: invalidateHash });
    const revoked = await executeOcaFactoryCollection({
      mode: "execute",
      link: secondLink,
      collectionConfig: config,
      nowSeconds: Number(block.timestamp),
      trustedDeployment,
      ...connectors,
    });
    if (revoked.status !== "deferred" || revoked.code !== "nonce-mismatch") throw new Error(`On-chain nonce invalidation was not enforced: ${JSON.stringify(revoked)}`);

    const bytecode = await publicClient.getBytecode({ address: first.collectionAddress });
    if (bytecode === undefined || bytecode === "0x") throw new Error("Verified collection has no deployed runtime bytecode.");
    console.log(JSON.stringify({
      status: "ok",
      chainId: CHAIN_ID,
      factoryAddress,
      creator: creator.address,
      agent: agent.address,
      collectionAddress: first.collectionAddress,
      transactionHash: first.transactionHash,
      replay: replay.code,
      invalidation: revoked.code,
      receiptVerified: true,
    }));
  } finally {
    anvil.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      anvil.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (anvil.exitCode !== null && anvil.exitCode !== 0 && stderr.trim() !== "") process.stderr.write(stderr);
  }
}

await main();
