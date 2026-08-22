#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  encodeAtlasMaterialMapBits,
  encodeMaterialBits,
  encodeSpriteBitAtlas,
  packSpriteFrames,
} from "../packages/viewer/dist/index.js";

const [kind, inputPath, outputPath] = process.argv.slice(2);
if (kind === undefined || inputPath === undefined || outputPath === undefined) {
  throw new Error(
    [
      "Usage:",
      "  pnpm reader-asset:compile material-map input.json output.ocam",
      "  pnpm reader-asset:compile material-profile input.json output.ocmp",
      "  pnpm reader-asset:compile sprite-pack input.json output.ocaa",
    ].join("\n"),
  );
}

const input = JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
let bytes;
let summary;
if (kind === "material-map") {
  bytes = encodeAtlasMaterialMapBits(input);
  summary = { kind, targets: input.targets?.length };
} else if (kind === "material-profile") {
  bytes = encodeMaterialBits(input);
  summary = { kind, regions: input.regions?.length };
} else if (kind === "sprite-pack") {
  const packed = packSpriteFrames(input);
  bytes = encodeSpriteBitAtlas(packed.atlas);
  const layoutPath = `${path.resolve(outputPath)}.layout.json`;
  await writeFile(layoutPath, `${JSON.stringify(packed, null, 2)}\n`);
  summary = {
    kind,
    frames: packed.atlas.frames.length,
    imageWidth: packed.imageWidth,
    imageHeight: packed.imageHeight,
    layoutPath,
  };
} else {
  throw new Error(`Unknown reader asset kind: ${kind}`);
}

await writeFile(path.resolve(outputPath), bytes);
console.log(
  JSON.stringify(
    {
      ...summary,
      outputPath: path.resolve(outputPath),
      bytes: bytes.byteLength,
    },
    null,
    2,
  ),
);
