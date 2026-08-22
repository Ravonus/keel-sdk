/**
 * The live demo: five real apes, two hands, every state you can put a wrapper in.
 *
 * The deployer keeps a set so every action can be driven and checked here; a
 * second set goes to the address given on the command line so the same actions
 * can be signed from a real wallet. Nothing is simulated — this is Sepolia, the
 * artwork is the artwork BAYC's directory names, and the proofs are the same
 * ones the contracts enforce.
 *
 *   node scripts/keel-backpack-demo.mjs --to 0x…
 *
 * It prices itself first and refuses to start if the balance cannot cover the
 * bytes, because running out of gas halfway leaves a half-proven token behind.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getContractAddress,
  http,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
// Costs are reported at real mainnet gas, never at the sending chain's. Sepolia
// has no fee market — its base fee sits on a floor that has been running three
// to four times above mainnet — so quoting what a rehearsal cost there would
// make preserving an artwork look several times more expensive than it is.
const MAINNET_RPC = process.env.MAINNET_RPC ?? "https://ethereum-rpc.publicnode.com";
const BOOK = "scripts/backpack-sepolia.json";
const FIXTURES = "packages/contracts/test/fixtures";
const VIEWER = process.env.KEEL_VIEWER_HTML;

const argv = process.argv.slice(2);
const recipient = argv[argv.indexOf("--to") + 1];
if (!recipient?.startsWith("0x") || recipient.length !== 42) {
  throw new Error("pass --to 0x… (the wallet that should receive the testable set)");
}

const art = (file, name) => JSON.parse(readFileSync(`packages/contracts/out/${file}/${name}.json`, "utf8"));
const CS = art("KeelHold.sol", "KeelHold");
const FACTORY = art("KeelBackpackFactory.sol", "KeelBackpackFactory");
const LEDGER = art("KeelBackpackProofLedger.sol", "KeelBackpackProofLedger");
const BACKPACK = art("KeelBackpack721.sol", "KeelBackpack721");
const STANDIN = art("KeelBaycEndToEnd.t.sol", "BaycStandIn");

const book = JSON.parse(readFileSync(BOOK, "utf8"));
const account = privateKeyToAccount(JSON.parse(readFileSync(".secrets/vault-sepolia-deployer.json", "utf8")).privateKey);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

/**
 * A fee cap pinned close to base rather than viem's 2x default.
 *
 * The node's allowance is `balance / maxFeePerGas`, so doubling the cap halves
 * the gas a transaction is allowed to buy — and a 5M-gas chunk write then fails
 * with "gas required exceeds allowance" while the balance sits there unused.
 */
const TIP = 100_000_000n; // 0.1 gwei

async function fees() {
  const base = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
  // The cap has to clear base *and* the tip. Taking 1.3x of base alone looks
  // fine until the base fee dips under the tip, at which point every send is
  // rejected for a cap below its own priority fee.
  return { maxFeePerGas: (base * 130n) / 100n + TIP, maxPriorityFeePerGas: TIP };
}

let spent = 0n;
let gasUsed = 0n;
let stepped = 0;

/** What the network people actually transact on is charging right now. */
async function mainnetGasPrice() {
  try {
    const response = await fetch(MAINNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
    });
    const body = await response.json();
    return BigInt(body.result.baseFeePerGas);
  } catch {
    return null;
  }
}

async function send(label, request) {
  const gas = await pub.estimateContractGas({ ...request, account });
  const hash = await wallet.writeContract({ ...request, gas: (gas * 115n) / 100n, ...(await fees()) });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  spent += receipt.gasUsed * receipt.effectiveGasPrice;
  gasUsed += receipt.gasUsed;
  console.log(
    `  ${String(++stepped).padStart(2)}. ${label.padEnd(34)} ${receipt.gasUsed.toLocaleString().padStart(11)} gas`,
  );
  return receipt;
}

async function deploy(name, args) {
  const compiled = art(`${name}.sol`, name);
  const hash = await wallet.deployContract({
    abi: compiled.abi,
    bytecode: compiled.bytecode.object,
    args,
    ...(await fees()),
  });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  spent += receipt.gasUsed * receipt.effectiveGasPrice;
  gasUsed += receipt.gasUsed;
  console.log(`  ${String(++stepped).padStart(2)}. deploy ${name.padEnd(27)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

const sha256 = async (bytes) => `0x${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;
const hex = (bytes) => `0x${Buffer.from(bytes).toString("hex")}`;

/**
 * Put content in the store and return its object id.
 *
 * Chunks are content-keyed, so anything already on this chain costs nothing to
 * "store" again — and `castSlug` emits no event when it recognises the payload,
 * which is why the id is derived here rather than read out of a log.
 */
async function store(label, bytes, mediaType) {
  const CHUNK = 23_000;
  const ids = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
    const id = keccak256(toHex(chunk));
    ids.push(id);
    const pointer = await pub.readContract({
      address: book.keelHold,
      abi: CS.abi,
      functionName: "slugPointer",
      args: [id],
    });
    if (pointer === "0x0000000000000000000000000000000000000000") {
      await send(`castSlug ${label} ${ids.length}`, {
        address: book.keelHold,
        abi: CS.abi,
        functionName: "castSlug",
        args: [hex(chunk)],
      });
    }
  }
  const digest = await sha256(bytes);
  // Mirror the store's own derivation rather than reading the id out of a log:
  // `weldObject` returns early without emitting anything when the object is
  // already there, so on a re-run there is no event to read.
  const indexDigest = keccak256(`0x${ids.map((id) => id.slice(2)).join("")}`);
  const objectId = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes1" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [
        "0x00",
        indexDigest,
        digest,
        BigInt(bytes.length),
        BigInt(bytes.length),
        0,
        keccak256(toHex(mediaType)),
      ],
    ),
  );

  // `getObject` reverts for an id it has never seen rather than returning a
  // record with `exists: false`.
  const existing = await pub
    .readContract({ address: book.keelHold, abi: CS.abi, functionName: "getObject", args: [objectId] })
    .catch(() => null);
  if (existing?.exists) {
    console.log(`  ${String(++stepped).padStart(2)}. object ${label.padEnd(27)} already on chain`);
    return objectId;
  }
  const receipt = await send(`weldObject ${label}`, {
    address: book.keelHold,
    abi: CS.abi,
    functionName: "weldObject",
    args: [ids, digest, BigInt(bytes.length), 0, mediaType],
  });
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === book.keelHold.toLowerCase());
  const emitted = log?.topics[1];
  if (emitted && emitted !== objectId) {
    throw new Error(`object id mismatch: derived ${objectId}, chain said ${emitted}`);
  }
  return objectId;
}

// ---------------------------------------------------------------------------

const opening = await pub.getBalance({ address: account.address });
const baseFee = (await pub.getBlock({ blockTag: "latest" })).baseFeePerGas;
console.log(`deployer ${account.address}`);
console.log(`balance  ${formatEther(opening)} ETH`);
console.log(`base fee ${Number(baseFee) / 1e9} gwei`);
console.log(`to       ${recipient}\n`);

/**
 * Price the run before starting it.
 *
 * Chunks are content-keyed, so only the bytes this chain has never seen cost
 * anything — which on a re-run is usually nothing at all. Running out of gas
 * midway would leave a token wrapped but half-proven, so the balance is checked
 * against the whole job rather than one transaction at a time.
 */
async function priceRun(files) {
  let missing = 0;
  let present = 0;
  for (const path of files) {
    const bytes = new Uint8Array(readFileSync(path));
    for (let offset = 0; offset < bytes.length; offset += 23_000) {
      const chunk = bytes.subarray(offset, Math.min(offset + 23_000, bytes.length));
      const pointer = await pub.readContract({
        address: book.keelHold,
        abi: CS.abi,
        functionName: "slugPointer",
        args: [keccak256(toHex(chunk))],
      });
      if (pointer === "0x0000000000000000000000000000000000000000") missing += chunk.length;
      else present += chunk.length;
    }
  }
  // ~225 gas a byte all in: 200 for the code deposit, 16 for the calldata, and
  // the rest in hashing and bookkeeping.
  const storage = BigInt(missing) * 225n;
  // Deploys, three proof ladders over a 469KB directory, mints, wraps, the
  // freeze and the handover. Generous on purpose.
  const overhead = 45_000_000n;
  const total = storage + overhead;
  const cap = (baseFee * 130n) / 100n + TIP;
  const worst = total * cap;

  console.log(`  bytes to store  ${missing.toLocaleString()} new · ${present.toLocaleString()} already on chain`);
  console.log(`  gas             ${total.toLocaleString()}`);

  // The number that means anything: what this costs where people actually
  // transact. The testnet charge is a faucet question, not a product question.
  const mainnet = await mainnetGasPrice();
  if (mainnet) {
    console.log(
      `  at mainnet      ${formatEther(total * mainnet)} ETH  (${(Number(mainnet) / 1e9).toFixed(4)} gwei)`,
    );
  }
  console.log(`  this testnet    ${formatEther(worst)} ETH worst case at the ${(Number(cap) / 1e9).toFixed(3)} gwei cap`);

  if (worst > opening) {
    throw new Error(
      `this testnet would charge up to ${formatEther(worst)} ETH and the deployer holds ${formatEther(opening)}` +
        (mainnet ? ` — the same work is ${formatEther(total * mainnet)} ETH on mainnet; this is a faucet problem` : ""),
    );
  }
  console.log(`  headroom        ${formatEther(opening - worst)} ETH\n`);
}

await priceRun([
  VIEWER,
  `${FIXTURES}/bayc-directory.bin`,
  ...[1, 2, 4, 5].flatMap((id) => [`${FIXTURES}/bayc-token-${id}.json`, `${FIXTURES}/bayc-ape-${id}.png`]),
]);

// Measured off the preserved bytes by the asset-view module, in the 1000x1000
// units the wrapper renders `image` in. Five apes, five different curves.
const BACKDROPS = JSON.parse(readFileSync("scripts/backpack-backdrops.json", "utf8"));

// Verified byte offsets of each entry inside the real 10,000-link directory.
const HINTS = { 1: 45n, 2: 52_139n, 3: 104_233n, 4: 156_327n, 5: 208_421n };

console.log("— storing the viewer —");
const viewerBytes = new Uint8Array(readFileSync(VIEWER));
const viewerObject = await store("viewer", viewerBytes, "text/html");
const viewerDigest = await sha256(viewerBytes);

console.log("\n— factory and ledger —");
const nonce = await pub.getTransactionCount({ address: account.address });
const predictedLedger = getContractAddress({ from: account.address, nonce: BigInt(nonce + 1) });
const factory = await deploy("KeelBackpackFactory", [
  predictedLedger,
  book.viewerBuilder,
  viewerObject,
  viewerDigest,
]);
const ledger = await deploy("KeelBackpackProofLedger", [
  factory,
  book.keelHold,
  book.attestations,
  book.commitments,
  "0x0000000000000000000000000000000000000000",
]);
if (ledger.toLowerCase() !== predictedLedger.toLowerCase()) {
  throw new Error("ledger did not land on its predicted address");
}

const backpack = await pub.readContract({
  address: factory,
  abi: FACTORY.abi,
  functionName: "predictBackpack",
  args: [book.bayc],
});
await send("init backpack", { address: factory, abi: FACTORY.abi, functionName: "init", args: [book.bayc] });
console.log(`      backpack ${backpack}`);

console.log("\n— the shared directory —");
const directoryObject = await store("directory", new Uint8Array(readFileSync(`${FIXTURES}/bayc-directory.bin`)), "application/vnd.ipld.dag-pb");

/**
 * Get `tokenId` into the new backpack, whatever state it is currently in.
 *
 * The stand-in has been through an earlier deployment, so a token can be
 * unminted, held by the deployer, or still escrowed in the superseded backpack.
 * All three are recoverable and none of them should need a human to intervene.
 */
async function bring(tokenId) {
  const id = BigInt(tokenId);
  let owner = null;
  try {
    owner = await pub.readContract({ address: book.bayc, abi: STANDIN.abi, functionName: "ownerOf", args: [id] });
  } catch {
    owner = null;
  }

  if (owner === null) {
    await send(`mint #${tokenId}`, {
      address: book.bayc,
      abi: STANDIN.abi,
      functionName: "mint",
      args: [account.address, id],
    });
    owner = account.address;
  }

  if (owner.toLowerCase() === backpack.toLowerCase()) return;

  // Escrowed in a previous backpack: the deployer holds that wrapper, so the
  // ape comes back out the same way anybody else's would — unless that wrapper
  // was frozen, in which case it is staying there and no amount of retrying
  // will change that. Which is the whole point of freezing.
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    const custody = await pub
      .readContract({ address: owner, abi: BACKPACK.abi, functionName: "custodyOf", args: [id] })
      .catch(() => 0);
    if (Number(custody) === 2) {
      throw new Error(
        `ape #${tokenId} is frozen inside ${owner} and cannot be recovered. Pick a different token id.`,
      );
    }
    await send(`recover #${tokenId} from old backpack`, {
      address: owner,
      abi: BACKPACK.abi,
      functionName: "withdraw",
      args: [id],
    });
  }

  await send(`wrap #${tokenId}`, {
    address: book.bayc,
    abi: STANDIN.abi,
    functionName: "safeTransferFrom",
    args: [account.address, backpack, id],
  });
}

const objects = {};

/** Prove a wrapped token's artwork all the way down to the bytes. */
async function preserve(tokenId) {
  const id = BigInt(tokenId);
  const metadataObject = await store(
    `metadata #${tokenId}`,
    new Uint8Array(readFileSync(`${FIXTURES}/bayc-token-${tokenId}.json`)),
    "application/json",
  );
  const imageObject = await store(
    `artwork #${tokenId}`,
    new Uint8Array(readFileSync(`${FIXTURES}/bayc-ape-${tokenId}.png`)),
    "image/png",
  );
  objects[tokenId] = { metadataObject, imageObject };

  await bring(tokenId);

  const pin = await send(`pin observation #${tokenId}`, {
    address: ledger,
    abi: LEDGER.abi,
    functionName: "pinObservation",
    args: [backpack, id],
  });
  // Sealing reads the pinned block's hash, which does not exist until a later
  // block has been mined. Wait on the block the pin actually landed in rather
  // than on "now", which is the same thing the instant the receipt arrives.
  while ((await pub.getBlockNumber()) <= pin.blockNumber) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await send(`seal observation #${tokenId}`, {
    address: ledger,
    abi: LEDGER.abi,
    functionName: "sealObservation",
    args: [backpack, id],
  });

  const route = await pub.readContract({
    address: book.bayc,
    abi: STANDIN.abi,
    functionName: "tokenURI",
    args: [id],
  });
  await send(`prove metadata #${tokenId}`, {
    address: ledger,
    abi: LEDGER.abi,
    functionName: "proveMetadataViaDirectory",
    args: [backpack, id, directoryObject, metadataObject, route, HINTS[tokenId]],
  });
  await send(`bind artwork #${tokenId}`, {
    address: ledger,
    abi: LEDGER.abi,
    functionName: "bindAsset",
    args: [backpack, id, imageObject, "image"],
  });
  await send(`bind backdrop #${tokenId}`, {
    address: ledger,
    abi: LEDGER.abi,
    functionName: "bindBackdrop",
    args: [backpack, id, BACKDROPS[tokenId].canvas],
  });
  await send(`bind viewer #${tokenId}`, {
    address: ledger,
    abi: LEDGER.abi,
    functionName: "bindViewer",
    args: [backpack, id, viewerObject],
  });
}

console.log("\n— deployer's set: #1 sealed, #5 to be frozen —");
await preserve(1);
await preserve(5);

console.log("\n— your set: #4 sealed and proven, #2 raw —");
await preserve(4);
await send("hand over wrapper #4", {
  address: backpack,
  abi: BACKPACK.abi,
  functionName: "transferFrom",
  args: [account.address, recipient, 4n],
});
// The raw ape's bytes go on chain now, so that when it is wrapped the proof
// ladder can be closed immediately instead of leaving it stuck at "unproven".
objects[2] = {
  metadataObject: await store("metadata #2", new Uint8Array(readFileSync(`${FIXTURES}/bayc-token-2.json`)), "application/json"),
  imageObject: await store("artwork #2", new Uint8Array(readFileSync(`${FIXTURES}/bayc-ape-2.png`)), "image/png"),
};
await send("mint raw ape #2 to you", {
  address: book.bayc,
  abi: STANDIN.abi,
  functionName: "mint",
  args: [recipient, 2n],
});

console.log("\n— the states, on chain —");
// #1 is emptied so the unwrapped frame is live and visible rather than
// described; #5 is frozen so the one-way claim can be tested against a real
// contract rather than a test harness.
await send("empty #1 (shows the red frame)", {
  address: backpack,
  abi: BACKPACK.abi,
  functionName: "withdraw",
  args: [1n],
});
await send("freeze #5 forever", {
  address: backpack,
  abi: BACKPACK.abi,
  functionName: "freeze",
  args: [5n],
});

const closing = await pub.getBalance({ address: account.address });
const settled = await mainnetGasPrice();
console.log(`\ngas used  ${gasUsed.toLocaleString()}`);
if (settled) {
  console.log(
    `on mainnet  ${formatEther(gasUsed * settled)} ETH at ${(Number(settled) / 1e9).toFixed(4)} gwei` +
      `  <- what this work costs`,
  );
}
console.log(`on testnet  ${formatEther(spent)} ETH billed here, ${formatEther(closing)} ETH left`);

const deployment = {
  chainId: 11155111,
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  keelHold: book.keelHold,
  collection: book.bayc,
  factory,
  ledger,
  backpack,
  viewerObject,
  viewerDigest,
  directoryObject,
  deployer: account.address,
  tester: recipient,
  // The route the collection itself returns, with the id left open. The console
  // rebuilds it rather than being handed one per token, because the ledger
  // checks this string against what `tokenURI` actually says.
  route: "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/{id}",
  // What each token's metadata names as its artwork. The console recomputes the
  // same CID from whatever file you hand it, so a mismatch is visible before
  // any transaction is signed.
  cids: {
    1: "QmPbxeGcXhYQQNgsC6a36dDyYUcHgMLnGKnF8pVFmGsvqi",
    2: "QmcJYkCKK7QPmYWjp4FD2e3Lv5WCGFuHNUByvGKBaytif4",
    3: "QmYxT4LnK8sqLupjbS6eRvu1si7Ly2wFQAqFebxhWntcf6",
    4: "QmSg9bPzW9anFYc3wWU5KnvymwkxQTpmqcRSfYj7UmiBa7",
    5: "QmNwbd7ctEhGpVkP8nZvBBQfiNeFKRdxftJAxxEdkUKLcQ",
  },
  // Everything the console needs to close a proof ladder itself: the shared
  // directory, this token's bytes, the verified offset of its entry, and the
  // backdrop measured off those same bytes.
  tokens: [
    { id: 4, note: "yours — sealed and fully proven", ...objects[4], hint: Number(HINTS[4]), backdrop: BACKDROPS[4].canvas },
    { id: 2, note: "yours — raw, wrap it yourself", ...objects[2], hint: Number(HINTS[2]), backdrop: BACKDROPS[2].canvas },
    { id: 1, note: "deployer — emptied, wears the red curved frame", ...objects[1], hint: Number(HINTS[1]), backdrop: BACKDROPS[1].canvas },
    { id: 5, note: "deployer — frozen forever", ...objects[5], hint: Number(HINTS[5]), backdrop: BACKDROPS[5].canvas },
  ],
};

writeFileSync("scripts/backpack-demo-sepolia.json", `${JSON.stringify(deployment, null, 2)}\n`);
console.log("\nwrote scripts/backpack-demo-sepolia.json");

// The console is generated by its own script, so it can be rebuilt after an
// edit without re-running everything above.
const { execFileSync } = await import("node:child_process");
execFileSync("node", ["scripts/build-backpack-console.mjs"], { stdio: "inherit" });
