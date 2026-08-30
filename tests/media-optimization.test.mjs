import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  applyMediaOptimization,
  detectMediaOptimizationCapabilities,
  planMediaOptimization,
  verifyBundledFfmpegExecutable,
} from "../packages/builder/dist/index.js";

const builderRequire = createRequire(new URL("../packages/builder/dist/index.js", import.meta.url));
const bundledFfmpeg = builderRequire("ffmpeg-static");

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

function glb(json) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const padding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const padded = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)]);
  const output = Buffer.alloc(20 + padded.byteLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.byteLength, 8);
  output.writeUInt32LE(padded.byteLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(output, 20);
  return output;
}

async function writeVideoFixture(directory) {
  const input = path.join(directory, "source.mp4");
  execFileSync(
    bundledFfmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=30",
      "-t", "2", "-an", "-c:v", "mpeg4", "-q:v", "1", "-y", input,
    ],
    { stdio: "pipe" },
  );
  return input;
}

test("bundled FFmpeg verification fails closed for missing, outside, and hash-mismatched executables without touching the real binary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-ffmpeg-verifier-"));
  try {
    const packageRoot = path.join(directory, "ffmpeg-static");
    const binary = path.join(packageRoot, "ffmpeg");
    const outside = path.join(directory, "machine-ffmpeg");
    const linkedOutside = path.join(packageRoot, "ffmpeg-link");
    const bytes = Buffer.from("reviewed test executable", "utf8");
    const digest = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    const platform = "testos";
    const architecture = "testarch";
    const expectedDigests = { [`${platform}-${architecture}`]: digest };
    await mkdir(packageRoot);
    await writeFile(binary, bytes);
    await writeFile(outside, bytes);
    await symlink(outside, linkedOutside);

    const verified = await verifyBundledFfmpegExecutable({ packageRoot, configuredPath: binary, platform, architecture, expectedDigests });
    assert.equal(verified.available, true);
    assert.equal(verified.digest, digest);

    const missing = await verifyBundledFfmpegExecutable({ packageRoot, configuredPath: undefined, platform, architecture, expectedDigests });
    assert.equal(missing.available, false);
    assert.match(missing.reason ?? "", /does not provide a bundled binary/u);

    const unsupported = await verifyBundledFfmpegExecutable({ packageRoot, configuredPath: binary, platform: "otheros", architecture, expectedDigests });
    assert.equal(unsupported.available, false);
    assert.match(unsupported.reason ?? "", /No reviewed bundled FFmpeg executable digest/u);

    const outsidePackage = await verifyBundledFfmpegExecutable({ packageRoot, configuredPath: outside, platform, architecture, expectedDigests });
    assert.equal(outsidePackage.available, false);
    assert.match(outsidePackage.reason ?? "", /outside the reviewed package/u);

    const symlinkEscape = await verifyBundledFfmpegExecutable({ packageRoot, configuredPath: linkedOutside, platform, architecture, expectedDigests });
    assert.equal(symlinkEscape.available, false);
    assert.match(symlinkEscape.reason ?? "", /regular bundled FFmpeg executable/u);

    const mismatched = await verifyBundledFfmpegExecutable({
      packageRoot,
      configuredPath: binary,
      platform,
      architecture,
      expectedDigests: { [`${platform}-${architecture}`]: `0x${"00".repeat(32)}` },
    });
    assert.equal(mismatched.available, false);
    assert.match(mismatched.reason ?? "", /hash does not match/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media optimization dry-runs deterministically, preserves storage selection, and reports pinned adapters", async () => {
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

    await writeFile(path.join(directory, "clip.avi"), Buffer.from("not-a-video"));
    const video = await planMediaOptimization({ input: path.join(directory, "clip.avi") });
    assert.equal(video.status, "unavailable");
    assert.match(video.capability.reason ?? "", /Only MP4, WebM, and Matroska/u);

    await writeFile(path.join(directory, "scene.gltf"), Buffer.from('{"buffers":[{"uri":"external.bin"}]}'));
    await assert.rejects(
      () => planMediaOptimization({ input: path.join(directory, "scene.gltf") }),
      /Only self-contained .glb input/u,
    );

    const capabilities = await detectMediaOptimizationCapabilities();
    assert.deepEqual(capabilities.map((capability) => capability.kind), ["image", "video", "model"]);
    assert.deepEqual(capabilities.map((capability) => capability.adapter), ["sharp-webp", "ffmpeg-webm-vp9", "gltf-transform-glb"]);
    assert.equal(capabilities.find((capability) => capability.kind === "model")?.available, true);
    assert.match(capabilities.find((capability) => capability.kind === "model")?.version ?? "", /4\.4\.2/u);
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
    assert.equal(result.output.mediaType, "image/webp");
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
      /measured, smaller dry-run candidate/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundled FFmpeg adapter dry-runs, rechecks its pinned version, and writes only a new WebM path", async () => {
  const { directory } = await fixture();
  try {
    const capability = (await detectMediaOptimizationCapabilities()).find((entry) => entry.kind === "video");
    if (capability?.available !== true) {
      const unavailableInput = path.join(directory, "source.mp4");
      await writeFile(unavailableInput, Buffer.from([0, 0, 0, 0]));
      const unavailable = await planMediaOptimization({ input: unavailableInput, selectedStorageMode: "native-carrier-v1" });
      assert.equal(unavailable.status, "unavailable");
      assert.equal(unavailable.capability.adapter, "ffmpeg-webm-vp9");
      assert.equal(unavailable.capability.available, false);
      assert.match(unavailable.capability.reason ?? "", /bundled binary|not installed/u);
      assert.deepEqual(unavailable.storage, { selectedMode: "native-carrier-v1", changed: false });
      return;
    }
    const input = await writeVideoFixture(directory);
    const before = await readFile(input);
    const first = await planMediaOptimization({ input, selectedStorageMode: "native-carrier-v1", videoCrf: 32, videoCpuUsed: 4 });
    const second = await planMediaOptimization({ input, selectedStorageMode: "native-carrier-v1", videoCrf: 32, videoCpuUsed: 4 });
    assert.deepEqual(first, second);
    assert.equal(first.capability.adapter, "ffmpeg-webm-vp9");
    assert.equal(first.capability.available, true);
    assert.match(first.capability.version ?? "", /^ffmpeg-static@5\.3\.0$/u);
    assert.deepEqual(first.settings, { adapter: "ffmpeg-webm-vp9", crf: 32, cpuUsed: 4 });
    assert.equal(first.output?.mediaType, "video/webm");
    assert.equal(first.output?.extension, ".webm");
    assert.equal(first.measurements.state, "measured-in-memory");
    assert.equal(first.status, "ready-for-explicit-apply");
    assert.equal(first.measurements.smaller, true);
    await assert.rejects(
      () => applyMediaOptimization({ plan: first, output: path.join(directory, "wrong-extension.mp4") }),
      /must use the .webm extension/u,
    );
    const result = await applyMediaOptimization({ plan: first, output: path.join(directory, "optimized.webm") });
    const optimized = await readFile(result.output.path);
    assert.deepEqual(await readFile(input), before);
    assert.deepEqual([...optimized.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.equal(result.output.integrity.digest, first.output?.integrity.digest);

    const staleVersion = { ...first, capability: { ...first.capability, version: "ffmpeg-static@other" } };
    await assert.rejects(
      () => applyMediaOptimization({ plan: staleVersion, output: path.join(directory, "stale.webm") }),
      /adapter version, settings, or candidate/u,
    );
    const staleSettings = { ...first, settings: { ...first.settings, crf: 33 } };
    await assert.rejects(
      () => applyMediaOptimization({ plan: staleSettings, output: path.join(directory, "changed-settings.webm") }),
      /adapter version, settings, or candidate/u,
    );
    await writeFile(input, Buffer.concat([before, Buffer.from([0])]));
    await assert.rejects(
      () => applyMediaOptimization({ plan: first, output: path.join(directory, "changed-source.webm") }),
      /input no longer matches the reviewed optimization plan/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the self-contained GLB adapter prunes in memory and rejects URI-bearing GLB or .gltf inputs", async () => {
  const { directory } = await fixture();
  try {
    const input = path.join(directory, "scene.glb");
    await writeFile(input, glb({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: Array.from({ length: 128 }, () => ({})) }));
    const before = await readFile(input);
    const first = await planMediaOptimization({ input, selectedStorageMode: "inline" });
    const second = await planMediaOptimization({ input, selectedStorageMode: "inline" });
    assert.deepEqual(first, second);
    assert.equal(first.capability.adapter, "gltf-transform-glb");
    assert.equal(first.capability.available, true);
    assert.deepEqual(first.settings, { adapter: "gltf-transform-glb", transforms: ["dedup", "prune"] });
    assert.equal(first.output?.mediaType, "model/gltf-binary");
    assert.equal(first.output?.extension, ".glb");
    assert.equal(first.status, "ready-for-explicit-apply");
    assert.equal(first.measurements.smaller, true);
    const result = await applyMediaOptimization({ plan: first, output: path.join(directory, "optimized.glb") });
    assert.equal(result.output.mediaType, "model/gltf-binary");
    assert.deepEqual(await readFile(input), before);
    assert.equal((await readFile(result.output.path)).readUInt32LE(0), 0x46546c67);

    const externalGlb = path.join(directory, "external.glb");
    await writeFile(externalGlb, glb({ asset: { version: "2.0" }, buffers: [{ uri: "external.bin", byteLength: 4 }] }));
    await assert.rejects(() => planMediaOptimization({ input: externalGlb }), /external or data-URI resources/u);

    const externalJson = path.join(directory, "external.gltf");
    await writeFile(externalJson, '{"asset":{"version":"2.0"},"images":[{"uri":"poster.png"}]}');
    await assert.rejects(() => planMediaOptimization({ input: externalJson }), /Only self-contained .glb input/u);
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
