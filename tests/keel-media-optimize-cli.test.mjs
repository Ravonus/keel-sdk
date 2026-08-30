import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = new URL("../tools/keel/cli.mjs", import.meta.url);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=",
  "base64",
);

async function run(args) {
  const result = await execFileAsync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });
  return JSON.parse(result.stdout);
}

test("media-optimize CLI plans and explicitly applies reviewed JSON and YAML configurations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-media-opt-cli-"));
  try {
    await writeFile(path.join(directory, "source.png"), ONE_PIXEL_PNG);
    const planConfig = path.join(directory, "plan.json");
    await writeFile(planConfig, JSON.stringify({ operation: "plan", input: "source.png", selectedStorageMode: "hybrid" }));
    const plan = await run(["media-optimize", "--config", planConfig]);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.status, "ready-for-explicit-apply");
    assert.deepEqual(plan.storage, { selectedMode: "hybrid", changed: false });

    const applyConfig = path.join(directory, "apply.yaml");
    await writeFile(applyConfig, [
      "operation: apply-reviewed",
      "input: source.png",
      "output: optimized.webp",
      `expectedOutputDigest: "${plan.output.integrity.digest}"`,
      `expectedAfterBytes: ${plan.measurements.afterBytes}`,
      "selectedStorageMode: hybrid",
      "",
    ].join("\n"));
    const applied = await run(["media-optimize", "--config", applyConfig]);
    assert.equal(applied.mode, "explicit-apply");
    assert.equal(applied.output.integrity.digest, plan.output.integrity.digest);
    assert.equal(applied.measurements.afterBytes, plan.measurements.afterBytes);
    assert.deepEqual(applied.storage, { selectedMode: "hybrid", changed: false });
    assert.deepEqual(await readFile(path.join(directory, "source.png")), ONE_PIXEL_PNG);

    await assert.rejects(
      () => run(["media-optimize", "--config", applyConfig]),
      /output already exists/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
