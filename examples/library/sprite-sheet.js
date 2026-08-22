/** Equal-cell and JSON-atlas sprite sheet helpers using ImageBitmap source rectangles. MIT. */
export function equalCells(imageWidth, imageHeight, { columns, rows = 1 }) {
  if (![imageWidth, imageHeight, columns, rows].every(Number.isSafeInteger) || columns < 1 || rows < 1) {
    throw new RangeError("Sprite geometry must use positive integers.");
  }
  if (imageWidth % columns !== 0 || imageHeight % rows !== 0) {
    throw new RangeError("Sprite sheet dimensions must divide evenly into the requested grid.");
  }
  const width = imageWidth / columns;
  const height = imageHeight / rows;
  return Array.from({ length: columns * rows }, (_, index) => ({
    x: (index % columns) * width,
    y: Math.floor(index / columns) * height,
    width,
    height,
  }));
}

export function atlasFrames(atlas) {
  if (atlas === null || typeof atlas !== "object" || Array.isArray(atlas.frames)) {
    throw new TypeError("Expected a named JSON atlas frame map.");
  }
  return Object.entries(atlas.frames ?? {}).map(([name, value]) => {
    const frame = value?.frame ?? value;
    const numbers = [frame?.x, frame?.y, frame?.w ?? frame?.width, frame?.h ?? frame?.height];
    if (!numbers.every((number) => Number.isSafeInteger(number) && number >= 0)) throw new TypeError(`Invalid atlas frame ${name}.`);
    return { name, x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
  });
}

export function drawFrame(context, image, frame, destination) {
  context.imageSmoothingEnabled = false;
  context.drawImage(image, frame.x, frame.y, frame.width, frame.height, destination.x, destination.y, destination.width, destination.height);
}
