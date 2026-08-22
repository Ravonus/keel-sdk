/**
 * Registering a module whose source lives in somebody else's repository.
 *
 * The load-bearing property is the split. Indexing must read only committed
 * files, so the catalog stays deterministic and a stranger can check it by
 * regenerating it; re-deriving the digests from the network is a separate verb
 * that is allowed to fail loudly. These tests hold that line from both sides:
 * indexing runs with `fetch` rigged to throw, and verification is fed a forge
 * that lies.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bumpKeelModuleRegistration,
  indexKeelWorkspace,
  parseKeelModuleRegistration,
  registerKeelModuleFromOrigin,
  verifyKeelWorkspaceRegistrations,
} from "../packages/builder/dist/index.js";

/* A minimal tar.gz of a foreign repository, in GitHub's <repo>-<commit>/ shape. */
function tar(files) {
  const blocks = [];
  const encoder = new TextEncoder();
  for (const [name, contents] of Object.entries(files)) {
    const body = encoder.encode(contents);
    const header = new Uint8Array(512);
    const put = (text, at) => header.set(encoder.encode(text), at);
    put(name, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    header[156] = 0x30;
    put("ustar\0", 257);
    put("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body, 0);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const COMMIT = "c".repeat(40);

/** Plain JavaScript, no tsconfig, no src/, no manifest: none of our business. */
const FOREIGN = {
  [`stranger-${COMMIT.slice(0, 4)}/lib/main.mjs`]:
    'import { tint } from "./tint.mjs";\nexport const paint = (n) => tint(n) + "!";\n',
  [`stranger-${COMMIT.slice(0, 4)}/lib/tint.mjs`]: 'export const tint = (n) => `#${n.toString(16)}`;\n',
  [`stranger-${COMMIT.slice(0, 4)}/Makefile`]: "all:\n\techo not our business\n",
};

const ORIGIN = { provider: "github", owner: "stranger", repo: "stranger", commit: COMMIT, entry: "lib/main.mjs" };

function forge(files) {
  return async () => new Response(await gzip(tar(files)), { status: 200 });
}

async function workspaceWithRegistration(t, { files = FOREIGN } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "keel-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "modules/solo"), { recursive: true });
  await writeFile(path.join(root, "modules/solo/publisher.json"), `${JSON.stringify({
    schema: "keel.publisher@1", kind: "user", id: "solo", title: "Solo", summary: "One person.",
    url: "https://github.com/solo", identityId: null, members: [], groups: [],
  }, null, 2)}\n`);
  const outDirectory = path.join(root, "modules/solo/render/painter");
  const result = await registerKeelModuleFromOrigin({
    origin: ORIGIN,
    id: "painter",
    version: "1.0.0",
    license: "MIT",
    summary: "Paints things.",
    category: "render",
    owner: { user: "solo" },
    outDirectory,
    fetchImpl: forge(files),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  return { root, outDirectory, result };
}

test("registering records what a verification found, and refuses to invent it", async (t) => {
  const { outDirectory, result } = await workspaceWithRegistration(t);
  const written = parseKeelModuleRegistration(JSON.parse(await readFile(path.join(outDirectory, "keel.registration.json"), "utf8")));

  assert.equal(written.id, "painter");
  assert.equal(written.origin.commit, COMMIT);
  assert.equal(written.origin.entry, "lib/main.mjs");
  // Only the files the entry imports; the Makefile is not our concern.
  assert.deepEqual(written.expect.sourceFiles.map((file) => file.path), ["lib/main.mjs", "lib/tint.mjs"]);
  for (const field of ["sourceDigest", "outputDigest", "receiptDigest", "archiveDigest"]) {
    assert.match(written.expect[field], /^0x[0-9a-f]{64}$/u, `${field} must be a real digest`);
  }
  assert.equal(written.expect.outputDigest, result.registration.expect.outputDigest);

  // A source that cannot be built is never written down as verified.
  await assert.rejects(
    () => registerKeelModuleFromOrigin({
      origin: ORIGIN, id: "broken", version: "1.0.0", license: "MIT", summary: "Broken.",
      category: "render", owner: { user: "solo" }, outDirectory,
      fetchImpl: forge({ [`stranger-${COMMIT.slice(0, 4)}/lib/main.mjs`]: "export const paint = (\n" }),
    }),
    /Refusing to register/u,
  );
});

test("a branch or tag is refused, because a proof pinned to a moving ref expires silently", () => {
  assert.throws(
    () => parseKeelModuleRegistration({
      schema: "keel.registration@1", id: "x", version: "1.0.0", license: "MIT", summary: "x",
      category: "render", owner: { user: "solo" }, repository: "https://github.com/a/b",
      origin: { provider: "github", owner: "a", repo: "b", commit: "master", entry: "index.js" },
      expect: {
        sourceDigest: `0x${"1".repeat(64)}`, outputDigest: `0x${"1".repeat(64)}`,
        receiptDigest: `0x${"1".repeat(64)}`, archiveDigest: `0x${"1".repeat(64)}`,
        sourceFiles: [{ path: "index.js", sha256: `0x${"1".repeat(64)}` }],
      },
      verifiedAt: "2026-01-01T00:00:00.000Z",
    }),
    /full commit hash, not a branch or tag/u,
  );
});

test("indexing a registration never touches the network", async (t) => {
  const { root } = await workspaceWithRegistration(t);

  // The guarantee, enforced rather than asserted: if indexing reaches for the
  // network at all, this throws and the test fails. A catalog that depends on
  // what a forge served that afternoon is not reproducible.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("indexing touched the network"); };
  try {
    const { catalog } = await indexKeelWorkspace(root, {});
    assert.equal(catalog.modules.length, 1);
    const entry = catalog.modules[0];
    assert.equal(entry.id, "painter");
    assert.equal(entry.provenance, "origin");
    assert.equal(entry.verified, true);
    assert.equal(entry.deployed, false);
    assert.equal(entry.origin.owner, "stranger");
    assert.equal(entry.origin.commit, COMMIT);
    assert.equal(entry.sourceRepository, "https://github.com/stranger/stranger");
    // Paths point into the FOREIGN repository, where a reader finds the files.
    assert.equal(entry.githubPath, "lib/main.mjs");
    assert.deepEqual(entry.sourceFiles.map((file) => file.path), ["lib/main.mjs", "lib/tint.mjs"]);
    // The listing path still resolves, and a user owns it directly.
    assert.deepEqual(entry.owner, { publisher: "solo", kind: "user", group: null, member: null });
  } finally {
    globalThis.fetch = realFetch;
  }

  // Re-indexing is a no-op diff: nothing in the entry came from a clock.
  const first = await readFile(path.join(root, "catalog/catalog.json"), "utf8");
  await indexKeelWorkspace(root, {});
  assert.equal(await readFile(path.join(root, "catalog/catalog.json"), "utf8"), first);
});

test("verification re-derives the digests and fails loudly on drift", async (t) => {
  const { root, outDirectory } = await workspaceWithRegistration(t);

  const clean = await verifyKeelWorkspaceRegistrations(root, { fetchImpl: forge(FOREIGN) });
  assert.equal(clean.length, 1);
  assert.equal(clean[0].reproduced, true, clean[0].mismatches.join("; "));

  // The forge serves a DIFFERENT tree for the same commit. Every committed
  // digest disagrees, and none of them are quietly adopted as the new truth.
  const swapped = {
    ...FOREIGN,
    [`stranger-${COMMIT.slice(0, 4)}/lib/tint.mjs`]: 'export const tint = (n) => `rgb(${n})`;\n',
  };
  const drifted = await verifyKeelWorkspaceRegistrations(root, { fetchImpl: forge(swapped) });
  assert.equal(drifted[0].reproduced, false);
  const joined = drifted[0].mismatches.join("\n");
  assert.match(joined, /outputDigest: registered 0x/u);
  assert.match(joined, /archiveDigest: registered 0x/u);
  assert.match(joined, /source file changed: lib\/tint\.mjs/u);

  // A hand-edited registration that claims a digest the source does not produce
  // is the same failure from the other direction.
  const file = path.join(outDirectory, "keel.registration.json");
  const registration = JSON.parse(await readFile(file, "utf8"));
  registration.expect.outputDigest = `0x${"ab".repeat(32)}`;
  await writeFile(file, `${JSON.stringify(registration, null, 2)}\n`);
  const lying = await verifyKeelWorkspaceRegistrations(root, { fetchImpl: forge(FOREIGN) });
  assert.equal(lying[0].reproduced, false);
  assert.match(lying[0].mismatches.join("\n"), /outputDigest: registered 0xabababab/u);
});

test("a registered id cannot collide with a vendored one", async (t) => {
  const { root } = await workspaceWithRegistration(t);
  // Same id, vendored this time: the catalog would have two entries claiming
  // to be the same module, and the site keys on id.
  const directory = path.join(root, "modules/solo/render/painter-vendored");
  await mkdir(path.join(directory, "src"), { recursive: true });
  await writeFile(path.join(directory, "keel.module.json"), `${JSON.stringify({
    schema: "keel.jsmodule@2", id: "painter", entry: "src/index.ts", license: "MIT",
    summary: "Collides.", category: "render", owner: { user: "solo" },
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: { target: "es2022", module: "es2022", moduleResolution: "bundler", strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true },
    include: ["src"],
  }, null, 2)}\n`);
  await writeFile(path.join(directory, "src/index.ts"), "export const paint = (n: number): string => String(n);\n");

  await assert.rejects(() => indexKeelWorkspace(root, {}), /Duplicate module id/u);
});

test("bumping re-verifies at the new commit instead of trusting the edit", async (t) => {
  const { outDirectory } = await workspaceWithRegistration(t);
  const NEXT = "d".repeat(40);
  const nextFiles = {
    [`stranger-${NEXT.slice(0, 4)}/lib/main.mjs`]:
      'import { tint } from "./tint.mjs";\nexport const paint = (n) => tint(n) + "?";\n',
    [`stranger-${NEXT.slice(0, 4)}/lib/tint.mjs`]: 'export const tint = (n) => `#${n.toString(16)}`;\n',
  };

  const before = parseKeelModuleRegistration(JSON.parse(await readFile(path.join(outDirectory, "keel.registration.json"), "utf8")));
  const result = await bumpKeelModuleRegistration({
    directory: outDirectory,
    commit: NEXT,
    version: "2.0.0",
    fetchImpl: forge(nextFiles),
    now: () => new Date("2026-02-02T00:00:00.000Z"),
  });

  const after = parseKeelModuleRegistration(JSON.parse(await readFile(path.join(outDirectory, "keel.registration.json"), "utf8")));
  assert.equal(after.origin.commit, NEXT);
  assert.equal(after.version, "2.0.0");
  assert.equal(after.verifiedAt, "2026-02-02T00:00:00.000Z");
  // Every digest is what the NEW rebuild produced, not the old ones carried over.
  assert.notEqual(after.expect.outputDigest, before.expect.outputDigest);
  assert.notEqual(after.expect.sourceDigest, before.expect.sourceDigest);
  assert.ok(result.changed.includes("outputDigest"), result.changed.join(", "));
  // Identity is untouched: a bump is a new version, not a new module.
  assert.equal(after.id, before.id);
  assert.equal(after.origin.owner, before.origin.owner);
  assert.equal(after.origin.repo, before.origin.repo);

  // A bump to a commit that does not build leaves the registration alone.
  await assert.rejects(
    () => bumpKeelModuleRegistration({
      directory: outDirectory,
      commit: "e".repeat(40),
      fetchImpl: forge({ [`stranger-eeee/lib/main.mjs`]: "export const paint = (\n" }),
    }),
    /Refusing to bump/u,
  );
  const unchanged = parseKeelModuleRegistration(JSON.parse(await readFile(path.join(outDirectory, "keel.registration.json"), "utf8")));
  assert.equal(unchanged.origin.commit, NEXT, "a refused bump must not touch the file");

  // Re-pinning to the commit it already has is a mistake, not a no-op.
  await assert.rejects(
    () => bumpKeelModuleRegistration({ directory: outDirectory, commit: NEXT, fetchImpl: forge(nextFiles) }),
    /already registered at/u,
  );
});

test("a bump reports honestly when the new commit changes nothing", async (t) => {
  const { outDirectory } = await workspaceWithRegistration(t);
  // A commit that touched only files the entry never imports: same build, same
  // bytes. Saying "bumped" without saying "nothing moved" would imply a change.
  const NEXT = "d".repeat(40);
  const sameBuild = {
    [`stranger-${NEXT.slice(0, 4)}/lib/main.mjs`]: FOREIGN[`stranger-${COMMIT.slice(0, 4)}/lib/main.mjs`],
    [`stranger-${NEXT.slice(0, 4)}/lib/tint.mjs`]: FOREIGN[`stranger-${COMMIT.slice(0, 4)}/lib/tint.mjs`],
    [`stranger-${NEXT.slice(0, 4)}/CHANGELOG.md`]: "# 2.0.0\n",
  };
  const result = await bumpKeelModuleRegistration({
    directory: outDirectory,
    commit: NEXT,
    fetchImpl: forge(sameBuild),
    now: () => new Date("2026-02-02T00:00:00.000Z"),
  });
  // The bytes that would go on chain are identical, and so is the readable
  // source they came from.
  assert.equal(result.registration.expect.outputDigest, result.previous.expect.outputDigest);
  assert.equal(result.registration.expect.sourceDigest, result.previous.expect.sourceDigest);
  // Two things still move, and both are correct. The archive differs because
  // the tree does, even though the build does not. The receipt differs because
  // it pins the revision it was verified at, which is the point of recording
  // one: the same bytes verified at a different commit is a different claim.
  assert.deepEqual(result.changed, ["receiptDigest", "archiveDigest"]);
});
