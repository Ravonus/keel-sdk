#!/usr/bin/env node
/** Stage one wallet-neutral KEEL project from a JSON or YAML declaration. */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveKeelEndpoints } from "../../packages/sdk/dist/endpoints.js";
import { stageKeelStudioProject } from "../../packages/sdk/dist/studio-upload.js";
import { readStudioConfig } from "./studio-config.mjs";

const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const ROLES = new Set(["entrypoint", "renderer", "runtime", "script", "module", "style", "data", "library", "image", "other"]);
const FORMATS = new Set(["asset", "classic-script", "es-module", "umd", "wasm"]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function exact(value, allowed, label) {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function text(value, label, maximum, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be non-empty text of at most ${maximum} characters.`);
  }
  return value.trim();
}

function safeProjectPath(value, label) {
  const normalized = text(value, label, 512).replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TypeError(`${label} must be a safe project-relative path.`);
  return normalized;
}

async function sourceBytes(configDirectory, source, label) {
  if (path.isAbsolute(source)) throw new TypeError(`${label} must be relative to the configuration file.`);
  const requested = path.resolve(configDirectory, source);
  const base = `${await realpath(configDirectory)}${path.sep}`;
  const resolved = await realpath(requested);
  if (!resolved.startsWith(base)) throw new TypeError(`${label} escapes the configuration directory.`);
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_PROJECT_BYTES) throw new TypeError(`${label} must be a bounded regular non-symlink file.`);
  return new Uint8Array(await readFile(resolved));
}

async function validateConfig(value, configPath, environment = process.env) {
  const input = object(value, "Studio stage configuration");
  exact(input, ["studioUrl", "title", "description", "storageStrategy", "marketplaceExportMode", "viewer", "files", "releaseIntent"], "Studio stage configuration");
  const token = environment.KEEL_STUDIO_AGENT_TOKEN;
  if (typeof token !== "string" || token.length < 48) throw new TypeError("Studio staging requires KEEL_STUDIO_AGENT_TOKEN.");
  const storageStrategy = text(input.storageStrategy, "storageStrategy", 32);
  if (!["local", "onchain", "hybrid"].includes(storageStrategy)) throw new TypeError("storageStrategy must be local, onchain, or hybrid.");
  const marketplaceExportMode = text(input.marketplaceExportMode, "marketplaceExportMode", 32, false);
  if (marketplaceExportMode !== undefined && !["recursive", "packed", "hybrid", "onchfs"].includes(marketplaceExportMode)) throw new TypeError("marketplaceExportMode is unsupported.");
  const viewer = text(input.viewer, "viewer", 64, false);
  if (viewer !== undefined && viewer !== "keel-verification-shell" && viewer !== "none") throw new TypeError("viewer must be keel-verification-shell or none.");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 256) throw new TypeError("files must contain from 1 through 256 entries.");
  const configDirectory = path.dirname(configPath);
  let totalBytes = 0;
  const files = [];
  for (const [index, candidate] of input.files.entries()) {
    const file = object(candidate, `files[${index}]`);
    exact(file, ["source", "path", "mediaType", "role", "format", "updateMode", "label"], `files[${index}]`);
    const projectPath = safeProjectPath(file.path, `files[${index}].path`);
    const source = file.source === undefined ? projectPath : safeProjectPath(file.source, `files[${index}].source`);
    const bytes = await sourceBytes(configDirectory, source, `files[${index}].source`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROJECT_BYTES) throw new RangeError(`Project exceeds the ${MAX_PROJECT_BYTES.toString()} byte CLI limit.`);
    const role = text(file.role, `files[${index}].role`, 32);
    const format = text(file.format, `files[${index}].format`, 32);
    if (!ROLES.has(role)) throw new TypeError(`files[${index}].role is unsupported.`);
    if (!FORMATS.has(format)) throw new TypeError(`files[${index}].format is unsupported.`);
    const updateMode = text(file.updateMode, `files[${index}].updateMode`, 16, false);
    if (updateMode !== undefined && updateMode !== "locked" && updateMode !== "manual") throw new TypeError(`files[${index}].updateMode is unsupported.`);
    const label = text(file.label, `files[${index}].label`, 96, false);
    files.push({ path: projectPath, bytes, mediaType: text(file.mediaType, `files[${index}].mediaType`, 160), role, format, ...(updateMode === undefined ? {} : { updateMode }), ...(label === undefined ? {} : { label }) });
  }
  const configuredStudioUrl = text(input.studioUrl, "studioUrl", 512, false);
  return {
    studioUrl: configuredStudioUrl ?? resolveKeelEndpoints({}, environment).studioUrl,
    agentToken: token,
    title: text(input.title, "title", 160),
    description: input.description === undefined ? "" : text(input.description, "description", 2_000),
    storageStrategy,
    ...(marketplaceExportMode === undefined ? {} : { marketplaceExportMode }),
    ...(viewer === undefined ? {} : { viewer }),
    files,
    ...(input.releaseIntent === undefined ? {} : { releaseIntent: object(input.releaseIntent, "releaseIntent") }),
  };
}

try {
  const loaded = await readStudioConfig(process.argv.slice(2), "studio-stage", "Studio stage");
  const result = await stageKeelStudioProject(await validateConfig(loaded.value, loaded.path));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
