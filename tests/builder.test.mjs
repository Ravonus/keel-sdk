import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { concatBytes, manifestIntegrity, verifyIntegrity } from "../packages/protocol/dist/index.js";
import { createRecursiveUploadPlan, createUploadPlan, decompressBytes, wrapImage } from "../packages/builder/dist/index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=",
  "base64",
);
const FAKE_WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const imageProcessor = {
  async metadata() { return { width: 2, height: 2 }; },
  async writeWebp(_input, output) { await writeFile(output, FAKE_WEBP); },
};

test("upload planner emits byte-bounded chunks that reconstruct exactly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-plan-"));
  try {
    const source = new TextEncoder().encode("browser-native-artifact\n".repeat(5000));
    const plan = await createUploadPlan(source, {
      objectName: "artifact.txt",
      mediaType: "text/plain",
      outputDirectory: directory,
      compression: "auto",
      maxChunkBytes: 1024,
    });
    assert.ok(plan.chunks.length > 0);
    assert.ok(plan.chunks.every((chunk) => chunk.byteLength <= 1024));
    const stored = concatBytes(
      await Promise.all(plan.chunks.map(async (chunk) => new Uint8Array(await readFile(path.join(directory, chunk.file))))),
    );
    const decoded = await decompressBytes(plan.compression, stored);
    assert.equal(decoded.byteLength, source.byteLength);
    assert.equal(await verifyIntegrity(decoded, plan.integrity), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recursive planner creates a balanced bounded-fanout tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-tree-"));
  try {
    const source = new TextEncoder().encode("0123456789abcdef".repeat(5000));
    const plan = await createRecursiveUploadPlan(source, {
      objectName: "large.txt",
      mediaType: "text/plain",
      outputDirectory: directory,
      compression: "auto",
      maxChunkBytes: 700,
      leafDecodedBytes: 4096,
      maxPartsPerComposite: 4,
    });
    const leaves = plan.objects.filter((object) => object.kind === "leaf");
    const composites = plan.objects.filter((object) => object.kind === "composite");
    assert.ok(leaves.length > 1);
    assert.ok(composites.length > 0);
    assert.equal(plan.objects.some((object) => object.id === plan.root), true);
    assert.ok(leaves.every((leaf) => leaf.chunks.length <= 128));
    assert.ok(composites.every((object) => object.parts.length <= 4));
    for (const leaf of leaves) {
      const stored = concatBytes(
        await Promise.all(leaf.chunks.map(async (chunk) => new Uint8Array(await readFile(path.join(directory, chunk.file))))),
      );
      const decoded = await decompressBytes(leaf.compression, stored);
      assert.equal(decoded.byteLength, leaf.byteLength);
      assert.equal(await verifyIntegrity(decoded, leaf.integrity), true);
    }
    assert.equal(await verifyIntegrity(source, plan.integrity), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recursive planner refuses fanout above the immutable index limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-tree-limit-"));
  try {
    await assert.rejects(
      () => createRecursiveUploadPlan(new Uint8Array(1000), {
        objectName: "bad.bin",
        mediaType: "application/octet-stream",
        outputDirectory: directory,
        maxPartsPerComposite: 129,
      }),
      /128/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image wrapper emits a deterministic v2 verified-only manifest and can omit the original", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-wrap-"));
  try {
    const input = path.join(directory, "art.png");
    const outputDirectory = path.join(directory, "release");
    await writeFile(input, ONE_PIXEL_PNG);
    const output = await wrapImage({
      input,
      outputDirectory,
      name: 'A <safe> "name"',
      preserveOriginal: false,
      imageProcessor,
    });
    assert.equal(output.originalPath, undefined);
    assert.equal(output.manifest.schema, "oca-manifest@2");
    assert.equal(output.manifest.canonicalization, "RFC8785");
    assert.equal(output.manifest.runtime.content.mode, "verified-only");
    assert.equal(output.manifest.runtime.determinism.mode, "replay");
    assert.equal(output.manifest.resources.some((resource) => resource.id === "original"), false);
    assert.equal(output.manifest.downloads, undefined);
    assert.ok(output.manifest.resources.every((resource) => resource.sources[0].kind === "uri"));
    const wrapper = await readFile(output.wrapperPath, "utf8");
    assert.equal(wrapper.includes("oca://original"), false);
    assert.ok(wrapper.includes("&lt;safe&gt;"));
    const expected = await manifestIntegrity(output.manifest);
    assert.equal(output.manifestIntegrity.digest, expected.digest);
    assert.ok((await readFile(output.manifestIntegrityPath, "utf8")).includes(expected.digest));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image wrapper validates WebP quality before loading an image backend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oca-wrap-quality-"));
  try {
    const input = path.join(directory, "art.png");
    await writeFile(input, ONE_PIXEL_PNG);
    await assert.rejects(
      () => wrapImage({ input, outputDirectory: path.join(directory, "release"), webpQuality: 101 }),
      /webpQuality/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
