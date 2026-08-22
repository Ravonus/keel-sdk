/**
 * The same proofs as `keel-module-assurance`, run against the real thing.
 *
 * The workspace under test is the public keel-modules checkout next to this
 * repository, copied to a temporary directory so the run is read-only, and the
 * public GitHub repository itself. Three claims are checked end to end:
 *
 *   1. every shipped module rebuilds reproducibly, and its vectors pass on the
 *      readable source AND on the minified bytes destined for chain;
 *   2. the committed `catalog/catalog.json` the site reads is what indexing
 *      this workspace produces, digest for digest;
 *   3. a stranger holding only the GitHub path and commit gets the exact
 *      published output digest back, which is the whole open-source claim.
 *
 * The workspace half is skipped when the sibling checkout is absent; the GitHub
 * half is skipped when the archive cannot be fetched. A digest that comes back
 * WRONG is never a skip.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, createIntegrity, keelBuildRecipeDigest, utf8ToBytes } from "../packages/protocol/dist/index.js";
import { verifyKeelModuleFromOrigin } from "../packages/builder/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repositoryRoot, "packages/builder/dist/cli.js");
const workspaceRoot = path.resolve(repositoryRoot, "../keel-modules");
const catalogRepository = "https://github.com/Ravonus/keel-modules";

const EXPECTED_MODULES = 11;
const EXPECTED_VECTORS = 65;

async function directoryExists(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

const workspacePresent = await directoryExists(workspaceRoot);
const skipWorkspace = workspacePresent ? false : `${workspaceRoot} is not checked out next to this repository.`;

function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024, ...options });
}

/** The tracked tree only: no .git, no installed packages, no previous dist. */
async function copyWorkspace(t) {
  const copy = await mkdtemp(path.join(os.tmpdir(), "keel-modules-reproduction-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(workspaceRoot, copy, {
    recursive: true,
    filter: (source) => ![".git", "node_modules", "dist"].includes(path.basename(source)),
  });
  return copy;
}

async function moduleIds(root) {
  const entries = await readdir(path.join(root, "modules"), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function distDigests(root, ids) {
  const digests = {};
  for (const id of ids) {
    digests[id] = (await createIntegrity(new Uint8Array(await readFile(path.join(root, "modules", id, "dist", `${id}.min.js`))))).digest;
  }
  return digests;
}

test("every published module rebuilds reproducibly, twice, with both compactor candidates recorded", { skip: skipWorkspace }, async (t) => {
  const root = await copyWorkspace(t);
  const ids = await moduleIds(root);
  assert.equal(ids.length, EXPECTED_MODULES, `expected ${EXPECTED_MODULES} modules, found ${ids.join(", ")}`);

  const { stdout } = await runCli(["module", "build", "--all", "--root", root]);
  const built = [...stdout.matchAll(/^Built modules\/([a-z0-9-]+) \(\d+ bytes; (\S+)\)\.$/gmu)];
  assert.deepEqual(built.map((match) => match[1]), ids);
  for (const match of built) assert.equal(match[2], "reproducible-build", `${match[1]} did not earn a byte proof`);

  for (const id of ids) {
    const moduleDirectory = path.join(root, "modules", id);
    const recipe = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-build-recipe.json"), "utf8"));
    const receipt = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-source-receipt.json"), "utf8"));
    const shipped = new Uint8Array(await readFile(path.join(moduleDirectory, "dist", `${id}.min.js`)));
    const shippedDigest = (await createIntegrity(shipped)).digest;

    assert.equal(recipe.protocol, "keel-build-recipe@2", `${id} skipped the compact stage`);
    const { esbuild, terser } = recipe.compact.candidateBytes;
    assert.ok(esbuild > 0 && terser > 0, `${id} did not record both candidate sizes`);
    // Terser ships only when it is strictly smaller; a tie keeps esbuild's bytes.
    assert.equal(recipe.compact.winner, terser < esbuild ? "terser" : "esbuild", `${id} shipped the wrong candidate`);
    assert.equal(shipped.byteLength, recipe.compact.winner === "terser" ? terser : esbuild, `${id} shipped neither candidate`);

    assert.equal(shippedDigest, recipe.output.integrity.digest, `${id} dist bytes are not the recipe's output`);
    assert.equal(receipt.output.digest, shippedDigest, `${id} receipt does not cover the dist bytes`);
    assert.equal(receipt.disposition, "reproducible-build");
    assert.equal(receipt.buildRecipeDigest, await keelBuildRecipeDigest(recipe));
  }

  // Determinism is the load-bearing property for third-party reproduction:
  // the same tree, built again, must produce the same bytes and the same recipe.
  const first = await distDigests(root, ids);
  const firstRecipes = Object.fromEntries(await Promise.all(ids.map(async (id) => [
    id,
    await keelBuildRecipeDigest(JSON.parse(await readFile(path.join(root, "modules", id, "dist/keel-build-recipe.json"), "utf8"))),
  ])));
  await runCli(["module", "build", "--all", "--root", root]);
  assert.deepEqual(await distDigests(root, ids), first, "a second build produced different bytes");
  const secondRecipes = Object.fromEntries(await Promise.all(ids.map(async (id) => [
    id,
    await keelBuildRecipeDigest(JSON.parse(await readFile(path.join(root, "modules", id, "dist/keel-build-recipe.json"), "utf8"))),
  ])));
  assert.deepEqual(secondRecipes, firstRecipes, "a second build produced a different recipe");
});

test("every vector passes on the readable source and on the shipped minified bytes", { skip: skipWorkspace }, async (t) => {
  const root = await copyWorkspace(t);
  const ids = await moduleIds(root);
  await runCli(["module", "build", "--all", "--root", root]);
  const { stdout } = await runCli(["module", "test", "--all", "--root", root]);

  assert.doesNotMatch(stdout, /skipped/u, "every published module must ship vectors");
  const passed = [...stdout.matchAll(/^modules\/([a-z0-9-]+): passed \((\d+) vectors\)$/gmu)];
  assert.deepEqual(passed.map((match) => match[1]), ids);
  const total = passed.reduce((sum, match) => sum + Number(match[2]), 0);
  assert.equal(total, EXPECTED_VECTORS, `expected ${EXPECTED_VECTORS} vectors across the workspace, ran ${total}`);
});

test("indexing the workspace reproduces the committed catalog, digest for digest", { skip: skipWorkspace }, async (t) => {
  const root = await copyWorkspace(t);
  await runCli(["module", "build", "--all", "--root", root]);
  await runCli(["module", "index", "--root", root, "--repository", catalogRepository]);

  const regeneratedText = await readFile(path.join(root, "catalog/catalog.json"), "utf8");
  const committedText = await readFile(path.join(workspaceRoot, "catalog/catalog.json"), "utf8");
  const regenerated = JSON.parse(regeneratedText);
  const committed = JSON.parse(committedText);

  assert.equal(regenerated.schema, "keel-module-catalog@1");
  assert.deepEqual(
    regenerated.modules.map((entry) => entry.id),
    committed.modules.map((entry) => entry.id),
  );
  // Everything the site shows next to the word "verified" is recomputed here.
  for (const [index, entry] of regenerated.modules.entries()) {
    const published = committed.modules[index];
    assert.deepEqual({ ...entry, builtAt: null }, { ...published, builtAt: null }, `${entry.id} drifted from the committed catalog`);
  }

  // Byte level, line by line: the only lines allowed to differ are `builtAt`,
  // which `keel module index` takes from the receipt file's mtime. Every digest
  // in the file reproduces exactly; the timestamp cannot, which is why a
  // stranger diffing their own re-index against the published catalog has to
  // know to ignore one field. Recorded here rather than papered over.
  const regeneratedLines = regeneratedText.split("\n");
  const committedLines = committedText.split("\n");
  assert.equal(regeneratedLines.length, committedLines.length);
  const differing = regeneratedLines.filter((line, index) => line !== committedLines[index]);
  for (const line of differing) assert.match(line, /"builtAt"/u, `an unexpected catalog line differs: ${line}`);
});

test("the receipt chain recomputes link by link, from readable files to catalog entry", { skip: skipWorkspace }, async (t) => {
  const root = await copyWorkspace(t);
  const id = "noise2d";
  await runCli(["module", "build", "--all", "--root", root]);
  await runCli(["module", "index", "--root", root, "--repository", catalogRepository]);

  const moduleDirectory = path.join(root, "modules", id);
  const recipe = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-build-recipe.json"), "utf8"));
  const receipt = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-source-receipt.json"), "utf8"));
  const catalog = JSON.parse(await readFile(path.join(root, "catalog/catalog.json"), "utf8"));
  const published = JSON.parse(await readFile(path.join(workspaceRoot, "catalog/catalog.json"), "utf8"));
  const entry = catalog.modules.find((module) => module.id === id);
  const publishedEntry = published.modules.find((module) => module.id === id);

  // Link 1: each readable file on disk hashes to what the recipe and the
  // catalog say it does. This is the file a reader actually opens on GitHub.
  assert.ok(recipe.inputs.length > 0);
  for (const [index, input] of recipe.inputs.entries()) {
    const digest = (await createIntegrity(new Uint8Array(await readFile(path.join(moduleDirectory, input.path))))).digest;
    assert.equal(input.integrity.digest, digest, `${input.path} is not what the recipe records`);
    assert.equal(entry.sourceFiles[index].path, `modules/${id}/${input.path}`);
    assert.equal(entry.sourceFiles[index].sha256, digest);
    assert.equal(publishedEntry.sourceFiles[index].sha256, digest, "the published catalog names different source bytes");
  }

  // Link 2: the concatenated readable graph is the receipt's source side.
  const sourceBytes = Buffer.concat(await Promise.all(recipe.inputs.map((input) => readFile(path.join(moduleDirectory, input.path)))));
  assert.equal(receipt.source.digest, (await createIntegrity(new Uint8Array(sourceBytes))).digest);

  // Link 3: the recipe digest binds inputs, toolchain, options, and compact
  // stage together, and the receipt commits to exactly that digest.
  const recipeDigest = await keelBuildRecipeDigest(recipe);
  assert.equal(receipt.buildRecipeDigest, recipeDigest);
  assert.equal(receipt.verification.buildRecipeDigest, recipeDigest);

  // Link 4: the shipped bytes are the recipe's output and the receipt's output.
  const shippedDigest = (await createIntegrity(new Uint8Array(await readFile(path.join(moduleDirectory, "dist", `${id}.min.js`))))).digest;
  assert.equal(recipe.output.integrity.digest, shippedDigest);
  assert.equal(receipt.output.digest, shippedDigest);
  assert.equal(receipt.verification.rebuiltOutput.digest, shippedDigest);
  assert.equal(entry.outputDigest, shippedDigest);
  assert.equal(publishedEntry.outputDigest, shippedDigest, "the published catalog names different on-chain bytes");

  // Link 5: the readability report inside the receipt is self-committing.
  assert.equal(receipt.reportDigest, (await createIntegrity(utf8ToBytes(canonicalJson(receipt.report)))).digest);

  // Link 6: the receipt digest the catalog carries is the digest of the receipt.
  const receiptDigest = (await createIntegrity(utf8ToBytes(canonicalJson(receipt)))).digest;
  assert.equal(entry.receiptDigest, receiptDigest);
  assert.equal(publishedEntry.receiptDigest, receiptDigest, "the published catalog names a different receipt");

  // Link 7: only a byte proof is allowed to be called verified.
  assert.equal(entry.disposition, "reproducible-build");
  assert.equal(entry.verified, true);
});

/** The commit GitHub can serve for this checkout, when the checkout is clean. */
async function publishedCommit() {
  const status = await execFileAsync("git", ["-C", workspaceRoot, "status", "--porcelain"]);
  if (status.stdout.trim().length > 0) return undefined;
  const head = await execFileAsync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"]);
  return head.stdout.trim();
}

test("a stranger with only the GitHub path reproduces the published on-chain bytes", { skip: skipWorkspace }, async (t) => {
  const commit = await publishedCommit();
  if (commit === undefined) {
    t.skip("the keel-modules checkout has uncommitted changes, so its catalog is not what GitHub serves.");
    return;
  }
  const published = JSON.parse(await readFile(path.join(workspaceRoot, "catalog/catalog.json"), "utf8"));

  for (const id of ["noise2d", "palette"]) {
    const entry = published.modules.find((module) => module.id === id);
    assert.ok(entry !== undefined, `${id} is missing from the published catalog`);

    let status = 0;
    let verified;
    try {
      verified = await verifyKeelModuleFromOrigin({
        origin: { protocol: "keel-source-origin@1", provider: "github", owner: "Ravonus", repo: "keel-modules", commit, visibility: "public" },
        identity: { namespace: "keel", name: id, version: entry.version, entry: entry.githubPath },
        recipeRoot: `modules/${id}`,
        entry: "src/index.ts",
        compact: { keepComments: false },
        mediaType: "text/javascript",
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          status = response.status;
          return response;
        },
      });
    } catch (error) {
      // No archive, no proof, but also no false failure: only a fetch that
      // succeeded and then disagreed is a real finding.
      if (status !== 200) {
        t.diagnostic(`skipping GitHub reproduction of ${id}: ${error instanceof Error ? error.message : String(error)}`);
        t.skip(`the keel-modules archive at ${commit} could not be fetched.`);
        return;
      }
      throw error;
    }

    assert.equal(verified.verification.verdict, "reproduced", verified.verification.issues.join("; "));
    assert.equal(verified.receipt.disposition, "reproducible-build");
    assert.equal(verified.recipe.output.integrity.digest, entry.outputDigest, `${id} did not reproduce the published output digest`);
    assert.equal((await createIntegrity(verified.outputBytes)).digest, entry.outputDigest);
    assert.equal(verified.receipt.repository.url, catalogRepository);
    assert.equal(verified.receipt.repository.revision, commit);
    // The independently fetched archive is pinned by digest, so a forge that
    // serves two different trees for one commit cannot do it silently.
    assert.match(verified.archiveIntegrity.digest, /^0x[0-9a-f]{64}$/u);
    assert.equal(verified.indexEntry.origin.archiveIntegrity.digest, verified.archiveIntegrity.digest);
  }
});
