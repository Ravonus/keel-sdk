import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIntegrity } from "../packages/protocol/dist/index.js";
import {
  advanceCreatorPublication,
  finalizeCreatorPublication,
  prepareCreatorPublication,
  prepareCreatorPublicationFromDirectory,
  serializeCreatorPreparedPublication,
  serializeCreatorPublicationAdvance,
  serializeCreatorResolvedPublication,
} from "../packages/builder/dist/index.js";

const bytes = (value) => new TextEncoder().encode(value);
const id = (digit) => `0x${digit.repeat(64)}`;

async function node(key, file, mediaType, text) {
  return { key, file, mediaType, integrity: await createIntegrity(bytes(text)), objectId: null, text };
}

async function fixture() {
  const dependency = await node("object:dep", "dep.js", "text/javascript", "export const ready = true;\n");
  const root = await node("object:root", "root.html", "text/html", '<script type="module" src="./dep.js"></script>\n');
  const plan = {
    schema: "keel-creator-publication-plan@1",
    nodes: [root, dependency].map(({ text, ...value }) => value),
    edges: [{ consumer: root.key, dependency: dependency.key, localSpecifier: "./dep.js", publishResolution: "object-id-from-receipt" }],
    surfaces: [],
  };
  return { plan, dependency, root };
}

function receipt(node, objectId, preparedIntegrity = node.integrity, mediaType = node.mediaType, byteLength = preparedIntegrity.byteLength) {
  return {
    nodeKey: node.key,
    originalIntegrity: node.integrity,
    preparedIntegrity,
    byteLength,
    mediaType,
    objectId,
    evidence: { status: "accepted", reference: "offline-test" },
  };
}

test("staged creator publication deduplicates bytes, publishes leaves first, and rehashes roots after aliases", async () => {
  const { plan, dependency, root } = await fixture();
  const prepared = await prepareCreatorPublication(plan, [
    { key: dependency.key, bytes: bytes(dependency.text) },
    { key: root.key, bytes: bytes(root.text) },
  ]);
  assert.deepEqual(prepared.stages.map((stage) => stage.nodeKeys), [["object:dep"], ["object:root"]]);
  const alias = `keel://creator/${id("a").slice(2)}`;
  const rootBytes = bytes(`<script type="module" src="${alias}"></script>\n`);
  const rootPrepared = await createIntegrity(rootBytes);
  const resolved = await finalizeCreatorPublication(prepared, [
    receipt(dependency, id("a")),
    receipt(root, id("b"), rootPrepared),
  ]);
  assert.equal(resolved.edges[0]?.resolvedAlias, alias);
  assert.deepEqual(resolved.roots.map((entry) => entry.key), ["object:root"]);
  assert.equal(new TextDecoder().decode(resolved.roots[0]?.preparedBytes), `<script type="module" src="${alias}"></script>\n`);
  assert.equal(resolved.roots[0]?.preparedIntegrity.digest, rootPrepared.digest);

  const css = await node("object:style-a", "a.css", "text/css", ".same{color:red}\n");
  const cssAlias = await node("object:style-b", "b.css", "text/css", ".same{color:red}\n");
  const jsSameBytes = await node("object:script", "script.js", "text/javascript", ".same{color:red}\n");
  const deduped = await prepareCreatorPublication({ ...plan, nodes: [css, cssAlias, jsSameBytes].map(({ text, ...value }) => value), edges: [] }, [
    { key: jsSameBytes.key, bytes: bytes(jsSameBytes.text) },
    { key: cssAlias.key, bytes: bytes(cssAlias.text) },
    { key: css.key, bytes: bytes(css.text) },
  ]);
  assert.equal(deduped.nodes.length, 2, "byte-identical CSS aliases deduplicate, unlike same bytes with another media type");
  assert.deepEqual(deduped.nodes.find((entry) => entry.mediaType === "text/css")?.aliases, ["object:style-a", "object:style-b"]);
});

test("creator publication fails closed on stale receipts, malformed graph edges, and ambiguous substitutions", async () => {
  const { plan, dependency, root } = await fixture();
  const sources = [{ key: root.key, bytes: bytes(root.text) }, { key: dependency.key, bytes: bytes(dependency.text) }];
  const prepared = await prepareCreatorPublication(plan, sources);
  const alias = `keel://creator/${id("a").slice(2)}`;
  const rootPrepared = await createIntegrity(bytes(`<script type="module" src="${alias}"></script>\n`));
  const good = [receipt(dependency, id("a")), receipt(root, id("b"), rootPrepared)];
  for (const bad of [
    [receipt(dependency, id("a"), { ...dependency.integrity, digest: id("c") }), good[1]],
    [receipt(dependency, id("a"), dependency.integrity, "text/css"), good[1]],
    [receipt(dependency, id("a"), dependency.integrity, dependency.mediaType, 1), good[1]],
    [receipt(dependency, "0xABC"), good[1]],
    [good[0]],
    [...good, receipt({ ...dependency, key: "object:extra" }, id("d"))],
    [good[0], good[0], good[1]],
  ]) await assert.rejects(() => finalizeCreatorPublication(prepared, bad), /receipt|object id|exactly once/u);

  await assert.rejects(() => prepareCreatorPublication({ ...plan, edges: [...plan.edges, plan.edges[0]] }, sources), /duplicate or ambiguous edge/u);
  await assert.rejects(() => prepareCreatorPublication({ ...plan, edges: [...plan.edges, { ...plan.edges[0], consumer: dependency.key, dependency: root.key, localSpecifier: "./root.html" }] }, sources), /cyclic/u);
  const ambiguousRoot = '<script src="./dep.js"></script><script src="./dep.js"></script>';
  const ambiguous = { ...root, integrity: await createIntegrity(bytes(ambiguousRoot)), text: ambiguousRoot };
  const ambiguousPlan = { ...plan, nodes: [ambiguous, dependency].map(({ text, ...value }) => value) };
  const ambiguousPrepared = await prepareCreatorPublication(ambiguousPlan, [{ key: ambiguous.key, bytes: bytes(ambiguous.text) }, sources[1]]);
  await assert.rejects(() => finalizeCreatorPublication(ambiguousPrepared, [receipt(dependency, id("a")), receipt(ambiguous, id("b"), ambiguous.integrity)]), /ambiguous or absent/u);
});

test("creator publication preparation is insertion-order independent", async () => {
  const { plan, dependency, root } = await fixture();
  const first = await prepareCreatorPublication(plan, [{ key: root.key, bytes: bytes(root.text) }, { key: dependency.key, bytes: bytes(dependency.text) }]);
  const second = await prepareCreatorPublication({ ...plan, nodes: [...plan.nodes].reverse() }, [{ key: dependency.key, bytes: bytes(dependency.text) }, { key: root.key, bytes: bytes(root.text) }]);
  assert.deepEqual(first.stages, second.stages);
  assert.deepEqual(first.nodes.map((entry) => [entry.key, entry.aliases, entry.originalIntegrity.digest]), second.nodes.map((entry) => [entry.key, entry.aliases, entry.originalIntegrity.digest]));
});

test("creator publication advances only complete accepted stages and returns exact next bytes", async () => {
  const { plan, dependency, root } = await fixture();
  const prepared = await prepareCreatorPublication(plan, [
    { key: dependency.key, bytes: bytes(dependency.text) },
    { key: root.key, bytes: bytes(root.text) },
  ]);
  const first = await advanceCreatorPublication(prepared, []);
  assert.deepEqual(first.acceptedNodeKeys, []);
  assert.deepEqual(first.readyStage?.nodeKeys, [dependency.key]);
  assert.equal(new TextDecoder().decode(first.ready[0]?.preparedBytes), dependency.text);
  assert.deepEqual(first.ready[0]?.preparedIntegrity, dependency.integrity);

  await assert.rejects(
    () => advanceCreatorPublication(prepared, [receipt(root, id("b"))]),
    /later creator publication stage/u,
    "a parent receipt is not accepted before its dependency stage",
  );

  const acceptedDependency = receipt(dependency, id("a"));
  const second = await advanceCreatorPublication(prepared, [acceptedDependency]);
  const alias = `keel://creator/${id("a").slice(2)}`;
  const parentBytes = bytes(`<script type="module" src="${alias}"></script>\n`);
  const parentIntegrity = await createIntegrity(parentBytes);
  assert.deepEqual(second.acceptedNodeKeys, [dependency.key]);
  assert.deepEqual(second.readyStage?.nodeKeys, [root.key]);
  assert.equal(new TextDecoder().decode(second.ready[0]?.preparedBytes), new TextDecoder().decode(parentBytes));
  assert.deepEqual(second.ready[0]?.preparedIntegrity, parentIntegrity);
  await assert.rejects(() => finalizeCreatorPublication(prepared, [acceptedDependency]), /requires every logical node receipt/u);

  const complete = await finalizeCreatorPublication(prepared, [acceptedDependency, receipt(root, id("b"), parentIntegrity)]);
  assert.deepEqual(complete.nodes.map((entry) => entry.key), [dependency.key, root.key]);
});

test("creator publication rewrites only real HTML and CSS dependency tokens", async () => {
  const js = await node("object:script", "script.js", "text/javascript", "export const ready = true;\n");
  const css = await node("object:style", "style.css", "text/css", ".ready{color:green}\n");
  const htmlText = [
    '<!-- <script src="./script.js"></script> -->',
    '<script type="module" src="./script.js"></script>',
    '<img data-src="./script.js">',
    '<a href="./style.css">ignore</a>',
    '<link rel="stylesheet" href="./style.css">',
    '<link rel="icon" href="./style.css">',
    '<script>const ignored = "<script src=\\"./script.js\\">";</script>',
  ].join("\n");
  const html = await node("object:root", "root.html", "text/html", htmlText);
  const htmlPlan = {
    schema: "keel-creator-publication-plan@1",
    nodes: [html, js, css].map(({ text, ...value }) => value),
    edges: [
      { consumer: html.key, dependency: js.key, localSpecifier: "./script.js", publishResolution: "object-id-from-receipt" },
      { consumer: html.key, dependency: css.key, localSpecifier: "./style.css", publishResolution: "object-id-from-receipt" },
    ],
    surfaces: [],
  };
  const preparedHtml = await prepareCreatorPublication(htmlPlan, [
    { key: html.key, bytes: bytes(html.text) }, { key: js.key, bytes: bytes(js.text) }, { key: css.key, bytes: bytes(css.text) },
  ]);
  const jsAlias = `keel://creator/${id("a").slice(2)}`;
  const cssAlias = `keel://creator/${id("b").slice(2)}`;
  const rewrittenHtml = htmlText
    .replace('type="module" src="./script.js"', `type="module" src="${jsAlias}"`)
    .replace('rel="stylesheet" href="./style.css"', `rel="stylesheet" href="${cssAlias}"`);
  const rewrittenHtmlIntegrity = await createIntegrity(bytes(rewrittenHtml));
  const finalizedHtml = await finalizeCreatorPublication(preparedHtml, [
    receipt(js, id("a")), receipt(css, id("b")), receipt(html, id("c"), rewrittenHtmlIntegrity),
  ]);
  const finalHtml = new TextDecoder().decode(finalizedHtml.roots[0]?.preparedBytes);
  assert.match(finalHtml, /<!-- <script src="\.\/script\.js"><\/script> -->/u);
  assert.match(finalHtml, new RegExp(`<script type="module" src="${jsAlias}">`, "u"));
  assert.match(finalHtml, /data-src="\.\/script\.js"/u);
  assert.match(finalHtml, /<a href="\.\/style\.css">/u);
  assert.match(finalHtml, new RegExp(`<link rel="stylesheet" href="${cssAlias}">`, "u"));
  assert.match(finalHtml, /<link rel="icon" href="\.\/style\.css">/u);

  const imported = await node("object:imported", "imported.css", "text/css", ".imported{}\n");
  const asset = await node("object:asset", "asset.css", "text/css", ".asset{}\n");
  const cssText = '/* @import "./imported.css"; url("./asset.css") */\n@import "./imported.css";\n.x{background:url("./asset.css")}\n.y{content:"url(\\"./asset.css\\")"}\n.z{background:noturl("./asset.css")}';
  const cssRoot = await node("object:css-root", "root.css", "text/css", cssText);
  const cssPlan = {
    schema: "keel-creator-publication-plan@1",
    nodes: [cssRoot, imported, asset].map(({ text, ...value }) => value),
    edges: [
      { consumer: cssRoot.key, dependency: imported.key, localSpecifier: "./imported.css", publishResolution: "object-id-from-receipt" },
      { consumer: cssRoot.key, dependency: asset.key, localSpecifier: "./asset.css", publishResolution: "object-id-from-receipt" },
    ],
    surfaces: [],
  };
  const preparedCss = await prepareCreatorPublication(cssPlan, [
    { key: cssRoot.key, bytes: bytes(cssRoot.text) }, { key: imported.key, bytes: bytes(imported.text) }, { key: asset.key, bytes: bytes(asset.text) },
  ]);
  const importedAlias = `keel://creator/${id("d").slice(2)}`;
  const assetAlias = `keel://creator/${id("e").slice(2)}`;
  const rewrittenCss = cssText
    .replace('\n@import "./imported.css";', `\n@import "${importedAlias}";`)
    .replace('.x{background:url("./asset.css")}', `.x{background:url("${assetAlias}")}`);
  const finalizedCss = await finalizeCreatorPublication(preparedCss, [
    receipt(imported, id("d")), receipt(asset, id("e")), receipt(cssRoot, id("f"), await createIntegrity(bytes(rewrittenCss))),
  ]);
  const finalCss = new TextDecoder().decode(finalizedCss.roots[0]?.preparedBytes);
  assert.match(finalCss, /\/\* @import "\.\/imported\.css"; url\("\.\/asset\.css"\) \*\//u);
  assert.match(finalCss, new RegExp(`@import "${importedAlias}"`, "u"));
  assert.match(finalCss, new RegExp(`url\\("${assetAlias}"\\)`, "u"));
  assert.match(finalCss, /noturl\("\.\/asset\.css"\)/u);
});

test("creator publication rejects tampered prepared bytes, malformed plans, and reused receipt ids", async () => {
  const { plan, dependency, root } = await fixture();
  const dependencyBytes = bytes(dependency.text);
  const prepared = await prepareCreatorPublication(plan, [
    { key: dependency.key, bytes: dependencyBytes }, { key: root.key, bytes: bytes(root.text) },
  ]);
  dependencyBytes[0] ^= 1;
  const stillCloned = await advanceCreatorPublication(prepared, []);
  assert.equal(new TextDecoder().decode(stillCloned.ready[0]?.preparedBytes), dependency.text, "input bytes are cloned at preparation");
  const mutablePreparedNode = prepared.nodes[0];
  assert.ok(mutablePreparedNode !== undefined);
  mutablePreparedNode.originalBytes[0] ^= 1;
  await assert.rejects(() => advanceCreatorPublication(prepared, []), /original bytes no longer match/u);

  const freshSources = [{ key: dependency.key, bytes: bytes(dependency.text) }, { key: root.key, bytes: bytes(root.text) }];
  for (const invalid of [
    { ...plan, nodes: [{ ...plan.nodes[0], objectId: id("a") }, plan.nodes[1]] },
    { ...plan, nodes: [{ ...plan.nodes[0], extra: true }, plan.nodes[1]] },
    { ...plan, edges: [{ ...plan.edges[0], publishResolution: "anything-else" }] },
    { ...plan, edges: [{ ...plan.edges[0], extra: true }] },
  ]) await assert.rejects(() => prepareCreatorPublication(invalid, freshSources), /exact (?:data )?shape|invalid exact shape/u);

  const complete = await prepareCreatorPublication(plan, freshSources);
  const parentBytes = bytes(`<script type="module" src="keel://creator/${id("a").slice(2)}"></script>\n`);
  const parentIntegrity = await createIntegrity(parentBytes);
  await assert.rejects(
    () => finalizeCreatorPublication(complete, [receipt(dependency, id("a")), receipt(root, id("a"), parentIntegrity)]),
    /reuses object id/u,
  );
});

test("creator publication accepts only plain JSON plans and receipts, with deterministic JSON views", async () => {
  const { plan, dependency, root } = await fixture();
  const sources = [{ key: dependency.key, bytes: bytes(dependency.text) }, { key: root.key, bytes: bytes(root.text) }];
  const surface = { name: "main", isolation: "sandbox", html: "main.html", entry: "main.js" };
  const accessorSurface = { ...surface };
  Object.defineProperty(accessorSurface, "entry", { enumerable: true, get: () => "main.js" });
  const inheritedSurface = Object.assign(Object.create({ inherited: true }), surface);
  for (const invalidSurface of [
    { ...surface, extra: true },
    { ...surface, entry: 1n },
    accessorSurface,
    inheritedSurface,
    new Proxy(surface, {}),
  ]) {
    await assert.rejects(
      () => prepareCreatorPublication({ ...plan, surfaces: [invalidSurface] }, sources),
      /plain data|exact data shape|bounded string|invalid exact shape/u,
    );
  }
  await assert.rejects(
    () => prepareCreatorPublication(plan, [{ ...sources[0], extra: 1n }, sources[1]]),
    /exact data shape/u,
    "source objects cannot smuggle non-JSON extras into a prepared publication",
  );

  const prepared = await prepareCreatorPublication({ ...plan, surfaces: [surface] }, sources);
  const firstAdvance = await advanceCreatorPublication(prepared, []);
  const parentBytes = bytes(`<script type="module" src="keel://creator/${id("a").slice(2)}"></script>\n`);
  const parentIntegrity = await createIntegrity(parentBytes);
  const completedReceipts = [receipt(dependency, id("a")), receipt(root, id("b"), parentIntegrity)];
  const badEvidence = receipt(dependency, id("a"));
  badEvidence.evidence = { status: "accepted", reference: 1n };
  const extraEvidence = receipt(dependency, id("a"));
  extraEvidence.evidence = { status: "accepted", reference: "offline-test", extra: true };
  const accessorEvidence = receipt(dependency, id("a"));
  Object.defineProperty(accessorEvidence.evidence, "reference", { enumerable: true, get: () => "offline-test" });
  const inheritedEvidence = receipt(dependency, id("a"));
  inheritedEvidence.evidence = Object.assign(Object.create({ inherited: true }), { status: "accepted", reference: "offline-test" });
  const inheritedReceipt = Object.assign(Object.create({ inherited: true }), receipt(dependency, id("a")));
  for (const invalidReceipt of [
    badEvidence,
    extraEvidence,
    accessorEvidence,
    inheritedEvidence,
    inheritedReceipt,
    new Proxy(receipt(dependency, id("a")), {}),
  ]) await assert.rejects(
    () => advanceCreatorPublication(prepared, [invalidReceipt]),
    /receipt|plain data|exact data shape|bounded string/u,
  );

  const resolved = await finalizeCreatorPublication(prepared, completedReceipts);
  const views = [
    serializeCreatorPreparedPublication(prepared),
    serializeCreatorPublicationAdvance(firstAdvance),
    serializeCreatorResolvedPublication(resolved),
  ];
  for (const view of views) {
    const encoded = JSON.stringify(view);
    assert.deepEqual(JSON.parse(encoded), JSON.parse(JSON.stringify(view)), "publication JSON views are deterministic and round-trip safely");
  }
  assert.equal(JSON.parse(JSON.stringify(views[2])).nodes[0].preparedBytes.encoding, "hex");
});

test("strict publication normalization never invokes accessors or proxy get traps", async () => {
  const { plan, dependency, root } = await fixture();
  const sources = [{ key: dependency.key, bytes: bytes(dependency.text) }, { key: root.key, bytes: bytes(root.text) }];
  const surface = { name: "main", isolation: "sandbox", html: "main.html", entry: "main.js" };
  let getterCalls = 0;
  const accessor = (value, key) => {
    const copy = { ...value };
    Object.defineProperty(copy, key, { enumerable: true, get() { getterCalls += 1; throw new Error("getter executed"); } });
    return copy;
  };
  const planCases = [
    { ...plan, surfaces: [accessor(surface, "entry")] },
    { ...plan, nodes: [accessor(plan.nodes[0], "key"), plan.nodes[1]] },
    { ...plan, nodes: [{ ...plan.nodes[0], integrity: accessor(plan.nodes[0].integrity, "digest") }, plan.nodes[1]] },
    { ...plan, edges: [accessor(plan.edges[0], "localSpecifier")] },
  ];
  for (const invalid of planCases) await assert.rejects(() => prepareCreatorPublication(invalid, sources), /plain data|exact data shape/u);
  await assert.rejects(
    () => prepareCreatorPublication(plan, [accessor(sources[0], "key"), sources[1]]),
    /plain data|exact data shape/u,
  );
  assert.equal(getterCalls, 0, "surface, node, integrity, edge, and source accessors must not execute");

  let proxyGets = 0;
  const proxied = (value) => new Proxy(value, { get() { proxyGets += 1; throw new Error("proxy get executed"); } });
  for (const [invalidPlan, invalidSources] of [
    [{ ...plan, surfaces: [proxied(surface)] }, sources],
    [{ ...plan, nodes: [proxied(plan.nodes[0]), plan.nodes[1]] }, sources],
    [{ ...plan, nodes: [{ ...plan.nodes[0], integrity: proxied(plan.nodes[0].integrity) }, plan.nodes[1]] }, sources],
    [{ ...plan, edges: [proxied(plan.edges[0])] }, sources],
    [plan, [proxied(sources[0]), sources[1]]],
  ]) await assert.rejects(() => prepareCreatorPublication(invalidPlan, invalidSources), /plain data|exact data shape/u);
  assert.equal(proxyGets, 0, "surface, node, integrity, edge, and source proxy get traps must not execute");
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
    const throwing = new Proxy(surface, { [trap]() { throw new Error(`${trap} executed`); } });
    await assert.rejects(
      () => prepareCreatorPublication({ ...plan, surfaces: [throwing] }, sources),
      /plain data|exact data shape/u,
      `${trap} proxies fail closed`,
    );
  }

  const prepared = await prepareCreatorPublication(plan, sources);
  const parentIntegrity = await createIntegrity(bytes(`<script type="module" src="keel://creator/${id("a").slice(2)}"></script>\n`));
  const baseReceipt = receipt(dependency, id("a"));
  const receiptCases = [
    accessor(baseReceipt, "nodeKey"),
    { ...baseReceipt, originalIntegrity: accessor(baseReceipt.originalIntegrity, "digest") },
    { ...baseReceipt, evidence: accessor(baseReceipt.evidence, "reference") },
  ];
  for (const invalid of receiptCases) {
    await assert.rejects(() => advanceCreatorPublication(prepared, [invalid]), /receipt|plain data|exact data shape/u);
  }
  assert.equal(getterCalls, 0, "receipt, evidence, and receipt integrity accessors must not execute");
  for (const invalid of [
    proxied(baseReceipt),
    { ...baseReceipt, originalIntegrity: proxied(baseReceipt.originalIntegrity) },
    { ...baseReceipt, evidence: proxied(baseReceipt.evidence) },
  ]) await assert.rejects(() => advanceCreatorPublication(prepared, [invalid]), /receipt|plain data|exact data shape/u);
  assert.equal(proxyGets, 0, "receipt, evidence, and receipt integrity proxy get traps must not execute");
  void parentIntegrity;
});

test("strict publication text rejects every C0 control and DEL in metadata lanes", async () => {
  const { plan, dependency, root } = await fixture();
  const sources = [{ key: dependency.key, bytes: bytes(dependency.text) }, { key: root.key, bytes: bytes(root.text) }];
  const surface = { name: "main", isolation: "sandbox", html: "main.html", entry: "main.js" };
  const prepared = await prepareCreatorPublication(plan, sources);
  const controls = [...Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)), String.fromCharCode(0x7f)];
  for (const control of controls) {
    const nodeValue = plan.nodes[0];
    const edgeValue = plan.edges[0];
    const invalidPlans = [
      { ...plan, surfaces: [{ ...surface, name: `main${control}` }] },
      { ...plan, surfaces: [{ ...surface, html: `main${control}.html` }] },
      { ...plan, surfaces: [{ ...surface, entry: `main${control}.js` }] },
      { ...plan, nodes: [{ ...nodeValue, key: `object:${control}root` }, plan.nodes[1]] },
      { ...plan, nodes: [{ ...nodeValue, file: `root${control}.html` }, plan.nodes[1]] },
      { ...plan, nodes: [{ ...nodeValue, mediaType: `text/${control}html` }, plan.nodes[1]] },
      { ...plan, nodes: [{ ...nodeValue, integrity: { ...nodeValue.integrity, algorithm: `sha256${control}` } }, plan.nodes[1]] },
      { ...plan, nodes: [{ ...nodeValue, integrity: { ...nodeValue.integrity, digest: `${nodeValue.integrity.digest}${control}` } }, plan.nodes[1]] },
      { ...plan, nodes: [{ ...nodeValue, [`extra${control}`]: true }, plan.nodes[1]] },
      { ...plan, edges: [{ ...edgeValue, consumer: `${edgeValue.consumer}${control}` }] },
      { ...plan, edges: [{ ...edgeValue, dependency: `${edgeValue.dependency}${control}` }] },
      { ...plan, edges: [{ ...edgeValue, localSpecifier: `.${control}/dep.js` }] },
    ];
    for (const invalid of invalidPlans) {
      await assert.rejects(() => prepareCreatorPublication(invalid, sources), /bounded string|exact data shape|invalid/u);
    }
    await assert.rejects(
      () => prepareCreatorPublication(plan, [{ ...sources[0], key: `${sources[0].key}${control}` }, sources[1]]),
      /bounded string/u,
    );

    const invalidReceipts = [
      { ...receipt(dependency, id("a")), nodeKey: `${dependency.key}${control}` },
      { ...receipt(dependency, id("a")), mediaType: `text/${control}javascript` },
      { ...receipt(dependency, id("a")), objectId: `${id("a")}${control}` },
      { ...receipt(dependency, id("a")), evidence: { status: "accepted", reference: `offline${control}test` } },
      { ...receipt(dependency, id("a")), evidence: { status: `accepted${control}` } },
      { ...receipt(dependency, id("a")), originalIntegrity: { ...dependency.integrity, algorithm: `sha256${control}` } },
      { ...receipt(dependency, id("a")), preparedIntegrity: { ...dependency.integrity, digest: `${dependency.integrity.digest}${control}` } },
    ];
    for (const invalid of invalidReceipts) {
      await assert.rejects(() => advanceCreatorPublication(prepared, [invalid]), /bounded string|receipt|evidence|invalid/u);
    }
  }
});

test("creator publication directory reads reject nested output symlinks", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "keel-publication-output-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "keel-publication-outside-"));
  try {
    const value = "outside bytes\n";
    await writeFile(path.join(outside, "entry.js"), value);
    await mkdir(fixture, { recursive: true });
    await symlink(outside, path.join(fixture, "library"), "dir");
    const item = await node("object:library/shared/entry.js", "library/shared/entry.js", "text/javascript", value);
    const plan = { schema: "keel-creator-publication-plan@1", nodes: [(({ text, ...entry }) => entry)(item)], edges: [], surfaces: [] };
    await assert.rejects(() => prepareCreatorPublicationFromDirectory(plan, fixture), /symbolic link/u);
  } finally {
    await Promise.all([rm(fixture, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});
