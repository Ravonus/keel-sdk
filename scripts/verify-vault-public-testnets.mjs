#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { keccak256 } from "../apps/studio/node_modules/viem/_esm/index.js";

const sepoliaRpc =
  process.env.VAULT_SEPOLIA_RPC ??
  "https://ethereum-sepolia-rpc.publicnode.com";
const shadownetRpc =
  process.env.VAULT_SHADOWNET_RPC ?? "https://rpc.shadownet.teztnets.com";
const expectedSepoliaChainId = 11_155_111;
const expectedShadownetChainId = "NetXsqzbfFenSTS";

const sepoliaCheckpoint = JSON.parse(
  await readFile(
    new URL(
      "../.secrets/vault-keel-sepolia-checkpoint-experimental-v15-smoke-corrected.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const shadownetDeployment = JSON.parse(
  await readFile(
    new URL(
      "../packages/tezos/dist/experimental-shadownet-deployment-tzip-v3.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const shadownetResult = JSON.parse(
  await readFile(
    new URL(
      "../packages/tezos/dist/experimental-shadownet-result-tzip-v3.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

async function timed(action) {
  const started = performance.now();
  const value = await action();
  return {
    value,
    milliseconds: Number((performance.now() - started).toFixed(3)),
  };
}

let requestId = 0;
async function evm(method, params = []) {
  return timed(async () => {
    const response = await fetch(sepoliaRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw new Error(
        `Sepolia ${method} failed: ${response.status} ${body.error?.message ?? ""}`,
      );
    }
    return body.result;
  });
}

async function tezos(pathname) {
  return timed(async () => {
    const response = await fetch(`${shadownetRpc}${pathname}`);
    if (!response.ok) {
      throw new Error(`Shadownet ${pathname} failed: ${response.status}`);
    }
    return response.json();
  });
}

const sepoliaChain = await evm("eth_chainId");
if (Number(BigInt(sepoliaChain.value)) !== expectedSepoliaChainId) {
  throw new Error(`Expected Sepolia chain ${expectedSepoliaChainId}`);
}
const sepoliaHead = await evm("eth_getBlockByNumber", ["latest", false]);
const sepoliaBlock = sepoliaHead.value.number;
const sepoliaContracts = [];
for (const [role, descriptor] of Object.entries(sepoliaCheckpoint.contracts)) {
  const code = await evm("eth_getCode", [descriptor.address, sepoliaBlock]);
  const runtimeCodeHash = keccak256(code.value);
  if (runtimeCodeHash !== descriptor.runtimeCodeHash) {
    throw new Error(`Sepolia ${role} runtime code hash changed`);
  }
  sepoliaContracts.push({
    role,
    address: descriptor.address,
    runtimeBytes: (code.value.length - 2) / 2,
    runtimeCodeHash,
    milliseconds: code.milliseconds,
  });
}

const shadownetChain = await tezos("/chains/main/chain_id");
if (shadownetChain.value !== expectedShadownetChainId) {
  throw new Error(`Expected Shadownet chain ${expectedShadownetChainId}`);
}
const shadownetHead = await tezos("/chains/main/blocks/head/hash");
const shadownetHeader = await tezos(
  `/chains/main/blocks/${shadownetHead.value}/header`,
);
const shadownetContracts = [];
for (const [role, address] of Object.entries({
  viewerStore: shadownetDeployment.viewerStore,
  content: shadownetDeployment.content,
  contentValidator: shadownetDeployment.contentValidator,
  seed: shadownetDeployment.seed,
  assets: shadownetDeployment.assets,
  character: shadownetDeployment.character,
  maps: shadownetDeployment.maps,
  arcade: shadownetDeployment.arcade,
  verificationHook: shadownetDeployment.verificationHook,
  verificationRegistry: shadownetDeployment.verificationRegistry,
})) {
  const script = await tezos(
    `/chains/main/blocks/${shadownetHead.value}/context/contracts/${address}/script`,
  );
  const encoded = Buffer.from(JSON.stringify(script.value.code));
  shadownetContracts.push({
    role,
    address,
    codeSections: script.value.code.length,
    rpcCodeSha256: createHash("sha256").update(encoded).digest("hex"),
    milliseconds: script.milliseconds,
  });
}
if (
  shadownetResult.chainId !== expectedShadownetChainId ||
  shadownetResult.collection !== shadownetDeployment.character ||
  shadownetResult.characters.length !== 3 ||
  !shadownetResult.characters.every(
    (character) =>
      character.characterAdminBalance === 0 &&
      character.characterEscrowBalance === 1 &&
      character.hookStoredLiveEqual === true &&
      character.stakedRuntimeExact === true,
  )
) {
  throw new Error("Stored Shadownet terminal receipt is incomplete");
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "keel.vault-public-testnet-readback@1",
      mutation: "none",
      sepolia: {
        chainId: expectedSepoliaChainId,
        pinnedBlockNumber: Number(BigInt(sepoliaBlock)),
        pinnedBlockHash: sepoliaHead.value.hash,
        pinnedTimestamp: Number(BigInt(sepoliaHead.value.timestamp)),
        rpcMilliseconds: {
          chainId: sepoliaChain.milliseconds,
          head: sepoliaHead.milliseconds,
        },
        exactCheckpointRuntimeMatches: sepoliaContracts.length,
        contracts: sepoliaContracts,
        note: "Existing experimental testnet contracts; not the new Vault Runner item/referee deployment.",
      },
      shadownet: {
        chainId: expectedShadownetChainId,
        pinnedBlockHash: shadownetHead.value,
        pinnedLevel: shadownetHeader.value.level,
        pinnedTimestamp: shadownetHeader.value.timestamp,
        rpcMilliseconds: {
          chainId: shadownetChain.milliseconds,
          head: shadownetHead.milliseconds,
          header: shadownetHeader.milliseconds,
        },
        contracts: shadownetContracts,
        storedTerminalCharacters: shadownetResult.characters.map(
          ({ tokenId, recipeDigest, seed, packedAttributes, viewerUrl }) => ({
            tokenId,
            recipeDigest,
            seed,
            packedAttributes,
            viewerUrl,
          }),
        ),
        note: "Fresh existence/code reads plus stored exact-operation terminal receipt; no new Shadownet operation.",
      },
    },
    null,
    2,
  )}\n`,
);
