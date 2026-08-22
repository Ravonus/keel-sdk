import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, createIntegrity, type Integrity } from "@keel/protocol";
import { verifyBuiltArtifact, type BuiltArtifactVerification } from "./verification.js";
import { wrapImage } from "./wrap.js";
import type { ImageProcessor, WrapImageOptions, WrappedArtifactOutput } from "./types.js";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
};

const IMAGE_MEDIA_TYPES = new Set(
  [".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"].map((extension) => MEDIA_TYPES[extension]),
);

const WRAPPABLE_IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

export type MediaKind = "image" | "audio" | "video" | "model" | "text" | "binary";

export interface AnalyzeMediaOptions {
  readonly input: string;
  readonly mediaType?: string;
  readonly maxInputBytes?: number;
  /** Optional metadata adapter. The analysis remains valid without it. */
  readonly imageProcessor?: Pick<ImageProcessor, "metadata">;
}

export interface MediaAnalysis {
  readonly schema: "oca-media-analysis@1";
  readonly input: {
    readonly fileName: string;
    readonly mediaType: string;
    readonly kind: MediaKind;
    readonly byteLength: number;
    readonly integrity: Integrity;
  };
  readonly image?: { readonly width?: number; readonly height?: number };
  readonly wrapper: {
    readonly supported: boolean;
    readonly strategy: "image-wrapper" | "none";
    readonly reason?: string;
  };
}

export interface BuildMediaArtifactOptions extends Omit<WrapImageOptions, "createdAt"> {
  /** Required to make the manifest commitment reproducible across runs. */
  readonly createdAt: string;
  readonly maxInputBytes?: number;
}

export interface BuiltMediaArtifact {
  readonly schema: "oca-build-result@1";
  readonly determinism: {
    readonly manifest: "deterministic";
    readonly encodedPreview: "processor-dependent";
  };
  readonly analysis: MediaAnalysis;
  readonly output: WrappedArtifactOutput;
}

export interface MediaPipelineResult {
  readonly schema: "oca-media-pipeline@1";
  readonly valid: boolean;
  readonly analysis: MediaAnalysis;
  readonly build: BuiltMediaArtifact;
  readonly verification: BuiltArtifactVerification;
}

function mediaTypeFor(input: string, override: string | undefined): string {
  const mediaType = override ?? MEDIA_TYPES[path.extname(input).toLowerCase()] ?? "application/octet-stream";
  if (mediaType.length === 0 || /[\u0000-\u001f]/u.test(mediaType)) throw new TypeError("mediaType must be a non-empty value without control characters.");
  return mediaType;
}

function mediaKind(mediaType: string): MediaKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("model/") || mediaType.includes("gltf")) return "model";
  if (mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.includes("javascript")) return "text";
  return "binary";
}

function dimension(value: number | undefined): number | undefined {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? undefined : value;
}

function dateIsValid(value: string): void {
  if (Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new RangeError("createdAt must be a canonical UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).");
  }
}

async function readInput(input: string, maxInputBytes: number | undefined): Promise<Uint8Array> {
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0)) throw new RangeError("maxInputBytes must be a positive safe integer.");
  const before = await stat(input);
  if (!before.isFile() || (maxInputBytes !== undefined && before.size > maxInputBytes)) throw new RangeError("input exceeds the configured byte cap.");
  const bytes = new Uint8Array(await readFile(input));
  const after = await stat(input);
  if (bytes.byteLength !== before.size || bytes.byteLength !== after.size) throw new Error("Input changed while it was being read.");
  return bytes;
}

export async function analyzeMedia(options: AnalyzeMediaOptions): Promise<MediaAnalysis> {
  const input = path.resolve(options.input);
  const bytes = await readInput(input, options.maxInputBytes);
  const mediaType = mediaTypeFor(input, options.mediaType);
  const kind = mediaKind(mediaType);
  const metadata = options.imageProcessor === undefined || !IMAGE_MEDIA_TYPES.has(mediaType)
    ? undefined
    : await options.imageProcessor.metadata(input);
  const width = dimension(metadata?.width);
  const height = dimension(metadata?.height);
  const image = width === undefined && height === undefined ? undefined : { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
  const wrapper = kind === "image" && WRAPPABLE_IMAGE_EXTENSIONS.has(path.extname(input).toLowerCase())
    ? { supported: true as const, strategy: "image-wrapper" as const }
    : { supported: false as const, strategy: "none" as const, reason: "The first builder slice wraps image media; this file is ready for a media-specific builder." };
  return {
    schema: "oca-media-analysis@1",
    input: { fileName: path.basename(input), mediaType, kind, byteLength: bytes.byteLength, integrity: await createIntegrity(bytes) },
    ...(image === undefined ? {} : { image }),
    wrapper,
  };
}

export async function buildMediaArtifact(options: BuildMediaArtifactOptions): Promise<BuiltMediaArtifact> {
  dateIsValid(options.createdAt);
  const analysis = await analyzeMedia({ input: options.input, ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }), ...(options.imageProcessor === undefined ? {} : { imageProcessor: options.imageProcessor }) });
  if (!analysis.wrapper.supported) throw new Error(`Cannot build ${analysis.input.mediaType}: ${analysis.wrapper.reason ?? "no wrapper is available"}`);
  const output = await wrapImage({ ...options, createdAt: options.createdAt });
  const postBuildIntegrity = await createIntegrity(await readInput(path.resolve(options.input), options.maxInputBytes));
  if (postBuildIntegrity.digest !== analysis.input.integrity.digest || postBuildIntegrity.byteLength !== analysis.input.integrity.byteLength) {
    throw new Error("Input changed while the artifact was being built; discard the output and retry.");
  }
  return {
    schema: "oca-build-result@1",
    determinism: { manifest: "deterministic", encodedPreview: "processor-dependent" },
    analysis,
    output,
  };
}

export async function runMediaPipeline(options: BuildMediaArtifactOptions): Promise<MediaPipelineResult> {
  const build = await buildMediaArtifact(options);
  const verification = await verifyBuiltArtifact({ directory: options.outputDirectory, ...(options.maxInputBytes === undefined ? {} : { maxSourceBytes: options.maxInputBytes }) });
  return { schema: "oca-media-pipeline@1", valid: verification.valid, analysis: build.analysis, build, verification };
}

/** Exposed for callers that need a stable representation in logs or cache keys. */
export function canonicalAnalysis(value: MediaAnalysis): string {
  return canonicalJson(value);
}

export { verifyBuiltArtifact } from "./verification.js";
export type {
  BuiltArtifactVerification,
  ManifestVerificationResult,
  ResourceVerificationResult,
  SourceVerificationResult,
  VerificationStatus,
  VerifyBuiltArtifactOptions,
} from "./verification.js";
