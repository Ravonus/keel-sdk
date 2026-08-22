import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createIntegrity, keelBuildRecipeDigest, canonicalJson, utf8ToBytes } from "../packages/protocol/dist/index.js";
import { verifyKeelPublishReviewPlan } from "../packages/sdk/dist/index.js";
import { verifyKeelBuildRecipe } from "../packages/builder/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repositoryRoot, "packages/builder/dist/cli.js");

function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, ...options });
}

test("the builder bin is keel with oca kept as a compatibility alias", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "packages/builder/package.json"), "utf8"));
  assert.equal(manifest.bin.keel, "./dist/cli.js");
  assert.equal(manifest.bin.oca, "./dist/cli.js");
  const { stdout } = await runCli(["help"]);
  assert.match(stdout, /keel module init <dir>/u);
  assert.match(stdout, /keel module build <dir>/u);
  assert.match(stdout, /keel module plan <dir>/u);
});

test("keel module init -> build -> plan produces recomputable digests and a review-only plan", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "keel-module-pipeline-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const moduleDirectory = path.join(workspace, "demo-module");

  const init = await runCli(["module", "init", moduleDirectory]);
  assert.match(init.stdout, /Scaffolded demo-module/u);
  const manifest = JSON.parse(await readFile(path.join(moduleDirectory, "keel.module.json"), "utf8"));
  assert.equal(manifest.protocol, "keel-module-manifest@1");
  assert.equal(manifest.name, "demo-module");
  assert.equal(manifest.entry, "src/index.ts");
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.sourceRepository.url.length > 0, "sourceRepository placeholder must exist");
  const tsconfig = JSON.parse(await readFile(path.join(moduleDirectory, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true);
  assert.equal(tsconfig.compilerOptions.exactOptionalPropertyTypes, true);
  const entrySource = await readFile(path.join(moduleDirectory, "src/index.ts"), "utf8");
  assert.match(entrySource, /export function createModule/u);
  assert.match(entrySource, /ModuleContext/u);
  await assert.rejects(() => runCli(["module", "init", moduleDirectory]), /already exists/u);

  const build = await runCli(["module", "build", moduleDirectory]);
  assert.match(build.stdout, /reproducible-build/u);
  assert.match(build.stdout, /source digest: {2}0x[0-9a-f]{64}/u);
  assert.match(build.stdout, /output digest: {2}0x[0-9a-f]{64}/u);
  assert.match(build.stdout, /receipt digest: 0x[0-9a-f]{64}/u);

  const outputBytes = new Uint8Array(await readFile(path.join(moduleDirectory, "dist/demo-module.min.js")));
  const recipe = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-build-recipe.json"), "utf8"));
  const receipt = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-source-receipt.json"), "utf8"));

  // The recipe digest and output commitment must recompute from what is on disk.
  const outputIntegrity = await createIntegrity(outputBytes);
  assert.equal(recipe.output.integrity.digest, outputIntegrity.digest);
  assert.equal(receipt.output.digest, outputIntegrity.digest);
  const recipeDigest = await keelBuildRecipeDigest(recipe);
  assert.equal(receipt.buildRecipeDigest, recipeDigest);
  assert.equal(receipt.verification.buildRecipeDigest, recipeDigest);
  assert.equal(receipt.disposition, "reproducible-build");
  assert.equal(receipt.protocol, "keel-source-receipt@1");
  const receiptDigest = (await createIntegrity(utf8ToBytes(canonicalJson(receipt)))).digest;
  assert.match(build.stdout, new RegExp(`receipt digest: ${receiptDigest}`, "u"));

  // A third party re-running the recipe against the same tree reproduces it.
  const reverified = await verifyKeelBuildRecipe({ recipe, root: moduleDirectory });
  assert.equal(reverified.verdict, "reproduced");

  const plan = await runCli(["module", "plan", moduleDirectory]);
  assert.match(plan.stdout, /review-only/u);
  const envelope = JSON.parse(await readFile(path.join(moduleDirectory, "dist/keel-publish-plan.json"), "utf8"));
  const verdict = await verifyKeelPublishReviewPlan(envelope);
  assert.equal(verdict.valid, true, verdict.issues.join("; "));
  assert.equal(envelope.plan.protocol, "keel-publish-plan@1");
  assert.equal(envelope.plan.status, "review-only");
  assert.equal(envelope.plan.chainReady, false);
  assert.equal(envelope.plan.signing, "not-performed");
  assert.equal(envelope.plan.submission, "not-performed");
  assert.equal(envelope.plan.target.chainId, 11155111);
  assert.equal(envelope.plan.source.objectName, "demo-module.min.js");
  const kinds = envelope.plan.operations.map((operation) => operation.kind);
  assert.deepEqual(kinds.slice(-1), ["weldObject"]);
  assert.ok(kinds.slice(0, -1).every((kind) => kind === "castSlugs"));
  const weld = envelope.plan.operations.at(-1).descriptor;
  assert.equal(weld.digest.digest, outputIntegrity.digest);
  assert.equal(weld.byteLength, outputBytes.byteLength);
});

test("keel module build fails closed on strict typecheck errors and weakened tsconfigs", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "keel-module-strict-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const moduleDirectory = path.join(workspace, "loose-module");
  await runCli(["module", "init", moduleDirectory]);

  const entryPath = path.join(moduleDirectory, "src/index.ts");
  const entrySource = await readFile(entryPath, "utf8");
  await writeFile(entryPath, `${entrySource}\nexport const broken: number = "not a number";\n`);
  await assert.rejects(() => runCli(["module", "build", moduleDirectory]), /Strict typecheck failed/u);
  await writeFile(entryPath, entrySource);

  const tsconfigPath = path.join(moduleDirectory, "tsconfig.json");
  const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
  tsconfig.compilerOptions.exactOptionalPropertyTypes = false;
  await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2));
  await assert.rejects(() => runCli(["module", "build", moduleDirectory]), /exactOptionalPropertyTypes/u);
});

test("keel module plan refuses stale output that no longer matches the recipe", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "keel-module-stale-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const moduleDirectory = path.join(workspace, "stale-module");
  await runCli(["module", "init", moduleDirectory]);
  await assert.rejects(() => runCli(["module", "plan", moduleDirectory]), /module build/u);
  await runCli(["module", "build", moduleDirectory]);
  await writeFile(path.join(moduleDirectory, "dist/stale-module.min.js"), "export const tampered = true;\n");
  await assert.rejects(() => runCli(["module", "plan", moduleDirectory]), /no longer matches/u);
});
