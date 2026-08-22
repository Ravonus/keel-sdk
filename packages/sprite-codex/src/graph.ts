import type { SpriteBundleRevisionRef, SpriteLibraryBuildManifest, SpriteLibraryBundleBuild } from "./types.js";

function refKey(ref: SpriteBundleRevisionRef): string {
  return `${ref.bundleId}@${ref.revision}`;
}

export function resolveProfilePlan(graph: SpriteLibraryBuildManifest, profileId: string, profileRevision: number): SpriteLibraryBundleBuild[] {
  const profile = graph.profiles.find((entry) => entry.id === profileId && entry.revision === profileRevision);
  if (profile === undefined) throw new Error(`unknown sprite library profile ${profileId}@${profileRevision}`);
  const byRef = new Map(graph.bundles.map((bundle) => [refKey(bundle), bundle]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: SpriteLibraryBundleBuild[] = [];
  const visit = (reference: SpriteBundleRevisionRef): void => {
    const key = refKey(reference);
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`sprite bundle dependency cycle at ${key}`);
    const bundle = byRef.get(key);
    if (bundle === undefined) throw new Error(`unknown sprite bundle ${key}`);
    visiting.add(key);
    for (const dependency of bundle.dependencies) visit(dependency);
    visiting.delete(key);
    visited.add(key);
    ordered.push(bundle);
  };
  for (const root of profile.roots) visit(root);
  return ordered;
}
