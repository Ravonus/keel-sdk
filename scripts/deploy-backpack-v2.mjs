/**
 * Deploy the backpack with everything measured today.
 *
 *   - `tokenURI` serves the document as it stands. The artwork inside it is
 *     already base64; encoding the whole thing again would put those same bytes
 *     through base64 twice, on every read, forever.
 *   - Nothing writes a `#` into the document, which is the only reason that
 *     second pass was ever needed — a data URI ends at the first one.
 *   - The artwork is stored already encoded and flagged `;base64`, so `image` is
 *     a concatenation rather than an encode.
 *
 * Every object these contracts need is already on this chain from earlier runs,
 * and KeelHold is content-keyed, so re-storing them costs nothing. What this
 * pays for is the four contracts and one token's proof ladder.
 *
 *   node scripts/deploy-backpack-v2.mjs --token 4
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, getContractAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";
const argv = process.argv.slice(2);
const tokenId = BigInt(argv[argv.indexOf("--token") + 1] ?? 4);

const art = (file, name) => JSON.parse(readFileSync(`packages/contracts/out/${file}/${name}.json`, "utf8"));
const FACTORY = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");
const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const BUILDER = art("KeelHarnessBuilder.sol", "KeelHarnessBuilder");
const STANDIN = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const book = JSON.parse(readFileSync("scripts/backpack-demo-sepolia.json", "utf8"));
const backdrops = JSON.parse(readFileSync("scripts/backpack-backdrops.json", "utf8"));
const account = privateKeyToAccount(JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const ZERO32 = "0x" + "0".repeat(64);
const TIP = 100_000_000n;
async function fees() {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (base * 130n) / 100n + TIP, maxPriorityFeePerGas: TIP };
}

let gasUsed = 0n;
let step = 0;
async function send(label, request) {
  const gas = await pub.estimateContractGas({ ...request, account });
  const hash = await wallet.writeContract({ ...request, gas: (gas * 115n) / 100n, ...(await fees()) });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  gasUsed += receipt.gasUsed;
  console.log(`  ${String(++step).padStart(2)}. ${label.padEnd(30)} ${receipt.gasUsed.toLocaleString().padStart(11)} gas`);
  return receipt;
}

async function deploy(name, compiled, args) {
  const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args, ...(await fees()) });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== "success") throw new Error(`${name} failed to deploy`);
  gasUsed += receipt.gasUsed;
  console.log(`  ${String(++step).padStart(2)}. deploy ${name.padEnd(23)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

const opening = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address}`);
console.log(`balance  ${formatEther(opening)} ETH\n`);

const reuse = process.env.REUSE === "1";

// Refuse to start what cannot be finished: a run that dies partway leaves a
// wrapped token with an incomplete ladder, which is worse than not starting.
// Reusing already-deployed contracts leaves only the token's own proof.
{
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  const cap = (base * 130n) / 100n + TIP;
  const projected = (reuse ? 14_000_000n : 27_000_000n) * cap;
  console.log(`  projected  ${formatEther(projected)} ETH at ${(Number(cap) / 1e9).toFixed(3)} gwei cap`);
  if (projected > opening) throw new Error(`needs ~${formatEther(projected)} ETH, holding ${formatEther(opening)}`);
  console.log(`  headroom   ${formatEther(opening - projected)} ETH\n`);
}

console.log("— contracts —");
const builder = reuse ? book.builder : await deploy("KeelHarnessBuilder", BUILDER, [book.keelHold]);
let factory;
let ledger;
if (reuse) {
  ({ factory, ledger } = book);
  console.log(`      reusing factory ${factory}`);
  console.log(`      reusing ledger  ${ledger}`);
} else {
  const nonce = await pub.getTransactionCount({ address: account.address });
  const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce + 1) });
  factory = await deploy("KeelBackpackFactory", FACTORY, [predicted, builder, ZERO32, ZERO32]);
  ledger = await deploy("KeelBackpackProofLedger", LEDGER, [
    factory, book.keelHold, book.attestations ?? "0x0000000000000000000000000000000000000000",
    book.commitments ?? "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000",
  ]);
  if (ledger.toLowerCase() !== predicted.toLowerCase()) throw new Error("ledger missed its predicted address");
}

const backpack = await pub.readContract({
  address: factory, abi: FACTORY.abi, functionName: "predictBackpack", args: [book.collection],
});
const alreadyInit = (await pub.getCode({ address: backpack }))?.length > 2;
if (!alreadyInit) {
  await send("init backpack", { address: factory, abi: FACTORY.abi, functionName: "init", args: [book.collection] });
}
console.log(`      backpack ${backpack}`);

console.log("\n— the token —");
const owner = await pub.readContract({
  address: book.collection, abi: STANDIN.abi, functionName: "ownerOf", args: [tokenId],
}).catch(() => null);
if (owner === null) {
  await send(`mint #${tokenId}`, { address: book.collection, abi: STANDIN.abi, functionName: "mint", args: [account.address, tokenId] });
}
if (owner && owner.toLowerCase() !== backpack.toLowerCase() && owner.toLowerCase() !== account.address.toLowerCase()) {
  await send(`recover #${tokenId}`, { address: owner, abi: BACKPACK.abi, functionName: "withdraw", args: [tokenId] });
}
const holder = await pub.readContract({ address: book.collection, abi: STANDIN.abi, functionName: "ownerOf", args: [tokenId] });
if (holder.toLowerCase() !== backpack.toLowerCase()) {
  await send(`wrap #${tokenId}`, {
    address: book.collection, abi: STANDIN.abi, functionName: "safeTransferFrom",
    args: [account.address, backpack, tokenId],
  });
}

const pin = await send("pin observation", { address: ledger, abi: LEDGER.abi, functionName: "pinObservation", args: [backpack, tokenId] });
while ((await pub.getBlockNumber()) <= pin.blockNumber) await new Promise((r) => setTimeout(r, 3_000));
await send("seal observation", { address: ledger, abi: LEDGER.abi, functionName: "sealObservation", args: [backpack, tokenId] });

const HINTS = { 1: 45n, 2: 52_139n, 3: 104_233n, 4: 156_327n, 5: 208_421n };
const route = await pub.readContract({ address: book.collection, abi: STANDIN.abi, functionName: "tokenURI", args: [tokenId] });
const meta = book.tokens.find((t) => BigInt(t.id) === tokenId);
await send("prove metadata", {
  address: ledger, abi: LEDGER.abi, functionName: "proveMetadataViaDirectory",
  args: [backpack, tokenId, book.directoryObject, meta.metadataObject, route, HINTS[Number(tokenId)]],
});
await send("bind artwork", {
  address: ledger, abi: LEDGER.abi, functionName: "bindAsset", args: [backpack, tokenId, meta.imageObject, "image"],
});
await send("bind backdrop", {
  address: ledger, abi: LEDGER.abi, functionName: "bindBackdrop", args: [backpack, tokenId, backdrops[Number(tokenId)].canvas],
});
// The pre-encoded artwork and the carried viewer were built for one particular
// token. Binding another token's bytes would be refused on chain, so they are
// only offered when they are this token's.
if (BigInt(book.renderFor ?? 0) === tokenId && book.artObject) {
  await send("bind render", {
    address: ledger, abi: LEDGER.abi, functionName: "bindRender", args: [backpack, tokenId, book.artObject],
  });
  await send("bind viewer", {
    address: ledger, abi: LEDGER.abi, functionName: "bindViewer", args: [backpack, tokenId, book.viewerObject],
  });
} else {
  console.log("      render/viewer belong to another token — skipped");
}

const mainnet = await fetch(MAINNET_RPC, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
}).then((r) => r.json()).then((b) => BigInt(b.result.baseFeePerGas)).catch(() => null);

const closing = await pub.getBalance({ address: account.address });
console.log(`\ngas used    ${gasUsed.toLocaleString()}`);
if (mainnet) console.log(`on mainnet  ${formatEther(gasUsed * mainnet)} ETH  <- what this work costs`);
console.log(`on testnet  ${formatEther(opening - closing)} ETH billed, ${formatEther(closing)} left`);

Object.assign(book, { builder, factory, ledger, backpack });
writeFileSync("scripts/backpack-demo-sepolia.json", `${JSON.stringify(book, null, 2)}\n`);
console.log("\nwrote scripts/backpack-demo-sepolia.json");
