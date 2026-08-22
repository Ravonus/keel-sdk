import { materialIdFromColor } from "./vault-material-targets.mjs";

const STORAGE_KEY = "vault:mob-mask-overrides:v1";
const SCHEMA = "vault-mob-mask-overrides@1";
const DIRECTIONS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
const LANCER_ROOT = "./assets/enemies/candidates/pixellab-lancer-v1";
const IMAGEGEN_REVIEW_ROOT = `${LANCER_ROOT}/animation-review/imagegen-lancer-v1`;
const REVIEW_STORAGE_KEY = "vault:lancer-animation-review:v1";
const RUNTIME_CLIPS = {
  base: { frames: 1, label: "Base rotation" },
  idle: { frames: 6, label: "Runtime idle" },
  move: { frames: 8, label: "Runtime move" },
  attack: { frames: 7, label: "Runtime attack" },
  hit: { frames: 5, label: "Runtime hit" },
  death: { frames: 8, label: "Runtime death" },
};
const LANCER_CLIPS = {
  base: { frames: 1, label: "Base rotation" },
  idle: { frames: 5, label: "REJECTED · idle limb motion" },
  move: { frames: 9, label: "REJECTED · move limb motion" },
  charge: { frames: 9, label: "REJECTED · charge limb motion" },
  hit: { frames: 5, label: "REJECTED · hit limb motion" },
  death: { frames: 9, label: "REJECTED · death limb motion" },
};

const materialRegions = [
  { id: 1, label: "Locked outline", color: "#13171b" },
  { id: 2, label: "Rear stabilizer / trail", color: "#52417e" },
  { id: 3, label: "Wings", color: "#236aa4" },
  { id: 4, label: "Body material", color: "#2ebe89" },
  { id: 5, label: "Weapon / attack material", color: "#f1bf4b" },
  { id: 6, label: "Visor / highlight", color: "#f8efd5" },
  { id: 7, label: "Core light / FX", color: "#ff00ff" },
  { id: "auto", label: "Restore automatic", color: "#ffffff" },
];
const skinRegions = [
  { id: 1, label: "Panel 1", color: "#36f1cd" }, { id: 2, label: "Panel 2", color: "#57a9ff" },
  { id: 3, label: "Panel 3", color: "#986cff" }, { id: 4, label: "Panel 4", color: "#f75bc1" },
  { id: 5, label: "Panel 5", color: "#ff9c45" }, { id: 6, label: "Panel 6", color: "#e7ed67" },
  { id: "auto", label: "Erase panel label", color: "#ffffff" },
];

const canvas = document.querySelector("#editor");
const context = canvas.getContext("2d", { willReadFrequently: true });
const mobSelect = document.querySelector("#mob");
const directionSelect = document.querySelector("#direction");
const animationSelect = document.querySelector("#animation");
const animationFrame = document.querySelector("#animation-frame");
const editLayer = document.querySelector("#edit-layer");
for (const direction of DIRECTIONS) {
  const option = document.createElement("option");
  option.value = direction;
  option.textContent = direction.replace("-", " ").toUpperCase();
  directionSelect.append(option);
}

const atlasResponse = await fetch("./vault-game-atlas-v1.json", { cache: "no-store" });
if (!atlasResponse.ok) throw new Error(`Vault atlas failed: ${atlasResponse.status}`);
const atlas = await atlasResponse.json();
const forgeAtlas = await loadImage(`./${atlas.gameArt.source}`);
const forgeCell = Math.floor(forgeAtlas.naturalWidth / atlas.gameArt.grid[0]);
const [drifterSource, drifterMap, lancerSource, lancerMap] = await Promise.all([
  loadImage("./assets/enemies/candidates/forge-drifter-v1/eight-direction-48.png"),
  loadImage("./assets/enemies/candidates/forge-drifter-v1/material-id-map-48.png"),
  loadImage(`${LANCER_ROOT}/eight-direction-master.png`),
  loadImage(`${LANCER_ROOT}/material-id-map.png`),
]);
const lancerAnimations = Object.fromEntries(await Promise.all(
  Object.entries(LANCER_CLIPS).filter(([name]) => name !== "base").map(async ([name, spec]) => [name, {
    ...spec,
    source: await loadImage(`${LANCER_ROOT}/animations/${name}/source.png`),
    map: await loadImage(`${LANCER_ROOT}/animations/${name}/material-id-map.png`),
 }]),
));
const imagegenRotorReview = Object.fromEntries(await Promise.all(DIRECTIONS.map(async (direction) => [
  direction,
  await loadImage(`${IMAGEGEN_REVIEW_ROOT}/rotor/${direction}/review-strip-96.png`),
])));
const imagegenAttackReview = {
  south: await loadImage(`${IMAGEGEN_REVIEW_ROOT}/attack/south/review-strip-96-v2.png`),
};

const mobs = {
  lancer: {
    label: "PixelLabs Lancer", size: 68, editable: true, clips: LANCER_CLIPS,
    source: lancerSource, map: lancerMap, columns: 4,
    status: "BASE APPROVED · ImageGen rotor + SOUTH attack in human review · gameplay locked",
  },
  drifter: {
    label: "Forge Drifter", size: 48, editable: true, clips: RUNTIME_CLIPS,
    source: drifterSource, map: drifterMap, columns: 4,
    status: "MIXED · authored eight-direction base + deterministic runtime motion",
  },
  wisp: {
    label: "Signal Wisp", size: forgeCell, editable: false, clips: RUNTIME_CLIPS,
    source: forgeAtlas, atlasColumn: 1, atlasRow: 3,
    status: "PROXY · deterministic runtime motion; directional PixelLabs art still required",
  },
  bulwark: {
    label: "Bulwark", size: forgeCell, editable: false, clips: RUNTIME_CLIPS,
    source: forgeAtlas, atlasColumn: 3, atlasRow: 3,
    status: "PROXY · deterministic runtime motion; directional PixelLabs art still required",
  },
};

let overrides = loadOverrides();
let tool = 4;
let current = null;
let painting = false;
let history = [];
let future = [];
let playing = false;
let animationTimer = null;
let reviewFrame = 0;
let reviewPlaying = true;
let reviewTimer = null;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const value = new Image();
    value.onload = () => resolve(value);
    value.onerror = () => reject(new Error(`Unable to load ${url}`));
    value.src = url;
  });
}

function emptyMobState() { return { directions: {}, skinPanels: {} }; }
function loadOverrides() {
  let value;
  try { value = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch {}
  if (!value || value.schema !== SCHEMA || !value.assets) value = { schema: SCHEMA, assets: {} };
  for (const id of Object.keys(mobs)) {
    value.assets[id] ??= emptyMobState();
    value.assets[id].directions ??= {};
    value.assets[id].skinPanels ??= {};
  }
  return value;
}

function definition() { return mobs[mobSelect.value]; }
function activeRegions() { return editLayer.value === "skin" ? skinRegions : materialRegions; }
function mobState() { return overrides.assets[mobSelect.value]; }
function frameOverrides(create = false) {
  const state = mobState();
  const layer = editLayer.value === "skin" ? state.skinPanels : state.directions;
  if (create) layer[directionSelect.value] ??= {};
  return layer[directionSelect.value] ?? {};
}
function compact() {
  const value = structuredClone(overrides);
  for (const state of Object.values(value.assets)) {
    state.directions ??= {};
    state.skinPanels ??= {};
    for (const layer of [state.directions, state.skinPanels]) {
      for (const [direction, pixels] of Object.entries(layer)) if (!Object.keys(pixels).length) delete layer[direction];
    }
  }
  return value;
}
function save() {
  overrides = compact();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  document.querySelector("#json").value = JSON.stringify(overrides);
  document.querySelector("#status").textContent = "saved locally · reload/open Test game to apply";
  document.querySelector("#metric-status").textContent = "saved";
  document.documentElement.dataset.mobMaskEditorSaved = "true";
}
function remember() {
  history.push(JSON.stringify(overrides));
  if (history.length > 100) history.shift();
  future = [];
  historyState();
}
function historyState() {
  document.querySelector("#undo").disabled = !history.length;
  document.querySelector("#redo").disabled = !future.length;
}
function restore(value) { overrides = JSON.parse(value); save(); render(); }
function rgba(hex, alpha) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function sourceFrame(direction) {
  const mob = definition();
  const index = Math.max(0, DIRECTIONS.indexOf(direction));
  const surface = document.createElement("canvas");
  surface.width = surface.height = mob.size;
  const target = surface.getContext("2d", { willReadFrequently: true });
  target.imageSmoothingEnabled = false;
  if (mob.atlasColumn !== undefined) {
    target.drawImage(mob.source, mob.atlasColumn * mob.size, mob.atlasRow * mob.size, mob.size, mob.size, 0, 0, mob.size, mob.size);
    removeGreenBackground(target, mob.size);
  } else {
    target.drawImage(mob.source, (index % mob.columns) * mob.size, Math.floor(index / mob.columns) * mob.size, mob.size, mob.size, 0, 0, mob.size, mob.size);
  }
  const mapSurface = document.createElement("canvas");
  mapSurface.width = mapSurface.height = mob.size;
  const mapTarget = mapSurface.getContext("2d", { willReadFrequently: true });
  mapTarget.imageSmoothingEnabled = false;
  if (mob.map) mapTarget.drawImage(mob.map, (index % mob.columns) * mob.size, Math.floor(index / mob.columns) * mob.size, mob.size, mob.size, 0, 0, mob.size, mob.size);
  else deriveMaterialMap(target, mapTarget, mob.size);
  return { surface, mapSurface };
}
function removeGreenBackground(target, size) {
  const pixels = target.getImageData(0, 0, size, size);
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    const [r, g, b] = pixels.data.slice(offset, offset + 3);
    if (g > 145 && g > r * 1.25 && g > b * 1.2) pixels.data[offset + 3] = 0;
  }
  target.putImageData(pixels, 0, 0);
}
function deriveMaterialMap(source, target, size) {
  const pixels = source.getImageData(0, 0, size, size);
  const output = target.createImageData(size, size);
  const colors = [[0,0,0,0],[19,23,27,255],[82,65,126,255],[35,106,164,255],[46,190,137,255],[241,191,75,255],[248,239,213,255],[255,0,255,255]];
  for (let index = 0; index < size * size; index++) {
    const offset = index * 4;
    if (pixels.data[offset + 3] < 24) continue;
    const luma = pixels.data[offset] * .2126 + pixels.data[offset + 1] * .7152 + pixels.data[offset + 2] * .0722;
    const id = luma < 32 ? 1 : luma < 76 ? 3 : luma < 145 ? 4 : luma < 210 ? 5 : 6;
    output.data.set(colors[id], offset);
  }
  target.putImageData(output, 0, 0);
}
function authoredLancerFrame(direction, clip, requestedFrame) {
  const mob = mobs.lancer;
  const asset = clip === "base" ? { source: mob.source, map: mob.map, ...LANCER_CLIPS.base } : lancerAnimations[clip];
  const directionIndex = DIRECTIONS.indexOf(direction);
  const frame = Math.max(0, Math.min(asset.frames - 1, requestedFrame));
  const sx = clip === "base" ? (directionIndex % 4) * mob.size : frame * mob.size;
  const sy = clip === "base" ? Math.floor(directionIndex / 4) * mob.size : directionIndex * mob.size;
  return cropPair(asset.source, asset.map, sx, sy, mob.size, frame);
}
function cropPair(source, map, sx, sy, size, frame) {
  const read = (image) => {
    const surface = document.createElement("canvas");
    surface.width = surface.height = size;
    const target = surface.getContext("2d", { willReadFrequently: true });
    target.imageSmoothingEnabled = false;
    target.drawImage(image, sx, sy, size, size, 0, 0, size, size);
    return { surface, pixels: target.getImageData(0, 0, size, size) };
  };
  const sourceFrameValue = read(source);
  const mapFrameValue = read(map);
  return { surface: sourceFrameValue.surface, source: sourceFrameValue.pixels, mask: mapFrameValue.pixels, frame };
}
function proceduralFrame(direction, clip, requestedFrame) {
  const mob = definition();
  const spec = mob.clips[clip];
  const frame = Math.max(0, Math.min(spec.frames - 1, requestedFrame));
  const base = sourceFrame(direction);
  if (clip === "base") return cropPair(base.surface, base.mapSurface, 0, 0, mob.size, frame);
  const progress = spec.frames <= 1 ? 0 : frame / (spec.frames - 1);
  const phase = progress * Math.PI * 2;
  let dx = 0, dy = 0, scaleX = 1, scaleY = 1, rotation = 0, alpha = 1;
  if (clip === "idle") { dy = Math.sin(phase) * mob.size * .025; scaleY = 1 + Math.sin(phase) * .025; }
  if (clip === "move") { dy = -Math.abs(Math.sin(phase)) * mob.size * .06; rotation = Math.sin(phase) * .045; scaleX = 1 + Math.cos(phase) * .025; }
  if (clip === "attack") { const pulse = Math.sin(progress * Math.PI); scaleX = 1 + pulse * .16; scaleY = 1 - pulse * .08; dx = pulse * mob.size * .08; }
  if (clip === "hit") { const recoil = Math.sin(progress * Math.PI); dx = -recoil * mob.size * .1; rotation = -recoil * .13; }
  if (clip === "death") { rotation = progress * .8; dy = progress * mob.size * .24; scaleX = scaleY = 1 - progress * .48; alpha = 1 - progress * .72; }
  const transform = (input) => {
    const output = document.createElement("canvas");
    output.width = output.height = mob.size;
    const target = output.getContext("2d", { willReadFrequently: true });
    target.imageSmoothingEnabled = false;
    target.globalAlpha = alpha;
    target.translate(mob.size / 2 + dx, mob.size / 2 + dy);
    target.rotate(rotation);
    target.scale(scaleX, scaleY);
    target.drawImage(input, -mob.size / 2, -mob.size / 2);
    return output;
  };
  const surface = transform(base.surface);
  const mapSurface = transform(base.mapSurface);
  return { surface, source: surface.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, mob.size, mob.size), mask: mapSurface.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, mob.size, mob.size), frame };
}
function rawFrame(direction, clip = animationSelect.value, requestedFrame = Number(animationFrame.value)) {
  return mobSelect.value === "lancer" ? authoredLancerFrame(direction, clip, requestedFrame) : proceduralFrame(direction, clip, requestedFrame);
}

function build() {
  const mob = definition();
  const frame = rawFrame(directionSelect.value);
  const baseline = [], materialBaseline = [], effective = [];
  const manual = mob.editable ? frameOverrides() : {};
  const skin = editLayer.value === "skin";
  let painted = 0;
  for (let index = 0; index < mob.size * mob.size; index++) {
    const offset = index * 4;
    const id = materialIdFromColor(frame.mask.data[offset], frame.mask.data[offset + 1], frame.mask.data[offset + 2], frame.mask.data[offset + 3]);
    materialBaseline[index] = id;
    baseline[index] = skin ? 0 : id;
    effective[index] = Number(manual[index] ?? baseline[index]);
    if (effective[index]) painted++;
  }
  return { ...frame, baseline, materialBaseline, effective, painted, clip: animationSelect.value };
}
function draw(target, mapState, only = null, outputSize = 680) {
  const mob = definition();
  const scale = outputSize / mob.size;
  target.imageSmoothingEnabled = false;
  target.clearRect(0, 0, outputSize, outputSize);
  if (!only && document.querySelector("#show-sprite").checked) target.drawImage(mapState.surface, 0, 0, outputSize, outputSize);
  const opacity = only ? .9 : Number(document.querySelector("#mask-opacity").value) / 100;
  const manual = mob.editable ? frameOverrides() : {};
  for (let index = 0; index < mob.size * mob.size; index++) {
    const id = mapState.effective[index];
    if (!id || (only && id !== only)) continue;
    const x = index % mob.size, y = Math.floor(index / mob.size);
    const region = activeRegions().find((value) => value.id === id);
    target.fillStyle = rgba(region?.color ?? "#ff0000", opacity);
    target.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale));
    if (!only && manual[index] !== undefined) { target.fillStyle = "#ffffff"; target.fillRect(x * scale, y * scale, Math.max(1, scale * .22), Math.max(1, scale * .22)); }
  }
}
function tools() {
  const root = document.querySelector("#tools");
  root.replaceChildren();
  if (!activeRegions().some((region) => region.id === tool)) tool = activeRegions()[0].id;
  for (const region of activeRegions()) {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = !definition().editable;
    button.style.setProperty("--tool-color", region.color);
    button.setAttribute("aria-pressed", String(tool === region.id));
    button.innerHTML = `<span class="swatch"></span>${region.label}`;
    button.onclick = () => { tool = region.id; tools(); };
    root.append(button);
  }
}
function isolations() {
  const root = document.querySelector("#isolations");
  root.replaceChildren();
  for (const region of activeRegions().filter((value) => value.id !== "auto")) {
    const count = current.effective.filter((value) => value === region.id).length;
    if (!count) continue;
    const article = document.createElement("article");
    article.className = "isolation";
    const title = document.createElement("strong");
    title.textContent = `${region.label} · ${count}px`;
    const preview = document.createElement("canvas");
    preview.width = preview.height = 272;
    draw(preview.getContext("2d"), current, region.id, 272);
    article.append(title, preview);
    root.append(article);
  }
}
function total() {
  return Object.values(overrides.assets).reduce((sum, state) => sum + [state.directions, state.skinPanels].reduce((mobSum, layer) => mobSum + Object.values(layer ?? {}).reduce((layerSum, value) => layerSum + Object.keys(value).length, 0), 0), 0);
}
function syncAnimationOptions() {
  const selected = animationSelect.value;
  animationSelect.replaceChildren();
  for (const [id, spec] of Object.entries(definition().clips)) {
    const option = document.createElement("option"); option.value = id; option.textContent = spec.label; animationSelect.append(option);
  }
  animationSelect.value = definition().clips[selected] ? selected : "base";
}
function syncAnimationControls() {
  const spec = definition().clips[animationSelect.value];
  animationFrame.max = String(spec.frames - 1);
  if (Number(animationFrame.value) >= spec.frames) animationFrame.value = "0";
  animationFrame.disabled = spec.frames === 1;
  document.querySelector("#play-animation").disabled = spec.frames === 1;
}
function stopAnimation() {
  playing = false; clearInterval(animationTimer); animationTimer = null;
  const button = document.querySelector("#play-animation"); button.textContent = "Play animation"; button.setAttribute("aria-pressed", "false");
}
function toggleAnimation() {
  if (playing) return stopAnimation();
  playing = true;
  const button = document.querySelector("#play-animation"); button.textContent = "Pause animation"; button.setAttribute("aria-pressed", "true");
  animationTimer = setInterval(() => {
    const spec = definition().clips[animationSelect.value];
    animationFrame.value = String((Number(animationFrame.value) + 1) % spec.frames);
    render();
  }, 110);
}
function syncEditability() {
  const editable = definition().editable;
  for (const id of ["edit-layer", "edit-mode", "brush-size", "propagate-south", "reset-direction"]) document.querySelector(`#${id}`).disabled = !editable;
  canvas.style.cursor = editable ? "crosshair" : "default";
  document.querySelector("#editor-title").textContent = `${definition().label} animation + target map`;
  document.querySelector("#source-status").textContent = definition().status;
  document.querySelector("#editor-help").innerHTML = editable
    ? "<b>Component colors</b> and <b>Skin panel labels</b> are saved per mob and direction. The same exact labels project over each animation frame."
    : "<b>Review-only proxy.</b> This mob is visible so the loader is complete, but target painting stays locked until its real eight-direction PixelLabs source and material map exist.";
}
async function render() {
  syncAnimationControls(); syncEditability();
  current = build();
  draw(context, current);
  tools(); isolations();
  const spec = definition().clips[current.clip];
  document.querySelector("#metric-painted").textContent = current.painted;
  document.querySelector("#metric-overrides").textContent = definition().editable ? Object.keys(frameOverrides()).length : "locked";
  document.querySelector("#metric-total").textContent = total();
  document.querySelector("#json").value = JSON.stringify(overrides);
  document.querySelector("#readout").textContent = `${definition().label} · ${spec.label} · frame ${current.frame + 1}/${spec.frames} · ${definition().editable ? "direction-level edits project over this clip" : "runtime motion preview only"}`;
  document.documentElement.dataset.mobMaskEditorReady = "true";
  document.documentElement.dataset.mobMaskMob = mobSelect.value;
  document.documentElement.dataset.mobMaskDirection = directionSelect.value;
  document.documentElement.dataset.mobMaskAnimation = `${current.clip}:${current.frame}`;
  document.documentElement.dataset.mobMaskSource = definition().editable ? (mobSelect.value === "lancer" ? "authored" : "mixed") : "proxy";
  historyState();
}

function reviewDefinition() {
  const clip = document.querySelector("#review-clip").value;
  if (clip === "attack") return { clip, label: "ImageGen SOUTH charge attack v2", directions: ["south"], images: imagegenAttackReview };
  return { clip, label: "ImageGen rotor loop", directions: DIRECTIONS, images: imagegenRotorReview };
}

function renderReview() {
  const definition = reviewDefinition();
  const root = document.querySelector("#review-grid");
  if (root.dataset.clip !== definition.clip) {
    root.replaceChildren();
    root.dataset.clip = definition.clip;
    for (const direction of definition.directions) {
      const card = document.createElement("article");
      card.className = "review-card";
      const title = document.createElement("strong");
      title.textContent = direction.replace("-", " ").toUpperCase();
      const preview = document.createElement("canvas");
      preview.width = preview.height = 192;
      preview.dataset.direction = direction;
      card.append(title, preview);
      root.append(card);
    }
  }
  for (const canvas of root.querySelectorAll("canvas")) {
    const source = definition.images[canvas.dataset.direction];
    const target = canvas.getContext("2d");
    target.imageSmoothingEnabled = false;
    target.clearRect(0, 0, canvas.width, canvas.height);
    target.drawImage(source, reviewFrame * 96, 0, 96, 96, 0, 0, canvas.width, canvas.height);
  }
  let decisions = {};
  try { decisions = JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY)) ?? {}; } catch {}
  const decision = decisions[definition.clip] ?? "candidate";
  document.querySelector("#review-status").textContent = `${definition.label} · frame ${reviewFrame + 1}/8 · ${decision} · gameplay locked`;
  document.documentElement.dataset.lancerReviewClip = definition.clip;
  document.documentElement.dataset.lancerReviewFrame = String(reviewFrame);
  document.documentElement.dataset.lancerReviewDecision = decision;
}

function saveReviewDecision(decision) {
  let decisions = {};
  try { decisions = JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY)) ?? {}; } catch {}
  decisions[reviewDefinition().clip] = decision;
  localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(decisions));
  renderReview();
}

function toggleReview() {
  reviewPlaying = !reviewPlaying;
  const button = document.querySelector("#review-play");
  button.textContent = reviewPlaying ? "Pause review" : "Play review";
  button.setAttribute("aria-pressed", String(reviewPlaying));
}
function point(event) {
  const rect = canvas.getBoundingClientRect(), size = definition().size;
  return { x: Math.max(0, Math.min(size - 1, Math.floor((event.clientX - rect.left) / rect.width * size))), y: Math.max(0, Math.min(size - 1, Math.floor((event.clientY - rect.top) / rect.height * size))) };
}
function inspect(x, y) {
  const size = definition().size, index = y * size + x, offset = index * 4;
  const luma = Math.round(current.source.data[offset] * .2126 + current.source.data[offset + 1] * .7152 + current.source.data[offset + 2] * .0722);
  document.querySelector("#readout").textContent = `pixel ${x},${y} · alpha ${current.source.data[offset + 3]} · luma ${luma} · region ${activeRegions().find((value) => value.id === current.effective[index])?.label ?? "transparent"} · ${frameOverrides()[index] === undefined ? "automatic" : "manual"}`;
}
function setPixel(index, value) {
  const frame = frameOverrides(true), baseline = current.baseline[index];
  if (value === "auto" || Number(value) === baseline) delete frame[index]; else frame[index] = Number(value);
}
function paint(x, y) {
  if (!definition().editable) return;
  const size = definition().size, radius = Number(document.querySelector("#brush-size").value) - 1, skin = editLayer.value === "skin";
  for (let py = y - radius; py <= y + radius; py++) for (let px = x - radius; px <= x + radius; px++) {
    if (px < 0 || py < 0 || px >= size || py >= size) continue;
    const index = py * size + px;
    if (skin && current.source.data[index * 4 + 3] < 24) continue;
    if (!current.baseline[index] && tool === "auto" && frameOverrides()[index] === undefined) continue;
    setPixel(index, tool);
  }
  save(); render(); inspect(x, y);
}
function fill(x, y) {
  if (!definition().editable) return;
  const size = definition().size, start = y * size + x, sourceRegion = current.effective[start];
  if (!sourceRegion) return;
  const pending = [start], seen = new Set([start]);
  while (pending.length) {
    const index = pending.pop(); setPixel(index, tool);
    const px = index % size, py = Math.floor(index / size);
    for (const next of [index - 1, index + 1, index - size, index + size]) {
      const nx = next % size, ny = Math.floor(next / size);
      if (next < 0 || next >= size * size || Math.abs(nx - px) + Math.abs(ny - py) !== 1 || seen.has(next) || current.effective[next] !== sourceRegion) continue;
      seen.add(next); pending.push(next);
    }
  }
  save(); render();
}
function propagationKey(frame, index) {
  const offset = index * 4;
  const id = materialIdFromColor(frame.mask.data[offset], frame.mask.data[offset + 1], frame.mask.data[offset + 2], frame.mask.data[offset + 3]);
  const quantize = (value) => Math.round(value / 12);
  return `${id}:${quantize(frame.source.data[offset])}:${quantize(frame.source.data[offset + 1])}:${quantize(frame.source.data[offset + 2])}:${frame.source.data[offset + 3] > 23 ? 1 : 0}`;
}
function propagateSouth() {
  if (!definition().editable) return;
  const size = definition().size, skin = editLayer.value === "skin", state = mobState(), layer = skin ? state.skinPanels : state.directions, reference = layer.south ?? {};
  if (!Object.keys(reference).length) { document.querySelector("#status").textContent = `paint SOUTH ${skin ? "skin panels" : "components"} first`; return; }
  remember();
  const referenceFrame = rawFrame("south", "base", 0), votes = new Map();
  for (const [pixel, rawId] of Object.entries(reference)) {
    const index = Number(pixel), offset = index * 4;
    if (referenceFrame.source.data[offset + 3] < 24) continue;
    const key = propagationKey(referenceFrame, index), id = Number(rawId);
    if (!skin && ![3, 4, 5, 6].includes(id)) continue;
    if (!votes.has(key)) votes.set(key, new Map());
    votes.get(key).set(id, (votes.get(key).get(id) ?? 0) + 1);
  }
  const winners = new Map([...votes].map(([key, counts]) => { const [id, count] = [...counts].sort((a, b) => b[1] - a[1])[0]; return [key, count >= 2 ? id : undefined]; }));
  let copied = 0;
  for (const direction of DIRECTIONS.slice(1)) {
    const frame = rawFrame(direction, "base", 0), target = layer[direction] ?? {};
    for (let index = 0; index < size * size; index++) {
      const offset = index * 4;
      if (target[index] !== undefined || frame.source.data[offset + 3] < 24) continue;
      const id = winners.get(propagationKey(frame, index));
      if (id === undefined) continue;
      const baseline = skin ? 0 : materialIdFromColor(frame.mask.data[offset], frame.mask.data[offset + 1], frame.mask.data[offset + 2], frame.mask.data[offset + 3]);
      if (id !== baseline) { target[index] = id; copied++; }
    }
    if (Object.keys(target).length) layer[direction] = target;
  }
  save(); render();
  document.querySelector("#status").textContent = `propagated ${copied} ${skin ? "panel" : "solid component"} labels from SOUTH`;
}

mobSelect.onchange = () => { stopAnimation(); animationFrame.value = "0"; syncAnimationOptions(); render(); };
directionSelect.onchange = render;
animationSelect.onchange = () => { stopAnimation(); animationFrame.value = "0"; render(); };
animationFrame.oninput = render;
document.querySelector("#play-animation").onclick = toggleAnimation;
document.querySelector("#review-clip").onchange = () => { reviewFrame = 0; renderReview(); };
document.querySelector("#review-play").onclick = toggleReview;
document.querySelector("#review-approve").onclick = () => saveReviewDecision("approved-locally-awaiting-runtime-promotion");
document.querySelector("#review-reject").onclick = () => saveReviewDecision("rejected");
document.querySelector("#propagate-south").onclick = propagateSouth;
canvas.addEventListener("pointerdown", (event) => {
  const p = point(event); inspect(p.x, p.y);
  if (!definition().editable || document.querySelector("#edit-mode").value === "inspect") return;
  remember();
  if (document.querySelector("#edit-mode").value === "fill") return fill(p.x, p.y);
  painting = true; canvas.setPointerCapture(event.pointerId); paint(p.x, p.y);
});
canvas.addEventListener("pointermove", (event) => { const p = point(event); inspect(p.x, p.y); if (painting) paint(p.x, p.y); });
canvas.addEventListener("pointerup", () => painting = false);
canvas.addEventListener("pointercancel", () => painting = false);
editLayer.onchange = () => { tool = editLayer.value === "skin" ? 1 : 4; render(); };
document.querySelector("#show-sprite").onchange = render;
document.querySelector("#mask-opacity").oninput = render;
document.querySelector("#undo").onclick = () => { if (history.length) { future.push(JSON.stringify(overrides)); restore(history.pop()); } };
document.querySelector("#redo").onclick = () => { if (future.length) { history.push(JSON.stringify(overrides)); restore(future.pop()); } };
document.querySelector("#reset-direction").onclick = () => { if (!definition().editable) return; remember(); const layer = editLayer.value === "skin" ? mobState().skinPanels : mobState().directions; delete layer[directionSelect.value]; save(); render(); };
document.querySelector("#reset-all").onclick = () => { remember(); overrides = { schema: SCHEMA, assets: Object.fromEntries(Object.keys(mobs).map((id) => [id, emptyMobState()])) }; save(); render(); };
document.querySelector("#copy").onclick = async () => { await navigator.clipboard.writeText(JSON.stringify(overrides)); document.querySelector("#status").textContent = "copied"; };
document.querySelector("#download").onclick = () => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(overrides, null, 2)], { type: "application/json" })); link.download = "vault-mob-mask-overrides.json"; link.click(); URL.revokeObjectURL(link.href); };
document.querySelector("#load").onclick = () => { const parsed = JSON.parse(document.querySelector("#json").value); if (parsed.schema !== SCHEMA) throw new Error("unsupported mob mask schema"); remember(); overrides = parsed; for (const id of Object.keys(mobs)) overrides.assets[id] ??= emptyMobState(); save(); render(); };

syncAnimationOptions();
save();
await render();
renderReview();
reviewTimer = setInterval(() => {
  if (!reviewPlaying) return;
  reviewFrame = (reviewFrame + 1) % 8;
  renderReview();
}, 120);
