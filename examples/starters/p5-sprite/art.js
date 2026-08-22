// Keel injects these values only after the manifest, viewer, and seed
// commitments verify. Preview mode can provide the same fields manually.
const context = globalThis.__OCA_CONTEXT__ ?? {};
const tokenId = String(context.tokenId ?? "preview");
const seedHex = context.derivedTokenSeed ?? "0x5f3a91c7";
const seed = Number.parseInt(seedHex.slice(-8), 16) >>> 0;

let sheet;
let motes = [];

function preload() {
  // This is another declared, hash-verified manifest resource—not a URL fetch.
  sheet = loadImage("/content/assets/sprite-sheet.svg");
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(Math.min(devicePixelRatio, 2));
  noSmooth();
  randomSeed(seed);
  colorMode(HSL, 360, 100, 100, 1);
  motes = Array.from({ length: 30 + (seed % 45) }, () => ({
    x: random(width), y: random(height), size: random(2, 9), speed: random(0.25, 1.5),
  }));
}

function draw() {
  const hue = seed % 360;
  background(hue, 48, 8, 1);
  noStroke();
  for (const mote of motes) {
    fill((hue + mote.x / 8) % 360, 80, 68, 0.72);
    circle(mote.x, mote.y, mote.size);
    mote.y = (mote.y - mote.speed + height) % height;
  }

  const frame = Math.floor(frameCount / 8) % 4;
  const size = Math.min(width, height) * 0.42;
  image(sheet, width / 2 - size / 2, height / 2 - size / 2, size, size, frame * 32, 0, 32, 32);

  fill(0, 0, 100, 0.9);
  textFont("monospace");
  textSize(14);
  text(`TOKEN #${tokenId} · SEED ${seedHex.slice(-8)}`, 22, height - 24);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
