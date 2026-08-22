// Assembles the on-chain Keel viewer document for Bored Ape #1.
//
// The document is a KeelHold composite of
//   [shell prefix, entrypoint fragment, ape fragment, shell suffix, raw ape]
// The first four are the viewer itself: the committed Keel shell wrapped
// around this token's own bytes, so rendering it and verifying it are the same
// act. The fifth is the raw ape object the ledger already proved — appended
// after </html>, where a browser ignores it — so `bindViewer` can confirm on
// chain that this document really does contain the bytes this token preserved,
// rather than taking the binder's word for it.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const SCRATCH = process.env.KEEL_SHELL_DIR;
const art = (p, n) => JSON.parse(readFileSync(`packages/contracts/out/${p}/${n}.json`, "utf8"));
const CS = art("KeelHold.sol", "KeelHold");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");

const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const fees = async () => {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (base * 1125n) / 1000n, maxPriorityFeePerGas: 1_000_000n };
};
const send = async (label, req) => {
  const estimate = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (estimate * 115n) / 100n, ...(await fees()) });
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
    const r = await send(`${label} ${i + 1}/${total}`, {
      address: D.keelHold, abi: CS.abi, functionName: "castSlug", args: [slice],
    });
    gas += r.gasUsed;
    slugIds.push(r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase()).topics[1]);
    process.stdout.write(`\r  ${label}: ${i + 1}/${total} chunks, ${gas} gas`);
  }
  const digest = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  const r = await send(`${label} weldObject`, {
    address: D.keelHold, abi: CS.abi, functionName: "weldObject",
    args: [slugIds, digest, BigInt(bytes.length), 0, mediaType],
  });
  const id = r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase()).topics[1];
  console.log(`\r  ${label}: ${bytes.length}B -> ${id} (${gas + r.gasUsed} gas)`);
  return id;
};

const before = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(before)} ETH\n`);

if (!D.entryFragmentObject) {
  D.entryFragmentObject = await store("entry fragment", new Uint8Array(readFileSync(`${SCRATCH}/slot-entry.bin`)), "application/json");
  writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
}
if (!D.apeFragmentObject) {
  D.apeFragmentObject = await store("ape fragment", new Uint8Array(readFileSync(`${SCRATCH}/slot-ape.bin`)), "application/json");
  writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
}

if (!D.viewerObject) {
  const parts = [D.shellPrefixObject, D.entryFragmentObject, D.apeFragmentObject, D.shellSuffixObject, D.imageObject];
  const sizes = await Promise.all(parts.map((p) => pub.readContract({ address: D.keelHold, abi: CS.abi, functionName: "getObject", args: [p] })));
  const total = sizes.reduce((a, o) => a + o.byteLength, 0n);
  // The composite's digest is over the concatenation of its children.
  const chunks = [];
  for (const f of ["shell-prefix.bin", "slot-entry.bin", "slot-ape.bin", "shell-suffix.bin"]) chunks.push(new Uint8Array(readFileSync(`${SCRATCH}/${f}`)));
  chunks.push(new Uint8Array(readFileSync("packages/contracts/test/fixtures/bayc-ape-1.png")));
  const joined = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let off = 0; for (const c of chunks) { joined.set(c, off); off += c.length; }
  const digest = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", joined)).toString("hex")}`;
  console.log(`  composite: ${total} bytes across ${parts.length} objects`);
  const r = await send("weldComposite", {
    address: D.keelHold, abi: CS.abi, functionName: "weldComposite",
    args: [parts, digest, total, "text/html"],
  });
  D.viewerObject = r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase()).topics[1];
  console.log(`  viewer object -> ${D.viewerObject} (${r.gasUsed} gas)`);
  writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
}

const r = await send("bindViewer", {
  address: D.ledger, abi: LEDGER.abi, functionName: "bindViewer", args: [D.backpack, 1n, D.viewerObject],
});
console.log(`  bindViewer ${r.gasUsed} gas`);

const after = await pub.getBalance({ address: account.address });
console.log(`\nspent ${formatEther(before - after)} ETH, left ${formatEther(after)} ETH`);
