#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseArtifactManifest } from "@keel/protocol";

import { inspectSandboxManifest } from "./inspect.js";
import { prepareSandboxProject } from "./project.js";

const MAX_FILES = 256;
const MAX_BYTES = 64 * 1024 * 1024;

function usage(): never {
  console.error(`Usage:
  keel-sandbox inspect <manifest.json> [--json]
  keel-sandbox compare <parent-manifest.json> <child-manifest.json> [--approve] [--json]
  keel-sandbox prepare <project-directory> [--name <name>] [--out <sandbox.html>] [--json]

Compare uses the same per-component hash gate as Studio. --approve records creator approval in the dry run only.
All checks use @keel/protocol and @keel/viewer. The CLI never grants network or wallet access to project code.`);
  process.exit(2);
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function projectFiles(root: string): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]> {
  const files: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if ([".git", "node_modules", ".next", "dist"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        total += info.size;
        if (files.length >= MAX_FILES || total > MAX_BYTES) throw new RangeError("Project exceeds 256 files or 64 MB.");
        files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), bytes: new Uint8Array(await readFile(absolute)) });
      }
    }
  };
  await visit(root);
  if (files.length === 0) throw new RangeError("Project directory contains no files.");
  return files;
}

function printHuman(report: Awaited<ReturnType<typeof inspectSandboxManifest>>): void {
  console.log(`${report.valid ? "PASS" : "BLOCKED"} · ${report.manifestId} · revision ${report.revision}`);
  console.log(`${report.summary.resources} resources · ${report.summary.components} labelled parts · ${report.summary.decodedBytesDeclared} declared bytes`);
  for (const diagnostic of report.diagnostics) console.log(`${diagnostic.level.toUpperCase().padEnd(7)} ${diagnostic.title}: ${diagnostic.message}`);
  for (const issue of report.protocolIssues) console.log(`${issue.level.toUpperCase().padEnd(7)} ${issue.path}: ${issue.message}`);
}

const args = process.argv.slice(2);
const command = args[0];
const target = args[1];
if ((command !== "inspect" && command !== "compare" && command !== "prepare") || target === undefined) usage();
const json = args.includes("--json");

if (command === "inspect") {
  const manifest = parseArtifactManifest(JSON.parse(await readFile(path.resolve(target), "utf8")) as unknown);
  const report = await inspectSandboxManifest(manifest);
  if (json) console.log(JSON.stringify(report, null, 2)); else printHuman(report);
  if (!report.valid) process.exitCode = 1;
} else if (command === "compare") {
  const childTarget = args[2];
  if (childTarget === undefined || childTarget.startsWith("--")) usage();
  const parent = parseArtifactManifest(JSON.parse(await readFile(path.resolve(target), "utf8")) as unknown);
  const child = parseArtifactManifest(JSON.parse(await readFile(path.resolve(childTarget), "utf8")) as unknown);
  const report = await inspectSandboxManifest(child, {
    previousManifest: parent,
    manualApproval: args.includes("--approve"),
  });
  if (json) console.log(JSON.stringify(report, null, 2)); else printHuman(report);
  if (!report.valid) process.exitCode = 1;
} else {
  const root = path.resolve(target);
  const prepared = await prepareSandboxProject({
    id: `sandbox-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "project"}`,
    name: option(args, "--name") ?? path.basename(root),
    files: await projectFiles(root),
  });
  const output = option(args, "--out");
  if (output !== undefined) await writeFile(path.resolve(output), prepared.sandbox.html, "utf8");
  if (json) {
    console.log(JSON.stringify({ ...prepared.report, resolution: prepared.audit, sandbox: { csp: prepared.sandbox.csp, warnings: prepared.sandbox.warnings, output } }, null, 2));
  } else {
    printHuman(prepared.report);
    console.log(`Sandbox resolved ${prepared.audit.resolvedResources} exact resources under: ${prepared.sandbox.csp}`);
    if (output !== undefined) console.log(`Wrote ${path.resolve(output)}`);
  }
  if (!prepared.report.valid) process.exitCode = 1;
}
