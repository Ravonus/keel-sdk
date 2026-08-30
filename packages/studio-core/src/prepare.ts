import {
  KEEL_CANONICALIZATION,
  KEEL_CONTENT_GATEWAY_PROTOCOL,
  KEEL_MANIFEST_SCHEMA,
  KEEL_MAX_THUMBNAIL_BYTES,
  KEEL_RUNTIME_PROTOCOL,
  KEEL_THUMBNAIL_PROTOCOL,
  KEEL_VIEWER_PROTOCOL,
  assertValidManifest,
  createIntegrity,
  manifestIntegrity,
  utf8ToBytes,
  type ArtifactDownload,
  type ArtifactManifest,
  type ArtifactResource,
  type ResourceSource,
  type KeelComponentFormat,
  type KeelComponentRole,
  type KeelMediaDerivative,
  type KeelProjectComponent,
  type KeelWebpProfile,
} from "@keel/protocol";
import { chooseSmallestCompression } from "@keel/builder";
import { normalizeAssets, normalizeProjectPath, sourceUriForFile, uniqueResourceId } from "./media.js";
import type {
  NormalizedStudioAsset,
  PreparedStudioArtifact,
  PreparedStudioResource,
  PrepareStudioArtifactOptions,
  StudioFlashRuntime,
  StudioArtifactStats,
} from "./types.js";
import { createGeneratedWrapper, type FlashWrapperResources } from "./wrapper.js";
import { buildKeelWebpDerivative } from "./media-derivative.js";

function positiveSafe(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return resolved;
}

function assertRemoteReference(uri: string): void {
  if (uri.startsWith("ipfs://") || uri.startsWith("ipns://") || uri.startsWith("ar://")) {
    const value = uri.slice(uri.indexOf("://") + 3);
    if (value.length === 0 || /[\u0000-\u001f\u007f\s]/u.test(value)) {
      throw new TypeError(`Remote content address is malformed: ${uri}`);
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new TypeError(`Remote source is not a URL: ${uri}`);
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError(`Remote sources must be credential-free HTTPS, IPFS, IPNS, or Arweave references: ${uri}`);
  }
}

function resourceAliases(resourceId: string, fileName: string): readonly string[] {
  const filePath = fileName.split("/").map((part) => encodeURIComponent(part)).join("/");
  return [...new Set([`/content/${encodeURIComponent(resourceId)}`, `/content/${filePath}`])];
}

async function prepareResource(asset: NormalizedStudioAsset): Promise<PreparedStudioResource> {
  const decodedIntegrity = await createIntegrity(asset.bytes);
  // The inline presentation contract must be able to concatenate the exact
  // HTML shell without running a browser codec. Entrypoints are deliberately
  // tiny orchestration documents, so keep them contract-readable and let
  // heavyweight scripts/assets use the ordinary compression policy.
  const contractReadable = (asset.entrypoint && asset.mediaType === "text/html")
    || asset.mediaType === "application/vnd.keel.token-uri-base64-fragment";
  const selected = contractReadable
    ? { compression: "none" as const, bytes: asset.bytes.slice() }
    : await chooseSmallestCompression(asset.bytes);
  const storedIntegrity = await createIntegrity(selected.bytes);
  const sources: ResourceSource[] = asset.sourceMode === "additional-only"
    ? []
    : [{
        kind: "uri",
        uri: sourceUriForFile(asset.fileName),
        integrity: decodedIntegrity,
        immutable: true,
      }];
  for (const source of asset.additionalSources ?? []) {
    if (
      source.integrity.algorithm !== decodedIntegrity.algorithm ||
      source.integrity.digest !== decodedIntegrity.digest ||
      source.integrity.byteLength !== decodedIntegrity.byteLength
    ) {
      throw new Error(`Additional source for ${asset.id} does not match its exact decoded bytes.`);
    }
    sources.push(source);
  }
  if (asset.remoteUri !== undefined) {
    assertRemoteReference(asset.remoteUri);
    sources.push({ kind: "uri", uri: asset.remoteUri, integrity: decodedIntegrity, immutable: false });
  }
  if (sources.length === 0) {
    throw new TypeError(`Additional-only resource ${asset.id} needs at least one exact provided source.`);
  }
  const resource: ArtifactResource = {
    id: asset.id,
    role: asset.role,
    mediaType: asset.mediaType,
    executable: asset.executable,
    originalName: asset.fileName,
    ...(asset.description === undefined ? {} : { description: asset.description }),
    aliases: resourceAliases(asset.id, asset.fileName),
    sources,
    extensions: {
      studio: {
        compression: selected.compression,
        storedIntegrity,
        storedByteLength: selected.bytes.byteLength,
      },
    },
  };
  return {
    resource,
    fileName: asset.fileName,
    decodedBytes: asset.bytes.slice(),
    storedBytes: selected.bytes,
    compression: selected.compression,
    decodedIntegrity,
    storedIntegrity,
    decodedByteLength: asset.bytes.byteLength,
    storedByteLength: selected.bytes.byteLength,
    compressionRatio: selected.bytes.byteLength / asset.bytes.byteLength,
  };
}

function choosePrimary(assets: readonly NormalizedStudioAsset[]): NormalizedStudioAsset {
  const selected =
    assets.find((asset) => asset.entrypoint) ??
    assets.find((asset) => asset.role === "preview") ??
    assets.find((asset) => asset.role === "image") ??
    assets[0];
  if (selected === undefined) throw new RangeError("At least one asset is required.");
  return selected;
}

interface ResolvedFlashRuntime {
  readonly wrapper: FlashWrapperResources;
  readonly extension: Readonly<Record<string, unknown>>;
}

function resolveFlashRuntime(runtime: StudioFlashRuntime, assets: readonly NormalizedStudioAsset[]): ResolvedFlashRuntime {
  if (!Number.isSafeInteger(runtime.collectionSize) || runtime.collectionSize < 1 || runtime.collectionSize > 1_000_000) {
    throw new RangeError("Flash collectionSize must be a positive safe integer no larger than 1,000,000.");
  }
  if (runtime.previewRootSeed !== undefined && !/^0x[0-9a-f]{64}$/iu.test(runtime.previewRootSeed)) {
    throw new TypeError("Flash previewRootSeed must be a canonical bytes32 value.");
  }
  const byPath = new Map(assets.map((asset) => [asset.fileName, asset]));
  const required = (path: string, label: string, mediaType: string): NormalizedStudioAsset => {
    const normalizedPath = normalizeProjectPath(path);
    const asset = byPath.get(normalizedPath);
    if (asset === undefined) throw new Error(`Flash ${label} resource is not present: ${normalizedPath}.`);
    const actual = asset.mediaType.toLowerCase().split(";", 1)[0] ?? asset.mediaType.toLowerCase();
    if (actual !== mediaType) throw new TypeError(`Flash ${label} must use ${mediaType}; received ${actual}.`);
    return asset;
  };
  const swf = required(runtime.swfPath, "SWF", "application/x-shockwave-flash");
  const loader = required(runtime.loaderPath, "Ruffle loader", "text/javascript");
  const seededRandom = required(runtime.seededRandomPath, "seeded-random module", "text/javascript");
  const edition = required(runtime.editionPath, "Flash edition module", "text/javascript");
  const ruffleMain = required(runtime.ruffleMainPath, "Ruffle main", "text/javascript");
  const ruffleModernCore = required(runtime.ruffleModernCorePath, "Ruffle modern core", "text/javascript");
  const ruffleLegacyCore = required(runtime.ruffleLegacyCorePath, "Ruffle legacy core", "text/javascript");
  const ruffleWasmPolicy = runtime.ruffleWasmPolicy ?? "dual";
  if (ruffleWasmPolicy !== "modern-only" && ruffleWasmPolicy !== "dual") {
    throw new TypeError("Flash ruffleWasmPolicy must be modern-only or dual.");
  }
  const ruffleModernWasm = runtime.ruffleModernWasmPath === undefined
    ? undefined
    : required(runtime.ruffleModernWasmPath, "Ruffle extensions-enabled WASM", "application/wasm");
  const ruffleLegacyWasm = required(runtime.ruffleLegacyWasmPath, "Ruffle legacy WASM", "application/wasm");
  if (ruffleWasmPolicy === "modern-only" && ruffleModernWasm === undefined) {
    throw new Error("Modern-only Flash runtime requires a verified modern Ruffle WASM resource.");
  }
  const fallbackWasmSha256 = runtime.ruffleModernWasmSha256;
  const fallbackWasmByteLength = runtime.ruffleModernWasmByteLength;
  if (ruffleModernWasm === undefined &&
      (!/^0x[0-9a-f]{64}$/iu.test(fallbackWasmSha256 ?? "") ||
       typeof fallbackWasmByteLength !== "number" || !Number.isSafeInteger(fallbackWasmByteLength) || fallbackWasmByteLength <= 0)) {
    throw new TypeError("Flash fallback WASM requires a canonical SHA-256 digest and byte length when the MVP resource is omitted.");
  }
  if (runtime.ruffleModernWasmFileName !== undefined &&
      (runtime.ruffleModernWasmFileName.length === 0 || runtime.ruffleModernWasmFileName.includes("/") || /[\\\u0000-\u001f]/u.test(runtime.ruffleModernWasmFileName))) {
    throw new TypeError("Flash fallback WASM file name must be a single safe file name.");
  }
  const wrapper: FlashWrapperResources = {
    swf: swf.id,
    loader: loader.id,
    seededRandom: seededRandom.id,
    edition: edition.id,
    ruffleMain: ruffleMain.id,
    ruffleModernCore: ruffleModernCore.id,
    ruffleLegacyCore: ruffleLegacyCore.id,
    ...(ruffleModernWasm === undefined ? {} : { ruffleModernWasm: ruffleModernWasm.id }),
    ruffleLegacyWasm: ruffleLegacyWasm.id,
    ruffleWasmPolicy,
    ...(runtime.ruffleModernWasmSha256 === undefined ? {} : { ruffleModernWasmSha256: runtime.ruffleModernWasmSha256.toLowerCase() }),
    ...(runtime.ruffleModernWasmByteLength === undefined ? {} : { ruffleModernWasmByteLength: runtime.ruffleModernWasmByteLength }),
    ...(runtime.ruffleModernWasmFileName === undefined ? {} : { ruffleModernWasmFileName: runtime.ruffleModernWasmFileName }),
    collectionSize: runtime.collectionSize,
    ...(runtime.previewRootSeed === undefined ? {} : { previewRootSeed: runtime.previewRootSeed.toLowerCase() }),
  };
  return {
    wrapper,
    extension: {
      protocol: "keel-flash@1",
      swfResource: swf.id,
      modules: { loader: loader.id, seededRandom: seededRandom.id, edition: edition.id },
      ruffle: {
        main: ruffleMain.id,
        modernCore: ruffleModernCore.id,
        legacyCore: ruffleLegacyCore.id,
        ...(ruffleModernWasm === undefined ? {} : { modernWasm: ruffleModernWasm.id }),
        legacyWasm: ruffleLegacyWasm.id,
      },
      ruffleWasmPolicy,
      ...(ruffleWasmPolicy === "dual" && ruffleModernWasm === undefined ? {
        fallback: {
          mode: "local-upload",
          fileName: runtime.ruffleModernWasmFileName ?? "a71cef02d58dcec6f55f.wasm",
          sha256: runtime.ruffleModernWasmSha256?.toLowerCase(),
          byteLength: runtime.ruffleModernWasmByteLength,
        },
      } : {}),
      collectionSize: runtime.collectionSize,
      ...(runtime.previewRootSeed === undefined ? {} : { previewRootSeed: runtime.previewRootSeed.toLowerCase() }),
    },
  };
}

function ensureEntrypoint(
  assets: readonly NormalizedStudioAsset[],
  name: string,
  description: string | undefined,
  flashRuntime?: FlashWrapperResources,
): readonly NormalizedStudioAsset[] {
  const inlineGraphMediaType = "application/vnd.keel.token-uri-base64-fragment";
  const selected = assets.find((asset) => asset.entrypoint && (asset.mediaType === "text/html" || asset.mediaType === inlineGraphMediaType)) ??
    assets.find((asset) => asset.mediaType === "text/html");
  if (selected !== undefined) {
    return assets.map((asset) => ({ ...asset, entrypoint: asset.id === selected.id }));
  }

  const primary = choosePrimary(assets);
  // Ordinary visual media is the creator payload, not a project-authored HTML
  // document. The canonical KEEL verification shell and its reusable
  // asset-display module mount these exact bytes later. Keeping the media as
  // the direct entrypoint prevents Studio from storing a per-project
  // `index.html` that merely duplicates platform renderer behavior.
  if (flashRuntime === undefined && ["image", "video", "model"].includes(primary.mode)) {
    return assets.map((asset) => ({ ...asset, entrypoint: asset.id === primary.id }));
  }
  const used = new Set(assets.map((asset) => asset.id));
  const id = uniqueResourceId("index.html", "entrypoint", used);
  const wrapper = utf8ToBytes(
    createGeneratedWrapper({
      name,
      ...(description === undefined ? {} : { description }),
      resourceId: primary.id,
      mediaType: primary.mediaType,
      mode: primary.mode,
      downloads: flashRuntime !== undefined || primary.role === "original" || primary.role === "image" || primary.role === "video" || primary.role === "audio" || primary.role === "model",
      ...(flashRuntime === undefined ? {} : { flashRuntime }),
    }),
  );
  return [
    {
      id,
      fileName: "index.html",
      mediaType: "text/html",
      bytes: wrapper,
      role: "entrypoint",
      executable: true,
      entrypoint: true,
      mode: "html",
      sourceMode: "local-and-additional",
    },
    ...assets.map((asset) => ({ ...asset, entrypoint: false })),
  ];
}

async function appendMediaDerivatives(
  assets: readonly NormalizedStudioAsset[],
  profiles: readonly KeelWebpProfile[],
): Promise<{ readonly assets: readonly NormalizedStudioAsset[]; readonly derivatives: readonly KeelMediaDerivative[] }> {
  const uniqueProfiles = [...new Set(profiles)];
  if (uniqueProfiles.length === 0) return { assets, derivatives: [] };
  const source = assets.find((asset) => asset.role === "original" && asset.mediaType.startsWith("image/") && asset.mediaType !== "image/svg+xml")
    ?? assets.find((asset) => asset.mediaType.startsWith("image/") && asset.mediaType !== "image/svg+xml");
  if (source === undefined) return { assets, derivatives: [] };
  const usedIds = new Set(assets.map((asset) => asset.id));
  const usedPaths = new Set(assets.map((asset) => asset.fileName));
  const next = [...assets];
  const derivatives: KeelMediaDerivative[] = [];
  for (const profile of uniqueProfiles) {
    const outputResourceId = uniqueResourceId(`derivative:${profile}`, `derivative:${profile}`, usedIds);
    let fileName = `derivatives/${profile}.webp`;
    for (let suffix = 2; usedPaths.has(fileName); suffix += 1) fileName = `derivatives/${profile}-${suffix}.webp`;
    usedPaths.add(fileName);
    const built = await buildKeelWebpDerivative({
      sourceResourceId: source.id,
      outputResourceId,
      sourceBytes: source.bytes,
      profile,
    });
    next.push({
      id: outputResourceId,
      fileName,
      mediaType: "image/webp",
      bytes: built.bytes,
      role: "image",
      executable: false,
      description: `Verified marketplace derivative ${profile}.`,
      entrypoint: false,
      mode: "image",
      sourceMode: "local-and-additional",
    });
    derivatives.push(built.receipt);
  }
  return { assets: next, derivatives };
}

function downloads(resources: readonly PreparedStudioResource[]): readonly ArtifactDownload[] | undefined {
  const values: ArtifactDownload[] = resources
    .filter((item) => item.resource.role === "original")
    .map((item) => {
      const originalName = item.resource.originalName;
      const filename = originalName?.split("/").at(-1);
      return {
        resource: item.resource.id,
        label: `Download ${originalName ?? item.resource.id}`,
        ...(filename === undefined ? {} : { filename }),
      };
    });
  return values.length === 0 ? undefined : values;
}

function fallback(resources: readonly PreparedStudioResource[], entrypointId: string): ArtifactManifest["fallback"] {
  const image = resources.find((item) => item.resource.mediaType.startsWith("image/") && (item.resource.role === "preview" || item.resource.role === "image"));
  const motion = resources.find((item) => item.resource.role === "preview" && item.resource.mediaType === "video/mp4");
  const entrypoint = resources.find((item) => item.resource.id === entrypointId);
  return {
    image: image?.resource.id ?? entrypointId,
    ...(motion !== undefined
      ? { animation: motion.resource.id }
      : entrypoint?.resource.mediaType === "text/html"
        ? { animation: entrypoint.resource.id }
        : {}),
  };
}

function thumbnail(
  resources: readonly PreparedStudioResource[],
  capture?: NonNullable<ArtifactManifest["thumbnail"]>["capture"],
): ArtifactManifest["thumbnail"] {
  const supportedImages = new Set(["image/gif", "image/avif", "image/webp", "image/png", "image/jpeg"]);
  const preview = resources.find((item) => item.resource.role === "preview");
  if (preview === undefined) {
    return capture === undefined
      ? undefined
      : { protocol: KEEL_THUMBNAIL_PROTOCOL, maxBytes: KEEL_MAX_THUMBNAIL_BYTES, capture };
  }
  if (preview.decodedByteLength > KEEL_MAX_THUMBNAIL_BYTES) {
    throw new RangeError(`Thumbnail ${preview.fileName} exceeds the 2 MiB on-chain preview limit.`);
  }
  if (supportedImages.has(preview.resource.mediaType)) {
    return {
      protocol: KEEL_THUMBNAIL_PROTOCOL,
      image: preview.resource.id,
      ...(preview.resource.mediaType === "image/gif" || preview.resource.mediaType === "image/avif" || preview.resource.mediaType === "image/webp"
        ? { animation: preview.resource.id }
        : {}),
      maxBytes: KEEL_MAX_THUMBNAIL_BYTES,
      ...(capture === undefined ? {} : { capture }),
    };
  }
  if (preview.resource.mediaType === "video/mp4") {
    return {
      protocol: KEEL_THUMBNAIL_PROTOCOL,
      animation: preview.resource.id,
      maxBytes: KEEL_MAX_THUMBNAIL_BYTES,
      ...(capture === undefined ? {} : { capture }),
    };
  }
  throw new TypeError(`Preview ${preview.fileName} must be GIF, AVIF, WebP, PNG, JPEG, or MP4.`);
}

function inferredStackRole(asset: NormalizedStudioAsset): KeelComponentRole {
  const lower = asset.fileName.toLowerCase();
  if (asset.entrypoint) return "entrypoint";
  if (lower.includes("wallet") || lower.includes("wagmi") || lower.includes("eip-1193")) return "wallet-runtime";
  if (lower.includes("renderer") || lower.includes("three") || lower.includes("babylon") || lower.includes("p5")) return "renderer";
  if (lower.includes("sprite") && (lower.includes("load") || lower.includes("reader"))) return "sprite-loader";
  if (lower.includes("sprite") || lower.includes("atlas")) return "sprite-atlas";
  if (lower.includes("shader") || /\.(?:glsl|vert|frag)$/u.test(lower)) return "shader";
  if (asset.mediaType.startsWith("audio/")) return "audio";
  if (lower.includes("audio") || lower.includes("sound") || lower.includes("sonant")) return "audio-engine";
  if (asset.mediaType.startsWith("image/")) return "image";
  if (asset.mediaType.startsWith("font/")) return "font";
  if (asset.mediaType.startsWith("model/")) return "model";
  if (asset.mediaType === "text/css") return "style";
  if (asset.mediaType.includes("javascript")) return "script";
  if (asset.mediaType.includes("json") || asset.mediaType.startsWith("text/")) return "data";
  return "other";
}

function inferredComponentFormat(asset: NormalizedStudioAsset): KeelComponentFormat {
  const lower = asset.fileName.toLowerCase();
  if (asset.mediaType === "application/wasm") return "wasm";
  if (!asset.mediaType.includes("javascript")) return "asset";
  if (lower.endsWith(".mjs")) return "es-module";
  if (lower.endsWith(".cjs")) return "commonjs";
  try {
    const code = new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes.subarray(0, Math.min(asset.bytes.byteLength, 32_768)));
    if (/\b(?:import\s+(?:[^('"`]|\()|export\s+(?:default\s+|const\s+|let\s+|var\s+|function\s+|class\s+|\{))/u.test(code)) return "es-module";
    if (/\b(?:module\.exports|exports\.[A-Za-z_$]|require\s*\()/u.test(code)) return "commonjs";
    if (/\bdefine\.amd\b/u.test(code)) return "umd";
  } catch {
    // Invalid textual JavaScript is still committed; later compatibility checks report it.
  }
  return "classic-script";
}

function projectStack(
  normalized: readonly NormalizedStudioAsset[],
  resources: readonly PreparedStudioResource[],
): NonNullable<ArtifactManifest["stack"]> {
  const byId = new Map(resources.map((resource) => [resource.resource.id, resource] as const));
  const components: KeelProjectComponent[] = normalized.map((asset, order) => {
    const resource = byId.get(asset.id);
    if (resource === undefined) throw new Error(`Prepared stack resource ${asset.id} is missing.`);
    const configured = asset.stack;
    return {
      id: asset.id,
      label: configured?.label.trim() || asset.fileName,
      role: configured?.role ?? inferredStackRole(asset),
      order,
      resource: asset.id,
      resourceIntegrity: resource.decodedIntegrity,
      ...(configured?.labelOrigin === undefined ? {} : { labelOrigin: configured.labelOrigin }),
      ...(configured?.library === undefined ? {} : { library: configured.library }),
      format: configured?.format ?? inferredComponentFormat(asset),
      updates: configured?.updates ?? { mode: "manual" },
    };
  });
  return { protocol: "keel-project-stack@1", components };
}

function stats(resources: readonly PreparedStudioResource[]): StudioArtifactStats {
  const decodedByteLength = resources.reduce((sum, item) => sum + item.decodedByteLength, 0);
  const storedByteLength = resources.reduce((sum, item) => sum + item.storedByteLength, 0);
  return {
    resourceCount: resources.length,
    executableResourceCount: resources.filter((item) => item.resource.executable === true).length,
    decodedByteLength,
    storedByteLength,
    bytesSaved: decodedByteLength - storedByteLength,
    compressionRatio: decodedByteLength === 0 ? 1 : storedByteLength / decodedByteLength,
  };
}

export async function prepareStudioArtifact(options: PrepareStudioArtifactOptions): Promise<PreparedStudioArtifact> {
  if (options.id.trim().length === 0 || options.name.trim().length === 0) throw new TypeError("Artifact ID and name are required.");
  const withDerivatives = await appendMediaDerivatives(normalizeAssets(options.assets), options.mediaDerivativeProfiles ?? []);
  const flashRuntime = options.flashRuntime === undefined ? undefined : resolveFlashRuntime(options.flashRuntime, withDerivatives.assets);
  const normalized = ensureEntrypoint(withDerivatives.assets, options.name, options.description, flashRuntime?.wrapper);
  const maxResources = positiveSafe(options.maxResources, 512, "maxResources");
  if (normalized.length > maxResources) throw new RangeError(`Artifact has ${normalized.length} resources; limit is ${maxResources}.`);

  const resources = await Promise.all(normalized.map(prepareResource));
  const entrypoint = normalized.find((asset) => asset.entrypoint);
  if (entrypoint === undefined) throw new Error("Artifact preparation did not produce an entrypoint.");
  const total = stats(resources);
  const maxResourceBytes = positiveSafe(options.maxResourceBytes, 64 * 1024 * 1024, "maxResourceBytes");
  const maxTotalBytes = positiveSafe(options.maxTotalBytes, 256 * 1024 * 1024, "maxTotalBytes");
  if (resources.some((resource) => resource.decodedByteLength > maxResourceBytes)) {
    throw new RangeError(`At least one resource exceeds the ${maxResourceBytes}-byte resource limit.`);
  }
  if (total.decodedByteLength > maxTotalBytes) throw new RangeError(`Artifact exceeds the ${maxTotalBytes}-byte total limit.`);

  const revision = options.revision ?? 1;
  const immutable = options.immutable === true;
  if (immutable && revision !== 1) {
    throw new RangeError("Immutable artifacts must use revision 1.");
  }
  if (immutable && options.parentRevision !== undefined) {
    throw new TypeError("Immutable artifacts cannot declare a parent revision.");
  }
  const artifactDownloads = downloads(resources);
  const artifactThumbnail = thumbnail(resources, options.thumbnailCapture);
  const manifest: ArtifactManifest = {
    schema: KEEL_MANIFEST_SCHEMA,
    canonicalization: KEEL_CANONICALIZATION,
    id: options.id,
    name: options.name,
    ...(options.description === undefined ? {} : { description: options.description }),
    entrypoint: { resource: entrypoint.id, mode: entrypoint.mode },
    resources: resources.map((item) => item.resource),
    stack: projectStack(normalized, resources),
    ...(options.libraries === undefined ? {} : { libraries: options.libraries }),
    ...(options.stakeObject === undefined ? {} : { stakeObject: options.stakeObject }),
    fallback: fallback(resources, entrypoint.id),
    ...(artifactThumbnail === undefined ? {} : { thumbnail: artifactThumbnail }),
    ...(withDerivatives.derivatives.length === 0 ? {} : { mediaDerivatives: withDerivatives.derivatives }),
    runtime: {
      engine: { protocol: KEEL_RUNTIME_PROTOCOL, viewerProtocol: KEEL_VIEWER_PROTOCOL, renderer: "browser" },
      determinism: { mode: "live" },
      content: {
        protocol: KEEL_CONTENT_GATEWAY_PROTOCOL,
        mode: "verified-only",
        externalSources: "host-verified",
        manifestTrust: "digest",
        blockUndeclared: true,
        resourcePathPrefix: "/content/",
        onchainPathPrefix: "/onchain/",
        ipfsPathPrefix: "/ipfs/",
      },
      sandbox: "strict",
      capabilities: { downloads: artifactDownloads !== undefined, webAssembly: resources.some((item) => item.resource.mediaType === "application/wasm") },
      maxResourceBytes,
      maxTotalBytes,
      maxRecursionDepth: 32,
      maxResources,
      timeoutMs: positiveSafe(options.timeoutMs, 30_000, "timeoutMs"),
    },
    revision: {
      number: revision,
      ...(options.parentRevision === undefined ? {} : { parent: options.parentRevision }),
      compatibility: { min: 1, max: revision },
      policy: immutable ? "immutable" : "creator",
      ...(immutable ? { frozen: true } : {}),
    },
    provenance: {
      ...(options.creator === undefined ? {} : { creator: options.creator }),
      createdAt: options.createdAt ?? new Date().toISOString(),
      ...(options.sourceRepository === undefined ? {} : { sourceRepository: options.sourceRepository }),
    },
    ...(artifactDownloads === undefined ? {} : { downloads: artifactDownloads }),
    ...(options.attributions === undefined ? {} : { attributions: options.attributions }),
    extensions: {
      studio: {
        preparedBy: "@keel/studio-core",
        stats: total,
      },
      ...(options.extensions ?? {}),
      ...(flashRuntime === undefined ? {} : { "keel:flash": flashRuntime.extension }),
    },
  };
  assertValidManifest(manifest);
  return { manifest, manifestIntegrity: await manifestIntegrity(manifest), resources, stats: total };
}
