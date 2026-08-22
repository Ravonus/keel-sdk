/**
 * Adds contracts that exist on disk but are not yet listed in the module map.
 *
 * Since sources live inside module directories, ownership is unambiguous — the
 * directory decides. The map still lists every file explicitly so that a new
 * contract is a deliberate, reviewable line in the diff rather than something
 * that appears by walking a directory; this command just removes the tedium.
 *
 * Pass --apply; default is a dry run.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MODULES, TIER_OF } from "./module-map.mjs";

const APPLY = process.argv.includes("--apply");
const REPO = resolve(import.meta.dirname, "../..");
const srcRoot = (id) => join(REPO, "packages/contracts/src", TIER_OF.get(id), id);
const MAP = join(import.meta.dirname, "module-map.mjs");

const owned = new Set(MODULES.flatMap((m) => m.contracts));
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith(".sol") ? [p] : []);
}) : []);

const additions = new Map();
for (const m of MODULES) {
  for (const file of walk(srcRoot(m.id))) {
    const rel = relative(srcRoot(m.id), file);
    if (owned.has(rel)) continue;
    if (!additions.has(m.id)) additions.set(m.id, []);
    additions.get(m.id).push(rel);
  }
}

if (!additions.size) { console.log("keel adopt: nothing to adopt — every source is already owned"); process.exit(0); }

console.log(`keel adopt ${APPLY ? "(APPLY)" : "(dry run)"}: ${[...additions.values()].flat().length} new contract(s)`);
for (const [id, files] of additions) for (const f of files) console.log(`  ${id.padEnd(28)} ${f}`);

if (!APPLY) { console.log("\n  re-run with --apply"); process.exit(0); }

let source = readFileSync(MAP, "utf8");
for (const [id, files] of additions) {
  // append to that module's contracts array, preserving the existing formatting
  const re = new RegExp(`(id: "${id}",[\\s\\S]*?contracts: \\[)([\\s\\S]*?)(\\],)`);
  if (!re.test(source)) throw new Error(`could not locate contracts array for ${id}`);
  source = source.replace(re, (whole, head, body, tail) => {
    const existing = body.trim().replace(/,$/, "");
    const merged = [...existing.split(/,\s*/).filter(Boolean), ...files.map((f) => `"${f}"`)];
    return `${head}${merged.join(", ")}${tail}`;
  });
}
writeFileSync(MAP, source);
console.log(`\nadopted into ${MAP.replace(`${REPO}/`, "")} — run \`pnpm keel:check\` and \`pnpm keel:sync\``);
