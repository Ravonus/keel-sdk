// Synthwave flow field — a deterministic p5.js sketch for the Keel demo gallery.
//
// Every value is derived from KEEL_SEED, which the manifest pins under
// runtime.determinism. Two viewers resolving the same manifest therefore paint
// the same frames: the artifact is reproducible, not merely re-runnable.

import { createSeededRandom } from "/content/seeded-random.js";

const CONTEXT_SEED = globalThis.__KEEL_CONTEXT__?.derivedTokenSeed ?? globalThis.KEEL_SEED ?? "0x5f3a91c7";
const SEED_HEX = typeof CONTEXT_SEED === "number"
  ? `0x${(CONTEXT_SEED >>> 0).toString(16).padStart(8, "0")}`
  : String(CONTEXT_SEED);
const SEED = Number.parseInt(SEED_HEX.replace(/^0x/u, "").slice(-8), 16) >>> 0;
const rand = createSeededRandom(SEED_HEX);
const PALETTES = [
  { background: [258, 55, 6], hue: 290, span: 70, horizon: 320 },
  { background: [210, 65, 5], hue: 165, span: 85, horizon: 188 },
  { background: [18, 62, 5], hue: 20, span: 65, horizon: 52 },
  { background: [315, 55, 5], hue: 245, span: 80, horizon: 338 },
];
const PALETTE = PALETTES[SEED % PALETTES.length];
const PARTICLES = 900 + ((SEED >>> 2) % 650);
const GRID = 20 + ((SEED >>> 12) % 15);
const SPEED = 0.9 + ((SEED >>> 8) & 0xff) / 255 * 1.25;
const DRIFT = 0.0007 + ((SEED >>> 16) & 0xff) / 255 * 0.0018;
const FIELD_BEND = 0.72 + ((SEED >>> 24) & 0xff) / 255 * 0.7;
const particles = [];
let field = [];
let cols = 0;
let rows = 0;
let cellSize = 0;
let frame = 0;

function buildField(width, height) {
  cellSize = Math.max(width, height) / GRID;
  cols = Math.ceil(width / cellSize) + 1;
  rows = Math.ceil(height / cellSize) + 1;
  field = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      // Layered sinusoids stand in for Perlin noise so the field stays
      // identical across p5 versions — determinism beats prettiness here.
      const angle =
        Math.sin(x * 0.29 + SEED * 1e-7) * 1.7 * FIELD_BEND +
        Math.cos(y * 0.31 - SEED * 1.3e-7) * 1.7 +
        Math.sin((x + y) * 0.11) * (1.55 - FIELD_BEND * 0.45);
      field[y * cols + x] = angle;
    }
  }
}

function fieldAngle(x, y) {
  const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
  const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
  return field[cy * cols + cx];
}

function respawn(particle, width, height) {
  particle.x = rand() * width;
  particle.y = rand() * height;
  particle.life = 90 + Math.floor(rand() * 210);
  particle.hue = PALETTE.hue + rand() * PALETTE.span;
}

globalThis.setup = function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  colorMode(HSB, 360, 100, 100, 1);
  background(...PALETTE.background);
  buildField(width, height);
  for (let i = 0; i < PARTICLES; i += 1) {
    const particle = { x: 0, y: 0, life: 0, hue: 0 };
    respawn(particle, width, height);
    particles.push(particle);
  }
  strokeWeight(1.15);
};

globalThis.draw = function draw() {
  frame += 1;
  noStroke();
  fill(...PALETTE.background, 0.09);
  rect(0, 0, width, height);

  for (const particle of particles) {
    const angle = fieldAngle(particle.x, particle.y) + frame * DRIFT;
    const nx = particle.x + Math.cos(angle) * SPEED;
    const ny = particle.y + Math.sin(angle) * SPEED;

    stroke(particle.hue, 78, 100, 0.5);
    line(particle.x, particle.y, nx, ny);

    particle.x = nx;
    particle.y = ny;
    particle.life -= 1;

    if (particle.life <= 0 || nx < 0 || ny < 0 || nx > width || ny > height) {
      respawn(particle, width, height);
    }
  }

  // Horizon line — the synthwave cue from the Keel shader notes.
  stroke(PALETTE.horizon, 90, 100, 0.85);
  strokeWeight(2);
  line(0, height * 0.72, width, height * 0.72);
  strokeWeight(1.15);
};

globalThis.windowResized = function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildField(width, height);
  background(...PALETTE.background);
};
