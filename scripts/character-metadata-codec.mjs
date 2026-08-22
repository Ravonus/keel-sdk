import { readFile, writeFile } from "node:fs/promises";
import {
  decodeCharacterMetadataBits,
  encodeCharacterMetadataBits,
} from "../packages/viewer/dist/index.js";

const [mode, inputPath, outputPath] = process.argv.slice(2);
if (!(["encode", "decode"].includes(mode)) || !inputPath || !outputPath) {
  throw new Error("Usage: node scripts/character-metadata-codec.mjs <encode|decode> <input> <output>");
}

if (mode === "encode") {
  const source = JSON.parse(await readFile(inputPath, "utf8"));
  const encoded = encodeCharacterMetadataBits(source);
  await writeFile(outputPath, encoded);
  console.log(JSON.stringify({ mode, inputPath, outputPath, bytes: encoded.byteLength }));
} else {
  const decoded = decodeCharacterMetadataBits(new Uint8Array(await readFile(inputPath)));
  const output = `${JSON.stringify(decoded, null, 2)}\n`;
  await writeFile(outputPath, output);
  console.log(JSON.stringify({ mode, inputPath, outputPath, bytes: Buffer.byteLength(output) }));
}
