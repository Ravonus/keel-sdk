import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeMedia,
  buildMediaArtifact,
  runMediaPipeline,
  wrapImage,
  verifyBuiltArtifact,
} from "../packages/builder/dist/index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=",
  "base64",
);
const FAKE_WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const imageProcessor = {
  async metadata() { return { width: 2, height: 2 }; },
  async writeWebp(_input, output) { await writeFile(output, FAKE_WEBP); },
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-pipeline-"));
  const input = path.join(directory, "art.png");
  await writeFile(input, ONE_PIXEL_PNG);
  return { directory, input };
}

test("media analysis is typed, hashed, and reports image wrapper support", async () => {
  const { directory, input } = await fixture();
  try {
    const analysis = await analyzeMedia({ input, imageProcessor });
    assert.equal(analysis.schema, "oca-media-analysis@1");
    assert.equal(analysis.input.mediaType, "image/png");
    assert.equal(analysis.input.kind, "image");
    assert.equal(analysis.input.byteLength, ONE_PIXEL_PNG.byteLength);
    assert.equal(analysis.input.integrity.algorithm, "sha256");
    assert.deepEqual(analysis.image, { width: 2, height: 2 });
    assert.equal(analysis.wrapper.supported, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fixed-time media builds are reproducible and independently verify", async () => {
  const { directory, input } = await fixture();
  try {
    const first = await runMediaPipeline({
      input,
      outputDirectory: path.join(directory, "first"),
      name: "Stable image",
      createdAt: "2026-01-01T00:00:00.000Z",
      imageProcessor,
    });
    const second = await runMediaPipeline({
      input,
      outputDirectory: path.join(directory, "second"),
      name: "Stable image",
      createdAt: "2026-01-01T00:00:00.000Z",
      imageProcessor,
    });
    assert.equal(first.valid, true);
    assert.equal(second.valid, true);
    assert.deepEqual(first.build.determinism, { manifest: "deterministic", encodedPreview: "processor-dependent" });
    assert.equal(first.build.output.manifestIntegrity.digest, second.build.output.manifestIntegrity.digest);
    assert.equal(first.analysis.input.integrity.digest, second.analysis.input.integrity.digest);
    assert.deepEqual(first.verification.resources.map((resource) => resource.status), ["verified", "verified", "verified"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification rejects a tampered resource and a tampered manifest", async () => {
  const { directory, input } = await fixture();
  try {
    const release = path.join(directory, "release");
    await buildMediaArtifact({ input, outputDirectory: release, createdAt: "2026-01-01T00:00:00.000Z", imageProcessor });
    await writeFile(path.join(release, "art.preview.webp"), Buffer.from("tampered"));
    const tamperedResource = await verifyBuiltArtifact({ directory: release });
    assert.equal(tamperedResource.valid, false);
    assert.equal(tamperedResource.resources.find((resource) => resource.resource === "preview")?.status, "failed");

    const manifestPath = path.join(release, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.name = "Changed after build";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const tamperedManifest = await verifyBuiltArtifact({ directory: release });
    assert.equal(tamperedManifest.valid, false);
    assert.equal(tamperedManifest.manifestIntegrity.status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification returns structured failure for a missing manifest and rejects symlink escapes", async () => {
  const { directory, input } = await fixture();
  try {
    const missing = await verifyBuiltArtifact({ directory: path.join(directory, "missing") });
    assert.equal(missing.valid, false);
    assert.equal(missing.manifestIntegrity.status, "unavailable");
    await assert.rejects(
      () => verifyBuiltArtifact({ directory, manifestName: "../manifest.json" }),
      /filename-safe segment/u,
    );

    const release = path.join(directory, "release");
    await buildMediaArtifact({ input, outputDirectory: release, createdAt: "2026-01-01T00:00:00.000Z", imageProcessor });
    const outside = path.join(directory, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(release, "escape.txt"));
    const manifestPath = path.join(release, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.resources[0].sources[0].uri = "./escape.txt";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const escaped = await verifyBuiltArtifact({ directory: release });
    assert.equal(escaped.valid, false);
    assert.match(escaped.resources[0].sources[0].message, /symlink escapes/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-image media is analyzed but cannot use the image builder", async () => {
  const { directory, input } = await fixture();
  try {
    const textInput = path.join(directory, "script.txt");
    await writeFile(textInput, "console.log('not an image');");
    const analysis = await analyzeMedia({ input: textInput });
    assert.equal(analysis.input.kind, "text");
    assert.equal(analysis.wrapper.supported, false);
    await assert.rejects(
      () => buildMediaArtifact({ input: textInput, outputDirectory: path.join(directory, "text-release"), createdAt: "2026-01-01T00:00:00.000Z" }),
      /first builder slice wraps image/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image wrapper rejects an id that could escape the output directory", async () => {
  const { directory, input } = await fixture();
  try {
    await assert.rejects(
      () => wrapImage({ input, outputDirectory: path.join(directory, "release"), id: "../outside", imageProcessor }),
      /filename-safe segment/u,
    );
    await assert.rejects(readFile(path.join(directory, "outside.viewer.html")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the build detects an input changed after analysis", async () => {
  const { directory, input } = await fixture();
  try {
    const mutatingProcessor = {
      ...imageProcessor,
      async writeWebp(source, output) {
        await imageProcessor.writeWebp(source, output);
        await writeFile(source, Buffer.from("changed after analysis"));
      },
    };
    await assert.rejects(
      () => buildMediaArtifact({ input, outputDirectory: path.join(directory, "release"), createdAt: "2026-01-01T00:00:00.000Z", imageProcessor: mutatingProcessor }),
      /Input changed while/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deterministic builds reject timestamps without an explicit timezone", async () => {
  const { directory, input } = await fixture();
  try {
    await assert.rejects(
      () => buildMediaArtifact({ input, outputDirectory: path.join(directory, "release"), createdAt: "2026-01-01T00:00:00", imageProcessor }),
      /canonical UTC ISO timestamp/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
