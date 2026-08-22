/** Tiny seeded value-noise field with smooth interpolation. MIT. */
function hash(x, y, seed) {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ (seed | 0);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39);
  return ((value ^ (value >>> 15)) >>> 0) / 0x1_0000_0000;
}

const smooth = (value) => value * value * (3 - 2 * value);
const mix = (left, right, amount) => left + (right - left) * amount;

export function noise2d(x, y, seed = 0) {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const fx = smooth(x - left);
  const fy = smooth(y - top);
  return mix(mix(hash(left, top, seed), hash(left + 1, top, seed), fx), mix(hash(left, top + 1, seed), hash(left + 1, top + 1, seed), fx), fy);
}

export function fractalNoise2d(x, y, { seed = 0, octaves = 4, persistence = 0.5, lacunarity = 2 } = {}) {
  let total = 0; let amplitude = 1; let frequency = 1; let scale = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += noise2d(x * frequency, y * frequency, seed + octave) * amplitude;
    scale += amplitude; amplitude *= persistence; frequency *= lacunarity;
  }
  return scale === 0 ? 0 : total / scale;
}
