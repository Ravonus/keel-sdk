import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const HANDOFF = path.resolve(ROOT, "../fun-art/apps/web/src/features/artworks/publication/fray-agent-handoff.ts");

test("Fun-Art resolves Fray presets from the Keel SDK instead of private execution tables", async () => {
  const text = await readFile(HANDOFF, "utf8");
  assert.match(text, /from "@keel\/sdk";/u);
  assert.match(text, /resolveFrayAuctionPolicy\(/u);
  assert.match(text, /formatFrayAtomicAmount\(/u);
  assert.doesNotMatch(text, /\b(?:EVM|TEZOS)_PRESETS\b/u);
});
