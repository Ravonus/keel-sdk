import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_PRESENTATION_CODEC_POLICY,
  KEEL_INLINE_MAX_TOKEN_URI_BYTES,
  KEEL_INLINE_SAFE_RPC_GAS,
  KEEL_INLINE_TOKEN_URI_FIXED_GAS,
  KEEL_INLINE_TOKEN_URI_GAS_PER_BYTE,
  KEEL_PREENCODED_TOKEN_URI_COLLECTION_MARGIN,
  KEEL_PRESENTATION_TERMS,
  assessKeelInlinePresentation,
  keelInlineReadGasLimit,
  keelInlineTokenUriReadGasEstimate,
  keelPreEncodedTokenUriReadGasEstimate,
  keelWeb3ObjectURI,
} from "../packages/sdk/dist/presentation.js";

test("codec policy keeps the shell plain and shared Brotli decoder explicit", () => {
  assert.equal(KEEL_PRESENTATION_CODEC_POLICY.none.decoder, "none");
  assert.equal(KEEL_PRESENTATION_CODEC_POLICY.gzip.decoder, "browser-decompression-stream");
  assert.equal(KEEL_PRESENTATION_CODEC_POLICY.brotli.decoder, "declared-keel-module");
  assert.match(KEEL_PRESENTATION_CODEC_POLICY.brotli.requirement, /published once per chain/u);
});

test("presentation vocabulary separates Inline, Hybrid, IPFS, storage, and compression", () => {
  assert.match(KEEL_PRESENTATION_TERMS.inline, /complete animation_url.+assembled onchain/iu);
  assert.match(KEEL_PRESENTATION_TERMS.inline, /no gateway, IPFS, \/content, or RPC/iu);
  assert.match(KEEL_PRESENTATION_TERMS.hybrid, /native KEEL objects through an RPC reader/iu);
  assert.match(KEEL_PRESENTATION_TERMS.hybrid, /remains fully onchain/iu);
  assert.match(KEEL_PRESENTATION_TERMS.resourceGraph, /Child resources may be compressed/iu);
  assert.match(KEEL_PRESENTATION_TERMS.browserDecoder, /browser or WASM decoder/iu);
});

test("web3 object URLs call haulObject and carry the exact MIME type", () => {
  assert.equal(keelWeb3ObjectURI({
    chainId: 11_155_111,
    storeAddress: `0x${"AB".repeat(20)}`,
    objectId: `0x${"CD".repeat(32)}`,
    mediaType: " Image/WebP ",
  }), `web3://0x${"ab".repeat(20)}:11155111/haulObject/0x${"cd".repeat(32)}?mime.type=image%2Fwebp`);
  assert.throws(() => keelWeb3ObjectURI({
    chainId: 0,
    storeAddress: `0x${"ab".repeat(20)}`,
    objectId: `0x${"cd".repeat(32)}`,
    mediaType: "image/webp",
  }), /positive safe chain ID/u);
  assert.throws(() => keelWeb3ObjectURI({
    chainId: 1,
    storeAddress: `0x${"ab".repeat(20)}`,
    objectId: `0x${"cd".repeat(32)}`,
    mediaType: "image/webp; charset=binary",
  }), /exact MIME type/u);
});

test("Inline accepts a plain boot shell and does not forbid compressed child resources", () => {
  assert.deepEqual(assessKeelInlinePresentation({
    builderConfigured: true,
    bootShellCompression: "none",
    tokenUriByteLength: 4_096,
    mediaType: "text/html; charset=utf-8",
    html: "<!doctype html><script>globalThis.keelStart()</script>",
  }), {
    eligible: true,
    recommendedMode: "inline",
    reason: "The prepared tokenURI return is under 2 MB. KEEL must still prove the exact builder read stays within the selected chain's current public RPC gas boundary before wallet review.",
  });
});

test("Inline read gas follows the selected chain while retaining a bounded maximum", () => {
  assert.equal(keelInlineReadGasLimit(30_000_000n), 30_000_000n);
  assert.equal(keelInlineReadGasLimit(45_000_000n), 45_000_000n);
  assert.equal(keelInlineReadGasLimit(90_000_000n), KEEL_INLINE_SAFE_RPC_GAS);
  assert.throws(() => keelInlineReadGasLimit(0n), /must be positive/u);
});

test("Inline review budgets the complete Base64 tokenURI rather than the cheaper harness call", () => {
  const estimate = keelInlineTokenUriReadGasEstimate({
    harnessReadGas: 35_240_197n,
    animationUriByteLength: 405_386,
  });
  assert.equal(
    estimate,
    35_240_197n + KEEL_INLINE_TOKEN_URI_FIXED_GAS + 405_386n * KEEL_INLINE_TOKEN_URI_GAS_PER_BYTE,
  );
  assert.ok(estimate > 74_474_724n, "the measured p5 tokenURI must remain inside the conservative budget");
  assert.ok(keelInlineTokenUriReadGasEstimate({ harnessReadGas: 1_000_000n, animationUriByteLength: 10_000 }) < 10_000_000n);
  assert.throws(() => keelInlineTokenUriReadGasEstimate({ harnessReadGas: -1n, animationUriByteLength: 1 }), /cannot be negative/u);
});

test("pre-encoded Inline adds only bounded collection overhead to the measured final-buffer read", () => {
  const estimate = keelPreEncodedTokenUriReadGasEstimate({ assemblyReadGas: 18_124_072n });
  assert.equal(estimate, 18_124_072n + KEEL_PREENCODED_TOKEN_URI_COLLECTION_MARGIN);
  assert.ok(estimate < 30_000_000n);
  assert.throws(() => keelPreEncodedTokenUriReadGasEstimate({ assemblyReadGas: -1n }), /cannot be negative/u);
});

test("Hybrid is selected when the shell still needs RPC resolution", () => {
  const assessment = assessKeelInlinePresentation({
    builderConfigured: true,
    bootShellCompression: "none",
    tokenUriByteLength: 5_084,
    mediaType: "text/html",
    html: '<script src="/content/p5.min.js"></script>',
  });
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.recommendedMode, "hybrid");
  assert.match(assessment.reason, /immutable bytes may all be native KEEL storage/iu);
});

test("Inline allows inert module aliases while rejecting active network reads", () => {
  const alias = assessKeelInlinePresentation({
    builderConfigured: true,
    bootShellCompression: "none",
    tokenUriByteLength: 8_192,
    mediaType: "text/html",
    html: '<script type="application/json">{"aliases":["/content/seeded-random.js"]}</script>',
  });
  assert.equal(alias.recommendedMode, "inline");
  assert.equal(assessKeelInlinePresentation({
    builderConfigured: true,
    bootShellCompression: "none",
    tokenUriByteLength: 8_192,
    mediaType: "text/html",
    html: '<script>fetch("/api/onchain/1/store/object")</script>',
  }).recommendedMode, "hybrid");
});

test("Inline fails closed for a compressed root, an oversized document, or a missing builder", () => {
  assert.match(assessKeelInlinePresentation({
    builderConfigured: true,
    bootShellCompression: "brotli",
    tokenUriByteLength: 4_096,
    mediaType: "text/html",
  }).reason, /compress child modules and assets instead/iu);
  assert.equal(assessKeelInlinePresentation({
    builderConfigured: true,
    bootShellCompression: "none",
    tokenUriByteLength: KEEL_INLINE_MAX_TOKEN_URI_BYTES + 1,
    mediaType: "text/html",
  }).recommendedMode, "hybrid");
  assert.match(assessKeelInlinePresentation({
    builderConfigured: false,
    bootShellCompression: "none",
    tokenUriByteLength: 4_096,
    mediaType: "text/html",
  }).reason, /no verified KEEL inline builder/iu);
});
