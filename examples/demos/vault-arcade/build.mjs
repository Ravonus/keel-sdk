import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const required = [
  "index.html",
  "game.js",
  "procedural-sprite-rig.js",
  "sidearm-still-rig.json",
  "about.json",
  "asset-manifest.json",
  "character-catalog.json",
  "character-catalog.octr",
  "character-material-0.ocmp",
  "character-material-1.ocmp",
  "character-material-2.ocmp",
  "character-material-3.ocmp",
  "sprite-attribute-system-v1.json",
  "sprite-effects-v1.json",
  "assets/character-parts-eight-direction-168.webp",
  "assets/vault-tiles.webp",
  "assets/tintable-kit.webp",
];
const bytes = await Promise.all(
  required.map((name) => readFile(path.join(directory, name))),
);
const totalBytes = bytes.reduce((sum, value) => sum + value.byteLength, 0);
const maxBytes = 8 * 1024 * 1024;
if (totalBytes > maxBytes)
  throw new Error(
    `Vault Arcade decoded runtime assets exceed 8 MiB (${totalBytes} bytes).`,
  );
console.log(
  `Validated Vault Arcade v2 (${totalBytes} / ${maxBytes} decoded runtime bytes across ${required.length} resources).`,
);
