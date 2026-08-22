// Read-only on-chain verification of the deployed KeelModuleReviewRegistry on
// Sepolia. No private key, no gas, no writes — safe to run in CI or monitoring.
// It re-reads the registry state for the spec recorded in the deploy evidence and
// asserts the lifecycle outcome still holds against live chain state.
//
// Run: node scripts/verify-module-registry-sepolia.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, getContract } from "../apps/studio/node_modules/viem/_esm/index.js";

const CHAIN_ID = 11_155_111;
const RPC = process.env.KEEL_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com";
const EVIDENCE = path.resolve("evidence/keel-trusted-runtime/module-review-registry-sepolia.json");

// Status enum: None=0, Unvetted=1, Sanctioned=2, Deprecated=3, Revoked=4.
const STATUS = ["None", "Unvetted", "Sanctioned", "Deprecated", "Revoked"];

async function main() {
  const evidence = JSON.parse(await readFile(EVIDENCE, "utf8"));
  const registryAddress = evidence.registry;
  const specDigest = evidence.specDigest;
  const expected = evidence.results;

  const publicClient = createPublicClient({ transport: http(RPC) });
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== CHAIN_ID) throw new Error(`Live chainId ${liveChainId} is not Sepolia.`);

  const code = await publicClient.getBytecode({ address: registryAddress });
  if (!code || code.length <= 2) throw new Error(`No contract at ${registryAddress}.`);

  const artifact = JSON.parse(
    await readFile(path.resolve("packages/contracts/out/KeelModuleReviewRegistry.sol/KeelModuleReviewRegistry.json"), "utf8"),
  );
  const registry = getContract({ address: registryAddress, abi: artifact.abi, client: publicClient });

  const review = await registry.read.review([specDigest]);
  const authorized = await registry.read.moduleAuthorized([specDigest]);
  const bindings = await registry.read.bindingsMatch([specDigest]);
  const graphRegistry = await registry.read.graphRegistry();

  const status = Number(review.status);
  const results = {
    registry: registryAddress,
    specDigest,
    graphRegistry,
    status: STATUS[status] ?? String(status),
    moduleAuthorized: authorized,
    bindingsMatch: bindings,
    reasonDigest: review.reasonDigest,
  };
  console.log("live registry state:", results);

  const checks = [
    [`status is Revoked (recorded run ended revoked)`, status === 4],
    [`moduleAuthorized is false`, authorized === false],
    [`moduleAuthorized matches evidence (${expected.authorizedAfterRevoke})`, authorized === expected.authorizedAfterRevoke],
    [`graphRegistry binding intact`, graphRegistry.toLowerCase() === String(evidence.graphRegistry).toLowerCase()],
    [`bindingsMatch still true (graph version unchanged)`, bindings === true],
    [`a revocation reason is recorded`, /^0x[0-9a-f]{64}$/u.test(review.reasonDigest) && !/^0x0+$/u.test(review.reasonDigest)],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) throw new Error(`${failed} on-chain verification check(s) failed.`);
  console.log("\nPASS — deployed module registry state verified read-only against Sepolia.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
