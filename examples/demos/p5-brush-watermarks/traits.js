// Watermarks — deterministic identity derivation for a brushed watercolor
// PFP series. Pure data: no p5, no DOM, no imports, so the exact module runs
// unchanged in the browser sandbox and in the Node test suite.
//
// One token seed fans out into independent streams (identity, layout, paint)
// so the trait roll can never be disturbed by a change in how strokes are
// painted, and vice versa. Every stream is xoshiro128** — the same generator
// as examples/library/seeded-random.js — salted per domain.

// ---------------------------------------------------------------------------
// Seeded streams

function seedWords(hexSeed, salt) {
  const clean = String(hexSeed).replace(/^0x/u, "").padEnd(64, "0").slice(0, 64);
  // Fold the salt into a 32-bit tag so "identity" and "paint:2" diverge fully.
  let tag = 0x9e3779b9;
  for (let index = 0; index < salt.length; index += 1) {
    tag = (Math.imul(tag ^ salt.charCodeAt(index), 0x85ebca6b) >>> 0);
    tag = ((tag << 13) | (tag >>> 19)) >>> 0;
  }
  return Array.from({ length: 4 }, (_, index) => {
    const high = Number.parseInt(clean.slice(index * 8, index * 8 + 8), 16) >>> 0;
    const low = Number.parseInt(clean.slice((index + 4) * 8, (index + 5) * 8), 16) >>> 0;
    return (high ^ low ^ (Math.imul(tag, index + 1) >>> 0)) >>> 0;
  });
}

/** Deterministic xoshiro128** stream in [0, 1), salted per domain. */
export function makeStream(hexSeed, salt = "identity") {
  let [a, b, c, d] = seedWords(hexSeed, salt);
  if ((a | b | c | d) === 0) d = 1;
  const random = () => {
    const result = Math.imul((b * 5) >>> 0, 0x7fffffff) >>> 0;
    const value = (((result << 7) | (result >>> 25)) * 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = ((d << 11) | (d >>> 21)) >>> 0;
    return value / 0x1_0000_0000;
  };
  random.range = (minimum, maximum) => minimum + random() * (maximum - minimum);
  random.int = (minimum, maximum) => minimum + Math.floor(random() * (maximum - minimum + 1));
  random.pick = (list) => list[Math.floor(random() * list.length)];
  random.chance = (probability) => random() < probability;
  return random;
}

function weightedPick(random, entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1];
}

// ---------------------------------------------------------------------------
// Palettes — pigment sets tuned so any wash/accent pairing stays in harmony.
// paper: the sheet. washes: mid-value pigments. accents: the punch colors.
// ink: line work (never pure black — real inks are grey, sepia, indigo).

export const PALETTES = [
  {
    name: "Tidewater", weight: 15,
    paper: "#f4f1e8", washes: ["#2e5f7a", "#7fb3c8"], accents: ["#e8623d"],
    ink: "#2b3440", deep: "#1b2430",
  },
  {
    name: "Terracotta Dusk", weight: 14,
    paper: "#f6efe3", washes: ["#c96f4a", "#d9a08c"], accents: ["#2f6d62"],
    ink: "#4a352a", deep: "#33241c",
  },
  {
    name: "Moss & Brass", weight: 13,
    paper: "#f2f0e4", washes: ["#7a7d4a", "#55663d"], accents: ["#c9962e"],
    ink: "#3d3528", deep: "#262117",
  },
  {
    name: "Rose Smoke", weight: 12,
    paper: "#f7f0ee", washes: ["#c76e79", "#a396b0"], accents: ["#5d3a56"],
    ink: "#453844", deep: "#2e222c",
  },
  {
    name: "Sea Glass", weight: 12,
    paper: "#eef3f0", washes: ["#3f8577", "#9cc4b2"], accents: ["#e0785a"],
    ink: "#24443c", deep: "#16302a",
  },
  {
    name: "Saffron Field", weight: 11,
    paper: "#f8f3e6", washes: ["#e0a63c", "#c07f2d"], accents: ["#6b5aa3"],
    ink: "#4b3a26", deep: "#32271a",
  },
  {
    name: "Indigo Rain", weight: 11,
    paper: "#f1f2f4", washes: ["#3d4f7c", "#6b7fa3"], accents: ["#cf9f4f"],
    ink: "#232a3d", deep: "#161c2c",
  },
  {
    name: "Orchid Ink", weight: 5,
    paper: "#f6f4f1", washes: ["#55565e", "#a7a7ad"], accents: ["#b0509c"],
    ink: "#26262c", deep: "#141418",
  },
  {
    name: "Glacier Ember", weight: 5,
    paper: "#eff3f6", washes: ["#8fb6cc", "#b9c9d4"], accents: ["#d95f2b"],
    ink: "#33424e", deep: "#1f2c36",
  },
];

// ---------------------------------------------------------------------------
// Backgrounds — picked per token but deliberately NOT an attribute: the
// contract may swap a token's background later, so it must never be part of
// the immutable trait list. `deriveIdentity` accepts an override for that.

export const BACKGROUND_STYLES = [
  { name: "Wash Fade", weight: 22 },
  { name: "Spatter Paper", weight: 18 },
  { name: "Granulated Field", weight: 15 },
  { name: "Halo Wash", weight: 14 },
  { name: "Split Wash", weight: 13 },
  { name: "Hatch Weave", weight: 10 },
  { name: "Deep Pool", weight: 6 }, // rare inversion: pigment sheet, paper lines
];

// ---------------------------------------------------------------------------
// Colorways — some attributes do not own one color but a *range*: strokes may
// interpolate between two pigments, alternate them, or drift inside the wash.
// `from`/`to` are resolved to concrete palette colors at derivation time so
// the recipe records the actual range this token painted with.

const COLORWAY_KINDS = {
  ink: { label: "Ink" },
  washA: { label: "First Wash" },
  washB: { label: "Second Wash" },
  accent: { label: "Accent" },
  washMix: { label: "Wash Range" }, // lerp washA -> washB per stroke
  washAccent: { label: "Wash To Accent" }, // lerp washA -> accent per stroke
  duotone: { label: "Duotone" }, // alternate washA / accent stroke by stroke
};

function resolveColorway(random, palette, pool) {
  const kind = random.pick(pool);
  const washA = random.pick(palette.washes);
  const washB = palette.washes[(palette.washes.indexOf(washA) + 1) % palette.washes.length];
  const accent = random.pick(palette.accents);
  const single = { ink: palette.ink, washA, washB, accent }[kind];
  const ranged = kind === "washMix" || kind === "washAccent" || kind === "duotone";
  return {
    kind,
    label: COLORWAY_KINDS[kind].label,
    from: ranged ? washA : single,
    to: kind === "washMix" ? washB : ranged ? accent : single,
  };
}

// ---------------------------------------------------------------------------
// Trait tables. Base three (Face, Eyes, Mouth) are always present; the
// optional slots roll afterwards. `anim` tags: "micro" rides the boil layer,
// "major" earns live per-frame movement on top of it.

const FACES = [
  { value: "Round Wash", weight: 22 },
  { value: "Tilted Oval", weight: 20 },
  { value: "Shard", weight: 14 },
  { value: "Arch", weight: 14 },
  { value: "Cutout", weight: 12 },
  { value: "Double Wash", weight: 10 },
  { value: "Mirror Split", weight: 8 },
];

// Eyes are pressed, pooled, or rested pigment — never a drawn outline of an
// eye. Anatomical sketching reads as cartoon and breaks the wash.
const EYES = [
  { value: "Wet Dabs", weight: 20 },
  { value: "Dot Pair", weight: 18 },
  { value: "Sleepy Lines", weight: 14 },
  { value: "Shadow Pools", weight: 12 },
  { value: "Wide Wells", weight: 10 },
  { value: "Mismatch", weight: 10 },
  { value: "Halfmoon", weight: 8 },
  { value: "Ripples", weight: 8 },
];

const MOUTHS = [
  { value: "Quiet Line", weight: 20 },
  { value: "Wave", weight: 16 },
  { value: "Smirk", weight: 14 },
  { value: "Bloom Blot", weight: 12 },
  { value: "Open O", weight: 10 },
  { value: "Stitch", weight: 10 },
  { value: "Hum", weight: 10 },
  { value: "Tide", weight: 8 },
];

export const OPTIONAL_SLOTS = [
  {
    slot: "Hair", weight: 30,
    colorways: ["ink", "washA", "washMix", "washAccent", "duotone"],
    variants: [
      { value: "Ink Scribble", weight: 24 },
      { value: "Wash Cap", weight: 22 },
      { value: "Twin Tufts", weight: 16 },
      { value: "Curtain", weight: 14 },
      { value: "Flow Mane", weight: 12, anim: "major" },
      { value: "Topknot", weight: 12 },
    ],
  },
  {
    slot: "Brows", weight: 22,
    colorways: ["ink"],
    variants: [
      { value: "Serene", weight: 30 },
      { value: "Worried", weight: 26 },
      { value: "Quizzical", weight: 24 },
      { value: "Heavy", weight: 20 },
    ],
  },
  {
    slot: "Nose", weight: 20,
    colorways: ["ink", "washB"],
    variants: [
      { value: "Hook Line", weight: 30 },
      { value: "Dot", weight: 26 },
      { value: "Long Stroke", weight: 24 },
      { value: "Wash Triangle", weight: 20 },
    ],
  },
  {
    slot: "Freckles", weight: 16,
    colorways: ["ink", "washA", "washMix", "accent"],
    variants: [
      { value: "Scatter", weight: 40 },
      { value: "Dusting", weight: 34 },
      { value: "Constellation", weight: 26 },
    ],
  },
  {
    slot: "Blush", weight: 14,
    colorways: ["washA", "accent", "washAccent"],
    variants: [
      { value: "Soft", weight: 44 },
      { value: "Feverish", weight: 30 },
      { value: "Lopsided", weight: 26 },
    ],
  },
  {
    slot: "Collar", weight: 14,
    colorways: ["washA", "washB", "washMix", "duotone"],
    variants: [
      { value: "Wash Collar", weight: 40 },
      { value: "Stitch Collar", weight: 32 },
      { value: "High Wrap", weight: 28 },
    ],
  },
  {
    slot: "Technique", weight: 12,
    colorways: ["washA", "accent", "washMix"],
    variants: [
      { value: "Salt", weight: 30 },
      { value: "Dry Brush", weight: 28 },
      { value: "Backruns", weight: 24 },
      { value: "Splatter", weight: 18 },
    ],
  },
  {
    slot: "Ears", weight: 12,
    colorways: ["ink", "washB"],
    variants: [
      { value: "Arcs", weight: 40 },
      { value: "Rings", weight: 32, anim: "micro" }, // earrings swing on the boil
      { value: "Drops", weight: 28, anim: "micro" },
    ],
  },
  {
    slot: "Marks", weight: 10,
    colorways: ["ink", "accent"],
    variants: [
      { value: "Third Line", weight: 32 },
      { value: "Hatch Patch", weight: 28 },
      { value: "Underline", weight: 22 },
      { value: "Tear", weight: 18, anim: "micro" },
    ],
  },
  {
    slot: "Headwear", weight: 9,
    colorways: ["washA", "accent", "duotone"],
    variants: [
      { value: "Paper Crown", weight: 36 },
      { value: "Wide Brim", weight: 30 },
      { value: "Pin Feather", weight: 20 },
      { value: "Halo", weight: 14, anim: "major" },
    ],
  },
  {
    slot: "Aura", weight: 4,
    colorways: ["accent", "washMix", "washAccent"],
    variants: [
      { value: "Drift Motes", weight: 40, anim: "major" },
      { value: "Ring Sparks", weight: 34, anim: "major" },
      { value: "Falling Petals", weight: 26, anim: "major" },
    ],
  },
  {
    slot: "Companion", weight: 2,
    colorways: ["ink", "accent", "washAccent"],
    variants: [
      { value: "Blot Bird", weight: 40, anim: "major" },
      { value: "Paper Boat", weight: 34, anim: "major" },
      { value: "Wisp", weight: 26, anim: "major" },
    ],
  },
];

// How many optional slots a token rolls (1..6; with Palette that caps the
// non-base attribute count at the series limit of 7).
const OPTIONAL_COUNT_TABLE = [
  { count: 1, weight: 8 },
  { count: 2, weight: 16 },
  { count: 3, weight: 24 },
  { count: 4, weight: 22 },
  { count: 5, weight: 14 },
  { count: 6, weight: 10 },
];

// ---------------------------------------------------------------------------
// Per-variant structural parameters. Everything a renderer needs beyond the
// variant name rolls here, on the identity stream, so the same seed always
// describes the same person — the paint stream only adds stroke-level wobble.

function faceParams(random, variant) {
  return {
    width: random.range(300, 402),
    aspect: random.range(1.04, 1.3),
    tilt: random.range(-6, 6),
    contourBreaks: random.int(0, 2),
    echo: random.chance(0.42), // ghosted second contour line
    vertices: variant === "Shard" ? random.int(6, 8) : random.int(9, 12),
    irregularity: random.range(0.035, variant === "Cutout" ? 0.13 : 0.075),
    splitOffset: variant === "Mirror Split" ? random.range(8, 22) : 0,
    echoOffset: variant === "Double Wash" ? random.range(14, 30) : 0,
  };
}

function eyeParams(random) {
  return {
    gap: random.range(0.36, 0.5), // fraction of face width
    height: random.range(-0.06, 0.06), // vertical drift from default line
    radius: random.range(13, 21),
    asym: random.range(0.82, 1.18), // right eye scale vs left
    tiltL: random.range(-9, 9),
    tiltR: random.range(-9, 9),
    lashes: random.chance(0.3),
  };
}

function mouthParams(random) {
  return {
    width: random.range(0.2, 0.4), // fraction of face width
    drop: random.range(0.2, 0.31), // below eye line, fraction of face height
    curve: random.range(-0.5, 0.6),
    offCenter: random.range(-0.08, 0.08),
  };
}

function optionalParams(random, slot, variant) {
  switch (slot) {
    case "Hair":
      return {
        strokes: random.int(9, 17),
        length: random.range(0.5, 1.05),
        sway: random.range(0.35, 1),
        side: random.pick(["left", "right", "center"]),
      };
    case "Brows":
      return { lift: random.range(-6, 10), spread: random.range(0.9, 1.2) };
    case "Nose":
      return { length: random.range(26, 52), bend: random.range(-0.4, 0.4) };
    case "Freckles":
      return {
        count: variant === "Dusting" ? random.int(14, 26) : random.int(6, 13),
        spread: random.range(0.5, 0.9),
        linked: variant === "Constellation",
      };
    case "Blush":
      return { size: random.range(20, 40), side: random.pick(["both", "left", "right"]) };
    case "Collar":
      return { rows: random.int(1, 3), lift: random.range(0, 26) };
    case "Technique":
      return { count: random.int(6, 12), scatter: random.range(0.5, 0.85) };
    case "Ears":
      return { size: random.range(14, 26), dangle: random.range(8, 22) };
    case "Marks":
      return { length: random.range(14, 34), side: random.pick(["left", "right"]) };
    case "Headwear":
      return {
        points: random.int(3, 5),
        width: random.range(0.5, 0.85),
        lift: random.range(0, 18),
      };
    case "Aura":
      return { count: random.int(6, 11), orbit: random.range(1.16, 1.4), pace: random.range(0.4, 1) };
    case "Companion":
      return { side: random.pick(["left", "right"]), drop: random.range(-0.1, 0.28), size: random.range(16, 30) };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------

/**
 * Derives the complete, immutable identity of one Watermarks token.
 *
 * @param hexSeed 0x-prefixed hex token seed (any length; padded to 256 bits).
 * @param options `{ background }` overrides the derived background by style
 *   name or index — the hook the contract's background swap uses. The rest of
 *   the identity is untouched by it.
 */
export function deriveIdentity(hexSeed, options = {}) {
  const seed = String(hexSeed);
  const random = makeStream(seed, "identity");

  const palette = weightedPick(random, PALETTES);

  // Background rolls on its own stream: overriding it must not shift traits.
  const backgroundRandom = makeStream(seed, "background");
  const rolledBackground = weightedPick(backgroundRandom, BACKGROUND_STYLES).name;
  let background = { style: rolledBackground, overridden: false };
  if (options.background !== undefined && options.background !== null) {
    const byIndex = BACKGROUND_STYLES[Number(options.background)]?.name;
    const byName = BACKGROUND_STYLES.find(
      (style) => style.name.toLowerCase() === String(options.background).toLowerCase(),
    )?.name;
    const chosen = byName ?? byIndex;
    if (chosen !== undefined) background = { style: chosen, overridden: true };
  }

  const face = weightedPick(random, FACES);
  const eyes = weightedPick(random, EYES);
  const mouth = weightedPick(random, MOUTHS);

  const traits = [
    {
      slot: "Face", variant: face.value,
      colorway: resolveColorway(random, palette, ["washA", "washB", "washMix"]),
      params: faceParams(random, face.value),
    },
    {
      slot: "Eyes", variant: eyes.value,
      colorway: resolveColorway(random, palette, ["ink"]),
      params: eyeParams(random),
    },
    {
      slot: "Mouth", variant: mouth.value,
      colorway: resolveColorway(random, palette, ["ink", "accent"]),
      params: mouthParams(random),
    },
  ];

  // Optional slots: weighted sample without replacement.
  const optionalCount = weightedPick(random, OPTIONAL_COUNT_TABLE.map(
    (entry) => ({ ...entry, value: entry.count }),
  )).count;
  const pool = OPTIONAL_SLOTS.map((slot) => ({ ...slot }));
  for (let picked = 0; picked < optionalCount && pool.length > 0; picked += 1) {
    const slot = weightedPick(random, pool);
    pool.splice(pool.indexOf(slot), 1);
    const variant = weightedPick(random, slot.variants);
    traits.push({
      slot: slot.slot,
      variant: variant.value,
      anim: variant.anim,
      colorway: resolveColorway(random, palette, slot.colorways),
      params: optionalParams(random, slot.slot, variant.value),
    });
  }

  // Portrait-level layout, shared by every renderer pass.
  const layout = {
    cx: random.range(486, 514),
    cy: random.range(450, 492),
    breath: random.range(0.6, 1),
    blinkEvery: random.range(2.6, 6.4), // seconds, nominal
    boilPace: random.pick([4, 5, 6]), // boil ticks per second
  };

  // Every token animates: the boil, blink, breath and gaze ride on the base
  // three. Major animations only join when their trait rolled in.
  const animations = ["boil", "blink", "breath", "gaze"];
  for (const trait of traits) {
    if (trait.anim === "major") animations.push(`${trait.slot}: ${trait.variant}`);
    if (trait.anim === "micro") animations.push(`${trait.slot} sway`);
  }

  // OpenSea-shape attribute list, canonical order: the forced base three,
  // optionals as rolled, palette last. Background is intentionally absent.
  const attributes = [
    { trait_type: "Face", value: face.value },
    { trait_type: "Eyes", value: eyes.value },
    { trait_type: "Mouth", value: mouth.value },
    ...traits.slice(3).map((trait) => ({ trait_type: trait.slot, value: trait.variant })),
    { trait_type: "Palette", value: palette.name },
  ];

  return { seed, palette, background, layout, traits, animations, attributes };
}
