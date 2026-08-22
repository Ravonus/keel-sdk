// Compiles human-readable media authoring files into the compact resources
// published by the live demo seeder. Run `pnpm build` first so the codec and
// the browser reader are always the same version.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeSoundBits,
  encodeSpriteBitAtlas,
  parseSpriteAtlasJson,
} from "../../packages/viewer/dist/readers.js";

const demos = path.dirname(fileURLToPath(import.meta.url));
const soundDirectory = path.join(demos, "soundbox-synth");
const spriteDirectory = path.join(demos, "sprite-forge");
const weaponSoundDirectory = path.join(demos, "vault-arcade", "generated-attribute-proxy", "audio");

for (const name of ["shot", "laser", "song"]) {
  const source = await readFile(path.join(soundDirectory, `${name}.json`), "utf8");
  const encoded = encodeSoundBits(JSON.parse(source));
  await writeFile(path.join(soundDirectory, `${name}.ocas`), encoded);
  console.log(`${name}.json ${Buffer.byteLength(source)} bytes -> ${encoded.byteLength} bytes`);
}

for (const name of ["gyro-saw-attack", "rift-fork-attack", "aegis-star-attack", "needle-array-attack"]) {
  const source = await readFile(path.join(weaponSoundDirectory, `${name}.json`), "utf8");
  const encoded = encodeSoundBits(JSON.parse(source));
  await writeFile(path.join(weaponSoundDirectory, `${name}.ocas`), encoded);
  console.log(`${name}.json ${Buffer.byteLength(source)} bytes -> ${encoded.byteLength} bytes`);
}

const atlasSource = JSON.parse(await readFile(path.join(spriteDirectory, "atlas.json"), "utf8"));
const atlas = parseSpriteAtlasJson(atlasSource);
const encodedAtlas = encodeSpriteBitAtlas(atlas);
await writeFile(path.join(spriteDirectory, "atlas.ocaa"), encodedAtlas);
console.log(`atlas.json -> atlas.ocaa ${encodedAtlas.byteLength} bytes`);
