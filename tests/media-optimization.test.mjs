import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyMediaOptimization,
  detectMediaOptimizationCapabilities,
  planMediaOptimization,
} from "../packages/builder/dist/index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-media-opt-"));
  const input = path.join(directory, "source.png");
  await writeFile(input, ONE_PIXEL_PNG);
  return { directory, input };
}

test("media optimization dry-runs deterministically, preserves storage selection, and reports unsupported adapters", async () => {
  const { directory, input } = await fixture();
  try {
    const first = await planMediaOptimization({ input, selectedStorageMode: "inline", quality: 82, effort: 6 });
    const second = await planMediaOptimization({ input, selectedStorageMode: "inline", quality: 82, effort: 6 });
    assert.deepEqual(first, second);
    assert.equal(first.schema, "keel-media-optimization-plan@1");
    assert.equal(first.mode, "dry-run");
    assert.equal(first.measurements.beforeBytes, ONE_PIXEL_PNG.byteLength);
    if (first.capability.available) {
      assert.equal(first.measurements.state, "measured-in-memory");
      assert.equal(typeof first.measurements.afterBytes, "number");
      assert.equal(typeof first.measurements.percentSaved, "number");
      assert.equal(first.output?.integrity.byteLength, first.measurements.afterBytes);
    } else {
      assert.equal(first.measurements.afterBytes, null);
      assert.equal(first.measurements.percentSaved, null);
    }
    assert.equal(first.sourceRetention.sourceRemoved, false);
    assert.deepEqual(first.storage, { selectedMode: "inline", changed: false });

    await writeFile(path.join(directory, "clip.webm"), Buffer.from("not-a-video"));
    const video = await planMediaOptimization({ input: path.join(directory, "clip.webm") });
    assert.equal(video.status, "unavailable");
    assert.match(video.capability.reason ?? "", /does not pin a video transcoder/u);

    await writeFile(path.join(directory, "scene.gltf"), Buffer.from("{}"));
    const model = await planMediaOptimization({ input: path.join(directory, "scene.gltf") });
    assert.equal(model.status, "unavailable");
    assert.match(model.capability.reason ?? "", /does not pin a glTF transform/u);

    const capabilities = await detectMediaOptimizationCapabilities();
    assert.deepEqual(capabilities.map((capability) => capability.kind), ["image", "video", "model"]);
    assert.equal(capabilities.find((capability) => capability.kind === "video")?.available, false);
    assert.equal(capabilities.find((capability) => capability.kind === "model")?.available, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the supported image adapter measures bytes, keeps the source, and only writes an explicit new output", async () => {
  const { directory, input } = await fixture();
  try {
    const plan = await planMediaOptimization({ input, selectedStorageMode: "native-carrier-v1" });
    if (!plan.capability.available) {
      assert.equal(plan.status, "unavailable");
      return;
    }
    assert.equal(plan.status, "ready-for-explicit-apply");
    assert.equal(plan.measurements.smaller, true);
    const before = await readFile(input);
    const output = path.join(directory, "optimized.webp");
    const result = await applyMediaOptimization({ plan, output });
    const after = await readFile(output);
    assert.equal(result.status, "completed");
    assert.equal(result.measurements.beforeBytes, before.byteLength);
    assert.equal(result.measurements.afterBytes, after.byteLength);
    assert.equal(result.measurements.savedBytes, before.byteLength - after.byteLength);
    assert.equal(result.measurements.percentSaved, plan.measurements.percentSaved);
    assert.deepEqual(await readFile(input), before);
    assert.deepEqual(result.sourceRetention.sourceIntegrity, plan.input.integrity);
    assert.deepEqual(result.storage, { selectedMode: "native-carrier-v1", changed: false });
    await assert.rejects(() => applyMediaOptimization({ plan, output }), /output already exists/u);

    const nonSavingPlan = await planMediaOptimization({ input: output, quality: 100, effort: 6 });
    assert.equal(nonSavingPlan.status, "candidate-not-smaller");
    assert.equal(nonSavingPlan.measurements.state, "measured-in-memory");
    assert.equal(nonSavingPlan.measurements.smaller, false);
    assert.ok((nonSavingPlan.measurements.afterBytes ?? 0) >= nonSavingPlan.measurements.beforeBytes);
    await assert.rejects(
      () => applyMediaOptimization({ plan: nonSavingPlan, output: path.join(directory, "larger.webp") }),
      /measured, smaller dry-run image candidate/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI emits dry-run JSON and YAML before it permits a local output", async () => {
  const { directory, input } = await fixture();
  try {
    const cli = path.resolve("packages/builder/dist/cli.js");
    const json = execFileSync(process.execPath, [cli, "optimize", input, "--json"], { encoding: "utf8" });
    const plan = JSON.parse(json);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.measurements.state, plan.capability.available ? "measured-in-memory" : "unavailable");
    const yaml = execFileSync(process.execPath, [cli, "optimize", input, "--yaml"], { encoding: "utf8" });
    assert.match(yaml, /"mode": "dry-run"/u);
    assert.match(yaml, plan.capability.available ? /"state": "measured-in-memory"/u : /"afterBytes": null/u);
    if (plan.capability.available) {
      const output = path.join(directory, "cli-optimized.webp");
      const applied = JSON.parse(execFileSync(process.execPath, [cli, "optimize", input, "--apply", "--out", output, "--json"], { encoding: "utf8" }));
      assert.equal(applied.mode, "explicit-apply");
      assert.equal(applied.sourceRetention.sourceRemoved, false);
      assert.equal((await readFile(output)).byteLength, applied.measurements.afterBytes);
    }
    assert.throws(
      () => execFileSync(process.execPath, [cli, "optimize", input, "--out", path.join(directory, "forbidden.webp")], { encoding: "utf8", stdio: "pipe" }),
      /only accepts --out together with explicit --apply/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
