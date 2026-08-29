import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildKeelInlineLocalDocument,
  buildKeelInlineModuleFragment,
  buildKeelInlinePreEncodedTokenURIGraph,
  buildKeelPreparedOneOfOneTokenURI,
  buildKeelInlineShellFragments,
  concatenateComposableBase64Fragments,
  createComposableBase64Fragment,
  serializeInlineScriptJSON,
  verifyKeelPublishedInlineModuleFragment,
} from "../packages/sdk/dist/inline-viewer-graph.js";

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
  assert.match(serialized, /\\u003c\/script>/u);
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
  assert.ok(shell.prefix.bytes.byteLength + shell.suffix.bytes.byteLength < 8_000);
  const shellText = new TextDecoder().decode(new Uint8Array([
    ...shell.prefix.bytes,
    ...shell.suffix.bytes,
  ]));
  assert.match(shellText, /DecompressionStream/u);
  assert.match(shellText, /globalThis\.crypto\?\.subtle/u);
  assert.match(shellText, /Uint32Array\.from/u);
  assert.match(shellText, /__KEEL_ITEMS__/u);
  assert.doesNotMatch(shellText, /brotli-dec-wasm|keel-verification-envelope|verify-corner|eth_call|fetch\(/iu);

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
  assert.equal(tokenGraph.parts.filter((part) => part.sourceKind === "existing").length, 3);
  assert.equal(tokenGraph.parts.filter((part) => part.sourceKind === "creator").length, 1);
  assert.equal(
    tokenGraph.creatorPublicationBytes,
    tokenGraph.parts.find((part) => part.sourceKind === "creator").bytes.byteLength,
  );
  assert.ok(tokenGraph.creatorPublicationBytes < tokenGraph.fragmentBytes.byteLength / 2);
  assert.doesNotMatch(new TextDecoder().decode(tokenGraph.fragmentBytes), /=/u);
  assert.match(new TextDecoder().decode(tokenGraph.htmlBytes), /keel-context-digest/u);
  assert.match(new TextDecoder().decode(tokenGraph.htmlBytes), /"compression":"gzip"/u);
  assert.doesNotMatch(new TextDecoder().decode(tokenGraph.htmlBytes), /\/content\/|\/api\/onchain\/|https?:\/\//u);

  const decodedMiddle = Buffer.from(new TextDecoder().decode(tokenGraph.fragmentBytes), "base64").toString("utf8");
  assert.match(decodedMiddle, /#(?:_x{1,2}=&)?keel-context=$/u);
  const htmlBase64 = decodedMiddle.slice(0, decodedMiddle.lastIndexOf("#"));
  assert.deepEqual(Buffer.from(htmlBase64, "base64"), Buffer.from(tokenGraph.htmlBytes));

  const prepared = await buildKeelPreparedOneOfOneTokenURI({
    graph: tokenGraph,
    chainId,
    collection: `0x${"ab".repeat(20)}`,
    collectionName: "Seed Current",
    description: "A deterministic p5 flow field </script> 雪",
    imageURI: "data:image/webp;base64,UklGRg==",
    manifestURI: `web3://0x${"cd".repeat(20)}:${chainId}/object/0x${"ef".repeat(32)}`,
    manifestDigest: `0x${"12".repeat(32)}`,
  });
  assert.equal(prepared.schema, "keel-prepared-one-of-one-token-uri@1");
  assert.equal(prepared.tokenURI, `data:application/json;base64,${new TextDecoder().decode(prepared.encodedPrefix)}${new TextDecoder().decode(tokenGraph.fragmentBytes)}${new TextDecoder().decode(prepared.encodedSuffix)}`);
  const metadata = JSON.parse(prepared.tokenJSON);
  assert.equal(metadata.name, "Seed Current #1");
  assert.equal(metadata.description, "A deterministic p5 flow field </script> 雪");
  assert.match(metadata.animation_url, /^data:text\/html;base64,/u);
  assert.match(metadata.animation_url, /#(?:_x{1,2}=&)?keel-context=/u);
  assert.match(metadata.animation_url, /&keel-context-digest=0x[0-9a-f]{64}/u);
  assert.equal(JSON.parse(prepared.contextJSON).derivedTokenSeed, prepared.derivedTokenSeed);
  assert.doesNotMatch(new TextDecoder().decode(prepared.encodedPrefix), /=/u);
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
