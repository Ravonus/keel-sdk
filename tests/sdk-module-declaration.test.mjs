import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_ROOT = path.join(ROOT, "packages", "sdk");
const MODULE_DIST = path.join(SDK_ROOT, "dist", "module", "index.js");

test("imported descriptors derive the Solidity and browser manifest lanes", async () => {
  const {
    Asset,
    browserModule,
    defineModule,
    moduleApi,
    solidityCapability,
  } = await import(pathToFileURL(MODULE_DIST).href);

  const harness = solidityCapability("keel-harness", {
    as: "verificationHarness",
    api: moduleApi(),
  });
  const story = browserModule("story-triggers", {
    as: "story",
    api: moduleApi(),
  });
  const declaration = defineModule("Typed story", {
    kind: "app",
    target: "@keel/eth/sepolia",
    extends: [harness, story],
    assets: { cover: Asset.image("Cover", "Shown in the project browser") },
    init({ verificationHarness, story: storyApi }) {
      void verificationHarness;
      void storyApi;
    },
  });

  assert.deepEqual(declaration.manifest.use, ["keel-harness"]);
  assert.deepEqual(declaration.manifest.modules, ["story-triggers"]);
  assert.equal(declaration.manifest.assets.cover.name, "Cover");
  assert.deepEqual(declaration.manifest.verification, { shell: true });
  assert.equal(typeof declaration.init, "function");
  assert.equal("verified" in story, false, "an authored descriptor must not claim verification");
});

test("bad descriptors, duplicate ids, lane mismatches, and unknown capabilities fail closed", async () => {
  const { browserModule, defineModule, moduleApi, solidityCapability } = await import(pathToFileURL(MODULE_DIST).href);
  const target = "@keel/eth/sepolia";
  const harness = solidityCapability("keel-harness", { as: "harness", api: moduleApi() });
  const harnessAgain = solidityCapability("keel-harness", { as: "otherHarness", api: moduleApi() });
  assert.equal(Object.isFrozen(harness), true);
  assert.equal(Object.isFrozen(harness.api), true);
  assert.throws(() => { harness.key = "mutated"; }, TypeError);
  assert.throws(() => { harness.api.kind = "mutated"; }, TypeError);

  assert.throws(
    () => defineModule("Duplicate", { target, extends: [harness, harnessAgain] }),
    /extends keel-harness twice/u,
  );
  assert.throws(
    () => solidityCapability("not-a-keel-capability", { as: "bad", api: moduleApi() }),
    /unknown Keel Solidity capability/u,
  );
  assert.throws(
    () => browserModule("keel-harness", { as: "badLane", api: moduleApi() }),
    /Solidity capability/u,
  );
  assert.throws(
    () => defineModule("Forged", { target, extends: [{ schema: "keel-module-descriptor@1" }] }),
    /invalid Keel module descriptor/u,
  );
  const exactForgedApi = Object.freeze({ kind: "keel-module-api-shape" });
  assert.throws(
    () => solidityCapability("keel-harness", { as: "forgedApi", api: exactForgedApi }),
    /module api must be created with moduleApi/u,
  );
  const exactForgedDescriptor = Object.freeze({
    schema: "keel-module-descriptor@1",
    id: "keel-harness",
    lane: "solidity",
    key: "harness",
    api: moduleApi(),
  });
  assert.throws(
    () => defineModule("Exact forged descriptor", { target, extends: [exactForgedDescriptor] }),
    /invalid Keel module descriptor/u,
  );
  const forgedLane = {
    schema: "keel-module-descriptor@1",
    id: "keel-harness",
    lane: "browser",
    key: "harness",
    api: moduleApi(),
  };
  assert.throws(
    () => defineModule("Wrong lane", { target, extends: [forgedLane] }),
    /invalid Keel module descriptor/u,
  );

  assert.throws(
    () => defineModule("Forged proof", { target, extends: [{ ...harness, verified: true }] }),
    /invalid Keel module descriptor/u,
  );
  assert.throws(
    () => defineModule("Symbol descriptor", { target, extends: [{ ...harness, [Symbol("claim")]: true }] }),
    /invalid Keel module descriptor/u,
  );
  assert.throws(
    () => defineModule("Extra API marker", {
      target,
      extends: [{ ...harness, api: { kind: "keel-module-api-shape", verified: true } }],
    }),
    /invalid Keel module descriptor/u,
  );
  let getterCalls = 0;
  const accessorDescriptor = { ...harness };
  Object.defineProperty(accessorDescriptor, "id", { enumerable: true, get() { getterCalls += 1; return "keel-harness"; } });
  assert.throws(
    () => defineModule("Accessor descriptor", { target, extends: [accessorDescriptor] }),
    /invalid Keel module descriptor/u,
  );
  assert.equal(getterCalls, 0, "descriptor validation must not invoke getters");

  const accessorApi = {};
  Object.defineProperty(accessorApi, "kind", {
    enumerable: true,
    get() { getterCalls += 1; return "keel-module-api-shape"; },
  });
  assert.throws(
    () => defineModule("Accessor API marker", { target, extends: [{ ...harness, api: accessorApi }] }),
    /invalid Keel module descriptor/u,
  );
  assert.equal(getterCalls, 0, "API marker validation must not invoke getters");
});

test("verification policy has an exact own-data shape", async () => {
  const { defineModule } = await import(pathToFileURL(MODULE_DIST).href);
  const base = { target: "@keel/eth/sepolia", extends: [] };

  for (const verification of [
    { shell: true, reason: "extra" },
    { shell: false },
    { shell: false, reason: "" },
    { shell: false, reason: "needed", verified: true },
    { shell: "yes" },
    { shell: true, [Symbol("proof")]: true },
  ]) {
    assert.throws(() => defineModule("Bad verification", { ...base, verification }), /verification must/u);
  }

  let getterCalls = 0;
  const accessorVerification = {};
  Object.defineProperty(accessorVerification, "shell", { enumerable: true, get() { getterCalls += 1; return true; } });
  assert.throws(
    () => defineModule("Accessor verification", { ...base, verification: accessorVerification }),
    /verification must/u,
  );
  assert.equal(getterCalls, 0, "verification validation must not invoke getters");
  assert.deepEqual(
    defineModule("No shell", { ...base, verification: { shell: false, reason: "custom verifier" } }).manifest.verification,
    { shell: false, reason: "custom verifier" },
  );
});

test("assets and extends are deeply snapshotted and frozen", async () => {
  const { defineModule, moduleApi, solidityCapability } = await import(pathToFileURL(MODULE_DIST).href);
  const harness = solidityCapability("keel-harness", { as: "harness", api: moduleApi() });
  const extensions = [harness];
  const cover = { kind: "image", name: "Original", description: "Stable" };
  const assets = { cover };
  const declaration = defineModule("Snapshots", {
    target: "@keel/eth/sepolia",
    extends: extensions,
    assets,
  });

  extensions.length = 0;
  cover.name = "Mutated";
  assets.extra = { kind: "bytes", name: "Late", description: "" };
  assert.equal(declaration.extends.length, 1);
  assert.equal(declaration.manifest.assets.cover.name, "Original");
  assert.equal("extra" in declaration.manifest.assets, false);
  assert.equal(Object.isFrozen(declaration.extends), true);
  assert.equal(Object.isFrozen(declaration.manifest.assets), true);
  assert.equal(Object.isFrozen(declaration.manifest.assets.cover), true);

  let getterCalls = 0;
  const accessorAsset = {};
  Object.defineProperty(accessorAsset, "kind", { enumerable: true, get() { getterCalls += 1; return "image"; } });
  Object.defineProperties(accessorAsset, {
    name: { enumerable: true, value: "Bad" },
    description: { enumerable: true, value: "" },
  });
  assert.throws(
    () => defineModule("Accessor asset", { target: "@keel/eth/sepolia", extends: [], assets: { bad: accessorAsset } }),
    /asset .* exactly/u,
  );
  assert.equal(getterCalls, 0, "asset validation must not invoke getters");

  const accessorAssets = {};
  Object.defineProperty(accessorAssets, "bad", {
    enumerable: true,
    get() { getterCalls += 1; return cover; },
  });
  assert.throws(
    () => defineModule("Accessor asset record", { target: "@keel/eth/sepolia", extends: [], assets: accessorAssets }),
    /assets must be an own-data record/u,
  );
  assert.equal(getterCalls, 0, "asset-record validation must not invoke getters");
});

test("npm is exact own data and the manifest is immutable plain JSON", async () => {
  const { Asset, defineModule, moduleApi, solidityCapability } = await import(pathToFileURL(MODULE_DIST).href);
  const harness = solidityCapability("keel-harness", { as: "harness", api: moduleApi() });
  const npm = { three: "0.180.0", "@keel/runtime": "1.2.3-beta.1+build.7" };
  const declaration = defineModule("Pure manifest", {
    kind: "app",
    target: "@keel/eth/sepolia/browser",
    extends: [harness],
    assets: { cover: Asset.image("Cover", "Stable") },
    npm,
    verification: { shell: false, reason: "external verifier" },
  });

  npm.three = "9.9.9";
  npm.late = "1.0.0";
  assert.deepEqual(declaration.manifest.npm, {
    three: "0.180.0",
    "@keel/runtime": "1.2.3-beta.1+build.7",
  });
  assert.equal(Object.isFrozen(declaration.manifest), true);
  assert.equal(Object.isFrozen(declaration.manifest.npm), true);
  assert.deepEqual(JSON.parse(JSON.stringify(declaration.manifest)), declaration.manifest);

  const base = { target: "@keel/eth/sepolia", extends: [] };
  for (const npmValue of [
    { three: 1n },
    { three: {} },
    { three: () => "1.0.0" },
    { three: "^1.2.3" },
    { three: "workspace:*" },
    { three: "file:../three" },
    { three: "link:../three" },
    { three: "latest" },
    { three: "*" },
    { "": "1.0.0" },
    { "Bad Package": "1.0.0" },
  ]) {
    assert.throws(
      () => defineModule("Bad npm", { ...base, npm: npmValue }),
      /npm (?:package name|version)/u,
    );
  }

  let getterCalls = 0;
  const accessorNpm = {};
  Object.defineProperty(accessorNpm, "three", {
    enumerable: true,
    get() { getterCalls += 1; return "1.0.0"; },
  });
  assert.throws(
    () => defineModule("Accessor npm", { ...base, npm: accessorNpm }),
    /npm must be an own-data record/u,
  );
  assert.equal(getterCalls, 0, "npm validation must not invoke getters");
  assert.throws(
    () => defineModule("Symbol npm", { ...base, npm: { three: "1.0.0", [Symbol("claim")]: "1.0.0" } }),
    /npm must be an own-data record/u,
  );
});

test("TypeScript infers init APIs from imported descriptor values", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-module-types-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(fixture, "modules.ts"), [
      'import { browserModule, createExternalModuleIndex, customExternalBrowserModule, moduleApi, rawBrowserModule, solidityCapability } from "@keel/sdk/module";',
      "export interface HarnessApi { writeTrigger(name: string, value: bigint): Promise<void>; readOutput(name: string): Promise<unknown>; }",
      "export interface StoryApi { advance(trigger: string): void; readonly chapter: number; }",
      'export const verificationHarness = solidityCapability("keel-harness", { as: "harness", api: moduleApi<HarnessApi>() });',
      'export const storyTriggers = browserModule("story-triggers", { as: "story", api: moduleApi<StoryApi>() });',
      'declare const externalIndex: ReturnType<typeof createExternalModuleIndex>;',
      'export const customTools = customExternalBrowserModule(externalIndex, "artist-tools", "1.2.3", { as: "tools", api: moduleApi<{ readonly palette: string }>() });',
      'export const rawTheme = rawBrowserModule(externalIndex, "install-theme", "1.2.3", { as: "theme" });',
    ].join("\n"));
    await writeFile(path.join(fixture, "entry.ts"), [
      'import { defineModule } from "@keel/sdk/module";',
      'import { customTools, rawTheme, storyTriggers, verificationHarness } from "./modules.js";',
      'export default defineModule("IDE typed", {',
      '  target: "@keel/eth/sepolia",',
      '  extends: [verificationHarness, storyTriggers, customTools.descriptor, rawTheme.descriptor],',
      '  async init({ harness, story, tools, theme }) {',
      '    await harness.writeTrigger("door", 1n);',
      '    const output: unknown = await harness.readOutput("door");',
      '    story.advance(String(output));',
      '    const chapter: number = story.chapter;',
      '    const palette: string = tools.palette;',
      '    void chapter;',
      '    void palette;',
      '    // @ts-expect-error Raw modules intentionally expose unknown, not a made-up API.',
      '    theme.install();',
      '    // @ts-expect-error An undeclared API must not appear in IDE types.',
      '    harness.nonexistent();',
      '  },',
      '});',
    ].join("\n"));
    await writeFile(path.join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["*.ts"],
    }));

    const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
    const result = spawnSync(tsc, ["-p", path.join(fixture, "tsconfig.json")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const manifest = JSON.parse(await readFile(path.join(SDK_ROOT, "package.json"), "utf8"));
    assert.deepEqual(manifest.exports["./module"], {
      types: "./dist/module/index.d.ts",
      import: "./dist/module/index.js",
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
