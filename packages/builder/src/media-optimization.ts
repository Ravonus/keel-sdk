import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIntegrity, type Integrity } from "@keel/protocol";
import type { MediaKind } from "./pipeline.js";

const DEFAULT_QUALITY = 82;
const DEFAULT_EFFORT = 6;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const SHARP_INPUT_MEDIA_TYPES = new Set(["image/avif", "image/jpeg", "image/png", "image/webp"]);

export type MediaOptimizationCapabilityKind = "image" | "video" | "model";

export interface MediaOptimizationCapability {
  readonly kind: MediaOptimizationCapabilityKind;
  readonly adapter: "sharp-webp" | "none";
  readonly available: boolean;
  readonly reason?: string;
  readonly version?: string;
}

export interface MediaOptimizationPlanOptions {
  readonly input: string;
  readonly mediaType?: string;
  readonly quality?: number;
  readonly effort?: number;
  readonly maxInputBytes?: number;
  /** Informational only. Optimization never changes the selected publication mode. */
  readonly selectedStorageMode?: string;
}

export interface MediaOptimizationPlan {
  readonly schema: "keel-media-optimization-plan@1";
  readonly mode: "dry-run";
  readonly status: "ready-for-explicit-apply" | "candidate-not-smaller" | "unavailable";
  readonly input: {
    readonly path: string;
    readonly fileName: string;
    readonly mediaType: string;
    readonly kind: MediaKind;
    readonly beforeBytes: number;
    readonly integrity: Integrity;
  };
  readonly output: {
    readonly mediaType: "image/webp";
    readonly extension: ".webp";
    readonly integrity: Integrity;
  } | null;
  readonly measurements: {
    readonly beforeBytes: number;
    readonly afterBytes: number | null;
    readonly savedBytes: number | null;
    readonly percentSaved: number | null;
    readonly smaller: boolean | null;
    readonly state: "measured-in-memory" | "unavailable";
  };
  readonly settings: {
    readonly quality: number;
    readonly effort: number;
  } | null;
  readonly capability: MediaOptimizationCapability;
  readonly sourceRetention: {
    readonly policy: "preserve-source";
    readonly sourceRemoved: false;
  };
  readonly storage: {
    readonly selectedMode: string | null;
    readonly changed: false;
  };
}

export interface ApplyMediaOptimizationOptions {
  readonly plan: MediaOptimizationPlan;
  /** A new output path. Existing files and the input path are rejected. */
  readonly output: string;
}

export interface AppliedMediaOptimization {
  readonly schema: "keel-media-optimization-result@1";
  readonly mode: "explicit-apply";
  readonly status: "completed";
  readonly input: MediaOptimizationPlan["input"];
  readonly output: {
    readonly path: string;
    readonly mediaType: "image/webp";
    readonly integrity: Integrity;
  };
  readonly measurements: {
    readonly beforeBytes: number;
    readonly afterBytes: number;
    readonly savedBytes: number;
    readonly percentSaved: number;
  };
  readonly settings: NonNullable<MediaOptimizationPlan["settings"]>;
  readonly capability: MediaOptimizationCapability;
  readonly sourceRetention: {
    readonly policy: "preserve-source";
    readonly sourceRemoved: false;
    readonly sourceIntegrity: Integrity;
  };
  readonly storage: MediaOptimizationPlan["storage"];
}

interface SharpImage {
  webp(options: { quality: number; effort: number }): SharpImage;
  toBuffer(): Promise<Uint8Array>;
}

interface SharpFactory {
  (input: string | Uint8Array): SharpImage;
  readonly versions?: { readonly sharp?: string };
}

interface StableInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly integrity: Integrity;
}

interface SharpResolution {
  readonly available: boolean;
  readonly factory?: SharpFactory;
  readonly version?: string;
}

interface ImageCandidate {
  readonly bytes: Uint8Array;
  readonly integrity: Integrity;
}

function assertByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("maxInputBytes must be a positive safe integer.");
  return limit;
}

function assertQuality(value: number | undefined): number {
  const quality = value ?? DEFAULT_QUALITY;
  if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100) throw new RangeError("quality must be an integer from 1 through 100.");
  return quality;
}

function assertEffort(value: number | undefined): number {
  const effort = value ?? DEFAULT_EFFORT;
  if (!Number.isSafeInteger(effort) || effort < 0 || effort > 6) throw new RangeError("effort must be an integer from 0 through 6.");
  return effort;
}

function assertMediaType(value: string): string {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("mediaType must be non-empty text without control characters.");
  return value;
}

function mediaTypeFor(input: string, override: string | undefined): string {
  return assertMediaType(override ?? MEDIA_TYPES[path.extname(input).toLowerCase()] ?? "application/octet-stream");
}

function mediaKind(mediaType: string): MediaKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("model/") || mediaType.includes("gltf")) return "model";
  if (mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.includes("javascript")) return "text";
  return "binary";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function stableRegularInput(input: string, maxInputBytes: number): Promise<StableInput> {
  const requested = path.resolve(input);
  const entries = await readdir(path.dirname(requested), { withFileTypes: true });
  const entry = entries.find((candidate) => candidate.name === path.basename(requested));
  if (entry === undefined) throw new TypeError("input must be a regular non-symlink file.");
  if (!entry.isFile() || entry.isSymbolicLink()) throw new TypeError("input must be a regular non-symlink file.");
  const resolved = await realpath(requested);
  const before = await stat(resolved);
  if (!before.isFile() || before.size <= 0 || before.size > maxInputBytes) {
    throw new RangeError(`input must be from 1 through ${maxInputBytes} bytes.`);
  }
  const bytes = new Uint8Array(await readFile(resolved));
  const secondRead = new Uint8Array(await readFile(resolved));
  const after = await stat(resolved);
  if (!bytesEqual(bytes, secondRead) || bytes.byteLength !== before.size || bytes.byteLength !== after.size || (await realpath(requested)) !== resolved) {
    throw new Error("input changed while it was being read.");
  }
  return { path: resolved, bytes, integrity: await createIntegrity(bytes) };
}

async function resolveSharp(): Promise<SharpResolution> {
  try {
    const module = await import("sharp");
    const factory = module.default as SharpFactory;
    if (typeof factory !== "function") return { available: false };
    return { available: true, factory, ...(factory.versions?.sharp === undefined ? {} : { version: factory.versions.sharp }) };
  } catch {
    return { available: false };
  }
}

function unavailableCapability(kind: Exclude<MediaOptimizationCapabilityKind, "image">): MediaOptimizationCapability {
  return {
    kind,
    adapter: "none",
    available: false,
    reason: kind === "video"
      ? "Video optimization is unavailable because this SDK does not pin a video transcoder."
      : "3D optimization is unavailable because this SDK does not pin a glTF transform toolchain.",
  };
}

async function imageCapability(mediaType: string): Promise<MediaOptimizationCapability> {
  if (!SHARP_INPUT_MEDIA_TYPES.has(mediaType)) {
    return {
      kind: "image",
      adapter: "none",
      available: false,
      reason: "Only AVIF, JPEG, PNG, and WebP input are supported by the loss-aware WebP adapter; animated or vector input is not silently flattened.",
    };
  }
  const sharp = await resolveSharp();
  return sharp.available
    ? { kind: "image", adapter: "sharp-webp", available: true, ...(sharp.version === undefined ? {} : { version: sharp.version }) }
    : { kind: "image", adapter: "sharp-webp", available: false, reason: "The optional sharp image encoder is not installed for this SDK environment." };
}

/** Reports only repository-supported adapters. Machine-local ffmpeg/gltf tools are intentionally ignored. */
export async function detectMediaOptimizationCapabilities(): Promise<readonly MediaOptimizationCapability[]> {
  const sharp = await resolveSharp();
  return [
    sharp.available
      ? { kind: "image", adapter: "sharp-webp", available: true, ...(sharp.version === undefined ? {} : { version: sharp.version }) }
      : { kind: "image", adapter: "sharp-webp", available: false, reason: "The optional sharp image encoder is not installed for this SDK environment." },
    unavailableCapability("video"),
    unavailableCapability("model"),
  ];
}

/**
 * Read and describe one immutable source without writing anything. The plan is
 * deterministic for stable source bytes and makes no storage-mode decision.
 */
export async function planMediaOptimization(options: MediaOptimizationPlanOptions): Promise<MediaOptimizationPlan> {
  const source = await stableRegularInput(options.input, assertByteLimit(options.maxInputBytes));
  const mediaType = mediaTypeFor(source.path, options.mediaType);
  const kind = mediaKind(mediaType);
  const quality = assertQuality(options.quality);
  const effort = assertEffort(options.effort);
  const capability: MediaOptimizationCapability = kind === "image"
    ? await imageCapability(mediaType)
    : kind === "video"
      ? unavailableCapability("video")
      : kind === "model"
        ? unavailableCapability("model")
        : { kind: "image", adapter: "none", available: false, reason: `No media optimizer is available for ${mediaType}.` };
  const supported = capability.available && capability.adapter === "sharp-webp";
  const settings = supported ? { quality, effort } : null;
  const sharp = supported ? await resolveSharp() : undefined;
  if (supported && (sharp?.available !== true || sharp.factory === undefined)) {
    throw new Error("The reviewed sharp image adapter became unavailable while measuring the candidate.");
  }
  const candidate = supported && sharp?.factory !== undefined
    ? await imageCandidate(sharp.factory, source.bytes, settings!)
    : null;
  const afterBytes = candidate?.bytes.byteLength ?? null;
  const savedBytes = afterBytes === null ? null : source.bytes.byteLength - afterBytes;
  const smaller = savedBytes === null ? null : savedBytes > 0;
  return {
    schema: "keel-media-optimization-plan@1",
    mode: "dry-run",
    status: !supported ? "unavailable" : smaller ? "ready-for-explicit-apply" : "candidate-not-smaller",
    input: {
      path: source.path,
      fileName: path.basename(source.path),
      mediaType,
      kind,
      beforeBytes: source.bytes.byteLength,
      integrity: source.integrity,
    },
    output: candidate === null ? null : { mediaType: "image/webp", extension: ".webp", integrity: candidate.integrity },
    measurements: {
      beforeBytes: source.bytes.byteLength,
      afterBytes,
      savedBytes,
      percentSaved: afterBytes === null ? null : percentSaved(source.bytes.byteLength, afterBytes),
      smaller,
      state: candidate === null ? "unavailable" : "measured-in-memory",
    },
    settings,
    capability,
    sourceRetention: { policy: "preserve-source", sourceRemoved: false },
    storage: { selectedMode: options.selectedStorageMode ?? null, changed: false },
  };
}

function percentSaved(beforeBytes: number, afterBytes: number): number {
  return Math.round(((beforeBytes - afterBytes) / beforeBytes) * 10_000) / 100;
}

async function imageCandidate(factory: SharpFactory, sourceBytes: Uint8Array, settings: { readonly quality: number; readonly effort: number }): Promise<ImageCandidate> {
  const bytes = new Uint8Array(await factory(sourceBytes).webp(settings).toBuffer());
  if (bytes.byteLength < 12 || new TextDecoder("ascii").decode(bytes.subarray(0, 4)) !== "RIFF" || new TextDecoder("ascii").decode(bytes.subarray(8, 12)) !== "WEBP") {
    throw new Error("The image adapter did not produce valid WebP bytes.");
  }
  return { bytes, integrity: await createIntegrity(bytes) };
}

async function outputIsNewRegularPath(output: string, input: string): Promise<string> {
  const requested = path.resolve(output);
  if (requested === input) throw new TypeError("output must be a new path; the source is always retained.");
  if (path.extname(requested).toLowerCase() !== ".webp") throw new TypeError("output must use the .webp extension.");
  await mkdir(path.dirname(requested), { recursive: true });
  const entries = await readdir(path.dirname(requested), { withFileTypes: true });
  if (entries.some((entry) => entry.name === path.basename(requested))) throw new TypeError("output already exists; choose a new path so optimization stays reversible.");
  return requested;
}

function assertReadyPlan(plan: MediaOptimizationPlan): asserts plan is MediaOptimizationPlan & {
  readonly status: "ready-for-explicit-apply";
  readonly output: { readonly mediaType: "image/webp"; readonly extension: ".webp"; readonly integrity: Integrity };
  readonly settings: { readonly quality: number; readonly effort: number };
  readonly measurements: MediaOptimizationPlan["measurements"] & {
    readonly afterBytes: number;
    readonly savedBytes: number;
    readonly percentSaved: number;
    readonly smaller: true;
    readonly state: "measured-in-memory";
  };
} {
  if (
    plan.schema !== "keel-media-optimization-plan@1" || plan.mode !== "dry-run"
      || plan.status !== "ready-for-explicit-apply" || plan.output === null || plan.settings === null
      || plan.capability.adapter !== "sharp-webp" || plan.measurements.state !== "measured-in-memory"
      || plan.measurements.afterBytes === null || plan.measurements.savedBytes === null
      || plan.measurements.percentSaved === null || plan.measurements.smaller !== true
  ) {
    throw new TypeError("A measured, smaller dry-run image candidate is required before applying output.");
  }
}

/**
 * Materialize one explicit image conversion. It refuses source overwrite,
 * retains the original bytes, and rechecks their digest before returning.
 */
export async function applyMediaOptimization(options: ApplyMediaOptimizationOptions): Promise<AppliedMediaOptimization> {
  const plan = options.plan;
  assertReadyPlan(plan);
  const source = await stableRegularInput(plan.input.path, DEFAULT_MAX_INPUT_BYTES);
  if (source.integrity.digest !== plan.input.integrity.digest || source.integrity.byteLength !== plan.input.integrity.byteLength) {
    throw new Error("input no longer matches the reviewed optimization plan; plan again before applying.");
  }
  const output = await outputIsNewRegularPath(options.output, source.path);
  const sharp = await resolveSharp();
  if (!sharp.available || sharp.factory === undefined) throw new Error("The reviewed sharp image adapter is unavailable; no output was written.");
  const candidate = await imageCandidate(sharp.factory, source.bytes, plan.settings);
  const outputBytes = candidate.bytes;
  if (
    candidate.integrity.digest !== plan.output.integrity.digest
      || candidate.integrity.byteLength !== plan.output.integrity.byteLength
      || outputBytes.byteLength !== plan.measurements.afterBytes
  ) {
    throw new Error("The image candidate no longer matches the reviewed dry-run measurement; plan again before applying.");
  }
  // Exclusive creation keeps the explicit output path reversible under races.
  await writeFile(output, outputBytes, { flag: "wx" });
  const afterSource = await stableRegularInput(source.path, DEFAULT_MAX_INPUT_BYTES);
  if (afterSource.integrity.digest !== source.integrity.digest || afterSource.integrity.byteLength !== source.integrity.byteLength) {
    await rm(output, { force: true });
    throw new Error("input changed during optimization; the new output was discarded.");
  }
  const afterBytes = outputBytes.byteLength;
  return {
    schema: "keel-media-optimization-result@1",
    mode: "explicit-apply",
    status: "completed",
    input: plan.input,
    output: { path: output, mediaType: "image/webp", integrity: candidate.integrity },
    measurements: {
      beforeBytes: source.bytes.byteLength,
      afterBytes,
      savedBytes: source.bytes.byteLength - afterBytes,
      percentSaved: percentSaved(source.bytes.byteLength, afterBytes),
    },
    settings: plan.settings,
    capability: { ...plan.capability, ...(sharp.version === undefined ? {} : { version: sharp.version }) },
    sourceRetention: { policy: "preserve-source", sourceRemoved: false, sourceIntegrity: afterSource.integrity },
    storage: plan.storage,
  };
}
