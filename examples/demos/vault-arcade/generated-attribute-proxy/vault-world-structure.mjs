export const CARDINAL = Object.freeze({ NORTH: 1, EAST: 2, SOUTH: 4, WEST: 8 });

export const STRUCTURE_COLORS = Object.freeze({
  transparent: [0, 0, 0, 0],
  topLow: [164, 168, 174, 255],
  topHigh: [188, 192, 198, 255],
  topEdge: [226, 230, 235, 255],
  sideSouth: [108, 113, 121, 255],
  sideEast: [86, 91, 100, 255],
  sideEdge: [137, 143, 152, 255],
  shadow: [25, 28, 34, 188],
  jamb: [76, 82, 91, 255],
  jambEdge: [185, 191, 200, 255],
  leaf: [119, 125, 135, 255],
  leafEdge: [208, 214, 221, 255],
  leafDepth: [67, 72, 81, 255],
  threshold: [51, 57, 65, 255],
  thresholdLine: [94, 102, 113, 255],
  aperture: [9, 13, 18, 255],
});

const DIRECTIONS = Object.freeze([
  { bit: CARDINAL.NORTH, dx: 0, dy: -1, name: "north" },
  { bit: CARDINAL.EAST, dx: 1, dy: 0, name: "east" },
  { bit: CARDINAL.SOUTH, dx: 0, dy: 1, name: "south" },
  { bit: CARDINAL.WEST, dx: -1, dy: 0, name: "west" },
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const keyFor = (column, row) => `${column},${row}`;
const oppositeBit = Object.freeze({
  [CARDINAL.NORTH]: CARDINAL.SOUTH,
  [CARDINAL.EAST]: CARDINAL.WEST,
  [CARDINAL.SOUTH]: CARDINAL.NORTH,
  [CARDINAL.WEST]: CARDINAL.EAST,
});

const freezeCells = (cells) => Object.freeze(cells.map((cell) => Object.freeze({
  column: cell.column,
  row: cell.row,
})));

export const STRUCTURE_REVIEW_FIXTURES = Object.freeze({
  straight: freezeCells([
    { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 },
    { column: 3, row: 0 }, { column: 4, row: 0 },
  ]),
  l: freezeCells([
    { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }, { column: 3, row: 0 },
    { column: 0, row: 1 }, { column: 0, row: 2 }, { column: 0, row: 3 },
  ]),
  t: freezeCells([
    { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }, { column: 3, row: 0 }, { column: 4, row: 0 },
    { column: 2, row: 1 }, { column: 2, row: 2 }, { column: 2, row: 3 },
  ]),
  cross: freezeCells([
    { column: 2, row: 0 }, { column: 2, row: 1 }, { column: 2, row: 2 }, { column: 2, row: 3 }, { column: 2, row: 4 },
    { column: 0, row: 2 }, { column: 1, row: 2 }, { column: 3, row: 2 }, { column: 4, row: 2 },
  ]),
  concave: freezeCells([
    { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }, { column: 3, row: 0 },
    { column: 0, row: 1 }, { column: 3, row: 1 },
    { column: 0, row: 2 }, { column: 3, row: 2 },
  ]),
  donut: freezeCells([
    { column: 0, row: 0 }, { column: 1, row: 0 }, { column: 2, row: 0 }, { column: 3, row: 0 },
    { column: 0, row: 1 }, { column: 3, row: 1 },
    { column: 0, row: 2 }, { column: 3, row: 2 },
    { column: 0, row: 3 }, { column: 1, row: 3 }, { column: 2, row: 3 }, { column: 3, row: 3 },
  ]),
});

function assertInteger(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
}

function normalizeCells(cells) {
  if (!Array.isArray(cells) || cells.length === 0) throw new Error("A wall assembly requires at least one cell");
  const byKey = new Map();
  for (const cell of cells) {
    assertInteger(cell?.column, "Wall column");
    assertInteger(cell?.row, "Wall row");
    const key = keyFor(cell.column, cell.row);
    if (byKey.has(key)) throw new Error(`Duplicate wall cell ${key}`);
    byKey.set(key, { column: cell.column, row: cell.row });
  }
  return byKey;
}

function joinRole(mask) {
  const count = DIRECTIONS.reduce((sum, direction) => sum + (mask & direction.bit ? 1 : 0), 0);
  if (count === 0) return "island";
  if (count === 1) return "cap";
  if (count === 2) return mask === (CARDINAL.NORTH | CARDINAL.SOUTH) || mask === (CARDINAL.EAST | CARDINAL.WEST) ? "straight" : "corner";
  if (count === 3) return "t-junction";
  return "cross";
}

function exposedCornerMask(exposedMask) {
  return ((exposedMask & CARDINAL.NORTH) && (exposedMask & CARDINAL.EAST) ? 1 : 0)
    | ((exposedMask & CARDINAL.EAST) && (exposedMask & CARDINAL.SOUTH) ? 2 : 0)
    | ((exposedMask & CARDINAL.SOUTH) && (exposedMask & CARDINAL.WEST) ? 4 : 0)
    | ((exposedMask & CARDINAL.WEST) && (exposedMask & CARDINAL.NORTH) ? 8 : 0);
}

export function describeWallCell(connectedMask, source = {}) {
  assertInteger(connectedMask, "Connected mask");
  if (connectedMask < 0 || connectedMask > 15) throw new Error("Connected mask must use the four NESW bits");
  assertInteger(source.column ?? 0, "Wall column");
  assertInteger(source.row ?? 0, "Wall row");
  const exposedMask = 15 ^ connectedMask;
  return Object.freeze({
    column: source.column ?? 0,
    row: source.row ?? 0,
    connectedMask,
    exposedMask,
    joinRole: joinRole(connectedMask),
    exposedCornerMask: exposedCornerMask(exposedMask),
  });
}

export function buildWallComponents(cells) {
  const byKey = normalizeCells(cells);
  const unvisited = new Set(byKey.keys());
  const components = [];
  while (unvisited.size) {
    const firstKey = [...unvisited].sort()[0];
    const queue = [byKey.get(firstKey)];
    unvisited.delete(firstKey);
    const componentCells = [];
    while (queue.length) {
      const cell = queue.shift();
      let connectedMask = 0;
      for (const direction of DIRECTIONS) {
        const neighborKey = keyFor(cell.column + direction.dx, cell.row + direction.dy);
        if (!byKey.has(neighborKey)) continue;
        connectedMask |= direction.bit;
        if (unvisited.delete(neighborKey)) queue.push(byKey.get(neighborKey));
      }
      componentCells.push(describeWallCell(connectedMask, cell));
    }
    componentCells.sort((left, right) => left.row - right.row || left.column - right.column);
    const columns = componentCells.map((cell) => cell.column);
    const rows = componentCells.map((cell) => cell.row);
    const componentKeys = new Set(componentCells.map((cell) => keyFor(cell.column, cell.row)));
    const reciprocalJoins = [];
    for (const cell of componentCells) {
      for (const direction of DIRECTIONS) {
        const neighborColumn = cell.column + direction.dx;
        const neighborRow = cell.row + direction.dy;
        const neighborKey = keyFor(neighborColumn, neighborRow);
        if (!componentKeys.has(neighborKey)) continue;
        if (cell.row > neighborRow || (cell.row === neighborRow && cell.column > neighborColumn)) continue;
        reciprocalJoins.push(Object.freeze({
          from: Object.freeze({ column: cell.column, row: cell.row }),
          to: Object.freeze({ column: neighborColumn, row: neighborRow }),
          side: direction.name,
          bit: direction.bit,
          reciprocalBit: oppositeBit[direction.bit],
        }));
      }
    }
    const boundaryEdges = componentCells.flatMap((cell) => DIRECTIONS
      .filter((direction) => cell.exposedMask & direction.bit)
      .map((direction) => ({ column: cell.column, row: cell.row, bit: direction.bit, side: direction.name })));
    const corners = componentCells
      .filter((cell) => cell.exposedCornerMask !== 0)
      .map((cell) => Object.freeze({ column: cell.column, row: cell.row, mask: cell.exposedCornerMask }));
    components.push(Object.freeze({
      id: `wall-component-${components.length}`,
      cells: Object.freeze(componentCells),
      bounds: Object.freeze({
        minimumColumn: Math.min(...columns),
        maximumColumn: Math.max(...columns),
        minimumRow: Math.min(...rows),
        maximumRow: Math.max(...rows),
      }),
      boundaryEdges: Object.freeze(boundaryEdges),
      reciprocalJoins: Object.freeze(reciprocalJoins),
      corners: Object.freeze(corners),
      topCap: Object.freeze({
        continuous: reciprocalJoins.length >= Math.max(0, componentCells.length - 1),
        cellCount: componentCells.length,
        internalJoinCount: reciprocalJoins.length,
      }),
    }));
  }
  return Object.freeze(components);
}

export function auditWallTopology(cells) {
  const components = buildWallComponents(cells);
  const reciprocalJoins = components.flatMap((component) => component.reciprocalJoins);
  const cellCount = components.reduce((sum, component) => sum + component.cells.length, 0);
  return Object.freeze({
    componentCount: components.length,
    cellCount,
    reciprocalJoinCount: reciprocalJoins.length,
    allReciprocalJoins: components.every((component) => component.topCap.continuous),
    continuousTopCap: components.every((component) => component.topCap.continuous),
    cornerCount: components.reduce((sum, component) => sum + component.corners.length, 0),
    exposedSouthFaceCount: components.reduce((sum, component) => sum + component.cells.filter((cell) => cell.exposedMask & CARDINAL.SOUTH).length, 0),
    exposedEastFaceCount: components.reduce((sum, component) => sum + component.cells.filter((cell) => cell.exposedMask & CARDINAL.EAST).length, 0),
  });
}

export function smoothDoorProgress(progress) {
  const value = clamp(Number(progress) || 0, 0, 1);
  return value * value * (3 - 2 * value);
}

export function describeDoorAperture({
  axis,
  progress = 0,
  span = 3,
  tileSize = 48,
  jamb = 7,
  lintel = 7,
  threshold = 5,
  leafThickness = 6,
} = {}) {
  if (axis !== "horizontal" && axis !== "vertical") throw new Error("Door axis must be horizontal or vertical");
  for (const [label, value] of Object.entries({ span, tileSize, jamb, lintel, threshold, leafThickness })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  }
  if (!Number.isInteger(span) || !Number.isInteger(tileSize)) throw new Error("Door span and tileSize must be integers");
  const easedProgress = smoothDoorProgress(progress);
  const frameWidth = axis === "horizontal" ? span * tileSize : tileSize;
  const frameHeight = axis === "vertical" ? span * tileSize : tileSize;
  const inner = Object.freeze({
    x: jamb,
    y: lintel,
    width: frameWidth - jamb * 2,
    height: frameHeight - lintel - threshold,
  });
  if (inner.width <= 0 || inner.height <= 0) throw new Error("Door frame consumes its aperture");
  const openingWidth = axis === "horizontal" ? inner.width * easedProgress : inner.width;
  const openingHeight = axis === "vertical" ? inner.height * easedProgress : inner.height;
  const aperture = Object.freeze({
    x: inner.x + (inner.width - openingWidth) / 2,
    y: inner.y + (inner.height - openingHeight) / 2,
    width: openingWidth,
    height: openingHeight,
  });
  const leaves = axis === "horizontal"
    ? Object.freeze([
      Object.freeze({ side: "west", x: inner.x, y: inner.y, width: (inner.width - openingWidth) / 2, height: inner.height, thickness: leafThickness }),
      Object.freeze({ side: "east", x: inner.x + inner.width - (inner.width - openingWidth) / 2, y: inner.y, width: (inner.width - openingWidth) / 2, height: inner.height, thickness: leafThickness }),
    ])
    : Object.freeze([
      Object.freeze({ side: "north", x: inner.x, y: inner.y, width: inner.width, height: (inner.height - openingHeight) / 2, thickness: leafThickness }),
      Object.freeze({ side: "south", x: inner.x, y: inner.y + inner.height - (inner.height - openingHeight) / 2, width: inner.width, height: (inner.height - openingHeight) / 2, thickness: leafThickness }),
    ]);
  return Object.freeze({
    axis,
    progress: clamp(Number(progress) || 0, 0, 1),
    easedProgress,
    span,
    tileSize,
    jamb,
    lintel,
    threshold,
    leafThickness,
    frame: Object.freeze({ x: 0, y: 0, width: frameWidth, height: frameHeight }),
    inner,
    aperture,
    renderAperture: aperture,
    collisionAperture: aperture,
    leaves,
    apertureSize: axis === "horizontal" ? aperture.width : aperture.height,
    fullApertureSize: axis === "horizontal" ? inner.width : inner.height,
  });
}

export function doorAperturePasses(aperture, radius, clearance = 4) {
  if (!aperture || !Number.isFinite(aperture.apertureSize)) throw new Error("A valid aperture descriptor is required");
  if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(clearance) || clearance < 0) throw new Error("Radius and clearance must be non-negative");
  return aperture.apertureSize >= radius * 2 + clearance;
}

function makeRaster(width, height) {
  assertInteger(width, "Raster width");
  assertInteger(height, "Raster height");
  if (width <= 0 || height <= 0) throw new Error("Raster dimensions must be positive");
  return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
}

function blendPixel(raster, x, y, color) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  const offset = (y * raster.width + x) * 4;
  const alpha = color[3] / 255;
  const destinationAlpha = raster.pixels[offset + 3] / 255;
  const outputAlpha = alpha + destinationAlpha * (1 - alpha);
  if (outputAlpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    raster.pixels[offset + channel] = Math.round((color[channel] * alpha + raster.pixels[offset + channel] * destinationAlpha * (1 - alpha)) / outputAlpha);
  }
  raster.pixels[offset + 3] = Math.round(outputAlpha * 255);
}

function fillRect(raster, x, y, width, height, color) {
  const startX = Math.floor(x);
  const startY = Math.floor(y);
  const endX = Math.ceil(x + width);
  const endY = Math.ceil(y + height);
  for (let py = startY; py < endY; py += 1) for (let px = startX; px < endX; px += 1) blendPixel(raster, px, py, color);
}

function fillPolygon(raster, points, color) {
  const minimumX = Math.floor(Math.min(...points.map((point) => point[0])));
  const maximumX = Math.ceil(Math.max(...points.map((point) => point[0])));
  const minimumY = Math.floor(Math.min(...points.map((point) => point[1])));
  const maximumY = Math.ceil(Math.max(...points.map((point) => point[1])));
  for (let y = minimumY; y < maximumY; y += 1) for (let x = minimumX; x < maximumX; x += 1) {
    const sampleX = x + 0.5;
    const sampleY = y + 0.5;
    let inside = false;
    for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
      const [currentX, currentY] = points[current];
      const [previousX, previousY] = points[previous];
      if ((currentY > sampleY) !== (previousY > sampleY)
        && sampleX < (previousX - currentX) * (sampleY - currentY) / (previousY - currentY) + currentX) inside = !inside;
    }
    if (inside) blendPixel(raster, x, y, color);
  }
}

function worldMaterialColor(worldX, worldY) {
  // Broad, world-phased luminance only. It never resets at a tile boundary;
  // the browser review intentionally keeps this neutral while the authored
  // industrial-forge-wall-v1 material remains candidate-visual-review.
  const band = ((Math.floor(worldX / 11) + Math.floor(worldY / 17) * 2) % 5 + 5) % 5;
  const delta = [-5, -2, 0, 2, 5][band];
  return [STRUCTURE_COLORS.topHigh[0] + delta, STRUCTURE_COLORS.topHigh[1] + delta, STRUCTURE_COLORS.topHigh[2] + delta, 255];
}

function fillWorldMaterial(raster, x, y, width, height, worldOffsetX = 0, worldOffsetY = 0) {
  for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
    blendPixel(raster, px, py, worldMaterialColor(px - x + worldOffsetX, py - y + worldOffsetY));
  }
}

function drawWallCell(raster, cell, originX, originY, tileSize, projectionDepth, shadowOffset) {
  const x = originX + cell.column * tileSize;
  const y = originY + cell.row * tileSize;
  const eastExposed = Boolean(cell.exposedMask & CARDINAL.EAST);
  const southExposed = Boolean(cell.exposedMask & CARDINAL.SOUTH);
  if (eastExposed || southExposed) {
    fillPolygon(raster, [
      [x + (eastExposed ? tileSize : 0) + shadowOffset, y + shadowOffset],
      [x + tileSize + projectionDepth + shadowOffset, y + projectionDepth + shadowOffset],
      [x + tileSize + projectionDepth + shadowOffset, y + tileSize + projectionDepth + shadowOffset],
      [x + shadowOffset, y + tileSize + shadowOffset],
    ], STRUCTURE_COLORS.shadow);
  }
  if (southExposed) fillPolygon(raster, [
    [x, y + tileSize],
    [x + tileSize, y + tileSize],
    [x + tileSize + projectionDepth, y + tileSize + projectionDepth],
    [x + projectionDepth, y + tileSize + projectionDepth],
  ], STRUCTURE_COLORS.sideSouth);
  if (eastExposed) fillPolygon(raster, [
    [x + tileSize, y],
    [x + tileSize, y + tileSize],
    [x + tileSize + projectionDepth, y + tileSize + projectionDepth],
    [x + tileSize + projectionDepth, y + projectionDepth],
  ], STRUCTURE_COLORS.sideEast);
  fillWorldMaterial(raster, x, y, tileSize, tileSize, cell.column * tileSize, cell.row * tileSize);
  if (cell.exposedMask & CARDINAL.NORTH) fillRect(raster, x, y, tileSize, 2, STRUCTURE_COLORS.topEdge);
  if (cell.exposedMask & CARDINAL.WEST) fillRect(raster, x, y, 2, tileSize, STRUCTURE_COLORS.topEdge);
  if (southExposed) fillRect(raster, x, y + tileSize - 2, tileSize, 2, STRUCTURE_COLORS.sideEdge);
  if (eastExposed) fillRect(raster, x + tileSize - 2, y, 2, tileSize, STRUCTURE_COLORS.sideEdge);
  const bevel = 4;
  if (cell.exposedCornerMask & 1) fillPolygon(raster, [[x + tileSize - bevel, y], [x + tileSize, y], [x + tileSize, y + bevel]], STRUCTURE_COLORS.sideEdge);
  if (cell.exposedCornerMask & 2) fillPolygon(raster, [[x + tileSize, y + tileSize - bevel], [x + tileSize, y + tileSize], [x + tileSize - bevel, y + tileSize]], STRUCTURE_COLORS.sideEdge);
  if (cell.exposedCornerMask & 4) fillPolygon(raster, [[x, y + tileSize - bevel], [x, y + tileSize], [x + bevel, y + tileSize]], STRUCTURE_COLORS.sideEdge);
  if (cell.exposedCornerMask & 8) fillPolygon(raster, [[x, y], [x + bevel, y], [x, y + bevel]], STRUCTURE_COLORS.topEdge);
}

const colorsEqual = (left, right) => left.every((channel, index) => channel === right[index]);

function auditRenderedWall(raster, cells, geometry) {
  const topology = auditWallTopology(cells);
  const byKey = new Map(cells.map((cell) => [keyFor(cell.column, cell.row), cell]));
  const internalJoins = [];
  for (const cell of cells) {
    for (const direction of DIRECTIONS) {
      const neighbor = byKey.get(keyFor(cell.column + direction.dx, cell.row + direction.dy));
      if (!neighbor) continue;
      if (cell.row > neighbor.row || (cell.row === neighbor.row && cell.column > neighbor.column)) continue;
      internalJoins.push({ cell, neighbor, direction });
    }
  }
  const internalEdgeColors = [STRUCTURE_COLORS.topEdge, STRUCTURE_COLORS.sideEdge];
  let internalSeamPixels = 0;
  let maximumInternalSeamRun = 0;
  let shadowPixelCount = 0;
  let southFacePixelCount = 0;
  let eastFacePixelCount = 0;
  for (let y = 0; y < raster.height; y += 1) for (let x = 0; x < raster.width; x += 1) {
    const pixel = pixelAt(raster, x, y);
    if (pixel[3] > 0 && pixel[3] < 255) shadowPixelCount += 1;
    if (colorsEqual(pixel, STRUCTURE_COLORS.sideSouth)) southFacePixelCount += 1;
    if (colorsEqual(pixel, STRUCTURE_COLORS.sideEast)) eastFacePixelCount += 1;
  }
  for (const { cell, neighbor, direction } of internalJoins) {
    const horizontalJoin = direction.dx !== 0;
    const boundaryX = geometry.originX + (horizontalJoin ? Math.max(cell.column, neighbor.column) * geometry.tileSize : cell.column * geometry.tileSize);
    const boundaryY = geometry.originY + (horizontalJoin ? cell.row * geometry.tileSize : Math.max(cell.row, neighbor.row) * geometry.tileSize);
    const samples = [];
    for (let offset = 4; offset < geometry.tileSize - 4; offset += 1) {
      const left = horizontalJoin
        ? pixelAt(raster, boundaryX - 1, boundaryY + offset)
        : pixelAt(raster, boundaryX + offset, boundaryY - 1);
      const right = horizontalJoin
        ? pixelAt(raster, boundaryX, boundaryY + offset)
        : pixelAt(raster, boundaryX + offset, boundaryY);
      samples.push([left, right]);
      if (internalEdgeColors.some((color) => colorsEqual(left, color) || colorsEqual(right, color))) internalSeamPixels += 1;
    }
    let run = 0;
    for (const [left, right] of samples) {
      if (internalEdgeColors.some((color) => colorsEqual(left, color) || colorsEqual(right, color))) run += 1;
      else run = 0;
      maximumInternalSeamRun = Math.max(maximumInternalSeamRun, run);
    }
  }
  return Object.freeze({
    ...topology,
    internalJoinCount: internalJoins.length,
    internalSeamPixels,
    maximumInternalSeamRun,
    noInternal64pxStrokes: internalSeamPixels === 0 && maximumInternalSeamRun === 0,
    continuousTopCap: topology.continuousTopCap && internalSeamPixels === 0,
    shadowPixelCount,
    southFacePixelCount,
    eastFacePixelCount,
  });
}

export function rasterizeWallAssembly(cells, {
  tileSize = 48,
  projectionDepth = 10,
  shadowOffset = 5,
  padding = 18,
} = {}) {
  for (const [label, value] of Object.entries({ tileSize, projectionDepth, shadowOffset, padding })) if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  const components = buildWallComponents(cells);
  const allCells = components.flatMap((component) => component.cells);
  const minimumColumn = Math.min(...allCells.map((cell) => cell.column));
  const maximumColumn = Math.max(...allCells.map((cell) => cell.column));
  const minimumRow = Math.min(...allCells.map((cell) => cell.row));
  const maximumRow = Math.max(...allCells.map((cell) => cell.row));
  const translated = allCells.map((cell) => describeWallCell(cell.connectedMask, {
    column: cell.column - minimumColumn,
    row: cell.row - minimumRow,
  }));
  const width = (maximumColumn - minimumColumn + 1) * tileSize + padding * 2 + projectionDepth + shadowOffset;
  const height = (maximumRow - minimumRow + 1) * tileSize + padding * 2 + projectionDepth + shadowOffset;
  const raster = makeRaster(width, height);
  const originX = padding;
  const originY = padding;
  translated.slice().sort((left, right) => left.row - right.row || left.column - right.column).forEach((cell) => {
    drawWallCell(raster, cell, originX, originY, tileSize, projectionDepth, shadowOffset);
  });
  const geometry = Object.freeze({
    tileSize,
    projectionDepth,
    shadowOffset,
    padding,
    originX,
    originY,
    cells: Object.freeze(translated),
    bounds: Object.freeze({
      minimumColumn: 0,
      maximumColumn: maximumColumn - minimumColumn,
      minimumRow: 0,
      maximumRow: maximumRow - minimumRow,
    }),
  });
  return Object.freeze({ ...raster, components, geometry, audit: auditRenderedWall(raster, translated, geometry) });
}

export function rasterizeWallMask(mask, options = {}) {
  const tileSize = options.tileSize ?? 48;
  const projectionDepth = options.projectionDepth ?? 10;
  const shadowOffset = options.shadowOffset ?? 5;
  const padding = options.padding ?? 18;
  const cell = describeWallCell(mask);
  const width = tileSize + padding * 2 + projectionDepth + shadowOffset;
  const height = tileSize + padding * 2 + projectionDepth + shadowOffset;
  const raster = makeRaster(width, height);
  drawWallCell(raster, cell, padding, padding, tileSize, projectionDepth, shadowOffset);
  const geometry = Object.freeze({
    tileSize,
    projectionDepth,
    shadowOffset,
    padding,
    originX: padding,
    originY: padding,
    cells: Object.freeze([cell]),
    bounds: Object.freeze({ minimumColumn: 0, maximumColumn: 0, minimumRow: 0, maximumRow: 0 }),
  });
  return Object.freeze({
    ...raster,
    cell,
    components: Object.freeze([]),
    geometry,
    audit: auditRenderedWall(raster, [cell], geometry),
  });
}

function drawDoorLeaf(raster, leaf) {
  if (leaf.width <= 0 || leaf.height <= 0) return;
  fillRect(raster, leaf.x, leaf.y, leaf.width, leaf.height, STRUCTURE_COLORS.leaf);
  fillRect(raster, leaf.x, leaf.y, leaf.width, Math.min(2, leaf.height), STRUCTURE_COLORS.leafEdge);
  fillRect(raster, leaf.x, leaf.y, Math.min(2, leaf.width), leaf.height, STRUCTURE_COLORS.leafEdge);
  if (leaf.side === "west") fillRect(raster, leaf.x + leaf.width - leaf.thickness, leaf.y, Math.min(leaf.thickness, leaf.width), leaf.height, STRUCTURE_COLORS.leafDepth);
  if (leaf.side === "east") fillRect(raster, leaf.x, leaf.y, Math.min(leaf.thickness, leaf.width), leaf.height, STRUCTURE_COLORS.leafDepth);
  if (leaf.side === "north") fillRect(raster, leaf.x, leaf.y + leaf.height - leaf.thickness, leaf.width, Math.min(leaf.thickness, leaf.height), STRUCTURE_COLORS.leafDepth);
  if (leaf.side === "south") fillRect(raster, leaf.x, leaf.y, leaf.width, Math.min(leaf.thickness, leaf.height), STRUCTURE_COLORS.leafDepth);
}

export function makeDoorWallCells(axis, span = 3) {
  if (axis !== "horizontal" && axis !== "vertical") throw new Error("Door axis must be horizontal or vertical");
  if (!Number.isInteger(span) || span <= 0) throw new Error("Door span must be a positive integer");
  const cells = axis === "horizontal"
    ? Array.from({ length: span + 2 }, (_, column) => ({ column, row: 0 }))
    : Array.from({ length: span + 2 }, (_, row) => ({ column: 0, row }));
  return freezeCells(cells);
}

function drawDoorIntoRaster(raster, descriptor, offsetX, offsetY) {
  const moveRect = (rect) => ({ ...rect, x: rect.x + offsetX, y: rect.y + offsetY });
  const inner = moveRect(descriptor.inner);
  const aperture = moveRect(descriptor.aperture);
  fillRect(raster, inner.x, inner.y, inner.width, inner.height, STRUCTURE_COLORS.threshold);
  if (descriptor.axis === "horizontal") {
    fillRect(raster, inner.x, inner.y + inner.height - 1, inner.width, 1, STRUCTURE_COLORS.thresholdLine);
  } else {
    fillRect(raster, inner.x + inner.width - 1, inner.y, 1, inner.height, STRUCTURE_COLORS.thresholdLine);
  }
  const leftJamb = { x: offsetX, y: offsetY, width: descriptor.jamb, height: descriptor.frame.height };
  const rightJamb = { x: offsetX + descriptor.frame.width - descriptor.jamb, y: offsetY, width: descriptor.jamb, height: descriptor.frame.height };
  const topLintel = { x: offsetX, y: offsetY, width: descriptor.frame.width, height: descriptor.lintel };
  const bottomThreshold = { x: offsetX, y: offsetY + descriptor.frame.height - descriptor.threshold, width: descriptor.frame.width, height: descriptor.threshold };
  for (const framePart of [leftJamb, rightJamb, topLintel, bottomThreshold]) {
    fillRect(raster, framePart.x, framePart.y, framePart.width, framePart.height, STRUCTURE_COLORS.jamb);
    fillRect(raster, framePart.x, framePart.y, framePart.width, Math.min(2, framePart.height), STRUCTURE_COLORS.jambEdge);
    fillRect(raster, framePart.x, framePart.y, Math.min(2, framePart.width), framePart.height, STRUCTURE_COLORS.jambEdge);
  }
  descriptor.leaves.map(moveRect).forEach((leaf) => drawDoorLeaf(raster, leaf));
  // Render and collision consume descriptor.renderAperture and
  // descriptor.collisionAperture, which intentionally reference the same
  // rectangle. Redrawing the opening last prevents leaf depth from stealing
  // traversable pixels at half and full progress.
  if (aperture.width > 0 && aperture.height > 0) fillRect(raster, aperture.x, aperture.y, aperture.width, aperture.height, STRUCTURE_COLORS.aperture);
}

export function rasterizeWallDoorAssembly(options = {}) {
  const axis = options.axis;
  const span = options.span ?? 3;
  const tileSize = options.tileSize ?? 48;
  const descriptor = describeDoorAperture(options);
  const wallCells = makeDoorWallCells(axis, span);
  const wall = rasterizeWallAssembly(wallCells, {
    tileSize,
    projectionDepth: options.projectionDepth ?? 10,
    shadowOffset: options.shadowOffset ?? 5,
    padding: Number.isInteger(options.padding) ? options.padding : 16,
  });
  const doorOriginX = wall.geometry.originX + (axis === "horizontal" ? tileSize : 0);
  const doorOriginY = wall.geometry.originY + (axis === "vertical" ? tileSize : 0);
  drawDoorIntoRaster(wall, descriptor, doorOriginX, doorOriginY);
  const moveRect = (rect) => Object.freeze({ ...rect, x: rect.x + doorOriginX, y: rect.y + doorOriginY });
  const frame = moveRect(descriptor.frame);
  const inner = moveRect(descriptor.inner);
  const aperture = moveRect(descriptor.renderAperture);
  const geometry = Object.freeze({
    ...wall.geometry,
    doorOriginX,
    doorOriginY,
    frame,
    inner,
    aperture,
    renderAperture: aperture,
    collisionAperture: aperture,
    wallCells,
    wallRun: Object.freeze({
      axis,
      componentId: wall.components[0]?.id ?? null,
      connected: wall.components.length === 1 && wall.audit.allReciprocalJoins,
      cellCount: wallCells.length,
    }),
  });
  return Object.freeze({
    ...wall,
    descriptor,
    geometry,
    audit: Object.freeze({
      ...wall.audit,
      doorAxis: axis,
      doorProgress: descriptor.progress,
      apertureSize: descriptor.apertureSize,
      fullApertureSize: descriptor.fullApertureSize,
      renderCollisionShared: geometry.renderAperture === geometry.collisionAperture,
      connectedWallRun: geometry.wallRun.connected,
      jambVisible: descriptor.jamb > 0,
      lintelVisible: descriptor.lintel > 0,
      thresholdVisible: descriptor.threshold > 0,
      leafThickness: descriptor.leafThickness,
    }),
  });
}

export function rasterizeDoorAssembly(options = {}) {
  return rasterizeWallDoorAssembly(options);
}

export function scaleRgbaNearest(raster, scale = 2) {
  assertInteger(scale, "Scale");
  if (scale <= 0) throw new Error("Scale must be positive");
  const output = makeRaster(raster.width * scale, raster.height * scale);
  for (let y = 0; y < raster.height; y += 1) for (let x = 0; x < raster.width; x += 1) {
    const sourceOffset = (y * raster.width + x) * 4;
    const color = Array.from(raster.pixels.subarray(sourceOffset, sourceOffset + 4));
    fillRect(output, x * scale, y * scale, scale, scale, color);
  }
  return output;
}

export function rgbaNearestScaleMatches(source, scaled, scale = 2) {
  if (!Number.isInteger(scale) || scale <= 0) throw new Error("Scale must be a positive integer");
  if (scaled.width !== source.width * scale || scaled.height !== source.height * scale) return false;
  for (let y = 0; y < source.height; y += 1) for (let x = 0; x < source.width; x += 1) {
    const expected = pixelAt(source, x, y);
    for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
      if (!colorsEqual(pixelAt(scaled, x * scale + dx, y * scale + dy), expected)) return false;
    }
  }
  return true;
}

export function rgbaHash(raster) {
  let hash = 2166136261;
  for (let index = 0; index < raster.pixels.length; index += 1) {
    hash ^= raster.pixels[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function rgbaLuminance(color) {
  return color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
}

export function pixelAt(raster, x, y) {
  assertInteger(x, "Pixel x");
  assertInteger(y, "Pixel y");
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return [0, 0, 0, 0];
  const offset = (y * raster.width + x) * 4;
  return Array.from(raster.pixels.subarray(offset, offset + 4));
}
