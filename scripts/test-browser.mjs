import { run } from "./run.mjs";
import { BROWSER_TEST_FILES, validateTestSuiteClassification } from "./test-suites.mjs";

const classificationIssues = validateTestSuiteClassification();
if (classificationIssues.length > 0) throw new Error(classificationIssues.join("\n"));

run("node", ["scripts/build.mjs"]);
run("node", ["--test", ...BROWSER_TEST_FILES]);
