import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import {
  decodeBase85,
  encodeBase85,
  equalBytes,
} from "../packages/protocol/dist/index.js";
import { checkCorpus } from "../examples/keel/build-corpus.mjs";

const corpusDirectory = path.resolve("examples/keel");

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function extractPayload(source, wrapper) {
  const match = /^<b85>([\s\S]*)<\/b85>$/u.exec(source);
  assert.equal(
    match !== null,
    wrapper === "legacy-b85-tag",
    "wrapper metadata must match the preserved source",
  );
  return match?.[1] ?? source;
}

test("the complete historical Keel .b85 corpus reproduces every committed stage", async () => {
  const manifest = JSON.parse(await readFile(path.join(corpusDirectory, "corpus.json"), "utf8"));

  assert.equal(manifest.schema, "keel-b85-corpus@1");
  assert.equal(manifest.discovery, "top-level .b85 files only");
  assert.equal(manifest.artifacts.length, 19);

  const sourceFiles = (await readdir(path.join(corpusDirectory, "b85")))
    .filter((name) => name.endsWith(".b85"))
    .sort();
  assert.deepEqual(
    sourceFiles,
    manifest.artifacts.map((artifact) => path.basename(artifact.sourceFile)).sort(),
    "the manifest must cover every vendored top-level .b85 file exactly once",
  );

  const totals = {
    sourceBytes: 0,
    encodedCharacters: 0,
    decodedBytes: 0,
    decompressedBytes: 0,
  };

  for (const artifact of manifest.artifacts) {
    const sourceBytes = new Uint8Array(
      await readFile(path.join(corpusDirectory, artifact.sourceFile)),
    );
    const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    const payload = extractPayload(source, artifact.wrapper);
    const payloadBytes = new TextEncoder().encode(payload);
    const decoded = decodeBase85(payload);
    const decompressed = new Uint8Array(brotliDecompressSync(decoded));
    const committedDecoded = new Uint8Array(
      await readFile(path.join(corpusDirectory, artifact.decodedFile)),
    );
    const committedDecompressed = new Uint8Array(
      await readFile(path.join(corpusDirectory, artifact.decompressedFile)),
    );

    assert.equal(
      encodeBase85(decoded),
      payload,
      `${artifact.name}: the historical Z85 payload must re-encode exactly`,
    );
    assert.ok(
      equalBytes(decodeBase85(encodeBase85(decoded)), decoded),
      `${artifact.name}: decoded bytes must survive a Z85 round trip`,
    );
    assert.deepEqual(
      committedDecoded,
      decoded,
      `${artifact.name}: the committed Brotli bytes must match Z85 decoding`,
    );
    assert.deepEqual(
      committedDecompressed,
      decompressed,
      `${artifact.name}: the committed JavaScript must match Brotli decompression`,
    );

    assert.deepEqual(artifact.sizes, {
      sourceBytes: sourceBytes.byteLength,
      encodedCharacters: payload.length,
      decodedBytes: decoded.byteLength,
      decompressedBytes: decompressed.byteLength,
    });
    assert.deepEqual(artifact.digests, {
      sourceSha256: sha256(sourceBytes),
      payloadSha256: sha256(payloadBytes),
      decodedSha256: sha256(decoded),
      decompressedSha256: sha256(decompressed),
    });

    totals.sourceBytes += sourceBytes.byteLength;
    totals.encodedCharacters += payload.length;
    totals.decodedBytes += decoded.byteLength;
    totals.decompressedBytes += decompressed.byteLength;
  }

  assert.deepEqual(manifest.totals, { files: 19, ...totals });
  assert.deepEqual(totals, {
    sourceBytes: 96_390,
    encodedCharacters: 96_379,
    decodedBytes: 77_096,
    decompressedBytes: 349_365,
  });

  const byName = Object.fromEntries(manifest.artifacts.map((artifact) => [artifact.name, artifact]));
  assert.deepEqual(byName["start-p5"].sizes, {
    sourceBytes: 2_047,
    encodedCharacters: 2_047,
    decodedBytes: 1_637,
    decompressedBytes: 6_153,
  });
  assert.deepEqual(byName["start-three"].sizes, {
    sourceBytes: 2_452,
    encodedCharacters: 2_452,
    decodedBytes: 1_961,
    decompressedBytes: 8_004,
  });
  assert.equal(byName["fluid-main"].sizes.decompressedBytes, 10_688);
  assert.equal(byName.twgl.sizes.decodedBytes, 19_322);
  assert.equal(byName.webMatrix.sizes.decodedBytes, 7_878);
  assert.equal(
    byName.start.wrapper,
    "legacy-b85-tag",
    "start.b85 preserves its historical wrapper",
  );
  await checkCorpus();
});
