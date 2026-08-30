import nodeTest from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { siblingTest } from "./sibling-repository.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const HANDOFF = path.resolve(ROOT, "../fun-art/apps/web/src/features/artworks/publication/fray-agent-handoff.ts");
const test = siblingTest(nodeTest, "fun-art");

test("Fray Auction staging resolves presets from the Keel SDK instead of private execution tables", async () => {
  const text = await readFile(HANDOFF, "utf8");
  assert.match(text, /from "@keel\/sdk(?:\/fray-auction-intent)?";/u);
  assert.match(text, /resolveFrayAuctionPolicy\(/u);
  assert.match(text, /formatFrayAtomicAmount\(/u);
  assert.doesNotMatch(text, /\b(?:EVM|TEZOS)_PRESETS\b/u);
});
