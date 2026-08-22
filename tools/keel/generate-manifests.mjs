/**
 * Writes packages/contracts/modules/<id>/keel.module.json from the module map.
 *
 * `deployable` is derived from compiled artifacts rather than declared by hand: a
 * contract is deployable when forge emitted non-empty creation bytecode for it,
 * which excludes interfaces, libraries, and abstract bases automatically.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { MODULES, TIER_OF } from "./module-map.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const CONTRACTS = join(REPO, "../keel-contracts");
const OUT = join(CONTRACTS, "out");
const metaDir = (id) => join(CONTRACTS, TIER_OF.get(id));
const VERSION = JSON.parse(readFileSync(join(CONTRACTS, "package.json"), "utf8")).version;

function deployablesFor(solFile) {
  const dir = join(OUT, basename(solFile));
  if (!existsSync(dir)) return [];
  const names = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const code = a?.bytecode?.object ?? "";
      if (code.replace(/^0x/, "").length > 0) names.push(f.replace(/\.json$/, ""));
    } catch { /* artifact unreadable; treat as non-deployable */ }
  }
  return names.sort();
}

/** preserve visibility across regeneration — it comes from GitHub, not the map */
function existingVisibility(id) {
  const p = join(metaDir(id), id, "keel.module.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")).visibility ?? null; } catch { return null; }
}

let written = 0;
for (const m of MODULES) {
  const dir = join(metaDir(m.id), m.id);
  mkdirSync(join(dir, "deployments"), { recursive: true });
  // interfaces are never deployed, and every library here is internal-only and
  // inlined by the compiler — forge still emits a stub for them, so filter by path.
  const deployable = [...new Set(
    m.contracts.filter((c) => !c.startsWith("interfaces/") && !c.startsWith("libraries/"))
      .flatMap(deployablesFor),
  )].sort();
  const manifest = {
    schema: "keel.module@1",
    id: m.id,
    kind: m.kind,
    title: m.title,
    group: m.group,
    summary: m.summary,
    version: VERSION,
    repo: m.kind === "app" ? null : `keel-web3/${m.id}`,
    // recorded by `keel repos --sync`; drives install instructions, nothing else
    visibility: existingVisibility(m.id),
    deps: m.deps,
    devDeps: m.devDeps ?? [],
    sources: `packages/contracts/src/${TIER_OF.get(m.id)}/${m.id}`,
    tests: `packages/contracts/test/${TIER_OF.get(m.id)}/${m.id}`,
    contracts: m.contracts,
    deployable,
    verify: {
      build: "forge build",
      test: `forge test --match-path 'test/${TIER_OF.get(m.id)}/${m.id}/*'`,
      static: "node scripts/solidity-static-check.mjs",
      sizeLimitBytes: 24576,
    },
  };
  writeFileSync(join(dir, "keel.module.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  written++;
}
console.log(`wrote ${written} manifests under packages/contracts/{modules,apps}/`);
const counts = MODULES.map((m) => {
  const d = JSON.parse(readFileSync(join(metaDir(m.id), m.id, "keel.module.json"), "utf8"));
  return `  ${(m.kind === "app" ? "app " : "    ")}${m.id.padEnd(32)} ${String(d.contracts.length).padStart(3)} files, ${String(d.deployable.length).padStart(2)} deployable`;
});
console.log(counts.join("\n"));
