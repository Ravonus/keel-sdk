#!/usr/bin/env node
/**
 * Run one creator-scoped Studio draft operation from a JSON or YAML file.
 *
 *   keel studio-drafts --config ./draft-operation.yaml
 *
 * The configuration is intentionally limited to the SDK's draft client. It
 * cannot sign, submit, or otherwise perform a wallet or chain operation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  executeKeelStudioAgentDraftOperation,
} from "../../packages/sdk/dist/studio-agent-drafts.js";

function usageError(message) {
  throw new TypeError(`${message}\nusage: keel studio-drafts --config <file> [--format json|yaml]`);
}

function parseArgs(args) {
  let configPath;
  let format;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      if (configPath !== undefined) usageError("--config may be provided only once.");
      configPath = args[index + 1];
      if (configPath === undefined || configPath.startsWith("--")) usageError("--config requires a file path.");
      index += 1;
    } else if (argument?.startsWith("--config=")) {
      if (configPath !== undefined) usageError("--config may be provided only once.");
      configPath = argument.slice("--config=".length);
      if (configPath.length === 0) usageError("--config requires a file path.");
    } else if (argument === "--format") {
      if (format !== undefined) usageError("--format may be provided only once.");
      format = args[index + 1];
      if (format === undefined || format.startsWith("--")) usageError("--format requires json or yaml.");
      index += 1;
    } else if (argument?.startsWith("--format=")) {
      if (format !== undefined) usageError("--format may be provided only once.");
      format = argument.slice("--format=".length);
    } else usageError(`Unknown argument: ${argument}`);
  }
  if (configPath === undefined) usageError("--config is required.");
  if (format !== undefined && format !== "json" && format !== "yaml") usageError("--format must be json or yaml.");
  return { configPath, format };
}

function formatFor(configPath, explicit) {
  if (explicit !== undefined) return explicit;
  const extension = path.extname(configPath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return undefined;
}

function parseConfig(source, format) {
  if (format === "json") {
    try { return JSON.parse(source); }
    catch { throw new TypeError("Studio agent draft JSON configuration is invalid."); }
  }
  try {
    return parseYaml(source, { version: "1.2", schema: "core", uniqueKeys: true });
  } catch {
    throw new TypeError("Studio agent draft YAML configuration is invalid.");
  }
}

function validateConfig(value, environment = process.env) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Studio agent draft configuration must be an object.");
  const supported = new Set(["studioUrl", "grantToken", "operation", "releaseId", "draft", "expectedRevision"]);
  for (const key of Object.keys(value)) if (!supported.has(key)) throw new TypeError(`Studio agent draft configuration.${key} is not supported.`);
  if (typeof value.studioUrl !== "string" || value.studioUrl.trim() === "") throw new TypeError("Studio agent draft configuration requires studioUrl.");
  const configuredToken = typeof value.grantToken === "string" && value.grantToken.length >= 48
    ? value.grantToken
    : undefined;
  const environmentToken = typeof environment.KEEL_STUDIO_AGENT_TOKEN === "string" && environment.KEEL_STUDIO_AGENT_TOKEN.length >= 48
    ? environment.KEEL_STUDIO_AGENT_TOKEN
    : undefined;
  const grantToken = configuredToken ?? environmentToken;
  if (grantToken === undefined) {
    throw new TypeError("Studio agent draft access requires KEEL_STUDIO_AGENT_TOKEN or a valid grantToken in the explicit config.");
  }
  if (!new Set(["list", "read", "create", "update"]).has(value.operation)) throw new TypeError("Studio agent draft configuration requires a supported operation.");
  return { ...value, grantToken };
}

const parsed = parseArgs(process.argv.slice(2));
try {
  const source = await readFile(path.resolve(parsed.configPath), "utf8");
  const config = validateConfig(parseConfig(source, formatFor(parsed.configPath, parsed.format)));
  const result = await executeKeelStudioAgentDraftOperation(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
