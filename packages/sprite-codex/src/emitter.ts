import { canonicalJson, sha256 } from "./hash.js";
import type { SpriteCodex } from "./loader.js";

export const SPRITE_EMITTER_SCHEMA = "oca-sprite-emitter@1" as const;
export const EMITTER_TICKS_PER_SECOND = 60;
export const EMITTER_LIMITS = Object.freeze({ maxLive: 512, maxTotal: 4_096, maxTicks: 3_600, maxFrames: 64, maxCurvePoints: 16, maxTrailSamples: 64 });
const Q16 = 65_536;
const U64_MASK = (1n << 64n) - 1n;

export interface EmitterCurvePoint { tick: number; value: number }
export interface SpriteEmitterRecipe {
  schema: typeof SPRITE_EMITTER_SCHEMA;
  presetId: number;
  revision: number;
  fxCatalogRevision: number;
  mapGenerationEpoch: number;
  seedDomainVersion: 1;
  eventKind: number;
  sprite: {
    mode: "static" | "animated" | "emitter";
    bundleId: number; bundleRevision: number; assetId: number; selectionRevision: number;
    frameIndices: number[]; frameSha256: string[];
  };
  animation: { frameTicks: number[]; playback: "once" | "loop" | "ping-pong"; phaseJitterTicks: number };
  spawn: {
    mode: "static" | "burst" | "rate";
    maxLive: number; maxTotal: number; startTick: number; endTick: number;
    countMin: number; countMax: number; timingJitterTicks: number; rateNumerator: number; rateDenominator: number;
    initialPosition: {
      shape: "point" | "rect" | "ellipse";
      offsetXMinQ16: number; offsetXMaxQ16: number; offsetYMinQ16: number; offsetYMaxQ16: number;
    };
  };
  motion: {
    speedMinQ16: number; speedMaxQ16: number; coneCenterTurns: number; coneWidthTurns: number;
    accelerationXQ16: number; accelerationYQ16: number; dragQ16: number; gravityQ16: number; turbulenceQ16: number;
    lifetimeMinTicks: number; lifetimeMaxTicks: number;
  };
  transform: {
    startScaleMinQ16: number; startScaleMaxQ16: number; endScaleMinQ16: number; endScaleMaxQ16: number;
    rotationMinTurns: number; rotationMaxTurns: number; angularVelocityMinTurns: number; angularVelocityMaxTurns: number;
    pivotXQ16: number; pivotYQ16: number;
  };
  appearance: {
    materialTarget: string; paletteMode: "fixed" | "character" | "weapon" | "map";
    palette: string[]; alphaCurve: EmitterCurvePoint[]; colorCurve: Array<EmitterCurvePoint & { rgba: [number, number, number, number] }>;
    blendMode: "source-over" | "lighter" | "screen" | "multiply";
  };
  extras: { trailSamples: number; trailWidthQ16: number; lightRadiusQ16: number; lightIntensity: number };
}

export interface EmitterSeedContext {
  mapSeed: string; mapId: string; worldEntityIndex: number; eventOrdinal: number;
}

export interface EmitterSeedIdentity { mapGenerationEpoch: number; presetId: number; revision: number; eventKind: number }

export interface EmitterParticleState {
  emissionIndex: number; bornTick: number; ageTicks: number; lifetimeTicks: number; frameIndex: number;
  xQ16: number; yQ16: number; velocityXQ16: number; velocityYQ16: number; scaleQ16: number;
  rotationTurns: number; angularVelocityTurns: number; animationPhaseTicks: number; paletteIndex: number; alpha: number; color: [number, number, number, number];
}

function integer(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
}

function digest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function curve(points: EmitterCurvePoint[], label: string): void {
  if (!Array.isArray(points) || points.length === 0 || points.length > EMITTER_LIMITS.maxCurvePoints) throw new Error(`${label} has an invalid point count`);
  let prior = -1;
  for (const point of points) { integer(point.tick, `${label}.tick`, 0, EMITTER_LIMITS.maxTicks); integer(point.value, `${label}.value`, -0x7fffffff, 0x7fffffff); if (point.tick <= prior) throw new Error(`${label} ticks must increase`); prior = point.tick; }
}

export function validateEmitterRecipe(value: unknown): asserts value is SpriteEmitterRecipe {
  if (value === null || typeof value !== "object") throw new Error("sprite emitter recipe must be an object");
  const recipe = value as SpriteEmitterRecipe;
  if (recipe.schema !== SPRITE_EMITTER_SCHEMA) throw new Error(`expected schema ${SPRITE_EMITTER_SCHEMA}`);
  integer(recipe.presetId, "presetId", 1, 0xffffffff); integer(recipe.revision, "revision", 1, 0xffffffff);
  integer(recipe.fxCatalogRevision, "fxCatalogRevision", 1, 0xffffffff); integer(recipe.mapGenerationEpoch, "mapGenerationEpoch", 1, 0xffffffff);
  if (recipe.seedDomainVersion !== 1) throw new Error("unsupported emitter seed domain"); integer(recipe.eventKind, "eventKind", 0, 0xffff);
  if (recipe.sprite === undefined || !["static", "animated", "emitter"].includes(recipe.sprite.mode)) throw new Error("invalid emitter sprite mode");
  for (const [label, field] of [["bundleId", recipe.sprite.bundleId], ["bundleRevision", recipe.sprite.bundleRevision], ["assetId", recipe.sprite.assetId], ["selectionRevision", recipe.sprite.selectionRevision]] as const) integer(field, label, 1, 0xffffffff);
  if (!Array.isArray(recipe.sprite.frameIndices) || recipe.sprite.frameIndices.length === 0 || recipe.sprite.frameIndices.length > EMITTER_LIMITS.maxFrames || recipe.sprite.frameIndices.length !== recipe.sprite.frameSha256.length) throw new Error("invalid emitter frame list");
  recipe.sprite.frameIndices.forEach((frame, index) => { integer(frame, `frameIndices[${index}]`, 0, 0xffff); digest(recipe.sprite.frameSha256[index]!, `frameSha256[${index}]`); });
  if (recipe.sprite.mode === "animated" && (recipe.sprite.frameIndices.length < 2 || new Set(recipe.sprite.frameSha256).size < 2)) throw new Error("animated emitter masters require at least two non-identical frames");
  if (recipe.animation === undefined || recipe.animation.frameTicks.length !== recipe.sprite.frameIndices.length || !["once", "loop", "ping-pong"].includes(recipe.animation.playback)) throw new Error("invalid emitter animation");
  recipe.animation.frameTicks.forEach((ticks, index) => integer(ticks, `frameTicks[${index}]`, 1, EMITTER_LIMITS.maxTicks));
  integer(recipe.animation.phaseJitterTicks, "phaseJitterTicks", 0, EMITTER_LIMITS.maxTicks);
  const spawn = recipe.spawn; if (spawn === undefined || !["static", "burst", "rate"].includes(spawn.mode)) throw new Error("invalid emitter spawn mode");
  integer(spawn.maxLive, "maxLive", 1, EMITTER_LIMITS.maxLive); integer(spawn.maxTotal, "maxTotal", 1, EMITTER_LIMITS.maxTotal); integer(spawn.startTick, "startTick", 0, EMITTER_LIMITS.maxTicks); integer(spawn.endTick, "endTick", spawn.startTick, EMITTER_LIMITS.maxTicks);
  integer(spawn.countMin, "countMin", 1, spawn.maxTotal); integer(spawn.countMax, "countMax", spawn.countMin, spawn.maxTotal); integer(spawn.timingJitterTicks, "timingJitterTicks", 0, EMITTER_LIMITS.maxTicks);
  integer(spawn.rateNumerator, "rateNumerator", 0, EMITTER_LIMITS.maxTotal); integer(spawn.rateDenominator, "rateDenominator", 1, EMITTER_LIMITS.maxTicks);
  if (spawn.mode === "static" && (spawn.maxTotal !== 1 || spawn.countMin !== 1 || spawn.countMax !== 1)) throw new Error("static emitter counts must be 1");
  const initialPosition = spawn.initialPosition;
  if (initialPosition === undefined || !["point", "rect", "ellipse"].includes(initialPosition.shape)) throw new Error("invalid emitter initial position shape");
  integer(initialPosition.offsetXMinQ16, "offsetXMinQ16", -0x7fffffff, 0x7fffffff); integer(initialPosition.offsetXMaxQ16, "offsetXMaxQ16", initialPosition.offsetXMinQ16, 0x7fffffff);
  integer(initialPosition.offsetYMinQ16, "offsetYMinQ16", -0x7fffffff, 0x7fffffff); integer(initialPosition.offsetYMaxQ16, "offsetYMaxQ16", initialPosition.offsetYMinQ16, 0x7fffffff);
  if (initialPosition.shape === "point" && (initialPosition.offsetXMinQ16 !== initialPosition.offsetXMaxQ16 || initialPosition.offsetYMinQ16 !== initialPosition.offsetYMaxQ16)) throw new Error("point emitter initial position ranges must collapse to one point");
  const motion = recipe.motion; if (motion === undefined) throw new Error("emitter motion is required");
  integer(motion.speedMinQ16, "speedMinQ16", -0x7fffffff, 0x7fffffff); integer(motion.speedMaxQ16, "speedMaxQ16", motion.speedMinQ16, 0x7fffffff);
  integer(motion.coneCenterTurns, "coneCenterTurns", 0, 0xffff); integer(motion.coneWidthTurns, "coneWidthTurns", 0, 0xffff);
  for (const field of ["accelerationXQ16", "accelerationYQ16", "gravityQ16", "turbulenceQ16"] as const) integer(motion[field], field, -0x7fffffff, 0x7fffffff);
  integer(motion.dragQ16, "dragQ16", 0, Q16); integer(motion.lifetimeMinTicks, "lifetimeMinTicks", 1, EMITTER_LIMITS.maxTicks); integer(motion.lifetimeMaxTicks, "lifetimeMaxTicks", motion.lifetimeMinTicks, EMITTER_LIMITS.maxTicks);
  const transform = recipe.transform; if (transform === undefined) throw new Error("emitter transform is required");
  for (const field of ["startScaleMinQ16", "endScaleMinQ16", "pivotXQ16", "pivotYQ16"] as const) integer(transform[field], field, -0x7fffffff, 0x7fffffff);
  integer(transform.startScaleMaxQ16, "startScaleMaxQ16", transform.startScaleMinQ16, 0x7fffffff); integer(transform.endScaleMaxQ16, "endScaleMaxQ16", transform.endScaleMinQ16, 0x7fffffff);
  integer(transform.rotationMinTurns, "rotationMinTurns", 0, 0xffff); integer(transform.rotationMaxTurns, "rotationMaxTurns", transform.rotationMinTurns, 0xffff);
  integer(transform.angularVelocityMinTurns, "angularVelocityMinTurns", -0x7fffffff, 0x7fffffff); integer(transform.angularVelocityMaxTurns, "angularVelocityMaxTurns", transform.angularVelocityMinTurns, 0x7fffffff);
  const appearance = recipe.appearance; if (appearance === undefined || typeof appearance.materialTarget !== "string" || !["fixed", "character", "weapon", "map"].includes(appearance.paletteMode) || !["source-over", "lighter", "screen", "multiply"].includes(appearance.blendMode)) throw new Error("invalid emitter appearance");
  if (!Array.isArray(appearance.palette) || appearance.palette.length === 0 || appearance.palette.length > 16 || appearance.palette.some((entry) => !/^#[0-9a-f]{6}$/i.test(entry))) throw new Error("invalid emitter palette");
  curve(appearance.alphaCurve, "alphaCurve"); curve(appearance.colorCurve, "colorCurve");
  for (const point of appearance.colorCurve) for (const channel of point.rgba) integer(channel, "color channel", 0, 255);
  const extras = recipe.extras; if (extras === undefined) throw new Error("emitter extras are required");
  integer(extras.trailSamples, "trailSamples", 0, EMITTER_LIMITS.maxTrailSamples); integer(extras.trailWidthQ16, "trailWidthQ16", 0, 16 * Q16); integer(extras.lightRadiusQ16, "lightRadiusQ16", 0, 256 * Q16); integer(extras.lightIntensity, "lightIntensity", 0, 255);
}

function u32be(value: number): Uint8Array { return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value); }
function u16be(value: number): Uint8Array { return Uint8Array.of(value >>> 8, value); }
function bytes32(value: string, label: string): Uint8Array {
  const clean = value.replace(/^0x/, ""); if (!/^[0-9a-f]{64}$/i.test(clean)) throw new Error(`${label} must be bytes32`);
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
}
function join(parts: Uint8Array[]): Uint8Array { const length = parts.reduce((sum, part) => sum + part.length, 0); const out = new Uint8Array(length); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }

export async function deriveEmitterEventSeedFromIdentity(identity: EmitterSeedIdentity, context: EmitterSeedContext): Promise<Uint8Array> {
  integer(identity.mapGenerationEpoch, "mapGenerationEpoch", 1, 0xffffffff); integer(identity.presetId, "presetId", 1, 0xffffffff); integer(identity.revision, "revision", 1, 0xffffffff); integer(identity.eventKind, "eventKind", 0, 0xffff);
  integer(context.worldEntityIndex, "worldEntityIndex", 0, 0xffffffff); integer(context.eventOrdinal, "eventOrdinal", 0, 0xffffffff);
  const domain = new TextEncoder().encode("oca.sprite-emitter.v1");
  const input = join([domain, u32be(identity.mapGenerationEpoch), bytes32(context.mapSeed, "mapSeed"), bytes32(context.mapId, "mapId"), u32be(identity.presetId), u32be(identity.revision), u16be(identity.eventKind), u32be(context.worldEntityIndex), u32be(context.eventOrdinal)]);
  const digestHex = await sha256(input); return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16));
}

export async function deriveEmitterEventSeed(recipe: SpriteEmitterRecipe, context: EmitterSeedContext): Promise<Uint8Array> {
  validateEmitterRecipe(recipe);
  return deriveEmitterEventSeedFromIdentity({ mapGenerationEpoch: recipe.mapGenerationEpoch, presetId: recipe.presetId, revision: recipe.revision, eventKind: recipe.eventKind }, context);
}

export function splitMix64(seed64: bigint, counter: number): bigint {
  integer(counter, "random counter", 0, 0xffffffff);
  let z = (seed64 + BigInt(counter + 1) * 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function seed64(seed: Uint8Array): bigint { if (seed.length < 8) throw new Error("emitter event seed is too short"); let value = 0n; for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(seed[index]!); return value; }
function randomQ16(seed: bigint, counter: number): number { return Number(splitMix64(seed, counter) >> 48n); }
function interpolate(minimum: number, maximum: number, random: number): number { return minimum + Math.trunc((maximum - minimum) * random / 0xffff); }
function qmul(left: number, right: number): number { const value = BigInt(left) * BigInt(right) / BigInt(Q16); if (value < -0x7fffffffn || value > 0x7fffffffn) throw new Error("emitter Q16 multiplication overflow"); return Number(value); }
function checkedI32(value: number): number { if (!Number.isSafeInteger(value) || value < -0x7fffffff || value > 0x7fffffff) throw new Error("emitter integer overflow"); return value; }
/** Pinned integer Bhaskara-I sine approximation. No floating-point trig or runtime LUT generation. */
function turnsSin(turns: number): number {
  const normalized = turns & 0xffff; const negative = normalized >= 0x8000; const half = negative ? 0x10000 - normalized : normalized; const x = BigInt(half * 2); const q = BigInt(Q16);
  const product = x * (q - x) / q; const denominator = 5n * q - 4n * product; const magnitude = denominator === 0n ? 0n : 16n * product * q / denominator;
  return Number(negative ? -magnitude : magnitude);
}
function turnsCos(turns: number): number { return turnsSin((turns + 0x4000) & 0xffff); }
function hexRgb(value: string): [number, number, number] { const number = Number.parseInt(value.slice(1), 16); return [(number >> 16) & 255, (number >> 8) & 255, number & 255]; }
function curveValue(points: EmitterCurvePoint[], age: number, fallback: number): number { if (points.length === 0) return fallback; if (age <= points[0]!.tick) return points[0]!.value; for (let index = 1; index < points.length; index += 1) { const right = points[index]!; const left = points[index - 1]!; if (age <= right.tick) return interpolate(left.value, right.value, Math.trunc((age - left.tick) * 0xffff / (right.tick - left.tick))); } return points.at(-1)!.value; }
function frameAt(recipe: SpriteEmitterRecipe, age: number, phase: number): number { const durations = recipe.animation.frameTicks; const total = durations.reduce((sum, value) => sum + value, 0); let tick = age + phase; if (recipe.animation.playback === "loop") tick %= total; else if (recipe.animation.playback === "ping-pong") { const span = total * 2 - durations[0]! - durations.at(-1)!; tick %= Math.max(1, span); const forward = tick < total; if (!forward) tick = span - tick; } else tick = Math.min(tick, total - 1); let sum = 0; for (let index = 0; index < durations.length; index += 1) { sum += durations[index]!; if (tick < sum) return recipe.sprite.frameIndices[index]!; } return recipe.sprite.frameIndices.at(-1)!; }

function emissionTicks(recipe: SpriteEmitterRecipe, root: bigint): number[] {
  const spawn = recipe.spawn;
  const count = interpolate(spawn.countMin, spawn.countMax, randomQ16(root, 0));
  const nominal: number[] = [];
  if (spawn.mode === "static") nominal.push(spawn.startTick);
  else if (spawn.mode === "burst") for (let index = 0; index < count; index += 1) nominal.push(spawn.startTick);
  else {
  for (let tick = spawn.startTick; tick <= spawn.endTick && nominal.length < spawn.maxTotal; tick += 1) {
    const elapsed = tick - spawn.startTick;
    const before = Math.floor(elapsed * spawn.rateNumerator / spawn.rateDenominator), after = Math.floor((elapsed + 1) * spawn.rateNumerator / spawn.rateDenominator);
      for (let emitted = before; emitted < after && nominal.length < spawn.maxTotal; emitted += 1) nominal.push(tick);
    }
  }
  const limited = nominal.slice(0, Math.min(count, spawn.maxTotal));
  return limited.map((tick, index) => Math.max(spawn.startTick, Math.min(spawn.endTick, tick + interpolate(-spawn.timingJitterTicks, spawn.timingJitterTicks, randomQ16(root, 1 + index))))).sort((left, right) => left - right);
}

export function emitterTrace(recipe: SpriteEmitterRecipe, eventSeed: Uint8Array, untilTick = recipe.spawn.endTick): EmitterParticleState[] {
  validateEmitterRecipe(recipe); integer(untilTick, "untilTick", 0, EMITTER_LIMITS.maxTicks); const root = seed64(eventSeed); const output: EmitterParticleState[] = [];
  for (const [emissionIndex, bornTick] of emissionTicks(recipe, root).entries()) {
    if (bornTick > untilTick) break;
    const base = 4_096 + emissionIndex * 20; const lifetime = interpolate(recipe.motion.lifetimeMinTicks, recipe.motion.lifetimeMaxTicks, randomQ16(root, base)); const age = untilTick - bornTick; if (age >= lifetime) continue;
    const speed = interpolate(recipe.motion.speedMinQ16, recipe.motion.speedMaxQ16, randomQ16(root, base + 1));
    const halfCone = Math.trunc(recipe.motion.coneWidthTurns / 2); const angle = (recipe.motion.coneCenterTurns + interpolate(-halfCone, halfCone, randomQ16(root, base + 2))) & 0xffff;
    let vx = qmul(speed, turnsCos(angle)), vy = qmul(speed, turnsSin(angle));
    const position = recipe.spawn.initialPosition;
    let x = interpolate(position.offsetXMinQ16, position.offsetXMaxQ16, randomQ16(root, base + 10));
    let y = interpolate(position.offsetYMinQ16, position.offsetYMaxQ16, randomQ16(root, base + 11));
    if (position.shape === "ellipse") {
      const centerX = Math.trunc((position.offsetXMinQ16 + position.offsetXMaxQ16) / 2), centerY = Math.trunc((position.offsetYMinQ16 + position.offsetYMaxQ16) / 2);
      const radiusX = Math.trunc((position.offsetXMaxQ16 - position.offsetXMinQ16) / 2), radiusY = Math.trunc((position.offsetYMaxQ16 - position.offsetYMinQ16) / 2);
      const radialQ16 = randomQ16(root, base + 10), positionAngle = randomQ16(root, base + 11);
      x = checkedI32(centerX + qmul(qmul(radiusX, radialQ16), turnsCos(positionAngle)));
      y = checkedI32(centerY + qmul(qmul(radiusY, radialQ16), turnsSin(positionAngle)));
    }
    const phase = randomQ16(root, base + 3);
    for (let tick = 0; tick < age; tick += 1) {
      const turbulence = qmul(recipe.motion.turbulenceQ16, turnsSin((phase + tick * 977) & 0xffff));
      vx = qmul(checkedI32(vx + recipe.motion.accelerationXQ16 + turbulence), recipe.motion.dragQ16);
      vy = qmul(checkedI32(vy + recipe.motion.accelerationYQ16 + recipe.motion.gravityQ16), recipe.motion.dragQ16);
      x = checkedI32(x + vx); y = checkedI32(y + vy);
    }
    const startScale = interpolate(recipe.transform.startScaleMinQ16, recipe.transform.startScaleMaxQ16, randomQ16(root, base + 4));
    const endScale = interpolate(recipe.transform.endScaleMinQ16, recipe.transform.endScaleMaxQ16, randomQ16(root, base + 5));
    const scale = interpolate(startScale, endScale, Math.trunc(age * 0xffff / Math.max(1, lifetime - 1)));
    const rotation = interpolate(recipe.transform.rotationMinTurns, recipe.transform.rotationMaxTurns, randomQ16(root, base + 6));
    const angularVelocity = interpolate(recipe.transform.angularVelocityMinTurns, recipe.transform.angularVelocityMaxTurns, randomQ16(root, base + 7));
    const animationPhase = interpolate(0, recipe.animation.phaseJitterTicks, randomQ16(root, base + 8));
    const paletteIndex = Math.trunc(randomQ16(root, base + 9) * recipe.appearance.palette.length / 0x10000);
    const alpha = Math.max(0, Math.min(255, curveValue(recipe.appearance.alphaCurve, age, 255)));
    let colorPoint = recipe.appearance.colorCurve[0]!;
    for (const point of recipe.appearance.colorCurve) { if (point.tick > age) break; colorPoint = point; }
    const paletteRgb = hexRgb(recipe.appearance.palette[paletteIndex]!);
    output.push({ emissionIndex, bornTick, ageTicks: age, lifetimeTicks: lifetime, frameIndex: frameAt(recipe, age, animationPhase), xQ16: x, yQ16: y, velocityXQ16: vx, velocityYQ16: vy, scaleQ16: scale, rotationTurns: (rotation + age * angularVelocity) & 0xffff, angularVelocityTurns: angularVelocity, animationPhaseTicks: animationPhase, paletteIndex, alpha, color: [Math.trunc(paletteRgb[0] * colorPoint.rgba[0] / 255), Math.trunc(paletteRgb[1] * colorPoint.rgba[1] / 255), Math.trunc(paletteRgb[2] * colorPoint.rgba[2] / 255), colorPoint.rgba[3]] });
  }
  return output.sort((left, right) => left.emissionIndex - right.emissionIndex).slice(0, recipe.spawn.maxLive);
}

export async function emitterReplayHash(recipe: SpriteEmitterRecipe, eventSeed: Uint8Array, untilTick: number): Promise<string> { return sha256(new TextEncoder().encode(canonicalJson(emitterTrace(recipe, eventSeed, untilTick)))); }

export function tintGrayscalePixels(source: Uint8ClampedArray, color: readonly [number, number, number, number]): Uint8ClampedArray {
  if (source.length % 4 !== 0) throw new Error("grayscale sprite pixels must be RGBA");
  const output = new Uint8ClampedArray(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    const luminance = Math.trunc((source[offset]! * 54 + source[offset + 1]! * 183 + source[offset + 2]! * 19) / 256);
    output[offset] = Math.trunc(color[0] * luminance / 255); output[offset + 1] = Math.trunc(color[1] * luminance / 255); output[offset + 2] = Math.trunc(color[2] * luminance / 255); output[offset + 3] = Math.trunc(source[offset + 3]! * color[3] / 255);
  }
  return output;
}

const tintedFrameCaches = new WeakMap<SpriteCodex, Map<string, CanvasImageSource>>();
const MAX_TINTED_FRAME_CACHE_ENTRIES = 1_024;

function tintedFrame(sprites: SpriteCodex, recipe: SpriteEmitterRecipe, state: EmitterParticleState): CanvasImageSource {
  const width = sprites.metadata.frame.width, height = sprites.metadata.frame.height;
  const key = `${recipe.sprite.assetId}:${state.frameIndex}:${recipe.appearance.materialTarget}:${state.color.join(":")}`;
  let cache = tintedFrameCaches.get(sprites);
  if (cache === undefined) { cache = new Map(); tintedFrameCaches.set(sprites, cache); }
  const cached = cache.get(key); if (cached !== undefined) return cached;
  const canvas = typeof OffscreenCanvas === "undefined" ? document.createElement("canvas") : new OffscreenCanvas(width, height);
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (context === null) throw new Error("2D canvas is unavailable for emitter material tinting");
  context.imageSmoothingEnabled = false; sprites.draw(context as CanvasRenderingContext2D, { asset: recipe.sprite.assetId, frame: state.frameIndex, displayWidth: width, displayHeight: height });
  const pixels = context.getImageData(0, 0, width, height); pixels.data.set(tintGrayscalePixels(pixels.data, state.color)); context.putImageData(pixels, 0, 0);
  if (cache.size >= MAX_TINTED_FRAME_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, canvas); return canvas;
}

export function drawEmitter(context: CanvasRenderingContext2D, sprites: SpriteCodex, recipe: SpriteEmitterRecipe, states: readonly EmitterParticleState[], originX = 0, originY = 0): void {
  validateEmitterRecipe(recipe);
  for (const state of states) {
    context.save(); context.globalCompositeOperation = recipe.appearance.blendMode; context.globalAlpha = state.alpha / 255;
    context.translate(originX + state.xQ16 / Q16, originY + state.yQ16 / Q16); context.rotate(state.rotationTurns / 0x10000 * Math.PI * 2);
    const scale = state.scaleQ16 / Q16; context.scale(scale, scale);
    context.drawImage(tintedFrame(sprites, recipe, state), -recipe.transform.pivotXQ16 / Q16, -recipe.transform.pivotYQ16 / Q16, sprites.metadata.frame.width, sprites.metadata.frame.height);
    context.restore();
  }
}
