// Deterministically materializes the historical Keel Z85 corpus.
//
// The checked-in b85/ directory is the byte-for-byte provenance layer. This
// script derives the exact Brotli bytes, final JavaScript, and corpus manifest
// without reading either external ChainRouge source tree.

import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { decodeBase85, encodeBase85, equalBytes } from "../../packages/protocol/dist/index.js";

const corpusDirectory = path.dirname(fileURLToPath(import.meta.url));
const b85Directory = path.join(corpusDirectory, "b85");
const decodedDirectory = path.join(corpusDirectory, "decoded");
const decompressedDirectory = path.join(corpusDirectory, "decompressed");

const EXPECTED_FILES = [
  "bab-start.b85",
  "fluid-capture.all.b85",
  "fluid-dat.gui.b85",
  "fluid-init.b85",
  "fluid-main.b85",
  "fluid-render.b85",
  "fluid-shaders.b85",
  "fluid-utils.b85",
  "shader-1.b85",
  "start-genart.b85",
  "start-gpu.b85",
  "start-p5.b85",
  "start-sphere.b85",
  "start-three.b85",
  "start-twgl.b85",
  "start-twgl2.b85",
  "start.b85",
  "twgl.b85",
  "webMatrix.b85",
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function legacyPayload(source, file) {
  const match = /^<b85>([\s\S]*)<\/b85>$/u.exec(source);
  if (match !== null) {
    if (file !== "start.b85") throw new Error(`${file}: unexpected legacy <b85> wrapper`);
    return { payload: match[1], wrapper: "legacy-b85-tag" };
  }
  if (source.includes("<b85>") || source.includes("</b85>")) {
    throw new Error(`${file}: incomplete legacy <b85> wrapper`);
  }
  return { payload: source, wrapper: "bare-z85" };
}

async function discoverFiles() {
  const discovered = (await readdir(b85Directory)).filter((file) => file.endsWith(".b85")).sort();
  if (JSON.stringify(discovered) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error(
      `Historical corpus mismatch. Expected ${EXPECTED_FILES.join(", ")}; found ${discovered.join(", ")}.`,
    );
  }
  return discovered;
}

export async function buildCorpus() {
  const artifacts = [];
  const outputs = [];

  for (const file of await discoverFiles()) {
    const name = file.slice(0, -".b85".length);
    const sourceBytes = new Uint8Array(await readFile(path.join(b85Directory, file)));
    const source = textDecoder.decode(sourceBytes);
    const { payload, wrapper } = legacyPayload(source, file);
    const payloadBytes = textEncoder.encode(payload);
    const decoded = decodeBase85(payload);
    const decompressed = new Uint8Array(brotliDecompressSync(decoded));

    // A valid final resource must be UTF-8 JavaScript, but do not execute it.
    textDecoder.decode(decompressed);
    if (encodeBase85(decoded) !== payload) {
      throw new Error(`${file}: decoded bytes do not canonically re-encode to the preserved payload`);
    }
    if (!equalBytes(decodeBase85(encodeBase85(decoded)), decoded)) {
      throw new Error(`${file}: decoded bytes fail the Z85 byte round trip`);
    }

    const decodedFile = `decoded/${name}.br`;
    const decompressedFile = `decompressed/${name}.js`;
    outputs.push({ file: decodedFile, bytes: decoded });
    outputs.push({ file: decompressedFile, bytes: decompressed });
    artifacts.push({
      name,
      sourceFile: `b85/${file}`,
      decodedFile,
      decompressedFile,
      wrapper,
      compression: "brotli",
      mediaType: "application/javascript",
      canonicalReencode: true,
      sizes: {
        sourceBytes: sourceBytes.byteLength,
        encodedCharacters: payload.length,
        decodedBytes: decoded.byteLength,
        decompressedBytes: decompressed.byteLength,
      },
      digests: {
        sourceSha256: sha256(sourceBytes),
        payloadSha256: sha256(payloadBytes),
        decodedSha256: sha256(decoded),
        decompressedSha256: sha256(decompressed),
      },
    });
  }

  const totals = artifacts.reduce(
    (result, artifact) => ({
      files: result.files + 1,
      sourceBytes: result.sourceBytes + artifact.sizes.sourceBytes,
      encodedCharacters: result.encodedCharacters + artifact.sizes.encodedCharacters,
      decodedBytes: result.decodedBytes + artifact.sizes.decodedBytes,
      decompressedBytes: result.decompressedBytes + artifact.sizes.decompressedBytes,
    }),
    { files: 0, sourceBytes: 0, encodedCharacters: 0, decodedBytes: 0, decompressedBytes: 0 },
  );

  const manifest = {
    schema: "keel-b85-corpus@1",
    provenance: {
      project: "ChainRouge Solidity / Keel",
      snapshot: "September 2023 inventory tree",
      scope: "the 19 top-level .b85 files",
      excluded: ["test/twgl.b85"],
    },
    discovery: "top-level .b85 files only",
    pipeline: [
      "preserved source file",
      "legacy <b85> wrapper extraction when declared",
      "Z85 decode",
      "Brotli decompress",
      "fatal UTF-8 validation without execution",
    ],
    totals,
    artifacts,
  };

  return {
    manifest,
    manifestBytes: textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    outputs,
  };
}

export async function writeCorpus() {
  const built = await buildCorpus();
  await mkdir(decodedDirectory, { recursive: true });
  await mkdir(decompressedDirectory, { recursive: true });
  for (const output of built.outputs) {
    await writeFile(path.join(corpusDirectory, output.file), output.bytes);
  }
  await writeFile(path.join(corpusDirectory, "corpus.json"), built.manifestBytes);
  return built.manifest;
}

export async function checkCorpus() {
  const built = await buildCorpus();
  const committedManifest = new Uint8Array(await readFile(path.join(corpusDirectory, "corpus.json")));
  if (!equalBytes(committedManifest, built.manifestBytes)) {
    throw new Error("corpus.json is stale; run node examples/keel/build-corpus.mjs");
  }
  for (const output of built.outputs) {
    const committed = new Uint8Array(await readFile(path.join(corpusDirectory, output.file)));
    if (!equalBytes(committed, output.bytes)) {
      throw new Error(`${output.file} is stale; run node examples/keel/build-corpus.mjs`);
    }
  }
  return built.manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const manifest = check ? await checkCorpus() : await writeCorpus();
  const ratio = ((manifest.totals.decodedBytes / manifest.totals.decompressedBytes) * 100).toFixed(1);
  console.log(
    `${check ? "Verified" : "Wrote"} ${manifest.totals.files} Keel artifacts: ` +
      `${manifest.totals.sourceBytes} source bytes → ${manifest.totals.decodedBytes} Brotli bytes → ` +
      `${manifest.totals.decompressedBytes} JavaScript bytes (${ratio}% stored/expanded).`,
  );
}
