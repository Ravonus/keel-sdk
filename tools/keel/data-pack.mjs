#!/usr/bin/env node
/** Convert JSON or YAML into KEEL's deterministic gzip-CBOR data-pack. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { decodeKeelDataPack, encodeKeelDataPack } from "../../packages/sdk/dist/data-layer.js";

function fail(message) {
  throw new TypeError(`${message}\nusage: keel data-pack --input <file.{json,yaml,yml}> --output <file.kdp> [--no-gzip]`);
}

const args = process.argv.slice(2);
function valueOf(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) fail(`${flag} is required.`);
  return path.resolve(args[index + 1]);
}

try {
  const inputPath = valueOf("--input");
  const outputPath = valueOf("--output");
  const allowed = new Set(["--input", "--output", "--no-gzip"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) fail(`Unknown argument: ${argument}`);
    if (argument !== "--no-gzip") index += 1;
  }
  const source = await readFile(inputPath, "utf8");
  const extension = path.extname(inputPath).toLowerCase();
  let value;
  if (extension === ".json") value = JSON.parse(source);
  else if (extension === ".yaml" || extension === ".yml") {
    value = parseYaml(source, { version: "1.2", schema: "core", uniqueKeys: true });
  } else fail("Input must use .json, .yaml, or .yml.");
  const pack = encodeKeelDataPack(value, args.includes("--no-gzip") ? "none" : "gzip");
  decodeKeelDataPack(pack);
  await writeFile(outputPath, pack);
  process.stdout.write(`${JSON.stringify({ input: inputPath, output: outputPath, sourceBytes: Buffer.byteLength(source), packBytes: pack.byteLength, compression: args.includes("--no-gzip") ? "none" : "gzip" })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
