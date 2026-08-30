import assert from "node:assert/strict";
import test from "node:test";

import { buildCompactInlineKeelShell } from "../packages/sdk/dist/index.js";

test("the registered default shell bundles the one canonical protected K chrome and bounded plugin API", async () => {
  const built = await buildCompactInlineKeelShell({ repositoryRoot: process.cwd() });
  const prefix = new TextDecoder().decode(built.prefix);
  const suffix = new TextDecoder().decode(built.suffix);
  const shell = `${prefix}${suffix}`;

  assert.match(suffix, /id=["']verify-seal["']/u);
  assert.match(suffix, /id=["']verify-panel["']/u);
  assert.match(suffix, /verify-page-nav/u);
  assert.match(suffix, /Keel proof viewer/u);
  assert.match(suffix, /"glyph":"K"/u);
  assert.doesNotMatch(suffix, /"glyph":"S"/u);
  assert.match(suffix, /keel-shell-plugin@1/u);
  assert.match(suffix, /__KEEL_SHELL_API__/u);
  assert.match(suffix, /mediaType/u);
  assert.match(suffix, /byteLength/u);
  assert.match(suffix, /__KEEL_CONTENT__/u);
  assert.match(suffix, /__KEEL_ENTRY__/u);
  assert.match(suffix, /configurable:\s*!1|configurable:false/u);
  assert.match(suffix, /sandbox\.add\("allow-scripts",\s*"allow-pointer-lock"\)/u);
  assert.doesNotMatch(shell, /allow-same-origin/u);
  assert.doesNotMatch(shell, /XMLHttpRequest|fetch\(|ethereum\.request|requestAccounts/iu);
  assert.doesNotMatch(shell, /id=["']keel-verify-(?:stamp|panel)["']/u);
});
