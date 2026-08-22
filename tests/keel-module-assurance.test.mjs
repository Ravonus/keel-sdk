/**
 * The assurance suite for the module pipeline: what a stranger can actually
 * prove about a Keel module, and what happens when somebody lies about it.
 *
 * `builder-module-pipeline` and `builder-module-workspace` cover that the verbs
 * work. This file covers the claim they exist to support: the readable
 * TypeScript in the open repository is hash-bound to the exact minified bytes
 * destined for chain, every link in that chain recomputes from the files on
 * disk, and each of the ways the chain could be forged is detected rather than
 * absorbed.
 *
 * Companion: `keel-modules-reproduction.test.mjs` runs the same proofs against
 * the real public keel-modules workspace and against GitHub itself.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, createIntegrity, keelBuildRecipeDigest, utf8ToBytes } from "../packages/protocol/dist/index.js";
import { verifyKeelBuildRecipe } from "../packages/builder/dist/index.js";
import { wrapInVerificationShell } from "../packages/sdk/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repositoryRoot, "packages/builder/dist/cli.js");
/** Resolved the way the builder itself resolves them, not from a guessed path. */
const toolchain = createRequire(cli);

function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, ...options });
}

/** A tiny, real module: two exported functions with exact, non-floaty vectors. */
const BEAT_GRID_SOURCE = `/**
 * beat-grid: snap times onto a musical beat grid.
 *
 * Readable and strict here; minified for chain by \`keel module build\`, with a
 * receipt binding the two. This doc comment is deliberately long enough to
 * tamper with without changing a single byte of the minified output.
 */

/** Seconds per beat at a tempo. */
export function beatSeconds(beatsPerMinute: number): number {
  if (!Number.isFinite(beatsPerMinute) || beatsPerMinute <= 0) {
    throw new RangeError("beatsPerMinute must be a finite positive number.");
  }
  return 60 / beatsPerMinute;
}

/** Snap a time in seconds onto the nearest beat. */
export function quantize(seconds: number, beatsPerMinute: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("seconds must be a finite, non-negative number.");
  }
  const beat = beatSeconds(beatsPerMinute);
  return Math.round(seconds / beat) * beat;
}
`;

const BEAT_GRID_VECTORS = `export default [
  { name: "a beat at 120bpm is half a second", run: (m) => m.beatSeconds(120), expect: 0.5 },
  { name: "0.51s snaps back onto the beat", run: (m) => m.quantize(0.51, 120), expect: 0.5 },
  { name: "1.3s snaps forward to 1.5", run: (m) => m.quantize(1.3, 120), expect: 1.5 },
  {
    name: "a negative time is refused",
    run: (m) => {
      try {
        m.quantize(-1, 120);
        return "no throw";
      } catch (error) {
        return error.name;
      }
    },
    expect: "RangeError",
  },
];
`;

/** Hand-minified and behavior-preserving: what an agent or a person would hand back. */
const EQUIVALENT_CANDIDATE = `export function beatSeconds(b){if(!Number.isFinite(b)||b<=0)throw new RangeError("beatsPerMinute must be a finite positive number.");return 60/b}
export function quantize(s,b){if(!Number.isFinite(s)||s<0)throw new RangeError("seconds must be a finite, non-negative number.");const t=beatSeconds(b);return Math.round(s/t)*t}
`;

/** Same shape, floor instead of round: passes some vectors, fails one. */
const BROKEN_CANDIDATE = `export function beatSeconds(b){if(!Number.isFinite(b)||b<=0)throw new RangeError("beatsPerMinute must be a finite positive number.");return 60/b}
export function quantize(s,b){if(!Number.isFinite(s)||s<0)throw new RangeError("seconds must be a finite, non-negative number.");const t=beatSeconds(b);return Math.floor(s/t)*t}
`;

async function sha256File(filePath) {
  return (await createIntegrity(new Uint8Array(await readFile(filePath)))).digest;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function printedDigest(stdout, label) {
  const match = new RegExp(`${label} digest:\\s+(0x[0-9a-f]{64})`, "u").exec(stdout);
  assert.ok(match !== null, `${label} digest was not printed:\n${stdout}`);
  return match[1];
}

/** `keel module init` from zero, then a real function and its vectors on top. */
async function authorModule(t, { withVectors = true } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "keel-module-assurance-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const directory = path.join(workspace, "beat-grid");
  const { stdout } = await runCli(["module", "init", directory]);
  assert.match(stdout, /Scaffolded beat-grid in/u);
  await writeFile(path.join(directory, "src/index.ts"), BEAT_GRID_SOURCE);
  if (withVectors) {
    await mkdir(path.join(directory, "test"), { recursive: true });
    await writeFile(path.join(directory, "test/vectors.mjs"), BEAT_GRID_VECTORS);
  }
  return { workspace, directory };
}

test("an author goes from zero to a build that proves itself", async (t) => {
  const { directory } = await authorModule(t);
  const { stdout } = await runCli(["module", "build", directory]);

  const outputPath = path.join(directory, "dist/beat-grid.min.js");
  const recipePath = path.join(directory, "dist/keel-build-recipe.json");
  const receiptPath = path.join(directory, "dist/keel-source-receipt.json");
  for (const artifact of [outputPath, recipePath, receiptPath]) {
    assert.ok(await exists(artifact), `${artifact} was not written`);
  }

  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

  // Every printed number is the sha256 of something on disk, recomputed here.
  const outputDigest = await sha256File(outputPath);
  assert.equal(printedDigest(stdout, "output"), outputDigest);
  assert.equal(recipe.output.integrity.digest, outputDigest);
  assert.equal(receipt.output.digest, outputDigest);

  const sourceBytes = Buffer.concat(await Promise.all(recipe.inputs.map((input) => readFile(path.join(directory, input.path)))));
  const sourceDigest = (await createIntegrity(new Uint8Array(sourceBytes))).digest;
  assert.equal(printedDigest(stdout, "source"), sourceDigest);
  assert.equal(receipt.source.digest, sourceDigest);

  const receiptDigest = (await createIntegrity(utf8ToBytes(canonicalJson(receipt)))).digest;
  assert.equal(printedDigest(stdout, "receipt"), receiptDigest);

  // The disposition was earned by a rebuild, not asserted.
  assert.equal(receipt.disposition, "reproducible-build");
  assert.equal(receipt.verification.protocol, "keel-source-build-verification@1");
  assert.equal(receipt.verification.rebuiltOutput.digest, outputDigest);
  assert.equal(receipt.buildRecipeDigest, await keelBuildRecipeDigest(recipe));
  assert.equal(receipt.verification.buildRecipeDigest, receipt.buildRecipeDigest);

  // The recipe pins the toolchain by exact version, both stages of it.
  assert.equal(recipe.tool.name, "esbuild");
  assert.equal(recipe.tool.version, toolchain("esbuild/package.json").version);
  assert.match(recipe.tool.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(recipe.compact.tool.name, "terser");
  assert.equal(recipe.compact.tool.version, toolchain("terser/package.json").version);
  assert.match(recipe.compact.tool.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(recipe.options.minify, true);
  assert.equal(recipe.options.charset, "ascii");

  // The shipped bytes behave like the readable source on the author's vectors.
  const tested = await runCli(["module", "test", directory]);
  assert.match(tested.stdout, /beat-grid: passed/u);
  assert.match(tested.stdout, /4\/4 vectors/u);
});

test("the compactor ships the smaller candidate, records both sizes, and repeats byte for byte", async (t) => {
  const { directory } = await authorModule(t);
  await runCli(["module", "build", directory]);
  const outputPath = path.join(directory, "dist/beat-grid.min.js");
  const first = await readFile(outputPath);
  const recipe = JSON.parse(await readFile(path.join(directory, "dist/keel-build-recipe.json"), "utf8"));

  assert.equal(recipe.protocol, "keel-build-recipe@2");
  assert.ok(recipe.compact.candidateBytes.esbuild > 0);
  assert.ok(recipe.compact.candidateBytes.terser > 0);
  const { esbuild, terser } = recipe.compact.candidateBytes;
  // Terser only wins when it is strictly smaller; ties go to esbuild.
  assert.equal(recipe.compact.winner, terser < esbuild ? "terser" : "esbuild");
  assert.equal(first.byteLength, recipe.compact.winner === "terser" ? terser : esbuild);

  // Determinism: the same tree built twice produces the same bytes and the
  // same recipe digest, which is the whole basis for third-party reproduction.
  await runCli(["module", "build", directory]);
  const second = await readFile(outputPath);
  assert.deepEqual(new Uint8Array(second), new Uint8Array(first));
  const rebuiltRecipe = JSON.parse(await readFile(path.join(directory, "dist/keel-build-recipe.json"), "utf8"));
  assert.equal(await keelBuildRecipeDigest(rebuiltRecipe), await keelBuildRecipeDigest(recipe));
});

test("a stamped build reproduces byte exactly, and a stamp that closes its own comment is refused", async (t) => {
  const { directory } = await authorModule(t);
  const stampPath = path.join(directory, "stamp.txt");
  await writeFile(stampPath, "  KEEL / beat-grid\n  <>< on chain ><>\n");
  await runCli(["module", "build", directory, "--stamp", stampPath]);

  const outputPath = path.join(directory, "dist/beat-grid.min.js");
  const shipped = await readFile(outputPath, "utf8");
  assert.ok(shipped.startsWith("/*!\n  KEEL / beat-grid\n  <>< on chain ><>\n*/\n"), "the banner must lead the shipped bytes");

  const recipe = JSON.parse(await readFile(path.join(directory, "dist/keel-build-recipe.json"), "utf8"));
  const receipt = JSON.parse(await readFile(path.join(directory, "dist/keel-source-receipt.json"), "utf8"));
  assert.equal(recipe.compact.stamp.path, "stamp.txt");
  assert.equal(recipe.compact.stamp.integrity.digest, await sha256File(stampPath));
  assert.equal(receipt.disposition, "reproducible-build");
  assert.equal(receipt.output.digest, await sha256File(outputPath));

  const reproduced = await verifyKeelBuildRecipe({ recipe, root: directory });
  assert.equal(reproduced.verdict, "reproduced", reproduced.issues.join("; "));
  assert.equal(reproduced.rebuiltOutput.digest, receipt.output.digest);

  // 5d: swapping the stamp is an input change, named as one.
  await writeFile(stampPath, "  SOMEBODY ELSE\n");
  const swapped = await verifyKeelBuildRecipe({ recipe, root: directory });
  assert.equal(swapped.reproduced, false);
  assert.equal(swapped.verdict, "source-changed");
  assert.ok(swapped.issues.some((issue) => issue.includes("stamp.txt")), swapped.issues.join("; "));

  await writeFile(stampPath, "art */ export const backdoor = 1;\n");
  await assert.rejects(() => runCli(["module", "build", directory, "--stamp", stampPath]), /terminate its own banner/u);
});

test("--keep-comments puts legal comments on chain and still reproduces", async (t) => {
  const { directory } = await authorModule(t);
  await writeFile(path.join(directory, "src/index.ts"), `/*! beat-grid: MIT licensed Keel module. */\n${BEAT_GRID_SOURCE}`);
  await runCli(["module", "build", directory, "--keep-comments"]);
  const kept = await readFile(path.join(directory, "dist/beat-grid.min.js"), "utf8");
  assert.match(kept, /MIT licensed Keel module/u);

  const recipe = JSON.parse(await readFile(path.join(directory, "dist/keel-build-recipe.json"), "utf8"));
  assert.equal(recipe.options.legalComments, "inline");
  assert.equal(recipe.compact.options.keepComments, true);
  const reproduced = await verifyKeelBuildRecipe({ recipe, root: directory });
  assert.equal(reproduced.verdict, "reproduced", reproduced.issues.join("; "));

  await runCli(["module", "build", directory]);
  const stripped = await readFile(path.join(directory, "dist/beat-grid.min.js"), "utf8");
  assert.ok(!stripped.includes("MIT licensed"), "without the flag the comment is not on chain");
});

test("a hand-minified candidate earns behaviorally-verified and never more", async (t) => {
  const { directory, workspace } = await authorModule(t);
  await runCli(["module", "build", directory]);
  const candidatePath = path.join(workspace, "beat-grid.hand.js");
  await writeFile(candidatePath, EQUIVALENT_CANDIDATE);

  const { stdout } = await runCli(["module", "compact", directory, "--candidate", candidatePath]);
  assert.match(stdout, /matched the readable source on all 4 vectors/u);
  assert.match(stdout, /reproducible-build > behaviorally-verified/u);

  const receiptPath = path.join(directory, "dist/keel-candidate-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.disposition, "behaviorally-verified");
  assert.notEqual(receipt.disposition, "reproducible-build");
  assert.equal(receipt.verification, undefined, "a behavioral receipt never claims a rebuild");
  assert.equal(receipt.buildRecipeDigest, undefined, "and never points at a recipe it did not run");
  assert.equal(receipt.output.digest, await sha256File(candidatePath));

  // The evidence is the executed vectors: the vectors file by digest, and one
  // digest per vector over the canonical value the readable source produced.
  assert.equal(receipt.behavior.protocol, "keel-source-behavior-verification@1");
  assert.equal(receipt.behavior.vectorsDigest, await sha256File(path.join(directory, "test/vectors.mjs")));
  assert.equal(receipt.behavior.vectors.length, 4);
  assert.deepEqual(
    receipt.behavior.vectors.map((vector) => vector.name),
    [
      "a beat at 120bpm is half a second",
      "0.51s snaps back onto the beat",
      "1.3s snaps forward to 1.5",
      "a negative time is refused",
    ],
  );
  assert.equal(receipt.behavior.vectors[0].valueDigest, (await createIntegrity(utf8ToBytes(canonicalJson(0.5)))).digest);
  assert.equal(receipt.behavior.vectors[3].valueDigest, (await createIntegrity(utf8ToBytes(canonicalJson("RangeError")))).digest);

  // The shipped bytes stay the toolchain's; the candidate is a separate claim.
  const buildReceipt = JSON.parse(await readFile(path.join(directory, "dist/keel-source-receipt.json"), "utf8"));
  assert.equal(buildReceipt.disposition, "reproducible-build");
  assert.notEqual(buildReceipt.output.digest, receipt.output.digest);
});

test("a behavior-breaking candidate is rejected and leaves no receipt behind", async (t) => {
  const { directory, workspace } = await authorModule(t);
  await runCli(["module", "build", directory]);
  const candidatePath = path.join(workspace, "beat-grid.broken.js");
  await writeFile(candidatePath, BROKEN_CANDIDATE);

  await assert.rejects(
    () => runCli(["module", "compact", directory, "--candidate", candidatePath]),
    (error) => {
      assert.match(String(error.stderr), /diverges from the readable source on: 1\.3s snaps forward to 1\.5/u);
      assert.match(String(error.stderr), /no receipt/u);
      return true;
    },
  );
  assert.equal(await exists(path.join(directory, "dist/keel-candidate-receipt.json")), false);
});

test("a module with no vectors cannot be behaviorally verified at all", async (t) => {
  const { directory, workspace } = await authorModule(t, { withVectors: false });
  await runCli(["module", "build", directory]);
  const candidatePath = path.join(workspace, "beat-grid.hand.js");
  await writeFile(candidatePath, EQUIVALENT_CANDIDATE);
  await assert.rejects(
    () => runCli(["module", "compact", directory, "--candidate", candidatePath]),
    /vectors\.mjs not found/u,
  );
  assert.equal(await exists(path.join(directory, "dist/keel-candidate-receipt.json")), false);
});

test("5a: a readable source edit is caught even when the minified bytes do not move", async (t) => {
  const { directory } = await authorModule(t);
  await runCli(["module", "build", directory]);
  const recipe = JSON.parse(await readFile(path.join(directory, "dist/keel-build-recipe.json"), "utf8"));
  const receipt = JSON.parse(await readFile(path.join(directory, "dist/keel-source-receipt.json"), "utf8"));
  const entryPath = path.join(directory, "src/index.ts");
  const before = await readFile(entryPath, "utf8");
  assert.equal(recipe.inputs.length, 1);
  assert.equal(recipe.inputs[0].integrity.digest, await sha256File(entryPath));

  // One byte, inside a doc comment the minifier strips: the on-chain bytes are
  // unchanged, so only the source binding can catch this.
  const tampered = before.replace("snap times onto a musical beat grid", "snap times onto a musical beat gr1d");
  assert.notEqual(tampered, before);
  await writeFile(entryPath, tampered);

  assert.notEqual(await sha256File(entryPath), receipt.source.digest, "the readable source digest must move");
  const verdict = await verifyKeelBuildRecipe({ recipe, root: directory });
  assert.equal(verdict.reproduced, false);
  assert.equal(verdict.verdict, "source-changed");
  assert.deepEqual(verdict.issues, ["input changed: src/index.ts"]);
  // Proof that the drill is the hard one: the rebuilt bytes are identical.
  assert.equal(verdict.rebuiltOutput.digest, receipt.output.digest);
});

test("5b: a single flipped byte in the shipped output is caught by every consumer", async (t) => {
  const { directory } = await authorModule(t);
  await runCli(["module", "build", directory]);
  const outputPath = path.join(directory, "dist/beat-grid.min.js");
  const recipe = JSON.parse(await readFile(path.join(directory, "dist/keel-build-recipe.json"), "utf8"));
  const receipt = JSON.parse(await readFile(path.join(directory, "dist/keel-source-receipt.json"), "utf8"));

  const bytes = new Uint8Array(await readFile(outputPath));
  const target = bytes.indexOf(0x3d); // an "=" somewhere in the minified body
  assert.ok(target > 0, "expected an = in the minified output");
  bytes[target] = 0x3e;
  await writeFile(outputPath, bytes);

  const flipped = await sha256File(outputPath);
  assert.notEqual(flipped, recipe.output.integrity.digest);
  assert.notEqual(flipped, receipt.output.digest);
  // The plan verb refuses to chunk bytes the recipe no longer covers.
  await assert.rejects(() => runCli(["module", "plan", directory]), /no longer matches/u);
  // And a rebuild puts the recipe's bytes back, proving the recipe was right.
  await runCli(["module", "build", directory]);
  assert.equal(await sha256File(outputPath), recipe.output.integrity.digest);
});

test("5c: editing what the recipe records about the build breaks the recipe digest", async (t) => {
  const { directory } = await authorModule(t);
  await runCli(["module", "build", directory]);
  const recipePath = path.join(directory, "dist/keel-build-recipe.json");
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  const receipt = JSON.parse(await readFile(path.join(directory, "dist/keel-source-receipt.json"), "utf8"));
  assert.equal(await keelBuildRecipeDigest(recipe), receipt.buildRecipeDigest);

  // Any edit to a recorded option moves the recipe digest, so the receipt that
  // committed to the original recipe no longer covers the edited one. That is
  // the detector for this drill: `verifyKeelBuildRecipe` rebuilds *using* the
  // recipe's own options, so it answers "does this recipe reproduce its own
  // declared output", not "is this the recipe the receipt signed".
  const retargeted = { ...recipe, options: { ...recipe.options, target: "es2020" } };
  assert.notEqual(await keelBuildRecipeDigest(retargeted), receipt.buildRecipeDigest);

  // When the edited option does change the bytes, the rebuild says so too.
  const unminified = { ...recipe, options: { ...recipe.options, minify: false } };
  assert.notEqual(await keelBuildRecipeDigest(unminified), receipt.buildRecipeDigest);
  const verdict = await verifyKeelBuildRecipe({ recipe: unminified, root: directory });
  assert.equal(verdict.reproduced, false);
  assert.equal(verdict.verdict, "output-differs");
  assert.ok(verdict.issues.some((issue) => issue.startsWith("output:")), verdict.issues.join("; "));

  // The compact section is inside the digest too, so restating the winner lies loudly.
  const restated = { ...recipe, compact: { ...recipe.compact, winner: recipe.compact.winner === "terser" ? "esbuild" : "terser" } };
  assert.notEqual(await keelBuildRecipeDigest(restated), receipt.buildRecipeDigest);
  const compactVerdict = await verifyKeelBuildRecipe({ recipe: restated, root: directory });
  assert.equal(compactVerdict.reproduced, false);
  assert.ok(compactVerdict.issues.some((issue) => issue.includes("compact stage")), compactVerdict.issues.join("; "));
});

test("wrapInVerificationShell returns a self-contained document and a review-only plan", async () => {
  const assetBytes = utf8ToBytes("export const palette = [\"#05060b\", \"#d7ff63\"];\n");
  const result = await wrapInVerificationShell({
    repositoryRoot,
    title: "Assurance Smoke Piece",
    entry: {
      mediaType: "text/html",
      source: "<!doctype html><html><body><script type=\"module\">import { palette } from \"/content/palette.js\"; document.title = String(palette.length);</script></body></html>",
    },
    assets: [{ id: "palette", mediaType: "text/javascript", aliases: ["/content/palette.js"], bytes: assetBytes }],
  });

  // The shell is embedded, not linked.
  assert.match(result.html, /id="keel-verification-envelope"/u);
  assert.match(result.html, /keel-verification-presentation@1/u);
  assert.match(result.html, /id="verify-seal"/u);

  // Aliases resolve out of the embedded verified graph, and the produced
  // document contains no absolute URL at all: nothing to fetch, nothing to
  // swap, no CDN fallback for a resource the envelope already commits to.
  const asset = result.envelope.items.find((item) => item.id === "palette");
  assert.deepEqual(asset.aliases, ["/content/palette.js"]);
  assert.equal(asset.integrity.digest, (await createIntegrity(assetBytes)).digest);
  assert.deepEqual(result.html.match(/https?:\/\/[^\s"'`)<]+/gu), null, "the wrapped document must not reach off chain");

  // The plan is review-only from every angle, and carries no signature anywhere.
  assert.equal(result.publishPlan.plan.status, "review-only");
  assert.equal(result.publishPlan.plan.chainReady, false);
  assert.equal(result.publishPlan.plan.signing, "not-performed");
  assert.equal(result.publishPlan.plan.submission, "not-performed");
  assert.equal(result.publishPlan.plan.walletApproval, "required");
  assert.ok(!/signature|signedBy|privateKey/iu.test(JSON.stringify(result.publishPlan)), "a review-only plan carries no signature material");

  // What the plan commits to is exactly the bytes it returned.
  const htmlIntegrity = await createIntegrity(utf8ToBytes(result.html));
  assert.equal(result.htmlIntegrity.digest, htmlIntegrity.digest);
  assert.equal(result.publishPlan.plan.source.integrity.digest, htmlIntegrity.digest);
  assert.equal(result.sourceReceipt.output.digest, htmlIntegrity.digest);
});
