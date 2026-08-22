import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const LEDGER = JSON.parse(readFileSync("packages/contracts/out/KeelBackpackProofLedger.sol/KeelBackpackProofLedger.json", "utf8"));
const book = JSON.parse(readFileSync("scripts/backpack-demo-sepolia.json", "utf8"));
const old = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const account = privateKeyToAccount(JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
const fees = { maxFeePerGas: (base * 130n) / 100n + 100_000_000n, maxPriorityFeePerGas: 100_000_000n };

// The Keel viewer object already composed from the protector shell:
// [shell prefix, entrypoint, artifact, shell suffix, raw bytes].
console.log("binding the existing Keel viewer", old.viewerObject);
const hash = await wallet.writeContract({
  address: book.ledger, abi: LEDGER.abi, functionName: "bindViewer",
  args: [book.backpack, 1n, old.viewerObject], ...fees,
});
const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
console.log(r.status, r.gasUsed, "gas");
