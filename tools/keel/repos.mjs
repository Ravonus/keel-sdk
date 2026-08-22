#!/usr/bin/env node
/**
 * Reconciles the module repositories with what exists on GitHub.
 *
 *   keel repos            report each module's repository state
 *   keel repos --sync     record visibility into the manifests, then keel sync
 *
 * Visibility is recorded because it changes how a consumer installs a module —
 * a private repository needs an authenticated remote — not because the SDK
 * depends on it. Address and ABI resolution is entirely local either way.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { MODULES, TIER_OF } from "./module-map.mjs";

const SYNC = process.argv.includes("--sync");
const ORG = (() => { const i = process.argv.indexOf("--org"); return i === -1 ? "keel-web3" : process.argv[i + 1]; })();
const REPO = resolve(import.meta.dirname, "../..");
const metaFile = (id) => join(REPO, "../keel-contracts", TIER_OF.get(id), id, "keel.module.json");

let remote = new Map();
try {
  const raw = execFileSync("gh", ["repo", "list", ORG, "--limit", "200", "--json", "name,visibility,pushedAt,isEmpty"], { encoding: "utf8" });
  for (const r of JSON.parse(raw)) remote.set(r.name, r);
} catch {
  console.error(`keel repos: could not reach GitHub for ${ORG} (is gh authenticated?)`);
  process.exit(1);
}

const publishable = MODULES.filter((m) => m.kind !== "app");
let missing = 0, changed = 0;
console.log(`${ORG}: ${remote.size} repository(ies) on GitHub, ${publishable.length} publishable module(s)\n`);

for (const m of publishable) {
  const r = remote.get(m.id);
  const file = metaFile(m.id);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (!r) {
    missing += 1;
    console.log(`  MISSING  ${m.id.padEnd(32)} not created yet`);
    continue;
  }
  const visibility = r.visibility.toLowerCase();
  const state = r.isEmpty ? "empty" : `pushed ${r.pushedAt.slice(0, 10)}`;
  console.log(`  ok       ${m.id.padEnd(32)} ${visibility.padEnd(7)} ${state}`);
  if (SYNC && manifest.visibility !== visibility) {
    manifest.visibility = visibility;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    changed += 1;
  }
}

// apps must never acquire a repository
for (const m of MODULES.filter((x) => x.kind === "app")) {
  if (remote.has(m.id)) console.log(`  WARN     ${m.id.padEnd(32)} is an app but has a repository in ${ORG}`);
}

if (SYNC) console.log(`\nrecorded visibility for ${changed} module(s) — run \`pnpm keel:sync\` to publish to the SDK`);
if (missing) { console.error(`\n${missing} module(s) have no repository yet`); process.exit(1); }
