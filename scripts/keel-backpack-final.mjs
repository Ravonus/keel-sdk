import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getContractAddress, http, formatEther, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const S = process.env.KEEL_SHELL_DIR;
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));
const CS = art("KeelHold.sol", "KeelHold");
const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const fees = async () => {
  const b = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (b * 130n) / 100n, maxPriorityFeePerGas: 200_000_000n };
};
const send = async (label, req) => {
  const g = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (g * 115n) / 100n, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ${label.padEnd(26)} ${r.gasUsed} gas`);
  return r;
};
const deploy = async (name, args) => {
  const a = art(`${name}.sol`, name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  console.log(`  ${name.padEnd(26)} ${r.contractAddress}`);
  return r.contractAddress;
};
const before = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(before)} ETH\n`);

// 1. Store the small Keel viewer.
const viewer = new Uint8Array(readFileSync(`${S}/keel-ape-viewer.html`));
// KeelHold keys chunks by keccak of the payload and returns the existing
// pointer when it has one, so a re-run emits no event. Compute the id rather
// than reading it from logs.
const slugId = keccak256(toHex(viewer));
if ((await pub.readContract({ address: D.keelHold, abi: CS.abi, functionName: "slugPointer", args: [slugId] })) === "0x0000000000000000000000000000000000000000") {
  await send("castSlug viewer", { address: D.keelHold, abi: CS.abi, functionName: "castSlug", args: [`0x${Buffer.from(viewer).toString("hex")}`] });
}
const vdigest = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", viewer)).toString("hex")}`;
const or = await send("weldObject viewer", { address: D.keelHold, abi: CS.abi, functionName: "weldObject", args: [[slugId], vdigest, BigInt(viewer.length), 0, "text/html"] });
const created = or.logs.find(l => l.address.toLowerCase() === D.keelHold.toLowerCase());
const viewerObject = created ? created.topics[1] : D.viewerObject;
console.log(`  viewer object              ${viewerObject}\n`);

// 2. Fresh factory + ledger.
const nonce = await pub.getTransactionCount({ address: account.address });
const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce + 1) });
const factory = await deploy("KeelBackpackFactory", [predicted, D.viewerBuilder ?? "0x3cbbba4142c0f599b0147f4cb29f5e9296e2dd1b", viewerObject, vdigest]);
const ledger = await deploy("KeelBackpackProofLedger", [factory, D.keelHold, D.attestations, D.commitments, "0x0000000000000000000000000000000000000000"]);
if (ledger.toLowerCase() !== predicted.toLowerCase()) throw new Error("prediction failed");

const F = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const L = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");
const BP = art("KeelBackpack721.sol", "KeelBackpack721");
const BAYC = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const backpack = await pub.readContract({ address: factory, abi: F.abi, functionName: "predictBackpack", args: [D.bayc] });
await send("init backpack", { address: factory, abi: F.abi, functionName: "init", args: [D.bayc] });
const holder = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] });
if (holder.toLowerCase() !== account.address.toLowerCase() && holder.toLowerCase() !== backpack.toLowerCase()) {
  await send("withdraw old", { address: holder, abi: BP.abi, functionName: "withdraw", args: [1n] });
}
if ((await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] })).toLowerCase() !== backpack.toLowerCase()) {
  await send("wrap ape #1", { address: D.bayc, abi: BAYC.abi, functionName: "safeTransferFrom", args: [account.address, backpack, 1n] });
}

// 3. Re-prove the ladder so traits and lane are real.
await send("pinObservation", { address: ledger, abi: L.abi, functionName: "pinObservation", args: [backpack, 1n] });
await new Promise(r => setTimeout(r, 15000));
await send("sealObservation", { address: ledger, abi: L.abi, functionName: "sealObservation", args: [backpack, 1n] });
const uri = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "tokenURI", args: [1n] });
await send("proveMetadataViaDirectory", { address: ledger, abi: L.abi, functionName: "proveMetadataViaDirectory", args: [backpack, 1n, D.directoryObject, D.metadataObject, uri, 45n] });
await send("bindAsset", { address: ledger, abi: L.abi, functionName: "bindAsset", args: [backpack, 1n, D.imageObject, "image"] });

const lane = await pub.readContract({ address: ledger, abi: L.abi, functionName: "weakestLane", args: [backpack, 1n] });
const json = await pub.readContract({ address: backpack, abi: BP.abi, functionName: "tokenJSON", args: [1n] });
console.log(`\n  NFT        ${backpack}`);
console.log(`  lane       ${["Unproven","Attested","Committed","Native"][lane]}`);
console.log(`  json len   ${json.length}`);
console.log(`  animation  ${(/"animation_url":"([^"]{0,40})/.exec(json)||[])[1]}…`);
console.log(`  traits     ${(json.match(/"trait_type":"[^"]+"/g)||[]).slice(0,7).join(" ")}`);
console.log(`\nleft ${formatEther(await pub.getBalance({ address: account.address }))} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({ ...D, factory, ledger, backpack, viewerObject, viewerDigest: vdigest }, null, 2));
