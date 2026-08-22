// Synthwave flow field — a deterministic p5.js sketch for the Keel demo gallery.
//
// Every value is derived from OCA_SEED, which the manifest pins under
// runtime.determinism. Two viewers resolving the same manifest therefore paint
// the same frames: the artifact is reproducible, not merely re-runnable.

const SEED = (globalThis.OCA_SEED ?? 0x5f3a91c7) >>> 0;
const PARTICLES = 1400;
const GRID = 26;

// xoshiro128** — the algorithm named in runtime.determinism.randomAlgorithm.
function makeRandom(seed) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  let b = (seed ^ 0x85ebca6b) >>> 0;
  let c = (seed ^ 0xc2b2ae35) >>> 0;
  let d = (seed ^ 0x27d4eb2f) >>> 0;
  return function next() {
    const t = (b << 9) >>> 0;
    let r = Math.imul(b, 5);
    r = (((r << 7) | (r >>> 25)) >>> 0) * 9;
    c = (c ^ a) >>> 0;
    d = (d ^ b) >>> 0;
    b = (b ^ c) >>> 0;
    a = (a ^ d) >>> 0;
    c = (c ^ t) >>> 0;
    d = ((d << 11) | (d >>> 21)) >>> 0;
    return ((r >>> 0) % 0x100000000) / 0x100000000;
  };
}

const rand = makeRandom(SEED);
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
        Math.sin(x * 0.29 + SEED * 1e-7) * 1.7 +
        Math.cos(y * 0.31 - SEED * 1.3e-7) * 1.7 +
        Math.sin((x + y) * 0.11) * 0.9;
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
  particle.hue = 290 + rand() * 70;
}

globalThis.setup = function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  colorMode(HSB, 360, 100, 100, 1);
  background(6, 40, 5);
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
  fill(258, 55, 6, 0.09);
  rect(0, 0, width, height);

  for (const particle of particles) {
    const angle = fieldAngle(particle.x, particle.y) + frame * 0.0016;
    const nx = particle.x + Math.cos(angle) * 1.5;
    const ny = particle.y + Math.sin(angle) * 1.5;

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
  stroke(320, 90, 100, 0.85);
  strokeWeight(2);
  line(0, height * 0.72, width, height * 0.72);
  strokeWeight(1.15);
};

globalThis.windowResized = function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildField(width, height);
  background(258, 55, 6);
};
