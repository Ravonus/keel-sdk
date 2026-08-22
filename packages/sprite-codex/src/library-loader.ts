import { sha256 } from "./hash.js";
import { loadSpriteCodex, type SpriteCodexLoadOptions, SpriteCodex } from "./loader.js";
import { resolveProfilePlan } from "./graph.js";
import {
  SPRITE_BUILD_SCHEMA,
  SPRITE_LIBRARY_BUILD_SCHEMA,
  type SpriteBuildManifest,
  type SpriteLibraryBuildManifest,
  type SpriteLibraryBundleBuild,
  type SpriteCodexLimits,
} from "./types.js";

export interface SpriteLibraryLoadOptions {
  graphUrl: string | URL;
  /** Required for relative graphUrl outside a browser; browsers default to document.baseURI. */
  baseUrl?: string | URL;
  graphSha256: string;
  profileId: string;
  profileRevision: number;
  fetch?: typeof globalThis.fetch;
  maxGraphBytes?: number;
  maxBundleManifestBytes?: number;
  maxBundles?: number;
  spriteLimits?: Partial<SpriteCodexLimits>;
  loadBundle?: (bundle: SpriteLibraryBundleBuild, build: SpriteBuildManifest, buildUrl: URL) => Promise<SpriteCodex>;
}

function digest(value: string): string {
  const normalized = value.toLowerCase().replace(/^sha256[:-]?/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("expected a 32-byte SHA-256 digest");
  return normalized;
}

async function bytes(fetcher: typeof globalThis.fetch, url: string | URL, limit: number): Promise<Uint8Array> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`failed to load ${String(url)}: HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new Error(`resource ${String(url)} exceeds byte limit ${limit}`);
  if (response.body === null) {
    const output = new Uint8Array(await response.arrayBuffer());
    if (output.length > limit) throw new Error(`resource ${String(url)} exceeds byte limit ${limit}`);
    return output;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const result = await reader.read(); if (result.done) break;
    length += result.value.length;
    if (length > limit) { await reader.cancel("sprite library byte limit exceeded"); throw new Error(`resource ${String(url)} exceeds byte limit ${limit}`); }
    chunks.push(result.value);
  }
  const output = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function parseGraph(value: unknown, maxBundles: number): SpriteLibraryBuildManifest {
  if (value === null || typeof value !== "object") throw new Error("sprite library graph must be an object");
  const graph = value as Partial<SpriteLibraryBuildManifest>;
  if (graph.schema !== SPRITE_LIBRARY_BUILD_SCHEMA || typeof graph.id !== "string") throw new Error(`expected schema ${SPRITE_LIBRARY_BUILD_SCHEMA}`);
  if (!Array.isArray(graph.bundles) || graph.bundles.length === 0 || graph.bundles.length > maxBundles) throw new Error("invalid sprite library bundle count");
  if (!Array.isArray(graph.profiles) || graph.profiles.length === 0 || graph.profiles.length > maxBundles) throw new Error("invalid sprite library profile count");
  if (graph.inventory === undefined || typeof graph.inventory.file !== "string") throw new Error("sprite library inventory commitment is missing");
  digest(graph.inventory.sha256);
  const refs = new Set<string>();
  const keys = new Set<string>();
  for (const bundle of graph.bundles) {
    if (!Number.isSafeInteger(bundle.bundleId) || bundle.bundleId <= 0 || !Number.isSafeInteger(bundle.revision) || bundle.revision <= 0) throw new Error("invalid sprite bundle identity");
    const ref = `${bundle.bundleId}@${bundle.revision}`;
    const keyed = `${bundle.key}@${bundle.revision}`;
    if (refs.has(ref) || keys.has(keyed)) throw new Error(`duplicate sprite bundle ${ref}`);
    refs.add(ref); keys.add(keyed);
    if (typeof bundle.buildManifest !== "string" || bundle.buildManifest.length === 0 || typeof bundle.role !== "string" || !Array.isArray(bundle.dependencies)) throw new Error(`invalid sprite bundle ${ref}`);
    digest(bundle.buildManifestSha256);
  }
  for (const bundle of graph.bundles) {
    const dependencies = new Set<string>();
    for (const dependency of bundle.dependencies) {
      const ref = `${dependency.bundleId}@${dependency.revision}`;
      if (!refs.has(ref)) throw new Error(`unknown dependency ${ref}`);
      if (ref === `${bundle.bundleId}@${bundle.revision}`) throw new Error(`sprite bundle ${ref} depends on itself`);
      if (dependencies.has(ref)) throw new Error(`sprite bundle ${bundle.bundleId}@${bundle.revision} repeats dependency ${ref}`);
      dependencies.add(ref);
    }
  }
  const profiles = new Set<string>();
  for (const profile of graph.profiles) {
    const key = `${profile.id}@${profile.revision}`;
    if (typeof profile.id !== "string" || !Number.isSafeInteger(profile.revision) || profile.revision <= 0 || profiles.has(key) || !Array.isArray(profile.roots) || profile.roots.length === 0) throw new Error(`invalid or duplicate sprite profile ${key}`);
    profiles.add(key);
    const roots = new Set<string>();
    for (const root of profile.roots) {
      const ref = `${root.bundleId}@${root.revision}`;
      if (!refs.has(ref)) throw new Error(`sprite profile ${key} references unknown bundle ${ref}`);
      if (roots.has(ref)) throw new Error(`sprite profile ${key} repeats root ${ref}`);
      roots.add(ref);
    }
  }
  for (const profile of graph.profiles) resolveProfilePlan(graph as SpriteLibraryBuildManifest, profile.id, profile.revision);
  for (const bundle of graph.bundles) resolveProfilePlan({ ...(graph as SpriteLibraryBuildManifest), profiles: [{ id: "bundle-audit", revision: 1, roots: [{ bundleId: bundle.bundleId, revision: bundle.revision }] }] }, "bundle-audit", 1);
  return graph as SpriteLibraryBuildManifest;
}

function parseBuild(value: unknown, bundle: SpriteLibraryBundleBuild): SpriteBuildManifest {
  if (value === null || typeof value !== "object") throw new Error(`bundle ${bundle.key} build manifest must be an object`);
  const build = value as Partial<SpriteBuildManifest>;
  if (build.schema !== SPRITE_BUILD_SCHEMA || typeof build.id !== "string" || build.id.length === 0 || build.atlas === undefined || build.codex === undefined) throw new Error(`bundle ${bundle.key} has an invalid build manifest`);
  if (typeof build.atlas.file !== "string" || typeof build.codex.file !== "string") throw new Error(`bundle ${bundle.key} build filenames are invalid`);
  digest(build.atlas.sha256); digest(build.codex.sha256);
  return build as SpriteBuildManifest;
}

export class SpriteLibrary {
  readonly graph: SpriteLibraryBuildManifest;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly #bundles: ReadonlyMap<string, SpriteCodex>;

  constructor(graph: SpriteLibraryBuildManifest, profileId: string, profileRevision: number, bundles: ReadonlyMap<string, SpriteCodex>) {
    this.graph = graph; this.profileId = profileId; this.profileRevision = profileRevision; this.#bundles = bundles;
  }

  bundle(idOrKey: number | string, revision?: number): SpriteCodex {
    const candidates = this.graph.bundles.filter((entry) => typeof idOrKey === "number" ? entry.bundleId === idOrKey : entry.key === idOrKey);
    const selected = revision === undefined
      ? [...candidates].reverse().find((entry) => this.#bundles.has(`${entry.bundleId}@${entry.revision}`))
      : candidates.find((entry) => entry.revision === revision);
    if (selected === undefined) {
      if (candidates.length > 0) throw new Error(`sprite bundle ${String(idOrKey)} is not in profile ${this.profileId}@${this.profileRevision}`);
      throw new Error(`unknown loaded sprite bundle ${String(idOrKey)}${revision === undefined ? "" : `@${revision}`}`);
    }
    const value = this.#bundles.get(`${selected.bundleId}@${selected.revision}`);
    if (value === undefined) throw new Error(`sprite bundle ${selected.key}@${selected.revision} is not in profile ${this.profileId}@${this.profileRevision}`);
    return value;
  }

  dispose(): void {
    for (const bundle of this.#bundles.values()) bundle.dispose();
  }
}

export async function loadSpriteLibrary(options: SpriteLibraryLoadOptions): Promise<SpriteLibrary> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (fetcher === undefined) throw new Error("fetch is unavailable");
  const maxGraphBytes = options.maxGraphBytes ?? 1024 * 1024;
  const maxBundleManifestBytes = options.maxBundleManifestBytes ?? 256 * 1024;
  const maxBundles = options.maxBundles ?? 256;
  for (const [label, value] of [["maxGraphBytes", maxGraphBytes], ["maxBundleManifestBytes", maxBundleManifestBytes], ["maxBundles", maxBundles]] as const) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label}`);
  const browserBase = typeof document === "undefined" ? undefined : document.baseURI;
  let graphUrl: URL;
  try { graphUrl = options.graphUrl instanceof URL ? options.graphUrl : new URL(options.graphUrl, options.baseUrl ?? browserBase); }
  catch { throw new Error("relative sprite library graphUrl requires baseUrl outside a browser"); }
  const graphBytes = await bytes(fetcher, graphUrl, maxGraphBytes);
  if (await sha256(graphBytes) !== digest(options.graphSha256)) throw new Error("sprite library graph SHA-256 mismatch");
  const graph = parseGraph(JSON.parse(new TextDecoder().decode(graphBytes)) as unknown, maxBundles);
  const plan = resolveProfilePlan(graph, options.profileId, options.profileRevision);
  if (plan.length > maxBundles) throw new Error("resolved sprite library exceeds bundle limit");
  const loaded = new Map<string, SpriteCodex>();
  try {
    for (const bundle of plan) {
      const buildUrl = new URL(bundle.buildManifest, graphUrl);
      const buildBytes = await bytes(fetcher, buildUrl, maxBundleManifestBytes);
      if (await sha256(buildBytes) !== digest(bundle.buildManifestSha256)) throw new Error(`sprite bundle ${bundle.key} build manifest SHA-256 mismatch`);
      const build = parseBuild(JSON.parse(new TextDecoder().decode(buildBytes)) as unknown, bundle);
      const codex = options.loadBundle === undefined
        ? await loadSpriteCodex({
          codexUrl: new URL(build.codex.file, buildUrl), atlasUrl: new URL(build.atlas.file, buildUrl),
          codexSha256: build.codex.sha256, atlasSha256: build.atlas.sha256, fetch: fetcher, limits: options.spriteLimits,
        } as SpriteCodexLoadOptions)
        : await options.loadBundle(bundle, build, buildUrl);
      loaded.set(`${bundle.bundleId}@${bundle.revision}`, codex);
    }
    return new SpriteLibrary(graph, options.profileId, options.profileRevision, loaded);
  } catch (error) {
    for (const bundle of loaded.values()) bundle.dispose();
    throw error;
  }
}
