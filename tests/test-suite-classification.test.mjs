import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_TEST_FILES,
  DEFAULT_TEST_FILES,
  DETERMINISTIC_TEST_FILES,
  LIVE_TEST_FILES,
  SIBLING_CONFORMANCE_TEST_FILES,
  TEST_FILES_ON_DISK,
  validateTestSuiteClassification,
} from "../scripts/test-suites.mjs";

test("[test gate] every suite is classified and browser/live checks stay outside the deterministic default", () => {
  assert.deepEqual(validateTestSuiteClassification(), []);
  assert.equal(LIVE_TEST_FILES.length, 0, "live-chain/public-network tests must not enter node:test discovery");
  for (const file of BROWSER_TEST_FILES) assert.equal(DEFAULT_TEST_FILES.includes(file), false, file);
  for (const file of LIVE_TEST_FILES) assert.equal(DEFAULT_TEST_FILES.includes(file), false, file);
  for (const file of DETERMINISTIC_TEST_FILES) assert.equal(DEFAULT_TEST_FILES.includes(file), true, file);
  for (const file of SIBLING_CONFORMANCE_TEST_FILES) assert.equal(DEFAULT_TEST_FILES.includes(file), true, file);
});

test("[test gate] a newly added test is unclassified until its execution boundary is reviewed", () => {
  const newTest = "tests/unreviewed-public-rpc.test.mjs";
  assert.deepEqual(
    validateTestSuiteClassification([...TEST_FILES_ON_DISK, newTest]),
    [`unclassified tests: ${newTest}`],
  );
  assert.equal(DEFAULT_TEST_FILES.includes(newTest), false);
});

test("[test gate] a removed test leaves a stale manifest entry instead of crashing validation", () => {
  const removedTest = DETERMINISTIC_TEST_FILES[0];
  assert.deepEqual(
    validateTestSuiteClassification(TEST_FILES_ON_DISK.filter((file) => file !== removedTest)),
    [`classified tests not on disk: ${removedTest}`],
  );
});
