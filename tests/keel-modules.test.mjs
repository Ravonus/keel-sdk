import nodeTest from "node:test";
import assert from "node:assert/strict";
import { siblingTest } from "./sibling-repository.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ABI_CONTRACTS,
  KEEL_APPS,
  KEEL_DEPLOYMENTS,
  KEEL_MODULES,
  findDeployments,
  getModule,
  listModules,
  moduleAbi,
  moduleAbiContracts,
  moduleAddress,
  moduleChains,
  moduleContract,
  moduleDependencyOrder,
  resolveModuleTarget,
} from "../packages/sdk/dist/index.js";

import { MODULE_BY_ID as UNIT_MAP } from "../tools/keel/module-map.mjs";

// Every case here compares this repository's module map against the contracts
// tree, so all of them need that sibling. See sibling-repository.mjs for why
// this is a skip rather than a token in a public workflow, and for the guard
// that stops it skipping everywhere unnoticed.
const test = siblingTest(nodeTest, "keel-contracts");

const MODULES_DIR = "../keel-contracts/modules";
const APPS_DIR = "../keel-contracts/apps";
/** modules and apps live in sibling trees; everything else about them matches */
const UNITS = [...KEEL_MODULES, ...KEEL_APPS];
const metaDir = (unit) => (unit.kind === "app" ? APPS_DIR : MODULES_DIR);
const srcDir = (unit) => `../keel-contracts/src/${unit.kind === "app" ? "apps" : "modules"}`;

/**
 * The checker only proves the map and the tree agree with each other. Deleting a
 * module from both at once is internally consistent, and that is exactly how
 * keel-backpack once disappeared without a single gate noticing. Pinning the
 * roster makes losing one a failure rather than a quiet consistency.
 */
const EXPECTED_MODULES = [
  "cool-s", "keel-anchors", "keel-artifacts", "keel-canvas", "keel-codecs",
  "keel-creator-identity", "keel-cross-chain-mint", "keel-crucible", "keel-die",
  "keel-equipment", "keel-graph", "keel-harness", "keel-hold", "keel-ip-control",
  "keel-kernel", "keel-market", "keel-mint-access", "keel-presentation", "keel-sleeve",
  "keel-stake", "keel-web3-url", "line", "vault-runner",
];

test("no module disappears without the roster changing", () => {
  const present = [...KEEL_MODULES, ...KEEL_APPS].map((m) => m.id).sort();
  assert.deepEqual(present, [...EXPECTED_MODULES].sort());
});

test("the boundary checker passes on the current tree", () => {
  // Guards the checker itself: cross-module imports are remapped through
  // `@keel/`, and a checker that stopped resolving them would report a clean
  // tree while enforcing nothing.
  const out = execFileSync("node", ["tools/keel/check.mjs"], { encoding: "utf8" });
  assert.match(out, /\d+ source edges, \d+ test edges/u);
  assert.match(out, /OK — coverage complete/u);
  assert.doesNotMatch(out, /FAIL/u);
});

test("every module in the SDK registry has a manifest and a source directory on disk", () => {
  assert.ok(KEEL_MODULES.length > 0);
  for (const module of UNITS) {
    const manifest = join(metaDir(module), module.id, "keel.module.json");
    assert.ok(existsSync(manifest), `${module.id} has no manifest`);
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(parsed.schema, "keel.module@1");
    assert.equal(parsed.id, module.id);
    if (UNIT_MAP.get(module.id)?.external) continue; // sources live in the unit's own repository
    assert.ok(existsSync(`${srcDir(module)}/${module.id}`), `${module.id} has no sources`);
    for (const contract of module.contracts) {
      assert.ok(
        existsSync(`${srcDir(module)}/${module.id}/${contract}`),
        `${module.id} claims ${contract}, which is not on disk`,
      );
    }
  }
});

test("every module carries a group label that matches its manifest", () => {
  const groups = new Set();
  for (const module of UNITS) {
    assert.ok(module.group, `${module.id} has no group`);
    groups.add(module.group);
    const manifest = JSON.parse(readFileSync(join(metaDir(module), module.id, "keel.module.json"), "utf8"));
    assert.equal(manifest.group, module.group, `${module.id} group drifted from its manifest`);
  }
  // groups are a small closed set, not free text
  assert.ok(groups.size <= 8, `too many groups: ${[...groups].join(", ")}`);
});

test("the module dependency graph is acyclic and every dependency is a known module", () => {
  const ids = new Set(UNITS.map((m) => m.id));
  for (const module of UNITS) {
    for (const dep of module.deps) assert.ok(ids.has(dep), `${module.id} depends on unknown ${dep}`);
    // devDeps are test-only and may point upward, so they are not part of the
    // acyclicity rule — but they still have to name real modules.
    const manifest = JSON.parse(readFileSync(join(metaDir(module), module.id, "keel.module.json"), "utf8"));
    for (const dep of manifest.devDeps ?? []) {
      assert.ok(ids.has(dep), `${module.id} devDepends on unknown ${dep}`);
      assert.ok(!module.deps.includes(dep), `${module.id} lists ${dep} as both dep and devDep`);
    }
    // moduleDependencyOrder recurses; a cycle would overflow rather than return.
    const order = moduleDependencyOrder(module.id);
    assert.ok(!order.includes(module.id), `${module.id} depends on itself`);
    for (const dep of module.deps) assert.ok(order.includes(dep), `${module.id} order omits ${dep}`);
  }
});

test("dependency order lists a module's dependencies before the modules that need them", () => {
  const order = moduleDependencyOrder("vault-runner");
  for (const [index, id] of order.entries()) {
    for (const dep of getModule(id).deps) {
      assert.ok(order.indexOf(dep) < index, `${dep} must precede ${id}`);
    }
  }
});

test("deployment records on disk match what the SDK reports", () => {
  let onDisk = 0;
  for (const module of UNITS) {
    const dir = join(metaDir(module), module.id, "deployments");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
      assert.equal(record.schema, "keel.deployments@1");
      assert.equal(record.module, module.id);
      assert.equal(String(record.chainId), file.replace(/\.json$/, ""));
      for (const instance of Object.values(record.deployments)) {
        for (const entry of Object.values(instance.contracts)) {
          assert.match(entry.address, /^0x[0-9a-fA-F]{40}$/u);
          assert.ok(
            module.deployable.includes(entry.contract),
            `${module.id} records ${entry.contract}, which is not deployable`,
          );
          onDisk += 1;
        }
      }
    }
  }
  assert.equal(onDisk, KEEL_DEPLOYMENTS.length);
});

test("a module deployed more than once on a chain must be disambiguated by instance", () => {
  const seen = new Map();
  for (const d of KEEL_DEPLOYMENTS) {
    const key = `${d.module}:${d.chainId}:${d.contract}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const ambiguous = [...seen].filter(([, n]) => n > 1);
  for (const [key] of ambiguous) {
    const [module, chainId, contract] = key.split(":");
    assert.throws(
      () => moduleAddress(module, contract, Number(chainId)),
      /pass instance/u,
      `${key} resolved silently despite multiple instances`,
    );
    const instances = findDeployments({ module, chainId: Number(chainId), contract }).map((d) => d.instance);
    for (const instance of instances) {
      assert.match(moduleAddress(module, contract, Number(chainId), instance), /^0x[0-9a-fA-F]{40}$/u);
    }
  }
});

test("every recorded deployment can be connected to: address and ABI together", async () => {
  // Resolution is entirely local, so a module behaves the same whether its
  // repository is public or private.
  for (const d of KEEL_DEPLOYMENTS) {
    const c = await moduleContract({
      module: d.module,
      contract: d.contract,
      chainId: d.chainId,
      instance: d.instance,
    });
    assert.equal(c.address, d.address);
    assert.ok(Array.isArray(c.abi) && c.abi.length > 0, `${d.module}/${d.contract} has an empty ABI`);
  }
});

test("every deployable contract has a recorded ABI", async () => {
  for (const unit of UNITS) {
    const recorded = moduleAbiContracts(unit.id);
    for (const contract of unit.deployable) {
      assert.ok(recorded.includes(contract), `${unit.id}/${contract} has no recorded ABI`);
      const abi = await moduleAbi(unit.id, contract);
      assert.ok(Array.isArray(abi), `${unit.id}/${contract} ABI is not an array`);
    }
    assert.deepEqual([...recorded].sort(), [...(ABI_CONTRACTS[unit.id] ?? [])].sort());
  }
});

test("asking for an ABI that was never recorded names what is available", async () => {
  await assert.rejects(() => moduleAbi("keel-market", "NotAContract"), /has no ABI for NotAContract/u);
});

test("repository visibility is recorded for every publishable module", () => {
  for (const module of KEEL_MODULES) {
    assert.match(module.repo, /^keel-web3\//u, `${module.id} has an unexpected repository`);
    assert.ok(
      module.visibility === "public" || module.visibility === "private" || module.visibility === null,
      `${module.id} has an invalid visibility: ${module.visibility}`,
    );
  }
  for (const app of KEEL_APPS) assert.equal(app.repo, null);
});

test("resolving an unknown target reports the chains the module is actually on", () => {
  assert.throws(() => resolveModuleTarget({ module: "keel-market", chainId: 999999 }), /known chains: 11155111/u);
  assert.throws(() => getModule("not-a-module"), /unknown module/u);
});

test("no module depends on an app", () => {
  // Apps are products built on the protocol. If infrastructure ever depends on
  // one, the module can no longer be released or consumed on its own.
  const appIds = new Set(KEEL_APPS.map((a) => a.id));
  for (const module of KEEL_MODULES) {
    assert.equal(module.kind, "module");
    for (const dep of module.deps) {
      assert.ok(!appIds.has(dep), `module ${module.id} depends on app ${dep}`);
    }
    assert.ok(module.repo, `${module.id} has no repository and so cannot ship`);
  }
  for (const app of KEEL_APPS) {
    assert.equal(app.kind, "app");
    assert.equal(app.repo, null, `app ${app.id} must not claim a repository`);
  }
});

test("listModules covers the registry and every chain id is a positive integer", () => {
  assert.equal(listModules().length, KEEL_MODULES.length);
  for (const module of UNITS) {
    for (const chainId of moduleChains(module.id)) {
      assert.ok(Number.isInteger(chainId) && chainId > 0, `${module.id} has bad chain ${chainId}`);
    }
  }
});
