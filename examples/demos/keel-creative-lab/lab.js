const scenes = Object.freeze([
  { id: "p5-one", runtime: "p5.js", title: "Signal Bloom", kind: "fixed 1/1", editable: false, seeded: false, attributes: { seed: 0x51a7f10d, background: "#090819", accent: "#ff5fba" } },
  { id: "p5-seeded", runtime: "p5.js", title: "Arc Weather", kind: "seed driven", editable: false, seeded: true, attributes: { seed: 73021, background: "#07101d", accent: "#7fe7ff" } },
  { id: "p5-edit", runtime: "p5.js", title: "Color Relay", kind: "owner palette", editable: true, seeded: true, attributes: { seed: 4078, background: "#090819", accent: "#ff5fba" } },
  { id: "p5-image-onchain", runtime: "p5.js", title: "Aurora Ledger", kind: "seeded · onchain image", editable: false, seeded: true, attributes: { seed: 128771, background: "#020617", accent: "#8fffc1" } },
  { id: "p5-image-hybrid", runtime: "p5.js", title: "Aurora Expanse", kind: "seeded · hybrid image", editable: false, seeded: true, attributes: { seed: 128771, background: "#020617", accent: "#f46dff" } },
  { id: "three-one", runtime: "Three.js", title: "Halo Index", kind: "fixed 1/1", editable: false, seeded: false, attributes: { seed: 0x715a9e3d, background: "#090819", accent: "#ff5fba" } },
  { id: "three-seeded", runtime: "Three.js", title: "Shard Orbit", kind: "seed driven", editable: false, seeded: true, attributes: { seed: 44017, background: "#080d1d", accent: "#ffb85c" } },
  { id: "three-edit", runtime: "Three.js", title: "Chromatic Field", kind: "owner palette", editable: true, seeded: true, attributes: { seed: 4078, background: "#090819", accent: "#ff5fba" } },
  { id: "three-texture-onchain", runtime: "Three.js", title: "Mineral Core", kind: "seeded · onchain texture", editable: false, seeded: true, attributes: { seed: 93117, background: "#020408", accent: "#6fffd4" } },
  { id: "three-texture-hybrid", runtime: "Three.js", title: "Mineral Archive", kind: "seeded · hybrid texture", editable: false, seeded: true, attributes: { seed: 93117, background: "#020408", accent: "#b78cff" } },
  { id: "three-heavy", runtime: "Three.js", title: "Instance Storm", kind: "seeded · inline code", editable: false, seeded: true, attributes: { seed: 24681357, background: "#04060f", accent: "#ffbd59" } },
  { id: "three-mixed", runtime: "Three.js", title: "Carrier Constellation", kind: "seeded · mixed graph", editable: true, seeded: true, attributes: { seed: 667788, background: "#03050c", accent: "#72ffd6" } },
  { id: "image-only", runtime: "Keel Image", title: "Aurora Still", kind: "image presentation module", editable: false, seeded: false, attributes: { seed: 0, background: "#020617", accent: "#8fffc1" } },
  { id: "video-loop", runtime: "Keel Video", title: "Aurora Signal", kind: "video presentation module", editable: false, seeded: false, attributes: { seed: 0, background: "#020617", accent: "#8fffc1" } },
  { id: "script-pulse", runtime: "Classic Script", title: "Script Pulse", kind: "locked executable module", editable: false, seeded: true, attributes: { seed: 27791, background: "#060712", accent: "#ffb85c" } },
  { id: "api-weather", runtime: "API Snapshot", title: "Weather Lattice", kind: "manifested algorithm input", editable: false, seeded: true, attributes: { seed: 77812, background: "#07101d", accent: "#7fe7ff" } },
]);

const elements = {
  grid: document.querySelector("#scene-grid"), frame: document.querySelector("#scene-frame"), runtime: document.querySelector("#scene-runtime"),
  title: document.querySelector("#scene-title"), kind: document.querySelector("#edition-kind"), seed: document.querySelector("#seed"),
  background: document.querySelector("#background"), accent: document.querySelector("#accent"), notice: document.querySelector("#revision-notice"),
  publish: document.querySelector("#publish"), connect: document.querySelector("#connect"), status: document.querySelector("#status"),
  network: document.querySelector("#network-state"), proof: document.querySelector("#proof-log"), collector: document.querySelector("#collector-link"),
  libraryReceipt: document.querySelector("#library-receipt"), libraryName: document.querySelector("#library-name"),
  libraryDigest: document.querySelector("#library-digest"), libraryStorage: document.querySelector("#library-storage"),
  libraryDistribution: document.querySelector("#library-distribution"), librarySource: document.querySelector("#library-source"),
};
let selected = scenes[0];
let release;
let account;
let localAnvil = false;

function sceneUrl() {
  const url = new URL("./viewer.html", location.href);
  url.searchParams.set("build", "creative-lab-edge-v2");
  url.searchParams.set("scene", selected.id);
  url.searchParams.set("seed", elements.seed.value);
  url.searchParams.set("background", elements.background.value);
  url.searchParams.set("accent", elements.accent.value);
  return url;
}

function renderPreview() {
  elements.frame.src = sceneUrl();
  elements.runtime.textContent = `${selected.runtime} · ${selected.kind}`;
  elements.title.textContent = selected.title;
  elements.kind.textContent = selected.editable ? "Tracked owner revision" : selected.seeded ? "Deterministic edition" : "Fixed composition";
  elements.seed.disabled = !selected.seeded;
  elements.background.disabled = !selected.editable;
  elements.accent.disabled = !selected.editable;
  const revision = release?.scenes?.find((item) => item.id === selected.id);
  elements.publish.disabled = revision === undefined || !selected.editable;
  elements.connect.hidden = revision === undefined || !selected.editable;
  elements.collector.hidden = revision?.collectorUrl === undefined;
  if (revision?.collectorUrl) elements.collector.href = revision.collectorUrl;
  elements.notice.innerHTML = revision === undefined
    ? `<strong>Preview only</strong><span>This scene has no deployment-bound storage, seed, or presentation receipt yet.</span>`
    : selected.editable
      ? `<strong>Tracked revision available</strong><span>Publish sends only the exact deployment-generated transactions, then verifies tokenURI and recursive reads.</span>`
      : `<strong>${selected.seeded ? "Seed committed at mint" : "One of one"}</strong><span>${selected.seeded ? "The scene derives its composition from the pinned token seed." : "This composition does not expose mutable visual attributes."}</span>`;
  const libraryId = selected.runtime === "p5.js"
    ? "p5-1-11-3"
    : selected.runtime === "Three.js"
      ? "three-r180-module"
      : undefined;
  const library = libraryId === undefined ? undefined : release?.libraries?.find((item) => item.id === libraryId);
  elements.libraryReceipt.hidden = library === undefined;
  if (library) {
    const sourceState = library.sourceReceipt.disposition === "exact-source-output"
      ? "Exact source"
      : library.sourceReceipt.disposition === "reproducible-build"
        ? "Reproducible build"
        : "Source review pending";
    elements.libraryName.textContent = `${sourceState} · ${library.id}`;
    elements.libraryDigest.textContent = library.decodedSha256;
    const ratio = Math.round(library.storedByteLength / library.decodedByteLength * 1000) / 10;
    elements.libraryStorage.textContent = `${library.compression} ${library.storedByteLength.toLocaleString()} bytes · ${ratio}% of ${library.decodedByteLength.toLocaleString()} decoded bytes · ${library.activeDeliveryProfile} · IPFS + onchain profiles committed`;
    elements.libraryDistribution.href = library.exactDistributionUrl;
    elements.librarySource.href = library.readableSourceTreeUrl;
  }
}

for (const scene of scenes) {
  const button = document.createElement("button");
  button.className = "scene-card";
  button.type = "button";
  button.setAttribute("aria-pressed", String(scene === selected));
  button.innerHTML = `<small>${scene.runtime} · ${scene.kind}</small><strong>${scene.title}</strong>`;
  button.addEventListener("click", () => {
    selected = scene;
    elements.seed.value = String(scene.attributes.seed >>> 0);
    elements.background.value = scene.attributes.background;
    elements.accent.value = scene.attributes.accent;
    for (const candidate of elements.grid.children) candidate.setAttribute("aria-pressed", String(candidate === button));
    renderPreview();
  });
  elements.grid.appendChild(button);
}
for (const input of [elements.seed, elements.background, elements.accent]) input.addEventListener("input", renderPreview);

function releaseAction() { return release?.scenes?.find((item) => item.id === selected.id); }
async function rpc(method, params) {
  const response = await fetch(release.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `RPC HTTP ${response.status}`);
  return body.result;
}
async function waitReceipt(hash) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`Transaction ${hash} reverted.`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Transaction ${hash} was not confirmed.`);
}
async function proofHash(value) {
  const bytes = new TextEncoder().encode(value.toLowerCase());
  return `0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function connectOwnerWallet() {
  try {
    const pageIsLoopback = ["127.0.0.1", "localhost"].includes(location.hostname);
    const rpcHost = new URL(release.rpcUrl).hostname;
    localAnvil = pageIsLoopback
      && ["127.0.0.1", "localhost"].includes(rpcHost)
      && Number(release.chainId) === 31337;
    if (localAnvil) {
      const accounts = await rpc("eth_accounts", []);
      account = accounts.find((candidate) => candidate.toLowerCase() === release.owner.toLowerCase());
      if (!account) throw new Error("The release owner is not unlocked by this local Anvil node.");
      elements.status.textContent = `Local Anvil owner ${account.slice(0, 8)}…${account.slice(-4)} ready.`;
      elements.connect.textContent = "Local Anvil owner ready";
      return account;
    }
    if (!globalThis.ethereum) throw new Error("A browser wallet is required outside the explicit local Anvil test lane.");
    const chain = await ethereum.request({ method: "eth_chainId" });
    const expected = `0x${Number(release.chainId).toString(16)}`;
    if (chain !== expected) await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
    [account] = await ethereum.request({ method: "eth_requestAccounts" });
    elements.status.textContent = `Connected ${account.slice(0, 8)}…${account.slice(-4)}.`;
    return account;
  } catch (error) {
    elements.status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
elements.connect.addEventListener("click", () => { void connectOwnerWallet().catch(() => undefined); });

elements.publish.addEventListener("click", async () => {
  const action = releaseAction();
  if (!action || !selected.editable) return;
  try {
    if (!account) await connectOwnerWallet();
    const attributes = { seed: Number(elements.seed.value) >>> 0, background: elements.background.value.toLowerCase(), accent: elements.accent.value.toLowerCase() };
    const variant = action.revisions.find((candidate) => JSON.stringify(candidate.attributes) === JSON.stringify(attributes));
    if (!variant) throw new Error("This exact palette has not been built and committed as a Keel revision.");
    elements.publish.disabled = true;
    elements.proof.textContent = "Reading tokenURI before the revision…";
    const before = await rpc("eth_call", [{ to: action.collection, data: action.tokenURICallData }, "latest"]);
    const hashes = [];
    for (const transaction of variant.transactions) {
      if (transaction.from.toLowerCase() !== account.toLowerCase()) throw new Error("Connected wallet is not the revision authority.");
      const hash = localAnvil
        ? await rpc("eth_sendTransaction", [transaction])
        : await ethereum.request({ method: "eth_sendTransaction", params: [transaction] });
      await waitReceipt(hash);
      hashes.push(hash);
    }
    const after = await rpc("eth_call", [{ to: action.collection, data: action.tokenURICallData }, "latest"]);
    if (after === before) throw new Error("tokenURI did not change after the presentation revision.");
    for (const check of variant.proofReads) {
      const result = await rpc("eth_call", [{ to: check.to, data: check.data }, "latest"]);
      if (await proofHash(result) !== check.sha256) throw new Error(`${check.label} returned unexpected bytes.`);
    }
    elements.proof.innerHTML = `<span data-ok>VERIFIED REVISION ${variant.revision}</span>\n${hashes.join("\n")}\ntokenURI changed\n${variant.proofReads.length} recursive reads matched`;
    elements.status.textContent = `Revision ${variant.revision} is active and its recursive proof matched.`;
    if (variant.collectorUrl) { elements.collector.href = variant.collectorUrl; elements.collector.hidden = false; }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.proof.innerHTML = `<span data-error>REVISION FAILED</span>\n${message}`;
    elements.status.textContent = message;
  } finally { renderPreview(); }
});

try {
  const response = await fetch("./release.json", { cache: "no-store" });
  if (!response.ok) throw new Error("not published");
  release = await response.json();
  if (release.schema !== "keel-creative-lab-release@1") throw new Error("unsupported release");
  if (!/^0x[0-9a-f]{40}$/u.test(release.owner)) throw new Error("release owner is missing");
  if (!Array.isArray(release.libraries) || !release.libraries.every((item) => item.compression === "brotli" && /^ipfs:\/\/b[a-z2-7]+$/u.test(item.ipfsUri) && item.logicalObjectId && item.linkRegistry && item.activeDeliveryProfile === "onchain-recursive" && item.deliveryProfiles?.includes("ordered-url-ipfs-then-onchain-gateway") && item.storageAuthentication === "onchain-immutable-bytes" && item.runtimeVerification === "recursive-decoded-sha256" && item.sourceBuildVerification === item.sourceReceipt?.disposition && item.decodedSha256 === item.sourceReceipt?.output?.digest && item.exactDistributionUrl && item.readableSourceTreeUrl)) {
    throw new Error("release Library source/compression receipts are incomplete");
  }
  elements.network.dataset.tone = "live";
  elements.network.lastElementChild.textContent = release.network;
  elements.status.textContent = `${release.scenes.length} on-chain scene receipts loaded.`;
  if (["127.0.0.1", "localhost"].includes(location.hostname) && Number(release.chainId) === 31337) {
    elements.connect.textContent = "Use local Anvil owner";
  }
} catch {
  elements.network.dataset.tone = "idle";
}
renderPreview();
