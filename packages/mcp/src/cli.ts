#!/usr/bin/env node
import { runMcpSelfTest } from "./health.js";
import { MCP_SERVER_VERSION } from "./types.js";
import { runStdio } from "./stdio.js";

const HELP = `Usage: keel-mcp [--workspace <directory> | --workspace=<directory>] [--help | --version | --self-test]

Run the offline MCP JSON-RPC server over stdio (the default).
  --workspace <directory>  Restrict local reads and writes to this directory.
  --self-test              Run initialize, ping, tools/list, prompts/list/get, and static resource checks.
  --version, -v            Print the server version and exit.
  --help, -h               Print this help and exit.
`;

type Action = "stdio" | "help" | "version" | "self-test";

interface ParsedArgs {
  readonly action: Action;
  readonly workspace: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let action: Action = "stdio";
  let workspace = ".";
  let workspaceSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) throw new TypeError("Missing command argument.");
    if (argument === "--workspace") {
      if (workspaceSeen) throw new TypeError("--workspace may be provided only once.");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError("--workspace requires a directory.");
      workspace = value;
      workspaceSeen = true;
      index += 1;
    } else if (argument.startsWith("--workspace=")) {
      if (workspaceSeen) throw new TypeError("--workspace may be provided only once.");
      const value = argument.slice("--workspace=".length);
      if (value.length === 0) throw new TypeError("--workspace requires a directory.");
      workspace = value;
      workspaceSeen = true;
    } else if (argument === "--help" || argument === "-h") {
      action = selectAction(action, "help");
    } else if (argument === "--version" || argument === "-v") {
      action = selectAction(action, "version");
    } else if (argument === "--self-test") {
      action = selectAction(action, "self-test");
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }
  return { action, workspace };
}

function selectAction(current: Action, next: Exclude<Action, "stdio">): Action {
  if (current !== "stdio" && current !== next) throw new TypeError("Choose only one of --help, --version, or --self-test.");
  return next;
}

async function main(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.action === "help") {
    process.stdout.write(HELP);
  } else if (parsed.action === "version") {
    process.stdout.write(`${MCP_SERVER_VERSION}\n`);
  } else if (parsed.action === "self-test") {
    process.stdout.write(`${JSON.stringify(await runMcpSelfTest(parsed.workspace))}\n`);
  } else {
    await runStdio(undefined, undefined, parsed.workspace);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
