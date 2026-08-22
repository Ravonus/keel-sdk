/** Generalized semantic color targets and FX for every raster sprite family. */
export const KEEL_SPRITE_ATTRIBUTE_SCHEMA = "keel-sprite-attributes@1" as const;

export type SpriteRgba = readonly [number, number, number, number];
export type SpriteChannelRange = readonly [number, number];

export interface SpritePixelSelector {
  readonly red: SpriteChannelRange;
  readonly green: SpriteChannelRange;
  readonly blue: SpriteChannelRange;
  readonly alpha: SpriteChannelRange;
}

export interface SpriteSemanticTarget {
  readonly targetId: number;
  readonly name: string;
  readonly selector: SpritePixelSelector;
  readonly priority: number;
  readonly colorSlot?: string;
  readonly effectSlot?: string;
  readonly preserve?: boolean;
}

export interface SpriteTargetMap {
  readonly schema: typeof KEEL_SPRITE_ATTRIBUTE_SCHEMA;
  readonly scope: string;
  readonly unmatched: "preserve";
  readonly targets: readonly SpriteSemanticTarget[];
}

export type SpriteEffectKind =
  | "glow"
  | "pulse"
  | "hue-rotate"
  | "saturate"
  | "brightness"
  | "contrast"
  | "blur"
  | "outline"
  | "dissolve"
  | "afterimage";

export interface SpriteEffectSelection {
  readonly id: string;
  readonly kind: SpriteEffectKind;
  readonly target: string;
  readonly amount: number;
  readonly color?: SpriteRgba;
  readonly speed?: number;
}

export interface AppliedSpriteTargets {
  readonly pixels: Uint8ClampedArray;
  /** One alpha byte per source pixel, keyed by semantic target name. */
  readonly masks: ReadonlyMap<string, Uint8Array>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum = 0, maximum = 0xffff_ffff): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function range(value: unknown, label: string): SpriteChannelRange {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} must be a min/max pair.`);
  const minimum = integer(value[0], `${label}[0]`, 0, 255);
  return [minimum, integer(value[1], `${label}[1]`, minimum, 255)];
}

function selector(value: unknown, label: string): SpritePixelSelector {
  const source = object(value, label);
  return {
    red: range(source.red, `${label}.red`),
    green: range(source.green, `${label}.green`),
    blue: range(source.blue, `${label}.blue`),
    alpha: range(source.alpha ?? [1, 255], `${label}.alpha`),
  };
}

function overlaps(left: SpritePixelSelector, right: SpritePixelSelector): boolean {
  const hit = (a: SpriteChannelRange, b: SpriteChannelRange) => a[0] <= b[1] && b[0] <= a[1];
  return hit(left.red, right.red) && hit(left.green, right.green) && hit(left.blue, right.blue) && hit(left.alpha, right.alpha);
}

export function parseSpriteTargetMap(value: unknown): SpriteTargetMap {
  const source = object(value, "sprite target map");
  if (source.schema !== KEEL_SPRITE_ATTRIBUTE_SCHEMA) throw new TypeError("Unsupported sprite target schema.");
  if (!Array.isArray(source.targets) || source.targets.length > 255) throw new RangeError("Sprite target maps support at most 255 targets.");
  const ids = new Set<number>();
  const names = new Set<string>();
  const targets = source.targets.map((candidate, index): SpriteSemanticTarget => {
    const entry = object(candidate, `sprite target map.targets[${index}]`);
    const targetId = integer(entry.targetId, `sprite target map.targets[${index}].targetId`, 0, 255);
    const name = String(entry.name ?? "").trim();
    if (name.length === 0 || name.length > 64) throw new RangeError("Sprite target names must contain 1 through 64 characters.");
    if (ids.has(targetId) || names.has(name)) throw new RangeError(`Duplicate sprite target ${name}.`);
    ids.add(targetId); names.add(name);
    return {
      targetId,
      name,
      selector: selector(entry.selector, `sprite target map.targets[${index}].selector`),
      priority: integer(entry.priority ?? 0, `sprite target map.targets[${index}].priority`, 0, 255),
      ...(entry.colorSlot === undefined ? {} : { colorSlot: String(entry.colorSlot) }),
      ...(entry.effectSlot === undefined ? {} : { effectSlot: String(entry.effectSlot) }),
      ...(entry.preserve === true ? { preserve: true } : {}),
    };
  }).sort((left, right) => right.priority - left.priority || left.targetId - right.targetId);
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      if (targets[left]!.priority === targets[right]!.priority && overlaps(targets[left]!.selector, targets[right]!.selector)) {
        throw new RangeError(`Sprite targets ${targets[left]!.name} and ${targets[right]!.name} overlap at equal priority.`);
      }
    }
  }
  return { schema: KEEL_SPRITE_ATTRIBUTE_SCHEMA, scope: String(source.scope ?? "sprite"), unmatched: "preserve", targets };
}

function inside(value: number, bounds: SpriteChannelRange): boolean { return value >= bounds[0] && value <= bounds[1]; }

/** Recolors named targets and emits reusable masks for glow/filter/particle FX. */
export function applySpriteTargets(
  sourcePixels: Uint8Array | Uint8ClampedArray,
  mapValue: unknown,
  colors: Readonly<Record<string, SpriteRgba>>,
): AppliedSpriteTargets {
  if (sourcePixels.byteLength === 0 || sourcePixels.byteLength % 4 !== 0) throw new RangeError("Sprite pixels must be non-empty RGBA bytes.");
  const map = parseSpriteTargetMap(mapValue);
  const pixels = new Uint8ClampedArray(sourcePixels);
  const masks = new Map<string, Uint8Array>();
  for (const target of map.targets) if (target.effectSlot !== undefined) masks.set(target.effectSlot, new Uint8Array(pixels.byteLength / 4));
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const target = map.targets.find((candidate) => {
      const match = candidate.selector;
      return inside(pixels[offset]!, match.red) && inside(pixels[offset + 1]!, match.green) && inside(pixels[offset + 2]!, match.blue) && inside(pixels[offset + 3]!, match.alpha);
    });
    if (target === undefined) continue;
    if (target.effectSlot !== undefined) masks.get(target.effectSlot)![offset / 4] = pixels[offset + 3]!;
    const color = target.colorSlot === undefined ? undefined : colors[target.colorSlot];
    if (target.preserve === true || color === undefined) continue;
    const authoredLuminance = (pixels[offset]! * 54 + pixels[offset + 1]! * 183 + pixels[offset + 2]! * 19) / 65_280;
    pixels[offset] = Math.round(color[0] * authoredLuminance);
    pixels[offset + 1] = Math.round(color[1] * authoredLuminance);
    pixels[offset + 2] = Math.round(color[2] * authoredLuminance);
    pixels[offset + 3] = Math.round((pixels[offset + 3]! * color[3]) / 255);
  }
  return { pixels, masks };
}

/** Converts whole-sprite filter effects to a deterministic Canvas filter. FX
 * that need semantic masks (glow, outline, dissolve, afterimage) remain in the
 * returned targeted list for the renderer's compositing pass. */
export function compileSpriteEffects(effects: readonly SpriteEffectSelection[], timeMs = 0): {
  readonly filter: string;
  readonly targeted: readonly SpriteEffectSelection[];
} {
  const filters: string[] = [];
  const targeted: SpriteEffectSelection[] = [];
  for (const effect of effects) {
    if (!Number.isFinite(effect.amount) || effect.amount < 0) throw new RangeError(`Invalid effect amount for ${effect.id}.`);
    const phase = effect.kind === "pulse" ? 0.5 + 0.5 * Math.sin(timeMs * (effect.speed ?? 0.004)) : 1;
    if (effect.target !== "sprite" || ["glow", "outline", "dissolve", "afterimage"].includes(effect.kind)) {
      targeted.push(effect); continue;
    }
    if (effect.kind === "hue-rotate") filters.push(`hue-rotate(${effect.amount * phase}deg)`);
    else if (effect.kind === "blur") filters.push(`blur(${effect.amount * phase}px)`);
    else if (effect.kind === "saturate" || effect.kind === "brightness" || effect.kind === "contrast") filters.push(`${effect.kind}(${effect.amount * phase})`);
    else if (effect.kind === "pulse") filters.push(`brightness(${1 + effect.amount * phase})`);
    else targeted.push(effect);
  }
  return { filter: filters.length === 0 ? "none" : filters.join(" "), targeted };
}
