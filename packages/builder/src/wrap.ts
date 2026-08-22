import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  assertValidManifest,
  createIntegrity,
  manifestIntegrity,
  type ArtifactManifest,
  type ArtifactResource,
  type ResourceSource,
} from "@keel/protocol";
import type { ImageProcessor, WrapImageOptions, WrappedArtifactOutput } from "./types.js";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "artifact";
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function htmlWrapper(name: string, description: string | undefined, preserveOriginal: boolean): string {
  const escapedName = escapeAttribute(name);
  const escapedDescription = escapeAttribute(description ?? "");
  const display = preserveOriginal
    ? `<picture><source srcset="/content/preview" type="image/webp"><img src="/content/original" alt="${escapedName}"></picture>`
    : `<img src="/content/preview" alt="${escapedName}">`;
  const download = preserveOriginal ? '<nav><a href="/content/original" download>Download original</a></nav>' : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeText(name)}</title>
  <style>
    :root{color-scheme:dark}html,body{height:100%;margin:0;background:#09090b;font-family:system-ui,sans-serif}
    main{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden}
    img{display:block;width:100%;height:100%;object-fit:contain}
    nav{position:absolute;right:12px;bottom:12px;display:flex;gap:8px;opacity:0;transition:opacity .18s}
    main:hover nav,nav:focus-within{opacity:1}a{color:white;background:#18181bcc;padding:8px 11px;border:1px solid #ffffff2b;border-radius:999px;text-decoration:none;backdrop-filter:blur(12px)}
  </style>
</head>
<body>
  <main aria-label="${escapedName}" data-description="${escapedDescription}">
    ${display}
    ${download}
  </main>
</body>
</html>`;
}

interface SharpImage {
  webp(options?: { quality?: number; effort?: number; lossless?: boolean }): SharpImage;
  toFile(file: string): Promise<{ size: number }>;
  metadata(): Promise<{ width?: number; height?: number }>;
}

async function sharpProcessor(): Promise<ImageProcessor> {
  try {
    const module = await import("sharp");
    const sharp = module.default as (input: string | Uint8Array) => SharpImage;
    return {
      async metadata(input) {
        return sharp(input).metadata();
      },
      async writeWebp(input, output, options) {
        await sharp(input).webp(options).toFile(output);
      },
    };
  } catch (error) {
    throw new Error(`Image wrapping requires optional dependency sharp or an imageProcessor adapter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertWebp(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) throw new Error("Image processor returned an invalid WebP file.");
  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
  const format = new TextDecoder("ascii").decode(bytes.subarray(8, 12));
  if (signature !== "RIFF" || format !== "WEBP") throw new Error("Image processor returned bytes that are not WebP.");
}

async function sourceFor(bytes: Uint8Array, fileName: string, mode: "files" | "inline"): Promise<ResourceSource> {
  const integrity = await createIntegrity(bytes);
  if (mode === "inline") {
    return { kind: "inline", data: Buffer.from(bytes).toString("base64"), encoding: "base64", integrity };
  }
  return { kind: "uri", uri: `./${fileName}`, integrity };
}

function webpQuality(value: number | undefined): number {
  const quality = value ?? 82;
  if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100) {
    throw new RangeError("webpQuality must be an integer from 1 through 100.");
  }
  return quality;
}

function viewportDimension(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return 1024;
  return Math.min(value, 4096);
}

function artifactId(value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /[<>:"|?*]/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("id must be a non-empty filename-safe segment without path separators.");
  }
  return value;
}

function createdAtValue(value: string | undefined): string {
  const createdAt = value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt)) {
    throw new RangeError("createdAt must be a canonical UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).");
  }
  return createdAt;
}

export async function wrapImage(options: WrapImageOptions): Promise<WrappedArtifactOutput> {
  const input = path.resolve(options.input);
  const outputDirectory = path.resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });

  const extension = path.extname(input).toLowerCase();
  const originalMediaType = MEDIA_TYPES[extension];
  if (originalMediaType === undefined) throw new TypeError(`Unsupported image extension ${extension || "(none)"}.`);

  const quality = webpQuality(options.webpQuality);
  const originalBytes = new Uint8Array(await readFile(input));
  const originalIntegrity = await createIntegrity(originalBytes);
  const baseName = path.basename(input, extension);
  const name = options.name ?? baseName;
  const id = artifactId(options.id ?? slug(name));
  const sourceMode = options.sourceMode ?? "files";
  const preserveOriginal = options.preserveOriginal ?? true;
  const previewName = `${id}.preview.webp`;
  const wrapperName = `${id}.viewer.html`;
  const originalName = `${id}.original${extension}`;
  const previewPath = path.join(outputDirectory, previewName);
  const wrapperPath = path.join(outputDirectory, wrapperName);
  const originalPath = path.join(outputDirectory, originalName);

  const processor = options.imageProcessor ?? (await sharpProcessor());
  const metadata = await processor.metadata(input);
  await processor.writeWebp(input, previewPath, { quality, effort: 6 });
  const previewBytes = new Uint8Array(await readFile(previewPath));
  assertWebp(previewBytes);
  const wrapper = htmlWrapper(name, options.description, preserveOriginal);
  const wrapperBytes = new TextEncoder().encode(wrapper);
  await writeFile(wrapperPath, wrapperBytes);
  if (preserveOriginal) await cp(input, originalPath);

  const resources: ArtifactResource[] = [
    {
      id: "viewer",
      role: "entrypoint",
      mediaType: "text/html",
      executable: true,
      originalName: wrapperName,
      sources: [await sourceFor(wrapperBytes, wrapperName, sourceMode)],
    },
    {
      id: "preview",
      role: "preview",
      mediaType: "image/webp",
      originalName: previewName,
      sources: [await sourceFor(previewBytes, previewName, sourceMode)],
    },
  ];

  if (preserveOriginal) {
    resources.push({
      id: "original",
      role: "original",
      mediaType: originalMediaType,
      originalName: path.basename(input),
      sources: [await sourceFor(originalBytes, originalName, sourceMode)],
    });
  }

  const includedBytes = wrapperBytes.byteLength + previewBytes.byteLength + (preserveOriginal ? originalBytes.byteLength : 0);
  const largestBytes = Math.max(wrapperBytes.byteLength, previewBytes.byteLength, preserveOriginal ? originalBytes.byteLength : 0);
  const createdAt = createdAtValue(options.createdAt);
  const manifest: ArtifactManifest = {
    schema: KEEL_MANIFEST_SCHEMA,
    canonicalization: KEEL_CANONICALIZATION,
    id,
    name,
    ...(options.description === undefined ? {} : { description: options.description }),
    entrypoint: { resource: "viewer", mode: "html" },
    resources,
    fallback: {
      image: "preview",
      animation: "viewer",
      ...(options.viewerBaseUrl === undefined ? {} : { externalUrl: options.viewerBaseUrl }),
      backgroundColor: "#09090b",
    },
    runtime: {
      engine: {
        protocol: KEEL_RUNTIME_PROTOCOL,
        viewerProtocol: KEEL_VIEWER_PROTOCOL,
        renderer: "browser",
        ...(options.viewerMirrors === undefined ? {} : { viewerMirrors: options.viewerMirrors }),
      },
      determinism: {
        mode: "replay",
        seed: originalIntegrity.digest,
        randomAlgorithm: "xoshiro128ss",
        viewport: {
          width: viewportDimension(metadata.width),
          height: viewportDimension(metadata.height),
          devicePixelRatio: 1,
        },
        clock: { mode: "fixed", epochMs: Date.parse(createdAt) },
        locale: "en-US",
        timezone: "UTC",
      },
      content: {
        protocol: KEEL_CONTENT_GATEWAY_PROTOCOL,
        mode: "verified-only",
        externalSources: "host-verified",
        manifestTrust: options.anchor === undefined ? "digest" : "registry",
        blockUndeclared: true,
        resourcePathPrefix: "/content/",
        onchainPathPrefix: "/onchain/",
        ipfsPathPrefix: "/ipfs/",
      },
      sandbox: "strict",
      capabilities: { downloads: preserveOriginal },
      maxResourceBytes: largestBytes + 1024,
      maxTotalBytes: includedBytes + 4096,
      maxRecursionDepth: 8,
      maxResources: 16,
      timeoutMs: 15_000,
    },
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
    revision: { number: 1, compatibility: { min: 1, max: 1 }, policy: "creator" },
    provenance: {
      createdAt,
      ...(options.creator === undefined ? {} : { creator: options.creator }),
      ...(options.sourceRepository === undefined ? {} : { sourceRepository: options.sourceRepository }),
      ...(options.anchor === undefined
        ? {}
        : {
            collection: options.anchor.collection,
            tokenId: options.anchor.tokenId,
            chainId: options.anchor.chainId,
          }),
    },
    ...(preserveOriginal
      ? { downloads: [{ resource: "original", label: "Download original", filename: path.basename(input) }] }
      : {}),
    extensions: {
      "oca:derived": {
        preview: "WebP",
        originalPreserved: preserveOriginal,
        sourceMode,
        canonicalization: KEEL_CANONICALIZATION,
      },
    },
  };

  assertValidManifest(manifest);
  const integrity = await manifestIntegrity(manifest);
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const manifestIntegrityPath = path.join(outputDirectory, "manifest.integrity.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    manifestIntegrityPath,
    `${JSON.stringify({ schema: "oca-manifest-integrity@2", manifest: "manifest.json", canonicalization: KEEL_CANONICALIZATION, integrity }, null, 2)}\n`,
  );
  return {
    manifest,
    manifestPath,
    wrapperPath,
    previewPath,
    ...(preserveOriginal ? { originalPath } : {}),
    manifestIntegrity: integrity,
    manifestIntegrityPath,
  };
}
