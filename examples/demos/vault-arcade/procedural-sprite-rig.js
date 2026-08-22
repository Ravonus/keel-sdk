export const VAULT_DIRECTIONS = Object.freeze([
  "south",
  "southwest",
  "west",
  "northwest",
  "north",
  "northeast",
  "east",
  "southeast",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function validateTransform(value, label) {
  if (value === undefined)
    return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  return {
    x: finiteNumber(value.x ?? 0, `${label}.x`),
    y: finiteNumber(value.y ?? 0, `${label}.y`),
    rotation: finiteNumber(value.rotation ?? 0, `${label}.rotation`),
    scaleX: finiteNumber(value.scaleX ?? 1, `${label}.scaleX`),
    scaleY: finiteNumber(value.scaleY ?? 1, `${label}.scaleY`),
  };
}

export function parseProceduralSpriteRig(bytes) {
  const source = typeof bytes === "string" ? bytes : decoder.decode(bytes);
  const rig = JSON.parse(source);
  if (rig.schema !== "keel-procedural-sprite-rig@1")
    throw new Error("Unsupported procedural sprite rig schema.");
  if (!Number.isInteger(rig.frames) || rig.frames < 2 || rig.frames > 64)
    throw new Error("Procedural sprite rig frames must be between 2 and 64.");
  if (!Number.isFinite(rig.fps) || rig.fps <= 0 || rig.fps > 60)
    throw new Error("Procedural sprite rig fps must be between 0 and 60.");
  if (!Array.isArray(rig.phases) || rig.phases.length !== rig.frames)
    throw new Error("Procedural sprite rig must name every frame phase.");
  if (new Set(rig.phases).size !== rig.phases.length)
    throw new Error("Procedural sprite rig phase names must be unique.");
  if (!Array.isArray(rig.layers) || rig.layers.length < 1)
    throw new Error("Procedural sprite rig requires layers.");
  for (const [index, layer] of rig.layers.entries()) {
    if (typeof layer.id !== "string" || layer.id.length === 0)
      throw new Error(`Procedural sprite rig layer ${index} has no id.`);
    if (!Number.isInteger(layer.sourceRow) || layer.sourceRow < 0)
      throw new Error(
        `Procedural sprite rig layer ${layer.id} has an invalid sourceRow.`,
      );
    if (!Array.isArray(layer.frames) || layer.frames.length !== rig.frames)
      throw new Error(
        `Procedural sprite rig layer ${layer.id} must define every frame.`,
      );
    layer.frames = layer.frames.map((frame, frameIndex) =>
      validateTransform(frame, `${layer.id}.frames[${frameIndex}]`),
    );
  }
  return rig;
}

export function proceduralFrameAt(elapsedMilliseconds, rig) {
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0)
    return 0;
  const frame = Math.floor((elapsedMilliseconds / 1000) * rig.fps);
  return Math.min(frame, rig.frames - 1);
}

export function sidearmCompositeOrder(direction) {
  const name =
    typeof direction === "number" ? VAULT_DIRECTIONS[direction] : direction;
  if (name === "east" || name === "northeast" || name === "southeast")
    return ["left-arm", "body", "right-arm", "weapon"];
  if (name === "west" || name === "northwest" || name === "southwest")
    return ["right-arm", "body", "left-arm", "weapon"];
  if (name === "north") return ["right-arm", "left-arm", "body", "weapon"];
  if (name === "south") return ["body", "right-arm", "left-arm", "weapon"];
  throw new Error(`Unknown Vault direction ${String(direction)}.`);
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === "function")
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function generateProceduralLayerAtlases(source, rig, options = {}) {
  const directions = options.directions ?? VAULT_DIRECTIONS.length;
  const sourceColumns = options.sourceColumns ?? directions;
  const sourceRows = options.sourceRows ?? rig.layers.length;
  const cellWidth = source.width / sourceColumns;
  const cellHeight = source.height / sourceRows;
  if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight))
    throw new Error("Procedural sprite source must divide into whole cells.");

  const atlases = new Map();
  for (const layer of rig.layers) {
    if (layer.sourceRow >= sourceRows)
      throw new Error(`Layer ${layer.id} sourceRow exceeds the source atlas.`);
    const atlas = createCanvas(cellWidth * rig.frames, cellHeight * directions);
    const context = atlas.getContext("2d");
    context.imageSmoothingEnabled = false;
    for (let direction = 0; direction < directions; direction += 1) {
      for (let frame = 0; frame < rig.frames; frame += 1) {
        const transform = layer.frames[frame];
        const centerX = frame * cellWidth + cellWidth / 2 + transform.x;
        const centerY = direction * cellHeight + cellHeight / 2 + transform.y;
        context.save();
        context.translate(centerX, centerY);
        context.rotate(transform.rotation);
        context.scale(transform.scaleX, transform.scaleY);
        context.drawImage(
          source,
          direction * cellWidth,
          layer.sourceRow * cellHeight,
          cellWidth,
          cellHeight,
          -cellWidth / 2,
          -cellHeight / 2,
          cellWidth,
          cellHeight,
        );
        context.restore();
      }
    }
    atlases.set(layer.id, atlas);
  }
  return atlases;
}
