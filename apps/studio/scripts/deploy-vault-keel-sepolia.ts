import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_REGISTRY_ANCHOR_PROTOCOL,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  assertValidManifest,
  canonicalJson,
  encodePortableGraphV1,
  encodePortableManifestV1,
  manifestIntegrity,
  portableContentCommitmentsV1,
  portableRootV1,
  verifyPortableGraphTreeV1,
  PortableCompression,
  PortableEditPolicy,
  PortableGraphRole,
  PortableResourceKind,
  utf8ToBytes,
  type ArtifactManifest,
  type Bytes32Hex,
  type PortableGraphEntryV1,
  type PortableManifestV1,
  type PortableResourceKind as PortableResourceKindType,
} from "@keel/protocol";
import {
  bytesToHex,
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  sha256,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKeelHoldObjectReader } from "@keel/viewer";

import { buildVaultKeelViewer } from "./vault-keel-viewer-bundle";
import { buildStandaloneKeelViewer, KEEL_STANDALONE_VIEWER_PROTOCOL } from "./keel-viewer-builder";
import { vaultEthereumReleaseInputClosure } from "./vault-ethereum-release-inputs";
import { assertReusableTransaction, checkpointTransitionDecision } from "./vault-deployment-checkpoint";
import {
  assertVaultMultiCharacterDeployment,
  assertVaultStudioRegistration,
  VAULT_SEPOLIA_CHARACTER_MINT_COUNT,
  VAULT_SEPOLIA_MAP_ID,
  type VaultCharacterDeploymentOutput,
  type VaultStudioRegistrationOutput,
} from "./vault-multi-character-deployment";

interface Artifact { readonly abi: Abi; readonly bytecode: Hex; readonly deployedBytecode: Hex }
interface ContractCheckpoint {
  readonly address: Address;
  readonly transactionHash: Hash;
  readonly contractName: string;
  readonly artifactCreationCodeHash: Hex;
  readonly artifactRuntimeTemplateHash: Hex;
  readonly constructorArgsHash: Hex;
  readonly deploymentDataHash: Hex;
  readonly runtimeCodeHash: Hex;
  readonly sender: Address;
  readonly chainId: number;
}
interface TransactionCheckpoint {
  readonly hash: Hash;
  readonly target: Address;
  readonly calldata: Hex;
  readonly calldataHash: Hex;
  readonly sender: Address;
  readonly chainId: number;
  expectedPostState: Hex;
}
interface Checkpoint {
  readonly schema: "vault-keel-sepolia-checkpoint@3";
  readonly chainId: number;
  readonly deployer: Address;
  readonly deploymentInputDigest: Hex;
  contracts: Record<string, ContractCheckpoint>;
  transactions: Record<string, TransactionCheckpoint>;
  stateDigest: Hex | null;
}

const repositoryRoot = path.resolve(process.cwd(), "../..");
const demoRoot = path.join(repositoryRoot, "examples/demos/vault-arcade/generated-attribute-proxy");
const mapRoot = path.join(repositoryRoot, "examples/demos/vault-arcade");
const mapResourceSpecs = [
  ["index.html", "index.html", "text/html", "entrypoint", true],
  ["game.js", "game.js", "text/javascript", "script", true],
  ["procedural-sprite-rig.js", "procedural-sprite-rig.js", "text/javascript", "script", true],
  ["sidearm-still-rig.json", "sidearm-still-rig.json", "application/json", "data", false],
  ["character-catalog.octr", "character-catalog.octr", "application/octet-stream", "data", false],
  ["character-material-0.ocmp", "character-material-0.ocmp", "application/octet-stream", "data", false],
  ["character-material-1.ocmp", "character-material-1.ocmp", "application/octet-stream", "data", false],
  ["character-material-2.ocmp", "character-material-2.ocmp", "application/octet-stream", "data", false],
  ["character-material-3.ocmp", "character-material-3.ocmp", "application/octet-stream", "data", false],
  ["character-parts-eight-direction-168.webp", "assets/character-parts-eight-direction-168.webp", "image/webp", "image", false],
  ["vault-tiles.webp", "assets/vault-tiles.webp", "image/webp", "image", false],
  ["tintable-kit.webp", "assets/tintable-kit.webp", "image/webp", "image", false],
] as const;

function expectedKeelHoldLeafObject(bytes: Uint8Array, mediaType: string): { objectId: Hex; digest: Hex } {
  const slugIds: Hex[] = [];
  for (let offset = 0; offset < bytes.length; offset += 23_000) {
    slugIds.push(keccak256(bytesToHex(bytes.slice(offset, Math.min(bytes.length, offset + 23_000)))));
  }
  if (slugIds.length === 0 || slugIds.length > 128) throw new Error(`Invalid local KeelHold object size for ${mediaType}.`);
  const digest = sha256(bytes);
  const indexDigest = keccak256(concatHex(slugIds));
  const descriptor = encodeAbiParameters(
    [
      { type: "bytes1" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
      { type: "uint64" }, { type: "uint8" }, { type: "bytes32" },
    ],
    ["0x00", indexDigest, digest, BigInt(bytes.length), BigInt(bytes.length), 0, keccak256(stringToHex(mediaType))],
  );
  return { objectId: keccak256(descriptor), digest };
}
// Hard local gate: construct the exact viewer before reading a wallet or making
// any Sepolia transaction. Remote rollout must never discover a local bundle failure.
const builtViewerBytes = await buildVaultKeelViewer(demoRoot);
if (builtViewerBytes.length === 0) throw new Error("Vault Keel viewer local build produced no bytes.");
// The generated viewer is part of the release closure. Write it before the
// closure digest is computed so a stale or drifted checked-in bundle cannot be
// silently adopted by a resumed deployment.
await writeFile(path.join(demoRoot, "vault-keel-viewer-bundled.html"), builtViewerBytes);
// The disposable corrected smoke already published this exact immutable viewer
// before another shared viewer edit landed. Resume against the verified chain
// bytes, never a later local rebuild with shifted chunk boundaries.
const viewerBytes = await readFile(path.join(demoRoot, "vault-keel-viewer-published-corrected.html"));
if (sha256(viewerBytes) !== "0x970128e550207f9245f41ab7b95c9495be2ca6668f209e9f7367d6f7260dd93f") {
  throw new Error("Corrected smoke viewer bytes do not match the published on-chain object.");
}
const secretPath = path.join(repositoryRoot, ".secrets/vault-sepolia-deployer.json");
// This explicitly authorized smoke lane is disposable and must never be reused
// as a release checkpoint or cited as independent release evidence.
const priorSmokeCheckpointPath = path.join(repositoryRoot, ".secrets/vault-keel-sepolia-checkpoint-experimental-v15-smoke.json");
const checkpointPath = path.join(repositoryRoot, ".secrets/vault-keel-sepolia-checkpoint-experimental-v15-smoke-corrected.json");
const outputPath = path.join(demoRoot, "character-mint-stake-deployment.experimental-v15-smoke-corrected.json");
const baseDeploymentPath = path.join(demoRoot, "character-mint-stake-base-deployment.json");
const rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
const chainId = 11_155_111;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Bytes32Hex;
const EXPERIMENTAL_SMOKE_DIRECT_VIEWER = true;
const oldDeployment = JSON.parse(await readFile(baseDeploymentPath, "utf8")) as {
  readonly schema: "vault-keel-base-deployment@1";
  readonly chainId: number;
  readonly contracts: { readonly keelHold: Address; readonly keelIndex: Address; readonly artifactRegistry: Address };
};
if (oldDeployment.schema !== "vault-keel-base-deployment@1" || oldDeployment.chainId !== chainId) {
  throw new Error("Immutable Keel base deployment input is malformed or on the wrong chain.");
}
for (const [name, address] of Object.entries(oldDeployment.contracts)) {
  if (!/^0x[0-9a-f]{40}$/iu.test(address)) throw new Error(`Invalid base deployment address ${name}.`);
}

const viewerDescriptor = expectedKeelHoldLeafObject(viewerBytes, "text/html");
const mapLocalResources = await Promise.all(mapResourceSpecs.map(async ([id, relativePath, mediaType]) => {
  const bytes = new Uint8Array(await readFile(path.join(mapRoot, relativePath)));
  return { id, mediaType, bytes, ...expectedKeelHoldLeafObject(bytes, mediaType) };
}));
const mapStandalone = await buildStandaloneKeelViewer({
  repositoryRoot,
  envelope: {
    protocol: KEEL_STANDALONE_VIEWER_PROTOCOL,
    title: "Vault Arcade Map · verified onchain Keel viewer",
    deliveryProfile: "onchain-recursive",
    rpcUrl,
    blockTag: "latest",
    entrypoint: "index.html",
    runtimeExpectations: { minimumCanvasCount: 1 },
    items: mapLocalResources.map((resource) => ({
      id: resource.id,
      mediaType: resource.mediaType,
      aliases: resource.id === "game.js"
        ? ["/content/game.js"]
        : resource.id === "procedural-sprite-rig.js"
          ? ["/content/procedural-sprite-rig.js"]
          : [],
      integrity: { algorithm: "sha256" as const, digest: resource.digest, byteLength: resource.bytes.length },
      chainId,
      store: oldDeployment.contracts.keelHold.toLowerCase(),
      objectId: resource.objectId,
    })),
  },
});
const characterWrapperPath = path.join(demoRoot, "vault-keel-character-wrapper.html");
const mapWrapperPath = path.join(demoRoot, "vault-keel-map-wrapper.html");
await Promise.all([
  writeFile(characterWrapperPath, viewerBytes),
  writeFile(mapWrapperPath, mapStandalone.html),
]);

// Wallet material is read only after both exact local viewers have built.
const secret = JSON.parse(await readFile(secretPath, "utf8")) as { privateKey: Hex; address: Address };
const account = privateKeyToAccount(secret.privateKey);
if (account.address.toLowerCase() !== secret.address.toLowerCase()) throw new Error("Sepolia deployer secret mismatch.");
const transport = http(rpcUrl, { timeout: 45_000, retryCount: 3 });
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });
if (await publicClient.getChainId() !== chainId) throw new Error("RPC is not Ethereum Sepolia.");

async function artifact(name: string): Promise<Artifact> {
  const value = JSON.parse(await readFile(path.join(repositoryRoot, "packages/contracts/artifacts", `${name}.json`), "utf8")) as Artifact;
  if (!Array.isArray(value.abi) || !/^0x[0-9a-f]+$/iu.test(value.bytecode) || !/^0x[0-9a-f]+$/iu.test(value.deployedBytecode)) {
    throw new Error(`Compiled artifact ${name} is incomplete.`);
  }
  return value;
}

const checkpointArtifactNames = [
  "KeelIndex",
  "KeelHold",
  "KEEL721",
  "KeelArtifactRegistry",
  "KeelHarnessBuilder",
  "KeelPortableAnchorRegistry",
  "KeelCollectionVerificationRegistry",
  "KeelSeedRegistry",
  "KeelHarnessRegistry",
  "VaultArcadeRegistry",
  "VaultCharacter721",
  "VaultCharacterMetadataRenderer",
  "VaultCharacterRegistry",
  "VaultSpriteAssetRegistry",
] as const;
const artifactBindings = Object.fromEntries(await Promise.all(checkpointArtifactNames.map(async (name) => {
  const value = await artifact(name);
  return [name, {
    creationCodeHash: keccak256(value.bytecode),
    runtimeTemplateHash: keccak256(value.deployedBytecode),
  }] as const;
})));
const releaseInputClosure = EXPERIMENTAL_SMOKE_DIRECT_VIEWER
  ? {
      schema: "vault-experimental-smoke-input@1",
      note: "Disposable smoke only; canonical artifacts and deployment source remain bound below.",
      viewerSha256: sha256(viewerBytes),
    }
  : await vaultEthereumReleaseInputClosure(repositoryRoot);
const deploymentSourceBytes = await readFile(new URL(import.meta.url));
const deploymentInputDigest = sha256(utf8ToBytes(canonicalJson({
  schema: "vault-keel-sepolia-input@3",
  chainId,
  rpcUrl,
  deployer: account.address.toLowerCase(),
  oldDeployment,
  viewerSha256: sha256(viewerBytes),
  characterWrapperSha256: viewerDescriptor.digest,
  mapWrapperSha256: mapStandalone.htmlIntegrity.digest,
  deploymentSourceSha256: sha256(deploymentSourceBytes),
  artifactBindings,
  releaseInputClosure,
}))) as Hex;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tupleField<T>(value: unknown, key: string, index: number): T {
  if (Array.isArray(value)) return value[index] as T;
  if (isRecord(value) && key in value) return value[key] as T;
  throw new Error(`Contract result is missing ${key}.`);
}

function checkpointJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(checkpointJsonValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, checkpointJsonValue(child)]));
  return value;
}

function parseCheckpoint(value: unknown): Checkpoint {
  if (!isRecord(value) || value.schema !== "vault-keel-sepolia-checkpoint@3") throw new Error("Deployment checkpoint schema is unsupported.");
  if (value.chainId !== chainId || typeof value.deployer !== "string" || value.deployer.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("Deployment checkpoint chain/deployer binding mismatch.");
  }
  if (value.deploymentInputDigest !== deploymentInputDigest) {
    if (!checkpointPath.includes("experimental-v15-smoke")) {
      throw new Error("Deployment checkpoint input or artifact binding changed.");
    }
    // Disposable smoke recovery only: every already-mined contract and write is
    // still independently rechecked below against exact code/calldata/state.
    // Release checkpoints remain strictly source-digest locked.
    value.deploymentInputDigest = deploymentInputDigest;
  }
  if (!isRecord(value.contracts) || !isRecord(value.transactions) || !(value.stateDigest === null || /^0x[0-9a-f]{64}$/iu.test(String(value.stateDigest)))) {
    throw new Error("Deployment checkpoint payload is malformed.");
  }
  for (const [key, entry] of Object.entries(value.contracts)) {
    if (
      !isRecord(entry)
      || !/^0x[0-9a-f]{40}$/iu.test(String(entry.address))
      || !/^0x[0-9a-f]{64}$/iu.test(String(entry.transactionHash))
      || String(entry.sender).toLowerCase() !== account.address.toLowerCase()
      || entry.chainId !== chainId
      || typeof entry.contractName !== "string"
      || entry.contractName.length === 0
      || ![entry.artifactCreationCodeHash, entry.artifactRuntimeTemplateHash, entry.constructorArgsHash, entry.deploymentDataHash, entry.runtimeCodeHash]
        .every((field) => /^0x[0-9a-f]{64}$/iu.test(String(field)))
    ) {
      throw new Error(`Deployment checkpoint contract ${key} is malformed.`);
    }
  }
  for (const [key, entry] of Object.entries(value.transactions)) {
    if (
      !isRecord(entry)
      || !/^0x[0-9a-f]{64}$/iu.test(String(entry.hash))
      || String(entry.sender).toLowerCase() !== account.address.toLowerCase()
      || entry.chainId !== chainId
      || !/^0x[0-9a-f]{40}$/iu.test(String(entry.target))
      || !/^0x(?:[0-9a-f]{2})+$/iu.test(String(entry.calldata))
      || !/^0x[0-9a-f]{64}$/iu.test(String(entry.calldataHash))
      || !/^0x[0-9a-f]{64}$/iu.test(String(entry.expectedPostState))
    ) {
      throw new Error(`Deployment checkpoint transaction ${key} is malformed.`);
    }
  }
  if (Object.keys(value.transactions).length > 0 && value.stateDigest === null) throw new Error("Deployment checkpoint is missing its post-state binding.");
  return value as unknown as Checkpoint;
}

const priorSmokeCheckpoint = parseCheckpoint(JSON.parse(await readFile(priorSmokeCheckpointPath, "utf8")) as unknown);
let checkpoint: Checkpoint;
try {
  checkpoint = parseCheckpoint(JSON.parse(await readFile(checkpointPath, "utf8")) as unknown);
} catch (error) {
  if (!isRecord(error) || error.code !== "ENOENT") throw error;
  const reusableContracts = Object.fromEntries(Object.entries(priorSmokeCheckpoint.contracts).filter(([key]) => ![
    "characterMetadataRenderer",
    "characterCollection",
    "characterRegistry",
    "arcadeRegistry",
  ].includes(key)));
  checkpoint = {
    schema: "vault-keel-sepolia-checkpoint@3",
    chainId,
    deployer: account.address.toLowerCase() as Address,
    deploymentInputDigest,
    // Reuse only independently code-hash-checked shared infrastructure. The
    // renderer, collection, character registry and arcade are replacement
    // deployments so the defective metadata collection cannot be adopted.
    contracts: reusableContracts,
    transactions: {},
    stateDigest: null,
  };
}

async function saveCheckpoint(): Promise<void> {
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
}

async function currentTransactionTargetsState(): Promise<Hex> {
  const targets = [...new Set([
    ...Object.values(checkpoint.transactions).map((entry) => entry.target.toLowerCase() as Address),
    ...Object.values(checkpoint.contracts).map((entry) => entry.address.toLowerCase() as Address),
    ...Object.values(oldDeployment.contracts).map((address) => address.toLowerCase() as Address),
  ])].sort();
  const proofs = await Promise.all(targets.map(async (address) => {
    const proof = await publicClient.getProof({ address, storageKeys: [] });
    return {
      address,
      balance: proof.balance.toString(),
      codeHash: proof.codeHash,
      nonce: proof.nonce.toString(),
      storageHash: proof.storageHash,
    };
  }));
  return sha256(utf8ToBytes(canonicalJson({ schema: "vault-deployment-post-state@1", proofs }))) as Hex;
}

async function refreshCheckpointPostState(): Promise<void> {
  const digest = await currentTransactionTargetsState();
  checkpoint.stateDigest = digest;
  for (const entry of Object.values(checkpoint.transactions)) entry.expectedPostState = digest;
}

async function assertCheckpointTransactionsReusable(): Promise<void> {
  const entries = Object.entries(checkpoint.transactions);
  if (entries.length === 0) return;
  const currentPostState = await currentTransactionTargetsState();
  const experimentalCrashRecovery = checkpointPath.includes("experimental-v15-smoke")
    && checkpoint.stateDigest !== currentPostState;
  if (checkpoint.stateDigest !== currentPostState && !experimentalCrashRecovery) {
    throw new Error("Deployment checkpoint post-state changed; refusing conditional skips.");
  }
  await Promise.all(entries.map(async ([key, entry]) => {
    if ((!experimentalCrashRecovery && entry.expectedPostState !== currentPostState) || entry.calldataHash !== keccak256(entry.calldata)) {
      throw new Error(`Deployment checkpoint binding changed for ${key}.`);
    }
    const [receipt, transaction] = await Promise.all([
      publicClient.getTransactionReceipt({ hash: entry.hash }),
      publicClient.getTransaction({ hash: entry.hash }),
    ]);
    assertReusableTransaction(key, {
      chainId: checkpoint.chainId,
      deployer: checkpoint.deployer,
      sender: entry.sender,
      target: entry.target,
      calldata: entry.calldata,
    }, transaction, receipt);
  }));
  if (experimentalCrashRecovery) {
    // Ctrl-C may land after a receipt is saved but before the aggregate state
    // digest refresh. Only the disposable smoke checkpoint can recover, and
    // only after every recorded tx was independently revalidated above.
    await refreshCheckpointPostState();
    await saveCheckpoint();
  }
}

await assertCheckpointTransactionsReusable();

async function deploy(key: string, name: string, args: readonly unknown[]): Promise<{ address: Address; abi: Abi }> {
  const contract = await artifact(name);
  const deploymentData = encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode, args } as Parameters<typeof encodeDeployData>[0]);
  const binding = {
    contractName: name,
    artifactCreationCodeHash: keccak256(contract.bytecode),
    artifactRuntimeTemplateHash: keccak256(contract.deployedBytecode),
    constructorArgsHash: sha256(utf8ToBytes(canonicalJson(checkpointJsonValue(args)))),
    deploymentDataHash: keccak256(deploymentData),
  };
  const existing = checkpoint.contracts[key];
  if (existing !== undefined) {
    if (
      existing.contractName !== binding.contractName
      || existing.artifactCreationCodeHash !== binding.artifactCreationCodeHash
      || existing.artifactRuntimeTemplateHash !== binding.artifactRuntimeTemplateHash
      || existing.constructorArgsHash !== binding.constructorArgsHash
      || existing.deploymentDataHash !== binding.deploymentDataHash
    ) throw new Error(`Checkpoint deployment binding changed for ${key}.`);
    const code = await publicClient.getCode({ address: existing.address });
    if (code === undefined || code === "0x" || keccak256(code) !== existing.runtimeCodeHash) {
      throw new Error(`Checkpoint address reuse/runtime substitution detected for ${key}.`);
    }
    const [receipt, transaction] = await Promise.all([
      publicClient.getTransactionReceipt({ hash: existing.transactionHash }),
      publicClient.getTransaction({ hash: existing.transactionHash }),
    ]);
    assertReusableTransaction(key, {
      chainId: checkpoint.chainId,
      deployer: checkpoint.deployer,
      sender: existing.sender,
      target: null,
      calldata: deploymentData,
      contractAddress: existing.address,
    }, transaction, receipt);
    return { address: existing.address, abi: contract.abi };
  }
  const hash = await walletClient.deployContract({ account, abi: contract.abi, bytecode: contract.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success" || receipt.contractAddress === null) throw new Error(`${name} deployment reverted: ${hash}`);
  const runtimeCode = await publicClient.getCode({ address: receipt.contractAddress });
  if (runtimeCode === undefined || runtimeCode === "0x") throw new Error(`${name} deployment produced no runtime code.`);
  checkpoint.contracts[key] = {
    address: receipt.contractAddress,
    transactionHash: hash,
    ...binding,
    runtimeCodeHash: keccak256(runtimeCode),
    sender: account.address.toLowerCase() as Address,
    chainId,
  };
  await saveCheckpoint();
  console.log(`${key} ${receipt.contractAddress}`);
  return { address: receipt.contractAddress, abi: contract.abi };
}
async function write(key: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hash> {
  const calldata = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const prior = checkpoint.transactions[key];
  if (prior !== undefined) {
    if (prior.target.toLowerCase() !== address.toLowerCase() || prior.calldata !== calldata || prior.calldataHash !== keccak256(calldata)) {
      throw new Error(`Checkpoint calldata/target changed for ${key}; refusing to skip the write.`);
    }
    const receipt = await publicClient.getTransactionReceipt({ hash: prior.hash });
    const transaction = await publicClient.getTransaction({ hash: prior.hash });
    assertReusableTransaction(key, {
      chainId: checkpoint.chainId,
      deployer: checkpoint.deployer,
      sender: prior.sender,
      target: address,
      calldata,
    }, transaction, receipt);
    const currentPostState = await currentTransactionTargetsState();
    if (checkpoint.stateDigest !== prior.expectedPostState || currentPostState !== prior.expectedPostState) {
      throw new Error(`Checkpoint post-state drift detected for ${key}; refusing to skip the write.`);
    }
    return prior.hash;
  }
  const simulation = await publicClient.simulateContract({ account, address, abi, functionName, args });
  const hash = await walletClient.writeContract({
    ...simulation.request,
    ...(functionName === "adminStrike" ? { gas: 1_000_000n } : {}),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  checkpoint.transactions[key] = {
    hash,
    target: address.toLowerCase() as Address,
    calldata,
    calldataHash: keccak256(calldata),
    sender: account.address.toLowerCase() as Address,
    chainId,
    expectedPostState: `0x${"00".repeat(32)}`,
  };
  await refreshCheckpointPostState();
  await saveCheckpoint();
  console.log(`${key} ${hash}`);
  return hash;
}

async function checkpointedTransition(
  key: string,
  observedState: "absent" | "exact" | "wrong",
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  verify: () => Promise<boolean>,
): Promise<Hash> {
  if (observedState === "exact" && checkpoint.transactions[key] === undefined) {
    const prior = priorSmokeCheckpoint.transactions[key];
    const calldata = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    if (prior !== undefined && prior.target.toLowerCase() === address.toLowerCase()
      && prior.calldata === calldata && prior.calldataHash === keccak256(calldata)) {
      const [receipt, transaction] = await Promise.all([
        publicClient.getTransactionReceipt({ hash: prior.hash }),
        publicClient.getTransaction({ hash: prior.hash }),
      ]);
      assertReusableTransaction(key, {
        chainId: checkpoint.chainId,
        deployer: checkpoint.deployer,
        sender: prior.sender,
        target: address,
        calldata,
      }, transaction, receipt);
      checkpoint.transactions[key] = { ...prior, expectedPostState: `0x${"00".repeat(32)}` };
      await refreshCheckpointPostState();
      await saveCheckpoint();
    }
  }
  checkpointTransitionDecision(key, observedState, checkpoint.transactions[key] !== undefined);
  const hash = await write(key, address, abi, functionName, args);
  if (!await verify()) throw new Error(`Checkpoint postcondition mismatch after ${key}.`);
  return hash;
}

async function readContractAtBlockHash(
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  blockHash: Hex,
): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const encoded = await publicClient.request({
    method: "eth_call",
    params: [{ to: address, data }, { blockHash, requireCanonical: true }],
  } as Parameters<typeof publicClient.request>[0]);
  return decodeFunctionResult({
    abi,
    functionName,
    data: encoded as Hex,
  } as Parameters<typeof decodeFunctionResult>[0]);
}

function exactTuple(actual: unknown, expected: unknown): boolean {
  return canonicalJson(checkpointJsonValue(actual)) === canonicalJson(checkpointJsonValue(expected));
}

const chunk = await artifact("KeelHold");
const registry = await artifact("KeelIndex");
const object = await artifact("KeelArtifactRegistry");

async function keelObjectState(
  objectId: Hex,
  exists: boolean,
  contentObjectId: Hex,
  digest: Hex,
  byteLength: number,
  mediaType: string,
): Promise<"absent" | "exact" | "wrong"> {
  if (!exists) return "absent";
  const source = await publicClient.readContract({
    address: oldDeployment.contracts.artifactRegistry,
    abi: object.abi,
    functionName: "artifactRevisionSource",
    args: [objectId, 1n],
  }) as readonly [Address, Hex, number, Hex, bigint, number, string];
  return source[0].toLowerCase() === oldDeployment.contracts.keelHold.toLowerCase()
    && source[1].toLowerCase() === contentObjectId.toLowerCase()
    && source[2] === 0
    && source[3].toLowerCase() === digest.toLowerCase()
    && source[4] === BigInt(byteLength)
    && source[5] === 0
    && source[6] === mediaType
    ? "exact"
    : "wrong";
}
const harnessRegistry = await deploy("harnessRegistry", "KeelHarnessRegistry", [oldDeployment.contracts.artifactRegistry, oldDeployment.contracts.keelIndex]);
const seedRegistry = await deploy("seedRegistry", "KeelSeedRegistry", [harnessRegistry.address, oldDeployment.contracts.keelIndex]);
const portableAnchorRegistry = await deploy("portableAnchorRegistry", "KeelPortableAnchorRegistry", [oldDeployment.contracts.artifactRegistry]);
const collectionVerificationRegistry = await deploy(
  "collectionVerificationRegistry",
  "KeelCollectionVerificationRegistry",
  [account.address, portableAnchorRegistry.address],
);
const metadataRenderer = await deploy("characterMetadataRenderer", "VaultCharacterMetadataRenderer", [account.address]);
const onchainHTMLBuilder = await deploy("onchainHTMLBuilder", "KeelHarnessBuilder", [
  oldDeployment.contracts.keelHold,
]);
const collection = await deploy("characterCollection", "VaultCharacter721", [
  "Vault Orb Characters", "VORB", account.address, zeroAddress, oldDeployment.contracts.keelIndex,
  account.address, 0, 100n, metadataRenderer.address, portableAnchorRegistry.address, onchainHTMLBuilder.address,
]);
const vaultVerificationPolicyInput = {
  lane: 1,
  runtimeCodeHash: checkpoint.contracts.characterCollection?.runtimeCodeHash,
  adapter: zeroAddress,
  adapterCodeHash: ZERO_BYTES32,
  implementation: zeroAddress,
  implementationCodeHash: ZERO_BYTES32,
  proxyAdmin: zeroAddress,
  beacon: zeroAddress,
  policyDigest: keccak256(stringToHex("vault-character-official-hook-policy@1")),
  version: 1n,
};
if (vaultVerificationPolicyInput.runtimeCodeHash === undefined) {
  throw new Error("Vault collection checkpoint is missing its exact runtime code hash.");
}
const vaultVerificationPolicyId = await publicClient.readContract({
  address: collectionVerificationRegistry.address,
  abi: collectionVerificationRegistry.abi,
  functionName: "policyId",
  args: [vaultVerificationPolicyInput],
}) as Hex;
const mapCollection = await deploy("mapCollection", "KEEL721", [
  "Vault Permanent Maps", "VMAP", account.address, zeroAddress, oldDeployment.contracts.keelIndex,
  account.address, 0, 100n,
]);
const spriteRegistry = await deploy("spriteAssetRegistry", "VaultSpriteAssetRegistry", [
  oldDeployment.contracts.artifactRegistry, account.address,
]);
const characterRegistry = await deploy("characterRegistry", "VaultCharacterRegistry", [
  collection.address, seedRegistry.address, oldDeployment.contracts.artifactRegistry, spriteRegistry.address,
  portableAnchorRegistry.address, account.address,
]);
const arcade = await deploy("arcadeRegistry", "VaultArcadeRegistry", [
  collection.address, mapCollection.address, oldDeployment.contracts.keelIndex, oldDeployment.contracts.artifactRegistry,
  characterRegistry.address, portableAnchorRegistry.address,
]);
await write("collection-description", collection.address, collection.abi, "setCollectionDescription", [
  "A floating Orb Core and detached weapon generated from permanent mint entropy, resolved by a verified Keel viewer and playable in Vault Arcade.",
]);
await write("map-description", mapCollection.address, mapCollection.abi, "setCollectionDescription", [
  "A permanent Vault Arcade map whose verified Keel runtime consumes the exact render recipe of each staked character.",
]);
const mapSupply = await publicClient.readContract({
  address: mapCollection.address, abi: mapCollection.abi, functionName: "totalSupply",
}) as bigint;
let mapMintState: "absent" | "exact" | "wrong" = mapSupply === 0n ? "absent" : "wrong";
if (mapSupply === 1n) {
  const owner = await publicClient.readContract({ address: mapCollection.address, abi: mapCollection.abi, functionName: "ownerOf", args: [1n] }) as Address;
  mapMintState = owner.toLowerCase() === account.address.toLowerCase() ? "exact" : "wrong";
}
await checkpointedTransition("mint-map", mapMintState, mapCollection.address, mapCollection.abi, "adminStrike", [account.address, 1n], async () => {
  const [supply, owner] = await Promise.all([
    publicClient.readContract({ address: mapCollection.address, abi: mapCollection.abi, functionName: "totalSupply" }) as Promise<bigint>,
    publicClient.readContract({ address: mapCollection.address, abi: mapCollection.abi, functionName: "ownerOf", args: [1n] }) as Promise<Address>,
  ]);
  return supply === 1n && owner.toLowerCase() === account.address.toLowerCase();
});

async function publishContent(key: string, bytes: Uint8Array, mediaType: string): Promise<{ objectId: Hex; digest: Hex }> {
  const slugIds: Hex[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += 23_000, index += 1) {
    const part = bytes.slice(offset, Math.min(bytes.length, offset + 23_000));
    const slugId = keccak256(bytesToHex(part));
    slugIds.push(slugId);
    const pointer = await publicClient.readContract({ address: oldDeployment.contracts.keelHold, abi: chunk.abi, functionName: "slugPointer", args: [slugId] }) as Address;
    // Chunk IDs are the Keccak digest of exact bytes and KeelHold.castSlug is
    // idempotent, so mine-before-save recovery safely resubmits the same bytes.
    await write(`${key}-chunk-${index}`, oldDeployment.contracts.keelHold, chunk.abi, "castSlug", [bytesToHex(part)]);
    const storedPointer = await publicClient.readContract({ address: oldDeployment.contracts.keelHold, abi: chunk.abi, functionName: "slugPointer", args: [slugId] }) as Address;
    if (storedPointer === zeroAddress || (pointer !== zeroAddress && storedPointer.toLowerCase() !== pointer.toLowerCase())) {
      throw new Error(`${key} chunk ${index} postcondition mismatch.`);
    }
  }
  const digest = sha256(bytes);
  const simulation = await publicClient.simulateContract({
    account, address: oldDeployment.contracts.keelHold, abi: chunk.abi, functionName: "weldObject",
    args: [slugIds, digest, BigInt(bytes.length), 0, mediaType],
  });
  const objectId = simulation.result as Hex;
  // Object IDs commit the complete immutable descriptor; resubmission is
  // idempotent and cannot adopt a different object under the same ID.
  await write(`${key}-object`, oldDeployment.contracts.keelHold, chunk.abi, "weldObject", [slugIds, digest, BigInt(bytes.length), 0, mediaType]);
  const stored = await publicClient.readContract({ address: oldDeployment.contracts.keelHold, abi: chunk.abi, functionName: "objectExists", args: [objectId] }) as boolean;
  if (!stored) throw new Error(`${key} content object postcondition mismatch.`);
  return { objectId, digest };
}

const viewerContent = await publishContent("viewer-bundle", viewerBytes, "text/html");
if (viewerContent.objectId !== viewerDescriptor.objectId || viewerContent.digest !== viewerDescriptor.digest) {
  throw new Error("Published Vault viewer did not match its local immutable KeelHold descriptor.");
}
const mapWrapperContent = EXPERIMENTAL_SMOKE_DIRECT_VIEWER
  ? viewerContent
  : await publishContent("map-viewer-wrapper", mapStandalone.html, "text/html");
await write("map-onchain-viewer", mapCollection.address, mapCollection.abi, "setOnchainHarness", [
  onchainHTMLBuilder.address, mapWrapperContent.objectId, mapWrapperContent.digest,
]);
const viewerSalt = keccak256(stringToHex(`vault-orb-viewer-bundle@1/${viewerContent.digest}`));
const viewerObjectId = await publicClient.readContract({
  address: oldDeployment.contracts.artifactRegistry, abi: object.abi, functionName: "predictArtifactId", args: [account.address, viewerSalt],
}) as Hex;
const viewerObjectExists = await publicClient.readContract({
  address: oldDeployment.contracts.artifactRegistry, abi: object.abi, functionName: "artifactRevisionExists", args: [viewerObjectId, 1n],
}) as boolean;
await checkpointedTransition(
  "viewer-keel-object",
  await keelObjectState(viewerObjectId, viewerObjectExists, viewerContent.objectId, viewerContent.digest, viewerBytes.length, "text/html"),
  oldDeployment.contracts.artifactRegistry,
  object.abi,
  "forgeArtifact",
  [
    viewerSalt, { collection: zeroAddress, tokenId: 0n }, 0, viewerContent.objectId, 0, viewerContent.digest,
    keccak256(stringToHex("vault-orb-viewer-html@1")), keccak256(stringToHex("vault-orb-viewer-assets@1")),
  ],
  async () => (await keelObjectState(viewerObjectId, true, viewerContent.objectId, viewerContent.digest, viewerBytes.length, "text/html")) === "exact",
);

async function publishSharedObject(
  key: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ objectId: Hex; digest: Hex; contentObjectId: Hex; byteLength: number }> {
  const content = await publishContent(key, bytes, mediaType);
  const salt = keccak256(stringToHex(`vault-orb-${key}@1/${content.digest}`));
  const objectId = await publicClient.readContract({
    address: oldDeployment.contracts.artifactRegistry, abi: object.abi, functionName: "predictArtifactId", args: [account.address, salt],
  }) as Hex;
  const exists = await publicClient.readContract({
    address: oldDeployment.contracts.artifactRegistry, abi: object.abi, functionName: "artifactRevisionExists", args: [objectId, 1n],
  }) as boolean;
  await checkpointedTransition(
    `${key}-keel-object`,
    await keelObjectState(objectId, exists, content.objectId, content.digest, bytes.length, mediaType),
    oldDeployment.contracts.artifactRegistry,
    object.abi,
    "forgeArtifact",
    [
      salt, { collection: zeroAddress, tokenId: 0n }, 0, content.objectId, 0, content.digest,
      keccak256(stringToHex(`vault-orb-${key}@1`)), keccak256(stringToHex(`vault-orb-${key}-provenance@1`)),
    ],
    async () => (await keelObjectState(objectId, true, content.objectId, content.digest, bytes.length, mediaType)) === "exact",
  );
  return { objectId, digest: content.digest, contentObjectId: content.objectId, byteLength: bytes.length };
}

const characterWrapperObject = {
  objectId: viewerObjectId,
  digest: viewerContent.digest,
  contentObjectId: viewerContent.objectId,
  byteLength: viewerBytes.length,
};
const mapWrapperObject = EXPERIMENTAL_SMOKE_DIRECT_VIEWER
  ? characterWrapperObject
  : await publishSharedObject("map-viewer-wrapper-object", mapStandalone.html, "text/html");

interface PortablePublication {
  readonly portableRoot: Bytes32Hex;
  readonly decodedSha256: Bytes32Hex;
  readonly decodedByteLength: bigint;
  readonly mediaType: PortableManifestV1["mediaType"];
  readonly manifestObjectId: Hex;
  readonly manifestObjectRevision: bigint;
  readonly decodedObjectId: Hex;
  readonly decodedObjectRevision: bigint;
}


async function publishPortableManifest(
  key: string,
  decodedBytes: Uint8Array,
  mediaType: PortableManifestV1["mediaType"],
  resourceKind: PortableResourceKindType,
  decodedObjectId: Hex,
): Promise<PortablePublication> {
  const commitments = await portableContentCommitmentsV1(decodedBytes);
  const manifest: PortableManifestV1 = {
    resourceKind,
    compression: PortableCompression.None,
    mediaType,
    decodedByteLength: commitments.decodedByteLength,
    decodedSha256: commitments.decodedSha256,
    metadataSha256: sha256(utf8ToBytes(`vault-orb-portable-metadata@1/${key}`)) as Bytes32Hex,
    chunkRoot: commitments.chunkRoot,
    lineageId: sha256(utf8ToBytes(`vault-orb-portable-lineage@1/${key}`)) as Bytes32Hex,
    revision: 1n,
    parentPortableRoot: ZERO_BYTES32,
    editPolicy: PortableEditPolicy.Immutable,
    controllerId: ZERO_BYTES32,
    frozen: true,
  };
  const manifestBytes = encodePortableManifestV1(manifest);
  const portableRoot = await portableRootV1(manifestBytes);
  const manifestObject = await publishSharedObject(`${key}-portable-manifest`, manifestBytes, "application/octet-stream");
  if (manifestObject.digest !== portableRoot) throw new Error(`${key} portable manifest/root mismatch.`);
  return {
    portableRoot,
    decodedSha256: commitments.decodedSha256,
    decodedByteLength: commitments.decodedByteLength,
    mediaType,
    manifestObjectId: manifestObject.objectId,
    manifestObjectRevision: 1n,
    decodedObjectId,
    decodedObjectRevision: 1n,
  };
}

async function anchorPortablePublication(key: string, publication: PortablePublication): Promise<Hex> {
  let anchorRoot = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "sourceAnchor",
    args: [publication.manifestObjectId, publication.manifestObjectRevision],
  }) as Hex;
  let anchorState: "absent" | "exact" | "wrong" = anchorRoot === ZERO_BYTES32 ? "absent" : "wrong";
  if (anchorRoot !== ZERO_BYTES32) {
    const anchored = await publicClient.readContract({
      address: portableAnchorRegistry.address,
      abi: portableAnchorRegistry.abi,
      functionName: "anchor",
      args: [anchorRoot],
    }) as { manifestObjectId: Hex; manifestObjectRevision: bigint; decodedObjectId: Hex; decodedObjectRevision: bigint; portableRoot: Hex; exists: boolean };
    anchorState = anchored.exists
      && anchored.manifestObjectId === publication.manifestObjectId
      && anchored.manifestObjectRevision === publication.manifestObjectRevision
      && anchored.decodedObjectId === publication.decodedObjectId
      && anchored.decodedObjectRevision === publication.decodedObjectRevision
      && anchored.portableRoot === publication.portableRoot
      ? "exact"
      : "wrong";
  }
  await checkpointedTransition(
    `${key}-portable-anchor`,
    anchorState,
    portableAnchorRegistry.address,
    portableAnchorRegistry.abi,
    "publishObjectAnchor",
    [
      publication.manifestObjectId,
      publication.manifestObjectRevision,
      publication.decodedObjectId,
      publication.decodedObjectRevision,
      publication.portableRoot,
    ],
    async () => {
      const value = await publicClient.readContract({
        address: portableAnchorRegistry.address,
        abi: portableAnchorRegistry.abi,
        functionName: "sourceAnchor",
        args: [publication.manifestObjectId, publication.manifestObjectRevision],
      }) as Hex;
      return value !== ZERO_BYTES32;
    },
  );
  if (anchorRoot === ZERO_BYTES32) {
    anchorRoot = await publicClient.readContract({
      address: portableAnchorRegistry.address,
      abi: portableAnchorRegistry.abi,
      functionName: "sourceAnchor",
      args: [publication.manifestObjectId, publication.manifestObjectRevision],
    }) as Hex;
  }
  if (anchorRoot === ZERO_BYTES32) throw new Error(`${key} portable anchor was not recorded.`);
  return anchorRoot;
}

async function assertPortablePublicationAnchored(key: string, publication: PortablePublication): Promise<Hex> {
  const anchorRoot = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "portableAnchor",
    args: [publication.portableRoot],
  }) as Hex;
  const sourceAnchorRoot = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "sourceAnchor",
    args: [publication.manifestObjectId, publication.manifestObjectRevision],
  }) as Hex;
  if (anchorRoot === ZERO_BYTES32 || anchorRoot !== sourceAnchorRoot) {
    throw new Error(`${key} is missing its portable-root/source anchor index.`);
  }
  const anchored = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "anchor",
    args: [anchorRoot],
  }) as {
    manifestObjectId: Hex;
    manifestObjectRevision: bigint;
    decodedObjectId: Hex;
    decodedObjectRevision: bigint;
    portableRoot: Hex;
    exists: boolean;
  };
  if (
    !anchored.exists
    || anchored.portableRoot !== publication.portableRoot
    || anchored.manifestObjectId !== publication.manifestObjectId
    || anchored.manifestObjectRevision !== publication.manifestObjectRevision
    || anchored.decodedObjectId !== publication.decodedObjectId
    || anchored.decodedObjectRevision !== publication.decodedObjectRevision
  ) throw new Error(`${key} portable anchor source substitution detected.`);
  const manifestSource = await publicClient.readContract({
    address: oldDeployment.contracts.artifactRegistry,
    abi: object.abi,
    functionName: "artifactRevisionSource",
    args: [publication.manifestObjectId, publication.manifestObjectRevision],
  }) as readonly [Address, Hex, number, Hex, bigint, number, string];
  const decodedSource = await publicClient.readContract({
    address: oldDeployment.contracts.artifactRegistry,
    abi: object.abi,
    functionName: "artifactRevisionSource",
    args: [publication.decodedObjectId, publication.decodedObjectRevision],
  }) as readonly [Address, Hex, number, Hex, bigint, number, string];
  if (
    manifestSource[2] !== 0
    || manifestSource[3] !== publication.portableRoot
    || manifestSource[6] !== "application/octet-stream"
    || decodedSource[2] !== 0
    || decodedSource[3] !== publication.decodedSha256
    || decodedSource[4] !== publication.decodedByteLength
    || decodedSource[5] !== PortableCompression.None
    || decodedSource[6] !== publication.mediaType
  ) throw new Error(`${key} portable manifest/decoded media or digest mismatch.`);
  return anchorRoot;
}

type PortableRevisionSource = readonly [Address, Hex, number, Hex, bigint, number, string];

const portableReadSignal = new AbortController().signal;
const readPortableContentObject = createKeelHoldObjectReader({
  async getObject(request) {
    if (
      request.chainId !== chainId
      || request.store.toLowerCase() !== oldDeployment.contracts.keelHold.toLowerCase()
    ) throw new Error("Portable graph resolved an unexpected KeelHold.");
    return publicClient.readContract({
      address: request.store,
      abi: chunk.abi,
      functionName: "getObject",
      args: [request.objectId],
    }) as Promise<{
      digest: Hex;
      byteLength: bigint;
      storedByteLength: bigint;
      chunkCount: bigint;
      compression: number;
      composite: boolean;
    }>;
  },
  async getObjectSlugPointers(request) {
    return publicClient.readContract({
      address: request.store,
      abi: chunk.abi,
      functionName: "getObjectSlugPointers",
      args: [request.objectId, BigInt(request.offset), BigInt(request.limit)],
    }) as Promise<readonly Hex[]>;
  },
  async getObjectPartIds(request) {
    return publicClient.readContract({
      address: request.store,
      abi: chunk.abi,
      functionName: "getObjectPartIds",
      args: [request.objectId, BigInt(request.offset), BigInt(request.limit)],
    }) as Promise<readonly Hex[]>;
  },
  async getCode(request) {
    const code = await publicClient.getCode({ address: request.address });
    if (code === undefined) throw new Error(`Missing portable KeelHold carrier ${request.address}.`);
    return hexToBytes(code);
  },
}, {
  digestAlgorithm: "sha256",
  verifyObjectDigests: true,
  maxDepth: 32,
  maxNodes: 4_096,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxStoredBytes: 256 * 1024 * 1024,
});

async function portableSourcesFromRoot(root: Bytes32Hex): Promise<{
  readonly manifest: PortableRevisionSource;
  readonly decoded: PortableRevisionSource;
}> {
  const anchorRoot = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "portableAnchor",
    args: [root],
  }) as Hex;
  if (anchorRoot === ZERO_BYTES32) throw new Error(`Portable root ${root} is not anchored.`);
  const anchored = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "anchor",
    args: [anchorRoot],
  }) as {
    manifestObjectId: Hex;
    manifestObjectRevision: bigint;
    decodedObjectId: Hex;
    decodedObjectRevision: bigint;
    portableRoot: Hex;
    exists: boolean;
  };
  if (!anchored.exists || anchored.portableRoot.toLowerCase() !== root.toLowerCase()) {
    throw new Error(`Portable root ${root} resolved a substituted anchor.`);
  }
  const sourceAnchor = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "sourceAnchor",
    args: [anchored.manifestObjectId, anchored.manifestObjectRevision],
  }) as Hex;
  if (sourceAnchor !== anchorRoot) throw new Error(`Portable root ${root} resolved a substituted source anchor.`);
  const [manifest, decoded] = await Promise.all([
    publicClient.readContract({
      address: oldDeployment.contracts.artifactRegistry,
      abi: object.abi,
      functionName: "artifactRevisionSource",
      args: [anchored.manifestObjectId, anchored.manifestObjectRevision],
    }) as Promise<PortableRevisionSource>,
    publicClient.readContract({
      address: oldDeployment.contracts.artifactRegistry,
      abi: object.abi,
      functionName: "artifactRevisionSource",
      args: [anchored.decodedObjectId, anchored.decodedObjectRevision],
    }) as Promise<PortableRevisionSource>,
  ]);
  for (const source of [manifest, decoded]) {
    if (source[0].toLowerCase() !== oldDeployment.contracts.keelHold.toLowerCase() || source[2] !== 0) {
      throw new Error(`Portable root ${root} resolved an unsupported source store or digest algorithm.`);
    }
  }
  if (
    manifest[3].toLowerCase() !== root.toLowerCase()
    || manifest[5] !== PortableCompression.None
    || manifest[6] !== "application/octet-stream"
  ) throw new Error(`Portable root ${root} manifest source does not match its root/media contract.`);
  return { manifest, decoded };
}

/** Starts with only a top portable root. Every graph edge is decoded from the
 * bytes fetched through the root's onchain anchor and exact Keel sources. */
async function verifyPublishedPortableGraph(topRoot: Bytes32Hex): Promise<void> {
  const sources = new Map<string, Awaited<ReturnType<typeof portableSourcesFromRoot>>>();
  const source = async (root: Bytes32Hex) => {
    const key = root.toLowerCase();
    const cached = sources.get(key);
    if (cached !== undefined) return cached;
    const resolved = await portableSourcesFromRoot(root);
    sources.set(key, resolved);
    return resolved;
  };
  const readSource = async (value: PortableRevisionSource) => readPortableContentObject({
    chainId,
    store: value[0],
    objectId: value[1],
  }, portableReadSignal);
  await verifyPortableGraphTreeV1(topRoot, {
    async loadManifest(root) {
      const value = await source(root);
      const bytes = await readSource(value.manifest);
      if (BigInt(bytes.byteLength) !== value.manifest[4]) {
        throw new Error(`Portable manifest ${root} byte length does not match Keel.`);
      }
      return bytes;
    },
    async loadDecoded(root, manifest) {
      const value = await source(root);
      if (
        value.decoded[3].toLowerCase() !== manifest.decodedSha256.toLowerCase()
        || value.decoded[4] !== manifest.decodedByteLength
        || value.decoded[5] !== manifest.compression
        || value.decoded[6] !== manifest.mediaType
      ) throw new Error(`Portable decoded source ${root} was missing or substituted.`);
      return readSource(value.decoded);
    },
  });
}

const [
  catalogBytes,
  metadataBytes,
  targetBytes,
  effectBytes,
  soundBytes,
  weaponAtlasBytes,
  weaponCodexBytes,
  weaponBuildBytes,
  weaponChecksumBytes,
] = await Promise.all([
  readFile(path.join(repositoryRoot, "examples/demos/vault-arcade/character-catalog.octr")),
  readFile(path.join(repositoryRoot, "examples/demos/vault-arcade/character-catalog.source.json")),
  readFile(path.join(demoRoot, "weapon-region-layouts-v2.json")),
  readFile(path.join(repositoryRoot, "examples/demos/vault-arcade/sprite-effects-v1.json")),
  readFile(path.join(demoRoot, "weapon-sounds-v1.json")),
  readFile(path.join(repositoryRoot, "packages/sprite-codex/vault/generated/library/bundles/2-1-vault-weapons-v1/vault-weapons-v1.atlas.webp")),
  readFile(path.join(repositoryRoot, "packages/sprite-codex/vault/generated/library/bundles/2-1-vault-weapons-v1/vault-weapons-v1.codex.bin")),
  readFile(path.join(repositoryRoot, "packages/sprite-codex/vault/generated/library/bundles/2-1-vault-weapons-v1/vault-weapons-v1.build.json")),
  readFile(path.join(repositoryRoot, "packages/sprite-codex/vault/generated/library/bundles/2-1-vault-weapons-v1/vault-weapons-v1.sha256")),
]);
const catalogObject = await publishSharedObject("character-catalog", catalogBytes, "application/octet-stream");
const metadataObject = await publishSharedObject("character-metadata", metadataBytes, "application/json");
const targetObject = await publishSharedObject("weapon-targets", targetBytes, "application/json");
const effectObject = await publishSharedObject("sprite-effects", effectBytes, "application/json");
const soundObject = await publishSharedObject("weapon-sounds", soundBytes, "application/json");
const weaponAtlasObject = await publishSharedObject("weapon-atlas-v1", weaponAtlasBytes, "image/webp");
const weaponCodexObject = await publishSharedObject("weapon-codex-v1", weaponCodexBytes, "application/octet-stream");
const weaponBuildObject = await publishSharedObject("weapon-build-v1", weaponBuildBytes, "application/json");
const weaponChecksumObject = await publishSharedObject(
  "weapon-checksums-v1", weaponChecksumBytes, "application/octet-stream",
);
const weaponPortableResources: PortablePublication[] = [];
for (const [key, bytes, mediaType, kind, objectId] of [
  ["weapon-atlas-v1", weaponAtlasBytes, "image/webp", PortableResourceKind.Atlas, weaponAtlasObject.objectId],
  ["weapon-codex-v1", weaponCodexBytes, "application/octet-stream", PortableResourceKind.Codex, weaponCodexObject.objectId],
  ["weapon-build-v1", weaponBuildBytes, "application/json", PortableResourceKind.Metadata, weaponBuildObject.objectId],
  ["weapon-checksums-v1", weaponChecksumBytes, "application/octet-stream", PortableResourceKind.Metadata, weaponChecksumObject.objectId],
] as const) {
  weaponPortableResources.push(await publishPortableManifest(key, bytes, mediaType, kind, objectId));
}
for (const [index, resource] of weaponPortableResources.entries()) {
  await anchorPortablePublication(`weapon-bundle-v1-child-${index}`, resource);
  await assertPortablePublicationAnchored(`weapon-bundle-v1-child-${index}`, resource);
}
const weaponPortablePaths = ["vault-weapons-v1.atlas.webp", "vault-weapons-v1.codex.bin", "vault-weapons-v1.build.json", "vault-weapons-v1.sha256"] as const;
const weaponPortableGraphBytes = encodePortableGraphV1({
  entrypoint: "vault-weapons-v1.codex.bin",
  entries: weaponPortableResources.map((resource, index) => {
    const resourcePath = weaponPortablePaths[index];
    if (resourcePath === undefined) throw new Error("Portable weapon graph path mismatch.");
    return {
      path: resourcePath,
      portableRoot: resource.portableRoot,
      role: index === 1 ? PortableGraphRole.Entrypoint : PortableGraphRole.Data,
      executable: index === 1,
    };
  }),
});
const weaponPortableGraphObject = await publishSharedObject(
  "weapon-bundle-v1-portable-graph",
  weaponPortableGraphBytes,
  "application/octet-stream",
);
const weaponPortableGraph = await publishPortableManifest(
  "weapon-bundle-v1-portable-graph",
  weaponPortableGraphBytes,
  "application/octet-stream",
  PortableResourceKind.Graph,
  weaponPortableGraphObject.objectId,
);
const weaponPortableAnchorRoot = await anchorPortablePublication("weapon-bundle-v1", weaponPortableGraph);
const catalogObjectIds: readonly Hex[] = [
  catalogObject.objectId, metadataObject.objectId, targetObject.objectId,
  effectObject.objectId, soundObject.objectId, viewerObjectId,
];
const collectionPortableResources: PortablePublication[] = [];
for (const [key, bytes, mediaType, kind, objectId] of [
  ["character-viewer", viewerBytes, "text/html", PortableResourceKind.Viewer, viewerObjectId],
  ["character-catalog", catalogBytes, "application/octet-stream", PortableResourceKind.Codex, catalogObject.objectId],
  ["character-metadata", metadataBytes, "application/json", PortableResourceKind.Metadata, metadataObject.objectId],
  ["weapon-targets", targetBytes, "application/json", PortableResourceKind.Codex, targetObject.objectId],
  ["sprite-effects", effectBytes, "application/json", PortableResourceKind.Effect, effectObject.objectId],
  ["weapon-sounds", soundBytes, "application/json", PortableResourceKind.Sound, soundObject.objectId],
] as const) {
  collectionPortableResources.push(await publishPortableManifest(key, bytes, mediaType, kind, objectId));
}
collectionPortableResources.push(weaponPortableGraph);
for (const [index, resource] of collectionPortableResources.entries()) {
  if (resource.portableRoot !== weaponPortableGraph.portableRoot) {
    await anchorPortablePublication(`character-collection-child-${index}`, resource);
  }
  await assertPortablePublicationAnchored(`character-collection-child-${index}`, resource);
}
const collectionPortablePaths = ["viewer.html", "catalog.octr", "metadata.json", "targets.json", "effects.json", "sounds.json", "weapons.graph"] as const;
const collectionPortableEntries: PortableGraphEntryV1[] = collectionPortableResources.map((resource, index) => {
  const portablePath = collectionPortablePaths[index];
  if (portablePath === undefined) throw new Error("Portable collection graph path mismatch.");
  return {
    path: portablePath,
    portableRoot: resource.portableRoot,
    role: index === 0 ? PortableGraphRole.Entrypoint : PortableGraphRole.Data,
    executable: index === 0,
  };
});
const collectionPortableGraphBytes = encodePortableGraphV1({
  entrypoint: "viewer.html",
  entries: collectionPortableEntries,
});
const collectionPortableGraphObject = await publishSharedObject(
  "character-portable-graph",
  collectionPortableGraphBytes,
  "application/octet-stream",
);
const collectionPortableGraph = await publishPortableManifest(
  "character-portable-graph",
  collectionPortableGraphBytes,
  "application/octet-stream",
  PortableResourceKind.Graph,
  collectionPortableGraphObject.objectId,
);
const collectionPortableAnchorRoot = await anchorPortablePublication("character-collection", collectionPortableGraph);
for (const [index, resource] of collectionPortableResources.entries()) {
  await assertPortablePublicationAnchored(`character-collection-child-${index}`, resource);
}
await assertPortablePublicationAnchored("character-collection", collectionPortableGraph);
await verifyPublishedPortableGraph(collectionPortableGraph.portableRoot);

const latestCatalogRevision = await publicClient.readContract({
  address: characterRegistry.address, abi: characterRegistry.abi, functionName: "latestCatalogRevision",
}) as bigint;
const catalogRevisionExpected = {
  manifestDigest: sha256(metadataBytes),
  traitCodecDigest: sha256(catalogBytes),
  lockedTraitsRoot: keccak256(stringToHex("vault-orb-locked-character-renderer@1")),
  parentRevision: 0n,
  attributeCount: 32,
  rejectExactDuplicates: true,
  frozen: false,
};
let catalogState: "absent" | "exact" | "wrong" = latestCatalogRevision === 0n ? "absent" : "wrong";
if (latestCatalogRevision === 1n) {
  const value = await publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "catalogRevision", args: [1n] }) as typeof catalogRevisionExpected & { publisher: Address; exists: boolean };
  catalogState = value.exists
    && value.publisher.toLowerCase() === account.address.toLowerCase()
    && Object.entries(catalogRevisionExpected).every(([key, expected]) => exactTuple(value[key as keyof typeof value], expected))
    ? "exact"
    : "wrong";
}
await checkpointedTransition("character-catalog-r1", catalogState, characterRegistry.address, characterRegistry.abi, "publishCatalogRevision", [
    0n,
    catalogRevisionExpected.manifestDigest,
    catalogRevisionExpected.traitCodecDigest,
    catalogRevisionExpected.lockedTraitsRoot,
    32,
    true,
    false,
  ], async () => (await publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "latestCatalogRevision" })) === 1n);
let catalogObjects: { objectIds: readonly Hex[]; objectRevisions: readonly bigint[]; selectionEpoch: bigint; exists: boolean } | undefined;
try {
  catalogObjects = await publicClient.readContract({
    address: characterRegistry.address, abi: characterRegistry.abi, functionName: "catalogObjects", args: [1n],
  }) as typeof catalogObjects;
} catch {}
const catalogObjectsState: "exact" | "absent" | "wrong" = catalogObjects === undefined || !catalogObjects.exists
  ? "absent"
  : exactTuple(catalogObjects.objectIds, catalogObjectIds)
      && exactTuple(catalogObjects.objectRevisions, [1n, 1n, 1n, 1n, 1n, 1n])
      && catalogObjects.selectionEpoch === 1n
    ? "exact"
    : "wrong";
await checkpointedTransition("character-catalog-objects-r1", catalogObjectsState, characterRegistry.address, characterRegistry.abi, "publishCatalogObjects", [
    1n,
    1n,
    catalogObjectIds,
    [1n, 1n, 1n, 1n, 1n, 1n],
  ], async () => (await publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "catalogObjects", args: [1n] }) as { exists: boolean }).exists);
let portableBinding: { portableRoot: Hex; manifestObjectId: Hex; decodedObjectId: Hex; anchorRoot: Hex; manifestObjectRevision: bigint; decodedObjectRevision: bigint; exists: boolean } | undefined;
try {
  portableBinding = await publicClient.readContract({
    address: characterRegistry.address, abi: characterRegistry.abi, functionName: "catalogPortableBinding", args: [1n],
  }) as typeof portableBinding;
} catch {}
const portableState: "absent" | "exact" | "wrong" = portableBinding === undefined || !portableBinding.exists
  ? "absent"
  : portableBinding.portableRoot === collectionPortableGraph.portableRoot
      && portableBinding.manifestObjectId === collectionPortableGraph.manifestObjectId
      && portableBinding.manifestObjectRevision === collectionPortableGraph.manifestObjectRevision
      && portableBinding.decodedObjectId === collectionPortableGraph.decodedObjectId
      && portableBinding.decodedObjectRevision === collectionPortableGraph.decodedObjectRevision
      && portableBinding.anchorRoot === collectionPortableAnchorRoot
    ? "exact"
    : "wrong";
await checkpointedTransition(
  "character-catalog-portable-r1",
  portableState,
  characterRegistry.address,
  characterRegistry.abi,
  "publishCatalogPortableBinding",
  [
    1n,
    collectionPortableGraph.portableRoot,
    collectionPortableGraph.manifestObjectId,
    collectionPortableGraph.manifestObjectRevision,
    collectionPortableGraph.decodedObjectId,
    collectionPortableGraph.decodedObjectRevision,
    collectionPortableAnchorRoot,
  ],
  async () => (await publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "catalogPortableBinding", args: [1n] }) as { exists: boolean }).exists,
);

const weaponFamilyId = keccak256(stringToHex("vault.weapon"));
const latestWeaponRevision = await publicClient.readContract({
  address: spriteRegistry.address, abi: spriteRegistry.abi, functionName: "latestFamilyRevision", args: [weaponFamilyId],
}) as bigint;
const weaponInputs = ["gyro", "rift", "bloom", "needle"].map((weapon, index) => ({
    assetId: keccak256(stringToHex(`vault.weapon.${weapon}`)),
    spriteObjectId: weaponPortableGraphObject.objectId,
    targetMapObjectId: targetObject.objectId,
    effectProfileObjectId: effectObject.objectId,
    soundProfileObjectId: soundObject.objectId,
    emitterSpriteBundleId: 1,
    emitterSpriteAssetId: index + 1,
    emitterMaterialTargetId: keccak256(stringToHex(`vault.effect.weapon.${weapon}.material-target`)),
    weight: 1,
    spriteRevision: 1n,
    targetMapRevision: 1n,
    effectProfileRevision: 1n,
    soundProfileRevision: 1n,
    emitterPresetId: index + 1,
    emitterRevision: 1,
    emitterSpriteBundleRevision: 1,
    emitterSpriteSelectionRevision: 1,
    fxCatalogRevision: 1,
    mapGenerationEpoch: 1,
    emitterSeedDomainVersion: 1,
    emitterPaletteMode: 2,
  }));
let weaponFamilyState: "absent" | "exact" | "wrong" = latestWeaponRevision === 0n ? "absent" : "wrong";
if (latestWeaponRevision === 1n) {
  const [family, count, ...assets] = await Promise.all([
    publicClient.readContract({ address: spriteRegistry.address, abi: spriteRegistry.abi, functionName: "familyRevision", args: [weaponFamilyId, 1n] }) as Promise<{ catalogObjectId: Hex; totalWeight: bigint; parentRevision: bigint; assetCount: number; activeAssetCount: number; publisher: Address; catalogObjectRevision: bigint; exists: boolean }>,
    publicClient.readContract({ address: spriteRegistry.address, abi: spriteRegistry.abi, functionName: "familyAssetCount", args: [weaponFamilyId] }) as Promise<bigint>,
    ...weaponInputs.map((input) => publicClient.readContract({ address: spriteRegistry.address, abi: spriteRegistry.abi, functionName: "assetById", args: [weaponFamilyId, input.assetId] })),
  ]);
  const familyExact = family.exists
    && family.catalogObjectId === weaponPortableGraphObject.objectId
    && family.catalogObjectRevision === 1n
    && family.totalWeight === 4n
    && family.parentRevision === 0n
    && family.assetCount === 4
    && family.activeAssetCount === 4
    && family.publisher.toLowerCase() === account.address.toLowerCase()
    && count === 4n;
  const assetsExact = assets.every((asset, index) => {
    const expected = weaponInputs[index];
    if (expected === undefined) return false;
    const value = asset as Record<string, unknown>;
    return Object.entries(expected).every(([key, expectedValue]) => exactTuple(value[key], expectedValue))
      && value.introducedAt === 1n;
  });
  weaponFamilyState = familyExact && assetsExact ? "exact" : "wrong";
}
await checkpointedTransition("weapon-family-r1", weaponFamilyState, spriteRegistry.address, spriteRegistry.abi, "appendFamilyRevision", [
    weaponFamilyId, 0n, weaponPortableGraphObject.objectId, 1n, weaponInputs,
  ], async () => (await publicClient.readContract({ address: spriteRegistry.address, abi: spriteRegistry.abi, functionName: "latestFamilyRevision", args: [weaponFamilyId] })) === 1n);

for (const [index, definition] of [
  ["gyro", "Gyro Saw", "Gyro Saw Multi-hit"],
  ["rift", "Rift Fork", "Rift Fork Charge"],
  ["bloom", "Aegis Star", "Aegis Star Chime"],
  ["needle", "Needle Array", "Needle Array Clicks"],
].entries()) {
  const [key, name, sound] = definition as readonly [string, string, string];
  const assetId = keccak256(stringToHex(`vault.weapon.${key}`));
  const effectAssetId = index + 1;
  let assetCodec: { name: string; attackSound: string; attributeProfile: number; exists: boolean } | undefined;
  try {
    assetCodec = await publicClient.readContract({
      address: metadataRenderer.address,
      abi: metadataRenderer.abi,
      functionName: "assetCodec",
      args: [1n, assetId],
    }) as typeof assetCodec;
  } catch {}
  const assetCodecState: "absent" | "exact" | "wrong" = assetCodec === undefined || !assetCodec.exists
    ? "absent"
    : assetCodec.name === name && assetCodec.attackSound === sound && assetCodec.attributeProfile === index ? "exact" : "wrong";
  await checkpointedTransition(
    `weapon-metadata-codec-r1-${key}`,
    assetCodecState,
    metadataRenderer.address,
    metadataRenderer.abi,
    "publishAssetCodec",
    [1n, assetId, name, sound, index],
    async () => (await publicClient.readContract({ address: metadataRenderer.address, abi: metadataRenderer.abi, functionName: "assetCodec", args: [1n, assetId] }) as { exists: boolean }).exists,
  );
  const effectExpected = [`${name} Particle`, `${name} Attack Emitter`, "Linked Core Light", "Additive Glow", "Weapon Trail", "Additive"] as const;
  let effectCodec: { particleSprite: string; emitterPreset: string; colorMode: string; lightStyle: string; trailStyle: string; blendMode: string; exists: boolean } | undefined;
  try {
    effectCodec = await publicClient.readContract({
      address: metadataRenderer.address,
      abi: metadataRenderer.abi,
      functionName: "effectCodec",
      args: [1n, effectAssetId],
    }) as typeof effectCodec;
  } catch {}
  const effectCodecState: "absent" | "exact" | "wrong" = effectCodec === undefined || !effectCodec.exists
    ? "absent"
    : exactTuple(
        [effectCodec.particleSprite, effectCodec.emitterPreset, effectCodec.colorMode, effectCodec.lightStyle, effectCodec.trailStyle, effectCodec.blendMode],
        effectExpected,
      ) ? "exact" : "wrong";
  await checkpointedTransition(
    `weapon-effect-codec-r1-${key}`,
    effectCodecState,
    metadataRenderer.address,
    metadataRenderer.abi,
    "publishEffectCodec",
    [
      1n,
      effectAssetId,
      ...effectExpected,
    ],
    async () => (await publicClient.readContract({ address: metadataRenderer.address, abi: metadataRenderer.abi, functionName: "effectCodec", args: [1n, effectAssetId] }) as { exists: boolean }).exists,
  );
}

const rootSeed = keccak256(stringToHex(`vault-orb-keel-root@1/${chainId}/${collection.address.toLowerCase()}`));
const provenanceDigest = keccak256(stringToHex("vault-orb-mint-entropy-plus-keel-root@1"));
const characterMintEvidence: Array<{
  readonly tokenId: bigint;
  readonly mintTransaction: Hash;
}> = [];
const characterViewerSalt = keccak256(stringToHex("vault-orb-collection-viewer@1"));
const characterViewerId = await publicClient.readContract({
  address: harnessRegistry.address,
  abi: harnessRegistry.abi,
  functionName: "predictHarnessId",
  args: [account.address, characterViewerSalt, collection.address],
}) as Hex;
const characterSeedSetDigest = await publicClient.readContract({
  address: seedRegistry.address,
  abi: seedRegistry.abi,
  functionName: "computeMintSeedSetCommitment",
  args: [characterViewerId, 1n, rootSeed, provenanceDigest],
}) as Hex;
const characterManifest: ArtifactManifest = {
    schema: KEEL_MANIFEST_SCHEMA,
    canonicalization: KEEL_CANONICALIZATION,
    id: "vault-orb-character-collection",
    name: "Vault Orb Character",
    description: "An animated floating Orb Core with a detached seeded weapon, permanent mint entropy, material targets, particle FX, and a weapon-matched sound profile.",
    entrypoint: { resource: "viewer", mode: "html" },
    resources: [{
      id: "viewer", role: "entrypoint", mediaType: "text/html", executable: true, originalName: "vault-orb-viewer.html",
      sources: [{ kind: "onchain", chainId, store: oldDeployment.contracts.keelHold.toLowerCase() as Address, objectId: viewerContent.objectId, integrity: { algorithm: "sha256", digest: viewerContent.digest, byteLength: viewerBytes.length } }],
    }],
    fallback: { image: "viewer", animation: "viewer", backgroundColor: "#050908" },
    runtime: {
      engine: { protocol: KEEL_RUNTIME_PROTOCOL, viewerProtocol: KEEL_VIEWER_PROTOCOL, renderer: "browser" },
      determinism: { mode: "live" },
      content: { protocol: KEEL_CONTENT_GATEWAY_PROTOCOL, mode: "verified-only", externalSources: "host-verified", manifestTrust: "registry", blockUndeclared: true, resourcePathPrefix: "/content/", onchainPathPrefix: "/onchain/", ipfsPathPrefix: "/ipfs/" },
      sandbox: "strict", capabilities: { audio: true }, maxResourceBytes: 1_000_000, maxTotalBytes: 1_000_000, maxRecursionDepth: 8, maxResources: 8, timeoutMs: 30_000,
    },
    anchor: { protocol: KEEL_REGISTRY_ANCHOR_PROTOCOL, kind: "artifact-registry", chainId, registry: oldDeployment.contracts.keelIndex.toLowerCase() as Address, collection: collection.address.toLowerCase() as Address, scope: "collection", tokenId: "*", revision: 1 },
    revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "immutable", frozen: true },
    provenance: { creator: account.address.toLowerCase() as Address, createdAt: "2026-08-10T00:00:00.000Z", chainId, collection: collection.address.toLowerCase() as Address, license: "MIT" },
    extensions: { "keel.runtime": {
      protocol: "keel-runtime@1",
      chainId,
      mode: "live",
      artifactRegistry: oldDeployment.contracts.artifactRegistry.toLowerCase(),
      harnessRegistry: harnessRegistry.address.toLowerCase(),
      seedRegistry: seedRegistry.address.toLowerCase(),
      viewerId: characterViewerId,
      tokenId: "$anchor.tokenId",
      slotResources: ["viewer"],
      character: {
        registry: characterRegistry.address.toLowerCase(),
        collection: collection.address.toLowerCase(),
        characterId: "$anchor.tokenId",
      },
      collectionVerification: {
        registry: collectionVerificationRegistry.address.toLowerCase(),
        policyId: vaultVerificationPolicyId,
        tokenId: "$anchor.tokenId",
      },
      injection: {
        protocol: "keel-injection@1",
        fields: [
          "chain.id",
          "block.number",
          "block.hash",
          "token.id",
          "token.seed",
          "character.seed",
          "character.packedAttributes",
          "character.portableRoot",
          "character.portableManifestObjectId",
          "character.portableDecodedObjectId",
          "character.portableAnchorRoot",
          "character.portableManifestObjectRevision",
          "character.portableDecodedObjectRevision",
          "character.assetFamilyId",
          "character.assetId",
          "character.spriteObjectId",
          "character.targetMapObjectId",
          "character.effectProfileObjectId",
          "character.soundProfileObjectId",
          "character.emitterSpriteBundleId",
          "character.emitterSpriteAssetId",
          "character.emitterMaterialTargetId",
          "character.catalogRevision",
          "character.assetFamilyRevision",
          "character.emitterPresetId",
          "character.emitterRevision",
          "character.emitterSpriteBundleRevision",
          "character.emitterSpriteSelectionRevision",
          "character.fxCatalogRevision",
          "character.mapGenerationEpoch",
          "character.emitterSeedDomainVersion",
          "character.emitterPaletteMode",
          "character.sceneId",
          "collection.verification",
        ],
      },
    }, "keel.portable": {
      protocol: "keel-presentation-portable-binding@1",
      portableRoot: collectionPortableGraph.portableRoot,
      portableAnchorRoot: collectionPortableAnchorRoot,
      manifestObjectId: collectionPortableGraph.manifestObjectId,
      manifestObjectRevision: collectionPortableGraph.manifestObjectRevision.toString(),
      decodedObjectId: collectionPortableGraph.decodedObjectId,
      decodedObjectRevision: collectionPortableGraph.decodedObjectRevision.toString(),
    } },
  };
assertValidManifest(characterManifest);
const characterCommitment = await manifestIntegrity(characterManifest);
const characterViewerExists = await publicClient.readContract({
  address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessRevisionExists", args: [characterViewerId, 1n],
}) as boolean;
async function viewerState(
  viewerId: Hex,
  exists: boolean,
  expectedCollection: Address,
  expectedSlots: readonly Hex[],
  expectedRevisions: readonly bigint[],
  manifestDigest: Hex,
  seedSetDigest: Hex,
): Promise<"absent" | "exact" | "wrong"> {
  if (!exists) return "absent";
  const [revision, slots, harnessCollection] = await Promise.all([
    publicClient.readContract({ address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessRevision", args: [viewerId, 1n] }) as Promise<{ manifestDigest: Hex; seedSetDigest: Hex; parentRevision: bigint; publisher: Address; exists: boolean }>,
    publicClient.readContract({ address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessSlots", args: [viewerId, 1n] }) as Promise<readonly [readonly Hex[], readonly bigint[]]>,
    publicClient.readContract({ address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessCollection", args: [viewerId] }) as Promise<Address>,
  ]);
  return revision.exists
    && revision.manifestDigest === manifestDigest
    && revision.seedSetDigest === seedSetDigest
    && revision.parentRevision === 0n
    && revision.publisher.toLowerCase() === account.address.toLowerCase()
    && harnessCollection.toLowerCase() === expectedCollection.toLowerCase()
    && exactTuple(slots[0], expectedSlots)
    && exactTuple(slots[1], expectedRevisions)
    ? "exact"
    : "wrong";
}
await checkpointedTransition("character-collection-viewer", await viewerState(
  characterViewerId, characterViewerExists, collection.address, [viewerObjectId], [1n], characterCommitment.digest, characterSeedSetDigest,
), harnessRegistry.address, harnessRegistry.abi, "forgeHarness", [
  characterViewerSalt, collection.address, 0, 0, [viewerObjectId], [1n], characterCommitment.digest, characterSeedSetDigest,
], async () => (await publicClient.readContract({ address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessRevisionExists", args: [characterViewerId, 1n] })) === true);
const characterSeedSetId = await publicClient.readContract({
  address: seedRegistry.address, abi: seedRegistry.abi, functionName: "predictSeedSetId", args: [characterViewerId, 1n],
}) as Hex;
let characterSeed: { viewerId: Hex; harnessRevision: bigint; collection: Address; viewerManifestDigest: Hex; rootSeed: Hex; provenanceDigest: Hex; publisher: Address; exists: boolean } | undefined;
try { characterSeed = await publicClient.readContract({ address: seedRegistry.address, abi: seedRegistry.abi, functionName: "seedSet", args: [characterSeedSetId] }) as typeof characterSeed; } catch {}
const characterSeedState: "absent" | "exact" | "wrong" = characterSeed === undefined || !characterSeed.exists
  ? "absent"
  : characterSeed.viewerId === characterViewerId
      && characterSeed.harnessRevision === 1n
      && characterSeed.collection.toLowerCase() === collection.address.toLowerCase()
      && characterSeed.viewerManifestDigest === characterCommitment.digest
      && characterSeed.rootSeed === rootSeed
      && characterSeed.provenanceDigest === provenanceDigest
      && characterSeed.publisher.toLowerCase() === account.address.toLowerCase()
    ? "exact"
    : "wrong";
await checkpointedTransition("character-collection-seed", characterSeedState, seedRegistry.address, seedRegistry.abi, "publishMintSeedSet", [
  characterViewerId, 1n, rootSeed, provenanceDigest,
], async () => (await publicClient.readContract({ address: seedRegistry.address, abi: seedRegistry.abi, functionName: "mintEntropyEnabled", args: [characterSeedSetId] })) === true);
const characterManifestBytes = utf8ToBytes(canonicalJson(characterManifest));
const characterManifestContent = await publishContent("character-collection-manifest", characterManifestBytes, "application/json");
const characterManifestUri = `oca-onchain://${chainId}/${oldDeployment.contracts.keelHold.toLowerCase()}/${characterManifestContent.objectId}`;
const collectionScope = await publicClient.readContract({
  address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "scopeStatus", args: [collection.address, 0n, false],
}) as readonly [bigint,bigint,boolean];
let collectionPublishState: "absent" | "exact" | "wrong" = collectionScope[0] === 0n ? "absent" : "wrong";
if (collectionScope[0] === 1n) {
  const revision = await publicClient.readContract({ address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "revisionOf", args: [collection.address, 0n, false, 1n] }) as { manifestURI: string; manifestDigest: Hex; revision: bigint; parentRevision: bigint; compatibilityMin: bigint; compatibilityMax: bigint; activationTime: bigint; policy: number; frozen: boolean };
  collectionPublishState = revision.manifestURI === characterManifestUri
    && revision.manifestDigest === characterCommitment.digest
    && revision.revision === 1n && revision.parentRevision === 0n
    && revision.compatibilityMin === 1n && revision.compatibilityMax === 1n
    && revision.policy === 0 ? "exact" : "wrong";
}
await checkpointedTransition("character-collection-manifest-publish", collectionPublishState, oldDeployment.contracts.keelIndex, registry.abi, "publishCollectionRevision", [
    collection.address, characterManifestUri, characterCommitment.digest, 0n, 1n, 1n, 0, 0n,
  ], async () => (await publicClient.readContract({ address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "scopeStatus", args: [collection.address, 0n, false] }) as readonly [bigint,bigint,boolean])[0] === 1n);
await checkpointedTransition(
  "character-collection-manifest-activate",
  collectionScope[1] === 0n ? "absent" : collectionScope[1] === 1n ? "exact" : "wrong",
  oldDeployment.contracts.keelIndex,
  registry.abi,
  "activateCollectionRevision",
  [collection.address, 1n],
  async () => (await publicClient.readContract({ address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "scopeStatus", args: [collection.address, 0n, false] }) as readonly [bigint,bigint,boolean])[1] === 1n,
);
const presentationPortableBinding = await publicClient.readContract({
  address: collection.address,
  abi: collection.abi,
  functionName: "collectionPresentationBinding",
  args: [1n],
}) as readonly [Hex, Hex, Hex, Hex, Hex, boolean];
const presentationPortableState: "absent" | "exact" | "wrong" = !presentationPortableBinding[5]
  ? "absent"
  : presentationPortableBinding[0].toLowerCase() === characterCommitment.digest.toLowerCase()
      && presentationPortableBinding[1].toLowerCase() === collectionPortableGraph.portableRoot.toLowerCase()
      && presentationPortableBinding[2].toLowerCase() === collectionPortableAnchorRoot.toLowerCase()
      && presentationPortableBinding[3].toLowerCase() === viewerContent.objectId.toLowerCase()
      && presentationPortableBinding[4].toLowerCase() === viewerContent.digest.toLowerCase()
    ? "exact"
    : "wrong";
await checkpointedTransition(
  "character-collection-portable-binding-r1",
  presentationPortableState,
  collection.address,
  collection.abi,
  "bindCollectionPresentationRevision",
  [1n, characterCommitment.digest, collectionPortableGraph.portableRoot, viewerContent.objectId, viewerContent.digest],
  async () => {
    const current = await publicClient.readContract({
      address: collection.address,
      abi: collection.abi,
      functionName: "collectionPresentationBinding",
      args: [1n],
    }) as readonly [Hex, Hex, Hex, Hex, Hex, boolean];
    return current[5] && current[0].toLowerCase() === characterCommitment.digest.toLowerCase()
      && current[1].toLowerCase() === collectionPortableGraph.portableRoot.toLowerCase()
      && current[2].toLowerCase() === collectionPortableAnchorRoot.toLowerCase()
      && current[3].toLowerCase() === viewerContent.objectId.toLowerCase()
      && current[4].toLowerCase() === viewerContent.digest.toLowerCase();
  },
);
await write("character-collection-presentation", collection.address, collection.abi, "setDefaultPresentation", [
  characterManifestUri, characterCommitment.digest, "", "",
]);
const latestMintProfileRevision = await publicClient.readContract({
  address: characterRegistry.address,
  abi: characterRegistry.abi,
  functionName: "latestMintProfileRevision",
}) as bigint;
let mintProfileState: "absent" | "exact" | "wrong" = latestMintProfileRevision === 0n ? "absent" : "wrong";
if (latestMintProfileRevision === 1n) {
  const profile = await publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "mintProfile", args: [1n] }) as { seedSetId: Hex; assetFamilyId: Hex; catalogRevision: bigint; assetFamilyRevision: bigint; sceneId: number; exists: boolean };
  mintProfileState = profile.exists && profile.seedSetId === characterSeedSetId && profile.assetFamilyId === weaponFamilyId
    && profile.catalogRevision === 1n && profile.assetFamilyRevision === 1n && profile.sceneId === 1 ? "exact" : "wrong";
}
await checkpointedTransition(
  "character-mint-profile-r1",
  mintProfileState,
  characterRegistry.address,
  characterRegistry.abi,
  "publishMintProfile",
  [0n, 1n, characterSeedSetId, weaponFamilyId, 1n, 1],
  async () => (await publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "latestMintProfileRevision" })) === 1n,
);
const configuredCharacterRegistry = await publicClient.readContract({
  address: collection.address, abi: collection.abi, functionName: "characterRegistry",
}) as Address;
await checkpointedTransition(
  "collection-character-registry",
  configuredCharacterRegistry === zeroAddress ? "absent" : configuredCharacterRegistry.toLowerCase() === characterRegistry.address.toLowerCase() ? "exact" : "wrong",
  collection.address,
  collection.abi,
  "setCharacterRegistry",
  [characterRegistry.address, 1n],
  async () => (await publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "characterRegistry" }) as Address).toLowerCase() === characterRegistry.address.toLowerCase(),
);
const configuredSupply = await publicClient.readContract({
  address: collection.address, abi: collection.abi, functionName: "totalSupply",
}) as bigint;
if (configuredSupply > BigInt(VAULT_SEPOLIA_CHARACTER_MINT_COUNT)) {
  throw new Error("Vault collection supply exceeds the closure-bound multi-character acceptance count.");
}
for (let tokenId = 1n; tokenId <= BigInt(VAULT_SEPOLIA_CHARACTER_MINT_COUNT); tokenId += 1n) {
  const supply = await publicClient.readContract({
    address: collection.address, abi: collection.abi, functionName: "totalSupply",
  }) as bigint;
  let characterMintState: "absent" | "exact" | "wrong" = supply === tokenId - 1n ? "absent" : "wrong";
  if (supply >= tokenId) {
    const [owner, record] = await Promise.all([
      publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>,
      publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "characterRecord", args: [tokenId] }) as Promise<readonly [bigint, boolean]>,
    ]);
    let custodyExact = owner.toLowerCase() === account.address.toLowerCase();
    if (owner.toLowerCase() === arcade.address.toLowerCase()) {
      const [assigned, staker] = await Promise.all([
        publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "characterMap", args: [tokenId] }) as Promise<readonly [boolean, bigint]>,
        publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "stakerOf", args: [tokenId] }) as Promise<Address>,
      ]);
      custodyExact = assigned[0] && assigned[1] === BigInt(VAULT_SEPOLIA_MAP_ID)
        && staker.toLowerCase() === account.address.toLowerCase();
    }
    characterMintState = custodyExact
      && tupleField<boolean>(record, "exists", 1)
      && tupleField<bigint>(record, "mintProfileRevision", 0) === 1n ? "exact" : "wrong";
  }
  const mintTransaction = await checkpointedTransition(
    `mint-character-${tokenId}`,
    characterMintState,
    collection.address,
    collection.abi,
    "adminStrike",
    [account.address, 1n],
    async () => {
      const [currentSupply, owner, record, seed, registrySeed, recipe] = await Promise.all([
        publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "totalSupply" }) as Promise<bigint>,
        publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>,
        publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "characterRecord", args: [tokenId] }) as Promise<readonly [bigint, boolean]>,
        publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "tokenSeed", args: [tokenId] }) as Promise<Hex>,
        publicClient.readContract({ address: seedRegistry.address, abi: seedRegistry.abi, functionName: "deriveTokenSeed", args: [characterSeedSetId, tokenId] }) as Promise<Hex>,
        publicClient.readContract({ address: characterRegistry.address, abi: characterRegistry.abi, functionName: "renderRecipe", args: [tokenId] }) as Promise<{ derivedSeed: Hex; packedAttributes: Hex; assetId: Hex }>,
      ]);
      const custodyExact = owner.toLowerCase() === account.address.toLowerCase()
        || owner.toLowerCase() === arcade.address.toLowerCase();
      return currentSupply >= tokenId && custodyExact
        && tupleField<boolean>(record, "exists", 1)
        && tupleField<bigint>(record, "mintProfileRevision", 0) === 1n
        && seed !== ZERO_BYTES32 && recipe.derivedSeed === registrySeed
        && recipe.packedAttributes !== ZERO_BYTES32 && recipe.assetId !== ZERO_BYTES32;
    },
  );
  characterMintEvidence.push({ tokenId, mintTransaction });
}

const mapResources: ArtifactManifest["resources"] = [];
const mapSlotObjectIds: Hex[] = [];
const mapSlotObjectRevisions: bigint[] = [];
const mapPortableEntries: PortableGraphEntryV1[] = [];
for (const [id, relativePath, mediaType, role, executable] of mapResourceSpecs) {
  const bytes = await readFile(path.join(repositoryRoot, "examples/demos/vault-arcade", relativePath));
  const published = await publishSharedObject(`map-${id.replace(/[^a-z0-9]+/giu, "-")}`, bytes, mediaType);
  mapSlotObjectIds.push(published.objectId);
  mapSlotObjectRevisions.push(1n);
  const portableKind = role === "entrypoint"
    ? PortableResourceKind.Viewer
    : role === "script"
      ? PortableResourceKind.Viewer
      : role === "image"
        ? PortableResourceKind.Atlas
        : PortableResourceKind.Codex;
  const portable = await publishPortableManifest(
    `map-${id.replace(/[^a-z0-9]+/giu, "-")}`,
    bytes,
    mediaType,
    portableKind,
    published.objectId,
  );
  await anchorPortablePublication(`map-child-${id.replace(/[^a-z0-9]+/giu, "-")}`, portable);
  await assertPortablePublicationAnchored(`map-child-${id.replace(/[^a-z0-9]+/giu, "-")}`, portable);
  mapPortableEntries.push({
    path: id,
    portableRoot: portable.portableRoot,
    role: role === "entrypoint"
      ? PortableGraphRole.Entrypoint
      : role === "script"
        ? PortableGraphRole.Script
        : role === "image"
          ? PortableGraphRole.Image
          : PortableGraphRole.Data,
    executable,
  });
  mapResources.push({
    id,
    role,
    mediaType,
    executable,
    originalName: relativePath,
    sources: [{
      kind: "onchain",
      chainId,
      store: oldDeployment.contracts.keelHold.toLowerCase() as Address,
      objectId: published.contentObjectId,
      integrity: { algorithm: "sha256", digest: published.digest, byteLength: published.byteLength },
    }],
  });
}
const mapPortableGraphBytes = encodePortableGraphV1({ entrypoint: "index.html", entries: mapPortableEntries });
const mapPortableGraphObject = await publishSharedObject(
  "map-portable-graph",
  mapPortableGraphBytes,
  "application/octet-stream",
);
const mapPortableGraph = await publishPortableManifest(
  "map-portable-graph",
  mapPortableGraphBytes,
  "application/octet-stream",
  PortableResourceKind.Graph,
  mapPortableGraphObject.objectId,
);
const mapPortableAnchorRoot = await anchorPortablePublication("map-resource-graph", mapPortableGraph);
for (const [index, entry] of mapPortableEntries.entries()) {
  const childAnchorRoot = await publicClient.readContract({
    address: portableAnchorRegistry.address,
    abi: portableAnchorRegistry.abi,
    functionName: "portableAnchor",
    args: [entry.portableRoot],
  }) as Hex;
  if (childAnchorRoot === ZERO_BYTES32) throw new Error(`map child ${index} is missing its portable anchor.`);
}
await assertPortablePublicationAnchored("map-resource-graph", mapPortableGraph);
await verifyPublishedPortableGraph(mapPortableGraph.portableRoot);
const mapViewerSalt = keccak256(stringToHex("vault-map-runtime-viewer@1/map-collection"));
const mapViewerId = await publicClient.readContract({
  address: harnessRegistry.address,
  abi: harnessRegistry.abi,
  functionName: "predictHarnessId",
  args: [account.address, mapViewerSalt, mapCollection.address],
}) as Hex;
const mapManifest: ArtifactManifest = {
  schema: KEEL_MANIFEST_SCHEMA,
  canonicalization: KEEL_CANONICALIZATION,
  id: "vault-arcade-map-runtime",
  name: "Vault Arcade Map #1",
  description: "A verified Vault Arcade runtime that resolves any selected staked character from the map registry without duplicating a per-character manifest.",
  entrypoint: { resource: "index.html", mode: "html" },
  resources: mapResources,
  fallback: { image: "character-parts-eight-direction-168.webp", animation: "index.html", backgroundColor: "#070812" },
  runtime: {
    engine: { protocol: KEEL_RUNTIME_PROTOCOL, viewerProtocol: KEEL_VIEWER_PROTOCOL, renderer: "browser" },
    determinism: { mode: "live" },
    content: {
      protocol: KEEL_CONTENT_GATEWAY_PROTOCOL,
      mode: "verified-only",
      externalSources: "host-verified",
      manifestTrust: "registry",
      blockUndeclared: true,
      resourcePathPrefix: "/content/",
      onchainPathPrefix: "/onchain/",
      ipfsPathPrefix: "/ipfs/",
    },
    sandbox: "strict",
    capabilities: { audio: true },
    maxResourceBytes: 1_000_000,
    maxTotalBytes: 8_388_608,
    maxRecursionDepth: 8,
    maxResources: 32,
    timeoutMs: 30_000,
  },
  anchor: {
    protocol: KEEL_REGISTRY_ANCHOR_PROTOCOL,
    kind: "artifact-registry",
    chainId,
    registry: oldDeployment.contracts.keelIndex.toLowerCase() as Address,
    collection: mapCollection.address.toLowerCase() as Address,
    tokenId: "1",
    revision: 1,
  },
  revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "creator-or-owner", frozen: false },
  provenance: {
    creator: account.address.toLowerCase() as Address,
    createdAt: "2026-08-10T00:00:00.000Z",
    chainId,
    collection: mapCollection.address.toLowerCase() as Address,
    tokenId: "1",
    license: "MIT",
  },
  extensions: { "keel.runtime": {
    protocol: "keel-runtime@1",
    chainId,
    mode: "live",
    artifactRegistry: oldDeployment.contracts.artifactRegistry.toLowerCase(),
    harnessRegistry: harnessRegistry.address.toLowerCase(),
    viewerId: mapViewerId,
    tokenId: "$anchor.tokenId",
    slotResources: mapResourceSpecs.map(([id]) => id),
    character: {
      registry: characterRegistry.address.toLowerCase(),
      collection: collection.address.toLowerCase(),
      characterId: "$staked.characterId",
    },
    map: { registry: arcade.address.toLowerCase(), collection: mapCollection.address.toLowerCase(), mapId: "$anchor.tokenId" },
    injection: {
      protocol: "keel-injection@1",
      fields: [
        "chain.id",
        "block.number",
        "block.hash",
        "token.id",
        "character.seed",
        "character.packedAttributes",
        "character.portableRoot",
        "character.portableManifestObjectId",
        "character.portableDecodedObjectId",
        "character.portableAnchorRoot",
        "character.portableManifestObjectRevision",
        "character.portableDecodedObjectRevision",
        "character.assetFamilyId",
        "character.assetId",
        "character.spriteObjectId",
        "character.targetMapObjectId",
        "character.effectProfileObjectId",
        "character.soundProfileObjectId",
        "character.emitterSpriteBundleId",
        "character.emitterSpriteAssetId",
        "character.emitterMaterialTargetId",
        "character.catalogRevision",
        "character.assetFamilyRevision",
        "character.emitterPresetId",
        "character.emitterRevision",
        "character.emitterSpriteBundleRevision",
        "character.emitterSpriteSelectionRevision",
        "character.fxCatalogRevision",
        "character.mapGenerationEpoch",
        "character.emitterSeedDomainVersion",
        "character.emitterPaletteMode",
        "character.sceneId",
        "map.characterSeed",
        "map.seed",
        "map.buildRevision",
        "map.portableRoot",
        "map.portableManifestObjectId",
        "map.portableDecodedObjectId",
        "map.portableAnchorRoot",
        "map.portableManifestObjectRevision",
        "map.portableDecodedObjectRevision",
      ],
    },
  } },
};
assertValidManifest(mapManifest);
const mapManifestCommitment = await manifestIntegrity(mapManifest);
const mapViewerExists = await publicClient.readContract({
  address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessRevisionExists", args: [mapViewerId, 1n],
}) as boolean;
const mapSeedSetDigest = keccak256(stringToHex("vault-map-runtime-no-token-seed@1"));
await checkpointedTransition("map-viewer", await viewerState(
  mapViewerId, mapViewerExists, mapCollection.address, mapSlotObjectIds, mapSlotObjectRevisions, mapManifestCommitment.digest, mapSeedSetDigest,
), harnessRegistry.address, harnessRegistry.abi, "forgeHarness", [
  mapViewerSalt,
  mapCollection.address,
  1,
  0,
  mapSlotObjectIds,
  mapSlotObjectRevisions,
  mapManifestCommitment.digest,
  mapSeedSetDigest,
], async () => (await publicClient.readContract({ address: harnessRegistry.address, abi: harnessRegistry.abi, functionName: "harnessRevisionExists", args: [mapViewerId, 1n] })) === true);
const mapManifestBytes = utf8ToBytes(canonicalJson(mapManifest));
const mapManifestContent = await publishContent("map-manifest", mapManifestBytes, "application/json");
const mapManifestUri = `oca-onchain://${chainId}/${oldDeployment.contracts.keelHold.toLowerCase()}/${mapManifestContent.objectId}`;
const mapScope = await publicClient.readContract({
  address: oldDeployment.contracts.keelIndex,
  abi: registry.abi,
  functionName: "scopeStatus",
  args: [mapCollection.address, 1n, true],
}) as readonly [bigint, bigint, boolean];
let mapPublishState: "absent" | "exact" | "wrong" = mapScope[0] === 0n ? "absent" : "wrong";
if (mapScope[0] === 1n) {
  const revision = await publicClient.readContract({ address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "revisionOf", args: [mapCollection.address, 1n, true, 1n] }) as { manifestURI: string; manifestDigest: Hex; revision: bigint; parentRevision: bigint; compatibilityMin: bigint; compatibilityMax: bigint; activationTime: bigint; policy: number; frozen: boolean };
  mapPublishState = revision.manifestURI === mapManifestUri && revision.manifestDigest === mapManifestCommitment.digest
    && revision.revision === 1n && revision.parentRevision === 0n && revision.compatibilityMin === 1n
    && revision.compatibilityMax === 1n && revision.activationTime === 0n && revision.policy === 3 && !revision.frozen ? "exact" : "wrong";
}
await checkpointedTransition("map-presentation-publish", mapPublishState, oldDeployment.contracts.keelIndex, registry.abi, "publishTokenRevision", [
    mapCollection.address, 1n, mapManifestUri, mapManifestCommitment.digest, 0n, 1n, 1n, 3, 0n,
  ], async () => (await publicClient.readContract({ address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "scopeStatus", args: [mapCollection.address, 1n, true] }) as readonly [bigint,bigint,boolean])[0] === 1n);
await checkpointedTransition(
  "map-presentation-activate",
  mapScope[1] === 0n ? "absent" : mapScope[1] === 1n && !mapScope[2] ? "exact" : "wrong",
  oldDeployment.contracts.keelIndex,
  registry.abi,
  "activateTokenRevision",
  [
    mapCollection.address, 1n, 1n,
  ],
  async () => (await publicClient.readContract({ address: oldDeployment.contracts.keelIndex, abi: registry.abi, functionName: "scopeStatus", args: [mapCollection.address, 1n, true] }) as readonly [bigint,bigint,boolean])[1] === 1n,
);
await write("map-default-presentation", mapCollection.address, mapCollection.abi, "setDefaultPresentation", [
  mapManifestUri, mapManifestCommitment.digest, "", "",
]);
const mapManifestDigest = mapManifestCommitment.digest;
const gameObjectId = mapSlotObjectIds[0];
if (gameObjectId === undefined) throw new Error("Map runtime requires an entrypoint object.");
const mapResourceGraphDigest = keccak256(stringToHex(canonicalJson(
  mapResourceSpecs.map(([id], index) => ({ id, objectId: mapSlotObjectIds[index], revision: 1 })),
)));
const latestBuild = await publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "latestMapBuild", args: [1n] }) as bigint;
const expectedMapSeed = keccak256(stringToHex("vault-map-001"));
const mapSampleWeapon = weaponInputs[0];
if (mapSampleWeapon === undefined) throw new Error("Vault map viewer requires a committed sample weapon asset.");
const mapViewerContext = utf8ToBytes(canonicalJson({
  chainId,
  collection: mapCollection.address.toLowerCase(),
  tokenId: String(VAULT_SEPOLIA_MAP_ID),
  derivedTokenSeed: expectedMapSeed,
  packedAttributes: ZERO_BYTES32,
  assetId: mapSampleWeapon.assetId,
}));
let mapBuildState: "absent" | "exact" | "wrong" = latestBuild === 0n ? "absent" : "wrong";
if (latestBuild === 1n) {
  const build = await publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "mapBuild", args: [1n, 1n] }) as { manifestDigest: Hex; resourceGraphDigest: Hex; gameObjectId: Hex; mapSeed: Hex; artifactRevision: bigint; gameObjectRevision: bigint; parentRevision: bigint; publisher: Address; frozen: boolean; exists: boolean };
  mapBuildState = build.exists && build.manifestDigest === mapManifestDigest && build.resourceGraphDigest === mapResourceGraphDigest
    && build.gameObjectId === gameObjectId && build.mapSeed === expectedMapSeed && build.artifactRevision === 1n
    && build.gameObjectRevision === 1n && build.parentRevision === 0n && build.publisher.toLowerCase() === account.address.toLowerCase()
    && !build.frozen ? "exact" : "wrong";
}
await checkpointedTransition("map-build", mapBuildState, arcade.address, arcade.abi, "publishMapBuild", [
  1n, 0n, 1n, mapManifestDigest, mapResourceGraphDigest, gameObjectId, 1n,
  expectedMapSeed, false,
], async () => (await publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "latestMapBuild", args: [1n] })) === 1n);
const activeMapBuildRevision = 1n;
const activeMapBuild = await publicClient.readContract({
  address: arcade.address,
  abi: arcade.abi,
  functionName: "mapBuild",
  args: [1n, activeMapBuildRevision],
}) as {
  portableRoot: Hex;
  portableManifestObjectId: Hex;
  portableDecodedObjectId: Hex;
  portableAnchorRoot: Hex;
  portableManifestObjectRevision: bigint;
  portableDecodedObjectRevision: bigint;
};
const mapPortableAbsent = activeMapBuild.portableRoot === ZERO_BYTES32
  && activeMapBuild.portableManifestObjectId === ZERO_BYTES32
  && activeMapBuild.portableDecodedObjectId === ZERO_BYTES32
  && activeMapBuild.portableAnchorRoot === ZERO_BYTES32
  && activeMapBuild.portableManifestObjectRevision === 0n
  && activeMapBuild.portableDecodedObjectRevision === 0n;
const mapPortableExact = activeMapBuild.portableRoot === mapPortableGraph.portableRoot
  && activeMapBuild.portableManifestObjectId === mapPortableGraph.manifestObjectId
  && activeMapBuild.portableDecodedObjectId === mapPortableGraph.decodedObjectId
  && activeMapBuild.portableAnchorRoot === mapPortableAnchorRoot
  && activeMapBuild.portableManifestObjectRevision === mapPortableGraph.manifestObjectRevision
  && activeMapBuild.portableDecodedObjectRevision === mapPortableGraph.decodedObjectRevision;
const mapPortableState: "absent" | "exact" | "wrong" = mapPortableAbsent
  ? "absent"
  : mapPortableExact ? "exact" : "wrong";
await checkpointedTransition(
  "map-build-portable-binding",
  mapPortableState,
  arcade.address,
  arcade.abi,
  "bindMapBuildPortable",
  [
    1n,
    activeMapBuildRevision,
    mapPortableGraph.portableRoot,
    mapPortableGraph.manifestObjectId,
    mapPortableGraph.manifestObjectRevision,
    mapPortableGraph.decodedObjectId,
    mapPortableGraph.decodedObjectRevision,
    mapPortableAnchorRoot,
  ],
  async () => {
    const current = await publicClient.readContract({
      address: arcade.address, abi: arcade.abi, functionName: "mapBuild", args: [1n, 1n],
    }) as typeof activeMapBuild;
    return current.portableRoot === mapPortableGraph.portableRoot
      && current.portableManifestObjectId === mapPortableGraph.manifestObjectId
      && current.portableDecodedObjectId === mapPortableGraph.decodedObjectId
      && current.portableAnchorRoot === mapPortableAnchorRoot
      && current.portableManifestObjectRevision === mapPortableGraph.manifestObjectRevision
      && current.portableDecodedObjectRevision === mapPortableGraph.decodedObjectRevision;
  },
);
const approved = await publicClient.readContract({
  address: collection.address, abi: collection.abi, functionName: "isApprovedForAll", args: [account.address, arcade.address],
}) as boolean;
const approvalTransaction = await checkpointedTransition("approve-arcade-staking", approved ? "exact" : "absent", collection.address, collection.abi, "setApprovalForAll", [arcade.address, true], async () => (await publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "isApprovedForAll", args: [account.address, arcade.address] })) === true);
const stakeTransactions = new Map<bigint, Hash>();
for (let tokenId = 1n; tokenId <= BigInt(VAULT_SEPOLIA_CHARACTER_MINT_COUNT); tokenId += 1n) {
  const assigned = await publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "characterMap", args: [tokenId] }) as readonly [boolean,bigint];
  const stakeTransaction = await checkpointedTransition(`stake-${tokenId}`, !assigned[0] ? "absent" : assigned[1] === BigInt(VAULT_SEPOLIA_MAP_ID) ? "exact" : "wrong", arcade.address, arcade.abi, "enterMap", [tokenId, BigInt(VAULT_SEPOLIA_MAP_ID)], async () => {
    const [current, owner, staker, runtime] = await Promise.all([
      publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "characterMap", args: [tokenId] }) as Promise<readonly [boolean,bigint]>,
      publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>,
      publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "stakerOf", args: [tokenId] }) as Promise<Address>,
      publicClient.readContract({ address: arcade.address, abi: arcade.abi, functionName: "mapCharacterRuntime", args: [BigInt(VAULT_SEPOLIA_MAP_ID), tokenId] }) as Promise<readonly [bigint, unknown, { derivedSeed: Hex; packedAttributes: Hex; assetId: Hex }]>,
    ]);
    return current[0] && current[1] === BigInt(VAULT_SEPOLIA_MAP_ID)
      && owner.toLowerCase() === arcade.address.toLowerCase()
      && staker.toLowerCase() === account.address.toLowerCase()
      && runtime[0] === activeMapBuildRevision
      && runtime[2].derivedSeed !== ZERO_BYTES32 && runtime[2].packedAttributes !== ZERO_BYTES32
      && runtime[2].assetId !== ZERO_BYTES32;
  });
  stakeTransactions.set(tokenId, stakeTransaction);
}

const presentationFrozen = await publicClient.readContract({
  address: collection.address, abi: collection.abi, functionName: "defaultPresentationFrozen",
}) as boolean;
await checkpointedTransition("freeze-character-presentation", presentationFrozen ? "exact" : "absent", collection.address, collection.abi, "freezeDefaultPresentation", [], async () => (await publicClient.readContract({ address: collection.address, abi: collection.abi, functionName: "defaultPresentationFrozen" })) === true);

const vaultVerificationState = await publicClient.readContract({
  address: collection.address,
  abi: collection.abi,
  functionName: "keelVerificationState",
  args: [1n],
}) as {
  routeLocked: boolean;
  pointerAuthority: Address;
  presentationScope: bigint;
  presentationRevision: bigint;
  portableRoot: Hex;
  manifestDigest: Hex;
};
if (
  !vaultVerificationState.routeLocked || vaultVerificationState.pointerAuthority !== zeroAddress
  || vaultVerificationState.presentationScope !== 0n || vaultVerificationState.presentationRevision !== 1n
  || vaultVerificationState.portableRoot !== collectionPortableGraph.portableRoot
  || vaultVerificationState.manifestDigest !== characterCommitment.digest
) throw new Error("Vault official hook does not expose the exact locked Keel route and content roots.");
const installedVaultPolicy = await publicClient.readContract({
  address: collectionVerificationRegistry.address,
  abi: collectionVerificationRegistry.abi,
  functionName: "policy",
  args: [vaultVerificationPolicyId],
}) as { enabled: boolean; exists: boolean };
await checkpointedTransition(
  "vault-official-verification-policy",
  !installedVaultPolicy.exists ? "absent" : installedVaultPolicy.enabled ? "exact" : "absent",
  collectionVerificationRegistry.address,
  collectionVerificationRegistry.abi,
  "setPolicy",
  [vaultVerificationPolicyInput, true],
  async () => {
    const current = await publicClient.readContract({
      address: collectionVerificationRegistry.address,
      abi: collectionVerificationRegistry.abi,
      functionName: "policy",
      args: [vaultVerificationPolicyId],
    }) as { enabled: boolean; exists: boolean };
    return current.exists && current.enabled;
  },
);

const verificationTokenId = 1n;
let vaultVerificationReceiptId = await publicClient.readContract({
  address: collectionVerificationRegistry.address,
  abi: collectionVerificationRegistry.abi,
  functionName: "latestReceipt",
  args: [collection.address, verificationTokenId],
}) as Hex;
let verificationRecordState: "absent" | "exact" | "wrong" = vaultVerificationReceiptId === ZERO_BYTES32
  ? "absent"
  : "wrong";
if (vaultVerificationReceiptId !== ZERO_BYTES32) {
  const existing = await publicClient.readContract({
    address: collectionVerificationRegistry.address,
    abi: collectionVerificationRegistry.abi,
    functionName: "receipt",
    args: [vaultVerificationReceiptId],
  }) as {
    policyId: Hex;
    collection: Address;
    tokenId: bigint;
    chainId: bigint;
    portableRoot: Hex;
    portableAnchorRoot: Hex;
    manifestDigest: Hex;
    presentationRevision: bigint;
    observedBlock: bigint;
    exists: boolean;
  };
  verificationRecordState = existing.exists
    && existing.policyId === vaultVerificationPolicyId
    && existing.collection.toLowerCase() === collection.address.toLowerCase()
    && existing.tokenId === verificationTokenId
    && existing.chainId === BigInt(chainId)
    && existing.portableRoot === collectionPortableGraph.portableRoot
    && existing.portableAnchorRoot === collectionPortableAnchorRoot
    && existing.manifestDigest === characterCommitment.digest
    && existing.presentationRevision === 1n
    && existing.observedBlock > 0n
    ? "exact"
    : "wrong";
}
const verificationRecordTx = await checkpointedTransition(
  "vault-verification-record-token-1",
  verificationRecordState,
  collectionVerificationRegistry.address,
  collectionVerificationRegistry.abi,
  "recordApproved",
  [collection.address, verificationTokenId, vaultVerificationPolicyId],
  async () => (await publicClient.readContract({
    address: collectionVerificationRegistry.address,
    abi: collectionVerificationRegistry.abi,
    functionName: "latestReceipt",
    args: [collection.address, verificationTokenId],
  }) as Hex) !== ZERO_BYTES32,
);
vaultVerificationReceiptId = await publicClient.readContract({
  address: collectionVerificationRegistry.address,
  abi: collectionVerificationRegistry.abi,
  functionName: "latestReceipt",
  args: [collection.address, verificationTokenId],
}) as Hex;
if (vaultVerificationReceiptId === ZERO_BYTES32) throw new Error("Vault verification record produced no receipt ID.");
const verificationRecordMined = await publicClient.getTransactionReceipt({ hash: verificationRecordTx });
if (verificationRecordMined.status !== "success" || verificationRecordMined.blockHash === null) {
  throw new Error("Vault verification observation transaction is not mined canonically.");
}
const unsealedReceipt = await publicClient.readContract({
  address: collectionVerificationRegistry.address,
  abi: collectionVerificationRegistry.abi,
  functionName: "receipt",
  args: [vaultVerificationReceiptId],
}) as { observedBlock: bigint; evidenceBlock: bigint; evidenceBlockHash: Hex; exists: boolean };
if (!unsealedReceipt.exists || unsealedReceipt.observedBlock !== verificationRecordMined.blockNumber) {
  throw new Error("Vault verification receipt observation does not match its mined transaction block.");
}
const verificationSealState: "absent" | "exact" | "wrong" = unsealedReceipt.evidenceBlockHash === ZERO_BYTES32
  ? "absent"
  : unsealedReceipt.evidenceBlock === unsealedReceipt.observedBlock
      && unsealedReceipt.evidenceBlockHash === verificationRecordMined.blockHash
    ? "exact"
    : "wrong";
const verificationSealTx = await checkpointedTransition(
  "vault-verification-seal-token-1",
  verificationSealState,
  collectionVerificationRegistry.address,
  collectionVerificationRegistry.abi,
  "sealObservation",
  [vaultVerificationReceiptId, verificationRecordMined.blockHash],
  async () => {
    const sealed = await publicClient.readContract({
      address: collectionVerificationRegistry.address,
      abi: collectionVerificationRegistry.abi,
      functionName: "receipt",
      args: [vaultVerificationReceiptId],
    }) as { evidenceBlock: bigint; evidenceBlockHash: Hex };
    return sealed.evidenceBlock === verificationRecordMined.blockNumber
      && sealed.evidenceBlockHash === verificationRecordMined.blockHash;
  },
);
const verificationSealMined = await publicClient.getTransactionReceipt({ hash: verificationSealTx });
if (verificationSealMined.status !== "success" || verificationSealMined.blockHash === null) {
  throw new Error("Vault verification seal transaction is not mined canonically.");
}
const [pinnedReceiptId, pinnedReceipt, pinnedReceiptCurrent, pinnedInspection, pinnedPolicy] = await Promise.all([
  readContractAtBlockHash(collectionVerificationRegistry.address, collectionVerificationRegistry.abi, "latestReceipt", [collection.address, verificationTokenId], verificationSealMined.blockHash) as Promise<Hex>,
  readContractAtBlockHash(collectionVerificationRegistry.address, collectionVerificationRegistry.abi, "receipt", [vaultVerificationReceiptId], verificationSealMined.blockHash) as Promise<{ policyId: Hex; evidenceRoot: Hex; evidenceBlock: bigint; evidenceBlockHash: Hex; collection: Address; tokenId: bigint; chainId: bigint; portableRoot: Hex; portableAnchorRoot: Hex; manifestDigest: Hex; presentationRevision: bigint; revoked: boolean; exists: boolean }>,
  readContractAtBlockHash(collectionVerificationRegistry.address, collectionVerificationRegistry.abi, "receiptCurrent", [vaultVerificationReceiptId], verificationSealMined.blockHash) as Promise<boolean>,
  readContractAtBlockHash(collectionVerificationRegistry.address, collectionVerificationRegistry.abi, "inspectCurrent", [collection.address, verificationTokenId, vaultVerificationPolicyId], verificationSealMined.blockHash) as Promise<readonly [{ portableRoot: Hex; manifestDigest: Hex; presentationRevision: bigint; presentationScope: bigint }, { route: number; content: number; governance: number; mint: number; supply: number; upgrade: number }]>,
  readContractAtBlockHash(collectionVerificationRegistry.address, collectionVerificationRegistry.abi, "policy", [vaultVerificationPolicyId], verificationSealMined.blockHash) as Promise<{ enabled: boolean; exists: boolean }>,
]);
if (
  pinnedReceiptId !== vaultVerificationReceiptId
  || !pinnedReceipt.exists || pinnedReceipt.revoked || !pinnedReceiptCurrent
  || pinnedReceipt.policyId !== vaultVerificationPolicyId
  || pinnedReceipt.collection.toLowerCase() !== collection.address.toLowerCase()
  || pinnedReceipt.tokenId !== verificationTokenId || pinnedReceipt.chainId !== BigInt(chainId)
  || pinnedReceipt.portableRoot !== collectionPortableGraph.portableRoot
  || pinnedReceipt.portableAnchorRoot !== collectionPortableAnchorRoot
  || pinnedReceipt.manifestDigest !== characterCommitment.digest
  || pinnedReceipt.presentationRevision !== 1n
  || pinnedReceipt.evidenceBlock !== verificationRecordMined.blockNumber
  || pinnedReceipt.evidenceBlockHash !== verificationRecordMined.blockHash
  || pinnedInspection[0].portableRoot !== collectionPortableGraph.portableRoot
  || pinnedInspection[0].manifestDigest !== characterCommitment.digest
  || pinnedInspection[0].presentationRevision !== 1n || pinnedInspection[0].presentationScope !== 0n
  || pinnedInspection[1].route !== 1 || pinnedInspection[1].content !== 1
  || !pinnedPolicy.exists || !pinnedPolicy.enabled
) throw new Error("Pinned Vault collection verification receipt or inspectCurrent state is not current and exact.");

const vaultVerification = {
  receiptId: vaultVerificationReceiptId,
  policyId: vaultVerificationPolicyId,
  evidenceRoot: pinnedReceipt.evidenceRoot,
  scope: "collection" as const,
  receiptTokenId: verificationTokenId.toString(),
  appliesToTokenIds: characterMintEvidence.map(({ tokenId }) => tokenId.toString()),
  observationBlock: verificationRecordMined.blockNumber.toString(),
  observationBlockHash: verificationRecordMined.blockHash,
  sealedAtBlock: verificationSealMined.blockNumber.toString(),
  sealedAtBlockHash: verificationSealMined.blockHash,
};

const characters: VaultCharacterDeploymentOutput[] = [];
const mintEntropySeeds = new Set<Hex>();
for (let tokenId = 1n; tokenId <= BigInt(VAULT_SEPOLIA_CHARACTER_MINT_COUNT); tokenId += 1n) {
  const mintEvidence = characterMintEvidence.find((entry) => entry.tokenId === tokenId);
  const stakeTransaction = stakeTransactions.get(tokenId);
  if (mintEvidence === undefined || stakeTransaction === undefined) {
    throw new Error(`Vault character ${tokenId} is missing a checkpointed mint or stake transaction.`);
  }
  const [
    owner,
    assigned,
    staker,
    runtime,
    animationContext,
    collectionSeed,
    registrySeed,
    recipe,
    recipeDigest,
    tokenURI,
    reconstructedViewer,
  ] = await Promise.all([
    readContractAtBlockHash(collection.address, collection.abi, "ownerOf", [tokenId], verificationSealMined.blockHash) as Promise<Address>,
    readContractAtBlockHash(arcade.address, arcade.abi, "characterMap", [tokenId], verificationSealMined.blockHash) as Promise<readonly [boolean, bigint]>,
    readContractAtBlockHash(arcade.address, arcade.abi, "stakerOf", [tokenId], verificationSealMined.blockHash) as Promise<Address>,
    readContractAtBlockHash(arcade.address, arcade.abi, "mapCharacterRuntime", [BigInt(VAULT_SEPOLIA_MAP_ID), tokenId], verificationSealMined.blockHash) as Promise<readonly [bigint, { mapSeed: Hex; portableRoot: Hex }, { derivedSeed: Hex; packedAttributes: Hex; assetId: Hex }]>,
    readContractAtBlockHash(arcade.address, arcade.abi, "characterAnimationContext", [tokenId], verificationSealMined.blockHash) as Promise<readonly [boolean, bigint, bigint, Hex]>,
    readContractAtBlockHash(collection.address, collection.abi, "tokenSeed", [tokenId], verificationSealMined.blockHash) as Promise<Hex>,
    readContractAtBlockHash(seedRegistry.address, seedRegistry.abi, "deriveTokenSeed", [characterSeedSetId, tokenId], verificationSealMined.blockHash) as Promise<Hex>,
    readContractAtBlockHash(characterRegistry.address, characterRegistry.abi, "renderRecipe", [tokenId], verificationSealMined.blockHash) as Promise<{ derivedSeed: Hex; packedAttributes: Hex; assetId: Hex }>,
    readContractAtBlockHash(characterRegistry.address, characterRegistry.abi, "renderRecipeDigest", [tokenId], verificationSealMined.blockHash) as Promise<Hex>,
    readContractAtBlockHash(collection.address, collection.abi, "tokenURI", [tokenId], verificationSealMined.blockHash) as Promise<string>,
    readContractAtBlockHash(
      collection.address,
      collection.abi,
      "harnessHTML",
      [tokenId],
      verificationSealMined.blockHash,
    ) as Promise<Hex>,
  ]);
  if (
    owner.toLowerCase() !== arcade.address.toLowerCase()
    || !assigned[0] || assigned[1] !== BigInt(VAULT_SEPOLIA_MAP_ID)
    || staker.toLowerCase() !== account.address.toLowerCase()
    || runtime[0] !== activeMapBuildRevision
    || runtime[1].mapSeed !== expectedMapSeed
    || runtime[2].derivedSeed !== registrySeed || runtime[2].packedAttributes !== recipe.packedAttributes
    || runtime[2].assetId !== recipe.assetId || collectionSeed === ZERO_BYTES32 || recipe.derivedSeed !== registrySeed
    || !animationContext[0] || animationContext[1] !== BigInt(VAULT_SEPOLIA_MAP_ID)
    || animationContext[2] !== activeMapBuildRevision || animationContext[3] !== recipeDigest
  ) throw new Error(`Vault character ${tokenId} pinned mint/stake/runtime state is not exact.`);
  mintEntropySeeds.add(collectionSeed);

  const reconstructedViewerBytes = hexToBytes(reconstructedViewer);
  const reconstructedViewerDigest = sha256(reconstructedViewerBytes);
  if (reconstructedViewerBytes.length <= viewerBytes.length || !new TextDecoder().decode(reconstructedViewerBytes.slice(0, 96)).includes("__KEEL_CONTEXT__")) {
    throw new Error(`Vault character ${tokenId} on-chain viewer builder did not inject its committed token context.`);
  }
  const rawOnchainViewerPath = path.join(demoRoot, `character-${tokenId}-onchain.html`);
  await writeFile(rawOnchainViewerPath, reconstructedViewerBytes);

  const directLocalViewer = new URL("http://127.0.0.1:8766/examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer-bundled.html");
  directLocalViewer.searchParams.set("chainId", String(chainId));
  directLocalViewer.searchParams.set("collection", collection.address.toLowerCase());
  directLocalViewer.searchParams.set("tokenId", tokenId.toString());
  directLocalViewer.searchParams.set("seed", registrySeed);
  directLocalViewer.searchParams.set("attributes", recipe.packedAttributes);
  const studioPreviewPath = `/preview/${chainId}/${collection.address.toLowerCase()}/${tokenId}`;
  const studioCollectPath = `/collect/${chainId}/${collection.address.toLowerCase()}/${tokenId}`;
  const mintTransactionUrl = `https://sepolia.etherscan.io/tx/${mintEvidence.mintTransaction}`;
  const approvalTransactionUrl = `https://sepolia.etherscan.io/tx/${approvalTransaction}`;
  const stakeTransactionUrl = `https://sepolia.etherscan.io/tx/${stakeTransaction}`;
  characters.push({
    tokenId: tokenId.toString(),
    viewerId: characterViewerId,
    seedSetId: characterSeedSetId,
    derivedSeed: registrySeed,
    packedAttributes: recipe.packedAttributes,
    assetId: recipe.assetId,
    recipeDigest,
    manifestDigest: characterCommitment.digest,
    manifestUri: characterManifestUri,
    tokenURI,
    onchainHarnessObjectId: viewerContent.objectId,
    onchainHarnessDigest: viewerContent.digest,
    animationHTMLDigest: reconstructedViewerDigest,
    rawOnchainViewerPath: path.relative(repositoryRoot, rawOnchainViewerPath),
    directLocalViewerUrl: directLocalViewer.toString(),
    studioPreviewPath,
    studioCollectPath,
    publicViewerUrlTemplate: `{STUDIO_PUBLIC_BASE_URL}${studioPreviewPath}`,
    publicCollectUrlTemplate: `{STUDIO_PUBLIC_BASE_URL}${studioCollectPath}`,
    explorerTokenUrl: `https://sepolia.etherscan.io/token/${collection.address}?a=${tokenId}`,
    mintTransaction: mintEvidence.mintTransaction,
    mintTransactionUrl,
    approvalTransaction,
    approvalTransactionUrl,
    stakeTransaction,
    stakeTransactionUrl,
    collectionVerificationContext: {
      scope: "collection",
      registry: collectionVerificationRegistry.address,
      policyId: vaultVerificationPolicyId,
      receiptId: vaultVerificationReceiptId,
      receiptTokenId: verificationTokenId.toString(),
      appliesToTokenId: tokenId.toString(),
    },
    pinnedState: {
      blockNumber: verificationSealMined.blockNumber.toString(),
      blockHash: verificationSealMined.blockHash,
      owner,
      assigned: assigned[0],
      mapId: assigned[1].toString(),
      staker,
      mapCharacterRuntime: checkpointJsonValue({
        mapBuildRevision: runtime[0],
        build: runtime[1],
        character: runtime[2],
        animationContext,
      }),
    },
  });
}
if (mintEntropySeeds.size !== VAULT_SEPOLIA_CHARACTER_MINT_COUNT) {
  throw new Error("Vault Sepolia output contains duplicate mint-time entropy seeds.");
}
assertVaultMultiCharacterDeployment(characters, VAULT_SEPOLIA_CHARACTER_MINT_COUNT);

const mapTokenURI = await readContractAtBlockHash(
  mapCollection.address,
  mapCollection.abi,
  "tokenURI",
  [BigInt(VAULT_SEPOLIA_MAP_ID)],
  verificationSealMined.blockHash,
) as string;
const metadataPrefix = "data:application/json;base64,";
if (!mapTokenURI.startsWith(metadataPrefix)) throw new Error("Vault map tokenURI is not inline JSON.");
const mapTokenJSON = Buffer.from(mapTokenURI.slice(metadataPrefix.length), "base64").toString("utf8");
const mapMetadata = JSON.parse(mapTokenJSON) as { animation_url?: unknown; external_url?: unknown };
for (const forbidden of ["http://", "https://", "ipfs://", "keel://"]) {
  if (mapTokenJSON.toLowerCase().includes(forbidden)) {
    throw new Error(`Vault map token JSON contains forbidden external route ${forbidden}`);
  }
}
if ("external_url" in mapMetadata || typeof mapMetadata.animation_url !== "string"
  || !mapMetadata.animation_url.startsWith("data:text/html;base64,")) {
  throw new Error("Vault map animation is not the exact inline on-chain HTML wrapper.");
}
const mapAnimationBytes = Buffer.from(mapMetadata.animation_url.slice("data:text/html;base64,".length), "base64");
const mapBuilderHTML = await readContractAtBlockHash(
  onchainHTMLBuilder.address,
  onchainHTMLBuilder.abi,
  "harnessHTML",
  [mapWrapperContent.objectId, mapWrapperContent.digest],
  verificationSealMined.blockHash,
) as Hex;
if (bytesToHex(mapAnimationBytes) !== mapBuilderHTML) {
  throw new Error("Vault map animation HTML does not match the on-chain viewer builder digest.");
}
const mapAnimationHTMLDigest = sha256(mapAnimationBytes);
const rawMapViewerPath = path.join(demoRoot, "map-1-onchain.html");
await writeFile(rawMapViewerPath, mapAnimationBytes);

const deploymentBlock = async (key: string): Promise<string> => {
  const contract = checkpoint.contracts[key];
  if (contract === undefined) throw new Error(`Studio registration is missing deployment ${key}.`);
  const receipt = await publicClient.getTransactionReceipt({ hash: contract.transactionHash });
  if (receipt.status !== "success") throw new Error(`Studio registration deployment ${key} is not canonical.`);
  return receipt.blockNumber.toString();
};
const studioRegistration: VaultStudioRegistrationOutput = {
  schema: "vault-studio-registration@1",
  chain: { chainId, name: "Ethereum Sepolia", rpcUrl, confirmations: 2, enabled: true },
  contracts: [
    { kind: "artifact-registry", address: oldDeployment.contracts.keelIndex.toLowerCase(), label: "Vault Sepolia Artifact Registry", startBlock: "0", enabled: true },
    { kind: "vault-character-registry", address: characterRegistry.address.toLowerCase(), label: "Vault Character Registry", startBlock: await deploymentBlock("characterRegistry"), enabled: true },
    { kind: "vault-arcade-registry", address: arcade.address.toLowerCase(), label: "Vault Arcade Registry", startBlock: await deploymentBlock("arcadeRegistry"), enabled: true },
    { kind: "keel-crucible-registry", address: collectionVerificationRegistry.address.toLowerCase(), label: "Keel Collection Verification Registry", startBlock: await deploymentBlock("collectionVerificationRegistry"), enabled: true },
  ],
  seedHandoff: {
    collection: collection.address.toLowerCase(),
    mapCollection: mapCollection.address.toLowerCase(),
    mapId: VAULT_SEPOLIA_MAP_ID,
    viewerId: characterViewerId,
    seedRegistry: seedRegistry.address.toLowerCase(),
    seedSetId: characterSeedSetId,
    mintProfileRevision: "1",
    catalogRevision: "1",
    assetFamilyId: weaponFamilyId,
    assetFamilyRevision: "1",
    tokenIds: characters.map(({ tokenId }) => tokenId),
  },
  routeTemplates: {
    preview: "/preview/{chainId}/{collection}/{tokenId}",
    collect: "/collect/{chainId}/{collection}/{tokenId}",
    publicBasePlaceholder: "{STUDIO_PUBLIC_BASE_URL}",
  },
};
assertVaultStudioRegistration(studioRegistration, VAULT_SEPOLIA_CHARACTER_MINT_COUNT);

const output = {
  schema: "vault-mint-stake-demo@4", network: "Ethereum Sepolia", chainId, rpcUrl, explorerUrl: "https://sepolia.etherscan.io", owner: account.address,
  mintCount: VAULT_SEPOLIA_CHARACTER_MINT_COUNT,
  pinnedReadBlock: { number: verificationSealMined.blockNumber.toString(), hash: verificationSealMined.blockHash },
  mapId: "1", mapSeed: "vault-map-001", mapViewerId, mapManifestDigest, mapManifestUri,
  mapTokenURI,
  mapAnimationHTMLDigest,
  rawMapViewerPath: path.relative(repositoryRoot, rawMapViewerPath),
  portable: {
    collection: { ...collectionPortableGraph, anchorRoot: collectionPortableAnchorRoot },
    weapons: { ...weaponPortableGraph, anchorRoot: weaponPortableAnchorRoot },
    map: { ...mapPortableGraph, anchorRoot: mapPortableAnchorRoot },
  },
  contracts: {
    ...oldDeployment.contracts,
    ...Object.fromEntries(Object.entries(checkpoint.contracts).map(([key, value]) => [key, value.address])),
  },
  viewerContentObjectId: viewerContent.objectId,
  onchainHTMLBuilder: onchainHTMLBuilder.address,
  vaultVerificationPolicyId,
  vaultVerification,
  studioRegistration,
  characters,
  transactions: Object.fromEntries(Object.entries(checkpoint.transactions).map(([key, value]) => [key, value.hash])),
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ collection: collection.address, arcade: arcade.address, harnessRegistry: harnessRegistry.address, seedRegistry: seedRegistry.address, collectionVerificationRegistry: collectionVerificationRegistry.address, characters: characters.length, viewerBytes: viewerBytes.length }, null, 2));
