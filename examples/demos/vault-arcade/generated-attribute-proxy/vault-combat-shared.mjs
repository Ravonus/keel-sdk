export const VAULT_MOB_ATTRIBUTE_LAYERS = Object.freeze([
  "body-primary", "body-secondary", "trim", "core-light", "floaters", "weapon-fx",
]);

export const VAULT_MOB_ABILITIES = Object.freeze([
  "bullets", "needles", "laser", "aoe", "homer", "exploder", "blink", "rush",
]);

export const VAULT_MOB_ABILITY_RULES = Object.freeze({
  bullets: Object.freeze({ mode: "projectile", count: 3, spread: .16, speed: 250, damageScale: 1 }),
  needles: Object.freeze({ mode: "projectile", count: 3, spread: .08, speed: 390, damageScale: .72 }),
  laser: Object.freeze({ mode: "projectile", count: 1, spread: 0, speed: 560, damageScale: 1.2 }),
  aoe: Object.freeze({ mode: "area", radius: 185, damageScale: 1.25 }),
  homer: Object.freeze({ mode: "projectile", count: 1, spread: 0, speed: 175, damageScale: 1.1, homing: .075 }),
  exploder: Object.freeze({ mode: "projectile", count: 1, spread: 0, speed: 145, damageScale: 1.7, explosionRadius: 145 }),
  blink: Object.freeze({ mode: "movement", distance: 125 }),
  rush: Object.freeze({ mode: "movement", durationMs: 620, speedScale: 2.8 }),
});

export const VAULT_PLAYER_COMBAT_RULES = Object.freeze({
  boost: Object.freeze({ energyPerSecond: 27, speedScale: 1.58 }),
  block: Object.freeze({ energyPerSecond: 42, damageScale: .22 }),
  energy: Object.freeze({ maximum: 100, recoveryPerSecond: 19, bustLockoutMs: 1000 }),
  blink: Object.freeze({ id: "phase-blink", distance: 150, cooldownMs: 3600 }),
  pulse: Object.freeze({ id: "core-flare", radius: 260, arcDegrees: 76, damage: 42, cooldownMs: 7800 }),
  charge: Object.freeze({ holdMs: 440, minimumEnergy: 15, maximumEnergy: 40 }),
});

export const VAULT_ESCAPE_STYLES = Object.freeze([
  Object.freeze({ id: "phase-blink", name: "Phase Blink", direction: "forward", effect: "streak", distance: 180, cooldownMs: 3600, invulnerableMs: 390 }),
  Object.freeze({ id: "afterimage-dash", name: "Afterimage Dash", direction: "forward", effect: "afterimages", distance: 245, cooldownMs: 4200, invulnerableMs: 470 }),
  Object.freeze({ id: "backstep", name: "Backstep", direction: "backward", effect: "afterimages", distance: 145, cooldownMs: 2500, invulnerableMs: 320 }),
  Object.freeze({ id: "orbit-step", name: "Orbit Step", direction: "lateral", effect: "arc", distance: 170, cooldownMs: 3000, invulnerableMs: 370 }),
]);

export function selectVaultEscapeStyle(entropy = 0) {
  return VAULT_ESCAPE_STYLES[Math.abs(Math.floor(Number(entropy) || 0)) % VAULT_ESCAPE_STYLES.length];
}

export function resolveVaultEscapeVector({ moveX = 0, moveY = 0, velocityX = 0, velocityY = 0, aimX = 1, aimY = 0, style = VAULT_ESCAPE_STYLES[0], side = 1 } = {}) {
  let x = Number(moveX) || 0;
  let y = Number(moveY) || 0;
  let source = "movement";
  if (Math.hypot(x, y) < .08) {
    x = Number(velocityX) || 0;
    y = Number(velocityY) || 0;
    source = "velocity";
  }
  if (Math.hypot(x, y) < .08) {
    x = Number(aimX) || 1;
    y = Number(aimY) || 0;
    source = "aim";
  }
  const length = Math.hypot(x, y) || 1;
  x /= length;
  y /= length;
  if (style.direction === "backward") {
    x = -x;
    y = -y;
  } else if (style.direction === "lateral") {
    const direction = Number(side) < 0 ? -1 : 1;
    [x, y] = [-y * direction, x * direction];
  }
  return Object.freeze({ x, y, source });
}

export const VAULT_SHOWCASE_MOB_ARCHETYPES = Object.freeze([
  Object.freeze({ id: "drifter", label: "Drifter", behavior: "chase", radius: 18, speed: 68, health: 23, contact: 7 }),
  Object.freeze({ id: "wisp", label: "Signal Wisp", behavior: "shooter", radius: 19, speed: 58, health: 18, contact: 6 }),
  Object.freeze({ id: "bulwark", label: "Bulwark", behavior: "tank", radius: 27, speed: 35, health: 57, contact: 13 }),
]);

export const VAULT_WEAPON_COMBAT_RULES = Object.freeze({
  gyro: Object.freeze({ longRange: Object.freeze({ mode: "launch-recall", damage: 23, speed: 430, cooldownMs: 685, radius: 14, pierce: 12, returnDelayMs: 900, returnSpeedScale: 1.15 }), charge: Object.freeze({ mode: "overdrive-disc", minimumMs: 420, maximumMs: 1450, damage: 75, speed: 370, radius: 23, cooldownMs: 2900, pierce: 24, returnDelayMs: 1150, returnSpeedScale: 1.3 }) }),
  rift: Object.freeze({ longRange: Object.freeze({ mode: "pierce", damage: 19, speed: 690, cooldownMs: 505, radius: 5, pierce: 3 }), charge: Object.freeze({ mode: "singularity-lance", minimumMs: 480, maximumMs: 1550, damage: 87, speed: 830, radius: 12, cooldownMs: 3125, pierce: 5 }) }),
  bloom: Object.freeze({ longRange: Object.freeze({ mode: "six-node-burst", damage: 11, speed: 475, cooldownMs: 930, radius: 5, pierce: 1, count: 6, spread: .16 }), charge: Object.freeze({ mode: "stellar-bloom", minimumMs: 520, maximumMs: 1650, damage: 32, speed: 425, radius: 9, cooldownMs: 3450, pierce: 2, count: 6, spread: .16 }) }),
  needle: Object.freeze({ longRange: Object.freeze({ mode: "staggered-darts", damage: 9, speed: 755, cooldownMs: 183, radius: 3, pierce: 1, count: 3, spread: .08 }), charge: Object.freeze({ mode: "needle-tempest", minimumMs: 380, maximumMs: 1250, damage: 23, speed: 850, radius: 6, cooldownMs: 2625, pierce: 3, count: 7, spread: .07 }) }),
});

// The playable map, the Keel preview, and the gallery all advance the
// authored Gyro Saw spin at the same cadence. Keeping the clock math here is
// important: a presentation may scale the sprite or the world, but it must
// never invent a different projectile animation.
export const VAULT_GYRO_FRAME_DURATION_MS = 86;

// The saw is an authored frame sequence, not a transform animation. Every
// surface uses this same clock: idle loops continuously, holding Fire speeds
// the loop up, and a launched disc advances faster without rotating its image.
export const VAULT_GYRO_ANIMATION_RULES = Object.freeze({
  idleSpeed: 1,
  heldSpeed: 2.25,
  chargeSpeed: 3.5,
  projectileSpeed: 2.75,
  chargedProjectileSpeed: 3.75,
});

export function vaultGyroAnimationSpeed({ held = false, charging = false, projectile = false, chargedProjectile = false } = {}) {
  if (projectile) return chargedProjectile ? VAULT_GYRO_ANIMATION_RULES.chargedProjectileSpeed : VAULT_GYRO_ANIMATION_RULES.projectileSpeed;
  if (charging) return VAULT_GYRO_ANIMATION_RULES.chargeSpeed;
  if (held) return VAULT_GYRO_ANIMATION_RULES.heldSpeed;
  return VAULT_GYRO_ANIMATION_RULES.idleSpeed;
}

export function vaultGyroFrameIndex(time = 0, frameCount = 9, speed = 1) {
  const count = Math.max(1, Math.floor(Number(frameCount) || 1));
  const playbackSpeed = Math.max(0, Number(speed) || 1);
  return ((Math.floor((Number(time) || 0) * playbackSpeed) / VAULT_GYRO_FRAME_DURATION_MS | 0) % count + count) % count;
}

export function vaultWeaponProjectileDamageScale(weaponId, attack = "longRange") {
  const rules = VAULT_WEAPON_COMBAT_RULES[weaponId]?.[attack];
  if (!rules) throw new Error(`Unknown Vault weapon attack ${weaponId}:${attack}`);
  if (attack === "longRange") return (rules.count ?? 1) > 1 ? .56 : 1;
  if (weaponId === "bloom") return .46;
  if (weaponId === "needle") return .5;
  return 1;
}

/**
 * Build the exact player projectile volley used by both the playable map and
 * passive Keel presentations. Hosts can scale world coordinates for display,
 * but count, spread, speed, radius, pierce, recall, and TTL remain game rules.
 */
export function createVaultWeaponProjectileVolley({
  weaponId,
  attack = "longRange",
  originX = 0,
  originY = 0,
  aimX = 1,
  aimY = 0,
  projectileSpeed,
  radius,
  damage,
  ttl,
  pierce,
  critical = false,
  charged = attack === "charge",
  now = 0,
  nextId = (index) => index,
} = {}) {
  const rules = VAULT_WEAPON_COMBAT_RULES[weaponId]?.[attack];
  if (!rules) throw new Error(`Unknown Vault weapon attack ${weaponId}:${attack}`);
  const count = rules.count ?? 1;
  const spread = rules.spread ?? 0;
  const baseAngle = Math.atan2(Number(aimY) || 0, Number(aimX) || 0);
  const spawnOffset = attack === "charge" ? 44 : 42;
  return Array.from({ length: count }, (_, index) => {
    const angle = baseAngle + (index - (count - 1) / 2) * spread;
    const projectile = {
      id: nextId(index),
      hostile: false,
      x: Number(originX) + Math.cos(angle) * spawnOffset,
      y: Number(originY) + Math.sin(angle) * spawnOffset,
      vx: Math.cos(angle) * Number(projectileSpeed),
      vy: Math.sin(angle) * Number(projectileSpeed),
      radius: Number(radius ?? rules.radius ?? 5),
      damage: Number(damage),
      ttl: Number(ttl ?? (weaponId === "gyro" ? 2.1 : attack === "charge" ? 1.8 : 2.2)),
      pierce: Number(pierce ?? rules.pierce ?? 1),
      critical: Boolean(critical),
      weapon: weaponId,
      ...(charged ? { charged: true } : {}),
    };
    if (weaponId === "gyro") {
      armVaultGyroProjectile(projectile, {
        now,
        returnDelayMs: rules.returnDelayMs,
        returnSpeed: Number(projectileSpeed) * rules.returnSpeedScale,
      });
    }
    return projectile;
  });
}

function vaultWeaponHash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function vaultWeaponRng(seed) {
  let state = vaultWeaponHash32(seed) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function vaultWeaponLerp(minimum, maximum, amount) { return minimum + (maximum - minimum) * amount; }
function vaultWeaponPick(items, rng) { return items[Math.floor(rng() * items.length) % items.length]; }
function vaultWeaponRarity(rng) {
  const value = rng();
  if (value > 0.995) return { id: "mythic", rank: 5, multiplier: 1.18 };
  if (value > 0.97) return { id: "legendary", rank: 4, multiplier: 1.12 };
  if (value > 0.88) return { id: "rare", rank: 3, multiplier: 1.07 };
  if (value > 0.62) return { id: "uncommon", rank: 2, multiplier: 1.03 };
  return { id: "common", rank: 1, multiplier: 1 };
}
function vaultWeaponClampedRoll(range, rng, rarity, bias = 1.75) {
  const amount = Math.pow(rng(), bias / rarity.multiplier);
  return Number(vaultWeaponLerp(range[0], range[1], amount).toFixed(4));
}

// This is the full Vault game's weapon roll. The optional forced weapon keeps
// the token's contract-bound asset identity while consuming the same selector
// draw and rolling the exact same rarity/stat sequence as the playable map.
export function rollVaultWeapon(atlas, runSeed, inventoryIndex = 0, forcedWeaponId = undefined) {
  const rng = vaultWeaponRng(`${runSeed}:starter-weapon:${inventoryIndex}`);
  const selected = vaultWeaponPick(atlas.weapons, rng);
  const spec = forcedWeaponId === undefined
    ? selected
    : atlas.weapons.find((weapon) => weapon.id === forcedWeaponId);
  if (spec === undefined) throw new Error(`Unknown Vault weapon ${forcedWeaponId}`);
  const rarity = vaultWeaponRarity(rng);
  const power = vaultWeaponClampedRoll(spec.statClamps.power, rng, rarity);
  const speed = vaultWeaponClampedRoll(spec.statClamps.speed, rng, rarity);
  const critical = vaultWeaponClampedRoll(spec.statClamps.critical, rng, rarity, 2.3);
  return Object.freeze({
    id: spec.id,
    name: spec.name,
    class: spec.class,
    source: spec.source,
    rarity: rarity.id,
    rarityRank: rarity.rank,
    power,
    speed,
    critical,
    fingerprint: vaultWeaponHash32(`${runSeed}:${spec.id}:${power}:${speed}:${critical}`).toString(16).padStart(8, "0"),
    longRange: Object.freeze({
      ...spec.longRange,
      damage: Math.round(vaultWeaponLerp(...spec.longRange.damage, rng()) * power),
      projectileSpeed: Math.round(vaultWeaponLerp(...spec.longRange.speed, rng()) * speed),
      cooldownMs: Math.round(vaultWeaponLerp(...spec.longRange.cooldownMs, rng()) / speed),
    }),
    closeRange: Object.freeze({
      ...spec.closeRange,
      damage: Math.round(vaultWeaponLerp(...spec.closeRange.damage, rng()) * power),
      radius: Math.round(vaultWeaponLerp(...spec.closeRange.radius, rng())),
      cooldownMs: Math.round(vaultWeaponLerp(...spec.closeRange.cooldownMs, rng()) / speed),
    }),
    chargeAttack: Object.freeze({
      ...spec.chargeAttack,
      minimumChargeMs: spec.chargeAttack.chargeMs[0],
      maximumChargeMs: spec.chargeAttack.chargeMs[1],
      damage: Math.round(vaultWeaponLerp(...spec.chargeAttack.damage, rng()) * power),
      projectileSpeed: Math.round(vaultWeaponLerp(...spec.chargeAttack.speed, rng()) * speed),
      radius: Math.round(vaultWeaponLerp(...spec.chargeAttack.radius, rng())),
      cooldownMs: Math.round(vaultWeaponLerp(...spec.chargeAttack.cooldownMs, rng()) / speed),
    }),
  });
}

// The full game combines this character roll with the rolled weapon critical
// chance. Keep the draw order identical to rollCharacter in vault-game-core.
export function rollVaultCharacterCritical(runSeed) {
  const rng = vaultWeaponRng(`${runSeed}:character`);
  rng(); // affinity
  rng(); // shell
  rng(); // matched visor decision
  rng(); // maximum health
  rng(); // movement speed
  rng(); // defense
  return Number((0.02 + rng() * 0.045).toFixed(3));
}

export function armVaultGyroProjectile(projectile, { now = 0, returnDelayMs = 900, returnSpeed = 0 } = {}) {
  if (projectile == null) return null;
  projectile.boomerang = true;
  projectile.returning = false;
  projectile.returnAt = Number(now) + Number(returnDelayMs);
  projectile.returnSpeed = Number(returnSpeed);
  projectile.hit ??= new Set();
  return projectile;
}

export function updateVaultGyroProjectile(projectile, player, now) {
  if (projectile?.boomerang !== true || Number(now) < projectile.returnAt) return false;
  projectile.returning = true;
  const dx = Number(player?.x) - projectile.x;
  const dy = Number(player?.y) - projectile.y;
  const length = Math.hypot(dx, dy) || 1;
  projectile.vx = dx / length * projectile.returnSpeed;
  projectile.vy = dy / length * projectile.returnSpeed;
  return true;
}

export function vaultProjectileHitKey(projectile, targetId) {
  return projectile?.boomerang === true ? `${targetId}:${projectile.returning ? "return" : "out"}` : targetId;
}

function vaultCombatClampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }
function vaultCombatHexRgb(hex) {
  const value = Number.parseInt(String(hex).replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
function vaultCombatRgbHex(rgb) { return `#${rgb.map((value) => vaultCombatClampByte(value).toString(16).padStart(2, "0")).join("")}`; }
function vaultCombatHslRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const channels = sector < 1 ? [chroma, secondary, 0] : sector < 2 ? [secondary, chroma, 0] : sector < 3 ? [0, chroma, secondary] : sector < 4 ? [0, secondary, chroma] : sector < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return channels.map((channel) => (channel + offset) * 255);
}

export function createVaultMobVisualRecipes({ sceneId = "vault", sceneColor = "#67f6c5", entropy = 0 } = {}) {
  const theme = vaultCombatHexRgb(sceneColor);
  const themedColor = (index, lightness, saturation = .62) => {
    const variant = vaultCombatHslRgb((index * 47 + entropy * 3) % 360, saturation, lightness);
    return vaultCombatRgbHex(variant.map((value, channel) => value * .58 + theme[channel] * .42));
  };
  return Object.freeze(Array.from({ length: 50 }, (_, index) => Object.freeze({
    id: `scene-${sceneId}-${String(index + 1).padStart(2, "0")}`,
    layers: VAULT_MOB_ATTRIBUTE_LAYERS,
    bodyPrimary: themedColor(index, .2 + (index % 4) * .035, .45 + (index % 3) * .08),
    bodySecondary: themedColor(index + 11, .34 + (index % 5) * .025, .48),
    trim: themedColor(index + 23, .62 + (index % 3) * .05, .68),
    core: themedColor(index + 37, .7, .92),
    floater: ["none", "orbit-pips", "winglets", "halo-shards", "satellite-pair"][index % 5],
    surface: ["clean", "banded", "split", "speckled", "charged"][Math.floor(index / 5) % 5],
  })));
}

export function selectVaultMobAbilities({ elite = false, variant = 0, spawnCount = 0, roll = 1 } = {}) {
  const count = elite ? 2 + (Math.abs(variant) % 2) : roll < .26 ? 1 : 0;
  const offset = (Math.abs(variant) + Math.abs(spawnCount) * 3) % VAULT_MOB_ABILITIES.length;
  return Object.freeze(Array.from({ length: count }, (_, index) => VAULT_MOB_ABILITIES[(offset + index * 3) % VAULT_MOB_ABILITIES.length]));
}
