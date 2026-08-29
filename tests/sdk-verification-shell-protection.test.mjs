import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactInlineKeelShell } from "../packages/sdk/dist/index.js";

test("the default compact shell contains the protected K stamp, proof panel, and bounded plugin API", async () => {
  const built = await buildCompactInlineKeelShell();
  const prefix = new TextDecoder().decode(built.prefix);
  const suffix = new TextDecoder().decode(built.suffix);
  const shell = `${prefix}${suffix}`;

  assert.match(prefix, /id="keel-verify-stamp"/u);
  assert.match(prefix, /aria-label="Open KEEL verification proof"/u);
  assert.match(prefix, />K<\/button>/u);
  assert.match(prefix, /id="keel-verify-panel"/u);
  assert.match(prefix, /id="keel-verify-plugin-panels"/u);
  assert.match(suffix, /keel-shell-plugin@1/u);
  assert.match(suffix, /__KEEL_SHELL_API__/u);
  assert.match(suffix, /configurable:\s*!1|configurable:false/u);
  assert.match(suffix, /sandbox\.add\("allow-scripts",\s*"allow-pointer-lock"\)/u);
  assert.doesNotMatch(shell, /allow-same-origin/u);
  assert.doesNotMatch(prefix, />S<\/button>/u);
});
