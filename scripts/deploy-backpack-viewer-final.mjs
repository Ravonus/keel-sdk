// Redeploys the backpack stack pointing at the Keel viewer that already
// serves LINES on Sepolia. One shared 37 KB viewer for every wrapped token,
// with this token's facts injected as context — the shape KEEL721 uses.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getContractAddress, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));

// The live Keel viewer, read off the LINES collection.
const VIEWER_BUILDER = "0x3C7A3c23Fefc682df3a06E5314311C3D9A3668bE";
const VIEWER_OBJECT = "0x9648488907d74ae8787ecf27eb0fef8dd1572c22b5c11e3d6b98dfa88db255fe";
const VIEWER_DIGEST = "0x4dab856473ade98f3a8645a9ff199ea8661cff56a9ff2915974dfb51a50227fe";
const VIEWER_CHUNK_STORE = "0x041Cc03eB91801C25A67f35fCf0CD0f810379Dca";

const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const fees = async () => {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (base * 105n) / 100n, maxPriorityFeePerGas: 500_000n };
};
const send = async (label, req) => {
  const g = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (g * 112n) / 100n, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  console.log(`  ${label.padEnd(28)} ${r.gasUsed} gas`);
  return r;
};
const deploy = async (name, args) => {
  const { abi, bytecode } = art(`${name}.sol`, name);
  const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${name} reverted`);
  console.log(`  ${name.padEnd(28)} ${r.contractAddress} (${r.gasUsed} gas)`);
  return r.contractAddress;
};

const before = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(before)} ETH\n`);

const nonce = await pub.getTransactionCount({ address: account.address });
const predictedLedger = getContractAddress({ from: account.address, nonce: BigInt(nonce + 1) });
const factory = await deploy("KeelBackpackFactory", [predictedLedger, VIEWER_BUILDER, VIEWER_OBJECT, VIEWER_DIGEST]);
const ledger = await deploy("KeelBackpackProofLedger", [factory, D.keelHold, D.attestations, D.commitments]);
if (ledger.toLowerCase() !== predictedLedger.toLowerCase()) throw new Error("prediction failed");

const FACTORY = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const BAYC = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const backpack = await pub.readContract({ address: factory, abi: FACTORY.abi, functionName: "predictBackpack", args: [D.bayc] });
await send("init backpack", { address: factory, abi: FACTORY.abi, functionName: "init", args: [D.bayc] });

const holder = await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] });
if (holder.toLowerCase() !== backpack.toLowerCase() && holder.toLowerCase() !== account.address.toLowerCase()) {
  await send("withdraw from old", { address: holder, abi: BACKPACK.abi, functionName: "withdraw", args: [1n] });
}
if ((await pub.readContract({ address: D.bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] })).toLowerCase() !== backpack.toLowerCase()) {
  await send("wrap ape #1", { address: D.bayc, abi: BAYC.abi, functionName: "safeTransferFrom", args: [account.address, backpack, 1n] });
}

const json = await pub.readContract({ address: backpack, abi: BACKPACK.abi, functionName: "tokenJSON", args: [1n] });
const anim = /"animation_url":"([^"]{0,60})/.exec(json);
console.log(`\n  NFT       ${backpack}`);
console.log(`  animation ${anim ? anim[1] : "(none)"}…`);
console.log(`  json len  ${json.length}`);

const after = await pub.getBalance({ address: account.address });
console.log(`\nspent ${formatEther(before - after)} ETH, left ${formatEther(after)} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({ ...D, factory, ledger, backpack, viewerBuilder: VIEWER_BUILDER, viewerObject: VIEWER_OBJECT, viewerKeelHold: VIEWER_CHUNK_STORE }, null, 2));
