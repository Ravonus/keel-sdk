import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createIntegrity,
  canonicalJson,
} from "../packages/protocol/dist/index.js";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createKeelModuleLock,
  createKeelModuleReceipt,
  createKeelModuleResolverSnapshot,
  parseKeelModuleResolverSnapshot,
  resolveKeelModule,
  verifyKeelModuleBytes,
  verifyKeelModuleLock,
  verifyKeelModuleReceipt,
} from "../packages/builder/dist/index.js";

const bytes = (value) => new TextEncoder().encode(value);
const carrier = {
  kind: "keel",
  network: "eip155:1",
  store: "module-store",
  objectId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  reader: "recursive-object@1",
};

async function release(name, version, source, entry = "dist/index.js") {
  const content = bytes(source);
  return {
    identity: { namespace: "npm", name, version, entry },
    mediaType: "text/javascript",
    format: "es-module",
    integrity: await createIntegrity(content),
    byteLength: content.byteLength,
    carriers: [carrier],
    content,
  };
}

async function fixture() {
  const three = await release("three", "0.180.0", "export const three = 180;");
  const threeOld = await release("three", "0.179.0", "export const three = 179;", "dist/legacy.js");
  const p5 = await release("p5", "1.9.0", "export const p5 = 19;");
  const strip = (item) => {
    const { content, ...declaration } = item;
    return declaration;
  };
  return {
    three,
    catalog: {
      protocol: "keel-module-catalog@1",
      canonicalDigest: "sha256",
      releases: [strip(threeOld), strip(p5), strip(three)],
    },
    metadata: [
      { releaseKey: "npm:three@0.180.0/dist/index.js", artist: "Three.js Authors", tags: ["renderer", "3d"] },
      { releaseKey: "npm:three@0.179.0/dist/legacy.js", artist: "Three.js Authors", tags: ["renderer", "legacy"] },
      { releaseKey: "npm:p5@1.9.0/dist/index.js", artist: "The Processing Foundation", tags: ["creative-coding"] },
    ],
  };
}

test("resolver snapshots normalize order and pin a canonical catalog digest", async () => {
  const first = await fixture();
  const second = await fixture();
  second.catalog.releases.reverse();
  second.metadata.reverse();
  const one = createKeelModuleResolverSnapshot(first.catalog, first.metadata);
  const two = createKeelModuleResolverSnapshot(second.catalog, second.metadata);
  const firstResult = await resolveKeelModule(one, { kind: "query", name: "three", version: "0.180.0" });
  const secondResult = await resolveKeelModule(two, { kind: "query", name: "three", version: "0.180.0" });
  assert.equal(firstResult.status, "resolved");
  assert.equal(secondResult.status, "resolved");
  assert.deepEqual(firstResult.catalogIntegrity, secondResult.catalogIntegrity);
  assert.equal(canonicalJson(one), canonicalJson(two));
});

test("carrier declaration order does not change the snapshot or preferred carrier", async () => {
  const value = await fixture();
  const mirror = { kind: "https", uri: "https://cdn.example.test/three.js", immutable: true };
  const withCarriers = (order) => ({
    ...value.catalog,
    releases: value.catalog.releases.map((item, index) => index === 0 ? { ...item, carriers: order } : item),
  });
  const one = createKeelModuleResolverSnapshot(withCarriers([carrier, mirror]), value.metadata);
  const two = createKeelModuleResolverSnapshot(withCarriers([mirror, carrier]), value.metadata);
  assert.equal(canonicalJson(one), canonicalJson(two));
  const resolved = await resolveKeelModule(two, { kind: "query", name: "three", version: "0.179.0", entry: "dist/legacy.js" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.selectedCarrier?.kind, "keel");
});

test("hash selectors require exact SHA-256 and byte length, with bytes initially unavailable", async () => {
  const value = await fixture();
  const snapshot = createKeelModuleResolverSnapshot(value.catalog, value.metadata);
  const result = await resolveKeelModule(snapshot, {
    kind: "hash",
    digest: value.three.integrity.digest,
    byteLength: value.three.byteLength,
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.bytes, "unavailable");
  assert.equal(result.releaseKey, "npm:three@0.180.0/dist/index.js");
  const wrongLength = await resolveKeelModule(snapshot, { kind: "hash", digest: value.three.integrity.digest, byteLength: value.three.byteLength + 1 });
  assert.equal(wrongLength.status, "not-found");
  assert.equal(await verifyKeelModuleBytes(value.three, value.three.content), "verified");
  assert.equal(await verifyKeelModuleBytes(value.three, bytes("tampered")), "mismatch");
});

test("name, artist, and tag queries are bounded and fail closed on ambiguity", async () => {
  const value = await fixture();
  const snapshot = createKeelModuleResolverSnapshot(value.catalog, value.metadata);
  const ambiguous = await resolveKeelModule(snapshot, { kind: "query", name: "three", artist: "authors", tags: ["renderer"] });
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates, [
    "npm:three@0.179.0/dist/legacy.js",
    "npm:three@0.180.0/dist/index.js",
  ]);
  const exact = await resolveKeelModule(snapshot, { kind: "query", name: "three", version: "0.180.0", artist: "authors", tags: ["3D", "renderer"] });
  assert.equal(exact.status, "resolved");
  assert.equal(exact.metadata?.artist, "Three.js Authors");
  const missing = await resolveKeelModule(snapshot, { kind: "query", name: "missing" });
  assert.equal(missing.status, "not-found");
  await assert.rejects(
    () => createKeelModuleLock(snapshot, [{ kind: "query", name: "three", artist: "authors", tags: ["renderer"] }]),
    /multiple/u,
  );
});

test("locks and receipts detect catalog replay and distinguish unavailable from verified bytes", async () => {
  const value = await fixture();
  const snapshot = createKeelModuleResolverSnapshot(value.catalog, value.metadata);
  const lock = await createKeelModuleLock(snapshot, [{ kind: "query", name: "three", version: "0.180.0" }]);
  assert.equal((await verifyKeelModuleLock(snapshot, lock)).valid, true);
  const receipt = await createKeelModuleReceipt(snapshot, lock);
  assert.equal(receipt.receipt.statuses[0]?.bytes, "unavailable");
  assert.equal((await verifyKeelModuleReceipt(snapshot, lock, receipt)).valid, true);
  const withBytes = await createKeelModuleReceipt(snapshot, lock, { [lock.lock.resolutions[0].releaseKey]: value.three.content });
  assert.equal(withBytes.receipt.statuses[0]?.bytes, "verified");
  assert.equal((await verifyKeelModuleReceipt(snapshot, lock, withBytes, { [lock.lock.resolutions[0].releaseKey]: value.three.content })).valid, true);
  const forged = structuredClone(withBytes);
  forged.receipt.statuses[0].bytes = "verified";
  forged.integrity = await createIntegrity(bytes(canonicalJson(forged.receipt)));
  assert.equal((await verifyKeelModuleReceipt(snapshot, lock, forged)).valid, false);
  const tamperedLock = structuredClone(lock);
  tamperedLock.lock.resolutions[0].mediaType = "application/x-tampered";
  tamperedLock.integrity = await createIntegrity(bytes(canonicalJson(tamperedLock.lock)));
  assert.equal((await verifyKeelModuleLock(snapshot, tamperedLock)).valid, false);
  const duplicateLock = structuredClone(lock);
  duplicateLock.lock.requests.push(duplicateLock.lock.requests[0]);
  duplicateLock.lock.resolutions.push(duplicateLock.lock.resolutions[0]);
  duplicateLock.integrity = await createIntegrity(bytes(canonicalJson(duplicateLock.lock)));
  assert.equal((await verifyKeelModuleLock(snapshot, duplicateLock)).valid, false);
  const changed = createKeelModuleResolverSnapshot({ ...value.catalog, releases: value.catalog.releases.map((item) => item.identity.name === "three" && item.identity.version === "0.180.0" ? { ...item, sourceRepository: "changed" } : item) }, value.metadata);
  assert.equal((await verifyKeelModuleLock(changed, lock)).valid, false);
});

test("resolver rejects malformed metadata, duplicate release keys, unsupported fields, and invalid catalog entries", async () => {
  const value = await fixture();
  assert.throws(() => parseKeelModuleResolverSnapshot({
    schema: "keel-module-resolver-catalog@1",
    catalog: { ...value.catalog, releases: [...value.catalog.releases, value.catalog.releases[2]] },
    metadata: value.metadata,
  }), /Duplicate/u);
  assert.throws(() => parseKeelModuleResolverSnapshot({
    schema: "keel-module-resolver-catalog@1",
    catalog: { ...value.catalog, releases: [{ ...value.catalog.releases[0], identity: { ...value.catalog.releases[0].identity, namespace: "evil" } }] },
    metadata: [],
  }), /namespace/u);
  assert.throws(() => parseKeelModuleResolverSnapshot({
    schema: "keel-module-resolver-catalog@1",
    catalog: value.catalog,
    metadata: [{ releaseKey: "npm:three@0.180.0/dist/index.js", tags: ["renderer", "RENDERER"] }],
  }), /unique/u);
  assert.throws(() => parseKeelModuleResolverSnapshot({
    schema: "keel-module-resolver-catalog@1",
    catalog: { ...value.catalog, releases: [{ ...value.catalog.releases[0], identity: { ...value.catalog.releases[0].identity, entry: "dist\\\\..\\\\index.js" } }] },
    metadata: [],
  }), /safe relative/u);
  assert.throws(() => parseKeelModuleResolverSnapshot({
    schema: "keel-module-resolver-catalog@1",
    catalog: { ...value.catalog, releases: [{ ...value.catalog.releases[0], identity: { ...value.catalog.releases[0].identity, entry: "bad\uD800.js" } }] },
    metadata: [],
  }), /Unicode/u);
});

test("CLI resolves JSON or concise output and writes an unavailable-by-default lock receipt", async () => {
  const value = await fixture();
  const directory = await mkdtemp(path.join("/tmp", "keel-module-cli-"));
  try {
    const snapshotPath = path.join(directory, "modules.snapshot.json");
    const lockPath = path.join(directory, "keel.lock.json");
    await writeFile(snapshotPath, `${JSON.stringify(createKeelModuleResolverSnapshot(value.catalog, value.metadata), null, 2)}\n`);
    const cli = path.resolve("packages/builder/dist/cli.js");
    const json = JSON.parse(execFileSync(process.execPath, [cli, "module-resolve", snapshotPath, "--name", "three", "--version", "0.180.0", "--json"], { encoding: "utf8" }));
    assert.equal(json.status, "resolved");
    assert.equal(json.bytes, "unavailable");
    const summary = execFileSync(process.execPath, [cli, "module-resolve", snapshotPath, "--name", "three", "--version", "0.180.0"], { encoding: "utf8" });
    assert.match(summary, /Resolved npm:three@0\.180\.0\/dist\/index\.js/u);
    const lockJson = JSON.parse(execFileSync(process.execPath, [cli, "module-lock", snapshotPath, "--out", lockPath, "--name", "three", "--version", "0.180.0", "--json"], { encoding: "utf8" }));
    assert.equal(lockJson.lock.lock.schema, "keel-module-lock@1");
    assert.equal(lockJson.receipt.receipt.statuses[0].bytes, "unavailable");
    const receipt = JSON.parse(await readFile(`${lockPath}.receipt.json`, "utf8"));
    assert.equal(receipt.receipt.statuses[0].bytes, "unavailable");
    const symlinkPath = path.join(directory, "linked.snapshot.json");
    await symlink(snapshotPath, symlinkPath);
    assert.throws(
      () => execFileSync(process.execPath, [cli, "module-resolve", symlinkPath, "--name", "three", "--version", "0.180.0"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      (error) => String(error?.stderr ?? "").includes("regular non-symlink"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
