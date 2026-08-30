import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import { createIntegrity } from "../packages/protocol/dist/index.js";
import {
  getKeelCreativeRuntime,
  listKeelCreativeRuntimes,
  searchKeelCreativeRuntimes,
} from "../packages/sdk/dist/creative-runtime-catalog.js";

test("[creative runtime catalog] p5, Three.js, Doom WASM, and Flash/Ruffle are locally discoverable", () => {
  assert.deepEqual(listKeelCreativeRuntimes().map(({ id }) => id), ["p5", "three", "doom-wasm", "flash-ruffle"]);
  assert.deepEqual(getKeelCreativeRuntime("p5").resources.map(({ id, version }) => ({ id, version })), [
    { id: "p5-1-11-3", version: "1.11.3" },
    { id: "p5-1-7-0", version: "1.7.0" },
  ]);
  assert.equal(getKeelCreativeRuntime("three").resources.length, 2);
  const flash = getKeelCreativeRuntime("flash-ruffle");
  assert.deepEqual(flash.resources.map(({ id }) => id), [
    "flash-edition-module",
    "seeded-random-module",
    "ruffle-loader-module",
    "ruffle-main",
    "ruffle-core-modern",
    "ruffle-wasm-modern",
    "brotli-decoder-wasm",
    "ruffle-core-legacy",
    "ruffle-wasm-legacy",
  ]);
  assert.deepEqual(
    flash.resources.filter(({ referenceStatus }) => referenceStatus === "inactive-legacy").map(({ id }) => id),
    ["ruffle-core-legacy", "ruffle-wasm-legacy"],
  );
  assert.deepEqual(searchKeelCreativeRuntimes("flash wasm").map(({ id }) => id), ["flash-ruffle"]);
  assert.deepEqual(searchKeelCreativeRuntimes("inactive legacy").map(({ id }) => id), ["flash-ruffle"]);
  assert.deepEqual(searchKeelCreativeRuntimes("three javascript").map(({ id }) => id), ["three"]);
  assert.deepEqual(searchKeelCreativeRuntimes("external source required").map(({ id }) => id), ["doom-wasm", "flash-ruffle"]);
  assert.throws(() => getKeelCreativeRuntime("missing-runtime"), /unknown creative runtime/u);
});

test("[creative runtime catalog] resource dependency graphs are closed, acyclic, and do not activate legacy fallbacks", () => {
  for (const runtime of listKeelCreativeRuntimes()) {
    const byId = new Map(runtime.resources.map((resource) => [resource.id, resource]));
    assert.equal(byId.size, runtime.resources.length, `${runtime.id} repeats a resource id`);
    for (const resource of runtime.resources) {
      assert.equal(Object.isFrozen(resource.dependencies), true, `${runtime.id}/${resource.id} dependencies are mutable`);
      for (const dependency of resource.dependencies) {
        const found = byId.get(dependency);
        assert.ok(found, `${runtime.id}/${resource.id} depends on missing ${dependency}`);
        if (resource.referenceStatus === "active") {
          assert.equal(found.referenceStatus, "active", `${runtime.id}/${resource.id} activates legacy ${dependency}`);
        }
      }
    }

    const visiting = new Set();
    const visited = new Set();
    const visit = (resource) => {
      if (visited.has(resource.id)) return;
      assert.equal(visiting.has(resource.id), false, `${runtime.id} dependency cycle reaches ${resource.id}`);
      visiting.add(resource.id);
      for (const dependency of resource.dependencies) visit(byId.get(dependency));
      visiting.delete(resource.id);
      visited.add(resource.id);
    };
    for (const resource of runtime.resources) visit(resource);
  }
});

test("[creative runtime catalog] every claimed local resource hashes to its indexed bytes", async () => {
  for (const runtime of listKeelCreativeRuntimes()) {
    for (const resource of runtime.resources) {
      if (resource.localPath === null) {
        assert.equal(resource.integrity, null, `${resource.id} must not claim absent bytes`);
        continue;
      }
      let bytes = new Uint8Array(await readFile(resource.localPath));
      if (resource.localTransform !== undefined) {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        assert.ok(source.includes(resource.localTransform.from), `${resource.id} transform input is missing`);
        bytes = new TextEncoder().encode(source.replaceAll(resource.localTransform.from, resource.localTransform.to));
      }
      const integrity = await createIntegrity(bytes);
      assert.deepEqual(integrity, resource.integrity, `${resource.id} local source drifted`);
    }
  }
});

test("[creative runtime catalog] evidence paths exist but never masquerade as receipt-backed publication", async () => {
  assert.equal(Object.isFrozen(listKeelCreativeRuntimes()), true);
  for (const runtime of listKeelCreativeRuntimes()) {
    assert.equal(Object.isFrozen(runtime), true);
    assert.equal(Object.isFrozen(runtime.resources), true);
    assert.equal(Object.isFrozen(runtime.evidencePaths), true);
    assert.deepEqual(runtime.publication, { status: "not-claimed", receiptBacked: false, carriers: [] });
    assert.equal(Object.isFrozen(runtime.publication), true);
    assert.equal(Object.isFrozen(runtime.publication.carriers), true);
    for (const evidencePath of runtime.evidencePaths) assert.equal((await stat(evidencePath)).isFile(), true, evidencePath);
  }
});
