import {
  clamp,
  createArenaLayout,
  createLayerProfile,
  createRunDescriptor,
  createShopChoices,
  deterministicFingerprint,
  hash32,
  lerp,
  makeRng,
  pick,
} from "./vault-game-core.mjs?v=world-grammar-6";
import {
  ORB_LIGHT_STYLES,
  ORB_METAL_PALETTES,
  ORB_PORT_LIGHTS,
  ORB_SKIN_STYLES,
  ORB_VISOR_PALETTES,
  paintOrbMaterialAtlas,
} from "./orb-materials.mjs";
import { materialIdColor, recolorVaultMaterialMapPixels, recolorVaultMaterialPixels } from "./vault-material-targets.mjs";
import {
  materialBuildFromPackedAttributes,
  materializeWeaponFrame,
  rollWeaponMaterialBuild,
  weaponMaterialLedger,
} from "./weapon-material-runtime.mjs";
import {
  VAULT_MOB_ABILITIES,
  VAULT_MOB_ABILITY_RULES,
  VAULT_PLAYER_COMBAT_RULES,
  VAULT_WEAPON_COMBAT_RULES,
  createVaultWeaponProjectileVolley,
  createVaultMobVisualRecipes,
  resolveVaultEscapeVector,
  selectVaultMobAbilities,
  vaultGyroAnimationSpeed,
  updateVaultGyroProjectile,
  vaultGyroFrameIndex,
  vaultWeaponProjectileDamageScale,
  vaultProjectileHitKey,
} from "./vault-combat-shared.mjs";
import {
  VAULT_INPUT_STORAGE_KEY,
  readVaultGamepad,
  sanitizeVaultBindings,
  vaultActionForCode,
} from "./vault-input-shared.mjs";
import {
  rasterizeWallDoorAssembly,
  rgbaHash,
} from "./vault-world-structure.mjs?v=wall-door-structure-review-v1";

const atlasResponse = await fetch("./vault-game-atlas-v1.json", { cache: "no-store" });
if (!atlasResponse.ok) throw new Error(`Vault game atlas failed: ${atlasResponse.status}`);
const atlas = await atlasResponse.json();
if (atlas.schema !== "vault-game-atlas@2") throw new Error("Unsupported Vault game atlas");
const [weaponMaterialCatalog, weaponRegionLayouts, weaponRegionOverrides] = await Promise.all([
  fetch("./weapon-attributes-v1.json", { cache: "no-store" }).then((response) => response.json()),
  fetch("./weapon-region-layouts-v2.json", { cache: "no-store" }).then((response) => response.json()),
  fetch("./weapon-region-overrides-v1.json", { cache: "no-store" }).then((response) => response.json()),
]);

const canvas = document.querySelector("#game");
const context = canvas.getContext("2d");
context.imageSmoothingEnabled = false;
const stage = document.querySelector("#stage");
const seedInput = document.querySelector("#map-seed");
const characterSeedInput = document.querySelector("#character-seed");
const toastElement = document.querySelector("#toast");
const launchParams = new URLSearchParams(location.search);
const artReviewMode = launchParams.get("artReview") === "1";
if (artReviewMode) document.documentElement.dataset.artReview = "1";
const vaultSurface = document.documentElement.dataset.vaultSurface ?? "development-harness";
const injectedContext = globalThis.__OCA_RUNTIME__?.context ?? globalThis.__OCA_CONTEXT__ ?? null;
const injectedMapSeed = injectedContext?.mapSeed;
const injectedCharacterSeed = injectedContext?.derivedTokenSeed;
const injectedMapCharacterSeed = injectedContext?.mapCharacterSeed;
const allowDevelopmentQuery = vaultSurface !== "map-viewer"
  || artReviewMode
  || launchParams.get("dev") === "1"
  || [...launchParams.keys()].some((key) => key.startsWith("review") || key.endsWith("Review"));
const authoredQuiltPrototypeRequested = allowDevelopmentQuery
  && launchParams.get("dev") === "1"
  && launchParams.get("floorPrototype") === "authored-quilt-v1";
const authoredSurfaceModule = authoredQuiltPrototypeRequested
  ? await import("./vault-authored-surface-runtime.mjs?v=authored-quilt-v1-live-3")
  : null;
const authoredQuiltPrototypeEnabled = authoredSurfaceModule?.resolveAuthoredQuiltPrototype(launchParams, allowDevelopmentQuery) ?? false;
const stakedCharacterId = injectedContext?.characterId ?? injectedContext?.stakedCharacterId ?? (allowDevelopmentQuery ? launchParams.get("characterId") : null);
const stakedMapId = injectedContext?.mapId ?? injectedContext?.tokenId ?? (allowDevelopmentQuery ? launchParams.get("mapId") : null);
const stakeTransaction = allowDevelopmentQuery ? launchParams.get("stakeTx") : null;
const arcadeRegistry = injectedContext?.arcadeRegistry ?? (allowDevelopmentQuery ? launchParams.get("arcadeRegistry") : null);
if (typeof injectedCharacterSeed === "string") characterSeedInput.value = injectedCharacterSeed;
else if (allowDevelopmentQuery && launchParams.get("characterSeed")) characterSeedInput.value = launchParams.get("characterSeed");
if (typeof injectedMapSeed === "string") seedInput.value = injectedMapSeed;
else if (allowDevelopmentQuery && launchParams.get("mapSeed")) seedInput.value = launchParams.get("mapSeed");
if (stakedCharacterId) document.documentElement.dataset.vaultCharacterToken = stakedCharacterId;
if (stakedMapId) document.documentElement.dataset.vaultMapToken = stakedMapId;
if (stakeTransaction) document.documentElement.dataset.vaultStakeTransaction = stakeTransaction;
if (injectedMapCharacterSeed) document.documentElement.dataset.vaultMapCharacterSeed = injectedMapCharacterSeed;
const verifiedMapViewerContext = vaultSurface === "map-viewer"
  && typeof injectedMapSeed === "string"
  && typeof injectedCharacterSeed === "string"
  && typeof injectedMapCharacterSeed === "string";
document.documentElement.dataset.vaultContextSource = verifiedMapViewerContext ? "keel-onchain" : allowDevelopmentQuery ? "development-query" : "missing";
const WALL_DOOR_STRUCTURE_REVIEW_SCHEMA = "vault-wall-door-structure-review@1";
const WALL_DOOR_STRUCTURE_REVIEW_VERSION = 1;
const wallDoorStructureReviewRequested = launchParams.get("wallDoorStructureReview") === "1";
const wallDoorStructureReviewEnabled = wallDoorStructureReviewRequested
  && allowDevelopmentQuery
  && (vaultSurface !== "map-viewer"
    || verifiedMapViewerContext
    || artReviewMode
    || launchParams.get("dev") === "1");
const WALL_DOOR_STRUCTURE_REVIEW_BOUNDARY = "review-only-query-overlay; default-renderer-and-camera-unchanged; no-PixelLabs-approval";
const WALL_DOOR_STRUCTURE_AXIS_MAPPING = "live-horizontal=>harness-vertical;live-vertical=>harness-horizontal";
document.documentElement.dataset.vaultWallDoorStructureSchema = WALL_DOOR_STRUCTURE_REVIEW_SCHEMA;
document.documentElement.dataset.vaultWallDoorStructureVersion = String(WALL_DOOR_STRUCTURE_REVIEW_VERSION);
document.documentElement.dataset.vaultWallDoorStructureFlag = wallDoorStructureReviewEnabled ? "1" : "0";
document.documentElement.dataset.vaultWallDoorStructureReview = wallDoorStructureReviewEnabled ? "pending" : "disabled";
document.documentElement.dataset.vaultWallDoorStructureReviewBoundary = WALL_DOOR_STRUCTURE_REVIEW_BOUNDARY;
document.documentElement.dataset.vaultWallDoorStructureAxisMapping = WALL_DOOR_STRUCTURE_AXIS_MAPPING;
document.documentElement.dataset.vaultWallDoorStructureMaterial = "neutral-deterministic-grayscale";
const WORLD_FEATURE_RENDER_REVIEW_SCHEMA = "vault-world-feature-render-review@1";
const WORLD_FEATURE_RENDER_REVIEW_VERSION = 1;
const worldFeatureRenderReviewRequested = launchParams.get("worldFeatureRenderReview") === "1";
const worldFeatureRenderReviewEnabled = worldFeatureRenderReviewRequested
  && allowDevelopmentQuery
  && (vaultSurface !== "map-viewer"
    || verifiedMapViewerContext
    || artReviewMode
    || launchParams.get("dev") === "1");
const WORLD_FEATURE_RENDER_REVIEW_BOUNDARY = "review-only-query-overlay; frozen-seeded-specimens; candidate-no-approval; no-PixelLabs-unlock";
const WORLD_FEATURE_REVIEW_CATEGORIES = Object.freeze(["bridges", "ramps", "cliffs", "objects", "occlusion", "lamps", "lighting"]);
document.documentElement.dataset.vaultWorldFeatureRenderSchema = WORLD_FEATURE_RENDER_REVIEW_SCHEMA;
document.documentElement.dataset.vaultWorldFeatureRenderVersion = String(WORLD_FEATURE_RENDER_REVIEW_VERSION);
document.documentElement.dataset.vaultWorldFeatureRenderFlag = worldFeatureRenderReviewEnabled ? "1" : "0";
document.documentElement.dataset.vaultWorldFeatureRenderReview = worldFeatureRenderReviewEnabled ? "pending" : "disabled";
document.documentElement.dataset.vaultWorldFeatureRenderReviewBoundary = WORLD_FEATURE_RENDER_REVIEW_BOUNDARY;
const BIOME_STRUCTURAL_VARIANT_REVIEW_SCHEMA = "vault-biome-structural-variant-review@1";
const BIOME_STRUCTURAL_VARIANT_REVIEW_VERSION = 1;
const BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES = Object.freeze([
  "industrial-forge",
  "crystal-overgrowth",
  "occult-machine-catacomb",
  "zero-gravity-reactor",
]);
const BIOME_STRUCTURAL_VARIANT_REVIEW_BOUNDARY = "review-only-query-overlay; candidate-neutral-grayscale; no-approval; no-PixelLabs-unlock";
const BIOME_STRUCTURAL_VARIANT_REVIEW_VARIANTS = Object.freeze({
  "industrial-forge": Object.freeze({
    id: "industrial-forge-girder-terrace-v1",
    wall: Object.freeze({ cap: "stepped-continuous", edge: "south-east", geometry: "riveted-2px-cap" }),
    bridge: Object.freeze({ axis: "horizontal", geometry: "gantry-crossbeam", edge: "double-rail" }),
    ramp: Object.freeze({ axis: "horizontal", geometry: "paired-switchback", edge: "iron-threshold" }),
    cliff: Object.freeze({ edge: "east", geometry: "exposed-slab", height: 2 }),
    object: Object.freeze({ geometry: "caged-smelter-tower", footprint: "2x2" }),
    lamp: Object.freeze({ geometry: "double-cage", rays: 4 }),
    lighting: Object.freeze({ geometry: "linear-amber-cone", occlusion: "south-east" }),
  }),
  "crystal-overgrowth": Object.freeze({
    id: "crystal-overgrowth-faceted-basin-v1",
    wall: Object.freeze({ cap: "faceted-continuous", edge: "north-east", geometry: "chamfered-3px-cap" }),
    bridge: Object.freeze({ axis: "vertical", geometry: "living-truss", edge: "triple-spine" }),
    ramp: Object.freeze({ axis: "vertical", geometry: "split-prism", edge: "crystal-threshold" }),
    cliff: Object.freeze({ edge: "north", geometry: "faceted-face", height: 2 }),
    object: Object.freeze({ geometry: "root-prism-tower", footprint: "3x2" }),
    lamp: Object.freeze({ geometry: "prism-crown", rays: 6 }),
    lighting: Object.freeze({ geometry: "radial-bloom", occlusion: "north-east" }),
  }),
  "occult-machine-catacomb": Object.freeze({
    id: "occult-machine-catacomb-buttressed-ritual-v1",
    wall: Object.freeze({ cap: "buttressed-continuous", edge: "south-west", geometry: "ritual-5px-cap" }),
    bridge: Object.freeze({ axis: "horizontal", geometry: "reliquary-arch", edge: "single-keystone" }),
    ramp: Object.freeze({ axis: "horizontal", geometry: "stepped-altar", edge: "ossuary-threshold" }),
    cliff: Object.freeze({ edge: "west", geometry: "north-ossuary-face", height: 2 }),
    object: Object.freeze({ geometry: "reliquary-tower", footprint: "2x3" }),
    lamp: Object.freeze({ geometry: "candle-thicket", rays: 3 }),
    lighting: Object.freeze({ geometry: "ritual-ring", occlusion: "south-west" }),
  }),
  "zero-gravity-reactor": Object.freeze({
    id: "zero-gravity-reactor-suspended-phase-v1",
    wall: Object.freeze({ cap: "floating-ring", edge: "all-suspended", geometry: "gap-3px-cap" }),
    bridge: Object.freeze({ axis: "vertical", geometry: "phase-spine", edge: "offset-crossbar" }),
    ramp: Object.freeze({ axis: "vertical", geometry: "radial-orbit", edge: "magnetic-threshold" }),
    cliff: Object.freeze({ edge: "all", geometry: "zero-g-shear-face", height: 3 }),
    object: Object.freeze({ geometry: "reactor-coil-tower", footprint: "3x3" }),
    lamp: Object.freeze({ geometry: "ion-orbit", rays: 8 }),
    lighting: Object.freeze({ geometry: "elliptic-reactor-cone", occlusion: "all-suspended" }),
  }),
});
const biomeStructuralVariantReviewRequested = launchParams.get("biomeStructuralVariantReview") === "1";
const biomeStructuralVariantReviewEnabled = biomeStructuralVariantReviewRequested
  && allowDevelopmentQuery
  && (vaultSurface !== "map-viewer"
    || verifiedMapViewerContext
    || artReviewMode
    || launchParams.get("dev") === "1");
document.documentElement.dataset.vaultBiomeStructuralVariantReviewSchema = BIOME_STRUCTURAL_VARIANT_REVIEW_SCHEMA;
document.documentElement.dataset.vaultBiomeStructuralVariantReviewVersion = String(BIOME_STRUCTURAL_VARIANT_REVIEW_VERSION);
document.documentElement.dataset.vaultBiomeStructuralVariantReviewFlag = biomeStructuralVariantReviewEnabled ? "1" : "0";
document.documentElement.dataset.vaultBiomeStructuralVariantReview = biomeStructuralVariantReviewEnabled ? "pending" : "disabled";
document.documentElement.dataset.vaultBiomeStructuralVariantReviewBoundary = BIOME_STRUCTURAL_VARIANT_REVIEW_BOUNDARY;

const directionOrder = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
const weaponImages = new Map();
const weaponMaterialBuildCache = new Map();
const weaponMaterialFrameCache = new Map();
const gyroSpinFrames = await Promise.all(Array.from({ length: 9 }, (_, index) => loadImage(`./assets/weapons/generated-v1/gyro-saw-spin/frame-${index}.png`)));
const rawOrbImage = await loadImage(atlas.character.source);
let orbImage = rawOrbImage;
const orbMaterialInputs = await loadOrbMaterialInputs();
const forgeAtlasImage = removeConnectedLightBackground(await loadImage(`./${atlas.gameArt.biomeAtlases["industrial-forge"].source}`));
const biomeAtlasImages = new Map([["industrial-forge", forgeAtlasImage]]);
const signalCryptTilekit = await loadImage("./assets/game/tilekits/signal-crypt-v3/runtime-tilekit-64.png");
const signalCryptAnimations = await loadImage("./assets/game/tilekits/signal-crypt-v3/runtime-animations-64.png");
const signalCryptFloorMacros = await loadImage("./assets/game/tilekits/signal-crypt-v4/runtime-floor-macros-2x2.png");
const signalCryptMaterials = await loadImage("./assets/game/tilekits/signal-crypt-v5/runtime-material-atlas-4x4.png");
const tilekitSpriteCache = new Map();
const floorMacroSpriteCache = new Map();
const signalMaterialCache = new Map();
const forgeSpriteCache = new Map();
const forgeMaterialCache = new Map();
const forgeDrifterSource = await loadImage("./assets/enemies/candidates/forge-drifter-v1/eight-direction-48.png");
const forgeDrifterMaterialMap = await loadImage("./assets/enemies/candidates/forge-drifter-v1/material-id-map-48.png");
const pixellabLancerSource = await loadImage("./assets/enemies/candidates/pixellab-lancer-v1/eight-direction-master.png");
const pixellabLancerMaterialMap = await loadImage("./assets/enemies/candidates/pixellab-lancer-v1/material-id-map.png");
const pixellabLancerAnimations = Object.fromEntries(await Promise.all(Object.entries({
  idle: { frames: 5, frameMs: 150, loop: true },
  move: { frames: 9, frameMs: 82, loop: true },
  charge: { frames: 9, frameMs: 78, loop: false },
  hit: { frames: 5, frameMs: 64, loop: false },
  death: { frames: 9, frameMs: 88, loop: false },
}).map(async ([name, spec]) => [name, {
  ...spec,
  source: await loadImage(`./assets/enemies/candidates/pixellab-lancer-v1/animations/${name}/source.png`),
  materialMap: await loadImage(`./assets/enemies/candidates/pixellab-lancer-v1/animations/${name}/material-id-map.png`),
}])));
const LANCER_ANIMATION_REVIEW = "rejected-pending-rotor-spin-review-v1";
const enemyMaterialCache = new Map();
const forgeFloorMaterial = await loadImage(`./${atlas.gameArt.materials["industrial-forge"].source}`);
const floorMaterialCache = new Map();
const floorVariationPatternCache = new Map();
const forgeWallMaterial = await loadImage(`./${atlas.gameArt.materials["industrial-forge-wall"].source}`);
const wallMaterialCache = new Map();
const authoredSurfaceRuntime = authoredQuiltPrototypeEnabled
  ? authoredSurfaceModule.createAuthoredSurfaceRuntime({
      signalMaterialImage: signalCryptMaterials,
      signalMacroImage: signalCryptFloorMacros,
      forgeMaterialImage: forgeFloorMaterial,
    })
  : null;
await Promise.all(atlas.weapons.map(async (weapon) => weaponImages.set(weapon.id, await loadImage(weapon.source))));

const keys = new Set();
const heldInputActions = new Set();
let inputBindings = (() => {
  try { return sanitizeVaultBindings(JSON.parse(localStorage.getItem(VAULT_INPUT_STORAGE_KEY) ?? "{}")); }
  catch { return sanitizeVaultBindings({}); }
})();
let gamepadInput = readVaultGamepad([]);
let previousGamepadInput = gamepadInput;
window.addEventListener("storage", (event) => {
  if (event.key !== VAULT_INPUT_STORAGE_KEY) return;
  try { inputBindings = sanitizeVaultBindings(JSON.parse(event.newValue ?? "{}")); }
  catch { inputBindings = sanitizeVaultBindings({}); }
});
const pointer = { x: canvas.width * 0.72, y: canvas.height / 2, down: false, alternate: false };
const touchInput = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, aimActive: false, block: false };
let run = null;
let profile = null;
let arena = null;
let player = null;
let enemies = [];
let defeatedEnemies = [];
let projectiles = [];
let effects = [];
let pickups = [];
let layer = 1;
let score = 0;
let elapsed = 0;
let lastFrame = performance.now();
let started = false;
let pausedForShop = false;
let nextEntityId = 1;
let toastTimer = 0;
let spawnQueue = [];
let challengeTimer = 0;
let layerClearedAt = 0;
let layerStartedAt = 0;
let activeRoomIndex = 0;
let roomHoldoutEndsAt = 0;
let exitActive = false;
let exitActiveAt = 0;
let layerDecisionApplied = false;
let combatRng = makeRng("vault-map-001:combat");
let relay = null;
const camera = { x: 0, y: 0 };
let puzzleTouchReadyAt = 0;
const MOB_MASK_STORAGE_KEY = "vault:mob-mask-overrides:v1";
let mobMaskOverrides = loadMobMaskOverrides();
let sharedMobVisualRecipes = [];
let wallDoorStructureReviewState = null;
let worldFeatureRenderReviewState = null;
let biomeStructuralVariantReviewState = null;

window.addEventListener("storage", (event) => {
  if (event.key !== MOB_MASK_STORAGE_KEY) return;
  mobMaskOverrides = loadMobMaskOverrides();
  enemyMaterialCache.clear();
});

function loadMobMaskOverrides() {
  try {
    const value = JSON.parse(localStorage.getItem(MOB_MASK_STORAGE_KEY));
    if (value?.schema === "vault-mob-mask-overrides@1") return value;
  } catch {}
  return { schema: "vault-mob-mask-overrides@1", assets: {} };
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image failed: ${source}`));
    image.src = source;
  });
}

function removeConnectedLightBackground(image) {
  const output = document.createElement("canvas");
  output.width = image.naturalWidth;
  output.height = image.naturalHeight;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  outputContext.drawImage(image, 0, 0);
  const frame = outputContext.getImageData(0, 0, output.width, output.height);
  const visited = new Uint8Array(output.width * output.height);
  const queue = [];
  const enqueue = (x, y) => {
    const index = y * output.width + x;
    if (visited[index]) return;
    const offset = index * 4;
    const minimum = Math.min(frame.data[offset], frame.data[offset + 1], frame.data[offset + 2]);
    const maximum = Math.max(frame.data[offset], frame.data[offset + 1], frame.data[offset + 2]);
    if (minimum < 210 || maximum - minimum > 12) return;
    visited[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < output.width; x += 1) { enqueue(x, 0); enqueue(x, output.height - 1); }
  for (let y = 0; y < output.height; y += 1) { enqueue(0, y); enqueue(output.width - 1, y); }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % output.width;
    const y = Math.floor(index / output.width);
    frame.data[index * 4 + 3] = 0;
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < output.width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < output.height) enqueue(x, y + 1);
  }
  outputContext.putImageData(frame, 0, 0);
  return output;
}

const WALL_DOOR_STRUCTURE_REVIEW_PROGRESS = Object.freeze([0, 0.5, 1]);

// The live arena names the long passage axis, while the approved harness names
// the long wall/door frame axis. A live horizontal passage therefore uses the
// harness vertical assembly, and vice versa. Keep this conversion explicit in
// both the pixels and the browser-readable receipt.
function harnessAxisForLiveDoor(liveAxis) {
  if (liveAxis === "horizontal") return "vertical";
  if (liveAxis === "vertical") return "horizontal";
  return null;
}

function wallCellsNearConnection(arenaLayout, connection) {
  const doorTiles = connection?.door?.tiles ?? [];
  if (!doorTiles.length) return [];
  const minimumColumn = Math.min(...doorTiles.map((tile) => tile.column)) - 1;
  const maximumColumn = Math.max(...doorTiles.map((tile) => tile.column)) + 1;
  const minimumRow = Math.min(...doorTiles.map((tile) => tile.row)) - 1;
  const maximumRow = Math.max(...doorTiles.map((tile) => tile.row)) + 1;
  const cells = [];
  for (let row = minimumRow; row <= maximumRow; row += 1) {
    for (let column = minimumColumn; column <= maximumColumn; column += 1) {
      if (column < 0 || row < 0 || column >= arenaLayout.columns || row >= arenaLayout.rows) continue;
      if (arenaLayout.tiles[row * arenaLayout.columns + column]?.kind === "wall") cells.push({ column, row });
    }
  }
  return cells;
}

function rasterCanvas(raster) {
  const image = document.createElement("canvas");
  image.width = raster.width;
  image.height = raster.height;
  const imageContext = image.getContext("2d");
  imageContext.imageSmoothingEnabled = false;
  const imageData = imageContext.createImageData(raster.width, raster.height);
  imageData.data.set(raster.pixels);
  imageContext.putImageData(imageData, 0, 0);
  return image;
}

function publishWallDoorStructureReview(audit) {
  const frozenAudit = Object.freeze(audit);
  globalThis.__vaultWallDoorStructureReview = frozenAudit;
  globalThis.__vaultWallDoorStructureReviewAudit = frozenAudit;
  const rgbaHashes = Object.entries(audit.deterministicRgbaHashes ?? {})
    .map(([axis, hashes]) => `${axis}:${hashes.join(",")}`)
    .join("|");
  const connectedRuns = Object.entries(audit.connectedRunStatus ?? {})
    .map(([axis, connected]) => `${axis}:${connected ? "true" : "false"}`)
    .join(",");
  const dataset = {
    vaultWallDoorStructureSchema: audit.schema,
    vaultWallDoorStructureVersion: String(audit.version),
    vaultWallDoorStructureFlag: audit.enabled ? "1" : "0",
    vaultWallDoorStructureReview: audit.status,
    vaultWallDoorStructureMapSeed: audit.mapSeed ?? "",
    vaultWallDoorStructureLayer: String(audit.layer ?? ""),
    vaultWallDoorStructureBiome: audit.biome ?? "",
    vaultWallDoorStructureIntegratedWallCount: String(audit.integratedWallCount ?? 0),
    vaultWallDoorStructureIntegratedDoorCount: String(audit.integratedDoorCount ?? 0),
    vaultWallDoorStructureIntegratedStateCount: String(audit.integratedStateCount ?? 0),
    vaultWallDoorStructureRgbaHashes: rgbaHashes,
    vaultWallDoorStructureRenderCollisionShared: String(Boolean(audit.renderCollisionApertureShared)),
    vaultWallDoorStructureConnectedRuns: connectedRuns,
    vaultWallDoorStructureAuditHash: audit.auditHash ?? "",
    vaultWallDoorStructureAxisMapping: audit.axisMapping ?? WALL_DOOR_STRUCTURE_AXIS_MAPPING,
    vaultWallDoorStructureReviewBoundary: audit.reviewBoundary ?? WALL_DOOR_STRUCTURE_REVIEW_BOUNDARY,
    vaultWallDoorStructureMaterial: audit.material ?? "neutral-deterministic-grayscale",
  };
  for (const [key, value] of Object.entries(dataset)) document.documentElement.dataset[key.replace(/^vault/, "vault")] = value;
}

function buildWallDoorStructureReview({ arenaLayout, mapSeed, layerNumber, biome }) {
  if (!wallDoorStructureReviewEnabled) return null;
  const rows = ["horizontal", "vertical"].map((liveAxis) => {
    const connection = arenaLayout.connections
      .filter((candidate) => candidate.door?.axis === liveAxis)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
    if (!connection) return Object.freeze({ liveAxis, harnessAxis: harnessAxisForLiveDoor(liveAxis), connection: null, states: Object.freeze([]), sourceWallCells: Object.freeze([]) });
    const door = connection.door;
    const harnessAxis = harnessAxisForLiveDoor(liveAxis);
    const span = door.span ?? door.tiles.length;
    const states = WALL_DOOR_STRUCTURE_REVIEW_PROGRESS.map((progress) => {
      const raster = rasterizeWallDoorAssembly({
        axis: harnessAxis,
        progress,
        span,
        tileSize: 24,
        projectionDepth: 5,
        shadowOffset: 3,
        padding: 6,
      });
      return Object.freeze({
        progress,
        apertureSize: raster.audit.apertureSize,
        fullApertureSize: raster.audit.fullApertureSize,
        rgbaHash: rgbaHash(raster),
        raster,
        image: rasterCanvas(raster),
      });
    });
    return Object.freeze({
      liveAxis,
      harnessAxis,
      connection,
      span,
      sourceWallCells: Object.freeze(wallCellsNearConnection(arenaLayout, connection)),
      wallCellCount: states[0].raster.geometry.wallCells.length,
      states: Object.freeze(states),
    });
  });
  const validRows = rows.filter((row) => row.connection);
  const connectedRunStatus = Object.fromEntries(rows.map((row) => [row.liveAxis, row.states.length === 3 && row.states.every((state) => state.raster.audit.connectedWallRun)]));
  const renderCollisionApertureShared = validRows.length === 2
    && validRows.every((row) => row.states.every((state) => state.raster.audit.renderCollisionShared));
  const deterministicRgbaHashes = Object.fromEntries(rows.map((row) => [row.liveAxis, row.states.map((state) => state.rgbaHash)]));
  const apertureMonotonic = Object.fromEntries(rows.map((row) => [row.liveAxis, row.states.length === 3 && row.states.every((state, index) => index === 0 || state.apertureSize >= row.states[index - 1].apertureSize)]));
  const wallRuns = Object.fromEntries(rows.map((row) => [row.liveAxis, row.states[0] ? {
    harnessAxis: row.harnessAxis,
    cellCount: row.wallCellCount,
    connected: row.states[0].raster.audit.connectedWallRun,
    componentCount: row.states[0].raster.audit.componentCount,
    reciprocalJoinCount: row.states[0].raster.audit.reciprocalJoinCount,
    continuousTopCap: row.states[0].raster.audit.continuousTopCap,
    exposedSouthFaceCount: row.states[0].raster.audit.exposedSouthFaceCount,
    exposedEastFaceCount: row.states[0].raster.audit.exposedEastFaceCount,
    shadowPixelCount: row.states[0].raster.audit.shadowPixelCount,
    internalSeamPixels: row.states[0].raster.audit.internalSeamPixels,
  } : null]));
  const sourceDoorConnections = rows.map((row) => row.connection ? {
    id: row.connection.id,
    from: row.connection.from,
    to: row.connection.to,
    kind: row.connection.kind,
    liveAxis: row.liveAxis,
    harnessAxis: row.harnessAxis,
    column: row.connection.door.column,
    row: row.connection.door.row,
    span: row.span,
    tileCount: row.connection.door.tiles.length,
    sourceWallCellCount: row.sourceWallCells.length,
  } : {
    id: null,
    liveAxis: row.liveAxis,
    harnessAxis: row.harnessAxis,
    sourceWallCellCount: 0,
  });
  const audit = {
    schema: WALL_DOOR_STRUCTURE_REVIEW_SCHEMA,
    version: WALL_DOOR_STRUCTURE_REVIEW_VERSION,
    enabled: true,
    status: "ready",
    flag: "wallDoorStructureReview=1",
    mapSeed,
    layer: layerNumber,
    biome,
    mapSchema: arenaLayout.schema,
    source: "seeded-arena-connections-with-approved-wall-door-raster",
    material: "neutral-deterministic-grayscale",
    axisMapping: WALL_DOOR_STRUCTURE_AXIS_MAPPING,
    integratedWallCount: validRows.reduce((sum, row) => sum + row.wallCellCount, 0),
    integratedDoorCount: validRows.length,
    integratedStateCount: validRows.reduce((sum, row) => sum + row.states.length, 0),
    deterministicRgbaHashes,
    renderCollisionApertureShared,
    connectedRunStatus,
    apertureMonotonic,
    wallRuns,
    doorStates: Object.fromEntries(rows.map((row) => [row.liveAxis, row.states.map((state) => ({ progress: state.progress, apertureSize: state.apertureSize, fullApertureSize: state.fullApertureSize, rgbaHash: state.rgbaHash }))])),
    sourceDoorConnections,
    reviewBoundary: WALL_DOOR_STRUCTURE_REVIEW_BOUNDARY,
  };
  audit.auditHash = deterministicFingerprint({
    schema: audit.schema,
    mapSeed: audit.mapSeed,
    layer: audit.layer,
    biome: audit.biome,
    axisMapping: audit.axisMapping,
    integratedWallCount: audit.integratedWallCount,
    integratedDoorCount: audit.integratedDoorCount,
    deterministicRgbaHashes: audit.deterministicRgbaHashes,
    renderCollisionApertureShared: audit.renderCollisionApertureShared,
    connectedRunStatus: audit.connectedRunStatus,
    sourceDoorConnections: audit.sourceDoorConnections,
  });
  publishWallDoorStructureReview(audit);
  return Object.freeze({ rows: Object.freeze(rows), audit: Object.freeze(audit) });
}

function worldFeatureTileKey(point) {
  return `${point.column},${point.row}`;
}

function worldFeatureBounds(points) {
  if (!points.length) return { minimumColumn: 0, maximumColumn: 0, minimumRow: 0, maximumRow: 0, width: 0, height: 0 };
  const columns = points.map((point) => point.column);
  const rows = points.map((point) => point.row);
  const minimumColumn = Math.min(...columns);
  const maximumColumn = Math.max(...columns);
  const minimumRow = Math.min(...rows);
  const maximumRow = Math.max(...rows);
  return {
    minimumColumn,
    maximumColumn,
    minimumRow,
    maximumRow,
    width: maximumColumn - minimumColumn + 1,
    height: maximumRow - minimumRow + 1,
  };
}

function worldFeatureMemberContinuity(points) {
  if (!points.length) return false;
  const members = new Set(points.map(worldFeatureTileKey));
  const first = points[0];
  const visited = new Set([worldFeatureTileKey(first)]);
  const pending = [first];
  while (pending.length) {
    const point = pending.shift();
    for (const [column, row] of [[point.column - 1, point.row], [point.column + 1, point.row], [point.column, point.row - 1], [point.column, point.row + 1]]) {
      const key = `${column},${row}`;
      if (!members.has(key) || visited.has(key)) continue;
      visited.add(key);
      pending.push({ column, row });
    }
  }
  return visited.size === members.size;
}

function worldFeatureHoleCount(points) {
  if (!points.length) return 0;
  const bounds = worldFeatureBounds(points);
  const members = new Set(points.map(worldFeatureTileKey));
  const outside = new Set();
  const pending = [];
  const enqueue = (column, row) => {
    const key = `${column},${row}`;
    if (column < bounds.minimumColumn || column > bounds.maximumColumn || row < bounds.minimumRow || row > bounds.maximumRow || members.has(key) || outside.has(key)) return;
    outside.add(key);
    pending.push({ column, row });
  };
  for (let column = bounds.minimumColumn; column <= bounds.maximumColumn; column += 1) {
    enqueue(column, bounds.minimumRow);
    enqueue(column, bounds.maximumRow);
  }
  for (let row = bounds.minimumRow; row <= bounds.maximumRow; row += 1) {
    enqueue(bounds.minimumColumn, row);
    enqueue(bounds.maximumColumn, row);
  }
  while (pending.length) {
    const point = pending.shift();
    enqueue(point.column - 1, point.row);
    enqueue(point.column + 1, point.row);
    enqueue(point.column, point.row - 1);
    enqueue(point.column, point.row + 1);
  }
  let holes = 0;
  for (let row = bounds.minimumRow; row <= bounds.maximumRow; row += 1) for (let column = bounds.minimumColumn; column <= bounds.maximumColumn; column += 1) {
    const key = `${column},${row}`;
    if (!members.has(key) && !outside.has(key)) holes += 1;
  }
  return holes;
}

function worldFeatureDirectionAxis(direction) {
  return ["east", "west"].includes(direction) ? "horizontal" : ["north", "south"].includes(direction) ? "vertical" : null;
}

function worldFeatureReviewColors(palette) {
  return {
    floor: palette?.floor ?? "#08100f",
    floor2: palette?.floor2 ?? "#14231f",
    line: palette?.line ?? "#8ca79f",
    accent: palette?.accent ?? "#67f6c5",
    hostile: palette?.hostile ?? "#ff6d7a",
    ambient: palette?.ambient ?? "#8f8cff",
  };
}

const WORLD_FEATURE_OCCLUSION_SHADOW_REGION = Object.freeze({
  minimumX: 42,
  maximumX: 110,
  minimumY: 46,
  maximumY: 64,
  backgroundX: 16,
  backgroundY: 16,
  minimumLumaDelta: 8,
});

function worldFeatureReviewLuma(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function worldFeatureReviewPolygon(targetContext, sides, radius, centerX, centerY) {
  targetContext.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = index / sides * Math.PI * 2 - Math.PI / 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    if (index === 0) targetContext.moveTo(x, y);
    else targetContext.lineTo(x, y);
  }
  targetContext.closePath();
}

function worldFeatureReviewSpecimen(category, data, palette) {
  const output = document.createElement("canvas");
  output.width = 176;
  output.height = 72;
  const targetContext = output.getContext("2d", { willReadFrequently: true });
  targetContext.imageSmoothingEnabled = false;
  const colors = worldFeatureReviewColors(palette);
  targetContext.fillStyle = "#050b0c";
  targetContext.fillRect(0, 0, output.width, output.height);
  targetContext.strokeStyle = rgba(colors.line, 0.34);
  targetContext.lineWidth = 1;
  targetContext.strokeRect(0.5, 0.5, output.width - 1, output.height - 1);
  if (!data) return output;

  if (category === "bridges") {
    const bounds = data.bounds;
    const members = new Set(data.members.map(worldFeatureTileKey));
    const cell = Math.max(4, Math.floor(Math.min(56 / Math.max(1, bounds.width), 56 / Math.max(1, bounds.height))));
    const left = Math.round((output.width - bounds.width * cell) / 2);
    const top = Math.round((output.height - bounds.height * cell) / 2);
    for (let row = bounds.minimumRow; row <= bounds.maximumRow; row += 1) for (let column = bounds.minimumColumn; column <= bounds.maximumColumn; column += 1) {
      const present = members.has(`${column},${row}`);
      targetContext.fillStyle = present ? rgba(colors.accent, 0.82) : "#101a19";
      targetContext.fillRect(left + (column - bounds.minimumColumn) * cell, top + (row - bounds.minimumRow) * cell, cell - 1, cell - 1);
      targetContext.strokeStyle = present ? rgba(colors.line, 0.7) : "#1d2a27";
      targetContext.strokeRect(left + (column - bounds.minimumColumn) * cell + 0.5, top + (row - bounds.minimumRow) * cell + 0.5, cell - 2, cell - 2);
    }
    return output;
  }

  if (category === "ramps") {
    const bounds = data.bounds;
    const cell = Math.max(4, Math.floor(Math.min(56 / Math.max(1, bounds.width), 56 / Math.max(1, bounds.height))));
    const left = Math.round((output.width - bounds.width * cell) / 2);
    const top = Math.round((output.height - bounds.height * cell) / 2);
    for (const tile of data.tiles) {
      const level = tile.level ?? 0;
      targetContext.fillStyle = level > 0 ? rgba(colors.accent, 0.88) : rgba(colors.ambient, 0.7);
      targetContext.fillRect(left + (tile.column - bounds.minimumColumn) * cell, top + (tile.row - bounds.minimumRow) * cell, cell - 1, cell - 1);
    }
    const centerX = left + bounds.width * cell / 2;
    const centerY = top + bounds.height * cell / 2;
    const horizontal = data.axis === "horizontal";
    targetContext.strokeStyle = colors.line;
    targetContext.lineWidth = 2;
    targetContext.beginPath();
    targetContext.moveTo(horizontal ? left + 2 : centerX, horizontal ? centerY : top + bounds.height * cell - 2);
    targetContext.lineTo(horizontal ? left + bounds.width * cell - 2 : centerX, horizontal ? centerY : top + 2);
    targetContext.stroke();
    return output;
  }

  if (category === "cliffs") {
    const bounds = data.bounds;
    const cell = Math.max(4, Math.floor(Math.min(56 / Math.max(1, bounds.width), 56 / Math.max(1, bounds.height))));
    const left = Math.round((output.width - bounds.width * cell) / 2);
    const top = Math.round((output.height - bounds.height * cell) / 2);
    for (const tile of data.tiles) {
      const x = left + (tile.column - bounds.minimumColumn) * cell;
      const y = top + (tile.row - bounds.minimumRow) * cell;
      targetContext.fillStyle = rgba(colors.floor2, 0.9);
      targetContext.fillRect(x, y, cell - 1, cell - 1);
      targetContext.fillStyle = rgba(colors.hostile, 0.78);
      const face = Math.max(2, Math.min(cell - 1, data.height * 2 + 2));
      if (data.direction === "north") targetContext.fillRect(x, y, cell - 1, face);
      else if (data.direction === "south") targetContext.fillRect(x, y + cell - face - 1, cell - 1, face);
      else if (data.direction === "west") targetContext.fillRect(x, y, face, cell - 1);
      else targetContext.fillRect(x + cell - face - 1, y, face, cell - 1);
    }
    return output;
  }

  if (category === "objects") {
    data.representatives.forEach((object, index) => {
      const centerX = 28 + index * 54;
      const centerY = 42;
      targetContext.fillStyle = "rgba(0,0,0,.62)";
      targetContext.beginPath();
      targetContext.ellipse(centerX + 3, centerY + 12, 20, 6, 0, 0, Math.PI * 2);
      targetContext.fill();
      const sides = object.feature === "tower" ? 4 : object.type === "puzzle-node" ? 6 : object.type === "coil" ? 8 : 5;
      targetContext.fillStyle = rgba(object.feature === "tower" ? colors.accent : colors.line, 0.88);
      worldFeatureReviewPolygon(targetContext, sides, Math.min(18, object.radius ?? 14), centerX, centerY);
      targetContext.fill();
      targetContext.strokeStyle = colors.line;
      targetContext.lineWidth = 1;
      targetContext.stroke();
    });
    return output;
  }

  if (category === "occlusion") {
    targetContext.fillStyle = colors.floor2;
    targetContext.fillRect(8, 8, 160, 56);
    targetContext.fillStyle = rgba(colors.line, 0.85);
    targetContext.fillRect(112, 9, 38, 54);
    targetContext.fillStyle = "rgba(0,0,0,.72)";
    targetContext.beginPath();
    targetContext.ellipse(76, 55, 34, 9, 0, 0, Math.PI * 2);
    targetContext.fill();
    targetContext.fillStyle = rgba(colors.accent, 0.9);
    targetContext.beginPath();
    targetContext.arc(76, 38, 13, 0, Math.PI * 2);
    targetContext.fill();
    targetContext.strokeStyle = colors.hostile;
    targetContext.lineWidth = 2;
    targetContext.strokeRect(112.5, 9.5, 37, 53);
    return output;
  }

  if (category === "lamps") {
    const gradient = targetContext.createRadialGradient(88, 20, 1, 88, 20, 28);
    gradient.addColorStop(0, "rgba(255,255,255,.96)");
    gradient.addColorStop(0.3, rgba(colors.accent, 0.86));
    gradient.addColorStop(1, rgba(colors.accent, 0));
    targetContext.fillStyle = gradient;
    targetContext.fillRect(50, 2, 76, 54);
    targetContext.fillStyle = rgba(colors.floor2, 0.96);
    worldFeatureReviewPolygon(targetContext, 4, 20, 88, 48);
    targetContext.fill();
    targetContext.strokeStyle = colors.line;
    targetContext.lineWidth = 2;
    targetContext.stroke();
    targetContext.fillStyle = "#ffffff";
    targetContext.beginPath();
    targetContext.arc(88, 20, 5, 0, Math.PI * 2);
    targetContext.fill();
    return output;
  }

  if (category === "lighting") {
    const cell = 10;
    const left = 8;
    const top = 8;
    for (const tile of data.visibleTiles) {
      targetContext.fillStyle = rgba(colors.accent, tile.tile.kind === "door" ? 0.56 : 0.26);
      targetContext.fillRect(left + tile.column * cell, top + tile.row * cell, cell - 1, cell - 1);
    }
    for (const tile of data.wallTiles) {
      targetContext.fillStyle = rgba(colors.hostile, 0.66);
      targetContext.fillRect(left + tile.column * cell, top + tile.row * cell, cell - 1, cell - 1);
    }
    const gradient = targetContext.createRadialGradient(42, 38, 1, 42, 38, 37);
    gradient.addColorStop(0, rgba(colors.accent, 0.78));
    gradient.addColorStop(1, rgba(colors.accent, 0));
    targetContext.globalCompositeOperation = "screen";
    targetContext.fillStyle = gradient;
    targetContext.fillRect(5, 4, 82, 64);
    targetContext.globalCompositeOperation = "source-over";
    targetContext.strokeStyle = colors.line;
    targetContext.lineWidth = 2;
    targetContext.beginPath();
    targetContext.arc(42, 38, 5, 0, Math.PI * 2);
    targetContext.stroke();
  }
  return output;
}

function worldFeatureReviewRasterReceipt(image, category) {
  const imageContext = image.getContext("2d", { willReadFrequently: true });
  const frame = imageContext.getImageData(0, 0, image.width, image.height);
  const shadowRegion = WORLD_FEATURE_OCCLUSION_SHADOW_REGION;
  const shadowBackgroundOffset = ((shadowRegion.backgroundY * image.width) + shadowRegion.backgroundX) * 4;
  const shadowBackgroundRgba = [
    frame.data[shadowBackgroundOffset],
    frame.data[shadowBackgroundOffset + 1],
    frame.data[shadowBackgroundOffset + 2],
    frame.data[shadowBackgroundOffset + 3],
  ];
  const shadowBackgroundLuma = worldFeatureReviewLuma(...shadowBackgroundRgba.slice(0, 3));
  let nonzeroPixelCount = 0;
  let inkPixelCount = 0;
  let shadowPixelCount = 0;
  let lampPixelCount = 0;
  let lightPixelCount = 0;
  for (let offset = 0; offset < frame.data.length; offset += 4) {
    const pixel = offset / 4;
    const pixelX = pixel % image.width;
    const pixelY = Math.floor(pixel / image.width);
    if (frame.data[offset] || frame.data[offset + 1] || frame.data[offset + 2] || frame.data[offset + 3]) nonzeroPixelCount += 1;
    if (frame.data[offset] !== 5 || frame.data[offset + 1] !== 11 || frame.data[offset + 2] !== 12 || frame.data[offset + 3] !== 255) inkPixelCount += 1;
    if (category === "occlusion"
      && pixelX >= shadowRegion.minimumX
      && pixelX <= shadowRegion.maximumX
      && pixelY >= shadowRegion.minimumY
      && pixelY <= shadowRegion.maximumY
      && frame.data[offset + 3] >= 250
      && shadowBackgroundRgba[3] >= 250
      && shadowBackgroundLuma - worldFeatureReviewLuma(frame.data[offset], frame.data[offset + 1], frame.data[offset + 2]) >= shadowRegion.minimumLumaDelta) {
      shadowPixelCount += 1;
    }
    if (category === "lamps" && pixelX >= 50 && pixelX <= 126 && pixelY <= 56 && (frame.data[offset] > 120 || frame.data[offset + 1] > 120 || frame.data[offset + 2] > 120)) lampPixelCount += 1;
    if (category === "lighting" && pixelX >= 5 && pixelX <= 90 && pixelY >= 4 && pixelY <= 68 && (frame.data[offset] !== 5 || frame.data[offset + 1] !== 11 || frame.data[offset + 2] !== 12)) lightPixelCount += 1;
  }
  return {
    width: image.width,
    height: image.height,
    rgbaHash: rgbaHash({ pixels: frame.data }),
    nonzeroPixelCount,
    inkPixelCount,
    shadowPixelCount,
    shadowPixelsObserved: category === "occlusion" && shadowPixelCount > 0,
    shadowPixelCriterion: category === "occlusion" ? "actual-rgba; sampled-floor-background-luma-delta>=8" : null,
    shadowBackground: category === "occlusion" ? {
      x: shadowRegion.backgroundX,
      y: shadowRegion.backgroundY,
      rgba: shadowBackgroundRgba,
      luma: Number(shadowBackgroundLuma.toFixed(3)),
    } : null,
    lampPixelCount,
    lightPixelCount,
  };
}

function publishWorldFeatureRenderReview(audit) {
  const frozenAudit = Object.freeze(audit);
  globalThis.__vaultWorldFeatureRenderReview = frozenAudit;
  globalThis.__vaultWorldFeatureRenderReviewAudit = frozenAudit;
  const counts = WORLD_FEATURE_REVIEW_CATEGORIES.map((category) => `${category}:${audit.categories[category].count}`).join(",");
  const hashes = WORLD_FEATURE_REVIEW_CATEGORIES.map((category) => `${category}:${audit.categories[category].rgbaHash}`).join(",");
  const nonzeroPixels = WORLD_FEATURE_REVIEW_CATEGORIES.map((category) => `${category}:${audit.categories[category].nonzeroPixelCount}`).join(",");
  const gates = WORLD_FEATURE_REVIEW_CATEGORIES.map((category) => `${category}:${audit.gates[category] ? "true" : "false"}`).join(",");
  const occlusion = audit.categories.occlusion;
  Object.assign(document.documentElement.dataset, {
    vaultWorldFeatureRenderSchema: audit.schema,
    vaultWorldFeatureRenderVersion: String(audit.version),
    vaultWorldFeatureRenderFlag: audit.enabled ? "1" : "0",
    vaultWorldFeatureRenderReview: audit.status,
    vaultWorldFeatureRenderMapSeed: audit.mapSeed,
    vaultWorldFeatureRenderLayer: String(audit.layer),
    vaultWorldFeatureRenderBiome: audit.biome,
    vaultWorldFeatureRenderCategoryCounts: counts,
    vaultWorldFeatureRenderRgbaHashes: hashes,
    vaultWorldFeatureRenderNonzeroPixels: nonzeroPixels,
    vaultWorldFeatureRenderGates: gates,
    vaultWorldFeatureRenderOcclusionShadowPixelCount: String(occlusion.shadowPixelCount),
    vaultWorldFeatureRenderOcclusionShadowPixelsObserved: occlusion.shadowPixelsObserved ? "true" : "false",
    vaultWorldFeatureRenderOcclusionShadowBackground: occlusion.shadowBackground?.rgba?.join(",") ?? "",
    vaultWorldFeatureRenderAuditHash: audit.auditHash,
    vaultWorldFeatureRenderFrozen: audit.frozenVisuals ? "1" : "0",
    vaultWorldFeatureRenderReviewBoundary: audit.reviewBoundary,
    vaultWorldFeatureRenderMaterial: audit.material,
  });
}

function buildWorldFeatureRenderReview({ arenaLayout, mapSeed, layerNumber, biome }) {
  if (!worldFeatureRenderReviewEnabled) return null;
  const indexedTiles = arenaLayout.tiles.map((tile, index) => ({
    tile,
    column: index % arenaLayout.columns,
    row: Math.floor(index / arenaLayout.columns),
  }));
  const sorted = (entries) => entries.slice().sort((left, right) => String(left.id ?? "").localeCompare(String(right.id ?? "")));
  const bridgeEntries = sorted(arenaLayout.features?.bridge ?? []).filter((entry) => entry.tiles?.length);
  const bridge = bridgeEntries[0] ?? null;
  const bridgeMembers = bridge ? Array.from(new Map(bridge.tiles.map((point) => [worldFeatureTileKey(point), { column: point.column, row: point.row }])).values()) : [];
  const bridgeBounds = worldFeatureBounds(bridgeMembers);
  const rampEntries = sorted(arenaLayout.features?.ramp ?? []).filter((entry) => entry.tiles?.length);
  const ramp = rampEntries[0] ?? null;
  const rampTiles = ramp?.tiles ?? [];
  const rampDirections = [...new Set(rampTiles.map((tile) => arenaLayout.tiles[tile.row * arenaLayout.columns + tile.column]?.rampDirection).filter(Boolean))].sort();
  const rampAxis = ramp?.axis ?? worldFeatureDirectionAxis(rampDirections[0]);
  const rampLevels = [...new Set(rampTiles.map((tile) => tile.level ?? 0))].sort((left, right) => left - right);
  const rampBounds = worldFeatureBounds(rampTiles);
  const cliffEntries = sorted(arenaLayout.features?.cliff ?? []).filter((entry) => entry.tiles?.length);
  const cliff = cliffEntries[0] ?? null;
  const cliffTiles = cliff?.tiles ?? [];
  const cliffDirections = [...new Set(cliffTiles.map((point) => arenaLayout.tiles[point.row * arenaLayout.columns + point.column]?.cliffDirection).filter(Boolean))].sort();
  const cliffDirection = cliff?.direction ?? cliffDirections[0] ?? "unknown";
  const cliffBounds = worldFeatureBounds(cliffTiles);
  const objects = sorted(arenaLayout.objects ?? []);
  const objectCells = objects.map((object) => `${Math.floor(object.x / arenaLayout.tileWidth)},${Math.floor(object.y / arenaLayout.tileHeight)}`);
  const objectIdentities = [...new Set(objects.map((object) => object.id))];
  const objectRepresentatives = objects.filter((object, index) => index < 3);
  const lightObjects = objects.filter((object) => object.feature === "tower" || ["relay", "terminal", "coil", "puzzle-node"].includes(object.type));
  const towerObjects = objects.filter((object) => object.feature === "tower");
  const shadowObject = objects[0] ?? null;
  const shadowColumn = shadowObject ? Math.floor(shadowObject.x / arenaLayout.tileWidth) : 0;
  const shadowRow = shadowObject ? Math.floor(shadowObject.y / arenaLayout.tileHeight) : 0;
  const shadowWall = indexedTiles.find(({ tile, column, row }) => tile.kind === "wall" && Math.abs(column - shadowColumn) <= 3 && Math.abs(row - shadowRow) <= 3)
    ?? indexedTiles.find(({ tile }) => tile.kind === "wall")
    ?? null;
  const lightObject = lightObjects[0] ?? null;
  const light = lightObject ? {
    x: lightObject.x,
    y: lightObject.y - (lightObject.feature === "tower" ? lightObject.radius * 0.45 : 0),
    radius: lightObject.feature === "tower" ? 220 : 130,
  } : null;
  const lightCandidates = light ? indexedTiles.filter(({ tile, column, row }) => tile.kind !== "wall" && Math.hypot((column + 0.5) * arenaLayout.tileWidth - light.x, (row + 0.5) * arenaLayout.tileHeight - light.y) <= light.radius) : [];
  const visibleLightTiles = light ? lightCandidates.filter(({ column, row }) => lightTileVisible(light, column, row)) : [];
  const lightCenterColumn = light ? Math.floor(light.x / arenaLayout.tileWidth) : 0;
  const lightCenterRow = light ? Math.floor(light.y / arenaLayout.tileHeight) : 0;
  const reviewVisibleLightTiles = visibleLightTiles
    .filter(({ column, row }) => Math.abs(column - lightCenterColumn) <= 7 && Math.abs(row - lightCenterRow) <= 5)
    .slice(0, 32)
    .map(({ tile, column, row }) => ({ tile, column: column - lightCenterColumn + 4, row: row - lightCenterRow + 3, worldColumn: column, worldRow: row }));
  const wallTiles = indexedTiles
    .filter(({ tile, column, row }) => tile.kind === "wall" && Math.abs(column - lightCenterColumn) <= 7 && Math.abs(row - lightCenterRow) <= 5)
    .slice(0, 16)
    .map(({ tile, column, row }) => ({ tile, column: column - lightCenterColumn + 4, row: row - lightCenterRow + 3, worldColumn: column, worldRow: row }));
  const categories = {
    bridges: {
      name: "bridges",
      count: bridgeEntries.length,
      id: bridge?.id ?? null,
      members: bridgeMembers,
      memberCount: bridgeMembers.length,
      bounds: bridgeBounds,
      shape: bridge ? `${bridgeBounds.width}x${bridgeBounds.height}/${bridge.axis ?? "unknown"}` : "missing",
      holeCount: worldFeatureHoleCount(bridgeMembers),
      memberContinuity: worldFeatureMemberContinuity(bridgeMembers),
      holes: bridgeMembers.length > 0 && worldFeatureHoleCount(bridgeMembers) === 0,
      dynamic: Boolean(bridge?.dynamic),
    },
    ramps: {
      name: "ramps",
      count: rampEntries.length,
      id: ramp?.id ?? null,
      axis: rampAxis ?? "unknown",
      orientation: rampDirections.join("+") || "missing",
      levels: rampLevels,
      tiles: rampTiles,
      bounds: rampBounds,
      elevationTransition: rampLevels.includes(0) && rampLevels.some((level) => level > 0),
      aligned: Boolean(ramp && rampTiles.length && rampDirections.length && rampDirections.every((direction) => worldFeatureDirectionAxis(direction) === rampAxis)),
    },
    cliffs: {
      name: "cliffs",
      count: cliffEntries.length,
      id: cliff?.id ?? null,
      direction: cliffDirection,
      directions: cliffDirections,
      height: cliff?.height ?? 0,
      tiles: cliffTiles,
      bounds: cliffBounds,
      elevationFace: Boolean(cliff && cliffTiles.length && (cliff.height ?? 0) > 0 && cliffDirections.length === 1),
    },
    objects: {
      name: "objects",
      count: objects.length,
      identities: objectIdentities,
      representatives: objectRepresentatives,
      nonOverlap: new Set(objectCells).size === objectCells.length,
    },
    occlusion: {
      name: "occlusion/shadow depth",
      count: indexedTiles.filter(({ tile }) => tile.kind === "wall").length,
      shadowObjectId: shadowObject?.id ?? null,
      occludingWall: shadowWall ? { column: shadowWall.column, row: shadowWall.row } : null,
      wallCount: indexedTiles.filter(({ tile }) => tile.kind === "wall").length,
      depth: shadowWall && shadowObject ? Math.max(1, Math.round(shadowObject.radius * 0.5)) : 0,
      shadow: Boolean(shadowWall && shadowObject),
    },
    lamps: {
      name: "lamps",
      count: towerObjects.length,
      identity: towerObjects[0]?.id ?? null,
      towerIds: towerObjects.map((object) => object.id),
      pixels: Boolean(towerObjects.length),
    },
    lighting: {
      name: "lighting/light visibility",
      count: lightObjects.length,
      sourceId: lightObject?.id ?? null,
      sourceType: lightObject?.feature ?? lightObject?.type ?? null,
      nonWallTileCount: lightCandidates.length,
      visibleTileCount: visibleLightTiles.length,
      visibleThroughNonWall: Boolean(lightObject && lightCandidates.length && visibleLightTiles.length),
      visibleTiles: reviewVisibleLightTiles,
      wallTiles,
    },
  };
  for (const category of WORLD_FEATURE_REVIEW_CATEGORIES) {
    const image = worldFeatureReviewSpecimen(category, categories[category], profile?.palette);
    const receipt = worldFeatureReviewRasterReceipt(image, category);
    categories[category].image = image;
    categories[category].rgbaHash = receipt.rgbaHash;
    categories[category].nonzeroPixelCount = receipt.nonzeroPixelCount;
    categories[category].inkPixelCount = receipt.inkPixelCount;
    categories[category].shadowPixelCount = receipt.shadowPixelCount;
    categories[category].shadowPixelsObserved = receipt.shadowPixelsObserved;
    categories[category].shadowPixelCriterion = receipt.shadowPixelCriterion;
    categories[category].shadowBackground = receipt.shadowBackground;
    categories[category].lampPixelCount = receipt.lampPixelCount;
    categories[category].lightPixelCount = receipt.lightPixelCount;
  }
  const gates = {
    bridges: Boolean(categories.bridges.count && categories.bridges.memberContinuity && categories.bridges.holes && categories.bridges.memberCount > 0),
    ramps: Boolean(categories.ramps.count && categories.ramps.orientation !== "missing" && categories.ramps.elevationTransition && categories.ramps.aligned),
    cliffs: Boolean(categories.cliffs.count && categories.cliffs.elevationFace && categories.cliffs.direction !== "unknown" && categories.cliffs.inkPixelCount > 0),
    objects: Boolean(categories.objects.count && categories.objects.identities.length === categories.objects.count && categories.objects.nonOverlap),
    occlusion: Boolean(categories.occlusion.count
      && categories.occlusion.shadow
      && categories.occlusion.depth > 0
      && categories.occlusion.shadowPixelCount > 0
      && categories.occlusion.shadowPixelsObserved),
    lamps: Boolean(categories.lamps.count && categories.lamps.pixels && categories.lamps.lampPixelCount > 0),
    lighting: Boolean(categories.lighting.count && categories.lighting.visibleThroughNonWall && categories.lighting.visibleTileCount > 0 && categories.lighting.lightPixelCount > 0),
  };
  const auditCategories = Object.fromEntries(WORLD_FEATURE_REVIEW_CATEGORIES.map((category) => {
    const entry = categories[category];
    const { image, members, tiles, representatives, visibleTiles, wallTiles, ...receipt } = entry;
    return [category, receipt];
  }));
  const allGatesPass = WORLD_FEATURE_REVIEW_CATEGORIES.every((category) => gates[category] === true);
  const audit = {
    schema: WORLD_FEATURE_RENDER_REVIEW_SCHEMA,
    version: WORLD_FEATURE_RENDER_REVIEW_VERSION,
    enabled: true,
    status: allGatesPass ? "ready" : "blocked",
    flag: "worldFeatureRenderReview=1",
    mapSeed,
    layer: layerNumber,
    biome,
    mapSchema: arenaLayout.schema,
    source: "seeded-arena-features-with-live-review-specimens",
    material: "candidate-live-biome-palette",
    frozenVisuals: true,
    approval: "not-asserted",
    categories: auditCategories,
    gates,
    allGatesPass,
    reviewBoundary: WORLD_FEATURE_RENDER_REVIEW_BOUNDARY,
  };
  audit.auditHash = deterministicFingerprint({
    schema: audit.schema,
    version: audit.version,
    mapSeed: audit.mapSeed,
    layer: audit.layer,
    biome: audit.biome,
    categories: audit.categories,
    gates: audit.gates,
    frozenVisuals: audit.frozenVisuals,
  });
  publishWorldFeatureRenderReview(audit);
  return Object.freeze({ categories: Object.freeze(categories), audit: Object.freeze(audit) });
}

function biomeStructuralReviewFeatureCounts(arenaLayout) {
  const features = arenaLayout?.features ?? {};
  return {
    walls: arenaLayout?.tiles?.filter((tile) => tile.kind === "wall").length ?? 0,
    bridges: features.bridge?.filter((entry) => entry.tiles?.length).length ?? 0,
    ramps: features.ramp?.filter((entry) => entry.tiles?.length).length ?? 0,
    cliffs: features.cliff?.filter((entry) => entry.tiles?.length).length ?? 0,
    objects: arenaLayout?.objects?.length ?? 0,
    lamps: features.tower?.length ?? 0,
    bodies: ["water-body", "lava-body", "other-body"].reduce((total, key) => total + (features[key]?.length ?? 0), 0),
  };
}

function biomeStructuralReviewCandidateScore(counts) {
  return [counts.walls, counts.bridges, counts.ramps, counts.cliffs, counts.objects, counts.lamps, counts.bodies]
    .reduce((score, count) => score + (count > 0 ? 1 : 0), 0);
}

function biomeStructuralReviewCandidateReady(counts) {
  return counts.walls > 0
    && counts.bridges > 0
    && counts.ramps > 0
    && counts.cliffs > 0
    && counts.objects > 0
    && counts.lamps > 0;
}

function findBiomeStructuralReviewRepresentative(biome, mapSeed, characterSeed) {
  let best = null;
  for (let seedIndex = 0; seedIndex <= 64; seedIndex += 1) {
    const candidateSeed = seedIndex === 0 ? mapSeed : `${mapSeed}:biome-review:${seedIndex}`;
    const candidateRun = createRunDescriptor(atlas, candidateSeed, characterSeed);
    for (let candidateLayer = 1; candidateLayer <= 64; candidateLayer += 1) {
      const candidateProfile = createLayerProfile(atlas, candidateRun, candidateLayer);
      if (candidateProfile.biome !== biome) continue;
      const candidateArena = createArenaLayout(candidateRun, candidateProfile);
      const counts = biomeStructuralReviewFeatureCounts(candidateArena);
      const score = biomeStructuralReviewCandidateScore(counts);
      const candidate = {
        mapSeed: candidateRun.mapSeed,
        characterSeed: candidateRun.characterSeed,
        layer: candidateLayer,
        run: candidateRun,
        profile: candidateProfile,
        arena: candidateArena,
        counts,
        score,
      };
      if (!best || score > best.score || (score === best.score && `${candidateRun.mapSeed}:${candidateLayer}` < `${best.mapSeed}:${best.layer}`)) best = candidate;
      if (biomeStructuralReviewCandidateReady(counts)) return candidate;
    }
  }
  return best;
}

function biomeStructuralReviewAnchor(candidate) {
  if (!candidate?.arena) return { column: 0, row: 0 };
  const arenaLayout = candidate.arena;
  const featureEntries = ["bridge", "ramp", "cliff"].flatMap((feature) => (arenaLayout.features?.[feature] ?? [])
    .filter((entry) => entry.tiles?.length)
    .slice()
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((entry) => entry.tiles[0]));
  const point = featureEntries[0]
    ?? (arenaLayout.objects ?? []).slice().sort((left, right) => String(left.id).localeCompare(String(right.id))).map((object) => ({
      column: Math.floor(object.x / arenaLayout.tileWidth),
      row: Math.floor(object.y / arenaLayout.tileHeight),
    }))[0]
    ?? arenaLayout.tiles.map((tile, index) => tile.kind === "wall" ? { column: index % arenaLayout.columns, row: Math.floor(index / arenaLayout.columns) } : null).find(Boolean)
    ?? { column: Math.floor(arenaLayout.columns / 2), row: Math.floor(arenaLayout.rows / 2) };
  return { column: point.column, row: point.row };
}

function biomeStructuralReviewTile(candidate, column, row) {
  if (!candidate?.arena || column < 0 || row < 0 || column >= candidate.arena.columns || row >= candidate.arena.rows) return null;
  return candidate.arena.tiles[row * candidate.arena.columns + column] ?? null;
}

function biomeStructuralReviewDrawWall(context2d, x, y, size, tile, candidate, variant) {
  const arenaLayout = candidate.arena;
  const column = Math.floor(x / size);
  const row = Math.floor(y / size);
  const worldColumn = candidate.reviewMinimumColumn + column;
  const worldRow = candidate.reviewMinimumRow + row;
  const wallAt = (offsetColumn, offsetRow) => biomeStructuralReviewTile(candidate, worldColumn + offsetColumn, worldRow + offsetRow)?.kind === "wall";
  context2d.fillStyle = "#5f696b";
  if (variant.wall.cap === "faceted-continuous") {
    context2d.beginPath();
    context2d.moveTo(x + 3, y);
    context2d.lineTo(x + size - 3, y);
    context2d.lineTo(x + size, y + 3);
    context2d.lineTo(x + size, y + size - 2);
    context2d.lineTo(x + 2, y + size);
    context2d.lineTo(x, y + 3);
    context2d.closePath();
    context2d.fill();
  } else if (variant.wall.cap === "buttressed-continuous") {
    context2d.fillRect(x + 2, y + 2, size - 4, size - 2);
    context2d.fillStyle = "#9ca6a5";
    context2d.beginPath();
    context2d.moveTo(x, y + size);
    context2d.lineTo(x + 5, y + size - 5);
    context2d.lineTo(x + 5, y + 4);
    context2d.lineTo(x + 2, y + 2);
    context2d.closePath();
    context2d.fill();
  } else if (variant.wall.cap === "floating-ring") {
    context2d.fillStyle = "#536063";
    context2d.fillRect(x + 3, y + 3, size - 6, size - 6);
    context2d.strokeStyle = "#c5d0cb";
    context2d.lineWidth = 2;
    context2d.strokeRect(x + 5, y + 5, size - 10, size - 10);
  } else {
    context2d.fillRect(x, y + 2, size, size - 2);
    context2d.fillStyle = "#bdc7c4";
    context2d.fillRect(x, y, size, 3);
    context2d.fillStyle = "#8f9b99";
    context2d.fillRect(x + 3, y + 3, size - 6, 2);
  }
  context2d.strokeStyle = "#c3ceca";
  context2d.lineWidth = 1;
  if (!wallAt(0, -1)) context2d.strokeRect(x + 1, y + 1, size - 2, 1);
  if (!wallAt(0, 1) && variant.wall.edge.includes("south")) context2d.fillRect(x + 1, y + size - 3, size - 2, 3);
  if (!wallAt(1, 0) && variant.wall.edge.includes("east")) context2d.fillRect(x + size - 3, y + 2, 3, size - 4);
  if (!wallAt(-1, 0) && variant.wall.edge.includes("west")) context2d.fillRect(x, y + 2, 3, size - 4);
  if (!wallAt(0, -1) && variant.wall.edge.includes("north")) context2d.fillRect(x + 1, y, size - 2, 3);
  if (variant.wall.geometry.includes("riveted")) {
    context2d.fillStyle = "#edf4ed";
    context2d.fillRect(x + 4, y + size - 5, 2, 2);
    context2d.fillRect(x + size - 6, y + size - 5, 2, 2);
  } else if (variant.wall.geometry.includes("chamfered")) {
    context2d.fillStyle = "#e1ece7";
    context2d.fillRect(x + Math.floor(size / 2) - 1, y + 2, 2, 2);
  } else if (variant.wall.geometry.includes("ritual")) {
    context2d.strokeStyle = "#d3dad5";
    context2d.beginPath();
    context2d.moveTo(x + 4, y + size - 4);
    context2d.lineTo(x + size - 4, y + 4);
    context2d.stroke();
  } else if (variant.wall.geometry.includes("gap")) {
    context2d.clearRect(x + Math.floor(size / 2), y, 2, 3);
  }
}

function biomeStructuralReviewCardImage(candidate, variant) {
  const image = document.createElement("canvas");
  image.width = 286;
  image.height = 158;
  const imageContext = image.getContext("2d", { willReadFrequently: true });
  imageContext.imageSmoothingEnabled = false;
  imageContext.fillStyle = "#08100f";
  imageContext.fillRect(0, 0, image.width, image.height);
  imageContext.fillStyle = "#b8c5bf";
  imageContext.font = "700 8px ui-monospace,monospace";
  imageContext.fillText(candidate ? "SEEDED STRUCTURE WINDOW" : "MISSING SEEDED STRUCTURE", 8, 11);
  const tileSize = 20;
  const columns = 12;
  const rows = 6;
  const originX = 8;
  const originY = 18;
  const anchor = biomeStructuralReviewAnchor(candidate);
  const arenaLayout = candidate?.arena;
  const minimumColumn = arenaLayout ? clamp(anchor.column - Math.floor(columns / 2), 0, Math.max(0, arenaLayout.columns - columns)) : 0;
  const minimumRow = arenaLayout ? clamp(anchor.row - Math.floor(rows / 2), 0, Math.max(0, arenaLayout.rows - rows)) : 0;
  if (candidate) {
    candidate.reviewMinimumColumn = minimumColumn;
    candidate.reviewMinimumRow = minimumRow;
  }
  imageContext.fillStyle = "#12201e";
  imageContext.fillRect(originX, originY, columns * tileSize, rows * tileSize);
  const lightX = originX + Math.floor(columns * tileSize * 0.58);
  const lightY = originY + Math.floor(rows * tileSize * 0.44);
  const lightGradient = imageContext.createRadialGradient(lightX, lightY, 4, lightX, lightY, 70);
  lightGradient.addColorStop(0, "rgba(220,235,223,.22)");
  lightGradient.addColorStop(1, "rgba(220,235,223,0)");
  imageContext.fillStyle = lightGradient;
  imageContext.fillRect(originX, originY, columns * tileSize, rows * tileSize);
  const wallPoints = [];
  if (candidate) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const worldColumn = minimumColumn + column;
        const worldRow = minimumRow + row;
        const tile = biomeStructuralReviewTile(candidate, worldColumn, worldRow);
        const x = originX + column * tileSize;
        const y = originY + row * tileSize;
        const terrain = tile?.terrain ?? "dry";
        imageContext.fillStyle = terrain === "lava" ? "#49352c" : terrain === "water" ? "#29434a" : terrain === "void" ? "#272437" : terrain === "mist" ? "#343b42" : "#1b2a27";
        imageContext.fillRect(x, y, tileSize, tileSize);
        imageContext.strokeStyle = "rgba(184,197,191,.16)";
        imageContext.lineWidth = 1;
        imageContext.strokeRect(x + 0.5, y + 0.5, tileSize - 1, tileSize - 1);
        if (tile?.kind === "wall") {
          wallPoints.push({ x, y, tile });
          biomeStructuralReviewDrawWall(imageContext, x, y, tileSize, tile, candidate, variant);
        }
        const features = tile?.features ?? [];
        if (features.includes("bridge") || features.includes("dynamic-bridge")) {
          imageContext.strokeStyle = "#d9e8df";
          imageContext.lineWidth = 2;
          if ((candidate.profile?.biome && candidate.arena.features.bridge[0]?.axis === "vertical") || variant.bridge.axis === "vertical") {
            imageContext.beginPath(); imageContext.moveTo(x + 5, y + 2); imageContext.lineTo(x + 5, y + tileSize - 2); imageContext.moveTo(x + tileSize - 5, y + 2); imageContext.lineTo(x + tileSize - 5, y + tileSize - 2); imageContext.stroke();
          } else {
            imageContext.beginPath(); imageContext.moveTo(x + 2, y + 5); imageContext.lineTo(x + tileSize - 2, y + 5); imageContext.moveTo(x + 2, y + tileSize - 5); imageContext.lineTo(x + tileSize - 2, y + tileSize - 5); imageContext.stroke();
          }
          imageContext.fillStyle = "#eef7ed";
          imageContext.fillRect(x + 8, y + 8, 4, 4);
        }
        if (features.includes("ramp")) {
          imageContext.strokeStyle = "#b9d6ca";
          imageContext.lineWidth = 2;
          for (let stripe = -1; stripe < 3; stripe += 1) {
            imageContext.beginPath();
            imageContext.moveTo(x + stripe * 7, y + tileSize);
            imageContext.lineTo(x + stripe * 7 + tileSize, y);
            imageContext.stroke();
          }
        }
        if (features.includes("cliff")) {
          imageContext.fillStyle = "#9aa7a5";
          imageContext.beginPath();
          imageContext.moveTo(x + 2, y + tileSize - 2);
          imageContext.lineTo(x + tileSize - 2, y + tileSize - 2);
          imageContext.lineTo(x + tileSize - 5, y + 5);
          imageContext.lineTo(x + 5, y + 5);
          imageContext.closePath();
          imageContext.fill();
        }
      }
    }
    for (const object of candidate.arena.objects ?? []) {
      const objectColumn = Math.floor(object.x / candidate.arena.tileWidth);
      const objectRow = Math.floor(object.y / candidate.arena.tileHeight);
      if (objectColumn < minimumColumn || objectColumn >= minimumColumn + columns || objectRow < minimumRow || objectRow >= minimumRow + rows) continue;
      const x = originX + (objectColumn - minimumColumn) * tileSize + tileSize / 2;
      const y = originY + (objectRow - minimumRow) * tileSize + tileSize / 2;
      imageContext.fillStyle = object.feature === "tower" ? "#eef7ed" : "#c0cec8";
      if (variant.object.geometry.includes("coil")) {
        imageContext.beginPath(); imageContext.arc(x, y, 7, 0, Math.PI * 2); imageContext.strokeStyle = "#eef7ed"; imageContext.lineWidth = 2; imageContext.stroke();
        imageContext.beginPath(); imageContext.arc(x, y, 3, 0, Math.PI * 2); imageContext.fill();
      } else if (variant.object.geometry.includes("prism")) {
        imageContext.beginPath(); imageContext.moveTo(x, y - 8); imageContext.lineTo(x + 7, y + 5); imageContext.lineTo(x - 7, y + 5); imageContext.closePath(); imageContext.fill();
      } else if (variant.object.geometry.includes("reliquary")) {
        imageContext.fillRect(x - 5, y - 7, 10, 14); imageContext.fillRect(x - 8, y - 2, 16, 4);
      } else {
        imageContext.fillRect(x - 6, y - 6, 12, 12); imageContext.strokeStyle = "#eef7ed"; imageContext.strokeRect(x - 8, y - 8, 16, 16);
      }
      if (object.feature === "tower") {
        imageContext.strokeStyle = "rgba(235,247,237,.7)";
        imageContext.lineWidth = 1;
        for (let ray = 0; ray < variant.lamp.rays; ray += 1) {
          const angle = (Math.PI * 2 * ray) / variant.lamp.rays;
          imageContext.beginPath(); imageContext.moveTo(x, y); imageContext.lineTo(x + Math.cos(angle) * 12, y + Math.sin(angle) * 12); imageContext.stroke();
        }
      }
    }
  } else {
    imageContext.strokeStyle = "#d37b83";
    imageContext.strokeRect(originX + 1, originY + 1, columns * tileSize - 2, rows * tileSize - 2);
  }
  imageContext.fillStyle = "#9eada7";
  imageContext.font = "700 8px ui-monospace,monospace";
  imageContext.fillText(`WALL ${wallPoints.length} · ${variant.wall.cap}`, 8, 149);
  const frame = imageContext.getImageData(0, 0, image.width, image.height);
  let nonzeroPixelCount = 0;
  let inkPixelCount = 0;
  for (let index = 0; index < frame.data.length; index += 4) {
    if (frame.data[index + 3] > 0) nonzeroPixelCount += 1;
    if (frame.data[index] !== 8 || frame.data[index + 1] !== 16 || frame.data[index + 2] !== 15 || frame.data[index + 3] !== 255) inkPixelCount += 1;
  }
  return {
    image,
    width: image.width,
    height: image.height,
    rgbaHash: rgbaHash({ pixels: frame.data }),
    nonzeroPixelCount,
    inkPixelCount,
  };
}

function publishBiomeStructuralVariantReview(audit) {
  const frozenAudit = Object.freeze(audit);
  globalThis.__vaultBiomeStructuralVariantReview = frozenAudit;
  globalThis.__vaultBiomeStructuralVariantReviewAudit = frozenAudit;
  const cards = BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => audit.cards[biome]);
  Object.assign(document.documentElement.dataset, {
    vaultBiomeStructuralVariantReviewSchema: audit.schema,
    vaultBiomeStructuralVariantReviewVersion: String(audit.version),
    vaultBiomeStructuralVariantReviewFlag: audit.enabled ? "1" : "0",
    vaultBiomeStructuralVariantReview: audit.status,
    vaultBiomeStructuralVariantReviewStatus: audit.status,
    vaultBiomeStructuralVariantReviewBiomes: BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.join("|"),
    vaultBiomeStructuralVariantReviewSignatures: cards.map((card) => `${card.biome}:${card.variantSignature}`).join("|"),
    vaultBiomeStructuralVariantReviewGates: BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => `${biome}:${audit.gates[biome] ? "true" : "false"}`).join("|"),
    vaultBiomeStructuralVariantReviewRgbaHashes: cards.map((card) => `${card.biome}:${card.rgbaHash}`).join("|"),
    vaultBiomeStructuralVariantReviewNonzeroPixels: cards.map((card) => `${card.biome}:${card.nonzeroPixelCount}`).join("|"),
    vaultBiomeStructuralVariantReviewSeedCohort: audit.seedCohort.join("|"),
    vaultBiomeStructuralVariantReviewAuditHash: audit.auditHash,
    vaultBiomeStructuralVariantReviewBoundary: audit.reviewBoundary,
    vaultBiomeStructuralVariantReviewMaterial: audit.material,
    vaultBiomeStructuralVariantReviewApproval: audit.approval,
  });
}

function buildBiomeStructuralVariantReview({ mapSeed, characterSeed }) {
  if (!biomeStructuralVariantReviewEnabled) return null;
  const cards = {};
  for (const biome of BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES) {
    const variant = BIOME_STRUCTURAL_VARIANT_REVIEW_VARIANTS[biome];
    const candidate = findBiomeStructuralReviewRepresentative(biome, mapSeed, characterSeed);
    const variantSignature = deterministicFingerprint({ biome, variant });
    const raster = biomeStructuralReviewCardImage(candidate, variant);
    const counts = candidate?.counts ?? { walls: 0, bridges: 0, ramps: 0, cliffs: 0, objects: 0, lamps: 0, bodies: 0 };
    const source = candidate ? {
      mapSeed: candidate.mapSeed,
      characterSeed: candidate.characterSeed,
      layer: candidate.layer,
      biome: candidate.profile.biome,
      tilesetId: candidate.profile.tilesetId,
      tilesetName: candidate.profile.tilesetName,
      paletteId: candidate.profile.paletteId,
      floor: candidate.profile.floor,
      wall: candidate.profile.wall,
      roomDesigns: candidate.profile.roomDesigns,
      objectPool: candidate.profile.objectPool,
    } : null;
    cards[biome] = {
      biome,
      variantId: variant.id,
      variantSignature,
      variant,
      source,
      counts,
      rgbaHash: raster.rgbaHash,
      nonzeroPixelCount: raster.nonzeroPixelCount,
      inkPixelCount: raster.inkPixelCount,
      image: raster.image,
      candidate,
    };
  }
  const variantSignatures = BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => cards[biome].variantSignature);
  const uniqueVariantSignatures = new Set(variantSignatures).size === BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.length;
  const gates = Object.fromEntries(BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => {
    const card = cards[biome];
    const source = card.source;
    const gate = Boolean(source
      && source.biome === biome
      && card.counts.walls > 0
      && card.counts.bridges > 0
      && card.counts.ramps > 0
      && card.counts.cliffs > 0
      && card.counts.objects > 0
      && card.counts.lamps > 0
      && card.rgbaHash
      && card.nonzeroPixelCount > 0
      && card.inkPixelCount > 0);
    return [biome, gate];
  }));
  const allGatesPass = BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.every((biome) => gates[biome] === true);
  const auditCards = Object.fromEntries(BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => {
    const { image, candidate, variant, ...receipt } = cards[biome];
    return [biome, receipt];
  }));
  const seedCohort = [...new Set(BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => cards[biome].source?.mapSeed).filter(Boolean))];
  const audit = {
    schema: BIOME_STRUCTURAL_VARIANT_REVIEW_SCHEMA,
    version: BIOME_STRUCTURAL_VARIANT_REVIEW_VERSION,
    enabled: true,
    status: allGatesPass && uniqueVariantSignatures ? "ready" : "blocked",
    flag: "biomeStructuralVariantReview=1",
    seedCohort,
    biomeNames: BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES,
    variantSignatures,
    uniqueVariantSignatures,
    cards: auditCards,
    gates,
    allGatesPass,
    frozenVisuals: true,
    material: "candidate-neutral-grayscale",
    approval: "not-asserted",
    reviewBoundary: BIOME_STRUCTURAL_VARIANT_REVIEW_BOUNDARY,
  };
  audit.auditHash = deterministicFingerprint({
    schema: audit.schema,
    version: audit.version,
    seedCohort: audit.seedCohort,
    biomeNames: audit.biomeNames,
    variantSignatures: audit.variantSignatures,
    cards: audit.cards,
    gates: audit.gates,
    allGatesPass: audit.allGatesPass,
    frozenVisuals: audit.frozenVisuals,
  });
  publishBiomeStructuralVariantReview(audit);
  return Object.freeze({ cards: Object.freeze(cards), audit: Object.freeze(audit) });
}

function activeBiomeAtlas() {
  return biomeAtlasImages.get(profile?.biome) ?? forgeAtlasImage;
}

async function ensureBiomeAtlas(biome) {
  if (biomeAtlasImages.has(biome)) return biomeAtlasImages.get(biome);
  const spec = atlas.gameArt.biomeAtlases[biome];
  if (!spec) throw new Error(`Missing authored atlas for ${biome}`);
  const image = removeConnectedLightBackground(await loadImage(`./${spec.source}`));
  biomeAtlasImages.set(biome, image);
  return image;
}

function forgeSprite(column, row, color, crop = false) {
  const biome = profile?.biome ?? "industrial-forge";
  const sourceAtlas = activeBiomeAtlas();
  const key = `${biome}:${column}:${row}:${color}:${crop}`;
  if (forgeSpriteCache.has(key)) return forgeSpriteCache.get(key);
  const cell = sourceAtlas.width / atlas.gameArt.grid[0];
  const pad = crop ? 20 : 0;
  const sourceSize = cell - pad * 2;
  const output = document.createElement("canvas");
  output.width = Math.round(sourceSize);
  output.height = Math.round(sourceSize);
  const outputContext = output.getContext("2d");
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(sourceAtlas, column * cell + pad, row * cell + pad, sourceSize, sourceSize, 0, 0, output.width, output.height);
  outputContext.globalCompositeOperation = "source-atop";
  outputContext.globalAlpha = 0.36;
  outputContext.fillStyle = color;
  outputContext.fillRect(0, 0, output.width, output.height);
  outputContext.globalAlpha = 1;
  outputContext.globalCompositeOperation = "source-over";
  forgeSpriteCache.set(key, output);
  return output;
}

function drawForgeCell(column, row, x, y, width, height, color, crop = false) {
  context.drawImage(forgeSprite(column, row, color, crop), x, y, width, height);
}

function tilekitSprite(sheet, sheetId, column, row, color) {
  const key = `${sheetId}:${column}:${row}:${color}`;
  if (tilekitSpriteCache.has(key)) return tilekitSpriteCache.get(key);
  const output = document.createElement("canvas");
  output.width = 64;
  output.height = 64;
  const outputContext = output.getContext("2d");
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(sheet, column * 64, row * 64, 64, 64, 0, 0, 64, 64);
  outputContext.globalCompositeOperation = "source-atop";
  outputContext.globalAlpha = 0.34;
  outputContext.fillStyle = color;
  outputContext.fillRect(0, 0, 64, 64);
  outputContext.globalAlpha = 1;
  outputContext.globalCompositeOperation = "source-over";
  tilekitSpriteCache.set(key, output);
  return output;
}

function drawTilekitCell(sheet, sheetId, column, row, x, y, width, height, color, quarterTurns = 0, alpha = 1) {
  const sprite = tilekitSprite(sheet, sheetId, column, row, color);
  context.save();
  context.globalAlpha = alpha;
  context.translate(x + width / 2, y + height / 2);
  context.rotate(quarterTurns * Math.PI / 2);
  context.drawImage(sprite, -width / 2, -height / 2, width, height);
  context.restore();
}

function floorMacroSprite(tile, color) {
  const column = tile.floorMacroColumn ?? 0;
  const row = tile.floorMacroRow ?? 0;
  const key = `${column}:${row}:${color}`;
  if (floorMacroSpriteCache.has(key)) return floorMacroSpriteCache.get(key);
  const output = document.createElement("canvas");
  output.width = 64;
  output.height = 64;
  const outputContext = output.getContext("2d");
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(signalCryptFloorMacros, column * 64, row * 64, 64, 64, 0, 0, 64, 64);
  // The authored macro is a detail layer, not a second opaque floor. Strip its
  // dark base so the same calm material remains visible below both sides of the
  // macro boundary. This preserves the authored circuitry without an 8x8 tile
  // luminance rectangle around it.
  const pixels = outputContext.getImageData(0, 0, 64, 64);
  const tint = colorChannels(color);
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    const pixel = offset / 4;
    const pixelX = pixel % 64;
    const pixelY = Math.floor(pixel / 64);
    const luminance = pixels.data[offset] * 0.2126 + pixels.data[offset + 1] * 0.7152 + pixels.data[offset + 2] * 0.0722;
    const detail = clamp((luminance - 48) / 112, 0, 1);
    let edgeFade = 1;
    const edgeMask = tile.floorMacroEdgeMask ?? 0;
    if (edgeMask & 1) edgeFade *= clamp(pixelY / 18, 0, 1);
    if (edgeMask & 2) edgeFade *= clamp((63 - pixelX) / 18, 0, 1);
    if (edgeMask & 4) edgeFade *= clamp((63 - pixelY) / 18, 0, 1);
    if (edgeMask & 8) edgeFade *= clamp(pixelX / 18, 0, 1);
    pixels.data[offset] = Math.round(lerp(tint[0] * 0.34, 238, detail));
    pixels.data[offset + 1] = Math.round(lerp(tint[1] * 0.34, 246, detail));
    pixels.data[offset + 2] = Math.round(lerp(tint[2] * 0.34, 244, detail));
    pixels.data[offset + 3] = Math.round(225 * detail * detail * edgeFade * edgeFade);
  }
  outputContext.putImageData(pixels, 0, 0);
  floorMacroSpriteCache.set(key, output);
  return output;
}

function signalMaterialSwatch(column, row, color) {
  const key = `${column}:${row}:${color}`;
  if (signalMaterialCache.has(key)) return signalMaterialCache.get(key);
  const output = document.createElement("canvas");
  output.width = 512;
  output.height = 512;
  const outputContext = output.getContext("2d");
  outputContext.imageSmoothingEnabled = false;
  // Mirror-wrap each generated material swatch. Opposite edges therefore meet
  // their own reflection instead of exposing a repeated 256px atlas seam.
  for (const [drawX, drawY, scaleX, scaleY] of [[0, 0, 1, 1], [512, 0, -1, 1], [0, 512, 1, -1], [512, 512, -1, -1]]) {
    outputContext.save();
    outputContext.translate(drawX, drawY);
    outputContext.scale(scaleX, scaleY);
    outputContext.drawImage(signalCryptMaterials, column * 256, row * 256, 256, 256, 0, 0, 256, 256);
    outputContext.restore();
  }
  outputContext.globalCompositeOperation = "multiply";
  outputContext.globalAlpha = 0.72;
  outputContext.fillStyle = color;
  outputContext.fillRect(0, 0, 512, 512);
  outputContext.globalCompositeOperation = "source-over";
  outputContext.globalAlpha = 1;
  signalMaterialCache.set(key, output);
  return output;
}

function fillSignalMaterial(column, row, color, x, y, width, height, alpha = 0.36, operation = "screen") {
  context.save();
  context.globalAlpha = alpha;
  context.globalCompositeOperation = operation;
  context.fillStyle = context.createPattern(signalMaterialSwatch(column, row, color), "repeat");
  context.fillRect(x, y, width, height);
  context.restore();
}

function motifCellForMask(mask) {
  if (mask === 15) return { column: 3, turns: 0 };
  if ([7, 11, 13, 14].includes(mask)) return { column: 2, turns: ({ 11: 0, 7: 1, 14: 2, 13: 3 })[mask] };
  if ([3, 6, 9, 12].includes(mask)) return { column: 1, turns: ({ 12: 0, 9: 1, 3: 2, 6: 3 })[mask] };
  if ([2, 8, 10].includes(mask)) return { column: 0, turns: 1 };
  if ([1, 4, 5].includes(mask)) return { column: 0, turns: 0 };
  return { column: 4, turns: 0 };
}

function wallCellForMask(mask) {
  if (mask === 0) return null;
  if (mask === 15) return { column: 5, turns: 0 };
  if ([7, 11, 13, 14].includes(mask)) return { column: 4, turns: ({ 7: 0, 14: 1, 13: 2, 11: 3 })[mask] };
  if ([3, 6, 9, 12].includes(mask)) return { column: 2, turns: ({ 3: 0, 6: 1, 12: 2, 9: 3 })[mask] };
  if (mask === 5) return { column: 1, turns: 0 };
  if (mask === 10) return { column: 1, turns: 1 };
  // A single exposed side is one continuous wall face. Rotate the horizontal
  // authored run so its lip always faces the walkable side.
  return { column: 0, turns: ({ 1: 0, 2: 1, 4: 2, 8: 3 })[mask] ?? 0 };
}

function drawSignalCryptWall(tile, x, y, column, row) {
  const width = arena.tileWidth;
  const height = arena.tileHeight;
  const exposure = tile.exposureMask ?? 0;
  const connected = tile.wallMask ?? 0;
  const rise = Math.max(15, Math.round(height * 0.27));

  // The top surface is deliberately edge-to-edge. The old three-pixel inset
  // made every wall cell read as a separate box. World-phased material and
  // sparse structural seams now make adjacent cells one continuous wall run.
  context.fillStyle = mixColor(profile.palette.floor2, "#030707", 0.66);
  context.fillRect(x, y, width, height);
  fillSignalMaterial(3, 1, profile.palette.floor2, x, y, width, height, exposure ? 0.44 : 0.27);

  // Broad plates span four cells. Only their joints are drawn, eliminating the
  // sixty-four-pixel checkerboard while retaining readable construction scale.
  const phaseX = ((column % 4) + 4) % 4;
  const phaseY = ((row % 4) + 4) % 4;
  context.fillStyle = rgba(profile.palette.line, exposure ? 0.2 : 0.055);
  if (phaseX === 0 && !(connected & 8)) context.fillRect(x, y, 2, height);
  if (phaseY === 0 && !(connected & 1)) context.fillRect(x, y, width, 2);
  if ((column + row * 5) % 17 === 0 && exposure === 0) {
    context.fillStyle = rgba(profile.palette.line, 0.07);
    context.fillRect(x + width * 0.18, y + height * 0.48, width * 0.64, 2);
  }

  const topHighlight = rgba(profile.palette.line, 0.58);
  const faceFill = mixColor(profile.palette.floor2, "#030505", 0.38);
  const edgeFill = mixColor(profile.palette.floor2, profile.palette.line, 0.2);
  const castFace = (bit) => {
    if (!(exposure & bit)) return;
    context.save();
    context.fillStyle = "rgba(0,0,0,.38)";
    if (bit === 4) context.fillRect(x + 5, y + height, width, rise + 8);
    if (bit === 2) context.fillRect(x + width, y + 5, rise + 7, height);
    if (bit === 1) context.fillRect(x + 4, y - 4, width, 7);
    if (bit === 8) context.fillRect(x - 4, y + 4, 7, height);
    context.fillStyle = faceFill;
    context.beginPath();
    if (bit === 4) { context.moveTo(x, y + height - 1); context.lineTo(x + width, y + height - 1); context.lineTo(x + width - 7, y + height + rise); context.lineTo(x + 7, y + height + rise); }
    if (bit === 2) { context.moveTo(x + width - 1, y); context.lineTo(x + width - 1, y + height); context.lineTo(x + width + rise, y + height - 7); context.lineTo(x + width + rise, y + 7); }
    if (bit === 1) { context.moveTo(x, y + 1); context.lineTo(x + width, y + 1); context.lineTo(x + width - 5, y + 7); context.lineTo(x + 5, y + 7); }
    if (bit === 8) { context.moveTo(x + 1, y); context.lineTo(x + 1, y + height); context.lineTo(x + 7, y + height - 5); context.lineTo(x + 7, y + 5); }
    context.closePath(); context.fill();
    context.clip();
    fillSignalMaterial(0, 2, profile.palette.line, x - rise, y - rise, width + rise * 2, height + rise * 2, bit === 4 || bit === 2 ? 0.68 : 0.42);
    context.restore();
    context.fillStyle = topHighlight;
    if (bit === 4) context.fillRect(x, y + height - 2, width, 2);
    if (bit === 2) context.fillRect(x + width - 2, y, 2, height);
    if (bit === 1) context.fillRect(x, y, width, 2);
    if (bit === 8) context.fillRect(x, y, 2, height);
  };
  castFace(1); castFace(2); castFace(4); castFace(8);

  // Corners are true join caps, not decorative badges. They only appear where
  // two exposed faces meet and cover the projection seam between those faces.
  const corner = (bits, cx, cy) => {
    if ((exposure & bits) !== bits) return;
    context.fillStyle = edgeFill;
    context.beginPath();
    context.moveTo(cx - 6, cy); context.lineTo(cx, cy - 6); context.lineTo(cx + 6, cy); context.lineTo(cx, cy + 6); context.closePath();
    context.fill();
    context.fillStyle = rgba(profile.palette.accent, 0.32);
    context.fillRect(cx - 1, cy - 1, 3, 3);
  };
  corner(1 | 8, x + 6, y + 6);
  corner(1 | 2, x + width - 6, y + 6);
  corner(4 | 2, x + width - 6, y + height - 6);
  corner(4 | 8, x + 6, y + height - 6);
}

function bridgeAxisForTile(tile, column, row) {
  const sameBridge = (testColumn, testRow) => arena.tiles[testRow * arena.columns + testColumn]?.bridgeId === tile.bridgeId;
  return sameBridge(column - 1, row) || sameBridge(column + 1, row) ? "horizontal" : "vertical";
}

function drawSignalCryptRamp(tile, x, y) {
  const turns = ({ north: 2, east: 3, south: 0, west: 1 })[tile.rampDirection] ?? 0;
  context.save();
  context.translate(x + arena.tileWidth / 2, y + arena.tileHeight / 2);
  context.rotate(turns * Math.PI / 2);
  const w = arena.tileWidth;
  const h = arena.tileHeight;
  context.fillStyle = mixColor(profile.palette.floor2, profile.palette.line, 0.14);
  context.beginPath(); context.moveTo(-w / 2 + 4, h / 2 - 3); context.lineTo(w / 2 - 4, h / 2 - 3); context.lineTo(w / 2 - 12, -h / 2 + 4); context.lineTo(-w / 2 + 12, -h / 2 + 4); context.closePath(); context.fill();
  for (let step = 0; step < 5; step += 1) {
    const y0 = h / 2 - 8 - step * 10;
    const inset = 5 + step * 1.4;
    context.fillStyle = step % 2 ? rgba(profile.palette.line, 0.2) : rgba(profile.palette.floor, 0.74);
    context.fillRect(-w / 2 + inset, y0, w - inset * 2, 7);
    context.fillStyle = rgba(profile.palette.line, 0.48);
    context.fillRect(-w / 2 + inset, y0, w - inset * 2, 2);
  }
  context.strokeStyle = rgba(profile.palette.accent, 0.54); context.lineWidth = 2;
  context.beginPath(); context.moveTo(-w / 2 + 5, h / 2 - 3); context.lineTo(-w / 2 + 13, -h / 2 + 4); context.moveTo(w / 2 - 5, h / 2 - 3); context.lineTo(w / 2 - 13, -h / 2 + 4); context.stroke();
  context.restore();
}

function drawSignalCryptBridge(tile, x, y, column, row) {
  const axis = bridgeAxisForTile(tile, column, row);
  const horizontal = axis === "horizontal";
  const dynamic = tile.features.includes("dynamic-bridge");
  const powered = !dynamic || dynamicBridgePowered(tile);
  const same = (testColumn, testRow) => arena.tiles[testRow * arena.columns + testColumn]?.bridgeId === tile.bridgeId;
  const north = same(column, row - 1), east = same(column + 1, row), south = same(column, row + 1), west = same(column - 1, row);
  const deck = horizontal
    ? context.createLinearGradient(x, y, x, y + arena.tileHeight)
    : context.createLinearGradient(x, y, x + arena.tileWidth, y);
  deck.addColorStop(0, mixColor(profile.palette.floor, profile.palette.line, 0.28));
  deck.addColorStop(0.48, mixColor(profile.palette.floor2, profile.palette.line, 0.1));
  deck.addColorStop(1, mixColor(profile.palette.floor2, "#000000", 0.34));
  context.fillStyle = deck;
  context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
  if (!south) {
    context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.52);
    context.fillRect(x, y + arena.tileHeight - 1, arena.tileWidth, 7);
    context.fillStyle = rgba(profile.palette.line, 0.18); context.fillRect(x, y + arena.tileHeight - 1, arena.tileWidth, 2);
  }
  if (!east) {
    context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.44);
    context.fillRect(x + arena.tileWidth - 1, y + 5, 6, arena.tileHeight - 5);
  }
  context.strokeStyle = rgba(powered ? profile.palette.accent : profile.palette.hostile, powered ? 0.5 : 0.22);
  context.lineWidth = 3;
  context.globalAlpha = powered ? 1 : 0.46;
  if (horizontal) {
    context.beginPath();
    if (!north) { context.moveTo(x, y + 2); context.lineTo(x + arena.tileWidth, y + 2); }
    if (!south) { context.moveTo(x, y + arena.tileHeight - 2); context.lineTo(x + arena.tileWidth, y + arena.tileHeight - 2); }
    if (!west) { context.moveTo(x + 2, y + 2); context.lineTo(x + 2, y + arena.tileHeight - 2); }
    if (!east) { context.moveTo(x + arena.tileWidth - 2, y + 2); context.lineTo(x + arena.tileWidth - 2, y + arena.tileHeight - 2); }
    context.stroke();
  } else {
    context.beginPath();
    if (!west) { context.moveTo(x + 2, y); context.lineTo(x + 2, y + arena.tileHeight); }
    if (!east) { context.moveTo(x + arena.tileWidth - 2, y); context.lineTo(x + arena.tileWidth - 2, y + arena.tileHeight); }
    if (!north) { context.moveTo(x + 2, y + 2); context.lineTo(x + arena.tileWidth - 2, y + 2); }
    if (!south) { context.moveTo(x + 2, y + arena.tileHeight - 2); context.lineTo(x + arena.tileWidth - 2, y + arena.tileHeight - 2); }
    context.stroke();
  }
  if ((horizontal && north && south) || (!horizontal && west && east)) {
    context.globalCompositeOperation = "lighter";
    context.strokeStyle = rgba(profile.palette.accent, powered ? 0.34 + Math.sin(elapsed * 0.009 + column + row) * 0.1 : 0.1);
    context.lineWidth = 2;
    context.beginPath();
    if (horizontal) { context.moveTo(x, y + arena.tileHeight / 2); context.lineTo(x + arena.tileWidth, y + arena.tileHeight / 2); }
    else { context.moveTo(x + arena.tileWidth / 2, y); context.lineTo(x + arena.tileWidth / 2, y + arena.tileHeight); }
    context.stroke();
    context.globalCompositeOperation = "source-over";
  }
  context.globalAlpha = 1;
}

function drawSignalCryptBridgeRamp(tile, x, y, column, row) {
  const dynamic = tile.features.includes("dynamic-bridge");
  const powered = !dynamic || dynamicBridgePowered(tile);
  const w = arena.tileWidth;
  const h = arena.tileHeight;
  const horizontal = ["east", "west"].includes(tile.rampDirection);
  const same = (testColumn, testRow) => arena.tiles[testRow * arena.columns + testColumn]?.bridgeId === tile.bridgeId;
  const north = same(column, row - 1), east = same(column + 1, row), south = same(column, row + 1), west = same(column - 1, row);
  const forward = tile.rampDirection === "east" ? [1, 0] : tile.rampDirection === "west" ? [-1, 0] : tile.rampDirection === "south" ? [0, 1] : [0, -1];
  const next = arena.tiles[(row + forward[1]) * arena.columns + column + forward[0]];
  const deck = horizontal ? context.createLinearGradient(x, y, x, y + h) : context.createLinearGradient(x, y, x + w, y);
  deck.addColorStop(0, mixColor(profile.palette.floor, profile.palette.line, 0.3 + tile.elevation * 0.04));
  deck.addColorStop(0.52, mixColor(profile.palette.floor2, profile.palette.line, 0.11));
  deck.addColorStop(1, mixColor(profile.palette.floor2, "#000000", 0.34));
  context.fillStyle = deck; context.fillRect(x, y, w, h);
  if (!south) {
    context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.54); context.fillRect(x, y + h - 1, w, 7);
    context.fillStyle = rgba(profile.palette.line, 0.18); context.fillRect(x, y + h - 1, w, 2);
  }
  if (!east) { context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.44); context.fillRect(x + w - 1, y + 5, 6, h - 5); }
  context.strokeStyle = rgba(powered ? profile.palette.accent : profile.palette.hostile, powered ? 0.5 : 0.22);
  context.lineWidth = 3;
  context.beginPath();
  if (horizontal) {
    if (!north) { context.moveTo(x, y + 2); context.lineTo(x + w, y + 2); }
    if (!south) { context.moveTo(x, y + h - 2); context.lineTo(x + w, y + h - 2); }
    if (!west) { context.moveTo(x + 2, y + 2); context.lineTo(x + 2, y + h - 2); }
    if (!east) { context.moveTo(x + w - 2, y + 2); context.lineTo(x + w - 2, y + h - 2); }
  } else {
    if (!west) { context.moveTo(x + 2, y); context.lineTo(x + 2, y + h); }
    if (!east) { context.moveTo(x + w - 2, y); context.lineTo(x + w - 2, y + h); }
    if (!north) { context.moveTo(x + 2, y + 2); context.lineTo(x + w - 2, y + 2); }
    if (!south) { context.moveTo(x + 2, y + h - 2); context.lineTo(x + w - 2, y + h - 2); }
  }
  context.stroke();
  if (next && next.bridgeId === tile.bridgeId && next.elevation !== tile.elevation) {
    context.strokeStyle = rgba(profile.palette.line, 0.48); context.lineWidth = 3;
    context.beginPath();
    if (horizontal) { const edgeX = tile.rampDirection === "east" ? x + w - 2 : x + 2; context.moveTo(edgeX, y + 4); context.lineTo(edgeX, y + h - 4); }
    else { const edgeY = tile.rampDirection === "south" ? y + h - 2 : y + 2; context.moveTo(x + 4, edgeY); context.lineTo(x + w - 4, edgeY); }
    context.stroke();
  }
  if ((horizontal && north && south) || (!horizontal && west && east)) {
    context.globalCompositeOperation = "lighter";
    context.strokeStyle = rgba(profile.palette.accent, powered ? 0.32 + Math.sin(elapsed * 0.008 + column + row) * 0.1 : 0.1);
    context.lineWidth = 2; context.beginPath();
    if (horizontal) { context.moveTo(x, y + h / 2); context.lineTo(x + w, y + h / 2); }
    else { context.moveTo(x + w / 2, y); context.lineTo(x + w / 2, y + h); }
    context.stroke(); context.globalCompositeOperation = "source-over";
  }
}

function drawSignalCryptBridgeAssembly(bridgeId) {
  const members = [];
  for (let row = 0; row < arena.rows; row += 1) {
    for (let column = 0; column < arena.columns; column += 1) {
      const tile = arena.tiles[row * arena.columns + column];
      if (tile?.bridgeId === bridgeId) members.push({ tile, column, row });
    }
  }
  if (!members.length) return;
  const minimumColumn = Math.min(...members.map((member) => member.column));
  const maximumColumn = Math.max(...members.map((member) => member.column));
  const minimumRow = Math.min(...members.map((member) => member.row));
  const maximumRow = Math.max(...members.map((member) => member.row));
  const left = minimumColumn * arena.tileWidth;
  const top = minimumRow * arena.tileHeight;
  const width = (maximumColumn - minimumColumn + 1) * arena.tileWidth;
  const height = (maximumRow - minimumRow + 1) * arena.tileHeight;
  const memberKeys = new Set(members.map((member) => `${member.column}:${member.row}`));
  const solidRectangle = members.length === (maximumColumn - minimumColumn + 1) * (maximumRow - minimumRow + 1);
  const horizontal = width >= height;
  const dynamic = members.some((member) => member.tile.features?.includes("dynamic-bridge"));
  const powered = !dynamic || dynamicBridgePowered(members[0].tile);
  const hasRamp = members.some((member) => member.tile.features?.includes("ramp"));
  const elevationValues = [...new Set(members.map((member) => member.tile.elevation ?? 0))].sort((a, b) => a - b);
  const radius = 12;
  const faceDepth = 10;
  const deckShape = () => {
    if (!solidRectangle) {
      for (const member of members) context.rect(member.column * arena.tileWidth, member.row * arena.tileHeight, arena.tileWidth, arena.tileHeight);
      return;
    }
    const shapeLeft = left + 3;
    const shapeTop = top + 3;
    const shapeRight = left + width - 5;
    const shapeBottom = top + height - 5;
    context.moveTo(shapeLeft + radius, shapeTop);
    context.lineTo(shapeRight - radius, shapeTop);
    context.quadraticCurveTo(shapeRight, shapeTop, shapeRight, shapeTop + radius);
    context.lineTo(shapeRight, shapeBottom - radius);
    context.quadraticCurveTo(shapeRight, shapeBottom, shapeRight - radius, shapeBottom);
    context.lineTo(shapeLeft + radius, shapeBottom);
    context.quadraticCurveTo(shapeLeft, shapeBottom, shapeLeft, shapeBottom - radius);
    context.lineTo(shapeLeft, shapeTop + radius);
    context.quadraticCurveTo(shapeLeft, shapeTop, shapeLeft + radius, shapeTop);
    context.closePath();
  };

  // One grounded structure for the whole crossing. The dark footprint and
  // south/east faces create depth without exposing the underlying tile grid.
  context.save();
  context.fillStyle = "rgba(0,0,0,.42)";
  context.filter = "blur(7px)";
  for (const member of members) context.fillRect(member.column * arena.tileWidth + 10, member.row * arena.tileHeight + 12, arena.tileWidth, arena.tileHeight);
  context.filter = "none";
  context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.62);
  for (const member of members) {
    const memberX = member.column * arena.tileWidth;
    const memberY = member.row * arena.tileHeight;
    if (!memberKeys.has(`${member.column}:${member.row + 1}`)) {
      context.beginPath();
      context.moveTo(memberX, memberY + arena.tileHeight);
      context.lineTo(memberX + arena.tileWidth, memberY + arena.tileHeight);
      context.lineTo(memberX + arena.tileWidth + faceDepth, memberY + arena.tileHeight + faceDepth);
      context.lineTo(memberX + faceDepth, memberY + arena.tileHeight + faceDepth);
      context.closePath();
      context.fill();
    }
    if (!memberKeys.has(`${member.column + 1}:${member.row}`)) {
      context.beginPath();
      context.moveTo(memberX + arena.tileWidth, memberY);
      context.lineTo(memberX + arena.tileWidth + faceDepth, memberY + faceDepth);
      context.lineTo(memberX + arena.tileWidth + faceDepth, memberY + arena.tileHeight + faceDepth);
      context.lineTo(memberX + arena.tileWidth, memberY + arena.tileHeight);
      context.closePath();
      context.fill();
    }
  }

  const deck = horizontal
    ? context.createLinearGradient(left, top, left, top + height)
    : context.createLinearGradient(left, top, left + width, top);
  deck.addColorStop(0, mixColor(profile.palette.floor, profile.palette.line, 0.38));
  deck.addColorStop(0.48, mixColor(profile.palette.floor2, profile.palette.line, 0.18));
  deck.addColorStop(1, mixColor(profile.palette.floor2, "#000000", 0.24));
  context.fillStyle = deck;
  context.beginPath();
  deckShape();
  context.fill();
  context.save();
  context.beginPath();
  deckShape();
  context.clip();
  fillSignalMaterial(0, 2, profile.palette.line, left, top, width, height, 0.2, "soft-light");

  // Large registered plates replace the old per-cell outlines. Their rhythm
  // follows the crossing axis, so the surface reads as one engineered deck.
  const plateSpan = (horizontal ? arena.tileWidth : arena.tileHeight) * 2;
  const plateCount = Math.ceil((horizontal ? width : height) / plateSpan);
  for (let plate = 1; plate < plateCount; plate += 1) {
    const position = plate * plateSpan;
    context.strokeStyle = rgba(profile.palette.line, 0.2);
    context.lineWidth = 2;
    context.beginPath();
    if (horizontal) {
      context.moveTo(left + position, top + 13);
      context.lineTo(left + position, top + height - 13);
    } else {
      context.moveTo(left + 13, top + position);
      context.lineTo(left + width - 13, top + position);
    }
    context.stroke();
  }
  context.strokeStyle = rgba(profile.palette.floor, 0.34);
  context.lineWidth = 2;
  context.beginPath();
  if (horizontal) {
    context.moveTo(left + 10, top + height * 0.34);
    context.lineTo(left + width - 10, top + height * 0.34);
    context.moveTo(left + 10, top + height * 0.66);
    context.lineTo(left + width - 10, top + height * 0.66);
  } else {
    context.moveTo(left + width * 0.34, top + 10);
    context.lineTo(left + width * 0.34, top + height - 10);
    context.moveTo(left + width * 0.66, top + 10);
    context.lineTo(left + width * 0.66, top + height - 10);
  }
  context.stroke();

  let rampGeometry = null;
  if (hasRamp && elevationValues.length > 1) {
    const low = elevationValues[0];
    const high = elevationValues.at(-1);
    const seamMembers = members.filter((member) => (member.tile.elevation ?? 0) === high);
    const seamPosition = horizontal
      ? Math.min(...seamMembers.map((member) => member.column)) * arena.tileWidth
      : Math.min(...seamMembers.map((member) => member.row)) * arena.tileHeight;
    const rampTile = members.find((member) => member.tile.features?.includes("ramp"));
    const highPositive = ["east", "south"].includes(rampTile?.tile.rampDirection);
    // Keep the grade compact enough to read as a physical junction.  The old
    // 2.4-tile wash looked like a lighting stripe across an otherwise flat
    // deck, especially after the review overlay was applied.
    const rampLength = horizontal ? arena.tileWidth * 0.82 : arena.tileHeight * 0.82;
    const rampStart = seamPosition - rampLength;
    const rampEnd = seamPosition + rampLength;
    const lift = 18 + Math.max(0, high - low - 1) * 6;
    rampGeometry = { seamPosition, rampStart, rampEnd, highPositive, lift };
    const rampGradient = horizontal
      ? context.createLinearGradient(rampStart, top, rampEnd, top)
      : context.createLinearGradient(left, rampStart, left, rampEnd);
    if (highPositive) {
      rampGradient.addColorStop(0, "rgba(0,0,0,.2)");
      rampGradient.addColorStop(0.52, rgba(profile.palette.line, 0.34 + (high - low) * 0.08));
      rampGradient.addColorStop(1, "rgba(255,255,255,.14)");
    } else {
      rampGradient.addColorStop(0, "rgba(255,255,255,.14)");
      rampGradient.addColorStop(0.48, rgba(profile.palette.line, 0.34 + (high - low) * 0.08));
      rampGradient.addColorStop(1, "rgba(0,0,0,.2)");
    }
    context.fillStyle = rampGradient;
    context.beginPath();
    if (horizontal) {
      const startLift = highPositive ? 0 : lift;
      const endLift = highPositive ? lift : 0;
      context.moveTo(rampStart, top + 11 - startLift);
      context.lineTo(rampEnd, top + 11 - endLift);
      context.lineTo(rampEnd, top + height - 11 - endLift);
      context.lineTo(rampStart, top + height - 11 - startLift);
    } else {
      const startLift = highPositive ? 0 : lift;
      const endLift = highPositive ? lift : 0;
      context.moveTo(left + 11 - startLift, rampStart);
      context.lineTo(left + width - 11 - startLift, rampStart);
      context.lineTo(left + width - 11 - endLift, rampEnd);
      context.lineTo(left + 11 - endLift, rampEnd);
    }
    context.closePath();
    context.fill();
    // Three registered grade ribs provide perspective without turning the
    // ramp into stairs.  Their screen-space displacement follows the same
    // low/high landing math as the exterior rail.
    context.strokeStyle = rgba(profile.palette.line, 0.34);
    context.lineWidth = 2;
    for (let rib = 1; rib <= 3; rib += 1) {
      const progress = rib / 4;
      if (horizontal) {
        const ribX = rampStart + (rampEnd - rampStart) * progress;
        const ribLift = highPositive ? lift * progress : lift * (1 - progress);
        context.beginPath();
        context.moveTo(ribX, top + 17 - ribLift);
        context.lineTo(ribX, top + height - 17 - ribLift);
        context.stroke();
      } else {
        const ribY = rampStart + (rampEnd - rampStart) * progress;
        const ribLift = highPositive ? lift * progress : lift * (1 - progress);
        context.beginPath();
        context.moveTo(left + 17 - ribLift, ribY);
        context.lineTo(left + width - 17 - ribLift, ribY);
        context.stroke();
      }
    }
    context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.58);
    context.beginPath();
    if (horizontal) {
      const startLift = highPositive ? 0 : lift;
      const endLift = highPositive ? lift : 0;
      context.moveTo(rampStart, top + height - 11 - startLift);
      context.lineTo(rampEnd, top + height - 11 - endLift);
      context.lineTo(rampEnd, top + height - 5 - endLift);
      context.lineTo(rampStart, top + height - 5 - startLift);
    } else {
      const startLift = highPositive ? 0 : lift;
      const endLift = highPositive ? lift : 0;
      context.moveTo(left + width - 11 - startLift, rampStart);
      context.lineTo(left + width - 11 - endLift, rampEnd);
      context.lineTo(left + width - 5 - endLift, rampEnd);
      context.lineTo(left + width - 5 - startLift, rampStart);
    }
    context.closePath();
    context.fill();
    // The high landing gets a hard registered lip.  This is the missing depth
    // cue that distinguishes a real elevation change from a bright material
    // band while preserving the traversable ramp surface.
    context.strokeStyle = rgba(profile.palette.line, 0.58);
    context.lineWidth = 3;
    context.beginPath();
    if (horizontal) {
      const landingX = highPositive ? rampEnd : rampStart;
      const landingLift = lift;
      context.moveTo(landingX, top + 12 - landingLift);
      context.lineTo(landingX, top + height - 12 - landingLift);
    } else {
      const landingY = highPositive ? rampEnd : rampStart;
      const landingLift = lift;
      context.moveTo(left + 12 - landingLift, landingY);
      context.lineTo(left + width - 12 - landingLift, landingY);
    }
    context.stroke();
  }
  context.restore();

  // Exterior rails and end abutments only. They sit inside the deck edge and
  // never trace internal tile boundaries.
  context.strokeStyle = rgba(powered ? profile.palette.accent : profile.palette.hostile, powered ? 0.4 : 0.18);
  context.lineWidth = 4;
  context.save();
  context.beginPath();
  deckShape();
  context.clip();
  const railPath = (secondary) => {
    const base = horizontal ? (secondary ? top + height - 10 : top + 8) : (secondary ? left + width - 10 : left + 8);
    if (!rampGeometry) {
      if (horizontal) { context.moveTo(left + 18, base); context.lineTo(left + width - 18, base); }
      else { context.moveTo(base, top + 18); context.lineTo(base, top + height - 18); }
      return;
    }
    const { rampStart, rampEnd, highPositive, lift } = rampGeometry;
    if (horizontal) {
      const lowY = base;
      const highY = base - lift;
      context.moveTo(left + 18, highPositive ? lowY : highY);
      context.lineTo(rampStart, highPositive ? lowY : highY);
      context.lineTo(rampEnd, highPositive ? highY : lowY);
      context.lineTo(left + width - 18, highPositive ? highY : lowY);
    } else {
      const lowX = base;
      const highX = base - lift;
      context.moveTo(highPositive ? lowX : highX, top + 18);
      context.lineTo(highPositive ? lowX : highX, rampStart);
      context.lineTo(highPositive ? highX : lowX, rampEnd);
      context.lineTo(highPositive ? highX : lowX, top + height - 18);
    }
  };
  context.beginPath();
  railPath(false);
  railPath(true);
  context.stroke();
  const postInterval = (horizontal ? arena.tileWidth : arena.tileHeight) * 2;
  const postCount = Math.floor((horizontal ? width : height) / postInterval);
  for (let post = 1; post < postCount; post += 1) {
    const offset = post * postInterval;
    context.fillStyle = mixColor(profile.palette.floor2, profile.palette.line, 0.24);
    if (horizontal) {
      context.fillRect(left + offset - 4, top + 3, 8, 11);
      context.fillRect(left + offset - 4, top + height - 16, 8, 11);
    } else {
      context.fillRect(left + 3, top + offset - 4, 11, 8);
      context.fillRect(left + width - 16, top + offset - 4, 11, 8);
    }
  }
  const abutment = (ax, ay, aw, ah) => {
    context.fillStyle = mixColor(profile.palette.floor2, profile.palette.line, 0.18);
    context.fillRect(ax, ay, aw, ah);
    context.fillStyle = rgba(profile.palette.line, 0.26);
    context.fillRect(ax + 3, ay + 3, Math.max(2, aw - 6), Math.max(2, ah - 6));
  };
  if (horizontal) {
    abutment(left + 3, top + 14, 11, height - 32);
    abutment(left + width - 16, top + 14, 11, height - 32);
  } else {
    abutment(left + 14, top + 3, width - 32, 11);
    abutment(left + 14, top + height - 16, width - 32, 11);
  }

  context.globalCompositeOperation = "lighter";
  context.strokeStyle = rgba(profile.palette.accent, powered ? 0.27 + Math.sin(elapsed * 0.008) * 0.07 : 0.08);
  context.lineWidth = 2;
  context.beginPath();
  if (horizontal) { context.moveTo(left + 15, top + height / 2); context.lineTo(left + width - 15, top + height / 2); }
  else { context.moveTo(left + width / 2, top + 15); context.lineTo(left + width / 2, top + height - 15); }
  context.stroke();
  context.globalCompositeOperation = "source-over";
  context.restore();
  context.restore();
}

function drawSignalCryptCalmGrammar(tile, x, y) {
  if (tile.roomLocalColumn == null || tile.roomLocalRow == null || !tile.roomWidth || !tile.roomHeight) return;
  const width = arena.tileWidth;
  const height = arena.tileHeight;
  const roomLeft = x - tile.roomLocalColumn * width;
  const roomTop = y - tile.roomLocalRow * height;
  const roomWidth = tile.roomWidth * width;
  const roomHeight = tile.roomHeight * height;
  const centerX = roomLeft + roomWidth / 2;
  const centerY = roomTop + roomHeight / 2;
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.strokeStyle = rgba(profile.palette.line, 0.075);
  context.lineWidth = 2;
  context.beginPath();
  if (tile.floorPattern === "cross-sanctum") {
    context.moveTo(roomLeft, centerY); context.lineTo(roomLeft + roomWidth, centerY);
    context.moveTo(centerX, roomTop); context.lineTo(centerX, roomTop + roomHeight);
    context.moveTo(roomLeft, centerY - 15); context.lineTo(roomLeft + roomWidth, centerY - 15);
    context.moveTo(centerX + 15, roomTop); context.lineTo(centerX + 15, roomTop + roomHeight);
  } else if (tile.floorPattern === "relay-chapel") {
    const maximumRadius = Math.min(roomWidth, roomHeight) * 0.46;
    for (const radius of [maximumRadius, maximumRadius * 0.72, maximumRadius * 0.48]) {
      context.moveTo(centerX + radius, centerY);
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    }
    context.moveTo(roomLeft, centerY); context.lineTo(roomLeft + roomWidth, centerY);
  } else if (tile.floorPattern === "rune-hall") {
    const lane = roomHeight / 5;
    for (let index = 1; index < 5; index += 1) {
      const laneY = roomTop + lane * index;
      const stepX = roomLeft + roomWidth * (index % 2 ? 0.36 : 0.64);
      context.moveTo(roomLeft, laneY);
      context.lineTo(stepX, laneY);
      context.lineTo(stepX, laneY + (index % 2 ? lane * 0.45 : -lane * 0.45));
      context.lineTo(roomLeft + roomWidth, laneY + (index % 2 ? lane * 0.45 : -lane * 0.45));
    }
  } else if (tile.floorPattern === "split-vault") {
    context.moveTo(roomLeft, roomTop); context.lineTo(roomLeft + roomWidth, roomTop + roomHeight);
    context.moveTo(roomLeft + roomWidth, roomTop); context.lineTo(roomLeft, roomTop + roomHeight);
    context.moveTo(centerX, roomTop); context.lineTo(centerX, roomTop + roomHeight);
  }
  context.stroke();
  context.strokeStyle = rgba(profile.palette.accent, 0.12);
  context.lineWidth = 1;
  context.stroke();
  context.restore();
}

function drawSignalCryptFloor(tile, x, y) {
  context.save();
  context.globalAlpha = 0.96;
  const calmMaterialColumn = ({ "cross-sanctum": 0, "relay-chapel": 1, "rune-hall": 2, "split-vault": 3 })[tile.floorPattern] ?? 0;
  // Every dry cell begins with the exact same world-aligned calm material.
  // Macro cells only add transparent authored detail on top of this base.
  context.fillStyle = profile.palette.floor;
  context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
  context.fillStyle = rgba(profile.palette.floor2, 0.2 + (tile.materialBand ?? 0) * 0.018);
  context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
  fillSignalMaterial(calmMaterialColumn, 0, profile.palette.floor, x, y, arena.tileWidth, arena.tileHeight, 0.28);
  if (Number.isInteger(tile.floorMacroColumn) && Number.isInteger(tile.floorMacroRow)) {
    context.save();
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 0.76;
    context.translate(x + arena.tileWidth / 2, y + arena.tileHeight / 2);
    context.rotate((tile.floorMacroTurns ?? 0) * Math.PI / 2);
    context.drawImage(floorMacroSprite(tile, profile.palette.floor2), -arena.tileWidth / 2, -arena.tileHeight / 2, arena.tileWidth, arena.tileHeight);
    context.restore();
  } else {
    const collarMask = tile.floorMacroCollarMask ?? 0;
    const collarFill = (bit) => {
      if (!(collarMask & bit)) return;
      const horizontal = bit === 2 || bit === 8;
      const gradient = horizontal
        ? context.createLinearGradient(x, y, x + arena.tileWidth, y)
        : context.createLinearGradient(x, y, x, y + arena.tileHeight);
      const macroAtEnd = bit === 2 || bit === 4;
      gradient.addColorStop(0, rgba(profile.palette.floor2, macroAtEnd ? 0.12 : 0.82));
      gradient.addColorStop(1, rgba(profile.palette.floor2, macroAtEnd ? 0.82 : 0.12));
      context.fillStyle = gradient;
      context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
      fillSignalMaterial(2, 1, profile.palette.floor2, x, y, arena.tileWidth, arena.tileHeight, 0.18);
    };
    collarFill(1); collarFill(2); collarFill(4); collarFill(8);
    if ((tile.variant + tile.materialBand) % 11 === 0) {
      context.fillStyle = rgba(profile.palette.ambient, 0.28);
      context.fillRect(x + 10, y + 10, 3, 3);
    }
  }
  context.restore();
  const macroEdgeMask = tile.floorMacroEdgeMask ?? 0;
  if (macroEdgeMask) {
    context.save();
    const softenEdge = (bit) => {
      if (!(macroEdgeMask & bit)) return;
      let gradient;
      if (bit === 1) gradient = context.createLinearGradient(x, y, x, y + arena.tileHeight);
      if (bit === 2) gradient = context.createLinearGradient(x + arena.tileWidth, y, x, y);
      if (bit === 4) gradient = context.createLinearGradient(x, y + arena.tileHeight, x, y);
      if (bit === 8) gradient = context.createLinearGradient(x, y, x + arena.tileWidth, y);
      gradient.addColorStop(0, rgba(profile.palette.floor, 0.68));
      gradient.addColorStop(0.18, rgba(profile.palette.floor, 0.34));
      gradient.addColorStop(0.58, rgba(profile.palette.floor, 0));
      gradient.addColorStop(1, rgba(profile.palette.floor, 0));
      context.fillStyle = gradient;
      context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
    };
    softenEdge(1); softenEdge(2); softenEdge(4); softenEdge(8);
    context.restore();
  }
  drawSignalCryptTerrainOverlay(tile, x, y);
}

function drawSignalCryptTerrainOverlay(tile, x, y) {
  if (tile.terrain === "dry") return;
  const row = ({ water: 0, lava: 1, mist: 2, void: 3 })[tile.terrain] ?? 2;
  const frame = (Math.floor(elapsed / 135) + (tile.variant ?? 0)) % 8;
  drawTilekitCell(signalCryptAnimations, "crypt-animation", frame, row, x, y, arena.tileWidth, arena.tileHeight, tile.terrain === "lava" ? profile.palette.hostile : profile.palette.ambient, 0, 0.76);
}

function colorChannels(color) {
  const value = String(color).replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return [128, 128, 128];
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function mixChannels(left, right, amount) {
  return left.map((channel, index) => Math.round(lerp(channel, right[index], amount)));
}

function channelsHex(channels) {
  return `#${channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

function mixColor(left, right, amount) {
  return channelsHex(mixChannels(colorChannels(left), colorChannels(right), amount));
}

function floorVariationPattern(palette, biome, seed) {
  const key = `${palette.id ?? "palette"}:${biome}:${seed}`;
  if (floorVariationPatternCache.has(key)) return floorVariationPatternCache.get(key);
  const output = document.createElement("canvas");
  output.width = 512;
  output.height = 512;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  const frame = outputContext.createImageData(512, 512);
  const identity = hash32(`${seed}:${biome}:material-relief`);
  const bright = mixChannels(colorChannels(palette.line), colorChannels(palette.accent), 0.28);
  const dark = mixChannels(colorChannels(palette.floor), [0, 2, 3], 0.84);
  for (let pixelY = 0; pixelY < 512; pixelY += 1) for (let pixelX = 0; pixelX < 512; pixelX += 1) {
    // Three-pixel horizontal runs read as brushed wear instead of a Fourier
    // lattice. The full seeded 512px carrier repeats in world space, so a
    // neighboring 64px cell does not restart or reuse the same patch.
    let noise = Math.imul((Math.floor(pixelX / 3) + 1) ^ identity, 0x45d9f3b)
      ^ Math.imul((pixelY + 1) ^ (identity >>> 16), 0x27d4eb2d);
    noise ^= noise >>> 15;
    noise = Math.imul(noise, 0x85ebca6b);
    noise ^= noise >>> 13;
    const relief = (noise >>> 0) / 0xffffffff * 2 - 1;
    const magnitude = clamp(Math.abs(relief), 0.12, 1);
    const color = relief >= 0 ? bright : dark;
    const alpha = relief >= 0 ? 0.04 + magnitude * 0.1 : 0.065 + magnitude * 0.15;
    const offset = (pixelY * 512 + pixelX) * 4;
    frame.data[offset] = color[0];
    frame.data[offset + 1] = color[1];
    frame.data[offset + 2] = color[2];
    frame.data[offset + 3] = Math.round(alpha * 255);
  }
  outputContext.putImageData(frame, 0, 0);
  const pattern = context.createPattern(output, "repeat");
  floorVariationPatternCache.set(key, pattern);
  return pattern;
}

function drawFloorVariation(tile, x, y, column, row) {
  if (tile.terrain !== "dry") return;
  // Canvas patterns stay registered in world space across separate cell fills,
  // so there is no tile seam. The token/map seed still fixes the exact relief.
  context.fillStyle = floorVariationPattern(profile.palette, profile.biome, run.seed);
  context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
}

function forgeFloorPattern(palette) {
  const key = `${palette.id ?? "palette"}:${palette.floor}:${palette.floor2}:${palette.line}:${palette.accent}`;
  if (floorMaterialCache.has(key)) return floorMaterialCache.get(key);
  const output = document.createElement("canvas");
  output.width = forgeFloorMaterial.naturalWidth;
  output.height = forgeFloorMaterial.naturalHeight;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  outputContext.drawImage(forgeFloorMaterial, 0, 0);
  const frame = outputContext.getImageData(0, 0, output.width, output.height);
  const low = colorChannels(palette.floor);
  const middle = colorChannels(palette.floor2);
  const high = colorChannels(palette.line);
  const accent = colorChannels(palette.accent);
  for (let offset = 0; offset < frame.data.length; offset += 4) {
    const luminance = (frame.data[offset] * 0.2126 + frame.data[offset + 1] * 0.7152 + frame.data[offset + 2] * 0.0722) / 255;
    let color = luminance < 0.52 ? mixChannels(low, middle, luminance / 0.52) : mixChannels(middle, high, (luminance - 0.52) / 0.48);
    if (luminance > 0.82) color = mixChannels(color, accent, (luminance - 0.82) * 0.48);
    frame.data[offset] = color[0];
    frame.data[offset + 1] = color[1];
    frame.data[offset + 2] = color[2];
  }
  outputContext.putImageData(frame, 0, 0);
  const pattern = context.createPattern(output, "repeat");
  floorMaterialCache.set(key, pattern);
  return pattern;
}

function forgeWallPattern(palette) {
  const key = `${palette.id ?? "palette"}:${palette.floor}:${palette.floor2}:${palette.line}:${palette.accent}`;
  if (wallMaterialCache.has(key)) return wallMaterialCache.get(key);
  const output = document.createElement("canvas");
  output.width = forgeWallMaterial.naturalWidth;
  output.height = forgeWallMaterial.naturalHeight;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  outputContext.drawImage(forgeWallMaterial, 0, 0);
  const frame = outputContext.getImageData(0, 0, output.width, output.height);
  const shadow = mixChannels(colorChannels(palette.floor), [3, 5, 6], 0.56);
  const body = mixChannels(colorChannels(palette.floor2), colorChannels(palette.line), 0.34);
  const bevel = mixChannels(colorChannels(palette.line), colorChannels(palette.accent), 0.26);
  for (let offset = 0; offset < frame.data.length; offset += 4) {
    const luminance = (frame.data[offset] * 0.2126 + frame.data[offset + 1] * 0.7152 + frame.data[offset + 2] * 0.0722) / 255;
    const color = luminance < 0.47
      ? mixChannels(shadow, body, luminance / 0.47)
      : mixChannels(body, bevel, (luminance - 0.47) / 0.53);
    frame.data[offset] = color[0];
    frame.data[offset + 1] = color[1];
    frame.data[offset + 2] = color[2];
  }
  outputContext.putImageData(frame, 0, 0);
  const pattern = context.createPattern(output, "repeat");
  wallMaterialCache.set(key, pattern);
  return pattern;
}

function enemyMaterialPalette(enemy) {
  const semanticParts = {
    drifter: { seam: "shell", dark: "shell", mid: "shell", light: "shell", highlight: "shell", core: "core" },
    lancer: { seam: "trail", dark: "wings", mid: "body", light: "lance", highlight: "visor", core: "core" },
    wisp: { seam: "halo", dark: "halo", mid: "projectile", light: "halo", highlight: "halo", core: "core" },
    bulwark: { seam: "armor", dark: "armor", mid: "shield", light: "shield", highlight: "armor", core: "core" },
  }[enemy.type] ?? {};
  const part = (name, fallback) => enemy.partColors[semanticParts[name]] ?? fallback;
  return {
    seam: colorChannels(part("seam", profile.palette.floor)),
    "armor-dark": colorChannels(part("dark", profile.palette.line)),
    "armor-mid": colorChannels(part("mid", profile.palette.ambient)),
    "armor-light": colorChannels(part("light", profile.palette.accent)),
    highlight: colorChannels(enemy.elite ? "#fff18a" : part("highlight", profile.palette.ambient)),
    "emissive-core": colorChannels(part("core", profile.palette.hostile)),
    "skin-panel-1": colorChannels(enemy.partColors["skin-1"] ?? enemy.partColors.skin ?? profile.palette.accent),
    "skin-panel-2": colorChannels(enemy.partColors["skin-2"] ?? profile.palette.ambient),
    "skin-panel-3": colorChannels(enemy.partColors["skin-3"] ?? profile.palette.hostile),
    "skin-panel-4": colorChannels(enemy.partColors["skin-4"] ?? profile.palette.line),
    "skin-panel-5": colorChannels(enemy.partColors["skin-5"] ?? profile.palette.accent),
    "skin-panel-6": colorChannels(enemy.partColors["skin-6"] ?? profile.palette.ambient),
  };
}

function recoloredCanvas(source, sourceX, sourceY, sourceWidth, sourceHeight, palette, materialMap = null, maskOverride = null, skinOverride = null) {
  const paletteKey = JSON.stringify(palette);
  const overrideKey = maskOverride ? JSON.stringify(maskOverride) : "authored";
  const skinKey = skinOverride ? JSON.stringify(skinOverride) : "no-skin";
  const key = `${source.src}:${sourceX}:${sourceY}:${sourceWidth}:${sourceHeight}:${paletteKey}:${materialMap?.src ?? "classified"}:${overrideKey}:${skinKey}`;
  if (enemyMaterialCache.has(key)) return enemyMaterialCache.get(key);
  const output = document.createElement("canvas");
  output.width = sourceWidth;
  output.height = sourceHeight;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  const frame = outputContext.getImageData(0, 0, sourceWidth, sourceHeight);
  if (materialMap) {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = sourceWidth;
    maskCanvas.height = sourceHeight;
    const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    maskContext.imageSmoothingEnabled = false;
    maskContext.drawImage(materialMap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    const maskFrame = maskContext.getImageData(0, 0, sourceWidth, sourceHeight);
    if (maskOverride) for (const [pixel, id] of Object.entries(maskOverride)) {
      const index = Number(pixel);
      if (!Number.isInteger(index) || index < 0 || index >= sourceWidth * sourceHeight) continue;
      const color = materialIdColor(Number(id));
      maskFrame.data.set(color, index * 4);
    }
    const recolored = recolorVaultMaterialMapPixels(frame.data, maskFrame.data, palette);
    if (maskOverride) {
      const regionNames = ["transparent", "locked-outline", "seam", "armor-dark", "armor-mid", "armor-light", "highlight", "emissive-core"];
      for (const [pixel, rawId] of Object.entries(maskOverride)) {
        const index = Number(pixel);
        const id = Number(rawId);
        const offset = index * 4;
        if (!Number.isInteger(index) || index < 0 || index >= sourceWidth * sourceHeight || frame.data[offset + 3] >= 24 || id <= 0) continue;
        const base = palette[regionNames[id]] ?? [255, 255, 255];
        recolored[offset] = base[0];
        recolored[offset + 1] = base[1];
        recolored[offset + 2] = base[2];
        recolored[offset + 3] = id === 7 ? 225 : id === 2 ? 150 : 185;
      }
    }
    if (skinOverride) for (const [pixel, rawPanel] of Object.entries(skinOverride)) {
      const panel = Number(rawPanel);
      if (!Number.isInteger(panel) || panel < 1 || panel > 6) continue;
      const index = Number(pixel);
      const offset = index * 4;
      if (!Number.isInteger(index) || index < 0 || index >= sourceWidth * sourceHeight || frame.data[offset + 3] < 24) continue;
      const x = index % sourceWidth;
      const y = Math.floor(index / sourceWidth);
      const pattern = (x * 3 + y * 5) % 7;
      const amount = pattern === 0 ? 0.52 : pattern < 3 ? 0.34 : 0.2;
      const color = mixChannels([recolored[offset], recolored[offset + 1], recolored[offset + 2]], palette[`skin-panel-${panel}`], amount);
      recolored[offset] = color[0];
      recolored[offset + 1] = color[1];
      recolored[offset + 2] = color[2];
    }
    frame.data.set(recolored);
  } else {
    frame.data.set(recolorVaultMaterialPixels(frame.data, palette));
  }
  outputContext.putImageData(frame, 0, 0);
  enemyMaterialCache.set(key, output);
  return output;
}

function directionalEnemySprite(enemy) {
  const palette = enemyMaterialPalette(enemy);
  if (enemy.type === "drifter") {
    const frame = Math.max(0, directionOrder.indexOf(enemy.facing));
    const overrides = mobMaskOverrides.assets?.drifter?.directions?.[enemy.facing] ?? null;
    const skin = mobMaskOverrides.assets?.drifter?.skinPanels?.[enemy.facing] ?? null;
    return recoloredCanvas(forgeDrifterSource, (frame % 4) * 48, Math.floor(frame / 4) * 48, 48, 48, palette, forgeDrifterMaterialMap, overrides, skin);
  }
  if (enemy.type === "lancer") {
    const directionFrame = Math.max(0, directionOrder.indexOf(enemy.facing));
    const overrides = mobMaskOverrides.assets?.lancer?.directions?.[enemy.facing] ?? null;
    const skin = mobMaskOverrides.assets?.lancer?.skinPanels?.[enemy.facing] ?? null;
    const animation = LANCER_ANIMATION_REVIEW === "approved" ? lancerAnimationFrame(enemy) : null;
    if (animation) return recoloredCanvas(animation.spec.source, animation.frame * 68, directionFrame * 68, 68, 68, palette, animation.spec.materialMap, overrides, skin);
    return recoloredCanvas(pixellabLancerSource, (directionFrame % 4) * 68, Math.floor(directionFrame / 4) * 68, 68, 68, palette, pixellabLancerMaterialMap, overrides, skin);
  }
  const columns = { wisp: 1, bulwark: 3 };
  const column = columns[enemy.type] ?? 4;
  const sourceAtlas = activeBiomeAtlas();
  const cell = Math.floor(sourceAtlas.width / atlas.gameArt.grid[0]);
  const key = `${profile?.biome}:${enemy.type}:${JSON.stringify(palette)}`;
  if (!forgeMaterialCache.has(key)) forgeMaterialCache.set(key, recoloredCanvas(sourceAtlas, column * cell, 3 * cell, cell, cell, palette));
  return forgeMaterialCache.get(key);
}

function lancerAnimationFrame(enemy) {
  let name = "idle";
  let startedAt = enemy.spawnedAt ?? 0;
  if (enemy.deathStartedAt !== undefined) { name = "death"; startedAt = enemy.deathStartedAt; }
  else if (enemy.hitStartedAt !== undefined && elapsed < enemy.hitStartedAt + pixellabLancerAnimations.hit.frames * pixellabLancerAnimations.hit.frameMs) { name = "hit"; startedAt = enemy.hitStartedAt; }
  else if (enemy.attackStartedAt !== undefined && elapsed < enemy.attackStartedAt + pixellabLancerAnimations.charge.frames * pixellabLancerAnimations.charge.frameMs) { name = "charge"; startedAt = enemy.attackStartedAt; }
  else if (elapsed < (enemy.motionUntil ?? 0)) { name = "move"; startedAt = enemy.motionStartedAt ?? 0; }
  const spec = pixellabLancerAnimations[name];
  const rawFrame = Math.max(0, Math.floor((elapsed - startedAt) / spec.frameMs));
  return { name, spec, frame: spec.loop ? rawFrame % spec.frames : Math.min(spec.frames - 1, rawFrame) };
}

async function loadOrbMaterialInputs() {
  const [mask, panel, targetsResponse] = await Promise.all([
    loadImage("./orb-core-v1-material-mask.png"),
    loadImage("./orb-core-v1-panel-mask.png"),
    fetch("./orb-core-v1-attribute-targets.json", { cache: "no-store" }),
  ]);
  if (!targetsResponse.ok) throw new Error(`Orb attribute targets failed: ${targetsResponse.status}`);
  const targets = await targetsResponse.json();
  if (targets.schema !== "vault-attribute-targets@1") throw new Error("Unsupported orb target schema");
  const pixels = (image) => {
    const buffer = document.createElement("canvas");
    buffer.width = image.naturalWidth;
    buffer.height = image.naturalHeight;
    const bufferContext = buffer.getContext("2d", { willReadFrequently: true });
    bufferContext.drawImage(image, 0, 0);
    return bufferContext.getImageData(0, 0, buffer.width, buffer.height);
  };
  const decodeFrame = (runs) => {
    const output = [];
    for (const [value, count] of runs) for (let index = 0; index < count; index += 1) output.push(value);
    if (output.length !== 34 * 34) throw new Error("Invalid orb target frame");
    return output;
  };
  const panelPixels = new ImageData(34 * directionOrder.length, 34);
  const skinPixels = new ImageData(34 * directionOrder.length, 34);
  const rearPortHotspots = {};
  const colors = { shell: [96, 96, 96, 255], visor: [0, 255, 255, 255], light: [180, 0, 255, 255], port: [255, 200, 0, 255] };
  directionOrder.forEach((direction, frame) => {
    const components = decodeFrame(targets.componentFrames[direction]);
    const skin = decodeFrame(targets.skinFrames[direction]);
    let portX = 0, portY = 0, portPixels = 0;
    components.forEach((componentIndex, pixel) => {
      const component = targets.componentLabels[componentIndex];
      const x = pixel % 34;
      const y = Math.floor(pixel / 34);
      const offset = (y * panelPixels.width + frame * 34 + x) * 4;
      const color = colors[component];
      if (color) panelPixels.data.set(color, offset);
      if (component === "shell" && !skin[pixel]) skinPixels.data.set([255, 255, 255, 255], offset);
      if (component === "port") { portX += x; portY += y; portPixels += 1; }
    });
    if (portPixels > 0) rearPortHotspots[direction] = Object.freeze({ x: portX / portPixels, y: portY / portPixels });
  });
  return { sourcePixels: pixels(rawOrbImage), maskPixels: pixels(mask), panelPixels, skinPixels, targets, rearPortHotspots: Object.freeze(rearPortHotspots) };
}

function materializeOrb(appearance) {
  const output = document.createElement("canvas");
  output.width = rawOrbImage.naturalWidth;
  output.height = rawOrbImage.naturalHeight;
  const outputContext = output.getContext("2d");
  const shellPalette = ORB_METAL_PALETTES[appearance.shell];
  const port = ORB_PORT_LIGHTS[appearance.rearLight];
  paintOrbMaterialAtlas({
    ...orbMaterialInputs,
    targetContext: outputContext,
    shellPalette,
    visorPalette: appearance.visor === "matched" ? shellPalette : ORB_VISOR_PALETTES[appearance.visor],
    lightStyle: ORB_LIGHT_STYLES[appearance.coreLight],
    portLightStyle: port?.linkedLight ? { ...ORB_LIGHT_STYLES[appearance.coreLight], intensity: port.intensity } : port,
    skinStyle: ORB_SKIN_STYLES[appearance.skin],
  });
  orbImage = output;
}

function vectorLength(x, y) { return Math.hypot(x, y); }
function normalized(x, y) { const length = vectorLength(x, y) || 1; return { x: x / length, y: y / length }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function rgba(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}
function announce(message, duration = 1700) {
  toastElement.textContent = message;
  toastElement.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove("show"), duration);
}
function roundedPath(ctx, x, y, width, height, radius) { ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); }
function circleHit(a, b, extra = 0) { return distance(a, b) <= a.radius + b.radius + extra; }
function weaponBuildFor(weapon) {
  const seed = run.packedAttributes ?? run.characterSeed;
  const key = `${seed}:${weapon.id}`;
  if (!weaponMaterialBuildCache.has(key)) {
    const build = run.packedAttributes === undefined
      ? rollWeaponMaterialBuild(weaponMaterialCatalog, seed, weapon.id)
      : materialBuildFromPackedAttributes(weaponMaterialCatalog, run.packedAttributes, weapon.id);
    weaponMaterialBuildCache.set(key, build);
  }
  return weaponMaterialBuildCache.get(key);
}

function materializedWeapon(weapon, sourceImage = weaponImages.get(weapon.id), frame = "base") {
  const build = weaponBuildFor(weapon);
  const coreStyle = ORB_LIGHT_STYLES[run.character.appearance.coreLight];
  const key = `${build.seed}:${weapon.id}:${frame}:${run.character.appearance.coreLight}`;
  if (!weaponMaterialFrameCache.has(key)) {
    weaponMaterialFrameCache.set(key, materializeWeaponFrame({
      catalog: weaponMaterialCatalog,
      layouts: weaponRegionLayouts,
      overrides: weaponRegionOverrides,
      build,
      sourceImage,
      coreStyle,
      frame,
    }));
  }
  return weaponMaterialFrameCache.get(key);
}

function currentGyroFrame(weapon = run.weapon.id === "gyro" ? run.weapon : run.weapons.find((candidate) => candidate.id === "gyro"), speed = 1) {
  const frame = vaultGyroFrameIndex(elapsed, gyroSpinFrames.length, speed);
  document.documentElement.dataset.vaultGyroFrame = String(frame);
  return materializedWeapon(weapon, gyroSpinFrames[frame], String(frame));
}

async function beginRun(mapSeed = seedInput.value, characterSeed = characterSeedInput.value) {
  if (vaultSurface === "map-viewer" && !verifiedMapViewerContext && !allowDevelopmentQuery) {
    announce("Verified Keel map + character context required", 2600);
    document.documentElement.dataset.vaultViewerBlocked = "missing-keel-context";
    return;
  }
  const committedAssetId = injectedContext?.assetId?.toLowerCase();
  const forcedWeaponId = typeof committedAssetId === "string"
    ? atlas.weapons.find((weapon) => weapon.assetId?.toLowerCase() === committedAssetId)?.id
    : undefined;
  run = createRunDescriptor(atlas, mapSeed, characterSeed, {
    ...(injectedContext?.packedAttributes === undefined ? {} : { packedAttributes: injectedContext.packedAttributes }),
    ...(forcedWeaponId === undefined ? {} : { forcedWeaponId }),
  });
  materializeOrb(run.character.appearance);
  const requestedReviewLayer = artReviewMode ? Number.parseInt(launchParams.get("reviewLayer") ?? "1", 10) : 1;
  layer = Number.isInteger(requestedReviewLayer) ? clamp(requestedReviewLayer, 1, 64) : 1;
  score = 0;
  elapsed = 0;
  started = true;
  pausedForShop = false;
  combatRng = makeRng(`${run.seed}:combat`);
  player = {
    x: canvas.width / 2,
    y: canvas.height / 2,
    radius: 24,
    health: run.character.maxHealth,
    maxHealth: run.character.maxHealth,
    level: run.character.level,
    experience: 0,
    nextLevelExperience: 55,
    moveSpeed: run.character.moveSpeed,
    defense: run.character.defense,
    critical: run.character.critical + run.weapon.critical,
    pickupRadius: run.character.pickupRadius,
    velocityX: 0,
    velocityY: 0,
    aim: { x: 1, y: 0 },
    facing: "east",
    invulnerableUntil: 0,
    shieldUntil: 0,
    blinkReadyAt: 0,
    defenseReadyAt: 0,
    cooldownAttackReadyAt: 0,
    ultimateReadyAt: 0,
    longReadyAt: 0,
    closeReadyAt: 0,
    chargeReadyAt: 0,
    shootHeldAt: null,
    terrainTouchReadyAt: 0,
    chargeStartedAt: null,
    energy: VAULT_PLAYER_COMBAT_RULES.energy.maximum,
    maxEnergy: VAULT_PLAYER_COMBAT_RULES.energy.maximum,
    energyLockUntil: 0,
    energyNeedsRelease: false,
    boosting: false,
    flashUntil: 0,
    backpackSlots: run.backpack.slots,
    backpack: structuredClone(run.backpack.items),
    activeWeaponIndex: 0,
    baseCritical: run.character.critical,
    gyroProjectileId: null,
    runAttributes: { power: 0, agility: 0, guard: 0, signal: 0 },
  };
  updateRunUi();
  await loadLayer(layer);
  canvas.focus();
  announce(`${run.weapon.rarity.toUpperCase()} ${run.weapon.name} · run ${run.mapSeedDigest}`);
  if (launchParams.get("reviewStation") === "1") setTimeout(() => openLoadoutStation(), 250);
}

async function loadLayer(nextLayer) {
  pausedForShop = true;
  layer = nextLayer;
  const nextProfile = createLayerProfile(atlas, run, layer);
  await ensureBiomeAtlas(nextProfile.biome);
  profile = nextProfile;
  sharedMobVisualRecipes = createVaultMobVisualRecipes({ sceneId: profile.biome, sceneColor: profile.palette.accent, entropy: hash32(`${run.seed}:${layer}:mob-visuals`) });
  arena = createArenaLayout(run, profile, canvas.width, canvas.height);
  // The review slice is additive: it reads the seeded arena connections after
  // the normal layout is built and never changes the player or camera state.
  wallDoorStructureReviewState = wallDoorStructureReviewEnabled
    ? buildWallDoorStructureReview({ arenaLayout: arena, mapSeed: run.mapSeed, layerNumber: layer, biome: profile.biome })
    : null;
  worldFeatureRenderReviewState = worldFeatureRenderReviewEnabled
    ? buildWorldFeatureRenderReview({ arenaLayout: arena, mapSeed: run.mapSeed, layerNumber: layer, biome: profile.biome })
    : null;
  biomeStructuralVariantReviewState = biomeStructuralVariantReviewEnabled
    ? buildBiomeStructuralVariantReview({ mapSeed: run.mapSeed, characterSeed: run.characterSeed })
    : null;
  enemies = [];
  defeatedEnemies = [];
  projectiles = [];
  effects = [];
  pickups = [];
  spawnQueue = [];
  layerClearedAt = 0;
  layerStartedAt = elapsed;
  activeRoomIndex = 0;
  exitActive = false;
  exitActiveAt = 0;
  layerDecisionApplied = false;
  arena.exit.locked = true;
  for (const room of arena.rooms) room.status = room.locked ? "locked" : "waiting";
  relay = null;
  challengeTimer = 0;
  player.x = arena.spawn.x;
  player.y = arena.spawn.y;
  if (launchParams.get("reviewDoor") === "1" && arena.connections[0]?.door) {
    const reviewDoor = arena.connections[0].door;
    player.x = (reviewDoor.column + 0.5) * arena.tileWidth;
    player.y = (reviewDoor.row + 0.5) * arena.tileHeight;
  }
  const reviewFeature = launchParams.get("reviewFeature");
  if (reviewFeature) {
    const reviewIndex = arena.tiles.findIndex((tile) => tile.features?.includes(reviewFeature));
    if (reviewIndex >= 0) {
      player.x = (reviewIndex % arena.columns + 0.5) * arena.tileWidth;
      player.y = (Math.floor(reviewIndex / arena.columns) + 0.5) * arena.tileHeight;
      document.documentElement.dataset.vaultReviewFeature = reviewFeature;
    }
  }
  camera.x = clamp(player.x - canvas.width / 2, 0, Math.max(0, arena.worldWidth - canvas.width));
  camera.y = clamp(player.y - canvas.height / 2, 0, Math.max(0, arena.worldHeight - canvas.height));
  const authoredSurfaceCamera = authoredSurfaceRuntime ? launchParams.get("surfaceCamera")?.split(",").map(Number) : null;
  if (authoredSurfaceCamera?.length === 2 && authoredSurfaceCamera.every(Number.isFinite)) {
    camera.x = clamp(authoredSurfaceCamera[0], 0, Math.max(0, arena.worldWidth - canvas.width));
    camera.y = clamp(authoredSurfaceCamera[1], 0, Math.max(0, arena.worldHeight - canvas.height));
    player.x = camera.x + canvas.width / 2;
    player.y = camera.y + canvas.height / 2;
  }
  if (authoredSurfaceRuntime) {
    const baselineRenderDescriptor = authoredSurfaceModule.buildBaselineRenderDescriptor({
      arena,
      mapSeed: run.mapSeed,
      layer,
      biome: profile.biome,
      palette: profile.palette.id,
    });
    authoredSurfaceRuntime.prepareLayer({
      arena,
      mapSeed: run.mapSeed,
      layer,
      biome: profile.biome,
      palette: profile.palette,
      baselineRenderHash: deterministicFingerprint(baselineRenderDescriptor),
      gameStateHash: () => deterministicFingerprint({
        mapSeed: run.mapSeed,
        characterSeed: run.characterSeed,
        layer,
        score,
        player: {
          x: Math.round(player.x * 100) / 100,
          y: Math.round(player.y * 100) / 100,
          health: player.health,
          maxHealth: player.maxHealth,
          activeWeaponIndex: player.activeWeaponIndex,
          runAttributes: player.runAttributes,
        },
        rooms: arena.rooms.map((room) => ({ id: room.id, status: room.status, locked: room.locked })),
        connections: arena.connections.map((connection) => ({ id: connection.id, locked: connection.locked })),
        enemies: enemies.map((enemy) => ({ id: enemy.id, x: Math.round(enemy.x), y: Math.round(enemy.y), health: enemy.health })),
        projectiles: projectiles.map((projectile) => ({ id: projectile.id, x: Math.round(projectile.x), y: Math.round(projectile.y) })),
        pickups: pickups.map((pickup) => ({ id: pickup.id, x: Math.round(pickup.x), y: Math.round(pickup.y) })),
      }),
    });
  }
  if (artReviewMode) globalThis.__vaultSurfaceAudit = () => ({
    schema: "vault-rendered-surface-audit@1",
    mapSeed: run.mapSeed,
    layer,
    biome: profile.biome,
    palette: profile.palette.id,
    tileWidth: arena.tileWidth,
    tileHeight: arena.tileHeight,
    columns: arena.columns,
    rows: arena.rows,
    camera: { x: Math.round(camera.x), y: Math.round(camera.y) },
    tiles: arena.tiles.map((tile, index) => ({
      column: index % arena.columns,
      row: Math.floor(index / arena.columns),
      kind: tile.kind,
      terrain: tile.terrain,
      roomId: tile.roomId ?? null,
      floorPattern: tile.floorPattern ?? null,
      elevation: tile.elevation ?? 0,
      features: tile.features ?? [],
    })),
    rooms: arena.rooms.map((room) => ({ id: room.id, x: room.x, y: room.y, width: room.width, height: room.height, floorPattern: room.floorPattern })),
  });
  updateLayerUi();
  activateRoom(0);
  pausedForShop = false;
  announce(profile.bossLayer ? `BOSS LAYER · ${profile.boss.name}` : `LAYER ${layer} · ${profile.tilesetName}`);
}

function activateRoom(index) {
  const room = arena.rooms[index];
  if (!room || room.status === "active" || room.status === "complete") return;
  activeRoomIndex = index;
  room.locked = false;
  room.status = "active";
  room.discovered = true;
  roomHoldoutEndsAt = elapsed + room.holdoutSeconds * 1000;
  const authoredRelay = arena.objects.find((object) => object.roomId === room.id && object.type === "relay");
  if (authoredRelay) authoredRelay.state = "active";
  relay = room.mission === "defend-relay" ? { x: (room.column + 0.5) * arena.tileWidth, y: (room.row + 0.5) * arena.tileHeight, radius: 22, health: 100, maxHealth: 100 } : null;
  const rng = makeRng(`${run.seed}:spawns:${layer}:${room.id}`);
  const offset = elapsed - layerStartedAt;
  if (room.final && profile.bossLayer) spawnQueue.push({ at: offset + 600, boss: true, spec: profile.boss, socket: room.spawnSockets[0], roomIndex: index });
  for (let enemyIndex = 0; enemyIndex < room.enemyBudget; enemyIndex += 1) {
    const elite = room.miniBoss ? enemyIndex === 0 : room.mission === "hunt-elite" && enemyIndex % 3 === 0;
    const tier = room.miniBoss && enemyIndex === 0 ? "miniboss" : elite ? "elite" : enemyIndex % 4 === 0 ? "heavy" : enemyIndex % 3 === 0 ? "light" : "standard";
    spawnQueue.push({ at: offset + 350 + enemyIndex * 420, type: pick(profile.mobPool, rng), socket: room.spawnSockets[enemyIndex % room.spawnSockets.length], roomIndex: index, elite, tier });
  }
  document.querySelector("#objective-title").textContent = roomMissionLabel(room);
  document.querySelector("#objective-detail").textContent = `${room.storyBeat.replaceAll("-", " ")} · ${room.enemyBudget + (room.final && profile.bossLayer ? 1 : 0)} threats`;
  announce(`${room.role.toUpperCase()} · ${roomMissionLabel(room)}`);
}

function roomMissionLabel(room) {
  return ({ breach: "Breach the entry", purge: "Purge the room", "defend-relay": "Defend the relay", "recover-cache": "Recover the sealed cache", "hunt-elite": room.miniBoss ? "Destroy the miniboss" : "Hunt the marked elite", "disable-lasers": "Disable the laser grid", "signal-puzzle": "Align the three signal nodes", survive: "Survive the lockdown", "final-holdout": profile?.bossLayer ? `Hold out · ${profile.boss.name}` : "Final holdout" })[room.mission] ?? room.mission;
}

function updateRunUi() {
  const materialBuild = weaponBuildFor(run.weapon);
  document.querySelector("#affinity").textContent = `${run.character.affinity} affinity`;
  document.querySelector("#character-fingerprint").textContent = stakedCharacterId
    ? `Sepolia mint #${stakedCharacterId} · ${deterministicFingerprint(run.character)}`
    : `build ${deterministicFingerprint(run.character)}`;
  document.querySelector("#weapon-name").textContent = run.weapon.name;
  document.querySelector("#weapon-rarity").textContent = run.weapon.rarity;
  document.querySelector("#weapon-preview").src = materializedWeapon(run.weapon).toDataURL("image/png");
  const materialChips = document.querySelector("#weapon-materials");
  materialChips.replaceChildren(...Object.entries(materialBuild.attributes).map(([name, value]) => {
    const chip = document.createElement("span");
    chip.className = "material-chip";
    const label = document.createElement("b");
    label.textContent = `${name.replaceAll("-", " ")}: `;
    chip.append(label, document.createTextNode(value.replaceAll("-", " ")));
    return chip;
  }));
  document.querySelector("#power-stat").textContent = run.weapon.power.toFixed(2);
  document.querySelector("#speed-stat").textContent = run.weapon.speed.toFixed(2);
  document.querySelector("#weapon-crit-stat").textContent = `${Math.round(run.weapon.critical * 100)}%`;
  document.querySelector("#weapon-fingerprint").textContent = `${run.weapon.fingerprint} · seeded material build`;
  document.querySelector("#graph-ledger").textContent = [
    `map seed ${run.mapSeedDigest}`,
    `character seed ${run.characterSeedDigest}`,
    `atlas vault-game-atlas@2`,
    `character ${run.character.id}`,
    `weapon ${run.weapon.id}:${run.weapon.fingerprint}`,
    `weapon materials ${weaponMaterialLedger(materialBuild)}`,
    `weapon core link ${run.character.appearance.coreLight}`,
    `tiles ${run.atlasClamp.tilesets.join(", ")}`,
    `mobs ${run.atlasClamp.mobs.join(", ")}`,
    `bosses ${run.atlasClamp.bosses.join(", ")}`,
    `shop every ${run.shopInterval} layers`,
    ...(arcadeRegistry ? [`Arcade ${arcadeRegistry}`, `Stake ${stakeTransaction}`] : []),
  ].join("\n");
  document.documentElement.dataset.vaultWeaponMaterials = weaponMaterialLedger(materialBuild);
  document.documentElement.dataset.vaultWeaponCoreLink = run.character.appearance.coreLight;
  document.documentElement.dataset.vaultWeaponParticleStyle = materialBuild.attributes["core-particles"] ?? "none";
  updatePlayerUi();
}

function switchWeapon(index) {
  if (!started || !run.weapons[index] || index === player.activeWeaponIndex) return;
  player.activeWeaponIndex = index;
  run.activeWeaponIndex = index;
  run.weapon = run.weapons[index];
  player.critical = player.baseCritical + run.weapon.critical;
  player.longReadyAt = elapsed + 180;
  player.closeReadyAt = elapsed + 180;
  player.chargeStartedAt = null;
  player.shootHeldAt = null;
  player.backpack.forEach((item) => { if (item.kind === "weapon") item.equipped = item.weaponIndex === index; });
  updateRunUi();
  announce(`Equipped ${run.weapon.name}`);
}

function updatePlayerUi() {
  const healthAmount = clamp(player.health / player.maxHealth, 0, 1);
  document.querySelector("#health-value").textContent = `${Math.ceil(player.health)} / ${Math.ceil(player.maxHealth)}`;
  document.querySelector("#health-bar").style.width = `${healthAmount * 100}%`;
  document.querySelector("#level-value").textContent = player.level;
  document.querySelector("#xp-value").textContent = `${player.experience} XP`;
  document.querySelector("#xp-bar").style.width = `${clamp(player.experience / player.nextLevelExperience, 0, 1) * 100}%`;
  document.querySelector("#move-stat").textContent = Math.round(player.moveSpeed);
  document.querySelector("#guard-stat").textContent = `${Math.round(player.defense * 100)}%`;
  document.querySelector("#crit-stat").textContent = `${Math.round(player.critical * 100)}%`;
  document.querySelector("#pickup-stat").textContent = Math.round(player.pickupRadius);
  document.querySelector("#score-value").textContent = score.toLocaleString();
  updateAbilityUi();
  const backpack = document.querySelector("#backpack");
  backpack.replaceChildren();
  for (let index = 0; index < player.backpackSlots; index += 1) {
    const item = player.backpack[index];
    const element = document.createElement("div");
    element.className = `slot${item ? " filled" : ""}`;
    element.textContent = item ? `${item.equipped ? "● " : ""}${item.name.split(" ")[0]}` : "+";
    element.title = item ? `${item.equipped ? "Equipped" : "Held"} · ${item.rarity ?? item.kind} ${item.name}` : "Open backpack slot";
    backpack.append(element);
  }
}

function updateAbilityUi() {
  const energy = document.querySelector("#energy-status");
  const charge = document.querySelector("#charge-status");
  const cooldownAttack = document.querySelector("#cooldown-attack-status");
  const chargedFor = player.chargeStartedAt === null ? 0 : elapsed - player.chargeStartedAt;
  const chargeAmount = clamp(chargedFor / run.weapon.chargeAttack.maximumChargeMs, 0, 1);
  charge.classList.toggle("charging", player.chargeStartedAt !== null);
  charge.classList.toggle("ready", player.chargeStartedAt === null && elapsed >= player.chargeReadyAt && elapsed >= player.energyLockUntil && !player.energyNeedsRelease && player.energy >= VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy);
  energy.classList.toggle("ready", elapsed >= player.energyLockUntil && !player.energyNeedsRelease);
  energy.classList.toggle("charging", player.boosting || elapsed < player.shieldUntil);
  energy.querySelector("b").textContent = elapsed < player.energyLockUntil ? "Energy busted" : player.energyNeedsRelease ? "Release boost / block" : "Shift boost · RMB block";
  energy.querySelector("span").textContent = `${Math.ceil(player.energy)} / ${player.maxEnergy}`;
  charge.querySelector("b").textContent = `Hold LMB · ${run.weapon.chargeAttack.mode}`;
  charge.querySelector("span").textContent = player.chargeStartedAt !== null
    ? `${Math.round(chargeAmount * 100)}% charged`
    : cooldownText(player.chargeReadyAt);
  cooldownAttack.classList.toggle("ready", elapsed >= player.cooldownAttackReadyAt);
  cooldownAttack.querySelector("b").textContent = `Q · ${run.character.abilities.cooldownAttack.name}`;
  cooldownAttack.querySelector("span").textContent = cooldownText(player.cooldownAttackReadyAt);
}

function cooldownText(readyAt) {
  return elapsed >= readyAt ? "Ready" : `${((readyAt - elapsed) / 1000).toFixed(1)}s`;
}

function updateLayerUi() {
  document.querySelector("#layer-value").textContent = profile.layer;
  document.querySelector("#tileset-value").textContent = `${profile.tilesetName} / ${profile.paletteId} / ${arena.rooms.length} rooms`;
  document.querySelector("#objective-title").textContent = profile.bossLayer ? `Defeat ${profile.boss.name}` : objectiveLabel(profile.challenge);
  document.querySelector("#objective-detail").textContent = profile.bossLayer ? `${profile.boss.parts.length} targetable parts · ${profile.boss.moves.join(" + ")}` : `${profile.mobCount} seeded hostiles · boss at layer ${Math.ceil(layer / run.shopInterval) * run.shopInterval}`;
  document.querySelector("#layer-ledger").textContent = [
    `story ${profile.story.title} · ${profile.story.premise}`,
    `wave ${profile.waveSeed}`,
    `biome ${profile.biome}`,
    `rooms ${arena.rooms.map((room) => `${room.role}:${room.design}`).join(" → ")}`,
    `graph ${arena.connections.map((edge) => `${edge.from}>${edge.to}`).join(", ")}`,
    `tiles ${profile.floor} / ${profile.wall}`,
    `objects ${profile.objectPool.join(", ")}`,
    `fx ${profile.effects.join(", ")}`,
    `mobs ${profile.mobPool.join(", ")}`,
    `challenge ${profile.challenge}`,
    profile.boss ? `boss ${profile.boss.id} [${profile.boss.parts.join(", ")}]` : `boss none`,
  ].join("\n");
}

function objectiveLabel(challenge) {
  return ({ boss: "Defeat the boss", clear: "Clear the layer", survive: "Survive the signal storm", "shatter-elites": "Shatter the marked elites", "protect-relay": "Keep the center relay online" })[challenge] ?? "Clear the layer";
}

function spawnEnemy(entry) {
  if (entry.boss) return spawnBoss(entry);
  const spec = atlas.mobs.find((mob) => mob.id === entry.type);
  const rng = makeRng(`${run.seed}:enemy:${layer}:${nextEntityId}`);
  const position = entry.socket ?? roomEdgePosition(entry.roomIndex, entry.angle ?? 0, 0.62);
  const health = Math.round(lerp(...spec.health, rng()) * (1 + layer * 0.075));
  const elite = Boolean(entry.elite) || (profile.challenge === "shatter-elites" && rng() > 0.78);
  const visualVariant = hash32(`${run.seed}:${layer}:${nextEntityId}:visual`) % 50;
  const visualRecipe = sharedMobVisualRecipes[visualVariant];
  const partColors = seededPartColors(spec.parts, rng, visualRecipe);
  const sharedAbilities = selectVaultMobAbilities({ elite, variant: visualVariant, spawnCount: nextEntityId, roll: hash32(`${run.seed}:${layer}:${nextEntityId}:ability`) / 0x100000000 });
  enemies.push({
    id: nextEntityId++,
    type: spec.id,
    name: spec.name,
    behavior: spec.behavior,
    attacks: spec.attacks,
    shape: spec.shape,
    x: position.x,
    y: position.y,
    radius: entry.tier === "miniboss" ? 34 : entry.tier === "heavy" ? 21 : elite ? 19 : entry.tier === "light" ? 12 : 15,
    health: entry.tier === "miniboss" ? Math.round(health * 4.2) : entry.tier === "heavy" ? Math.round(health * 1.65) : elite ? Math.round(health * 2.1) : entry.tier === "light" ? Math.round(health * 0.72) : health,
    maxHealth: entry.tier === "miniboss" ? Math.round(health * 4.2) : entry.tier === "heavy" ? Math.round(health * 1.65) : elite ? Math.round(health * 2.1) : entry.tier === "light" ? Math.round(health * 0.72) : health,
    speed: lerp(...spec.speed, rng()) * (1 + Math.min(0.5, layer * 0.018)),
    damage: Math.round(lerp(...spec.damage, rng()) * (1 + layer * 0.04)),
    elite,
    visualVariant,
    visualRecipe,
    sharedAbilities,
    sharedAbilityIndex: 0,
    tier: entry.tier ?? (elite ? "elite" : "standard"),
    partColors,
    facing: facingFromVector(normalized(player.x - position.x, player.y - position.y)),
    nextActionAt: elapsed + 700 + rng() * 1200,
    nextSharedAbilityAt: elapsed + 1700 + rng() * 1200,
    spawnedAt: elapsed,
    phase: rng() * Math.PI * 2,
    xp: elite ? 14 : 6,
  });
}

function spawnBoss(entry) {
  const rng = makeRng(`${run.seed}:boss:${layer}`);
  const position = entry.socket ?? roomEdgePosition(entry.roomIndex, entry.angle ?? 0, 0.42);
  const health = Math.round(520 * (1 + layer * 0.22));
  const boss = {
    id: nextEntityId++,
    type: entry.spec.id,
    name: entry.spec.name,
    behavior: "boss",
    shape: entry.spec.shape,
    x: position.x,
    y: position.y,
    radius: 52,
    health,
    maxHealth: health,
    speed: 38 + layer * 1.2,
    damage: 16 + layer * 2,
    boss: true,
    moves: entry.spec.moves,
    parts: entry.spec.parts.map((name, index) => ({ name, health: Math.round(health * (index ? 0.17 : 0.3)), alive: true, angle: (index / entry.spec.parts.length) * Math.PI * 2, color: index ? profile.palette.hostile : profile.palette.accent })),
    nextActionAt: elapsed + 1400,
    phase: rng() * Math.PI * 2,
    xp: 90 + layer * 4,
  };
  enemies.push(boss);
}

function seededPartColors(parts, rng, visualRecipe = null) {
  const anchors = [profile.palette.accent, profile.palette.ambient, profile.palette.hostile, profile.palette.line];
  return Object.fromEntries(parts.map((part, index) => {
    if (visualRecipe) {
      if (part.includes("core")) return [part, visualRecipe.core];
      if (["visor", "projectile", "trail", "lance"].some((name) => part.includes(name))) return [part, visualRecipe.trim];
      return [part, index % 2 ? visualRecipe.bodySecondary : visualRecipe.bodyPrimary];
    }
    const primary = colorChannels(anchors[index % anchors.length]);
    const secondary = colorChannels(anchors[(index + 1 + Math.floor(rng() * (anchors.length - 1))) % anchors.length]);
    const blend = 0.12 + rng() * 0.34;
    const luminance = 0.76 + rng() * 0.42;
    return [part, channelsHex(mixChannels(primary, secondary, blend).map((channel) => channel * luminance))];
  }));
}

function roomEdgePosition(roomIndex, angle, radiusFactor) {
  const room = arena.rooms[roomIndex] ?? arena.rooms[activeRoomIndex] ?? arena.rooms[0];
  const radiusX = Math.max(24, room.halfWidth * arena.tileWidth * radiusFactor);
  const radiusY = Math.max(24, room.halfHeight * arena.tileHeight * radiusFactor);
  return {
    x: (room.column + 0.5) * arena.tileWidth + Math.cos(angle) * radiusX,
    y: (room.row + 0.5) * arena.tileHeight + Math.sin(angle) * radiusY,
  };
}

function update(delta) {
  if (!started || pausedForShop) return;
  elapsed += delta;
  const seconds = delta / 1000;
  updateInput(seconds);
  updateSpawns();
  updateEnemies(seconds);
  updateProjectiles(seconds);
  updateEffects(seconds);
  updatePickups(seconds);
  updatePuzzleInteraction();
  if (challengeTimer > 0) challengeTimer = Math.max(0, challengeTimer - seconds);
  updateRoomEntry();
  updateLayerProgress();
  document.querySelector("#hostiles-value").textContent = enemies.length + spawnQueue.length;
  updatePlayerUi();
}

function updateInput(seconds) {
  previousGamepadInput = gamepadInput;
  gamepadInput = readVaultGamepad(navigator.getGamepads?.() ?? []);
  document.documentElement.dataset.vaultController = gamepadInput.connected ? "connected" : "disconnected";
  document.documentElement.dataset.vaultControllerId = gamepadInput.id;
  if (gamepadInput.fire && !previousGamepadInput.fire) beginShootHold();
  if (!gamepadInput.fire && previousGamepadInput.fire) releaseShootHold();
  if (gamepadInput.escape && !previousGamepadInput.escape) blink();
  if (gamepadInput.pulse && !previousGamepadInput.pulse) cooldownAttack();
  let dx = 0, dy = 0;
  if (heldInputActions.has("moveLeft") || keys.has("ArrowLeft")) dx -= 1;
  if (heldInputActions.has("moveRight") || keys.has("ArrowRight")) dx += 1;
  if (heldInputActions.has("moveUp") || keys.has("ArrowUp")) dy -= 1;
  if (heldInputActions.has("moveDown") || keys.has("ArrowDown")) dy += 1;
  dx += touchInput.moveX + gamepadInput.moveX;
  dy += touchInput.moveY + gamepadInput.moveY;
  const movement = normalized(dx, dy);
  const wantsBlock = pointer.alternate || touchInput.block || heldInputActions.has("block") || gamepadInput.block;
  const wantsBoost = heldInputActions.has("boost") || gamepadInput.boost || Math.hypot(touchInput.moveX, touchInput.moveY) > .88;
  if (player.energyNeedsRelease && !wantsBlock && !wantsBoost) player.energyNeedsRelease = false;
  const energyReady = elapsed >= player.energyLockUntil && !player.energyNeedsRelease && player.energy > 0;
  const blocking = wantsBlock && energyReady, boosting = wantsBoost && !blocking && energyReady;
  if (blocking) { player.energy = Math.max(0, player.energy - VAULT_PLAYER_COMBAT_RULES.block.energyPerSecond * seconds); player.shieldUntil = elapsed + 90; }
  else if (boosting) player.energy = Math.max(0, player.energy - VAULT_PLAYER_COMBAT_RULES.boost.energyPerSecond * seconds);
  else if (elapsed >= player.energyLockUntil) player.energy = Math.min(player.maxEnergy, player.energy + VAULT_PLAYER_COMBAT_RULES.energy.recoveryPerSecond * seconds);
  if ((blocking || boosting) && player.energy <= 0) {
    player.energy = 0; player.energyLockUntil = elapsed + VAULT_PLAYER_COMBAT_RULES.energy.bustLockoutMs; player.energyNeedsRelease = true; player.shieldUntil = 0; pointer.alternate = false; touchInput.block = false;
    effects.push({ type: "energy-bust", x: player.x, y: player.y, radius: 18, maximumRadius: 72, born: elapsed, duration: 520, color: profile.palette.accent }); announce("Energy busted · one second lockout", 950);
  }
  player.boosting = boosting;
  document.documentElement.dataset.vaultEnergyState = elapsed < player.energyLockUntil ? "busted" : player.energyNeedsRelease ? "release-required" : blocking ? "blocking" : boosting ? "boosting" : "ready";
  document.documentElement.dataset.vaultControlContract = "lmb-tap-fire/lmb-hold-charge/rmb-hold-block/space-escape/q-core-flare/shift-boost";
  const terrainTile = arena.tiles[Math.floor(player.y / arena.tileHeight) * arena.columns + Math.floor(player.x / arena.tileWidth)];
  if (dx || dy) {
    const terrainMultiplier = terrainTile?.terrain === "water" ? 0.72 : terrainTile?.terrain === "mist" ? 0.86 : terrainTile?.terrain === "lava" ? 0.82 : terrainTile?.terrain === "void" ? 0.9 : 1;
    const bridgeMultiplier = terrainTile?.features?.includes("bridge") ? 1.12 : 1;
    const multiplier = (blocking ? 0.8 : boosting ? VAULT_PLAYER_COMBAT_RULES.boost.speedScale : 1) * terrainMultiplier * bridgeMultiplier;
    movePlayer(movement.x * player.moveSpeed * multiplier * seconds, movement.y * player.moveSpeed * multiplier * seconds);
  }
  const velocityBlend = dx || dy ? .52 : .16;
  const intendedSpeed = player.moveSpeed * (blocking ? .8 : boosting ? VAULT_PLAYER_COMBAT_RULES.boost.speedScale : 1);
  player.velocityX += (movement.x * intendedSpeed - player.velocityX) * velocityBlend;
  player.velocityY += (movement.y * intendedSpeed - player.velocityY) * velocityBlend;
  player.x = clamp(player.x, 34, arena.worldWidth - 34);
  player.y = clamp(player.y, 42, arena.worldHeight - 32);
  for (const object of arena.objects) {
    const overlap = object.radius + player.radius - distance(player, object);
    if (overlap > 0) {
      const away = normalized(player.x - object.x, player.y - object.y);
      player.x += away.x * overlap;
      player.y += away.y * overlap;
    }
  }
  const activeTerrain = arena.tiles[Math.floor(player.y / arena.tileHeight) * arena.columns + Math.floor(player.x / arena.tileWidth)];
  const dynamicBridgeDown = activeTerrain?.features?.includes("dynamic-bridge") && !dynamicBridgePowered(activeTerrain);
  if ((activeTerrain?.hazard || dynamicBridgeDown) && elapsed >= player.terrainTouchReadyAt && elapsed >= player.invulnerableUntil) {
    const damage = dynamicBridgeDown ? 4 : activeTerrain.hazard === "lava" ? 7 : 5;
    player.health -= Math.max(1, damage * (1 - player.defense));
    player.invulnerableUntil = elapsed + 420;
    player.terrainTouchReadyAt = elapsed + 520;
    player.flashUntil = elapsed + 120;
    effects.push({ type: "danger-pool", x: player.x, y: player.y, radius: 8, maximumRadius: 34, born: elapsed, duration: 420, hostile: false, color: profile.palette.hostile });
    if (player.health <= 0) endRun();
  }
  if (Math.hypot(gamepadInput.aimX, gamepadInput.aimY) > .2) {
    pointer.x = player.x - camera.x + gamepadInput.aimX * Math.min(canvas.width, canvas.height) * 0.34;
    pointer.y = player.y - camera.y + gamepadInput.aimY * Math.min(canvas.width, canvas.height) * 0.34;
  } else if (touchInput.aimActive) {
    pointer.x = player.x - camera.x + touchInput.aimX * Math.min(canvas.width, canvas.height) * 0.34;
    pointer.y = player.y - camera.y + touchInput.aimY * Math.min(canvas.width, canvas.height) * 0.34;
  }
  player.aim = normalized(pointer.x + camera.x - player.x, pointer.y + camera.y - player.y);
  player.facing = facingFromVector(player.aim);
  if (player.shootHeldAt !== null && player.chargeStartedAt === null && elapsed - player.shootHeldAt >= VAULT_PLAYER_COMBAT_RULES.charge.holdMs) beginCharge();
  const targetCameraX = clamp(player.x - canvas.width / 2, 0, Math.max(0, arena.worldWidth - canvas.width));
  const targetCameraY = clamp(player.y - canvas.height / 2, 0, Math.max(0, arena.worldHeight - canvas.height));
  camera.x = lerp(camera.x, targetCameraX, 0.13);
  camera.y = lerp(camera.y, targetCameraY, 0.13);
}

function movePlayer(dx, dy) {
  const nextX = clamp(player.x + dx, 24, arena.worldWidth - 24);
  const nextY = clamp(player.y + dy, 24, arena.worldHeight - 24);
  if (canTraverseStep(player.x, player.y, nextX, player.y, player.radius * 0.62)) player.x = nextX;
  if (canTraverseStep(player.x, player.y, player.x, nextY, player.radius * 0.62)) player.y = nextY;
}

function tileAtWorld(x, y) {
  const column = Math.floor(x / arena.tileWidth);
  const row = Math.floor(y / arena.tileHeight);
  return column < 0 || row < 0 || column >= arena.columns || row >= arena.rows ? null : arena.tiles[row * arena.columns + column];
}

function doorApertureIsPassable(connection) {
  if (!connection || connection.locked) return false;
  const progress = clamp((elapsed - (connection.openedAt ?? elapsed)) / 680, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  const span = connection.door.span ?? connection.door.tiles.length;
  return (span * arena.tileWidth - 10) * eased >= player.radius * 2 * 0.62 + 8;
}

function canTraverseStep(fromX, fromY, toX, toY, radius) {
  if (!isArenaWalkable(toX, toY, radius)) return false;
  const from = tileAtWorld(fromX, fromY);
  const to = tileAtWorld(toX, toY);
  if (!from || !to) return false;
  const elevationDelta = Math.abs((to.elevation ?? 0) - (from.elevation ?? 0));
  if (elevationDelta > 0) {
    const stepHorizontal = Math.floor(fromY / arena.tileHeight) === Math.floor(toY / arena.tileHeight);
    const expectedAxis = stepHorizontal ? "horizontal" : "vertical";
    const rampAxis = (tile) => ["east", "west"].includes(tile.rampDirection) ? "horizontal" : ["north", "south"].includes(tile.rampDirection) ? "vertical" : null;
    const alignedRamp = from.features?.includes("ramp")
      && to.features?.includes("ramp")
      && rampAxis(from) === expectedAxis
      && rampAxis(to) === expectedAxis;
    if (!alignedRamp) return false;
  }
  return true;
}

function isArenaWalkable(x, y, radius = 0) {
  return [[0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius]].every(([offsetX, offsetY]) => {
    const column = Math.floor((x + offsetX) / arena.tileWidth);
    const row = Math.floor((y + offsetY) / arena.tileHeight);
    if (column < 0 || row < 0 || column >= arena.columns || row >= arena.rows) return false;
    const tile = arena.tiles[row * arena.columns + column];
    if (tile.kind === "wall") return false;
    if (tile.traversable === false) return false;
    if (["water", "lava", "void"].includes(tile.terrain) && !tile.features?.includes("bridge")) return false;
    if (tile.features?.includes("dynamic-bridge") && !dynamicBridgePowered(tile)) return false;
    if (tile.kind === "door") {
      const connection = arena.connections.find((candidate) => candidate.id === tile.doorId);
      if (!doorApertureIsPassable(connection)) return false;
    }
    const room = tile.roomId ? arena.rooms.find((candidate) => candidate.id === tile.roomId) : null;
    return !room?.locked;
  });
}

function dynamicBridgePowered(tile) {
  if (!tile?.features?.includes("dynamic-bridge")) return true;
  const phase = hash32(`${run.seed}:${layer}:${tile.bridgeId}:phase`) % 4;
  return (Math.floor(elapsed / 900) + phase) % 4 !== 0;
}

function roomAt(x, y) {
  const column = Math.floor(x / arena.tileWidth);
  const row = Math.floor(y / arena.tileHeight);
  if (column < 0 || row < 0 || column >= arena.columns || row >= arena.rows) return null;
  const roomId = arena.tiles[row * arena.columns + column].roomId;
  return roomId ? arena.rooms.find((room) => room.id === roomId) ?? null : null;
}

function updateRoomEntry() {
  const room = roomAt(player.x, player.y);
  if (room?.status === "waiting") activateRoom(arena.rooms.indexOf(room));
  if (exitActive && elapsed >= exitActiveAt && distance(player, arena.exit) <= 34) loadLayer(layer + 1);
}

function updatePuzzleInteraction() {
  const room = arena.rooms[activeRoomIndex];
  if (!room || room.mission !== "signal-puzzle" || room.puzzleComplete || elapsed < puzzleTouchReadyAt) return;
  const nodes = arena.objects.filter((object) => object.roomId === room.id && object.type === "puzzle-node");
  const touched = nodes.find((node) => node.state !== "complete" && distance(player, node) <= player.radius + node.radius + 5);
  if (!touched) return;
  puzzleTouchReadyAt = elapsed + 550;
  room.puzzleProgress ??= 0;
  const expected = room.puzzleSequence[room.puzzleProgress];
  if (touched.puzzleIndex !== expected) {
    room.puzzleProgress = 0;
    for (const node of nodes) node.state = "dormant";
    effects.push({ type: "danger-pool", x: touched.x, y: touched.y, radius: 8, maximumRadius: 44, born: elapsed, duration: 650, hostile: false, color: profile.palette.hostile });
    announce("Signal sequence reset", 900);
    return;
  }
  touched.state = "complete";
  room.puzzleProgress += 1;
  effects.push({ type: "close", x: touched.x, y: touched.y, radius: 18, maximumRadius: 54, born: elapsed, duration: 500, color: profile.palette.accent });
  if (room.puzzleProgress === room.puzzleSequence.length) {
    room.puzzleComplete = true;
    score += 180;
    announce("SIGNAL ALIGNED · chamber unlocked", 1800);
  } else announce(`Signal ${room.puzzleProgress}/${room.puzzleSequence.length}`, 800);
}

function facingFromVector(vector) {
  const angle = Math.atan2(vector.y, vector.x);
  const index = Math.round(((angle - Math.PI / 2) / (Math.PI * 2)) * 8 + 8) % 8;
  return directionOrder[index];
}

function updateSpawns() {
  while (spawnQueue.length && spawnQueue[0].at <= elapsed - layerStartedAt) spawnEnemy(spawnQueue.shift());
}

function updateEnemies(seconds) {
  for (const enemy of [...enemies]) {
    const target = relay && enemy.id % 3 === 0 ? relay : player;
    const toward = normalized(target.x - enemy.x, target.y - enemy.y);
    updateSharedMobAbility(enemy, toward, distance(enemy, player));
    if (enemy.boss) updateBoss(enemy, toward, seconds);
    else if (enemy.behavior === "shooter") updateShooter(enemy, toward, seconds);
    else if (enemy.behavior === "dash") updateDasher(enemy, toward, seconds);
    else updateCloseEnemy(enemy, toward, seconds);
    if (circleHit(player, enemy) && elapsed > player.invulnerableUntil) hurtPlayer(enemy.damage, enemy);
    if (relay && circleHit(relay, enemy) && elapsed > (enemy.relayHitReadyAt ?? 0)) {
      relay.health = Math.max(0, relay.health - enemy.damage * 0.45);
      enemy.relayHitReadyAt = elapsed + 900;
      if (relay.health <= 0) {
        const room = arena.rooms[activeRoomIndex];
        if (room) {
          room.mission = "purge";
          roomHoldoutEndsAt = elapsed;
        }
        announce("Relay lost · purge the room", 2400);
        relay = null;
      }
    }
  }
}

function updateSharedMobAbility(enemy, toward, range) {
  if (enemy.boss || !enemy.sharedAbilities?.length || elapsed < enemy.nextSharedAbilityAt) return;
  const ability = enemy.sharedAbilities[enemy.sharedAbilityIndex++ % enemy.sharedAbilities.length], rule = VAULT_MOB_ABILITY_RULES[ability];
  const damage = enemy.damage * (rule.damageScale ?? 1);
  if (rule.mode === "projectile") {
    const count = rule.count ?? 1;
    for (let index = 0; index < count; index += 1) {
      const base = Math.atan2(toward.y, toward.x), angle = base + (index - (count - 1) / 2) * (rule.spread ?? 0);
      enemyProjectile(enemy, { x: Math.cos(angle), y: Math.sin(angle) }, damage, rule.speed, ability === "exploder" ? 12 : ability === "laser" ? 8 : 5, { kind: ability, homing: rule.homing ?? 0, explosionRadius: rule.explosionRadius ?? 0, color: enemy.visualRecipe?.core });
    }
  } else if (ability === "aoe") {
    effects.push({ type: "hostile-aoe", hostile: true, triggered: false, x: enemy.x, y: enemy.y, radius: 16, maximumRadius: rule.radius, damage, born: elapsed, duration: 720, color: enemy.visualRecipe?.core ?? profile.palette.hostile });
  } else if (ability === "blink") {
    const side = enemy.id % 2 ? 1 : -1, fromX = enemy.x, fromY = enemy.y; moveEnemy(enemy, -toward.y * side * rule.distance, toward.x * side * rule.distance);
    effects.push({ type: "blink", x: fromX, y: fromY, toX: enemy.x, toY: enemy.y, born: elapsed, duration: 380, color: enemy.visualRecipe?.core ?? profile.palette.hostile });
  } else if (ability === "rush" && range < 360) { enemy.dash = toward; enemy.dashUntil = elapsed + rule.durationMs; }
  enemy.nextSharedAbilityAt = elapsed + (enemy.elite ? 1350 : 2600) + (enemy.id % 7) * 110;
}

function updateCloseEnemy(enemy, toward, seconds) {
  const range = distance(enemy, player);
  const tank = enemy.behavior === "tank";
  if (elapsed >= enemy.nextActionAt && range < (tank ? 175 : 130)) {
    const attack = enemy.attacks[(enemy.id + Math.floor(elapsed / 1000)) % enemy.attacks.length];
    if (attack.includes("aoe")) {
      enemy.attackStartedAt = elapsed;
      effects.push({ type: "hostile-aoe", hostile: true, triggered: false, x: enemy.x, y: enemy.y, radius: 16, maximumRadius: tank ? 115 : 82, damage: enemy.damage, born: elapsed, duration: 720, color: profile.palette.hostile });
      enemy.nextActionAt = elapsed + (tank ? 1900 : 1450);
    } else if (attack === "charge") {
      enemy.dash = toward; enemy.dashUntil = elapsed + 430; enemy.nextActionAt = elapsed + 1750;
    }
  }
  const direction = elapsed < (enemy.dashUntil ?? 0) ? enemy.dash : toward;
  const speed = enemy.speed * (tank ? 0.82 : 1) * (elapsed < (enemy.dashUntil ?? 0) ? 3.2 : 1);
  moveEnemy(enemy, direction.x * speed * seconds, direction.y * speed * seconds);
}

function updateShooter(enemy, toward, seconds) {
  const range = distance(enemy, player);
  if (range > 250) moveEnemy(enemy, toward.x * enemy.speed * seconds, toward.y * enemy.speed * seconds);
  else if (range < 165) moveEnemy(enemy, -toward.x * enemy.speed * 0.7 * seconds, -toward.y * enemy.speed * 0.7 * seconds);
  moveEnemy(enemy, Math.cos(elapsed * 0.001 + enemy.phase) * 16 * seconds, Math.sin(elapsed * 0.001 + enemy.phase) * 16 * seconds);
  if (elapsed >= enemy.nextActionAt) {
    const attack = enemy.attacks[(enemy.id + Math.floor(elapsed / 1000)) % enemy.attacks.length];
    enemy.attackStartedAt = elapsed;
    enemyProjectile(enemy, toward, attack === "laser" ? enemy.damage * 1.35 : enemy.damage, attack === "laser" ? 430 : 245, attack === "laser" ? 8 : 5);
    if (attack === "laser") effects.push({ type: "laser-line", x: enemy.x, y: enemy.y, toX: player.x, toY: player.y, born: elapsed, duration: 280, color: profile.palette.hostile });
    enemy.nextActionAt = elapsed + 1250 + (enemy.id % 5) * 90;
  }
}

function updateDasher(enemy, toward, seconds) {
  if (elapsed >= enemy.nextActionAt) {
    enemy.dashUntil = elapsed + 320;
    enemy.dash = toward;
    enemy.attackStartedAt = elapsed;
    enemy.nextActionAt = elapsed + 1450 + (enemy.id % 4) * 130;
  }
  const direction = elapsed < (enemy.dashUntil ?? 0) ? enemy.dash : toward;
  const multiplier = elapsed < (enemy.dashUntil ?? 0) ? 3.4 : 0.68;
  moveEnemy(enemy, direction.x * enemy.speed * multiplier * seconds, direction.y * enemy.speed * multiplier * seconds);
}

function updateBoss(enemy, toward, seconds) {
  moveEnemy(enemy, toward.x * enemy.speed * seconds, toward.y * enemy.speed * seconds);
  enemy.phase += seconds * 0.8;
  if (elapsed < enemy.nextActionAt) return;
  const move = enemy.moves[(enemy.id + Math.floor(elapsed / 1000)) % enemy.moves.length];
  if (move === "ring-burst" || move === "needle-rain") {
    const count = move === "needle-rain" ? 14 : 10;
    for (let index = 0; index < count; index += 1) enemyProjectile(enemy, { x: Math.cos(index / count * Math.PI * 2), y: Math.sin(index / count * Math.PI * 2) }, enemy.damage * 0.7, move === "needle-rain" ? 280 : 205);
  } else if (move === "pylon-beam" || move === "thread-lines") {
    for (let index = -1; index <= 1; index += 1) {
      const angle = Math.atan2(toward.y, toward.x) + index * 0.25;
      enemyProjectile(enemy, { x: Math.cos(angle), y: Math.sin(angle) }, enemy.damage, 360, 8);
    }
  } else if (move === "summon-drifters" || move === "echo-clones") {
    for (let index = 0; index < 3; index += 1) spawnEnemy({ type: profile.mobPool[index % profile.mobPool.length], angle: enemy.phase + index * 2.1, roomIndex: activeRoomIndex });
  } else if (move === "charge" || move === "cone-bite") {
    enemy.dashUntil = elapsed + 560;
    enemy.dash = toward;
    enemy.speed *= 1.9;
    setTimeout(() => { if (enemies.includes(enemy)) enemy.speed /= 1.9; }, 580);
  } else {
    effects.push({ type: "danger-pool", x: player.x, y: player.y, radius: 14, maximumRadius: 68, born: elapsed, duration: 1350, hostile: true, damage: enemy.damage });
  }
  enemy.nextActionAt = elapsed + Math.max(900, 2300 - layer * 45);
}

function moveEnemy(enemy, dx, dy) {
  if (Math.abs(dx) + Math.abs(dy) > 0.01) {
    enemy.facing = facingFromVector({ x: dx, y: dy });
    if (elapsed >= (enemy.motionUntil ?? 0)) enemy.motionStartedAt = elapsed;
    enemy.motionUntil = elapsed + 130;
  }
  const nextX = enemy.x + dx;
  const nextY = enemy.y + dy;
  if (isArenaWalkable(nextX, enemy.y, enemy.radius * 0.5)) enemy.x = nextX;
  if (isArenaWalkable(enemy.x, nextY, enemy.radius * 0.5)) enemy.y = nextY;
}

function enemyProjectile(enemy, direction, damage, speed, radius = 5, options = {}) {
  projectiles.push({ id: nextEntityId++, hostile: true, owner: enemy.id, x: enemy.x, y: enemy.y, vx: direction.x * speed, vy: direction.y * speed, speed, radius, damage, ttl: 4, ...options });
}

function longAttack() {
  if (elapsed < player.longReadyAt) return;
  if (run.weapon.id === "gyro" && player.gyroProjectileId !== null) return;
  const sharedAttack = VAULT_WEAPON_COMBAT_RULES[run.weapon.id]?.longRange;
  player.longReadyAt = elapsed + run.weapon.longRange.cooldownMs;
  const critical = combatRng() < player.critical;
  const damage = Math.round(run.weapon.longRange.damage * (critical ? 1.8 : 1));
  const volley = createVaultWeaponProjectileVolley({
    weaponId: run.weapon.id,
    attack: "longRange",
    originX: player.x,
    originY: player.y,
    aimX: player.aim.x,
    aimY: player.aim.y,
    projectileSpeed: run.weapon.longRange.projectileSpeed,
    radius: sharedAttack?.radius,
    damage: Math.round(damage * vaultWeaponProjectileDamageScale(run.weapon.id, "longRange")),
    ttl: run.weapon.id === "gyro" ? 2.1 : 2.2,
    pierce: sharedAttack?.pierce,
    critical,
    now: elapsed,
    nextId: () => nextEntityId++,
  });
  projectiles.push(...volley);
  if (run.weapon.id === "gyro") player.gyroProjectileId = volley[0]?.id ?? null;
  effects.push({ type: "muzzle", x: player.x + player.aim.x * 45, y: player.y + player.aim.y * 45, radius: 10, born: elapsed, duration: 180, color: profile.palette.accent });
}

function closeAttack() {
  if (elapsed < player.closeReadyAt) return;
  player.closeReadyAt = elapsed + run.weapon.closeRange.cooldownMs;
  const radius = run.weapon.closeRange.radius;
  effects.push({ type: "close", x: player.x, y: player.y, radius, born: elapsed, duration: 320, color: profile.palette.accent });
  for (const enemy of [...enemies]) if (distance(player, enemy) <= radius + enemy.radius) damageEnemy(enemy, run.weapon.closeRange.damage, false, { x: enemy.x, y: enemy.y });
  for (const projectile of projectiles) if (projectile.hostile && distance(player, projectile) <= radius) projectile.ttl = 0;
}

function beginShootHold() {
  if (!started || pausedForShop || player.shootHeldAt !== null) return;
  player.shootHeldAt = elapsed;
}

function releaseShootHold() {
  if (!started || pausedForShop || player.shootHeldAt === null) return;
  const wasCharging = player.chargeStartedAt !== null;
  player.shootHeldAt = null;
  if (wasCharging) releaseCharge(); else longAttack();
}

function beginCharge() {
  if (!started || pausedForShop || player.chargeStartedAt !== null || elapsed < player.energyLockUntil || player.energyNeedsRelease || player.energy < VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy || elapsed < player.chargeReadyAt) return;
  if (run.weapon.id === "gyro" && player.gyroProjectileId !== null) return announce("Gyro Saw is returning", 800);
  player.chargeStartedAt = elapsed;
  announce(`${run.weapon.name} charging`, 900);
}

function releaseCharge() {
  if (!started || pausedForShop || player.chargeStartedAt === null) return;
  const chargedFor = elapsed - player.chargeStartedAt;
  const spec = run.weapon.chargeAttack;
  const sharedCharge = VAULT_WEAPON_COMBAT_RULES[run.weapon.id]?.charge;
  const charge = clamp((chargedFor - spec.minimumChargeMs) / (spec.maximumChargeMs - spec.minimumChargeMs), 0, 1);
  const strength = lerp(0.55, 1, charge);
  player.chargeStartedAt = null;
  const energyCost = lerp(VAULT_PLAYER_COMBAT_RULES.charge.minimumEnergy, VAULT_PLAYER_COMBAT_RULES.charge.maximumEnergy, charge);
  if (player.energy < energyCost) return announce("Not enough energy", 700);
  player.energy -= energyCost;
  player.chargeReadyAt = elapsed + spec.cooldownMs;
  const volley = createVaultWeaponProjectileVolley({
    weaponId: run.weapon.id,
    attack: "charge",
    originX: player.x,
    originY: player.y,
    aimX: player.aim.x,
    aimY: player.aim.y,
    projectileSpeed: spec.projectileSpeed,
    radius: Math.round(spec.radius * lerp(0.8, 1.25, charge)),
    damage: Math.max(1, Math.round(spec.damage * strength * vaultWeaponProjectileDamageScale(run.weapon.id, "charge"))),
    ttl: spec.mode === "overdrive-disc" ? 2.8 : 1.8,
    pierce: spec.mode === "overdrive-disc" ? 24 : sharedCharge?.pierce,
    critical: charge >= 0.98,
    charged: true,
    now: elapsed,
    nextId: () => nextEntityId++,
  });
  projectiles.push(...volley);
  if (run.weapon.id === "gyro") player.gyroProjectileId = volley[0]?.id ?? null;
  effects.push({ type: "charged-release", x: player.x, y: player.y, radius: 28, maximumRadius: 110, born: elapsed, duration: 430, color: profile.palette.accent });
  announce(`${spec.mode} · ${Math.round(strength * 100)}%`, 1200);
}

function cooldownAttack() {
  if (!started || pausedForShop || elapsed < player.cooldownAttackReadyAt) return;
  const characterSpec = run.character.abilities.cooldownAttack;
  const sharedSpec = VAULT_PLAYER_COMBAT_RULES.pulse;
  const spec = {
    ...characterSpec,
    range: sharedSpec.radius,
    arcDegrees: sharedSpec.arcDegrees,
    damage: sharedSpec.damage,
    cooldownMs: sharedSpec.cooldownMs,
  };
  player.cooldownAttackReadyAt = elapsed + spec.cooldownMs;
  const minimumDot = Math.cos(spec.arcDegrees * Math.PI / 360);
  let hits = 0;
  for (const enemy of [...enemies]) {
    const toward = normalized(enemy.x - player.x, enemy.y - player.y);
    if (distance(player, enemy) <= spec.range + enemy.radius && toward.x * player.aim.x + toward.y * player.aim.y >= minimumDot) {
      damageEnemy(enemy, Math.round(spec.damage + player.level * 3), false, player);
      hits += 1;
    }
  }
  for (const projectile of projectiles) {
    if (!projectile.hostile || distance(player, projectile) > spec.range) continue;
    const toward = normalized(projectile.x - player.x, projectile.y - player.y);
    if (toward.x * player.aim.x + toward.y * player.aim.y >= minimumDot) projectile.ttl = 0;
  }
  effects.push({ type: "core-flare", x: player.x, y: player.y, toX: player.x + player.aim.x * spec.range, toY: player.y + player.aim.y * spec.range, radius: 18, born: elapsed, duration: 520, color: profile.palette.accent });
  announce(`${spec.name} · ${hits} target${hits === 1 ? "" : "s"}`, 1200);
}

function blink() {
  if (!started || pausedForShop || elapsed < player.blinkReadyAt) return;
  const escape = run.character.abilities.escape;
  player.blinkReadyAt = elapsed + escape.cooldownMs;
  const from = { x: player.x, y: player.y };
  const moveX = touchInput.moveX + (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
  const moveY = touchInput.moveY + (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
  const direction = resolveVaultEscapeVector({ moveX, moveY, velocityX: player.velocityX, velocityY: player.velocityY, aimX: player.aim.x, aimY: player.aim.y, style: escape, side: hash32(`${run.characterSeed}:escape-side`) % 2 ? 1 : -1 });
  for (let distance = escape.distance; distance >= 18; distance -= 18) {
    const targetX = clamp(from.x + direction.x * distance, 24, arena.worldWidth - 24);
    const targetY = clamp(from.y + direction.y * distance, 24, arena.worldHeight - 24);
    if (!isArenaWalkable(targetX, targetY, player.radius * 0.62)) continue;
    player.x = targetX; player.y = targetY; break;
  }
  player.invulnerableUntil = elapsed + escape.invulnerableMs;
  effects.push({ type: "blink", style: escape.effect, x: from.x, y: from.y, toX: player.x, toY: player.y, born: elapsed, duration: escape.invulnerableMs, color: profile.palette.ambient });
  document.documentElement.dataset.vaultEscapeVector = `${escape.id}:${direction.source}:${direction.x.toFixed(3)},${direction.y.toFixed(3)}:${escape.distance}`;
  announce(escape.name, 720);
}

function defend() {
  if (!started || pausedForShop || elapsed < player.defenseReadyAt) return;
  player.defenseReadyAt = elapsed + run.character.abilities.defense.cooldownMs;
  player.shieldUntil = elapsed + run.character.abilities.defense.durationMs;
  player.invulnerableUntil = player.shieldUntil;
  announce("Gravity shell active");
}

function ultimate() {
  if (player.level < run.character.abilities.ultimate.unlockLevel) return announce(`Event Horizon unlocks at level ${run.character.abilities.ultimate.unlockLevel}`);
  if (elapsed < player.ultimateReadyAt) return;
  player.ultimateReadyAt = elapsed + run.character.abilities.ultimate.cooldownMs;
  effects.push({ type: "ultimate", x: player.x, y: player.y, radius: 30, maximumRadius: 360, born: elapsed, duration: 1200, color: profile.palette.accent });
  for (const enemy of [...enemies]) damageEnemy(enemy, Math.round(55 + player.level * 7), true, player);
}

function detonateHostileProjectile(projectile) {
  if (projectile.detonated) return; projectile.detonated = true;
  effects.push({ type: "hostile-aoe", hostile: true, triggered: false, x: projectile.x, y: projectile.y, radius: 12, maximumRadius: projectile.explosionRadius || 96, damage: projectile.damage, born: elapsed, duration: 520, color: projectile.color ?? profile.palette.hostile });
}

function updateProjectiles(seconds) {
  for (const projectile of [...projectiles]) {
    if (projectile.hostile && projectile.homing) {
      const target = Math.atan2(player.y - projectile.y, player.x - projectile.x), current = Math.atan2(projectile.vy, projectile.vx), turn = Math.atan2(Math.sin(target - current), Math.cos(target - current)) * projectile.homing;
      projectile.vx = Math.cos(current + turn) * projectile.speed; projectile.vy = Math.sin(current + turn) * projectile.speed;
    }
    updateVaultGyroProjectile(projectile, player, elapsed);
    const previousColumn = Math.floor(projectile.x / arena.tileWidth);
    const previousRow = Math.floor(projectile.y / arena.tileHeight);
    const previousTile = arena.tiles[previousRow * arena.columns + previousColumn];
    projectile.x += projectile.vx * seconds;
    projectile.y += projectile.vy * seconds;
    const nextColumn = Math.floor(projectile.x / arena.tileWidth);
    const nextRow = Math.floor(projectile.y / arena.tileHeight);
    const nextTile = arena.tiles[nextRow * arena.columns + nextColumn];
    const blockedByGeometry = !nextTile || nextTile.kind === "wall" || nextTile.features?.includes("cliff")
      || (previousTile && Math.abs((nextTile.elevation ?? 0) - (previousTile.elevation ?? 0)) > 1 && !nextTile.features?.includes("ramp"));
    if (blockedByGeometry) projectile.ttl = 0;
    projectile.ttl -= seconds;
    if (projectile.hostile) {
      if (circleHit(projectile, player) && elapsed > player.invulnerableUntil) { if (projectile.kind === "exploder") detonateHostileProjectile(projectile); else hurtPlayer(projectile.damage, projectile); projectile.ttl = 0; }
    } else {
      if (projectile.boomerang && projectile.returning && circleHit(projectile, player, 4)) projectile.ttl = 0;
      for (const enemy of [...enemies]) {
        const hitKey = vaultProjectileHitKey(projectile, enemy.id);
        if (projectile.hit?.has(hitKey) || !circleHit(projectile, enemy)) continue;
        projectile.hit ??= new Set(); projectile.hit.add(hitKey);
        damageEnemy(enemy, projectile.damage, projectile.critical, projectile);
        projectile.pierce -= 1;
        if (projectile.pierce <= 0) { projectile.ttl = 0; break; }
      }
    }
    const outside = projectile.x < -40 || projectile.y < -40 || projectile.x > arena.worldWidth + 40 || projectile.y > arena.worldHeight + 40;
    if (projectile.ttl <= 0 || (!projectile.boomerang && outside)) {
      if (projectile.hostile && projectile.kind === "exploder") detonateHostileProjectile(projectile);
      projectiles.splice(projectiles.indexOf(projectile), 1);
      if (player.gyroProjectileId === projectile.id) player.gyroProjectileId = null;
    }
  }
}

function damageEnemy(enemy, amount, critical, source) {
  enemy.health -= amount;
  enemy.flashUntil = elapsed + 90;
  enemy.hitStartedAt = elapsed;
  effects.push({ type: "number", x: enemy.x, y: enemy.y - enemy.radius, text: `${critical ? "✦" : ""}${Math.round(amount)}`, born: elapsed, duration: 620, color: critical ? "#fff18a" : "#ffffff" });
  if (enemy.boss && enemy.parts?.length) {
    const liveParts = enemy.parts.filter((part) => part.alive);
    const target = liveParts.length ? liveParts[Math.abs(Math.floor(Math.atan2(source.y - enemy.y, source.x - enemy.x) * 10)) % liveParts.length] : null;
    if (target) { target.health -= amount; if (target.health <= 0) { target.alive = false; announce(`${enemy.name}: ${target.name} shattered`); } }
  }
  if (enemy.health <= 0) defeatEnemy(enemy);
}

function defeatEnemy(enemy) {
  if (!enemies.includes(enemy)) return;
  enemies.splice(enemies.indexOf(enemy), 1);
  if (!enemy.boss) defeatedEnemies.push({ ...enemy, health: 0, deathStartedAt: elapsed, deathUntil: elapsed + (enemy.type === "lancer" ? pixellabLancerAnimations.death.frames * pixellabLancerAnimations.death.frameMs : 620) });
  score += enemy.boss ? 1000 + layer * 100 : enemy.elite ? 110 : 35;
  gainExperience(enemy.xp);
  effects.push({ type: "burst", x: enemy.x, y: enemy.y, radius: enemy.radius, born: elapsed, duration: 520, color: enemy.boss ? profile.palette.accent : profile.palette.hostile });
  const rng = makeRng(`${run.seed}:drop:${layer}:${enemy.id}`);
  if (enemy.boss || rng() > 0.72) pickups.push({ id: nextEntityId++, x: enemy.x, y: enemy.y, radius: 7, type: enemy.boss ? "relic" : rng() > 0.5 ? "health" : "credit", value: enemy.boss ? `Layer ${layer} core` : 8 + Math.floor(rng() * 14), phase: rng() * 6 });
}

function gainExperience(amount) {
  player.experience += amount;
  while (player.experience >= player.nextLevelExperience) {
    player.experience -= player.nextLevelExperience;
    player.level += 1;
    player.nextLevelExperience = Math.round(player.nextLevelExperience * 1.32);
    const growth = ({ power: "power", agility: "move", guard: "health", signal: "critical" })[run.character.affinity];
    if (growth === "move") player.moveSpeed += 9;
    if (growth === "health") { player.maxHealth += 12; player.health += 12; }
    if (growth === "critical") player.critical += 0.012;
    if (growth === "power") { run.weapon.longRange.damage += 2; run.weapon.closeRange.damage += 3; }
    announce(`Level ${player.level} · ${run.character.affinity} growth`);
  }
}

function hurtPlayer(amount, source) {
  const blockScale = elapsed < player.shieldUntil ? VAULT_PLAYER_COMBAT_RULES.block.damageScale : 1;
  const reduced = Math.max(1, amount * (1 - player.defense) * blockScale);
  player.health -= reduced;
  player.invulnerableUntil = elapsed + 680;
  player.flashUntil = elapsed + 150;
  const away = normalized(player.x - source.x, player.y - source.y);
  player.x += away.x * 22; player.y += away.y * 22;
  if (player.health <= 0) endRun();
}

function endRun() {
  started = false;
  announce(`RUN ENDED · layer ${layer} · score ${score}`, 5000);
  document.querySelector("#objective-title").textContent = "Signal lost";
  document.querySelector("#objective-detail").textContent = `Map ${run.mapSeedDigest} controls this floor; character ${run.characterSeedDigest} keeps its own build and weapon.`;
}

function updatePickups(seconds) {
  for (const pickup of [...pickups]) {
    pickup.phase += seconds * 4;
    const range = distance(player, pickup);
    if (range < player.pickupRadius) {
      const direction = normalized(player.x - pickup.x, player.y - pickup.y);
      pickup.x += direction.x * 240 * seconds; pickup.y += direction.y * 240 * seconds;
    }
    if (circleHit(player, pickup, 3)) {
      if (pickup.type === "health") player.health = Math.min(player.maxHealth, player.health + pickup.value);
      else if (pickup.type === "credit") score += pickup.value * 4;
      else if (player.backpack.length < player.backpackSlots) player.backpack.push({ kind: "relic", name: pickup.value, rarity: "boss" });
      pickups.splice(pickups.indexOf(pickup), 1);
    }
  }
}

function updateEffects() {
  defeatedEnemies = defeatedEnemies.filter((enemy) => elapsed < enemy.deathUntil);
  for (const effect of [...effects]) {
    const progress = (elapsed - effect.born) / effect.duration;
    if (effect.hostile && !effect.triggered && progress > 0.76) {
      effect.triggered = true;
      if (distance(effect, player) < effect.maximumRadius && elapsed > player.invulnerableUntil) hurtPlayer(effect.damage, effect);
    }
    if (progress >= 1) effects.splice(effects.indexOf(effect), 1);
  }
}

function updateLayerProgress() {
  const room = arena.rooms[activeRoomIndex];
  if (!room || room.status !== "active") return;
  const roomQueue = spawnQueue.filter((entry) => entry.roomIndex === activeRoomIndex).length;
  const holdoutRemaining = Math.max(0, roomHoldoutEndsAt - elapsed);
  const threats = enemies.length + roomQueue;
  if (relay) document.querySelector("#objective-detail").textContent = `Relay ${Math.ceil(relay.health)}% · ${threats} threats · ${Math.ceil(holdoutRemaining / 1000)}s`;
  else if (room.holdoutSeconds) document.querySelector("#objective-detail").textContent = `${Math.ceil(holdoutRemaining / 1000)} seconds · ${threats} threats remain`;
  else document.querySelector("#objective-detail").textContent = `${threats} threats remain · ${room.storyBeat.replaceAll("-", " ")}`;
  if (roomQueue > 0 || enemies.length > 0 || holdoutRemaining > 0 || !room.puzzleComplete) return;
  completeRoom(room);
}

function completeRoom(room) {
  room.status = "complete";
  relay = null;
  const authoredRelay = arena.objects.find((object) => object.roomId === room.id && object.type === "relay");
  if (authoredRelay) authoredRelay.state = "complete";
  score += 90 + room.enemyBudget * 20 + layer * 12;
  if (room.mission === "recover-cache") {
    const chest = arena.objects.find((object) => object.roomId === room.id && object.type === "cache");
    if (chest) chest.state = "open";
    pickups.push({ id: nextEntityId++, x: (room.column + 0.5) * arena.tileWidth, y: (room.row + 0.5) * arena.tileHeight, radius: 7, type: "relic", value: `${profile.biome} cache`, phase: 0 });
  }
  const remainingRequired = arena.rooms.filter((candidate) => !candidate.final && !candidate.optional && candidate.status !== "complete");
  const unlocked = [];
  for (const connection of arena.connections.filter((candidate) => candidate.locked && (candidate.from === room.id || (!remainingRequired.length && arena.rooms.find((target) => target.id === candidate.to)?.final)))) {
    const target = arena.rooms.find((candidate) => candidate.id === connection.to);
    if (!target || (target.final && remainingRequired.length)) continue;
    connection.locked = false;
    connection.openedAt = elapsed;
    target.locked = false;
    target.status = "waiting";
    target.discovered = true;
    unlocked.push(target);
  }
  if (!room.final) {
    const target = unlocked[0];
    document.querySelector("#objective-title").textContent = target ? `${unlocked.length} route${unlocked.length === 1 ? "" : "s"} opened` : "Branch cleared";
    document.querySelector("#objective-detail").textContent = target ? `${target.storyBeat.replaceAll("-", " ")} · explore the opened route` : "Return to the last junction";
    announce(`${room.role.toUpperCase()} CLEARED${unlocked.length ? ` · ${unlocked.length} route${unlocked.length === 1 ? "" : "s"} unlocked` : ""}`, 2200);
    return;
  }
  if (layerClearedAt) return;
  layerClearedAt = elapsed;
  score += 200 + layer * 35;
  document.querySelector("#objective-title").textContent = profile.shopAfter ? "Boss cleared · enter the loadout station" : "Floor cleared · choose one upgrade";
  setTimeout(() => openLoadoutStation(), 500);
}

function activateExit() {
  exitActive = true;
  exitActiveAt = elapsed + 250;
  arena.exit.locked = false;
  document.querySelector("#objective-title").textContent = "Floor exit online";
  document.querySelector("#objective-detail").textContent = "Walk into the map portal to enter the next seeded floor";
  announce("FLOOR CLEARED · EXIT ONLINE", 2200);
}

function applyAutomaticGrowth() {
  if (layerDecisionApplied) return "Automatic growth already applied";
  layerDecisionApplied = true;
  const affinity = run.character.affinity;
  player.runAttributes[affinity] += 1;
  if (affinity === "power") {
    for (const weapon of run.weapons) {
      weapon.longRange.damage = Math.round(weapon.longRange.damage * 1.035);
      weapon.closeRange.damage = Math.round(weapon.closeRange.damage * 1.035);
      weapon.chargeAttack.damage = Math.round(weapon.chargeAttack.damage * 1.025);
    }
  }
  if (affinity === "agility") player.moveSpeed += 5;
  if (affinity === "guard") {
    player.defense = Math.min(0.45, player.defense + 0.006);
    player.health = Math.min(player.maxHealth, player.health + 6);
  }
  if (affinity === "signal") {
    player.pickupRadius += 4;
    run.character.abilities.cooldownAttack.cooldownMs = Math.round(run.character.abilities.cooldownAttack.cooldownMs * 0.985);
  }
  updatePlayerUi();
  return `${upgradeLabel(affinity)} affinity automatically gained +1 · ${affinityGrowthDescription(affinity)}`;
}

function affinityGrowthDescription(affinity) {
  return ({ power: "all held weapons gained damage", agility: "movement speed increased", guard: "defense and repair increased", signal: "pickup reach and Core Flare recovery improved" })[affinity];
}

function renderStationLoadout() {
  const root = document.querySelector("#station-loadout");
  root.replaceChildren();
  run.weapons.forEach((weapon, index) => {
    const button = document.createElement("button");
    button.classList.toggle("active", index === player.activeWeaponIndex);
    button.innerHTML = `<span><strong>${index + 1} · ${weapon.name}</strong><br><span class="muted">${weapon.rarity} · ${weapon.chargeAttack.mode}</span></span><span>${index === player.activeWeaponIndex ? "EQUIPPED" : "EQUIP"}</span>`;
    button.addEventListener("click", () => { switchWeapon(index); renderStationLoadout(); });
    root.append(button);
  });
}

function openLoadoutStation() {
  if (!started || pausedForShop) return;
  pausedForShop = true;
  const automaticGrowth = applyAutomaticGrowth();
  const choices = createShopChoices(atlas, run, layer);
  document.querySelector("#station-eyebrow").textContent = profile.shopAfter ? "Boss cleared · store + loadout station" : "Floor cleared · loadout station";
  document.querySelector("#station-title").textContent = "Choose one of three run upgrades";
  document.querySelector("#station-detail").textContent = profile.shopAfter
    ? "Boss cache unlocked. Swap either carried weapon, then install one deterministic upgrade."
    : "Your character grew automatically. Swap either carried weapon, then install one deterministic upgrade.";
  document.querySelector("#growth-receipt").textContent = automaticGrowth;
  renderStationLoadout();
  const root = document.querySelector("#shop-options");
  root.replaceChildren();
  for (const choice of choices) {
    const button = document.createElement("button");
    button.innerHTML = `<strong>${upgradeLabel(choice)}</strong><span class="muted">${upgradeDescription(choice)}</span>`;
    button.addEventListener("click", () => chooseUpgrade(choice));
    root.append(button);
  }
  document.querySelector("#shop").classList.add("open");
  document.documentElement.dataset.vaultStation = profile.shopAfter ? "boss-store" : "floor-loadout";
  document.documentElement.dataset.vaultDecisionChoices = choices.join(",");
}

function upgradeLabel(id) { return id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
function upgradeDescription(id) {
  return ({ power: "+12% long and close damage", "fire-rate": "12% shorter long-range cooldown", "move-speed": "+18 movement speed", "max-health": "+20 max integrity and heal", critical: "+4% critical chance", "pickup-radius": "+22 collection radius", "close-range": "+18% close-range radius and damage", "defense-cooldown": "Gravity shell recharges 18% faster", "escape-cooldown": "Phase blink recharges 18% faster", "backpack-slot": "+1 persistent backpack slot" })[id];
}

function chooseUpgrade(id) {
  const chosenAttribute = ({ power: "power", "fire-rate": "agility", "move-speed": "agility", "max-health": "guard", critical: "power", "pickup-radius": "signal", "close-range": "power", "defense-cooldown": "guard", "escape-cooldown": "agility", "backpack-slot": "signal" })[id];
  if (chosenAttribute) player.runAttributes[chosenAttribute] += 1;
  if (id === "power") { run.weapon.longRange.damage = Math.round(run.weapon.longRange.damage * 1.12); run.weapon.closeRange.damage = Math.round(run.weapon.closeRange.damage * 1.12); }
  if (id === "fire-rate") run.weapon.longRange.cooldownMs = Math.round(run.weapon.longRange.cooldownMs * 0.88);
  if (id === "move-speed") player.moveSpeed += 18;
  if (id === "max-health") { player.maxHealth += 20; player.health = Math.min(player.maxHealth, player.health + 20); }
  if (id === "critical") player.critical += 0.04;
  if (id === "pickup-radius") player.pickupRadius += 22;
  if (id === "close-range") { run.weapon.closeRange.radius = Math.round(run.weapon.closeRange.radius * 1.18); run.weapon.closeRange.damage = Math.round(run.weapon.closeRange.damage * 1.1); }
  if (id === "defense-cooldown") run.character.abilities.defense.cooldownMs = Math.round(run.character.abilities.defense.cooldownMs * 0.82);
  if (id === "escape-cooldown") run.character.abilities.escape.cooldownMs = Math.round(run.character.abilities.escape.cooldownMs * 0.82);
  if (id === "backpack-slot") player.backpackSlots = Math.min(atlas.backpack.maximumSlots, player.backpackSlots + 1);
  document.querySelector("#shop").classList.remove("open");
  pausedForShop = false;
  document.documentElement.dataset.vaultStation = "closed";
  document.documentElement.dataset.vaultChosenUpgrade = id;
  updatePlayerUi();
  announce(`${upgradeLabel(id)} installed`);
  activateExit();
}

function draw() {
  if (!profile) return drawAttractMode();
  context.fillStyle = "#020504";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(-Math.round(camera.x), -Math.round(camera.y));
  drawArena();
  drawWorldLighting();
  drawObjects();
  drawExit();
  drawRelay();
  drawPickups();
  drawProjectiles();
  if (!artReviewMode) {
    drawEnemies();
    drawPlayer();
  }
  drawEffects();
  context.restore();
  const edge = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  edge.addColorStop(0, rgba(profile.palette.accent, 0.42));
  edge.addColorStop(1, rgba(profile.palette.hostile, 0.32));
  context.strokeStyle = edge;
  context.lineWidth = 8;
  context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  if (profile.effects.includes("scanlines")) {
    context.fillStyle = "rgba(255,255,255,.018)";
    for (let y = 0; y < canvas.height; y += 5) context.fillRect(0, y, canvas.width, 1);
  }
  if (wallDoorStructureReviewEnabled) drawWallDoorStructureReview();
  if (launchParams.get("wallReview") === "1" && profile.biome === "occult-machine-catacomb") drawWallMaskReview();
  if (!artReviewMode) {
    drawMinimap();
    drawCrosshair();
  }
  if (worldFeatureRenderReviewEnabled) drawWorldFeatureRenderReview();
  if (biomeStructuralVariantReviewEnabled) drawBiomeStructuralVariantReview();
  document.documentElement.dataset.vaultGameReady = "true";
  document.documentElement.dataset.vaultRunSeed = run.seed;
  document.documentElement.dataset.vaultLayer = String(layer);
  document.documentElement.dataset.vaultWaveSeed = profile.waveSeed;
  document.documentElement.dataset.vaultWeapon = run.weapon.id;
  document.documentElement.dataset.vaultHostiles = String(enemies.length + spawnQueue.length);
  document.documentElement.dataset.vaultWorld = `${arena.worldWidth}x${arena.worldHeight}`;
  document.documentElement.dataset.vaultCamera = `${Math.round(camera.x)},${Math.round(camera.y)}`;
  document.documentElement.dataset.vaultCorridorWidth = String(arena.corridorWidth);
  document.documentElement.dataset.vaultDoorArt = "animated-five-cell-continuous-split-gate-v2";
  document.documentElement.dataset.vaultBiome = profile.biome;
  document.documentElement.dataset.vaultBiomeAtlas = atlas.gameArt.biomeAtlases[profile.biome]?.source ?? atlas.gameArt.source;
  document.documentElement.dataset.vaultGenerator = arena.schema;
  document.documentElement.dataset.vaultWorldFeatures = Object.entries(arena.features ?? {}).map(([name, entries]) => `${name}:${entries.length}`).join(",");
  document.documentElement.dataset.vaultArtBoundary = "world-enemy-boss-motion-placeholders-pending-pixellabs-imagegen-critic-gates";
  document.documentElement.dataset.vaultRunAttributes = Object.entries(player.runAttributes).map(([key, value]) => `${key}:${value}`).join(",");
  const gyroProjectile = projectiles.find((projectile) => projectile.weapon === "gyro" && !projectile.hostile);
  document.documentElement.dataset.vaultGyroProjectile = gyroProjectile
    ? `${gyroProjectile.returning ? "returning" : "outbound"}:${Math.round(gyroProjectile.x)},${Math.round(gyroProjectile.y)}`
    : "held";
}

function drawWallMaskReview() {
  const cell = 96;
  const gap = 12;
  const originX = Math.max(18, Math.round((canvas.width - (cell + gap) * 4 + gap) / 2));
  const originY = 78;
  context.save();
  context.fillStyle = "rgba(2,5,5,.96)";
  context.fillRect(originX - 18, originY - 48, (cell + gap) * 4 + 24, (cell + gap) * 4 + 62);
  context.fillStyle = "#ecfff9";
  context.font = "800 20px ui-monospace,monospace";
  context.fillText("SIGNAL CRYPT · ALL 16 NESW WALL MASKS", originX, originY - 18);
  const priorTileWidth = arena.tileWidth;
  const priorTileHeight = arena.tileHeight;
  arena.tileWidth = cell;
  arena.tileHeight = cell;
  for (let mask = 0; mask < 16; mask += 1) {
    const gridColumn = mask % 4;
    const gridRow = Math.floor(mask / 4);
    const x = originX + gridColumn * (cell + gap);
    const y = originY + gridRow * (cell + gap);
    drawSignalCryptWall({ exposureMask: mask, wallMask: 15 ^ mask, materialBand: gridRow }, x, y, gridColumn, gridRow);
    context.strokeStyle = rgba(profile.palette.line, 0.35);
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
    context.fillStyle = "rgba(0,0,0,.74)";
    context.fillRect(x + 4, y + 4, 46, 20);
    context.fillStyle = "#ecfff9";
    context.font = "700 12px ui-monospace,monospace";
    context.fillText(`${mask.toString(16).toUpperCase()} · ${mask.toString(2).padStart(4, "0")}`, x + 8, y + 18);
  }
  arena.tileWidth = priorTileWidth;
  arena.tileHeight = priorTileHeight;
  context.restore();
}

function drawWallDoorStructureReview() {
  if (!wallDoorStructureReviewEnabled || !wallDoorStructureReviewState || !profile) return;
  const panelX = 18;
  const panelY = 76;
  const panelWidth = Math.min(820, canvas.width - panelX * 2);
  const panelHeight = Math.min(568, canvas.height - panelY - 18);
  if (panelWidth < 520 || panelHeight < 440) return;
  const audit = wallDoorStructureReviewState.audit;
  const contentLeft = panelX + 180;
  const slotWidth = Math.floor((panelWidth - 196) / 3);
  const rowHeight = 238;
  context.save();
  context.imageSmoothingEnabled = false;
  context.fillStyle = "rgba(2,5,5,.95)";
  context.fillRect(panelX, panelY, panelWidth, panelHeight);
  context.strokeStyle = rgba(profile.palette.accent, 0.82);
  context.lineWidth = 2;
  context.strokeRect(panelX + 1, panelY + 1, panelWidth - 2, panelHeight - 2);
  context.fillStyle = "#ecfff9";
  context.font = "800 16px ui-monospace,monospace";
  context.fillText("LIVE WALL / DOOR STRUCTURE REVIEW", panelX + 16, panelY + 23);
  context.fillStyle = "#8ca79f";
  context.font = "10px ui-monospace,monospace";
  context.fillText(`seed ${audit.mapSeed} · layer ${audit.layer} · biome ${audit.biome} · ${audit.material}`, panelX + 16, panelY + 40);
  audit.sourceDoorConnections.forEach((source, rowIndex) => {
    const row = wallDoorStructureReviewState.rows[rowIndex];
    const rowTop = panelY + 58 + rowIndex * rowHeight;
    context.fillStyle = "#ecfff9";
    context.font = "800 12px ui-monospace,monospace";
    context.fillText(`LIVE ${source.liveAxis.toUpperCase()}  →  HARNESS ${source.harnessAxis.toUpperCase()}`, panelX + 16, rowTop + 13);
    context.fillStyle = "#8ca79f";
    context.font = "9px ui-monospace,monospace";
    const sourceLabel = source.id
      ? `${source.id} · ${source.from}→${source.to} · @${source.column},${source.row} · span ${source.span}`
      : "NO SEEDED CONNECTION FOR THIS AXIS";
    context.fillText(sourceLabel, panelX + 16, rowTop + 29);
    row?.states.forEach((state, stateIndex) => {
      const imageX = Math.round(contentLeft + stateIndex * slotWidth + (slotWidth - state.image.width) / 2);
      const imageY = rowTop + 42;
      context.fillStyle = state.progress === 0.5 ? "#fff18a" : state.progress === 1 ? "#67f6c5" : "#ecfff9";
      context.font = "800 10px ui-monospace,monospace";
      context.fillText(`${Math.round(state.progress * 100)}% · ${state.apertureSize.toFixed(1)}px`, imageX, rowTop + 40);
      context.drawImage(state.image, imageX, imageY);
      context.strokeStyle = "rgba(236,255,249,.25)";
      context.lineWidth = 1;
      context.strokeRect(imageX + 0.5, imageY + 0.5, state.image.width - 1, state.image.height - 1);
    });
  });
  const statusY = panelY + panelHeight - 42;
  context.fillStyle = "#ecfff9";
  context.font = "800 10px ui-monospace,monospace";
  context.fillText(`CONNECTED ${Object.values(audit.connectedRunStatus).every(Boolean) ? "YES" : "NO"} · RENDER/COLLISION APERTURE SHARED ${audit.renderCollisionApertureShared ? "YES" : "NO"}`, panelX + 16, statusY);
  context.fillStyle = "#8ca79f";
  context.font = "9px ui-monospace,monospace";
  context.fillText(`RGBA ${Object.entries(audit.deterministicRgbaHashes).map(([axis, hashes]) => `${axis}:${hashes.join("/")}`).join("  ")}`, panelX + 16, statusY + 14);
  context.fillText("REVIEW ONLY · default renderer/camera unchanged · neutral candidate material · no PixelLabs or industrial-forge-wall-v1 approval", panelX + 16, statusY + 28);
  context.restore();
  document.documentElement.dataset.vaultWallDoorStructureReviewPaint = "true";
}

function worldFeatureReviewTruncate(value, maximum = 30) {
  const text = String(value ?? "missing");
  return text.length <= maximum ? text : `${text.slice(0, Math.max(1, maximum - 1))}…`;
}

function worldFeatureReviewDetailLines(category, entry) {
  if (category === "bridges") return [
    `${worldFeatureReviewTruncate(entry.id)} · ${entry.memberCount} members`,
    `shape ${entry.shape} · holes ${entry.holeCount}`,
    `continuity ${entry.memberContinuity ? "PASS" : "FAIL"} · RGBA ${entry.rgbaHash}`,
  ];
  if (category === "ramps") return [
    `${worldFeatureReviewTruncate(entry.id)} · axis ${entry.axis}`,
    `levels ${entry.levels.join("/") || "missing"} · transition ${entry.elevationTransition ? "PASS" : "FAIL"}`,
    `orientation ${entry.orientation} · align ${entry.aligned ? "PASS" : "FAIL"} · ${entry.rgbaHash}`,
  ];
  if (category === "cliffs") return [
    `${worldFeatureReviewTruncate(entry.id)} · dir ${entry.direction}`,
    `height ${entry.height} · face ${entry.elevationFace ? "PASS" : "FAIL"}`,
    `${entry.tiles.length} tiles · RGBA ${entry.rgbaHash}`,
  ];
  if (category === "objects") return [
    `${entry.count} actual objects · ${entry.nonOverlap ? "non-overlap PASS" : "non-overlap FAIL"}`,
    `ids ${worldFeatureReviewTruncate(entry.identities.slice(0, 2).join(" | "))}`,
    `RGBA ${entry.rgbaHash} · ink ${entry.inkPixelCount}`,
  ];
  if (category === "occlusion") return [
    `wall ${entry.occludingWall ? `${entry.occludingWall.column},${entry.occludingWall.row}` : "missing"}`,
    `shadow ${entry.shadow ? "PASS" : "FAIL"} · depth ${entry.depth} · px ${entry.shadowPixelCount}`,
    `source ${worldFeatureReviewTruncate(entry.shadowObjectId)} · RGBA ${entry.rgbaHash}`,
  ];
  if (category === "lamps") return [
    `${entry.count} tower lamps · ${worldFeatureReviewTruncate(entry.identity)}`,
    `lamp pixels ${entry.pixels ? "PASS" : "FAIL"} · px ${entry.lampPixelCount}`,
    `RGBA ${entry.rgbaHash} · frozen visual` ,
  ];
  return [
    `${entry.count} sources · ${worldFeatureReviewTruncate(entry.sourceId)}`,
    `visible ${entry.visibleTileCount}/${entry.nonWallTileCount} tiles · ${entry.visibleThroughNonWall ? "PASS" : "FAIL"}`,
    `light px ${entry.lightPixelCount} · RGBA ${entry.rgbaHash}`,
  ];
}

function drawWorldFeatureRenderReview() {
  if (!worldFeatureRenderReviewEnabled || !worldFeatureRenderReviewState || !profile) return;
  const compact = wallDoorStructureReviewEnabled && canvas.width >= 1000;
  const panelX = compact ? Math.min(850, canvas.width - 330) : 18;
  const panelY = compact ? 76 : 18;
  const panelWidth = compact ? canvas.width - panelX - 18 : Math.min(1244, canvas.width - 36);
  const panelHeight = compact ? Math.min(626, canvas.height - panelY - 18) : Math.min(684, canvas.height - panelY - 18);
  if (panelWidth < 300 || panelHeight < 430) return;
  const audit = worldFeatureRenderReviewState.audit;
  const categories = WORLD_FEATURE_REVIEW_CATEGORIES;
  const columnCount = compact ? 1 : 4;
  const rowCount = Math.ceil(categories.length / columnCount);
  const gap = compact ? 6 : 10;
  const headerHeight = compact ? 72 : 88;
  const cardWidth = Math.floor((panelWidth - 32 - gap * (columnCount - 1)) / columnCount);
  const cardHeight = Math.floor((panelHeight - headerHeight - 18 - gap * (rowCount - 1)) / rowCount);
  context.save();
  context.imageSmoothingEnabled = false;
  context.fillStyle = "rgba(2,5,5,.96)";
  context.fillRect(panelX, panelY, panelWidth, panelHeight);
  context.strokeStyle = rgba(profile.palette.accent, 0.86);
  context.lineWidth = 2;
  context.strokeRect(panelX + 1, panelY + 1, panelWidth - 2, panelHeight - 2);
  context.fillStyle = "#ecfff9";
  context.font = compact ? "800 12px ui-monospace,monospace" : "800 16px ui-monospace,monospace";
  context.fillText("WORLD FEATURE RENDER REVIEW", panelX + 16, panelY + 20);
  context.fillStyle = "#8ca79f";
  context.font = compact ? "8px ui-monospace,monospace" : "10px ui-monospace,monospace";
  context.fillText(`seed ${worldFeatureReviewTruncate(audit.mapSeed, compact ? 22 : 42)} · layer ${audit.layer} · biome ${audit.biome}`, panelX + 16, panelY + 37);
  context.fillText(compact ? "FLAG ON · FROZEN RGBA · CANDIDATE / NO APPROVAL / REVIEW ONLY" : "FLAG worldFeatureRenderReview=1 · frozen deterministic RGBA · CANDIDATE / NO APPROVAL / REVIEW ONLY", panelX + 16, panelY + (compact ? 50 : 54));
  const receiptLabel = `SCHEMA ${audit.schema} · VERSION ${audit.version} · STATUS ${audit.status.toUpperCase()}`;
  context.fillStyle = audit.status === "ready" ? "#67f6c5" : "#ffb2b9";
  context.font = compact ? "800 8px ui-monospace,monospace" : "800 10px ui-monospace,monospace";
  context.fillText(receiptLabel, panelX + 16, panelY + (compact ? 65 : 70));
  categories.forEach((category, index) => {
    const entry = worldFeatureRenderReviewState.categories[category];
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    const cardX = panelX + 16 + column * (cardWidth + gap);
    const cardY = panelY + headerHeight + row * (cardHeight + gap);
    context.fillStyle = "rgba(8,17,16,.98)";
    context.fillRect(cardX, cardY, cardWidth, cardHeight);
    context.strokeStyle = audit.gates[category] ? rgba(profile.palette.accent, 0.58) : rgba(profile.palette.hostile, 0.78);
    context.lineWidth = 1;
    context.strokeRect(cardX + 0.5, cardY + 0.5, cardWidth - 1, cardHeight - 1);
    context.fillStyle = audit.gates[category] ? "#ecfff9" : "#ffb2b9";
    context.font = compact ? "800 9px ui-monospace,monospace" : "800 12px ui-monospace,monospace";
    const label = category === "occlusion" ? "OCCLUSION / SHADOW DEPTH" : category === "lighting" ? "LIGHTING / LIGHT VISIBILITY" : category.toUpperCase();
    context.fillText(`${label} · COUNT ${entry.count}`, cardX + 8, cardY + (compact ? 14 : 18));
    const imageWidth = compact ? 78 : 176;
    const imageHeight = compact ? 32 : 72;
    const imageX = compact ? cardX + 8 : cardX + Math.max(8, Math.floor((cardWidth - imageWidth) / 2));
    const imageY = compact ? cardY + 23 : cardY + 28;
    context.drawImage(entry.image, imageX, imageY, imageWidth, imageHeight);
    context.strokeStyle = "rgba(236,255,249,.25)";
    context.strokeRect(imageX + 0.5, imageY + 0.5, imageWidth - 1, imageHeight - 1);
    const lines = worldFeatureReviewDetailLines(category, entry);
    context.fillStyle = "#8ca79f";
    context.font = compact ? "8px ui-monospace,monospace" : "9px ui-monospace,monospace";
    const textX = compact ? cardX + 94 : cardX + 10;
    const textY = compact ? cardY + 31 : cardY + 118;
    lines.forEach((line, lineIndex) => context.fillText(worldFeatureReviewTruncate(line, compact ? 43 : 48), textX, textY + lineIndex * (compact ? 10 : 14)));
  });
  context.fillStyle = "#8ca79f";
  context.font = compact ? "7px ui-monospace,monospace" : "9px ui-monospace,monospace";
  const gateSummary = categories.map((category) => `${category}:${audit.gates[category] ? "P" : "F"}`).join("  ");
  context.fillText(`GATES ${gateSummary} · audit ${audit.auditHash}`, panelX + 16, panelY + panelHeight - (compact ? 8 : 10));
  context.restore();
  document.documentElement.dataset.vaultWorldFeatureRenderPaint = "true";
}

function biomeStructuralReviewTruncate(value, maximum = 44) {
  const text = String(value ?? "missing");
  return text.length <= maximum ? text : `${text.slice(0, Math.max(1, maximum - 1))}…`;
}

function drawBiomeStructuralVariantReview() {
  if (!biomeStructuralVariantReviewEnabled || !biomeStructuralVariantReviewState) return;
  const panelX = 14;
  const panelY = 14;
  const panelWidth = canvas.width - 28;
  const panelHeight = canvas.height - 28;
  const combinedReview = wallDoorStructureReviewEnabled || worldFeatureRenderReviewEnabled;
  const headerHeight = 70;
  const footerHeight = 28;
  const gap = 12;
  const cardWidth = Math.floor((panelWidth - 32 - gap) / 2);
  const cardHeight = Math.floor((panelHeight - headerHeight - footerHeight - 24 - gap) / 2);
  const audit = biomeStructuralVariantReviewState.audit;
  context.save();
  context.imageSmoothingEnabled = false;
  if (combinedReview) {
    context.fillStyle = "rgba(3,8,8,.98)";
    context.fillRect(panelX, panelY, panelWidth, 52);
    context.strokeStyle = audit.status === "ready" ? "#67f6c5" : "#ffb2b9";
    context.lineWidth = 1;
    context.strokeRect(panelX + 0.5, panelY + 0.5, panelWidth - 1, 51);
    context.fillStyle = audit.status === "ready" ? "#67f6c5" : "#ffb2b9";
    context.font = "800 10px ui-monospace,monospace";
    context.fillText(`BIOME VARIANTS · ${audit.status.toUpperCase()} · ${audit.schema} · V${audit.version}`, panelX + 10, panelY + 15);
    context.fillStyle = "#9eada7";
    context.font = "8px ui-monospace,monospace";
    context.fillText(BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => `${biome}:${audit.gates[biome] ? "P" : "F"}/${audit.cards[biome].variantSignature}`).join("  "), panelX + 10, panelY + 29);
    context.fillText("CANDIDATE / NO APPROVAL / REVIEW ONLY · full four-card board is available with this flag alone", panelX + 10, panelY + 43);
    context.restore();
    document.documentElement.dataset.vaultBiomeStructuralVariantReviewPaint = "true";
    return;
  }
  context.fillStyle = "rgba(3,8,8,.98)";
  context.fillRect(panelX, panelY, panelWidth, panelHeight);
  context.strokeStyle = audit.status === "ready" ? "#67f6c5" : "#ffb2b9";
  context.lineWidth = 2;
  context.strokeRect(panelX + 1, panelY + 1, panelWidth - 2, panelHeight - 2);
  context.fillStyle = "#ecfff9";
  context.font = "800 16px ui-monospace,monospace";
  context.fillText("FOUR-BIOME STRUCTURAL VARIANT REVIEW", panelX + 16, panelY + 22);
  context.fillStyle = "#9eada7";
  context.font = "9px ui-monospace,monospace";
  context.fillText(`FLAG biomeStructuralVariantReview=1 · seeded cohort ${biomeStructuralReviewTruncate(audit.seedCohort.join(" + "), 105)}`, panelX + 16, panelY + 39);
  const receiptLabel = `SCHEMA ${audit.schema} · VERSION ${audit.version} · STATUS ${audit.status.toUpperCase()}`;
  context.fillStyle = audit.status === "ready" ? "#67f6c5" : "#ffb2b9";
  context.font = "800 10px ui-monospace,monospace";
  context.fillText(receiptLabel, panelX + 16, panelY + 56);
  BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.forEach((biome, index) => {
    const card = biomeStructuralVariantReviewState.cards[biome];
    const column = index % 2;
    const row = Math.floor(index / 2);
    const cardX = panelX + 16 + column * (cardWidth + gap);
    const cardY = panelY + headerHeight + row * (cardHeight + gap);
    const source = card.source;
    const variant = card.variant;
    context.fillStyle = "rgba(10,21,19,.98)";
    context.fillRect(cardX, cardY, cardWidth, cardHeight);
    context.strokeStyle = audit.gates[biome] ? "rgba(103,246,197,.72)" : "rgba(255,178,185,.82)";
    context.lineWidth = 1;
    context.strokeRect(cardX + 0.5, cardY + 0.5, cardWidth - 1, cardHeight - 1);
    context.fillStyle = audit.gates[biome] ? "#ecfff9" : "#ffb2b9";
    context.font = "800 12px ui-monospace,monospace";
    context.fillText(`${biome.toUpperCase()} · ${audit.gates[biome] ? "PASS" : "FAIL"}`, cardX + 10, cardY + 18);
    context.fillStyle = "#9eada7";
    context.font = "8px ui-monospace,monospace";
    context.fillText(`source ${biomeStructuralReviewTruncate(source?.mapSeed)} · layer ${source?.layer ?? "missing"} · ${source?.tilesetId ?? "missing"}`, cardX + 10, cardY + 33);
    context.fillText(`variant ${biomeStructuralReviewTruncate(card.variantId, 60)} · candidate neutral grayscale`, cardX + 10, cardY + 46);
    context.drawImage(card.image, cardX + 10, cardY + 58, card.image.width, card.image.height);
    const detailX = cardX + 308;
    const detailY = cardY + 76;
    const counts = card.counts;
    const detailLines = [
      `actual ${source?.biome ?? "missing"} · palette ${source?.paletteId ?? "missing"}`,
      `W${counts.walls} B${counts.bridges} R${counts.ramps} C${counts.cliffs} O${counts.objects} L${counts.lamps}`,
      `wall ${variant.wall.cap} / ${variant.wall.edge}`,
      `bridge ${variant.bridge.geometry} / ${variant.bridge.axis}`,
      `ramp ${variant.ramp.geometry} / ${variant.ramp.axis}`,
      `cliff ${variant.cliff.geometry} / ${variant.cliff.edge}`,
      `object ${variant.object.geometry} / ${variant.object.footprint}`,
      `lamp ${variant.lamp.geometry} / ${variant.lamp.rays} rays`,
      `light ${variant.lighting.geometry} / ${variant.lighting.occlusion}`,
      `signature ${card.variantSignature} · RGBA ${card.rgbaHash}`,
      `pixels ${card.nonzeroPixelCount} nonzero / ${card.inkPixelCount} structural`,
    ];
    context.fillStyle = "#b7c8c0";
    context.font = "8px ui-monospace,monospace";
    detailLines.forEach((line, lineIndex) => context.fillText(biomeStructuralReviewTruncate(line, 48), detailX, detailY + lineIndex * 13));
  });
  context.fillStyle = "#9eada7";
  context.font = "8px ui-monospace,monospace";
  context.fillText(`GATES ${BIOME_STRUCTURAL_VARIANT_REVIEW_BIOMES.map((biome) => `${biome}:${audit.gates[biome] ? "P" : "F"}`).join("  ")} · unique signatures ${audit.uniqueVariantSignatures ? "PASS" : "FAIL"} · audit ${audit.auditHash}`, panelX + 16, panelY + panelHeight - 18);
  context.fillStyle = "#7e928a";
  context.fillText("CANDIDATE / NO APPROVAL / REVIEW ONLY · seeded profile + arena provenance · PixelLabs remains locked", panelX + 16, panelY + panelHeight - 7);
  context.restore();
  document.documentElement.dataset.vaultBiomeStructuralVariantReviewPaint = "true";
}

function drawMinimap() {
  const width = 184;
  const height = 116;
  const x = 16;
  const y = canvas.height - height - 16;
  const scaleX = width / arena.worldWidth;
  const scaleY = height / arena.worldHeight;
  context.save();
  context.fillStyle = "rgba(2,5,4,.84)";
  context.strokeStyle = rgba(profile.palette.line, 0.65);
  context.lineWidth = 2;
  roundedPath(context, x, y, width, height, 10);
  context.fill();
  context.stroke();
  for (const connection of arena.connections) {
    const from = arena.rooms.find((room) => room.id === connection.from);
    const to = arena.rooms.find((room) => room.id === connection.to);
    if (!from?.discovered && !to?.discovered) continue;
    context.strokeStyle = connection.locked ? rgba(profile.palette.hostile, 0.42) : rgba(profile.palette.accent, 0.55);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x + (from.column + 0.5) * arena.tileWidth * scaleX, y + (from.row + 0.5) * arena.tileHeight * scaleY);
    context.lineTo(x + (to.column + 0.5) * arena.tileWidth * scaleX, y + (to.row + 0.5) * arena.tileHeight * scaleY);
    context.stroke();
  }
  if (!artReviewMode) for (const room of arena.rooms) {
    if (!room.discovered && room.locked) continue;
    context.fillStyle = room.final ? profile.palette.hostile : room.status === "complete" ? profile.palette.accent : profile.palette.ambient;
    context.globalAlpha = room.discovered ? 0.9 : 0.3;
    context.fillRect(x + room.left * arena.tileWidth * scaleX, y + room.top * arena.tileHeight * scaleY, Math.max(3, room.width * arena.tileWidth * scaleX), Math.max(3, room.height * arena.tileHeight * scaleY));
  }
  context.globalAlpha = 1;
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(x + player.x * scaleX, y + player.y * scaleY, 3, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "rgba(236,255,249,.72)";
  context.font = "700 9px ui-monospace,monospace";
  context.fillText(`WORLD ${arena.columns}×${arena.rows}`, x + 8, y + 12);
  context.restore();
}

function drawAttractMode() {
  context.fillStyle = "#07100e"; context.fillRect(0, 0, canvas.width, canvas.height);
  const gradient = context.createRadialGradient(canvas.width / 2, canvas.height / 2, 20, canvas.width / 2, canvas.height / 2, 360);
  gradient.addColorStop(0, "#174b3d"); gradient.addColorStop(1, "#07100e"); context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center"; context.fillStyle = "#ecfff9"; context.font = "700 42px Inter,system-ui"; context.fillText("ENTER A DETERMINISTIC MAP", canvas.width / 2, canvas.height / 2 - 20);
  context.fillStyle = "#8ca79f"; context.font = "18px Inter,system-ui"; context.fillText("Character seed fixes the loadout. Map seed fixes rooms, missions, shops and bosses.", canvas.width / 2, canvas.height / 2 + 24); context.textAlign = "left";
}

function drawArena() {
  const palette = profile.palette;
  const useForgeArt = profile.biome === "industrial-forge";
  const useSignalCryptKit = profile.biome === "occult-machine-catacomb";
  const continuousFloor = useForgeArt ? forgeFloorPattern(palette) : null;
  const continuousWall = useForgeArt ? forgeWallPattern(palette) : null;
  context.fillStyle = "#020504";
  context.fillRect(0, 0, arena.worldWidth, arena.worldHeight);
  if (authoredSurfaceRuntime) authoredSurfaceRuntime.draw(context, {
    left: camera.x - arena.tileWidth,
    top: camera.y - arena.tileHeight,
    right: camera.x + canvas.width + arena.tileWidth,
    bottom: camera.y + canvas.height + arena.tileHeight,
  });
  const startColumn = Math.max(0, Math.floor(camera.x / arena.tileWidth) - 1);
  const endColumn = Math.min(arena.columns, Math.ceil((camera.x + canvas.width) / arena.tileWidth) + 1);
  const startRow = Math.max(0, Math.floor(camera.y / arena.tileHeight) - 1);
  const endRow = Math.min(arena.rows, Math.ceil((camera.y + canvas.height) / arena.tileHeight) + 1);
  for (let row = startRow; row < endRow; row += 1) for (let column = startColumn; column < endColumn; column += 1) {
    const tile = arena.tiles[row * arena.columns + column];
    const x = column * arena.tileWidth, y = row * arena.tileHeight;
    if (tile.kind === "wall") {
      if (useSignalCryptKit) {
        drawSignalCryptWall(tile, x, y, column, row);
        continue;
      }
      context.fillStyle = continuousWall ?? (tile.variant % 2 ? rgba(palette.line, 0.62) : rgba(palette.floor2, 0.92));
      context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
      const wallNoise = 0.025 + tile.materialBand * 0.008;
      context.fillStyle = rgba(palette.accent, wallNoise);
      if ((tile.variant + column + row) % 5 === 0) context.fillRect(x + 11, y + 11, arena.tileWidth - 22, arena.tileHeight - 22);
      const edgeDepth = 15;
      const edgeLine = 4;
      const drawWallEdge = (bit, edgeX, edgeY, edgeWidth, edgeHeight, lineX, lineY, lineWidth, lineHeight) => {
        if (!(tile.exposureMask & bit)) return;
        context.fillStyle = rgba(palette.floor, 0.92);
        context.fillRect(edgeX, edgeY, edgeWidth, edgeHeight);
        context.fillStyle = rgba(palette.accent, 0.72);
        context.fillRect(lineX, lineY, lineWidth, lineHeight);
      };
      drawWallEdge(1, x, y, arena.tileWidth, edgeDepth, x, y + edgeDepth - edgeLine, arena.tileWidth, edgeLine);
      drawWallEdge(2, x + arena.tileWidth - edgeDepth, y, edgeDepth, arena.tileHeight, x + arena.tileWidth - edgeDepth, y, edgeLine, arena.tileHeight);
      drawWallEdge(4, x, y + arena.tileHeight - edgeDepth, arena.tileWidth, edgeDepth, x, y + arena.tileHeight - edgeDepth, arena.tileWidth, edgeLine);
      drawWallEdge(8, x, y, edgeDepth, arena.tileHeight, x + edgeDepth - edgeLine, y, edgeLine, arena.tileHeight);
      if (tile.exposureMask) {
        if (tile.wallFamily === "bulkhead") {
          context.strokeStyle = rgba(palette.line, 0.3);
          context.lineWidth = 2;
          context.strokeRect(x + 20, y + 20, arena.tileWidth - 40, arena.tileHeight - 40);
        } else if (tile.wallFamily === "ribbed") {
          context.fillStyle = rgba(palette.line, 0.26);
          if (tile.exposureMask & (1 | 4)) {
            for (let rib = 0; rib < 3; rib += 1) context.fillRect(x + 15 + rib * 17, y + 8, 4, arena.tileHeight - 16);
          } else {
            for (let rib = 0; rib < 3; rib += 1) context.fillRect(x + 8, y + 15 + rib * 17, arena.tileWidth - 16, 4);
          }
        } else {
          context.strokeStyle = rgba(palette.accent, 0.42);
          context.lineWidth = 4;
          context.beginPath();
          if (tile.wallMask & 8) context.moveTo(x, y + arena.tileHeight / 2);
          else context.moveTo(x + arena.tileWidth / 2, y + arena.tileHeight / 2);
          if (tile.wallMask & 2) context.lineTo(x + arena.tileWidth, y + arena.tileHeight / 2);
          else context.lineTo(x + arena.tileWidth / 2, y + arena.tileHeight / 2);
          if (tile.wallMask & 1) { context.moveTo(x + arena.tileWidth / 2, y); context.lineTo(x + arena.tileWidth / 2, y + arena.tileHeight / 2); }
          if (tile.wallMask & 4) { context.moveTo(x + arena.tileWidth / 2, y + arena.tileHeight / 2); context.lineTo(x + arena.tileWidth / 2, y + arena.tileHeight); }
          context.stroke();
          context.fillStyle = rgba(palette.accent, 0.62);
          context.fillRect(x + arena.tileWidth / 2 - 4, y + arena.tileHeight / 2 - 4, 8, 8);
        }
        const cornerPost = (enabled, postX, postY) => {
          if (!enabled) return;
          context.fillStyle = rgba(palette.line, 0.94);
          context.fillRect(postX, postY, 12, 12);
          context.fillStyle = rgba(palette.accent, 0.48);
          context.fillRect(postX + 3, postY + 3, 6, 6);
        };
        cornerPost(tile.wallCornerMask & 1, x + arena.tileWidth - 12, y);
        cornerPost(tile.wallCornerMask & 2, x + arena.tileWidth - 12, y + arena.tileHeight - 12);
        cornerPost(tile.wallCornerMask & 4, x, y + arena.tileHeight - 12);
        cornerPost(tile.wallCornerMask & 8, x, y);
      }
      if (tile.exposureMask && (column + row + tile.variant) % 4 === 0) {
        context.fillStyle = rgba(palette.ambient, 0.72);
        context.fillRect(x + arena.tileWidth / 2 - 2, y + arena.tileHeight / 2 - 2, 4, 4);
      }
      if (!continuousWall) {
        const roleColumn = ({ island: 0, cap: 0, straight: 1, corner: 2, "t-junction": 3, cross: 3 })[tile.wallJoinRole] ?? 0;
        context.globalAlpha = 0.82;
        drawForgeCell(roleColumn, 1, x, y, arena.tileWidth, arena.tileHeight, palette.line, true);
        context.globalAlpha = 1;
      }
    } else if (tile.kind === "door") {
      if (useSignalCryptKit) {
        drawSignalCryptFloor(tile, x, y);
        // Door tiles only carry the registered threshold. The complete five
        // cell gate is composed once below from cap/inner/mechanism roles.
        context.fillStyle = rgba(palette.line, 0.1);
        if (tile.doorAxis === "horizontal") context.fillRect(x, y + arena.tileHeight * 0.38, arena.tileWidth, arena.tileHeight * 0.24);
        else context.fillRect(x + arena.tileWidth * 0.38, y, arena.tileWidth * 0.24, arena.tileHeight);
        continue;
      }
      context.fillStyle = continuousFloor ?? palette.floor;
      context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
      if (!continuousFloor) {
        context.globalAlpha = 0.64;
        drawForgeCell(4, 1, x, y, arena.tileWidth, arena.tileHeight, palette.accent, true);
        context.globalAlpha = 1;
      }
      context.fillStyle = rgba(palette.line, 0.13);
      if (tile.doorAxis === "horizontal") context.fillRect(x, y + arena.tileHeight * 0.43, arena.tileWidth, arena.tileHeight * 0.14);
      else context.fillRect(x + arena.tileWidth * 0.43, y, arena.tileWidth * 0.14, arena.tileHeight);
    } else {
      const terrainFill = tile.terrain === "water"
        ? rgba(palette.ambient, 0.58)
        : tile.terrain === "lava"
          ? rgba(palette.hostile, 0.64)
          : tile.terrain === "void"
            ? "rgba(0,0,0,.9)"
            : tile.terrain === "mist"
              ? rgba(palette.ambient, 0.31)
              : tile.kind === "corridor" ? palette.floor : tile.variant % 2 ? palette.floor2 : palette.floor;
      const authoredSurfaceReady = authoredSurfaceRuntime?.hasReadySurfaceFor(column, row) ?? false;
      if (useSignalCryptKit && !authoredSurfaceReady) drawSignalCryptFloor(tile, x, y);
      else if (useSignalCryptKit) drawSignalCryptTerrainOverlay(tile, x, y);
      else if (!authoredSurfaceReady) {
        context.fillStyle = continuousFloor && tile.terrain === "dry" ? continuousFloor : terrainFill;
        context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
      } else if (tile.terrain !== "dry") {
        context.fillStyle = terrainFill;
        context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
      }
      if (!authoredSurfaceReady && !useSignalCryptKit && !continuousFloor) {
        context.globalAlpha = 0.72;
        drawForgeCell((tile.adjacencyMask + tile.materialBand) % 6, 0, x, y, arena.tileWidth, arena.tileHeight, tile.terrain === "water" || tile.terrain === "mist" ? palette.ambient : tile.terrain === "lava" ? palette.hostile : palette.floor2, true);
        context.globalAlpha = 1;
      }
      if (!authoredSurfaceReady) drawFloorVariation(tile, x, y, column, row);
      if (tile.terrain === "water") {
        context.strokeStyle = rgba(palette.accent, 0.2 + Math.sin(elapsed * 0.002 + column * 0.7 + row) * 0.08);
        context.beginPath();
        context.moveTo(x + 7, y + arena.tileHeight * 0.55);
        context.quadraticCurveTo(x + arena.tileWidth * 0.5, y + arena.tileHeight * 0.42, x + arena.tileWidth - 7, y + arena.tileHeight * 0.55);
        context.stroke();
      }
      if (tile.terrain === "lava") {
        const phase = elapsed * 0.003 + column * 0.73 + row * 0.41;
        context.fillStyle = rgba(palette.hostile, 0.16 + Math.sin(phase) * 0.06);
        context.fillRect(x + 4, y + 4, arena.tileWidth - 8, arena.tileHeight - 8);
        context.strokeStyle = rgba(palette.accent, 0.5 + Math.sin(phase * 1.7) * 0.14);
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(x + 5, y + 18 + Math.sin(phase) * 5);
        context.bezierCurveTo(x + 20, y + 5, x + 42, y + 54, x + arena.tileWidth - 5, y + 31 + Math.cos(phase) * 6);
        context.stroke();
      } else if (tile.terrain === "void") {
        context.fillStyle = rgba(palette.ambient, 0.38 + Math.sin(elapsed * 0.002 + tile.variant) * 0.1);
        for (let mote = 0; mote < 3; mote += 1) {
          const moteX = 8 + (hash32(`${run.seed}:${layer}:${column}:${row}:void:${mote}:x`) % 48);
          const moteY = 8 + ((hash32(`${run.seed}:${layer}:${column}:${row}:void:${mote}:y`) + Math.floor(elapsed / 90)) % 48);
          context.fillRect(x + moteX, y + moteY, mote ? 2 : 3, mote ? 2 : 3);
        }
      } else if (tile.terrain === "mist") {
        const drift = (elapsed * 0.015 + hash32(`${run.seed}:${column}:${row}:mist`) % 24) % 36;
        const mist = context.createLinearGradient(x - 12 + drift, y, x + 40 + drift, y + arena.tileHeight);
        mist.addColorStop(0, "rgba(255,255,255,0)");
        mist.addColorStop(0.5, rgba(palette.ambient, 0.24));
        mist.addColorStop(1, "rgba(255,255,255,0)");
        context.fillStyle = mist;
        context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
      }
      if (tile.elevation > 0) {
        context.fillStyle = `rgba(255,255,255,${0.025 * tile.elevation})`;
        context.fillRect(x, y, arena.tileWidth, arena.tileHeight);
        if (!tile.features?.includes("ramp") && !tile.features?.includes("bridge")) {
          context.strokeStyle = rgba(palette.line, 0.16 + tile.elevation * 0.08);
          context.lineWidth = tile.elevation * 2;
          context.strokeRect(x + 2, y + 2, arena.tileWidth - 4, arena.tileHeight - 4);
        }
      }
      if (tile.features?.includes("cliff")) {
        if (useSignalCryptKit) drawTilekitCell(signalCryptTilekit, "crypt-kit", 3, 3, x, y, arena.tileWidth, arena.tileHeight, palette.line, ({ north: 0, east: 1, south: 2, west: 3 })[tile.cliffDirection] ?? 0, 0.92);
        else {
          context.fillStyle = rgba(palette.floor, 0.84);
          if (tile.cliffDirection === "north") context.fillRect(x, y, arena.tileWidth, 12 + tile.elevation * 4);
          if (tile.cliffDirection === "south") context.fillRect(x, y + arena.tileHeight - 12 - tile.elevation * 4, arena.tileWidth, 12 + tile.elevation * 4);
          if (tile.cliffDirection === "west") context.fillRect(x, y, 12 + tile.elevation * 4, arena.tileHeight);
          if (tile.cliffDirection === "east") context.fillRect(x + arena.tileWidth - 12 - tile.elevation * 4, y, 12 + tile.elevation * 4, arena.tileHeight);
        }
      }
      const bridgeRamp = tile.features?.includes("bridge-ramp") || (tile.features?.includes("ramp") && tile.features?.includes("bridge"));
      if (tile.features?.includes("ramp") && !bridgeRamp) {
        if (useSignalCryptKit) drawSignalCryptRamp(tile, x, y);
        else {
          context.strokeStyle = rgba(palette.accent, 0.66);
          context.lineWidth = 3;
          for (let step = 1; step < 4; step += 1) {
            context.beginPath();
            if (["east", "west"].includes(tile.rampDirection)) {
              context.moveTo(x + step * 16, y + 8);
              context.lineTo(x + step * 16, y + arena.tileHeight - 8);
            } else {
              context.moveTo(x + 8, y + step * 16);
              context.lineTo(x + arena.tileWidth - 8, y + step * 16);
            }
            context.stroke();
          }
        }
      }
      if (tile.features?.includes("bridge")) {
        const dynamic = tile.features.includes("dynamic-bridge");
        const powered = !dynamic || dynamicBridgePowered(tile);
        if (!useSignalCryptKit) {
          context.fillStyle = rgba(dynamic ? (powered ? palette.accent : palette.hostile) : palette.line, dynamic ? (powered ? 0.58 : 0.18) + Math.sin(elapsed * 0.007 + column + row) * 0.12 : 0.72);
          context.fillRect(x + 5, y + 5, arena.tileWidth - 10, arena.tileHeight - 10);
          context.strokeStyle = rgba(powered ? palette.accent : palette.hostile, dynamic ? 0.95 : 0.55);
          context.lineWidth = dynamic ? 4 : 2;
          context.strokeRect(x + 7, y + 7, arena.tileWidth - 14, arena.tileHeight - 14);
        }
      }
      if (tile.kind === "corridor") {
        context.strokeStyle = rgba(palette.line, 0.42);
        context.lineWidth = 2;
        if (!(tile.walkableMask & 1)) { context.beginPath(); context.moveTo(x, y + 1); context.lineTo(x + arena.tileWidth, y + 1); context.stroke(); }
        if (!(tile.walkableMask & 2)) { context.beginPath(); context.moveTo(x + arena.tileWidth - 1, y); context.lineTo(x + arena.tileWidth - 1, y + arena.tileHeight); context.stroke(); }
        if (!(tile.walkableMask & 4)) { context.beginPath(); context.moveTo(x, y + arena.tileHeight - 1); context.lineTo(x + arena.tileWidth, y + arena.tileHeight - 1); context.stroke(); }
        if (!(tile.walkableMask & 8)) { context.beginPath(); context.moveTo(x + 1, y); context.lineTo(x + 1, y + arena.tileHeight); context.stroke(); }
      }
      if (useSignalCryptKit && tile.variant === 3) { context.fillStyle = rgba(palette.accent, 0.11); context.fillRect(x + arena.tileWidth * 0.43, y + arena.tileHeight * 0.43, arena.tileWidth * 0.14, arena.tileHeight * 0.14); }
    }
  }
  if (useSignalCryptKit) {
    const bridgeIds = new Set(arena.tiles.filter((tile) => tile.bridgeId && tile.features?.includes("bridge")).map((tile) => tile.bridgeId));
    for (const bridgeId of bridgeIds) drawSignalCryptBridgeAssembly(bridgeId);
  }
  for (const connection of arena.connections) {
    const door = connection.door;
    const axis = door.axis ?? arena.tiles[door.row * arena.columns + door.column]?.doorAxis ?? "horizontal";
    const span = door.span ?? door.tiles.length;
    const forcedDoorProgressValue = launchParams.get("doorReviewProgress");
    const forcedDoorProgress = forcedDoorProgressValue == null ? null : clamp(Number.parseFloat(forcedDoorProgressValue), 0, 1);
    const locked = forcedDoorProgress == null ? connection.locked !== false : false;
    const openProgress = forcedDoorProgress ?? (locked ? 0 : clamp((elapsed - (connection.openedAt ?? elapsed)) / 680, 0, 1));
    const easedOpen = openProgress * openProgress * (3 - 2 * openProgress);
    const first = door.tiles[0];
    const gateX = (axis === "vertical" ? first.column : door.column) * arena.tileWidth;
    const gateY = (axis === "horizontal" ? first.row : door.row) * arena.tileHeight;
    const gateWidth = axis === "vertical" ? span * arena.tileWidth : arena.tileWidth;
    const gateHeight = axis === "horizontal" ? span * arena.tileHeight : arena.tileHeight;
    if (gateX + gateWidth < camera.x - arena.tileWidth || gateY + gateHeight < camera.y - arena.tileHeight || gateX > camera.x + canvas.width + arena.tileWidth || gateY > camera.y + canvas.height + arena.tileHeight) continue;
    context.save();
    // The threshold remains real traversable floor in every gate state. Panels
    // close over it; they never replace it with a black review slab.
    context.fillStyle = palette.floor;
    context.fillRect(gateX + 3, gateY + 3, gateWidth - 6, gateHeight - 6);
    if (useSignalCryptKit) fillSignalMaterial(0, 0, palette.floor, gateX + 3, gateY + 3, gateWidth - 6, gateHeight - 6, 0.34);
    const drawGatePanel = (panelX, panelY, panelWidth, panelHeight) => {
      if (panelWidth <= 0.5 || panelHeight <= 0.5) return;
      context.fillStyle = useSignalCryptKit ? mixColor(palette.floor2, palette.line, 0.18) : continuousWall ?? palette.floor2;
      context.fillRect(panelX, panelY, panelWidth, panelHeight);
      if (useSignalCryptKit) {
        fillSignalMaterial(axis === "horizontal" ? 0 : 2, 3, palette.line, panelX, panelY, panelWidth, panelHeight, 0.76);
      }
      context.strokeStyle = rgba(locked ? palette.hostile : palette.accent, 0.58);
      context.lineWidth = 2;
      context.strokeRect(panelX + 1.5, panelY + 1.5, Math.max(0, panelWidth - 3), Math.max(0, panelHeight - 3));
      context.fillStyle = rgba(palette.line, 0.34);
      const ribs = Math.max(1, Math.floor((axis === "horizontal" ? panelHeight : panelWidth) / arena.tileWidth));
      for (let rib = 1; rib < ribs; rib += 1) {
        if (axis === "horizontal") context.fillRect(panelX, panelY + rib * arena.tileHeight, panelWidth, 2);
        else context.fillRect(panelX + rib * arena.tileWidth, panelY, 2, panelHeight);
      }
      if (!continuousWall && !useSignalCryptKit) {
        context.save();
        context.globalAlpha = 0.78;
        context.drawImage(forgeSprite(locked ? 5 : 4, 1, locked ? palette.hostile : palette.accent, true), panelX, panelY, panelWidth, panelHeight);
        context.restore();
      }
      if (useSignalCryptKit) {
        context.fillStyle = rgba(palette.line, 0.08);
        const inset = 10;
        context.fillRect(panelX + inset, panelY + inset, Math.max(0, panelWidth - inset * 2), Math.max(0, panelHeight - inset * 2));
        context.strokeStyle = rgba(palette.line, 0.34);
        context.lineWidth = 1;
        context.strokeRect(panelX + inset + 1, panelY + inset + 1, Math.max(0, panelWidth - inset * 2 - 2), Math.max(0, panelHeight - inset * 2 - 2));
      }
    };
    if (axis === "horizontal") {
      const panelHeight = (gateHeight - 10) * 0.5 * (1 - easedOpen);
      drawGatePanel(gateX + 5, gateY + 5, gateWidth - 10, panelHeight);
      drawGatePanel(gateX + 5, gateY + gateHeight - 5 - panelHeight, gateWidth - 10, panelHeight);
      context.fillStyle = rgba(palette.line, 0.96);
      context.fillRect(gateX, gateY, 7, gateHeight);
      context.fillRect(gateX + gateWidth - 7, gateY, 7, gateHeight);
      if (useSignalCryptKit) {
        fillSignalMaterial(0, 3, palette.line, gateX, gateY, 7, gateHeight, 0.52);
        fillSignalMaterial(0, 3, palette.line, gateX + gateWidth - 7, gateY, 7, gateHeight, 0.52);
      }
    } else {
      const panelWidth = (gateWidth - 10) * 0.5 * (1 - easedOpen);
      drawGatePanel(gateX + 5, gateY + 5, panelWidth, gateHeight - 10);
      drawGatePanel(gateX + gateWidth - 5 - panelWidth, gateY + 5, panelWidth, gateHeight - 10);
      context.fillStyle = rgba(palette.line, 0.96);
      context.fillRect(gateX, gateY, gateWidth, 7);
      context.fillRect(gateX, gateY + gateHeight - 7, gateWidth, 7);
      if (useSignalCryptKit) {
        fillSignalMaterial(2, 3, palette.line, gateX, gateY, gateWidth, 7, 0.52);
        fillSignalMaterial(2, 3, palette.line, gateX, gateY + gateHeight - 7, gateWidth, 7, 0.52);
      }
    }
    if (openProgress < 1) {
      context.globalCompositeOperation = "lighter";
      context.fillStyle = rgba(locked ? palette.hostile : palette.accent, 0.5 + Math.sin(elapsed * 0.009) * 0.14);
      context.beginPath();
      context.arc(gateX + gateWidth / 2, gateY + gateHeight / 2, locked ? 9 : 6, 0, Math.PI * 2);
      context.fill();
      if (useSignalCryptKit) {
        context.save();
        context.beginPath();
        context.arc(gateX + gateWidth / 2, gateY + gateHeight / 2, 17, 0, Math.PI * 2);
        context.clip();
        fillSignalMaterial(axis === "horizontal" ? 1 : 3, 3, locked ? palette.hostile : palette.accent, gateX + gateWidth / 2 - 17, gateY + gateHeight / 2 - 17, 34, 34, 0.82);
        context.restore();
        context.strokeStyle = rgba(locked ? palette.hostile : palette.accent, 0.86);
        context.lineWidth = 3;
        context.beginPath();
        context.arc(gateX + gateWidth / 2, gateY + gateHeight / 2, 17, 0, Math.PI * 2);
        context.stroke();
      }
    }
    context.restore();
  }
  if (!artReviewMode) for (const room of arena.rooms) {
    const roomX = (room.column + 0.5) * arena.tileWidth;
    const roomY = (room.row - room.halfHeight + 0.45) * arena.tileHeight;
    context.fillStyle = room.locked ? rgba(palette.hostile, 0.78) : room.status === "complete" ? rgba(palette.accent, 0.7) : rgba(palette.ambient, 0.52);
    context.font = "700 10px ui-monospace,monospace"; context.textAlign = "center";
    context.fillText(`${room.locked ? "LOCKED" : room.status === "complete" ? "CLEARED" : room.role.toUpperCase()} · ${room.design}`, roomX, roomY);
  }
  context.textAlign = "left";
  if (profile.effects.some((effect) => effect.includes("motes") || effect.includes("dust") || effect.includes("embers") || effect.includes("specks"))) {
    context.fillStyle = rgba(palette.ambient, 0.38); for (let index = 0; index < 42; index += 1) { const x = (index * 397 + elapsed * 0.018) % arena.worldWidth; const y = (index * 283 + Math.sin(elapsed * 0.0007 + index) * 38 + arena.worldHeight) % arena.worldHeight; context.fillRect(x, y, index % 3 ? 2 : 3, index % 3 ? 2 : 3); }
  }
}

function drawExit() {
  const { x, y } = arena.exit;
  context.save();
  context.translate(x, y);
  context.globalCompositeOperation = "lighter";
  context.strokeStyle = exitActive ? profile.palette.accent : rgba(profile.palette.hostile, 0.28);
  context.fillStyle = exitActive ? rgba(profile.palette.accent, 0.2) : "rgba(0,0,0,.28)";
  context.lineWidth = exitActive ? 5 : 2;
  context.beginPath();
  context.arc(0, 0, 21 + (exitActive ? Math.sin(elapsed * 0.008) * 4 : 0), 0, Math.PI * 2);
  context.fill(); context.stroke();
  if (exitActive) {
    context.rotate(elapsed * 0.0014);
    context.setLineDash([8, 10]);
    context.beginPath(); context.arc(0, 0, 31, 0, Math.PI * 2); context.stroke();
  }
  context.restore();
}

function lightTileVisible(light, column, row) {
  const targetX = (column + 0.5) * arena.tileWidth;
  const targetY = (row + 0.5) * arena.tileHeight;
  const steps = Math.max(2, Math.ceil(Math.hypot(targetX - light.x, targetY - light.y) / (arena.tileWidth * 0.42)));
  for (let step = 1; step <= steps; step += 1) {
    const amount = step / steps;
    const sampleColumn = Math.floor(lerp(light.x, targetX, amount) / arena.tileWidth);
    const sampleRow = Math.floor(lerp(light.y, targetY, amount) / arena.tileHeight);
    const sample = arena.tiles[sampleRow * arena.columns + sampleColumn];
    if (!sample || sample.kind === "wall") return false;
    if (sample.kind === "door") {
      const connection = arena.connections.find((candidate) => candidate.door.tiles.some((point) => point.column === sampleColumn && point.row === sampleRow));
      if (connection && !doorApertureIsPassable(connection)) return false;
    }
  }
  return true;
}

function drawWorldLighting() {
  if (!arena || artReviewMode) return;
  const sources = arena.objects
    .filter((object) => object.feature === "tower" || ["relay", "terminal", "coil", "puzzle-node"].includes(object.type))
    .map((object) => ({
      x: object.x,
      y: object.y - (object.feature === "tower" ? object.radius * 0.45 : 0),
      radius: object.feature === "tower" ? 220 : 130,
      color: object.state === "dormant" ? profile.palette.ambient : profile.palette.accent,
      strength: object.feature === "tower" ? 0.22 : 0.12,
    }));
  if (exitActive) sources.push({ x: arena.exit.x, y: arena.exit.y, radius: 160, color: profile.palette.accent, strength: 0.16 });
  for (const light of sources) {
    const left = Math.max(0, Math.floor((light.x - light.radius) / arena.tileWidth));
    const right = Math.min(arena.columns - 1, Math.ceil((light.x + light.radius) / arena.tileWidth));
    const top = Math.max(0, Math.floor((light.y - light.radius) / arena.tileHeight));
    const bottom = Math.min(arena.rows - 1, Math.ceil((light.y + light.radius) / arena.tileHeight));
    context.save();
    context.beginPath();
    for (let row = top; row <= bottom; row += 1) for (let column = left; column <= right; column += 1) {
      const tile = arena.tiles[row * arena.columns + column];
      if (!tile || tile.kind === "wall" || !lightTileVisible(light, column, row)) continue;
      context.rect(column * arena.tileWidth, row * arena.tileHeight, arena.tileWidth, arena.tileHeight);
    }
    context.clip();
    context.globalCompositeOperation = "screen";
    const gradient = context.createRadialGradient(light.x, light.y, 2, light.x, light.y, light.radius);
    gradient.addColorStop(0, rgba(light.color, light.strength));
    gradient.addColorStop(0.35, rgba(light.color, light.strength * 0.52));
    gradient.addColorStop(1, rgba(light.color, 0));
    context.fillStyle = gradient;
    context.fillRect(light.x - light.radius, light.y - light.radius, light.radius * 2, light.radius * 2);
    context.restore();
  }
}

function drawSignalCryptObject(object, pulse) {
  const radius = object.radius;
  context.fillStyle = "rgba(0,0,0,.38)";
  context.beginPath(); context.ellipse(5, radius * 0.8, radius * 1.25, radius * 0.42, 0, 0, Math.PI * 2); context.fill();
  if (object.feature === "foliage") {
    context.rotate(Math.sin(elapsed * 0.0016 + object.variant) * 0.05);
    context.fillStyle = rgba(profile.palette.floor2, 0.9);
    context.strokeStyle = rgba(profile.palette.line, 0.5);
    context.lineWidth = 2;
    const fronds = 3 + (object.variant % 3);
    for (let frond = 0; frond < fronds; frond += 1) {
      context.save(); context.rotate((frond / fronds) * Math.PI * 2 + object.variant * 0.21);
      context.beginPath(); context.moveTo(-4, 1); context.quadraticCurveTo(-radius * 0.72, -radius * 0.7, 0, -radius * 1.15); context.quadraticCurveTo(radius * 0.5, -radius * 0.56, 4, 1); context.closePath(); context.fill(); context.stroke(); context.restore();
    }
    context.fillStyle = rgba(profile.palette.ambient, 0.58);
    context.beginPath(); context.arc(0, 0, Math.max(4, radius * 0.2), 0, Math.PI * 2); context.fill();
    return;
  }
  if (object.feature === "tower") {
    context.fillStyle = mixColor(profile.palette.floor2, "#020404", 0.36);
    context.beginPath(); context.moveTo(-radius, radius * 0.55); context.lineTo(-radius * 0.72, -radius * 0.5); context.lineTo(0, -radius); context.lineTo(radius * 0.72, -radius * 0.5); context.lineTo(radius, radius * 0.55); context.lineTo(radius * 0.76, radius); context.lineTo(-radius * 0.76, radius); context.closePath(); context.fill();
    context.strokeStyle = rgba(profile.palette.line, 0.68); context.lineWidth = 2; context.stroke();
    context.fillStyle = rgba(profile.palette.line, 0.16); context.fillRect(-radius * 0.58, -radius * 0.28, radius * 1.16, radius * 0.62);
    context.globalCompositeOperation = "lighter";
    const lamp = context.createRadialGradient(0, -radius * 0.48, 1, 0, -radius * 0.48, 11 + pulse * 4);
    lamp.addColorStop(0, "rgba(255,255,255,.95)"); lamp.addColorStop(0.32, rgba(profile.palette.accent, 0.82)); lamp.addColorStop(1, rgba(profile.palette.accent, 0));
    context.fillStyle = lamp; context.beginPath(); context.arc(0, -radius * 0.48, 12 + pulse * 4, 0, Math.PI * 2); context.fill();
    return;
  }
  if (object.type === "cache") {
    const w = radius * 2.25, h = radius * 1.35, depth = Math.max(7, radius * 0.42);
    context.fillStyle = mixColor(profile.palette.floor2, "#020404", 0.28); context.fillRect(-w / 2, -h / 2, w, h);
    fillSignalMaterial(2, 2, profile.palette.line, object.x - w / 2, object.y - h / 2, w, h, 0.58);
    context.fillStyle = mixColor(profile.palette.floor2, "#000000", 0.45);
    context.beginPath(); context.moveTo(-w / 2, h / 2); context.lineTo(w / 2, h / 2); context.lineTo(w / 2 - depth, h / 2 + depth); context.lineTo(-w / 2 + depth, h / 2 + depth); context.closePath(); context.fill();
    context.strokeStyle = rgba(profile.palette.line, 0.72); context.lineWidth = 2; context.strokeRect(-w / 2, -h / 2, w, h);
    context.fillStyle = rgba(object.state === "open" ? profile.palette.accent : profile.palette.ambient, 0.76); context.fillRect(-5, -3, 10, 7);
    return;
  }
  const sides = object.type === "puzzle-node" ? 6 : object.type === "coil" ? 8 : 4;
  context.fillStyle = mixColor(profile.palette.floor2, "#020404", 0.3);
  polygon(context, sides, radius * 1.08); context.fill();
  context.strokeStyle = rgba(profile.palette.line, 0.7); context.lineWidth = 2; context.stroke();
  context.save(); context.translate(0, -6); context.fillStyle = rgba(profile.palette.line, 0.15); polygon(context, sides, radius * 0.7); context.fill(); context.restore();
  context.globalCompositeOperation = "lighter";
  context.fillStyle = rgba(object.state === "dormant" ? profile.palette.ambient : profile.palette.accent, 0.56 + pulse * 0.28);
  context.beginPath(); context.arc(0, -6, Math.max(4, radius * 0.23), 0, Math.PI * 2); context.fill();
}

function drawObjects() {
  for (const object of arena.objects) {
    const pulse = object.animation === "static" ? 0 : (Math.sin(elapsed * 0.006 + object.variant) + 1) / 2;
    context.save(); context.translate(object.x, object.y); context.strokeStyle = rgba(profile.palette.accent, 0.4 + pulse * 0.25); context.fillStyle = rgba(profile.palette.line, 0.75); context.lineWidth = 3;
    if (profile.biome === "occult-machine-catacomb") {
      drawSignalCryptObject(object, pulse);
      context.restore();
      continue;
    }
    if (object.feature === "foliage") {
      context.rotate(Math.sin(elapsed * 0.0018 + object.variant) * 0.12);
      context.fillStyle = rgba(profile.palette.ambient, 0.52 + pulse * 0.2);
      context.strokeStyle = rgba(profile.palette.accent, 0.5);
      for (let frond = 0; frond < 4; frond += 1) {
        context.save(); context.rotate((frond / 4) * Math.PI * 2 + object.variant * 0.19);
        context.beginPath(); context.ellipse(0, -object.radius * 0.75, object.radius * 0.3, object.radius, 0, 0, Math.PI * 2); context.fill(); context.stroke();
        context.restore();
      }
      context.restore();
      continue;
    }
    if (object.feature === "tower") {
      context.fillStyle = rgba(profile.palette.floor2, 0.94);
      context.strokeStyle = rgba(profile.palette.line, 0.82);
      context.beginPath(); context.moveTo(-object.radius, object.radius); context.lineTo(-object.radius * 0.55, -object.radius); context.lineTo(object.radius * 0.55, -object.radius); context.lineTo(object.radius, object.radius); context.closePath(); context.fill(); context.stroke();
      context.globalCompositeOperation = "lighter";
      context.fillStyle = rgba(profile.palette.accent, 0.5 + pulse * 0.42);
      context.beginPath(); context.arc(0, -object.radius * 0.48, 4 + pulse * 3, 0, Math.PI * 2); context.fill();
      context.restore();
      continue;
    }
    {
      const sourceColumn = profile.biome === "industrial-forge"
        ? object.type === "cache" ? (object.state === "open" ? 1 : 0) : object.type === "relay" ? (object.state === "active" ? 3 : 2) : object.type === "terminal" ? 4 : 5
        : object.type === "cache" ? (object.state === "open" ? 4 : 3) : ["relay", "terminal", "coil", "puzzle-node"].includes(object.type) ? 5 : object.variant % 3;
      const scale = object.type === "cache" ? 3.5 : object.type === "relay" ? 3.1 : 3;
      const size = object.radius * scale;
      context.globalAlpha = object.state === "dormant" ? 0.68 : 0.96;
      context.translate(0, object.animation === "static" ? 0 : Math.sin(elapsed * 0.004 + object.variant) * 1.5);
      drawForgeCell(sourceColumn, 2, -size / 2, -size / 2, size, size, object.state === "open" || object.state === "active" ? profile.palette.accent : profile.palette.line);
      context.restore();
      continue;
    }
  }
}

function drawRelay() {
  if (!relay) return;
  context.save(); context.translate(relay.x, relay.y); context.globalCompositeOperation = "lighter";
  context.strokeStyle = rgba(profile.palette.accent, 0.55); context.lineWidth = 3;
  context.beginPath(); context.arc(0, 0, relay.radius + 8 + Math.sin(elapsed * 0.006) * 3, 0, Math.PI * 2); context.stroke();
  context.fillStyle = profile.palette.accent; polygon(context, 6, relay.radius); context.fill();
  context.fillStyle = "#ffffff"; context.beginPath(); context.arc(0, 0, 6, 0, Math.PI * 2); context.fill(); context.restore();
}

function drawWeaponCoreParticles(style, eyePoint, weaponPoint, coreStyle) {
  const dx = weaponPoint.x - eyePoint.x;
  const dy = weaponPoint.y - eyePoint.y;
  const length = Math.hypot(dx, dy) || 1;
  const tangent = { x: dx / length, y: dy / length };
  const normal = { x: -tangent.y, y: tangent.x };
  const phase = elapsed * 0.006;
  context.save();
  context.globalCompositeOperation = "lighter";
  context.shadowColor = coreStyle.glow;

  if (style === "energy-filaments") {
    context.lineCap = "round";
    for (let filament = -1; filament <= 1; filament += 1) {
      const bend = filament * 5 + Math.sin(phase * 1.7 + filament * 2.2) * 2.4;
      const middleX = eyePoint.x + dx * 0.5 + normal.x * bend;
      const middleY = eyePoint.y + dy * 0.5 + normal.y * bend;
      context.strokeStyle = filament === 0 ? rgba(coreStyle.core, 0.76) : rgba(coreStyle.glow, 0.48);
      context.lineWidth = filament === 0 ? 1.6 : 1;
      context.shadowBlur = filament === 0 ? 9 : 5;
      context.beginPath();
      context.moveTo(eyePoint.x, eyePoint.y);
      context.quadraticCurveTo(middleX, middleY, weaponPoint.x, weaponPoint.y);
      context.stroke();
    }
  } else if (style === "orbit-motes") {
    context.strokeStyle = rgba(coreStyle.glow, 0.22);
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(eyePoint.x, eyePoint.y); context.lineTo(weaponPoint.x, weaponPoint.y); context.stroke();
    context.shadowBlur = 8;
    for (let mote = 0; mote < 6; mote += 1) {
      const orbit = phase * (mote % 2 ? -1.35 : 1.1) + mote * Math.PI / 3;
      const radius = 11 + (mote % 3) * 3;
      const x = weaponPoint.x + Math.cos(orbit) * radius;
      const y = weaponPoint.y + Math.sin(orbit) * radius * 0.58;
      context.fillStyle = mote % 2 ? rgba(coreStyle.core, 0.92) : rgba(coreStyle.glow, 0.82);
      context.beginPath(); context.arc(x, y, 1.5 + (mote % 3) * 0.45, 0, Math.PI * 2); context.fill();
    }
  } else if (style === "ember-shards") {
    context.strokeStyle = rgba(coreStyle.glow, 0.18);
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(eyePoint.x, eyePoint.y); context.lineTo(weaponPoint.x, weaponPoint.y); context.stroke();
    context.shadowBlur = 7;
    for (let shard = 0; shard < 7; shard += 1) {
      const progress = (phase * 0.55 + shard / 7) % 1;
      const flutter = Math.sin(progress * Math.PI * 4 + shard) * 5 * Math.sin(progress * Math.PI);
      const x = eyePoint.x + dx * progress + normal.x * flutter;
      const y = eyePoint.y + dy * progress + normal.y * flutter;
      const size = 2 + (shard % 3) * 0.8;
      context.fillStyle = shard % 2 ? rgba(coreStyle.core, 0.9) : rgba(coreStyle.glow, 0.8);
      context.beginPath();
      context.moveTo(x + tangent.x * size * 1.8, y + tangent.y * size * 1.8);
      context.lineTo(x + normal.x * size, y + normal.y * size);
      context.lineTo(x - normal.x * size, y - normal.y * size);
      context.closePath(); context.fill();
    }
  } else if (style === "pulse-rings") {
    context.strokeStyle = rgba(coreStyle.glow, 0.16);
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(eyePoint.x, eyePoint.y); context.lineTo(weaponPoint.x, weaponPoint.y); context.stroke();
    context.shadowBlur = 8;
    for (let pulse = 0; pulse < 4; pulse += 1) {
      const progress = (phase * 0.42 + pulse / 4) % 1;
      const x = eyePoint.x + dx * progress;
      const y = eyePoint.y + dy * progress;
      const radius = 2.5 + Math.sin(progress * Math.PI) * 7;
      context.strokeStyle = rgba(pulse % 2 ? coreStyle.core : coreStyle.glow, 0.35 + (1 - progress) * 0.5);
      context.lineWidth = 1.1 + (1 - progress) * 1.2;
      context.beginPath();
      context.ellipse(x, y, Math.max(1.5, radius * 0.38), radius, Math.atan2(dy, dx), 0, Math.PI * 2);
      context.stroke();
    }
  } else {
    context.strokeStyle = rgba(coreStyle.glow, 0.42);
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(eyePoint.x, eyePoint.y); context.lineTo(weaponPoint.x, weaponPoint.y); context.stroke();
  }
  context.restore();
}

function drawPlayer() {
  const bob = Math.sin(elapsed * 0.005) * 4;
  const hurt = elapsed < player.flashUntil;
  context.save(); context.translate(player.x, player.y + 27); context.fillStyle = "rgba(0,0,0,.38)"; context.beginPath(); context.ellipse(0, 0, 27, 9, 0, 0, Math.PI * 2); context.fill(); context.restore();
  if (elapsed < player.shieldUntil) { context.strokeStyle = rgba(profile.palette.accent, 0.72); context.lineWidth = 3; context.beginPath(); context.arc(player.x, player.y + bob, 37 + Math.sin(elapsed * 0.012) * 3, 0, Math.PI * 2); context.stroke(); }
  const frame = directionOrder.indexOf(player.facing);
  if (player.boosting) {
    const hotspot = orbMaterialInputs.rearPortHotspots[player.facing], fallback = { x: player.x - player.aim.x * 25, y: player.y + bob - player.aim.y * 25 };
    const portPoint = hotspot ? { x: player.x + (hotspot.x - 17) * 2, y: player.y + bob + (hotspot.y - 17) * 2 } : fallback;
    let exhaust = normalized(portPoint.x - player.x, portPoint.y - (player.y + bob)); if (Math.hypot(exhaust.x, exhaust.y) < .1) exhaust = { x: -player.aim.x, y: -player.aim.y };
    const portStyle = ORB_PORT_LIGHTS[run.character.appearance.rearLight], coreStyle = ORB_LIGHT_STYLES[run.character.appearance.coreLight], boostStyle = portStyle?.linkedLight || !portStyle?.glow ? coreStyle : portStyle;
    context.save(); context.globalCompositeOperation = "lighter"; context.lineCap = "round"; context.strokeStyle = rgba(boostStyle.glow, .82); context.shadowColor = boostStyle.glow; context.shadowBlur = 12;
    for (let index = 0; index < 3; index += 1) { const length = 13 + index * 7 + Math.sin(elapsed * .03 + index) * 3; context.globalAlpha = .82 - index * .2; context.lineWidth = 4 - index; context.beginPath(); context.moveTo(portPoint.x, portPoint.y); context.lineTo(portPoint.x + exhaust.x * length, portPoint.y + exhaust.y * length); context.stroke(); }
    context.restore();
  }
  context.save(); context.globalAlpha = hurt && Math.floor(elapsed / 45) % 2 ? 0.35 : 1; context.drawImage(orbImage, frame * 34, 0, 34, 34, player.x - 34, player.y - 34 + bob, 68, 68); context.restore();
  const weapon = materializedWeapon(run.weapon);
  const hotspot = orbMaterialInputs.targets.hotspots?.[player.facing]?.weapon ?? orbMaterialInputs.targets.hotspots?.[player.facing]?.light;
  const eyePoint = hotspot
    ? { x: player.x + (hotspot.x - 17) * 2, y: player.y + (hotspot.y - 17) * 2 + bob }
    : { x: player.x + player.aim.x * 22, y: player.y + player.aim.y * 22 + bob };
  const weaponPoint = { x: player.x + player.aim.x * 58, y: player.y + player.aim.y * 58 + bob };
  if (player.chargeStartedAt !== null) {
    const charge = clamp((elapsed - player.chargeStartedAt) / run.weapon.chargeAttack.maximumChargeMs, 0, 1);
    context.save(); context.globalCompositeOperation = "lighter"; context.strokeStyle = charge >= 0.98 ? "#fff18a" : profile.palette.accent; context.lineWidth = 3 + charge * 6; context.globalAlpha = 0.45 + charge * 0.5; context.beginPath(); context.arc(weaponPoint.x, weaponPoint.y, 32 + charge * 18, -Math.PI / 2, -Math.PI / 2 + charge * Math.PI * 2); context.stroke(); context.restore();
  }
  if (!(run.weapon.id === "gyro" && player.gyroProjectileId !== null)) {
    const gyroHeldSpeed = vaultGyroAnimationSpeed({ held: player.shootHeldAt !== null, charging: player.chargeStartedAt !== null });
    context.save(); context.translate(weaponPoint.x, weaponPoint.y); if (run.weapon.id !== "gyro") context.rotate(Math.atan2(player.aim.y, player.aim.x)); context.drawImage(run.weapon.id === "gyro" ? currentGyroFrame(undefined, gyroHeldSpeed) : weapon, -26, -26, 52, 52); context.restore();
  }
  const coreStyle = ORB_LIGHT_STYLES[run.character.appearance.coreLight];
  const particleStyle = weaponBuildFor(run.weapon).attributes["core-particles"] ?? "none";
  context.save(); context.globalCompositeOperation = "lighter";
  const coreGlow = context.createRadialGradient(eyePoint.x, eyePoint.y, 0, eyePoint.x, eyePoint.y, 14);
  coreGlow.addColorStop(0, coreStyle.core); coreGlow.addColorStop(0.28, rgba(coreStyle.glow, 0.68)); coreGlow.addColorStop(1, "transparent");
  context.fillStyle = coreGlow; context.beginPath(); context.arc(eyePoint.x, eyePoint.y, 14, 0, Math.PI * 2); context.fill();
  context.restore();
  drawWeaponCoreParticles(particleStyle, eyePoint, weaponPoint, coreStyle);
  document.documentElement.dataset.vaultFacing = player.facing;
  document.documentElement.dataset.vaultOrbAppearance = `${run.character.appearance.shell}/${run.character.appearance.visor}/${run.character.appearance.coreLight}/${run.character.appearance.skin}`;
}

function enemyAnimationPose(enemy) {
  const hitAge = elapsed - (enemy.hitStartedAt ?? -Infinity);
  if (hitAge >= 0 && hitAge < 190) {
    const recoil = Math.sin((hitAge / 190) * Math.PI);
    return { scaleX: 1 + recoil * 0.13, scaleY: 1 - recoil * 0.18, rotation: (enemy.id % 2 ? -1 : 1) * recoil * 0.14, lift: -recoil * 3, state: "hit" };
  }
  const attackAge = elapsed - (enemy.attackStartedAt ?? -Infinity);
  if (attackAge >= 0 && attackAge < 620) {
    const charge = Math.sin(Math.min(1, attackAge / 620) * Math.PI);
    return { scaleX: 1 - charge * 0.09, scaleY: 1 + charge * 0.16, rotation: 0, lift: -charge * 4, state: "attack" };
  }
  if (elapsed < (enemy.motionUntil ?? 0)) {
    const cycle = (elapsed - (enemy.motionStartedAt ?? 0)) / 150 * Math.PI * 2;
    return { scaleX: 1 + Math.cos(cycle) * 0.035, scaleY: 1 - Math.cos(cycle) * 0.05, rotation: Math.sin(cycle) * 0.035, lift: -Math.abs(Math.sin(cycle)) * 3, state: "move" };
  }
  const idle = Math.sin(elapsed * 0.0035 + enemy.phase);
  return { scaleX: 1 + idle * 0.018, scaleY: 1 - idle * 0.018, rotation: 0, lift: idle * 1.4, state: "idle" };
}

function drawEnemySemanticFx(enemy, spriteSize, animationState) {
  const pulse = 0.5 + Math.sin(elapsed * 0.008 + enemy.phase) * 0.5;
  context.save();
  context.globalCompositeOperation = "lighter";
  if (enemy.type === "drifter") {
    context.fillStyle = rgba(enemy.partColors.core, 0.2 + pulse * 0.3);
    context.beginPath(); context.arc(0, 0, spriteSize * (animationState === "attack" ? 0.2 : 0.13), 0, Math.PI * 2); context.fill();
  } else if (enemy.type === "wisp") {
    context.strokeStyle = rgba(enemy.partColors.halo, 0.42 + pulse * 0.4);
    context.lineWidth = enemy.elite ? 5 : 3;
    context.beginPath(); context.arc(0, 0, spriteSize * (0.34 + pulse * 0.025), 0, Math.PI * 2); context.stroke();
    context.fillStyle = rgba(enemy.partColors.projectile, 0.8);
    for (let mote = 0; mote < (enemy.elite ? 4 : 3); mote += 1) {
      const angle = elapsed * 0.0025 + mote / (enemy.elite ? 4 : 3) * Math.PI * 2 + enemy.phase;
      context.beginPath(); context.arc(Math.cos(angle) * spriteSize * 0.42, Math.sin(angle) * spriteSize * 0.42, 2.5, 0, Math.PI * 2); context.fill();
    }
  } else if (enemy.type === "bulwark") {
    const facing = directionOrder.indexOf(enemy.facing) / directionOrder.length * Math.PI * 2 + Math.PI / 2;
    context.strokeStyle = rgba(enemy.partColors.shield, 0.52 + pulse * 0.28);
    context.lineWidth = enemy.tier === "miniboss" ? 8 : 5;
    context.beginPath(); context.arc(0, 0, spriteSize * 0.42, facing - 0.72, facing + 0.72); context.stroke();
    context.fillStyle = rgba(enemy.partColors.core, 0.28 + pulse * 0.35);
    context.beginPath(); context.arc(0, 0, spriteSize * 0.11, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}

function drawEnemies() {
  for (const enemy of enemies) {
    const flash = elapsed < (enemy.flashUntil ?? 0);
    context.save(); context.translate(enemy.x, enemy.y); context.globalAlpha = 0.96;
    context.fillStyle = "rgba(0,0,0,.32)"; context.beginPath(); context.ellipse(0, enemy.radius + 8, enemy.radius * 0.9, enemy.radius * 0.32, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = flash ? "#ffffff" : enemy.boss ? profile.palette.floor2 : profile.palette.hostile; context.strokeStyle = enemy.elite ? "#fff18a" : profile.palette.accent; context.lineWidth = enemy.boss ? 5 : 3;
    const enemyColumns = { drifter: 0, wisp: 1, lancer: 2, bulwark: 3 };
    const spriteColumn = enemy.boss ? ({ warden: 0, loom: 3, devourer: 5 }[enemy.type] ?? 0) : (enemyColumns[enemy.type] ?? 4);
    const spriteRow = enemy.boss ? 4 : 3;
    const spriteSize = enemy.radius * (enemy.boss ? 3.1 : enemy.type === "drifter" ? 4.15 : 3.5);
    context.globalAlpha = flash ? 0.46 : 1;
    context.translate(0, Math.sin(elapsed * 0.005 + enemy.phase) * (enemy.boss ? 2 : 1.5));
    const animationPose = enemy.boss ? { scaleX: 1, scaleY: 1, rotation: 0, lift: 0, state: "boss" } : enemyAnimationPose(enemy);
    context.translate(0, animationPose.lift);
    context.rotate(animationPose.rotation);
    context.scale(animationPose.scaleX, animationPose.scaleY);
    if (enemy.boss) drawForgeCell(spriteColumn, spriteRow, -spriteSize / 2, -spriteSize / 2, spriteSize, spriteSize, profile.palette.hostile);
    else context.drawImage(directionalEnemySprite(enemy), -spriteSize / 2, -spriteSize / 2, spriteSize, spriteSize);
    if (!enemy.boss) drawEnemySemanticFx(enemy, spriteSize, animationPose.state);
    if (flash && !enemy.boss) {
      context.globalCompositeOperation = "lighter";
      context.globalAlpha = 0.58;
      context.drawImage(directionalEnemySprite(enemy), -spriteSize / 2, -spriteSize / 2, spriteSize, spriteSize);
      context.globalCompositeOperation = "source-over";
    }
    context.globalAlpha = 1;
    if (enemy.tier === "heavy" || enemy.tier === "miniboss") {
      context.strokeStyle = enemy.tier === "miniboss" ? "#fff18a" : rgba(profile.palette.line, 0.9);
      context.lineWidth = enemy.tier === "miniboss" ? 5 : 3;
      context.setLineDash(enemy.tier === "miniboss" ? [8, 5] : []);
      context.beginPath();
      context.arc(0, 0, enemy.radius + (enemy.tier === "miniboss" ? 13 : 6), 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
    }
    if (enemy.tier === "miniboss") {
      context.globalCompositeOperation = "lighter";
      context.strokeStyle = rgba(profile.palette.hostile, 0.55 + Math.sin(elapsed * 0.007) * 0.2);
      context.lineWidth = 3;
      context.beginPath();
      context.arc(0, 0, enemy.radius + 22 + Math.sin(elapsed * 0.006) * 3, 0, Math.PI * 2);
      context.stroke();
      context.globalCompositeOperation = "source-over";
    }
    if (enemy.elite) { context.strokeStyle = "#fff18a"; context.beginPath(); context.arc(0, 0, enemy.radius + 6, 0, Math.PI * 2); context.stroke(); }
    if (enemy.boss) drawBossParts(enemy);
    context.restore();
    const width = enemy.boss ? 120 : enemy.radius * 2.2; context.fillStyle = "rgba(0,0,0,.5)"; context.fillRect(enemy.x - width / 2, enemy.y - enemy.radius - 15, width, 5); context.fillStyle = enemy.boss ? profile.palette.accent : profile.palette.hostile; context.fillRect(enemy.x - width / 2, enemy.y - enemy.radius - 15, width * clamp(enemy.health / enemy.maxHealth, 0, 1), 5);
    if (enemy.tier === "miniboss") { context.fillStyle = "#fff18a"; context.font = "800 10px ui-monospace,monospace"; context.textAlign = "center"; context.fillText("MINIBOSS", enemy.x, enemy.y - enemy.radius - 22); context.textAlign = "left"; }
  }
  for (const enemy of defeatedEnemies) {
    const progress = clamp((elapsed - enemy.deathStartedAt) / (enemy.deathUntil - enemy.deathStartedAt), 0, 1);
    const spriteSize = enemy.radius * 3.5;
    context.save();
    context.translate(enemy.x, enemy.y);
    context.globalAlpha = 1 - progress * 0.72;
    if (enemy.type !== "lancer") {
      context.rotate((enemy.id % 2 ? -1 : 1) * progress * 0.55);
      context.scale(1 - progress * 0.35, 1 - progress * 0.72);
      context.translate(0, progress * enemy.radius * 0.8);
    }
    context.drawImage(directionalEnemySprite(enemy), -spriteSize / 2, -spriteSize / 2, spriteSize, spriteSize);
    context.restore();
  }
  document.documentElement.dataset.vaultEnemyArt = `pixellabs-8dir-base-v1:${LANCER_ANIMATION_REVIEW}`;
  document.documentElement.dataset.vaultLancerAnimations = LANCER_ANIMATION_REVIEW;
  document.documentElement.dataset.vaultEnemyMotion = "idle/move/attack/hit/death-semantic-v1";
}

function polygon(ctx, sides, radius) { ctx.beginPath(); for (let index = 0; index < sides; index += 1) { const angle = index / sides * Math.PI * 2 - Math.PI / 2; ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius); } ctx.closePath(); }
function drawBossParts(enemy) {
  enemy.parts.forEach((part, index) => {
    if (!part.alive) return;
    const angle = part.angle + enemy.phase;
    const radius = enemy.radius * 0.76;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const size = index === 0 ? 28 : 23;
    drawForgeCell((index + 1) % 6, 4, x - size / 2, y - size / 2, size, size, part.color);
    context.strokeStyle = "#020504";
    context.lineWidth = 2;
    context.beginPath(); context.arc(x, y, size * 0.34, 0, Math.PI * 2); context.stroke();
  });
}

function drawProjectiles() {
  for (const projectile of projectiles) {
    context.save(); context.translate(projectile.x, projectile.y); context.fillStyle = projectile.hostile ? profile.palette.hostile : projectile.critical ? "#fff18a" : profile.palette.accent;
    if (projectile.weapon === "gyro") {
      const saw = currentGyroFrame(undefined, vaultGyroAnimationSpeed({ projectile: true, chargedProjectile: projectile.charged === true }));
      const coreStyle = ORB_LIGHT_STYLES[run.character.appearance.coreLight];
      context.save(); context.globalCompositeOperation = "lighter";
      const halo = context.createRadialGradient(0, 0, 2, 0, 0, projectile.radius * 1.9);
      halo.addColorStop(0, rgba(coreStyle.glow, 0.42)); halo.addColorStop(0.58, rgba(coreStyle.glow, 0.14)); halo.addColorStop(1, rgba(coreStyle.glow, 0));
      context.fillStyle = halo; context.beginPath(); context.arc(0, 0, projectile.radius * 1.9, 0, Math.PI * 2); context.fill(); context.restore();
      context.globalCompositeOperation = "source-over";
      context.drawImage(saw, -projectile.radius * 1.55, -projectile.radius * 1.55, projectile.radius * 3.1, projectile.radius * 3.1);
    } else {
      context.globalCompositeOperation = "lighter"; context.shadowColor = context.fillStyle; context.shadowBlur = 10;
      context.beginPath(); context.arc(0, 0, projectile.radius, 0, Math.PI * 2); context.fill();
    }
    context.restore();
  }
}

function drawPickups() {
  for (const pickup of pickups) { context.save(); context.translate(pickup.x, pickup.y + Math.sin(pickup.phase) * 4); context.rotate(pickup.phase * 0.2); context.fillStyle = pickup.type === "health" ? "#63ffa5" : pickup.type === "relic" ? "#fff18a" : profile.palette.accent; context.strokeStyle = "#ffffff"; context.lineWidth = 2; if (pickup.type === "relic") polygon(context, 6, 10); else { context.beginPath(); context.rect(-6, -6, 12, 12); } context.fill(); context.stroke(); context.restore(); }
}

function drawEffects() {
  for (const effect of effects) {
    const progress = clamp((elapsed - effect.born) / effect.duration, 0, 1);
    context.save(); context.globalCompositeOperation = "lighter";
    if (effect.type === "number") { context.globalAlpha = 1 - progress; context.fillStyle = effect.color; context.font = "700 16px ui-monospace,monospace"; context.textAlign = "center"; context.fillText(effect.text, effect.x, effect.y - progress * 24); context.textAlign = "left"; }
    else if (effect.type === "blink") {
      context.globalAlpha = 1 - progress; context.strokeStyle = effect.color; context.shadowColor = effect.color; context.shadowBlur = 14; context.lineWidth = 7 * (1 - progress); context.beginPath(); context.moveTo(effect.x, effect.y);
      if (effect.style === "arc") { const dx = effect.toX - effect.x, dy = effect.toY - effect.y; context.quadraticCurveTo((effect.x + effect.toX) / 2 - dy * .32, (effect.y + effect.toY) / 2 + dx * .32, effect.toX, effect.toY); } else context.lineTo(effect.toX, effect.toY);
      context.stroke();
      if (effect.style === "afterimages") for (let index = 1; index <= 4; index += 1) { const amount = index / 5; context.globalAlpha = (1 - progress) * (.12 + index * .04); context.beginPath(); context.arc(effect.x + (effect.toX - effect.x) * amount, effect.y + (effect.toY - effect.y) * amount, player.radius * .72, 0, Math.PI * 2); context.fillStyle = effect.color; context.fill(); }
    }
    else if (effect.type === "core-flare") { context.globalAlpha = 1 - progress; context.strokeStyle = effect.color; context.shadowColor = effect.color; context.shadowBlur = 20; context.lineWidth = 30 * (1 - progress) + 4; context.beginPath(); context.moveTo(effect.x, effect.y); context.lineTo(effect.toX, effect.toY); context.stroke(); }
    else if (effect.type === "laser-line") { context.globalAlpha = 1 - progress; context.strokeStyle = effect.color; context.shadowColor = effect.color; context.shadowBlur = 14; context.lineWidth = 7 * (1 - progress) + 2; context.beginPath(); context.moveTo(effect.x, effect.y); context.lineTo(effect.toX, effect.toY); context.stroke(); }
    else if (effect.type === "danger-pool") { const radius = lerp(effect.radius, effect.maximumRadius, progress); context.globalAlpha = progress < 0.75 ? 0.3 + progress * 0.4 : 1 - progress; context.fillStyle = profile.palette.hostile; context.beginPath(); context.arc(effect.x, effect.y, radius, 0, Math.PI * 2); context.fill(); }
    else {
      const end = effect.maximumRadius ?? effect.radius * 2.8;
      const radius = lerp(effect.radius * 0.4, end, progress);
      const effectColumn = [...effect.type].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 6;
      context.globalAlpha = (1 - progress) * 0.62;
      drawForgeCell(effectColumn, 5, effect.x - radius, effect.y - radius, radius * 2, radius * 2, effect.color, true);
      context.globalAlpha = 1 - progress;
      context.strokeStyle = effect.color;
      context.lineWidth = effect.type === "close" ? 8 * (1 - progress) : 4;
      context.beginPath(); context.arc(effect.x, effect.y, radius, 0, Math.PI * 2); context.stroke();
    }
    context.restore();
  }
}

function drawCrosshair() { context.save(); context.translate(pointer.x, pointer.y); context.strokeStyle = rgba(profile.palette.accent, 0.82); context.lineWidth = 2; context.beginPath(); context.arc(0, 0, 12 + Math.sin(elapsed * 0.008) * 2, 0, Math.PI * 2); context.moveTo(-18, 0); context.lineTo(-7, 0); context.moveTo(18, 0); context.lineTo(7, 0); context.moveTo(0, -18); context.lineTo(0, -7); context.moveTo(0, 18); context.lineTo(0, 7); context.stroke(); context.restore(); }

function resizeCanvasCoordinates(event) { const bounds = canvas.getBoundingClientRect(); pointer.x = (event.clientX - bounds.left) / bounds.width * canvas.width; pointer.y = (event.clientY - bounds.top) / bounds.height * canvas.height; }
canvas.addEventListener("pointermove", resizeCanvasCoordinates);
canvas.addEventListener("pointerdown", (event) => { event.preventDefault(); resizeCanvasCoordinates(event); if (event.button === 2) pointer.alternate = true; else if (event.button === 0) pointer.down = true; if (!started) { void beginRun().then(() => { if (pointer.down) beginShootHold(); }); } else if (event.button === 0) beginShootHold(); canvas.focus(); });
window.addEventListener("pointerup", (event) => { if (event.button === 2) pointer.alternate = false; else if (event.button === 0) { pointer.down = false; releaseShootHold(); } });
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("keydown", (event) => {
  const action = vaultActionForCode(inputBindings, event.code);
  if (action || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (action) heldInputActions.add(action);
  if (event.code === "Digit1") switchWeapon(0);
  if (event.code === "Digit2") switchWeapon(1);
  if (action === "escape" && !event.repeat) blink();
  if (action === "pulse" && !event.repeat) cooldownAttack();
  if (action === "fire" && !event.repeat) beginShootHold();
  if (event.code === "KeyC" && !event.repeat) closeAttack();
  if (event.code === "KeyG" && !event.repeat) defend();
  if (event.code === "KeyX" && !event.repeat) ultimate();
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
  const action = vaultActionForCode(inputBindings, event.code);
  if (action) heldInputActions.delete(action);
  if (action === "fire") releaseShootHold();
});

function bindTouchStick(element, kind) {
  if (!element) return;
  let activePointer = null;
  const reset = () => {
    element.style.setProperty("--knob-x", "0px");
    element.style.setProperty("--knob-y", "0px");
    if (kind === "move") { touchInput.moveX = 0; touchInput.moveY = 0; }
    else { touchInput.aimActive = false; releaseShootHold(); }
    activePointer = null;
    document.documentElement.dataset.vaultTouchVector = `${touchInput.moveX.toFixed(2)},${touchInput.moveY.toFixed(2)}|${touchInput.aimX.toFixed(2)},${touchInput.aimY.toFixed(2)}|${touchInput.aimActive ? "fire" : "held"}`;
  };
  const updateStick = (event) => {
    const bounds = element.getBoundingClientRect();
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) * 0.34);
    const rawX = event.clientX - (bounds.left + bounds.width / 2);
    const rawY = event.clientY - (bounds.top + bounds.height / 2);
    const length = Math.hypot(rawX, rawY);
    const scale = length > radius ? radius / length : 1;
    const knobX = rawX * scale;
    const knobY = rawY * scale;
    const normalizedX = knobX / radius;
    const normalizedY = knobY / radius;
    element.style.setProperty("--knob-x", `${knobX.toFixed(1)}px`);
    element.style.setProperty("--knob-y", `${knobY.toFixed(1)}px`);
    if (kind === "move") { touchInput.moveX = normalizedX; touchInput.moveY = normalizedY; }
    else {
      if (Math.hypot(normalizedX, normalizedY) > 0.08) { touchInput.aimX = normalizedX; touchInput.aimY = normalizedY; }
      touchInput.aimActive = true;
    }
    document.documentElement.dataset.vaultTouchVector = `${touchInput.moveX.toFixed(2)},${touchInput.moveY.toFixed(2)}|${touchInput.aimX.toFixed(2)},${touchInput.aimY.toFixed(2)}|${touchInput.aimActive ? "fire" : "held"}`;
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!started) beginRun();
    activePointer = event.pointerId;
    element.setPointerCapture?.(event.pointerId);
    updateStick(event);
    if (kind === "aim") beginShootHold();
  });
  element.addEventListener("pointermove", (event) => { if (event.pointerId === activePointer) { event.preventDefault(); updateStick(event); } });
  element.addEventListener("pointerup", (event) => { if (event.pointerId === activePointer) { event.preventDefault(); reset(); } });
  element.addEventListener("pointercancel", reset);
  element.addEventListener("lostpointercapture", () => { if (activePointer !== null) reset(); });
}

bindTouchStick(document.querySelector("#touch-move"), "move");
bindTouchStick(document.querySelector("#touch-aim"), "aim");
for (const button of document.querySelectorAll("[data-touch-action]")) {
  const action = button.dataset.touchAction;
  const engage = (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!started) beginRun();
    if (action === "close") closeAttack();
    else if (action === "charge") beginShootHold();
    else if (action === "cooldown") cooldownAttack();
    else if (action === "blink") blink();
    else if (action === "defend") touchInput.block = true;
    else if (action === "gravity") defend();
    else if (action === "ultimate") ultimate();
    else if (action === "weapon-1") switchWeapon(0);
    else if (action === "weapon-2") switchWeapon(1);
  };
  const release = (event) => {
    event.preventDefault(); event.stopPropagation();
    if (action === "defend") touchInput.block = false;
    if (action === "charge") releaseShootHold();
  };
  button.addEventListener("pointerdown", engage);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}
function syncTouchUi() {
  const touchUiEnabled = matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0 && Math.min(innerWidth, innerHeight) <= 1024;
  document.documentElement.dataset.touchUi = touchUiEnabled ? "1" : "0";
  document.documentElement.dataset.vaultTouchControls = touchUiEnabled ? "ready" : "desktop";
}
syncTouchUi();
window.addEventListener("resize", syncTouchUi);
window.addEventListener("orientationchange", syncTouchUi);
document.documentElement.dataset.vaultTouchVector = "0.00,0.00|1.00,0.00|held";
document.querySelector("#start-run")?.addEventListener("click", () => beginRun());
seedInput.addEventListener("keydown", (event) => { if (event.key === "Enter") beginRun(); });
characterSeedInput.addEventListener("keydown", (event) => { if (event.key === "Enter") beginRun(); });
document.querySelector("#copy-run")?.addEventListener("click", async () => { await navigator.clipboard?.writeText(JSON.stringify({ characterSeed: characterSeedInput.value, mapSeed: seedInput.value })); announce("Character + map pairing copied"); });
document.querySelector("#fullscreen").addEventListener("click", async () => { if (!document.fullscreenElement) await stage.requestFullscreen(); else await document.exitFullscreen(); canvas.focus(); });

function animationFrame(time) {
  const delta = Math.min(40, time - lastFrame);
  lastFrame = time;
  update(delta);
  draw();
  requestAnimationFrame(animationFrame);
}

document.documentElement.dataset.vaultAtlasReady = "true";
document.documentElement.dataset.vaultAtlasWeapons = String(atlas.weapons.length);
document.documentElement.dataset.vaultAtlasMobs = String(atlas.mobs.length);
document.documentElement.dataset.vaultAtlasBosses = String(atlas.bosses.length);
document.documentElement.dataset.vaultAtlasBiomes = String(Object.keys(atlas.gameArt.biomeAtlases).length);
requestAnimationFrame(animationFrame);
if (verifiedMapViewerContext || (allowDevelopmentQuery && (launchParams.get("autostart") === "1" || artReviewMode))) {
  queueMicrotask(() => beginRun());
} else if (vaultSurface === "map-viewer") {
  document.querySelector("#objective-title").textContent = "Verified map context required";
  document.querySelector("#objective-detail").textContent = "The host must inject this map token's pinned build and staked character runtime.";
  document.documentElement.dataset.vaultViewerBlocked = "missing-keel-context";
}
