/**
 * Backdrop geometry — proof that the shape detection is algorithmic.
 *
 * Nothing here tells the detector what it is looking at. Each case paints an
 * RGBA buffer with a known shape and then asks `measureBackdrop` to recover it
 * from the pixels alone. Every input is synthetic and generated in memory so
 * no creator collection or creator media becomes an SDK fixture.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureBackdrop } from "../src/keel-asset-view.js";

/**
 * Paint a rounded rectangle (radius `r`) of `fill` onto a field of `outside`.
 *
 * Supersampled, because a real image is antialiased and a detector tuned
 * against hard-edged fixtures would be tuned against something that never
 * arrives. Each pixel gets the coverage a renderer would give it.
 */
function paint({ size = 256, inset = 0, r = 0, fill = [235, 155, 54, 255], outside = [0, 0, 0, 0], ellipse = false } = {}) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const left = inset;
  const top = inset;
  const right = size - inset;
  const bottom = size - inset;
  const w = right - left;
  const h = bottom - top;
  const covered = (x, y) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    if (ellipse) {
      const nx = (x - left - w / 2) / (w / 2);
      const ny = (y - top - h / 2) / (h / 2);
      return nx * nx + ny * ny <= 1;
    }
    if (r <= 0) return true;
    const dx = Math.max(left + r - x, x - (right - r), 0);
    const dy = Math.max(top + r - y, y - (bottom - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const GRID = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < GRID; sy++) {
        for (let sx = 0; sx < GRID; sx++) {
          if (covered(x + (sx + 0.5) / GRID, y + (sy + 0.5) / GRID)) hits++;
        }
      }
      const a = hits / (GRID * GRID);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) pixels[i + c] = Math.round(fill[c] * a + outside[c] * (1 - a));
    }
  }
  return { pixels, size };
}

test("a hard-cornered field reads as a square", () => {
  const { pixels, size } = paint({ inset: 24, r: 0 });
  const shape = measureBackdrop(pixels, size, size);
  assert.equal(shape.kind, "rect");
  assert.equal(shape.r, 0);
});

test("an image that is one flat colour edge to edge has no shape to find", () => {
  const { pixels, size } = paint({ r: 0 });
  assert.equal(measureBackdrop(pixels, size, size).kind, "full");
});

test("corner radius is recovered across the whole range", () => {
  for (const r of [3, 6, 8, 12, 21, 40, 64, 96]) {
    const { pixels, size } = paint({ r });
    const shape = measureBackdrop(pixels, size, size);
    const measured = shape.r * size;
    assert.equal(shape.kind, r >= size * 0.45 ? "ellipse" : "rounded", `r=${r} kind`);
    // Sub-pixel across the range: the uncovered-length trace does not round to
    // a pixel anywhere, so a shallow curve is as well recovered as a deep one.
    assert.ok(Math.abs(measured - r) <= 0.5, `r=${r} measured ${measured.toFixed(2)}`);
  }
});

test("a circle is called an ellipse, not a 50% corner", () => {
  const { pixels, size } = paint({ ellipse: true });
  const shape = measureBackdrop(pixels, size, size);
  assert.equal(shape.kind, "ellipse");
});

test("a matted artwork reports the backdrop box, not the canvas", () => {
  const { pixels, size } = paint({ inset: 32, r: 16 });
  const shape = measureBackdrop(pixels, size, size);
  assert.ok(Math.abs(shape.x - 32 / size) < 0.02, `x=${shape.x}`);
  assert.ok(Math.abs(shape.w - (size - 64) / size) < 0.03, `w=${shape.w}`);
  assert.equal(shape.kind, "rounded");
});

test("a full-bleed image has no backdrop to trace", () => {
  const size = 128;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i * 4);
  }
  const shape = measureBackdrop(pixels, size, size);
  assert.equal(shape.kind, "full");
  assert.equal(shape.confidence, 0);
});

test("mismatched corners are refused rather than averaged", () => {
  const { pixels, size } = paint({ r: 40 });
  // Square off one corner only. Four corners that disagree is not a shape.
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) pixels.set([235, 155, 54, 255], (y * size + x) * 4);
  }
  const shape = measureBackdrop(pixels, size, size);
  assert.equal(shape.confidence, 0);
  assert.equal(shape.r, 0);
  assert.notEqual(shape.kind, "rounded");
});

test("an opaque backdrop over a solid outside is found by colour, not alpha", () => {
  const { pixels, size } = paint({ inset: 20, r: 24, outside: [8, 8, 12, 255] });
  const shape = measureBackdrop(pixels, size, size);
  assert.equal(shape.kind, "rounded");
  assert.ok(Math.abs(shape.r * (size - 40) - 24) <= 4, `r=${shape.r * (size - 40)}`);
  assert.equal(shape.color, "rgb(235,155,54)");
});
