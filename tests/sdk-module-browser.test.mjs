import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_ROOT = path.join(ROOT, "packages", "sdk");
const requireFromSdk = createRequire(path.join(SDK_ROOT, "package.json"));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(resolved) : [resolved];
  }))).flat();
}

test("@keel/sdk/module bundles for a browser without Node or verification implementation code", { timeout: 30_000 }, async () => {
  const { build } = await import(requireFromSdk.resolve("esbuild"));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-module-browser-"));
  try {
    const linkedSdk = path.join(fixture, "node_modules", "@keel", "sdk");
    await mkdir(path.dirname(linkedSdk), { recursive: true });
    await symlink(SDK_ROOT, linkedSdk, "dir");
    await writeFile(path.join(fixture, "entry.js"), [
      'import { browserModule, defineModule, moduleApi, solidityCapability } from "@keel/sdk/module";',
      'const harness = solidityCapability("keel-harness", { as: "harness", api: moduleApi() });',
      'const story = browserModule("story-triggers", { as: "story", api: moduleApi() });',
      'globalThis.declaration = defineModule("Browser", { target: "@keel/eth/sepolia", extends: [harness, story] });',
    ].join("\n"));

    const outputDirectory = path.join(fixture, "out");
    const result = await build({
      entryPoints: [path.join(fixture, "entry.js")],
      bundle: true,
      platform: "browser",
      format: "esm",
      outdir: outputDirectory,
      logLevel: "silent",
      metafile: true,
    });
    assert.deepEqual(result.warnings, []);
    const emitted = await Promise.all((await filesUnder(outputDirectory)).map((file) => readFile(file, "utf8")));
    const source = emitted.join("\n");
    assert.doesNotMatch(source, /node:|child_process|worker_threads|verification-shell|onchaininator/iu);
    assert.ok(Object.keys(result.metafile.inputs).some((input) => /modules\.generated\.js$/u.test(input)));
    assert.ok(Object.keys(result.metafile.inputs).every((input) => !/verification-shell|onchaininator/iu.test(input)));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
