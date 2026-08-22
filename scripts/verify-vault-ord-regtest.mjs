import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  decodeOrdinalsPortableCommitmentV1,
  hexToBytes,
  ordinalsTargetDigestV1,
  sha256Hex,
} from "../packages/protocol/dist/index.js";

function command(program, args) {
  return execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a Bitcoin regtest RPC port.");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

const fixture = JSON.parse(await readFile(new URL("../tests/fixtures/portable-root-v1.json", import.meta.url), "utf8"));
const strpHex = fixture.strpBytesHex.slice(2);
const strpBytes = hexToBytes(fixture.strpBytesHex);
const commitment = decodeOrdinalsPortableCommitmentV1(strpBytes);
if (commitment.portableRoot !== fixture.portableRoot) throw new Error("STRP portable root differs from the canonical fixture.");
if (commitment.targetDigest !== await ordinalsTargetDigestV1(fixture.anchorRoot)) {
  throw new Error("STRP target digest does not bind the complete portable anchor root.");
}

const datadir = await mkdtemp(path.join(os.tmpdir(), "vault-ord-regtest-"));
const rpcPort = await freePort();
const cliPrefix = ["-regtest", `-datadir=${datadir}`, `-rpcport=${rpcPort}`];
let daemonStarted = false;

try {
  command("bitcoind", [
    "-regtest",
    `-datadir=${datadir}`,
    `-rpcport=${rpcPort}`,
    "-listen=0",
    "-fallbackfee=0.0002",
    "-daemonwait",
  ]);
  daemonStarted = true;
  command("bitcoin-cli", [...cliPrefix, "createwallet", "vault-ord"]);
  const address = command("bitcoin-cli", [...cliPrefix, "getnewaddress"]);
  command("bitcoin-cli", [...cliPrefix, "generatetoaddress", "101", address]);

  const unsigned = command("bitcoin-cli", [
    ...cliPrefix,
    "createrawtransaction",
    "[]",
    JSON.stringify([{ data: strpHex }]),
  ]);
  const funded = JSON.parse(command("bitcoin-cli", [...cliPrefix, "fundrawtransaction", unsigned])).hex;
  const signed = JSON.parse(command("bitcoin-cli", [...cliPrefix, "signrawtransactionwithwallet", funded]));
  if (signed.complete !== true) throw new Error("Bitcoin Core did not completely sign the STRP transaction.");
  const txid = command("bitcoin-cli", [...cliPrefix, "sendrawtransaction", signed.hex]);
  const blockHash = JSON.parse(command("bitcoin-cli", [...cliPrefix, "generatetoaddress", "1", address]))[0];
  const txoutProofHex = command("bitcoin-cli", [...cliPrefix, "gettxoutproof", JSON.stringify([txid]), blockHash]);
  const verifiedTxids = JSON.parse(command("bitcoin-cli", [...cliPrefix, "verifytxoutproof", txoutProofHex]));
  if (verifiedTxids.length !== 1 || verifiedTxids[0] !== txid) throw new Error("Bitcoin Core rejected the STRP transaction Merkle proof.");

  const transaction = JSON.parse(command("bitcoin-cli", [...cliPrefix, "getrawtransaction", txid, "true", blockHash]));
  const nulldata = transaction.vout.filter((entry) => entry.scriptPubKey?.type === "nulldata");
  if (nulldata.length !== 1) throw new Error("STRP transaction must contain exactly one OP_RETURN output.");
  const expectedScript = `6a42${strpHex}`;
  if (nulldata[0].scriptPubKey.hex !== expectedScript) throw new Error("Mined OP_RETURN bytes differ from the canonical STRP payload.");

  const receipt = {
    schema: "keel-ord-regtest-receipt@1",
    network: "regtest",
    proofBoundary: "transaction-output-merkle-proof-not-witness-envelope-proof",
    portableRoot: commitment.portableRoot,
    anchorRoot: fixture.anchorRoot,
    targetDigest: commitment.targetDigest,
    envelopeIndex: commitment.envelopeIndex,
    revision: commitment.revision.toString(),
    strpBytesHex: fixture.strpBytesHex,
    txid,
    blockHash,
    outputIndex: nulldata[0].n,
    scriptPubKeyHex: nulldata[0].scriptPubKey.hex,
    txoutProofHex,
    txoutProofSha256: await sha256Hex(hexToBytes(`0x${txoutProofHex}`)),
    txoutProofBytes: txoutProofHex.length / 2,
    verifiedTxids,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  if (daemonStarted) {
    try { command("bitcoin-cli", [...cliPrefix, "stop"]); } catch {}
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        command("bitcoin-cli", [...cliPrefix, "getblockchaininfo"]);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        break;
      }
    }
  }
  await rm(datadir, { recursive: true, force: true });
}
