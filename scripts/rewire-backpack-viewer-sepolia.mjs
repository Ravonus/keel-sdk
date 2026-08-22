// Redeploys the backpack stack with the Keel viewer builder wired in, and
// re-proves Bored Ape #1 against the new canonical backpack.
//
// Nothing stored is lost: KeelHold keys everything by content hash, so the
// directory, metadata and ape bytes are reused for free by the new ledger.
//
// Fees are pinned close to the base fee. viem defaults to roughly twice base
// plus a tip, and since a node's allowance is balance/maxFeePerGas, that headroom
// makes most of a balance unusable — 12.7M gas of allowance instead of 33M.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getContractAddress, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));

const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const fees = async () => {
  const base = await pub.getBlock({ blockTag: "latest" }).then((b) => b.baseFeePerGas);
  return { maxFeePerGas: (base * 1125n) / 1000n, maxPriorityFeePerGas: 1_000_000n };
};

const send = async (label, req) => {
  const estimate = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (estimate * 115n) / 100n, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ${label.padEnd(30)} ${r.gasUsed} gas`);
  return r;
};

const deploy = async (name, args = []) => {
  const { abi, bytecode } = art(`${name}.sol`, name);
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${name} deployment reverted`);
  console.log(`  ${name.padEnd(30)} ${r.contractAddress} (${r.gasUsed} gas)`);
  return r.contractAddress;
};

const before = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(before)} ETH\n`);

const builder = await deploy("KeelHarnessBuilder", [D.keelHold]);
const nonce = await pub.getTransactionCount({ address: account.address });
const predictedLedger = getContractAddress({ from: account.address, nonce: BigInt(nonce + 1) });
const factory = await deploy("KeelBackpackFactory", [predictedLedger, builder]);
const ledger = await deploy("KeelBackpackProofLedger", [
  factory, D.keelHold, D.attestations, D.commitments,
]);
if (ledger.toLowerCase() !== predictedLedger.toLowerCase()) throw new Error("ledger address prediction failed");

const FACTORY = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");
const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const BAYC = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const backpack = await pub.readContract({ address: factory, abi: FACTORY.abi, functionName: "predictBackpack", args: [D.bayc] });
await send("init backpack", { address: factory, abi: FACTORY.abi, functionName: "init", args: [D.bayc] });
console.log(`  new backpack                   ${backpack}\n`);

// Move the ape out of the superseded backpack and into the new one.
const holder = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] });
if (holder.toLowerCase() === D.backpack.toLowerCase()) {
  await send("withdraw from old backpack", { address: D.backpack, abi: BACKPACK.abi, functionName: "withdraw", args: [1n] });
}
if ((await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] })).toLowerCase() !== backpack.toLowerCase()) {
  await send("wrap into new backpack", {
    address: D.bayc, abi: BAYC.abi, functionName: "safeTransferFrom", args: [account.address, backpack, 1n],
  });
}

await send("pinObservation", { address: ledger, abi: LEDGER.abi, functionName: "pinObservation", args: [backpack, 1n] });
await new Promise((r) => setTimeout(r, 15000));
await send("sealObservation", { address: ledger, abi: LEDGER.abi, functionName: "sealObservation", args: [backpack, 1n] });

const uri = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "tokenURI", args: [1n] });
await send("proveMetadataViaDirectory", {
  address: ledger, abi: LEDGER.abi, functionName: "proveMetadataViaDirectory",
  args: [backpack, 1n, D.directoryObject, D.metadataObject, uri, 45n],
});
await send("bindAsset", { address: ledger, abi: LEDGER.abi, functionName: "bindAsset", args: [backpack, 1n, D.imageObject, "image"] });

const lane = await pub.readContract({ address: ledger, abi: LEDGER.abi, functionName: "weakestLane", args: [backpack, 1n] });
const after = await pub.getBalance({ address: account.address });
console.log(`\nweakestLane ${["Unproven","Attested","Committed","Native"][lane]}`);
console.log(`spent ${formatEther(before - after)} ETH, left ${formatEther(after)} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({ ...D, viewerBuilder: builder, factory, ledger, backpack, supersededBackpack: D.backpack }, null, 2));
