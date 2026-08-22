// Exercise the DEPRECATE branch of the module trust lifecycle on Sepolia,
// reusing the already-deployed KeelModuleReviewRegistry and its Library graph
// (submit a fresh module id -> sanction -> deprecate -> verify still authorized
// within the window, with a reason recorded). Complements the deploy script,
// which covers submit -> sanction -> revoke. Hard-guards chainId 11155111 and
// never prints the key.
//
// Run: node scripts/module-registry-deprecate-sepolia.mjs
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, http, keccak256, toHex, getContract } from "../apps/studio/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../apps/studio/node_modules/viem/_esm/accounts/index.js";
import { sepolia } from "../apps/studio/node_modules/viem/_esm/chains/index.js";

const CHAIN_ID = 11_155_111;
const RPC = process.env.KEEL_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com";
const KEY_FILE = path.resolve(".secrets/vault-sepolia-deployer.json");
const EVIDENCE_IN = path.resolve("evidence/keel-trusted-runtime/module-review-registry-sepolia.json");
const EVIDENCE_OUT = path.resolve("evidence/keel-trusted-runtime/module-review-registry-deprecate-sepolia.json");

async function readKey() {
  const metadata = await stat(KEY_FILE);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Deployer key file must not be group/world accessible.");
  const doc = JSON.parse(await readFile(KEY_FILE, "utf8"));
  if (doc.chainId !== CHAIN_ID || typeof doc.privateKey !== "string") throw new Error("Deployer key file is invalid or off-chain.");
  return doc.privateKey;
}

async function main() {
  const prior = JSON.parse(await readFile(EVIDENCE_IN, "utf8"));
  const registryAddress = prior.registry;
  const graphId = prior.graphId;

  const account = privateKeyToAccount(await readKey());
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== CHAIN_ID) throw new Error(`Refusing to broadcast: chainId ${liveChainId} is not Sepolia.`);

  const artifact = JSON.parse(
    await readFile(path.resolve("packages/contracts/out/KeelModuleReviewRegistry.sol/KeelModuleReviewRegistry.json"), "utf8"),
  );
  const graphArtifact = JSON.parse(
    await readFile(path.resolve("packages/contracts/out/KeelGraphRegistry.sol/KeelGraphRegistry.json"), "utf8"),
  );
  const registry = getContract({ address: registryAddress, abi: artifact.abi, client: walletClient });
  const graphs = getContract({ address: prior.graphRegistry, abi: graphArtifact.abi, client: publicClient });

  // Read the existing graph version's committed digests so the new spec binds.
  const version = await graphs.read.versionOf([graphId, 1n]);

  const receipts = {};
  async function send(label, hash) {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
    receipts[label] = { hash, gasUsed: r.gasUsed.toString() };
    console.log(`  ${label}: ${hash} (gas ${r.gasUsed})`);
  }

  // A fresh module id keyed to the current block so the spec is new each run.
  const block = await publicClient.getBlockNumber();
  const spec = {
    moduleId: keccak256(toHex(`deprecate-flow-${block}`)),
    moduleVersion: 2n,
    format: 0,
    graphId,
    graphVersion: 1n,
    manifestDigest: version.manifestDigest,
    resourceGraphDigest: version.resourceGraphDigest,
    metadataDigest: version.metadataDigest,
  };
  const specDigest = await registry.read.specDigest([spec]);
  console.log(`deprecate flow on ${registryAddress}, module ${specDigest}`);
  await send("submitModule", await registry.write.submitModule([spec]));

  const sunset = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  await send("sanctionModule", await registry.write.sanctionModule([specDigest, keccak256(toHex("deprecate-flow-review")), sunset]));
  const authorizedAfterSanction = await registry.read.moduleAuthorized([specDigest]);

  await send(
    "deprecateModule",
    await registry.write.deprecateModule([specDigest, keccak256(toHex("superseded-by-next-major")), keccak256(toHex("replacement-spec")), sunset - 3600n]),
  );
  const review = await registry.read.review([specDigest]);
  const authorizedAfterDeprecate = await registry.read.moduleAuthorized([specDigest]);

  const results = {
    authorizedAfterSanction,
    authorizedAfterDeprecate,
    status: Number(review.status),
    reasonRecorded: /^0x[0-9a-f]{64}$/u.test(review.reasonDigest) && !/^0x0+$/u.test(review.reasonDigest),
    replacementRecorded: !/^0x0+$/u.test(review.replacementSpecDigest),
  };
  console.log("results:", results);
  // Deprecated (status 3) keeps authority within the window.
  const pass = authorizedAfterSanction === true && authorizedAfterDeprecate === true && results.status === 3 && results.reasonRecorded && results.replacementRecorded;
  if (!pass) throw new Error(`Deprecate lifecycle assertions failed: ${JSON.stringify(results)}`);

  const evidence = {
    schema: "keel.module-review-registry.deprecate-smoke@1",
    chainId: liveChainId,
    registry: registryAddress,
    graphId,
    specDigest,
    results,
    receipts,
  };
  await mkdir(path.dirname(EVIDENCE_OUT), { recursive: true });
  await writeFile(EVIDENCE_OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nPASS — deprecate branch verified on Sepolia. Evidence: ${path.relative(process.cwd(), EVIDENCE_OUT)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
