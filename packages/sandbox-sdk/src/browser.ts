import {
  OCA_CANONICALIZATION,
  OCA_CONTENT_GATEWAY_PROTOCOL,
  OCA_MANIFEST_SCHEMA,
  OCA_RUNTIME_PROTOCOL,
  OCA_VIEWER_PROTOCOL,
  KEEL_PROJECT_STACK_PROTOCOL,
  assertValidManifest,
  createIntegrity,
  manifestIntegrity,
  utf8ToBytes,
  type ArtifactManifest,
  type ArtifactResource,
  type Integrity,
  type ResourceRole,
  type KeelComponentFormat,
  type KeelComponentRole,
} from "@keel/protocol";
import {
  createSandboxDocument,
  resolveArtifact,
  type FetchResponseLike,
  type ResolutionAudit,
  type SandboxDocument,
} from "@keel/viewer";

import { inspectSandboxManifest } from "./inspect.js";
import type { SandboxInspectionReport } from "./types.js";

const BASE_URL = "https://sandbox.oca.invalid/project/";

export interface BrowserSandboxFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface BrowserSandboxInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly creator?: string;
  readonly revision?: number;
  readonly files: readonly BrowserSandboxFile[];
}

export interface PreparedBrowserSandbox {
  readonly manifest: ArtifactManifest;
  readonly manifestIntegrity: Integrity;
  readonly report: SandboxInspectionReport;
  readonly audit: ResolutionAudit;
  readonly sandbox: SandboxDocument;
}

interface NormalizedBrowserFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export async function prepareBrowserSandboxProject(input: BrowserSandboxInput): Promise<PreparedBrowserSandbox> {
  const files = withBrowserEntrypoint(normalizeFiles(input.files));
  const entry = chooseEntrypoint(files);
  const resources = await Promise.all(files.map((file) => browserResource(file, file.path === entry.path)));
  const manifest = browserManifest(input, resources, entry);
  assertValidManifest(manifest);
  const integrity = await manifestIntegrity(manifest);
  const locations = new Map(resources.map((resource, index) => [
    new URL(resource.sources[0]?.kind === "uri" ? resource.sources[0].uri : "", BASE_URL).toString(),
    files[index]?.bytes ?? new Uint8Array(),
  ]));
  const resolved = await resolveArtifact(manifest, {
    baseUrl: BASE_URL,
    sourceAllowlist: [BASE_URL],
    commitment: { integrity, digestVerified: true, sourceUrl: `${BASE_URL}manifest.json` },
    adapters: {
      fetch: async (url) => byteResponse(locations.get(url), url),
    },
  });
  return {
    manifest,
    manifestIntegrity: integrity,
    report: await inspectSandboxManifest(manifest),
    audit: resolved.audit,
    sandbox: createSandboxDocument(resolved),
  };
}

function normalizeFiles(input: readonly BrowserSandboxFile[]): readonly NormalizedBrowserFile[] {
  if (input.length === 0) throw new RangeError("A browser sandbox needs at least one file.");
  const seen = new Set<string>();
  return input.map((file) => {
    const path = normalizedPath(file.path);
    if (seen.has(path)) throw new TypeError(`Duplicate sandbox path: ${path}`);
    seen.add(path);
    if (!ArrayBuffer.isView(file.bytes) || file.bytes.BYTES_PER_ELEMENT !== 1 || file.bytes.byteLength === 0) {
      throw new RangeError(`${path} must contain bytes.`);
    }
    return { path, bytes: new Uint8Array(file.bytes), mediaType: file.mediaType ?? inferredMediaType(path) };
  });
}

function withBrowserEntrypoint(files: readonly NormalizedBrowserFile[]): readonly NormalizedBrowserFile[] {
  if (files.some((file) => isEntrypointMedia(file.mediaType))) return files;
  const wasm = files.find((file) => file.mediaType === "application/wasm");
  if (wasm === undefined) return files;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>WASM sandbox</title></head><body><main><strong>Checking ${escapeHtml(wasm.path)}…</strong><pre id="result"></pre></main><script type="module">const result=document.querySelector('#result');try{const response=await fetch(${JSON.stringify(`./${wasm.path}`)});const module=await WebAssembly.compile(await response.arrayBuffer());result.textContent='WASM verified locally. Imports: '+WebAssembly.Module.imports(module).length+' · Exports: '+WebAssembly.Module.exports(module).length}catch(error){result.textContent='WASM check failed: '+String(error)}</script></body></html>`;
  return [{ path: "index.html", bytes: utf8ToBytes(html), mediaType: "text/html" }, ...files];
}

function chooseEntrypoint(files: readonly NormalizedBrowserFile[]): NormalizedBrowserFile {
  const entry = files.find((file) => file.path === "index.html")
    ?? files.find((file) => isEntrypointMedia(file.mediaType))
    ?? files[0];
  if (entry === undefined) throw new RangeError("A browser sandbox needs an entrypoint.");
  return entry;
}

async function browserResource(file: NormalizedBrowserFile, entrypoint: boolean): Promise<ArtifactResource> {
  const integrity = await createIntegrity(file.bytes);
  return {
    id: file.path,
    role: entrypoint ? "entrypoint" : resourceRole(file.mediaType),
    mediaType: file.mediaType,
    executable: entrypoint || isExecutable(file.mediaType),
    originalName: file.path,
    aliases: [`/content/${file.path.split("/").map(encodeURIComponent).join("/")}`],
    sources: [{ kind: "uri", uri: relativeUri(file.path), integrity, immutable: true }],
    extensions: {
      studio: { compression: "none", storedIntegrity: integrity, storedByteLength: file.bytes.byteLength },
    },
  };
}

function browserManifest(
  input: BrowserSandboxInput,
  resources: readonly ArtifactResource[],
  entry: NormalizedBrowserFile,
): ArtifactManifest {
  const entryResource = resources.find((resource) => resource.id === entry.path);
  if (entryResource === undefined) throw new Error("The browser sandbox entrypoint was not prepared.");
  const image = resources.find((resource) => resource.mediaType.startsWith("image/"));
  const motion = resources.find((resource) => resource.mediaType.startsWith("video/"));
  return {
    schema: OCA_MANIFEST_SCHEMA,
    canonicalization: OCA_CANONICALIZATION,
    id: input.id,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    entrypoint: { resource: entry.path, mode: entrypointMode(entry.mediaType) },
    resources,
    stack: {
      protocol: KEEL_PROJECT_STACK_PROTOCOL,
      components: resources.map((resource, order) => ({
        id: resource.id,
        label: resource.originalName ?? resource.id,
        role: componentRole(resource, entry.path),
        order,
        resource: resource.id,
        resourceIntegrity: resource.sources[0]?.integrity ?? { algorithm: "none", digest: "0x" },
        format: componentFormat(resource.mediaType),
        updates: { mode: "manual" },
      })),
    },
    fallback: {
      image: image?.id ?? entryResource.id,
      ...(motion === undefined ? {} : { animation: motion.id }),
    },
    runtime: {
      engine: { protocol: OCA_RUNTIME_PROTOCOL, viewerProtocol: OCA_VIEWER_PROTOCOL, renderer: "browser" },
      determinism: { mode: "live" },
      content: {
        protocol: OCA_CONTENT_GATEWAY_PROTOCOL,
        mode: "verified-only",
        externalSources: "host-verified",
        manifestTrust: "digest",
        blockUndeclared: true,
        resourcePathPrefix: "/content/",
        onchainPathPrefix: "/onchain/",
        ipfsPathPrefix: "/ipfs/",
      },
      sandbox: "strict",
      capabilities: { downloads: false, webAssembly: resources.some((resource) => resource.mediaType === "application/wasm") },
      maxResourceBytes: 64 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024,
      maxRecursionDepth: 32,
      maxResources: 512,
      timeoutMs: 30_000,
    },
    revision: { number: input.revision ?? 1, compatibility: { min: 1, max: 1 }, policy: "creator" },
    provenance: { createdAt: "1970-01-01T00:00:00.000Z", ...(input.creator === undefined ? {} : { creator: input.creator }) },
    extensions: { sandbox: { preparedBy: "@keel/sandbox-sdk/browser", persistence: "none", networkWrites: false } },
  };
}

function byteResponse(bytes: Uint8Array | undefined, url: string): FetchResponseLike {
  return bytes === undefined
    ? { ok: false, status: 404, statusText: "Not Found", url, async arrayBuffer() { return new ArrayBuffer(0); } }
    : { ok: true, status: 200, statusText: "OK", url, async arrayBuffer() { return bytes.slice().buffer; } };
}

function normalizedPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path === "" || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`Unsafe sandbox path: ${value}`);
  }
  return path;
}

function relativeUri(path: string): string {
  return `./${path.split("/").map(encodeURIComponent).join("/")}`;
}

function inferredMediaType(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  return ({ html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", json: "application/json" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function isEntrypointMedia(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "text/javascript" || mediaType.startsWith("image/") || mediaType.startsWith("video/") || mediaType.startsWith("audio/");
}

function isExecutable(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "text/javascript" || mediaType === "application/wasm";
}

function entrypointMode(mediaType: string): ArtifactManifest["entrypoint"]["mode"] {
  if (mediaType === "text/html") return "html";
  if (mediaType === "text/javascript") return "module";
  if (mediaType === "image/svg+xml") return "svg";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "model";
}

function resourceRole(mediaType: string): ResourceRole {
  if (mediaType === "text/javascript") return "script";
  if (mediaType === "text/css") return "style";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType === "application/json") return "data";
  return "other";
}

function componentRole(resource: ArtifactResource, entrypointId: string): KeelComponentRole {
  if (resource.id === entrypointId) return "entrypoint";
  if (resource.mediaType === "text/javascript") return "module";
  if (resource.mediaType === "text/css") return "style";
  if (resource.mediaType === "application/wasm") return "runtime";
  if (resource.mediaType.startsWith("image/")) return "image";
  if (resource.mediaType.startsWith("audio/")) return "audio";
  if (resource.mediaType === "application/json") return "data";
  return "other";
}

function componentFormat(mediaType: string): KeelComponentFormat {
  if (mediaType === "text/javascript") return "es-module";
  if (mediaType === "application/wasm") return "wasm";
  return "asset";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
