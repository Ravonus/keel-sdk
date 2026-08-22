import { loadSpriteCodex } from "./sprite-codex/loader.js";
import {
  PortableResourceKind,
  decodePortableAnchorV1,
  decodePortableGraphV1,
  decodePortableManifestV1,
  portableAnchorRootV1,
  portableRootV1,
  verifyPortableContentV1,
} from "./protocol/portable.js";

function terminalVerificationFailure(value) {
  const message = value instanceof Error ? value.message : String(value || "unknown verification failure");
  document.body.className = "verification-failed";
  document.body.replaceChildren();
  const warning = document.createElement("main");
  warning.setAttribute("role", "alert");
  warning.innerHTML = "<strong>KEEL VERIFICATION FAILED</strong><span></span>";
  warning.querySelector("span").textContent = message;
  document.body.append(warning);
}
window.addEventListener("error", (event) => terminalVerificationFailure(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => terminalVerificationFailure(event.reason));

const moduleBytes = globalThis.__KEEL_FETCH_MODULE__;
const defaults = globalThis.__VAULT_TOKEN_ARGS__
  ?? await fetch("./token-args.json").then((response) => response.json());
const packagedGraph = globalThis.__VAULT_GRAPH__
  ?? JSON.parse(new TextDecoder().decode(moduleBytes
    ? await moduleBytes("assets/vault-graph-v1.json")
    : new Uint8Array(await fetch("./assets/vault-graph-v1.json").then((response) => response.arrayBuffer()))));
const query = new URLSearchParams(location.search);
const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
if (defaults.contextMode === "onchain-token" && (query.size || fragment.size)) {
  throw new Error("on-chain token context does not accept URL overrides");
}
const arg = (name) => defaults[name];
function pinnedArg(name) {
  return String(defaults[name] || "");
}
const rpc = pinnedArg("rpc").replace(/\/$/, "");
const character = pinnedArg("character");
const content = pinnedArg("content");
const arcade = pinnedArg("arcade");
const verificationHook = pinnedArg("verificationHook");
const verificationRegistry = pinnedArg("verificationRegistry");
const collectionCodeSha256 = pinnedArg("collectionCodeSha256");
const verificationCodeSha256 = pinnedArg("verificationCodeSha256");
const verificationRegistryCodeSha256 = pinnedArg("verificationRegistryCodeSha256");
const allowedTokenIds = Array.isArray(defaults.tokenIds) ? defaults.tokenIds.map(String) : [String(defaults.tokenId || "preview")];
const tokenId = String(defaults.tokenId || "preview");
if (!allowedTokenIds.includes(tokenId)) throw new Error("tokenId is not allowed by the on-chain token context");
const mapId = pinnedArg("mapId");
const contextMode = String(defaults.contextMode || "preview");
const expectedChainId = String(defaults.chainId || "");
const expectedNetworkHex = String(defaults.sourceNetwork || "").toLowerCase().replace(/^0x/, "");
const blockPolicy = String(defaults.blockPolicy || "exact");
const transportAuthority = String(defaults.transportAuthority || "unknown transport");
const rpcProofClass = String(defaults.proofClass || "unverified-rpc");
const marketplaceCompatibility = String(defaults.marketplaceCompatibility || "unknown marketplace compatibility");
let pinnedBlockHash = String(defaults.blockHash || "");
let pinnedBlockLevel = Number(defaults.blockLevel ?? -1);
const textDecoder = new TextDecoder();
const normalizeRoot = (root) => String(root).toLowerCase().replace(/^0x/, "");
const hexBytes = (hex) => Uint8Array.from(BufferlessHex(normalizeRoot(hex)));
function BufferlessHex(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("invalid hex bytes");
  return Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}
const bytesText = (hex) => textDecoder.decode(hexBytes(hex));

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Bytes(value) {
  if (typeof value !== "string" || !value) throw new Error("invalid Base58 value");
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new Error("invalid Base58 character");
    number = number * 58n + BigInt(digit);
  }
  const output = [];
  while (number > 0n) { output.push(Number(number & 0xffn)); number >>= 8n; }
  output.reverse();
  let zeros = 0; while (value[zeros] === "1") zeros += 1;
  return new Uint8Array([...new Array(zeros).fill(0), ...output]);
}
async function sha256(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", value)); }
async function base58Payload(value, prefix, length, label) {
  const decoded = base58Bytes(value);
  if (decoded.byteLength !== prefix.length + length + 4 || prefix.some((byte, index) => decoded[index] !== byte)) {
    throw new Error(`${label} has invalid Base58Check identity`);
  }
  const body = decoded.slice(0, -4);
  const checksum = (await sha256(await sha256(body))).slice(0, 4);
  if (checksum.some((byte, index) => decoded[body.byteLength + index] !== byte)) throw new Error(`${label} has invalid Base58Check checksum`);
  return decoded.slice(prefix.length, prefix.length + length);
}
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const concat = (...values) => {
  const size = values.reduce((sum, value) => sum + value.byteLength, 0), result = new Uint8Array(size);
  let offset = 0; for (const value of values) { result.set(value, offset); offset += value.byteLength; } return result;
};

let chainId = "";
async function verifyRpcContext() {
  if (!rpc) throw new Error("missing pinned RPC context");
  const [contentHash] = await Promise.all([
    base58Payload(content, [2, 90, 121], 20, "content contract"),
    base58Payload(character, [2, 90, 121], 20, "character contract"),
    base58Payload(arcade, [2, 90, 121], 20, "arcade contract"),
  ]);
  const chainResponse = await fetch(`${rpc}/chains/main/chain_id`);
  if (!chainResponse.ok) throw new Error(`chain id HTTP ${chainResponse.status}`);
  chainId = await chainResponse.json();
  if (chainId !== expectedChainId) throw new Error("RPC chain id does not match pinned token context");
  const network = await base58Payload(chainId, [87, 82, 0], 4, "chain id");
  if (hex(network) !== expectedNetworkHex) throw new Error("chain id/source-network mismatch");
  if (blockPolicy === "snapshot-head") {
    const snapshotResponse = await fetch(`${rpc}/chains/main/blocks/head/hash`);
    if (!snapshotResponse.ok) throw new Error(`snapshot head HTTP ${snapshotResponse.status}`);
    pinnedBlockHash = await snapshotResponse.json();
  } else if (blockPolicy !== "exact") throw new Error("unsupported token block policy");
  await base58Payload(pinnedBlockHash, [1, 52], 32, "block hash");
  const hashResponse = await fetch(`${rpc}/chains/main/blocks/${encodeURIComponent(pinnedBlockHash)}/hash`);
  if (!hashResponse.ok || await hashResponse.json() !== pinnedBlockHash) throw new Error("pinned block hash is unavailable");
  const headerResponse = await fetch(`${rpc}/chains/main/blocks/${encodeURIComponent(pinnedBlockHash)}/header`);
  if (!headerResponse.ok) throw new Error(`block header HTTP ${headerResponse.status}`);
  const header = await headerResponse.json();
  if (blockPolicy === "snapshot-head") pinnedBlockLevel = Number(header.level);
  else if (Number(header.level) !== pinnedBlockLevel) throw new Error("pinned block level mismatch");
  if (!Number.isInteger(pinnedBlockLevel) || pinnedBlockLevel < 0) throw new Error("invalid pinned block level");
  return { contentHash, network };
}
let verifiedRpcContext;

async function runView(contract, view, input) {
  if (!rpc || !contract) throw new Error(`missing RPC context for ${view}`);
  const response = await fetch(`${rpc}/chains/main/blocks/${encodeURIComponent(pinnedBlockHash)}/helpers/scripts/run_script_view`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract, view, input, chain_id: chainId, unlimited_gas: true, unparsing_mode: "Optimized" }),
  });
  if (!response.ok) throw new Error(`${view} HTTP ${response.status}`);
  const result = await response.json();
  return result.data ?? result;
}

function flattenPairs(node, output = []) {
  if (node?.prim === "Pair" && Array.isArray(node.args)) for (const child of node.args) flattenPairs(child, output);
  else output.push(node);
  return output;
}
function atom(node) {
  if (node && typeof node === "object") {
    if ("bytes" in node) return node.bytes;
    if ("int" in node) return Number(node.int);
    if ("string" in node) return node.string;
    if (node.prim === "True") return true;
    if (node.prim === "False") return false;
  }
  return node;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function contractCodeSha256(contract) {
  const response = await fetch(`${rpc}/chains/main/blocks/${encodeURIComponent(pinnedBlockHash)}/context/contracts/${contract}/script`);
  if (!response.ok) throw new Error(`contract script HTTP ${response.status}`);
  const script = await response.json();
  return hex(await sha256(new TextEncoder().encode(canonicalJson(script.code ?? script))));
}
function optionAddress(node) {
  if (node?.prim === "None") return null;
  if (node?.prim === "Some" && node.args?.[0]?.string) return node.args[0].string;
  throw new Error("invalid authority option");
}
function optionValue(node) {
  if (node?.prim === "None") return "not verifiable";
  if (node?.prim === "Some") return String(atom(node.args?.[0]));
  throw new Error("invalid optional facet");
}
async function verifyPresentationAdapter() {
  if (!verificationHook || !verificationRegistry) return {
    level:"conditional",
    text:`Verification not enabled for contract controls · content observed through ${transportAuthority} · no official hook or approved adapter · no verifier receipt claimed`,
    facets:[
      ["Keel route", "unknown", "Verification not enabled — no approved hook or adapter", "unknown", "unverified"],
      ["Active presentation", "amber", `Recipe r${recipe.catalogRevision} and portable roots match packaged bytes through ${transportAuthority}`, "none", rpcProofClass],
      ["Revision policy", "unknown", "Not verifiable — governance interface is not approved", "unknown", "unverified"],
      ["Minting", "unknown", "Not verifiable — mint controls are not approved", "unknown", "unverified"],
      ["Supply", "unknown", "Not verifiable — counters and cap controls are not approved", "unknown", "unverified"],
      ["Upgrades", "unknown", "Not verifiable — runtime and admin controls are not approved", "unknown", "unverified"],
    ],
  };
  await base58Payload(verificationHook, [2, 90, 121], 20, "verification hook");
  await base58Payload(verificationRegistry, [2, 90, 121], 20, "verification registry");
  if (!/^[0-9a-f]{64}$/.test(collectionCodeSha256) || !/^[0-9a-f]{64}$/.test(verificationCodeSha256)
    || !/^[0-9a-f]{64}$/.test(verificationRegistryCodeSha256)) throw new Error("approved template identity is missing");
  const [actualCollectionCode, actualHookCode, actualRegistryCode] = await Promise.all([
    contractCodeSha256(character), contractCodeSha256(verificationHook), contractCodeSha256(verificationRegistry),
  ]);
  if (actualCollectionCode !== collectionCodeSha256 || actualHookCode !== verificationCodeSha256
    || actualRegistryCode !== verificationRegistryCodeSha256) throw new Error("presentation adapter code identity mismatch");
  const bindingValues = flattenPairs(await runView(verificationHook, "get_binding", { prim:"Unit" })).map(atom);
  if (bindingValues.length !== 5) throw new Error(`hook binding field count ${bindingValues.length}`);
  const [boundCollection, boundCollectionCode, boundContent, boundPolicyDigest, boundProtocol] = bindingValues;
  if (boundCollection !== character || boundContent !== content || normalizeRoot(boundCollectionCode) !== collectionCodeSha256)
    throw new Error("approved hook is bound to a decoy collection or content registry");
  const approvalValues = flattenPairs(await runView(verificationRegistry, "get_approval", { string:verificationHook })).map(atom);
  if (approvalValues.length !== 8) throw new Error(`hook approval field count ${approvalValues.length}`);
  const [approvedLevel, approvedCollection, approvedCollectionCode, approvedContent, approvedHook,
    approvedHookCode, approvedPolicyDigest, approvedProtocol] = approvalValues;
  if (approvedLevel > pinnedBlockLevel || approvedCollection !== character || approvedContent !== content
    || approvedHook !== verificationHook || normalizeRoot(approvedCollectionCode) !== collectionCodeSha256
    || normalizeRoot(approvedHookCode) !== verificationCodeSha256
    || normalizeRoot(approvedPolicyDigest) !== normalizeRoot(boundPolicyDigest)
    || normalizeRoot(approvedProtocol) !== normalizeRoot(boundProtocol)) throw new Error("official hook approval does not bind displayed token context");
  const policyValues = flattenPairs(await runView(verificationHook, "get_policy", { prim:"Unit" }));
  if (policyValues.length !== 28) throw new Error(`presentation policy field count ${policyValues.length}`);
  const [adapterDigest, adminAuthorityNode, adminEntrypoint, mintAuthorityNode, mintEntrypoint,
    mintPolicyAuthorityNode, mintPolicyEntrypoint, mintRolesRoot, mintState,
    revisionAuthorityNode, revisionEntrypoint, revisionPolicy,
    routeEntrypoint, routeLocked, routeRegistry, supplyAuthorityNode, supplyBurnableNode,
    supplyBurnedNode, supplyCapNode, supplyCapKind, supplyCapMutableNode, supplyEntrypoint,
    supplyLifetimeMintedNode, supplyOutstandingNode, supplyRemainingNode, supplyReservedNode,
    upgradeAuthorityNode, upgradeEntrypoint] = policyValues.map(atom);
  if (routeLocked !== true || routeRegistry !== content || bytesText(routeEntrypoint) !== "get_descriptor") throw new Error("Keel presentation route is not locked");
  const receiptValues = flattenPairs(await runView(verificationHook, "get_receipt", { int:tokenId })).map(atom);
  const liveReceiptValues = flattenPairs(await runView(verificationHook, "get_live_receipt", { int:tokenId })).map(atom);
  if (receiptValues.length !== 7) throw new Error(`presentation receipt field count ${receiptValues.length}`);
  if (liveReceiptValues.length !== 7 || JSON.stringify(liveReceiptValues) !== JSON.stringify(receiptValues)) throw new Error("stored presentation receipt differs from live Character state");
  const [catalogRevision, catalogRoot, metadataPointer, metadataRoot, recipeDigest, receiptTokenId, viewerRoot] = receiptValues;
  const liveArtifactUri = atom(await runView(character, "get_artifact_uri", { int:tokenId }));
  if (receiptTokenId !== Number(tokenId) || catalogRevision !== recipe.catalogRevision
    || normalizeRoot(catalogRoot) !== normalizeRoot(recipe.catalogRoot)
    || normalizeRoot(metadataRoot) !== normalizeRoot(recipe.metadataRoot)
    || normalizeRoot(viewerRoot) !== normalizeRoot(recipe.viewerRoot)
    || normalizeRoot(metadataPointer) !== normalizeRoot(liveArtifactUri)
    || normalizeRoot(recipeDigest).length !== 64) throw new Error("presentation receipt/recipe/metadata mismatch");
  const revisionAuthority = optionAddress(revisionAuthorityNode);
  const adminAuthority = optionAddress(adminAuthorityNode);
  const mintAuthority = optionAddress(mintAuthorityNode);
  const mintPolicyAuthority = optionAddress(mintPolicyAuthorityNode);
  const supplyAuthority = optionAddress(supplyAuthorityNode);
  const upgradeAuthority = optionAddress(upgradeAuthorityNode);
  const supplyFacts = [
    ["outstanding", supplyOutstandingNode], ["lifetime", supplyLifetimeMintedNode],
    ["burned", supplyBurnedNode], ["reserved", supplyReservedNode],
    ["remaining", supplyRemainingNode], ["cap", supplyCapNode], ["burnable", supplyBurnableNode],
  ];
  const unknownSupply = supplyFacts.filter(([, node]) => node?.prim === "None").map(([name]) => name);
  const knownSupply = supplyFacts.filter(([, node]) => node?.prim === "Some").map(([name, node]) => `${name}=${optionValue(node)}`);
  const supplyStatus = unknownSupply.length ? "unknown" : "amber";
  const supplyDetail = `${knownSupply.length ? `Known ${knownSupply.join(", ")}. ` : ""}Not verifiable ${unknownSupply.join(", ") || "none"}; cap kind ${bytesText(supplyCapKind)}; cap mutable ${optionValue(supplyCapMutableNode)}`;
  return {
    level:"conditional",
    text:`Overall conditional · trusted RPC observation at block ${pinnedBlockLevel} via ${transportAuthority} · marketplace ${marketplaceCompatibility} · Keel route observed locked: ${content}::get_descriptor · revisions: ${bytesText(revisionPolicy)} by ${revisionAuthority ?? "none"}::${bytesText(revisionEntrypoint)} · mint observed: state=${bytesText(mintState)} roles=${normalizeRoot(mintRolesRoot).slice(0, 8)} executor=${mintAuthority ?? "public"}::${bytesText(mintEntrypoint)} · supply ${supplyStatus}: ${supplyDetail} · upgrade ${upgradeAuthority ?? "none"}::${bytesText(upgradeEntrypoint) || "none"} · admin ${adminAuthority ?? "none"}::${bytesText(adminEntrypoint) || "none"}`,
    facets:[
      ["Keel route", "amber", `Official registry/hook binding observed at the pinned block for ${character} and ${content}::get_descriptor`, "immutable", rpcProofClass],
      ["Active presentation", "amber", `Catalog r${catalogRevision}; stored/live recipe digest, metadata pointer, current roots, and packaged bytes match`, "none", rpcProofClass],
      ["Revision policy", "amber", bytesText(revisionPolicy), `${revisionAuthority ?? "none"}::${bytesText(revisionEntrypoint) || "none"}`, rpcProofClass],
      ["Minting", "amber", `State ${bytesText(mintState)}; roles ${normalizeRoot(mintRolesRoot)}`, `${mintPolicyAuthority ?? "immutable"}::${bytesText(mintPolicyEntrypoint) || "none"}; executor ${mintAuthority ?? "public"}::${bytesText(mintEntrypoint)}`, rpcProofClass],
      ["Supply", supplyStatus, supplyDetail, `${supplyAuthority ?? "immutable"}::${bytesText(supplyEntrypoint) || "none"}`, unknownSupply.length ? "partially-observed" : rpcProofClass],
      ["Upgrades", "amber", `Upgrade ${upgradeAuthority ? "mutable" : "immutable"}; collection admin ${adminAuthority ?? "none"}`, `${upgradeAuthority ?? "none"}::${bytesText(upgradeEntrypoint) || "none"}; admin ${adminAuthority ?? "none"}::${bytesText(adminEntrypoint) || "none"}`, rpcProofClass],
    ],
    adapterDigest, metadataPointer, recipeDigest, boundPolicyDigest, boundProtocol, approvedLevel,
  };
}
function decodeRecipeFromValues(values) {
  const [accessibilityFlags, catalogRevision, catalogRoot, fxRoot, metadataRoot,
    packedAttributes, sceneId, seed, soundRoot, spriteRoot, targetRoot, viewerRoot] = values;
  return { accessibilityFlags, catalogRevision, catalogRoot, fxRoot, metadataRoot,
    packedAttributes, sceneId, seed, soundRoot, spriteRoot, targetRoot, viewerRoot };
}
function decodeRecipe(data) {
  const values = flattenPairs(data).map(atom);
  if (values.length !== 12) throw new Error(`recipe field count ${values.length}`);
  return decodeRecipeFromValues(values);
}
function decodeRuntime(data) {
  const values = flattenPairs(data).map(atom);
  if (values.length !== 16) throw new Error(`runtime field count ${values.length}`);
  const [buildRevision, buildRoot, characterId, resolvedMapId, ...recipe] = values;
  return { buildRevision, buildRoot, characterId, mapId: resolvedMapId, recipe: decodeRecipeFromValues(recipe) };
}

function decodeDescriptor(data) {
  const values = flattenPairs(data).map(atom);
  if (values.length !== 9) throw new Error(`descriptor field count ${values.length}`);
  const [compression, decodedByteLength, decodedSha256, descriptorBytes, frozen,
    locator, mediaType, resourceKind, revision] = values;
  return { compression, decodedByteLength, decodedSha256, descriptorBytes, frozen,
    locator: bytesText(locator), locatorBytes: hexBytes(locator), mediaType: bytesText(mediaType), resourceKind, revision };
}

let recipe;
let runtime;
let source = "preview";
if (rpc && character && content && tokenId !== "preview") {
  verifiedRpcContext = await verifyRpcContext();
  recipe = decodeRecipe(await runView(character, "get_recipe", { int: tokenId }));
  source = contextMode;
  if (arcade && mapId !== "") {
    runtime = decodeRuntime(await runView(arcade, "map_character_runtime", {
      prim: "Pair", args: [{ int: mapId }, { int: tokenId }],
    }));
    recipe = runtime.recipe;
  }
}
if (!recipe) {
  recipe = {
    catalogRevision: Number(arg("catalogRevision") || 1), catalogRoot: packagedGraph.roots.catalog.slice(2),
    spriteRoot: packagedGraph.roots.sprite.slice(2), targetRoot: packagedGraph.roots.target.slice(2),
    fxRoot: packagedGraph.roots.fx.slice(2), soundRoot: packagedGraph.roots.sound.slice(2),
    packedAttributes: normalizeRoot(arg("seed") || defaults.seed), seed: normalizeRoot(arg("seed") || defaults.seed),
    sceneId: Array.from(new TextEncoder().encode("vault-arcade"), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
const presentation = source === "preview"
  ? { level:"conditional", text:"Overall conditional · packaged client-proof preview · native control facets Not verifiable",
      facets:[
        ["Keel route", "unknown", "Not verifiable without pinned chain context", "unknown", "unverified"],
        ["Active presentation", "green", "Packaged portable graph bytes verified", "none", "client-proof"],
        ["Revision policy", "unknown", "Not verifiable without pinned chain context", "unknown", "unverified"],
        ["Minting", "unknown", "Not verifiable without pinned chain context", "unknown", "unverified"],
        ["Supply", "unknown", "Not verifiable without pinned chain context", "unknown", "unverified"],
        ["Upgrades", "unknown", "Not verifiable without pinned chain context", "unknown", "unverified"],
      ] }
  : await verifyPresentationAdapter();

function mountProofDrawer(result) {
  const seal = document.querySelector("#proof-seal"), drawer = document.querySelector("#proof-drawer");
  const close = document.querySelector("#proof-close"), backdrop = document.querySelector("#proof-backdrop");
  const facets = document.querySelector("#proof-facets"), summary = document.querySelector("#proof-summary");
  document.documentElement.dataset.verificationChrome = "embedded";
  document.documentElement.dataset.verificationAggregate = result.level;
  summary.textContent = result.level === "verified" ? "All six facets verified" : "Conditional — inspect each independent facet";
  facets.replaceChildren();
  const evidence = result.adapterDigest ? normalizeRoot(result.adapterDigest) : "not available";
  const hookVersion = verificationCodeSha256 || "not approved";
  for (const [name, status, detail, authority, proofClass] of result.facets || []) {
    const row = document.createElement("section"); row.className = "proof-facet"; row.dataset.status = status;
    const heading = document.createElement("h3"); heading.textContent = `${status.toUpperCase()} · ${name}`;
    const state = document.createElement("p"); state.textContent = detail;
    const context = document.createElement("p");
    context.textContent = `Chain ${expectedChainId || "not pinned"} · block ${pinnedBlockLevel >= 0 ? pinnedBlockLevel : "not pinned"} ${pinnedBlockHash || ""} · proof class ${proofClass} · hook ${hookVersion} · evidence ${evidence} · authority ${authority}`;
    row.append(heading, state, context); facets.append(row);
  }
  const setOpen = (open) => {
    document.body.classList.toggle("proof-open", open); seal.setAttribute("aria-expanded", String(open)); drawer.setAttribute("aria-hidden", String(!open));
  };
  seal.addEventListener("click", () => setOpen(true)); close.addEventListener("click", () => setOpen(false)); backdrop.addEventListener("click", () => setOpen(false));
  addEventListener("keydown", (event) => { if (event.key === "Escape") setOpen(false); });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.protocol !== "keel-viewer-verification@1") return;
    if (event.data.action === "open") setOpen(true);
    else if (event.data.action === "close") setOpen(false);
    else if (event.data.action === "set-chrome" && (event.data.chrome === "external" || event.data.chrome === "embedded")) document.documentElement.dataset.verificationChrome = event.data.chrome;
  });
}
mountProofDrawer(presentation);

const fixtureObjects = new Map(packagedGraph.objects.map((entry) => [normalizeRoot(entry.portableRoot), entry]));
const objectCache = new Map();
const MAX_OBJECTS = 64;
const MAX_DEPTH = 8;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
let totalDecodedBytes = 0;
async function loadObject(root) {
  root = normalizeRoot(root);
  if (objectCache.has(root)) return objectCache.get(root);
  if (objectCache.size >= MAX_OBJECTS) throw new Error("portable graph object limit exceeded");
  const fixture = fixtureObjects.get(root);
  if (!fixture) throw new Error(`portable root ${root} is not packaged`);
  let manifestBytes;
  let descriptor;
  let graphBytes;
  if (source !== "preview") {
    descriptor = decodeDescriptor(await runView(content, "get_descriptor", { bytes: root }));
    manifestBytes = hexBytes(descriptor.descriptorBytes);
    if (normalizeRoot(await portableRootV1(manifestBytes)) !== root) throw new Error("on-chain manifest/root mismatch");
    if (normalizeRoot(descriptor.descriptorBytes) !== normalizeRoot(fixture.manifestBytesHex)) throw new Error("packaged/on-chain manifest substitution");
    const anchorBytes = hexBytes(atom(await runView(content, "get_anchor_for_object", { bytes: root })));
    const anchor = decodePortableAnchorV1(anchorBytes);
    await portableAnchorRootV1(anchor);
    const expectedNetwork = Number.parseInt(expectedNetworkHex, 16);
    const registryPack = concat(hexBytes("050a0000001601"), verifiedRpcContext.contentHash, hexBytes("00"));
    const expectedRegistry = hex(await sha256(registryPack));
    const revisionBytes = hexBytes(descriptor.revision);
    const expectedEvent = hex(await sha256(concat(
      new TextEncoder().encode("keel.tezos-source-event.v1"),
      hexBytes(root), manifestBytes, descriptor.locatorBytes, revisionBytes,
    )));
    if (anchor.sourceFamily !== 2 || anchor.sourceNetwork !== expectedNetwork || normalizeRoot(anchor.portableRoot) !== root
      || normalizeRoot(anchor.sourceRegistry) !== expectedRegistry || normalizeRoot(anchor.sourceObjectKey) !== root
      || anchor.sourceRevision !== BigInt(`0x${normalizeRoot(descriptor.revision)}`)
      || normalizeRoot(anchor.sourceEventDigest) !== expectedEvent) {
      throw new Error("non-native or misbound Tezos anchor");
    }
  } else {
    manifestBytes = hexBytes(fixture.manifestBytesHex);
    descriptor = { locator: fixture.locator, descriptorBytes: fixture.manifestBytesHex, frozen: true };
  }
  const manifest = decodePortableManifestV1(manifestBytes);
  if (!descriptor.frozen || !manifest.frozen) throw new Error("inactive portable object");
  if (manifest.resourceKind === PortableResourceKind.Graph) {
    if (source !== "preview") {
      graphBytes = hexBytes(atom(await runView(content, "get_graph", { bytes: root })));
    } else {
      graphBytes = hexBytes(fixture.decodedHex);
    }
    await verifyPortableContentV1(manifest, graphBytes);
    const graph = decodePortableGraphV1(graphBytes);
    const loaded = { root, fixture, manifest, descriptor, decoded: graphBytes, graph };
    objectCache.set(root, loaded); totalDecodedBytes += graphBytes.byteLength; return loaded;
  }
  if (!descriptor.locator.startsWith("asset://")) throw new Error("unsupported decoded-source locator");
  const assetPath = `assets/${descriptor.locator.slice(8)}`;
  let decoded;
  if (moduleBytes) decoded = await moduleBytes(assetPath);
  else {
    const response = await fetch(`./assets/${encodeURIComponent(descriptor.locator.slice(8))}`);
    if (!response.ok) throw new Error(`asset source HTTP ${response.status}`);
    decoded = new Uint8Array(await response.arrayBuffer());
  }
  await verifyPortableContentV1(manifest, decoded);
  totalDecodedBytes += decoded.byteLength;
  if (totalDecodedBytes > MAX_TOTAL_BYTES) throw new Error("portable graph byte limit exceeded");
  const loaded = { root, fixture, manifest, descriptor, decoded };
  objectCache.set(root, loaded); return loaded;
}
async function resolveTree(root, depth = 0, ancestors = new Set()) {
  root = normalizeRoot(root);
  if (depth > MAX_DEPTH) throw new Error("portable graph depth limit exceeded");
  if (ancestors.has(root)) throw new Error("portable graph cycle");
  const object = await loadObject(root);
  if (object.graph) {
    const next = new Set(ancestors); next.add(root);
    for (const entry of object.graph.entries) await resolveTree(entry.portableRoot, depth + 1, next);
  }
  return object;
}
async function graphChild(root, path) {
  const object = await loadObject(root);
  if (!object.graph) throw new Error(`${root} is not a graph`);
  const entry = object.graph.entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`graph path ${path} is missing`);
  return loadObject(entry.portableRoot);
}

for (const root of [recipe.catalogRoot, recipe.spriteRoot, recipe.targetRoot, recipe.fxRoot, recipe.soundRoot]) await resolveTree(root);
if (runtime) await resolveTree(runtime.buildRoot);

const loadout = await loadObject(recipe.spriteRoot);
const characterGraphRoot = loadout.graph.entries.find((entry) => entry.path === "loadout/character.graph")?.portableRoot;
const weaponGraphRoot = loadout.graph.entries.find((entry) => entry.path === "loadout/weapon.graph")?.portableRoot;
if (!characterGraphRoot || !weaponGraphRoot) throw new Error("loadout graph is incomplete");
const orbBuildObject = await graphChild(characterGraphRoot, "character/build.json");
const weaponBuildObject = await graphChild(weaponGraphRoot, "weapon/build.json");
const orbBuild = JSON.parse(textDecoder.decode(orbBuildObject.decoded));
const weaponBuild = JSON.parse(textDecoder.decode(weaponBuildObject.decoded));
async function verifiedAssetUrl(name, mime) {
  if (!moduleBytes) return `./assets/${name}`;
  return URL.createObjectURL(new Blob([await moduleBytes(`assets/${name}`)], { type:mime }));
}
const orbCodex = await loadSpriteCodex({
  codexUrl: await verifiedAssetUrl(orbBuild.codex.file, "application/octet-stream"), atlasUrl: await verifiedAssetUrl(orbBuild.atlas.file, "image/webp"),
  codexSha256: orbBuild.codex.sha256, atlasSha256: orbBuild.atlas.sha256,
});
const weaponCodex = await loadSpriteCodex({
  codexUrl: await verifiedAssetUrl(weaponBuild.codex.file, "application/octet-stream"), atlasUrl: await verifiedAssetUrl(weaponBuild.atlas.file, "image/webp"),
  codexSha256: weaponBuild.codex.sha256, atlasSha256: weaponBuild.atlas.sha256,
});

const attr = hexBytes(recipe.packedAttributes || recipe.seed);
const corePalette = ["#8be9fd", "#bd93f9", "#ff79c6", "#50fa7b"];
const shellPalette = ["#dce7f7", "#ffd866", "#a6e3a1", "#f5c2e7"];
const coreColor = corePalette[(attr[0] ?? 0) % corePalette.length];
const shellColor = shellPalette[(attr[1] ?? 0) % shellPalette.length];
document.documentElement.style.setProperty("--particle", coreColor);

function tintLayer(codex, asset, color, target, frame = 0) {
  const temp = document.createElement("canvas"); temp.width = target.width; temp.height = target.height;
  const context = temp.getContext("2d");
  codex.draw(context, { asset, frame, dx:0, dy:0, displayWidth:target.width, displayHeight:target.height });
  context.globalCompositeOperation = "source-in"; context.fillStyle = color; context.fillRect(0, 0, target.width, target.height);
  target.getContext("2d").drawImage(temp, 0, 0);
}
const orbCanvas = document.querySelector("#orb");
const orbContext = orbCanvas.getContext("2d"); orbContext.clearRect(0, 0, orbCanvas.width, orbCanvas.height);
orbCodex.draw(orbContext, { asset:"orb-body", frame:0, dx:0, dy:0, displayWidth:240, displayHeight:240 });
tintLayer(orbCodex, "orb-material", coreColor, orbCanvas);
tintLayer(orbCodex, "orb-panel", shellColor, orbCanvas);

function semanticWeaponFrame(frame) {
  const native = document.createElement("canvas"); native.width = weaponCodex.metadata.frame.width; native.height = weaponCodex.metadata.frame.height;
  const context = native.getContext("2d");
  weaponCodex.draw(context, { asset:"rift", frame, dx:0, dy:0 });
  const pixels = context.getImageData(0, 0, native.width, native.height);
  const regions = weaponCodex.regionMask("rift", frame);
  const colors = { "core-light":coreColor, "core-hilt":"#354158", "front-hilt":"#78869c", "rear-hilt":"#47536a", prongs:shellColor };
  for (const [pixel, region] of regions) {
    if (region === "fixed" || !colors[region]) continue;
    const offset = pixel * 4; const value = (pixels.data[offset] + pixels.data[offset + 1] + pixels.data[offset + 2]) / (3 * 255);
    const rgb = BufferlessHex(colors[region].slice(1));
    pixels.data[offset] = Math.round(rgb[0] * value); pixels.data[offset + 1] = Math.round(rgb[1] * value); pixels.data[offset + 2] = Math.round(rgb[2] * value);
  }
  context.putImageData(pixels, 0, 0);
  const output = document.querySelector("#weapon").getContext("2d"); output.clearRect(0, 0, 340, 340); output.imageSmoothingEnabled = false; output.drawImage(native, 0, 0, 340, 340);
}

let frame = 0; let reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
semanticWeaponFrame(frame);
setInterval(() => { if (!reduced) { frame = (frame + 1) % weaponCodex.asset("rift").frames.length; semanticWeaponFrame(frame); } }, 1000 / 12);

if (runtime) {
  const mapBuildObject = await graphChild(runtime.buildRoot, "map/build.json");
  const mapBuild = JSON.parse(textDecoder.decode(mapBuildObject.decoded));
  const mapCodex = await loadSpriteCodex({
    codexUrl:await verifiedAssetUrl(mapBuild.codex.file, "application/octet-stream"), atlasUrl:await verifiedAssetUrl(mapBuild.atlas.file, "image/webp"),
    codexSha256:mapBuild.codex.sha256, atlasSha256:mapBuild.atlas.sha256,
  });
  const mapCanvas = document.querySelector("#map"); const mapContext = mapCanvas.getContext("2d"); mapContext.imageSmoothingEnabled = false;
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) mapCodex.draw(mapContext, { asset:"forge-floor", frame:(x + y) % mapCodex.asset("forge-floor").frames.length, dx:x * 180, dy:y * 180, displayWidth:180, displayHeight:180 });
  for (let x = 0; x < 4; x += 1) mapCodex.draw(mapContext, { asset:"forge-wall", frame:x % mapCodex.asset("forge-wall").frames.length, dx:x * 180, dy:0, displayWidth:180, displayHeight:180 });
}

const button = document.querySelector("#motion");
function setReduced(value) { reduced = value; document.body.classList.toggle("reduce-motion", value); button.setAttribute("aria-pressed", String(value)); }
setReduced(reduced); button.addEventListener("click", () => setReduced(!reduced));
document.querySelector("#chain-state").textContent = source === "octez-v25-mockup-replay"
  ? `Trusted RPC observation of Octez v25 mockup replay · block ${pinnedBlockLevel} ${pinnedBlockHash} · ${character} · token ${tokenId}`
  : (source.startsWith("shadownet") ? `Trusted RPC observation of Shadownet · block ${pinnedBlockLevel} ${pinnedBlockHash} · ${character} · token ${tokenId}` : "Client-verified local graph preview");
document.querySelector("#verification").dataset.level = presentation.level;
document.querySelector("#verification").textContent = presentation.text;
document.querySelector("#map-state").textContent = runtime
  ? `Staked map ${runtime.mapId} · pinned build r${runtime.buildRevision} · ${normalizeRoot(runtime.buildRoot).slice(0, 16)}…`
  : "No map escrow runtime loaded";
document.querySelector("#traits").textContent = `Orb core ${coreColor} · shell ${shellColor} · Rift Fork · semantic target mask · deterministic particles/sound`;
document.querySelector("#status").textContent = [
  `source=${source}`, `objects=${objectCache.size}`, `verifiedBytes=${totalDecodedBytes}`,
  `catalogRevision=${recipe.catalogRevision}`, `spriteRoot=${normalizeRoot(recipe.spriteRoot).slice(0, 12)}…`,
  `mapRoot=${runtime ? normalizeRoot(runtime.buildRoot).slice(0, 12) : "none"}…`,
].join(" · ");
