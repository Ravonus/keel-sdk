// Stores the Keel viewer shell on-chain, once, for every wrapped token to share.
//
// The shell is split into a prefix and a suffix around the envelope's item list,
// so a per-token viewer is a composite object of
// [prefix, item fragments..., suffix] — and the fragments are content-addressed,
// so a second token reusing the same shell pays only for its descriptor.
//
// Stored uncompressed on purpose: KeelHarnessBuilder reconstructs the
// document inside the EVM, and a compressed object cannot be read there.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.KEEL_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const KEY = JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey;
const D = JSON.parse(readFileSync("scripts/backpack-sepolia.json", "utf8"));
const CHUNK_STORE = JSON.parse(readFileSync("packages/contracts/out/KeelHold.sol/KeelHold.json", "utf8"));

const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const send = async (label, req) => {
  const estimate = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (estimate * 115n) / 100n });
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
      address: D.keelHold, abi: CHUNK_STORE.abi, functionName: "castSlug", args: [slice],
    });
    gas += r.gasUsed;
    slugIds.push(r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase()).topics[1]);
    process.stdout.write(`\r  ${label}: ${i + 1}/${total} chunks, ${gas} gas`);
  }
  const digest = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
  const r = await send(`${label} weldObject`, {
    address: D.keelHold, abi: CHUNK_STORE.abi, functionName: "weldObject",
    args: [slugIds, digest, BigInt(bytes.length), 0, mediaType],
  });
  const objectId = r.logs.find((l) => l.address.toLowerCase() === D.keelHold.toLowerCase()).topics[1];
  console.log(`\r  ${label}: ${bytes.length}B -> ${objectId} (${gas + r.gasUsed} gas)`);
  return objectId;
};

const SCRATCH = process.env.KEEL_SHELL_DIR;
const before = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(before)} ETH\n`);

if (!D.shellPrefixObject) {
  D.shellPrefixObject = await store("shell prefix", new Uint8Array(readFileSync(`${SCRATCH}/shell-prefix.bin`)), "text/html");
  writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
}
if (!D.shellSuffixObject) {
  D.shellSuffixObject = await store("shell suffix", new Uint8Array(readFileSync(`${SCRATCH}/shell-suffix.bin`)), "text/html");
  writeFileSync("scripts/backpack-sepolia.json", JSON.stringify(D, null, 2));
}

const after = await pub.getBalance({ address: account.address });
console.log(`\nspent ${formatEther(before - after)} ETH, left ${formatEther(after)} ETH`);
