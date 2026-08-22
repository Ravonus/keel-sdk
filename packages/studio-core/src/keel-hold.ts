import {
  KEEL_DIRECTORY_PROTOCOL,
  KEEL_STORAGE_PROTOCOL,
  assertValidKeelStorageGraph,
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  type Integrity,
  type KeelCarrier,
  type KeelDirectoryManifest,
  type KeelStorageGraph,
} from "@keel/protocol";
import { normalizeProjectPath } from "./media.js";
import { buildKeelTezosRecursiveObject, type KeelTezosNode } from "./tezos-recursive.js";
import type { PreparedStudioArtifact, PreparedStudioResource } from "./types.js";

export interface BuiltKeelStorageGraph {
  readonly graph: KeelStorageGraph;
  readonly integrity: Integrity;
  /** De-duplicated encoded nodes ready for append-only recursive storage. */
  readonly nodes: readonly KeelTezosNode[];
}

export interface KeelDirectoryOutputFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly integrity: Integrity;
  readonly resourceId?: string;
}

export interface BuiltKeelDirectory {
  readonly manifest: KeelDirectoryManifest;
  readonly integrity: Integrity;
  readonly files: readonly KeelDirectoryOutputFile[];
}

export interface BuildKeelStorageGraphOptions {
  readonly carriers?: (
    resource: PreparedStudioResource,
    objectId: `0x${string}`,
  ) => readonly KeelCarrier[];
}

function textResource(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "text/css" || mediaType.includes("javascript") || mediaType.includes("json") || mediaType.includes("xml");
}

function referencedPaths(resource: PreparedStudioResource): readonly string[] {
  if (!textResource(resource.resource.mediaType)) return [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(resource.decodedBytes);
  } catch {
    return [];
  }
  const values = new Set<string>();
  const patterns = [
    /\b(?:src|href)\s*=\s*["']([^"']+)["']/giu,
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\burl\(\s*["']?([^"')]+)["']?\s*\)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value !== undefined && value.length > 0) values.add(value);
    }
  }
  return [...values];
}

function dependencyIds(resource: PreparedStudioResource, resources: readonly PreparedStudioResource[]): readonly string[] {
  const byPath = new Map(resources.map((item) => [normalizeProjectPath(item.fileName), item.resource.id] as const));
  const resourcePath = normalizeProjectPath(resource.fileName);
  const slash = resourcePath.lastIndexOf("/");
  const directory = slash < 0 ? "" : resourcePath.slice(0, slash);
  const dependencies = new Set<string>();
  for (const reference of referencedPaths(resource)) {
    if (/^(?:[a-z]+:|\/|#)/iu.test(reference)) continue;
    const withoutQuery = reference.split(/[?#]/u, 1)[0];
    if (withoutQuery === undefined || withoutQuery.length === 0) continue;
    let resolved: string;
    try {
      resolved = normalizeProjectPath(directory.length === 0 ? withoutQuery : `${directory}/${withoutQuery}`);
    } catch {
      continue;
    }
    const id = byPath.get(resolved);
    if (id !== undefined && id !== resource.resource.id) dependencies.add(id);
  }
  return [...dependencies].sort();
}

/** Build one canonical graph of independently compressed resources. No archive is involved. */
export async function buildKeelStorageGraph(
  prepared: PreparedStudioArtifact,
  options: BuildKeelStorageGraphOptions = {},
): Promise<BuiltKeelStorageGraph> {
  const built = await Promise.all(prepared.resources.map(async (resource) => ({
    resource,
    object: await buildKeelTezosRecursiveObject(
      resource.storedBytes,
      "application/vnd.keel.object",
    ),
  })));
  const graph: KeelStorageGraph = {
    protocol: KEEL_STORAGE_PROTOCOL,
    canonicalDigest: "sha256",
    sourceManifest: prepared.manifestIntegrity,
    entrypoint: prepared.manifest.entrypoint.resource,
    resources: built.map(({ resource, object }) => ({
      resourceId: resource.resource.id,
      path: normalizeProjectPath(resource.fileName),
      mediaType: resource.resource.mediaType,
      executable: resource.resource.executable === true,
      decodedIntegrity: resource.decodedIntegrity,
      storedIntegrity: resource.storedIntegrity,
      compression: resource.compression,
      objectId: object.id,
      dependencies: dependencyIds(resource, prepared.resources),
      carriers: [...(options.carriers?.(resource, object.id) ?? [])],
    })),
  };
  assertValidKeelStorageGraph(graph);
  const integrity = await createIntegrity(utf8ToBytes(canonicalJson(graph)));
  const nodes = new Map<string, KeelTezosNode>();
  for (const { object } of built) {
    for (const current of object.nodes) nodes.set(current.id, current);
  }
  return { graph, integrity, nodes: [...nodes.values()] };
}

function wrapper(entrypoint: string): Uint8Array {
  const escaped = entrypoint
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  return utf8ToBytes(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keel artifact</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#05060b}</style></head><body><iframe title="Keel artifact" src="./${escaped}" sandbox="allow-scripts allow-downloads allow-pointer-lock allow-same-origin"></iframe></body></html>`);
}

/**
 * Materialize a same-origin HTML/module directory for OnchFS, IPFS, or a normal
 * web host. Resources remain separate modules and assets; ZIP is optional and
 * may be generated later strictly as a marketplace upload compatibility view.
 */
export async function buildKeelDirectory(
  prepared: PreparedStudioArtifact,
  storage?: BuiltKeelStorageGraph,
): Promise<BuiltKeelDirectory> {
  const graph = storage ?? await buildKeelStorageGraph(prepared);
  const output: KeelDirectoryOutputFile[] = [];
  const entrypointResource = prepared.resources.find((item) => item.resource.id === prepared.manifest.entrypoint.resource);
  if (entrypointResource === undefined) throw new Error("Keel directory entrypoint is missing.");
  const entrypointPath = normalizeProjectPath(entrypointResource.fileName);
  if (entrypointPath !== "index.html") {
    const bytes = wrapper(entrypointPath);
    output.push({ path: "index.html", bytes, mediaType: "text/html", integrity: await createIntegrity(bytes) });
  }
  for (const resource of prepared.resources) {
    const filePath = normalizeProjectPath(resource.fileName);
    if (filePath === "keel-hold.json" || (filePath === "index.html" && output.some((item) => item.path === "index.html"))) {
      throw new TypeError(`Reserved Keel directory path: ${filePath}`);
    }
    output.push({
      path: filePath,
      bytes: resource.decodedBytes.slice(),
      mediaType: resource.resource.mediaType,
      integrity: resource.decodedIntegrity,
      resourceId: resource.resource.id,
    });
  }
  const draft: KeelDirectoryManifest = {
    protocol: KEEL_DIRECTORY_PROTOCOL,
    sourceManifest: prepared.manifestIntegrity,
    storageGraph: graph.integrity,
    root: "index.html",
    files: output.map((file) => ({
      path: file.path,
      ...(file.resourceId === undefined ? {} : { resourceId: file.resourceId }),
      integrity: file.integrity,
      mediaType: file.mediaType,
    })),
  };
  const manifestBytes = utf8ToBytes(canonicalJson(draft));
  const manifestFile: KeelDirectoryOutputFile = {
    path: "keel-hold.json",
    bytes: manifestBytes,
    mediaType: "application/json",
    integrity: await createIntegrity(manifestBytes),
  };
  const files = [...output, manifestFile];
  return { manifest: draft, integrity: manifestFile.integrity, files };
}
