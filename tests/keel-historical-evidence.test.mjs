import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  UnsupportedHistoricalGameVariant,
  analyzeHistoricalComet,
  analyzeHistoricalGames,
  analyzeHistoricalThree,
  splitHistoricalGame,
} from "../packages/studio-core/dist/index.js";
import { concatBytes, verifyIntegrity } from "../packages/protocol/dist/index.js";

const historicalDirectory = path.resolve("examples/keel/historical");
const evidence = JSON.parse(await readFile(path.join(historicalDirectory, "report.json"), "utf8"));
const gameIds = [11, 14, 18, 20, 21, 33, 36, 46, 47, 52];
const expectedGameDigests = [
  "0xb401e58c3a304062900485c84e19525c7039f2e8d975c485909dfd8c1794de71",
  "0xc6a47c17b8a8abcd3bb09a284597b26cb6ad591f49d0b391298d04da138d27b8",
  "0x0e55495a1b8999c8fb6cae274d54cce0b4fa03d0956dd507f046897a4de305bb",
  "0x53724673cc54d6a3f075a4bf3b9bd735c818c42f2fa4211347186cdcf01b7201",
  "0xfb0ff152ed8127db52a6a3cd072f2ebd6a520bc13fe1715ce020d54d76eb89c8",
  "0x3297d0922dce3844c9a0fc42306ae58453e78bc98bd116fc0158c07b458d16bd",
  "0x7507f93ac63a7099fc71de58cabd23b4df0ce321496a775ccae6a38841d6a8a4",
  "0x653ab6b45f128ba6a17a2f539470e0960ae5fb85dce496ef2b7b95de150169ff",
  "0xcee49034e28d9d1549b7be537bdf23dec0b56fedd06a9ea07ad53d52b77e1e6b",
  "0xfd4e88d07796f3147d05c36d1801a3527a3ad1fe21108f9aabd9d832881199a0",
];

async function bytes(file) {
  return new Uint8Array(await readFile(file));
}

test("ten real historical game captures round-trip through 13 exact deduped fragments", async () => {
  const fixtureByDigest = new Map(evidence.game.selected.fragments.map((fragment) => [fragment.digest, fragment.fixtureFile]));
  const reconstructedInputs = await Promise.all(evidence.game.selected.tokens.map(async (token) => ({
    tokenId: token.tokenId,
    bytes: concatBytes(await Promise.all(token.fragmentDigests.map(async (digest) => {
      const file = fixtureByDigest.get(digest);
      assert.ok(file !== undefined, `fixture path for ${digest}`);
      return bytes(path.join(historicalDirectory, file.replace(/^game-fragments\//u, "game-fragments/")));
    }))),
  })));
  const bundle = await analyzeHistoricalGames(
    reconstructedInputs,
  );
  const { report } = bundle;
  assert.equal(report.tokenCount, 10);
  assert.equal(report.storage.naiveFullBytes, 408_301);
  assert.equal(report.storage.uniqueFragmentBytes, 44_476);
  assert.equal(report.storage.bytesSaved, 363_825);
  assert.equal(Number((report.storage.savingsRatio * 100).toFixed(3)), 89.107);
  assert.equal(report.storage.uniqueFragmentCount, 13);
  assert.equal(report.storage.sharedFragmentCount, 3);
  assert.equal(report.storage.perTokenFragmentCount, 10);
  assert.ok(report.tokens.every((entry) => entry.reassembledByteIdentical));
  assert.deepEqual(report.tokens.map((entry) => entry.tokenId), gameIds.map(String));
  assert.deepEqual(report.tokens.map((entry) => entry.integrity.digest), expectedGameDigests);

  const token11 = report.tokens.find((entry) => entry.tokenId === "11");
  assert.equal(token11?.integrity.digest, "0xb401e58c3a304062900485c84e19525c7039f2e8d975c485909dfd8c1794de71");
  assert.deepEqual(token11?.offsets, { headEnd: 735, atlasEnd: 7_879, tokenEnd: 8_284, fullEnd: 40_830 });
  assert.deepEqual(
    report.fragments.filter((fragment) => fragment.tokenIds.length === 10).map((fragment) => fragment.byteLength).sort((a, b) => a - b),
    [735, 7_144, 32_546],
  );

  const token11Parts = token11.fragmentDigests.map((digest) => bundle.fragmentBytes.get(digest));
  assert.ok(token11Parts.every((part) => part !== undefined));
  const tamperedHead = token11Parts[0].slice();
  tamperedHead[0] ^= 0x01;
  const tampered = concatBytes([tamperedHead, ...token11Parts.slice(1)]);
  assert.equal(await verifyIntegrity(tampered, token11.integrity), false, "shared-fragment tampering must block the final commitment");
});

test("historical game variants 6 through 9 fail explicitly instead of being rewritten", async () => {
  for (const tokenId of [6, 7, 8, 9]) {
    const source = await bytes(path.join(historicalDirectory, "game-unsupported", `gameStaked${tokenId}.html`));
    assert.throws(
      () => splitHistoricalGame(String(tokenId), source),
      (error) => error instanceof UnsupportedHistoricalGameVariant && /boundaries are missing/u.test(error.message),
    );
  }
});

test("the two unstaked comparison captures retain the corrected byte-difference measurement", async () => {
  const [left, right] = await Promise.all([
    Promise.all(["head", "atlas", "token3", "engine"].map((name) => bytes(path.join(historicalDirectory, "game-comparison", `${name}.htmlfrag`)))).then(concatBytes),
    Promise.all(["head", "atlas", "token4", "engine"].map((name) => bytes(path.join(historicalDirectory, "game-comparison", `${name}.htmlfrag`)))).then(concatBytes),
  ]);
  assert.equal(left.byteLength, 34_566);
  assert.equal(right.byteLength, 34_566);
  let differentPositions = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) differentPositions += 1;
  }
  assert.equal(differentPositions, 87);
  const leftSplit = splitHistoricalGame("3", left);
  const rightSplit = splitHistoricalGame("4", right);
  assert.deepEqual(leftSplit.head, rightSplit.head);
  assert.deepEqual(leftSplit.atlas, rightSplit.atlas);
  assert.deepEqual(leftSplit.engine, rightSplit.engine);
  assert.equal(leftSplit.head.byteLength + leftSplit.atlas.byteLength + leftSplit.engine.byteLength, 34_160, "preserve the audited shared-byte measurement, not the brief approximation");
});

test("the root three.js serialization proves Brotli, 32 chunks, and its one-byte provenance difference", async () => {
  const evidence = await analyzeHistoricalThree({
    raw: await bytes(path.join(historicalDirectory, "three", "three-r154.js")),
    rootSerialized: await bytes(path.join(historicalDirectory, "three", "three-r154.root.z85")),
    alternateSerialized: await bytes(path.join(historicalDirectory, "three", "three-r154.alternate.z85")),
  });
  assert.equal(evidence.raw.byteLength, 728_973);
  assert.equal(evidence.raw.integrity.digest, "0xf06c5cc1f6c61db82465d17c07ef4d8ae1a2ec598fc664182eaec5bb62494e85");
  assert.equal(evidence.raw.historicalChunkCount, 32);
  assert.equal(evidence.rootSerialized.source.byteLength, 166_734);
  assert.equal(evidence.rootSerialized.source.integrity.digest, "0xe91f81911f7621faea537d010352ed7f02cc42066ea8d3630034bdffaea009d6");
  assert.equal(evidence.rootSerialized.storedBrotli.byteLength, 133_387);
  assert.equal(evidence.rootSerialized.storedBrotli.integrity.digest, "0x9526b2bd367ea103cc2f2909d38dd4b993da73d7917e5b02fcac69cce0b5dcc6");
  assert.equal(evidence.rootSerialized.resolved.byteLength, 728_974);
  assert.equal(evidence.rootSerialized.resolved.integrity.digest, "0x81df68653bf0e9262e059f68ed74dc1c13046865cc5a14b60e49cd5d82d970e6");
  assert.equal(evidence.rootSerialized.differsFromRawByLeadingCarriageReturnOnly, true);
  assert.equal(evidence.alternateSerialized?.source.byteLength, 167_465);
  assert.equal(evidence.alternateSerialized?.sourceDriftBytes, 731);
});

test("the emitted Comet archive proves runtime order while keeping numeric ID provenance honest", async () => {
  const evidence = await analyzeHistoricalComet(
    await bytes(path.join(historicalDirectory, "comet", "nftComet0.html")),
    await bytes("examples/keel/b85/start-p5.b85"),
  );
  assert.equal(evidence.archive.integrity.digest, "0x7b10e18bc083678e649574590ca3c46fe82f3e6d7f3326592bd9096dded0601d");
  assert.deepEqual(evidence.historicalIndexConvention.objectIds, [2, 3, 4, 5, 6]);
  assert.equal(evidence.historicalIndexConvention.packedWord, "0x0000000000000006000000000005000000000004000000000003000000000002");
  assert.equal(evidence.historicalIndexConvention.byteToIdMapping, "not-proven-by-retained-chain-state");
  assert.deepEqual(evidence.emittedRuntimeOrder, ["brotli-loader", "de85", "seedGen", "p5@1.7.0", "start-p5", "seed"]);
  assert.equal(evidence.startP5PayloadMatchesCorpus, true);
  assert.equal(evidence.externalRuntimeDependenciesPinnedLocally, false);
});
