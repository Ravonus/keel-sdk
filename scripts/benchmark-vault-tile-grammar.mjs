import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArenaLayout,
  createLayerProfile,
  createRunDescriptor,
  deterministicFingerprint,
} from "../examples/demos/vault-arcade/generated-attribute-proxy/vault-game-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const atlas = JSON.parse(await readFile(path.join(root, "examples/demos/vault-arcade/generated-attribute-proxy/vault-game-atlas-v1.json"), "utf8"));
const seedCount = Number.parseInt(valueAfter("--seeds") ?? "64", 10);
const layers = Number.parseInt(valueAfter("--layers") ?? "4", 10);
const outputPath = valueAfter("--out");
const enforce = process.argv.includes("--enforce");

if (!Number.isInteger(seedCount) || seedCount < 8 || seedCount > 2_000) throw new Error("--seeds must be 8..2000");
if (!Number.isInteger(layers) || layers < 1 || layers > 24) throw new Error("--layers must be 1..24");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function sourceKey(tile) {
  if (tile.kind === "wall") return `wall:${tile.wallFamily}:${tile.wallJoinRole}:${tile.exposureMask}`;
  if (tile.kind === "door") return `door:${tile.doorAxis}:${tile.doorSegment ?? 0}`;
  if ((tile.terrain ?? "dry") !== "dry") return `terrain:${tile.terrain}:${tile.terrainMask}`;
  return `macro:${tile.floorMacroColumn}:${tile.floorMacroRow}`;
}

function semanticKey(tile) {
  return `${sourceKey(tile)}:motif:${tile.motifActive ? tile.motifMask : 0}:role:${tile.motifRole}:decor:${tile.decorVariant}`;
}

function analyze(layout) {
  let adjacentPairs = 0;
  let sameAdjacentPairs = 0;
  for (let row = 0; row < layout.rows; row += 1) for (let column = 0; column < layout.columns; column += 1) {
    const tile = layout.tiles[row * layout.columns + column];
    if (tile.kind === "wall" || tile.kind === "door" || (tile.terrain ?? "dry") !== "dry") continue;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const neighbour = layout.tiles[(row + dy) * layout.columns + column + dx];
      if (!neighbour || neighbour.kind === "wall" || neighbour.kind === "door" || (neighbour.terrain ?? "dry") !== "dry") continue;
      adjacentPairs += 1;
      if (sourceKey(tile) === sourceKey(neighbour)) sameAdjacentPairs += 1;
    }
  }

  let sampledWindows = 0;
  let uniformWindows = 0;
  const signatures = [];
  for (let row = 0; row <= layout.rows - 6; row += 3) for (let column = 0; column <= layout.columns - 6; column += 3) {
    const window = [];
    let valid = true;
    for (let y = 0; y < 6 && valid; y += 1) for (let x = 0; x < 6; x += 1) {
      const tile = layout.tiles[(row + y) * layout.columns + column + x];
      if (tile.kind === "wall" || tile.kind === "door" || (tile.terrain ?? "dry") !== "dry") { valid = false; break; }
      window.push(semanticKey(tile));
    }
    if (!valid) continue;
    sampledWindows += 1;
    if (new Set(window.map((key) => key.split(":motif:")[0])).size === 1) uniformWindows += 1;
    signatures.push(deterministicFingerprint(window));
  }
  const signatureCounts = new Map();
  for (const signature of signatures) signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  const repeatedWindows = [...signatureCounts.values()].reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);

  const visited = new Set();
  let largestComponent = 0;
  for (let index = 0; index < layout.tiles.length; index += 1) {
    if (visited.has(index)) continue;
    const origin = layout.tiles[index];
    if (origin.kind === "wall" || origin.kind === "door" || (origin.terrain ?? "dry") !== "dry") continue;
    const key = sourceKey(origin);
    const queue = [index];
    visited.add(index);
    let count = 0;
    while (queue.length) {
      const current = queue.pop();
      count += 1;
      const column = current % layout.columns;
      const row = Math.floor(current / layout.columns);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const x = column + dx;
        const y = row + dy;
        if (x < 0 || y < 0 || x >= layout.columns || y >= layout.rows) continue;
        const next = y * layout.columns + x;
        if (visited.has(next) || sourceKey(layout.tiles[next]) !== key) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    largestComponent = Math.max(largestComponent, count);
  }

  const objectCells = layout.objects.map((object) => `${Math.floor(object.x / layout.tileWidth)},${Math.floor(object.y / layout.tileHeight)}`);
  const spawnCells = new Set(layout.rooms.flatMap((room) => room.spawnSockets.map((socket) => `${Math.floor(socket.x / layout.tileWidth)},${Math.floor(socket.y / layout.tileHeight)}`)));
  const motifSignatures = new Set(layout.rooms.map((room) => deterministicFingerprint(
    layout.tiles.filter((tile) => tile.roomId === room.id && tile.kind !== "wall").map((tile) => [tile.motifActive, tile.motifMask, tile.floorBase]),
  ))).size;
  return {
    adjacentPairs,
    sameAdjacentPairs,
    sampledWindows,
    uniformWindows,
    repeatedWindows,
    largestComponent,
    objectDuplicates: objectCells.length - new Set(objectCells).size,
    objectSpawnOverlaps: objectCells.filter((cell) => spawnCells.has(cell)).length,
    unresolvedWalls: layout.tiles.filter((tile) => tile.kind === "wall" && (!tile.wallJoinRole || !Number.isInteger(tile.exposureMask))).length,
    unresolvedDoors: layout.tiles.filter((tile) => tile.kind === "door" && !["horizontal", "vertical"].includes(tile.doorAxis)).length,
    motifSignatures,
    roomCount: layout.rooms.length,
  };
}

const samples = [];
for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
  const run = createRunDescriptor(atlas, `tile-grammar-${seedIndex}`, `character-${seedIndex % 11}`);
  for (let layer = 1; layer <= layers; layer += 1) {
    const profile = createLayerProfile(atlas, run, layer);
    const layout = createArenaLayout(run, profile);
    samples.push({ seedIndex, layer, biome: profile.biome, ...analyze(layout) });
  }
}

const sum = (field) => samples.reduce((total, sample) => total + sample[field], 0);
const metrics = {
  layouts: samples.length,
  biomes: [...new Set(samples.map((sample) => sample.biome))].sort(),
  sameNeighbourRate: sum("sameAdjacentPairs") / Math.max(1, sum("adjacentPairs")),
  uniformSixBySixRate: sum("uniformWindows") / Math.max(1, sum("sampledWindows")),
  repeatedSixBySixRate: sum("repeatedWindows") / Math.max(1, sum("sampledWindows")),
  largestSameCellComponent: Math.max(...samples.map((sample) => sample.largestComponent)),
  objectDuplicates: sum("objectDuplicates"),
  objectSpawnOverlaps: sum("objectSpawnOverlaps"),
  unresolvedWalls: sum("unresolvedWalls"),
  unresolvedDoors: sum("unresolvedDoors"),
  distinctRoomMotifRate: samples.reduce((total, sample) => total + sample.motifSignatures / sample.roomCount, 0) / samples.length,
};
const gates = {
  sameNeighbourRate: { comparison: "max", threshold: 0.35, actual: metrics.sameNeighbourRate },
  uniformSixBySixRate: { comparison: "max", threshold: 0.02, actual: metrics.uniformSixBySixRate },
  repeatedSixBySixRate: { comparison: "max", threshold: 0.10, actual: metrics.repeatedSixBySixRate },
  largestSameCellComponent: { comparison: "max", threshold: 36, actual: metrics.largestSameCellComponent },
  objectDuplicates: { comparison: "max", threshold: 0, actual: metrics.objectDuplicates },
  objectSpawnOverlaps: { comparison: "max", threshold: 0, actual: metrics.objectSpawnOverlaps },
  unresolvedWalls: { comparison: "max", threshold: 0, actual: metrics.unresolvedWalls },
  unresolvedDoors: { comparison: "max", threshold: 0, actual: metrics.unresolvedDoors },
  distinctRoomMotifRate: { comparison: "min", threshold: 0.75, actual: metrics.distinctRoomMotifRate },
};
for (const gate of Object.values(gates)) gate.pass = gate.comparison === "max" ? gate.actual <= gate.threshold : gate.actual >= gate.threshold;

const receipt = {
  schema: "vault-tile-grammar-benchmark@1",
  generatedAt: new Date().toISOString(),
  parameters: { seedCount, layers },
  metrics,
  gates,
  pass: Object.values(gates).every((gate) => gate.pass),
};
const output = `${JSON.stringify(receipt, null, 2)}\n`;
if (outputPath) {
  const absolute = path.resolve(root, outputPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, output);
}
process.stdout.write(output);
if (enforce && !receipt.pass) process.exitCode = 1;
