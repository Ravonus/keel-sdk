import {
  STRUCTURE_REVIEW_FIXTURES,
  rgbaHash,
  rgbaNearestScaleMatches,
  rasterizeWallAssembly,
  rasterizeWallDoorAssembly,
  scaleRgbaNearest,
} from "./vault-world-structure.mjs";

const nativeCanvas = document.querySelector("#native-review");
const exact2xCanvas = document.querySelector("#exact-2x-review");
const status = document.querySelector("#status");
const auditJson = document.querySelector("#audit-json");
const NATIVE_WIDTH = 1280;
const NATIVE_HEIGHT = 1160;
const PROGRESS_VALUES = [0, 0.5, 1];

function drawPanel(context, x, y, width, height) {
  context.fillStyle = "#091311";
  context.fillRect(x, y, width, height);
  context.strokeStyle = "#29443c";
  context.lineWidth = 2;
  context.strokeRect(x + 1, y + 1, width - 2, height - 2);
}

function drawRaster(context, raster, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("Review raster placement must be integer");
  context.putImageData(new ImageData(raster.pixels, raster.width, raster.height), x, y);
}

function makeNativeBoard() {
  const board = document.createElement("canvas");
  board.width = NATIVE_WIDTH;
  board.height = NATIVE_HEIGHT;
  const context = board.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#050a0c";
  context.fillRect(0, 0, NATIVE_WIDTH, NATIVE_HEIGHT);

  const panelWidth = 400;
  const wallPanelHeight = 300;
  const panelGap = 20;
  const wallStartX = 20;
  const wallStartY = 20;
  const wallRasters = Object.entries(STRUCTURE_REVIEW_FIXTURES).map(([name, cells]) => ({
    name,
    raster: rasterizeWallAssembly(cells, { tileSize: 48, padding: 12 }),
  }));
  wallRasters.forEach(({ raster }, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const panelX = wallStartX + column * (panelWidth + panelGap);
    const panelY = wallStartY + row * (wallPanelHeight + panelGap);
    drawPanel(context, panelX, panelY, panelWidth, wallPanelHeight);
    const x = panelX + Math.floor((panelWidth - raster.width) / 2);
    const y = panelY + Math.floor((wallPanelHeight - raster.height) / 2);
    drawRaster(context, raster, x, y);
  });

  const doorPanelHeight = 220;
  const doorStartY = 660;
  ["horizontal", "vertical"].forEach((axis, axisIndex) => {
    PROGRESS_VALUES.forEach((progress, progressIndex) => {
      const panelX = wallStartX + progressIndex * (panelWidth + panelGap);
      const panelY = doorStartY + axisIndex * (doorPanelHeight + panelGap);
      drawPanel(context, panelX, panelY, panelWidth, doorPanelHeight);
      const raster = rasterizeWallDoorAssembly({ axis, progress, span: 3, tileSize: 32, padding: 12, leafThickness: 5 });
      const x = panelX + Math.floor((panelWidth - raster.width) / 2);
      const y = panelY + Math.floor((doorPanelHeight - raster.height) / 2);
      drawRaster(context, raster, x, y);
    });
  });

  const pixels = context.getImageData(0, 0, NATIVE_WIDTH, NATIVE_HEIGHT).data;
  return Object.freeze({ width: NATIVE_WIDTH, height: NATIVE_HEIGHT, pixels: new Uint8ClampedArray(pixels) });
}

function putCanvasRaster(canvas, raster, scale) {
  canvas.width = raster.width;
  canvas.height = raster.height;
  canvas.style.width = `${raster.width}px`;
  canvas.style.height = `${raster.height}px`;
  canvas.dataset.bitmapWidth = String(raster.width);
  canvas.dataset.bitmapHeight = String(raster.height);
  canvas.dataset.cssWidth = canvas.style.width;
  canvas.dataset.cssHeight = canvas.style.height;
  canvas.dataset.scale = String(scale);
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = false;
  context.putImageData(new ImageData(raster.pixels, raster.width, raster.height), 0, 0);
}

function buildAudit(nativeRaster, exact2xRaster, exactRelation) {
  const fixtures = Object.entries(STRUCTURE_REVIEW_FIXTURES).map(([name, cells]) => {
    const raster = rasterizeWallAssembly(cells, { tileSize: 48, padding: 12 });
    return {
      name,
      cells,
      hash: rgbaHash(raster),
      dimensions: { width: raster.width, height: raster.height },
      topology: raster.audit,
    };
  });
  const doors = ["horizontal", "vertical"].flatMap((axis) => PROGRESS_VALUES.map((progress) => {
    const raster = rasterizeWallDoorAssembly({ axis, progress, span: 3, tileSize: 32, padding: 12, leafThickness: 5 });
    const exactDoor2x = scaleRgbaNearest(raster, 2);
    return {
      axis,
      progress,
      hash: rgbaHash(raster),
      dimensions: { width: raster.width, height: raster.height },
      aperture: {
        size: raster.descriptor.apertureSize,
        fullSize: raster.descriptor.fullApertureSize,
        renderCollisionShared: raster.audit.renderCollisionShared,
      },
      connectedWallRun: raster.audit.connectedWallRun,
      rgba2xExact: rgbaNearestScaleMatches(raster, exactDoor2x, 2),
    };
  }));
  return Object.freeze({
    schema: "vault-world-structure-review@2",
    material: Object.freeze({
      mode: "neutral-deterministic-grayscale",
      authoredSource: "industrial-forge-wall-v1",
      authoredStatus: "candidate-visual-review",
      approval: "not-asserted",
    }),
    fixtures,
    doors,
    canvases: Object.freeze({
      native1x: Object.freeze({
        bitmapWidth: nativeRaster.width,
        bitmapHeight: nativeRaster.height,
        cssWidth: nativeCanvas.style.width,
        cssHeight: nativeCanvas.style.height,
        scale: 1,
        hash: rgbaHash(nativeRaster),
      }),
      exact2x: Object.freeze({
        bitmapWidth: exact2xRaster.width,
        bitmapHeight: exact2xRaster.height,
        cssWidth: exact2xCanvas.style.width,
        cssHeight: exact2xCanvas.style.height,
        scale: 2,
        hash: rgbaHash(exact2xRaster),
      }),
      relation: Object.freeze({
        source: "native1x",
        target: "exact2x",
        scale: 2,
        widthRatio: exact2xRaster.width / nativeRaster.width,
        heightRatio: exact2xRaster.height / nativeRaster.height,
        pixelReplication: exactRelation,
      }),
    }),
    reviewBoundary: "independent-critic-required",
  });
}

function render() {
  const nativeRaster = makeNativeBoard();
  const exact2xRaster = scaleRgbaNearest(nativeRaster, 2);
  putCanvasRaster(nativeCanvas, nativeRaster, 1);
  putCanvasRaster(exact2xCanvas, exact2xRaster, 2);
  const exactRelation = rgbaNearestScaleMatches(nativeRaster, exact2xRaster, 2);
  const audit = buildAudit(nativeRaster, exact2xRaster, exactRelation);
  globalThis.vaultWorldStructureAudit = audit;
  document.documentElement.dataset.structureReview = "ready";
  document.documentElement.dataset.structureMaterial = audit.material.mode;
  document.documentElement.dataset.structureMaterialStatus = audit.material.authoredStatus;
  document.documentElement.dataset.structureFixtures = String(audit.fixtures.length);
  document.documentElement.dataset.structureDoors = String(audit.doors.length);
  document.documentElement.dataset.structureNative1x = `${audit.canvases.native1x.bitmapWidth}x${audit.canvases.native1x.bitmapHeight}`;
  document.documentElement.dataset.structureExact2x = `${audit.canvases.exact2x.bitmapWidth}x${audit.canvases.exact2x.bitmapHeight}`;
  document.documentElement.dataset.structureExactRelation = String(audit.canvases.relation.pixelReplication);
  auditJson.textContent = JSON.stringify(audit, null, 2);
  status.textContent = `Ready · ${audit.fixtures.length} connected fixtures · ${audit.doors.length} connected door states · native/2× exact ${audit.canvases.relation.pixelReplication ? "PASS" : "FAIL"} · independent critic required`;
}

try {
  render();
} catch (error) {
  document.documentElement.dataset.structureReview = "error";
  status.textContent = `Harness error: ${error.message}`;
  auditJson.textContent = JSON.stringify({ schema: "vault-world-structure-review@2", error: error.message }, null, 2);
  throw error;
}
