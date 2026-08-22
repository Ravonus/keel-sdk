import {
  ORB_LIGHT_STYLES,
  ORB_METAL_PALETTES,
  ORB_PORT_LIGHTS,
  ORB_SKIN_STYLES,
  ORB_VISOR_PALETTES,
  paintOrbMaterialAtlas,
} from "/content/orb-materials.mjs";
import { resolveWeaponRegion } from "/content/weapon-region-resolver.js";
import {
  materialBuildFromPackedAttributes,
  materializeWeaponFrame,
} from "/content/weapon-material-runtime.mjs";
import { evaluateVaultVerification } from "/content/vault-verification.js";
import { allowCollectionVerificationFixtureQuery, evaluateCollectionVerification } from "/content/collection-verification.js";
import { OCA_SOUND_BITS_CODEC, createAudioReader } from "/content/oca-readers.js";
import {
  VAULT_MOB_ABILITIES,
  VAULT_MOB_ABILITY_RULES,
  VAULT_MOB_ATTRIBUTE_LAYERS,
  VAULT_PLAYER_COMBAT_RULES,
  VAULT_SHOWCASE_MOB_ARCHETYPES,
  VAULT_WEAPON_COMBAT_RULES,
  armVaultGyroProjectile,
  createVaultMobVisualRecipes,
  resolveVaultEscapeVector,
  rollVaultCharacterCritical,
  rollVaultWeapon,
  selectVaultEscapeStyle,
  selectVaultMobAbilities,
  vaultGyroAnimationSpeed,
  updateVaultGyroProjectile,
  vaultGyroFrameIndex,
  vaultProjectileHitKey,
} from "/content/vault-combat-shared.mjs";
import {
  VAULT_DEFAULT_BINDINGS,
  VAULT_INPUT_ACTIONS,
  VAULT_INPUT_STORAGE_KEY,
  readVaultGamepad,
  sanitizeVaultBindings,
  vaultActionForCode,
  vaultBindingLabel,
} from "/content/vault-input-shared.mjs";

const markVaultStartup = (name) => {
  const markName = `vault:${name}`;
  performance.mark(markName);
  document.documentElement.dataset.vaultStartupStage = name;
};
markVaultStartup("module-start");

const localParams = new URLSearchParams(location.search);
const presentationMode = localParams.get("presentation") === "gallery" ? "gallery" : "full";
document.documentElement.dataset.vaultPresentationMode = presentationMode;
const queryChainId = localParams.get("chainId");
// Hosts may inject the verified context through either the modern runtime
// envelope or the legacy global. Keep both viewers on the exact same source
// of truth so a preview cannot silently fall back to a different seed/asset.
const runtimeData = globalThis.__KEEL_RUNTIME__;
const contextData = runtimeData?.context ?? globalThis.__KEEL_CONTEXT__ ?? {
  ...(queryChainId !== null && /^\d+$/.test(queryChainId) ? { chainId: Number(queryChainId) } : {}),
  derivedTokenSeed: localParams.get("seed"),
  tokenId: localParams.get("tokenId") ?? "preview",
};
const verificationFixturesAllowed = allowCollectionVerificationFixtureQuery(location.hostname, globalThis.__KEEL_TEST_MODE__ === true);
const verificationScenario = verificationFixturesAllowed ? localParams.get("verificationTest") ?? undefined : undefined;
if (verificationScenario === "module") throw new Error("Intentional pre-mount viewer module failure fixture.");
const collectionVerificationScenario = verificationFixturesAllowed ? localParams.get("collectionVerificationTest") ?? undefined : undefined;
const collectionFixture = (scenario) => {
  if (scenario === undefined) return undefined;
  const authority = "0x1111111111111111111111111111111111111111";
  const green = (reason) => ({ verdict: "green", reason });
  const unknown = () => ({ verdict: "unknown", reason: "Not verifiable — this custom contract does not expose an approved Keel hook or adapter." });
  const facets = scenario === "no-hook" ? {
    route: unknown(), content: green("Current Keel bytes and roots verify."), governance: unknown(), mint: unknown(), supply: unknown(), upgrade: unknown(),
  } : {
    route: green("tokenURI permanently delegates to the approved Keel resolver."),
    content: green("Active manifest, viewer, asset, and portable roots verify."),
    governance: scenario === "official" ? green("Revision lineage is frozen.") : { verdict: "amber", authority, reason: "Creator may publish tracked Keel revisions." },
    mint: scenario === "red-mint" ? { verdict: "red", reason: "Mint authority proof contradicts contract state." } : green("Mint policy is fixed."),
    supply: scenario === "red-supply" ? { verdict: "red", reason: "Supply arithmetic contradicts the claimed cap." } : green("Supply policy is fixed."),
    upgrade: green("Runtime and route are not upgradeable."),
  };
  return {
    proofClass: scenario === "adapter" ? "adapter-proof" : scenario === "no-hook" ? "content-only" : "native-proof",
    receiptId: `0x${"17".repeat(32)}`,
    chainId: String(globalThis.__KEEL_CONTEXT__?.chainId ?? 11155111),
    blockNumber: globalThis.__KEEL_CONTEXT__?.blockNumber ?? "9123456",
    blockHash: globalThis.__KEEL_CONTEXT__?.blockHash ?? `0x${"12".repeat(32)}`,
    observationBlockNumber: "9123455", observationBlockHash: `0x${"18".repeat(32)}`,
    collection: "0x2222222222222222222222222222222222222222", tokenId: globalThis.__KEEL_CONTEXT__?.tokenId ?? "1",
    policyVersion: "1", evidenceRoot: `0x${"13".repeat(32)}`, presentationRevision: "2", portableRoot: `0x${"14".repeat(32)}`,
    portableAnchorRoot: `0x${"15".repeat(32)}`, presentationContentDigest: `0x${"16".repeat(32)}`,
    revoked: scenario === "revoked", expired: scenario === "stale", facets,
  };
};
const collectionVerificationInput = globalThis.__KEEL_CONTEXT__?.collectionVerification
  ?? collectionFixture(collectionVerificationScenario);
const collectionVerification = collectionVerificationInput === undefined
  ? undefined
  : evaluateCollectionVerification(collectionVerificationInput);
const baseVerification = evaluateVaultVerification(runtimeData, globalThis.__KEEL_CONTEXT__, verificationScenario);
const verification = collectionVerification === undefined ? baseVerification : Object.freeze({
  ...baseVerification,
  state: collectionVerification.state === "failed" ? "failed" : baseVerification.state,
  title: collectionVerification.state === "failed" ? "Collection verification failed"
    : collectionVerification.state === "conditional" && baseVerification.state === "verified"
      ? `${collectionVerification.seal} · controls conditional` : baseVerification.title,
  summary: `${baseVerification.summary} ${collectionVerification.summary}`,
  proofTier: `${baseVerification.proofTier} · ${collectionVerificationInput.proofClass}`,
  isFixture: baseVerification.isFixture || collectionVerificationScenario !== undefined,
  collectionVerification: Object.freeze({ ...collectionVerification, input: collectionVerificationInput }),
});

const KEEL_VERIFICATION_PRESENTATION_PROTOCOL = "keel-verification-presentation@1";
const KEEL_VERIFICATION_PANEL_TYPES = new Set(["overview", "checks", "storage", "resources", "identity", "commitments", "object-trail", "staking", "contract-facets"]);
const normalizeVerificationPresentation = (input) => {
  if (input?.protocol !== KEEL_VERIFICATION_PRESENTATION_PROTOCOL || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Unsupported Keel verification presentation manifest.");
  const seal = input.seal;
  if (!seal || typeof seal.glyph !== "string" || seal.glyph.length < 1 || seal.glyph.length > 4 || !["stamp", "disc", "shield", "square"].includes(seal.shape) || !["slide", "stamp", "scale", "rise", "none"].includes(seal.motion)) throw new Error("Invalid Keel verification seal presentation.");
  for (const [name, value, minimum, maximum] of [["sizePx", seal.sizePx, 24, 72], ["fadeInMs", seal.fadeInMs, 50, 3000], ["holdMs", seal.holdMs, 0, 10000], ["fadeOutMs", seal.fadeOutMs, 50, 3000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid Keel seal ${name}.`);
  }
  const overlay = input.overlay;
  if (!overlay || !["left", "right", "center"].includes(overlay.placement) || !["compact", "standard", "wide"].includes(overlay.width) || !["tabs", "stepper"].includes(overlay.navigation)) throw new Error("Invalid Keel verification overlay presentation.");
  const theme = input.theme;
  const color = (value, state = false) => (state && value === "verification-state") || /^#[0-9a-f]{6}$/u.test(value ?? "");
  if (!theme || !color(theme.accent, true) || !color(theme.surface) || !color(theme.text) || !color(theme.muted) || !Number.isSafeInteger(theme.radiusPx) || theme.radiusPx < 0 || theme.radiusPx > 48) throw new Error("Invalid Keel verification theme presentation.");
  if (theme.cssResource !== undefined && (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(theme.cssResource.id) || !/^0x[0-9a-f]{64}$/u.test(theme.cssResource.digest) || !Number.isSafeInteger(theme.cssResource.byteLength) || theme.cssResource.byteLength < 1 || theme.cssResource.byteLength > 65536)) throw new Error("Invalid Keel verification CSS commitment.");
  if (!Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 8) throw new Error("Invalid Keel verification page manifest.");
  const pageIds = new Set(), panelIds = new Set();
  const pages = input.pages.map((page) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(page?.id) || pageIds.has(page.id) || typeof page.label !== "string" || page.label.length < 1 || page.label.length > 32 || !["stack", "columns", "grid"].includes(page.layout) || !Number.isSafeInteger(page.columns) || page.columns < 1 || page.columns > 3 || !Array.isArray(page.panels) || page.panels.length < 1 || page.panels.length > 16) throw new Error("Invalid Keel verification page.");
    pageIds.add(page.id);
    const panels = page.panels.map((item) => {
      const span = item.span ?? 1;
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(item?.id) || panelIds.has(item.id) || !KEEL_VERIFICATION_PANEL_TYPES.has(item.type) || !Number.isSafeInteger(span) || span < 1 || span > page.columns) throw new Error("Invalid Keel verification panel.");
      panelIds.add(item.id);
      return Object.freeze({ ...item, span });
    });
    return Object.freeze({ ...page, panels: Object.freeze(panels) });
  });
  if (!pageIds.has(overlay.initialPage)) throw new Error("The initial Keel verification page does not exist.");
  return Object.freeze({ ...input, seal: Object.freeze({ ...seal }), overlay: Object.freeze({ ...overlay }), theme: Object.freeze({ ...input.theme }), pages: Object.freeze(pages) });
};
const embeddedVerificationPresentation = normalizeVerificationPresentation(JSON.parse(document.querySelector("#keel-verification-presentation")?.textContent ?? "null"));

const ANCHOR_FAMILY_NAMES = Object.freeze({ 1: "Ethereum", 2: "Tezos", 3: "Bitcoin Ordinals" });
const OBJECT_TRAIL = Object.freeze([
  {
    field: "portableRoot", label: "Portable package", type: "Cross-chain content root",
    description: "The fingerprint for the portable presentation package.",
    impact: "A different root means a different package of presentation content.", source: "Portable anchor",
  },
  {
    field: "portableManifestObjectId", label: "Portable manifest", type: "Manifest / JSON",
    revision: "portableManifestObjectRevision",
    description: "The table of contents that says which portable bytes belong together.",
    impact: "It controls what the portable presentation is allowed to load.", source: "On-chain / Keel",
  },
  {
    field: "portableDecodedObjectId", label: "Decoded presentation", type: "HTML / data",
    revision: "portableDecodedObjectRevision",
    description: "The decoded payload referenced by the portable manifest.",
    impact: "Changing it can change the rendered presentation.", source: "On-chain / Keel",
  },
  {
    field: "portableAnchorRoot", label: "Portable anchor", type: "Cross-chain proof link",
    description: "The registry link that binds the portable package to its exact Keel objects and revisions.",
    impact: "It prevents a delivery copy from pointing at a different package.", source: "On-chain / Keel",
  },
  {
    field: "assetFamilyId", label: "Asset family", type: "Asset catalog",
    revision: "assetFamilyRevision",
    description: "The family of visual and audio parts available to this character.",
    impact: "A different family can change the character's available parts.", source: "On-chain / Keel",
  },
  {
    field: "assetId", label: "Selected asset", type: "Asset selection",
    description: "The exact asset choice derived from the pinned token recipe.",
    impact: "This can change the character or equipped weapon that is rendered.", source: "On-chain / Keel",
  },
  {
    field: "spriteObjectId", label: "Sprite", type: "Image / sprite",
    description: "The image object used for the visible character or weapon pixels.",
    impact: "This directly changes what the collector sees.", source: "On-chain / Keel",
  },
  {
    field: "targetMapObjectId", label: "Target map", type: "Data / mask",
    description: "The map that tells the renderer which pixels receive each material or effect.",
    impact: "It can change color placement, masks, and material regions.", source: "On-chain / Keel",
  },
  {
    field: "effectProfileObjectId", label: "Effect profile", type: "FX / behavior",
    description: "The committed effect rules used by the viewer.",
    impact: "It can change particles, lights, trails, and animation response.", source: "On-chain / Keel",
  },
  {
    field: "soundProfileObjectId", label: "Sound profile", type: "Audio",
    description: "The committed sound mapping used by the viewer.",
    impact: "It can change which sound plays and how it is decoded.", source: "On-chain / Keel",
  },
]);

const isSupplied = (value) => value !== undefined && value !== null && value !== "";
const shortValue = (value) => typeof value === "string" && value.length > 22
  ? `${value.slice(0, 10)}…${value.slice(-8)}` : String(value);
const sourceTag = (source) => {
  const uri = typeof source?.uri === "string" ? source.uri.toLowerCase() : "";
  if (source?.kind === "onchain") return { label: "On-chain / Keel", detail: `Chain ${source.chainId} · object ${shortValue(source.objectId)}`, tone: "onchain" };
  if (source?.kind === "contract-call") return { label: "On-chain call", detail: `Chain ${source.chainId} · contract read`, tone: "onchain" };
  if (source?.kind === "inline") return { label: "Bundled", detail: "Embedded in the verified viewer", tone: "bundled" };
  if (source?.kind === "composite") return { label: "Composed", detail: "Built from committed parts", tone: "composed" };
  if (uri.startsWith("ipfs://") || uri.includes("/ipfs/")) return { label: "IPFS mirror", detail: shortValue(source.uri), tone: "ipfs" };
  if (uri.startsWith("ar://") || uri.includes("arweave")) return { label: "Arweave mirror", detail: shortValue(source.uri), tone: "arweave" };
  if (uri.startsWith("ord://") || uri.includes("ordinal") || uri.includes("inscription")) return { label: "Ordinals mirror", detail: shortValue(source.uri), tone: "ordinals" };
  if (uri.startsWith("tezos://") || uri.includes("tezos") || uri.includes("tzkt")) return { label: "Tezos mirror", detail: shortValue(source.uri), tone: "tezos" };
  return { label: "URI mirror", detail: shortValue(source.uri), tone: "uri" };
};
const contentResources = () => {
  const content = globalThis.__KEEL_CONTENT__;
  if (typeof content?.resources !== "function") return [];
  try {
    const result = content.resources();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
};
const stakeLockupLabel = (lockup) => {
  if (lockup?.mode === "minimum-duration") return `Minimum duration · ${lockup.seconds} seconds from stake start`;
  if (lockup?.mode === "until-disabled") return "Until disabled · the manager must disable this object before unstake";
  return "No lockup · unstake is available while the object is active";
};
const stakeManagerLabel = (stake) => {
  if (stake?.managerVerified !== true) return "Not verified · gated resources remain withheld";
  if (stake.managerPolicy?.mode === "verified-custom") return "Verified custom · immutable code + paid review receipt";
  return "Official Keel manager · immutable proof accepted";
};

function mountVerificationUI(result, runtime, runtimeContext, presentationInput) {
  const seal = document.querySelector("#verify-seal"), panel = document.querySelector("#verify-panel");
  const corner = document.querySelector(".verify-corner");
  const closeButton = document.querySelector("#verify-close"), backdrop = document.querySelector("#verify-backdrop");
  const alertOpen = document.querySelector("#verify-alert-open"), alertDismiss = document.querySelector("#verify-alert-dismiss"), details = document.querySelector("#verify-details");
  const title = document.querySelector("#verify-title"), summary = document.querySelector("#verify-summary");
  const kicker = document.querySelector("#verify-kicker"), tier = document.querySelector("#verify-tier");
  const alertMessage = document.querySelector("#verify-alert-message");
  const presentation = normalizeVerificationPresentation(presentationInput ?? globalThis.__KEEL_VERIFICATION_PRESENTATION__ ?? embeddedVerificationPresentation);
  const sealMarks = document.querySelectorAll(".seal-mark");
  for (const mark of sealMarks) mark.dataset.keelSealGlyph = presentation.seal.glyph;
  seal.dataset.keelSeal = presentation.seal.shape;
  corner.dataset.keelSealShape = presentation.seal.shape;
  corner.dataset.keelSealMotion = presentation.seal.motion;
  corner.dataset.keelPresentationRevision = String(presentation.revision);
  corner.style.setProperty("--keel-seal-size", `${presentation.seal.sizePx}px`);
  corner.style.setProperty("--keel-seal-fade-in", `${presentation.seal.fadeInMs}ms`);
  corner.style.setProperty("--keel-seal-fade-out", `${presentation.seal.fadeOutMs}ms`);
  if (presentation.seal.color !== "verification-state") corner.style.setProperty("--keel-seal-color", presentation.seal.color);
  panel.dataset.keelPlacement = presentation.overlay.placement;
  panel.dataset.keelWidth = presentation.overlay.width;
  panel.style.setProperty("--keel-panel-width", presentation.overlay.width === "compact" ? "min(420px,calc(100% - 20px))" : presentation.overlay.width === "wide" ? "min(760px,calc(100% - 20px))" : "min(560px,calc(100% - 20px))");
  panel.style.setProperty("--keel-panel-radius", `${presentation.theme.radiusPx}px`);
  panel.style.setProperty("--keel-panel-surface", presentation.theme.surface);
  panel.style.setProperty("--keel-panel-text", presentation.theme.text);
  panel.style.setProperty("--keel-panel-muted", presentation.theme.muted);
  if (presentation.theme.accent !== "verification-state") panel.style.setProperty("--keel-seal-color", presentation.theme.accent);
  document.documentElement.dataset.verificationChrome = "embedded";
  document.documentElement.dataset.keelVerificationPresentation = String(presentation.revision);
  let lastFocus;
  let currentResult = result;
  let cornerHideTimer;
  const setCornerPresence = (active) => {
    if (active) {
      corner.dataset.verifyCornerActive = "true";
      seal.tabIndex = 0;
      seal.setAttribute("aria-hidden", "false");
    } else {
      delete corner.dataset.verifyCornerActive;
      seal.tabIndex = -1;
      seal.setAttribute("aria-hidden", "true");
    }
  };

  const section = (heading, panelType) => {
    const node = document.createElement("section"); node.className = "verify-section";
    node.dataset.keelPanelType = panelType;
    const label = document.createElement("h3"); label.textContent = heading; node.append(label); details.append(node); return node;
  };
  const note = (parent, text, className = "verify-note") => {
    const node = document.createElement("p"); node.className = className; node.textContent = text; parent.append(node); return node;
  };
  const row = (parent, key, value, options = {}) => {
    if (!isSupplied(value)) return false;
    const node = document.createElement("div"); node.className = "verify-row";
    const name = document.createElement("span"); name.className = "verify-key"; name.textContent = key;
    const output = document.createElement("span"); output.className = `verify-value${options.plain ? " verify-value-plain" : ""}`;
    output.textContent = options.display ?? (options.plain ? String(value) : shortValue(value)); output.title = String(value);
    node.append(name, output); parent.append(node);
    return true;
  };
  const badge = (parent, value) => {
    const tag = typeof value === "string" ? { label: value } : value;
    const node = document.createElement("span"); node.className = `verify-source-badge verify-source-${tag.tone ?? "neutral"}`; node.textContent = tag.label;
    if (tag.detail !== undefined) node.title = tag.detail;
    parent.append(node); return node;
  };
  const trailItem = (parent, item, index, value, options = {}) => {
    if (!isSupplied(value)) return false;
    const node = document.createElement("article"); node.className = "verify-trail-item";
    const head = document.createElement("div"); head.className = "verify-trail-head";
    const step = document.createElement("span"); step.className = "verify-trail-step"; step.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("strong"); title.textContent = item.label;
    const type = document.createElement("span"); type.className = "verify-trail-type"; type.textContent = item.type;
    head.append(step, title, type); node.append(head);
    const sourceLine = document.createElement("div"); sourceLine.className = "verify-source-line";
    const sources = options.sources ?? [item.source ?? "On-chain / Keel"];
    for (const source of sources) badge(sourceLine, source);
    node.append(sourceLine);
    const description = document.createElement("p"); description.className = "verify-trail-description"; description.textContent = item.description;
    node.append(description);
    const valueLine = document.createElement("div"); valueLine.className = "verify-trail-value";
    const code = document.createElement("code"); code.textContent = options.display ?? shortValue(value); code.title = String(value);
    valueLine.append(code);
    if (isSupplied(item.revision) && isSupplied(runtimeContext?.[item.revision])) {
      const revision = document.createElement("span"); revision.className = "verify-revision"; revision.textContent = `rev ${runtimeContext[item.revision]}`; revision.title = `Pinned object revision ${runtimeContext[item.revision]}`; valueLine.append(revision);
    }
    node.append(valueLine);
    const impact = document.createElement("small"); impact.className = "verify-trail-impact"; impact.textContent = `Can affect: ${item.impact}`; node.append(impact);
    parent.append(node); return true;
  };
  const applyPresentationLayout = () => {
    const queues = new Map();
    for (const node of [...details.querySelectorAll(":scope > .verify-section")]) {
      const type = node.dataset.keelPanelType;
      if (!queues.has(type)) queues.set(type, []);
      queues.get(type).push(node);
    }
    const navigation = document.createElement("nav"); navigation.className = "verify-page-nav"; navigation.dataset.navigation = presentation.overlay.navigation; navigation.setAttribute("role", "tablist"); navigation.setAttribute("aria-label", "Verification proof pages");
    const pageHost = document.createElement("div"); pageHost.className = "verify-page-host";
    const available = [];
    for (const pageDefinition of presentation.pages) {
      const pageNode = document.createElement("section"); pageNode.className = "verify-page"; pageNode.id = `verify-page-${pageDefinition.id}`; pageNode.dataset.layout = pageDefinition.layout; pageNode.style.setProperty("--keel-page-columns", String(pageDefinition.columns)); pageNode.setAttribute("role", "tabpanel");
      for (const panelDefinition of pageDefinition.panels) {
        const node = queues.get(panelDefinition.type)?.shift();
        if (!(node instanceof HTMLElement)) continue;
        node.dataset.keelPanelId = panelDefinition.id;
        node.style.setProperty("--keel-panel-span", String(panelDefinition.span));
        if (panelDefinition.title) node.querySelector("h3").textContent = panelDefinition.title;
        pageNode.append(node);
      }
      if (pageNode.childElementCount === 0) continue;
      const button = document.createElement("button"); button.className = "verify-page-button"; button.type = "button"; button.id = `verify-page-tab-${pageDefinition.id}`; button.textContent = pageDefinition.label; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", pageNode.id); pageNode.setAttribute("aria-labelledby", button.id);
      navigation.append(button); pageHost.append(pageNode); available.push({ id: pageDefinition.id, button, pageNode });
    }
    if (available.length === 0) throw new Error("The verification presentation did not select any available proof panels.");
    const select = (id) => {
      const selected = available.some((item) => item.id === id) ? id : available[0].id;
      for (const item of available) {
        const active = item.id === selected;
        item.button.setAttribute("aria-selected", String(active)); item.button.tabIndex = active ? 0 : -1; item.pageNode.hidden = !active;
      }
      details.dataset.activePage = selected;
    };
    for (const item of available) item.button.addEventListener("click", () => select(item.id));
    select(presentation.overlay.initialPage);
    details.replaceChildren(navigation, pageHost);
  };
  const render = (next) => {
    currentResult = next;
    document.body.classList.remove("verification-alert-dismissed");
    document.body.classList.remove("verification-verified", "verification-failed", "verification-unavailable");
    document.body.classList.add(`verification-${next.state}`);
    document.documentElement.dataset.vaultVerification = next.state;
    document.documentElement.dataset.vaultVerificationFixture = String(next.isFixture);
    title.textContent = next.isFixture ? `TEST FIXTURE — ${next.title}` : next.title;
    summary.textContent = next.isFixture ? `TEST FIXTURE ONLY. ${next.summary}` : next.summary;
    tier.textContent = next.proofTier;
    kicker.textContent = next.isFixture ? "TEST FIXTURE — NOT A LIVE PROOF"
      : next.state === "verified" ? (next.syntheticTokenContext ? "Keel runtime active" : "On-chain proof accepted") : next.state === "failed" ? "Proof rejected" : "Proof unavailable";
    seal.setAttribute("aria-label", `${next.title}. Open on-chain verification details`);
    if (next.state === "failed") alertMessage.textContent = next.isFixture ? `TEST FIXTURE — ${next.summary}` : next.summary;
    details.replaceChildren();
    const plain = section("What this proves", "overview");
    note(plain, next.state === "unavailable"
      ? "This presentation did not enable a supported Keel verifier API. The art may still render, but no verifier receipt is being claimed."
      : next.syntheticTokenContext
      ? "This is a runtime preview: it proves the bundled Keel viewer and its committed resource pipeline. It does not claim that this preview is a live token snapshot at a block."
      : next.state === "verified"
        ? "This render is tied to the token, the exact viewer version, and the chain block shown below."
        : "The viewer is showing the evidence that failed. Treat the render as unverified until the failed check is resolved.");
    const guide = document.createElement("div"); guide.className = "verify-guide-grid";
    for (const card of [
      ["Presentation", "HTML + CSS", "The page shell, layout, and visual rules.", "Changes how the viewer looks."],
      ["Recipe", "Seed + versions", "The token recipe chooses the object IDs and revisions.", "Changes which character parts are selected."],
      ["Assets", "Pixels + FX + sound", "Committed objects supply the image, masks, effects, and audio.", "Changes what the collector sees or hears."],
    ]) {
      const cardNode = document.createElement("div"); cardNode.className = "verify-guide-card";
      const label = document.createElement("span"); label.className = "verify-guide-label"; label.textContent = card[0];
      const titleNode = document.createElement("strong"); titleNode.textContent = card[1];
      const copy = document.createElement("p"); copy.textContent = card[2];
      const impact = document.createElement("small"); impact.textContent = card[3];
      cardNode.append(label, titleNode, copy, impact); guide.append(cardNode);
    }
    plain.append(guide);
    const checkSection = section(next.state === "failed" ? "Failed verification checks" : "Verification checks", "checks");
    const hasMapContext = Object.keys(runtimeContext ?? {}).some((key) => key.startsWith("map"));
    const visibleChecks = next.checks.filter((check) => check.id !== "map-pin");
    if (hasMapContext) {
      const mapCheck = next.checks.find((check) => check.id === "map-pin");
      if (mapCheck !== undefined) visibleChecks.push(mapCheck);
    }
    for (const item of visibleChecks) {
      const node = document.createElement("div"); node.className = "verify-check"; node.dataset.check = item.passed ? "pass" : item.severity;
      const dot = document.createElement("span"); dot.className = "verify-dot";
      if (!item.passed) { dot.style.background = item.severity === "unavailable" ? "#ffca63" : "#ff6573"; dot.style.boxShadow = "0 0 10px currentColor"; }
      const copy = document.createElement("span"); copy.textContent = `${item.passed ? "PASS" : item.severity === "unavailable" ? "NOT PROVEN" : "FAIL"} · ${item.label}`;
      const detail = document.createElement("small"); detail.textContent = item.plain ?? item.detail; detail.title = item.detail; copy.append(detail);
      if (item.impact !== undefined) { const impact = document.createElement("small"); impact.className = "verify-check-impact"; impact.textContent = `Impact: ${item.impact}`; copy.append(impact); }
      node.append(dot, copy); checkSection.append(node);
    }
    const sources = contentResources();
    const sourceFamilies = new Set(sources.flatMap((resource) => (resource.sources ?? []).map((source) => sourceTag(source).label)));
    const storage = section("Where the bytes come from", "storage");
    row(storage, "Canonical viewer", next.syntheticTokenContext ? "Bundled Keel preview" : sourceFamilies.has("On-chain / Keel") ? "On-chain / Keel" : "Verified Keel runtime", { plain: true });
    for (const [label, family] of [["IPFS", "IPFS mirror"], ["Ordinals", "Ordinals mirror"], ["Tezos", "Tezos mirror"]]) {
      row(storage, label, sourceFamilies.has(family) ? "Declared mirror" : "Not declared for this proof", { plain: true });
    }
    note(storage, "Mirrors are optional delivery copies. They can make content easier to retrieve, but they do not replace the committed source.");
    if (sources.length > 0) {
      const files = section(`Verified viewer files · ${sources.length}`, "resources");
      for (const resource of sources) {
        const file = document.createElement("article"); file.className = "verify-file-item";
        const head = document.createElement("div"); head.className = "verify-file-head";
        const fileName = document.createElement("strong"); fileName.textContent = resource.originalName ?? resource.id;
        const mediaType = document.createElement("span"); mediaType.className = "verify-file-type"; mediaType.textContent = resource.mediaType ?? resource.role ?? "resource";
        head.append(fileName, mediaType); file.append(head);
        const sourceLine = document.createElement("div"); sourceLine.className = "verify-source-line";
        for (const source of resource.sources ?? []) badge(sourceLine, sourceTag(source));
        if ((resource.sources ?? []).length === 0) badge(sourceLine, next.syntheticTokenContext ? "Bundled" : "Verified runtime");
        file.append(sourceLine);
        const fileMeta = document.createElement("small"); fileMeta.className = "verify-file-meta"; fileMeta.textContent = `${resource.role ?? "resource"} · ${resource.byteLength ?? "?"} bytes · ${shortValue(resource.digest ?? "digest unavailable")}`; file.append(fileMeta);
        files.append(file);
      }
    } else {
      note(storage, "The standalone preview embeds its viewer files in the bundled HTML, so a separate gateway file list is not available here.", "verify-note verify-note-muted");
    }
    const identity = section("Token identity", "identity");
    let identityCount = 0;
    identityCount += row(identity, "Chain ID", runtimeContext?.chainId ?? contextData?.chainId) ? 1 : 0;
    const tokenId = runtimeContext?.tokenId ?? contextData?.tokenId;
    identityCount += row(identity, "Token ID", tokenId, tokenId === "preview" ? { display: "Preview · no token binding", plain: true } : {}) ? 1 : 0;
    identityCount += row(identity, "Pinned block", runtimeContext?.blockNumber) ? 1 : 0;
    identityCount += row(identity, "Block hash", runtimeContext?.blockHash) ? 1 : 0;
    identityCount += row(identity, "Token seed", runtimeContext?.derivedTokenSeed ?? contextData?.derivedTokenSeed) ? 1 : 0;
    identityCount += row(identity, "Packed attributes", runtimeContext?.packedAttributes ?? localParams.get("attributes")) ? 1 : 0;
    if (identityCount === 0) note(identity, "No token-specific identity was supplied to this viewer.");
    else if (next.syntheticTokenContext) note(identity, "These are preview inputs. A live token proof also needs the pinned block and block hash.");

    const versions = section("Versions & commitments", "commitments");
    let versionCount = 0;
    versionCount += row(versions, "Viewer revision", runtime?.revision) ? 1 : 0;
    versionCount += row(versions, "Viewer content hash", runtime?.manifestDigest) ? 1 : 0;
    versionCount += row(versions, "Catalog revision", runtimeContext?.catalogRevision) ? 1 : 0;
    versionCount += row(versions, "Asset-family revision", runtimeContext?.assetFamilyRevision) ? 1 : 0;
    versionCount += row(versions, "Portable root", runtimeContext?.portableRoot) ? 1 : 0;
    versionCount += row(versions, "Anchor root", runtimeContext?.portableAnchorRoot) ? 1 : 0;
    if (versionCount === 0) note(versions, "No live version commitments were supplied to this preview.");

    const trail = section("Keel object trail", "object-trail");
    const viewerTrail = { field: "manifestDigest", label: "Viewer package", type: "HTML + CSS + code", description: "The page and runtime that explain and render the object graph.", impact: "A different package can change the entire presentation.", source: next.syntheticTokenContext ? "Bundled preview" : "On-chain / Keel" };
    let trailCount = 0;
    trailCount += trailItem(trail, viewerTrail, trailCount, runtime?.manifestDigest, { display: runtime?.manifestDigest ? undefined : "Bundled viewer package" }) ? 1 : 0;
    if (next.syntheticTokenContext && trailCount === 0) trailCount += trailItem(trail, viewerTrail, trailCount, "bundled-preview", { display: "Bundled Keel viewer" }) ? 1 : 0;
    for (const item of OBJECT_TRAIL) trailCount += trailItem(trail, item, trailCount, runtimeContext?.[item.field]) ? 1 : 0;
    const attestedAnchors = Array.isArray(runtimeContext?.attestedAnchors) ? runtimeContext.attestedAnchors : [];
    for (const anchored of attestedAnchors) {
      const familyName = ANCHOR_FAMILY_NAMES[anchored.family] ?? `Family ${anchored.family}`;
      trailCount += row(trail, `Anchored on ${familyName} · network ${anchored.network}`, anchored.anchorRoot, {
        display: `revision ${anchored.objectRevision} · ${shortValue(anchored.anchorRoot)}`,
      }) ? 1 : 0;
    }
    if (attestedAnchors.length > 0) note(trail, "Anchored networks are registry-verified locations of these exact bytes: the home chain's row is the native proof, and foreign rows were oracle-verified byte-for-byte before the registry accepted them.");
    if (trailCount === 0) note(trail, "No token-specific Keel object IDs were supplied. The preview is using its bundled resource graph.");
    else note(trail, "The trail is ordered from the viewer package to the portable binding, recipe, and the objects that affect pixels, effects, and sound.");
    const stake = runtimeContext?.stakeObject;
    if (stake !== undefined) {
      const staking = section(stake.active ? "Stake object · active" : "Stake object · inactive", "staking");
      note(staking, stake.active
        ? "This verified stake is loading the staked entrypoint and its gated map resources."
        : stake.managerVerified
          ? "No active stake was found for this token. The viewer is using its original entrypoint; gated map resources are withheld."
          : "A stake object is declared, but its manager is not verified. The viewer is using its original entrypoint and withholding gated map resources.");
      row(staking, "Manager", stakeManagerLabel(stake), { plain: true });
      row(staking, "Chain", stake.chain, { plain: true });
      row(staking, "Manager address", stake.manager);
      row(staking, "Stake object ID", stake.stakeObjectId);
      row(staking, "Viewer enabled while staked", stake.viewerId);
      row(staking, "Host map token", `${stake.hostCollection} · ${stake.hostTokenId}`);
      row(staking, "Staked token", `${stake.stakedCollection ?? "collection unavailable"} · ${stake.stakedTokenId}`);
      row(staking, "Current token owner", stake.tokenOwner ?? (stake.active ? stake.manager : "Not escrowed"), { plain: true });
      row(staking, "Staker", stake.staker ?? "No active staker", { plain: true });
      row(staking, "Map owner", stake.hostOwner ?? "Not declared for this proof", { plain: true });
      row(staking, "Controller", stake.controller ?? stake.manager, { plain: true });
      row(staking, "Lockup", stakeLockupLabel(stake.lockup), { plain: true });
      row(staking, "Started at", stake.startedAt ?? "Not active", { plain: true });
      row(staking, "This character in this map", stake.counters.objectTokenLifetime, { plain: true });
      row(staking, "All lifetime stakes into this map", stake.counters.objectLifetime, { plain: true });
      row(staking, "Characters active in this map", stake.counters.objectActive, { plain: true });
      row(staking, "This character across all maps", stake.counters.tokenLifetime, { plain: true });
      row(staking, "This token active stakes", stake.counters.tokenActive, { plain: true });
      row(staking, "Global lifetime stakes", stake.counters.globalLifetime, { plain: true });
      row(staking, "Global active stakes", stake.counters.globalActive, { plain: true });
      row(staking, "Gated viewer slot", stake.slot, { plain: true });
      row(staking, "Map code object", stake.codeObjectId);
      row(staking, "Map code revision", stake.codeObjectRevision, { plain: true });
      row(staking, "Runtime commitment", stake.runtimeDigest);
      row(staking, "Backpack", stake.backpack?.kind ?? "Not enabled", { plain: true });
      if (stake.managerProof !== undefined) {
        row(staking, "Immutable manager code", stake.managerProof.codeHash);
        row(staking, "Manager evidence", stake.managerProof.evidenceDigest ?? "Not declared for this proof", { plain: true });
        if (stake.managerProof.feeReceipt !== undefined) row(staking, "Review fee receipt", stake.managerProof.feeReceipt);
      }
      note(staking, `Rules: require the token to be staked before loading ${stake.stakedEntrypoint}; unstake restores the original entrypoint. ${stakeLockupLabel(stake.lockup)}. The global counters include every stake object using this manager, while token counters follow this character across maps.`);
    }
    if (next.collectionVerification !== undefined) {
      const proof = next.collectionVerification;
      const collection = section("Collection contract facets", "contract-facets");
      row(collection, "Proof class", proof.input.proofClass);
      row(collection, "Receipt ID", proof.input.receiptId);
      row(collection, "Observation block", `${proof.input.observationBlockNumber} · ${proof.input.observationBlockHash}`);
      row(collection, "Current pinned block", `${proof.input.blockNumber} · ${proof.input.blockHash}`);
      row(collection, "Policy version", proof.input.policyVersion);
      row(collection, "Evidence root", proof.input.evidenceRoot);
      for (const facet of proof.rows) {
        const authority = facet.authority ?? facet.timelock;
        row(collection, facet.label, `${facet.verdict.toUpperCase()} · ${facet.reason}${authority === undefined ? "" : ` · ${authority}`}`);
      }
    }
    applyPresentationLayout();
  };
  const open = () => {
    setCornerPresence(true);
    lastFocus = document.activeElement; document.body.classList.add("verify-open"); panel.setAttribute("aria-hidden", "false"); seal.setAttribute("aria-expanded", "true");
    closeButton.focus({ preventScroll: true });
    parent.postMessage({ protocol: "keel-viewer-verification@1", action: "opened", state: document.documentElement.dataset.vaultVerification }, "*");
  };
  const close = () => {
    document.body.classList.remove("verify-open"); panel.setAttribute("aria-hidden", "true"); seal.setAttribute("aria-expanded", "false");
    if (lastFocus instanceof HTMLElement && lastFocus !== seal) lastFocus.focus({ preventScroll: true });
    else seal.blur();
    scheduleCornerHide();
    parent.postMessage({ protocol: "keel-viewer-verification@1", action: "closed" }, "*");
  };
  const revealCorner = () => {
    clearTimeout(cornerHideTimer);
    setCornerPresence(true);
  };
  const scheduleCornerHide = () => {
    clearTimeout(cornerHideTimer);
    cornerHideTimer = setTimeout(() => {
      if (!document.body.classList.contains("verify-open")) setCornerPresence(false);
    }, presentation.seal.holdMs);
  };
  setCornerPresence(false);
  corner.addEventListener("pointerenter", revealCorner);
  corner.addEventListener("pointerleave", scheduleCornerHide);
  corner.addEventListener("pointerdown", revealCorner);
  corner.addEventListener("pointerup", scheduleCornerHide);
  corner.addEventListener("pointercancel", scheduleCornerHide);
  seal.addEventListener("focus", revealCorner);
  seal.addEventListener("blur", scheduleCornerHide);
  seal.addEventListener("click", open); alertOpen.addEventListener("click", open); alertDismiss.addEventListener("click", () => { document.body.classList.add("verification-alert-dismissed"); parent.postMessage({ protocol: "keel-viewer-verification@1", action: "warning-dismissed", state: currentResult.state }, "*"); }); closeButton.addEventListener("click", close); backdrop.addEventListener("click", close);
  addEventListener("keydown", (event) => {
    if (!document.body.classList.contains("verify-open")) return;
    if (event.key === "Escape") { close(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...panel.querySelectorAll("button:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])")].filter((node) => node instanceof HTMLElement && !node.hidden);
    if (focusable.length === 0) { event.preventDefault(); panel.focus({ preventScroll: true }); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.protocol !== "keel-viewer-verification@1") return;
    if (event.data.action === "open") open();
    else if (event.data.action === "close") close();
    else if (event.data.action === "toggle") document.body.classList.contains("verify-open") ? close() : open();
    else if (event.data.action === "set-chrome" && (event.data.chrome === "external" || event.data.chrome === "embedded")) document.documentElement.dataset.verificationChrome = event.data.chrome;
    else if (event.data.action === "force-failure") globalThis.__VAULT_VERIFICATION_UI__?.fail("Viewer readiness", "The viewer did not finish initializing before the host deadline.");
  });
  const api = Object.freeze({
    open, close,
    ready() {
      parent.postMessage({ protocol: "keel-viewer-verification@1", action: "ready", state: currentResult.state, title: currentResult.title, proofTier: currentResult.proofTier }, "*");
    },
    fail(label, detail) {
      render(Object.freeze({ state: "failed", title: "Verification failed", summary: `${label}: ${detail}`, checks: Object.freeze([{ id: "viewer-execution", label, passed: false, detail, severity: "fatal" }]), proofTier: "Rejected render", isFixture: false, proofMode: "rejected" }));
      parent.postMessage({ protocol: "keel-viewer-verification@1", action: "state", state: "failed", title: "Verification failed", proofTier: "Rejected render" }, "*");
    },
  });
  Object.defineProperty(globalThis, "__VAULT_VERIFICATION_UI__", { value: api, configurable: false, writable: false });
  render(result);
  parent.postMessage({ protocol: "keel-viewer-verification@1", action: "mounted" }, "*");
  return api;
}

const verificationUI = presentationMode === "gallery"
  ? Object.freeze({
    ready() {
      parent.postMessage({ protocol: "keel-viewer-verification@1", action: "preview-ready", state: verification.state }, "*");
    },
    fail() {},
  })
  : mountVerificationUI(verification, runtimeData, globalThis.__KEEL_CONTEXT__);
markVaultStartup("verification-ready");
const seed = contextData?.derivedTokenSeed;
if (typeof seed !== "string" || !/^0x[0-9a-f]{64}$/.test(seed)) throw new Error("Keel token.seed was not injected");
const bytes = Array.from({ length: 32 }, (_, index) => Number.parseInt(seed.slice(2 + index * 2, 4 + index * 2), 16));
const packedAttributes = contextData?.packedAttributes ?? localParams.get("attributes");
if (typeof packedAttributes !== "string" || !/^0x[0-9a-f]{64}$/i.test(packedAttributes)) throw new Error("Committed packed attributes were not injected");
const attributeBytes = Array.from({ length: 32 }, (_, index) => Number.parseInt(packedAttributes.slice(2 + (31 - index) * 2, 4 + (31 - index) * 2), 16));
const assetId = (contextData?.assetId ?? localParams.get("assetId"))?.toLowerCase();
const [weaponAttributeCatalog, vaultGameAtlas] = await Promise.all([
  fetch("/content/weapon-attributes.json").then((response) => {
    if (!response.ok) throw new Error(`Weapon codex failed: ${response.status}`);
    return response.json();
  }),
  fetch("/content/vault-game-atlas.json").then((response) => {
    if (!response.ok) throw new Error(`Vault game atlas failed: ${response.status}`);
    return response.json();
  }),
]);
markVaultStartup("catalogs-ready");
const selectedWeapon = Object.entries(weaponAttributeCatalog.weapons).find(([, definition]) => definition.assetId?.toLowerCase() === assetId)?.[0]
  ?? (globalThis.__KEEL_CONTEXT__ == null
    ? Object.keys(weaponAttributeCatalog.weapons)[attributeBytes[0] % Object.keys(weaponAttributeCatalog.weapons).length]
    : undefined);
if (!selectedWeapon) throw new Error(`The committed weapon assetId is not present in this codex revision: ${assetId ?? "missing"}`);
const tokenId = contextData?.tokenId ?? "?";
const choose = (values, index) => values[attributeBytes[index] % values.length];
const SCENE_CATALOG = Object.freeze({
  scenes: Object.freeze(["grid", "grid", "grid", "grid", "grid", "constellation", "reactor", "void-horizon"]),
  backgrounds: Object.freeze([
    Object.freeze({ id: "emerald-night", colors: ["#173b32", "#07110f", "#020504"] }),
    Object.freeze({ id: "cobalt-depth", colors: ["#17345a", "#071425", "#02050b"] }),
    Object.freeze({ id: "ember-void", colors: ["#4a2518", "#160b08", "#050201"] }),
    Object.freeze({ id: "orchid-space", colors: ["#351b4a", "#12091d", "#030205"] }),
    Object.freeze({ id: "solar-dusk", colors: ["#4a3b17", "#171205", "#050401"] }),
    Object.freeze({ id: "ice-vault", colors: ["#183b45", "#08151a", "#020506"] }),
  ]),
  grids: Object.freeze([
    Object.freeze({ id: "mint", rgb: "103,246,197", hex: "#67f6c5" }),
    Object.freeze({ id: "cyan", rgb: "62,213,255", hex: "#3ed5ff" }),
    Object.freeze({ id: "violet", rgb: "184,110,255", hex: "#b86eff" }),
    Object.freeze({ id: "amber", rgb: "255,190,77", hex: "#ffbe4d" }),
    Object.freeze({ id: "rose", rgb: "255,102,142", hex: "#ff668e" }),
    Object.freeze({ id: "ice", rgb: "185,236,255", hex: "#b9ecff" }),
  ]),
  ambiences: Object.freeze(["star-drift", "pixel-rain", "orbit-rings", "emberfall", "scan-sweep", "quiet"]),
  filters: Object.freeze([
    Object.freeze({ id: "clean", css: "none" }),
    Object.freeze({ id: "soft-bloom", css: "saturate(1.12) drop-shadow(0 0 8px rgba(var(--scene-grid-rgb),.16))" }),
    Object.freeze({ id: "arcade-crisp", css: "contrast(1.12) saturate(1.08)" }),
    Object.freeze({ id: "prism-shift", css: "saturate(1.32) hue-rotate(9deg) drop-shadow(2px 0 0 rgba(255,70,190,.08))" }),
    Object.freeze({ id: "dream-glow", css: "brightness(1.05) saturate(1.18) drop-shadow(0 0 14px rgba(var(--scene-grid-rgb),.2))" }),
  ]),
});
const sceneRecipe = Object.freeze({
  scene: SCENE_CATALOG.scenes[attributeBytes[24] % SCENE_CATALOG.scenes.length],
  background: SCENE_CATALOG.backgrounds[attributeBytes[25] % SCENE_CATALOG.backgrounds.length],
  grid: SCENE_CATALOG.grids[attributeBytes[26] % SCENE_CATALOG.grids.length],
  ambience: SCENE_CATALOG.ambiences[attributeBytes[27] % SCENE_CATALOG.ambiences.length],
  filter: SCENE_CATALOG.filters[attributeBytes[28] % SCENE_CATALOG.filters.length],
});
document.documentElement.dataset.vaultScene = sceneRecipe.scene;
document.documentElement.style.setProperty("--scene-a", sceneRecipe.background.colors[0]);
document.documentElement.style.setProperty("--scene-b", sceneRecipe.background.colors[1]);
document.documentElement.style.setProperty("--scene-c", sceneRecipe.background.colors[2]);
document.documentElement.style.setProperty("--scene-grid-rgb", sceneRecipe.grid.rgb);
document.documentElement.style.setProperty("--scene-canvas-filter", sceneRecipe.filter.css);
const appearance = {
  weapon: selectedWeapon,
  shell: choose(["gunmetal", "gold", "copper", "chrome", "obsidian", "pearl"], 1),
  visor: choose(["matched", "glass", "ruby", "sapphire", "brass", "ceramic", "prism"], 2),
  coreLight: choose(["cyan", "amber", "magenta", "white", "plasma", "aurora", "eclipse", "starfire"], 3),
  rearLight: choose(["utility", "dormant", "linked-light", "titanium", "reactor", "ion", "hazard", "void"], 4),
  skin: choose(["metal", "brushed", "battle-worn", "polished", "oxidized", "prism-light"], 5),
  particle: choose(["cyan", "amber", "magenta", "white", "plasma", "aurora", "eclipse", "starfire"], 6),
  effect: choose(["clean", "pulse", "ion-trail", "prism-echo", "void-distortion", "starfire-bloom"], 7),
};
const directions = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image failed: ${source}`));
    image.src = source;
  });
}
function pixels(image) {
  const buffer = document.createElement("canvas");
  buffer.width = image.naturalWidth; buffer.height = image.naturalHeight;
  const context = buffer.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, buffer.width, buffer.height);
}
function rgba(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}
function decodeFrame(runs) {
  const output = [];
  for (const [value, count] of runs) for (let index = 0; index < count; index += 1) output.push(value);
  if (output.length !== 34 * 34) throw new Error("Invalid orb target frame");
  return output;
}

const [rawOrb, mask, panel, targets, weapon, weaponFrames, weaponRegionLayouts, weaponRegionOverrides] = await Promise.all([
  loadImage("/content/orb-core.png"),
  loadImage("/content/orb-material-mask.png"),
  loadImage("/content/orb-panel-mask.png"),
  fetch("/content/orb-targets.json").then((response) => response.json()),
  loadImage(weaponAttributeCatalog.weapons[appearance.weapon].sprite),
  Promise.all(weaponAttributeCatalog.weapons[appearance.weapon].frames.map(loadImage)),
  fetch("/content/weapon-region-layouts.json").then((response) => response.json()),
  fetch("/content/weapon-region-overrides.json").then((response) => response.json()),
]);
markVaultStartup("visual-assets-ready");
const weaponSpec = weaponAttributeCatalog.weapons[appearance.weapon];
const weaponMaterialBuild = materialBuildFromPackedAttributes(weaponAttributeCatalog, packedAttributes, appearance.weapon);
const weaponBuild = weaponMaterialBuild.attributes;
const weaponSoundCatalog = await fetch("/content/weapon-sounds.json").then((response) => response.json());
const weaponSoundProfile = weaponSoundCatalog.profiles.find((profile) => profile.assetId === appearance.weapon);
if (!weaponSoundProfile) throw new Error(`Weapon sound profile missing for ${appearance.weapon}`);
const weaponSoundResource = {
  gyro: "/content/sound-gyro.ocas",
  rift: "/content/sound-rift.ocas",
  bloom: "/content/sound-bloom.ocas",
  needle: "/content/sound-needle.ocas",
}[appearance.weapon];
const weaponSoundBytes = new Uint8Array(await fetch(weaponSoundResource).then((response) => response.arrayBuffer()));
const weaponSoundVariation = weaponSoundProfile.events.find((event) => event.eventId === "attack")?.variations[0];
let audioReader;
let weaponSoundBuffer;
let weaponSoundBoot;
const soundContent = Object.freeze({
  protocol: "oca-content-gateway@1",
  manifestId: "vault-character-showcase-sounds-v1",
  bytes(resourceId) {
    if (resourceId !== weaponSoundVariation?.resourceId) throw new Error(`Unknown weapon sound resource ${resourceId}`);
    return weaponSoundBytes.slice();
  },
  text() { throw new Error("Weapon sound resources are binary"); },
  json() { throw new Error("Weapon sound resources are binary"); },
  integrity() { return undefined; },
  url() { return weaponSoundResource; },
});

function weaponHexRgb(hex) { const value = Number.parseInt(hex.slice(1), 16); return [(value >> 16) & 255, (value >> 8) & 255, value & 255]; }
function weaponMix(a, b, amount) { return Math.round(a + (b - a) * amount); }
function clamp(value, minimum = 0, maximum = 1) { return Math.max(minimum, Math.min(maximum, value)); }
function viewerLinkedLightPixel(luminance) {
  const light = ORB_LIGHT_STYLES[appearance.coreLight];
  const shadow = weaponHexRgb(light.edge), core = weaponHexRgb(light.core), amount = clamp((luminance - 48) / 207);
  return [0, 1, 2].map((channel) => weaponMix(shadow[channel], core[channel], amount));
}
const tintedWeaponFrames = Array(weaponFrames.length);
const weaponEmissiveFrames = Array(weaponFrames.length);
function tintedWeaponFrame(frameIndex) {
  if (tintedWeaponFrames[frameIndex] !== undefined) return tintedWeaponFrames[frameIndex];
  const surface = materializeWeaponFrame({
    catalog: weaponAttributeCatalog,
    layouts: weaponRegionLayouts,
    overrides: weaponRegionOverrides,
    build: weaponMaterialBuild,
    sourceImage: weaponFrames[frameIndex],
    coreStyle: ORB_LIGHT_STYLES[appearance.coreLight],
    frame: String(frameIndex),
  });
  tintedWeaponFrames[frameIndex] = surface;
  return surface;
}
const weaponEmissiveRegion = { gyro: "hub", rift: "core-light", needle: "core-light", bloom: "aperture" }[appearance.weapon];
function getWeaponEmissiveFrame(frameIndex) {
  if (weaponEmissiveFrames[frameIndex] !== undefined) return weaponEmissiveFrames[frameIndex];
  const image = tintedWeaponFrame(frameIndex);
  const surface = document.createElement("canvas"); surface.width = 96; surface.height = 96;
  const glowContext = surface.getContext("2d", { willReadFrequently: true }); glowContext.imageSmoothingEnabled = false; glowContext.drawImage(image, 0, 0);
  const framePixels = glowContext.getImageData(0, 0, 96, 96), data = framePixels.data;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    const luminance = data[offset] * .2126 + data[offset + 1] * .7152 + data[offset + 2] * .0722, pixel = offset / 4, x = pixel % 96, y = Math.floor(pixel / 96);
    const region = resolveWeaponRegion(weaponRegionLayouts, appearance.weapon, x, y, luminance, frameIndex, weaponRegionOverrides);
    if (region !== weaponEmissiveRegion) { data[offset + 3] = 0; continue; }
    const target = viewerLinkedLightPixel(Math.max(72, luminance)); data[offset] = target[0]; data[offset + 1] = target[1]; data[offset + 2] = target[2]; data[offset + 3] = Math.max(120, data[offset + 3]);
  }
  glowContext.putImageData(framePixels, 0, 0);
  weaponEmissiveFrames[frameIndex] = surface;
  return surface;
}
function currentGyroFrameIndex(time = performance.now(), speed = 1) { return vaultGyroFrameIndex(time, tintedWeaponFrames.length, speed); }
function currentGyroFrame(time = performance.now(), speed = 1) {
  const frame = currentGyroFrameIndex(time, speed);
  setDatasetIfChanged(document.documentElement, "vaultGyroFrame", String(frame));
  return tintedWeaponFrame(frame);
}
let weaponPrewarmCursor = 0;
function prewarmWeaponFrames(deadline) {
  let warmedThisTurn = 0;
  while (weaponPrewarmCursor < weaponFrames.length && (warmedThisTurn === 0 || (deadline?.timeRemaining?.() ?? 8) > 2)) {
    tintedWeaponFrame(weaponPrewarmCursor);
    getWeaponEmissiveFrame(weaponPrewarmCursor);
    weaponPrewarmCursor += 1;
    warmedThisTurn += 1;
  }
  document.documentElement.dataset.vaultWeaponFramesReady = String(weaponPrewarmCursor);
  if (weaponPrewarmCursor < weaponFrames.length) scheduleWeaponFramePrewarm();
}
function scheduleWeaponFramePrewarm() {
  if (typeof requestIdleCallback === "function") requestIdleCallback(prewarmWeaponFrames, { timeout: 250 });
  else setTimeout(() => prewarmWeaponFrames(), 0);
}
const sourcePixels = pixels(rawOrb);
const maskPixels = pixels(mask);
const panelPixels = new ImageData(34 * directions.length, 34);
const skinPixels = new ImageData(34 * directions.length, 34);
const rearPortHotspots = Array(directions.length).fill(null);
const colors = { shell: [96,96,96,255], visor: [0,255,255,255], light: [180,0,255,255], port: [255,200,0,255] };
directions.forEach((direction, frame) => {
  const components = decodeFrame(targets.componentFrames[direction]);
  const skin = decodeFrame(targets.skinFrames[direction]);
  let portX = 0, portY = 0, portPixels = 0;
  components.forEach((componentIndex, pixel) => {
    const component = targets.componentLabels[componentIndex];
    const x = pixel % 34, y = Math.floor(pixel / 34), offset = (y * panelPixels.width + frame * 34 + x) * 4;
    if (colors[component]) panelPixels.data.set(colors[component], offset);
    if (component === "shell" && !skin[pixel]) skinPixels.data.set([255,255,255,255], offset);
    if (component === "port") { portX += x; portY += y; portPixels += 1; }
  });
  if (portPixels > 0) rearPortHotspots[frame] = Object.freeze({ x: portX / portPixels, y: portY / portPixels });
});
const orb = document.createElement("canvas");
orb.width = rawOrb.naturalWidth; orb.height = rawOrb.naturalHeight;
const shellPalette = ORB_METAL_PALETTES[appearance.shell];
const port = ORB_PORT_LIGHTS[appearance.rearLight];
paintOrbMaterialAtlas({
  sourcePixels, maskPixels, panelPixels, skinPixels,
  targetContext: orb.getContext("2d"),
  shellPalette,
  visorPalette: appearance.visor === "matched" ? shellPalette : ORB_VISOR_PALETTES[appearance.visor],
  lightStyle: ORB_LIGHT_STYLES[appearance.coreLight],
  portLightStyle: port?.linkedLight ? { ...ORB_LIGHT_STYLES[appearance.coreLight], intensity: port.intensity } : port,
  skinStyle: ORB_SKIN_STYLES[appearance.skin],
});
markVaultStartup("material-atlases-ready");

const canvas = document.querySelector("#vault-character");
if (presentationMode === "gallery") canvas.setAttribute("aria-label", "Onchain rotating Vault character preview");
const context = canvas.getContext("2d");
context.imageSmoothingEnabled = false;
const setTextIfChanged = (node, value) => { if (node?.textContent !== value) node.textContent = value; };
const setDatasetIfChanged = (node, key, value) => { if (node?.dataset[key] !== value) node.dataset[key] = value; };
const setStyleIfChanged = (node, property, value) => { if (node?.style[property] !== value) node.style[property] = value; };
const pointer = { x: canvas.width * .74, y: canvas.height * .45 };
const arenaState = document.querySelector("#arena-state");
const arenaWave = document.querySelector("#arena-wave");
const arenaTime = document.querySelector("#arena-time");
const arenaKills = document.querySelector("#arena-kills");
const arenaLevel = document.querySelector("#arena-level");
const shieldFill = document.querySelector("#shield-fill");
const energyFill = document.querySelector("#energy-fill");
const xpFill = document.querySelector("#xp-fill");
const arenaFlash = document.querySelector("#arena-flash");
const touchStick = document.querySelector("#touch-stick");
const touchFire = document.querySelector("#touch-fire");
const touchEscape = document.querySelector("#touch-escape");
const touchDefend = document.querySelector("#touch-defend");
const touchCooldown = document.querySelector("#touch-cooldown");
const sceneGrid = document.querySelector(".grid");
const abilityEscape = document.querySelector("#ability-escape");
const abilityDefend = document.querySelector("#ability-defend");
const abilityCooldown = document.querySelector("#ability-cooldown");
const abilityClose = document.createElement("span"); abilityClose.id = "ability-close"; abilityClose.textContent = "Close · C"; document.querySelector(".arena-abilities")?.append(abilityClose);
const abilityCharge = document.createElement("span"); abilityCharge.id = "ability-charge"; abilityCharge.textContent = "Hold Fire · Charge"; document.querySelector(".arena-abilities")?.append(abilityCharge);
const settingsOpen = document.querySelector("#settings-open");
const settingsClose = document.querySelector("#settings-close");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const settingsPanel = document.querySelector("#settings-panel");
const keybindList = document.querySelector("#keybind-list");
const keybindReset = document.querySelector("#keybind-reset");
const gamepadStatus = document.querySelector("#gamepad-status");
const mobileDrawerToggle = document.querySelector("#mobile-drawer-toggle");
const mobileSettings = document.querySelector("#mobile-settings");
const mobileVerify = document.querySelector("#mobile-verify");
const heldActions = new Set();
let capturedBinding = null;
let inputBindings = loadInputBindings();
let gamepadState = readVaultGamepad([]);
let previousGamepadState = gamepadState;
let controllerAim = { x: 1, y: 0, active: false };
const touchMove = { x: 0, y: 0, pointerId: null };
const MOB_ARCHETYPES = VAULT_SHOWCASE_MOB_ARCHETYPES;
const MOB_ATTRIBUTE_LAYERS = VAULT_MOB_ATTRIBUTE_LAYERS;
const MOB_ABILITIES = VAULT_MOB_ABILITIES;
const MOB_VISUAL_RECIPES = createVaultMobVisualRecipes({ sceneId: sceneRecipe.grid.id, sceneColor: sceneRecipe.grid.hex, entropy: attributeBytes[25] });
const escapeStyle = selectVaultEscapeStyle(attributeBytes[29]);
const sharedWeaponCombat = VAULT_WEAPON_COMBAT_RULES[appearance.weapon];
const rolledWeapon = rollVaultWeapon(vaultGameAtlas, seed, 0, appearance.weapon);
const weaponCombat = Object.freeze({
  longRange: Object.freeze({
    ...sharedWeaponCombat.longRange,
    mode: rolledWeapon.longRange.mode,
    damage: rolledWeapon.longRange.damage,
    speed: rolledWeapon.longRange.projectileSpeed,
    cooldownMs: rolledWeapon.longRange.cooldownMs,
  }),
  closeRange: rolledWeapon.closeRange,
  charge: Object.freeze({
    ...sharedWeaponCombat.charge,
    mode: rolledWeapon.chargeAttack.mode,
    minimumMs: rolledWeapon.chargeAttack.minimumChargeMs,
    maximumMs: rolledWeapon.chargeAttack.maximumChargeMs,
    damage: rolledWeapon.chargeAttack.damage,
    speed: rolledWeapon.chargeAttack.projectileSpeed,
    radius: rolledWeapon.chargeAttack.radius,
    cooldownMs: rolledWeapon.chargeAttack.cooldownMs,
  }),
});
const PROJECTILE_STYLES = Object.freeze({
  "linked-core": Object.freeze({ id: "linked-core", mode: "linked", primary: null, secondary: null }),
  "solid-cyan": Object.freeze({ id: "solid-cyan", mode: "solid", primary: "#45f4ff", secondary: "#d9ffff" }),
  "solid-amber": Object.freeze({ id: "solid-amber", mode: "solid", primary: "#ffb83f", secondary: "#fff0b2" }),
  "solid-magenta": Object.freeze({ id: "solid-magenta", mode: "solid", primary: "#ff55df", secondary: "#ffd8fa" }),
  prism: Object.freeze({ id: "prism", mode: "prism", primary: "#ff55da", secondary: "#58f6ff" }),
  matrix: Object.freeze({ id: "matrix", mode: "matrix", primary: "#45ff73", secondary: "#d8ffe0" }),
  blood: Object.freeze({ id: "blood", mode: "blood", primary: "#ff324d", secondary: "#ffb0a9" }),
  void: Object.freeze({ id: "void", mode: "void", primary: "#9c63ff", secondary: "#eadfff" }),
  aurora: Object.freeze({ id: "aurora", mode: "aurora", primary: "#51ffd1", secondary: "#7f8cff" }),
});
const initialRandomState = bytes.slice(0, 4).reduce((value, byte) => ((value << 8) ^ byte) >>> 0, 0x6d2b79f5) || 0x6d2b79f5;
let randomState = initialRandomState;
const seededRandom = () => {
  randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
  return (randomState >>> 0) / 4294967296;
};
const arena = {
  active: false, startedAt: 0, lastFrameAt: performance.now(), lastSpawnAt: 0, nextShotAt: 0, nextCloseAt: 0, nextChargeAt: 0, restartAt: 0,
  wave: 0, kills: 0, deaths: 0, lastRunKills: 0, lastRunDurationMs: 0, spawnCount: 0, firing: false, flashUntil: 0, level: 1, experience: 0,
  nextEscapeAt: 0, nextDefendAt: 0, nextCooldownAt: 0, defendingUntil: 0, energyLockUntil: 0, energyNeedsRelease: false, weaponAnimationStartedAt: -Infinity, weaponDischargedAt: -Infinity, guardTouch: false, boosting: false, charging: false, chargeStartedAt: -Infinity, shootHeldSince: -Infinity, shootHoldTimer: 0, blinkTrail: null,
  player: { x: 0, y: 0, radius: 24, velocityX: 0, velocityY: 0, shield: 100, maxShield: 100, energy: VAULT_PLAYER_COMBAT_RULES.energy.maximum, maxEnergy: VAULT_PLAYER_COMBAT_RULES.energy.maximum, hitUntil: 0, hiddenUntil: 0, speed: 205, power: 1, haste: 1, critical: rollVaultCharacterCritical(seed) + rolledWeapon.critical, gyroProjectileId: null },
  nextProjectileId: 1, nextMobId: 1,
  camera: { x: 0, y: 0 }, closeEffect: null,
  mobs: [], projectiles: [], hostileProjectiles: [], pendingShots: [], particles: [], damagePopups: [],
};
const COMBAT_LIMITS = Object.freeze({ projectiles: 384, hostileProjectiles: 384, particles: 2048, visibleParticles: 640, damagePopups: 192 });
const runtimeBudget = { dropped: { projectiles: 0, hostileProjectiles: 0, particles: 0, damagePopups: 0 }, culledThisFrame: 0, visibleParticleLimit: COMBAT_LIMITS.visibleParticles, telemetryFrame: 0, frameSamples: new Float32Array(120), frameCursor: 0, frameCount: 0, workSamples: new Float32Array(120), workCursor: 0, workCount: 0 };
function createPool(factory, maxFree) {
  const free = [];
  return Object.freeze({
    acquire(values) { const item = free.pop() ?? factory(); Object.assign(item, values); return item; },
    release(item) { if (free.length < maxFree) free.push(item); },
    get freeCount() { return free.length; },
  });
}
const projectilePool = createPool(() => ({ trailX: new Float32Array(12), trailY: new Float32Array(12), trailLife: new Float32Array(12), trailHead: 0, trailCount: 0 }), 96);
const hostileProjectilePool = createPool(() => ({}), 96);
const particlePool = createPool(() => ({}), 512);
const damagePopupPool = createPool(() => ({}), 96);
function pushPooled(list, pool, limit, values, budgetKey) {
  if (list.length >= limit) { runtimeBudget.dropped[budgetKey] += 1; return null; }
  const item = pool.acquire(values); list.push(item); return item;
}
function removePooledAt(list, index, pool) {
  const removed = list[index];
  if (removed == null) return false;
  const last = list.pop(); if (index < list.length) list[index] = last; pool.release(removed); return true;
}
function recycleAll(list, pool) { while (list.length) pool.release(list.pop()); }
function loadInputBindings() {
  try { return sanitizeVaultBindings(JSON.parse(localStorage.getItem(VAULT_INPUT_STORAGE_KEY) ?? "null")); }
  catch { return sanitizeVaultBindings(VAULT_DEFAULT_BINDINGS); }
}
function saveInputBindings() {
  try { localStorage.setItem(VAULT_INPUT_STORAGE_KEY, JSON.stringify(inputBindings)); } catch {}
  document.documentElement.dataset.vaultInputBindings = VAULT_INPUT_ACTIONS.map((action) => `${action.id}:${inputBindings[action.id]}`).join("|");
}
function refreshControlCopy() {
  const label = (action) => vaultBindingLabel(inputBindings[action]);
  abilityEscape.textContent = `Blink · ${label("escape")}`;
  abilityDefend.textContent = `Block · RMB / ${label("block")}`;
  abilityCooldown.textContent = `Pulse · ${label("pulse")}`;
  document.querySelector("#ability-sprint").textContent = `Boost · ${label("boost")}`;
  document.querySelector(".arena-controls").innerHTML = `${label("moveUp")}${label("moveLeft")}${label("moveDown")}${label("moveRight")} · move &nbsp; ${label("boost")} · boost<br />LMB / ${label("fire")} · fire or charge &nbsp; C · close &nbsp; RMB / ${label("block")} · block<br />${label("escape")} · escape &nbsp; ${label("pulse")} · Core Flare`;
}
function renderKeybindings() {
  keybindList.replaceChildren(...VAULT_INPUT_ACTIONS.map((action) => {
    const row = document.createElement("label"); row.className = "keybind-row"; row.textContent = action.label;
    const button = document.createElement("button"); button.type = "button"; button.className = `keybind-button${capturedBinding === action.id ? " listening" : ""}`; button.dataset.action = action.id; button.textContent = capturedBinding === action.id ? "Press a key…" : vaultBindingLabel(inputBindings[action.id]);
    button.addEventListener("click", () => { capturedBinding = action.id; renderKeybindings(); button.focus(); }); row.append(button); return row;
  }));
}
function setSettingsOpen(open) {
  document.body.classList.toggle("settings-open", open); settingsOpen.setAttribute("aria-expanded", String(open)); settingsPanel.setAttribute("aria-hidden", String(!open));
  if (open) { heldActions.clear(); cancelShootHold(); arena.guardTouch = false; document.body.classList.remove("mobile-drawer-open"); mobileDrawerToggle?.setAttribute("aria-expanded", "false"); renderKeybindings(); settingsPanel.querySelector(".settings-scroll").scrollTop = 0; keybindList.querySelector("button")?.focus({ preventScroll: true }); }
  else { capturedBinding = null; renderKeybindings(); canvas.focus({ preventScroll: true }); }
}
function applyCapturedBinding(code) {
  if (!capturedBinding) return false;
  const currentCode = inputBindings[capturedBinding];
  const occupiedAction = vaultActionForCode(inputBindings, code);
  const next = { ...inputBindings, [capturedBinding]: code };
  if (occupiedAction && occupiedAction !== capturedBinding) next[occupiedAction] = currentCode;
  inputBindings = sanitizeVaultBindings(next); capturedBinding = null; saveInputBindings(); refreshControlCopy(); renderKeybindings(); return true;
}
function setMobileDrawer(open) {
  document.body.classList.toggle("mobile-drawer-open", open); mobileDrawerToggle?.setAttribute("aria-expanded", String(open)); if (mobileDrawerToggle) mobileDrawerToggle.textContent = open ? "LOADOUT ▼" : "LOADOUT ▲";
}
settingsOpen?.addEventListener("click", () => setSettingsOpen(true)); mobileSettings?.addEventListener("click", () => setSettingsOpen(true)); settingsClose?.addEventListener("click", () => setSettingsOpen(false)); settingsBackdrop?.addEventListener("click", () => setSettingsOpen(false));
keybindReset?.addEventListener("click", () => { inputBindings = sanitizeVaultBindings(VAULT_DEFAULT_BINDINGS); capturedBinding = null; saveInputBindings(); refreshControlCopy(); renderKeybindings(); });
mobileDrawerToggle?.addEventListener("click", () => setMobileDrawer(!document.body.classList.contains("mobile-drawer-open")));
mobileVerify?.addEventListener("click", () => { setMobileDrawer(false); document.querySelector("#verify-seal")?.click(); });
saveInputBindings(); refreshControlCopy(); renderKeybindings();
let verificationReadyEmitted = false;
canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = (event.clientX - rect.left) / rect.width * canvas.width;
  pointer.y = (event.clientY - rect.top) / rect.height * canvas.height;
});
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  event.preventDefault(); canvas.setPointerCapture?.(event.pointerId);
  if (event.button === 2) { arena.guardTouch = true; useDefend(performance.now()); return; }
  beginShootHold(performance.now());
});
canvas.addEventListener("pointerup", (event) => { if (event.button === 2) { arena.guardTouch = false; return; } if (event.button === 0) releaseShootHold(performance.now()); });
canvas.addEventListener("pointercancel", () => { arena.guardTouch = false; cancelShootHold(); });
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
addEventListener("keydown", (event) => {
  if (capturedBinding) { event.preventDefault(); event.stopImmediatePropagation(); if (event.code === "Escape") { capturedBinding = null; renderKeybindings(); } else applyCapturedBinding(event.code); return; }
  if (document.body.classList.contains("settings-open")) { if (event.code === "Escape") { event.preventDefault(); setSettingsOpen(false); } return; }
  if (event.code === "KeyC" && !event.repeat) { event.preventDefault(); closeAttack(performance.now()); return; }
  const arrowAction = ({ ArrowUp: "moveUp", ArrowDown: "moveDown", ArrowLeft: "moveLeft", ArrowRight: "moveRight" })[event.code];
  const action = vaultActionForCode(inputBindings, event.code) ?? arrowAction;
  if (!action) return;
  event.preventDefault(); heldActions.add(action);
  if (action === "escape" && !event.repeat) useEscape(performance.now());
  else if (action === "pulse" && !event.repeat) useCooldownAttack(performance.now());
  else if (action === "block") useDefend(performance.now());
  else if (action === "fire" && !event.repeat) beginShootHold(performance.now());
});
addEventListener("keyup", (event) => {
  const action = vaultActionForCode(inputBindings, event.code) ?? ({ ArrowUp: "moveUp", ArrowDown: "moveDown", ArrowLeft: "moveLeft", ArrowRight: "moveRight" })[event.code];
  if (!action) return; heldActions.delete(action); if (action === "fire") releaseShootHold(performance.now());
});

function updateTouchMove(event) {
  const rect = touchStick.getBoundingClientRect(), x = event.clientX - (rect.left + rect.width / 2), y = event.clientY - (rect.top + rect.height / 2);
  const length = Math.hypot(x, y) || 1, amount = Math.min(1, length / (rect.width * .36));
  touchMove.x = x / length * amount; touchMove.y = y / length * amount;
}
touchStick?.addEventListener("pointerdown", (event) => { touchMove.pointerId = event.pointerId; touchStick.setPointerCapture(event.pointerId); updateTouchMove(event); });
touchStick?.addEventListener("pointermove", (event) => { if (event.pointerId === touchMove.pointerId) updateTouchMove(event); });
const clearTouchMove = (event) => { if (event.pointerId !== touchMove.pointerId) return; touchMove.pointerId = null; touchMove.x = 0; touchMove.y = 0; };
touchStick?.addEventListener("pointerup", clearTouchMove); touchStick?.addEventListener("pointercancel", clearTouchMove);
touchFire?.addEventListener("pointerdown", (event) => { touchFire.setPointerCapture(event.pointerId); aimAtNearestMob(); beginShootHold(performance.now()); });
touchFire?.addEventListener("pointerup", () => releaseShootHold(performance.now())); touchFire?.addEventListener("pointercancel", cancelShootHold);
touchEscape?.addEventListener("pointerdown", () => useEscape(performance.now()));
touchDefend?.addEventListener("pointerdown", (event) => { touchDefend.setPointerCapture(event.pointerId); arena.guardTouch = true; useDefend(performance.now()); });
touchDefend?.addEventListener("pointerup", () => { arena.guardTouch = false; }); touchDefend?.addEventListener("pointercancel", () => { arena.guardTouch = false; });
touchCooldown?.addEventListener("pointerdown", () => useCooldownAttack(performance.now()));

function facingIndex(angle) {
  return Math.round(((angle - Math.PI / 2) / (Math.PI * 2)) * directions.length + directions.length) % directions.length;
}
async function bootWeaponSound() {
  if (weaponSoundBoot) return weaponSoundBoot;
  weaponSoundBoot = (async () => {
    audioReader = createAudioReader({ content: soundContent, noiseSeed: `${seed}:${appearance.weapon}:showcase`, maxSeconds: 5 });
    await audioReader.unlock();
    weaponSoundBuffer = audioReader.render({ codec: OCA_SOUND_BITS_CODEC, resourceId: weaponSoundVariation.resourceId });
    document.documentElement.dataset.vaultSoundLibrary = `${OCA_SOUND_BITS_CODEC}:createAudioReader`;
    document.documentElement.dataset.vaultSoundReady = "true";
  })().catch((error) => {
    weaponSoundBoot = undefined;
    document.documentElement.dataset.vaultSoundReady = "false";
    console.warn("Vault sound library could not start", error);
  });
  return weaponSoundBoot;
}
function playAttackSound() {
  if (!audioReader || !weaponSoundBuffer || !weaponSoundVariation) return;
  audioReader.playBuffer(weaponSoundBuffer, { gain: weaponSoundVariation.gain, rate: weaponSoundVariation.rate });
  document.documentElement.dataset.vaultSoundLast = `${appearance.weapon}:${weaponSoundVariation.soundId}`;
}

function showArenaFlash(message, duration = 900) {
  arenaFlash.textContent = message; arenaFlash.classList.add("show"); arena.flashUntil = performance.now() + duration;
}
function arenaIsRebooting(time) { return !arena.active && arena.restartAt > time; }
function activateArena(time) {
  if (arena.active) return true;
  if (arenaIsRebooting(time)) return false;
  arena.active = true; arena.restartAt = 0; arena.startedAt = time; arena.lastSpawnAt = time - 9999; arena.wave = 1;
  arenaState.textContent = "Survival signal active"; showArenaFlash("Wave 1 · three drone classes", 1300);
  document.documentElement.dataset.vaultArenaState = "active";
  return true;
}
function resetArena(time, { preserveFeedback = false, keepPosition = false, autoRestart = false } = {}) {
  const deathPosition = { x: arena.player.x, y: arena.player.y };
  if (autoRestart) {
    arena.deaths += 1;
    arena.lastRunKills = arena.kills;
    arena.lastRunDurationMs = arena.startedAt > 0 ? Math.max(0, time - arena.startedAt) : 0;
  }
  arena.active = false; arena.startedAt = 0; arena.wave = 0; arena.mobs.length = 0; recycleAll(arena.projectiles, projectilePool); recycleAll(arena.hostileProjectiles, hostileProjectilePool);
  arena.pendingShots.length = 0;
  if (!preserveFeedback) { recycleAll(arena.particles, particlePool); recycleAll(arena.damagePopups, damagePopupPool); }
  arena.kills = 0; arena.level = 1; arena.experience = 0; arena.spawnCount = 0; arena.player.maxShield = 100; arena.player.maxEnergy = 100; arena.player.energy = 100; arena.player.power = 1; arena.player.haste = 1; arena.player.speed = 205;
  arena.nextEscapeAt = 0; arena.nextDefendAt = 0; arena.nextCooldownAt = 0; arena.nextCloseAt = 0; arena.nextChargeAt = 0; arena.defendingUntil = 0; arena.energyLockUntil = 0; arena.energyNeedsRelease = false; arena.guardTouch = false; arena.boosting = false; arena.charging = false; clearTimeout(arena.shootHoldTimer); arena.shootHoldTimer = 0; arena.shootHeldSince = -Infinity; arena.blinkTrail = null; arena.closeEffect = null;
  arena.player.shield = arena.player.maxShield; arena.player.x = keepPosition ? deathPosition.x : 0; arena.player.y = keepPosition ? deathPosition.y : 0; arena.player.velocityX = 0; arena.player.velocityY = 0; arena.player.hitUntil = 0;
  arena.player.gyroProjectileId = null;
  arena.player.hiddenUntil = preserveFeedback ? time + 440 : 0;
  arena.camera.x = arena.player.x; arena.camera.y = arena.player.y; arena.firing = false; arena.nextShotAt = time + 450; arena.restartAt = autoRestart ? time + 1150 : 0;
  randomState = initialRandomState;
  arenaState.textContent = autoRestart ? "Core shattered · automatic reboot" : "Core rebooted · fire to wake the arena";
  showArenaFlash(autoRestart ? "Core shattered · rebooting" : preserveFeedback ? "Core shattered · rebooted" : "Core reboot", 1100);
  document.documentElement.dataset.vaultArenaState = autoRestart ? "rebooting" : "dormant";
}
function screenCenter() { return { x: canvas.width / 2, y: canvas.height / 2 }; }
function worldToScreen(x, y) { const center = screenCenter(); return { x: x - arena.camera.x + center.x, y: y - arena.camera.y + center.y }; }
function isWorldVisible(x, y, padding = 96) {
  const halfWidth = canvas.width / 2 + padding, halfHeight = canvas.height / 2 + padding;
  return Math.abs(x - arena.camera.x) <= halfWidth && Math.abs(y - arena.camera.y) <= halfHeight;
}
function aimVector() {
  if (controllerAim.active) return { x: controllerAim.x, y: controllerAim.y };
  const center = screenCenter();
  const vector = { x: pointer.x - center.x, y: pointer.y - center.y };
  const length = Math.hypot(vector.x, vector.y);
  if (length < .01) return { x: 1, y: 0 };
  vector.x /= length; vector.y /= length; return vector;
}
function updateGamepadInput(time) {
  previousGamepadState = gamepadState; gamepadState = readVaultGamepad(navigator.getGamepads?.() ?? []);
  const aimLength = Math.hypot(gamepadState.aimX, gamepadState.aimY); controllerAim.active = gamepadState.connected && aimLength > .18;
  if (controllerAim.active) { controllerAim.x = gamepadState.aimX / aimLength; controllerAim.y = gamepadState.aimY / aimLength; }
  if (gamepadState.fire && !previousGamepadState.fire) beginShootHold(time);
  else if (!gamepadState.fire && previousGamepadState.fire) releaseShootHold(time);
  if (gamepadState.escape && !previousGamepadState.escape) useEscape(time);
  if (gamepadState.pulse && !previousGamepadState.pulse) useCooldownAttack(time);
  if (gamepadState.settings && !previousGamepadState.settings) setSettingsOpen(!document.body.classList.contains("settings-open"));
  if (gamepadState.block) useDefend(time);
  gamepadStatus.textContent = gamepadState.connected ? `Connected · ${gamepadState.id}` : "No controller detected"; gamepadStatus.classList.toggle("connected", gamepadState.connected);
  document.documentElement.dataset.vaultGamepad = gamepadState.connected ? `connected:${gamepadState.id}` : "disconnected";
}
function aimAtNearestMob() {
  if (arena.mobs.length === 0) return;
  const target = arena.mobs.reduce((closest, mob) => Math.hypot(mob.x - arena.player.x, mob.y - arena.player.y) < Math.hypot(closest.x - arena.player.x, closest.y - arena.player.y) ? mob : closest);
  const screen = worldToScreen(target.x, target.y); pointer.x = screen.x; pointer.y = screen.y;
}
function addProjectile(angle, options = {}) {
  const speed = options.speed ?? 580;
  const spawnOffset = options.spawnOffset ?? 42;
  const projectile = pushPooled(arena.projectiles, projectilePool, COMBAT_LIMITS.projectiles, {
    id: arena.nextProjectileId++,
    x: arena.player.x + Math.cos(angle) * spawnOffset, y: arena.player.y + Math.sin(angle) * spawnOffset,
    launchX: arena.player.x, launchY: arena.player.y, spawnOffset, launchedAt: options.launchedAt ?? performance.now(),
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    radius: options.radius ?? 5, damage: (options.damage ?? 20) * arena.player.power, life: options.life ?? .86, pierce: options.pierce ?? 1, critical: options.critical ?? false,
    kind: options.kind ?? appearance.weapon, style: weaponBuild["projectile-style"] ?? "linked-core", spin: seededRandom() * Math.PI * 2,
    trailHead: 0, trailCount: 0, boomerang: false, returning: false, returnAt: Infinity, returnSpeed: 0, hit: new Set(),
  }, "projectiles");
  if (projectile) projectile.trailLife.fill(0);
  return projectile;
}
function emitBurst(x, y, style, count = 9, scale = 1, palette = null) {
  for (let index = 0; index < count; index += 1) {
    const angle = seededRandom() * Math.PI * 2, speed = (35 + seededRandom() * 115) * scale;
    pushPooled(arena.particles, particlePool, COMBAT_LIMITS.particles, { x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .28 + seededRandom() * .44, maxLife: .72, size: 2 + seededRandom() * 4, style, primary: palette?.primary ?? null, secondary: palette?.secondary ?? null }, "particles");
  }
}
function addDamagePopup(x, y, amount, critical = false) {
  pushPooled(arena.damagePopups, damagePopupPool, COMBAT_LIMITS.damagePopups, { x, y, amount: Math.round(amount), critical, life: .72, maxLife: .72 }, "damagePopups");
}
function grantKill(mob, time) {
  arena.kills += 1; arena.experience += 1;
  const visual = mob.visual ?? MOB_VISUAL_RECIPES[0], scale = mob.elite ? 1.85 : 1.2;
  emitBurst(mob.x, mob.y, "mob-body", mob.elite ? 30 : 16, scale, { primary: visual.bodyPrimary, secondary: visual.bodySecondary });
  emitBurst(mob.x, mob.y, "mob-core", mob.elite ? 24 : 10, scale * 1.1, { primary: visual.core, secondary: visual.trim });
  const needed = 3 + arena.level * 2;
  if (arena.experience < needed) return;
  arena.experience -= needed; arena.level += 1;
  const growth = ["power", "haste", "shield", "speed"][(attributeBytes[(arena.level + 17) % attributeBytes.length] + arena.level) % 4];
  if (growth === "power") arena.player.power *= 1.09;
  else if (growth === "haste") arena.player.haste *= 1.08;
  else if (growth === "shield") { arena.player.maxShield += 10; arena.player.shield = Math.min(arena.player.maxShield, arena.player.shield + 18); }
  else arena.player.speed += 12;
  showArenaFlash(`Level ${arena.level} · ${growth} increased`, 1200);
}
function resolveWeaponShot(time, angle) {
  if (appearance.weapon === "gyro" && arena.player.gyroProjectileId !== null) return false;
  arena.weaponDischargedAt = time;
  const spec = weaponCombat.longRange, count = spec.count ?? 1;
  const critical = seededRandom() < arena.player.critical;
  const damage = Math.round(spec.damage * (critical ? 1.8 : 1));
  for (let index = 0; index < count; index += 1) {
    const projectile = addProjectile(angle + (index - (count - 1) / 2) * (spec.spread ?? 0), { spawnOffset: 42, launchedAt: time, speed: spec.speed, radius: spec.radius, damage: count > 1 ? Math.round(damage * .56) : damage, life: appearance.weapon === "gyro" ? 2.1 : 2.2, pierce: spec.pierce, kind: appearance.weapon, critical });
    if (appearance.weapon === "gyro" && projectile) {
      armVaultGyroProjectile(projectile, { now: time, returnDelayMs: spec.returnDelayMs, returnSpeed: spec.speed * spec.returnSpeedScale });
      arena.player.gyroProjectileId = projectile.id;
    }
  }
  const muzzle = { x: arena.player.x + Math.cos(angle) * 45, y: arena.player.y + Math.sin(angle) * 45 };
  emitBurst(muzzle.x, muzzle.y, weaponBuild["projectile-style"] ?? "linked-core", 8, .75); playAttackSound();
  return true;
}
function fireWeapon(time, forced = false) {
  if (!forced && !arena.firing) return false;
  if (!activateArena(time)) return false;
  if (time < arena.nextShotAt) return false;
  if (appearance.weapon === "gyro" && arena.player.gyroProjectileId !== null) { showArenaFlash("Gyro Saw is returning", 800); return false; }
  if (matchMedia("(pointer: coarse)").matches) aimAtNearestMob();
  const aim = aimVector(), angle = Math.atan2(aim.y, aim.x);
  const period = weaponCombat.longRange.cooldownMs;
  arena.weaponAnimationStartedAt = time;
  if (!resolveWeaponShot(time, angle)) return false;
  arena.nextShotAt = time + period / arena.player.haste;
  document.documentElement.dataset.vaultArenaLastFire = `${appearance.weapon}:${Math.round(time)}`;
  return true;
}
function beginShootHold(time) {
  if (arenaIsRebooting(time) || Number.isFinite(arena.shootHeldSince)) return false;
  void bootWeaponSound(); arena.shootHeldSince = time; clearTimeout(arena.shootHoldTimer);
  arena.shootHoldTimer = setTimeout(() => startCharge(arena.shootHeldSince), VAULT_PLAYER_COMBAT_RULES.charge.holdMs);
  return true;
}
function cancelShootHold() {
  clearTimeout(arena.shootHoldTimer); arena.shootHoldTimer = 0; arena.shootHeldSince = -Infinity; arena.charging = false;
}
function releaseShootHold(time) {
  if (!Number.isFinite(arena.shootHeldSince)) return false;
  clearTimeout(arena.shootHoldTimer); arena.shootHoldTimer = 0;
  const wasCharging = arena.charging; arena.shootHeldSince = -Infinity;
  return wasCharging ? releaseCharge(time) : fireWeapon(time, true);
}
function startCharge(time) {
  if (arenaIsRebooting(time) || arena.charging || time < arena.energyLockUntil || arena.energyNeedsRelease || time < arena.nextChargeAt || arena.player.energy < VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy) return false;
  if (appearance.weapon === "gyro" && arena.player.gyroProjectileId !== null) { showArenaFlash("Gyro Saw is returning", 800); return false; }
  arena.charging = true; arena.chargeStartedAt = time; arena.weaponAnimationStartedAt = time; arena.firing = false; showArenaFlash("Weapon charging", 420); return true;
}
function releaseCharge(time) {
  if (!arena.charging) return false;
  const spec = weaponCombat.charge, duration = Math.max(0, time - arena.chargeStartedAt), charge = clamp((duration - spec.minimumMs) / (spec.maximumMs - spec.minimumMs)); arena.charging = false;
  activateArena(time); const aim = aimVector(), angle = Math.atan2(aim.y, aim.x), cost = VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy + charge * (VAULT_PLAYER_COMBAT_RULES.charge.maximumEnergy - VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy), strength = .55 + charge * .45;
  if (arena.player.energy < cost) return false;
  arena.player.energy -= cost; arena.weaponDischargedAt = time; arena.nextChargeAt = time + spec.cooldownMs;
  const count = spec.count ?? 1;
  const multiShotDamageScale = spec.mode === "stellar-bloom" ? .46 : spec.mode === "needle-tempest" ? .5 : 1;
  for (let index = 0; index < count; index += 1) {
    const projectile = addProjectile(angle + (index - (count - 1) / 2) * (spec.spread ?? 0), { spawnOffset: 44, launchedAt: time, speed: spec.speed, radius: Math.round(spec.radius * (.8 + charge * .45)), damage: Math.max(1, Math.round(spec.damage * strength * multiShotDamageScale)), life: appearance.weapon === "gyro" ? 2.8 : 1.8, pierce: spec.pierce, kind: `${appearance.weapon}-charge`, critical: charge >= .98 });
    if (appearance.weapon === "gyro" && projectile) {
      armVaultGyroProjectile(projectile, { now: time, returnDelayMs: spec.returnDelayMs, returnSpeed: spec.speed * spec.returnSpeedScale });
      arena.player.gyroProjectileId = projectile.id;
    }
  }
  const muzzle = { x: arena.player.x + aim.x * 78, y: arena.player.y + aim.y * 78 }; emitBurst(muzzle.x, muzzle.y, weaponBuild["projectile-style"] ?? "linked-core", 18 + Math.floor(charge * 18), 1 + charge); playAttackSound(); showArenaFlash(`Charged ${Math.round(charge * 100)}%`, 620); return true;
}

function closeAttack(time) {
  if (arenaIsRebooting(time) || time < arena.nextCloseAt) return false;
  if (!activateArena(time)) return false;
  const spec = weaponCombat.closeRange;
  arena.nextCloseAt = time + spec.cooldownMs / arena.player.haste;
  arena.weaponAnimationStartedAt = time;
  arena.closeEffect = { startedAt: time, until: time + 320, radius: spec.radius, mode: spec.mode };
  emitBurst(arena.player.x, arena.player.y, weaponBuild["projectile-style"] ?? "linked-core", 18, 1.1);
  for (let index = arena.mobs.length - 1; index >= 0; index -= 1) {
    const mob = arena.mobs[index];
    if (Math.hypot(mob.x - arena.player.x, mob.y - arena.player.y) > spec.radius + mob.radius) continue;
    mob.health -= spec.damage * arena.player.power; mob.hitUntil = time + 110;
    addDamagePopup(mob.x, mob.y - mob.radius, spec.damage * arena.player.power, false);
    if (mob.health <= 0) { arena.mobs.splice(index, 1); grantKill(mob, time); }
  }
  for (let index = arena.hostileProjectiles.length - 1; index >= 0; index -= 1) {
    const projectile = arena.hostileProjectiles[index];
    if (Math.hypot(projectile.x - arena.player.x, projectile.y - arena.player.y) <= spec.radius) removePooledAt(arena.hostileProjectiles, index, hostileProjectilePool);
  }
  showArenaFlash(spec.mode, 520);
  return true;
}

function useEscape(time) {
  if (arenaIsRebooting(time) || time < arena.nextEscapeAt) return false;
  let x = touchMove.x + gamepadState.moveX + (heldActions.has("moveRight") ? 1 : 0) - (heldActions.has("moveLeft") ? 1 : 0);
  let y = touchMove.y + gamepadState.moveY + (heldActions.has("moveDown") ? 1 : 0) - (heldActions.has("moveUp") ? 1 : 0);
  const aim = aimVector();
  const vector = resolveVaultEscapeVector({ moveX: x, moveY: y, velocityX: arena.player.velocityX, velocityY: arena.player.velocityY, aimX: aim.x, aimY: aim.y, style: escapeStyle, side: attributeBytes[30] % 2 ? 1 : -1 });
  x = vector.x; y = vector.y;
  const fromX = arena.player.x, fromY = arena.player.y;
  emitBurst(fromX, fromY, "linked-core", escapeStyle.effect === "afterimages" ? 10 : 16, 1.4); arena.player.x += x * escapeStyle.distance; arena.player.y += y * escapeStyle.distance; emitBurst(arena.player.x, arena.player.y, "linked-core", 18, 1.4);
  arena.blinkTrail = { fromX, fromY, toX: arena.player.x, toY: arena.player.y, effect: escapeStyle.effect, startedAt: time, until: time + Math.max(480, escapeStyle.invulnerableMs) };
  arena.player.hitUntil = Math.max(arena.player.hitUntil, time + escapeStyle.invulnerableMs);
  document.documentElement.dataset.vaultEscapeVector = `${escapeStyle.id}:${vector.source}:${x.toFixed(3)},${y.toFixed(3)}:${escapeStyle.distance}`;
  arena.nextEscapeAt = time + escapeStyle.cooldownMs; showArenaFlash(escapeStyle.name, 520); return true;
}
function useDefend(time) {
  if (arenaIsRebooting(time) || time < arena.energyLockUntil || arena.energyNeedsRelease || arena.player.energy <= 0) return false;
  arena.defendingUntil = time + 140; arena.nextDefendAt = time + 140; return true;
}
function useCooldownAttack(time) {
  if (arenaIsRebooting(time) || time < arena.nextCooldownAt) return false;
  const rule = VAULT_PLAYER_COMBAT_RULES.pulse, aim = aimVector(), minimumDot = Math.cos(rule.arcDegrees / 2 * Math.PI / 180);
  arena.nextCooldownAt = time + rule.cooldownMs; emitBurst(arena.player.x, arena.player.y, "linked-core", 38, 2.2);
  for (let index = arena.mobs.length - 1; index >= 0; index -= 1) {
    const mob = arena.mobs[index], dx = mob.x - arena.player.x, dy = mob.y - arena.player.y, distance = Math.hypot(dx, dy); if (distance > rule.radius || (dx / distance) * aim.x + (dy / distance) * aim.y < minimumDot) continue;
    const damage = rule.damage * arena.player.power; mob.health -= damage; addDamagePopup(mob.x, mob.y, damage, true);
    if (mob.health <= 0) { arena.mobs.splice(index, 1); grantKill(mob, time); }
  }
  showArenaFlash("Core Flare", 650); return true;
}

function spawnMob(time, overrides = {}) {
  const definition = MOB_ARCHETYPES.find((entry) => entry.id === overrides.archetype) ?? MOB_ARCHETYPES[arena.spawnCount % MOB_ARCHETYPES.length], edge = Math.floor(seededRandom() * 4), range = canvas.width * .58;
  let x = arena.player.x + (seededRandom() * 2 - 1) * range, y = arena.player.y + (seededRandom() * 2 - 1) * range;
  if (edge === 0) y = arena.player.y - range; else if (edge === 1) x = arena.player.x + range; else if (edge === 2) y = arena.player.y + range; else x = arena.player.x - range;
  if (Number.isFinite(overrides.x)) x = arena.player.x + Number(overrides.x);
  if (Number.isFinite(overrides.y)) y = arena.player.y + Number(overrides.y);
  const scale = 1 + (arena.wave - 1) * .13, variant = overrides.variant ?? Math.floor(seededRandom() * MOB_VISUAL_RECIPES.length), elite = overrides.elite ?? (seededRandom() < Math.min(.2, .025 + arena.wave * .012));
  const abilities = overrides.abilities ?? selectVaultMobAbilities({ elite, variant, spawnCount: arena.spawnCount, roll: seededRandom() });
  const maxHealth = definition.health * scale * (elite ? 2.15 : 1);
  const mob = { ...definition, entityId: arena.nextMobId++, x, y, elite, variant, visual: MOB_VISUAL_RECIPES[variant], abilities, abilityIndex: 0, maxHealth, health: maxHealth, radius: definition.radius * (elite ? 1.2 : 1), speed: definition.speed * (elite ? 1.08 : 1), phase: seededRandom() * Math.PI * 2, nextActionAt: time + 700 + seededRandom() * 900, nextAbilityAt: time + 1300 + seededRandom() * 1600, contactAt: 0, rushUntil: 0 };
  arena.mobs.push(mob);
  arena.spawnCount += 1;
  return mob;
}
function hostileShot(mob, speed, damage, kind = "bullet", angleOffset = 0) {
  const angle = Math.atan2(arena.player.y - mob.y, arena.player.x - mob.x) + angleOffset, visual = mob.visual ?? MOB_VISUAL_RECIPES[0];
  pushPooled(arena.hostileProjectiles, hostileProjectilePool, COMBAT_LIMITS.hostileProjectiles, { x: mob.x, y: mob.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, speed, radius: kind === "exploder" ? 12 : kind === "laser" ? 4 : 5, damage, life: kind === "laser" ? 1.15 : 3, kind, primary: visual.core, secondary: visual.trim, homing: kind === "homer" ? .075 : 0 }, "hostileProjectiles");
}
function triggerMobAbility(mob, time, distance) {
  if (!mob.abilities?.length || time < mob.nextAbilityAt) return;
  const ability = mob.abilities[mob.abilityIndex++ % mob.abilities.length], rule = VAULT_MOB_ABILITY_RULES[ability], damage = (mob.elite ? 10 : 6) + arena.wave * .65;
  if (rule?.mode === "projectile") {
    const count = rule.count ?? 1;
    for (let index = 0; index < count; index += 1) hostileShot(mob, rule.speed, damage * rule.damageScale, ability === "bullets" ? "bullet" : ability, (index - (count - 1) / 2) * (rule.spread ?? 0));
  } else if (ability === "aoe") { emitBurst(mob.x, mob.y, "mob-core", 24, 1.5, { primary: mob.visual.core, secondary: mob.visual.trim }); if (distance < rule.radius) hurtPlayer(damage * rule.damageScale, time); }
  else if (ability === "blink") { const angle = seededRandom() * Math.PI * 2; emitBurst(mob.x, mob.y, "mob-core", 10, .8, { primary: mob.visual.core, secondary: mob.visual.trim }); mob.x += Math.cos(angle) * rule.distance; mob.y += Math.sin(angle) * rule.distance; }
  else if (ability === "rush") mob.rushUntil = time + rule.durationMs;
  mob.nextAbilityAt = time + (mob.elite ? 1350 : 2600) + seededRandom() * 1100;
}
function hurtPlayer(amount, time) {
  if (time < arena.player.hitUntil) return;
  if (time < arena.defendingUntil) amount *= VAULT_PLAYER_COMBAT_RULES.block.damageScale;
  arena.player.shield = Math.max(0, arena.player.shield - amount); arena.player.hitUntil = time + 420;
  addDamagePopup(arena.player.x, arena.player.y - 34, amount, false); emitBurst(arena.player.x, arena.player.y, "linked-core", 10, .7);
  if (arena.player.shield === 0) {
    emitBurst(arena.player.x, arena.player.y, "linked-core", 34, 2.55);
    emitBurst(arena.player.x, arena.player.y, "character-shell", 24, 2.15);
    resetArena(time, { preserveFeedback: true, keepPosition: true, autoRestart: true });
  }
}
function updateArena(time, delta) {
  updateGamepadInput(time);
  if (document.body.classList.contains("settings-open")) return;
  let moveX = touchMove.x + gamepadState.moveX + (heldActions.has("moveRight") ? 1 : 0) - (heldActions.has("moveLeft") ? 1 : 0);
  let moveY = touchMove.y + gamepadState.moveY + (heldActions.has("moveDown") ? 1 : 0) - (heldActions.has("moveUp") ? 1 : 0);
  if (arenaIsRebooting(time)) { moveX = 0; moveY = 0; }
  const moveLength = Math.hypot(moveX, moveY) || 1; if (moveLength > 1) { moveX /= moveLength; moveY /= moveLength; }
  const wantsGuard = heldActions.has("block") || arena.guardTouch || gamepadState.block;
  const wantsBoost = heldActions.has("boost") || gamepadState.boost || (touchMove.pointerId !== null && Math.hypot(touchMove.x, touchMove.y) > .88);
  if (arena.energyNeedsRelease && !wantsGuard && !wantsBoost) arena.energyNeedsRelease = false;
  const energyReady = time >= arena.energyLockUntil && !arena.energyNeedsRelease && arena.player.energy > 0;
  const guarding = wantsGuard && energyReady, sprinting = wantsBoost && !guarding && energyReady;
  if (guarding) { arena.player.energy = Math.max(0, arena.player.energy - VAULT_PLAYER_COMBAT_RULES.block.energyPerSecond * delta); arena.defendingUntil = time + 90; }
  else if (sprinting) arena.player.energy = Math.max(0, arena.player.energy - VAULT_PLAYER_COMBAT_RULES.boost.energyPerSecond * delta);
  else if (time >= arena.energyLockUntil) arena.player.energy = Math.min(arena.player.maxEnergy, arena.player.energy + VAULT_PLAYER_COMBAT_RULES.energy.recoveryPerSecond * delta);
  if ((guarding || sprinting) && arena.player.energy <= 0) {
    arena.player.energy = 0; arena.energyLockUntil = time + VAULT_PLAYER_COMBAT_RULES.energy.bustLockoutMs; arena.energyNeedsRelease = true; arena.guardTouch = false; arena.defendingUntil = 0;
    emitBurst(arena.player.x, arena.player.y, "linked-core", 20, 1.25); showArenaFlash("Energy busted · one second lockout", 900);
  }
  arena.boosting = sprinting;
  const speed = arena.player.speed * (sprinting ? VAULT_PLAYER_COMBAT_RULES.boost.speedScale : 1);
  const velocityBlend = Math.hypot(moveX, moveY) > .04 ? .52 : .16;
  arena.player.velocityX += (moveX * speed - arena.player.velocityX) * velocityBlend;
  arena.player.velocityY += (moveY * speed - arena.player.velocityY) * velocityBlend;
  arena.player.x += moveX * speed * delta; arena.player.y += moveY * speed * delta;
  const cameraBlend = 1 - Math.pow(.00008, delta); arena.camera.x += (arena.player.x - arena.camera.x) * cameraBlend; arena.camera.y += (arena.player.y - arena.camera.y) * cameraBlend;
  if (runtimeBudget.telemetryFrame % 4 === 0) {
    abilityEscape?.classList.toggle("ready", time >= arena.nextEscapeAt); abilityDefend?.classList.toggle("ready", energyReady); abilityCooldown?.classList.toggle("ready", time >= arena.nextCooldownAt); abilityClose.classList.toggle("ready", time >= arena.nextCloseAt);
    setTextIfChanged(abilityDefend, time < arena.energyLockUntil ? "Energy busted" : "Block · RMB / E");
    abilityCharge.classList.toggle("ready", time >= arena.nextChargeAt && arena.player.energy >= VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy); setTextIfChanged(abilityCharge, arena.charging ? `Charging · ${Math.round(clamp((time - arena.chargeStartedAt) / weaponCombat.charge.maximumMs) * 100)}%` : "Hold Fire · Charge");
    setDatasetIfChanged(touchEscape, "cooling", String(time < arena.nextEscapeAt)); setDatasetIfChanged(touchDefend, "cooling", String(!energyReady)); setDatasetIfChanged(touchCooldown, "cooling", String(time < arena.nextCooldownAt));
    setDatasetIfChanged(document.documentElement, "vaultEnergyState", time < arena.energyLockUntil ? "busted" : energyReady ? "ready" : "recovering");
  }
  for (let index = arena.particles.length - 1; index >= 0; index -= 1) { const particle = arena.particles[index]; particle.x += particle.vx * delta; particle.y += particle.vy * delta; particle.vx *= Math.pow(.08, delta); particle.vy *= Math.pow(.08, delta); particle.life -= delta; if (particle.life <= 0) removePooledAt(arena.particles, index, particlePool); }
  for (let index = arena.damagePopups.length - 1; index >= 0; index -= 1) { const popup = arena.damagePopups[index]; popup.y -= 34 * delta; popup.life -= delta; if (popup.life <= 0) removePooledAt(arena.damagePopups, index, damagePopupPool); }
  if (!arena.active && arena.restartAt > 0 && time >= arena.restartAt) {
    activateArena(time);
    arenaState.textContent = "Core restored · survival signal active";
    showArenaFlash("Core restored · Wave 1", 1000);
  }
  if (!arena.active) return;
  const elapsed = time - arena.startedAt, nextWave = Math.floor(elapsed / 12000) + 1;
  if (nextWave !== arena.wave) { arena.wave = nextWave; showArenaFlash(`Wave ${arena.wave} · pressure rising`, 950); }
  const spawnInterval = Math.max(360, 1550 - arena.wave * 105), cap = Math.min(33, 3 + (arena.wave - 1) * 3);
  if (arena.mobs.length < cap && time - arena.lastSpawnAt >= spawnInterval) { spawnMob(time); arena.lastSpawnAt = time; }
  for (const mob of arena.mobs) {
    const dx = arena.player.x - mob.x, dy = arena.player.y - mob.y, distance = Math.hypot(dx, dy) || 1;
    triggerMobAbility(mob, time, distance);
    if (mob.id === "wisp") {
      const preferred = 225, direction = distance > preferred + 28 ? 1 : distance < preferred - 28 ? -1 : 0;
      mob.x += dx / distance * mob.speed * direction * delta; mob.y += dy / distance * mob.speed * direction * delta;
      if (time >= mob.nextActionAt) { hostileShot(mob, 220 + arena.wave * 8, 6 + arena.wave * .7, "bullet"); mob.nextActionAt = time + Math.max(620, 1550 - arena.wave * 55); }
    } else {
      const burst = time < mob.rushUntil || (mob.id === "bulwark" && time >= mob.nextActionAt) ? 2.8 : 1;
      mob.x += dx / distance * mob.speed * burst * (1 + arena.wave * .025) * delta; mob.y += dy / distance * mob.speed * burst * (1 + arena.wave * .025) * delta;
      if (burst > 1) mob.nextActionAt = time + Math.max(1100, 2600 - arena.wave * 60);
    }
    if (distance < mob.radius + 42 && time >= mob.contactAt) { hurtPlayer(mob.contact + arena.wave * .45, time); mob.contactAt = time + 720; }
  }
  for (let index = arena.projectiles.length - 1; index >= 0; index -= 1) {
    const projectile = arena.projectiles[index], trailSlot = projectile.trailHead;
    projectile.trailX[trailSlot] = projectile.x; projectile.trailY[trailSlot] = projectile.y; projectile.trailLife[trailSlot] = .24;
    projectile.trailHead = (trailSlot + 1) % projectile.trailX.length; projectile.trailCount = Math.min(projectile.trailX.length, projectile.trailCount + 1);
    updateVaultGyroProjectile(projectile, arena.player, time);
    projectile.x += projectile.vx * delta; projectile.y += projectile.vy * delta; projectile.life -= delta;
    if (projectile.kind !== "gyro" && projectile.kind !== "gyro-charge") projectile.spin += delta * 12;
    for (let trailIndex = 0; trailIndex < projectile.trailCount; trailIndex += 1) projectile.trailLife[trailIndex] -= delta;
    let remove = projectile.life <= 0 || (projectile.boomerang && projectile.returning && Math.hypot(projectile.x - arena.player.x, projectile.y - arena.player.y) < projectile.radius + arena.player.radius + 4);
    for (let mobIndex = arena.mobs.length - 1; mobIndex >= 0 && !remove; mobIndex -= 1) {
      const mob = arena.mobs[mobIndex]; if (Math.hypot(projectile.x - mob.x, projectile.y - mob.y) > projectile.radius + mob.radius) continue;
      const hitKey = vaultProjectileHitKey(projectile, mob.entityId); if (projectile.hit.has(hitKey)) continue; projectile.hit.add(hitKey);
      mob.health -= projectile.damage; mob.hitUntil = time + 110; addDamagePopup(mob.x, mob.y - mob.radius, projectile.damage, projectile.critical || projectile.damage >= 34); emitBurst(projectile.x, projectile.y, projectile.style, 7, .65);
      if (mob.health <= 0) { arena.mobs.splice(mobIndex, 1); grantKill(mob, time); }
      projectile.pierce -= 1; if (projectile.pierce <= 0) remove = true;
    }
    if (remove) { if (arena.player.gyroProjectileId === projectile.id) arena.player.gyroProjectileId = null; removePooledAt(arena.projectiles, index, projectilePool); }
  }
  for (let index = arena.hostileProjectiles.length - 1; index >= 0; index -= 1) {
    const projectile = arena.hostileProjectiles[index];
    if (projectile.homing) { const target = Math.atan2(arena.player.y - projectile.y, arena.player.x - projectile.x), current = Math.atan2(projectile.vy, projectile.vx), turn = Math.atan2(Math.sin(target - current), Math.cos(target - current)) * projectile.homing; projectile.vx = Math.cos(current + turn) * projectile.speed; projectile.vy = Math.sin(current + turn) * projectile.speed; }
    projectile.x += projectile.vx * delta; projectile.y += projectile.vy * delta; projectile.life -= delta;
    if (Math.hypot(projectile.x - arena.player.x, projectile.y - arena.player.y) < projectile.radius + 36) { hurtPlayer(projectile.damage, time); if (arena.hostileProjectiles[index] === projectile) removePooledAt(arena.hostileProjectiles, index, hostileProjectilePool); continue; }
    if (projectile.life <= 0) { if (projectile.kind === "exploder" && Math.hypot(projectile.x - arena.player.x, projectile.y - arena.player.y) < 145) hurtPlayer(projectile.damage, time); if (arena.hostileProjectiles[index] === projectile) removePooledAt(arena.hostileProjectiles, index, hostileProjectilePool); }
  }
}

function drawMob(mob, time, light) {
  if (!isWorldVisible(mob.x, mob.y, mob.radius + 42)) { runtimeBudget.culledThisFrame += 1; return; }
  const screen = worldToScreen(mob.x, mob.y);
  const visual = mob.visual ?? MOB_VISUAL_RECIPES[0];
  const crowded = arena.mobs.length > 24;
  const pulse = .88 + Math.sin(time * .005 + mob.phase) * .08;
  context.save(); context.translate(screen.x, screen.y); context.scale(pulse, pulse);
  if (!crowded && time < (mob.hitUntil ?? 0)) { context.shadowColor = "#ffffff"; context.shadowBlur = 18; }
  context.fillStyle = "rgba(0,0,0,.34)"; context.beginPath(); context.ellipse(0, mob.radius + 10, mob.radius * 1.15, 7, 0, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "#020504"; context.lineWidth = 4;
  if (mob.id === "drifter") {
    context.fillStyle = visual.bodyPrimary; context.strokeStyle = visual.trim; for (let index = 0; index < 6; index += 1) { const angle = index * Math.PI / 3 + time * .001; context.beginPath(); context.moveTo(Math.cos(angle) * 10, Math.sin(angle) * 10); context.lineTo(Math.cos(angle) * 27, Math.sin(angle) * 27); context.stroke(); }
    context.strokeStyle = "#020504";
    context.beginPath(); context.arc(0, 0, mob.radius, 0, Math.PI * 2); context.fill(); context.stroke();
  } else if (mob.id === "wisp") {
    context.rotate(Math.sin(time * .0015 + mob.phase) * .18); context.fillStyle = visual.bodyPrimary; context.beginPath(); context.moveTo(0, -mob.radius - 5); context.lineTo(mob.radius + 5, 0); context.lineTo(0, mob.radius + 5); context.lineTo(-mob.radius - 5, 0); context.closePath(); context.fill(); context.stroke();
  } else {
    context.fillStyle = visual.bodyPrimary; context.beginPath(); for (let index = 0; index < 8; index += 1) { const angle = index * Math.PI / 4, radius = index % 2 ? mob.radius : mob.radius + 5; context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius); } context.closePath(); context.fill(); context.stroke();
    context.strokeStyle = visual.trim; context.lineWidth = 5; context.beginPath(); context.arc(0, 0, mob.radius - 7, -.8, .8); context.stroke();
  }
  context.strokeStyle = visual.bodySecondary; context.lineWidth = 3; context.beginPath(); context.arc(0, 0, mob.radius * .66, Math.PI * .15, Math.PI * 1.35); context.stroke();
  const floaterCount = crowded && !mob.elite ? 0 : visual.floater === "none" ? 0 : visual.floater === "satellite-pair" ? 2 : visual.floater === "winglets" ? 4 : visual.floater === "halo-shards" ? 5 : 3;
  for (let index = 0; index < floaterCount; index += 1) { const orbit = time * .0014 * (index % 2 ? -1 : 1) + mob.phase + index * Math.PI * 2 / floaterCount, distance = mob.radius + 9 + index % 2 * 4; context.fillStyle = index % 2 ? visual.trim : visual.bodySecondary; context.fillRect(Math.round(Math.cos(orbit) * distance - 2), Math.round(Math.sin(orbit) * distance - 2), mob.elite ? 6 : 4, mob.elite ? 6 : 4); }
  if (mob.elite) { context.strokeStyle = visual.core; context.lineWidth = 2; context.globalAlpha = .7; context.beginPath(); context.arc(0, 0, mob.radius + 12 + Math.sin(time * .006) * 3, 0, Math.PI * 2); context.stroke(); context.globalAlpha = 1; }
  const coreColor = visual.core;
  context.globalCompositeOperation = "lighter"; context.fillStyle = coreColor; if (!crowded) { context.shadowColor = coreColor; context.shadowBlur = 13; } context.beginPath(); context.arc(0, 0, mob.id === "bulwark" ? 7 : 5, 0, Math.PI * 2); context.fill(); context.restore();
  if (mob.elite) { context.fillStyle = visual.core; context.font = "900 8px ui-monospace,SFMono-Regular,monospace"; context.textAlign = "center"; context.fillText("ELITE", screen.x, screen.y - mob.radius - 18); }
  if (!crowded || mob.elite || mob.health < mob.maxHealth) { context.fillStyle = "#07110f"; context.fillRect(screen.x - mob.radius, screen.y - mob.radius - 11, mob.radius * 2, 4); context.fillStyle = coreColor; context.fillRect(screen.x - mob.radius, screen.y - mob.radius - 11, mob.radius * 2 * clamp(mob.health / mob.maxHealth), 4); }
}

function projectileColors(styleId, time, phase = 0) {
  if (styleId === "character-shell") return { primary: shellPalette[3], secondary: shellPalette[1] };
  const style = PROJECTILE_STYLES[styleId] ?? PROJECTILE_STYLES["linked-core"];
  const light = ORB_LIGHT_STYLES[appearance.coreLight];
  if (style.mode === "linked") return { primary: light.glow, secondary: light.core };
  if (style.mode === "prism") return { primary: `hsl(${(time * .18 + phase * 47) % 360} 95% 65%)`, secondary: `hsl(${(time * .18 + phase * 47 + 90) % 360} 100% 82%)` };
  if (style.mode === "matrix") return { primary: phase % 3 === 0 ? "#d8ffe0" : style.primary, secondary: "#071d0d" };
  if (style.mode === "aurora") return { primary: `hsl(${165 + Math.sin(time * .003 + phase) * 55} 92% 66%)`, secondary: `hsl(${225 + Math.cos(time * .002 + phase) * 48} 95% 78%)` };
  return { primary: style.primary, secondary: style.secondary };
}
function drawArenaProjectile(projectile, light, hostile = false, time = performance.now()) {
  if (!isWorldVisible(projectile.x, projectile.y, projectile.radius + 48)) { runtimeBudget.culledThisFrame += 1; return; }
  const screen = worldToScreen(projectile.x, projectile.y), colors = hostile ? { primary: projectile.primary ?? "#ff5e78", secondary: projectile.secondary ?? "#ffd3dc" } : projectileColors(projectile.style, time, projectile.spin ?? 0);
  if (!hostile && projectile.trailCount > 0) {
    context.save(); context.globalCompositeOperation = "lighter";
    for (let index = 0; index < projectile.trailCount; index += 1) {
      const slot = (projectile.trailHead - projectile.trailCount + index + projectile.trailX.length) % projectile.trailX.length;
      if (projectile.trailLife[slot] <= 0) continue;
      const trail = worldToScreen(projectile.trailX[slot], projectile.trailY[slot]), alpha = clamp(projectile.trailLife[slot] / .24); context.fillStyle = rgba(colors.primary, alpha * .55); context.fillRect(Math.round(trail.x) - 1, Math.round(trail.y) - 1, 2 + index % 3, 2 + index % 3);
    }
    context.restore();
  }
  context.save(); context.translate(screen.x, screen.y); if (hostile || projectile.kind !== "gyro" && projectile.kind !== "gyro-charge") context.rotate(hostile ? Math.atan2(projectile.vy, projectile.vx) : (projectile.spin ?? 0)); context.globalCompositeOperation = "lighter";
  const color = colors.primary; context.fillStyle = color; context.shadowColor = color; context.shadowBlur = hostile ? 12 : 18;
  if (hostile && projectile.kind === "laser") { context.strokeStyle = color; context.lineWidth = 4; context.beginPath(); context.moveTo(-26, 0); context.lineTo(12, 0); context.stroke(); }
  else if (hostile && projectile.kind === "needle") { context.fillRect(-12, -2, 22, 4); context.fillStyle = colors.secondary; context.fillRect(4, -1, 8, 2); }
  else if (hostile && projectile.kind === "exploder") { context.strokeStyle = color; context.lineWidth = 3; context.beginPath(); context.arc(0, 0, projectile.radius + 5 + Math.sin(time * .02) * 3, 0, Math.PI * 2); context.stroke(); context.fillStyle = colors.secondary; context.beginPath(); context.arc(0, 0, projectile.radius * .55, 0, Math.PI * 2); context.fill(); }
  else if (projectile.kind === "gyro" || projectile.kind === "gyro-charge") {
    const halo = context.createRadialGradient(0, 0, 2, 0, 0, projectile.radius * 1.9); halo.addColorStop(0, rgba(light.glow, .42)); halo.addColorStop(.58, rgba(light.glow, .14)); halo.addColorStop(1, rgba(light.glow, 0)); context.fillStyle = halo; context.beginPath(); context.arc(0, 0, projectile.radius * 1.9, 0, Math.PI * 2); context.fill();
    context.globalCompositeOperation = "source-over"; context.shadowBlur = 0; const saw = currentGyroFrame(time, vaultGyroAnimationSpeed({ projectile: true, chargedProjectile: projectile.kind === "gyro-charge" })); context.drawImage(saw, -projectile.radius * 1.55, -projectile.radius * 1.55, projectile.radius * 3.1, projectile.radius * 3.1);
  }
  else { context.beginPath(); context.arc(0, 0, projectile.radius, 0, Math.PI * 2); context.fill(); context.fillStyle = colors.secondary; context.beginPath(); context.arc(-projectile.radius * .22, -projectile.radius * .22, Math.max(1, projectile.radius * .34), 0, Math.PI * 2); context.fill(); }
  context.restore();
}

function drawCombatFeedback(time) {
  if (arena.closeEffect !== null) {
    const effect = arena.closeEffect;
    if (time >= effect.until) arena.closeEffect = null;
    else {
      const progress = clamp((time - effect.startedAt) / (effect.until - effect.startedAt));
      const center = worldToScreen(arena.player.x, arena.player.y);
      const colors = projectileColors(weaponBuild["projectile-style"] ?? "linked-core", time, progress);
      context.save(); context.globalCompositeOperation = "lighter"; context.globalAlpha = 1 - progress;
      context.strokeStyle = colors.primary; context.shadowColor = colors.secondary; context.shadowBlur = 18; context.lineWidth = 5 - progress * 3;
      context.beginPath(); context.arc(center.x, center.y, effect.radius * (.25 + progress * .75), 0, Math.PI * 2); context.stroke(); context.restore();
    }
  }
  const visibleParticleLimit = Math.max(96, COMBAT_LIMITS.visibleParticles - Math.max(0, arena.mobs.length - 12) * 15);
  runtimeBudget.visibleParticleLimit = visibleParticleLimit;
  let visibleParticles = 0;
  for (let index = arena.particles.length - 1; index >= 0; index -= 1) {
    const particle = arena.particles[index];
    if (!isWorldVisible(particle.x, particle.y, 24)) { runtimeBudget.culledThisFrame += 1; continue; }
    if (visibleParticles >= visibleParticleLimit) { runtimeBudget.culledThisFrame += 1; continue; }
    visibleParticles += 1;
    const point = worldToScreen(particle.x, particle.y), colors = particle.primary ? { primary: particle.primary, secondary: particle.secondary ?? particle.primary } : projectileColors(particle.style, time, particle.x * .01 + particle.y * .01), alpha = clamp(particle.life / particle.maxLife);
    context.save(); context.globalCompositeOperation = particle.style === "character-shell" ? "source-over" : "lighter"; context.globalAlpha = alpha; context.fillStyle = colors.primary;
    if (arena.particles.length < 220) { context.shadowColor = colors.secondary; context.shadowBlur = particle.style === "character-shell" ? 3 : 8; }
    context.translate(Math.round(point.x), Math.round(point.y)); context.rotate(Math.atan2(particle.vy, particle.vx));
    context.fillRect(Math.round(-particle.size / 2), Math.round(-particle.size / 2), Math.max(2, Math.round(particle.size * (particle.style === "character-shell" ? 1.8 : 1))), Math.max(1, Math.round(particle.size))); context.restore();
  }
  for (const popup of arena.damagePopups) {
    if (!isWorldVisible(popup.x, popup.y, 36)) { runtimeBudget.culledThisFrame += 1; continue; }
    const point = worldToScreen(popup.x, popup.y); context.save(); context.globalAlpha = clamp(popup.life / popup.maxLife); context.fillStyle = popup.critical ? "#fff08a" : "#ffffff"; context.shadowColor = popup.critical ? "#ff7a45" : "#000000"; context.shadowBlur = 8; context.font = `${popup.critical ? 900 : 700} ${popup.critical ? 18 : 14}px ui-monospace,SFMono-Regular,monospace`; context.textAlign = "center"; context.fillText(`${popup.critical ? "✦" : ""}${popup.amount}`, point.x, point.y); context.restore();
  }
}

function drawWeaponEffect(time, point) {
  const light = ORB_LIGHT_STYLES[appearance.coreLight];
  const style = weaponBuild["core-particles"];
  context.save(); context.globalCompositeOperation = "lighter";
  if (style === "pulse-rings") {
    for (let index = 0; index < 2; index += 1) { const phase = (time * .0012 + index * .5) % 1; context.strokeStyle = rgba(light.glow, (1 - phase) * .55); context.lineWidth = 2; context.beginPath(); context.arc(point.x, point.y, 8 + phase * 30, 0, Math.PI * 2); context.stroke(); }
  } else if (style === "energy-filaments") {
    for (let index = 0; index < 3; index += 1) { context.strokeStyle = rgba(index % 2 ? light.core : light.glow, .48); context.lineWidth = 1.5; context.beginPath(); context.arc(point.x, point.y, 11 + index * 5, time * .002 + index, time * .002 + index + 1.7); context.stroke(); }
  } else {
    for (let index = 0; index < 6; index += 1) { const angle = time * .0025 + index * Math.PI / 3, radius = 15 + ((time * .018 + index * 5) % 14); context.fillStyle = index % 2 ? light.core : light.glow; context.globalAlpha = .4 + index * .08; context.fillRect(Math.round(point.x + Math.cos(angle) * radius) - 1, Math.round(point.y + Math.sin(angle) * radius) - 1, index % 3 ? 3 : 5, index % 3 ? 3 : 2); }
  }
  context.restore();
}

function drawSceneAmbience(time) {
  if (sceneRecipe.ambience === "quiet") return;
  context.save(); context.globalCompositeOperation = "lighter"; context.strokeStyle = rgba(sceneRecipe.grid.hex, .2); context.fillStyle = rgba(sceneRecipe.grid.hex, .2);
  if (sceneRecipe.ambience === "scan-sweep") {
    const y = ((time * .055) % (canvas.height + 160)) - 80;
    const sweep = context.createLinearGradient(0, y - 42, 0, y + 42); sweep.addColorStop(0, "transparent"); sweep.addColorStop(.5, rgba(sceneRecipe.grid.hex, .16)); sweep.addColorStop(1, "transparent");
    context.fillStyle = sweep; context.fillRect(0, y - 42, canvas.width, 84);
  } else if (sceneRecipe.ambience === "orbit-rings") {
    for (let index = 0; index < 4; index += 1) { const pulse = (time * .018 + index * 47) % 190; context.globalAlpha = (1 - pulse / 190) * .42; context.lineWidth = 2; context.beginPath(); context.arc(canvas.width / 2, canvas.height / 2, 90 + pulse, 0, Math.PI * 2); context.stroke(); }
  } else {
    const falling = sceneRecipe.ambience === "pixel-rain" || sceneRecipe.ambience === "emberfall";
    for (let index = 0; index < 34; index += 1) {
      const x = (bytes[index % 32] * 19 + index * 83) % canvas.width;
      const base = (bytes[(index + 9) % 32] * 23 + index * 37) % canvas.height;
      const y = falling ? (base + time * (sceneRecipe.ambience === "emberfall" ? -.025 : .035) + canvas.height * 4) % canvas.height : base + Math.sin(time * .001 + index) * 9;
      context.globalAlpha = .12 + (index % 5) * .045; context.fillRect(Math.round(x), Math.round(y), index % 4 === 0 ? 3 : 2, sceneRecipe.ambience === "pixel-rain" ? 7 : 2);
    }
  }
  context.restore();
}

function drawBlinkTrail(time, frame) {
  const trail = arena.blinkTrail; if (!trail) return;
  if (time >= trail.until) { arena.blinkTrail = null; return; }
  const from = worldToScreen(trail.fromX, trail.fromY), to = worldToScreen(trail.toX, trail.toY), progress = clamp((time - trail.startedAt) / (trail.until - trail.startedAt)), alpha = 1 - progress;
  context.save(); context.globalCompositeOperation = "lighter"; context.globalAlpha = alpha * .72; context.strokeStyle = ORB_LIGHT_STYLES[appearance.coreLight].glow; context.shadowColor = ORB_LIGHT_STYLES[appearance.coreLight].glow; context.shadowBlur = 18; context.lineCap = "round"; context.lineWidth = trail.effect === "arc" ? 7 : 9 * alpha + 2;
  context.beginPath(); context.moveTo(from.x, from.y);
  if (trail.effect === "arc") { const dx = to.x - from.x, dy = to.y - from.y; context.quadraticCurveTo((from.x + to.x) / 2 - dy * .32, (from.y + to.y) / 2 + dx * .32, to.x, to.y); }
  else context.lineTo(to.x, to.y);
  context.stroke(); context.restore();
  if (trail.effect !== "afterimages") return;
  for (let index = 1; index <= 4; index += 1) { const amount = index / 5, x = from.x + (to.x - from.x) * amount, y = from.y + (to.y - from.y) * amount; context.save(); context.globalAlpha = alpha * (.16 + index * .045); context.drawImage(orb, frame * 34, 0, 34, 34, x - 45, y - 45, 90, 90); context.restore(); }
}

const FLOOR_TILE_SIZE = 96 + (attributeBytes[27] % 3) * 16;
const FLOOR_PAD_SPACING = FLOOR_TILE_SIZE * 5;
const FLOOR_SPOKES = 8 + (attributeBytes[28] % 5) * 2;
const FLOOR_CACHE_MARGIN = FLOOR_TILE_SIZE * 3;
const floorCacheCanvas = document.createElement("canvas");
const floorCacheContext = floorCacheCanvas.getContext("2d");
floorCacheContext.imageSmoothingEnabled = false;
const floorCache = { cameraX: Number.NaN, cameraY: Number.NaN, width: 0, height: 0, renders: 0 };
function floorCellNoise(column, row) {
  let value = Math.imul(column ^ attributeBytes[25], 0x45d9f3b) ^ Math.imul(row ^ attributeBytes[26], 0x119de1f3);
  value ^= value >>> 16; return value >>> 0;
}
function paintWorldFloor(target, cameraX, cameraY, width, height) {
  const halfWidth = width / 2, halfHeight = height / 2;
  const floorPoint = (x, y) => ({ x: x - cameraX + halfWidth, y: y - cameraY + halfHeight });
  const firstColumn = Math.floor((cameraX - halfWidth) / FLOOR_TILE_SIZE) - 1;
  const lastColumn = Math.ceil((cameraX + halfWidth) / FLOOR_TILE_SIZE) + 1;
  const firstRow = Math.floor((cameraY - halfHeight) / FLOOR_TILE_SIZE) - 1;
  const lastRow = Math.ceil((cameraY + halfHeight) / FLOOR_TILE_SIZE) + 1;
  target.save(); target.lineWidth = 1;
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const point = floorPoint(column * FLOOR_TILE_SIZE, row * FLOOR_TILE_SIZE), noise = floorCellNoise(column, row);
      target.fillStyle = rgba(sceneRecipe.grid.hex, ((column + row) & 1) === 0 ? .018 : .008);
      target.fillRect(Math.round(point.x), Math.round(point.y), FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
      target.strokeStyle = rgba(sceneRecipe.grid.hex, noise % 7 === 0 ? .3 : .15);
      target.strokeRect(Math.round(point.x) + .5, Math.round(point.y) + .5, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
      if (noise % 4 === 0) {
        target.fillStyle = rgba(sceneRecipe.grid.hex, .28);
        target.fillRect(Math.round(point.x + FLOOR_TILE_SIZE / 2) - 2, Math.round(point.y + FLOOR_TILE_SIZE / 2) - 2, 4, 4);
      }
      if (noise % 9 === 0) {
        target.strokeStyle = rgba(sceneRecipe.grid.hex, .11); target.beginPath();
        target.moveTo(point.x + 12, point.y + FLOOR_TILE_SIZE - 12); target.lineTo(point.x + FLOOR_TILE_SIZE - 12, point.y + 12); target.stroke();
      }
    }
  }
  const firstPadColumn = Math.floor((cameraX - halfWidth - FLOOR_PAD_SPACING) / FLOOR_PAD_SPACING);
  const lastPadColumn = Math.ceil((cameraX + halfWidth + FLOOR_PAD_SPACING) / FLOOR_PAD_SPACING);
  const firstPadRow = Math.floor((cameraY - halfHeight - FLOOR_PAD_SPACING) / FLOOR_PAD_SPACING);
  const lastPadRow = Math.ceil((cameraY + halfHeight + FLOOR_PAD_SPACING) / FLOOR_PAD_SPACING);
  target.strokeStyle = rgba(sceneRecipe.grid.hex, .16);
  for (let row = firstPadRow; row <= lastPadRow; row += 1) {
    for (let column = firstPadColumn; column <= lastPadColumn; column += 1) {
      const pad = floorPoint(column * FLOOR_PAD_SPACING, row * FLOOR_PAD_SPACING);
      for (let ring = 1; ring <= 4; ring += 1) { target.globalAlpha = .95 - ring * .12; target.beginPath(); target.arc(pad.x, pad.y, FLOOR_TILE_SIZE * ring * .58, 0, Math.PI * 2); target.stroke(); }
      target.globalAlpha = .72;
      for (let spoke = 0; spoke < FLOOR_SPOKES; spoke += 1) {
        const angle = spoke / FLOOR_SPOKES * Math.PI * 2, inner = FLOOR_TILE_SIZE * .36, outer = FLOOR_TILE_SIZE * 2.32;
        target.beginPath(); target.moveTo(pad.x + Math.cos(angle) * inner, pad.y + Math.sin(angle) * inner); target.lineTo(pad.x + Math.cos(angle) * outer, pad.y + Math.sin(angle) * outer); target.stroke();
      }
    }
  }
  target.restore();
}
function drawWorldFloor() {
  const cameraX = Math.round(arena.camera.x), cameraY = Math.round(arena.camera.y);
  const cacheWidth = canvas.width + FLOOR_CACHE_MARGIN * 2, cacheHeight = canvas.height + FLOOR_CACHE_MARGIN * 2;
  const driftX = cameraX - floorCache.cameraX, driftY = cameraY - floorCache.cameraY;
  if (floorCache.width !== cacheWidth || floorCache.height !== cacheHeight || !Number.isFinite(driftX) || Math.abs(driftX) > FLOOR_TILE_SIZE || Math.abs(driftY) > FLOOR_TILE_SIZE) {
    floorCacheCanvas.width = cacheWidth; floorCacheCanvas.height = cacheHeight; floorCacheContext.imageSmoothingEnabled = false;
    floorCacheContext.clearRect(0, 0, cacheWidth, cacheHeight);
    paintWorldFloor(floorCacheContext, cameraX, cameraY, cacheWidth, cacheHeight);
    floorCache.cameraX = cameraX; floorCache.cameraY = cameraY; floorCache.width = cacheWidth; floorCache.height = cacheHeight; floorCache.renders += 1;
    setDatasetIfChanged(document.documentElement, "vaultFloorCacheRenders", String(floorCache.renders));
  }
  const sourceX = FLOOR_CACHE_MARGIN + cameraX - floorCache.cameraX;
  const sourceY = FLOOR_CACHE_MARGIN + cameraY - floorCache.cameraY;
  context.drawImage(floorCacheCanvas, sourceX, sourceY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  const offsetX = ((-cameraX % FLOOR_TILE_SIZE) + FLOOR_TILE_SIZE) % FLOOR_TILE_SIZE;
  const offsetY = ((-cameraY % FLOOR_TILE_SIZE) + FLOOR_TILE_SIZE) % FLOOR_TILE_SIZE;
  setDatasetIfChanged(document.documentElement, "vaultFloorTileSize", String(FLOOR_TILE_SIZE));
  setDatasetIfChanged(document.documentElement, "vaultFloorOffset", `${offsetX.toFixed(2)},${offsetY.toFixed(2)}`);
}

let firstFrameReady = false;
function drawGalleryPresentation(time) {
  const frame = Math.floor(time / 650) % directions.length;
  const light = ORB_LIGHT_STYLES[appearance.coreLight];
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const orbSize = Math.round(Math.min(canvas.width, canvas.height) * .47);
  const bob = Math.sin(time * .0018) * 5;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const aura = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, canvas.width * .39);
  aura.addColorStop(0, rgba(light.glow, .2));
  aura.addColorStop(.46, rgba(light.glow, .075));
  aura.addColorStop(1, "transparent");
  context.fillStyle = aura;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(centerX, centerY);
  context.strokeStyle = rgba(light.glow, .34);
  context.lineWidth = 2;
  context.beginPath();
  context.arc(0, 0, canvas.width * .315, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([6, 12]);
  context.lineDashOffset = -time * .012;
  context.strokeStyle = "rgba(255,255,255,.18)";
  context.beginPath();
  context.arc(0, 0, canvas.width * .242, 0, Math.PI * 2);
  context.stroke();
  context.restore();
  context.save();
  context.translate(centerX, centerY + orbSize * .34);
  context.scale(1, .24);
  const shadow = context.createRadialGradient(0, 0, 0, 0, 0, orbSize * .48);
  shadow.addColorStop(0, "rgba(0,0,0,.58)");
  shadow.addColorStop(1, "transparent");
  context.fillStyle = shadow;
  context.beginPath();
  context.arc(0, 0, orbSize * .48, 0, Math.PI * 2);
  context.fill();
  context.restore();
  context.drawImage(
    orb,
    frame * 34,
    0,
    34,
    34,
    centerX - orbSize / 2,
    centerY - orbSize / 2 + bob,
    orbSize,
    orbSize,
  );
  setDatasetIfChanged(document.documentElement, "vaultGalleryFrame", String(frame));
  setDatasetIfChanged(document.documentElement, "vaultDirection", directions[frame]);
  if (!firstFrameReady) {
    firstFrameReady = true;
    document.body.classList.add("ready");
    document.documentElement.dataset.vaultCharacterReady = "true";
    globalThis.__KEEL_THUMBNAIL__?.ready("vault-orb-gallery");
    markVaultStartup("gallery-first-frame-ready");
  }
  if (!verificationReadyEmitted) { verificationReadyEmitted = true; verificationUI.ready(); }
  setTimeout(() => requestAnimationFrame(draw), 120);
}
function draw(time) {
  if (presentationMode === "gallery") {
    drawGalleryPresentation(time);
    return;
  }
  const startupFrame = !firstFrameReady;
  if (startupFrame) performance.mark("vault:first-frame-start");
  const workStartedAt = performance.now();
  const frameMs = Math.max(0, time - arena.lastFrameAt), delta = Math.min(.034, frameMs / 1000); arena.lastFrameAt = time;
  if (frameMs > 0 && frameMs < 1000) { runtimeBudget.frameSamples[runtimeBudget.frameCursor] = frameMs; runtimeBudget.frameCursor = (runtimeBudget.frameCursor + 1) % runtimeBudget.frameSamples.length; runtimeBudget.frameCount = Math.min(runtimeBudget.frameSamples.length, runtimeBudget.frameCount + 1); }
  if (runtimeBudget.frameCount > 0 && runtimeBudget.frameCursor % 30 === 0) { const samples = Array.from(runtimeBudget.frameSamples.slice(0, runtimeBudget.frameCount)).sort((a, b) => a - b); document.documentElement.dataset.vaultFrameP95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))].toFixed(2); }
  updateArena(time, delta);
  runtimeBudget.culledThisFrame = 0;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (sceneRecipe.scene === "grid" && sceneGrid) setStyleIfChanged(sceneGrid, "transform", `translate3d(${Math.round(((-arena.camera.x % 28) + 28) % 28) - 28}px,${Math.round(((-arena.camera.y % 28) + 28) % 28) - 28}px,0)`);
  drawWorldFloor();
  if (startupFrame) performance.mark("vault:first-frame-floor-ready");
  drawSceneAmbience(time);
  const center = screenCenter();
  const bob = Math.sin(time * .0032) * 10;
  const aim = aimVector();
  const angle = Math.atan2(aim.y, aim.x), frame = facingIndex(angle), light = ORB_LIGHT_STYLES[appearance.coreLight];
  drawBlinkTrail(time, frame);
  for (let index = 0; index < 24; index += 1) {
    const phase = (bytes[(index + 8) % 32] / 255) * Math.PI * 2;
    const radius = 86 + (bytes[(index + 13) % 32] % 96);
    const x = center.x + Math.cos(phase + time * .00008 * (index % 2 ? 1 : -1)) * radius;
    const y = center.y + Math.sin(phase + time * .00011) * radius * .72;
    context.fillStyle = rgba(light.glow, .12 + (index % 4) * .035); context.fillRect(Math.round(x), Math.round(y), 2 + index % 2, 2 + index % 2);
  }
  for (const mob of arena.mobs) drawMob(mob, time, light);
  for (const projectile of arena.projectiles) drawArenaProjectile(projectile, light, false, time);
  for (const projectile of arena.hostileProjectiles) drawArenaProjectile(projectile, light, true, time);
  drawCombatFeedback(time);
  context.save(); context.globalAlpha = time < arena.player.hiddenUntil ? 0 : 1;
  context.save(); context.translate(center.x, center.y + 66); context.fillStyle = "rgba(0,0,0,.42)"; context.beginPath(); context.ellipse(0, 0, 58, 15, 0, 0, Math.PI * 2); context.fill(); context.restore();
  if (time < arena.defendingUntil) { context.save(); context.globalCompositeOperation = "lighter"; context.strokeStyle = rgba(light.glow, .7); context.lineWidth = 4; context.shadowColor = light.glow; context.shadowBlur = 18; context.beginPath(); context.arc(center.x, center.y + bob, 76 + Math.sin(time * .012) * 4, 0, Math.PI * 2); context.stroke(); context.restore(); }
  const orbSize = 124;
  if (arena.boosting) {
    const portHotspot = rearPortHotspots[frame], scale = orbSize / 34;
    const portX = portHotspot ? center.x + (portHotspot.x - 17) * scale : center.x - aim.x * orbSize * .38;
    const portY = portHotspot ? center.y + bob + (portHotspot.y - 17) * scale : center.y + bob - aim.y * orbSize * .38;
    let exhaustX = portX - center.x, exhaustY = portY - (center.y + bob), exhaustLength = Math.hypot(exhaustX, exhaustY);
    if (exhaustLength < 1) { exhaustX = -aim.x; exhaustY = -aim.y; exhaustLength = 1; }
    exhaustX /= exhaustLength; exhaustY /= exhaustLength;
    const boostLight = port?.linkedLight ? light : port?.glow ? port : light;
    context.save(); context.globalCompositeOperation = "lighter"; context.lineCap = "round"; context.strokeStyle = rgba(boostLight.glow, .82); context.shadowColor = boostLight.glow; context.shadowBlur = 18;
    for (let index = 0; index < 3; index += 1) { const length = 18 + index * 10 + Math.sin(time * .03 + index) * 5; context.globalAlpha = .82 - index * .2; context.lineWidth = 5 - index; context.beginPath(); context.moveTo(portX, portY); context.lineTo(portX + exhaustX * length + Math.sin(time * .017 + index) * 3, portY + exhaustY * length + Math.cos(time * .019 + index) * 3); context.stroke(); }
    context.restore();
  }
  context.drawImage(orb, frame * 34, 0, 34, 34, center.x - orbSize / 2, center.y - orbSize / 2 + bob, orbSize, orbSize);
  const hotspot = targets.hotspots?.[directions[frame]]?.weapon ?? targets.hotspots?.[directions[frame]]?.light;
  const eye = hotspot ? { x: center.x + (hotspot.x - 17) * (orbSize / 34), y: center.y + (hotspot.y - 17) * (orbSize / 34) + bob } : center;
  const weaponPoint = { x: center.x + aim.x * 98, y: center.y + aim.y * 98 + bob };
  context.save(); context.globalCompositeOperation = "lighter";
  const beam = context.createLinearGradient(eye.x, eye.y, weaponPoint.x, weaponPoint.y); beam.addColorStop(0, rgba(light.glow,.88)); beam.addColorStop(.58,rgba(light.glow,.38)); beam.addColorStop(1,"transparent");
  context.strokeStyle = beam; context.lineWidth = 4; context.beginPath(); context.moveTo(eye.x,eye.y); context.lineTo(weaponPoint.x,weaponPoint.y); context.stroke();
  const glow = context.createRadialGradient(eye.x,eye.y,0,eye.x,eye.y,34); glow.addColorStop(0,light.core); glow.addColorStop(.25,rgba(light.glow,.65)); glow.addColorStop(1,"transparent"); context.fillStyle=glow; context.beginPath(); context.arc(eye.x,eye.y,34,0,Math.PI*2); context.fill(); context.restore();
  const animationAge = time - arena.weaponAnimationStartedAt;
  const actionWeaponFrameIndex = arena.charging ? Math.min(tintedWeaponFrames.length - 1, Math.floor(clamp(animationAge / weaponCombat.charge.maximumMs) * tintedWeaponFrames.length)) : animationAge >= 0 && animationAge < 540 ? Math.min(tintedWeaponFrames.length - 1, Math.floor(animationAge / (540 / tintedWeaponFrames.length))) : 0;
  const gyroHeldSpeed = vaultGyroAnimationSpeed({ held: Number.isFinite(arena.shootHeldSince), charging: arena.charging });
  const weaponFrameIndex = appearance.weapon === "gyro" ? currentGyroFrameIndex(time, gyroHeldSpeed) : actionWeaponFrameIndex;
  const weaponFrame = appearance.weapon === "gyro" ? currentGyroFrame(time, gyroHeldSpeed) : tintedWeaponFrame(weaponFrameIndex);
  if (startupFrame) performance.mark("vault:first-frame-weapon-ready");
  if (animationAge >= 0 && animationAge < 150) {
    const charge = 1 - animationAge / 150; context.save(); context.globalCompositeOperation = "lighter"; const chargeGlow = context.createRadialGradient(weaponPoint.x, weaponPoint.y, 0, weaponPoint.x, weaponPoint.y, 38 + charge * 24); chargeGlow.addColorStop(0, light.core); chargeGlow.addColorStop(.18, rgba(light.glow, .82)); chargeGlow.addColorStop(1, "transparent"); context.fillStyle = chargeGlow; context.beginPath(); context.arc(weaponPoint.x, weaponPoint.y, 62, 0, Math.PI * 2); context.fill(); context.restore();
  }
  const gyroDeployed = appearance.weapon === "gyro" && arena.player.gyroProjectileId !== null;
  const heldWeaponSize = appearance.weapon === "gyro" ? 80 : 94;
  context.save(); context.translate(weaponPoint.x, weaponPoint.y); if (appearance.weapon !== "gyro") context.rotate(angle); if (!gyroDeployed) context.drawImage(weaponFrame, -heldWeaponSize / 2, -heldWeaponSize / 2, heldWeaponSize, heldWeaponSize);
  if (arena.charging || (animationAge >= 0 && animationAge < 540)) {
    const weaponEmissiveFrame = getWeaponEmissiveFrame(weaponFrameIndex);
    const cycle = arena.charging ? clamp(animationAge / weaponCombat.charge.maximumMs) : clamp(animationAge / 540), chargePulse = arena.charging ? cycle : Math.sin(cycle * Math.PI), dischargePulse = Math.exp(-Math.pow((time - arena.weaponDischargedAt) / 52, 2));
    context.globalCompositeOperation = "lighter"; context.globalAlpha = .42 + chargePulse * .68 + dischargePulse * .72;
    context.shadowColor = light.glow; context.shadowBlur = 12 + chargePulse * 18 + dischargePulse * 20;
    if (!gyroDeployed) context.drawImage(weaponEmissiveFrame, -heldWeaponSize / 2, -heldWeaponSize / 2, heldWeaponSize, heldWeaponSize);
  }
  context.restore();
  drawWeaponEffect(time, weaponPoint);
  if (startupFrame) performance.mark("vault:first-frame-character-ready");
  context.restore();
  if (time >= arena.flashUntil) arenaFlash.classList.remove("show");
  const survival = arena.active ? Math.max(0, time - arena.startedAt) : 0, seconds = Math.floor(survival / 1000), rebooting = !arena.active && arena.restartAt > time;
  setTextIfChanged(arenaWave, arena.active ? `Wave ${arena.wave}` : rebooting ? "Reboot" : "Dormant"); setTextIfChanged(arenaTime, rebooting ? `${Math.max(0, Math.ceil((arena.restartAt - time) / 1000))}` : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`); setTextIfChanged(arenaKills, `${arena.kills} clears`); setTextIfChanged(arenaLevel, `Level ${arena.level}`);
  if (runtimeBudget.telemetryFrame % 4 === 0) {
    setStyleIfChanged(shieldFill, "transform", `scaleX(${arena.player.shield / arena.player.maxShield})`); setStyleIfChanged(energyFill, "transform", `scaleX(${arena.player.energy / arena.player.maxEnergy})`); setStyleIfChanged(xpFill, "transform", `scaleX(${arena.experience / (3 + arena.level * 2)})`);
  }
  runtimeBudget.telemetryFrame += 1;
  setDatasetIfChanged(document.documentElement, "vaultArenaWave", String(arena.wave)); setDatasetIfChanged(document.documentElement, "vaultArenaKills", String(arena.kills));
  setDatasetIfChanged(document.documentElement, "vaultDirection", directions[frame]);
  setDatasetIfChanged(document.documentElement, "vaultArenaRestart", rebooting ? `scheduled:${Math.max(0, Math.ceil(arena.restartAt - time))}` : arena.active ? "active" : "idle");
  setDatasetIfChanged(document.documentElement, "vaultLevel", String(arena.level));
  setDatasetIfChanged(document.documentElement, "vaultWeaponFrame", String(weaponFrameIndex));
  const gyroProjectile = arena.projectiles.find((projectile) => projectile.id === arena.player.gyroProjectileId); setDatasetIfChanged(document.documentElement, "vaultGyroState", appearance.weapon !== "gyro" ? "not-equipped" : gyroProjectile?.returning ? "returning" : gyroProjectile ? "outbound" : "held");
  if (runtimeBudget.telemetryFrame % 4 === 0) {
    setDatasetIfChanged(document.documentElement, "vaultArenaMobs", arena.mobs.map((mob) => mob.id).join("|"));
    setDatasetIfChanged(document.documentElement, "vaultWorldPosition", `${arena.player.x.toFixed(2)},${arena.player.y.toFixed(2)}`);
    setDatasetIfChanged(document.documentElement, "vaultRuntimeBudget", `p:${arena.projectiles.length}/${COMBAT_LIMITS.projectiles}|h:${arena.hostileProjectiles.length}/${COMBAT_LIMITS.hostileProjectiles}|fx:${arena.particles.length}/${COMBAT_LIMITS.particles}/${runtimeBudget.visibleParticleLimit}|pop:${arena.damagePopups.length}/${COMBAT_LIMITS.damagePopups}|culled:${runtimeBudget.culledThisFrame}`);
  }
  if (!firstFrameReady) {
    firstFrameReady = true;
    document.body.classList.add("ready");
    document.documentElement.dataset.vaultCharacterReady = "true";
    globalThis.__KEEL_THUMBNAIL__?.ready("vault-orb");
    markVaultStartup("first-frame-ready");
    scheduleWeaponFramePrewarm();
  }
  if (!verificationReadyEmitted) { verificationReadyEmitted = true; verificationUI.ready(); }
  const workMs = performance.now() - workStartedAt; runtimeBudget.workSamples[runtimeBudget.workCursor] = workMs; runtimeBudget.workCursor = (runtimeBudget.workCursor + 1) % runtimeBudget.workSamples.length; runtimeBudget.workCount = Math.min(runtimeBudget.workSamples.length, runtimeBudget.workCount + 1);
  if (runtimeBudget.workCursor % 30 === 0) { const samples = Array.from(runtimeBudget.workSamples.slice(0, runtimeBudget.workCount)).sort((a, b) => a - b); document.documentElement.dataset.vaultWorkP95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))].toFixed(2); }
  requestAnimationFrame(draw);
}

document.querySelector("#name").textContent = `Vault Orb #${tokenId}`;
document.querySelector("#traits").textContent = `${weaponSpec.name} · ${Object.values(weaponBuild).join(" · ")} · ${escapeStyle.name} · ${appearance.shell} shell · ${appearance.coreLight} core · ${sceneRecipe.scene} / ${sceneRecipe.grid.id} / ${sceneRecipe.ambience}`;
document.querySelector("#mobile-name").textContent = `Vault Orb #${tokenId}`;
document.querySelector("#mobile-traits").textContent = document.querySelector("#traits").textContent;
document.documentElement.dataset.vaultWeaponRoll = `${rolledWeapon.id}:${rolledWeapon.rarity}:${rolledWeapon.fingerprint}:${rolledWeapon.longRange.damage}/${rolledWeapon.longRange.projectileSpeed}/${rolledWeapon.longRange.cooldownMs}`;
document.documentElement.dataset.vaultWeapon = appearance.weapon;
document.documentElement.dataset.vaultWeaponAttributes = Object.entries(weaponBuild).map(([name, value]) => `${name}:${value}`).join("|");
document.documentElement.dataset.vaultOrbAppearance = `${appearance.shell}/${appearance.visor}/${appearance.coreLight}/${appearance.skin}`;
document.documentElement.dataset.vaultTokenSeed = seed;
document.documentElement.dataset.vaultSceneRecipe = `${sceneRecipe.scene}|${sceneRecipe.background.id}|${sceneRecipe.grid.id}|${sceneRecipe.ambience}|${sceneRecipe.filter.id}`;
document.documentElement.dataset.vaultProjectileStyle = weaponBuild["projectile-style"] ?? "linked-core";
globalThis.__VAULT_CHARACTER__ = Object.freeze({ tokenId, seed, packedAttributes, assetId, appearance: Object.freeze(appearance), weaponBuild: Object.freeze(weaponBuild), rolledWeapon, sceneRecipe, escapeStyle });
globalThis.__VAULT_CHARACTER_ARENA__ = Object.freeze({
  archetypes: MOB_ARCHETYPES.map(({ id, label }) => Object.freeze({ id, label })),
  snapshot: () => Object.freeze({
    active: arena.active, wave: arena.wave, kills: arena.kills, deaths: arena.deaths, lastRunKills: arena.lastRunKills, lastRunDurationMs: arena.lastRunDurationMs, restartAt: arena.restartAt, level: arena.level, experience: arena.experience,
    shield: arena.player.shield, maxShield: arena.player.maxShield, energy: arena.player.energy, maxEnergy: arena.player.maxEnergy, energyState: document.documentElement.dataset.vaultEnergyState, charging: arena.charging, boosting: arena.boosting, escapeStyle: escapeStyle.id, player: Object.freeze({ x: arena.player.x, y: arena.player.y, radius: arena.player.radius, critical: arena.player.critical }), camera: Object.freeze({ ...arena.camera }), mobs: arena.mobs.map((mob) => mob.id),
    projectiles: arena.projectiles.length, pendingShots: arena.pendingShots.length, particles: arena.particles.length, particleStyles: Object.freeze(arena.particles.reduce((counts, particle) => { counts[particle.style] = (counts[particle.style] ?? 0) + 1; return counts; }, {})), damagePopups: arena.damagePopups.length,
    projectileDetails: arena.projectiles.map((projectile) => Object.freeze({ id: projectile.id, x: projectile.x, y: projectile.y, vx: projectile.vx, vy: projectile.vy, launchX: projectile.launchX, launchY: projectile.launchY, spawnOffset: projectile.spawnOffset, launchedAt: projectile.launchedAt, radius: projectile.radius, damage: projectile.damage, life: projectile.life, pierce: projectile.pierce, critical: projectile.critical, kind: projectile.kind, boomerang: projectile.boomerang, returning: projectile.returning, returnAt: projectile.returnAt, returnSpeed: projectile.returnSpeed })),
    mobDetails: arena.mobs.map((mob) => Object.freeze({ id: mob.id, health: mob.health, elite: mob.elite, variant: mob.variant, recipe: mob.visual?.id, abilities: Object.freeze([...(mob.abilities ?? [])]) })),
    weaponRoll: rolledWeapon, nextCloseAt: arena.nextCloseAt, closeEffect: arena.closeEffect === null ? null : Object.freeze({ ...arena.closeEffect }),
    weaponFrame: Number(document.documentElement.dataset.vaultWeaponFrame ?? 0), gyroFrame: Number(document.documentElement.dataset.vaultGyroFrame ?? 0), gyroState: appearance.weapon !== "gyro" ? "not-equipped" : arena.projectiles.find((projectile) => projectile.id === arena.player.gyroProjectileId)?.returning ? "returning" : arena.player.gyroProjectileId !== null ? "outbound" : "held", gyroProjectileId: arena.player.gyroProjectileId, weaponEmissiveRegion, projectileStyle: weaponBuild["projectile-style"] ?? "linked-core",
    soundReady: document.documentElement.dataset.vaultSoundReady === "true",
    runtimeBudget: Object.freeze({
      limits: COMBAT_LIMITS, visibleParticleLimit: runtimeBudget.visibleParticleLimit, frameP95Ms: Number(document.documentElement.dataset.vaultFrameP95 ?? 0), workP95Ms: Number(document.documentElement.dataset.vaultWorkP95 ?? 0), culledThisFrame: runtimeBudget.culledThisFrame, dropped: Object.freeze({ ...runtimeBudget.dropped }),
      pooled: Object.freeze({ projectiles: projectilePool.freeCount, hostileProjectiles: hostileProjectilePool.freeCount, particles: particlePool.freeCount, damagePopups: damagePopupPool.freeCount }),
    }),
  }),
  fire: () => fireWeapon(performance.now(), true),
  escape: () => useEscape(performance.now()),
  defend: () => useDefend(performance.now()),
  cooldown: () => useCooldownAttack(performance.now()),
  close: () => closeAttack(performance.now()),
  chargeStart: () => startCharge(performance.now()), chargeRelease: () => releaseCharge(performance.now()),
  damage: (amount = 20) => hurtPlayer(Number(amount) || 20, performance.now()),
  stressParticles: (count = COMBAT_LIMITS.particles * 2) => emitBurst(arena.player.x, arena.player.y, "linked-core", Math.max(0, Math.floor(Number(count) || 0)), 1),
  spawnMob: ({ variant = 0, elite = false, archetype = "drifter", abilities = [], x, y } = {}) => {
    const mob = spawnMob(performance.now(), { variant: Math.abs(Math.floor(variant)) % MOB_VISUAL_RECIPES.length, elite: Boolean(elite), archetype, abilities: abilities.filter((ability) => MOB_ABILITIES.includes(ability)), x, y });
    return Object.freeze({ id: mob.id, elite: mob.elite, variant: mob.variant, recipe: mob.visual.id, abilities: Object.freeze([...mob.abilities]) });
  },
  triggerMob: (index = 0, ability) => {
    const mob = arena.mobs[Math.max(0, Math.floor(Number(index) || 0))]; if (!mob) return false;
    if (MOB_ABILITIES.includes(ability)) { mob.abilities = [ability]; mob.abilityIndex = 0; }
    mob.nextAbilityAt = 0; triggerMobAbility(mob, performance.now(), Math.hypot(mob.x - arena.player.x, mob.y - arena.player.y)); return true;
  },
  killMob: (index = 0) => {
    const mobIndex = Math.max(0, Math.floor(Number(index) || 0)), mob = arena.mobs[mobIndex]; if (!mob) return false;
    arena.mobs.splice(mobIndex, 1); grantKill(mob, performance.now()); return true;
  },
});
document.documentElement.dataset.vaultArenaState = "dormant";
document.documentElement.dataset.vaultArenaArchetypes = MOB_ARCHETYPES.map((mob) => mob.id).join("|");
document.documentElement.dataset.vaultMobVisualRecipes = String(MOB_VISUAL_RECIPES.length);
document.documentElement.dataset.vaultMobAttributeLayers = MOB_ATTRIBUTE_LAYERS.join("|");
document.documentElement.dataset.vaultEscapeStyle = escapeStyle.id;
markVaultStartup("api-ready");
draw(performance.now());
