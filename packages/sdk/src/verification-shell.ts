/**
 * The canonical Keel verification shell builders, plus the one-call
 * `wrapInVerificationShell` for creators: give it an art entry (HTML or JS
 * with assets) and a title, get back the shell-wrapped HTML and the
 * review-only publish plan for those exact bytes.
 *
 * This is the single implementation; `apps/studio/scripts/keel-viewer-builder.ts`
 * re-exports it so the studio deploy scripts and the SDK cannot drift apart.
 *
 * Security properties this file must keep:
 *   - aliases resolve only from the verified item graph; there is no CDN,
 *     no network fallback, and no unverified byte source
 *   - the shell hash-checks every committed resource before mounting anything
 *   - the emitted publish plan is review-only: no signing, no submission
 *
 * Node-only: it reads shell sources from the repository, bundles with esbuild,
 * and compresses with zlib. Do not import it from browser code.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlibConstants, deflate, gzip } from "node:zlib";
import { build } from "esbuild";

import {
  canonicalJson,
  chunkBytes,
  createIntegrity,
  createKeelVerificationPresentationManifest,
  utf8ToBytes,
  verifySourceBuild,
  type Hex,
  type Integrity,
  type KeelSourceReceipt,
  type KeelVerificationPresentationManifest,
  type KeelVerificationPresentationOverrides,
} from "@keel/protocol";
import { createKeelPublishReviewPlan, type KeelPublishReviewPlanEnvelope } from "./publish-plan.js";
import { resolveModuleTarget } from "./modules.js";

type Sha256Integrity = { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };

/** createIntegrity, narrowed to the sha256 shape the viewer envelope commits to. */
async function sha256Integrity(bytes: Uint8Array): Promise<Sha256Integrity> {
  const value: Integrity = await createIntegrity(bytes);
  if (value.algorithm !== "sha256" || typeof value.byteLength !== "number") throw new TypeError("Keel viewer commitments require sha256 integrity with a byte length.");
  return { algorithm: "sha256", digest: value.digest, byteLength: value.byteLength };
}

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

async function compressBrotli(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await brotliCompressAsync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY ?? 1]: 11,
        [zlibConstants.BROTLI_PARAM_MODE ?? 0]: zlibConstants.BROTLI_MODE_GENERIC ?? 0,
      },
    }),
  );
}

async function decompressBrotli(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await brotliDecompressAsync(bytes));
}

const gzipAsync = promisify(gzip);
const deflateAsync = promisify(deflate);

async function compressStored(compression: "none" | "gzip" | "deflate" | "brotli", bytes: Uint8Array): Promise<Uint8Array> {
  switch (compression) {
    case "none": return bytes.slice();
    case "brotli": return compressBrotli(bytes);
    case "gzip": return new Uint8Array(await gzipAsync(bytes, { level: 9 }));
    case "deflate": return new Uint8Array(await deflateAsync(bytes, { level: 9 }));
  }
}

export const KEEL_STANDALONE_VIEWER_PROTOCOL = "keel-standalone-viewer@1" as const;

export interface KeelStandaloneViewerItem {
  readonly id: string;
  readonly role?: "entrypoint" | "module" | "asset" | "data";
  readonly mediaType: string;
  readonly aliases: readonly string[];
  readonly integrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  readonly chainId?: number;
  readonly store?: string;
  readonly objectId?: Hex;
  readonly embedded?: {
    readonly storedBase64: string;
    readonly compression: "none" | "gzip" | "deflate" | "brotli";
    readonly storedIntegrity?: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  };
  readonly sources?: readonly {
    readonly uri: string;
    readonly compression: "none" | "gzip" | "deflate" | "brotli";
    readonly storedIntegrity?: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  }[];
}

export interface KeelStandaloneViewerEnvelope {
  readonly protocol: typeof KEEL_STANDALONE_VIEWER_PROTOCOL;
  readonly title: string;
  readonly deliveryProfile: "onchain-recursive" | "ordered-url" | "embedded-assembled";
  readonly rpcUrl?: string;
  readonly blockTag?: string;
  readonly entrypoint: string;
  readonly runtimeExpectations?: { readonly minimumCanvasCount?: number };
  readonly items: readonly KeelStandaloneViewerItem[];
}

export interface KeelStandaloneViewerBuild {
  readonly html: Uint8Array;
  readonly htmlIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  readonly compressedHtml: Uint8Array;
  readonly compressedIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  readonly compression: "brotli";
  readonly runtimeByteLength: number;
  readonly brotliDecoderByteLength: number;
  readonly brotliDecoderDigest: Hex;
  readonly sourceReceipt: KeelSourceReceipt;
}

function escapeScriptJson(value: unknown): string {
  return canonicalJson(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

async function loadVaultVerificationChrome(
  repositoryRoot: string,
  presentationOverrides: KeelVerificationPresentationOverrides = {},
): Promise<{
  readonly css: string;
  readonly markup: string;
  readonly javascript: string;
  readonly presentation: KeelVerificationPresentationManifest;
  readonly sourceBytes: Uint8Array;
  readonly sourceDigest: Hex;
}> {
  const htmlPath = path.join(
    repositoryRoot,
    "examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.html",
  );
  const javascriptPath = path.join(
    repositoryRoot,
    "examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.js",
  );
  const [htmlBytes, javascriptBytes] = await Promise.all([readFile(htmlPath), readFile(javascriptPath)]);
  const html = htmlBytes.toString("utf8");
  const javascript = javascriptBytes.toString("utf8");
  const styles = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gu)].map((match) => match[1] ?? "");
  const primaryStyle = styles.find((style) => style.includes(".verify-corner{") && style.includes(".verify-alert{"));
  const detailStyle = styles.find((style) => style.includes(".verify-note{") && style.includes(".verify-trail-item"));
  const presenceStyle = styles.find((style) => (
    style.includes("data-verify-corner-active")
    && style.includes("visibility:hidden")
    && style.includes("pointer-events:none")
  ));
  const rootRule = primaryStyle?.match(/:root\{[^}]+\}/u)?.[0];
  const verificationStyleOffset = primaryStyle?.indexOf(".verify-corner{") ?? -1;
  if (!primaryStyle || !detailStyle || !presenceStyle || !rootRule || verificationStyleOffset < 0) {
    throw new Error("Canonical Vault verification CSS could not be extracted.");
  }
  const chromeMarkup = html.match(/<div class="verify-corner"[^>]*>[\s\S]*?<section class="verify-alert"[\s\S]*?<\/section>/u)?.[0];
  const presentationScript = html.match(/<script id="keel-verification-presentation" type="application\/json">[\s\S]*?<\/script>/u)?.[0];
  if (!chromeMarkup || !presentationScript) throw new Error("Canonical Vault verification markup could not be extracted.");
  const presentation = createKeelVerificationPresentationManifest(presentationOverrides);
  const replacedPresentationScript = presentationScript.replace(
    /(<script id="keel-verification-presentation" type="application\/json">)[\s\S]*?(<\/script>)/u,
    `$1${escapeScriptJson(presentation)}$2`,
  );
  const markup = `${replacedPresentationScript}${chromeMarkup}`;
  const javascriptStart = javascript.indexOf("const KEEL_VERIFICATION_PRESENTATION_PROTOCOL =");
  // The gallery presentation can select a lightweight no-op UI, so the
  // declaration is no longer always a direct `mountVerificationUI` call.
  const javascriptEnd = javascript.indexOf("const verificationUI =", javascriptStart);
  if (javascriptStart < 0 || javascriptEnd < 0) {
    throw new Error("Canonical Vault verification runtime could not be extracted.");
  }
  const extractedJavascript = javascript.slice(javascriptStart, javascriptEnd)
    .replace("Changes which character parts are selected.", "Changes which committed objects are selected.");
  const css = `${rootRule}\n${primaryStyle.slice(verificationStyleOffset)}\n${detailStyle}\n${presenceStyle}`;
  const sourceBytes = utf8ToBytes(`${css}\n${markup}\n${extractedJavascript}`);
  return {
    css,
    markup,
    javascript: extractedJavascript,
    presentation,
    sourceBytes,
    sourceDigest: (await sha256Integrity(sourceBytes)).digest,
  };
}

export async function buildStandaloneKeelViewer(input: {
  readonly repositoryRoot: string;
  readonly envelope: KeelStandaloneViewerEnvelope;
  readonly verificationPresentation?: KeelVerificationPresentationOverrides;
}): Promise<KeelStandaloneViewerBuild> {
  if (input.envelope.protocol !== KEEL_STANDALONE_VIEWER_PROTOCOL) throw new TypeError("Unsupported standalone viewer protocol.");
  if (!input.envelope.items.some((item) => item.id === input.envelope.entrypoint)) throw new TypeError("Standalone viewer entrypoint is missing.");
  if (input.envelope.deliveryProfile === "onchain-recursive" && !input.envelope.rpcUrl) throw new TypeError("Onchain viewer requires an RPC URL.");
  if (input.envelope.deliveryProfile === "ordered-url" && input.envelope.items.some((item) => !item.sources?.length)) {
    throw new TypeError("Every ordered URL viewer item requires at least one committed source.");
  }
  if (input.envelope.deliveryProfile === "embedded-assembled" && input.envelope.items.some((item) => !item.embedded?.storedBase64)) {
    throw new TypeError("Every embedded assembled viewer item requires committed inline bytes.");
  }
  const runtimePath = path.join(input.repositoryRoot, "examples/demos/keel-creative-lab/keel-verifier-runtime.js");
  const wasmPath = path.join(input.repositoryRoot, "apps/studio/node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm");
  const [runtimeSource, wasm, verificationChrome] = await Promise.all([
    readFile(runtimePath),
    readFile(wasmPath),
    loadVaultVerificationChrome(input.repositoryRoot, input.verificationPresentation),
  ]);
  const wasmIntegrity = await sha256Integrity(wasm);
  const runtimeWithVerificationChrome = runtimeSource.toString("utf8").replace(
    "/*__KEEL_VAULT_VERIFICATION_CHROME__*/",
    verificationChrome.javascript,
  );
  if (runtimeWithVerificationChrome === runtimeSource.toString("utf8")) {
    throw new Error("Standalone verifier runtime is missing its Vault verification chrome marker.");
  }
  const bundled = await build({
    absWorkingDir: path.join(input.repositoryRoot, "apps/studio"),
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    write: false,
    stdin: { contents: runtimeWithVerificationChrome, resolveDir: path.dirname(runtimePath), sourcefile: "keel-verifier-runtime.js", loader: "js" },
    plugins: [{
      name: "keel-embedded-brotli",
      setup(plugin) {
        plugin.onResolve({ filter: /^brotli-dec-wasm\/web$/ }, () => ({
          path: path.join(input.repositoryRoot, "apps/studio/node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm.js"),
        }));
        plugin.onResolve({ filter: /^keel:brotli-wasm-base64$/ }, () => ({ path: "keel:brotli-wasm-base64", namespace: "keel" }));
        plugin.onLoad({ filter: /.*/, namespace: "keel" }, () => ({ contents: `export default ${JSON.stringify(wasm.toString("base64"))}`, loader: "js" }));
      },
    }],
  });
  const runtime = bundled.outputFiles[0]?.text;
  if (!runtime) throw new Error("Standalone verifier bundle produced no JavaScript.");
  const htmlText = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body,#keel-stage,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#05060b}body{position:relative}#keel-status{position:fixed;inset:0;z-index:6;display:grid;place-items:center;padding:8vw;white-space:pre-wrap;text-align:center;background:#05060b;color:#d7ff63;font:700 12px/1.7 ui-monospace,monospace;letter-spacing:.12em}#keel-status[hidden]{display:none}${verificationChrome.css}</style></head><body data-verification="pending"><div id="keel-stage"></div><div id="keel-status">VERIFYING KEEL GRAPH</div>${verificationChrome.markup}<script id="keel-verification-envelope" type="application/json">${escapeScriptJson(input.envelope)}</script><script>${runtime}</script></body></html>`;
  const html = utf8ToBytes(htmlText.replace("<head>", '<head><link rel="icon" href="data:," />'));
  const compressedHtml = await compressBrotli(html);
  const roundTrip = await decompressBrotli(compressedHtml);
  if (roundTrip.byteLength !== html.byteLength || !roundTrip.every((value, index) => value === html[index])) throw new Error("Standalone viewer Brotli round trip failed.");
  const [htmlIntegrity, compressedIntegrity, envelopeIntegrity] = await Promise.all([
    sha256Integrity(html),
    sha256Integrity(compressedHtml),
    sha256Integrity(utf8ToBytes(canonicalJson(input.envelope))),
  ]);
  const buildRecipe = {
    protocol: "keel-viewer-build-recipe@1",
    runtime: "examples/demos/keel-creative-lab/keel-verifier-runtime.js",
    bundler: "esbuild@0.28.2",
    format: "iife",
    minify: true,
    target: "es2022",
    brotliDecoder: { package: "brotli-dec-wasm@2.3.2", digest: wasmIntegrity.digest },
    verificationChrome: {
      html: "examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.html",
      javascript: "examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.js",
      digest: verificationChrome.sourceDigest,
      presentation: verificationChrome.presentation,
    },
    envelopeDigest: envelopeIntegrity.digest,
  } as const;
  const buildRecipeDigest = (await sha256Integrity(utf8ToBytes(canonicalJson(buildRecipe)))).digest;
  const sourceReceipt = await verifySourceBuild({
    sourceBytes: new Uint8Array(Buffer.concat([runtimeSource, verificationChrome.sourceBytes])),
    outputBytes: html,
    rebuiltOutputBytes: html,
    mediaType: "text/javascript",
    buildRecipeDigest,
    verifier: { name: "keel-viewer-builder", version: "1.0.0" },
  });
  return {
    html,
    htmlIntegrity,
    compressedHtml,
    compressedIntegrity,
    compression: "brotli",
    runtimeByteLength: new TextEncoder().encode(runtime).byteLength,
    brotliDecoderByteLength: wasm.byteLength,
    brotliDecoderDigest: wasmIntegrity.digest,
    sourceReceipt,
  };
}

export async function buildEmbeddedKeelViewerShell(input: {
  readonly repositoryRoot: string;
  readonly verificationPresentation?: KeelVerificationPresentationOverrides;
}): Promise<{
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
  readonly prefixIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  readonly suffixIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
}> {
  const emptyDigest = (await sha256Integrity(new Uint8Array())).digest;
  const placeholder = await buildStandaloneKeelViewer({
    repositoryRoot: input.repositoryRoot,
    ...(input.verificationPresentation === undefined ? {} : { verificationPresentation: input.verificationPresentation }),
    envelope: {
      protocol: KEEL_STANDALONE_VIEWER_PROTOCOL,
      title: "Keel verified presentation",
      deliveryProfile: "embedded-assembled",
      entrypoint: "__keel_placeholder__",
      items: [{
        id: "__keel_placeholder__",
        role: "entrypoint",
        mediaType: "text/html",
        aliases: [],
        integrity: { algorithm: "sha256", digest: emptyDigest, byteLength: 0 },
        embedded: { storedBase64: "AA==", compression: "none" },
      }],
    },
  });
  const html = new TextDecoder().decode(placeholder.html);
  const marker = '<script id="keel-verification-envelope" type="application/json">';
  const markerOffset = html.indexOf(marker);
  if (markerOffset < 0) throw new Error("Embedded Keel shell envelope marker is missing.");
  const envelopeStart = markerOffset + marker.length;
  const envelopeEnd = html.indexOf("</script>", envelopeStart);
  if (envelopeEnd < 0) throw new Error("Embedded Keel shell envelope terminator is missing.");
  const prefix = utf8ToBytes(`${html.slice(0, envelopeStart)}{\"deliveryProfile\":\"embedded-assembled\",\"entrypoint\":null,\"items\":[null`);
  const suffix = utf8ToBytes(`],\"protocol\":${JSON.stringify(KEEL_STANDALONE_VIEWER_PROTOCOL)},\"title\":\"Keel verified presentation\"}${html.slice(envelopeEnd)}`);
  const [prefixIntegrity, suffixIntegrity] = await Promise.all([sha256Integrity(prefix), sha256Integrity(suffix)]);
  return { prefix, suffix, prefixIntegrity, suffixIntegrity };
}

export async function buildEmbeddedKeelViewerSlot(input: {
  readonly id: string;
  readonly role: "entrypoint" | "module" | "asset" | "data";
  readonly mediaType: string;
  readonly aliases?: readonly string[];
  readonly bytes: Uint8Array;
  readonly compression?: "none" | "gzip" | "deflate" | "brotli";
}): Promise<{
  readonly item: KeelStandaloneViewerItem;
  readonly fragment: Uint8Array;
  readonly fragmentIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
}> {
  if (!input.id || !input.mediaType || input.bytes.byteLength === 0) throw new TypeError("Embedded Keel viewer slots require an id, media type, and bytes.");
  const compression = input.compression ?? "none";
  const stored = await compressStored(compression, input.bytes);
  const [integrity, storedIntegrity] = await Promise.all([sha256Integrity(input.bytes), sha256Integrity(stored)]);
  const item: KeelStandaloneViewerItem = {
    id: input.id,
    role: input.role,
    mediaType: input.mediaType,
    aliases: input.aliases ?? [],
    integrity,
    embedded: {
      storedBase64: Buffer.from(stored).toString("base64"),
      compression,
      storedIntegrity,
    },
  };
  const fragment = utf8ToBytes(`,${escapeScriptJson(item)}`);
  return { item, fragment, fragmentIntegrity: await sha256Integrity(fragment) };
}

/* --------------------------------------------------- wrapInVerificationShell */

const MAX_CHUNKS_PER_CAST = 3;
const MAX_SLUG_BYTES = 23_000;
const SAFE_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface WrapInVerificationShellOptions {
  /** Repository checkout holding the canonical shell sources. */
  readonly repositoryRoot: string;
  /** The token or manifest identity the shell displays as its title. */
  readonly title: string;
  /** Metadata-safe object name for the publish plan; defaults from the title. */
  readonly objectName?: string;
  /** The creator's art entry: self-contained HTML, or a JS entry module. */
  readonly entry: {
    readonly id?: string;
    readonly mediaType: "text/html" | "text/javascript";
    readonly source: string | Uint8Array;
  };
  /** Additional committed items; aliases resolve only from this verified graph. */
  readonly assets?: readonly {
    readonly id: string;
    readonly mediaType: string;
    readonly aliases?: readonly string[];
    readonly bytes: Uint8Array;
  }[];
  /** Presentation-only shell overrides (seal, overlay, theme, pages). */
  readonly presentation?: KeelVerificationPresentationOverrides;
  /** Publish plan target; defaults to the registered Sepolia KeelHold. */
  readonly target?: { readonly chainId: number; readonly address: `0x${string}` };
}

export interface WrapInVerificationShellResult {
  /** The shell-wrapped, self-verifying HTML document. */
  readonly html: string;
  readonly htmlIntegrity: Integrity;
  readonly compressedHtml: Uint8Array;
  readonly compressedIntegrity: Integrity;
  readonly compression: "brotli";
  readonly envelope: KeelStandaloneViewerEnvelope;
  readonly sourceReceipt: KeelSourceReceipt;
  /** Review-only keel-publish-plan@1 for the wrapped HTML bytes. */
  readonly publishPlan: KeelPublishReviewPlanEnvelope;
}

function defaultObjectName(title: string): string {
  const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 96);
  return `${slug.length === 0 ? "keel-wrapped" : slug}.html`;
}

/**
 * Wrap a creator's work in the canonical verification shell and return both
 * halves of a publication: the exact HTML bytes and the review-only publish
 * plan that would put them on chain. Nothing is signed and nothing is sent.
 */
export async function wrapInVerificationShell(options: WrapInVerificationShellOptions): Promise<WrapInVerificationShellResult> {
  if (options.title.length === 0 || options.title.length > 256) throw new TypeError("wrapInVerificationShell requires a title of 1 through 256 characters.");
  const objectName = options.objectName ?? defaultObjectName(options.title);
  if (!SAFE_OBJECT_NAME.test(objectName)) throw new TypeError("objectName must be a metadata-safe file name.");
  const entryId = options.entry.id ?? "entry";
  const entryBytes = typeof options.entry.source === "string" ? utf8ToBytes(options.entry.source) : options.entry.source;
  const assets = options.assets ?? [];
  const ids = new Set([entryId]);
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new TypeError(`Duplicate item id "${asset.id}" in the verified graph.`);
    ids.add(asset.id);
  }
  const slots = [
    await buildEmbeddedKeelViewerSlot({
      id: entryId,
      role: "entrypoint",
      mediaType: options.entry.mediaType,
      bytes: entryBytes,
    }),
    ...await Promise.all(assets.map((asset) => buildEmbeddedKeelViewerSlot({
      id: asset.id,
      role: /javascript|ecmascript/u.test(asset.mediaType) ? "module" : "asset",
      mediaType: asset.mediaType,
      ...(asset.aliases === undefined ? {} : { aliases: asset.aliases }),
      bytes: asset.bytes,
    }))),
  ];
  const envelope: KeelStandaloneViewerEnvelope = {
    protocol: KEEL_STANDALONE_VIEWER_PROTOCOL,
    title: options.title,
    deliveryProfile: "embedded-assembled",
    entrypoint: entryId,
    items: slots.map((slot) => slot.item),
  };
  const built = await buildStandaloneKeelViewer({
    repositoryRoot: options.repositoryRoot,
    envelope,
    ...(options.presentation === undefined ? {} : { verificationPresentation: options.presentation }),
  });
  const target = options.target ?? {
    chainId: 11_155_111,
    address: resolveModuleTarget({ module: "keel-hold", contract: "KeelHold", chainId: 11_155_111 }).address,
  };
  const chunks = chunkBytes(built.compressedHtml, MAX_SLUG_BYTES);
  const chunkIntegrities = await Promise.all(chunks.map((chunk) => sha256Integrity(chunk.bytes)));
  const operations: Record<string, unknown>[] = [];
  for (let offset = 0; offset < chunks.length; offset += MAX_CHUNKS_PER_CAST) {
    const batch = chunks.slice(offset, offset + MAX_CHUNKS_PER_CAST);
    operations.push({
      kind: "castSlugs",
      function: "castSlugs(bytes[])",
      payloadEncoding: "raw-bytes-from-files",
      chunkCount: batch.length,
      chunkByteLengths: batch.map((chunk) => chunk.length),
      chunkIntegrities: chunkIntegrities.slice(offset, offset + batch.length),
      slugIds: "derived-keccak256-after-review",
    });
  }
  operations.push({
    kind: "weldObject",
    function: "weldObject(bytes32[],bytes32,uint64,uint8,string)",
    slugIds: "from-preceding-castSlugs",
    digest: built.htmlIntegrity,
    byteLength: built.htmlIntegrity.byteLength,
    compression: "brotli",
    mediaType: "text/html",
  });
  const publishPlan = await createKeelPublishReviewPlan({
    schema: "keel-chain-operation-plan@1",
    status: "review-only",
    materialized: true,
    descriptorMaterialized: true,
    chainReady: false,
    target: { family: "ethereum", chainId: target.chainId, address: target.address },
    sourcePlan: {
      schema: "keel-upload-plan@2",
      objectName,
      mediaType: "text/html",
      integrity: built.htmlIntegrity,
    },
    operations,
    encoding: "deferred-contract-abi",
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    caveat: "Operation descriptors are review-only; a verified chain adapter must encode, simulate, sign, and submit them.",
  });
  return {
    html: new TextDecoder().decode(built.html),
    htmlIntegrity: built.htmlIntegrity,
    compressedHtml: built.compressedHtml,
    compressedIntegrity: built.compressedIntegrity,
    compression: "brotli",
    envelope,
    sourceReceipt: built.sourceReceipt,
    publishPlan,
  };
}
