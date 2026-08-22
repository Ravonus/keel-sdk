import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  KEEL_BUILD_RECIPE_PROTOCOL,
  KEEL_MODULE_INDEX_PROTOCOL,
  KEEL_SOURCE_ORIGIN_PROTOCOL,
  assertValidKeelBuildRecipe,
  assertValidKeelModuleIndex,
  assertValidKeelSourceOrigin,
  canonicalJson,
  createIntegrity,
  diffKeelBuildRecipes,
  sortKeelModuleIndex,
  keelBuildRecipeDigest,
  keelModuleKey,
  keelModuleLinkIssues,
  keelSourceArchiveUrl,
  keelSourceOriginUrl,
  keelSourceRepositoryRef,
  utf8ToBytes,
} from "../packages/protocol/dist/index.js";
import {
  createKeelBuildRecipe,
  createKeelModuleSourceReceipt,
  verifyKeelBuildRecipe,
  verifyKeelModuleFromOrigin,
} from "../packages/builder/dist/index.js";

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "keel-recipe-"));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

const MODULE = {
  "src/index.js": 'import { greet } from "./greet.js";\nexport const hello = (name) => greet(name);\n',
  "src/greet.js": "export const greet = (name) => `hello ${name}`;\n",
  "src/unused.js": "export const unused = () => 0;\n",
};

// -------------------------------------------------------------- the recipe

test("a recipe pins the resolved graph, not the directory", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    // `src/unused.js` is in the folder and not in the build. A recipe that
    // pinned a directory would change every time an unrelated file was added,
    // which is the difference between pinning a build and pinning a workspace.
    assert.deepEqual(recipe.inputs.map((input) => input.path), ["src/greet.js", "src/index.js"]);
    assert.equal(recipe.protocol, KEEL_BUILD_RECIPE_PROTOCOL);
    assert.equal(recipe.tool.name, "esbuild");
    assert.match(recipe.tool.version, /^\d+\.\d+\.\d+$/u);
    assert.equal(recipe.entry, "src/index.js");
    assert.equal(recipe.options.minify, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same source rebuilds to the same bytes, and the recipe says so", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe, recipeDigest, outputBytes } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    const verification = await verifyKeelBuildRecipe({ recipe, root });
    assert.equal(verification.verdict, "reproduced");
    assert.equal(verification.reproduced, true);
    assert.deepEqual(verification.issues, []);
    assert.equal(verification.recipeDigest, recipeDigest);
    assert.deepEqual(verification.rebuiltBytes, outputBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed input is reported as a changed input, not as an unexplained mismatch", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    await writeFile(path.join(root, "src/greet.js"), "export const greet = (name) => `HELLO ${name}`;\n");
    const verification = await verifyKeelBuildRecipe({ recipe, root });
    assert.equal(verification.verdict, "source-changed");
    assert.equal(verification.reproduced, false);
    // Naming the file is the whole value: "it did not match" sends people hunting.
    assert.ok(verification.issues.some((issue) => issue === "input changed: src/greet.js"), verification.issues.join("; "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file added to the graph is caught even when the output happens to be reachable", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    await writeFile(path.join(root, "src/extra.js"), "export const extra = () => 1;\n");
    await writeFile(
      path.join(root, "src/index.js"),
      'import { greet } from "./greet.js";\nimport { extra } from "./extra.js";\nexport const hello = (name) => greet(name) + extra();\n',
    );
    const verification = await verifyKeelBuildRecipe({ recipe, root });
    assert.equal(verification.verdict, "source-changed");
    assert.ok(verification.issues.some((issue) => issue === "input added: src/extra.js"), verification.issues.join("; "));
    assert.ok(verification.issues.some((issue) => issue === "input changed: src/index.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the digest moves for every input that changes the bytes", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe, recipeDigest } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    const bump = async (mutate) => keelBuildRecipeDigest({ ...recipe, ...mutate });
    assert.notEqual(recipeDigest, await bump({ tool: { name: "esbuild", version: "0.0.1" } }));
    assert.notEqual(recipeDigest, await bump({ options: { ...recipe.options, minify: false } }));
    assert.notEqual(recipeDigest, await bump({ options: { ...recipe.options, target: "es2020" } }));
    assert.notEqual(
      recipeDigest,
      await bump({ output: { ...recipe.output, integrity: { ...recipe.output.integrity, digest: `0x${"cd".repeat(32)}` } } }),
    );
    // The digest covers the pairing of recipe and output, so a recipe and an
    // output that were never each other's cannot be recombined under one hash.
    const swapped = { ...recipe, output: { ...recipe.output, integrity: { ...recipe.output.integrity, byteLength: 1 } } };
    assert.notEqual(recipeDigest, await keelBuildRecipeDigest(swapped));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recipe that cannot be re-run is refused when it is written, not when it is used", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    assert.throws(() => assertValidKeelBuildRecipe({ ...recipe, entry: "src/missing.js" }), /entry must appear/u);
    assert.throws(
      () => assertValidKeelBuildRecipe({ ...recipe, inputs: [...recipe.inputs].reverse() }),
      /sorted by path and unique/u,
    );
    assert.throws(() => assertValidKeelBuildRecipe({ ...recipe, entry: "../escape.js" }), /safe relative path/u);
    assert.throws(
      () => assertValidKeelBuildRecipe({ ...recipe, tool: { name: "esbuild", version: "^1.0.0" } }),
      /exact version/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the receipt's reproducible-build disposition is earned by rebuilding", async () => {
  const root = await fixture(MODULE);
  try {
    const { recipe, recipeDigest, outputBytes } = await createKeelBuildRecipe({ root, entry: "src/index.js" });
    const sourceBytes = new TextEncoder().encode(MODULE["src/index.js"]);
    const { receipt } = await createKeelModuleSourceReceipt({
      recipe,
      root,
      sourceBytes,
      repository: { url: "https://github.com/example/mod", revision: "a".repeat(40), path: "src/index.js" },
    });
    assert.equal(receipt.disposition, "reproducible-build");
    assert.equal(receipt.verification.buildRecipeDigest, recipeDigest);
    assert.equal(receipt.output.byteLength, outputBytes.length);
    assert.equal(receipt.report.classification, "readable");

    // And it is refused when the rebuild does not reproduce, rather than filed
    // with a disposition nobody checked.
    await writeFile(path.join(root, "src/greet.js"), "export const greet = () => `no`;\n");
    await assert.rejects(
      () => createKeelModuleSourceReceipt({ recipe, root, sourceBytes }),
      /did not reproduce \(source-changed\)/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the diff separates a changed checkout from a changed toolchain", () => {
  const base = {
    protocol: KEEL_BUILD_RECIPE_PROTOCOL,
    tool: { name: "esbuild", version: "0.28.2" },
    entry: "src/index.js",
    inputs: [{ path: "src/index.js", integrity: { algorithm: "sha256", digest: `0x${"11".repeat(32)}`, byteLength: 10 } }],
    options: {
      format: "esm", target: "es2022", platform: "browser",
      minify: true, bundle: true, legalComments: "none", charset: "ascii",
    },
    output: { mediaType: "text/javascript", integrity: { algorithm: "sha256", digest: `0x${"22".repeat(32)}`, byteLength: 5 } },
  };
  assert.deepEqual(diffKeelBuildRecipes(base, base), []);
  const other = { ...base, tool: { name: "esbuild", version: "0.29.0" } };
  assert.ok(diffKeelBuildRecipes(base, other).some((issue) => issue.startsWith("tool:")));
});

// --------------------------------------------------------- the source origin

test("an origin must be public and pinned to something that cannot move", () => {
  const origin = {
    protocol: KEEL_SOURCE_ORIGIN_PROTOCOL,
    provider: "github",
    owner: "keel-modules",
    repo: "keel-rpc-view",
    commit: "b".repeat(40),
    path: "src",
    visibility: "public",
  };
  assert.equal(assertValidKeelSourceOrigin(origin), origin);
  assert.equal(
    keelSourceOriginUrl(origin),
    `https://github.com/keel-modules/keel-rpc-view/tree/${"b".repeat(40)}/src`,
  );
  assert.equal(
    keelSourceArchiveUrl(origin),
    `https://codeload.github.com/keel-modules/keel-rpc-view/tar.gz/${"b".repeat(40)}`,
  );
  assert.deepEqual(keelSourceRepositoryRef(origin, "src/index.js"), {
    url: "https://github.com/keel-modules/keel-rpc-view",
    revision: "b".repeat(40),
    path: "src/index.js",
  });

  // A branch or tag moves; a receipt pinned to one expires without saying so.
  assert.throws(() => assertValidKeelSourceOrigin({ ...origin, commit: "main" }), /full commit hash/u);
  assert.throws(() => assertValidKeelSourceOrigin({ ...origin, commit: "v1.0.0" }), /full commit hash/u);
  // Private source cannot be re-verified by anyone else, so it is not a source
  // this system will record a verification against.
  assert.throws(() => assertValidKeelSourceOrigin({ ...origin, visibility: "private" }), /must be public/u);
  assert.throws(() => assertValidKeelSourceOrigin({ ...origin, path: "../etc" }), /safe relative path/u);
  // A provider with no archive resolver fails loudly rather than silently
  // producing a URL nobody can fetch.
  assert.throws(() => keelSourceArchiveUrl({ ...origin, provider: "somewhere" }), /No archive resolver/u);
});

// ---------------------------------------------------------- the module index

const entry = (name, version = "1.0.0") => ({
  identity: { namespace: "keel", name, version, entry: "dist/index.js" },
  origin: {
    protocol: KEEL_SOURCE_ORIGIN_PROTOCOL,
    provider: "github",
    owner: "keel-modules",
    repo: name,
    commit: "c".repeat(40),
    visibility: "public",
  },
  recipeDigest: `0x${"33".repeat(32)}`,
  output: { algorithm: "sha256", digest: `0x${"44".repeat(32)}`, byteLength: 2810 },
  workspace: { path: `packages/viewer/src/${name}.js` },
});

test("the index has one canonical form and refuses a duplicate module", () => {
  const modules = sortKeelModuleIndex([entry("rpc-view"), entry("asset-view")]);
  const index = { protocol: KEEL_MODULE_INDEX_PROTOCOL, canonicalDigest: "sha256", modules };
  assert.equal(assertValidKeelModuleIndex(index), index);
  assert.deepEqual(modules.map((item) => keelModuleKey(item.identity)), [
    "keel/asset-view@1.0.0",
    "keel/rpc-view@1.0.0",
  ]);
  assert.throws(
    () => assertValidKeelModuleIndex({ ...index, modules: [...modules].reverse() }),
    /sorted by module key/u,
  );
  assert.throws(
    () => assertValidKeelModuleIndex({ ...index, modules: [entry("rpc-view"), entry("rpc-view")] }),
    /sorted by module key and unique/u,
  );
  // Two versions of one module are distinct entries, not a duplicate.
  assert.doesNotThrow(() =>
    assertValidKeelModuleIndex({
      ...index,
      modules: sortKeelModuleIndex([entry("rpc-view", "1.0.0"), entry("rpc-view", "1.1.0")]),
    }),
  );
});

test("the monorepo link is a check only when both halves agree", () => {
  const item = entry("rpc-view");
  assert.deepEqual(keelModuleLinkIssues(item, { workspace: { path: item.workspace.path } }), []);
  assert.equal(keelModuleLinkIssues(item, {}).length, 1);
  assert.match(
    keelModuleLinkIssues(item, { workspace: { path: "packages/elsewhere.js" } })[0],
    /declares workspace packages\/elsewhere\.js; the index says/u,
  );
  assert.match(keelModuleLinkIssues({ ...item, workspace: undefined }, {})[0], /no workspace slot/u);
});

// ------------------------------------------------- fetch, verify, discard

/** A real ustar archive, so the reader is exercised rather than a stand-in. */
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
    header[156] = 0x30; // regular file
    put("ustar\0", 257);
    put("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
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

const ORIGIN = {
  protocol: KEEL_SOURCE_ORIGIN_PROTOCOL,
  provider: "github",
  owner: "keel-modules",
  repo: "demo-module",
  commit: "d".repeat(40),
  visibility: "public",
};

const IDENTITY = { namespace: "keel", name: "demo-module", version: "1.0.0", entry: "dist/index.js" };

test("a public repo at a commit is fetched, built, and verified without keeping the source", async () => {
  const archive = await gzip(
    tar({
      // GitHub wraps everything in <repo>-<commit>/, which the reader strips.
      "demo-module-dddd/src/index.js": 'import { greet } from "./greet.js";\nexport const hello = () => greet("world");\n',
      "demo-module-dddd/src/greet.js": "export const greet = (who) => `hello ${who}`;\n",
      "demo-module-dddd/README.md": "# demo\n",
    }),
  );
  let requested;
  const result = await verifyKeelModuleFromOrigin({
    origin: ORIGIN,
    identity: IDENTITY,
    entry: "src/index.js",
    workspacePath: "packages/viewer/src/demo-module.js",
    fetchImpl: async (url) => {
      requested = url;
      return new Response(archive, { status: 200 });
    },
  });

  assert.equal(requested, `https://codeload.github.com/keel-modules/demo-module/tar.gz/${"d".repeat(40)}`);
  assert.equal(result.verification.verdict, "reproduced");
  assert.equal(result.receipt.disposition, "reproducible-build");
  assert.equal(result.receipt.repository.revision, "d".repeat(40));
  assert.deepEqual(result.recipe.inputs.map((input) => input.path), ["src/greet.js", "src/index.js"]);
  assert.ok(result.outputBytes.length > 0);
  // The archive is hashed before anything is unpacked, so the receipt names the
  // exact bytes that were built rather than trusting the forge to be stable.
  assert.equal(result.archiveIntegrity.byteLength, archive.length);
  assert.equal(result.indexEntry.origin.archiveIntegrity.digest, result.archiveIntegrity.digest);
  assert.equal(result.indexEntry.recipeDigest, result.recipeDigest);

  // The entry is valid input for the monorepo index without further shaping.
  assert.doesNotThrow(() =>
    assertValidKeelModuleIndex({
      protocol: KEEL_MODULE_INDEX_PROTOCOL,
      canonicalDigest: "sha256",
      modules: [result.indexEntry],
    }),
  );
});

test("a submitted archive cannot write outside the checkout or be served from any host", async () => {
  const archive = await gzip(
    tar({
      "demo-module-dddd/src/index.js": "export const hello = () => 1;\n",
      // Traversal in a creator-submitted tarball: read, refused, not written.
      "demo-module-dddd/../../../etc/keel-owned": "pwned\n",
      "demo-module-dddd/nested/../../escape": "pwned\n",
    }),
  );
  const result = await verifyKeelModuleFromOrigin({
    origin: ORIGIN,
    identity: IDENTITY,
    entry: "src/index.js",
    fetchImpl: async () => new Response(archive, { status: 200 }),
  });
  assert.equal(result.verification.verdict, "reproduced");
  assert.deepEqual(result.recipe.inputs.map((input) => input.path), ["src/index.js"]);

  // An archive host is governed the same way an RPC endpoint is.
  await assert.rejects(
    () =>
      verifyKeelModuleFromOrigin({
        origin: ORIGIN,
        identity: IDENTITY,
        entry: "src/index.js",
        sourceHosts: ["codeload.example.com"],
        fetchImpl: async () => new Response(archive, { status: 200 }),
      }),
    /archive host is not permitted/u,
  );
});

test("an oversized archive is refused before it is unpacked", async () => {
  const archive = await gzip(tar({ "demo-module-dddd/src/index.js": "export const hello = () => 1;\n" }));
  await assert.rejects(
    () =>
      verifyKeelModuleFromOrigin({
        origin: ORIGIN,
        identity: IDENTITY,
        entry: "src/index.js",
        maxArchiveBytes: 16,
        fetchImpl: async () => new Response(archive, { status: 200 }),
      }),
    /the limit is 16/u,
  );
});

test("no source survives the call, on success or on failure", async (t) => {
  // The load-bearing promise of the whole design: Keel is not a code host.
  // A comment saying so is not a test, and a `finally` that stops running is
  // exactly the kind of regression nobody notices until a disk fills.
  //
  // The verifier builds its checkouts under os.tmpdir(), which is shared, so
  // this test gets its own to look at. Scanning the real one made the check
  // race every other test file that verifies an origin concurrently: it would
  // see their in-flight checkouts and blame this code for them.
  const previous = process.env.TMPDIR;
  const isolated = await mkdtemp(path.join(tmpdir(), "keel-leftovers-"));
  process.env.TMPDIR = isolated;
  t.after(async () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(isolated, { recursive: true, force: true });
  });

  const leftovers = async () =>
    (await readdir(isolated)).filter((name) => name.startsWith("keel-verify-"));
  assert.deepEqual(await leftovers(), [], "a previous run left a checkout behind");

  const good = await gzip(tar({ "demo-module-dddd/src/index.js": "export const hello = () => 1;\n" }));
  await verifyKeelModuleFromOrigin({
    origin: ORIGIN,
    identity: IDENTITY,
    entry: "src/index.js",
    fetchImpl: async () => new Response(good, { status: 200 }),
  });
  assert.deepEqual(await leftovers(), [], "a successful verification kept the checkout");

  // The failure path is the one that matters: a build that throws must not be
  // the path that quietly retains somebody's repository.
  const broken = await gzip(tar({ "demo-module-dddd/src/index.js": "export const hello = (\n" }));
  await assert.rejects(() =>
    verifyKeelModuleFromOrigin({
      origin: ORIGIN,
      identity: IDENTITY,
      entry: "src/index.js",
      fetchImpl: async () => new Response(broken, { status: 200 }),
    }),
  );
  assert.deepEqual(await leftovers(), [], "a failed verification kept the checkout");
});

test("verification imposes no language, layout, or house style on somebody else's repository", async () => {
  // Deliberately everything the keel-modules workspace is not: plain
  // JavaScript with no TypeScript anywhere, no tsconfig.json, no src/
  // directory, no test vectors, no keel.module.json, a nested entry at a path
  // we would never choose, and a CommonJS-flavoured filename extension.
  //
  // Keel's strictness rules are house rules for the Keel repository. Outside
  // it they are none of our business: the only thing a verification can
  // legitimately demand of a stranger's code is that it builds deterministically
  // to the bytes being claimed. If this test ever needs a tsconfig to pass, an
  // opinion has leaked out of our tree and into other people's.
  const archive = await gzip(
    tar({
      "demo-module-dddd/lib/deep/nested/entry.mjs":
        'import { shade } from "../../palette.mjs";\nexport const paint = (n) => shade(n) + "!";\n',
      "demo-module-dddd/lib/palette.mjs": 'export const shade = (n) => `#${n.toString(16)}`;\n',
      "demo-module-dddd/Makefile": "all:\n\techo not our business\n",
      "demo-module-dddd/README.txt": "no license header, no vectors, no manifest\n",
    }),
  );
  const result = await verifyKeelModuleFromOrigin({
    origin: ORIGIN,
    identity: IDENTITY,
    entry: "lib/deep/nested/entry.mjs",
    fetchImpl: async () => new Response(archive, { status: 200 }),
  });

  assert.equal(result.verification.verdict, "reproduced");
  assert.equal(result.receipt.disposition, "reproducible-build");
  // Only the files the entry actually imports are pinned. The Makefile and the
  // README are not our concern and are not in the recipe.
  assert.deepEqual(
    result.recipe.inputs.map((input) => input.path),
    ["lib/deep/nested/entry.mjs", "lib/palette.mjs"],
  );
  assert.ok(result.outputBytes.length > 0);
});

test("an origin verification's receiptDigest is the same digest the catalog computes", async () => {
  // These were computed two different ways: the catalog canonicalises the
  // receipt, this path used JSON.stringify. Same receipt, different digest, so
  // comparing a catalog entry against an origin verification reported a
  // mismatch that was not real. Every other digest in the system is over
  // canonical bytes; this one is now too.
  const archive = await gzip(
    tar({
      "demo-module-dddd/src/index.js": 'import { greet } from "./greet.js";\nexport const hello = () => greet("world");\n',
      "demo-module-dddd/src/greet.js": "export const greet = (who) => `hello ${who}`;\n",
    }),
  );
  const result = await verifyKeelModuleFromOrigin({
    origin: ORIGIN,
    identity: IDENTITY,
    entry: "src/index.js",
    fetchImpl: async () => new Response(archive, { status: 200 }),
  });
  const canonical = (await createIntegrity(utf8ToBytes(canonicalJson(result.receipt)))).digest;
  assert.equal(result.indexEntry.receiptDigest, canonical);
});
