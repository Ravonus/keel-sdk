import type { EntrypointMode, ResourceRole } from "@keel/protocol";
import type { NormalizedStudioAsset, StudioAssetInput } from "./types.js";

const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".html": "text/html",
  ".htm": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

function extension(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

export function normalizeProjectPath(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === ".." || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new TypeError(`Unsafe project path: ${fileName}`);
  }
  return parts.join("/");
}

export function sourceUriForFile(fileName: string): string {
  return `./${normalizeProjectPath(fileName).split("/").map(encodeURIComponent).join("/")}`;
}

export function inferMediaType(fileName: string, declared?: string): string {
  if (declared !== undefined && declared.trim().length > 0 && declared !== "application/octet-stream") {
    return declared.toLowerCase();
  }
  return MEDIA_BY_EXTENSION[extension(fileName)] ?? "application/octet-stream";
}

export function inferRole(mediaType: string, fileName: string): ResourceRole {
  const lower = fileName.toLowerCase();
  if (lower.includes("preview") || lower.includes("thumbnail") || lower.includes("poster")) return "preview";
  if (lower.includes("original") || lower.includes("source")) return "original";
  if (mediaType === "text/html") return "entrypoint";
  if (mediaType === "text/css") return "style";
  if (mediaType.includes("javascript") || mediaType === "application/wasm") return "script";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("font/")) return "font";
  if (mediaType.startsWith("model/")) return "model";
  if (mediaType.includes("json") || mediaType.startsWith("text/") || mediaType.includes("xml")) return "data";
  return "other";
}

export function isExecutableMediaType(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "text/css" || mediaType.includes("javascript") || mediaType === "application/wasm";
}

export function entrypointMode(mediaType: string): EntrypointMode {
  if (mediaType === "text/html") return "html";
  if (mediaType.includes("javascript")) return "module";
  if (mediaType === "image/svg+xml") return "svg";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("model/")) return "model";
  return "html";
}

function resourceIdBase(fileName: string): string {
  return normalizeProjectPath(fileName)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._:/-]+/g, "-")
    .replace(/^[-./:]+|[-./:]+$/g, "")
    .slice(0, 110) || "resource";
}

export function uniqueResourceId(fileName: string, requested: string | undefined, used: Set<string>): string {
  const base = (requested?.trim() || resourceIdBase(fileName)).slice(0, 120);
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix += 1) {
    candidate = `${base.slice(0, Math.max(1, 124 - String(suffix).length))}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

export function normalizeAssets(inputs: readonly StudioAssetInput[]): readonly NormalizedStudioAsset[] {
  if (inputs.length === 0) throw new RangeError("At least one asset is required.");
  const usedIds = new Set<string>();
  const usedPaths = new Set<string>();
  return inputs.map((asset) => {
    if (!(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength === 0) {
      throw new RangeError(`Asset ${asset.fileName} is empty.`);
    }
    const fileName = normalizeProjectPath(asset.fileName);
    if (usedPaths.has(fileName)) throw new TypeError(`Duplicate project path: ${fileName}`);
    usedPaths.add(fileName);
    const mediaType = inferMediaType(fileName, asset.mediaType);
    const role = asset.role ?? inferRole(mediaType, fileName);
    return {
      id: uniqueResourceId(fileName, asset.id, usedIds),
      fileName,
      mediaType,
      bytes: asset.bytes.slice(),
      role,
      executable: asset.executable ?? isExecutableMediaType(mediaType),
      ...(asset.description === undefined ? {} : { description: asset.description }),
      ...(asset.remoteUri === undefined ? {} : { remoteUri: asset.remoteUri }),
      ...(asset.stack === undefined ? {} : { stack: asset.stack }),
      ...(asset.additionalSources === undefined ? {} : { additionalSources: asset.additionalSources }),
      entrypoint: asset.entrypoint ?? role === "entrypoint",
      mode: entrypointMode(mediaType),
    };
  });
}

export const entrypointModeForMediaType = entrypointMode;
