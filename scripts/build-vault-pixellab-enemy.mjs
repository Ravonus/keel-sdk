import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  VAULT_MATERIAL_REGIONS,
  materialIdColor,
  pixelLuminance,
  recolorVaultMaterialMapPixels,
} from "../examples/demos/vault-arcade/generated-attribute-proxy/vault-material-targets.mjs";

const require = createRequire(new URL("../apps/studio/package.json", import.meta.url));
const sharp = require("sharp");
const directions = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];
const vectors = {
  south: [0, 1],
  "south-west": [-Math.SQRT1_2, Math.SQRT1_2],
  west: [-1, 0],
  "north-west": [-Math.SQRT1_2, -Math.SQRT1_2],
  north: [0, -1],
  "north-east": [Math.SQRT1_2, -Math.SQRT1_2],
  east: [1, 0],
  "south-east": [Math.SQRT1_2, Math.SQRT1_2],
};

const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const [key, ...value] = entry.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const asset = args.asset ?? "pixellab-lancer-v1";
const objectId = args["object-id"] ?? "unknown";
const root = path.resolve(args.root ?? `examples/demos/vault-arcade/generated-attribute-proxy/assets/enemies/candidates/${asset}`);
const rotationRoot = path.join(root, "rotations");
const proofPalette = {
  seam: [76, 43, 145],
  "armor-dark": [20, 86, 116],
  "armor-mid": [24, 185, 143],
  "armor-light": [243, 170, 42],
  highlight: [255, 245, 218],
  "emissive-core": [255, 48, 216],
};

const frames = await Promise.all(directions.map(async (direction) => {
  const file = path.join(rotationRoot, `${direction}.png`);
  const bytes = await readFile(file);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { direction, file, bytes, data: new Uint8ClampedArray(data), info };
}));
const cellSize = Math.max(...frames.map(({ info }) => Math.max(info.width, info.height)));
const columns = 4;
const rows = 2;
const outputWidth = columns * cellSize;
const outputHeight = rows * cellSize;
const source = new Uint8ClampedArray(outputWidth * outputHeight * 4);
const materialMap = new Uint8ClampedArray(source.length);
const regionCounts = Object.fromEntries(VAULT_MATERIAL_REGIONS.map((region) => [region.name, 0]));
const frameReports = [];

function offsetOf(width, x, y) {
  return (y * width + x) * 4;
}

function opaque(data, width, x, y) {
  return data[offsetOf(width, x, y) + 3] >= 24;
}

function findBodyCenter(frame) {
  const { data, info } = frame;
  const middleX = (info.width - 1) / 2;
  const middleY = (info.height - 1) / 2;
  let winner = { x: Math.round(middleX), y: Math.round(middleY), score: -Infinity };
  for (let y = 8; y < info.height - 8; y += 1) for (let x = 8; x < info.width - 8; x += 1) {
    if (!opaque(data, info.width, x, y)) continue;
    let density = 0;
    for (let oy = -8; oy <= 8; oy += 2) for (let ox = -8; ox <= 8; ox += 2) {
      const sampleX = x + ox;
      const sampleY = y + oy;
      if (sampleX >= 0 && sampleY >= 0 && sampleX < info.width && sampleY < info.height && opaque(data, info.width, sampleX, sampleY)) density += 1;
    }
    const centerPenalty = Math.hypot(x - middleX, y - middleY) * 0.28;
    const score = density - centerPenalty;
    if (score > winner.score) winner = { x, y, score };
  }
  return winner;
}

function regionForPixel(frame, x, y, center) {
  const sourceOffset = offsetOf(frame.info.width, x, y);
  const red = frame.data[sourceOffset];
  const green = frame.data[sourceOffset + 1];
  const blue = frame.data[sourceOffset + 2];
  const alpha = frame.data[sourceOffset + 3];
  if (alpha < 24) return 0;
  const luminance = pixelLuminance(red, green, blue);
  if (luminance < 25) return 1;
  const [forwardX, forwardY] = vectors[frame.direction];
  const deltaX = x - center.x;
  const deltaY = y - center.y;
  const forward = deltaX * forwardX + deltaY * forwardY;
  const lateral = Math.abs(deltaX * -forwardY + deltaY * forwardX);
  const coreDistance = Math.hypot(deltaX - forwardX * 8, deltaY - forwardY * 8);
  if (coreDistance <= 4.6 && luminance >= 92) return 7;
  if (forward > 10 && lateral < 15) return 5;
  if (forward < -10 && lateral < 14) return 2;
  if (forward > 1.5 && forward <= 10 && lateral < 9.5) return 6;
  if (Math.abs(forward) < 12 && lateral >= 9.5) return 3;
  return 4;
}

for (let index = 0; index < frames.length; index += 1) {
  const frame = frames[index];
  const column = index % columns;
  const row = Math.floor(index / columns);
  const destinationX = column * cellSize + Math.floor((cellSize - frame.info.width) / 2);
  const destinationY = row * cellSize + Math.floor((cellSize - frame.info.height) / 2);
  const center = findBodyCenter(frame);
  const localCounts = {};
  for (let y = 0; y < frame.info.height; y += 1) for (let x = 0; x < frame.info.width; x += 1) {
    const sourceOffset = offsetOf(frame.info.width, x, y);
    const targetOffset = offsetOf(outputWidth, destinationX + x, destinationY + y);
    source.set(frame.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    const id = regionForPixel(frame, x, y, center);
    const color = materialIdColor(id);
    materialMap.set(color, targetOffset);
    materialMap[targetOffset + 3] = id === 0 ? 0 : frame.data[sourceOffset + 3];
    const name = VAULT_MATERIAL_REGIONS[id].name;
    regionCounts[name] += 1;
    localCounts[name] = (localCounts[name] ?? 0) + 1;
  }
  frameReports.push({ direction: frame.direction, source: path.basename(frame.file), size: [frame.info.width, frame.info.height], bodyCenter: [center.x, center.y], regions: localCounts });
}

const sourceBytes = await sharp(Buffer.from(source), { raw: { width: outputWidth, height: outputHeight, channels: 4 } }).png().toBuffer();
const mapBytes = await sharp(Buffer.from(materialMap), { raw: { width: outputWidth, height: outputHeight, channels: 4 } }).png().toBuffer();
const proofPixels = recolorVaultMaterialMapPixels(source, materialMap, proofPalette);
const proofBytes = await sharp(Buffer.from(proofPixels), { raw: { width: outputWidth, height: outputHeight, channels: 4 } }).png().toBuffer();
const sha256 = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;

await mkdir(root, { recursive: true });
await writeFile(path.join(root, "eight-direction-master.png"), sourceBytes);
await writeFile(path.join(root, "material-id-map.png"), mapBytes);
await writeFile(path.join(root, "palette-proof.png"), proofBytes);
await writeFile(path.join(root, "candidate-report.json"), `${JSON.stringify({
  schema: "vault-pixellab-enemy-candidate@1",
  asset,
  state: "candidate-mechanical-pass-visual-review-required",
  provenance: { provider: "PixelLabs", objectId, directions, sourceMode: "eight-direction-object" },
  output: { cellSize, columns, rows, width: outputWidth, height: outputHeight },
  source: { file: "eight-direction-master.png", sha256: sha256(sourceBytes) },
  materialMap: { file: "material-id-map.png", sha256: sha256(mapBytes), regions: regionCounts },
  paletteProof: { file: "palette-proof.png", sha256: sha256(proofBytes) },
  frames: frameReports,
}, null, 2)}\n`);
console.log(`Built ${asset}: ${outputWidth}x${outputHeight}; ${Object.entries(regionCounts).filter(([, count]) => count).map(([name, count]) => `${name}=${count}`).join(", ")}`);

const downloadRoot = args["download-root"] ? path.resolve(args["download-root"]) : null;
if (downloadRoot) {
  const animationRoot = path.join(downloadRoot, "animations");
  const sourceDirectories = await readdir(animationRoot, { withFileTypes: true });
  const animationKinds = [
    { key: "idle", needle: "idle_hover" },
    { key: "move", needle: "movement_glide" },
    { key: "charge", needle: "charge_attack" },
    { key: "hit", needle: "damage_reaction" },
    { key: "death", needle: "Death_animation" },
  ];
  for (const spec of animationKinds) {
    const directory = sourceDirectories.find((entry) => entry.isDirectory() && entry.name.toLowerCase().includes(spec.needle.toLowerCase()));
    if (!directory) continue;
    const sourceRoot = path.join(animationRoot, directory.name);
    const southFiles = (await readdir(path.join(sourceRoot, "south"))).filter((file) => /^frame_\d+\.png$/.test(file)).sort();
    if (!southFiles.length) continue;
    const frameCount = southFiles.length;
    const animationWidth = frameCount * cellSize;
    const animationHeight = directions.length * cellSize;
    const animationSource = new Uint8ClampedArray(animationWidth * animationHeight * 4);
    const animationMap = new Uint8ClampedArray(animationSource.length);
    const animationCounts = Object.fromEntries(VAULT_MATERIAL_REGIONS.map((region) => [region.name, 0]));
    for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
      const direction = directions[directionIndex];
      const files = (await readdir(path.join(sourceRoot, direction))).filter((file) => /^frame_\d+\.png$/.test(file)).sort();
      if (files.length !== frameCount) throw new Error(`${spec.key}/${direction} has ${files.length} frames; expected ${frameCount}`);
      for (let frameIndex = 0; frameIndex < files.length; frameIndex += 1) {
        const bytes = await readFile(path.join(sourceRoot, direction, files[frameIndex]));
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const frame = { direction, data: new Uint8ClampedArray(data), info };
        const center = findBodyCenter(frame);
        const destinationX = frameIndex * cellSize + Math.floor((cellSize - info.width) / 2);
        const destinationY = directionIndex * cellSize + Math.floor((cellSize - info.height) / 2);
        for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
          const sourceOffset = offsetOf(info.width, x, y);
          const targetOffset = offsetOf(animationWidth, destinationX + x, destinationY + y);
          animationSource.set(frame.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
          const id = regionForPixel(frame, x, y, center);
          const color = materialIdColor(id);
          animationMap.set(color, targetOffset);
          animationMap[targetOffset + 3] = id === 0 ? 0 : frame.data[sourceOffset + 3];
          animationCounts[VAULT_MATERIAL_REGIONS[id].name] += 1;
        }
      }
    }
    const animationOutput = path.join(root, "animations", spec.key);
    await mkdir(animationOutput, { recursive: true });
    const animationSourceBytes = await sharp(Buffer.from(animationSource), { raw: { width: animationWidth, height: animationHeight, channels: 4 } }).png().toBuffer();
    const animationMapBytes = await sharp(Buffer.from(animationMap), { raw: { width: animationWidth, height: animationHeight, channels: 4 } }).png().toBuffer();
    const animationProof = recolorVaultMaterialMapPixels(animationSource, animationMap, proofPalette);
    const animationProofBytes = await sharp(Buffer.from(animationProof), { raw: { width: animationWidth, height: animationHeight, channels: 4 } }).png().toBuffer();
    await writeFile(path.join(animationOutput, "source.png"), animationSourceBytes);
    await writeFile(path.join(animationOutput, "material-id-map.png"), animationMapBytes);
    await writeFile(path.join(animationOutput, "palette-proof.png"), animationProofBytes);
    await writeFile(path.join(animationOutput, "manifest.json"), `${JSON.stringify({
      schema: "vault-pixellab-enemy-animation@1",
      asset,
      animation: spec.key,
      state: "candidate-mechanical-pass-visual-review-required",
      provenance: { provider: "PixelLabs", objectId, sourceDirectory: directory.name },
      cellSize,
      directions,
      frameCount,
      layout: { columns: frameCount, rows: directions.length, width: animationWidth, height: animationHeight },
      source: { file: "source.png", sha256: sha256(animationSourceBytes) },
      materialMap: { file: "material-id-map.png", sha256: sha256(animationMapBytes), regions: animationCounts },
      paletteProof: { file: "palette-proof.png", sha256: sha256(animationProofBytes) },
    }, null, 2)}\n`);
    console.log(`Built ${asset}/${spec.key}: ${frameCount} frames x ${directions.length} directions`);
  }
}
