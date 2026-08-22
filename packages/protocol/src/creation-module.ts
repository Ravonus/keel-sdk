import type { Hex } from "./types.js";

export const KEEL_CREATION_MODULE_PROTOCOL = "keel-creation-module@1" as const;
export const KEEL_CREATION_BINDING_PROTOCOL = "keel-creation-binding@1" as const;
export const KEEL_CREATION_PLUGIN_PROTOCOL = "keel-creation-plugin@1" as const;
export const KEEL_CREATION_MODULE_MEDIA_TYPE = "application/vnd.keel.creation-module+json" as const;

export type KeelCreationPrompt =
  | {
      readonly id: string;
      readonly type: "short-text" | "long-text";
      readonly label: string;
      readonly help?: string;
      readonly target: "artifact.name" | "artifact.description" | `configuration.${string}`;
      readonly required: boolean;
      readonly placeholder?: string;
      readonly maxLength: number;
      readonly default?: string;
    }
  | {
      readonly id: string;
      readonly type: "choice";
      readonly label: string;
      readonly help?: string;
      readonly target: `configuration.${string}`;
      readonly required: boolean;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly default?: string;
    }
  | {
      readonly id: string;
      readonly type: "toggle";
      readonly label: string;
      readonly help?: string;
      readonly target: `configuration.${string}`;
      readonly required: boolean;
      readonly default: boolean;
    }
  | {
      readonly id: string;
      readonly type: "number";
      readonly label: string;
      readonly help?: string;
      readonly target: `configuration.${string}`;
      readonly required: boolean;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly default?: number;
    }
  | {
      readonly id: string;
      readonly type: "color";
      readonly label: string;
      readonly help?: string;
      readonly target: `configuration.${string}`;
      readonly required: boolean;
      readonly default?: `#${string}`;
    }
  | {
      readonly id: string;
      readonly type: "files";
      readonly label: string;
      readonly help?: string;
      readonly target: "artifact.resources";
      readonly required: boolean;
      readonly accept: readonly string[];
      readonly minFiles: number;
      readonly maxFiles: number;
      readonly directory: boolean;
    };

/**
 * A non-executable, strictly bounded UI contract for one creator module.
 * The exact JSON bytes are stored as a versioned Keel Library item.
 */
export interface KeelCreationModuleManifest {
  readonly protocol: typeof KEEL_CREATION_MODULE_PROTOCOL;
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly category: "artwork" | "interactive" | "generative" | "game" | "audio" | "tool";
  readonly plugin: {
    readonly protocol: typeof KEEL_CREATION_PLUGIN_PROTOCOL;
    /** A small, audited renderer shipped by Studio. Manifest bytes never inject UI code. */
    readonly renderer: "studio.standard-project@1" | "studio.seeded-character@1";
  };
  readonly prompts: readonly KeelCreationPrompt[];
  readonly output: {
    readonly storageStrategy: "onchain" | "hybrid";
    readonly marketplaceExportMode: "recursive" | "hybrid" | "onchfs";
    readonly generatePreview: true;
    readonly thumbnail: {
      readonly mode: "signal" | "after-init" | "time";
      readonly delayMs: number;
      readonly durationMs: number;
      readonly frameRate: number;
    };
  };
}

export interface KeelCreationBinding {
  readonly protocol: typeof KEEL_CREATION_BINDING_PROTOCOL;
  readonly chainId: number;
  readonly libraryRegistry: string;
  readonly assetId: Hex;
  readonly policyVersion: number;
  readonly policyCommitment: Hex;
  readonly graphId: Hex;
  readonly graphVersion: number;
  readonly resourceGraphDigest: Hex;
  readonly graphRegistry: string;
  readonly moduleManifest: {
    readonly store: string;
    readonly objectId: Hex;
    readonly digest: Hex;
  };
  readonly moduleResource: {
    readonly resourceId: string;
    readonly digest: Hex;
    readonly byteLength: number;
    readonly mediaType: typeof KEEL_CREATION_MODULE_MEDIA_TYPE;
    readonly logicalObject: {
      readonly registry: string;
      readonly objectId: Hex;
      readonly revision: number;
      readonly linkRegistry: string;
    };
    readonly carrier: {
      readonly store: string;
      readonly objectId: Hex;
    };
  };
  readonly moduleId: string;
  readonly moduleVersion: number;
  readonly answers: Readonly<Record<string, string | number | boolean>>;
}

const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const TARGET = /^configuration\.[a-z][a-z0-9.-]{0,95}$/u;
const COLOR = /^#[0-9a-f]{6}$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const BYTES32 = /^0x[0-9a-f]{64}$/u;
const CATEGORIES = new Set(["artwork", "interactive", "generative", "game", "audio", "tool"]);
const STORAGE_STRATEGIES = new Set(["onchain", "hybrid"]);
const EXPORT_MODES = new Set(["recursive", "hybrid", "onchfs"]);
const PLUGIN_RENDERERS = new Set(["studio.standard-project@1", "studio.seeded-character@1"]);
const THUMBNAIL_MODES = new Set(["signal", "after-init", "time"]);
const ACCEPT = /^(?:\.[a-z0-9][a-z0-9.+_-]{0,31}|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}))$/iu;

function boundedText(value: string, label: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
}

export function assertValidKeelCreationModule(value: KeelCreationModuleManifest): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Creation module must be an object.");
  if (value.protocol !== KEEL_CREATION_MODULE_PROTOCOL) throw new TypeError("Unsupported Keel creation module.");
  if (!ID.test(value.id) || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new TypeError("Creation module identity is invalid.");
  }
  boundedText(value.title, "Creation module title", 96);
  boundedText(value.summary, "Creation module summary", 320);
  if (!CATEGORIES.has(value.category)) throw new TypeError("Creation module category is invalid.");
  if (
    value.plugin?.protocol !== KEEL_CREATION_PLUGIN_PROTOCOL
    || !PLUGIN_RENDERERS.has(value.plugin.renderer)
  ) {
    throw new TypeError("Creation module plugin renderer is unsupported.");
  }
  if (
    !STORAGE_STRATEGIES.has(value.output?.storageStrategy)
    || !EXPORT_MODES.has(value.output?.marketplaceExportMode)
    || value.output?.generatePreview !== true
  ) {
    throw new TypeError("Creation module output policy is invalid.");
  }
  if (value.prompts.length < 2 || value.prompts.length > 24) throw new RangeError("Creation modules need 2 through 24 prompts.");
  const ids = new Set<string>();
  const targets = new Set<string>();
  let nameFields = 0;
  let resourceFields = 0;
  for (const [index, prompt] of value.prompts.entries()) {
    const label = `prompts[${index}]`;
    if (!ID.test(prompt.id) || ids.has(prompt.id)) throw new TypeError(`${label}.id must be valid and unique.`);
    ids.add(prompt.id);
    if (targets.has(prompt.target)) throw new TypeError(`${label}.target must be unique.`);
    targets.add(prompt.target);
    boundedText(prompt.label, `${label}.label`, 96);
    if (typeof prompt.required !== "boolean") throw new TypeError(`${label}.required must be boolean.`);
    if (prompt.help !== undefined) boundedText(prompt.help, `${label}.help`, 320);
    if (prompt.target === "artifact.name") nameFields += 1;
    if (prompt.target === "artifact.resources") resourceFields += 1;
    if (prompt.target.startsWith("configuration.") && !TARGET.test(prompt.target)) throw new TypeError(`${label}.target is invalid.`);
    if (prompt.type === "short-text" || prompt.type === "long-text") {
      if (prompt.target !== "artifact.name" && prompt.target !== "artifact.description" && !TARGET.test(prompt.target)) {
        throw new TypeError(`${label}.target is not valid for text.`);
      }
      if (prompt.target === "artifact.name" && prompt.type !== "short-text") throw new TypeError(`${label}.artifact name must be short text.`);
      const maximum = prompt.type === "short-text" ? 160 : 4_000;
      if (!Number.isSafeInteger(prompt.maxLength) || prompt.maxLength < 1 || prompt.maxLength > maximum) {
        throw new RangeError(`${label}.maxLength is invalid.`);
      }
      if (prompt.default !== undefined && (typeof prompt.default !== "string" || prompt.default.length > prompt.maxLength)) throw new RangeError(`${label}.default is invalid.`);
      if (prompt.placeholder !== undefined) boundedText(prompt.placeholder, `${label}.placeholder`, 160);
    } else if (prompt.type === "choice") {
      if (!TARGET.test(prompt.target)) throw new TypeError(`${label}.target is not valid for a choice.`);
      if (prompt.options.length < 2 || prompt.options.length > 24) throw new RangeError(`${label}.options is invalid.`);
      const values = new Set<string>();
      for (const option of prompt.options) {
        if (!ID.test(option.value) || values.has(option.value)) throw new TypeError(`${label} option values must be valid and unique.`);
        values.add(option.value);
        boundedText(option.label, `${label} option label`, 80);
      }
      if (prompt.default !== undefined && !values.has(prompt.default)) throw new TypeError(`${label}.default is not an option.`);
    } else if (prompt.type === "toggle") {
      if (!TARGET.test(prompt.target)) throw new TypeError(`${label}.target is not valid for a toggle.`);
      if (typeof prompt.default !== "boolean") throw new TypeError(`${label}.default must be boolean.`);
    } else if (prompt.type === "number") {
      if (!TARGET.test(prompt.target)) throw new TypeError(`${label}.target is not valid for a number.`);
      if (![prompt.min, prompt.max, prompt.step].every(Number.isFinite) || prompt.min > prompt.max || prompt.step <= 0) {
        throw new RangeError(`${label} numeric range is invalid.`);
      }
      if (prompt.default !== undefined && (prompt.default < prompt.min || prompt.default > prompt.max)) {
        throw new RangeError(`${label}.default is outside its range.`);
      }
      if (prompt.default !== undefined && Math.abs(((prompt.default - prompt.min) / prompt.step) - Math.round((prompt.default - prompt.min) / prompt.step)) > 1e-9) {
        throw new RangeError(`${label}.default does not align to its step.`);
      }
    } else if (prompt.type === "color") {
      if (!TARGET.test(prompt.target)) throw new TypeError(`${label}.target is not valid for a color.`);
      if (prompt.default !== undefined && !COLOR.test(prompt.default)) throw new TypeError(`${label}.default must be a lower-case hex color.`);
    } else if (prompt.type === "files") {
      if (prompt.target !== "artifact.resources") throw new TypeError(`${label}.target is not valid for files.`);
      if (!Number.isSafeInteger(prompt.minFiles) || !Number.isSafeInteger(prompt.maxFiles) || prompt.minFiles < 0 || prompt.maxFiles < Math.max(1, prompt.minFiles) || prompt.maxFiles > 256) {
        throw new RangeError(`${label} file count is invalid.`);
      }
      if (prompt.accept.length === 0 || prompt.accept.length > 32 || prompt.accept.some((item) => typeof item !== "string" || !ACCEPT.test(item))) {
        throw new TypeError(`${label}.accept is invalid.`);
      }
      if (typeof prompt.directory !== "boolean") throw new TypeError(`${label}.directory must be boolean.`);
    } else {
      throw new TypeError(`${label}.type is unsupported.`);
    }
  }
  if (nameFields !== 1 || resourceFields !== 1) {
    throw new TypeError("A creation module must declare exactly one artifact name prompt and one resource prompt.");
  }
  const thumbnail = value.output.thumbnail;
  if (
    !THUMBNAIL_MODES.has(thumbnail?.mode) ||
    !Number.isSafeInteger(thumbnail.delayMs) || thumbnail.delayMs < 0 || thumbnail.delayMs > 30_000 ||
    !Number.isSafeInteger(thumbnail.durationMs) || thumbnail.durationMs < 0 || thumbnail.durationMs > 30_000 ||
    !Number.isSafeInteger(thumbnail.frameRate) || thumbnail.frameRate < 1 || thumbnail.frameRate > 60
  ) {
    throw new RangeError("Creation module thumbnail settings are invalid.");
  }
}

export function assertValidKeelCreationBinding(value: KeelCreationBinding): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Creation binding must be an object.");
  if (value.protocol !== KEEL_CREATION_BINDING_PROTOCOL) throw new TypeError("Unsupported Keel creation binding.");
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0) throw new TypeError("Creation binding chain is invalid.");
  for (const [label, candidate] of [
    ["library registry", value.libraryRegistry],
    ["graph registry", value.graphRegistry],
    ["manifest store", value.moduleManifest?.store],
    ["resource object registry", value.moduleResource?.logicalObject?.registry],
    ["resource link registry", value.moduleResource?.logicalObject?.linkRegistry],
    ["resource carrier", value.moduleResource?.carrier?.store],
  ] as const) {
    if (typeof candidate !== "string" || !ADDRESS.test(candidate)) throw new TypeError(`Creation binding ${label} is invalid.`);
  }
  for (const [label, candidate] of [
    ["asset ID", value.assetId],
    ["policy commitment", value.policyCommitment],
    ["graph ID", value.graphId],
    ["resource graph digest", value.resourceGraphDigest],
    ["manifest object ID", value.moduleManifest?.objectId],
    ["manifest digest", value.moduleManifest?.digest],
    ["resource logical object ID", value.moduleResource?.logicalObject?.objectId],
    ["resource carrier object ID", value.moduleResource?.carrier?.objectId],
    ["resource digest", value.moduleResource?.digest],
  ] as const) {
    if (typeof candidate !== "string" || !BYTES32.test(candidate)) throw new TypeError(`Creation binding ${label} is invalid.`);
  }
  if (
    !Number.isSafeInteger(value.policyVersion) || value.policyVersion < 1
    || !Number.isSafeInteger(value.graphVersion) || value.graphVersion < 1
    || !Number.isSafeInteger(value.moduleResource?.logicalObject?.revision) || value.moduleResource.logicalObject.revision < 1
    || !Number.isSafeInteger(value.moduleResource?.byteLength) || value.moduleResource.byteLength < 1
    || value.moduleResource?.mediaType !== KEEL_CREATION_MODULE_MEDIA_TYPE
    || typeof value.moduleResource?.resourceId !== "string" || !ID.test(value.moduleResource.resourceId)
    || !ID.test(value.moduleId)
    || !Number.isSafeInteger(value.moduleVersion) || value.moduleVersion < 1
  ) {
    throw new TypeError("Creation binding version or resource metadata is invalid.");
  }
  if (value.answers === null || typeof value.answers !== "object" || Array.isArray(value.answers)) {
    throw new TypeError("Creation binding answers must be an object.");
  }
  const entries = Object.entries(value.answers);
  if (entries.length > 23) throw new RangeError("Creation binding has too many answers.");
  for (const [key, answer] of entries) {
    if (!ID.test(key)) throw new TypeError("Creation binding answer ID is invalid.");
    if (typeof answer === "string") {
      if (answer.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(answer)) throw new TypeError("Creation binding text answer is invalid.");
    } else if (typeof answer === "number") {
      if (!Number.isFinite(answer)) throw new TypeError("Creation binding number answer is invalid.");
    } else if (typeof answer !== "boolean") {
      throw new TypeError("Creation binding answers must be text, numbers, or booleans.");
    }
  }
}

export function validateKeelCreationAnswers(
  manifest: KeelCreationModuleManifest,
  answers: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> {
  assertValidKeelCreationModule(manifest);
  const known = new Set(manifest.prompts.filter((prompt) => prompt.type !== "files").map((prompt) => prompt.id));
  if (Object.keys(answers).some((key) => !known.has(key))) throw new TypeError("Creation answers contain an undeclared prompt.");
  const normalized: Record<string, string | number | boolean> = {};
  for (const prompt of manifest.prompts) {
    if (prompt.type === "files") continue;
    const raw = answers[prompt.id] ?? prompt.default;
    if (raw === undefined || raw === "" || (typeof raw === "string" && raw.trim().length === 0)) {
      if (prompt.required) throw new TypeError(`${prompt.label} is required.`);
      continue;
    }
    if (prompt.type === "short-text" || prompt.type === "long-text") {
      if (typeof raw !== "string" || raw.length > prompt.maxLength) throw new TypeError(`${prompt.label} is invalid.`);
      normalized[prompt.id] = raw.trim();
    } else if (prompt.type === "choice") {
      if (typeof raw !== "string" || !prompt.options.some((option) => option.value === raw)) throw new TypeError(`${prompt.label} is invalid.`);
      normalized[prompt.id] = raw;
    } else if (prompt.type === "toggle") {
      if (typeof raw !== "boolean") throw new TypeError(`${prompt.label} is invalid.`);
      normalized[prompt.id] = raw;
    } else if (prompt.type === "number") {
      if (
        typeof raw !== "number" || !Number.isFinite(raw) || raw < prompt.min || raw > prompt.max
        || Math.abs(((raw - prompt.min) / prompt.step) - Math.round((raw - prompt.min) / prompt.step)) > 1e-9
      ) throw new TypeError(`${prompt.label} is invalid.`);
      normalized[prompt.id] = raw;
    } else {
      if (typeof raw !== "string" || !COLOR.test(raw)) throw new TypeError(`${prompt.label} is invalid.`);
      normalized[prompt.id] = raw;
    }
  }
  return normalized;
}
