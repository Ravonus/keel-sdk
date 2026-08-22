// Puts Bored Ape #1 on-chain, end to end, on Sepolia.
//
// Nothing here trusts the gateway the fixtures came from: every block is
// re-hashed by the contracts and compared to the CID mainnet's BAYC commits to.
// If the bytes are not the ones BAYC named, the transaction reverts.
//
// Resumable by construction — KeelHold keys chunks by content hash and returns
// the existing pointer, so re-running skips what is already stored.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.KEEL_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const KEY_FILE = process.env.KEEL_DEPLOYER_FILE ?? ".secrets/vault-sepolia-deployer.json";
const KEY = process.env.KEEL_DEPLOYER_PRIVATE_KEY || JSON.parse(readFileSync(KEY_FILE, "utf8")).privateKey;

const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));

const art = (path, name) =>
  JSON.parse(readFileSync(`packages/contracts/out/${path}/${name}.json`, "utf8"));
const CHUNK_STORE = art("KeelHold.sol", "KeelHold");
const FACTORY = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");
const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const BAYC = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const account = privateKeyToAccount(KEY.startsWith("0x") ? KEY : `0x${KEY}`);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const send = async (label, req) => {
  // viem sends the bare estimate. Reading a 468 KB object back out of KeelHold
  // lands close enough to that number that a slightly different block tips it
  // into an out-of-gas revert with no reason data, so estimate and add headroom.
  if (!req.gas) {
    const estimate = await pub.estimateContractGas({ ...req, account });
    req = { ...req, gas: (estimate * 115n) / 100n };
  }
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return r;
};

const CHUNK = 23000;
const store = async (label, bytes, mediaType) => {
  const total = Math.ceil(bytes.length / CHUNK);
  const slugIds = [];
  let gas = 0n;
  for (let i = 0; i < total; i++) {
    const slice = `0x${Buffer.from(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)).toString("hex")}`;
    const id = await pub.readContract({
      address: D.keelHold, abi: CHUNK_STORE.abi, functionName: "slugPointer",
      args: [`0x${Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(0))).toString("hex")}`],
    }).catch(() => null);
    void id;
    const r = await send(`${label} chunk ${i + 1}/${total}`, {
      address: D.keelHold, abi: CHUNK_STORE.abi, functionName: "castSlug", args: [slice],
    });
    gas += r.gasUsed;
    // The chunk id is keccak256 of the payload; read it back from the event.
    const log = r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase());
    slugIds.push(log.topics[1]);
    process.stdout.write(`\r  ${label}: ${i + 1}/${total} chunks (${gas} gas)`);
  }
  const digest = `0x${Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex")}`;
  const r = await send(`${label} weldObject`, {
    address: D.keelHold, abi: CHUNK_STORE.abi, functionName: "weldObject",
    args: [slugIds, digest, BigInt(bytes.length), 0, mediaType],
  });
  gas += r.gasUsed;
  const objectId = r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase()).topics[1];
  console.log(`\r  ${label}: stored ${bytes.length}B in ${total} chunks -> ${objectId} (${gas} gas)`);
  return objectId;
};

console.log(`deployer ${account.address}`);
console.log(`balance  ${formatEther(await pub.getBalance({ address: account.address }))} ETH\n`);
const before = await pub.getBalance({ address: account.address });

// 1. A stand-in BAYC returning the exact string mainnet returns.
let bayc = D.bayc;
if (!bayc) {
  const hash = await wallet.deployContract({ abi: BAYC.abi, bytecode: BAYC.bytecode.object, args: [] });
  bayc = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  console.log(`BAYC stand-in            ${bayc}`);
  D.bayc = bayc;
  writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
}

// 2. Its canonical backpack. Permissionless, no arguments.
let backpack = await pub.readContract({
  address: D.factory, abi: FACTORY.abi, functionName: "predictBackpack", args: [bayc],
});
const initialized = await pub.readContract({
  address: D.factory, abi: FACTORY.abi, functionName: "isInitialized", args: [bayc],
});
if (!initialized) {
  await send("init backpack", { address: D.factory, abi: FACTORY.abi, functionName: "init", args: [bayc] });
}
console.log(`backpack                 ${backpack}\n`);

// 3. The real blocks BAYC's tokenURI resolves to.
const directory = new Uint8Array(readFileSync("packages/contracts/test/fixtures/bayc-directory.bin"));
const metadata = new Uint8Array(readFileSync("packages/contracts/test/fixtures/bayc-token-1.json"));
const image = new Uint8Array(readFileSync("packages/contracts/test/fixtures/bayc-ape-1.png"));

D.metadataObject = D.metadataObject ?? (await store("metadata", metadata, "application/json"));
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
D.imageObject = D.imageObject ?? (await store("ape image", image, "image/png"));
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
D.directoryObject = D.directoryObject ?? (await store("directory", directory, "application/vnd.ipld.dag-pb"));
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));

// 4. Mint ape #1 and wrap it with a single transfer.
const owner = await pub.readContract({ address: bayc, abi: BAYC.abi, functionName: "ownerOf", args: [1n] }).catch(() => null);
if (!owner) {
  await send("mint ape #1", { address: bayc, abi: BAYC.abi, functionName: "mint", args: [account.address, 1n] });
}
if ((owner ?? account.address).toLowerCase() !== backpack.toLowerCase()) {
  await send("wrap ape #1", {
    address: bayc, abi: BAYC.abi,
    functionName: "safeTransferFrom", args: [account.address, backpack, 1n],
  });
  console.log("wrapped ape #1");
}

// 5. Link A: what the route said, sealed to a block.
const ladder = await pub.readContract({ address: D.ledger, abi: LEDGER.abi, functionName: "ladderOf", args: [backpack, 1n] });
if (ladder.observation.blockNumber === 0n) {
  await send("pinObservation", { address: D.ledger, abi: LEDGER.abi, functionName: "pinObservation", args: [backpack, 1n] });
}
if (!(await pub.readContract({ address: D.ledger, abi: LEDGER.abi, functionName: "ladderOf", args: [backpack, 1n] })).observation.isSealed) {
  await send("sealObservation", { address: D.ledger, abi: LEDGER.abi, functionName: "sealObservation", args: [backpack, 1n] });
}
console.log("observation pinned and sealed");

const uri = await pub.readContract({ address: bayc, abi: BAYC.abi, functionName: "tokenURI", args: [1n] });
console.log(`route                    ${uri}`);

// 6. Links B/C: the directory is the one BAYC named, and entry "1" is our bytes.
await send("proveMetadataViaDirectory", {
  address: D.ledger, abi: LEDGER.abi, functionName: "proveMetadataViaDirectory",
  args: [backpack, 1n, D.directoryObject, D.metadataObject, uri, 45n],
});
// 7. Link D: the PNG is the one that metadata points at.
await send("bindAsset", {
  address: D.ledger, abi: LEDGER.abi, functionName: "bindAsset",
  args: [backpack, 1n, D.imageObject, "image"],
});

const complete = await pub.readContract({ address: D.ledger, abi: LEDGER.abi, functionName: "ladderComplete", args: [backpack, 1n] });
const lane = await pub.readContract({ address: D.ledger, abi: LEDGER.abi, functionName: "weakestLane", args: [backpack, 1n] });
const json = await pub.readContract({ address: backpack, abi: BACKPACK.abi, functionName: "tokenJSON", args: [1n] });

const after = await pub.getBalance({ address: account.address });
console.log(`\nladderComplete           ${complete}`);
console.log(`weakestLane              ${["Unproven","Attested","Committed","Native"][lane]}`);
console.log(`\ntokenJSON:\n${json}`);
console.log(`\nspent ${formatEther(before - after)} ETH, left ${formatEther(after)} ETH`);
writeFileSync("scripts/backpack-sepolia.json", JSON.stringify({ ...D, backpack }, null, 2));
