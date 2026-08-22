import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  FORGE_DRIFTER_PROOF_PALETTE,
  VAULT_MATERIAL_REGIONS,
  classifyVaultMaterial,
  materialIdColor,
  recolorVaultMaterialPixels,
} from "../examples/demos/vault-arcade/generated-attribute-proxy/vault-material-targets.mjs";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const root = path.resolve("examples/demos/vault-arcade/generated-attribute-proxy/assets/enemies/candidates/forge-drifter-v1");
const sourcePath = path.join(root, "eight-direction-master.png");
const sourceBytes = await readFile(sourcePath);
const sourceImage = sharp(sourceBytes).ensureAlpha();
const metadata = await sourceImage.metadata();
const { data, info } = await sourceImage.raw().toBuffer({ resolveWithObject: true });
const columns = 4;
const rows = 2;
const cellSize = 48;
const padding = 2;
const outputWidth = columns * cellSize;
const outputHeight = rows * cellSize;
const normalized = new Uint8ClampedArray(outputWidth * outputHeight * 4);
const cells = [];

function alphaAt(x, y) {
  return data[(y * info.width + x) * 4 + 3];
}

for (let index = 0; index < columns * rows; index += 1) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const left = Math.round(column * info.width / columns);
  const right = Math.round((column + 1) * info.width / columns);
  const top = Math.round(row * info.height / rows);
  const bottom = Math.round((row + 1) * info.height / rows);
  let minX = right;
  let minY = bottom;
  let maxX = left;
  let maxY = top;
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    if (alphaAt(x, y) < 24) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error(`Direction cell ${index} is empty.`);
  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const scale = Math.min((cellSize - padding * 2) / contentWidth, (cellSize - padding * 2) / contentHeight);
  const drawWidth = Math.max(1, Math.round(contentWidth * scale));
  const drawHeight = Math.max(1, Math.round(contentHeight * scale));
  const destinationX = column * cellSize + Math.floor((cellSize - drawWidth) / 2);
  const destinationY = row * cellSize + cellSize - padding - drawHeight;
  for (let y = 0; y < drawHeight; y += 1) for (let x = 0; x < drawWidth; x += 1) {
    const sourceX = Math.min(maxX, minX + Math.floor(x / scale));
    const sourceY = Math.min(maxY, minY + Math.floor(y / scale));
    const sourceOffset = (sourceY * info.width + sourceX) * 4;
    const targetOffset = ((destinationY + y) * outputWidth + destinationX + x) * 4;
    normalized[targetOffset] = data[sourceOffset];
    normalized[targetOffset + 1] = data[sourceOffset + 1];
    normalized[targetOffset + 2] = data[sourceOffset + 2];
    normalized[targetOffset + 3] = data[sourceOffset + 3];
  }
  cells.push({ index, sourceBounds: [minX, minY, maxX, maxY], normalizedBounds: [destinationX, destinationY, destinationX + drawWidth - 1, destinationY + drawHeight - 1] });
}

const targetMap = new Uint8ClampedArray(normalized.length);
const regionCounts = Object.fromEntries(VAULT_MATERIAL_REGIONS.map((region) => [region.name, 0]));
for (let offset = 0; offset < normalized.length; offset += 4) {
  const id = classifyVaultMaterial(normalized[offset], normalized[offset + 1], normalized[offset + 2], normalized[offset + 3]);
  regionCounts[VAULT_MATERIAL_REGIONS[id].name] += 1;
  const color = materialIdColor(id);
  targetMap[offset] = color[0];
  targetMap[offset + 1] = color[1];
  targetMap[offset + 2] = color[2];
  targetMap[offset + 3] = id === 0 ? 0 : normalized[offset + 3];
}
const recolored = recolorVaultMaterialPixels(normalized, FORGE_DRIFTER_PROOF_PALETTE);

await mkdir(root, { recursive: true });
const normalizedBytes = await sharp(Buffer.from(normalized), { raw: { width: outputWidth, height: outputHeight, channels: 4 } }).png().toBuffer();
const targetBytes = await sharp(Buffer.from(targetMap), { raw: { width: outputWidth, height: outputHeight, channels: 4 } }).png().toBuffer();
const recoloredBytes = await sharp(Buffer.from(recolored), { raw: { width: outputWidth, height: outputHeight, channels: 4 } }).png().toBuffer();
await writeFile(path.join(root, "eight-direction-48.png"), normalizedBytes);
await writeFile(path.join(root, "material-id-map-48.png"), targetBytes);
await writeFile(path.join(root, "palette-proof-48.png"), recoloredBytes);
const sha256 = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;
await writeFile(path.join(root, "candidate-report.json"), `${JSON.stringify({
  schema: "vault-enemy-candidate-report@1",
  asset: "forge-drifter-v1",
  state: "candidate-mechanical-pass-visual-review-required",
  source: { file: "eight-direction-master.png", width: metadata.width, height: metadata.height, sha256: sha256(sourceBytes) },
  normalized: { file: "eight-direction-48.png", width: outputWidth, height: outputHeight, cellSize, sha256: sha256(normalizedBytes) },
  materialMap: { file: "material-id-map-48.png", sha256: sha256(targetBytes), regions: regionCounts },
  paletteProof: { file: "palette-proof-48.png", sha256: sha256(recoloredBytes) },
  cells,
}, null, 2)}\n`);
console.log(`Built Forge Drifter target pack: ${outputWidth}x${outputHeight}, ${Object.entries(regionCounts).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`).join(", ")}`);
