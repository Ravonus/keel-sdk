import {
  generateProceduralLayerAtlases,
  parseProceduralSpriteRig,
  proceduralFrameAt,
  sidearmCompositeOrder,
} from "/content/procedural-sprite-rig.js";

const canvas = document.querySelector("#game");
const context = canvas.getContext("2d", { alpha: false });
const stats = document.querySelector("#stats");
const characterLabel = document.querySelector("#character");
const mapLabel = document.querySelector("#map");
const boot = document.querySelector("#boot");
const damage = document.querySelector("#damage");
const keys = new Set();
const pointer = { x: canvas.width / 2, y: canvas.height / 2, down: false };

function contentBlob(id, type) {
  const bytes = globalThis.__KEEL_CONTENT__.bytes(id);
  return new Blob([bytes], { type });
}

function hash32(value) {
  let result = 0x811c9dc5;
  for (const character of String(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 0x01000193);
  }
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  return result >>> 0;
}

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const runtime = globalThis.__KEEL_RUNTIME__;
const characterRecipe = runtime?.context ?? {};
const mapSeed =
  characterRecipe.mapSeed ??
  characterRecipe.derivedTokenSeed ??
  runtime?.manifestDigest ??
  "vault-arcade-default-map";
const characterRuntimeSeed = runtime?.context?.mapCharacterSeed ?? characterRecipe.derivedTokenSeed ?? mapSeed;
const packedAttributes = /^0x[0-9a-f]{64}$/i.test(characterRecipe.packedAttributes ?? "")
  ? characterRecipe.packedAttributes.slice(2).toLowerCase()
  : undefined;
const weaponAssetId = /^0x[0-9a-f]{64}$/i.test(characterRecipe.assetId ?? "")
  ? characterRecipe.assetId.toLowerCase()
  : "unbound-weapon";
function recipeByte(index) {
  if (!packedAttributes) return undefined;
  const offset = packedAttributes.length - (index + 1) * 2;
  return Number.parseInt(packedAttributes.slice(offset, offset + 2), 16);
}
document.documentElement.dataset.runtimeRecipe = packedAttributes ? "staked-onchain" : "fallback";
document.documentElement.dataset.weaponAssetId = weaponAssetId;
document.documentElement.dataset.assetFamilyRevision = String(characterRecipe.assetFamilyRevision ?? 0);
const mapRevision = 1;
let characterAtlas;
let characterLayers;
let characterAnimationRig;
let tileAtlas;
let tintAtlas;
let characterMaterials;
let traitCatalog;
let started = false;
let lastTime = performance.now();
let wave = 1;
let score = 0;
let attackCooldown = 0;
let spawnCooldown = 0;
const player = {
  x: 480,
  y: 270,
  radius: 19,
  health: 100,
  facing: 0,
  invulnerable: 0,
  actionStartedAt: Number.NEGATIVE_INFINITY,
};
let enemies = [];
let bolts = [];
let pickups = [];
const materialCellCache = new Map();
const materialImageIds = new WeakMap();
let nextMaterialImageId = 1;

function materialImageId(image) {
  let id = materialImageIds.get(image);
  if (id !== undefined) return id;
  id = nextMaterialImageId;
  nextMaterialImageId += 1;
  materialImageIds.set(image, id);
  return id;
}

function codecReader(bytes) {
  let offset = 0;
  return {
    byte() {
      const value = bytes[offset++];
      if (value === undefined)
        throw new Error("Unexpected end of material codec.");
      return value;
    },
    varUint() {
      let value = 0;
      let factor = 1;
      for (let index = 0; index < 5; index += 1) {
        const byte = this.byte();
        value += (byte & 0x7f) * factor;
        if ((byte & 0x80) === 0) return value;
        factor *= 128;
      }
      throw new Error("Invalid material codec varuint.");
    },
    rgb() {
      return [this.byte(), this.byte(), this.byte()];
    },
    done() {
      return offset === bytes.length;
    },
  };
}

function decodeMaterialProfile(bytes) {
  const reader = codecReader(bytes);
  if ([0x4f, 0x43, 0x4d, 0x50].some((value) => reader.byte() !== value))
    throw new Error("Invalid material codec magic.");
  if (reader.byte() !== 1 || reader.byte() !== 0)
    throw new Error("Unsupported material codec version.");
  const profile = {
    setId: reader.varUint(),
    setWeight: reader.varUint(),
    regions: [],
  };
  const regionCount = reader.varUint();
  if (regionCount < 1 || regionCount > 64)
    throw new Error("Invalid material region count.");
  for (let index = 0; index < regionCount; index += 1) {
    const regionId = reader.varUint();
    const weight = reader.varUint();
    const mode = reader.byte();
    let rule;
    if (mode === 0) rule = { mode: "locked", color: reader.rgb() };
    else if (mode === 1) {
      const count = reader.varUint();
      const colors = Array.from({ length: count }, () => ({
        color: reader.rgb(),
        weight: reader.varUint(),
      }));
      rule = { mode: "palette", colors };
    } else if (mode === 2)
      rule = {
        mode: "ramp",
        colors: [reader.rgb(), reader.rgb(), reader.rgb()],
      };
    else if (mode === 3) {
      rule = {
        mode: "range",
        hue: [reader.varUint(), reader.varUint()],
        saturation: [reader.byte(), reader.byte()],
        lightness: [reader.byte(), reader.byte()],
        darken: reader.byte(),
        lighten: reader.byte(),
      };
    } else throw new Error("Unsupported material region mode.");
    profile.regions.push({ regionId, weight, rule });
  }
  if (!reader.done()) throw new Error("Trailing material codec bytes.");
  return profile;
}

function decodeTraitCatalogHeader(bytes) {
  const reader = codecReader(bytes);
  if ([0x4f, 0x43, 0x54, 0x52].some((value) => reader.byte() !== value))
    throw new Error("Invalid trait codec magic.");
  if (reader.byte() !== 2) throw new Error("Unsupported trait codec version.");
  const flags = reader.byte();
  if ((flags & ~1) !== 0) throw new Error("Unsupported trait codec flags.");
  const revision = reader.varUint();
  const attributeCount = reader.varUint();
  let combinations = 1n;
  for (let attribute = 0; attribute < attributeCount; attribute += 1) {
    reader.varUint();
    const attributeFlags = reader.byte();
    if ((attributeFlags & ~3) !== 0)
      throw new Error("Unsupported trait attribute flags.");
    if ((attributeFlags & 2) !== 0) reader.byte();
    const optionCount = reader.varUint();
    combinations *= BigInt(optionCount);
    for (let option = 0; option < optionCount; option += 1) {
      reader.varUint();
      reader.varUint();
      reader.varUint();
    }
  }
  if (!reader.done()) throw new Error("Trailing trait codec bytes.");
  return {
    revision,
    attributeCount,
    combinations,
    rejectExactDuplicates: (flags & 1) !== 0,
  };
}

function hslRgb(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const position = hue / 60;
  const x = chroma * (1 - Math.abs((position % 2) - 1));
  const color =
    position < 1
      ? [chroma, x, 0]
      : position < 2
        ? [x, chroma, 0]
        : position < 3
          ? [0, chroma, x]
          : position < 4
            ? [0, x, chroma]
            : position < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = l - chroma / 2;
  return color.map((channel) => Math.round((channel + match) * 255));
}

function boundedSeed(range, domain) {
  const committedByte = recipeByte(hash32(domain) % 32);
  return (
    range[0] +
    ((committedByte ?? hash32(`${characterRuntimeSeed}:material:${domain}`)) % (range[1] - range[0] + 1))
  );
}

function resolveMaterialRegion(profile, regionId, domain) {
  const region =
    profile.regions.find((candidate) => candidate.regionId === regionId) ??
    profile.regions[0];
  const rule = region.rule;
  if (rule.mode === "locked") return [rule.color, rule.color, rule.color];
  if (rule.mode === "ramp") return rule.colors;
  if (rule.mode === "palette") {
    const total = rule.colors.reduce((sum, item) => sum + item.weight, 0);
    let selected = hash32(`${characterRuntimeSeed}:palette:${domain}`) % total;
    const item =
      rule.colors.find((candidate) => (selected -= candidate.weight) < 0) ??
      rule.colors.at(-1);
    return [
      item.color.map((value) => Math.round(value * 0.35)),
      item.color,
      item.color.map((value) => Math.min(255, Math.round(value * 1.45))),
    ];
  }
  const hue = boundedSeed(rule.hue, `${domain}:h`);
  const saturation = boundedSeed(rule.saturation, `${domain}:s`);
  const lightness = boundedSeed(rule.lightness, `${domain}:l`);
  return [
    hslRgb(hue, saturation, Math.max(0, lightness - rule.darken)),
    hslRgb(hue, saturation, lightness),
    hslRgb(hue, saturation, Math.min(100, lightness + rule.lighten)),
  ];
}

function selectMaterialProfile(profiles) {
  const total = profiles.reduce((sum, profile) => sum + profile.setWeight, 0);
  let selected = (recipeByte(5) ?? hash32(`${characterRuntimeSeed}:material-set`)) % total;
  return (
    profiles.find((profile) => (selected -= profile.setWeight) < 0) ??
    profiles.at(-1)
  );
}

function waveRandom(waveNumber) {
  return random(hash32(`${mapSeed}:${mapRevision}:${waveNumber}`));
}

function loadWave(waveNumber) {
  const rng = waveRandom(waveNumber);
  enemies = [];
  pickups = [];
  const count = Math.min(7 + waveNumber * 2, 46);
  for (let index = 0; index < count; index += 1) {
    const side = Math.floor(rng() * 4);
    const along = 50 + rng() * (side % 2 === 0 ? 860 : 440);
    const position =
      side === 0
        ? [along, 36]
        : side === 1
          ? [924, along]
          : side === 2
            ? [along, 504]
            : [36, along];
    enemies.push({
      x: position[0],
      y: position[1],
      radius: 12 + rng() * 7,
      speed: 28 + Math.min(waveNumber * 1.8, 70) + rng() * 18,
      health: 1 + Math.floor((waveNumber - 1) / 4),
      phase: rng() * Math.PI * 2,
      hue: rng() > 0.5 ? 188 : 309,
    });
  }
  mapLabel.innerHTML = `DEFAULT VAULT<br>MAP r${mapRevision} · WAVE SEED ${hash32(`${mapSeed}:${mapRevision}:${waveNumber}`).toString(16).padStart(8, "0")}`;
  document.documentElement.dataset.waveSeed = String(
    hash32(`${mapSeed}:${mapRevision}:${waveNumber}`),
  );
}

function directionIndex(dx, dy) {
  if (dx === 0 && dy === 0) return player.facing;
  const angle = Math.atan2(dy, dx);
  const eastClockwise = Math.round(angle / (Math.PI / 4) + 8) % 8;
  return [6, 7, 0, 1, 2, 3, 4, 5][eastClockwise];
}

function drawAtlasCell(
  image,
  column,
  row,
  x,
  y,
  size,
  columns = 8,
  rows = 8,
  alpha = 1,
) {
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    x - size / 2,
    y - size / 2,
    size,
    size,
  );
  context.restore();
}

function drawTintedCell(image, column, row, x, y, size, tint) {
  const buffer = document.createElement("canvas");
  buffer.width = buffer.height = 128;
  const bufferContext = buffer.getContext("2d");
  const cellWidth = image.width / 8;
  const cellHeight = image.height / 6;
  bufferContext.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    0,
    0,
    128,
    128,
  );
  bufferContext.globalCompositeOperation = "source-atop";
  bufferContext.fillStyle = tint;
  bufferContext.fillRect(0, 0, 128, 128);
  context.drawImage(buffer, x - size / 2, y - size / 2, size, size);
}

function drawTintedAtlasCell(
  image,
  column,
  row,
  x,
  y,
  size,
  tint,
  columns,
  rows,
) {
  const buffer = document.createElement("canvas");
  buffer.width = buffer.height = 128;
  const bufferContext = buffer.getContext("2d");
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  bufferContext.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    0,
    0,
    128,
    128,
  );
  bufferContext.globalCompositeOperation = "source-atop";
  bufferContext.fillStyle = tint;
  bufferContext.fillRect(0, 0, 128, 128);
  context.drawImage(buffer, x - size / 2, y - size / 2, size, size);
}

function mixColor(left, right, amount) {
  return left.map((value, index) =>
    Math.round(value + (right[index] - value) * amount),
  );
}

function materialRampCell(image, column, row, ramp, columns, rows) {
  const key = `${materialImageId(image)}:${column}:${row}:${ramp.flat().join(",")}`;
  const cached = materialCellCache.get(key);
  if (cached) return cached;
  const buffer = document.createElement("canvas");
  buffer.width = buffer.height = 168;
  const bufferContext = buffer.getContext("2d", { willReadFrequently: true });
  const cellWidth = image.width / columns;
  const cellHeight = image.height / rows;
  bufferContext.drawImage(
    image,
    column * cellWidth,
    row * cellHeight,
    cellWidth,
    cellHeight,
    0,
    0,
    168,
    168,
  );
  const pixels = bufferContext.getImageData(0, 0, 168, 168);
  const [dark, mid, light] = ramp;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    if (pixels.data[offset + 3] === 0) continue;
    const red = pixels.data[offset];
    const green = pixels.data[offset + 1];
    const blue = pixels.data[offset + 2];
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    // Saturated source pixels are authored accents and remain completely fixed.
    if (chroma > 46) continue;
    const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    const mapped =
      luminance < 0.5
        ? mixColor(dark, mid, luminance * 2)
        : mixColor(mid, light, (luminance - 0.5) * 2);
    pixels.data[offset] = mapped[0];
    pixels.data[offset + 1] = mapped[1];
    pixels.data[offset + 2] = mapped[2];
  }
  bufferContext.putImageData(pixels, 0, 0);
  materialCellCache.set(key, buffer);
  return buffer;
}

function drawMaterialRampCell(
  image,
  column,
  row,
  x,
  y,
  size,
  ramp,
  columns,
  rows,
) {
  context.drawImage(
    materialRampCell(image, column, row, ramp, columns, rows),
    x - size / 2,
    y - size / 2,
    size,
    size,
  );
}

function fire() {
  if (attackCooldown > 0) return;
  const attackProfile = recipeByte(9) ?? hash32(weaponAssetId);
  attackCooldown = 0.13 + (attackProfile % 5) * 0.015;
  player.actionStartedAt = performance.now();
  const dx = pointer.x - player.x;
  const dy = pointer.y - player.y;
  const length = Math.hypot(dx, dy) || 1;
  player.facing = directionIndex(dx, dy);
  bolts.push({
    x: player.x,
    y: player.y,
    vx: (dx / length) * (520 + (attackProfile % 7) * 12),
    vy: (dy / length) * (520 + (attackProfile % 7) * 12),
    life: 0.8,
    hue: hash32(weaponAssetId) % 360,
  });
}

function update(delta) {
  let dx = 0;
  let dy = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) dy -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) dy += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) dx -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) dx += 1;
  if (dx !== 0 || dy !== 0) {
    const length = Math.hypot(dx, dy);
    dx /= length;
    dy /= length;
    player.x = Math.max(32, Math.min(928, player.x + dx * 210 * delta));
    player.y = Math.max(32, Math.min(508, player.y + dy * 210 * delta));
    player.facing = directionIndex(dx, dy);
  }
  if (pointer.down || keys.has("Space")) fire();
  attackCooldown -= delta;
  spawnCooldown -= delta;
  player.invulnerable -= delta;

  for (const bolt of bolts) {
    bolt.x += bolt.vx * delta;
    bolt.y += bolt.vy * delta;
    bolt.life -= delta;
  }
  bolts = bolts.filter(
    (bolt) =>
      bolt.life > 0 && bolt.x > 0 && bolt.x < 960 && bolt.y > 0 && bolt.y < 540,
  );

  for (const enemy of enemies) {
    const dxToPlayer = player.x - enemy.x;
    const dyToPlayer = player.y - enemy.y;
    const distance = Math.hypot(dxToPlayer, dyToPlayer) || 1;
    enemy.x += (dxToPlayer / distance) * enemy.speed * delta;
    enemy.y += (dyToPlayer / distance) * enemy.speed * delta;
    enemy.phase += delta * 4;
    if (distance < player.radius + enemy.radius && player.invulnerable <= 0) {
      player.health = Math.max(0, player.health - 12);
      player.invulnerable = 0.65;
      damage.classList.add("hit");
      setTimeout(() => damage.classList.remove("hit"), 120);
    }
  }
  for (const bolt of bolts) {
    for (const enemy of enemies) {
      if (enemy.health <= 0) continue;
      if (Math.hypot(bolt.x - enemy.x, bolt.y - enemy.y) < enemy.radius + 6) {
        enemy.health -= 1;
        bolt.life = 0;
        if (enemy.health <= 0) {
          score += 100 * wave;
          if (hash32(`${mapSeed}:${wave}:${score}`) % 7 === 0)
            pickups.push({ x: enemy.x, y: enemy.y, life: 8 });
        }
      }
    }
  }
  enemies = enemies.filter((enemy) => enemy.health > 0);
  for (const pickup of pickups) {
    pickup.life -= delta;
    if (Math.hypot(pickup.x - player.x, pickup.y - player.y) < 28) {
      player.health = Math.min(100, player.health + 18);
      pickup.life = 0;
      score += 25;
    }
  }
  pickups = pickups.filter((pickup) => pickup.life > 0);

  if (enemies.length === 0 && spawnCooldown <= 0) {
    wave += 1;
    score += 500 * wave;
    spawnCooldown = 0.9;
    loadWave(wave);
  }
  if (player.health <= 0) {
    document.documentElement.dataset.runEnded = "true";
    started = false;
    boot.hidden = false;
    boot.querySelector("button").textContent =
      `RUN ENDED · SCORE ${score} · RETRY`;
  }
}

function drawFloor(time) {
  context.fillStyle = "#070812";
  context.fillRect(0, 0, 960, 540);
  const rng = waveRandom(wave);
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 11; x += 1) {
      const tile = Math.floor(rng() * 4);
      drawAtlasCell(
        tileAtlas,
        tile,
        0,
        x * 96 + 4,
        y * 96 + 4,
        108,
        8,
        6,
        0.25,
      );
    }
  }
  const glow = context.createRadialGradient(
    player.x,
    player.y,
    20,
    player.x,
    player.y,
    270,
  );
  glow.addColorStop(0, "#7ce7c41c");
  glow.addColorStop(1, "#0000");
  context.fillStyle = glow;
  context.fillRect(0, 0, 960, 540);
  context.strokeStyle = `hsla(${190 + Math.sin(time / 900) * 20} 90% 62% / .25)`;
  context.strokeRect(18, 18, 924, 504);
}

function draw(time) {
  drawFloor(time);
  for (const pickup of pickups) {
    drawAtlasCell(tileAtlas, 4, 3, pickup.x, pickup.y, 36, 8, 6, 0.9);
  }
  for (const enemy of enemies) {
    context.beginPath();
    context.fillStyle = `hsla(${enemy.hue} 90% 58% / .18)`;
    context.arc(
      enemy.x,
      enemy.y,
      enemy.radius + 8 + Math.sin(enemy.phase) * 3,
      0,
      Math.PI * 2,
    );
    context.fill();
    drawTintedCell(
      tintAtlas,
      Math.floor(enemy.phase) % 8,
      4,
      enemy.x,
      enemy.y,
      enemy.radius * 3.4,
      enemy.hue === 188 ? "#38d9ff" : "#ff48d7",
    );
  }
  for (const bolt of bolts) {
    context.fillStyle = `hsl(${bolt.hue} 92% 78%)`;
    context.beginPath();
    context.arc(bolt.x, bolt.y, 5, 0, Math.PI * 2);
    context.fill();
  }

  const characterHash = hash32(`${characterRuntimeSeed}:starter-character`);
  const materials = characterMaterials;
  const actionFrame = proceduralFrameAt(
    time - player.actionStartedAt,
    characterAnimationRig,
  );
  const layer = (id) => {
    const image = characterLayers.get(id);
    if (!image) throw new Error(`Missing generated character layer ${id}.`);
    return image;
  };
  const armOrder = sidearmCompositeOrder(player.facing);
  document.documentElement.dataset.sidearmFrame = String(actionFrame);
  document.documentElement.dataset.sidearmPhase =
    characterAnimationRig.phases[actionFrame];
  document.documentElement.dataset.sidearmCompositeOrder = armOrder.join(",");
  const blink = player.invulnerable > 0 && Math.floor(time / 60) % 2 ? 0.35 : 1;
  context.save();
  context.globalAlpha = blink;
  // Background equipment passes (capes, wings, back-mounted weapons) render
  // before the body. A production definition may also provide a separately
  // committed foreground pass for collars, clasps, and shoulder overlap.
  drawMaterialRampCell(
    layer("addon-three"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    materials.cape,
    characterAnimationRig.frames,
    8,
  );
  drawAtlasCell(
    layer("body"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    characterAnimationRig.frames,
    8,
  );
  drawMaterialRampCell(
    layer("legs"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    materials.legs,
    characterAnimationRig.frames,
    8,
  );
  drawMaterialRampCell(
    layer("shirt"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    materials.shirt,
    characterAnimationRig.frames,
    8,
  );
  drawAtlasCell(
    layer("hair-head"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    characterAnimationRig.frames,
    8,
  );
  drawAtlasCell(
    layer("face"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    characterAnimationRig.frames,
    8,
  );
  drawAtlasCell(
    layer("addon-one"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    characterAnimationRig.frames,
    8,
    0.72,
  );
  drawAtlasCell(
    layer("addon-two"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    characterAnimationRig.frames,
    8,
    0.62,
  );
  drawAtlasCell(
    layer("weapon"),
    actionFrame,
    player.facing,
    player.x,
    player.y,
    88,
    characterAnimationRig.frames,
    8,
    attackCooldown > 0.08 ? 1 : 0.82,
  );
  context.restore();
  stats.textContent = `WAVE ${wave} · SCORE ${score.toLocaleString()} · HP ${player.health}`;
}

function frame(time) {
  const delta = Math.min((time - lastTime) / 1000, 0.04);
  lastTime = time;
  if (started) update(delta);
  draw(time);
  requestAnimationFrame(frame);
}

function canvasCoordinates(event) {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) * canvas.width) / bounds.width;
  pointer.y = ((event.clientY - bounds.top) * canvas.height) / bounds.height;
}

window.addEventListener("keydown", (event) => {
  if (
    [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Space",
    ].includes(event.code)
  ) {
    event.preventDefault();
    keys.add(event.code);
  }
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => keys.clear());
canvas.addEventListener("pointermove", canvasCoordinates);
canvas.addEventListener("pointerdown", (event) => {
  canvasCoordinates(event);
  pointer.down = true;
  canvas.focus();
});
window.addEventListener("pointerup", () => {
  pointer.down = false;
});

document.querySelector("#start").addEventListener("click", () => {
  wave = 1;
  score = 0;
  player.health = 100;
  player.x = 480;
  player.y = 270;
  loadWave(wave);
  started = true;
  boot.hidden = true;
  canvas.focus();
  document.documentElement.dataset.gameStarted = "true";
});

async function main() {
  const [
    character,
    tiles,
    tintable,
    catalogBytes,
    rigBytes,
    ...materialProfiles
  ] = await Promise.all([
    createImageBitmap(
      contentBlob("character-parts-eight-direction-168.webp", "image/webp"),
    ),
    createImageBitmap(contentBlob("vault-tiles.webp", "image/webp")),
    createImageBitmap(contentBlob("tintable-kit.webp", "image/webp")),
    Promise.resolve(globalThis.__KEEL_CONTENT__.bytes("character-catalog.octr")),
    Promise.resolve(globalThis.__KEEL_CONTENT__.bytes("sidearm-still-rig.json")),
    ...[0, 1, 2, 3].map((id) =>
      Promise.resolve(
        decodeMaterialProfile(
          globalThis.__KEEL_CONTENT__.bytes(`character-material-${id}.ocmp`),
        ),
      ),
    ),
  ]);
  characterAtlas = character;
  characterAnimationRig = parseProceduralSpriteRig(rigBytes);
  characterLayers = generateProceduralLayerAtlases(
    characterAtlas,
    characterAnimationRig,
    {
      directions: 8,
      sourceColumns: 8,
      sourceRows: 9,
    },
  );
  tileAtlas = tiles;
  tintAtlas = tintable;
  traitCatalog = decodeTraitCatalogHeader(catalogBytes);
  const selectedMaterial = selectMaterialProfile(materialProfiles);
  characterMaterials = {
    legs: resolveMaterialRegion(selectedMaterial, 1, "legs"),
    shirt: resolveMaterialRegion(selectedMaterial, 2, "shirt"),
    cape: resolveMaterialRegion(selectedMaterial, 1, "cape"),
  };
  document.documentElement.dataset.materialSet = String(selectedMaterial.setId);
  document.documentElement.dataset.catalogRevision = String(
    traitCatalog.revision,
  );
  document.documentElement.dataset.attributeCount = String(
    traitCatalog.attributeCount,
  );
  document.documentElement.dataset.proceduralSpriteRig =
    characterAnimationRig.id;
  document.documentElement.dataset.proceduralSpriteFrames = String(
    characterAnimationRig.frames,
  );
  document.documentElement.dataset.proceduralSpriteSource =
    "directional-stills";
  document.documentElement.dataset.characterFingerprint = hash32(
    `${characterRuntimeSeed}:character:${traitCatalog.revision}:${selectedMaterial.setId}`,
  )
    .toString(16)
    .padStart(8, "0");
  characterLabel.textContent = `CHARACTER ${document.documentElement.dataset.characterFingerprint} · CATALOG r${characterRecipe.catalogRevision ?? traitCatalog.revision} · FAMILY r${characterRecipe.assetFamilyRevision ?? 0} · ASSET ${weaponAssetId.slice(0, 10)} · ${traitCatalog.attributeCount} ATTR · MATERIAL SET ${selectedMaterial.setId} · ${traitCatalog.rejectExactDuplicates ? "NO EXACT DUPES" : "DUPES ALLOWED"}`;
  loadWave(1);
  document.documentElement.dataset.gameReady = "true";
  document.documentElement.dataset.mapMode = "endless-deterministic-waves";
  requestAnimationFrame(frame);
}

main().catch((error) => {
  boot.hidden = false;
  boot.querySelector("p").textContent =
    `Failed: ${error instanceof Error ? error.message : String(error)}`;
  document.documentElement.dataset.gameReady = "false";
});
