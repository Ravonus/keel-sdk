/** Deterministic xoshiro128** helpers for replayable browser art. MIT. */
export function seedWords(hexSeed) {
  const clean = String(hexSeed).replace(/^0x/u, "").padEnd(64, "0").slice(0, 64);
  return Array.from({ length: 4 }, (_, index) => {
    const high = Number.parseInt(clean.slice(index * 8, index * 8 + 8), 16) >>> 0;
    const low = Number.parseInt(clean.slice((index + 4) * 8, (index + 5) * 8), 16) >>> 0;
    return (high ^ low) >>> 0;
  });
}

export function createSeededRandom(hexSeed) {
  let [a, b, c, d] = seedWords(hexSeed);
  if ((a | b | c | d) === 0) d = 1;
  return function random() {
    const result = Math.imul(((b * 5) >>> 0), 0x7fffffff) >>> 0;
    const value = (((result << 7) | (result >>> 25)) * 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = ((d << 11) | (d >>> 21)) >>> 0;
    return value / 0x1_0000_0000;
  };
}

export function randomInt(random, minimum, maximum) {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
    throw new RangeError("randomInt expects an inclusive safe-integer range.");
  }
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}
