import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("the container harness declares required modules and proves default verification", async () => {
  const declaration = JSON.parse(await readFile("examples/immutable-three-one-of-one/keel.modules.json", "utf8"));
  assert.equal(declaration.schema, "keel-publication-harness@1");
  assert.equal(declaration.publication.storageMode, "native-carrier-v1");
  assert.equal(declaration.publication.maxChunkBytes, 23_000);
  assert.equal(declaration.publication.maxChunksPerCarrierTransaction, 3);
  assert.ok(declaration.modules.filter(({ required }) => required).every(({ address, package: packageName }) => address ?? packageName));

  const { stdout } = await execFileAsync(process.execPath, ["examples/immutable-three-one-of-one/run.mjs"]);
  const proof = JSON.parse(stdout);
  assert.equal(proof.status, "passed");
  assert.equal(proof.artifact.immutable, true);
  assert.equal(proof.artifact.edition.size, 1);
  assert.equal(proof.artifact.storageMode, "native-carrier-v1");
  assert.ok(proof.artifact.storedBytes < proof.artifact.decodedBytes);
  assert.ok(proof.batching.sceneChunks >= 1);
  assert.equal(proof.batching.maxChunksPerCarrierTransaction, 3);
  assert.equal(proof.batching.walletApprovalRequests, 1);
  assert.equal(proof.batching.executorTransactions, 0);
  assert.equal(proof.gas.executorEscrowWei, "0");
  assert.equal(proof.gas.scope, "native scene and manifest storage lane only");
  assert.equal(proof.gas.tokenPresentationGas, null);
  assert.equal(proof.verification.manifestDigestVerified, true);
  assert.equal(proof.verification.entrypointBytesVerified, true);
  assert.equal(proof.verification.sandbox, "strict");
  assert.deepEqual(proof.verification.sandboxTokens, ["allow-scripts"]);
  assert.equal(proof.verification.cspBlocksNetwork, true);
  assert.equal(proof.publicSubmissionReady, false);
  assert.equal(proof.signingPerformed, false);
  assert.equal(proof.walletTransactionsSent, 0);
});
