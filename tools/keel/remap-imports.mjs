/**
 * Rewrites cross-module imports from relative paths to `@keel/<module>/...`.
 *
 * The point is that the same import text resolves in both layouts:
 *   monorepo        @keel/ -> src/modules/
 *   standalone repo @keel/keel-hold/ -> lib/keel-hold/src/
 *
 * so extracting a module into its own repository becomes a copy plus a
 * remappings file, with no source rewriting. It also makes a boundary crossing
 * visible in the source: `../` means "inside my module", `@keel/` means "not".
 *
 * Test suites additionally reach into other modules' test directories for shared
 * fixtures and mocks; those become `@keel-test/<module>/...`, remapped to that
 * module's test/ directory. Imports within a module stay relative.
 *
 * Pass --apply; default is a dry run.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { MODULES } from "./module-map.mjs";

const APPLY = process.argv.includes("--apply");
const REPO = resolve(import.meta.dirname, "../..");
const SRC = join(REPO, "packages/contracts/src");
const TEST = join(REPO, "packages/contracts/test");
const MODROOT = join(SRC, "modules");
const IMPORT_RE = /(import\s+(?:[^"';]*?\s+from\s+)?["'])([^"']+)(["'])/g;

const ids = new Set(MODULES.map((m) => m.id));
function walk(d) {
  if (!existsSync(d)) return [];
  const o = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) o.push(...walk(p));
    else if (e.endsWith(".sol")) o.push(p);
  }
  return o;
}
/** the module a file belongs to, or null for shared test helpers/gates */
function moduleOf(file) {
  const rel = relative(MODROOT, file);
  if (!rel.startsWith("..")) return rel.split("/")[0];
  const t = relative(join(TEST, "modules"), file);
  if (!t.startsWith("..")) return t.split("/")[0];
  return null;
}

let changed = 0, rewrites = 0;
const samples = [];
for (const file of [...walk(SRC), ...walk(TEST)]) {
  const from = moduleOf(file);
  const body = readFileSync(file, "utf8");
  let n = 0;
  const next = body.replace(IMPORT_RE, (whole, pre, spec, post) => {
    if (!spec.startsWith(".")) return whole;
    const target = resolve(dirname(file), spec);

    const srcRel = relative(MODROOT, target);
    const testRel = relative(join(TEST, "modules"), target);
    let prefix, rel;
    if (!srcRel.startsWith("..")) { prefix = "@keel"; rel = srcRel; }
    else if (!testRel.startsWith("..")) { prefix = "@keel-test"; rel = testRel; }
    else return whole;                                  // shared helper or gate

    const to = rel.split("/")[0];
    if (!ids.has(to) || to === from) return whole;      // same module stays relative
    n++;
    if (samples.length < 5) samples.push(`  ${relative(REPO, file)}\n    ${spec}\n      -> ${prefix}/${rel}`);
    return `${pre}${prefix}/${rel}${post}`;
  });
  if (n) { rewrites += n; changed++; if (APPLY) writeFileSync(file, next); }
}
console.log(`keel remap ${APPLY ? "(APPLY)" : "(dry run)"}: ${rewrites} cross-module import(s) in ${changed} file(s)`);
if (samples.length) console.log(samples.join("\n"));
if (!APPLY) console.log("\n  re-run with --apply");
