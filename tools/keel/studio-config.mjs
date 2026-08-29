import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export function parseStudioConfigArgs(args, command) {
  const usage = `usage: keel ${command} --config <file> [--format json|yaml]`;
  const fail = (message) => { throw new TypeError(`${message}\n${usage}`); };
  let configPath;
  let format;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config") {
      if (configPath !== undefined) fail("--config may be provided only once.");
      configPath = args[index + 1];
      if (configPath === undefined || configPath.startsWith("--")) fail("--config requires a file path.");
      index += 1;
    } else if (argument?.startsWith("--config=")) {
      if (configPath !== undefined) fail("--config may be provided only once.");
      configPath = argument.slice("--config=".length);
      if (configPath.length === 0) fail("--config requires a file path.");
    } else if (argument === "--format") {
      if (format !== undefined) fail("--format may be provided only once.");
      format = args[index + 1];
      if (format === undefined || format.startsWith("--")) fail("--format requires json or yaml.");
      index += 1;
    } else if (argument?.startsWith("--format=")) {
      if (format !== undefined) fail("--format may be provided only once.");
      format = argument.slice("--format=".length);
    } else fail(`Unknown argument: ${argument}`);
  }
  if (configPath === undefined) fail("--config is required.");
  if (format !== undefined && format !== "json" && format !== "yaml") fail("--format must be json or yaml.");
  return { configPath: path.resolve(configPath), format };
}

function selectedFormat(configPath, explicit) {
  if (explicit !== undefined) return explicit;
  const extension = path.extname(configPath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return undefined;
}

export async function readStudioConfig(args, command, label) {
  const parsed = parseStudioConfigArgs(args, command);
  const source = await readFile(parsed.configPath, "utf8");
  const format = selectedFormat(parsed.configPath, parsed.format);
  if (format === "json") {
    try { return { path: parsed.configPath, value: JSON.parse(source) }; }
    catch { throw new TypeError(`${label} JSON configuration is invalid.`); }
  }
  try {
    return { path: parsed.configPath, value: parseYaml(source, { version: "1.2", schema: "core", uniqueKeys: true }) };
  } catch {
    throw new TypeError(`${label} YAML configuration is invalid.`);
  }
}
