import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  UnsupportedHistoricalGameVariant,
  analyzeHistoricalComet,
  analyzeHistoricalGames,
  analyzeHistoricalThree,
  splitHistoricalGame,
} from "../../packages/studio-core/dist/index.js";

const keelDirectory = path.dirname(fileURLToPath(import.meta.url));
const inventoryDirectory = process.env.KEEL_INVENTORY_DIR ?? "/Users/ravonus/dev/chainrougesolidity-inventory";
const developmentDirectory = process.env.KEEL_DEVELOPMENT_DIR ?? "/Users/ravonus/dev/chainrougesolidity-development";
const websitesDirectory = path.join(developmentDirectory, "websites");
const outputDirectory = path.join(keelDirectory, "historical");
const fragmentsDirectory = path.join(outputDirectory, "game-fragments");
const selectedGameIds = [11, 14, 18, 20, 21, 33, 36, 46, 47, 52];
const fluidOrder = [
  "fluid-capture.all",
  "fluid-dat.gui",
  "fluid-init",
  "fluid-shaders",
  "fluid-utils",
  "fluid-render",
  "fluid-main",
];

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readBytes(file) {
  return new Uint8Array(await readFile(file));
}

function fragmentFile(fragment) {
  const role = fragment.roles[0];
  if (role === "token" && fragment.tokenIds.length === 1) return `token-${fragment.tokenIds[0]}.htmlfrag`;
  if (fragment.roles.length === 1) return `${role}.htmlfrag`;
  return `${fragment.digest.slice(2, 18)}.htmlfrag`;
}

function assertExpected(report) {
  assert.equal(report.corpus.totals.files, 19);
  assert.equal(report.corpus.totals.decodedBytes, 77_096);
  assert.equal(report.corpus.totals.decompressedBytes, 349_365);
  assert.equal(report.comet.archive.integrity.digest, "0x7b10e18bc083678e649574590ca3c46fe82f3e6d7f3326592bd9096dded0601d");
  assert.equal(report.comet.historicalIndexConvention.packedWord, "0x0000000000000006000000000005000000000004000000000003000000000002");
  assert.equal(report.three.raw.integrity.digest, "0xf06c5cc1f6c61db82465d17c07ef4d8ae1a2ec598fc664182eaec5bb62494e85");
  assert.equal(report.three.rootSerialized.source.byteLength, 166_734);
  assert.equal(report.three.rootSerialized.storedBrotli.byteLength, 133_387);
  assert.equal(report.three.rootSerialized.differsFromRawByLeadingCarriageReturnOnly, true);
  assert.deepEqual(report.fluid.totals, { sourceBytes: 44_590, storedBrotliBytes: 35_670, resolvedJavaScriptBytes: 151_361 });
  assert.equal(report.game.standardCaptures, 93);
  assert.deepEqual(report.game.unsupportedTokenIds, [6, 7, 8, 9]);
  assert.equal(report.game.selected.storage.naiveFullBytes, 408_301);
  assert.equal(report.game.selected.storage.uniqueFragmentBytes, 44_476);
  assert.equal(report.game.selected.storage.uniqueFragmentCount, 13);
  assert.equal(report.game.selected.storage.bytesSaved, 363_825);
  assert.equal(report.game.comparison3And4.differentBytePositions, 87);
  assert.equal(report.game.comparison3And4.sharedFragmentBytes, 34_160);
  assert.equal(report.game.blackAndWhiteCaptures, 23);
  assert.equal(report.game.rainbowStrobeCaptures, 0);
}

export async function buildHistoricalEvidence() {
  const corpus = JSON.parse(await readFile(path.join(keelDirectory, "corpus.json"), "utf8"));
  const comet = await analyzeHistoricalComet(
    await readBytes(path.join(inventoryDirectory, "test", "nftComet0.html")),
    await readBytes(path.join(keelDirectory, "b85", "start-p5.b85")),
  );
  const three = await analyzeHistoricalThree({
    raw: await readBytes(path.join(inventoryDirectory, "three.js")),
    rootSerialized: await readBytes(path.join(inventoryDirectory, "three.js.deflate.new-serialization")),
    alternateSerialized: await readBytes(path.join(inventoryDirectory, "THREECHAIN", "three.js.deflate.new-serialization")),
  });
  const fluidArtifacts = fluidOrder.map((name) => {
    const artifact = corpus.artifacts.find((candidate) => candidate.name === name);
    if (artifact === undefined) throw new Error(`Corpus is missing ${name}.`);
    return {
      name,
      sourceBytes: artifact.sizes.sourceBytes,
      storedBrotliBytes: artifact.sizes.decodedBytes,
      resolvedJavaScriptBytes: artifact.sizes.decompressedBytes,
      sourceDigest: artifact.digests.sourceSha256,
      storedDigest: artifact.digests.decodedSha256,
      resolvedDigest: artifact.digests.decompressedSha256,
    };
  });
  const fluidTotals = fluidArtifacts.reduce(
    (totals, artifact) => ({
      sourceBytes: totals.sourceBytes + artifact.sourceBytes,
      storedBrotliBytes: totals.storedBrotliBytes + artifact.storedBrotliBytes,
      resolvedJavaScriptBytes: totals.resolvedJavaScriptBytes + artifact.resolvedJavaScriptBytes,
    }),
    { sourceBytes: 0, storedBrotliBytes: 0, resolvedJavaScriptBytes: 0 },
  );

  const selectedGames = await analyzeHistoricalGames(
    await Promise.all(selectedGameIds.map(async (tokenId) => ({
      tokenId: String(tokenId),
      bytes: await readBytes(path.join(websitesDirectory, `gameStaked${tokenId}.html`)),
    }))),
  );
  const fragmentFiles = Object.fromEntries(selectedGames.report.fragments.map((fragment) => [fragment.digest, fragmentFile(fragment)]));
  const selectedReport = {
    ...selectedGames.report,
    fragments: selectedGames.report.fragments.map((fragment) => ({ ...fragment, fixtureFile: `game-fragments/${fragmentFiles[fragment.digest]}` })),
  };

  const gameFiles = (await readdir(websitesDirectory))
    .filter((name) => /^gameStaked\d+\.html$/u.test(name))
    .sort((left, right) => Number(left.match(/\d+/u)?.[0]) - Number(right.match(/\d+/u)?.[0]));
  const unsupportedTokenIds = [];
  let standardCaptures = 0;
  let blackAndWhiteCaptures = 0;
  let rainbowStrobeCaptures = 0;
  for (const name of gameFiles) {
    const tokenId = name.match(/\d+/u)?.[0];
    if (tokenId === undefined) continue;
    const bytes = await readBytes(path.join(websitesDirectory, name));
    try {
      splitHistoricalGame(tokenId, bytes);
      standardCaptures += 1;
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (source.includes("function bw(")) blackAndWhiteCaptures += 1;
      if (source.includes("rainbowStrobe") || source.includes("pulseRestart")) rainbowStrobeCaptures += 1;
    } catch (error) {
      if (!(error instanceof UnsupportedHistoricalGameVariant)) throw error;
      unsupportedTokenIds.push(Number(tokenId));
    }
  }
  unsupportedTokenIds.sort((left, right) => left - right);

  const [game3, game4] = await Promise.all([
    readBytes(path.join(websitesDirectory, "gameStaked3.html")),
    readBytes(path.join(websitesDirectory, "gameStaked4.html")),
  ]);
  let differentBytePositions = 0;
  for (let index = 0; index < game3.byteLength; index += 1) if (game3[index] !== game4[index]) differentBytePositions += 1;
  const game3Split = splitHistoricalGame("3", game3);
  const game4Split = splitHistoricalGame("4", game4);
  assert.deepEqual(game3Split.head, game4Split.head);
  assert.deepEqual(game3Split.atlas, game4Split.atlas);
  assert.deepEqual(game3Split.engine, game4Split.engine);

  const report = {
    schema: "keel-historical-evidence@1",
    proofBoundary: {
      sourceBytes: "verified-against-local-author-archives",
      fragmentAssembly: "byte-identical-offchain",
      onchainPublication: "not-in-this-report",
      browserRendering: "reported-separately",
      licensing: "research-only-until-each-third-party-dependency-is-pinned",
    },
    corpus: {
      schema: corpus.schema,
      pipeline: corpus.pipeline,
      totals: corpus.totals,
      artifactCount: corpus.artifacts.length,
      artifacts: corpus.artifacts.map((artifact) => ({
        name: artifact.name,
        wrapper: artifact.wrapper,
        compression: artifact.compression,
        sizes: artifact.sizes,
        digests: artifact.digests,
        canonicalReencode: artifact.canonicalReencode,
      })),
    },
    comet: {
      ...comet,
      injectedLiveField: "block.timestamp as decimal extras[0]",
      modernFixtureMapping: {
        status: "reference-only-not-historical-chain-state",
        entries: ["2=decoder compatibility", "3=de85", "4=seedGen", "5=p5@1.7.0", "6=start-p5"],
      },
      renderStatus: "blocked-until-p5-1.7.0-is-pinned-with-redistribution-notice",
    },
    three: {
      ...three,
      libraryVersion: "r154",
      license: "MIT",
      renderStatus: "blocked-until-compatible-OrbitControls-and-ARButton-are-pinned",
    },
    fluid: {
      emittedOrder: fluidOrder,
      modules: fluidArtifacts,
      totals: fluidTotals,
      renderStatus: "source-graph-verified-browser-and-license-gates-open",
      requiredCapability: "WebGPU",
    },
    breadth: [
      { id: "genart", status: "runnable-compatibility-candidate", dependencies: ["seedGen", "start-genart"] },
      { id: "twgl", status: "blocked-license-provenance", dependencies: ["twgl", "start-twgl"] },
      { id: "matrix", status: "blocked-unpinned-dependencies", dependencies: ["Babylon 6.19.1", "texture", "bab-start"] },
      { id: "gpu", status: "blocked-license-and-WebGPU-proof", dependencies: ["webMatrix", "start-gpu"] },
      { id: "sphere", status: "blocked-incomplete-shader-graph", dependencies: ["twgl", "start-sphere", "vs", "fs"] },
    ],
    game: {
      sourceFileCount: gameFiles.length,
      standardCaptures,
      unsupportedTokenIds,
      blackAndWhiteCaptures,
      rainbowStrobeCaptures,
      selectedTokenIds: selectedGameIds,
      selected: selectedReport,
      comparison3And4: {
        byteLengthEach: game3.byteLength,
        differentBytePositions,
        sharedFragmentBytes: game3Split.head.byteLength + game3Split.atlas.byteLength + game3Split.engine.byteLength,
        tokenBytesEach: game3Split.token.byteLength,
        digests: [sha256(game3), sha256(game4)],
      },
      storageClaim: "fragment-byte measurement; onchain event/accounting proof is a separate deployment receipt",
    },
  };
  assertExpected(report);
  return {
    report,
    fragmentBytes: selectedGames.fragmentBytes,
    fragmentFiles,
    sourceFixtures: {
      cometArchive: await readBytes(path.join(inventoryDirectory, "test", "nftComet0.html")),
      threeRaw: await readBytes(path.join(inventoryDirectory, "three.js")),
      threeRootSerialized: await readBytes(path.join(inventoryDirectory, "three.js.deflate.new-serialization")),
      threeAlternateSerialized: await readBytes(path.join(inventoryDirectory, "THREECHAIN", "three.js.deflate.new-serialization")),
      seedGen: await readBytes(path.join(inventoryDirectory, "seedGen.js")),
      unsupportedGames: await Promise.all([6, 7, 8, 9].map(async (tokenId) => ({
        tokenId,
        bytes: await readBytes(path.join(websitesDirectory, `gameStaked${tokenId}.html`)),
      }))),
      comparison: {
        head: game3Split.head,
        atlas: game3Split.atlas,
        engine: game3Split.engine,
        token3: game3Split.token,
        token4: game4Split.token,
      },
    },
  };
}

async function expectedOutputs() {
  const built = await buildHistoricalEvidence();
  const outputs = new Map([[path.join(outputDirectory, "report.json"), `${JSON.stringify(built.report, null, 2)}\n`]]);
  for (const [digest, bytes] of built.fragmentBytes) {
    const name = built.fragmentFiles[digest];
    if (name === undefined) throw new Error(`No fixture filename for ${digest}.`);
    outputs.set(path.join(fragmentsDirectory, name), bytes);
  }
  outputs.set(path.join(outputDirectory, "comet", "nftComet0.html"), built.sourceFixtures.cometArchive);
  outputs.set(path.join(outputDirectory, "comet", "seedGen.js"), built.sourceFixtures.seedGen);
  outputs.set(path.join(outputDirectory, "three", "three-r154.js"), built.sourceFixtures.threeRaw);
  outputs.set(path.join(outputDirectory, "three", "three-r154.root.z85"), built.sourceFixtures.threeRootSerialized);
  outputs.set(path.join(outputDirectory, "three", "three-r154.alternate.z85"), built.sourceFixtures.threeAlternateSerialized);
  for (const game of built.sourceFixtures.unsupportedGames) {
    outputs.set(path.join(outputDirectory, "game-unsupported", `gameStaked${game.tokenId}.html`), game.bytes);
  }
  for (const [name, bytes] of Object.entries(built.sourceFixtures.comparison)) {
    outputs.set(path.join(outputDirectory, "game-comparison", `${name}.htmlfrag`), bytes);
  }
  return outputs;
}

export async function checkHistoricalEvidence() {
  const outputs = await expectedOutputs();
  for (const [file, expected] of outputs) {
    const actual = await readFile(file);
    const expectedBytes = typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected);
    assert.deepEqual(actual, expectedBytes, `${path.relative(keelDirectory, file)} is stale`);
  }
}

async function main() {
  const check = process.argv.includes("--check");
  if (check) {
    await checkHistoricalEvidence();
    console.log("Historical Keel evidence and 13 game fragments are current.");
    return;
  }
  const outputs = await expectedOutputs();
  for (const [file, value] of outputs) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  console.log(`Wrote ${outputs.size} historical evidence files.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
