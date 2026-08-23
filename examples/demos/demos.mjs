// Shared catalogue for the Keel demo gallery.
//
// The Node test suite and the Studio seeder both read from here so that the
// artifacts proven by `pnpm test` are byte-identical to the ones published to
// the local chain by `pnpm studio:seed-demos`.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const demosDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Each demo lists its resources in load order. `file` is relative to the demo
 * directory, `id` becomes the /content/<id> gateway route the HTML references.
 */
export const DEMOS = [
  {
    id: "keel-three-vault",
    slug: "three-vault",
    name: "Vault Of The Fallen",
    tagline:
      "A complete 3D library, committed on chain and verified byte-for-byte.",
    description:
      "A procedural three.js chamber generated from the token seed. three.js is an ordinary manifest resource: the sandbox only imports it after its declared SHA-256 matches the bytes the gateway returns. This is the artifact behind the whitepaper's storage claim.",
    accent: "#59e5ff",
    license: "MIT",
    directory: "three-vault",
    entrypointResourceId: "index.html",
    resources: [
      {
        id: "index.html",
        role: "entrypoint",
        mediaType: "text/html",
        file: "index.html",
        executable: true,
      },
      {
        id: "three.min.js",
        role: "script",
        mediaType: "text/javascript",
        file: "../vendor/three.min.js",
        executable: true,
      },
      // three.js ships as a two-module graph; the second half is resolved
      // through the gateway exactly like the first.
      {
        id: "three.core.min.js",
        role: "script",
        mediaType: "text/javascript",
        file: "../vendor/three.core.min.js",
        executable: true,
      },
      {
        id: "scene.js",
        role: "script",
        mediaType: "text/javascript",
        file: "scene.js",
        executable: true,
      },
      {
        id: "poster.webp",
        role: "preview",
        mediaType: "image/webp",
        file: "poster.webp",
      },
    ],
  },
  {
    id: "keel-p5-flowfield",
    slug: "p5-flowfield",
    name: "Synthwave Flow Field",
    tagline:
      "1400 seeded particles; the sketch and p5.js both arrive verified.",
    description:
      "A deterministic p5.js sketch. Every value derives from the seed pinned in the manifest, so two viewers resolving the same manifest paint the same frames — the artifact is reproducible, not merely re-runnable.",
    accent: "#ff8ad4",
    license: "MIT AND LGPL-2.1-only",
    directory: "p5-flowfield",
    entrypointResourceId: "index.html",
    resources: [
      {
        id: "index.html",
        role: "entrypoint",
        mediaType: "text/html",
        file: "index.html",
        executable: true,
      },
      {
        id: "p5.min.js",
        role: "script",
        mediaType: "text/javascript",
        file: "../vendor/p5.min.js",
        executable: true,
      },
      {
        id: "sketch.js",
        role: "script",
        mediaType: "text/javascript",
        file: "sketch.js",
        executable: true,
      },
      {
        id: "poster.webp",
        role: "preview",
        mediaType: "image/webp",
        file: "poster.webp",
      },
    ],
  },
  {
    id: "keel-soundbox-sfx",
    slug: "soundbox-synth",
    name: "On-Chain SFX",
    tagline:
      "Three sounds stored as synthesis parameters. No samples, no recordings.",
    description:
      "The original Keel Sonant-X patches, compiled from human JSON into a versioned binary codec. A verified AI-friendly reader API expands 58-byte and 60-byte effects into deterministic stereo PCM in the browser; no recording or sample fallback is stored.",
    accent: "#c6a1ff",
    license: "MIT AND LicenseRef-Ravonus-Keel-Research",
    directory: "soundbox-synth",
    entrypointResourceId: "index.html",
    resources: [
      {
        id: "index.html",
        role: "entrypoint",
        mediaType: "text/html",
        file: "index.html",
        executable: true,
      },
      {
        id: "keel-readers.js",
        role: "library",
        mediaType: "text/javascript",
        file: "../../../packages/viewer/dist/readers.js",
        executable: true,
      },
      {
        id: "synth.js",
        role: "script",
        mediaType: "text/javascript",
        file: "synth.js",
        executable: true,
      },
      {
        id: "shot.ocas",
        role: "audio",
        mediaType: "application/octet-stream",
        file: "shot.ocas",
      },
      {
        id: "laser.ocas",
        role: "audio",
        mediaType: "application/octet-stream",
        file: "laser.ocas",
      },
      {
        id: "song.ocas",
        role: "audio",
        mediaType: "application/octet-stream",
        file: "song.ocas",
      },
      {
        id: "poster.webp",
        role: "preview",
        mediaType: "image/webp",
        file: "poster.webp",
      },
    ],
  },
  {
    id: "keel-sprite-forge",
    slug: "sprite-forge",
    name: "Sprite Forge",
    tagline:
      "Eight real sprite frames from a 63-byte atlas; colour stays separate.",
    description:
      "Five original 128×16 WebP layers become eight real 16×16 sprites through a 63-byte atlas. The verified reader crops matching frames, applies per-layer colour without baking variants, and advances at a caller-controlled FPS.",
    accent: "#7ce7c4",
    license: "MIT",
    directory: "sprite-forge",
    entrypointResourceId: "index.html",
    resources: [
      {
        id: "index.html",
        role: "entrypoint",
        mediaType: "text/html",
        file: "index.html",
        executable: true,
      },
      {
        id: "keel-readers.js",
        role: "library",
        mediaType: "text/javascript",
        file: "../../../packages/viewer/dist/readers.js",
        executable: true,
      },
      {
        id: "forge.js",
        role: "script",
        mediaType: "text/javascript",
        file: "forge.js",
        executable: true,
      },
      {
        id: "atlas.ocaa",
        role: "data",
        mediaType: "application/octet-stream",
        file: "atlas.ocaa",
      },
      {
        id: "body.webp",
        role: "image",
        mediaType: "image/webp",
        file: "body.webp",
      },
      {
        id: "legs.webp",
        role: "image",
        mediaType: "image/webp",
        file: "legs.webp",
      },
      {
        id: "shirt.webp",
        role: "image",
        mediaType: "image/webp",
        file: "shirt.webp",
      },
      {
        id: "hair.webp",
        role: "image",
        mediaType: "image/webp",
        file: "hair.webp",
      },
      {
        id: "gun.webp",
        role: "image",
        mediaType: "image/webp",
        file: "gun.webp",
      },
      {
        id: "poster.webp",
        role: "preview",
        mediaType: "image/webp",
        file: "poster.webp",
      },
    ],
  },
  {
    id: "keel-vault-arcade",
    slug: "vault-arcade",
    name: "Vault Arcade",
    tagline:
      "An endless seeded arena where every map revision is the same challenge for everyone.",
    description:
      "A top-down eight-direction roguelike arena fighter with deterministic infinite waves, modular character layers, original WebP atlases, enemies, projectiles and pickups. A map can keep this default runtime or replace the complete verified resource graph.",
    accent: "#ffb12e",
    license: "LicenseRef-Ravonus-Keel-Research",
    directory: "vault-arcade",
    entrypointResourceId: "index.html",
    resources: [
      {
        id: "index.html",
        role: "entrypoint",
        mediaType: "text/html",
        file: "index.html",
        executable: true,
      },
      {
        id: "game.js",
        role: "script",
        mediaType: "text/javascript",
        file: "game.js",
        executable: true,
      },
      {
        id: "procedural-sprite-rig.js",
        role: "library",
        mediaType: "text/javascript",
        file: "procedural-sprite-rig.js",
        executable: true,
      },
      {
        id: "sidearm-still-rig.json",
        role: "data",
        mediaType: "application/json",
        file: "sidearm-still-rig.json",
      },
      {
        id: "about.json",
        role: "data",
        mediaType: "application/json",
        file: "about.json",
      },
      {
        id: "asset-manifest.json",
        role: "data",
        mediaType: "application/json",
        file: "asset-manifest.json",
      },
      {
        id: "character-catalog.json",
        role: "data",
        mediaType: "application/json",
        file: "character-catalog.json",
      },
      {
        id: "character-catalog.octr",
        role: "data",
        mediaType: "application/octet-stream",
        file: "character-catalog.octr",
      },
      {
        id: "character-material-0.ocmp",
        role: "data",
        mediaType: "application/octet-stream",
        file: "character-material-0.ocmp",
      },
      {
        id: "character-material-1.ocmp",
        role: "data",
        mediaType: "application/octet-stream",
        file: "character-material-1.ocmp",
      },
      {
        id: "character-material-2.ocmp",
        role: "data",
        mediaType: "application/octet-stream",
        file: "character-material-2.ocmp",
      },
      {
        id: "character-material-3.ocmp",
        role: "data",
        mediaType: "application/octet-stream",
        file: "character-material-3.ocmp",
      },
      {
        id: "character-parts-eight-direction-168.webp",
        role: "image",
        mediaType: "image/webp",
        file: "assets/character-parts-eight-direction-168.webp",
      },
      {
        id: "vault-tiles.webp",
        role: "image",
        mediaType: "image/webp",
        file: "assets/vault-tiles.webp",
      },
      {
        id: "tintable-kit.webp",
        role: "image",
        mediaType: "image/webp",
        file: "assets/tintable-kit.webp",
      },
    ],
  },
];

export function demoById(id) {
  const demo = DEMOS.find((candidate) => candidate.id === id);
  if (demo === undefined) throw new Error(`Unknown demo ${id}.`);
  return demo;
}

export function resourcePath(demo, resource) {
  return path.resolve(demosDirectory, demo.directory, resource.file);
}

/** Reads every resource of a demo as raw bytes, preserving catalogue order. */
export async function readDemoResources(demo) {
  return Promise.all(
    demo.resources.map(async (resource) => ({
      ...resource,
      path: resourcePath(demo, resource),
      bytes: new Uint8Array(await readFile(resourcePath(demo, resource))),
    })),
  );
}

/** Cheap existence/size probe used by the structure checks. */
export async function demoResourceSizes(demo) {
  return Promise.all(
    demo.resources.map(async (resource) => ({
      id: resource.id,
      byteLength: (await stat(resourcePath(demo, resource))).size,
    })),
  );
}
