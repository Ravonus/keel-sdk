/**
 * Assembles a standalone repository for each module.
 *
 * Because cross-module imports are already remapped through `@keel/`, this is a
 * copy plus a remappings file — no source is rewritten at split time. A module's
 * dependencies resolve from `lib/`, installed the ordinary Foundry way:
 *
 *   @keel/keel-hold/ -> lib/keel-hold/src/
 *
 * Usage: node tools/keel/split.mjs [<module>|--all] --out <dir> [--apply]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync, cpSync, rmSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { MODULES, MODULE_BY_ID } from "./module-map.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const REPO = resolve(import.meta.dirname, "../..");
const CONTRACTS = join(REPO, "../keel-contracts");
const OUT = resolve(flag("out") ?? join(REPO, "build/keel-repos"));
const ORG = flag("org") ?? "keel-web3";

const target = argv.find((a) => !a.startsWith("--") && MODULE_BY_ID.has(a));
// Apps are products, not published libraries — they never get their own repo.
const releasable = MODULES.filter((m) => m.kind !== "app");
if (target && MODULE_BY_ID.get(target).kind === "app") {
  console.error(`keel split: ${target} is an app, not a module — apps do not ship as repositories`);
  process.exit(1);
}
const selected = argv.includes("--all") || !target ? releasable : [MODULE_BY_ID.get(target)];

const FOUNDRY = JSON.parse(JSON.stringify({}));
const CHAIN_NAMES = { 1: "Ethereum", 11155111: "Sepolia", 8453: "Base", 84532: "Base Sepolia", 10: "Optimism", 42161: "Arbitrum", 137: "Polygon", 31337: "Anvil" };

function manifestOf(id) {
  return JSON.parse(readFileSync(join(CONTRACTS, "modules", id, "keel.module.json"), "utf8"));
}
function deploymentsOf(id) {
  const dir = join(CONTRACTS, "modules", id, "deployments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
/** transitive source deps, deepest first — what a consumer of this module needs */
function cone(id) {
  const out = [];
  const seen = new Set();
  (function visit(m) {
    if (seen.has(m)) return;
    seen.add(m);
    for (const d of MODULE_BY_ID.get(m).deps) visit(d);
    if (m !== id) out.push(m);
  })(id);
  return out;
}

/**
 * Everything that must exist in lib/ to BUILD AND TEST this module: the source
 * cone plus each devDep and its own source cone. A devDep may depend back on
 * this module (a canvas test builds a LINE collection, and LINE needs canvas),
 * so the module's own name is dropped here and remapped to src/ instead.
 */
function libCone(id) {
  const out = new Set();
  const add = (m) => {
    if (out.has(m)) return;
    out.add(m);
    for (const d of MODULE_BY_ID.get(m).deps) add(d);
  };
  for (const d of MODULE_BY_ID.get(id).deps) add(d);
  for (const d of MODULE_BY_ID.get(id).devDeps ?? []) add(d);
  out.delete(id);
  return [...out].sort();
}

/** tests that read golden vectors need the fixture directory and fs_permissions */
function needsFixtures(id) {
  const dir = join(CONTRACTS, "test/modules", id);
  if (!existsSync(dir)) return false;
  const walkSol = (d) => readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walkSol(p) : (p.endsWith(".sol") ? [p] : []);
  });
  return walkSol(dir).some((f) => readFileSync(f, "utf8").includes("test/fixtures"));
}

function foundryToml(id) {
  const fsPerms = needsFixtures(id)
    ? '\n# Golden vectors only — a test needs its fixtures, not the project root.\nfs_permissions = [{ access = "read", path = "./test/fixtures" }]\n'
    : "";
  return `[profile.default]
src = "src"
test = "test"
libs = ["lib"]
solc_version = "0.8.36"
# EIP-2537's BLS12-381 precompiles require Prague.
evm_version = "prague"
optimizer = true
optimizer_runs = 200
via_ir = true
bytecode_hash = "none"
cbor_metadata = false
${fsPerms}
[fuzz]
runs = 1000

[invariant]
runs = 256
depth = 64
fail_on_revert = true
`;
}

function remappings(id) {
  const lines = ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/"];
  // A dependency that depends back on this module still writes `@keel/<self>/…`,
  // which has to land on this repo's own sources rather than a copy in lib/.
  lines.push(`@keel/${id}/=src/`);
  lines.push(`@keel-test/${id}/=test/`);
  for (const dep of libCone(id)) lines.push(`@keel/${dep}/=lib/${dep}/src/`);
  // shared mocks live in a module's test/ dir, and a source dep's mocks are just
  // as reachable as a devDep's — map the test root for everything in lib/.
  for (const dep of libCone(id)) lines.push(`@keel-test/${dep}/=lib/${dep}/test/`);
  return `${lines.join("\n")}\n`;
}

function readme(id) {
  const m = manifestOf(id);
  const deps = cone(id);
  const records = deploymentsOf(id);
  const deployRows = [];
  for (const rec of records) {
    for (const [instance, slot] of Object.entries(rec.deployments)) {
      for (const c of Object.values(slot.contracts ?? {})) {
        deployRows.push(`| ${CHAIN_NAMES[rec.chainId] ?? rec.chainId} | \`${c.contract}\` | ${instance} | \`${c.address}\` |`);
      }
    }
  }
  return `# ${m.title}

${m.summary}

**Group:** \`${m.group}\` · **Module id:** \`${m.id}\` · **Version:** ${m.version}

## Install

\`\`\`bash
forge install ${ORG}/${m.id}
\`\`\`

While this repository is private, install over SSH so Foundry can authenticate:

\`\`\`bash
forge install git@github.com:${ORG}/${m.id}
\`\`\`

Add to \`remappings.txt\`:

\`\`\`
@keel/${m.id}/=lib/${m.id}/src/
\`\`\`

## Contracts

${m.deployable.length ? m.deployable.map((c) => `- \`${c}\``).join("\n") : "_This module ships interfaces and libraries only; nothing is deployed on its own._"}

## Dependencies

${deps.length ? deps.map((d) => `- [\`${d}\`](https://github.com/${ORG}/${d}) — ${manifestOf(d).title}`).join("\n") : "_None. This module sits at the bottom of the graph._"}

## Deployments

${deployRows.length ? `| Chain | Contract | Instance | Address |\n| --- | --- | --- | --- |\n${deployRows.join("\n")}` : "_Not yet deployed._"}

A chain can carry more than one instance of this module, so resolve by instance:

\`\`\`ts
import { moduleAddress } from "@keel/sdk";
moduleAddress("${m.id}", "${m.deployable[0] ?? "Contract"}", 11155111);
\`\`\`

## Develop

\`\`\`bash
forge build
forge test
\`\`\`

---
Generated by \`keel split\` from the [keel-sdk](https://github.com/Ravonus/keel-sdk) monorepo.
Edit the module there until it is fully separated.
`;
}

function workflow(id) {
  return `name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: foundry-rs/foundry-toolchain@v1
        with:
          version: nightly
      - name: build
        run: forge build --sizes
      - name: test
        run: forge test -vvv
      - name: fuzz
        run: forge test --fuzz-runs 10000
`;
}

function packageJson(id) {
  const m = manifestOf(id);
  return `${JSON.stringify({
    name: `@${ORG}/${m.id}`,
    version: m.version,
    description: m.summary,
    keywords: ["ethereum", "solidity", "keel", m.group],
    license: "MIT",
    repository: { type: "git", url: `https://github.com/${ORG}/${m.id}.git` },
    files: ["src", "keel.module.json", "deployments"],
  }, null, 2)}\n`;
}

const IMPORT_RE = /(import\s+(?:[^"';]*?\s+from\s+)?["'])([^"']+)(["'])/g;

/**
 * Tests address the monorepo by relative path (`../../../src/modules/<id>/X.sol`,
 * `../../TestBase.sol`). In a split repo `src/` and `test/` are siblings, so those
 * specifiers are recomputed against the copied layout. `@keel/` and package
 * specifiers already resolve through remappings and pass through untouched.
 */
function rewriteCopiedTests(id, outDir) {
  const origTestRoot = join(CONTRACTS, "test/modules", id);
  const newTestRoot = join(outDir, "test");
  const walkSol = (d) => (existsSync(d) ? readdirSync(d).flatMap((e) => {
    const p = join(d, e);
    return statSync(p).isDirectory() ? walkSol(p) : (p.endsWith(".sol") ? [p] : []);
  }) : []);

  let n = 0;
  for (const file of walkSol(newTestRoot)) {
    const rel = relative(newTestRoot, file);
    // TestBase.sol is copied in from the test root, not from the module dir
    const origin = rel === "TestBase.sol" ? join(CONTRACTS, "test/TestBase.sol") : join(origTestRoot, rel);
    const body = readFileSync(file, "utf8");
    const next = body.replace(IMPORT_RE, (whole, pre, spec, post) => {
      if (!spec.startsWith(".")) return whole;
      const target = resolve(dirname(origin), spec);
      const inOwnSrc = relative(join(CONTRACTS, "src/modules", id), target);
      let mapped;
      if (!inOwnSrc.startsWith("..")) mapped = join(outDir, "src", inOwnSrc);
      else if (target === join(CONTRACTS, "test/TestBase.sol")) mapped = join(newTestRoot, "TestBase.sol");
      else {
        const inOwnTest = relative(origTestRoot, target);
        if (inOwnTest.startsWith("..")) return whole; // leave anything else alone
        mapped = join(newTestRoot, inOwnTest);
      }
      let r = relative(dirname(file), mapped);
      if (!r.startsWith(".")) r = `./${r}`;
      if (r === spec) return whole;
      n++;
      return `${pre}${r}${post}`;
    });
    if (next !== body) writeFileSync(file, next);
  }
  return n;
}

let made = 0, rewrites = 0;
const plan = [];
for (const m of selected) {
  const dir = join(OUT, m.id);
  const deps = libCone(m.id);
  const srcDir = join(CONTRACTS, "src/modules", m.id);
  const testDir = join(CONTRACTS, "test/modules", m.id);
  const nTests = existsSync(testDir) ? readdirSync(testDir).filter((f) => f.endsWith(".sol")).length : 0;
  plan.push(`  ${m.id.padEnd(32)} ${String(manifestOf(m.id).contracts.length).padStart(3)} src, ${String(nTests).padStart(2)} test, ${deps.length} lib dep(s)`);
  if (!APPLY) continue;

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(srcDir, join(dir, "src"), { recursive: true });
  if (existsSync(testDir)) cpSync(testDir, join(dir, "test"), { recursive: true });
  // TestBase is shared across every module's suite
  const testBase = join(CONTRACTS, "test/TestBase.sol");
  if (existsSync(testBase) && existsSync(join(dir, "test"))) cpSync(testBase, join(dir, "test/TestBase.sol"));
  cpSync(join(CONTRACTS, "modules", m.id, "keel.module.json"), join(dir, "keel.module.json"));
  const depl = join(CONTRACTS, "modules", m.id, "deployments");
  if (existsSync(depl)) cpSync(depl, join(dir, "deployments"), { recursive: true });

  if (needsFixtures(m.id)) {
    cpSync(join(CONTRACTS, "test/fixtures"), join(dir, "test/fixtures"), { recursive: true });
  }
  const rewrote = rewriteCopiedTests(m.id, dir);
  if (rewrote) rewrites += rewrote;

  writeFileSync(join(dir, "foundry.toml"), foundryToml(m.id));
  writeFileSync(join(dir, "remappings.txt"), remappings(m.id));
  writeFileSync(join(dir, "README.md"), readme(m.id));
  writeFileSync(join(dir, "package.json"), packageJson(m.id));
  writeFileSync(join(dir, ".gitignore"), "out/\ncache/\nlib/\nnode_modules/\n");
  writeFileSync(join(dir, "LICENSE"), readFileSync(join(REPO, "LICENSE"), "utf8"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/ci.yml"), workflow(m.id));
  // the dependency install script, so lib/ is reproducible
  writeFileSync(join(dir, "install.sh"), `#!/usr/bin/env sh
# Dependencies for ${m.id}, in the order they must resolve.
set -e
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1
${libCone(m.id).map((d) => `forge install ${ORG}/${d}`).join("\n")}
`);
  made++;
}

const appTestDeps = selected
  .map((m) => [m.id, (MODULE_BY_ID.get(m.id).devDeps ?? []).filter((d) => MODULE_BY_ID.get(d)?.kind === "app")])
  .filter(([, apps]) => apps.length);

console.log(`keel split ${APPLY ? `(APPLY -> ${relative(REPO, OUT)})` : "(dry run)"}: ${selected.length} module(s)`);
console.log(plan.join("\n"));
if (APPLY) console.log(`\nwrote ${made} repository skeleton(s) to ${OUT}; rewrote ${rewrites} test import(s) for the split layout`);
else console.log("\n  re-run with --apply --out <dir>");
if (appTestDeps.length) {
  console.log("\nsources split cleanly, but these suites cannot run standalone —");
  console.log("they test against apps, which are never published:");
  for (const [id, apps] of appTestDeps) console.log(`  ${id} -> ${apps.join(", ")}`);
}
