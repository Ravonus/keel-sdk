#!/usr/bin/env node
/**
 * The uniform per-module release gate.
 *
 *   static   the Solidity source policy, scoped to this module's files
 *   size     every deployable contract's runtime bytecode under the EIP-170 limit
 *   abi      the published ABI has not drifted from its recorded snapshot
 *   test     the module's own Foundry suite
 *   gas      the module's gas snapshot has not regressed
 *
 * `--update` records the current ABI and gas snapshots instead of comparing.
 * `--evidence` writes the run to modules/<id>/evidence/verify.json.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { MODULES, MODULE_BY_ID, TIER_OF } from "./module-map.mjs";
import { checkSource } from "./static-policy.mjs";

const argv = process.argv.slice(2);
const UPDATE = argv.includes("--update");
const EVIDENCE = argv.includes("--evidence");
const REPO = resolve(import.meta.dirname, "../..");
const CONTRACTS = join(REPO, "../keel-contracts");
const OUT = join(CONTRACTS, "out");
const metaDir = (id) => join(CONTRACTS, TIER_OF.get(id), id);
const SIZE_LIMIT = 24576;

const named = argv.find((a) => !a.startsWith("--") && MODULE_BY_ID.has(a));
const selected = argv.includes("--all") || !named ? MODULES : [MODULE_BY_ID.get(named)];

const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith(".sol") ? [p] : []);
}) : []);

function manifest(id) { return JSON.parse(readFileSync(join(metaDir(id), "keel.module.json"), "utf8")); }
function artifact(contract, sources) {
  for (const rel of sources) {
    const p = join(OUT, basename(rel), `${contract}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return null;
}
function sh(cmdline) {
  const r = spawnSync("sh", ["-c", cmdline], { cwd: CONTRACTS, encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const digest = (value) => createHash("sha256").update(value).digest("hex");

// One build up front; every module reads the same artifacts.
process.stdout.write("building… ");
const built = sh("forge build");
console.log(built.status === 0 ? "ok" : "FAILED");
if (built.status !== 0) { console.error(built.out.split("\n").filter((l) => /Error/.test(l)).slice(0, 5).join("\n")); process.exit(1); }

let failedModules = 0;
const report = [];

for (const m of selected) {
  const d = manifest(m.id);
  const dir = metaDir(m.id);
  const tier = TIER_OF.get(m.id);
  const steps = {};
  const detail = [];

  // static — scoped to this module's sources
  const findings = [];
  for (const file of walk(join(CONTRACTS, "src", tier, m.id))) {
    for (const f of checkSource(readFileSync(file, "utf8"))) findings.push(`${basename(file)}: ${f}`);
  }
  steps.static = findings.length === 0;
  detail.push(...findings.map((f) => `static: ${f}`));

  // size — runtime bytecode under EIP-170
  const sizes = {};
  let sizeOk = true;
  for (const c of d.deployable) {
    const a = artifact(c, d.contracts);
    const runtime = a?.deployedBytecode?.object ?? "";
    const bytes = Math.max(0, Math.floor(runtime.replace(/^0x/, "").length / 2));
    sizes[c] = bytes;
    if (bytes > SIZE_LIMIT) { sizeOk = false; detail.push(`size: ${c} is ${bytes} bytes (limit ${SIZE_LIMIT})`); }
  }
  steps.size = sizeOk;

  // abi — drift against the recorded snapshot
  const abiDir = join(dir, "abi");
  let abiOk = true;
  if (UPDATE) mkdirSync(abiDir, { recursive: true });
  for (const c of d.deployable) {
    const a = artifact(c, d.contracts);
    if (!a?.abi) continue;
    const serialized = `${JSON.stringify(a.abi, null, 2)}\n`;
    const p = join(abiDir, `${c}.json`);
    if (UPDATE) { writeFileSync(p, serialized); continue; }
    if (!existsSync(p)) { abiOk = false; detail.push(`abi: ${c} has no recorded snapshot (run --update)`); continue; }
    if (readFileSync(p, "utf8") !== serialized) { abiOk = false; detail.push(`abi: ${c} drifted from its snapshot`); }
  }
  steps.abi = UPDATE ? true : abiOk;

  // test — this module's suite
  const hasTests = existsSync(join(CONTRACTS, "test", tier, m.id));
  const t = hasTests ? sh(`forge test --match-path 'test/${tier}/${m.id}/*'`) : { status: 0, out: "" };
  steps.test = t.status === 0;
  if (t.status !== 0) {
    detail.push(...t.out.split("\n").filter((l) => l.includes("[FAIL")).slice(0, 5).map((l) => `test: ${l.trim()}`));
  }

  // gas — snapshot comparison
  const snap = join(dir, "gas.snapshot");
  if (!hasTests) steps.gas = true;
  else if (UPDATE) {
    steps.gas = sh(`forge snapshot --match-path 'test/${tier}/${m.id}/*' --snap ${snap}`).status === 0;
  } else if (!existsSync(snap)) {
    steps.gas = true; detail.push("gas: no snapshot recorded (run --update)");
  } else {
    const g = sh(`forge snapshot --match-path 'test/${tier}/${m.id}/*' --check ${snap}`);
    steps.gas = g.status === 0;
    if (g.status !== 0) detail.push(...g.out.split("\n").filter((l) => l.trim()).slice(0, 4).map((l) => `gas: ${l.trim()}`));
  }

  const ok = Object.values(steps).every(Boolean);
  if (!ok) failedModules += 1;
  const flags = Object.entries(steps).map(([k, v]) => `${v ? "ok" : "FAIL"} ${k}`).join("  ");
  console.log(`${ok ? "PASS" : "FAIL"}  ${m.id.padEnd(32)} ${flags}`);
  for (const line of detail) console.log(`        ${line}`);

  report.push({ module: m.id, kind: d.kind, group: d.group, version: d.version, ok, steps, sizes });

  if (EVIDENCE) {
    mkdirSync(join(dir, "evidence"), { recursive: true });
    const sourceDigests = {};
    for (const file of walk(join(CONTRACTS, "src", tier, m.id))) {
      sourceDigests[basename(file)] = digest(readFileSync(file));
    }
    writeFileSync(join(dir, "evidence/verify.json"), `${JSON.stringify({
      schema: "keel.verify@1",
      module: m.id,
      kind: d.kind,
      version: d.version,
      generatedAt: new Date().toISOString(),
      steps,
      sizes,
      sourceDigests,
      findings: detail,
    }, null, 2)}\n`);
  }
}

console.log(`\n${selected.length - failedModules}/${selected.length} module(s) pass${UPDATE ? " (snapshots updated)" : ""}`);
process.exit(failedModules ? 1 : 0);
