#!/usr/bin/env node
import path from "node:path";
import { compileSpriteCodex } from "./compiler.js";
import { compileSpriteLibrary } from "./library.js";

function usage(): never {
  console.error("Usage: sprite-codex <compile|library> <source.json> --out <directory> [--lock <source.lock.json>] [--check]");
  process.exit(2);
}

const [, , command, manifest, ...rest] = process.argv;
if ((command !== "compile" && command !== "library") || manifest === undefined) usage();
let output: string | undefined;
let lock: string | undefined;
let writeLock = true;
for (let index = 0; index < rest.length; index += 1) {
  const flag = rest[index];
  if (flag === "--out") {
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) usage();
    output = value;
  }
  else if (flag === "--lock") {
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) usage();
    lock = value;
  }
  else if (flag === "--check") writeLock = false;
  else usage();
}
if (output === undefined) usage();
if (!writeLock && lock === undefined) usage();
const compile = command === "compile" ? compileSpriteCodex : compileSpriteLibrary;
const result = await compile({
  manifestPath: path.resolve(manifest),
  outputDirectory: path.resolve(output),
  ...(lock === undefined ? {} : { lockPath: path.resolve(lock) }),
  writeLock,
});
console.log(JSON.stringify(result.manifest, null, 2));
