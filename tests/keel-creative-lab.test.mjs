import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../examples/demos/keel-creative-lab/", import.meta.url);
const source = async (name) => readFile(new URL(name, root), "utf8");

test("Creative Lab edge matrix binds real compact and hybrid image bytes", async () => {
  const matrix = JSON.parse(await source("edge-case-matrix.json"));
  assert.equal(matrix.viewerInvariant, "onchain-html-wrapper");
  assert.equal(matrix.failurePolicy, "fail-closed-in-wrapper");
  for (const standard of ["erc721", "erc721a", "erc1155", "erc4906", "erc7496", "erc7508", "erc5773", "custom-no-hook"]) {
    assert.ok(matrix.standards.some((entry) => entry.id === standard), `missing ${standard}`);
  }
  for (const asset of matrix.assets) {
    const bytes = await readFile(new URL(asset.file, root));
    assert.equal(bytes.byteLength, asset.decodedBytes, `${asset.id} byte length`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.decodedSha256, `${asset.id} sha256`);
  }
  for (const hostile of ["missing-source", "wrong-decoded-sha256", "wrong-compression", "brotli-truncation", "recursive-cycle", "runtime-timeout"]) {
    assert.ok(matrix.hostileCases.includes(hostile), `missing hostile ${hostile}`);
  }
  assert.equal(matrix.schema, "keel-creative-lab-edge-matrix@2");
  for (const moduleId of ["p5", "three", "image", "video", "classic-script", "api-algorithm"]) {
    assert.ok(matrix.moduleCases.some((entry) => entry.id === moduleId), `missing ${moduleId} module case`);
  }
  for (const policyId of ["code.locked", "css.creator", "palette.owner", "api.weather"]) {
    assert.ok(matrix.presentationPolicies.some((entry) => entry.id === policyId), `missing ${policyId} policy`);
  }
  for (const hostile of ["unauthorized-css-revision", "immutable-code-revision", "api-wrong-media-type", "api-uncommitted-response", "api-stale-sequence", "verifier-api-not-enabled"]) {
    assert.ok(matrix.hostileCases.includes(hostile), `missing ${hostile}`);
  }
});

test("Creative Lab exposes fixed, seeded, and editable p5 and Three scenes", async () => {
  const [html, lab, scenes, viewer] = await Promise.all([
    source("index.html"), source("lab.js"), source("creative-scenes.js"), source("viewer.html"),
  ]);
  for (const id of [
    "p5-one", "p5-seeded", "p5-edit", "p5-image-onchain", "p5-image-hybrid",
    "three-one", "three-seeded", "three-edit", "three-texture-onchain", "three-texture-hybrid", "three-heavy", "three-mixed",
    "image-only", "video-loop", "script-pulse", "api-weather",
  ]) {
    assert.match(lab, new RegExp(`id: "${id}"`, "u"));
  }
  assert.match(viewer, /vendor\/p5\.min\.js/u);
  assert.match(viewer, /vendor\/three\.min\.js/u);
  assert.match(viewer, /\/content\/three\.core\.min\.js/u);
  assert.match(viewer, /class P5CompatibleMutationObserver/u);
  assert.match(viewer, /globalThis\.WebKitMutationObserver = P5CompatibleMutationObserver/u);
  assert.match(viewer, /this\.#native\.observe\(target, options\)/u);
  assert.match(viewer, /setInterval\(\(\) => this\.#callback\(\[\], this\), 4\)/u);
  assert.match(viewer, /globalThis\.MutationObserver = NativeMutationObserver/u);
  assert.doesNotMatch(viewer, /globalThis\.MutationObserver = undefined/u);
  assert.doesNotMatch(scenes, /Math\.random/u);
  assert.match(scenes, /new THREE\.InstancedMesh\(geometry, material, count\)/u);
  assert.match(scenes, /new THREE\.TextureLoader\(\)\.load/u);
  assert.match(scenes, /p\.loadImage/u);
  assert.match(scenes, /export function mountImageScene/u);
  assert.match(scenes, /export function mountVideoScene/u);
  assert.match(scenes, /export function mountClassicScriptScene/u);
  assert.match(scenes, /export function mountApiWeatherScene/u);
  assert.match(scenes, /API snapshot format is not enabled by the Keel manifest/u);
  assert.match(viewer, /aurora-signal-loop-v1\.webm/u);
  assert.match(viewer, /keel-api-snapshot@1/u);
  assert.match(viewer, /aurora-data-horizon-onchain-v1\.webp/u);
  assert.match(viewer, /aurora-data-horizon-v1\.png/u);
  assert.match(viewer, /cosmic-mineral-field-onchain-v1\.webp/u);
  assert.match(viewer, /cosmic-mineral-field-v1\.png/u);
  assert.match(html, /Scene attributes/u);
  assert.match(html, /Recursive objects/u);
  assert.match(html, /Presentation revision/u);
  assert.match(html, /tokenURI proof/u);
  assert.match(html, /KEEL SOURCE VERIFICATION/u);
  assert.match(lab, /Reproducible build/u);
  assert.match(lab, /item\.decodedSha256 === item\.sourceReceipt\?\.output\?\.digest/u);
  assert.match(lab, /item\.compression === "brotli"/u);
  assert.match(lab, /item\.storageAuthentication === "onchain-immutable-bytes"/u);
  assert.match(lab, /item\.runtimeVerification === "recursive-decoded-sha256"/u);
  assert.match(lab, /item\.sourceBuildVerification === item\.sourceReceipt\?\.disposition/u);
  assert.match(lab, /item\.deliveryProfiles\?\.includes\("ordered-url-ipfs-then-onchain-gateway"\)/u);
  assert.match(lab, /item\.activeDeliveryProfile === "onchain-recursive"/u);
  assert.match(html, /Inspect exact upstream distribution/u);
  assert.match(html, /Browse readable source tree/u);
});

test("Creative Lab cannot claim an on-chain edit without a deployment receipt", async () => {
  const [html, lab] = await Promise.all([source("index.html"), source("lab.js")]);
  assert.match(html, /id="publish" type="button" disabled/u);
  assert.match(lab, /release\.schema !== "keel-creative-lab-release@1"/u);
  assert.match(lab, /This exact palette has not been built and committed as a Keel revision/u);
  assert.match(lab, /tokenURI did not change after the presentation revision/u);
  assert.match(lab, /recursive reads matched/u);
  assert.match(lab, /proofHash\(result\) !== check\.sha256/u);
  assert.match(lab, /transaction\.from\.toLowerCase\(\) !== account\.toLowerCase\(\)/u);
  assert.match(lab, /eth_getTransactionReceipt/u);
  assert.match(lab, /Number\(release\.chainId\) === 31337/u);
  assert.match(lab, /The release owner is not unlocked by this local Anvil node/u);
  assert.match(lab, /localAnvil[\s\S]*eth_sendTransaction/u);
});

test("Creative Lab release contract keeps preview controls separate from tracked revisions", async () => {
  const lab = await source("lab.js");
  assert.match(lab, /Preview only/u);
  assert.match(lab, /no deployment-bound storage, seed, or presentation receipt yet/u);
  assert.match(lab, /Publish sends only the exact deployment-generated transactions, then verifies tokenURI and recursive reads/u);
  assert.match(lab, /selected\.editable/u);
  assert.match(lab, /elements\.seed\.value = String\(scene\.attributes\.seed/u);
  assert.match(lab, /revision === undefined \|\| !selected\.editable/u);
  assert.match(lab, /JSON\.stringify\(candidate\.attributes\) === JSON\.stringify\(attributes\)/u);
});

test("Standalone Viewer Builder commits recursive and ordered URL delivery without route magic", async () => {
  const [builder, runtime, seeder, readme, gatewayRoute] = await Promise.all([
    readFile(new URL("../packages/sdk/src/verification-shell.ts", import.meta.url), "utf8"),
    source("keel-verifier-runtime.js"),
    readFile(new URL("../apps/studio/scripts/seed-keel-creative-lab.ts", import.meta.url), "utf8"),
    source("README.md"),
    readFile(new URL("../apps/studio/src/app/api/onchain/[chainId]/[store]/[objectId]/route.ts", import.meta.url), "utf8"),
  ]);
  const studioBuilder = await readFile(new URL("../apps/studio/scripts/keel-viewer-builder.ts", import.meta.url), "utf8");
  assert.match(studioBuilder, /@keel\/sdk\/verification-shell/u);
  assert.match(builder, /deliveryProfile: "onchain-recursive" \| "ordered-url"/u);
  assert.match(builder, /Every ordered URL viewer item requires at least one committed source/u);
  assert.match(builder, /brotli-dec-wasm@2\.3\.2/u);
  assert.match(builder, /compressedHtml/u);
  assert.match(runtime, /source\.storedIntegrity/u);
  assert.match(runtime, /for \(const source of item\.sources\)/u);
  assert.match(runtime, /throw lastError/u);
  assert.match(runtime, /readOnchainObject/u);
  assert.match(runtime, /keel-child-runtime@1/u);
  assert.match(runtime, /new URLSearchParams\(location\.search\)/u);
  assert.match(runtime, /Query tokenId must be a canonical uint256 decimal string/u);
  assert.match(runtime, /derivedTokenSeed: seed/u);
  assert.match(runtime, /packedAttributes/u);
  assert.match(runtime, /unhandledrejection/u);
  assert.match(runtime, /did not report runtime readiness/u);
  assert.match(runtime, /data:\$\{mediaType\};base64/u);
  assert.match(runtime, /stage\.replaceChildren\(frame\)/u);
  assert.doesNotMatch(runtime, /URL\.createObjectURL/u);
  assert.match(seeder, /creator mirror then canonical Keel onchain gateway/u);
  assert.match(seeder, /minimumCanvasCount: 1/u);
  assert.match(seeder, /\.onchain\.html\.br/u);
  assert.match(seeder, /\.url\.html\.br/u);
  assert.match(readme, /creator's mirror first, then a canonical Keel gateway URL/u);
  assert.match(readme, /fails hard/u);
  assert.match(gatewayRoute, /"Access-Control-Allow-Origin": "\*"/u);
  assert.match(gatewayRoute, /"Cross-Origin-Resource-Policy": "cross-origin"/u);
});

test("both chain viewers refuse to invent a receipt for an unsupported contract API", async () => {
  const [ethereumViewer, tezosViewer] = await Promise.all([
    readFile(new URL("../examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.js", import.meta.url), "utf8"),
    readFile(new URL("../packages/tezos/viewer/runtime.js", import.meta.url), "utf8"),
  ]);
  assert.match(ethereumViewer, /did not enable a supported Keel verifier API/u);
  assert.match(ethereumViewer, /no verifier receipt is being claimed/u);
  assert.match(tezosViewer, /Verification not enabled for contract controls/u);
  assert.match(tezosViewer, /no verifier receipt claimed/u);
});
