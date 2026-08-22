/**
 * One-shot relocation of the flat contract tree into per-module directories.
 *
 * src/Foo.sol                  -> src/modules/<owner>/Foo.sol
 * src/interfaces/IFoo.sol      -> src/modules/<owner>/interfaces/IFoo.sol
 * test/Foo.t.sol               -> test/modules/<owner>/Foo.t.sol
 *
 * Every local import is recomputed from the mover's own path table, so no import
 * is rewritten by string-matching. Pass --apply to execute; default is a dry run.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, resolve, basename } from "node:path";
import { MODULES } from "./module-map.mjs";

const APPLY = process.argv.includes("--apply");
const REPO = resolve(import.meta.dirname, "../..");
const CONTRACTS = join(REPO, "../keel-contracts");
const SRC = join(CONTRACTS, "src");
const TEST = join(CONTRACTS, "test");
const IMPORT_RE = /(import\s+(?:[^"';]*?\s+from\s+)?["'])([^"']+)(["'])/g;

const owner = new Map();
for (const m of MODULES) for (const c of m.contracts) owner.set(c, m.id);

function walk(dir, filter = (f) => f.endsWith(".sol")) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter(e)) out.push(p);
  }
  return out;
}

// ---- path table: absolute old path -> absolute new path -------------------
const moves = new Map();

for (const f of walk(SRC)) {
  const rel = relative(SRC, f);
  if (rel.startsWith("modules/")) continue; // already relocated
  const id = owner.get(rel);
  if (!id) throw new Error(`no module owns ${rel} — run \`node tools/keel/check.mjs\` first`);
  moves.set(f, join(SRC, "modules", id, rel));
}

// tests: owned by the module of the contract they exercise. Resolve by looking at
// which src file the test imports; ties break toward the deepest module in the DAG.
const testOwner = new Map();
for (const f of walk(TEST)) {
  const rel = relative(TEST, f);
  if (rel.startsWith("modules/")) continue;
  // fixtures are shared data; fork/ and gas/ are repo-level gates whose paths are
  // pinned by foundry.toml (no_match_path) and the gas snapshot scripts.
  if (rel.startsWith("fixtures/") || rel.startsWith("fork/") || rel.startsWith("gas/")) continue;
  const body = readFileSync(f, "utf8");
  const hits = new Map();
  for (const m of body.matchAll(IMPORT_RE)) {
    const spec = m[2];
    if (!spec.startsWith(".")) continue;
    const target = relative(SRC, resolve(dirname(f), spec));
    if (target.startsWith("..")) continue;
    const id = owner.get(target);
    if (id) hits.set(id, (hits.get(id) ?? 0) + 1);
  }
  // strongest signal: a src file whose basename matches the test's basename.
  const stem = basename(f).replace(/\.t\.sol$|\.gas\.t\.sol$/, "");
  let id = owner.get(`${stem}.sol`) ?? owner.get(`interfaces/${stem}.sol`) ?? owner.get(`libraries/${stem}.sol`);
  if (!id) id = [...hits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!id) { testOwner.set(f, null); continue; }
  testOwner.set(f, id);
  moves.set(f, join(TEST, "modules", id, rel));
}

const unowned = [...testOwner].filter(([, v]) => !v).map(([k]) => relative(TEST, k));

// ---- rewrite imports using the path table --------------------------------
function newPathOf(abs) { return moves.get(abs) ?? abs; }

let rewritten = 0;
const edits = new Map();
const allSol = [...walk(SRC), ...walk(TEST)];
for (const oldPath of allSol) {
  const body = readFileSync(oldPath, "utf8");
  const from = newPathOf(oldPath);
  let changed = false;
  const next = body.replace(IMPORT_RE, (whole, pre, spec, post) => {
    if (!spec.startsWith(".")) return whole;
    const targetOld = resolve(dirname(oldPath), spec);
    const targetNew = newPathOf(targetOld);
    let r = relative(dirname(from), targetNew);
    if (!r.startsWith(".")) r = `./${r}`;
    if (r === spec) return whole;
    changed = true;
    return `${pre}${r}${post}`;
  });
  if (changed) { edits.set(oldPath, next); rewritten++; }
}

console.log(`keel relocate ${APPLY ? "(APPLY)" : "(dry run)"}`);
console.log(`  ${moves.size} files move, ${rewritten} need import rewrites`);
if (unowned.length) {
  console.log(`  ${unowned.length} test file(s) with no resolvable owner (left in place):`);
  for (const u of unowned) console.log(`      ${u}`);
}

if (!APPLY) {
  console.log("\n  sample:");
  for (const [o, n] of [...moves].slice(0, 6)) console.log(`    ${relative(CONTRACTS, o)}\n      -> ${relative(CONTRACTS, n)}`);
  console.log("\n  re-run with --apply to execute");
  process.exit(0);
}

let untracked = 0;
for (const [oldPath, newPath] of moves) {
  mkdirSync(dirname(newPath), { recursive: true });
  try {
    execFileSync("git", ["mv", oldPath, newPath], { cwd: REPO, stdio: "pipe" });
  } catch {
    // Not tracked yet (this tree carries an uncommitted rename sweep). A plain
    // rename is equivalent — git detects renames by content at commit time.
    renameSync(oldPath, newPath);
    untracked++;
  }
}
if (untracked) console.log(`  ${untracked} file(s) moved outside the index (untracked)`);
for (const [oldPath, body] of edits) writeFileSync(newPathOf(oldPath), body);
console.log(`\n  moved ${moves.size}, rewrote ${edits.size}`);
