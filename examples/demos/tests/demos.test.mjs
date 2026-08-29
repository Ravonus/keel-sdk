import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createIntegrity,
  packUint48Ids,
  parseArtifactManifest,
  unpackUint48Ids,
  verifyIntegrity,
} from "../../../packages/protocol/dist/index.js";
import { chooseSmallestCompression, compressBytes, decompressBytes } from "../../../packages/builder/dist/index.js";
import {
  createSandboxDocument,
  createVerifiedContentGateway,
  resolveArtifact,
} from "../../../packages/viewer/dist/index.js";
import { DEMOS, demosDirectory, readDemoResources, resourcePath } from "../demos.mjs";
import { buildDemoManifest } from "../build.mjs";

const built = new Map();

async function demoArtifact(demo) {
  if (!built.has(demo.id)) built.set(demo.id, await buildDemoManifest(demo));
  return built.get(demo.id);
}

// Node has no DecompressionStream for brotli, so the resolver takes the
// adapter the builder already provides. Browsers supply gzip/deflate natively
// and Studio injects the same adapter for brotli.
const adapters = { decompress: (compression, bytes) => decompressBytes(compression, bytes) };

function resolveDemo(manifest) {
  return resolveArtifact(manifest, { adapters });
}

// --- Per-demo manifest and resolution --------------------------------------

for (const demo of DEMOS) {
  test(`${demo.name}: marketplace fallback is the committed preview`, async () => {
    const { manifest } = await demoArtifact(demo);
    const expectedPoster = demo.resources.find((resource) => resource.role === "preview")?.id
      ?? demo.resources.find((resource) => resource.mediaType.startsWith("image/"))?.id
      ?? demo.entrypointResourceId;
    assert.equal(manifest.fallback.image, expectedPoster);
    assert.ok(manifest.resources.some((resource) => resource.id === expectedPoster));
  });

  test(`${demo.name}: every declared resource resolves and verifies`, async () => {
    const { manifest } = await demoArtifact(demo);
    const artifact = await resolveDemo(manifest);

    assert.equal(artifact.resources.size, demo.resources.length);
    assert.equal(artifact.audit.resolvedResources, demo.resources.length);
    assert.ok(
      artifact.audit.entries.every((entry) => entry.status === "loaded"),
      "every resource should load on its first declared source",
    );
    assert.ok(
      artifact.audit.entries.every((entry) => entry.integrityVerified === true),
      "every resource must be integrity verified",
    );
  });

  test(`${demo.name}: resolved bytes match the files on disk`, async () => {
    const { manifest } = await demoArtifact(demo);
    const artifact = await resolveDemo(manifest);

    for (const resource of await readDemoResources(demo)) {
      const resolved = artifact.resources.get(resource.id);
      assert.ok(resolved !== undefined, `${resource.id} should resolve`);
      assert.deepEqual(
        Array.from(resolved.bytes),
        Array.from(resource.bytes),
        `${resource.id} bytes must survive compression and decoding unchanged`,
      );
    }
  });

  test(`${demo.name}: the gateway serves declared routes and refuses everything else`, async () => {
    const { manifest } = await demoArtifact(demo);
    const gateway = createVerifiedContentGateway(await resolveDemo(manifest));

    for (const resource of demo.resources) {
      const response = gateway.resolve(`/content/${resource.id}`);
      assert.equal(response.status, 200, `/content/${resource.id} should be served`);
      assert.equal(response.resourceId, resource.id);
    }

    assert.equal(gateway.resolve("/content/not-declared").status, 404);
    assert.equal(gateway.resolve("https://cdn.jsdelivr.net/npm/three").status, 403);
    assert.equal(gateway.resolve("https://unpkg.com/p5").status, 403);
  });

  test(`${demo.name}: the sandbox mounts with no raw creator egress`, async () => {
    const { manifest } = await demoArtifact(demo);
    const document = createSandboxDocument(await resolveDemo(manifest));

    assert.match(document.html, /^<!doctype html>/iu);
    assert.ok(document.csp.includes("default-src 'none'"), "CSP must deny by default");
    assert.ok(!/https:\/\/unpkg\.com/u.test(document.html), "no CDN origin may survive into the sandbox");
    assert.ok(!/https:\/\/cdnjs\.cloudflare\.com/u.test(document.html), "no CDN origin may survive into the sandbox");
  });

  test(`${demo.name}: runtime fetches survive the sandbox's own URL rewriting`, async () => {
    // replaceResourceUrls() rewrites /content/<id> inside text resources into
    // data: URLs, so a script that fetches a declared resource at runtime sees
    // the rewritten form. verifiedFetch has to serve that back, or every demo
    // that loads a resource from JavaScript breaks.
    const { manifest } = await demoArtifact(demo);
    const document = createSandboxDocument(await resolveDemo(manifest));

    assert.ok(
      document.html.includes('requested.startsWith("data:")'),
      "the sandbox gateway must handle its own rewritten data: URLs",
    );
    // connect-src grants only blob: (locally created object URLs, for the
    // Flash fallback-WASM path) — never a network scheme. blob: fetches cannot
    // leave the document, so creator code still has no raw egress.
    assert.match(document.csp, /(?:^|; )connect-src blob:(?:;|$)/u, "no raw network egress may be granted to do it");
  });

  test(`${demo.name}: the manifest digest is stable across rebuilds`, async () => {
    const first = await buildDemoManifest(demo);
    const second = await buildDemoManifest(demo);
    assert.equal(first.integrity.digest, second.integrity.digest);
    assert.match(first.integrity.digest, /^0x[0-9a-f]{64}$/u);
  });

  test(`${demo.name}: the published manifest survives the wire parser`, async () => {
    // assertValidManifest alone once let a role slip through that
    // parseArtifactManifest rejects, so consumers choked on a manifest our own
    // build had blessed. Round-trip through JSON exactly as a consumer would.
    const { manifest } = await demoArtifact(demo);
    const parsed = parseArtifactManifest(JSON.parse(JSON.stringify(manifest)));
    assert.deepEqual(parsed, manifest);
  });
}

// --- The entrypoint only references routes the manifest actually declares ---

test("demo entrypoints only reference declared /content routes", async () => {
  for (const demo of DEMOS) {
    const html = await readFile(
      resourcePath(demo, demo.resources.find((resource) => resource.id === demo.entrypointResourceId)),
      "utf8",
    );
    const declared = new Set(demo.resources.map((resource) => `/content/${resource.id}`));
    const referenced = [...html.matchAll(/(?:src|href)="(\/content\/[^"]+)"/gu)].map((match) => match[1]);

    assert.ok(referenced.length > 0, `${demo.name} should reference at least one gateway route`);
    for (const route of referenced) {
      assert.ok(declared.has(route), `${demo.name} references undeclared route ${route}`);
    }
  }
});

// The Studio gallery/catalogue sync check lives in the keel-studio repository
// since the 2026-08-22 split.

// --- Compression, against the numbers published in the whitepaper ----------

test("three.js compresses at least as well as the Keel whitepaper reported", async () => {
  const bytes = new Uint8Array(await readFile(path.join(demosDirectory, "vendor", "three.min.js")));

  const deflate = await compressBytes("deflate", bytes);
  const brotli = await compressBytes("brotli", bytes);

  // storage.mdx: 750 KB of three.js compressed to 218 KB with deflate and
  // 175 KB with brotli. Those are ratios of 0.291 and 0.233; today's build is a
  // different size, so the ratios are what carry over.
  const deflateRatio = deflate.byteLength / bytes.byteLength;
  const brotliRatio = brotli.byteLength / bytes.byteLength;

  assert.ok(
    deflateRatio <= 0.291,
    `deflate ratio ${deflateRatio.toFixed(3)} should beat the published 0.291`,
  );
  assert.ok(
    brotliRatio <= 0.233,
    `brotli ratio ${brotliRatio.toFixed(3)} should beat the published 0.233`,
  );
  assert.ok(brotli.byteLength < deflate.byteLength, "brotli should win, as the whitepaper claimed");

  // The compressed bytes must round-trip exactly, or the commitment is worthless.
  assert.ok(await verifyIntegrity(await decompressBytes("brotli", brotli), await createIntegrity(bytes)));
  assert.ok(await verifyIntegrity(await decompressBytes("deflate", deflate), await createIntegrity(bytes)));
});

test("per-resource compression selection never inflates a resource", async () => {
  for (const demo of DEMOS) {
    for (const resource of await readDemoResources(demo)) {
      const { compression, bytes } = await chooseSmallestCompression(resource.bytes);
      assert.ok(
        bytes.byteLength <= resource.bytes.byteLength,
        `${demo.id}/${resource.id} grew under ${compression}`,
      );
      assert.deepEqual(
        Array.from(await decompressBytes(compression, bytes)),
        Array.from(resource.bytes),
        `${demo.id}/${resource.id} must round-trip through ${compression}`,
      );
    }
  }
});

test("already-compressed sprite art is stored uncompressed rather than padded", async () => {
  // WebP is entropy-coded; re-compressing it costs bytes. The builder should
  // notice and leave those resources alone.
  const forge = DEMOS.find((demo) => demo.id === "keel-sprite-forge");
  const webp = (await readDemoResources(forge)).filter((resource) => resource.mediaType === "image/webp");
  assert.ok(webp.length >= 5, "the sprite demo should carry the original attribute layers");

  for (const resource of webp) {
    const { bytes } = await chooseSmallestCompression(resource.bytes);
    assert.ok(bytes.byteLength <= resource.bytes.byteLength);
  }
});

// --- Legacy Keel compatibility ------------------------------------------

// The original Keel uploader packed five uint48 object IDs into each
// uint256 (src/utils/packIds.ts). Re-implemented here from the old source so a
// regression in the modern packer is caught against the historical behaviour.
function legacyPackIds(ids) {
  const packedIds = [];
  let packedId = 0n;
  for (let i = 0; i < ids.length; i++) {
    packedId = packedId | (BigInt(ids[i]) << (BigInt(i % 5) * 48n));
    if (i % 5 === 4 || i === ids.length - 1) {
      packedIds.push(packedId);
      packedId = 0n;
    }
  }
  return packedIds;
}

test("uint48 packing matches the original Keel packIds implementation", () => {
  const cases = [
    [1],
    [1, 2, 3],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5, 6],
    [9, 8, 7, 6, 5, 4, 3, 2, 1],
    [281474976710655, 1, 281474976710655],
  ];

  for (const ids of cases) {
    const modern = packUint48Ids(ids).map((group) => group.value);
    assert.deepEqual(modern, legacyPackIds(ids), `packing diverged for [${ids}]`);
  }
});

test("uint48 packing round-trips through the modern unpacker", () => {
  const ids = [7, 11, 13, 17, 19, 23, 29];
  const groups = packUint48Ids(ids);
  const recovered = groups.flatMap((group, index) =>
    unpackUint48Ids(group.value, Math.min(5, ids.length - index * 5)),
  );
  assert.deepEqual(recovered.map(Number), ids);
});

test("uint48 packing refuses IDs the legacy contract could not store", () => {
  assert.throws(() => packUint48Ids([2 ** 48]), RangeError);
  assert.throws(() => packUint48Ids([-1]), RangeError);
});
