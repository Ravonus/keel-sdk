/**
 * Make a token's viewer carry its own artwork.
 *
 * The document becomes a KeelHold composite of
 *
 *   [ head , body , artwork(base64) , tail ]
 *
 * so the preserved bytes arrive with the page instead of being fetched from a
 * node at render time. Rendering it and holding the artwork become the same act:
 * nothing to go and get, no host to be down or dishonest, and a chain that can
 * confirm the document really does contain the bytes this token proved, because
 * the artwork object is one of the composite's own parts.
 *
 * The artwork part is stored base64 and flagged `;base64` in its media type. It
 * costs a third more to store, once, and saves an encode on every read forever —
 * and it is the form the document needs anyway, so the same object serves both.
 *
 *   node scripts/burn-artwork-into-viewer.mjs --token 4
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://ethereum-rpc.publicnode.com";
const VIEWER = process.env.KEEL_VIEWER_HTML;
const FIXTURES = "packages/contracts/test/fixtures";

const argv = process.argv.slice(2);
const tokenId = Number(argv[argv.indexOf("--token") + 1]);
if (!Number.isInteger(tokenId)) throw new Error("pass --token <id>");

const art = (file, name) => JSON.parse(readFileSync(`packages/contracts/out/${file}/${name}.json`, "utf8"));
const CS = art("KeelHold.sol", "KeelHold");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");

const book = JSON.parse(readFileSync("scripts/backpack-demo-sepolia.json", "utf8"));
const account = privateKeyToAccount(JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

const TIP = 100_000_000n;
async function fees() {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  // The cap must clear base *and* the tip; 1.3x of base alone fails outright
  // whenever the base fee dips below the tip.
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
  console.log(`  ${String(++step).padStart(2)}. ${label.padEnd(32)} ${receipt.gasUsed.toLocaleString().padStart(11)} gas`);
  return receipt;
}

const sha256 = async (bytes) => `0x${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;

/** Put content in the store, reusing anything this chain already holds. */
async function store(label, bytes, mediaType) {
  const CHUNK = 23_000;
  const ids = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
    const id = keccak256(toHex(chunk));
    ids.push(id);
    const pointer = await pub.readContract({
      address: book.keelHold, abi: CS.abi, functionName: "slugPointer", args: [id],
    });
    if (pointer === "0x0000000000000000000000000000000000000000") {
      await send(`chunk ${label} ${ids.length}`, {
        address: book.keelHold, abi: CS.abi, functionName: "castSlug", args: [hex(chunk)],
      });
    }
  }
  const digest = await sha256(bytes);
  const receipt = await send(`object ${label}`, {
    address: book.keelHold, abi: CS.abi, functionName: "weldObject",
    args: [ids, digest, BigInt(bytes.length), 0, mediaType],
  });
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === book.keelHold.toLowerCase());
  return log.topics[1];
}

// ---------------------------------------------------------------------------

const opening = await pub.getBalance({ address: account.address });
console.log(`deployer ${account.address}`);
console.log(`balance  ${formatEther(opening)} ETH\n`);

const base = VIEWER.replace(/\.html$/, "");
const head = new Uint8Array(readFileSync(`${base}.head.html`));
const body = new Uint8Array(readFileSync(`${base}.body.html`));
const tail = new Uint8Array(readFileSync(`${base}.tail.html`));
const artwork = new Uint8Array(readFileSync(`${FIXTURES}/bayc-ape-${tokenId}.png`));
const encoded = new TextEncoder().encode(Buffer.from(artwork).toString("base64"));

console.log(`— the document, in parts —`);
console.log(`  head ${head.length.toLocaleString()} B · body ${body.length.toLocaleString()} B` +
  ` · artwork ${encoded.length.toLocaleString()} B · tail ${tail.length.toLocaleString()} B\n`);

const headObject = await store("head", head, "text/html");
const bodyObject = await store("body", body, "text/html");
const tailObject = await store("tail", tail, "text/html");
// Flagged, so a reader can hand these bytes to a data URI without inspecting
// them — which is only safe because nothing unflagged can reach that path.
const artObject = await store(`artwork #${tokenId}`, encoded, "image/png;base64");

// The digest covers the document as assembled, before any context is spliced in;
// that is exactly what the builder re-hashes before it injects, so a document
// cannot be smuggled past verification by way of its context.
const assembled = new Uint8Array([...head, ...body, ...encoded, ...tail]);
const digest = await sha256(assembled);

const composite = await send("compose the document", {
  address: book.keelHold, abi: CS.abi, functionName: "weldComposite",
  args: [[headObject, bodyObject, artObject, tailObject], digest, BigInt(assembled.length), "text/html"],
});
const compositeId = composite.logs.find((e) => e.address.toLowerCase() === book.keelHold.toLowerCase()).topics[1];
console.log(`      document ${compositeId}`);

await send(`bind viewer #${tokenId}`, {
  address: book.ledger, abi: LEDGER.abi, functionName: "bindViewer",
  args: [book.backpack, BigInt(tokenId), compositeId],
});

const mainnet = await fetch(MAINNET_RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
})
  .then((r) => r.json())
  .then((b) => BigInt(b.result.baseFeePerGas))
  .catch(() => null);

const closing = await pub.getBalance({ address: account.address });
console.log(`\ngas used    ${gasUsed.toLocaleString()}`);
if (mainnet) console.log(`on mainnet  ${formatEther(gasUsed * mainnet)} ETH  <- what this work costs`);
console.log(`on testnet  ${formatEther(opening - closing)} ETH billed, ${formatEther(closing)} left`);

book.viewerObject = compositeId;
book.viewerDigest = digest;
book.artObject = artObject;
writeFileSync("scripts/backpack-demo-sepolia.json", `${JSON.stringify(book, null, 2)}\n`);
console.log("\nwrote scripts/backpack-demo-sepolia.json");
