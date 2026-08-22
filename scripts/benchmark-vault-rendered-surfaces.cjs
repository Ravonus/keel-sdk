const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("../apps/studio/node_modules/@playwright/test");

const root = path.resolve(__dirname, "../examples/demos/vault-arcade/generated-attribute-proxy");
const seedCount = Math.max(1, Number(process.argv[process.argv.indexOf("--seeds") + 1] ?? 16));
const layerCount = Math.max(1, Number(process.argv[process.argv.indexOf("--layers") + 1] ?? 4));
const enforce = process.argv.includes("--enforce");
const workerCount = Math.min(4, Math.max(1, Number(process.argv[process.argv.indexOf("--workers") + 1] ?? 4)));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wav": "audio/wav",
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const target = path.resolve(root, `.${pathname === "/" ? "/vault-game.html" : pathname}`);
  if (!target.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(target, (error, bytes) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.code ?? "read-error");
      return;
    }
    response.writeHead(200, { "content-type": mime[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(bytes);
  });
});

function hamming(left, right) {
  let distance = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) distance += 1;
  return distance + Math.abs(left.length - right.length);
}

function percentile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
}

async function auditPage(page, base, seedIndex, layer) {
  const seed = `rendered-surface-${seedIndex}`;
  const url = `${base}/vault-game.html?mapSeed=${seed}&characterSeed=orb-character-001&artReview=1&autostart=1&reviewLayer=${layer}&v=rgba-surface-audit-1`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.documentElement.dataset.vaultGameReady === "true" && typeof globalThis.__vaultSurfaceAudit === "function", null, { timeout: 15_000 });
  await page.waitForTimeout(80);
  return page.evaluate(() => {
    const meta = globalThis.__vaultSurfaceAudit();
    const canvas = document.querySelector("#game");
    const pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const luminanceAt = (x, y) => {
      const offset = (Math.max(0, Math.min(canvas.height - 1, y)) * canvas.width + Math.max(0, Math.min(canvas.width - 1, x))) * 4;
      return pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
    };
    const visible = new Map();
    const tileSignatures = [];
    for (const tile of meta.tiles) {
      if (tile.kind === "wall" || tile.terrain !== "dry") continue;
      const screenX = tile.column * meta.tileWidth - meta.camera.x;
      const screenY = tile.row * meta.tileHeight - meta.camera.y;
      if (screenX < 0 || screenY < 0 || screenX + meta.tileWidth > canvas.width || screenY + meta.tileHeight > canvas.height) continue;
      const signature = [];
      for (let sampleY = 0; sampleY < 8; sampleY += 1) for (let sampleX = 0; sampleX < 8; sampleX += 1) {
        const left = Math.round(screenX + 8 + sampleX * 6);
        const top = Math.round(screenY + 8 + sampleY * 6);
        // Preserve the actual pixel-phase signal. Averaging a six-pixel block
        // erased exactly the material grain and micro-seams this gate is meant
        // to catch, allowing visibly repeated fields to look statistically
        // uniform even when the sampled RGBA differed.
        signature.push(luminanceAt(left + 3, top + 3));
      }
      const item = { ...tile, screenX, screenY, signature, mean: signature.reduce((sum, value) => sum + value, 0) / signature.length };
      visible.set(`${tile.column}:${tile.row}`, item);
      tileSignatures.push(item);
    }
    const signatureMae = (left, right) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
    let neighborPairs = 0;
    let nearNeighborPairs = 0;
    const adjacency = new Map([...visible.keys()].map((key) => [key, []]));
    const seamRatios = [];
    for (const item of tileSignatures) for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const neighbor = visible.get(`${item.column + dx}:${item.row + dy}`);
      if (!neighbor) continue;
      neighborPairs += 1;
      const near = signatureMae(item.signature, neighbor.signature) <= 4.5;
      if (near) {
        nearNeighborPairs += 1;
        adjacency.get(`${item.column}:${item.row}`).push(`${neighbor.column}:${neighbor.row}`);
        adjacency.get(`${neighbor.column}:${neighbor.row}`).push(`${item.column}:${item.row}`);
      }
      let boundary = 0;
      let local = 0;
      let samples = 0;
      if (dx) {
        const edgeX = Math.round(item.screenX + meta.tileWidth);
        for (let sample = 8; sample < meta.tileHeight - 8; sample += 4) {
          const edgeY = Math.round(item.screenY + sample);
          boundary += Math.abs(luminanceAt(edgeX - 1, edgeY) - luminanceAt(edgeX, edgeY));
          const localDifferences = [];
          for (let offset = -8; offset < 8; offset += 1) {
            if (offset === -1) continue;
            const difference = Math.abs(luminanceAt(edgeX + offset, edgeY) - luminanceAt(edgeX + offset + 1, edgeY));
            if (difference < 0.5) continue;
            localDifferences.push(difference);
          }
          localDifferences.sort((left, right) => left - right);
          local += localDifferences[localDifferences.length - 1] ?? 1;
          samples += 1;
        }
      } else {
        const edgeY = Math.round(item.screenY + meta.tileHeight);
        for (let sample = 8; sample < meta.tileWidth - 8; sample += 4) {
          const edgeX = Math.round(item.screenX + sample);
          boundary += Math.abs(luminanceAt(edgeX, edgeY - 1) - luminanceAt(edgeX, edgeY));
          const localDifferences = [];
          for (let offset = -8; offset < 8; offset += 1) {
            if (offset === -1) continue;
            const difference = Math.abs(luminanceAt(edgeX, edgeY + offset) - luminanceAt(edgeX, edgeY + offset + 1));
            if (difference < 0.5) continue;
            localDifferences.push(difference);
          }
          localDifferences.sort((left, right) => left - right);
          local += localDifferences[localDifferences.length - 1] ?? 1;
          samples += 1;
        }
      }
      seamRatios.push((boundary / Math.max(1, samples)) / Math.max(1, local / Math.max(1, samples)));
    }
    let largestNearComponent = 0;
    const visited = new Set();
    for (const key of adjacency.keys()) {
      if (visited.has(key)) continue;
      const stack = [key];
      let size = 0;
      visited.add(key);
      while (stack.length) {
        const current = stack.pop();
        size += 1;
        for (const next of adjacency.get(current)) if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
      largestNearComponent = Math.max(largestNearComponent, size);
    }
    let sixWindows = 0;
    let uniformSixWindows = 0;
    const windowHashes = [];
    for (const item of tileSignatures) {
      const cells = [];
      let complete = true;
      for (let wy = 0; wy < 6 && complete; wy += 1) for (let wx = 0; wx < 6; wx += 1) {
        const cell = visible.get(`${item.column + wx}:${item.row + wy}`);
        if (!cell) { complete = false; break; }
        cells.push(cell);
      }
      if (!complete) continue;
      sixWindows += 1;
      const mean = cells.reduce((sum, cell) => sum + cell.mean, 0) / cells.length;
      const deviation = Math.sqrt(cells.reduce((sum, cell) => sum + (cell.mean - mean) ** 2, 0) / cells.length);
      const meanPatchDistance = cells.slice(1).reduce((sum, cell) => sum + signatureMae(cells[0].signature, cell.signature), 0) / (cells.length - 1);
      if (deviation <= 1.8 && meanPatchDistance <= 4.5) uniformSixWindows += 1;
      windowHashes.push(cells.map((cell) => cell.signature.filter((_, index) => index % 9 === 0).map((value) => Math.round(value / 12)).join("")).join(":"));
    }
    const repeatedSixWindows = windowHashes.length - new Set(windowHashes).size;
    const sceneSamples = [];
    for (let sy = 0; sy < 8; sy += 1) for (let sx = 0; sx < 9; sx += 1) {
      let sum = 0;
      let count = 0;
      const left = Math.floor(sx * canvas.width / 9);
      const right = Math.floor((sx + 1) * canvas.width / 9);
      const top = Math.floor(sy * canvas.height / 8);
      const bottom = Math.floor((sy + 1) * canvas.height / 8);
      for (let y = top; y < bottom; y += 6) for (let x = left; x < right; x += 6) { sum += luminanceAt(x, y); count += 1; }
      sceneSamples.push(sum / Math.max(1, count));
    }
    const sceneHash = [];
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) sceneHash.push(sceneSamples[row * 9 + column] > sceneSamples[row * 9 + column + 1] ? "1" : "0");
    return {
      mapSeed: meta.mapSeed,
      layer: meta.layer,
      biome: meta.biome,
      palette: meta.palette,
      neighborPairs,
      nearNeighborPairs,
      largestNearComponent,
      sixWindows,
      uniformSixWindows,
      repeatedSixWindows,
      seamRatios,
      sceneHash: sceneHash.join(""),
      consoleErrors: Number(document.documentElement.dataset.vaultRuntimeErrors ?? 0),
    };
  });
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined });
  const base = `http://127.0.0.1:${port}`;
  const jobs = [];
  for (let seed = 0; seed < seedCount; seed += 1) for (let layer = 1; layer <= layerCount; layer += 1) jobs.push({ seed, layer });
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      results.push(await auditPage(page, base, job.seed, job.layer));
    }
    await page.close();
  }));
  await browser.close();
  server.close();

  const totals = results.reduce((summary, result) => {
    summary.neighborPairs += result.neighborPairs;
    summary.nearNeighborPairs += result.nearNeighborPairs;
    summary.sixWindows += result.sixWindows;
    summary.uniformSixWindows += result.uniformSixWindows;
    summary.repeatedSixWindows += result.repeatedSixWindows;
    summary.largestNearComponent = Math.max(summary.largestNearComponent, result.largestNearComponent);
    summary.seamRatios.push(...result.seamRatios);
    summary.biomes[result.biome] = (summary.biomes[result.biome] ?? 0) + 1;
    return summary;
  }, { neighborPairs: 0, nearNeighborPairs: 0, sixWindows: 0, uniformSixWindows: 0, repeatedSixWindows: 0, largestNearComponent: 0, seamRatios: [], biomes: {} });
  let nearDuplicateScenes = 0;
  let scenePairs = 0;
  for (let left = 0; left < results.length; left += 1) for (let right = left + 1; right < results.length; right += 1) {
    if (results[left].biome !== results[right].biome) continue;
    scenePairs += 1;
    if (hamming(results[left].sceneHash, results[right].sceneHash) <= 4) nearDuplicateScenes += 1;
  }
  const summarizeResults = (subset) => {
    const summary = subset.reduce((value, result) => {
      value.neighborPairs += result.neighborPairs;
      value.nearNeighborPairs += result.nearNeighborPairs;
      value.sixWindows += result.sixWindows;
      value.uniformSixWindows += result.uniformSixWindows;
      value.repeatedSixWindows += result.repeatedSixWindows;
      value.largestNearComponent = Math.max(value.largestNearComponent, result.largestNearComponent);
      value.seamRatios.push(...result.seamRatios);
      value.runtimeErrors += result.consoleErrors;
      return value;
    }, { neighborPairs: 0, nearNeighborPairs: 0, sixWindows: 0, uniformSixWindows: 0, repeatedSixWindows: 0, largestNearComponent: 0, seamRatios: [], runtimeErrors: 0 });
    return {
      layouts: subset.length,
      perceptualSameNeighborRate: summary.nearNeighborPairs / Math.max(1, summary.neighborPairs),
      uniformActualSixBySixRate: summary.uniformSixWindows / Math.max(1, summary.sixWindows),
      repeatedActualSixBySixRate: summary.repeatedSixWindows / Math.max(1, summary.sixWindows),
      largestPerceptuallySameRegion: summary.largestNearComponent,
      seamRatioP95: percentile(summary.seamRatios, 0.95),
      runtimeErrors: summary.runtimeErrors,
    };
  };
  const report = {
    schema: "vault-rendered-surface-benchmark@1",
    layouts: results.length,
    seeds: seedCount,
    layers: layerCount,
    biomes: totals.biomes,
    byBiome: Object.fromEntries(Object.keys(totals.biomes).sort().map((biome) => [biome, summarizeResults(results.filter((result) => result.biome === biome))])),
    metrics: {
      perceptualSameNeighborRate: totals.nearNeighborPairs / Math.max(1, totals.neighborPairs),
      uniformActualSixBySixRate: totals.uniformSixWindows / Math.max(1, totals.sixWindows),
      repeatedActualSixBySixRate: totals.repeatedSixWindows / Math.max(1, totals.sixWindows),
      largestPerceptuallySameRegion: totals.largestNearComponent,
      nearDuplicateSceneRate: nearDuplicateScenes / Math.max(1, scenePairs),
      seamRatioP95: percentile(totals.seamRatios, 0.95),
      runtimeErrors: results.reduce((sum, result) => sum + result.consoleErrors, 0),
    },
    gates: {
      perceptualSameNeighborRateMax: 0.35,
      uniformActualSixBySixRateMax: 0.02,
      repeatedActualSixBySixRateMax: 0.10,
      largestPerceptuallySameRegionMax: 36,
      nearDuplicateSceneRateMax: 0.05,
      seamRatioP95Max: 1.5,
      runtimeErrorsMax: 0,
    },
  };
  report.pass = Object.entries(report.gates).every(([gate, limit]) => {
    const metric = gate.replace(/Max$/, "");
    return report.metrics[metric] <= limit;
  }) && Object.keys(report.biomes).length === 4;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (enforce && !report.pass) process.exitCode = 1;
})().catch((error) => {
  server.close();
  console.error(error);
  process.exitCode = 1;
});
