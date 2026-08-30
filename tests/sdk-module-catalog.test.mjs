import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_APPS,
  KEEL_DEPLOYMENTS,
  KEEL_MODULES,
  findDeployments,
  getModule,
  listApps,
  listModules,
  moduleAddress,
  moduleChains,
  moduleDependencyOrder,
  resolveModuleTarget,
} from "../packages/sdk/dist/index.js";
import { MODULES } from "../tools/keel/module-map.mjs";

test("[modules/listModules,listApps,getModule] exposes every authoritative unit once and keeps examples separate", () => {
  const catalog = [...listModules(), ...listApps()];
  assert.equal(catalog.length, MODULES.length);
  assert.deepEqual(catalog.map(({ id }) => id), MODULES.map(({ id }) => id));
  assert.equal(new Set(catalog.map(({ id }) => id)).size, catalog.length);

  for (const source of MODULES) {
    const indexed = getModule(source.id);
    assert.equal(indexed.kind, source.kind);
    assert.equal(indexed.group, source.group);
    assert.equal(indexed.title, source.title);
    assert.equal(indexed.summary, source.summary);
    assert.deepEqual(indexed.deps, source.deps);
    assert.deepEqual(indexed.contracts, source.contracts);
  }

  assert.equal(/argonaut/iu.test(JSON.stringify(catalog)), false, "private creator examples must not leak into the reusable SDK catalogue");
  assert.throws(() => getModule("not-a-keel-unit"), /unknown module/u);
});

test("[modules/moduleDependencyOrder] returns the complete dependency DAG in deployment order", () => {
  for (const unit of [...KEEL_MODULES, ...KEEL_APPS]) {
    const order = moduleDependencyOrder(unit.id);
    assert.equal(new Set(order).size, order.length, `${unit.id} repeats a dependency`);
    assert.equal(order.includes(unit.id), false, `${unit.id} includes itself`);
    for (const [index, dependency] of order.entries()) {
      for (const prerequisite of getModule(dependency).deps) {
        assert.ok(order.indexOf(prerequisite) < index, `${unit.id}: ${prerequisite} must precede ${dependency}`);
      }
    }
    for (const direct of unit.deps) assert.ok(order.includes(direct), `${unit.id} omits direct dependency ${direct}`);
  }
});

test("[modules/findDeployments,resolveModuleTarget,moduleAddress,moduleChains] never guesses between deployments", () => {
  for (const deployment of KEEL_DEPLOYMENTS) {
    assert.ok(moduleChains(deployment.module).includes(deployment.chainId));
    assert.deepEqual(resolveModuleTarget({
      module: deployment.module,
      chainId: deployment.chainId,
      contract: deployment.contract,
      instance: deployment.instance,
    }), deployment);
    assert.equal(
      moduleAddress(deployment.module, deployment.contract, deployment.chainId, deployment.instance),
      deployment.address,
    );
  }

  const ambiguous = findDeployments({
    module: "keel-graph",
    chainId: 11_155_111,
    contract: "KeelGraphRegistry",
  });
  assert.ok(ambiguous.length > 1, "fixture must retain multiple named KeelGraphRegistry instances");
  assert.throws(
    () => resolveModuleTarget({ module: "keel-graph", chainId: 11_155_111, contract: "KeelGraphRegistry" }),
    /pass instance/u,
  );
  assert.throws(
    () => resolveModuleTarget({ module: "keel-hold", chainId: 1, contract: "KeelHold" }),
    /known chains: 11155111/u,
  );
});

test("[modules/catalog immutability] JavaScript callers cannot corrupt later SDK resolution", () => {
  assert.equal(Object.isFrozen(KEEL_MODULES), true);
  assert.equal(Object.isFrozen(KEEL_APPS), true);
  assert.equal(Object.isFrozen(KEEL_DEPLOYMENTS), true);
  for (const unit of [...KEEL_MODULES, ...KEEL_APPS]) {
    assert.equal(Object.isFrozen(unit), true);
    assert.equal(Object.isFrozen(unit.deps), true);
    assert.equal(Object.isFrozen(unit.contracts), true);
    assert.equal(Object.isFrozen(unit.deployable), true);
  }
  for (const deployment of KEEL_DEPLOYMENTS) assert.equal(Object.isFrozen(deployment), true);

  const firstId = KEEL_MODULES[0].id;
  assert.throws(() => KEEL_MODULES.pop(), /read only|object is not extensible|Cannot delete/u);
  assert.throws(() => { KEEL_MODULES[0].deps[0] = "keel-market"; }, /read only|object is not extensible|Cannot assign/u);
  assert.equal(getModule(firstId).id, firstId);
});

test("[modules/generated inventory] current token, auction, and route contracts stay identifiable", () => {
  const die = getModule("keel-die");
  for (const contract of ["KeelMintSeeded721.sol", "KeelMintSeeded721A.sol", "KeelCreator721A.sol", "interfaces/IKeelMintDataSource.sol"]) {
    assert.ok(die.contracts.includes(contract), `keel-die is missing ${contract}`);
  }

  const mintAccess = getModule("keel-mint-access");
  for (const contract of ["FrayAuctionIssuer", "KeelMintRouteRegistry", "OneMintController", "OpenOneMintController"]) {
    assert.ok(mintAccess.deployable.includes(contract), `keel-mint-access cannot identify ${contract}`);
  }
});
