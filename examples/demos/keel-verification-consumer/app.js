const elements = {
  cases: document.querySelector("#cases"),
  viewer: document.querySelector("#viewer"),
  observed: document.querySelector("#observed"),
  expected: document.querySelector("#expected"),
  chain: document.querySelector("#chain"),
  chainProof: document.querySelector("#chain-proof"),
  title: document.querySelector("#title"),
  description: document.querySelector("#description"),
  receipt: document.querySelector("#receipt"),
  runAll: document.querySelector("#run-all"),
  runSummary: document.querySelector("#run-summary"),
  testVerdict: document.querySelector("#test-verdict"),
  repairToggle: document.querySelector("#repair-toggle"),
  liveControls: document.querySelector("#live-controls"),
  liveControlButtons: document.querySelector("#live-control-buttons"),
  gameControls: document.querySelector("#game-controls"),
  targetTokenId: document.querySelector("#target-token-id"),
  seedSource: document.querySelector("#seed-source"),
  seedEntropy: document.querySelector("#seed-entropy"),
  entropyLabel: document.querySelector("#entropy-label"),
  applyGameTarget: document.querySelector("#apply-game-target"),
};

const manifest = await fetch("./cases.json", { cache: "no-store" }).then((response) => {
  if (!response.ok) throw new Error(`cases.json returned ${response.status}`);
  return response.json();
});
if (manifest.schema !== "keel-verification-consumer-matrix@1") throw new Error("Unsupported consumer matrix.");

const FIXED_SEED = `0x${"5a".repeat(32)}`;
const FIXED_ATTRIBUTES = "0x0000000000000000000000000000000018171615141312110807060504030201";
let selected = manifest.cases[0];
let repaired = false;
let activeVariantId = null;
let activeRun = 0;
const buttons = new Map();
const chainProof = () => elements.chain.value === "evm" ? manifest.chainProof.evm : manifest.chainProof.tezos;
const variantFor = (item, variantId) => item.variants?.find((variant) => variant.id === variantId);
const expectedState = (item, useRepair, variantId) => variantId !== null || useRepair ? "verified" : item.expected;
const expectedAction = (item, useRepair, variantId) => expectedState(item, useRepair, variantId) === "verified" ? "VERIFY" : "REJECT";
const mutationFor = (item, useRepair, variantId) => variantFor(item, variantId)?.mutation ?? (useRepair ? item.repairMutation : item.mutation);
const modeFor = (useRepair, variantId) => variantId === null ? useRepair ? "repaired" : "original" : `variant:${variantId}`;

function updateSummary() {
  const completed = [...buttons.values()].filter((button) => button.dataset.result).length;
  const passed = [...buttons.values()].filter((button) => button.dataset.result === "pass").length;
  elements.runSummary.textContent = completed === manifest.cases.length
    ? `${passed} / ${manifest.cases.length} tests passed`
    : `${completed} / ${manifest.cases.length} run`;
}

function setVerdict(state, message) {
  elements.testVerdict.dataset.state = state;
  elements.testVerdict.querySelector("strong").textContent = message;
}

function updateRepairControl(item, useRepair, variantId, state = "idle") {
  const available = item.repairFile !== undefined && variantId === null;
  elements.repairToggle.hidden = !available;
  if (!available) return;
  elements.repairToggle.disabled = state === "running";
  elements.repairToggle.dataset.repaired = String(useRepair);
  elements.repairToggle.textContent = state === "running"
    ? "Rechecking same token…"
    : useRepair ? "Restore hostile input & recheck" : item.repairLabel ?? "Apply fix & recheck";
}

function updateLiveControls(item, variantId) {
  const variants = item.variants ?? [];
  elements.liveControls.hidden = variants.length === 0;
  elements.liveControlButtons.replaceChildren();
  if (variants.length === 0) return;
  for (const option of [{ id: null, label: "Minted state", authority: "base" }, ...variants]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.dataset.authority = option.authority;
    button.setAttribute("aria-pressed", String(option.id === variantId));
    button.addEventListener("click", () => { void runCase(item, false, option.id); });
    elements.liveControlButtons.append(button);
  }
}

function updateGameControls(item) {
  elements.gameControls.hidden = item.id !== "vault-game";
}

function validatedTokenId() {
  const value = elements.targetTokenId.value.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || value.length > 78 || BigInt(value) > (1n << 256n) - 1n) {
    throw new Error("Game token ID must be a canonical uint256 decimal value.");
  }
  return value;
}

function validatedEntropy() {
  const value = elements.seedEntropy.value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(value)) throw new Error("Seed source commitment must be canonical bytes32.");
  return value;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `0x${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function mintFixtureFor(chain, tokenId) {
  const id = BigInt(tokenId);
  const evm = chain === "evm";
  const blockNumber = (evm ? 19_840_000n : 4_571_000n) + id * 17n;
  const timestamp = 1_786_435_200n + id * 47n;
  const blockEntropy = await sha256Hex(`keel-consumer-block-entropy@1:${chain}:${blockNumber}:${timestamp}`);
  return {
    protocol: "keel-consumer-mint-receipt@1",
    chain,
    chainId: evm ? "11155111" : "NetXsqzbfFenSTS",
    collection: evm ? "0x69833c8d7621de03fb110a9450499b096854f8f4" : "KT1TkK2yvGcnqN8RoeVMn4DkJDDHD48S8KYZ",
    minter: evm ? "0x404a00000000000000000000000000000000b05" : "tz1g2BCUcuBQCtfriKB5ChBvYr6arDY324Np",
    recipient: evm ? "0x404a00000000000000000000000000000000b05" : "tz1g2BCUcuBQCtfriKB5ChBvYr6arDY324Np",
    tokenId,
    mintNonce: id.toString(),
    blockNumber: blockNumber.toString(),
    timestamp: timestamp.toString(),
    blockEntropy,
  };
}

async function runtimeContextFor(item) {
  if (item.id !== "vault-game") return { tokenId: "7", seed: FIXED_SEED, attributes: FIXED_ATTRIBUTES, seedSource: "fixed-fixture" };
  const tokenId = validatedTokenId();
  const seedSource = elements.seedSource.value;
  if (seedSource === "chainlink-vrf" && elements.chain.value !== "evm") throw new Error("Chainlink VRF is enabled only for the EVM lane in this harness.");
  if (seedSource === "commit-reveal" && elements.chain.value !== "tezos") throw new Error("Commit/reveal is enabled only for the Tezos lane in this harness.");
  const mintReceipt = await mintFixtureFor(elements.chain.value, tokenId);
  const mintCommitment = await sha256Hex(JSON.stringify(mintReceipt));
  const optionalEntropy = seedSource === "mint-derived" ? null : validatedEntropy();
  const mintRecord = JSON.stringify({
    protocol: "keel-consumer-mint-seed@1",
    mintReceipt,
    mintCommitment,
    seedSource,
    optionalEntropy,
    viewer: "vault-game-entry",
  });
  const seed = await sha256Hex(mintRecord);
  const attributes = await sha256Hex(`keel-packed-attributes@1:${seed}:${mintCommitment}`);
  const attributeBytes = Array.from({ length: 32 }, (_, index) => Number.parseInt(attributes.slice(2 + index * 2, 4 + index * 2), 16));
  const weaponIndex = attributeBytes[31] % 4;
  return {
    tokenId,
    seed,
    attributes,
    seedSource,
    mintCommitment,
    optionalEntropy,
    mintReceipt,
    weaponIndex,
    derivation: "sha256(domain + automatic mint receipt + optional committed entropy); all 32 packed trait bytes expand from a separate domain",
  };
}

function renderSelection(item, useRepair, variantId, runtimeContext) {
  selected = item;
  repaired = useRepair;
  activeVariantId = variantId;
  for (const [id, button] of buttons) button.setAttribute("aria-pressed", String(id === item.id));
  const variant = variantFor(item, variantId);
  elements.title.textContent = variant === undefined ? item.title : `${item.title} · ${variant.label}`;
  elements.description.textContent = variantId !== null
    ? `${item.description} VERIFIED CHANGE: ${variant.mutation}`
    : useRepair ? `${item.description} FIX APPLIED: ${item.repairMutation}` : item.description;
  elements.expected.textContent = expectedAction(item, useRepair, variantId);
  elements.observed.textContent = "RUNNING";
  setVerdict("running", variantId !== null ? "Checking the updated committed resource on the same token" : useRepair ? "Rechecking the corrected input on the same token" : expectedState(item, false, null) === "verified" ? "Valid input should verify" : "Hostile input should be rejected");
  elements.chainProof.textContent = chainProof().label;
  updateRepairControl(item, useRepair, variantId, "running");
  updateLiveControls(item, variantId);
  updateGameControls(item);
  elements.receipt.textContent = JSON.stringify({
    case: item.id,
    tokenId: runtimeContext.tokenId,
    mode: modeFor(useRepair, variantId),
    expected: expectedState(item, useRepair, variantId),
    mutation: mutationFor(item, useRepair, variantId),
    runtimeContext,
    chain: elements.chain.value,
    contractGate: chainProof(),
  }, null, 2);
}

async function observe(item, useRepair, variantId, runtimeContext, runId, timeoutMs = 20_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (runId !== activeRun) return false;
    const state = elements.viewer.contentDocument?.body?.dataset?.verification;
    if (state === "verified" || state === "failed") {
      const expected = expectedState(item, useRepair, variantId);
      const match = state === expected;
      elements.observed.textContent = state === "verified" ? "VERIFIED" : "REJECTED";
      const button = buttons.get(item.id);
      if (variantId !== null) button.dataset.variantResult = match ? "pass" : "fail";
      else if (useRepair) button.dataset.repairResult = match ? "pass" : "fail";
      else button.dataset.result = match ? "pass" : "fail";
      setVerdict(
        match ? "pass" : "fail",
        match
          ? variantId !== null ? "PASS — UPDATED RESOURCE VERIFIED" : useRepair ? "PASS — FIXED INPUT NOW VERIFIES" : state === "verified" ? "PASS — VALID INPUT VERIFIED" : "PASS — INVALID INPUT REJECTED"
          : `TEST FAILED — EXPECTED ${expectedAction(item, useRepair, variantId)}, OBSERVED ${state === "verified" ? "VERIFY" : "REJECT"}`,
      );
      elements.receipt.textContent = JSON.stringify({
        case: item.id,
        tokenId: runtimeContext.tokenId,
        mode: modeFor(useRepair, variantId),
        expected,
        observed: state,
        matched: match,
        mutation: mutationFor(item, useRepair, variantId),
        runtimeContext,
        chain: elements.chain.value,
        contractGate: chainProof(),
      }, null, 2);
      updateRepairControl(item, useRepair, variantId);
      updateSummary();
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (runId !== activeRun) return false;
  elements.observed.textContent = "TIMEOUT";
  const button = buttons.get(item.id);
  if (variantId !== null) button.dataset.variantResult = "fail";
  else if (useRepair) button.dataset.repairResult = "fail";
  else button.dataset.result = "fail";
  setVerdict("fail", "TEST FAILED — VERIFIER TIMED OUT");
  updateRepairControl(item, useRepair, variantId);
  updateSummary();
  return false;
}

async function runCase(item, useRepair = false, variantId = null) {
  const runId = ++activeRun;
  let runtimeContext;
  try {
    runtimeContext = await runtimeContextFor(item);
  } catch (error) {
    elements.observed.textContent = "INPUT ERROR";
    setVerdict("fail", error instanceof Error ? error.message : String(error));
    return false;
  }
  renderSelection(item, useRepair, variantId, runtimeContext);
  const variant = variantFor(item, variantId);
  const file = variant?.file ?? (useRepair ? item.repairFile : item.file);
  const loaded = new Promise((resolve) => elements.viewer.addEventListener("load", resolve, { once: true }));
  const params = new URLSearchParams({ tokenId: runtimeContext.tokenId, seed: runtimeContext.seed, attributes: runtimeContext.attributes, case: item.id, mode: modeFor(useRepair, variantId) });
  elements.viewer.src = `./viewers/${file}?${params}`;
  await loaded;
  return observe(item, useRepair, variantId, runtimeContext, runId);
}

function updateSeedControlAvailability() {
  const options = [...elements.seedSource.options];
  options.find((option) => option.value === "chainlink-vrf").disabled = elements.chain.value !== "evm";
  options.find((option) => option.value === "commit-reveal").disabled = elements.chain.value !== "tezos";
  if (elements.seedSource.selectedOptions[0]?.disabled) elements.seedSource.value = "mint-derived";
  elements.seedEntropy.disabled = elements.seedSource.value === "mint-derived";
  elements.entropyLabel.textContent = elements.seedSource.value === "chainlink-vrf"
    ? "Committed Chainlink VRF word · bytes32"
    : elements.seedSource.value === "commit-reveal"
      ? "Revealed mint secret · bytes32"
      : "Automatic contract mint receipt · no input";
}

for (const item of manifest.cases) {
  const button = document.createElement("button");
  button.className = "case";
  button.type = "button";
  button.innerHTML = `<small>${item.group} · ${item.expected === "verified" ? "valid input" : "hostile input"}</small><strong>${item.title}</strong><em>${item.expected === "verified" ? "MUST VERIFY" : "MUST REJECT"}</em>`;
  button.addEventListener("click", () => { void runCase(item, false, null); });
  buttons.set(item.id, button);
  elements.cases.append(button);
}

elements.repairToggle.addEventListener("click", () => { void runCase(selected, !repaired, null); });
elements.chain.addEventListener("change", () => {
  updateSeedControlAvailability();
  elements.chainProof.textContent = chainProof().label;
  void runCase(selected, repaired, activeVariantId);
});
elements.seedSource.addEventListener("change", updateSeedControlAvailability);
elements.applyGameTarget.addEventListener("click", () => { void runCase(selected, false, null); });
elements.targetTokenId.addEventListener("keydown", (event) => { if (event.key === "Enter") void runCase(selected, false, null); });
for (const type of ["keydown", "keyup"]) addEventListener(type, (event) => {
  if (selected.id !== "vault-game" || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  if (!["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "Space", "KeyQ", "KeyE", "KeyF"].includes(event.code)) return;
  event.preventDefault();
  elements.viewer.contentWindow?.postMessage({ protocol: "keel-host-input@1", type, code: event.code, key: event.key, repeat: event.repeat, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }, "*");
});
elements.runAll.addEventListener("click", async () => {
  elements.runAll.disabled = true;
  for (const item of manifest.cases) await runCase(item, false, null);
  elements.runAll.disabled = false;
});

updateSeedControlAvailability();
updateSummary();
void runCase(selected, false, null);
