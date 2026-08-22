import { hashString } from "./vault-authored-surface.mjs";

export const AUTHORED_QUILT_PROTOTYPE = "authored-quilt-v1";
export const AUTHORED_SURFACE_CACHE_MAX_BYTES = 16 * 1024 * 1024;

const TILE_SIZE = 64;
const SURFACE_CHUNK_CELLS = 4;
const COMMIT_BATCH_CHUNKS = 1;
const SUPPORTED_BIOMES = new Set(["occult-machine-catacomb", "industrial-forge"]);
const SYNTHESIS_BY_BIOME = Object.freeze({
  "occult-machine-catacomb": Object.freeze({
    patchSize: 192,
    overlap: 48,
    stride: 13,
    shortlistSize: 8,
    sampleStride: 12,
    candidateLimit: 32,
    candidateReuseWeight: 5000,
    periodicBoundaryPeriod: TILE_SIZE,
    periodicBoundaryWeight: 1500,
    periodicBoundarySampleStride: 12,
  }),
  "industrial-forge": Object.freeze({
    patchSize: 192,
    overlap: 48,
    stride: 31,
    shortlistSize: 8,
    sampleStride: 12,
    candidateLimit: 64,
    candidateReuseWeight: 0,
    periodicBoundaryPeriod: TILE_SIZE,
    periodicBoundaryWeight: 1000,
    periodicBoundarySampleStride: 12,
  }),
});

function hex32(value) {
  return hashString(value).toString(16).padStart(8, "0");
}

function cellKey(column, row) {
  return `${column},${row}`;
}

function regionBounds(cells, tileWidth, tileHeight) {
  if (!cells.length) throw new Error("Authored surface composition has no cells");
  const left = Math.min(...cells.map((cell) => cell.column));
  const top = Math.min(...cells.map((cell) => cell.row));
  const right = Math.max(...cells.map((cell) => cell.column)) + 1;
  const bottom = Math.max(...cells.map((cell) => cell.row)) + 1;
  return {
    left,
    top,
    right,
    bottom,
    x: left * tileWidth,
    y: top * tileHeight,
    width: (right - left) * tileWidth,
    height: (bottom - top) * tileHeight,
  };
}

function connectedCorridorRegions(arena) {
  const remaining = new Map();
  for (let index = 0; index < arena.tiles.length; index += 1) {
    const tile = arena.tiles[index];
    if (tile.kind !== "corridor" || tile.roomId) continue;
    const cell = { column: index % arena.columns, row: Math.floor(index / arena.columns) };
    remaining.set(cellKey(cell.column, cell.row), cell);
  }
  const regions = [];
  while (remaining.size) {
    const first = [...remaining.values()].sort((left, right) => left.row - right.row || left.column - right.column)[0];
    const pending = [first];
    const cells = [];
    remaining.delete(cellKey(first.column, first.row));
    while (pending.length) {
      const cell = pending.shift();
      cells.push(cell);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const key = cellKey(cell.column + dx, cell.row + dy);
        const neighbor = remaining.get(key);
        if (!neighbor) continue;
        remaining.delete(key);
        pending.push(neighbor);
      }
    }
    cells.sort((left, right) => left.row - right.row || left.column - right.column);
    const fingerprint = cells.map((cell) => `${cell.column},${cell.row}`).join(";");
    regions.push({
      type: "corridor",
      id: `corridor-${hex32(fingerprint)}`,
      cells,
      ...regionBounds(cells, arena.tileWidth, arena.tileHeight),
    });
  }
  return regions.sort((left, right) => left.top - right.top || left.left - right.left || left.id.localeCompare(right.id));
}

export function resolveAuthoredQuiltPrototype(searchParameters, developmentQueryAllowed) {
  return Boolean(developmentQueryAllowed)
    && searchParameters.get("dev") === "1"
    && searchParameters.get("floorPrototype") === AUTHORED_QUILT_PROTOTYPE;
}

export function buildAuthoredSurfaceRegions({ arena, mapSeed, layer, biome }) {
  if (!SUPPORTED_BIOMES.has(biome)) return [];
  const rooms = arena.rooms.map((room) => {
    const cells = [];
    for (let index = 0; index < arena.tiles.length; index += 1) {
      const tile = arena.tiles[index];
      if (tile.roomId !== room.id || tile.kind === "wall") continue;
      cells.push({ column: index % arena.columns, row: Math.floor(index / arena.columns) });
    }
    cells.sort((left, right) => left.row - right.row || left.column - right.column);
    return {
      type: "room",
      id: room.id,
      macro: biome === "occult-machine-catacomb" ? room.floorMacro : null,
      macroTransform: room.motifTransform ?? "r0",
      cells,
      ...regionBounds(cells, arena.tileWidth, arena.tileHeight),
    };
  });
  const regions = [...rooms, ...connectedCorridorRegions(arena)];
  for (const region of regions) {
    region.key = `${mapSeed}:${layer}:${biome}:${region.type}:${region.id}`;
    region.compositionByteSize = region.width * region.height * 4;
  }
  return regions;
}

export function buildAuthoredSurfaceChunks(regions, tileWidth = TILE_SIZE, tileHeight = TILE_SIZE) {
  const chunks = [];
  for (const region of regions) {
    const buckets = new Map();
    for (const cell of region.cells) {
      const chunkColumn = Math.floor(cell.column / SURFACE_CHUNK_CELLS);
      const chunkRow = Math.floor(cell.row / SURFACE_CHUNK_CELLS);
      const key = `${chunkColumn},${chunkRow}`;
      const bucket = buckets.get(key) ?? { chunkColumn, chunkRow, cells: [] };
      bucket.cells.push(cell);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.cells.sort((left, right) => left.row - right.row || left.column - right.column);
      const bounds = regionBounds(bucket.cells, tileWidth, tileHeight);
      chunks.push({
        type: region.type,
        regionId: region.id,
        regionKey: region.key,
        key: `${region.key}:chunk:${bucket.chunkColumn}:${bucket.chunkRow}`,
        cells: bucket.cells,
        localX: bounds.x - region.x,
        localY: bounds.y - region.y,
        byteSize: bounds.width * bounds.height * 4,
        ...bounds,
      });
    }
  }
  return chunks.sort((left, right) => left.top - right.top || left.left - right.left || left.key.localeCompare(right.key));
}

export function surfaceChunksForViewport(chunks, viewport) {
  return chunks.filter((chunk) => chunk.x < viewport.right && chunk.x + chunk.width > viewport.left
    && chunk.y < viewport.bottom && chunk.y + chunk.height > viewport.top);
}

export function visibleSurfaceChunkBytes(chunks, viewport) {
  return surfaceChunksForViewport(chunks, viewport).reduce((sum, chunk) => sum + chunk.byteSize, 0);
}

export function planMissingSurfaceCompositions(visibleChunks, residentKeys = new Set(), pendingKeys = new Set()) {
  const byRegion = new Map();
  for (const chunk of visibleChunks) {
    if (residentKeys.has(chunk.key) || pendingKeys.has(chunk.key)) continue;
    const job = byRegion.get(chunk.regionKey) ?? { regionKey: chunk.regionKey, chunks: [] };
    job.chunks.push(chunk);
    byRegion.set(chunk.regionKey, job);
  }
  return [...byRegion.values()].sort((left, right) => left.regionKey.localeCompare(right.regionKey));
}

export function authoredSurfaceWorldDescriptorHash(regions, chunks) {
  const normalizedRegions = regions.map((region) => ({
    key: region.key,
    bounds: [region.left, region.top, region.right, region.bottom],
    macro: region.macro,
    macroTransform: region.macroTransform,
    cells: region.cells.map((cell) => [cell.column, cell.row]).sort((left, right) => left[1] - right[1] || left[0] - right[0]),
  })).sort((left, right) => left.key.localeCompare(right.key));
  const normalizedChunks = chunks.map((chunk) => ({
    key: chunk.key,
    regionKey: chunk.regionKey,
    bounds: [chunk.left, chunk.top, chunk.right, chunk.bottom],
    cells: chunk.cells.map((cell) => [cell.column, cell.row]).sort((left, right) => left[1] - right[1] || left[0] - right[0]),
  })).sort((left, right) => left.key.localeCompare(right.key));
  return hex32(JSON.stringify({
    compositions: normalizedRegions,
    chunks: normalizedChunks,
  }));
}

export function buildBaselineRenderDescriptor({ arena, mapSeed, layer, biome, palette }) {
  return {
    schema: arena.schema,
    mapSeed,
    layer,
    biome,
    palette,
    geometry: {
      columns: arena.columns,
      rows: arena.rows,
      tileWidth: arena.tileWidth,
      tileHeight: arena.tileHeight,
      corridorWidth: arena.corridorWidth,
      worldWidth: arena.worldWidth,
      worldHeight: arena.worldHeight,
    },
    rooms: arena.rooms.map((room) => ({
      id: room.id,
      left: room.left,
      top: room.top,
      width: room.width,
      height: room.height,
      floorMacro: room.floorMacro,
      motifTransform: room.motifTransform,
    })),
    connections: arena.connections.map((connection) => ({
      id: connection.id,
      from: connection.from,
      to: connection.to,
      kind: connection.kind,
      door: connection.door,
    })),
    tiles: arena.tiles.map((tile) => ({
      kind: tile.kind,
      roomId: tile.roomId ?? null,
      terrain: tile.terrain,
      elevation: tile.elevation,
      features: tile.features ?? [],
      doorId: tile.doorId ?? null,
    })),
  };
}

export class ByteLruCache {
  constructor(maxBytes = AUTHORED_SURFACE_CACHE_MAX_BYTES) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("LRU byte limit must be positive");
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  peek(key) {
    return this.entries.get(key)?.value ?? null;
  }

  has(key) {
    return this.entries.has(key);
  }

  keys() {
    return new Set(this.entries.keys());
  }

  snapshot() {
    return [...this.entries.entries()].map(([key, entry]) => ({ key, byteSize: entry.byteSize, value: entry.value }));
  }

  set(key, value, byteSize, dispose = null) {
    if (!Number.isInteger(byteSize) || byteSize < 0 || byteSize > this.maxBytes) throw new Error("LRU entry exceeds its byte bound");
    const prior = this.entries.get(key);
    if (prior) {
      this.bytes -= prior.byteSize;
      prior.dispose?.(prior.value);
      this.entries.delete(key);
    }
    this.entries.set(key, { value, byteSize, dispose });
    this.bytes += byteSize;
    while (this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes -= oldest.byteSize;
      oldest.dispose?.(oldest.value);
      this.evictions += 1;
    }
  }

  clear() {
    for (const entry of this.entries.values()) entry.dispose?.(entry.value);
    this.entries.clear();
    this.bytes = 0;
  }

  receipt() {
    return {
      maxBytes: this.maxBytes,
      bytes: this.bytes,
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

function imageSource(image, rectangles) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return rectangles.map((rectangle) => {
    const frame = context.getImageData(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    return { width: rectangle.width, height: rectangle.height, pixels: frame.data.buffer };
  });
}

function percentile95(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function emptySynthesisReceipt() {
  return {
    count: 0,
    chunkCount: 0,
    totalMs: 0,
    maximumMs: 0,
    lastMs: 0,
    commitSamples: [],
    failures: 0,
    compositions: new Map(),
    chunks: new Map(),
  };
}

export class AuthoredSurfaceRuntime {
  constructor({ signalMaterialImage, signalMacroImage, forgeMaterialImage, root = document.documentElement }) {
    this.root = root;
    this.cache = new ByteLruCache();
    this.worker = new Worker(new URL("./vault-authored-surface-worker.mjs?v=authored-quilt-v1-live-3", import.meta.url), { type: "module" });
    this.regions = [];
    this.regionByKey = new Map();
    this.chunks = [];
    this.chunkByCell = new Map();
    this.queue = [];
    this.queuedChunkKeys = new Set();
    this.inFlight = null;
    this.nextRequestId = 1;
    this.configuredBiomes = new Set();
    this.signalMacroConfigured = false;
    this.layerIdentity = null;
    this.palette = null;
    this.baselineRenderHash = null;
    this.baselineGameStateHash = null;
    this.gameStateHash = () => null;
    this.worldDescriptorHash = null;
    this.visibleDescriptorHash = null;
    this.visibleChunkKeys = new Set();
    this.disabled = false;
    this.synthesis = emptySynthesisReceipt();
    this.worker.addEventListener("message", (event) => this.handleWorkerMessage(event.data));
    this.worker.addEventListener("error", (event) => this.failInFlight(event.message || "Authored surface worker failed"));
    this.configureBiome("occult-machine-catacomb", imageSource(signalMaterialImage, [
      { x: 0, y: 0, width: 256, height: 256 },
      { x: 256, y: 0, width: 256, height: 256 },
    ]));
    this.configureBiome("industrial-forge", imageSource(forgeMaterialImage, [
      { x: 0, y: 0, width: 1024, height: 1024 },
    ]));
    this.configureSignalMacro(imageSource(signalMacroImage, [
      { x: 0, y: 0, width: 1024, height: 1024 },
    ])[0]);
    this.root.dataset.vaultFloorPrototype = AUTHORED_QUILT_PROTOTYPE;
    this.root.dataset.vaultAuthoredSurfaceStatus = "initializing";
    globalThis.__vaultAuthoredSurfaceAudit = () => this.receipt();
    this.publishReceipt();
  }

  configureBiome(biome, sources) {
    const transfers = sources.map((source) => source.pixels);
    this.worker.postMessage({ type: "configure", biome, sources }, transfers);
  }

  configureSignalMacro(source) {
    this.worker.postMessage({ type: "configure-signal-macro", source }, [source.pixels]);
  }

  prepareLayer({ arena, mapSeed, layer, biome, palette, baselineRenderHash, gameStateHash }) {
    this.queue.length = 0;
    this.queuedChunkKeys.clear();
    this.cache.clear();
    this.synthesis = emptySynthesisReceipt();
    this.regions = buildAuthoredSurfaceRegions({ arena, mapSeed, layer, biome });
    this.regionByKey = new Map(this.regions.map((region) => [region.key, region]));
    this.chunks = buildAuthoredSurfaceChunks(this.regions, arena.tileWidth, arena.tileHeight);
    this.chunkByCell.clear();
    for (const chunk of this.chunks) for (const cell of chunk.cells) this.chunkByCell.set(cellKey(cell.column, cell.row), chunk);
    this.layerIdentity = { mapSeed, layer, biome, palette: palette.id ?? null };
    this.palette = palette;
    this.baselineRenderHash = baselineRenderHash;
    this.gameStateHash = gameStateHash;
    this.baselineGameStateHash = gameStateHash();
    this.worldDescriptorHash = authoredSurfaceWorldDescriptorHash(this.regions, this.chunks);
    this.visibleDescriptorHash = null;
    this.visibleChunkKeys.clear();
    this.disabled = false;
    this.root.dataset.vaultAuthoredSurfaceStatus = this.regions.length ? "queued" : "unsupported-biome";
    this.publishReceipt();
  }

  sourcesReady() {
    if (!this.layerIdentity || !this.configuredBiomes.has(this.layerIdentity.biome)) return false;
    return this.layerIdentity.biome !== "occult-machine-catacomb" || this.signalMacroConfigured;
  }

  requestVisible(viewport) {
    if (this.disabled || !this.sourcesReady()) return;
    const visible = surfaceChunksForViewport(this.chunks, viewport);
    this.visibleChunkKeys = new Set(visible.map((chunk) => chunk.key));
    this.visibleDescriptorHash = hex32([...this.visibleChunkKeys].sort().join("|"));
    const visibleBytes = visible.reduce((sum, chunk) => sum + chunk.byteSize, 0);
    if (visibleBytes > AUTHORED_SURFACE_CACHE_MAX_BYTES) {
      this.disable(`Visible authored chunks exceed 16 MiB: ${visibleBytes}`);
      return;
    }
    const plans = planMissingSurfaceCompositions(visible, this.cache.keys(), this.queuedChunkKeys);
    const centerX = (viewport.left + viewport.right) / 2;
    const centerY = (viewport.top + viewport.bottom) / 2;
    for (const plan of plans) {
      const region = this.regionByKey.get(plan.regionKey);
      plan.region = region;
      plan.distance = Math.hypot(region.x + region.width / 2 - centerX, region.y + region.height / 2 - centerY);
      for (const chunk of plan.chunks) this.queuedChunkKeys.add(chunk.key);
      this.queue.push(plan);
    }
    this.queue.sort((left, right) => left.distance - right.distance || left.regionKey.localeCompare(right.regionKey));
    if (!this.inFlight) this.dispatchNext();
    if (plans.length) this.publishReceipt();
  }

  dispatchNext() {
    if (this.disabled || this.inFlight || !this.queue.length || !this.layerIdentity) return;
    const job = this.queue.shift();
    const requestId = this.nextRequestId++;
    this.inFlight = { requestId, job, layerIdentity: { ...this.layerIdentity }, pendingChunks: null };
    const macroSize = job.region.type === "room" && this.layerIdentity.biome === "occult-machine-catacomb"
      ? Math.min(512, job.region.width, job.region.height)
      : 0;
    this.worker.postMessage({
      type: "synthesize",
      requestId,
      key: job.region.key,
      biome: this.layerIdentity.biome,
      width: job.region.width,
      height: job.region.height,
      palette: this.palette,
      synthesis: SYNTHESIS_BY_BIOME[this.layerIdentity.biome],
      macro: macroSize ? {
        quadrant: job.region.macro ?? 0,
        transform: job.region.macroTransform,
        size: macroSize,
        feather: Math.min(62, Math.round(macroSize * 0.12)),
        alpha: 0.82,
      } : null,
      chunks: job.chunks.map((chunk) => ({
        key: chunk.key,
        localX: chunk.localX,
        localY: chunk.localY,
        width: chunk.width,
        height: chunk.height,
      })),
    });
    this.publishReceipt();
  }

  handleWorkerMessage(message) {
    if (message?.type === "configured") {
      this.configuredBiomes.add(message.biome);
      this.publishReceipt();
      return;
    }
    if (message?.type === "configured-signal-macro") {
      this.signalMacroConfigured = true;
      this.publishReceipt();
      return;
    }
    if (!this.inFlight || message?.requestId !== this.inFlight.requestId) return;
    if (message.type === "error") {
      this.failInFlight(message.error);
      return;
    }
    if (message.type !== "surface-chunks") return;
    this.inFlight.pendingChunks = message.chunks.slice();
    this.inFlight.workerDurationMs = message.durationMs;
    this.inFlight.placementCount = message.placementCount;
    this.scheduleCommitBatch();
  }

  scheduleCommitBatch() {
    const commit = () => this.commitWorkerChunkBatch();
    if (typeof requestIdleCallback === "function") requestIdleCallback(commit, { timeout: 180 });
    else setTimeout(commit, 0);
  }

  commitWorkerChunkBatch() {
    const active = this.inFlight;
    if (!active?.pendingChunks) return;
    if (active.layerIdentity.mapSeed !== this.layerIdentity?.mapSeed
      || active.layerIdentity.layer !== this.layerIdentity?.layer
      || active.layerIdentity.biome !== this.layerIdentity?.biome) {
      this.inFlight = null;
      this.dispatchNext();
      return;
    }
    const startedAt = performance.now();
    const batch = active.pendingChunks.splice(0, COMMIT_BATCH_CHUNKS);
    for (const result of batch) {
      const chunk = active.job.chunks.find((candidate) => candidate.key === result.key);
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
      this.cache.set(result.key, { canvas, hash: result.hash }, chunk.byteSize, (entry) => {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      });
      this.synthesis.chunkCount += 1;
      this.synthesis.chunks.set(result.key, { hash: result.hash, width: result.width, height: result.height });
    }
    this.synthesis.commitSamples.push(performance.now() - startedAt);
    if (active.pendingChunks.length) {
      this.publishReceipt();
      this.scheduleCommitBatch();
      return;
    }
    this.synthesis.count += 1;
    this.synthesis.totalMs += active.workerDurationMs;
    this.synthesis.maximumMs = Math.max(this.synthesis.maximumMs, active.workerDurationMs);
    this.synthesis.lastMs = active.workerDurationMs;
    this.synthesis.compositions.set(active.job.regionKey, {
      workerMs: active.workerDurationMs,
      placements: active.placementCount,
      chunks: active.job.chunks.length,
    });
    for (const chunk of active.job.chunks) this.queuedChunkKeys.delete(chunk.key);
    this.inFlight = null;
    this.root.dataset.vaultAuthoredSurfaceStatus = this.queue.length ? "synthesizing" : "ready";
    this.publishReceipt();
    this.dispatchNext();
  }

  failInFlight(error) {
    this.synthesis.failures += 1;
    this.disable(error);
  }

  disable(error) {
    this.disabled = true;
    this.queue.length = 0;
    this.queuedChunkKeys.clear();
    this.inFlight = null;
    this.cache.clear();
    this.root.dataset.vaultAuthoredSurfaceStatus = "failed-baseline-fallback";
    this.root.dataset.vaultAuthoredSurfaceError = String(error);
    this.publishReceipt();
  }

  draw(context, viewport) {
    this.requestVisible(viewport);
    for (const chunk of surfaceChunksForViewport(this.chunks, viewport)) {
      const cached = this.cache.get(chunk.key);
      if (!cached) continue;
      context.save();
      context.beginPath();
      for (const cell of chunk.cells) context.rect(cell.column * TILE_SIZE, cell.row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      context.clip();
      context.drawImage(cached.canvas, chunk.x, chunk.y);
      context.restore();
    }
  }

  hasReadySurfaceFor(column, row) {
    const chunk = this.chunkByCell.get(cellKey(column, row));
    return Boolean(chunk && this.cache.peek(chunk.key));
  }

  receipt() {
    const residentEntries = this.cache.snapshot()
      .map((entry) => [entry.key, entry.value.hash])
      .sort(([left], [right]) => left.localeCompare(right));
    const commitTotalMs = this.synthesis.commitSamples.reduce((sum, value) => sum + value, 0);
    const commitMaximumMs = Math.max(0, ...this.synthesis.commitSamples);
    return {
      schema: "vault-authored-surface-runtime@2",
      prototype: AUTHORED_QUILT_PROTOTYPE,
      active: !this.disabled,
      fallback: this.disabled ? "baseline" : null,
      layer: this.layerIdentity ? { ...this.layerIdentity } : null,
      cache: this.cache.receipt(),
      queue: {
        ready: this.cache.entries.size,
        queued: this.queue.reduce((sum, job) => sum + job.chunks.length, 0) + (this.inFlight?.job.chunks.length ?? 0),
        pendingCompositions: this.queue.length,
        inFlight: this.inFlight?.job.regionKey ?? null,
      },
      synthesis: {
        count: this.synthesis.count,
        chunkCount: this.synthesis.chunkCount,
        totalMs: this.synthesis.totalMs,
        maximumMs: this.synthesis.maximumMs,
        lastMs: this.synthesis.lastMs,
        commitTotalMs,
        commitMaximumMs,
        commitP95Ms: percentile95(this.synthesis.commitSamples),
        failures: this.synthesis.failures,
        compositions: Object.fromEntries(this.synthesis.compositions),
        chunks: Object.fromEntries(this.synthesis.chunks),
      },
      hashes: {
        baselineRender: this.baselineRenderHash,
        baselineGameState: this.baselineGameStateHash,
        gameState: this.gameStateHash?.() ?? null,
        worldDescriptor: this.worldDescriptorHash,
        visibleDescriptor: this.visibleDescriptorHash,
        cacheResident: residentEntries.length
          ? hex32(residentEntries.map(([key, hash]) => `${key}=${hash}`).join("|"))
          : null,
      },
      geometry: {
        compositions: this.regions.length,
        rooms: this.regions.filter((region) => region.type === "room").length,
        corridors: this.regions.filter((region) => region.type === "corridor").length,
        chunks: this.chunks.length,
        visibleChunks: this.visibleChunkKeys.size,
        visibleBytes: [...this.visibleChunkKeys].reduce((sum, key) => sum + (this.chunks.find((chunk) => chunk.key === key)?.byteSize ?? 0), 0),
        compositionSynthesis: true,
        chunkSelection: false,
        exactCellClip: true,
      },
      overlays: ["terrain", "water", "lava", "objects", "walls", "doors"],
    };
  }

  publishReceipt() {
    const receipt = this.receipt();
    this.root.dataset.vaultAuthoredSurfaceCacheBytes = String(receipt.cache.bytes);
    this.root.dataset.vaultAuthoredSurfaceCacheHits = String(receipt.cache.hits);
    this.root.dataset.vaultAuthoredSurfaceCacheMisses = String(receipt.cache.misses);
    this.root.dataset.vaultAuthoredSurfaceReady = String(receipt.queue.ready);
    this.root.dataset.vaultAuthoredSurfaceQueued = String(receipt.queue.queued);
    this.root.dataset.vaultAuthoredSurfaceSynthesisCount = String(receipt.synthesis.count);
    this.root.dataset.vaultAuthoredSurfaceSynthesisMs = receipt.synthesis.totalMs.toFixed(2);
    this.root.dataset.vaultAuthoredSurfaceCommitP95Ms = receipt.synthesis.commitP95Ms.toFixed(2);
    this.root.dataset.vaultAuthoredSurfaceMaxCommitMs = receipt.synthesis.commitMaximumMs.toFixed(2);
    this.root.dataset.vaultAuthoredSurfaceResidentHashes = Object.entries(receipt.synthesis.chunks)
      .filter(([key]) => this.cache.has(key))
      .map(([key, chunk]) => `${key}=${chunk.hash}`)
      .join(",");
    this.root.dataset.vaultAuthoredSurfaceCacheResidentHash = receipt.hashes.cacheResident ?? "pending";
    this.root.dataset.vaultAuthoredSurfaceWorldDescriptorHash = receipt.hashes.worldDescriptor ?? "pending";
    this.root.dataset.vaultAuthoredSurfaceVisibleDescriptorHash = receipt.hashes.visibleDescriptor ?? "pending";
    this.root.dataset.vaultAuthoredSurfaceGeometry = `${receipt.geometry.rooms}r/${receipt.geometry.corridors}c/${receipt.geometry.chunks}chunks/exact-cell-clip`;
    this.root.dataset.vaultAuthoredSurfaceVisibleBytes = String(receipt.geometry.visibleBytes);
    this.root.dataset.vaultBaselineRenderHash = receipt.hashes.baselineRender ?? "pending";
    this.root.dataset.vaultBaselineGameStateHash = receipt.hashes.baselineGameState ?? "pending";
    this.root.dataset.vaultGameStateHash = receipt.hashes.gameState ?? "pending";
  }
}

export function createAuthoredSurfaceRuntime(options) {
  try {
    return new AuthoredSurfaceRuntime(options);
  } catch (error) {
    const root = options.root ?? document.documentElement;
    const message = error instanceof Error ? error.message : String(error);
    root.dataset.vaultFloorPrototype = AUTHORED_QUILT_PROTOTYPE;
    root.dataset.vaultAuthoredSurfaceStatus = "failed-baseline-fallback";
    root.dataset.vaultAuthoredSurfaceError = message;
    globalThis.__vaultAuthoredSurfaceAudit = () => ({
      schema: "vault-authored-surface-runtime@2",
      prototype: AUTHORED_QUILT_PROTOTYPE,
      active: false,
      fallback: "baseline",
      error: message,
      cache: { maxBytes: AUTHORED_SURFACE_CACHE_MAX_BYTES, bytes: 0, entries: 0, hits: 0, misses: 0, evictions: 0 },
      queue: { ready: 0, queued: 0, pendingCompositions: 0, inFlight: null },
    });
    return null;
  }
}
