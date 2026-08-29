import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  createIntegrity,
  encodeBase64,
  manifestIntegrity,
  assertValidManifest,
  sha256Hex,
  utf8ToBytes,
} from "../packages/protocol/dist/index.js";
import {
  loadArtifactManifest,
  parseKeelWakeUri,
  createVerifiedContentGateway,
  resolveArtifact,
  resolveArtifactFromManifestUri,
} from "../packages/viewer/dist/index.js";
import { baseManifest } from "./fixtures.mjs";

const coordinator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const uri = `keel://wake/eip155/31337/${coordinator}/7`;

async function wakeFixture() {
  const sourceBytes = utf8ToBytes("<main>verified</main>");
  const sourceIntegrity = await createIntegrity(sourceBytes);
  const value = baseManifest([{
    id: "viewer",
    role: "entrypoint",
    mediaType: "text/html",
    executable: false,
    sources: [{ kind: "inline", data: encodeBase64(sourceBytes), encoding: "base64", integrity: sourceIntegrity }],
  }, {
    id: "image",
    role: "fallback",
    mediaType: "image/svg+xml",
    sources: [{ kind: "inline", data: encodeBase64(sourceBytes), encoding: "base64", integrity: sourceIntegrity }],
  }]);
  const bytes = utf8ToBytes(canonicalJson(value));
  const integrity = await manifestIntegrity(value);
  const decodedDigest = await sha256Hex(bytes);
  return {
    bytes,
    integrity,
    provenance: {
      protocol: "keel-wake@1",
      storageMode: "history-inscription-v1",
      chainId: 31337,
      coordinator,
      publicationId: 7n,
      storedDigest: decodedDigest,
      decodedDigest,
      storedByteLength: bytes.byteLength,
      decodedByteLength: bytes.byteLength,
      compression: "none",
      batchCount: 1,
      chunkCount: 1,
      retrievalSource: "archive",
      archivalStatus: "replicated",
      verified: true,
    },
  };
}

test("viewer recognizes canonical KEEL Wake locators as a verified manifest source", async () => {
  const fixture = await wakeFixture();
  let request;
  const loaded = await loadArtifactManifest(uri, fixture.integrity, {
    adapters: {
      async readWakeObject(next) {
        request = next;
        return { bytes: fixture.bytes, provenance: fixture.provenance };
      },
      async fetch() {
        throw new Error("KEEL Wake must not fall through to generic HTTP retrieval.");
      },
    },
  });
  assert.deepEqual(request, {
    chainId: 31337,
    coordinator,
    publicationId: 7n,
    expectedIntegrity: fixture.integrity,
  });
  assert.equal(loaded.sourceUrl, uri);
  assert.equal(loaded.commitment.wake?.verified, true);
  assert.equal(parseKeelWakeUri(uri)?.kind, "object");
  assert.equal(parseKeelWakeUri(uri)?.publicationId, 7n);
});

test("viewer fails closed on Wake reader failure or manifest digest mismatch", async () => {
  const fixture = await wakeFixture();
  let genericFetches = 0;
  await assert.rejects(() => loadArtifactManifest(uri, fixture.integrity, {
    adapters: {
      async readWakeObject() {
        throw new Error("archive unavailable");
      },
      async fetch() {
        genericFetches += 1;
        throw new Error("must not fetch");
      },
    },
  }), /archive unavailable/u);

  const wrongManifestDigest = `0x${"f".repeat(64)}`;
  await assert.rejects(() => loadArtifactManifest(uri, wrongManifestDigest, {
    adapters: {
      async readWakeObject() {
        return { bytes: fixture.bytes, provenance: fixture.provenance };
      },
      async fetch() {
        genericFetches += 1;
        throw new Error("must not fetch");
      },
    },
  }), /canonical manifest digest/u);
  assert.equal(genericFetches, 0);
});

test("viewer rejects non-canonical Wake forms before any reader or mount path", async () => {
  const fixture = await wakeFixture();
  const invalid = [
    `keel://wake/eip155/01/${coordinator}/7`,
    `keel://wake/eip155/31337/${coordinator.toUpperCase()}/7`,
    `${uri}?archive=1`,
    `${uri}/`,
    "keel://wake/other/1/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/7",
  ];
  for (const invalidUri of invalid) {
    let reads = 0;
    await assert.rejects(() => loadArtifactManifest(invalidUri, fixture.integrity, {
      adapters: {
        async readWakeObject() {
          reads += 1;
          return { bytes: fixture.bytes, provenance: fixture.provenance };
        },
      },
    }), /Invalid KEEL Wake URI|canonical/u);
    assert.equal(reads, 0);
  }
});

test("Wake resource sources enter the existing verified resolver and content gateway", async () => {
  const resourceBytes = utf8ToBytes("wake-resource");
  const resourceDigest = await sha256Hex(resourceBytes);
  const resourceUri = `keel://wake/eip155/31337/${coordinator}/8`;
  const value = baseManifest([{
    id: "viewer",
    role: "entrypoint",
    mediaType: "text/plain",
    executable: false,
    sources: [{ kind: "uri", uri: resourceUri, integrity: { algorithm: "sha256", digest: resourceDigest } }],
  }, {
    id: "image",
    role: "fallback",
    mediaType: "text/plain",
    sources: [{ kind: "inline", data: "d2FrZS1yZXNvdXJjZQ==", encoding: "base64", integrity: { algorithm: "sha256", digest: resourceDigest } }],
  }]);
  const manifestBytes = utf8ToBytes(canonicalJson(value));
  const manifestIntegrityValue = await manifestIntegrity(value);
  const rootDigest = await sha256Hex(manifestBytes);
  const provenance = (publicationId, bytes, digest) => ({
    protocol: "keel-wake@1",
    storageMode: "history-inscription-v1",
    chainId: 31337,
    coordinator,
    publicationId,
    storedDigest: digest,
    decodedDigest: digest,
    storedByteLength: bytes.byteLength,
    decodedByteLength: bytes.byteLength,
    compression: "none",
    batchCount: 1,
    chunkCount: 1,
    retrievalSource: "rpc-history",
    verified: true,
  });
  const artifact = await resolveArtifactFromManifestUri(`keel://wake/eip155/31337/${coordinator}/7`, manifestIntegrityValue, {
    resolver: { allowUriSources: false },
    adapters: {
      async readWakeObject(request) {
        if (request.publicationId === 7n) return { bytes: manifestBytes, provenance: provenance(7n, manifestBytes, rootDigest) };
        if (request.publicationId === 8n) return { bytes: resourceBytes, provenance: provenance(8n, resourceBytes, resourceDigest) };
        throw new Error("unexpected Wake publication");
      },
    },
  });
  assert.deepEqual(Array.from(artifact.entrypoint.bytes), Array.from(resourceBytes));
  assert.deepEqual(Array.from(artifact.resources.get("viewer").bytes), Array.from(resourceBytes));
  const gateway = createVerifiedContentGateway(artifact);
  assert.equal(gateway.resolve(`/content/viewer`).status, 200);
  assert.equal(gateway.resolve(resourceUri).status, 403);
});

test("Wake chunk locators are transport-only and never reach manifest or resource readers", async () => {
  const fixture = await wakeFixture();
  const chunkUri = `${uri}/chunk/0`;
  assert.equal(parseKeelWakeUri(chunkUri)?.kind, "chunk");
  let reads = 0;
  await assert.rejects(() => loadArtifactManifest(chunkUri, fixture.integrity, {
    adapters: { async readWakeObject() { reads += 1; return fixture; } },
  }), /transport-only|manifest locators/u);
  assert.equal(reads, 0);
  const value = baseManifest([{
    id: "viewer",
    role: "entrypoint",
    mediaType: "text/plain",
    executable: false,
    sources: [{ kind: "uri", uri: chunkUri, integrity: fixture.integrity }],
  }]);
  await assert.rejects(() => resolveArtifact(value, {
    adapters: { async readWakeObject() { reads += 1; return fixture; } },
  }), /uri.invalid|transport-only/u);
  assert.equal(reads, 0);
});

test("Wake namespace remains reserved from creator resource IDs and aliases", () => {
  const source = {
    kind: "inline",
    data: "d2FrZQ==",
    encoding: "base64",
    integrity: { algorithm: "sha256", digest: `0x${"0".repeat(64)}` },
  };
  const idReserved = baseManifest([{
    id: "wake/eip155/1/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1",
    role: "entrypoint",
    mediaType: "text/plain",
    executable: false,
    sources: [source],
  }]);
  assert.throws(() => assertValidManifest(idReserved), /reserved/u);
  const aliasReserved = baseManifest([{
    id: "safe",
    role: "entrypoint",
    mediaType: "text/plain",
    executable: false,
    aliases: [uri],
    sources: [source],
  }]);
  assert.throws(() => assertValidManifest(aliasReserved), /reserved/u);
});

test("Wake resolution enforces aggregate stored bytes and shares one canonical read", async () => {
  const bytes = utf8ToBytes("shared-wake");
  const digest = await sha256Hex(bytes);
  const source = { kind: "uri", uri, integrity: { algorithm: "sha256", digest } };
  const value = baseManifest([
    { id: "viewer", role: "entrypoint", mediaType: "text/plain", executable: false, sources: [source] },
    { id: "image", role: "fallback", mediaType: "text/plain", sources: [source] },
  ]);
  const provenance = {
    protocol: "keel-wake@1",
    storageMode: "history-inscription-v1",
    chainId: 31337,
    coordinator,
    publicationId: 7n,
    storedDigest: digest,
    decodedDigest: digest,
    storedByteLength: bytes.byteLength,
    decodedByteLength: bytes.byteLength,
    compression: "none",
    batchCount: 1,
    chunkCount: 1,
    retrievalSource: "archive",
    verified: true,
  };
  let reads = 0;
  const artifact = await resolveArtifact(value, {
    adapters: {
      async readWakeObject() {
        reads += 1;
        return { bytes, provenance };
      },
    },
  });
  assert.equal(reads, 1);
  assert.equal(artifact.audit.totalStoredBytes, bytes.byteLength * 2);
  await assert.rejects(() => resolveArtifact(value, {
    limits: { maxStoredBytes: bytes.byteLength - 1 },
    adapters: { async readWakeObject() { return { bytes, provenance }; } },
  }), /stored-byte/u);
});
