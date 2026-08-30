import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeKeelDataPack,
  encodeKeelDataPack,
  orderKeelModules,
} from "../packages/sdk/dist/index.js";
import {
  buildKeelInlineLocalDocument,
  buildKeelInlineModuleFragment,
  buildKeelInlineShellFragments,
} from "../packages/sdk/dist/inline-viewer-graph.js";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const utf8 = (value) => new TextEncoder().encode(value);

test("canonical gzip-CBOR round trips JSON/YAML-compatible data deterministically", () => {
  const value = {
    collection: "Luna Seed Test",
    supply: 9999,
    traits: Array.from({ length: 64 }, (_, index) => ({ layer: index % 7, value: `trait-${index % 11}` })),
  };
  const first = encodeKeelDataPack(value);
  const second = encodeKeelDataPack({ supply: 9999, traits: value.traits, collection: "Luna Seed Test" });
  assert.deepEqual(first, second);
  assert.deepEqual(decodeKeelDataPack(first), value);
  assert.ok(first.byteLength < Buffer.byteLength(JSON.stringify(value)));
  assert.equal(Buffer.from(first.subarray(0, 5)).toString("hex"), "4b44503101");
});

test("data modules are forced above runtime and render regardless of input order", () => {
  const ordered = orderKeelModules([
    { moduleId: "render", phase: "render", weight: -100 },
    { moduleId: "runtime", phase: "runtime", weight: 0 },
    { moduleId: "seed", phase: "data", weight: 20 },
    { moduleId: "contract", phase: "data", weight: 10 },
  ]);
  assert.deepEqual(ordered.map(({ moduleId }) => moduleId), ["contract", "seed", "runtime", "render"]);
});

test("seed data script is injected before creator render code", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  const seed = await buildKeelInlineModuleFragment({
    moduleId: "keel.seed-data",
    version: "1.0.0",
    mediaType: "text/javascript",
    aliases: ["keel-seed-data.js"],
    decodedBytes: utf8("globalThis.SEED_MODULE_RAN=globalThis.KEEL_SEED"),
    execution: "classic",
    phase: "data",
  });
  const render = await buildKeelInlineModuleFragment({
    moduleId: "luna.render",
    version: "1.0.0",
    mediaType: "text/javascript",
    decodedBytes: utf8("globalThis.RENDER_MODULE_RAN=true"),
    execution: "classic",
    phase: "render",
  });
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [render, seed],
    entry: { id: "luna.html", mediaType: "text/html", source: utf8("<main><script>globalThis.ENTRY_RAN=true</script></main>") },
  });
  assert.deepEqual(local.parts.map((part) => part.moduleId ?? part.role), ["shell-prefix", "keel.seed-data", "luna.render", "entrypoint", "shell-suffix"]);
  assert.equal(seed.phase, "data");
  await assert.rejects(() => buildKeelInlineModuleFragment({
    moduleId: "bad-data",
    version: "1",
    mediaType: "text/javascript",
    decodedBytes: utf8("export default 1"),
    execution: "module",
    phase: "data",
  }), /classic execution/u);
});
