#!/usr/bin/env node
/**
 * keel — per-module operations over the contract modules.
 *
 *   keel list [--group <g>] [--apps|--modules]
 *                                 every unit, its size, and where it is deployed
 *   keel graph [id]               dependency graph (or one module's cone)
 *   keel check                    boundary + coverage + acyclicity gate
 *   keel test <id>                forge test scoped to one module
 *   keel verify <id|--all> [--update] [--evidence]
 *                                 the uniform gate: static, size, abi, test, gas
 *   keel deployments [id]         known addresses per chain
 *   keel plan <id> --chain <n>    ordered release plan for a chain, and what is missing
 *   keel record <id> --chain <n> --instance <s> --contract <C> --address <0x..>
 *                                 write a completed deployment into the registry
 *   keel split [<id>|--all] --out <dir> [--apply]
 *                                 assemble standalone repositories, one per module
 *   keel repos [--sync]           reconcile module repositories with GitHub
 *   keel reconcile [--write]      check the registry against the repo's deployment files
 *   keel sync                     regenerate manifests + SDK registry
 *   keel studio-drafts --config <file> [--format json|yaml]
 *                                 run one creator-scoped Studio draft operation
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { MODULES, MODULE_BY_ID, TIER_OF } from "./module-map.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const CONTRACTS = join(REPO, "../keel-contracts");
const MODULES_DIR = join(CONTRACTS, "modules");
const [cmd, ...rest] = process.argv.slice(2);

const CHAIN_NAMES = { 1: "ethereum", 11155111: "sepolia", 8453: "base", 84532: "base-sepolia", 10: "optimism", 42161: "arbitrum", 137: "polygon", 31337: "anvil" };
const chainName = (id) => CHAIN_NAMES[id] ?? `chain-${id}`;

const argvHas = (f) => rest.includes(f);

function manifest(id) {
  const p = join(CONTRACTS, TIER_OF.get(id), id, "keel.module.json");
  if (!existsSync(p)) die(`no manifest for ${id} — run \`keel sync\``);
  return JSON.parse(readFileSync(p, "utf8"));
}
function deploymentsOf(id) {
  const dir = join(CONTRACTS, TIER_OF.get(id), id, "deployments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
function die(msg) { console.error(`keel: ${msg}`); process.exit(1); }
function run(cmdline, cwd = CONTRACTS) {
  const r = spawnSync("sh", ["-c", cmdline], { cwd, stdio: "inherit" });
  return r.status ?? 1;
}

function runNodeScript(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, stdio: "inherit" });
  if (r.error) { console.error(`keel: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}

function cmdList() {
  const only = flag("group", false);
  const wantApps = argvHas("--apps");
  const wantModules = argvHas("--modules");
  let shown = MODULES;
  if (wantApps && !wantModules) shown = shown.filter((m) => m.kind === "app");
  if (wantModules && !wantApps) shown = shown.filter((m) => m.kind !== "app");
  if (only) shown = shown.filter((m) => m.group === only);
  if (only && !shown.length) die(`no modules in group ${only} (have: ${[...new Set(MODULES.map((m) => m.group))].join(", ")})`);
  const noun = wantApps && !wantModules ? "app" : "unit";
  console.log(`${shown.length} ${noun}${shown.length === 1 ? "" : "s"}${only ? ` in group ${only}` : ""}\n`);
  const rows = shown.map((m) => {
    const d = manifest(m.id);
    const chains = deploymentsOf(m.id).map((r) => chainName(r.chainId));
    return [m.id, m.kind === "app" ? "app" : "module", m.group, String(d.contracts.length), String(d.deployable.length), String(d.deps.length), chains.length ? chains.join(",") : "—"];
  });
  const head = ["NAME", "KIND", "GROUP", "FILES", "DEPL", "DEPS", "LIVE ON"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
}

function cmdGraph(id) {
  const show = (m, depth, seen) => {
    console.log(`${"  ".repeat(depth)}${depth ? "└─ " : ""}${m}`);
    if (seen.has(m)) return;
    seen.add(m);
    for (const d of MODULE_BY_ID.get(m)?.deps ?? []) show(d, depth + 1, seen);
  };
  if (id) { if (!MODULE_BY_ID.has(id)) die(`unknown module ${id}`); show(id, 0, new Set()); return; }
  for (const m of MODULES) { show(m.id, 0, new Set()); console.log(); }
}

function cmdDeployments(id) {
  const ids = id ? [id] : MODULES.map((m) => m.id);
  let any = false;
  for (const mid of ids) {
    for (const rec of deploymentsOf(mid)) {
      any = true;
      console.log(`\n${mid}  ·  ${chainName(rec.chainId)} (${rec.chainId})`);
      for (const [instance, slot] of Object.entries(rec.deployments)) {
        console.log(`  ${instance}`);
        for (const c of Object.values(slot.contracts ?? {})) {
          console.log(`    ${c.contract.padEnd(34)} ${c.address}${c.block ? `  @${c.block}` : ""}`);
        }
      }
    }
  }
  if (!any) console.log(id ? `${id}: no recorded deployments` : "no recorded deployments");
}

function cmdTest(id) {
  if (!id) die("usage: keel test <module>");
  const d = manifest(id);
  console.log(`keel test ${id}\n`);
  process.exit(run(`forge test --match-path 'test/modules/${id}/*' ${rest.slice(1).join(" ")}`));
}

function flag(name, required = true) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1 || !rest[i + 1]) { if (required) die(`missing --${name}`); return undefined; }
  return rest[i + 1];
}

/**
 * A release plan is the module's dependency cone in deploy order. For each entry
 * it reports whether that module already has a deployment on the target chain,
 * because deploying a module against a chain missing its dependencies is the most
 * common way a cross-chain release goes wrong.
 */
function cmdPlan(id) {
  if (!id || !MODULE_BY_ID.has(id)) die("usage: keel plan <module> --chain <id>");
  const chainId = Number(flag("chain"));
  if (!Number.isInteger(chainId) || chainId <= 0) die("--chain must be a positive integer");

  const order = [];
  const seen = new Set();
  (function visit(m) {
    if (seen.has(m)) return;
    seen.add(m);
    for (const d of MODULE_BY_ID.get(m).deps) visit(d);
    order.push(m);
  })(id);

  const present = (m) => deploymentsOf(m).find((r) => r.chainId === chainId);
  console.log(`release plan: ${id} on ${chainName(chainId)} (${chainId})\n`);
  let missing = 0, toDeploy = 0;
  for (const m of order) {
    const rec = present(m);
    const d = manifest(m);
    const role = m === id ? "TARGET" : "dep";
    if (rec) {
      const names = Object.entries(rec.deployments).map(([n, v]) => `${n}:${Object.keys(v.contracts).length}`).join(" ");
      console.log(`  [present] ${role.padEnd(6)} ${m.padEnd(32)} ${names}`);
    } else {
      if (m !== id) missing++;
      toDeploy += d.deployable.length;
      console.log(`  [DEPLOY ] ${role.padEnd(6)} ${m.padEnd(32)} ${d.deployable.join(", ") || "(nothing deployable)"}`);
    }
  }
  console.log(`\n${order.length} module(s) in the cone; ${toDeploy} contract(s) to deploy.`);
  if (missing) console.log(`${missing} dependency module(s) are not on this chain yet — deploy them first, in the order above.`);
  console.log(`\nAfter each deploy, record it:\n  pnpm keel record ${id} --chain ${chainId} --instance <name> --contract <Contract> --address 0x...`);
}

function cmdRecord(id) {
  if (!id || !MODULE_BY_ID.has(id)) die("usage: keel record <module> --chain <id> --instance <name> --contract <C> --address <0x..>");
  const chainId = Number(flag("chain"));
  const instance = flag("instance");
  const contract = flag("contract");
  const address = flag("address");
  const block = flag("block", false) ?? null;
  const txHash = flag("tx", false) ?? null;
  if (!Number.isInteger(chainId) || chainId <= 0) die("--chain must be a positive integer");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) die(`--address is not an address: ${address}`);
  const d = manifest(id);
  if (!d.deployable.includes(contract)) die(`${id} has no deployable contract named ${contract} (have: ${d.deployable.join(", ")})`);

  const dir = join(CONTRACTS, TIER_OF.get(id), id, "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${chainId}.json`);
  const rec = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { schema: "keel.deployments@1", module: id, chainId, deployments: {} };
  const slot = (rec.deployments[instance] ??= { contracts: {} });
  const prior = slot.contracts[contract]?.address;
  slot.contracts[contract] = { contract, address, block, txHash, source: "keel record" };
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(`${prior ? `replaced ${prior} with` : "recorded"} ${address} for ${id}/${contract} (${instance}) on ${chainName(chainId)}`);
  console.log("run `pnpm keel sync` to publish it to the SDK registry");
}

function cmdSync() {
  for (const script of ["generate-manifests.mjs", "sync-sdk.mjs"]) {
    const p = join(import.meta.dirname, script);
    if (!existsSync(p)) continue;
    const status = run(`node ${p}`, REPO);
    if (status !== 0) process.exit(status);
  }
}

switch (cmd) {
  case "list": cmdList(); break;
  case "graph": cmdGraph(rest[0]); break;
  case "check": process.exit(run(`node ${join(import.meta.dirname, "check.mjs")}`, REPO)); break;
  case "test": cmdTest(rest[0]); break;
  case "verify": process.exit(run(`node ${join(import.meta.dirname, "verify.mjs")} ${rest.join(" ")}`, REPO)); break;
  case "deployments": cmdDeployments(rest[0]); break;
  case "plan": cmdPlan(rest[0]); break;
  case "record": cmdRecord(rest[0]); break;
  case "split": process.exit(run(`node ${join(import.meta.dirname, "split.mjs")} ${rest.join(" ")}`, REPO)); break;
  case "repos": process.exit(run(`node ${join(import.meta.dirname, "repos.mjs")} ${rest.join(" ")}`, REPO)); break;
  case "reconcile": process.exit(run(`node ${join(import.meta.dirname, "seed-deployments.mjs")} ${rest.join(" ")}`, REPO)); break;
  case "sync": cmdSync(); break;
  case "studio-drafts": process.exit(runNodeScript(join(import.meta.dirname, "studio-drafts.mjs"), rest)); break;
  default:
    console.log(readFileSync(import.meta.filename, "utf8").split("\n").slice(2, 12).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
}
