#!/usr/bin/env node
/** Measure or explicitly apply one reversible media optimization from JSON/YAML. */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { applyMediaOptimization, planMediaOptimization } from "../../packages/builder/dist/index.js";
import { readStudioConfig } from "./studio-config.mjs";

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const ALLOWED = new Set(["operation", "input", "output", "expectedOutputDigest", "expectedAfterBytes", "mediaType", "quality", "effort", "videoCrf", "videoCpuUsed", "selectedStorageMode"]);

function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Media optimization configuration must be an object.");
  for (const key of Object.keys(value)) if (!ALLOWED.has(key)) throw new TypeError(`Media optimization configuration.${key} is not supported.`);
  return value;
}

function text(value, label, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be non-empty text without control characters.`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

async function inputPath(configDirectory, value) {
  const source = text(value, "input", true);
  if (path.isAbsolute(source)) throw new TypeError("input must be relative to the configuration file.");
  const base = await realpath(configDirectory);
  const requested = path.resolve(base, source);
  const resolved = await realpath(requested);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new TypeError("input escapes the configuration directory.");
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_MEDIA_BYTES) throw new TypeError("input must be a bounded regular non-symlink file.");
  return resolved;
}

async function outputPath(configDirectory, value) {
  const output = text(value, "output", true);
  if (path.isAbsolute(output)) throw new TypeError("output must be relative to the configuration file.");
  const base = await realpath(configDirectory);
  const requested = path.resolve(base, output);
  if (requested === base || !requested.startsWith(`${base}${path.sep}`)) throw new TypeError("output escapes the configuration directory.");
  const parent = await realpath(path.dirname(requested));
  if (parent !== base && !parent.startsWith(`${base}${path.sep}`)) throw new TypeError("output escapes the configuration directory.");
  if (!(await stat(parent)).isDirectory()) throw new TypeError("output parent must be a directory.");
  return requested;
}

function planOptions(config, input) {
  const mediaType = text(config.mediaType, "mediaType");
  const selectedStorageMode = text(config.selectedStorageMode, "selectedStorageMode");
  const quality = integer(config.quality, "quality", 1, 100);
  const effort = integer(config.effort, "effort", 0, 6);
  const videoCrf = integer(config.videoCrf, "videoCrf", 0, 63);
  const videoCpuUsed = integer(config.videoCpuUsed, "videoCpuUsed", 0, 8);
  return {
    input,
    maxInputBytes: MAX_MEDIA_BYTES,
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(selectedStorageMode === undefined ? {} : { selectedStorageMode }),
    ...(quality === undefined ? {} : { quality }),
    ...(effort === undefined ? {} : { effort }),
    ...(videoCrf === undefined ? {} : { videoCrf }),
    ...(videoCpuUsed === undefined ? {} : { videoCpuUsed }),
  };
}

try {
  const loaded = await readStudioConfig(process.argv.slice(2), "media-optimize", "Media optimization");
  const config = object(loaded.value);
  const operation = config.operation === undefined ? "plan" : text(config.operation, "operation", true);
  if (operation !== "plan" && operation !== "apply-reviewed") throw new TypeError("operation must be plan or apply-reviewed.");
  const input = await inputPath(path.dirname(loaded.path), config.input);
  const plan = await planMediaOptimization(planOptions(config, input));
  if (operation === "plan") {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } else {
    const expectedOutputDigest = text(config.expectedOutputDigest, "expectedOutputDigest", true);
    if (!/^0x[0-9a-f]{64}$/u.test(expectedOutputDigest)) throw new TypeError("expectedOutputDigest must be a lowercase SHA-256 digest.");
    const expectedAfterBytes = integer(config.expectedAfterBytes, "expectedAfterBytes", 1, Number.MAX_SAFE_INTEGER);
    if (expectedAfterBytes === undefined || plan.output?.integrity.digest !== expectedOutputDigest || plan.measurements.afterBytes !== expectedAfterBytes) {
      throw new Error("The current optimization candidate does not match the reviewed dry-run digest and byte length; review it again before applying.");
    }
    const result = await applyMediaOptimization({ plan, output: await outputPath(path.dirname(loaded.path), config.output) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
