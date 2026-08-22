/**
 * Behavioral testing for the module pipeline: run a module's own test vectors
 * against the readable source build AND against the bytes that will actually
 * ship, and fail on any divergence between the two.
 *
 * The point is narrow and important. The reproducible-build receipt proves the
 * shipped bytes came from the readable source; this proves the shipped bytes
 * *behave* like the readable source on the inputs the author cared enough to
 * write down. For a toolchain-minified build the second check is a seatbelt.
 * For an externally-minified candidate (a human or an AI produced the bytes,
 * so no deterministic recipe exists) it is the only evidence there is, which
 * is why the candidate flow refuses to run without vectors and why the receipt
 * it emits carries the honest, weaker disposition "behaviorally-verified".
 * Trust order: reproducible-build > behaviorally-verified.
 *
 * Vectors convention: `<module>/test/vectors.mjs` exporting (default or named
 * `vectors`) an array of `{ name, run(moduleExports) -> value, expect }`.
 * Values must be JSON-serializable; each candidate executes in its own
 * subprocess with no arguments beyond the two file URLs, so a module cannot
 * reach back into the builder's process.
 */

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  verifySourceBehavior,
  type Hex,
  type KeelBehaviorVectorEvidence,
  type KeelSourceReceipt,
} from "@keel/protocol";
import { KEEL_MODULE_BUILD_OPTIONS, createKeelBuildRecipe } from "./build-recipe.js";
import { readKeelModuleManifest, type KeelModuleManifest } from "./module-pipeline.js";

const execFileAsync = promisify(execFile);

export const KEEL_MODULE_VECTORS_FILE = "test/vectors.mjs" as const;
const MAX_VECTORS = 256;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const VECTOR_TIMEOUT_MS = 30_000;

/**
 * The runner is a fixed script written next to the module copies, not code
 * assembled from the module's content, so nothing a module prints or exports
 * can splice into what the parent executes.
 */
const RUNNER_SOURCE = `import process from "node:process";
const [vectorsHref, moduleHref] = process.argv.slice(2);
const loaded = await import(vectorsHref);
const vectors = Array.isArray(loaded.default) ? loaded.default : loaded.vectors;
if (!Array.isArray(vectors) || vectors.length === 0) {
  process.stderr.write("vectors file must export a non-empty array (default or named 'vectors').");
  process.exit(3);
}
const moduleExports = await import(moduleHref);
const results = [];
for (const vector of vectors) {
  if (typeof vector?.name !== "string" || typeof vector?.run !== "function") {
    process.stderr.write("every vector needs a string name and a run(moduleExports) function.");
    process.exit(3);
  }
  const value = await vector.run(moduleExports);
  results.push({ name: vector.name, value: value === undefined ? null : value, expect: vector.expect === undefined ? null : vector.expect });
}
process.stdout.write(JSON.stringify(results));
`;

export interface KeelVectorRun {
  readonly name: string;
  /** Canonical JSON of the value the module produced. */
  readonly valueJson: string;
  /** Canonical JSON of the vector's declared expectation. */
  readonly expectJson: string;
}

interface RawVectorResult {
  readonly name: string;
  readonly value: unknown;
  readonly expect: unknown;
}

/** Execute the vectors file against one candidate's bytes in a clean subprocess. */
export async function runModuleVectors(vectorsPath: string, moduleBytes: Uint8Array): Promise<readonly KeelVectorRun[]> {
  const workspace = await mkdtemp(path.join(tmpdir(), "keel-vectors-"));
  try {
    const runnerPath = path.join(workspace, "runner.mjs");
    const modulePath = path.join(workspace, "candidate.mjs");
    await writeFile(runnerPath, RUNNER_SOURCE);
    await writeFile(modulePath, moduleBytes);
    const { stdout } = await execFileAsync(
      process.execPath,
      [runnerPath, pathToFileURL(path.resolve(vectorsPath)).href, pathToFileURL(modulePath).href],
      { cwd: workspace, maxBuffer: MAX_RESULT_BYTES, timeout: VECTOR_TIMEOUT_MS },
    );
    const results = JSON.parse(stdout) as readonly RawVectorResult[];
    if (!Array.isArray(results) || results.length === 0 || results.length > MAX_VECTORS) {
      throw new Error(`Vector run must produce 1 through ${MAX_VECTORS} results.`);
    }
    return results.map((result) => ({
      name: result.name,
      valueJson: canonicalJson(result.value),
      expectJson: canonicalJson(result.expect),
    }));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export interface KeelVectorComparison {
  readonly name: string;
  readonly matchesExpectation: boolean;
  readonly matchesSource: boolean;
}

export interface TestKeelModuleResult {
  readonly directory: string;
  readonly manifest: KeelModuleManifest;
  readonly vectorsPath: string;
  readonly shippedPath: string;
  readonly vectors: readonly KeelVectorComparison[];
  readonly passed: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hasModuleVectors(directory: string): Promise<boolean> {
  return fileExists(path.join(path.resolve(directory), KEEL_MODULE_VECTORS_FILE));
}

/** The readable (unminified) build of the module's entry graph. */
async function readableBuildBytes(root: string, entry: string): Promise<Uint8Array> {
  const built = await createKeelBuildRecipe({
    root,
    entry,
    options: { ...KEEL_MODULE_BUILD_OPTIONS, minify: false },
    mediaType: "text/javascript",
  });
  return built.outputBytes;
}

function compareRuns(
  sourceRuns: readonly KeelVectorRun[],
  candidateRuns: readonly KeelVectorRun[],
): readonly KeelVectorComparison[] {
  if (sourceRuns.length !== candidateRuns.length) {
    throw new Error("The two builds produced different vector counts, which should be impossible for one vectors file.");
  }
  return sourceRuns.map((sourceRun, index) => {
    const candidateRun = candidateRuns[index] as KeelVectorRun;
    if (sourceRun.name !== candidateRun.name) {
      throw new Error(`Vector order diverged: ${sourceRun.name} vs ${candidateRun.name}.`);
    }
    return {
      name: sourceRun.name,
      matchesExpectation: sourceRun.valueJson === sourceRun.expectJson && candidateRun.valueJson === candidateRun.expectJson,
      matchesSource: sourceRun.valueJson === candidateRun.valueJson,
    };
  });
}

async function runAgainstSourceAndCandidate(
  directory: string,
  candidateBytes: Uint8Array,
): Promise<{
  readonly manifest: KeelModuleManifest;
  readonly root: string;
  readonly vectorsPath: string;
  readonly sourceRuns: readonly KeelVectorRun[];
  readonly vectors: readonly KeelVectorComparison[];
}> {
  const root = path.resolve(directory);
  const manifest = await readKeelModuleManifest(root);
  const vectorsPath = path.join(root, KEEL_MODULE_VECTORS_FILE);
  if (!(await fileExists(vectorsPath))) {
    throw new Error(`${vectorsPath} not found. Behavioral testing needs the module's test vectors.`);
  }
  const sourceBytes = await readableBuildBytes(root, manifest.entry);
  const [sourceRuns, candidateRuns] = await Promise.all([
    runModuleVectors(vectorsPath, sourceBytes),
    runModuleVectors(vectorsPath, candidateBytes),
  ]);
  return { manifest, root, vectorsPath, sourceRuns, vectors: compareRuns(sourceRuns, candidateRuns) };
}

/**
 * `keel module test`: the shipped bytes in `dist/` must behave exactly like
 * the readable source build on every vector, and both must meet the vectors'
 * own expectations.
 */
export async function testKeelModule(directory: string): Promise<TestKeelModuleResult> {
  const root = path.resolve(directory);
  const manifest = await readKeelModuleManifest(root);
  const shippedPath = path.join(root, "dist", `${manifest.name}.min.js`);
  if (!(await fileExists(shippedPath))) {
    throw new Error(`${shippedPath} not found. Run "keel module build" first; the test runs the shipped bytes.`);
  }
  const shippedBytes = new Uint8Array(await readFile(shippedPath));
  const compared = await runAgainstSourceAndCandidate(root, shippedBytes);
  const passed = compared.vectors.every((vector) => vector.matchesExpectation && vector.matchesSource);
  return {
    directory: root,
    manifest,
    vectorsPath: compared.vectorsPath,
    shippedPath,
    vectors: compared.vectors,
    passed,
  };
}

export interface VerifyCandidateResult {
  readonly directory: string;
  readonly manifest: KeelModuleManifest;
  readonly candidatePath: string;
  readonly candidateByteLength: number;
  readonly vectors: readonly KeelVectorComparison[];
  readonly receipt: KeelSourceReceipt;
  readonly receiptPath: string;
  readonly receiptDigest: Hex;
}

/**
 * `keel module compact --candidate`: an externally-minified candidate (from a
 * human or an AI agent) earns at most "behaviorally-verified". Every vector
 * must match the readable source build's behavior and its own expectation;
 * the receipt records the vectors-file digest and one value digest per vector
 * as the executed evidence. No vectors, no verification: refuse.
 */
export async function verifyKeelModuleCandidate(directory: string, candidatePath: string): Promise<VerifyCandidateResult> {
  const resolvedCandidate = path.resolve(candidatePath);
  const candidateBytes = new Uint8Array(await readFile(resolvedCandidate));
  const compared = await runAgainstSourceAndCandidate(directory, candidateBytes);
  const failures = compared.vectors.filter((vector) => !vector.matchesExpectation || !vector.matchesSource);
  if (failures.length > 0) {
    throw new Error(
      `Candidate behavior diverges from the readable source on: ${failures.map((vector) => vector.name).join(", ")}. ` +
      "A diverging candidate gets no receipt.",
    );
  }
  // The readable source the receipt points at is the resolved graph, exactly
  // as `keel module build` frames it, so the two receipt kinds are comparable.
  const built = await createKeelBuildRecipe({
    root: compared.root,
    entry: compared.manifest.entry,
    options: KEEL_MODULE_BUILD_OPTIONS,
    mediaType: "text/javascript",
  });
  const sourceParts = await Promise.all(
    built.recipe.inputs.map(async (input) => new Uint8Array(await readFile(path.join(compared.root, input.path)))),
  );
  const sourceBytes = new Uint8Array(Buffer.concat(sourceParts));
  const vectorsDigest = (await createIntegrity(new Uint8Array(await readFile(compared.vectorsPath)))).digest;
  const evidence: readonly KeelBehaviorVectorEvidence[] = await Promise.all(
    compared.sourceRuns.map(async (run) => ({
      name: run.name,
      valueDigest: (await createIntegrity(utf8ToBytes(run.valueJson))).digest,
    })),
  );
  const receipt = await verifySourceBehavior({
    sourceBytes,
    outputBytes: candidateBytes,
    mediaType: "application/typescript",
    verifier: { name: "keel-module-vectors", version: "1.0.0" },
    vectorsDigest,
    vectors: evidence,
  });
  const distDirectory = path.join(compared.root, "dist");
  await mkdir(distDirectory, { recursive: true });
  const receiptPath = path.join(distDirectory, "keel-candidate-receipt.json");
  await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
  const receiptDigest = (await createIntegrity(utf8ToBytes(canonicalJson(receipt)))).digest;
  return {
    directory: compared.root,
    manifest: compared.manifest,
    candidatePath: resolvedCandidate,
    candidateByteLength: candidateBytes.byteLength,
    vectors: compared.vectors,
    receipt,
    receiptPath,
    receiptDigest,
  };
}
