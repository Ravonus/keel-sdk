// Shared anvil fixture for web3:// boundary tests. Each test file gets its
// own anvil instance (vitest runs files in separate workers), a freshly
// deployed KeelHold + KeelWeb3ResourceAdapter from the Foundry build
// output, and helpers to publish Keel objects.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  concatHex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  sha256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const contractsOut = path.join(repositoryRoot, "packages/contracts/out");

// anvil's first default development account; a publicly known key.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d45d95e78ba";

export const storeAbi = parseAbi([
  "function castSlugs(bytes[] payloads) returns (bytes32[] slugIds,address[] pointers)",
  "function weldObject(bytes32[] slugIds,bytes32 digest,uint64 byteLength,uint8 compression,string mediaType) returns (bytes32 objectId)",
  "function weldComposite(bytes32[] partObjectIds,bytes32 digest,uint64 byteLength,string mediaType) returns (bytes32 objectId)",
  "function readChunk(bytes32 objectId,uint256 index) view returns (bytes data,bool hasNext)",
  "function flatSlugCount(bytes32 objectId) view returns (uint256)",
  "function haulObject(bytes32 objectId) view returns (bytes data)",
]);
export const adapterAbi = parseAbi([
  "function resolveMode() view returns (bytes32)",
  "function request(string[] resource,(string key,string value)[] params) view returns (uint16 statusCode,string body,(string key,string value)[] headers)",
]);

export const Compression = { None: 0, Gzip: 1, Deflate: 2, Brotli: 3 };
export const MAX_SLUG_BYTES = 23_000;

async function forgeBytecode(name) {
  const artifact = JSON.parse(await readFile(path.join(contractsOut, `${name}.sol`, `${name}.json`), "utf8"));
  return artifact.bytecode.object;
}

async function waitForRpc(rpcUrl, deadlineMs = 15_000) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if ((await response.json()).result !== undefined) return;
    } catch {
      // still booting
    }
    if (Date.now() - start > deadlineMs) throw new Error("anvil did not come up");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/// Boots anvil, deploys the boundary contracts, and returns everything a test
/// needs. Call `fixture.stop()` in afterAll.
async function spawnAnvil() {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = 9000 + Math.floor(Math.random() * 20_000);
    const rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
    const exited = new Promise((resolve) => anvil.once("exit", () => resolve("exited")));
    try {
      const outcome = await Promise.race([waitForRpc(rpcUrl).then(() => "ready"), exited]);
      if (outcome === "ready") return { anvil, rpcUrl };
      lastError = new Error(`anvil exited early (port ${port} likely taken)`);
    } catch (error) {
      anvil.kill("SIGKILL");
      lastError = error;
    }
  }
  throw lastError;
}

export async function startBoundaryFixture() {
  const { anvil, rpcUrl } = await spawnAnvil();
  const stop = () => anvil.kill("SIGKILL");
  try {
    const account = privateKeyToAccount(DEV_KEY);
    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    };
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
    // The dev key ships in every anvil genesis but fund it explicitly so the
    // fixture never depends on which mnemonic this anvil build defaults to.
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [account.address, "0x21e19e0c9bab2400000"],
      }),
    });

    async function deploy(name, args) {
      const hash = await walletClient.deployContract({
        abi: name === "KeelWeb3ResourceAdapter" ? parseAbi(["constructor(address store_)"]) : [],
        bytecode: await forgeBytecode(name),
        args: args ?? [],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${name} deploy failed`);
      return receipt.contractAddress;
    }

    const store = await deploy("KeelHold");
    const adapter = await deploy("KeelWeb3ResourceAdapter", [store]);

    /// Publishes a leaf object from raw payload bytes (Uint8Array), splitting
    /// into MAX_SLUG_BYTES carriers. `decodedLength` defaults to the stored
    /// length (uncompressed objects must commit exactly that).
    async function publishLeaf(payload, { compression = Compression.None, mediaType = "text/html", decodedLength } = {}) {
      const chunks = [];
      for (let offset = 0; offset < payload.length; offset += MAX_SLUG_BYTES) {
        chunks.push(toHex(payload.slice(offset, offset + MAX_SLUG_BYTES)));
      }
      for (let offset = 0; offset < chunks.length; offset += 3) {
        const batch = chunks.slice(offset, offset + 3);
        await publicClient.waitForTransactionReceipt({
          hash: await walletClient.writeContract({ address: store, abi: storeAbi, functionName: "castSlugs", args: [batch] }),
        });
      }
      const slugIds = chunks.map((chunk) => keccak256(chunk));
      const joined = concatHex(chunks);
      const args = [
        slugIds,
        sha256(joined),
        BigInt(decodedLength ?? payload.length),
        compression,
        mediaType,
      ];
      const { result: objectId } = await publicClient.simulateContract({
        account: account.address, address: store, abi: storeAbi, functionName: "weldObject", args,
      });
      await publicClient.waitForTransactionReceipt({
        hash: await walletClient.writeContract({ address: store, abi: storeAbi, functionName: "weldObject", args }),
      });
      return { objectId, chunkCount: chunks.length };
    }

    return { rpcUrl, chainId: 31337, publicClient, walletClient, account, store, adapter, publishLeaf, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
