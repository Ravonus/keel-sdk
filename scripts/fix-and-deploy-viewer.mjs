import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));

const VIEWER_BUILDER = "0x3C7A3c23Fefc682df3a06E5314311C3D9A3668bE";
const VIEWER_OBJECT = "0x9648488907d74ae8787ecf27eb0fef8dd1572c22b5c11e3d6b98dfa88db255fe";
const VIEWER_DIGEST = "0x4dab856473ade98f3a8645a9ff199ea8661cff56a9ff2915974dfb51a50227fe";

const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

// A real tip. The previous run used 0.0005 gwei and simply never got mined.
const fees = async () => {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (base * 118n) / 100n, maxPriorityFeePerGas: 100_000_000n };
};

const latest = await pub.getTransactionCount({ address: account.address, blockTag: "latest" });
const pending = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
if (pending > latest) {
  console.log(`clearing stuck nonce ${latest}...`);
  const f = await fees();
  const hash = await wallet.sendTransaction({
    to: account.address, value: 0n, nonce: latest, gas: 21000n,
    maxFeePerGas: f.maxFeePerGas * 3n, maxPriorityFeePerGas: 2_000_000_000n,
  });
  await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log("  cleared\n");
}

const before = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(before)} ETH\n`);

const send = async (label, req) => {
  const g = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (g * 112n) / 100n, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ${label.padEnd(26)} ${r.gasUsed} gas`);
  return r;
};

// Only the factory is redeployed. It keeps the existing ledger, so the proof
// ladder contracts stay put and this fits the remaining balance.
const F = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const hash = await wallet.deployContract({
  abi: F.abi, bytecode: F.bytecode.object,
  args: [D.ledger, VIEWER_BUILDER, VIEWER_OBJECT, VIEWER_DIGEST], ...(await fees()),
});
const fr = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
const factory = fr.contractAddress;
console.log(`  factory                    ${factory} (${fr.gasUsed} gas)`);

const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const BAYC = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const backpack = await pub.readContract({ address: factory, abi: F.abi, functionName: "predictBackpack", args: [D.bayc] });
await send("init backpack", { address: factory, abi: F.abi, functionName: "init", args: [D.bayc] });

const holder = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] });
if (holder.toLowerCase() !== account.address.toLowerCase() && holder.toLowerCase() !== backpack.toLowerCase()) {
  await send("withdraw from old", { address: holder, abi: BACKPACK.abi, functionName: "withdraw", args: [1n] });
}
if ((await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] })).toLowerCase() !== backpack.toLowerCase()) {
  await send("wrap ape #1", { address: D.bayc, abi: BAYC.abi, functionName: "safeTransferFrom", args: [account.address, backpack, 1n] });
}

const json = await pub.readContract({ address: backpack, abi: BACKPACK.abi, functionName: "tokenJSON", args: [1n] });
const anim = /"animation_url":"([^"]{0,50})/.exec(json);
console.log(`\n  NFT        ${backpack}`);
console.log(`  animation  ${anim ? anim[1] : "(none)"}…`);
console.log(`  json len   ${json.length}`);
const after = await pub.getBalance({ address: account.address });
console.log(`\nspent ${formatEther(before - after)} ETH, left ${formatEther(after)} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({ ...D, factory, backpack, viewerBuilder: VIEWER_BUILDER, viewerObject: VIEWER_OBJECT }, null, 2));
