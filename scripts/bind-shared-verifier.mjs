/**
 * Bind a verifier document to a token.
 *
 * The document's chrome — head, body, tail — is shared by every token in the
 * collection and stored once. Only the composite that names those parts is per
 * token, which costs one call rather than a new document, and only that call
 * has to be made again when a token wants its own artwork carried in the slot
 * between them.
 *
 * A shared document must be valid for every token, which is why the chrome
 * holds no artwork of its own: whichever token's bytes it held would be the
 * wrong ones for everybody else. Per-token facts arrive through the context the
 * builder splices into the head slot at read time.
 *
 *   node scripts/bind-shared-verifier.mjs --token 1
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const VIEWER = process.env.KEEL_VIEWER_HTML;
const tokenId = BigInt(process.argv[process.argv.indexOf("--token") + 1] ?? 1);

const art = (f, n) => JSON.parse(readFileSync(`packages/contracts/out/${f}/${n}.json`, "utf8"));
const CS = art("KeelHold.sol", "KeelHold");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");
const book = JSON.parse(readFileSync("scripts/backpack-demo-sepolia.json", "utf8"));
const account = privateKeyToAccount(JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const TIP = 100_000_000n;
const fees = async () => {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  return { maxFeePerGas: (base * 130n) / 100n + TIP, maxPriorityFeePerGas: TIP };
};
let gasUsed = 0n;
let step = 0;
async function send(label, request) {
  const gas = await pub.estimateContractGas({ ...request, account });
  const hash = await wallet.writeContract({ ...request, gas: (gas * 115n) / 100n, ...(await fees()) });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  gasUsed += r.gasUsed;
  console.log(`  ${String(++step).padStart(2)}. ${label.padEnd(30)} ${r.gasUsed.toLocaleString().padStart(11)} gas`);
  return r;
}
const sha256 = async (b) => `0x${Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex")}`;

async function store(label, bytes, mediaType) {
  const ids = [];
  for (let o = 0; o < bytes.length; o += 23_000) {
    const chunk = bytes.subarray(o, Math.min(o + 23_000, bytes.length));
    const id = keccak256(toHex(chunk));
    ids.push(id);
    const p = await pub.readContract({ address: book.keelHold, abi: CS.abi, functionName: "slugPointer", args: [id] });
    if (p === "0x0000000000000000000000000000000000000000") {
      await send(`chunk ${label} ${ids.length}`, {
        address: book.keelHold, abi: CS.abi, functionName: "castSlug",
        args: [`0x${Buffer.from(chunk).toString("hex")}`],
      });
    }
  }
  const digest = await sha256(bytes);
  const r = await send(`object ${label}`, {
    address: book.keelHold, abi: CS.abi, functionName: "weldObject",
    args: [ids, digest, BigInt(bytes.length), 0, mediaType],
  });
  return r.logs.find((l) => l.address.toLowerCase() === book.keelHold.toLowerCase()).topics[1];
}

const opening = await pub.getBalance({ address: account.address });
console.log(`balance ${formatEther(opening)} ETH\n`);

const base = VIEWER.replace(/\.html$/, "");
const head = new Uint8Array(readFileSync(`${base}.head.html`));
const body = new Uint8Array(readFileSync(`${base}.body.html`));
const tail = new Uint8Array(readFileSync(`${base}.tail.html`));

console.log("— shared chrome (stored once for the whole collection) —");
const headObject = book.chromeHead ?? (await store("head", head, "text/html"));
const bodyObject = book.chromeBody ?? (await store("body", body, "text/html"));
const tailObject = book.chromeTail ?? (await store("tail", tail, "text/html"));

console.log(`\n— the composite for token ${tokenId} —`);
const doc = new Uint8Array([...head, ...body, ...tail]);
const parts = [headObject, bodyObject, tailObject];
const composite = await send("compose", {
  address: book.keelHold, abi: CS.abi, functionName: "weldComposite",
  args: [parts, await sha256(doc), BigInt(doc.length), "text/html"],
});
const viewerObject = composite.logs.find((l) => l.address.toLowerCase() === book.keelHold.toLowerCase()).topics[1];
console.log(`      document ${viewerObject}`);

await send(`bind viewer #${tokenId}`, {
  address: book.ledger, abi: LEDGER.abi, functionName: "bindViewer", args: [book.backpack, tokenId, viewerObject],
});

const closing = await pub.getBalance({ address: account.address });
console.log(`\ngas used  ${gasUsed.toLocaleString()}`);
console.log(`billed    ${formatEther(opening - closing)} ETH, ${formatEther(closing)} left`);

Object.assign(book, { chromeHead: headObject, chromeBody: bodyObject, chromeTail: tailObject, viewerObject });
writeFileSync("scripts/backpack-demo-sepolia.json", `${JSON.stringify(book, null, 2)}\n`);
