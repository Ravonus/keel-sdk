import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther, keccak256, toHex, encodeAbiParameters, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));
const CS = art("KeelHold.sol", "KeelHold"), L = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger"), BP = art("KeelBackpack721.sol", "KeelBackpack721");
const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const wallet = createWalletClient({ account, chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const fees = async () => { const b=(await pub.getBlock({blockTag:"latest"})).baseFeePerGas; return { maxFeePerGas:(b*130n)/100n, maxPriorityFeePerGas:200_000_000n }; };
const send = async (label, req) => { const g = await pub.estimateContractGas({...req,account}); const h = await wallet.writeContract({...req,gas:(g*115n)/100n,...(await fees())}); const r = await pub.waitForTransactionReceipt({hash:h,timeout:300_000}); if(r.status!=="success")throw new Error(label); console.log(`  ${label.padEnd(22)} ${r.gasUsed} gas`); return r; };

const viewer = new Uint8Array(readFileSync(`${process.env.KEEL_SHELL_DIR}/keel-viewer.min.html`));

// KeelHold caps a chunk at 23,000 bytes, so anything larger is split. Chunks
// are keyed by content hash, so a re-run only pays for what actually changed.
const CHUNK = 23000;
const slugIds = [];
for (let i = 0; i * CHUNK < viewer.length; i++) {
  const slice = viewer.subarray(i * CHUNK, Math.min(viewer.length, (i + 1) * CHUNK));
  const id = keccak256(toHex(slice));
  slugIds.push(id);
  if ((await pub.readContract({ address: D.keelHold, abi: CS.abi, functionName: "slugPointer", args: [id] })) === "0x0000000000000000000000000000000000000000") {
    await send(`castSlug ${i + 1}`, { address: D.keelHold, abi: CS.abi, functionName: "castSlug", args: [`0x${Buffer.from(slice).toString("hex")}`] });
  }
}
const digest = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", viewer)).toString("hex")}`;

// KeelHold returns the existing objectId without an event when the same
// content is created twice, so the id is derived here rather than read from a
// log that may not be emitted. Mirrors KeelHold.weldObject exactly.
const indexDigest = keccak256(encodePacked(slugIds.map(() => "bytes32"), slugIds));
const obj = keccak256(encodeAbiParameters(
  [{ type: "bytes1" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes32" }],
  ["0x00", indexDigest, digest, BigInt(viewer.length), BigInt(viewer.length), 0, keccak256(toHex("text/html"))],
));
if (!(await pub.readContract({ address: D.keelHold, abi: CS.abi, functionName: "objectExists", args: [obj] }))) {
  await send("weldObject", { address: D.keelHold, abi: CS.abi, functionName: "weldObject", args: [slugIds, digest, BigInt(viewer.length), 0, "text/html"] });
}
console.log(`  object exists: ${await pub.readContract({ address: D.keelHold, abi: CS.abi, functionName: "objectExists", args: [obj] })}`);
await send("bindViewer", { address: D.ledger, abi: L.abi, functionName: "bindViewer", args: [D.backpack, 1n, obj] });
const json = await pub.readContract({address:D.backpack,abi:BP.abi,functionName:"tokenJSON",args:[1n]});
const html = Buffer.from(/"animation_url":"data:text\/html;base64,([^"]+)/.exec(json)[1],"base64").toString("utf8");
console.log(`\n  viewer object ${obj}`);
console.log(`  tabs: ${(html.match(/class="tab"/g)||[]).length}`);
console.log(`  unwrapped state: ${html.includes("is-unwrapped")}`);
console.log(`  score algo: ${html.includes("Artwork stored on chain")}`);
console.log(`  left ${formatEther(await pub.getBalance({address:account.address}))} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({...D, viewerObject: obj}, null, 2));
