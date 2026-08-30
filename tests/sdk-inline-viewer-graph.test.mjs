import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  KEEL_ASSET_DISPLAY_MODULE_ID,
  buildKeelInlineAssetDisplayModuleFragment,
  buildKeelInlineLocalDocument,
  buildKeelInlineModuleFragment,
  buildKeelInlineNormalMediaDocument,
  buildKeelInlinePreEncodedTokenURIGraph,
  buildKeelRegisteredInlineNormalMediaTokenURIGraph,
  buildKeelPreparedOneOfOneTokenURI,
  buildKeelInlineShellFragments,
  concatenateComposableBase64Fragments,
  createComposableBase64Fragment,
  keelAssetDisplayModuleBytes,
  keelAssetDisplayKind,
  serializeInlineScriptJSON,
  verifyKeelPublishedInlineModuleFragment,
} from "../packages/sdk/dist/inline-viewer-graph.js";
import { KEEL_INLINE_PROTECTION_SHELL_ID } from "../packages/sdk/dist/shell-registry.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const chainId = 11155111;

const utf8 = (value) => new TextEncoder().encode(value);
const decoded = (value) => new Uint8Array(Buffer.from(value, "base64"));

test("composable Base64 fragments equal one traditional outer encoding across UTF-8 boundaries", () => {
  const values = [
    "",
    "abc",
    "abcd",
    "abcde",
    '{"quote":"\\\"","slash":"\\\\","line":"\\n"}',
    '{"unicode":"雪 🌊"}',
    "x".repeat(250_001),
  ];
  for (const value of values) {
    const first = createComposableBase64Fragment(value, { mustAllowFollowingFragment: true });
    const tail = createComposableBase64Fragment("</script>", { mustAllowFollowingFragment: false });
    const composable = concatenateComposableBase64Fragments([first, tail]);
    const paddedRaw = Buffer.concat([Buffer.from(utf8(value)), Buffer.from(" ".repeat(first.paddingBytes)), Buffer.from("</script>")]);
    assert.equal(composable, paddedRaw.toString("base64"));
    assert.deepEqual(decoded(composable), new Uint8Array(paddedRaw));
    assert.equal((first.rawByteLength + first.paddingBytes) % 3, 0);
    assert.doesNotMatch(first.base64, /=/u);
  }
});

test("hundreds of reordered composable JSON fragments remain one deterministic Base64 stream", () => {
  const order = Array.from({ length: 1_000 }, (_, index) => (index * 73) % 1_000);
  const raw = order.map((id, index) => `${JSON.stringify({ id, text: `row ${id} 雪` })}${index === order.length - 1 ? "" : ","}`);
  const pieces = ["const DATA=[", ...raw, "];"].map((value, index, values) =>
    createComposableBase64Fragment(value, {
      mustAllowFollowingFragment: index < values.length - 1,
      paddingStrategy: "json-whitespace",
    }));
  const composable = concatenateComposableBase64Fragments(pieces);
  const expectedRaw = pieces.map((piece, index) => `${["const DATA=[", ...raw, "];"][index]}${" ".repeat(piece.paddingBytes)}`).join("");
  assert.equal(composable, Buffer.from(expectedRaw).toString("base64"));
  assert.equal(Buffer.from(composable, "base64").toString("utf8"), expectedRaw);
});

test("inline JSON escaping closes script parser hazards before byte alignment", () => {
  const serialized = serializeInlineScriptJSON({ html: "</script><b>snow 雪</b>", lines: "a\u2028b\u2029c" });
  assert.doesNotMatch(serialized, /</u);
  assert.match(serialized, /\\u003c\/script\\u003e/u);
  assert.match(serialized, /\\u2028/u);
  assert.deepEqual(JSON.parse(serialized), { html: "</script><b>snow 雪</b>", lines: "a\u2028b\u2029c" });
});

test("composable Base64 rejects malformed Unicode and padded non-terminal fragments", () => {
  assert.throws(() => createComposableBase64Fragment("\ud800"), /unpaired high surrogate/u);
  assert.throws(() => createComposableBase64Fragment("\udc00"), /unpaired low surrogate/u);
  assert.throws(
    () => concatenateComposableBase64Fragments([
      { rawByteLength: 1, paddingBytes: 0, base64: "YQ==" },
      createComposableBase64Fragment("tail", { mustAllowFollowingFragment: false }),
    ]),
    /Non-terminal/u,
  );
  assert.throws(
    () => concatenateComposableBase64Fragments([{ rawByteLength: 1, paddingBytes: 0, base64: "%%%=" }]),
    /Malformed/u,
  );
});

test("Gzip Inline graph reuses shell and p5 fragments and publishes only creator bytes", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  assert.equal(shell.codecProfile, "browser-gzip-deflate");
  assert.ok(shell.prefix.bytes.byteLength + shell.suffix.bytes.byteLength < 100_000);
  const shellText = new TextDecoder().decode(new Uint8Array([
    ...shell.prefix.bytes,
    ...shell.suffix.bytes,
  ]));
  assert.match(shellText, /DecompressionStream/u);
  assert.match(shellText, /globalThis\.crypto\?\.subtle/u);
  assert.match(shellText, /Uint32Array\.from/u);
  assert.match(shellText, /__KEEL_ITEMS__/u);
  assert.match(shellText, /id=["']verify-seal["']/u);
  assert.match(shellText, /id=["']verify-panel["']/u);
  assert.match(shellText, /verify-page-nav/u);
  assert.doesNotMatch(shellText, /brotli-dec-wasm|keel-verification-envelope|eth_call|fetch\(/iu);

  const p5 = await buildKeelInlineModuleFragment({
    moduleId: "p5",
    version: "1.11.11",
    mediaType: "text/javascript",
    aliases: ["p5.min.js"],
    decodedBytes: new TextEncoder().encode(`globalThis.p5=${JSON.stringify("x".repeat(200_000))}`),
    compression: "gzip",
    execution: "classic",
  });
  assert.equal(p5.item.embedded.compression, "gzip");

  const root = await buildKeelInlineLocalDocument({
    shell,
    modules: [p5],
    entry: {
      id: "sketch.js",
      mediaType: "text/javascript",
      source: new TextEncoder().encode("new p5(()=>{});"),
    },
  });
  assert.equal(root.parts.filter((part) => part.kind === "existing").length, 3);
  assert.equal(root.parts.filter((part) => part.kind === "creator").length, 1);
  assert.deepEqual(
    root.parts.filter((part) => part.role === "module").map((part) => [part.moduleId, part.moduleVersion, part.execution]),
    [["p5", "1.11.11", "classic"]],
  );
  assert.ok(root.byteLength < 2_000_000);
  const html = new TextDecoder().decode(root.rootBytes);
  assert.doesNotMatch(html, /\/content\/|\/api\/onchain\/|https?:\/\//u);
  assert.match(html, /"compression":"gzip"/u);
  assert.match(html, /"id":"sketch\.js"/u);

  const tokenGraph = await buildKeelInlinePreEncodedTokenURIGraph(root);
  assert.equal(tokenGraph.schema, "keel-inline-preencoded-token-uri@1");
  assert.equal(tokenGraph.mediaType, "application/vnd.keel.token-uri-base64-fragment");
  assert.equal(tokenGraph.contextDelivery, "base64-html-tail");
  assert.equal(tokenGraph.parts.filter((part) => part.sourceKind === "existing").length, 3);
  assert.equal(tokenGraph.parts.filter((part) => part.sourceKind === "creator").length, 1);
  assert.equal(
    tokenGraph.creatorPublicationBytes,
    tokenGraph.parts.find((part) => part.sourceKind === "creator").bytes.byteLength,
  );
  assert.ok(tokenGraph.creatorPublicationBytes < tokenGraph.fragmentBytes.byteLength / 2);
  assert.doesNotMatch(new TextDecoder().decode(tokenGraph.fragmentBytes), /=/u);
  assert.match(new TextDecoder().decode(tokenGraph.htmlBytes), /"compression":"gzip"/u);
  assert.doesNotMatch(new TextDecoder().decode(tokenGraph.htmlBytes), /\/content\/|\/api\/onchain\/|https?:\/\//u);

  const decodedMiddle = Buffer.from(new TextDecoder().decode(tokenGraph.fragmentBytes), "base64").toString("utf8");
  assert.match(decodedMiddle, /^[A-Za-z0-9+/]+$/u);
  assert.deepEqual(Buffer.from(decodedMiddle, "base64"), Buffer.from(tokenGraph.htmlBytes));

  const prepared = await buildKeelPreparedOneOfOneTokenURI({
    graph: tokenGraph,
    chainId,
    collection: `0x${"ab".repeat(20)}`,
    collectionName: "Seed Current",
    description: "A deterministic p5 flow field </script> 雪",
    imageURI: "data:image/webp;base64,UklGRg==",
    manifestURI: `web3://0x${"cd".repeat(20)}:${chainId}/object/0x${"ef".repeat(32)}`,
    manifestDigest: `0x${"12".repeat(32)}`,
    artifact: {
      store: `0x${"cd".repeat(20)}`,
      objectId: `0x${"34".repeat(32)}`,
      digest: `0x${"56".repeat(32)}`,
      byteLength: 3_300,
      mediaType: "text/javascript",
    },
  });
  assert.equal(prepared.schema, "keel-prepared-one-of-one-token-uri@1");
  assert.equal(prepared.tokenURI, `data:application/json;base64,${new TextDecoder().decode(prepared.encodedPrefix)}${new TextDecoder().decode(tokenGraph.fragmentBytes)}${new TextDecoder().decode(prepared.encodedSuffix)}`);
  const metadata = JSON.parse(prepared.tokenJSON);
  assert.equal(metadata.name, "Seed Current #1");
  assert.equal(metadata.description, "A deterministic p5 flow field </script> 雪");
  assert.deepEqual(metadata.keel_artifact, {
    store: `0x${"cd".repeat(20)}`,
    object_id: `0x${"34".repeat(32)}`,
    digest: `0x${"56".repeat(32)}`,
    byte_length: 3_300,
    media_type: "text/javascript",
    uri: `web3://0x${"cd".repeat(20)}:${chainId}/haulObject/0x${"34".repeat(32)}?mime.type=text%2Fjavascript`,
  });
  assert.match(metadata.animation_url, /^data:text\/html;base64,/u);
  assert.match(metadata.animation_url, /^data:text\/html;base64,/u);
  const animationPayload = metadata.animation_url.slice(metadata.animation_url.indexOf(",") + 1);
  assert.match(animationPayload, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
  assert.doesNotMatch(animationPayload, /[#?&_-]/u);
  const animationHTML = Buffer.from(animationPayload, "base64").toString("utf8");
  assert.match(animationHTML, /__KEEL_CONTEXT__/u);
  assert.match(animationHTML, /__KEEL_ONCHAIN_CONTEXT__/u);
  assert.match(animationHTML, new RegExp(prepared.contextDigest, "u"));
  assert.equal(JSON.parse(prepared.contextJSON).derivedTokenSeed, prepared.derivedTokenSeed);
  assert.doesNotMatch(new TextDecoder().decode(prepared.encodedPrefix), /=/u);

  await assert.rejects(
    buildKeelPreparedOneOfOneTokenURI({
      graph: tokenGraph,
      chainId,
      collection: `0x${"ab".repeat(20)}`,
      collectionName: "Unsafe image",
      description: "raw SVG data URI",
      imageURI: "data:image/svg+xml,<svg></svg>",
      manifestURI: `web3://0x${"cd".repeat(20)}:${chainId}/object/0x${"ef".repeat(32)}`,
      manifestDigest: `0x${"12".repeat(32)}`,
    }),
    /must be percent-escaped/u,
  );
});

test("canonical Inline publication has one shell top, ordered middle, and one shell bottom", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  const p5 = await buildKeelInlineModuleFragment({
    moduleId: "p5.js",
    version: "1.11.3",
    mediaType: "text/javascript",
    decodedBytes: utf8("globalThis.p5=class{}"),
    execution: "classic",
  });
  const seed = await buildKeelInlineModuleFragment({
    moduleId: "keel.seeded-random",
    version: "1.0.0",
    mediaType: "text/javascript",
    decodedBytes: utf8("globalThis.keelSeed=()=>1"),
    execution: "module",
  });
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [p5, seed],
    entry: { id: "sketch.js", mediaType: "text/javascript", source: utf8("new p5(()=>{});") },
  });
  assert.deepEqual(local.parts.map((part) => part.role), ["shell-prefix", "module", "module", "entrypoint", "shell-suffix"]);
  const graph = await buildKeelInlinePreEncodedTokenURIGraph(local);
  assert.deepEqual(graph.parts.map((part) => part.role), ["shell-prefix", "module", "module", "entrypoint", "shell-suffix"]);
  assert.equal(graph.parts.filter((part) => part.role === "shell-prefix").length, 1);
  assert.equal(graph.parts.filter((part) => part.role === "shell-suffix").length, 1);
  assert.equal(graph.parts.some((part) => part.sourceObjectId !== undefined), false);
});

test("creator HTML is one verified middle slot inside the canonical shell", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  const source = utf8('<main id="work"><canvas></canvas><script>globalThis.rendered=true</script></main>');
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [],
    entry: { id: "creator.html", mediaType: "text/html", source },
  });
  assert.deepEqual(local.parts.map((part) => part.role), ["shell-prefix", "entrypoint", "shell-suffix"]);
  assert.equal(local.parts.filter((part) => part.role === "shell-prefix").length, 1);
  assert.equal(local.parts.filter((part) => part.role === "shell-suffix").length, 1);
  assert.equal(new TextDecoder().decode(local.rootBytes).includes("creator.html"), true);
  assert.equal(local.rootBytes.byteLength < source.byteLength + shell.prefix.bytes.byteLength + shell.suffix.bytes.byteLength + 1_000, true);
});

test("normal media uses the registered shell and asset-display module without a creator wrapper", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  const inputs = [
    { id: "poster.webp", mediaType: "image/webp", source: new Uint8Array([0x52, 0x49, 0x46, 0x46]) },
    { id: "loop.webm", mediaType: "video/webm", source: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) },
    { id: "scene.glb", mediaType: "model/gltf-binary", source: new Uint8Array([0x67, 0x6c, 0x54, 0x46]) },
  ];
  const documents = await Promise.all(inputs.map((asset) => buildKeelInlineNormalMediaDocument({ shell, asset })));

  assert.deepEqual(documents.map((document) => document.parts.map((part) => part.role)), [
    ["shell-prefix", "module", "entrypoint", "shell-suffix"],
    ["shell-prefix", "module", "entrypoint", "shell-suffix"],
    ["shell-prefix", "module", "entrypoint", "shell-suffix"],
  ]);
  for (const [index, document] of documents.entries()) {
    const asset = inputs[index];
    assert.equal(document.declaration.shellId, KEEL_INLINE_PROTECTION_SHELL_ID);
    assert.equal(document.declaration.assetDisplay.moduleId, KEEL_ASSET_DISPLAY_MODULE_ID);
    assert.deepEqual(document.parts.filter((part) => part.kind === "creator").map((part) => part.role), ["entrypoint"]);
    assert.equal(document.declaration.creatorAsset.id, asset.id);
    assert.equal(document.declaration.creatorAsset.mediaType, asset.mediaType);
    assert.match(new TextDecoder().decode(document.rootBytes), new RegExp(`"id":"${asset.id}"`, "u"));
    assert.doesNotMatch(new TextDecoder().decode(document.rootBytes), /index\.html|local-shell|viewer\.js/u);
  }
  assert.deepEqual(inputs.map((asset) => keelAssetDisplayKind(asset.mediaType)), ["image", "video", "model"]);
  assert.throws(() => keelAssetDisplayKind("model/gltf+json"), /does not support/u);

  const display = await buildKeelInlineAssetDisplayModuleFragment();
  const firstDisplayBytes = keelAssetDisplayModuleBytes();
  const expectedFirstByte = firstDisplayBytes[0];
  firstDisplayBytes[0] ^= 0xff;
  const secondDisplayBytes = keelAssetDisplayModuleBytes();
  assert.equal(secondDisplayBytes[0], expectedFirstByte);
  assert.notDeepEqual(firstDisplayBytes, secondDisplayBytes);
  assert.equal(display.item.integrity.byteLength, secondDisplayBytes.byteLength);
  const displaySource = new TextDecoder().decode(secondDisplayBytes);
  assert.match(displaySource, /createElement\("img"\)/u);
  assert.match(displaySource, /createElement\("video"\)/u);
  assert.match(displaySource, /model\/gltf-binary/u);
  assert.match(displaySource, /getContext\("webgl"/u);
  assert.match(displaySource, /__KEEL_ENTRY__/u);
  assert.doesNotMatch(displaySource, /fetch\(|ethereum|wallet|XMLHttpRequest/u);

  await assert.rejects(
    buildKeelInlineLocalDocument({ shell, modules: [], entry: inputs[0] }),
    /exactly one registered keel\.asset-display/u,
  );
  const counterfeit = await buildKeelInlineModuleFragment({
    moduleId: KEEL_ASSET_DISPLAY_MODULE_ID,
    version: "1.0.0",
    mediaType: "text/javascript",
    decodedBytes: utf8("globalThis.notTheKeelAssetDisplay=true"),
    compression: "gzip",
    execution: "classic",
    phase: "render",
  });
  await assert.rejects(
    buildKeelInlineLocalDocument({ shell, modules: [counterfeit], entry: inputs[0] }),
    /exact registered keel\.asset-display/u,
  );
});

test("normal-media pre-encoded graphs accept only the registered shell and display module", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  const document = await buildKeelInlineNormalMediaDocument({
    shell,
    asset: { id: "poster.png", mediaType: "image/png", source: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  });
  const local = await buildKeelInlinePreEncodedTokenURIGraph(document);
  const existingParts = local.parts.filter((part) => part.sourceKind === "existing").map((part, index) => ({
    bytes: part.bytes,
    integrity: part.integrity,
    carrier: {
      chainId,
      store: `0x${"ab".repeat(20)}`,
      objectId: `0x${String(index + 1).padStart(64, "0")}`,
      mediaType: local.mediaType,
      compression: "none",
      storedByteLength: part.bytes.byteLength,
    },
  }));
  const graph = await buildKeelRegisteredInlineNormalMediaTokenURIGraph({
    document,
    existingParts,
  });
  assert.deepEqual(graph.parts.map((part) => [part.sourceKind, part.role]), [
    ["existing", "shell-prefix"],
    ["existing", "module"],
    ["creator", "entrypoint"],
    ["existing", "shell-suffix"],
  ]);
  assert.equal(graph.creatorPublicationBytes, graph.parts[2].bytes.byteLength);
  assert.equal(graph.parts[1].sourceObjectId, existingParts[1].carrier.objectId);
  await assert.rejects(
    buildKeelRegisteredInlineNormalMediaTokenURIGraph({
      document,
      shellId: `0x${"ff".repeat(32)}`,
      existingParts,
    }),
    /canonical registered KEEL Inline protection shell/u,
  );
  const counterfeitShell = {
    ...document,
    parts: [
      { ...document.parts[0], bytes: utf8("counterfeit shell"), byteLength: 17 },
      ...document.parts.slice(1),
    ],
  };
  await assert.rejects(
    buildKeelRegisteredInlineNormalMediaTokenURIGraph({ document: counterfeitShell, existingParts }),
    /exact canonical KEEL shell and asset-display declarations/u,
  );
});

test("published canonical fragments survive platform-specific module recompression", async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot });
  const moduleBytes = utf8(`globalThis.p5=${JSON.stringify("flow".repeat(20_000))}`);
  const aliases = ["p5.min.js", "./p5.min.js", "p5.js"];
  const canonicalModule = await buildKeelInlineModuleFragment({
    moduleId: "p5.js",
    version: "1.11.3",
    mediaType: "text/javascript",
    aliases,
    decodedBytes: moduleBytes,
    compression: "gzip",
    execution: "classic",
  });
  const canonicalRoot = await buildKeelInlineLocalDocument({
    shell,
    modules: [canonicalModule],
    entry: { id: "sketch.js", mediaType: "text/javascript", source: utf8("new p5(()=>{});") },
  });
  const canonicalGraph = await buildKeelInlinePreEncodedTokenURIGraph(canonicalRoot);
  const published = canonicalGraph.parts.filter((part) => part.sourceKind === "existing").map((part, index) => ({
    bytes: part.bytes,
    integrity: part.integrity,
    carrier: {
      chainId,
      store: `0x${"ab".repeat(20)}`,
      objectId: `0x${String(index + 1).padStart(64, "0")}`,
      mediaType: canonicalGraph.mediaType,
      compression: "none",
      storedByteLength: part.bytes.byteLength,
    },
  }));
  await verifyKeelPublishedInlineModuleFragment({
    fragment: published[1],
    moduleId: "p5.js",
    mediaType: "text/javascript",
    aliases,
    decodedBytes: moduleBytes,
  });

  // Deflate stands in for another runtime's byte-different compression. The
  // creator graph must consume the already-published canonical gzip slot.
  const recompressedModule = await buildKeelInlineModuleFragment({
    moduleId: "p5.js",
    version: "1.11.3",
    mediaType: "text/javascript",
    aliases,
    decodedBytes: moduleBytes,
    compression: "deflate",
    execution: "classic",
  });
  const recompressedRoot = await buildKeelInlineLocalDocument({
    shell,
    modules: [recompressedModule],
    entry: { id: "sketch.js", mediaType: "text/javascript", source: utf8("new p5(()=>{});") },
  });
  const reusedGraph = await buildKeelInlinePreEncodedTokenURIGraph(recompressedRoot, { existingParts: published });
  assert.deepEqual(
    reusedGraph.parts.filter((part) => part.sourceKind === "existing").map((part) => part.integrity.digest),
    published.map((part) => part.integrity.digest),
  );
  assert.match(new TextDecoder().decode(reusedGraph.htmlBytes), /"compression":"gzip"/u);
  assert.doesNotMatch(new TextDecoder().decode(reusedGraph.htmlBytes), /"compression":"deflate"/u);
  await assert.rejects(
    verifyKeelPublishedInlineModuleFragment({
      fragment: published[1],
      moduleId: "p5.js",
      mediaType: "text/javascript",
      aliases,
      decodedBytes: utf8("tampered"),
    }),
    /payload does not match|metadata does not match/u,
  );
});
