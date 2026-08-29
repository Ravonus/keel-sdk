// p5.brush as a Keel shared module.
//
// Mirrors examples/agent-p5-project/project.mjs: the library is pinned by
// digest and byte length here, and becomes publishable the moment a carrier
// binding (store + objectId) exists for it on a chain. Until then the entry
// is the reviewable declaration a staging run consumes — the artwork itself
// never bundles the library, it references the shared on-chain copy.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const P5_BRUSH_ID = "p5.brush";
export const P5_BRUSH_VERSION = "1.1.4";
export const P5_BRUSH_DIGEST = "sha256:9b13697c3d545973a37233b551504cdacc82fa9539395103b202b7c4f787f411";
export const P5_BRUSH_BYTE_LENGTH = 36_861;
export const P5_BRUSH_MEDIA_TYPE = "text/javascript";
export const P5_BRUSH_LICENSE = "MIT";
export const P5_BRUSH_SOURCE = "https://registry.npmjs.org/p5.brush/-/p5.brush-1.1.4.tgz";

/** The vendored bytes this declaration commits to. */
export function vendoredPath() {
  return fileURLToPath(new URL("../vendor/p5.brush.min.js", import.meta.url));
}

export async function vendoredBytes() {
  return new Uint8Array(await readFile(vendoredPath()));
}

/**
 * Builds the shared-library index entry once a carrier binding exists.
 * `sdk` is `@keel/sdk`'s module surface (packages/sdk/dist/module/index.js) —
 * passed in so this file stays importable without a built workspace.
 *
 * @param sdk `{ externalModuleIndexEntry }`
 * @param binding `{ objectId, store, chain }` — the on-chain carrier.
 */
export function p5BrushIndexEntry(sdk, binding) {
  return sdk.externalModuleIndexEntry(
    P5_BRUSH_ID, P5_BRUSH_VERSION, "keel.system",
    P5_BRUSH_DIGEST, P5_BRUSH_BYTE_LENGTH, P5_BRUSH_MEDIA_TYPE,
    binding.objectId, binding.store, binding.chain,
    `${P5_BRUSH_ID}@${P5_BRUSH_VERSION}`, P5_BRUSH_DIGEST,
    undefined, undefined, "shared-library", "publisher-attested",
    // p5.brush attaches to the p5 runtime already shared on chain.
    "p5.js",
  );
}
