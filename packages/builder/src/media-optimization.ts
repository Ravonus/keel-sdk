import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune } from "@gltf-transform/functions";
import { createIntegrity, type Hex, type Integrity } from "@keel/protocol";
import type { MediaKind } from "./pipeline.js";

const DEFAULT_QUALITY = 82;
const DEFAULT_EFFORT = 6;
const DEFAULT_VIDEO_CRF = 32;
const DEFAULT_VIDEO_CPU_USED = 4;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 256 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 60_000;
const FFMPEG_STATIC_VERSION = "5.3.0";
const GLTF_TRANSFORM_VERSION = "4.4.2";
/**
 * Exact bytes reviewed from ffmpeg-static@5.3.0. Unlisted platforms must fail
 * closed instead of trusting install.js' environment-configurable download.
 */
const FFMPEG_STATIC_EXECUTABLE_SHA256: Readonly<Record<string, Hex>> = {
  "darwin-arm64": "0xa90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
};
const localRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".avi": "video/x-msvideo",
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
const FFMPEG_INPUT_MEDIA_TYPES = new Set(["video/mp4", "video/webm", "video/x-matroska"]);
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;

export type MediaOptimizationCapabilityKind = "image" | "video" | "model";
export type MediaOptimizationAdapter = "sharp-webp" | "ffmpeg-webm-vp9" | "gltf-transform-glb" | "none";
export type OptimizedMediaType = "image/webp" | "video/webm" | "model/gltf-binary";
export type OptimizedExtension = ".webp" | ".webm" | ".glb";

export interface MediaOptimizationCapability {
  readonly kind: MediaOptimizationCapabilityKind;
  readonly adapter: MediaOptimizationAdapter;
  readonly available: boolean;
  readonly reason?: string;
  readonly version?: string;
}

export interface MediaOptimizationPlanOptions {
  readonly input: string;
  readonly mediaType?: string;
  readonly quality?: number;
  readonly effort?: number;
  readonly videoCrf?: number;
  readonly videoCpuUsed?: number;
  readonly maxInputBytes?: number;
  /** Informational only. Optimization never changes the selected publication mode. */
  readonly selectedStorageMode?: string;
}

export type MediaOptimizationSettings =
  | { readonly adapter: "sharp-webp"; readonly quality: number; readonly effort: number }
  | { readonly adapter: "ffmpeg-webm-vp9"; readonly crf: number; readonly cpuUsed: number }
  | { readonly adapter: "gltf-transform-glb"; readonly transforms: readonly ["dedup", "prune"] };

export interface MediaOptimizationOutput {
  readonly mediaType: OptimizedMediaType;
  readonly extension: OptimizedExtension;
  readonly integrity: Integrity;
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
  readonly output: MediaOptimizationOutput | null;
  readonly measurements: {
    readonly beforeBytes: number;
    readonly afterBytes: number | null;
    readonly savedBytes: number | null;
    readonly percentSaved: number | null;
    readonly smaller: boolean | null;
    readonly state: "measured-in-memory" | "unavailable";
  };
  readonly settings: MediaOptimizationSettings | null;
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
  /** A new output path using the planned extension. Existing files and the input path are rejected. */
  readonly output: string;
}

export interface AppliedMediaOptimization {
  readonly schema: "keel-media-optimization-result@1";
  readonly mode: "explicit-apply";
  readonly status: "completed";
  readonly input: MediaOptimizationPlan["input"];
  readonly output: MediaOptimizationOutput & { readonly path: string };
  readonly measurements: {
    readonly beforeBytes: number;
    readonly afterBytes: number;
    readonly savedBytes: number;
    readonly percentSaved: number;
  };
  readonly settings: MediaOptimizationSettings;
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

interface VideoResolution {
  readonly available: boolean;
  readonly binary?: string;
  readonly version?: string;
  readonly reason?: string;
}

export interface BundledFfmpegExecutableVerificationOptions {
  readonly packageRoot: string;
  readonly configuredPath: string | undefined;
  readonly platform: string;
  readonly architecture: string;
  /** Internal test seam. Production resolution uses the reviewed allowlist above. */
  readonly expectedDigests?: Readonly<Record<string, Hex>>;
}

export interface BundledFfmpegExecutableVerification {
  readonly available: boolean;
  readonly binary?: string;
  readonly digest?: Hex;
  readonly reason?: string;
}

interface Candidate {
  readonly bytes: Uint8Array;
  readonly output: MediaOptimizationOutput;
}

interface GlbJson {
  readonly json: Record<string, unknown>;
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

function assertVideoCrf(value: number | undefined): number {
  const crf = value ?? DEFAULT_VIDEO_CRF;
  if (!Number.isSafeInteger(crf) || crf < 0 || crf > 63) throw new RangeError("videoCrf must be an integer from 0 through 63.");
  return crf;
}

function assertVideoCpuUsed(value: number | undefined): number {
  const cpuUsed = value ?? DEFAULT_VIDEO_CPU_USED;
  if (!Number.isSafeInteger(cpuUsed) || cpuUsed < 0 || cpuUsed > 8) throw new RangeError("videoCpuUsed must be an integer from 0 through 8.");
  return cpuUsed;
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

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
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

/**
 * Verify the exact executable bytes before allowing the video adapter to run.
 * This is exported for deterministic adversarial tests; ordinary resolution
 * always supplies the fixed source allowlist, never caller-controlled input.
 */
export async function verifyBundledFfmpegExecutable(options: BundledFfmpegExecutableVerificationOptions): Promise<BundledFfmpegExecutableVerification> {
  const platformArch = `${options.platform}-${options.architecture}`;
  const expectedDigest = (options.expectedDigests ?? FFMPEG_STATIC_EXECUTABLE_SHA256)[platformArch];
  if (expectedDigest === undefined) {
    return { available: false, reason: `No reviewed bundled FFmpeg executable digest exists for ${platformArch}.` };
  }
  if (options.configuredPath === undefined || options.configuredPath.length === 0) {
    return { available: false, reason: "The pinned ffmpeg-static package does not provide a bundled binary for this platform." };
  }
  try {
    const configuredPackageRoot = path.resolve(options.packageRoot);
    const configuredPath = path.resolve(options.configuredPath);
    if (!isPathInside(configuredPackageRoot, configuredPath)) {
      return { available: false, reason: "Video optimization refuses an overridden or machine-local FFmpeg binary outside the reviewed package." };
    }
    const packageRoot = await realpath(configuredPackageRoot);
    const binary = await realpath(configuredPath);
    const binaryStat = await stat(binary);
    if (!binaryStat.isFile() || !isPathInside(packageRoot, binary)) {
      return { available: false, reason: "Video optimization requires a regular bundled FFmpeg executable inside the reviewed package." };
    }
    const digest = (await createIntegrity(new Uint8Array(await readFile(binary)))).digest;
    if (digest !== expectedDigest) {
      return { available: false, reason: `The bundled FFmpeg executable hash does not match the reviewed digest for ${platformArch}.` };
    }
    return { available: true, binary, digest };
  } catch {
    return { available: false, reason: "The pinned ffmpeg-static binary is not installed for this platform." };
  }
}

async function resolveBundledFfmpeg(): Promise<VideoResolution> {
  try {
    const packageJsonPath = localRequire.resolve("ffmpeg-static/package.json");
    const packageRoot = await realpath(path.dirname(packageJsonPath));
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { readonly version?: unknown };
    if (packageJson.version !== FFMPEG_STATIC_VERSION) {
      return { available: false, reason: "The pinned ffmpeg-static package version is unavailable; reinstall the reviewed dependency." };
    }
    const module = await import("ffmpeg-static");
    const configuredPath = (module as { readonly default?: unknown }).default;
    if (typeof configuredPath !== "string" || configuredPath.length === 0) {
      return { available: false, reason: "The pinned ffmpeg-static package does not provide a bundled binary for this platform." };
    }
    const verification = await verifyBundledFfmpegExecutable({
      packageRoot,
      configuredPath,
      platform: process.platform,
      architecture: process.arch,
    });
    if (!verification.available || verification.binary === undefined) {
      return { available: false, reason: verification.reason ?? "The pinned ffmpeg-static binary is not installed for this platform." };
    }
    return { available: true, binary: verification.binary, version: `ffmpeg-static@${FFMPEG_STATIC_VERSION}` };
  } catch {
    return { available: false, reason: "The pinned ffmpeg-static binary is not installed for this platform." };
  }
}

function unavailableCapability(kind: Exclude<MediaOptimizationCapabilityKind, "image">, adapter: MediaOptimizationAdapter, reason: string): MediaOptimizationCapability {
  return { kind, adapter, available: false, reason };
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

async function videoCapability(mediaType: string): Promise<MediaOptimizationCapability> {
  if (!FFMPEG_INPUT_MEDIA_TYPES.has(mediaType)) {
    return unavailableCapability("video", "none", "Only MP4, WebM, and Matroska input are supported by the reviewed WebM/VP9 adapter.");
  }
  const ffmpeg = await resolveBundledFfmpeg();
  return ffmpeg.available
    ? { kind: "video", adapter: "ffmpeg-webm-vp9", available: true, version: ffmpeg.version ?? `ffmpeg-static@${FFMPEG_STATIC_VERSION}` }
    : { kind: "video", adapter: "ffmpeg-webm-vp9", available: false, reason: ffmpeg.reason ?? "The pinned ffmpeg-static binary is not installed for this platform." };
}

function glbCapability(): MediaOptimizationCapability {
  return { kind: "model", adapter: "gltf-transform-glb", available: true, version: `@gltf-transform/core@${GLTF_TRANSFORM_VERSION}` };
}

/** Reports only pinned repository adapters. Machine-local ffmpeg/gltf tools are intentionally ignored. */
export async function detectMediaOptimizationCapabilities(): Promise<readonly MediaOptimizationCapability[]> {
  const [sharp, video] = await Promise.all([resolveSharp(), resolveBundledFfmpeg()]);
  return [
    sharp.available
      ? { kind: "image", adapter: "sharp-webp", available: true, ...(sharp.version === undefined ? {} : { version: sharp.version }) }
      : { kind: "image", adapter: "sharp-webp", available: false, reason: "The optional sharp image encoder is not installed for this SDK environment." },
    video.available
      ? { kind: "video", adapter: "ffmpeg-webm-vp9", available: true, version: video.version ?? `ffmpeg-static@${FFMPEG_STATIC_VERSION}` }
      : { kind: "video", adapter: "ffmpeg-webm-vp9", available: false, reason: video.reason ?? "The pinned ffmpeg-static binary is not installed for this platform." },
    glbCapability(),
  ];
}

function glbUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new TypeError("GLB is truncated.");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function assertNoExternalUri(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoExternalUri);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "uri" && typeof child === "string") {
      throw new TypeError("GLB must be self-contained; external or data-URI resources are not accepted by this adapter.");
    }
    assertNoExternalUri(child);
  }
}

function assertSelfContainedGlb(bytes: Uint8Array): GlbJson {
  if (bytes.byteLength < 20 || glbUint32(bytes, 0) !== GLB_MAGIC || glbUint32(bytes, 4) !== GLB_VERSION || glbUint32(bytes, 8) !== bytes.byteLength) {
    throw new TypeError("input must be a valid GLB 2.0 binary.");
  }
  let offset = 12;
  let json: Record<string, unknown> | undefined;
  let binaryChunkCount = 0;
  while (offset < bytes.byteLength) {
    const chunkLength = glbUint32(bytes, offset);
    const chunkType = glbUint32(bytes, offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkLength;
    if (chunkLength % 4 !== 0 || bodyEnd > bytes.byteLength) throw new TypeError("GLB has an invalid chunk boundary.");
    if (json === undefined) {
      if (chunkType !== JSON_CHUNK) throw new TypeError("GLB must start with a JSON chunk.");
      try {
        const parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(bodyStart, bodyEnd))) as unknown;
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new TypeError("GLB JSON must be an object.");
        json = parsed as Record<string, unknown>;
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new TypeError("GLB JSON chunk is invalid.");
      }
    } else if (chunkType === BIN_CHUNK && binaryChunkCount === 0) {
      binaryChunkCount += 1;
    } else {
      throw new TypeError("GLB may contain only one JSON chunk and one embedded binary chunk.");
    }
    offset = bodyEnd;
  }
  if (json === undefined || offset !== bytes.byteLength) throw new TypeError("GLB is incomplete.");
  assertNoExternalUri(json);
  return { json };
}

function imageSettings(options: MediaOptimizationPlanOptions): MediaOptimizationSettings {
  return { adapter: "sharp-webp", quality: assertQuality(options.quality), effort: assertEffort(options.effort) };
}

function videoSettings(options: MediaOptimizationPlanOptions): MediaOptimizationSettings {
  return { adapter: "ffmpeg-webm-vp9", crf: assertVideoCrf(options.videoCrf), cpuUsed: assertVideoCpuUsed(options.videoCpuUsed) };
}

function glbSettings(): MediaOptimizationSettings {
  return { adapter: "gltf-transform-glb", transforms: ["dedup", "prune"] };
}

async function imageCandidate(factory: SharpFactory, sourceBytes: Uint8Array, settings: Extract<MediaOptimizationSettings, { readonly adapter: "sharp-webp" }>): Promise<Candidate> {
  const bytes = new Uint8Array(await factory(sourceBytes).webp(settings).toBuffer());
  if (bytes.byteLength < 12 || new TextDecoder("ascii").decode(bytes.subarray(0, 4)) !== "RIFF" || new TextDecoder("ascii").decode(bytes.subarray(8, 12)) !== "WEBP") {
    throw new Error("The image adapter did not produce valid WebP bytes.");
  }
  return { bytes, output: { mediaType: "image/webp", extension: ".webp", integrity: await createIntegrity(bytes) } };
}

async function runBundledFfmpeg(binary: string, sourceBytes: Uint8Array, settings: Extract<MediaOptimizationSettings, { readonly adapter: "ffmpeg-webm-vp9" }>): Promise<Uint8Array> {
  const workspace = await mkdtemp(path.join(tmpdir(), "keel-ffmpeg-"));
  const input = path.join(workspace, "source");
  const output = path.join(workspace, "candidate.webm");
  try {
    await writeFile(input, sourceBytes, { flag: "wx" });
    await execFileAsync(
      binary,
      [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "+bitexact", "-i", input,
        "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1", "-map_chapters", "-1",
        "-flags:v", "+bitexact", "-c:v", "libvpx-vp9", "-crf", String(settings.crf), "-b:v", "0", "-cpu-used", String(settings.cpuUsed), "-deadline", "good", "-row-mt", "1",
        "-c:a", "libopus", "-b:a", "96k", "-f", "webm", "-bitexact", "-n", output,
      ],
      { cwd: workspace, maxBuffer: 1024 * 1024, timeout: VIDEO_TIMEOUT_MS },
    );
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size <= 0 || outputStat.size > MAX_CANDIDATE_BYTES) {
      throw new Error(`The bundled FFmpeg candidate must be from 1 through ${MAX_CANDIDATE_BYTES} bytes.`);
    }
    return new Uint8Array(await readFile(output));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The bundled FFmpeg adapter failed: ${detail}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function videoCandidate(binary: string, sourceBytes: Uint8Array, settings: Extract<MediaOptimizationSettings, { readonly adapter: "ffmpeg-webm-vp9" }>): Promise<Candidate> {
  const bytes = await runBundledFfmpeg(binary, sourceBytes, settings);
  if (bytes.byteLength < 4 || new TextDecoder("latin1").decode(bytes.subarray(0, 4)) !== "\u001aE\u00df\u00a3") {
    throw new Error("The bundled FFmpeg adapter did not produce valid WebM bytes.");
  }
  return { bytes, output: { mediaType: "video/webm", extension: ".webm", integrity: await createIntegrity(bytes) } };
}

async function glbCandidate(sourceBytes: Uint8Array): Promise<Candidate> {
  assertSelfContainedGlb(sourceBytes);
  const logger = new Logger(Logger.Verbosity.SILENT);
  const io = new NodeIO().setLogger(logger).registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(sourceBytes);
  document.setLogger(logger);
  await document.transform(dedup(), prune());
  const bytes = await io.writeBinary(document);
  assertSelfContainedGlb(bytes);
  return { bytes, output: { mediaType: "model/gltf-binary", extension: ".glb", integrity: await createIntegrity(bytes) } };
}

async function candidateFor(sourceBytes: Uint8Array, mediaType: string, settings: MediaOptimizationSettings): Promise<{ readonly capability: MediaOptimizationCapability; readonly candidate: Candidate }> {
  switch (settings.adapter) {
    case "sharp-webp": {
      const capability = await imageCapability(mediaType);
      const sharp = await resolveSharp();
      if (!capability.available || sharp.factory === undefined) throw new Error("The reviewed sharp image adapter is unavailable; no output was written.");
      return { capability, candidate: await imageCandidate(sharp.factory, sourceBytes, settings) };
    }
    case "ffmpeg-webm-vp9": {
      const capability = await videoCapability(mediaType);
      const ffmpeg = await resolveBundledFfmpeg();
      if (!capability.available || ffmpeg.binary === undefined) throw new Error("The reviewed bundled FFmpeg adapter is unavailable; no output was written.");
      return { capability, candidate: await videoCandidate(ffmpeg.binary, sourceBytes, settings) };
    }
    case "gltf-transform-glb": {
      if (mediaType !== "model/gltf-binary") throw new TypeError("The glTF adapter only accepts self-contained .glb input.");
      return { capability: glbCapability(), candidate: await glbCandidate(sourceBytes) };
    }
  }
}

/**
 * Read and describe one immutable source without writing anything. The plan is
 * deterministic for stable source bytes and makes no storage-mode decision.
 */
export async function planMediaOptimization(options: MediaOptimizationPlanOptions): Promise<MediaOptimizationPlan> {
  const source = await stableRegularInput(options.input, assertByteLimit(options.maxInputBytes));
  const mediaType = mediaTypeFor(source.path, options.mediaType);
  const kind = mediaKind(mediaType);
  if (mediaType === "model/gltf+json") {
    throw new TypeError("Only self-contained .glb input is accepted; .gltf JSON can reference external dependencies.");
  }
  let capability: MediaOptimizationCapability;
  let settings: MediaOptimizationSettings | null;
  if (kind === "image") {
    capability = await imageCapability(mediaType);
    settings = capability.available ? imageSettings(options) : null;
  } else if (kind === "video") {
    capability = await videoCapability(mediaType);
    settings = capability.available ? videoSettings(options) : null;
  } else if (mediaType === "model/gltf-binary") {
    assertSelfContainedGlb(source.bytes);
    capability = glbCapability();
    settings = glbSettings();
  } else if (kind === "model") {
    capability = unavailableCapability("model", "none", `No self-contained GLB optimizer is available for ${mediaType}.`);
    settings = null;
  } else {
    capability = { kind: "image", adapter: "none", available: false, reason: `No media optimizer is available for ${mediaType}.` };
    settings = null;
  }
  const measured = settings === null ? null : await candidateFor(source.bytes, mediaType, settings);
  if (measured !== null) capability = measured.capability;
  const candidate = measured?.candidate ?? null;
  const afterBytes = candidate?.bytes.byteLength ?? null;
  const savedBytes = afterBytes === null ? null : source.bytes.byteLength - afterBytes;
  const smaller = savedBytes === null ? null : savedBytes > 0;
  return {
    schema: "keel-media-optimization-plan@1",
    mode: "dry-run",
    status: candidate === null ? "unavailable" : smaller ? "ready-for-explicit-apply" : "candidate-not-smaller",
    input: {
      path: source.path,
      fileName: path.basename(source.path),
      mediaType,
      kind,
      beforeBytes: source.bytes.byteLength,
      integrity: source.integrity,
    },
    output: candidate?.output ?? null,
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

async function outputIsNewRegularPath(output: string, input: string, extension: OptimizedExtension): Promise<string> {
  const requested = path.resolve(output);
  if (requested === input) throw new TypeError("output must be a new path; the source is always retained.");
  if (path.extname(requested).toLowerCase() !== extension) throw new TypeError(`output must use the ${extension} extension selected by the reviewed plan.`);
  await mkdir(path.dirname(requested), { recursive: true });
  const entries = await readdir(path.dirname(requested), { withFileTypes: true });
  if (entries.some((entry) => entry.name === path.basename(requested))) throw new TypeError("output already exists; choose a new path so optimization stays reversible.");
  return requested;
}

type ReadyPlan = MediaOptimizationPlan & {
  readonly status: "ready-for-explicit-apply";
  readonly output: MediaOptimizationOutput;
  readonly settings: MediaOptimizationSettings;
  readonly measurements: MediaOptimizationPlan["measurements"] & {
    readonly afterBytes: number;
    readonly savedBytes: number;
    readonly percentSaved: number;
    readonly smaller: true;
    readonly state: "measured-in-memory";
  };
};

function assertReadyPlan(plan: MediaOptimizationPlan): asserts plan is ReadyPlan {
  if (
    plan.schema !== "keel-media-optimization-plan@1" || plan.mode !== "dry-run"
      || plan.status !== "ready-for-explicit-apply" || plan.output === null || plan.settings === null
      || plan.capability.available !== true || plan.capability.adapter !== plan.settings.adapter
      || plan.measurements.state !== "measured-in-memory" || plan.measurements.afterBytes === null
      || plan.measurements.savedBytes === null || plan.measurements.percentSaved === null || plan.measurements.smaller !== true
  ) {
    throw new TypeError("A measured, smaller dry-run candidate is required before applying output.");
  }
}

/**
 * Materialize one explicit conversion. It refuses source overwrite, retains
 * the original bytes, and rechecks source, adapter version, settings, and
 * candidate digest before writing a new output path.
 */
export async function applyMediaOptimization(options: ApplyMediaOptimizationOptions): Promise<AppliedMediaOptimization> {
  const plan = options.plan;
  assertReadyPlan(plan);
  const source = await stableRegularInput(plan.input.path, DEFAULT_MAX_INPUT_BYTES);
  if (source.integrity.digest !== plan.input.integrity.digest || source.integrity.byteLength !== plan.input.integrity.byteLength) {
    throw new Error("input no longer matches the reviewed optimization plan; plan again before applying.");
  }
  const output = await outputIsNewRegularPath(options.output, source.path, plan.output.extension);
  const fresh = await candidateFor(source.bytes, plan.input.mediaType, plan.settings);
  if (
    fresh.capability.available !== true || fresh.capability.adapter !== plan.capability.adapter || fresh.capability.version !== plan.capability.version
      || fresh.candidate.output.mediaType !== plan.output.mediaType || fresh.candidate.output.extension !== plan.output.extension
      || fresh.candidate.output.integrity.digest !== plan.output.integrity.digest || fresh.candidate.output.integrity.byteLength !== plan.output.integrity.byteLength
      || fresh.candidate.bytes.byteLength !== plan.measurements.afterBytes
  ) {
    throw new Error("The adapter version, settings, or candidate no longer matches the reviewed dry-run measurement; plan again before applying.");
  }
  await writeFile(output, fresh.candidate.bytes, { flag: "wx" });
  const afterSource = await stableRegularInput(source.path, DEFAULT_MAX_INPUT_BYTES);
  if (afterSource.integrity.digest !== source.integrity.digest || afterSource.integrity.byteLength !== source.integrity.byteLength) {
    await rm(output, { force: true });
    throw new Error("input changed during optimization; the new output was discarded.");
  }
  const afterBytes = fresh.candidate.bytes.byteLength;
  return {
    schema: "keel-media-optimization-result@1",
    mode: "explicit-apply",
    status: "completed",
    input: plan.input,
    output: { path: output, ...fresh.candidate.output },
    measurements: {
      beforeBytes: source.bytes.byteLength,
      afterBytes,
      savedBytes: source.bytes.byteLength - afterBytes,
      percentSaved: percentSaved(source.bytes.byteLength, afterBytes),
    },
    settings: plan.settings,
    capability: fresh.capability,
    sourceRetention: { policy: "preserve-source", sourceRemoved: false, sourceIntegrity: afterSource.integrity },
    storage: plan.storage,
  };
}
