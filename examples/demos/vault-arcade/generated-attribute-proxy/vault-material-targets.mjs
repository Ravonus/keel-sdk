export const VAULT_MATERIAL_REGIONS = Object.freeze([
  { id: 0, name: "transparent", color: [0, 0, 0, 0], editable: false },
  { id: 1, name: "locked-outline", color: [19, 23, 27, 255], editable: false },
  { id: 2, name: "seam", color: [82, 65, 126, 255], editable: true },
  { id: 3, name: "armor-dark", color: [35, 106, 164, 255], editable: true },
  { id: 4, name: "armor-mid", color: [46, 190, 137, 255], editable: true },
  { id: 5, name: "armor-light", color: [241, 191, 75, 255], editable: true },
  { id: 6, name: "highlight", color: [248, 239, 213, 255], editable: true },
  { id: 7, name: "emissive-core", color: [255, 0, 255, 255], editable: true },
]);

const REGION_BY_ID = new Map(VAULT_MATERIAL_REGIONS.map((region) => [region.id, region]));
const REGION_ID_BY_COLOR = new Map(VAULT_MATERIAL_REGIONS.map((region) => [region.color.slice(0, 3).join(","), region.id]));

export function pixelLuminance(red, green, blue) {
  return Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
}

export function classifyVaultMaterial(red, green, blue, alpha) {
  if (alpha < 24) return 0;
  if (red > 135 && blue > 105 && green < 105 && red + blue > green * 3.1) return 7;
  const luminance = pixelLuminance(red, green, blue);
  if (luminance < 28) return 1;
  if (luminance < 61) return 2;
  if (luminance < 101) return 3;
  if (luminance < 151) return 4;
  if (luminance < 211) return 5;
  return 6;
}

export function materialIdColor(id) {
  return REGION_BY_ID.get(id)?.color ?? [255, 0, 0, 255];
}

export function materialIdFromColor(red, green, blue, alpha = 255) {
  if (alpha < 24) return 0;
  return REGION_ID_BY_COLOR.get(`${red},${green},${blue}`) ?? 0;
}

export function materialTargetPixels(sourcePixels) {
  const output = new Uint8ClampedArray(sourcePixels.length);
  for (let offset = 0; offset < sourcePixels.length; offset += 4) {
    const id = classifyVaultMaterial(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2], sourcePixels[offset + 3]);
    const color = materialIdColor(id);
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
    output[offset + 3] = id === 0 ? 0 : sourcePixels[offset + 3];
  }
  return output;
}

function rampColor(base, luminance, minimum = 0.32, maximum = 1.18) {
  const factor = minimum + (maximum - minimum) * (luminance / 255);
  return base.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor))));
}

export function recolorVaultMaterialPixels(sourcePixels, palette) {
  const output = new Uint8ClampedArray(sourcePixels.length);
  for (let offset = 0; offset < sourcePixels.length; offset += 4) {
    const alpha = sourcePixels[offset + 3];
    const id = classifyVaultMaterial(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2], alpha);
    if (id === 0) continue;
    const luminance = pixelLuminance(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2]);
    const region = REGION_BY_ID.get(id);
    const base = palette[region.name] ?? region.color.slice(0, 3);
    const color = id === 1 ? [10, 12, 14] : id === 7 ? rampColor(base, Math.max(luminance, 155), 0.68, 1.34) : rampColor(base, luminance);
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
    output[offset + 3] = alpha;
  }
  return output;
}

export function recolorVaultMaterialMapPixels(sourcePixels, materialMapPixels, palette) {
  if (sourcePixels.length !== materialMapPixels.length) throw new Error("Vault source and material map sizes must match");
  const output = new Uint8ClampedArray(sourcePixels.length);
  for (let offset = 0; offset < sourcePixels.length; offset += 4) {
    const alpha = sourcePixels[offset + 3];
    const id = materialIdFromColor(materialMapPixels[offset], materialMapPixels[offset + 1], materialMapPixels[offset + 2], materialMapPixels[offset + 3]);
    if (id === 0 || alpha < 24) continue;
    const luminance = pixelLuminance(sourcePixels[offset], sourcePixels[offset + 1], sourcePixels[offset + 2]);
    const region = REGION_BY_ID.get(id);
    const base = palette[region.name] ?? region.color.slice(0, 3);
    const color = id === 1 ? [10, 12, 14] : id === 7 ? rampColor(base, Math.max(luminance, 155), 0.68, 1.34) : rampColor(base, luminance);
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
    output[offset + 3] = alpha;
  }
  return output;
}

export const FORGE_DRIFTER_PROOF_PALETTE = Object.freeze({
  seam: [71, 38, 117],
  "armor-dark": [19, 67, 103],
  "armor-mid": [20, 161, 126],
  "armor-light": [237, 155, 44],
  highlight: [255, 244, 208],
  "emissive-core": [255, 44, 210],
});
