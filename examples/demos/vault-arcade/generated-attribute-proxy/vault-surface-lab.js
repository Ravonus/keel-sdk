import {
  cropSource,
  drawFeatheredMacro,
  drawTintedQuilt,
  hashString,
  loadImage,
  quiltImageData,
  tintImageData,
} from "./vault-authored-surface.mjs";
import {
  countExactDuplicateCrops,
  macroBoundaryLuminance,
  perceptualHash,
  periodicBoundaryEnergy,
} from "./vault-surface-audit.mjs";

const TILE_SIZE = 64;
const ROOM_COLUMNS = 13;
const ROOM_ROWS = 11;
const CORRIDOR_COLUMNS = 5;
const CORRIDOR_ROWS = 2;
const SIZE = ROOM_COLUMNS * TILE_SIZE;
const ROOM_HEIGHT = ROOM_ROWS * TILE_SIZE;
const CORRIDOR_WIDTH = CORRIDOR_COLUMNS * TILE_SIZE;
const CORRIDOR_HEIGHT = CORRIDOR_ROWS * TILE_SIZE;
const PATCH_SIZE = 192;
const PATCH_OVERLAP = 48;
const SCORE_SAMPLE_STRIDE = 12;
const SIGNAL_CANDIDATE_LIMIT = 32;
const FORGE_CANDIDATE_LIMIT = 64;
const SIGNAL_SOURCE_STRIDE = 13;
const FORGE_SOURCE_STRIDE = 31;
const SIGNAL_PERIODIC_BOUNDARY_WEIGHT = 1500;
const FORGE_PERIODIC_BOUNDARY_WEIGHT = 1000;
const SIGNAL_CANDIDATE_REUSE_WEIGHT = 5000;
const SIGNAL_PALETTE = { floor: "#111525", floor2: "#1a2034", line: "#35446b", accent: "#90c7ff" };
const FORGE_PALETTE = { floor: "#21170f", floor2: "#302117", line: "#634224", accent: "#ffc65c" };
const urls = {
  signal: "assets/game/tilekits/signal-crypt-v5/runtime-material-atlas-4x4.png",
  macros: "assets/game/tilekits/signal-crypt-v4/runtime-floor-macros-2x2.png",
  forge: "assets/game/materials/industrial-forge-floor-v1-tile.webp",
};

const searchParameters = new URLSearchParams(location.search);
const FRAME_AUDIT_COUNT = Math.min(120, Math.max(0, Number.parseInt(searchParameters.get("frames") ?? "0", 10) || 0));
let seedIndex = Number.parseInt(searchParameters.get("seed") ?? "0", 10) || 0;
let assets;
let lastAudit = null;

function canvas(id) { return document.getElementById(id); }

function roomClip(context) {
  context.beginPath();
  context.roundRect(0, 0, SIZE, ROOM_HEIGHT, 24);
  context.rect((SIZE - CORRIDOR_WIDTH) / 2, ROOM_HEIGHT - 8, CORRIDOR_WIDTH, CORRIDOR_HEIGHT + 8);
  context.clip();
}

function drawRoomFrame(context, palette) {
  const inset = 4;
  const radius = 22;
  const corridorLeft = (SIZE - CORRIDOR_WIDTH) / 2;
  const corridorRight = corridorLeft + CORRIDOR_WIDTH;
  context.save();
  context.strokeStyle = `${palette.line}cc`;
  context.lineWidth = 8;
  context.beginPath();
  context.moveTo(inset + radius, inset);
  context.lineTo(SIZE - inset - radius, inset);
  context.quadraticCurveTo(SIZE - inset, inset, SIZE - inset, inset + radius);
  context.lineTo(SIZE - inset, ROOM_HEIGHT - inset - radius);
  context.quadraticCurveTo(SIZE - inset, ROOM_HEIGHT - inset, SIZE - inset - radius, ROOM_HEIGHT - inset);
  context.lineTo(corridorRight + inset, ROOM_HEIGHT - inset);
  context.lineTo(corridorRight + inset, SIZE - inset);
  context.lineTo(corridorLeft - inset, SIZE - inset);
  context.lineTo(corridorLeft - inset, ROOM_HEIGHT - inset);
  context.lineTo(inset + radius, ROOM_HEIGHT - inset);
  context.quadraticCurveTo(inset, ROOM_HEIGHT - inset, inset, ROOM_HEIGHT - inset - radius);
  context.lineTo(inset, inset + radius);
  context.quadraticCurveTo(inset, inset, inset + radius, inset);
  context.closePath();
  context.stroke();
  context.restore();
}

function drawPatternBaseline(target, image, sourceRect, palette, macroImage = null, quadrant = 0) {
  const context = target.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, SIZE, SIZE);
  context.save();
  roomClip(context);
  const swatch = document.createElement("canvas");
  swatch.width = sourceRect.width;
  swatch.height = sourceRect.height;
  const swatchContext = swatch.getContext("2d", { willReadFrequently: true });
  swatchContext.drawImage(image, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, sourceRect.width, sourceRect.height);
  swatchContext.putImageData(tintImageData(swatchContext.getImageData(0, 0, swatch.width, swatch.height), palette), 0, 0);
  context.fillStyle = context.createPattern(swatch, "repeat");
  context.fillRect(0, 0, SIZE, SIZE);
  if (macroImage) drawFeatheredMacro(context, macroImage, quadrant, 160, 84, palette, 512, 62, 0.82);
  context.restore();
  drawRoomFrame(context, palette);
}

function drawCandidate(target, rawSurface, palette, macroImage = null, quadrant = 0) {
  const work = document.createElement("canvas");
  work.width = rawSurface.width;
  work.height = rawSurface.height;
  const workContext = work.getContext("2d", { willReadFrequently: true });
  workContext.drawImage(rawSurface, 0, 0);
  if (macroImage) drawFeatheredMacro(workContext, macroImage, quadrant, 160, 84, palette, 512, 62, 0.82);
  const context = target.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, SIZE, SIZE);
  context.save();
  roomClip(context);
  context.drawImage(work, 0, 0);
  context.restore();
  drawRoomFrame(context, palette);
  return work;
}

function pixelHash(target) {
  const pixels = target.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, target.width, target.height).data;
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 1) { hash ^= pixels[index]; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function legacyVerticalGridEnergy(target, period = 64) {
  const { data, width, height } = target.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, target.width, target.height);
  const energyAtX = (x) => {
    let sum = 0;
    for (let y = 1; y < height - 1; y += 2) {
      const left = (y * width + x - 1) * 4;
      const right = (y * width + x) * 4;
      sum += Math.abs(data[left] - data[right]) + Math.abs(data[left + 1] - data[right + 1]) + Math.abs(data[left + 2] - data[right + 2]);
    }
    return sum / Math.max(1, Math.floor(height / 2));
  };
  const grid = [];
  const other = [];
  for (let x = 1; x < width; x += 1) (x % period === 0 ? grid : other).push(energyAtX(x));
  other.sort((a, b) => a - b);
  const median = other[Math.floor(other.length / 2)] || 1;
  return { gridMean: grid.reduce((sum, value) => sum + value, 0) / Math.max(1, grid.length), median, ratio: (grid.reduce((sum, value) => sum + value, 0) / Math.max(1, grid.length)) / median };
}

function surfacePixels(target) {
  return target.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, target.width, target.height).data;
}

function interiorGridAudit(target, applyRawGate = false) {
  const audit = periodicBoundaryEnergy({
    pixels: surfacePixels(target),
    width: target.width,
    height: target.height,
    period: TILE_SIZE,
    region: { left: TILE_SIZE, top: TILE_SIZE, right: SIZE - TILE_SIZE, bottom: ROOM_HEIGHT - TILE_SIZE },
  });
  return applyRawGate ? {
    ...audit,
    gateMaximum: 1.15,
    passes: audit.vertical.ratio <= 1.15 && audit.horizontal.ratio <= 1.15,
  } : audit;
}

function interiorCropOrigins() {
  const origins = [];
  for (let row = 1; row < ROOM_ROWS - 1; row += 1) {
    for (let column = 1; column < ROOM_COLUMNS - 1; column += 1) origins.push({ x: column * TILE_SIZE, y: row * TILE_SIZE });
  }
  return origins;
}

function candidatePerceptualHash(target) {
  return perceptualHash({ pixels: surfacePixels(target), width: target.width, height: target.height });
}

function updateAuditData() {
  document.getElementById("surface-audit-data").textContent = JSON.stringify(lastAudit);
}

async function auditStaticFrames(count) {
  const references = {
    signal: pixelHash(canvas("signal-candidate")),
    forge: pixelHash(canvas("forge-candidate")),
  };
  const uniqueSignal = new Set();
  const uniqueForge = new Set();
  let mismatchedFrames = 0;
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const signal = pixelHash(canvas("signal-candidate"));
    const forge = pixelHash(canvas("forge-candidate"));
    uniqueSignal.add(signal);
    uniqueForge.add(forge);
    if (signal !== references.signal || forge !== references.forge) mismatchedFrames += 1;
  }
  lastAudit.staticFrameEquivalence = {
    requestedFrames: count,
    observedFrames: count,
    references,
    uniqueHashes: { signal: uniqueSignal.size, forge: uniqueForge.size },
    mismatchedFrames,
    equivalent: mismatchedFrames === 0 && uniqueSignal.size === 1 && uniqueForge.size === 1,
  };
  updateAuditData();
  document.documentElement.dataset.surfaceLabFrameAuditReady = "true";
}

async function render() {
  document.documentElement.dataset.surfaceLabReady = "false";
  document.documentElement.dataset.surfaceLabFrameAuditReady = FRAME_AUDIT_COUNT > 0 ? "false" : "not-requested";
  document.documentElement.classList.add("loading");
  const seed = `vault-authored-surface-${seedIndex}`;
  document.getElementById("seed-label").textContent = seed;
  const signalSources = [cropSource(assets.signal, 0, 0, 256, 256), cropSource(assets.signal, 256, 0, 256, 256)];
  const forgeSources = [cropSource(assets.forge, 0, 0, 1024, 1024)];
  const signalStart = performance.now();
  const signalQuilt = quiltImageData({ sources: signalSources, width: SIZE, height: SIZE, seed: `${seed}:signal`, patchSize: PATCH_SIZE, overlap: PATCH_OVERLAP, stride: SIGNAL_SOURCE_STRIDE, sampleStride: SCORE_SAMPLE_STRIDE, candidateLimit: SIGNAL_CANDIDATE_LIMIT, candidateReuseWeight: SIGNAL_CANDIDATE_REUSE_WEIGHT, periodicBoundaryPeriod: TILE_SIZE, periodicBoundaryWeight: SIGNAL_PERIODIC_BOUNDARY_WEIGHT, periodicBoundarySampleStride: SCORE_SAMPLE_STRIDE });
  const signalMs = performance.now() - signalStart;
  const forgeStart = performance.now();
  const forgeQuilt = quiltImageData({ sources: forgeSources, width: SIZE, height: SIZE, seed: `${seed}:forge`, patchSize: PATCH_SIZE, overlap: PATCH_OVERLAP, stride: FORGE_SOURCE_STRIDE, sampleStride: SCORE_SAMPLE_STRIDE, candidateLimit: FORGE_CANDIDATE_LIMIT, periodicBoundaryPeriod: TILE_SIZE, periodicBoundaryWeight: FORGE_PERIODIC_BOUNDARY_WEIGHT, periodicBoundarySampleStride: SCORE_SAMPLE_STRIDE });
  const forgeMs = performance.now() - forgeStart;
  const signalRaw = canvas("signal-raw-quilt");
  const forgeRaw = canvas("forge-raw-quilt");
  drawTintedQuilt(signalRaw, signalQuilt, SIGNAL_PALETTE);
  drawTintedQuilt(forgeRaw, forgeQuilt, FORGE_PALETTE);
  drawPatternBaseline(canvas("signal-baseline"), assets.signal, { x: 0, y: 0, width: 256, height: 256 }, SIGNAL_PALETTE, assets.macros, seedIndex % 4);
  const signalComposed = drawCandidate(canvas("signal-candidate"), signalRaw, SIGNAL_PALETTE, assets.macros, seedIndex % 4);
  drawPatternBaseline(canvas("forge-baseline"), assets.forge, { x: 0, y: 0, width: 1024, height: 1024 }, FORGE_PALETTE);
  const forgeComposed = drawCandidate(canvas("forge-candidate"), forgeRaw, FORGE_PALETTE);
  document.getElementById("signal-candidate-rgba").src = canvas("signal-candidate").toDataURL("image/png");
  document.getElementById("forge-candidate-rgba").src = canvas("forge-candidate").toDataURL("image/png");
  document.getElementById("signal-time").textContent = `${signalMs.toFixed(1)} ms`;
  document.getElementById("forge-time").textContent = `${forgeMs.toFixed(1)} ms`;
  document.getElementById("signal-hash").textContent = pixelHash(canvas("signal-candidate"));
  document.getElementById("forge-hash").textContent = pixelHash(canvas("forge-candidate"));
  const signalRawPixels = surfacePixels(signalRaw);
  const forgeRawPixels = surfacePixels(forgeRaw);
  const signalRawGrid = interiorGridAudit(signalRaw, true);
  const forgeRawGrid = interiorGridAudit(forgeRaw, true);
  const cropOrigins = interiorCropOrigins();
  const signalDuplicateCrops = countExactDuplicateCrops({ pixels: signalRawPixels, width: SIZE, height: SIZE, cropSize: TILE_SIZE, origins: cropOrigins });
  const forgeDuplicateCrops = countExactDuplicateCrops({ pixels: forgeRawPixels, width: SIZE, height: SIZE, cropSize: TILE_SIZE, origins: cropOrigins });
  document.getElementById("signal-grid-ratio").textContent = `${signalRawGrid.ratio.toFixed(3)} ${signalRawGrid.passes ? "pass" : "fail"}`;
  document.getElementById("forge-grid-ratio").textContent = `${forgeRawGrid.ratio.toFixed(3)} ${forgeRawGrid.passes ? "pass" : "fail"}`;
  document.getElementById("duplicate-crops").textContent = `S ${signalDuplicateCrops.exactDuplicateCrops} / F ${forgeDuplicateCrops.exactDuplicateCrops}`;
  lastAudit = {
    schema: "vault-authored-surface-lab@2",
    seed,
    geometry: {
      tileSize: TILE_SIZE,
      roomColumns: ROOM_COLUMNS,
      roomRows: ROOM_ROWS,
      roomWidth: SIZE,
      roomHeight: ROOM_HEIGHT,
      corridorColumns: CORRIDOR_COLUMNS,
      corridorRows: CORRIDOR_ROWS,
      corridorWidth: CORRIDOR_WIDTH,
      corridorHeight: CORRIDOR_HEIGHT,
    },
    synthesis: {
      patchSize: PATCH_SIZE,
      overlap: PATCH_OVERLAP,
      scoreSampleStride: SCORE_SAMPLE_STRIDE,
      candidateLimits: { signal: SIGNAL_CANDIDATE_LIMIT, forge: FORGE_CANDIDATE_LIMIT },
      candidateReuseWeights: { signal: SIGNAL_CANDIDATE_REUSE_WEIGHT, forge: 0 },
      sourceCandidateStrides: { signal: SIGNAL_SOURCE_STRIDE, forge: FORGE_SOURCE_STRIDE },
      periodicBoundaryScoring: { signalWeight: SIGNAL_PERIODIC_BOUNDARY_WEIGHT, forgeWeight: FORGE_PERIODIC_BOUNDARY_WEIGHT, period: TILE_SIZE, sampleStride: SCORE_SAMPLE_STRIDE },
      selectionUnit: "authored-patch",
      cellSelection: false,
      addedNoise: false,
      macro: { sourceSize: 512, renderedSize: 512, intact: true, feather: 62 },
    },
    sourceHashes: {
      signalMaterials: "776af94542c8b7d0c5e657d244aa20e760677318d185995887cb5697943111dc",
      signalMacros: "f56c9eb01b2a36958f53033b6baca769632b0eb615310f743d2ed4ce363d1275",
      forgeMaterial: "4c249d2af0c9225adb6293b27be669b834c16998028df4010e7fc34a94517b60",
    },
    timingMs: { signal: signalMs, forge: forgeMs },
    hashes: {
      signalBaseline: pixelHash(canvas("signal-baseline")),
      signalCandidate: pixelHash(canvas("signal-candidate")),
      signalRawBase: pixelHash(signalRaw),
      signalComposedBeforeFrame: pixelHash(signalComposed),
      forgeBaseline: pixelHash(canvas("forge-baseline")),
      forgeCandidate: pixelHash(canvas("forge-candidate")),
      forgeRawBase: pixelHash(forgeRaw),
      forgeComposedBeforeFrame: pixelHash(forgeComposed),
    },
    perceptualHashes: {
      signalRawBase: candidatePerceptualHash(signalRaw),
      signalCandidate: candidatePerceptualHash(canvas("signal-candidate")),
      forgeRawBase: candidatePerceptualHash(forgeRaw),
      forgeCandidate: candidatePerceptualHash(canvas("forge-candidate")),
    },
    gridEnergy: {
      rawBase: { signal: signalRawGrid, forge: forgeRawGrid },
      finalSurface: {
        signalInterior: interiorGridAudit(canvas("signal-candidate")),
        forgeInterior: interiorGridAudit(canvas("forge-candidate")),
        signalLegacyFullVertical: legacyVerticalGridEnergy(canvas("signal-candidate")),
        forgeLegacyFullVertical: legacyVerticalGridEnergy(canvas("forge-candidate")),
      },
    },
    exactDuplicate64Crops: {
      scope: "raw tinted quilt; one-cell border inset; deliberate macro absent",
      signal: signalDuplicateCrops,
      forge: forgeDuplicateCrops,
    },
    macroBoundaryLuminance: {
      signal: macroBoundaryLuminance({
        basePixels: signalRawPixels,
        composedPixels: surfacePixels(signalComposed),
        width: SIZE,
        height: SIZE,
        bounds: { x: 160, y: 84, width: 512, height: 512 },
        strip: 16,
      }),
      forge: null,
    },
    staticFrameEquivalence: FRAME_AUDIT_COUNT > 0 ? { requestedFrames: FRAME_AUDIT_COUNT, status: "pending" } : { requestedFrames: 0, status: "not-requested" },
    placements: { signal: signalQuilt.placements, forge: forgeQuilt.placements },
  };
  updateAuditData();
  document.documentElement.dataset.surfaceLabReady = "true";
  document.documentElement.classList.remove("loading");
  if (FRAME_AUDIT_COUNT > 0) await auditStaticFrames(FRAME_AUDIT_COUNT);
}

window.__vaultSurfaceLabAudit = () => structuredClone(lastAudit);
document.getElementById("next-seed").addEventListener("click", async () => { seedIndex += 1; await render(); });

assets = {
  signal: await loadImage(urls.signal),
  macros: await loadImage(urls.macros),
  forge: await loadImage(urls.forge),
};
await render();
