import assert from "node:assert/strict";
import test from "node:test";

import { prepareKeelStudioProjectIntake } from "../packages/sdk/dist/studio-project-intake.js";

test("ambiguous requests ask once whether storage or release is wanted", () => {
  const result = prepareKeelStudioProjectIntake({ title: "Seed Current", description: "A p5 work." });
  assert.equal(result.status, "needs-input");
  assert.deepEqual(result.questions.map(({ field }) => field), ["outcome"]);
});

test("storage-only is complete and never invents a listing", () => {
  assert.deepEqual(prepareKeelStudioProjectIntake({
    title: "Seed Current",
    description: "A p5 work.",
    outcome: "storage-only",
  }), {
    status: "ready",
    title: "Seed Current",
    description: "A p5 work.",
    outcome: "storage-only",
  });
});

test("an explicit one-of-one release produces an editable immediate listing intent", () => {
  const result = prepareKeelStudioProjectIntake({
    title: "Seed Current",
    description: "A p5 work.",
    outcome: "release",
    chainId: 11_155_111,
    release: { type: "one-of-one", saleMechanism: "fixed-price", priceEth: "0.1" },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.releaseIntent.release.supply, "1");
  assert.equal(result.releaseIntent.release.priceEth, "0.1");
  assert.equal(result.releaseIntent.release.startsAt, null);
  assert.deepEqual(result.releaseIntent.wallet, { approvalRequiredNow: false, transactionSubmitted: false });
});

test("a release without chain or price stops for missing input", () => {
  const result = prepareKeelStudioProjectIntake({ title: "Seed Current", description: "A p5 work.", outcome: "release" });
  assert.equal(result.status, "needs-input");
  assert.deepEqual(result.questions.map(({ field }) => field), ["chainId", "priceEth"]);
});
