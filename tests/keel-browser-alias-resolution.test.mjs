import assert from "node:assert/strict";
import test from "node:test";

import { replaceVerifiedAliases } from "../examples/demos/keel-creative-lab/alias-resolution.js";

test("verified alias replacement resolves the longest module path before its basename", () => {
  const dataURI = "data:text/javascript;base64,dmVyaWZpZWQ=";
  const aliases = new Map([
    ["seeded-random.js", dataURI],
    ["./seeded-random.js", dataURI],
    ["/content/seeded-random.js", dataURI],
    ["keel.seeded-random", dataURI],
  ]);
  assert.equal(
    replaceVerifiedAliases('import { createSeededRandom } from "/content/seeded-random.js";', aliases),
    `import { createSeededRandom } from "${dataURI}";`,
  );
  assert.doesNotMatch(
    replaceVerifiedAliases('import "/content/seeded-random.js";', aliases),
    /\/content\/data:/u,
  );
});

test("verified alias replacement leaves undeclared specifiers unchanged", () => {
  assert.equal(replaceVerifiedAliases('import "./creator.js";', new Map()), 'import "./creator.js";');
});
