// Sprite Forge now uses the reusable Keel reader rather than stretching whole
// 128x16 strips over a fullscreen quad. Each verified layer is cropped to the
// same 16x16 atlas frame, tinted independently, and advanced at a target FPS.

import {
  createSpritePlayer,
  decodeSpriteBitAtlas,
} from "/content/oca-readers.js";

const LAYERS = [
  { resourceId: "body.webp", hue: 222, opacity: 1 },
  { resourceId: "legs.webp", hue: 252, opacity: 1 },
  { resourceId: "shirt.webp", hue: 326, opacity: 1 },
  { resourceId: "hair.webp", hue: 24, opacity: 1 },
  { resourceId: "gun.webp", hue: 188, opacity: 1 },
];

const canvas = document.getElementById("stage");
const status = document.getElementById("status");
const frameLabel = document.getElementById("frame");
const fpsInput = document.getElementById("fps");
const playButton = document.getElementById("play");

function seedFromRuntime() {
  const value = globalThis.__KEEL_RUNTIME__?.context?.derivedTokenSeed ??
    globalThis.__KEEL_RUNTIME__?.manifestDigest ??
    "oca-sprite-forge";
  let seed = 0x811c9dc5;
  for (const character of String(value)) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 0x01000193);
  }
  return seed >>> 0;
}

function palette(seed) {
  return LAYERS.map((layer, index) => {
    const offset = ((seed >>> ((index % 4) * 8)) & 31) - 16;
    return {
      resourceId: layer.resourceId,
      tint: `hsl(${(layer.hue + offset + 360) % 360} 82% ${index === 0 ? 62 : 56}%)`,
      opacity: layer.opacity,
    };
  });
}

function updateControls(player) {
  frameLabel.textContent = `frame ${player.frameIndex + 1}/${player.frameCount}`;
  playButton.textContent = player.playing ? "Pause" : "Play";
  canvas.dataset.spriteFrame = String(player.frameIndex);
  document.documentElement.dataset.spriteFrame = String(player.frameIndex);
  document.documentElement.dataset.spritePlaying = String(player.playing);
}

async function main() {
  const atlasBytes = globalThis.__KEEL_CONTENT__.bytes("atlas.ocaa");
  const atlas = decodeSpriteBitAtlas(atlasBytes);
  const player = createSpritePlayer({
    content: globalThis.__KEEL_CONTENT__,
    canvas,
    atlas,
    layers: palette(seedFromRuntime()),
    scale: 14,
    fps: Number(fpsInput.value),
  });
  await player.load();
  player.play();

  document.getElementById("previous").addEventListener("click", () => {
    player.pause();
    player.previous();
    updateControls(player);
  });
  document.getElementById("next").addEventListener("click", () => {
    player.pause();
    player.next();
    updateControls(player);
  });
  playButton.addEventListener("click", () => {
    if (player.playing) player.pause();
    else player.play();
    updateControls(player);
  });
  fpsInput.addEventListener("input", () => {
    player.setFps(Number(fpsInput.value));
    document.getElementById("fps-value").textContent = `${fpsInput.value} fps`;
    document.documentElement.dataset.spriteFps = fpsInput.value;
  });

  const sourceBytes = LAYERS.reduce(
    (total, layer) => total + globalThis.__KEEL_CONTENT__.bytes(layer.resourceId).byteLength,
    0,
  );
  status.textContent =
    `${LAYERS.length} verified WebP layers · ${atlas.frames.length} real 16×16 frames · ` +
    `${atlasBytes.byteLength}B bit atlas · ${sourceBytes}B art`;
  document.documentElement.dataset.spriteReady = "true";
  document.documentElement.dataset.spriteFrames = String(atlas.frames.length);
  document.documentElement.dataset.spriteAtlasBytes = String(atlasBytes.byteLength);
  updateControls(player);

  const observe = () => {
    updateControls(player);
    requestAnimationFrame(observe);
  };
  requestAnimationFrame(observe);
}

main().catch((error) => {
  document.documentElement.dataset.spriteReady = "false";
  status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
});

