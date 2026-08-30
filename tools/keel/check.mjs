/**
 * Boundary checker for the Keel module map.
 *
 * Three invariants, each fatal:
 *   1. coverage    — every src/*.sol is owned by exactly one module, and every
 *                    path the map names actually exists.
 *   2. acyclic     — the declared module dep graph is a DAG.
 *   3. boundaries  — every local import either stays inside its own module or
 *                    crosses an edge that module declares in `deps`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { MODULES, MODULE_BY_ID, OWNER_OF, TIER_OF, isApp } from "./module-map.mjs";

const SRC = resolve(import.meta.dirname, "../../../keel-contracts/src");
const CONTRACTS = resolve(import.meta.dirname, "../../../keel-contracts");
const TEST_TIERS = ["modules", "apps"];
const IMPORT_RE = /import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".sol")) out.push(p);
  }
  return out;
}

const errors = [];
const key = (p) => relative(SRC, p).split("/").filter((s) => s !== "modules" && s !== "apps" && !MODULE_BY_ID.has(s)).join("/");
const files = walk(SRC);
const onDisk = new Set(files.map(key));

// 1. coverage
const claimed = new Map();
for (const m of MODULES) {
  if (m.external) continue; // sources live in the unit's own repository since the split
  for (const c of m.contracts) {
    if (claimed.has(c)) errors.push(`coverage: ${c} claimed by both ${claimed.get(c)} and ${m.id}`);
    claimed.set(c, m.id);
    if (!onDisk.has(c)) errors.push(`coverage: ${m.id} claims ${c}, which is not on disk`);
  }
}

for (const f of onDisk) if (!claimed.has(f)) errors.push(`coverage: ${f} is not owned by any module`);

// 2. acyclic
const seen = new Map();
function visit(id, stack) {
  if (seen.get(id) === "done") return;
  if (seen.get(id) === "open") { errors.push(`cycle: ${[...stack, id].join(" -> ")}`); return; }
  seen.set(id, "open");
  for (const d of MODULE_BY_ID.get(id)?.deps ?? []) {
    if (!MODULE_BY_ID.has(d)) { errors.push(`deps: ${id} declares unknown module ${d}`); continue; }
    visit(d, [...stack, id]);
  }
  seen.set(id, "done");
}
for (const m of MODULES) visit(m.id, []);

// 3. boundaries — a module may import from itself or any module it declares.
const allowed = new Map();
for (const m of MODULES) allowed.set(m.id, new Set([m.id, ...m.deps]));

const crossings = new Map();
for (const f of files) {
  const from = key(f);
  const owner = claimed.get(from);
  if (!owner) continue;
  for (const match of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
    const spec = match[1];
    // Cross-module imports are remapped (`@keel/<module>/...`) so the same text
    // resolves in a split-out repository; resolve them here or the boundary
    // check would silently stop seeing the edges it exists to police.
    const target = spec.startsWith("@keel/")
      ? key(join(SRC, "modules", spec.slice("@keel/".length)))
      : spec.startsWith("@app/")
        ? key(join(SRC, "apps", spec.slice("@app/".length)))
        : spec.startsWith(".")
          ? key(resolve(dirname(f), spec))
          : null;
    if (target === null) continue;
    const targetOwner = claimed.get(target);
    if (!targetOwner) { errors.push(`boundary: ${from} imports unowned ${target}`); continue; }
    if (targetOwner === owner) continue;
    const edge = `${owner} -> ${targetOwner}`;
    crossings.set(edge, (crossings.get(edge) ?? 0) + 1);
    if (!isApp(owner) && isApp(targetOwner)) {
      errors.push(`layering: ${from} (module ${owner}) imports ${target}, which belongs to the app ${targetOwner} — modules may not depend on apps`);
    } else if (!allowed.get(owner).has(targetOwner)) {
      errors.push(`boundary: ${from} (${owner}) imports ${target} (${targetOwner}) — ${owner} does not declare ${targetOwner}`);
    }
  }
}

// 4. test boundaries — a module's tests may reach anything in deps OR devDeps.
// devDeps legitimately point upward, so they are checked but never made acyclic.
const testAllowed = new Map();
for (const m of MODULES) testAllowed.set(m.id, new Set([m.id, ...m.deps, ...(m.devDeps ?? [])]));

let testEdges = 0;
for (const tier of TEST_TIERS) {
  const root = join(CONTRACTS, "test", tier);
  if (!existsSync(root)) continue;
  for (const id of readdirSync(root)) {
    if (!MODULE_BY_ID.has(id)) { errors.push(`tests: test/${tier}/${id} matches no module`); continue; }
    if (TIER_OF.get(id) !== tier) { errors.push(`tests: ${id} is a ${TIER_OF.get(id) === "apps" ? "app" : "module"} but its tests are under test/${tier}/`); continue; }
    for (const f of walk(join(root, id))) {
      for (const match of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
        const spec = match[1];
        const to = spec.startsWith("@keel/") ? spec.slice("@keel/".length).split("/")[0]
          : spec.startsWith("@keel-test/") ? spec.slice("@keel-test/".length).split("/")[0]
            : spec.startsWith("@app/") ? spec.slice("@app/".length).split("/")[0]
              : spec.startsWith("@app-test/") ? spec.slice("@app-test/".length).split("/")[0]
                : null;
        if (to === null || to === id) continue;
        if (!MODULE_BY_ID.has(to)) { errors.push(`tests: ${relative(root, f)} imports unknown module ${to}`); continue; }
        testEdges++;
        if (!testAllowed.get(id).has(to)) {
          errors.push(`tests: ${relative(root, f)} (${id}) imports ${to} — declare it in ${id}'s devDeps`);
        }
      }
    }
  }
}

// declared-but-unused deps are worth knowing about, but are not fatal.
const warnings = [];
// A module whose SOURCES touch an app is a hard error (above). A module whose
// TESTS do is debt: the module still releases on its own, but its suite cannot
// run in a split repository, because apps are never published.
for (const m of MODULES) {
  if (m.kind === "app") continue;
  for (const d of m.devDeps ?? []) {
    if (isApp(d)) warnings.push(`test debt: module ${m.id} tests against the app ${d}; its suite cannot run standalone`);
  }
}
for (const m of MODULES) {
  for (const d of m.deps) if (!crossings.has(`${m.id} -> ${d}`)) warnings.push(`unused dep: ${m.id} declares ${d} but imports nothing from it`);
}

const nApps = MODULES.filter((m) => m.kind === "app").length;
console.log(`keel check: ${MODULES.length - nApps} modules + ${nApps} apps, ${onDisk.size} contracts, ${crossings.size} source edges, ${testEdges} test edges`);
for (const w of warnings) console.log(`  warn  ${w}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  FAIL  ${e}`);
  process.exit(1);
}
console.log("\nedges:");
for (const [e, n] of [...crossings].sort()) console.log(`  ${e}  (${n})`);
console.log("\nOK — coverage complete, graph acyclic, no undeclared boundary crossings.");
