#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
} from "../apps/studio/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../apps/studio/node_modules/viem/_esm/accounts/index.js";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const rpcUrl = process.env.VAULT_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const outputPath = process.env.VAULT_SEPOLIA_STAKE_OUTPUT
  ? path.resolve(repositoryRoot, process.env.VAULT_SEPOLIA_STAKE_OUTPUT)
  : undefined;
const expectedChainId = 11_155_111;
const secret = JSON.parse(await readFile(path.join(repositoryRoot, ".secrets/vault-sepolia-deployer.json"), "utf8"));
const account = privateKeyToAccount(secret.privateKey);
if (account.address.toLowerCase() !== String(secret.address).toLowerCase()) throw new Error("Sepolia deployer secret does not match its declared address.");

const transport = http(rpcUrl, { timeout: 45_000, retryCount: 3 });
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });
if (await publicClient.getChainId() !== expectedChainId) throw new Error("RPC is not Ethereum Sepolia.");

const artifact = async (relativePath) => {
  const value = JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
  const bytecode = value.bytecode?.object;
  if (!Array.isArray(value.abi) || !/^0x[0-9a-f]+$/iu.test(bytecode ?? "")) throw new Error(`Invalid Foundry artifact: ${relativePath}`);
  return { abi: value.abi, bytecode };
};

const registryArtifact = await artifact("packages/contracts/out/KeelStakeObjectManager.t.sol/StakeObjectRegistryMock.json");
const nftArtifact = await artifact("packages/contracts/out/KeelStakeObjectManager.t.sol/StakeObject721Mock.json");
const managerArtifact = await artifact("packages/contracts/out/KeelStakeObjectManager.sol/KeelStakeObjectManager.json");

const operations = [];
const recordReceipt = (label, receipt) => {
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${receipt.transactionHash}`);
  operations.push({
    label,
    transactionHash: receipt.transactionHash,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
    contractAddress: receipt.contractAddress ?? undefined,
  });
};
const wait = async (label, hash) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  recordReceipt(label, receipt);
  return receipt;
};
const deploy = async (label, contractArtifact, args = []) => {
  const hash = await walletClient.deployContract({
    account,
    abi: contractArtifact.abi,
    bytecode: contractArtifact.bytecode,
    args,
  });
  const receipt = await wait(label, hash);
  if (!receipt.contractAddress) throw new Error(`${label} did not produce a contract address.`);
  return receipt.contractAddress;
};
const write = async (label, address, abi, functionName, args = []) => {
  const simulation = await publicClient.simulateContract({ account, address, abi, functionName, args });
  const hash = await walletClient.writeContract(simulation.request);
  return wait(label, hash);
};
const read = (address, abi, functionName, args = [], blockNumber) => publicClient.readContract({ address, abi, functionName, args, blockNumber });
const digest = (label) => keccak256(stringToHex(`keel-stake-object-sepolia-smoke:${label}:v1`));

const startBlock = await publicClient.getBlock({ blockTag: "latest" });
const registry = await deploy("deploy-object-registry-smoke", registryArtifact);
const hosts = await deploy("deploy-host-erc721-smoke", nftArtifact);
const characters = await deploy("deploy-character-erc721-smoke", nftArtifact);
const manager = await deploy("deploy-stake-object-manager", managerArtifact, [registry]);

const codeObjectId = digest("vault-runner-map-code");
const viewerId = digest("vault-keel-viewer");
const saltOne = digest("map-one");
const saltTwo = digest("map-two");
const objectOne = await read(manager, managerArtifact.abi, "predictStakeObjectId", [account.address, saltOne]);
const objectTwo = await read(manager, managerArtifact.abi, "predictStakeObjectId", [account.address, saltTwo]);
const emptyBackpack = { registry: "0x0000000000000000000000000000000000000000", implementation: "0x0000000000000000000000000000000000000000", salt: `0x${"00".repeat(32)}` };

await write("register-map-code-revision", registry, registryArtifact.abi, "setRevision", [codeObjectId, 1n, true]);
await write("mint-map-one", hosts, nftArtifact.abi, "mint", [account.address, 1n]);
await write("mint-map-two", hosts, nftArtifact.abi, "mint", [account.address, 2n]);
await write("mint-character-ten", characters, nftArtifact.abi, "mint", [account.address, 10n]);
await write("mint-character-eleven", characters, nftArtifact.abi, "mint", [account.address, 11n]);
await write("create-map-one-stake-object", manager, managerArtifact.abi, "createStakeObject", [saltOne, hosts, 1n, characters, viewerId, emptyBackpack]);
await write("create-map-two-stake-object", manager, managerArtifact.abi, "createStakeObject", [saltTwo, hosts, 2n, characters, viewerId, emptyBackpack]);
await write("configure-map-one-runtime", manager, managerArtifact.abi, "configureRuntime", [objectOne, codeObjectId, 1n, 4, digest("seed-one"), digest("args-one"), digest("vars-one"), digest("runtime-one")]);
await write("configure-map-two-runtime", manager, managerArtifact.abi, "configureRuntime", [objectTwo, codeObjectId, 1n, 4, digest("seed-two"), digest("args-two"), digest("vars-two"), digest("runtime-two")]);
// UntilDisabled demonstrates an immutable verifier-readable rule without
// waiting for wall-clock time on a public testnet.
await write("configure-map-one-lockup", manager, managerArtifact.abi, "configureLockup", [objectOne, 2, 0n]);
await write("stake-character-ten-map-one", manager, managerArtifact.abi, "stake", [objectOne, 10n]);
await write("stake-character-eleven-map-one", manager, managerArtifact.abi, "stake", [objectOne, 11n]);

const twoCharactersSameMapBlock = await publicClient.getBlockNumber();
const twoCharactersSameMap = {
  characterTen: await read(manager, managerArtifact.abi, "stakeObjectState", [objectOne, 10n], twoCharactersSameMapBlock),
  characterEleven: await read(manager, managerArtifact.abi, "stakeObjectState", [objectOne, 11n], twoCharactersSameMapBlock),
  characterTenOwner: await read(characters, nftArtifact.abi, "ownerOf", [10n], twoCharactersSameMapBlock),
  characterElevenOwner: await read(characters, nftArtifact.abi, "ownerOf", [11n], twoCharactersSameMapBlock),
};
let lockedUnstakeRejected = false;
try {
  await publicClient.simulateContract({ account, address: manager, abi: managerArtifact.abi, functionName: "unstake", args: [objectOne, 10n] });
} catch {
  lockedUnstakeRejected = true;
}
if (!lockedUnstakeRejected) throw new Error("UntilDisabled lockup did not reject unstake while enabled.");

await write("disable-map-one", manager, managerArtifact.abi, "setStakeObjectEnabled", [objectOne, false]);
await write("unstake-character-ten-map-one", manager, managerArtifact.abi, "unstake", [objectOne, 10n]);
await write("stake-character-ten-map-two", manager, managerArtifact.abi, "stake", [objectTwo, 10n]);

const crossMapBlock = await publicClient.getBlockNumber();
const crossMapState = await read(manager, managerArtifact.abi, "stakeObjectState", [objectTwo, 10n], crossMapBlock);
const mapOneCounts = await read(manager, managerArtifact.abi, "stakeCounts", [objectOne, characters, 10n], crossMapBlock);
const packedCounts = await read(manager, managerArtifact.abi, "packedStakeCounts", [objectOne, characters, 10n], crossMapBlock);
const globalCounts = await read(manager, managerArtifact.abi, "globalStakeCounts", [], crossMapBlock);
const packed = BigInt(packedCounts);
const decodedPackedCounts = {
  objectTokenLifetime: Number(packed >> 216n),
  objectLifetime: Number((packed >> 176n) & ((1n << 40n) - 1n)),
  objectActive: Number((packed >> 144n) & ((1n << 32n) - 1n)),
  tokenLifetime: Number((packed >> 104n) & ((1n << 40n) - 1n)),
  tokenActive: Number((packed >> 72n) & ((1n << 32n) - 1n)),
  globalLifetime: Number((packed >> 32n) & ((1n << 40n) - 1n)),
  globalActive: Number(packed & ((1n << 32n) - 1n)),
};

if (twoCharactersSameMap.characterTenOwner.toLowerCase() !== manager.toLowerCase() || twoCharactersSameMap.characterElevenOwner.toLowerCase() !== manager.toLowerCase()) throw new Error("Manager custody was not visible while staked.");
if (!twoCharactersSameMap.characterTen.active || !twoCharactersSameMap.characterEleven.active || twoCharactersSameMap.characterTen.objectActive !== 2n) throw new Error("Many-character map stake readback failed.");
if (!crossMapState.active || crossMapState.tokenLifetime !== 2n || crossMapState.globalLifetime !== 3n || crossMapState.globalActive !== 2n) throw new Error("Cross-map/global count readback failed.");
if (mapOneCounts[0] !== 1n || mapOneCounts[1] !== 2n || mapOneCounts[2] !== 1n || mapOneCounts[3] !== 2n || mapOneCounts[4] !== 1n) throw new Error("Map/character count tuple is incorrect.");
if (Object.entries(decodedPackedCounts).some(([key, value]) => value !== ({ objectTokenLifetime: 1, objectLifetime: 2, objectActive: 1, tokenLifetime: 2, tokenActive: 1, globalLifetime: 3, globalActive: 2 })[key])) throw new Error("Packed stake count layout is incorrect.");

// Restore both original token owners after proving the active state.
await write("unstake-character-eleven-map-one", manager, managerArtifact.abi, "unstake", [objectOne, 11n]);
await write("unstake-character-ten-map-two", manager, managerArtifact.abi, "unstake", [objectTwo, 10n]);
const finalBlock = await publicClient.getBlock({ blockTag: "latest" });
const finalGlobalCounts = await read(manager, managerArtifact.abi, "globalStakeCounts", [], finalBlock.number);
const finalOwnerTen = await read(characters, nftArtifact.abi, "ownerOf", [10n], finalBlock.number);
const finalOwnerEleven = await read(characters, nftArtifact.abi, "ownerOf", [11n], finalBlock.number);
if (finalGlobalCounts[0] !== 3n || finalGlobalCounts[1] !== 0n || finalOwnerTen.toLowerCase() !== account.address.toLowerCase() || finalOwnerEleven.toLowerCase() !== account.address.toLowerCase()) throw new Error("Final owner restoration/global count readback failed.");

const totalGasUsed = operations.reduce((sum, operation) => sum + BigInt(operation.gasUsed), 0n);
const report = {
  schema: "keel.stake-object.sepolia-smoke@1",
  network: { chainId: expectedChainId, rpc: new URL(rpcUrl).host, startBlock: Number(startBlock.number), finalBlock: Number(finalBlock.number), finalBlockHash: finalBlock.hash },
  deployer: account.address,
  contracts: { registry, hosts, characters, manager },
  stakeObjects: { objectOne, objectTwo, viewerId, codeObjectId },
  proofs: {
    twoCharactersSameMap: {
      blockNumber: Number(twoCharactersSameMapBlock),
      objectActive: Number(twoCharactersSameMap.characterTen.objectActive),
      objectLifetime: Number(twoCharactersSameMap.characterTen.objectLifetime),
      characterTenStaker: twoCharactersSameMap.characterTen.staker,
      characterElevenStaker: twoCharactersSameMap.characterEleven.staker,
      tokenOwnerWhileStaked: twoCharactersSameMap.characterTenOwner,
      lockedUnstakeRejected,
    },
    crossMap: {
      blockNumber: Number(crossMapBlock),
      active: crossMapState.active,
      staker: crossMapState.staker,
      hostOwner: crossMapState.hostOwner,
      runtimeDigest: crossMapState.runtimeDigest,
      lockupMode: Number(crossMapState.lockupMode),
      decodedPackedCounts,
      globalCounts: globalCounts.map(String),
    },
    final: { lifetime: Number(finalGlobalCounts[0]), active: Number(finalGlobalCounts[1]), ownerTen: finalOwnerTen, ownerEleven: finalOwnerEleven },
  },
  operations,
  totalGasUsed: totalGasUsed.toString(),
  pass: true,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}
process.stdout.write(output);
