/** Compact palette parsing, interpolation, and deterministic selection. MIT. */
export function parseHexColor(value) {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(value);
  if (match === null) throw new TypeError(`Invalid color ${value}.`);
  const hex = match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).concat(match[2] === undefined ? 255 : Number.parseInt(match[2], 16));
}

export function rgba(color) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.round(color[3] ?? 255) / 255})`;
}

export function mixColors(left, right, amount) {
  const t = Math.min(Math.max(Number(amount), 0), 1);
  return Array.from({ length: 4 }, (_, index) => Math.round((left[index] ?? 255) + ((right[index] ?? 255) - (left[index] ?? 255)) * t));
}

export function paletteColor(palette, index) {
  if (!Array.isArray(palette) || palette.length === 0) throw new RangeError("Palette cannot be empty.");
  return parseHexColor(palette[((index % palette.length) + palette.length) % palette.length]);
}
