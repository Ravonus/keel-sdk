import { resolveWeaponRegion } from "./weapon-region-resolver.js";

export const WEAPON_MATERIAL_BUILD_SCHEMA = "vault-weapon-material-build@1";

function weaponMaterialHash32(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function weaponMaterialPick(options, key) {
  if (!Array.isArray(options) || options.length === 0) throw new Error(`Missing weapon material options for ${key}`);
  return options[weaponMaterialHash32(key) % options.length];
}

export function rollWeaponMaterialBuild(catalog, seed, weaponId) {
  if (catalog?.schema !== "vault-weapon-attributes@1") throw new Error("Unsupported weapon attribute catalogue");
  const weapon = catalog.weapons?.[weaponId];
  if (!weapon) throw new Error(`Unknown weapon material profile: ${weaponId}`);
  const normalizedSeed = String(seed || "vault-weapon-001").trim() || "vault-weapon-001";
  const attributes = Object.fromEntries(weapon.attributes.map((attribute) => [
    attribute.id,
    weaponMaterialPick(attribute.options, `${normalizedSeed}:${weaponId}:${attribute.id}`),
  ]));
  return {
    schema: WEAPON_MATERIAL_BUILD_SCHEMA,
    seed: normalizedSeed,
    weaponId,
    assetId: weapon.assetId,
    characterLightLinked: true,
    attributes,
  };
}

/**
 * Resolve the material choices committed in a Vault character recipe.
 *
 * The packed attribute word is the canonical visual input for an on-chain
 * character.  Keeping this next to the seed fallback makes every consumer
 * (gallery, map, and full viewer) use the same byte ordering and option
 * selection instead of independently inventing a seed derivation.
 */
export function materialBuildFromPackedAttributes(catalog, packedAttributes, weaponId) {
  if (catalog?.schema !== "vault-weapon-attributes@1") throw new Error("Unsupported weapon attribute catalogue");
  const weapon = catalog.weapons?.[weaponId];
  if (!weapon) throw new Error(`Unknown weapon material profile: ${weaponId}`);
  if (typeof packedAttributes !== "string" || !/^0x[0-9a-f]{64}$/iu.test(packedAttributes)) {
    throw new Error("Packed character attributes must be a bytes32 hex value.");
  }
  const bytes = Array.from(
    { length: 32 },
    (_, index) => Number.parseInt(packedAttributes.slice(2 + (31 - index) * 2, 4 + (31 - index) * 2), 16),
  );
  const attributes = Object.fromEntries(weapon.attributes.map((attribute, index) => [
    attribute.id,
    attribute.options[bytes[(9 + index) % bytes.length] % attribute.options.length],
  ]));
  return {
    schema: WEAPON_MATERIAL_BUILD_SCHEMA,
    seed: packedAttributes.toLowerCase(),
    weaponId,
    assetId: weapon.assetId,
    characterLightLinked: true,
    attributes,
  };
}

export function weaponMaterialLedger(build) {
  if (build?.schema !== WEAPON_MATERIAL_BUILD_SCHEMA) throw new Error("Unsupported weapon material build");
  return `${build.weaponId}:${Object.entries(build.attributes).map(([id, value]) => `${id}=${value}`).join(",")}`;
}

function weaponMaterialClamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function weaponMaterialMix(left, right, amount) {
  return Math.round(left + (right - left) * amount);
}

function weaponMaterialRgb(hex) {
  const number = Number.parseInt(String(hex).replace("#", ""), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function weaponMaterialHslRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs(sector % 2 - 1));
  let color;
  if (sector < 1) color = [chroma, x, 0];
  else if (sector < 2) color = [x, chroma, 0];
  else if (sector < 3) color = [0, chroma, x];
  else if (sector < 4) color = [0, x, chroma];
  else if (sector < 5) color = [x, 0, chroma];
  else color = [chroma, 0, x];
  const offset = lightness - chroma / 2;
  return color.map((channel) => Math.round((channel + offset) * 255));
}

function materialPixel(material, luminance, x, y) {
  const bands = material.bands.map(weaponMaterialRgb);
  const position = weaponMaterialClamp((luminance - 48) / 207) * 2;
  const lower = Math.floor(position);
  const upper = Math.min(2, lower + 1);
  const amount = position - lower;
  let color = [0, 1, 2].map((channel) => weaponMaterialMix(bands[lower][channel], bands[upper][channel], amount));
  if (material.effect === "rainbow") color = weaponMaterialHslRgb((x * 11 + y * 7) % 360, 0.88, 0.2 + weaponMaterialClamp((luminance - 48) / 207) * 0.62);
  else if (material.effect === "aurora") color = weaponMaterialHslRgb(165 + 65 * Math.sin(x * 0.22 + y * 0.11), 0.78, 0.18 + weaponMaterialClamp((luminance - 48) / 207) * 0.64);
  else if (material.effect === "void" && (x * 17 + y * 29) % 31 < 3) color = [190, 128, 255];
  else if (material.effect === "acid" && (x * 13 + y * 19) % 23 < 4) color = [190, 255, 91];
  else if (material.effect === "blood" && (x * 7 + y * 23) % 29 < 7) color = [weaponMaterialMix(color[0], 255, 0.32), weaponMaterialMix(color[1], 16, 0.5), weaponMaterialMix(color[2], 24, 0.45)];
  return color;
}

function linkedLightPixel(coreStyle, luminance) {
  const amount = weaponMaterialClamp((luminance - 48) / 207);
  const edge = weaponMaterialRgb(coreStyle.edge);
  const core = weaponMaterialRgb(coreStyle.core);
  return [0, 1, 2].map((channel) => weaponMaterialMix(edge[channel], core[channel], amount));
}

function shellFinish(color, finish, x, y, luminance) {
  const grain = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  if (finish === "battle-worn" && grain % 17 < 3) return color.map((value) => Math.round(value * 0.54));
  if (finish === "blood-splatter" && grain % 31 < 5) return [weaponMaterialMix(color[0], 166, 0.66), weaponMaterialMix(color[1], 8, 0.76), weaponMaterialMix(color[2], 18, 0.72)];
  if (finish === "prism-wash") return color.map((value, channel) => weaponMaterialMix(value, weaponMaterialHslRgb((x * 13 + y * 9) % 360, 0.82, 0.62)[channel], 0.3));
  if (finish === "void-speckle" && grain % 23 < 4) return luminance > 150 ? [132, 78, 190] : [10, 4, 20];
  return color;
}

export function materializeWeaponFrame({ catalog, layouts, overrides, build, sourceImage, coreStyle, frame = "base" }) {
  if (build?.schema !== WEAPON_MATERIAL_BUILD_SCHEMA) throw new Error("Unsupported weapon material build");
  if (!sourceImage || !coreStyle) throw new Error("Weapon materialization requires a source image and character core style");
  const width = layouts.size?.[0] ?? 96;
  const height = layouts.size?.[1] ?? 96;
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const context = surface.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  context.drawImage(sourceImage, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const attributes = catalog.weapons[build.weaponId].attributes;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    if (pixels.data[offset + 3] === 0) continue;
    const luminance = pixels.data[offset] * 0.2126 + pixels.data[offset + 1] * 0.7152 + pixels.data[offset + 2] * 0.0722;
    if (luminance < 48) continue;
    const pixel = offset / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const region = resolveWeaponRegion(layouts, build.weaponId, x, y, luminance, frame, overrides);
    if (region === "fixed") {
      pixels.data[offset] = 0;
      pixels.data[offset + 1] = 0;
      pixels.data[offset + 2] = 0;
      continue;
    }
    const attribute = attributes.find((candidate) => candidate.region === region && !candidate.finish);
    const linked = attribute?.link === "character.core-light" || region === "core-light";
    const material = catalog.materials[build.attributes[attribute?.id]] ?? catalog.materials.gunmetal;
    let target = linked ? linkedLightPixel(coreStyle, luminance) : materialPixel(material, luminance, x, y);
    if (build.weaponId === "bloom" && region === "shell") target = shellFinish(target, build.attributes["shell-finish"], x, y, luminance);
    pixels.data[offset] = weaponMaterialMix(pixels.data[offset], target[0], 0.9);
    pixels.data[offset + 1] = weaponMaterialMix(pixels.data[offset + 1], target[1], 0.9);
    pixels.data[offset + 2] = weaponMaterialMix(pixels.data[offset + 2], target[2], 0.9);
  }
  context.putImageData(pixels, 0, 0);
  return surface;
}
