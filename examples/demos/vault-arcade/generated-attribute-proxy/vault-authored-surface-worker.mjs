import {
  quiltImageData,
  tintRgbaPixels,
} from "./vault-authored-surface.mjs";

const sourceSets = new Map();
let signalMacroSource = null;

function pixelHash(pixels) {
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 1) {
    hash ^= pixels[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function macroQuarterTurns(transform) {
  return ({ r0: 0, r90: 1, r180: 2, r270: 3 })[transform] ?? 0;
}

function canvasFromPixels(pixels, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}

function composeSignalMacro(basePixels, width, height, macro, palette) {
  if (!macro) return basePixels;
  if (!signalMacroSource) throw new Error("Signal macro source is not configured");
  const surface = canvasFromPixels(basePixels, width, height);
  const surfaceContext = surface.getContext("2d", { willReadFrequently: true });
  const macroCanvas = new OffscreenCanvas(macro.size, macro.size);
  const macroContext = macroCanvas.getContext("2d", { willReadFrequently: true });
  const sourceX = (macro.quadrant % 2) * 512;
  const sourceY = Math.floor(macro.quadrant / 2) * 512;
  macroContext.drawImage(signalMacroSource, sourceX, sourceY, 512, 512, 0, 0, macro.size, macro.size);
  const tinted = tintRgbaPixels(macroContext.getImageData(0, 0, macro.size, macro.size).data, palette);
  macroContext.putImageData(new ImageData(tinted, macro.size, macro.size), 0, 0);
  const mask = macroContext.createRadialGradient(macro.size / 2, macro.size / 2, Math.max(0, macro.size / 2 - macro.feather * 1.4), macro.size / 2, macro.size / 2, macro.size / 2);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.82, "rgba(0,0,0,0.96)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  macroContext.globalCompositeOperation = "destination-in";
  macroContext.fillStyle = mask;
  macroContext.fillRect(0, 0, macro.size, macro.size);
  macroContext.globalCompositeOperation = "source-over";
  surfaceContext.save();
  surfaceContext.globalAlpha = macro.alpha;
  surfaceContext.translate(width / 2, height / 2);
  surfaceContext.rotate(macroQuarterTurns(macro.transform) * Math.PI / 2);
  surfaceContext.drawImage(macroCanvas, -macro.size / 2, -macro.size / 2);
  surfaceContext.restore();
  return surfaceContext.getImageData(0, 0, width, height).data;
}

function cropPixels(pixels, sourceWidth, chunk) {
  const output = new Uint8ClampedArray(chunk.width * chunk.height * 4);
  for (let row = 0; row < chunk.height; row += 1) {
    const sourceOffset = ((chunk.localY + row) * sourceWidth + chunk.localX) * 4;
    output.set(pixels.subarray(sourceOffset, sourceOffset + chunk.width * 4), row * chunk.width * 4);
  }
  return output;
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "configure") {
    sourceSets.set(message.biome, message.sources.map((source) => ({
      width: source.width,
      height: source.height,
      pixels: new Uint8ClampedArray(source.pixels),
    })));
    self.postMessage({ type: "configured", biome: message.biome });
    return;
  }
  if (message?.type === "configure-signal-macro") {
    const pixels = new Uint8ClampedArray(message.source.pixels);
    signalMacroSource = canvasFromPixels(pixels, message.source.width, message.source.height);
    self.postMessage({ type: "configured-signal-macro" });
    return;
  }
  if (message?.type !== "synthesize") return;
  const sources = sourceSets.get(message.biome);
  if (!sources) {
    self.postMessage({ type: "error", requestId: message.requestId, key: message.key, error: `Authored surface sources are not configured for ${message.biome}` });
    return;
  }
  try {
    const startedAt = performance.now();
    const quilt = quiltImageData({
      sources,
      width: message.width,
      height: message.height,
      seed: message.key,
      ...message.synthesis,
    });
    const tintedPixels = tintRgbaPixels(quilt.pixels, message.palette);
    const composedPixels = composeSignalMacro(tintedPixels, message.width, message.height, message.macro, message.palette);
    const chunks = message.chunks.map((chunk) => {
      const pixels = cropPixels(composedPixels, message.width, chunk);
      return { key: chunk.key, width: chunk.width, height: chunk.height, hash: pixelHash(pixels), pixels: pixels.buffer };
    });
    const durationMs = performance.now() - startedAt;
    self.postMessage({
      type: "surface-chunks",
      requestId: message.requestId,
      key: message.key,
      durationMs,
      placementCount: quilt.placements.length,
      chunks,
    }, chunks.map((chunk) => chunk.pixels));
  } catch (error) {
    self.postMessage({ type: "error", requestId: message.requestId, key: message.key, error: error instanceof Error ? error.message : String(error) });
  }
});
