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
  assert.match(suffix, /data-keel-panel-placement/u);
  assert.match(suffix, /opacity:\.24!important;visibility:visible!important;pointer-events:auto!important/u);
  assert.match(suffix, /transform:translateX\(0\) rotate\(-4deg\) scale\(\.94\)!important/u);
  assert.match(suffix, /translateY\(102%\)/u);
  assert.match(suffix, /body\.verify-open\[data-keel-panel-placement=.{0,8}right/u);
  assert.match(suffix, /#keel-stage\{position:absolute/u);
  assert.match(suffix, /#keel-stage\{right:var\(--keel-panel-width[^}]+width:auto!important/u);
  assert.match(suffix, /style\.setProperty\(["']--keel-panel-width["']/u);
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
