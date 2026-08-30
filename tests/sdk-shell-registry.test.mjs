import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_INLINE_PROTECTION_SHELL_ID,
  KEEL_PROTECTION_SHELL_ID,
  buildKeelCreatorShellFreezeCall,
  buildKeelCreatorShellRegistrationCall,
  buildKeelCreatorShellUpdateCall,
  buildKeelRegisteredPreEncodedTokenURICall,
  buildKeelShellDataURICall,
  buildKeelShellRegistrationCall,
  createKeelShellManifest,
  parseKeelShellManifest,
  searchKeelShells,
  keelCreatorShellId,
  keelShellId,
  moduleAbi,
} from "../packages/sdk/dist/index.js";

const BUILDER = "0x4f04bf6aac1183c26cadf05cf69d6148c9f6440b";
const PREFIX = `0x${"11".repeat(32)}`;
const SUFFIX = `0x${"22".repeat(32)}`;
const ARTIFACT = `0x${"33".repeat(32)}`;
const DIGEST = `0x${"44".repeat(32)}`;

test("the SDK and contract share one stable default protection shell ID", () => {
  assert.equal(KEEL_PROTECTION_SHELL_ID, "0x7b2e5d9ae4904559ee0b3bf392525dea473479632be701d474269261dea2386c");
  assert.equal(keelShellId("keel.shell.protection@1"), KEEL_PROTECTION_SHELL_ID);
  assert.equal(keelShellId("keel.shell.inline-protection@1"), KEEL_INLINE_PROTECTION_SHELL_ID);
  assert.equal(keelShellId("luna.shell.gzip-only@1"), "0xe08c9d0616c929be1727c8928341364f2a85b4537818c62ab68d55e9f34a7e2b");
});

test("shell discovery accepts only bounded read-back-verified catalogue records", async () => {
  const shellId = `0x${"66".repeat(32)}`;
  const rows = await searchKeelShells({
    studioUrl: "https://studio.example",
    query: "proof",
    fetchImplementation: async (url) => {
      assert.equal(new URL(url).pathname, "/api/shells");
      assert.equal(new URL(url).searchParams.get("q"), "proof");
      return new Response(JSON.stringify({ shells: [{
        chainId: 11155111,
        builder: BUILDER,
        shellId,
        creator: "0x404a6bd65ef48ae85da7b0e9358715a34a401b05",
        name: "KEEL Verification Shell",
        description: "Protected proof chrome.",
        version: "1.0.0",
        tags: ["proof", "sandbox"],
        payloadMode: "sandboxed-html",
        topObjectId: PREFIX,
        bottomObjectId: SUFFIX,
        metadataObjectId: ARTIFACT,
        metadataDigest: DIGEST,
        revisionMode: "follow-latest",
        latestRevision: 3,
        frozen: false,
      }] }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(rows[0].shellId, shellId);
  assert.deepEqual(rows[0].tags, ["proof", "sandbox"]);
  assert.equal(rows[0].revisionMode, "follow-latest");
  assert.equal(rows[0].latestRevision, 3);
  assert.equal(rows[0].frozen, false);
});

test("the generated harness ABI exposes the registry and overloaded shell reads", async () => {
  const abi = await moduleAbi("keel-harness", "KeelHarnessBuilder");
  const functions = abi.filter((item) => item.type === "function");
  assert.equal(functions.filter((item) => item.name === "setShell").length, 3);
  assert.ok(functions.some((item) => item.name === "setShell" && item.inputs.length === 4));
  assert.ok(functions.some((item) => item.name === "setShell" && item.inputs.length === 5));
  assert.ok(functions.some((item) => item.name === "registerShell" && item.inputs.length === 5));
  assert.ok(functions.some((item) => item.name === "updateShell" && item.inputs.length === 5));
  assert.ok(functions.some((item) => item.name === "freezeShell" && item.inputs.length === 1));
  assert.ok(functions.some((item) => item.name === "shellLatestRevision"));
  assert.ok(functions.some((item) => item.name === "shellRevision"));
  assert.ok(functions.some((item) => item.name === "predictShellId"));
  assert.ok(functions.some((item) => item.name === "shellCreator"));
  assert.ok(functions.some((item) => item.name === "shellMetadataObjectId"));
  assert.equal(functions.filter((item) => item.name === "shellDataURI").length, 2);
  assert.ok(functions.some((item) => item.name === "PROTECTION_SHELL_ID"));
  assert.ok(functions.some((item) => item.name === "INLINE_PROTECTION_SHELL_ID"));
  assert.ok(functions.some((item) => item.name === "registeredPreEncodedTokenURI"));
  assert.ok(functions.some((item) => item.name === "shells"));
});

test("the SDK prepares explicit gzip-shell reads without claiming protection", () => {
  const shellId = keelShellId("luna.shell.gzip-only@1");
  const call = buildKeelShellDataURICall({
    builderAddress: BUILDER,
    shellId,
    artifactObjectId: ARTIFACT,
    artifactDigest: DIGEST,
    contextJSON: '{"tokenId":"1"}',
  });

  assert.equal(call.mode, "explicit-shell");
  assert.equal(call.functionSignature, "shellDataURI(bytes32,bytes32,bytes32,bytes)");
  assert.deepEqual(call.arguments.slice(0, 3), [shellId, ARTIFACT, DIGEST]);
});

test("omitting a shell ID selects protection and registration stays review-only", () => {
  const read = buildKeelShellDataURICall({
    builderAddress: BUILDER,
    artifactObjectId: ARTIFACT,
    artifactDigest: DIGEST,
  });
  assert.equal(read.mode, "default-protection");
  assert.equal(read.functionSignature, "shellDataURI(bytes32,bytes32,bytes)");

  const registration = buildKeelShellRegistrationCall({
    builderAddress: BUILDER,
    shellId: keelShellId("luna.shell.gzip-only@1"),
    prefixObjectId: PREFIX,
    suffixObjectId: SUFFIX,
    metadataObjectId: ARTIFACT,
    payloadMode: "gzip-base64",
  });
  assert.equal(registration.status, "review-only");
  assert.equal(registration.signing, "not-performed");
  assert.equal(registration.submission, "not-performed");
  assert.equal(registration.functionSignature, "setShell(bytes32,bytes32,bytes32,uint8,bytes32)");
  assert.equal(registration.arguments[3], 1);
  assert.equal(registration.arguments[4], ARTIFACT);
});

test("creator shells are namespaced, metadata-backed, and prepared without signing", async () => {
  const creator = "0x404a6bd65ef48ae85da7b0e9358715a34a401b05";
  const salt = `0x${"55".repeat(32)}`;
  const shellId = keelCreatorShellId(creator, salt);
  assert.notEqual(shellId, keelCreatorShellId("0x000000000000000000000000000000000000beef", salt));

  const manifest = await createKeelShellManifest({
    name: "Creator Grid",
    description: "A reusable grid presentation around a verified work.",
    version: "1.0.0",
    creator,
    tags: ["Generative", "grid", "generative"],
  });
  assert.equal(manifest.value.protocol, "keel-shell-manifest@1");
  assert.deepEqual(manifest.value.tags, ["generative", "grid"]);
  assert.equal(manifest.integrity.byteLength, manifest.bytes.byteLength);
  assert.deepEqual(parseKeelShellManifest(manifest.bytes), manifest.value);
  assert.throws(
    () => parseKeelShellManifest(JSON.stringify({ ...manifest.value, tags: ["grid", "generative"] })),
    /sorted unique lowercase/u,
  );

  const call = buildKeelCreatorShellRegistrationCall({
    builderAddress: BUILDER,
    salt,
    prefixObjectId: PREFIX,
    suffixObjectId: SUFFIX,
    metadataObjectId: ARTIFACT,
  });
  assert.equal(call.functionName, "registerShell");
  assert.equal(call.functionSignature, "registerShell(bytes32,bytes32,bytes32,uint8,bytes32)");
  assert.equal(call.status, "review-only");
  assert.equal(call.signing, "not-performed");
  assert.equal(call.submission, "not-performed");
  assert.equal(call.payloadMode, "pre-encoded-graph");
  assert.equal(call.arguments[3], 2);

  const update = buildKeelCreatorShellUpdateCall({
    builderAddress: BUILDER,
    shellId,
    prefixObjectId: PREFIX,
    suffixObjectId: SUFFIX,
    metadataObjectId: ARTIFACT,
  });
  assert.equal(update.functionSignature, "updateShell(bytes32,bytes32,bytes32,uint8,bytes32)");
  assert.deepEqual(update.arguments, [shellId, PREFIX, SUFFIX, 2, ARTIFACT]);
  assert.equal(update.signing, "not-performed");

  const freeze = buildKeelCreatorShellFreezeCall({ builderAddress: BUILDER, shellId });
  assert.equal(freeze.functionSignature, "freezeShell(bytes32)");
  assert.equal(freeze.irreversible, true);
  assert.deepEqual(freeze.arguments, [shellId]);
  assert.equal(freeze.submission, "not-performed");
});

test("the canonical inline read selects the registered graph shell without manufacturing HTML", () => {
  const call = buildKeelRegisteredPreEncodedTokenURICall({
    builderAddress: BUILDER,
    objectId: ARTIFACT,
    expectedDigest: DIGEST,
    rawPrefix: '{"x":"',
    rawSuffix: '"}',
  });
  assert.equal(call.mode, "default-inline-protection");
  assert.equal(call.arguments[0], KEEL_INLINE_PROTECTION_SHELL_ID);
  assert.equal(call.functionSignature, "registeredPreEncodedTokenURI(bytes32,bytes32,bytes32,bytes,bytes)");
});
