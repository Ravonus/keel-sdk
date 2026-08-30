import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { p5ProjectBindings } from "../deployments.mjs";

const demo = new URL("../../demos/p5-flowfield/", import.meta.url);

test("agent p5 project publishes only the creator script without embedding a shell or shared modules", async () => {
  const sketch = await readFile(new URL("sketch.js", demo), "utf8");
  assert.match(sketch, /import \{ createSeededRandom \} from "\/content\/seeded-random\.js";/u);
  assert.match(sketch, /const PALETTE = PALETTES\[SEED % PALETTES\.length\]/u);
  assert.match(sketch, /const SPEED = 0\.9 \+ \(\(SEED >>> 8\) & 0xff\) \/ 255 \* 1\.25/u);
  assert.match(sketch, /const FIELD_BEND = 0\.72 \+ \(\(SEED >>> 24\) & 0xff\) \/ 255 \* 0\.7/u);
  assert.doesNotMatch(sketch, /<html|<script|function makeRandom/iu);
  assert.ok(Buffer.byteLength(sketch) < 4_000, "the payable creator script should remain one small carrier");
});

test("agent p5 project resolves both modules from one exact chain deployment", async () => {
  const bindings = await p5ProjectBindings(11_155_111);
  assert.deepEqual(bindings, {
    chain: "eip155:11155111",
    p5: {
      store: "0x0a4f31d5ab08029e4c68f6f3227d9fa3a2d66267",
      objectId: "0x608b3969847e33dcd0b33b89dbdd54a6354869ebe45bfd98b5019c305cf751a5",
    },
    seededRandom: {
      store: "0x0a4f31d5ab08029e4c68f6f3227d9fa3a2d66267",
      objectId: "0x274113efe02d13b9b41d30fa025647a8f83f422745079d2fda3094fc27b9fd62",
    },
  });
  await assert.rejects(p5ProjectBindings(1), /not both registered/u);
});
