// Deploy KeelModuleReviewRegistry to Sepolia and exercise the full on-chain
// module trust lifecycle (createGraph(Library) -> submitModule -> sanction ->
// moduleAuthorized:true -> revoke -> moduleAuthorized:false), writing a tracked
// evidence receipt. Never prints the private key. Hard-guards chainId 11155111
// so this can never touch mainnet.
//
// Run: node scripts/deploy-module-review-registry-sepolia.mjs
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  formatEther,
  getContract,
} from "../apps/studio/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../apps/studio/node_modules/viem/_esm/accounts/index.js";
import { sepolia } from "../apps/studio/node_modules/viem/_esm/chains/index.js";

const CHAIN_ID = 11_155_111;
const RPC = process.env.OCA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com";
const GRAPH_REGISTRY = "0x5b86439598d2091bf45971c3676eb25c5d64dca4";
const KEY_FILE = path.resolve(".secrets/vault-sepolia-deployer.json");
const OUT = path.resolve("evidence/keel-trusted-runtime/module-review-registry-sepolia.json");

async function readKey() {
  const metadata = await stat(KEY_FILE);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Deployer key file must not be group/world accessible.");
  const doc = JSON.parse(await readFile(KEY_FILE, "utf8"));
  if (doc.chainId !== CHAIN_ID || typeof doc.privateKey !== "string" || !/^0x[0-9a-f]{64}$/iu.test(doc.privateKey)) {
    throw new Error("Deployer key file is invalid or belongs to another chain.");
  }
  return doc.privateKey;
}

async function loadArtifact(name) {
  const file = path.resolve(`packages/contracts/out/${name}.sol/${name}.json`);
  const doc = JSON.parse(await readFile(file, "utf8"));
  return { abi: doc.abi, bytecode: doc.bytecode.object };
}

function d(label) {
  return keccak256(toHex(label));
}

async function main() {
  const account = privateKeyToAccount(await readKey());
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

  // HARD GUARD: never broadcast unless the live chain is Sepolia.
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== CHAIN_ID) throw new Error(`Refusing to broadcast: live chainId ${liveChainId} is not Sepolia.`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer ${account.address} | ${formatEther(balance)} ETH | chainId ${liveChainId}`);
  if (balance === 0n) throw new Error("Deployer has no Sepolia ETH.");

  const receipts = {};
  async function send(label, hash) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
    receipts[label] = { hash, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber.toString() };
    console.log(`  ${label}: ${hash} (gas ${receipt.gasUsed})`);
    return receipt;
  }

  // 1. Deploy the registry (admin = approver = deployer for this exercise).
  console.log("deploying KeelModuleReviewRegistry...");
  const artifact = await loadArtifact("KeelModuleReviewRegistry");
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [account.address, account.address, GRAPH_REGISTRY],
  });
  const deployReceipt = await send("deploy", deployHash);
  const registryAddress = deployReceipt.contractAddress;
  console.log(`  registry: ${registryAddress}`);

  const registry = getContract({ address: registryAddress, abi: artifact.abi, client: walletClient });
  const graphArtifact = await loadArtifact("KeelGraphRegistry");
  const graphs = getContract({ address: GRAPH_REGISTRY, abi: graphArtifact.abi, client: walletClient });

  // 2. Register a Library graph (the on-chain home of a non-contract module).
  const salt = keccak256(toHex(`keel-module-review-live-${liveChainId}-${account.address}-${balance}`));
  const manifestDigest = d("keel-three-module-manifest-v1");
  const resourceGraphDigest = d("keel-three-module-resource-graph-v1");
  const metadataDigest = d("keel-three-module-metadata-v1");
  const graphId = await graphs.read.predictGraphId([account.address, salt]);
  console.log(`registering Library graph ${graphId}...`);
  await send(
    "createGraph",
    await graphs.write.createGraph([salt, 2, "https://modules.example/three/v1.json", manifestDigest, resourceGraphDigest, metadataDigest, 0]),
  );

  // 3. Submit the module spec, then read its digest.
  const spec = {
    moduleId: d("three@0.160.0"),
    moduleVersion: 1n,
    format: 0, // EsModule
    graphId,
    graphVersion: 1n,
    manifestDigest,
    resourceGraphDigest,
    metadataDigest,
  };
  const specDigest = await registry.read.specDigest([spec]);
  console.log(`submitting module ${specDigest}...`);
  await send("submitModule", await registry.write.submitModule([spec]));
  const unvetted = await registry.read.moduleAuthorized([specDigest]);

  // 4. Sanction -> authorized.
  console.log("sanctioning...");
  await send("sanctionModule", await registry.write.sanctionModule([specDigest, d("review-receipt-v1"), 0n]));
  const authorizedAfterSanction = await registry.read.moduleAuthorized([specDigest]);

  // 5. Revoke -> not authorized.
  console.log("revoking...");
  await send("revokeModule", await registry.write.revokeModule([specDigest, d("supply-chain-compromise"), `0x${"00".repeat(32)}`]));
  const authorizedAfterRevoke = await registry.read.moduleAuthorized([specDigest]);

  const reviewAfter = await registry.read.review([specDigest]);

  const results = {
    unvettedAuthorized: unvetted,
    authorizedAfterSanction,
    authorizedAfterRevoke,
    finalStatus: Number(reviewAfter.status),
  };
  console.log("results:", results);
  const pass =
    unvetted === false && authorizedAfterSanction === true && authorizedAfterRevoke === false && Number(reviewAfter.status) === 4;
  if (!pass) throw new Error(`Lifecycle assertions failed: ${JSON.stringify(results)}`);

  const evidence = {
    schema: "keel.module-review-registry.sepolia-smoke@1",
    chainId: liveChainId,
    deployer: account.address,
    registry: registryAddress,
    graphRegistry: GRAPH_REGISTRY,
    graphId,
    specDigest,
    results,
    receipts,
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nPASS — full lifecycle verified on Sepolia. Evidence: ${path.relative(process.cwd(), OUT)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
