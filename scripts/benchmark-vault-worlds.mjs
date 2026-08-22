import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArenaLayout,
  createLayerProfile,
  createRunDescriptor,
  deterministicFingerprint,
} from "../examples/demos/vault-arcade/generated-attribute-proxy/vault-game-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const atlasPath = path.join(
  repoRoot,
  "examples/demos/vault-arcade/generated-attribute-proxy/vault-game-atlas-v1.json",
);
const atlas = JSON.parse(await readFile(atlasPath, "utf8"));
const seedCount = Number.parseInt(valueAfter("--seeds") ?? "96", 10);
const layersPerSeed = Number.parseInt(valueAfter("--layers") ?? "4", 10);
const outPath = valueAfter("--out");
const enforce = process.argv.includes("--enforce");

if (!Number.isInteger(seedCount) || seedCount < 8 || seedCount > 2_000) {
  throw new Error("--seeds must be an integer from 8 through 2000");
}
if (!Number.isInteger(layersPerSeed) || layersPerSeed < 1 || layersPerSeed > 24) {
  throw new Error("--layers must be an integer from 1 through 24");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentile(values, amount) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * amount))] ?? 0;
}

function connected(layout) {
  const start = layout.rooms[0].row * layout.columns + layout.rooms[0].column;
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const index = queue.shift();
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    for (const [nextColumn, nextRow] of [
      [column - 1, row],
      [column + 1, row],
      [column, row - 1],
      [column, row + 1],
    ]) {
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= layout.columns || nextRow >= layout.rows) continue;
      const next = nextRow * layout.columns + nextColumn;
      const tile = layout.tiles[next];
      if (visited.has(next) || tile.kind === "wall" || tile.traversable === false) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return layout.rooms.every((room) => visited.has(room.row * layout.columns + room.column));
}

function featureCount(layout, feature, fallback = () => false) {
  return layout.features?.[feature]?.length
    ?? layout.tiles.filter((tile) => tile.feature === feature || fallback(tile)).length
    ?? 0;
}

function layoutSignature(layout) {
  return deterministicFingerprint({
    columns: layout.columns,
    rows: layout.rows,
    rooms: layout.rooms.map((room) => ({
      column: room.column,
      row: room.row,
      width: room.width,
      height: room.height,
      role: room.role,
      mission: room.mission,
      situation: room.situation?.id ?? room.situation ?? null,
      elevation: room.elevation ?? 0,
    })),
    connections: layout.connections.map((connection) => ({
      from: connection.from,
      to: connection.to,
      axis: connection.door.axis,
      bridge: connection.bridge?.id ?? null,
      ramp: connection.ramp?.id ?? null,
    })),
    terrain: layout.tiles.map((tile) => [
      tile.kind,
      tile.terrain,
      tile.elevation ?? 0,
      tile.feature ?? null,
    ]),
    objects: layout.objects.map((object) => [object.type, object.roomId, Math.round(object.x), Math.round(object.y)]),
  });
}

const startedAt = performance.now();
const generationTimes = [];
const layouts = [];
for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
  const mapSeed = `vault-gauntlet-${seedIndex.toString().padStart(4, "0")}`;
  const run = createRunDescriptor(atlas, mapSeed, `vault-character-${seedIndex % 17}`);
  for (let layer = 1; layer <= layersPerSeed; layer += 1) {
    const profile = createLayerProfile(atlas, run, layer);
    const generationStartedAt = performance.now();
    const layout = createArenaLayout(run, profile);
    generationTimes.push(performance.now() - generationStartedAt);
    const replay = createArenaLayout(run, profile);
    const terrain = Object.fromEntries(
      [...new Set(layout.tiles.map((tile) => tile.terrain ?? "dry"))]
        .map((name) => [name, layout.tiles.filter((tile) => (tile.terrain ?? "dry") === name).length]),
    );
    layouts.push({
      mapSeed,
      layer,
      biome: profile.biome,
      profileFingerprint: deterministicFingerprint(profile),
      fingerprint: deterministicFingerprint(layout),
      replayFingerprint: deterministicFingerprint(replay),
      signature: layoutSignature(layout),
      connected: connected(layout),
      terrain,
      roomCount: layout.rooms.length,
      situationCount: new Set(layout.rooms.map((room) => room.situation?.id ?? room.situation).filter(Boolean)).size,
      animatedObjectCount: layout.objects.filter((object) => object.animation && object.animation !== "static").length,
      water: featureCount(layout, "water-body", (tile) => tile.terrain === "water"),
      lava: featureCount(layout, "lava-body", (tile) => tile.terrain === "lava"),
      otherBodies: featureCount(layout, "other-body", (tile) => ["void", "acid", "mist"].includes(tile.terrain)),
      cliffs: featureCount(layout, "cliff"),
      ramps: featureCount(layout, "ramp"),
      bridges: featureCount(layout, "bridge"),
      dynamicBridges: featureCount(layout, "dynamic-bridge"),
      towers: layout.objects.filter((object) => object.type?.includes("tower") || object.feature === "tower").length,
      foliage: layout.objects.filter((object) => object.type?.includes("foliage") || object.feature === "foliage").length,
    });
  }
}

const total = layouts.length;
const uniqueSignatures = new Set(layouts.map((layout) => layout.signature)).size;
const distinctBiomes = new Set(layouts.map((layout) => layout.biome)).size;
const coverage = (predicate) => layouts.filter(predicate).length / total;
const metrics = {
  generatedLayouts: total,
  seedCount,
  layersPerSeed,
  deterministicReplayRate: coverage((layout) => layout.fingerprint === layout.replayFingerprint),
  connectedLayoutRate: coverage((layout) => layout.connected),
  uniqueWorldSignatureRate: uniqueSignatures / total,
  distinctBiomes,
  multiSituationLayoutRate: coverage((layout) => layout.situationCount >= 2),
  animatedWorldLayoutRate: coverage((layout) => layout.animatedObjectCount >= 2),
  waterBodyLayoutRate: coverage((layout) => layout.water > 0),
  lavaBodyLayoutRate: coverage((layout) => layout.lava > 0),
  otherBodyLayoutRate: coverage((layout) => layout.otherBodies > 0),
  bodyLayoutRate: coverage((layout) => layout.water > 0 || layout.lava > 0 || layout.otherBodies > 0),
  cliffLayoutRate: coverage((layout) => layout.cliffs > 0),
  rampLayoutRate: coverage((layout) => layout.ramps >= 2),
  bridgeLayoutRate: coverage((layout) => layout.bridges > 0),
  dynamicBridgeLayoutRate: coverage((layout) => layout.dynamicBridges > 0),
  towerLayoutRate: coverage((layout) => layout.towers > 0),
  foliageLayoutRate: coverage((layout) => layout.foliage >= 3),
  generationMilliseconds: {
    median: Number(percentile(generationTimes, 0.5).toFixed(3)),
    p95: Number(percentile(generationTimes, 0.95).toFixed(3)),
    maximum: Number(Math.max(...generationTimes).toFixed(3)),
    total: Number((performance.now() - startedAt).toFixed(3)),
  },
};

const gates = {
  deterministicReplay: { threshold: 1, actual: metrics.deterministicReplayRate },
  connectedWorlds: { threshold: 1, actual: metrics.connectedLayoutRate },
  worldUniqueness: { threshold: 0.98, actual: metrics.uniqueWorldSignatureRate },
  biomeCoverage: { threshold: 4, actual: metrics.distinctBiomes },
  authoredSituations: { threshold: 0.9, actual: metrics.multiSituationLayoutRate },
  breathingWorld: { threshold: 0.9, actual: metrics.animatedWorldLayoutRate },
  bodiesOfMaterial: { threshold: 0.7, actual: metrics.bodyLayoutRate },
  cliffs: { threshold: 0.7, actual: metrics.cliffLayoutRate },
  doubleLayerRamps: { threshold: 0.7, actual: metrics.rampLayoutRate },
  bridges: { threshold: 0.6, actual: metrics.bridgeLayoutRate },
  dynamicBridges: { threshold: 0.25, actual: metrics.dynamicBridgeLayoutRate },
  towers: { threshold: 0.55, actual: metrics.towerLayoutRate },
  foliage: { threshold: 0.7, actual: metrics.foliageLayoutRate },
  generationP95: { threshold: 85, actual: metrics.generationMilliseconds.p95, comparison: "maximum" },
};
for (const gate of Object.values(gates)) {
  gate.pass = gate.comparison === "maximum" ? gate.actual <= gate.threshold : gate.actual >= gate.threshold;
}

const receipt = {
  schema: "vault-world-benchmark@1",
  generatedAt: new Date().toISOString(),
  implementation: "vault-game-core.mjs:createArenaLayout",
  parameters: { seedCount, layersPerSeed },
  metrics,
  gates,
  pass: Object.values(gates).every((gate) => gate.pass),
  sample: layouts.slice(0, 12),
};

const output = `${JSON.stringify(receipt, null, 2)}\n`;
if (outPath) {
  const absolute = path.resolve(repoRoot, outPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, output);
}
process.stdout.write(output);
if (enforce && !receipt.pass) process.exitCode = 1;
