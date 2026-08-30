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
  assertKeelRpcUrl,
  assertDataUriMediaType,
  canonicalJson,
  chunkBytes,
  createIntegrity,
  createKeelVerificationPresentationManifest,
  escapeJsonForScript,
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
  /**
   * Optional packing applied around an onchain object's exact decoded bytes.
   * This lets a large HTML document live as a raw composite Brotli stream:
   * the object record authenticates the packed stream, then the viewer
   * decompresses it and authenticates `integrity` before mounting anything.
   */
  readonly onchain?: {
    readonly storeKind?: "keel-hold" | "stratus-chunk-store";
    readonly compression: "none" | "gzip" | "deflate" | "brotli";
    readonly storedIntegrity?: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  };
  readonly embedded?: {
    readonly storedBase64: string;
    readonly compression: "none" | "gzip" | "deflate" | "brotli";
    readonly storedIntegrity?: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  };
}

export interface KeelStandaloneViewerEnvelope {
  readonly protocol: typeof KEEL_STANDALONE_VIEWER_PROTOCOL;
  readonly title: string;
  /** Inline bytes or recursive chain RPC. Hosted URL delivery is intentionally unsupported. */
  readonly deliveryProfile: "onchain-recursive" | "embedded-assembled";
  /** @deprecated Use rpcUrls so a sealed viewer is not pinned to one RPC operator. */
  readonly rpcUrl?: string;
  /** Governed ordinary chain RPC endpoints, tried in order. Never content hosts. */
  readonly rpcUrls?: readonly string[];
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
  return escapeJsonForScript(canonicalJson(value));
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
  /** Embed Brotli WASM only when this exact graph declares Brotli resources. */
  readonly brotliDecoder?: "embedded" | "disabled";
}): Promise<KeelStandaloneViewerBuild> {
  if (input.envelope.protocol !== KEEL_STANDALONE_VIEWER_PROTOCOL) throw new TypeError("Unsupported standalone viewer protocol.");
  if (!input.envelope.items.some((item) => item.id === input.envelope.entrypoint)) throw new TypeError("Standalone viewer entrypoint is missing.");
  for (const item of input.envelope.items) assertDataUriMediaType(item.mediaType);
  if (input.envelope.deliveryProfile === "onchain-recursive") {
    const rpcUrls = input.envelope.rpcUrls ?? (input.envelope.rpcUrl === undefined ? [] : [input.envelope.rpcUrl]);
    if (rpcUrls.length === 0) throw new TypeError("Onchain viewer requires at least one governed RPC URL.");
    if (rpcUrls.length > 8) throw new RangeError("Onchain viewer accepts at most eight governed RPC URLs.");
    for (const rpcUrl of rpcUrls) assertKeelRpcUrl(rpcUrl);
    if (input.envelope.items.some((item) => item.chainId === undefined || item.store === undefined || item.objectId === undefined)) {
      throw new TypeError("Every onchain viewer item requires a chain, store, and object ID.");
    }
  }
  if (input.envelope.deliveryProfile === "embedded-assembled" && input.envelope.items.some((item) => !item.embedded?.storedBase64)) {
    throw new TypeError("Every embedded assembled viewer item requires committed inline bytes.");
  }
  const runtimePath = path.join(input.repositoryRoot, "examples/demos/keel-creative-lab/keel-verifier-runtime.js");
  const decoderMode = input.brotliDecoder ?? "embedded";
  const wasmPath = path.join(input.repositoryRoot, "apps/studio/node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm");
  const [runtimeSource, wasm, verificationChrome] = await Promise.all([
    readFile(runtimePath),
    decoderMode === "embedded" ? readFile(wasmPath) : Promise.resolve(Buffer.from(new Uint8Array())),
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
      name: "keel-compression-runtime",
      setup(plugin) {
        plugin.onResolve({ filter: /^keel:compression-runtime$/ }, () => ({ path: "keel:compression-runtime", namespace: "keel" }));
        plugin.onResolve({ filter: /^brotli-dec-wasm\/web$/ }, () => ({
          path: path.join(input.repositoryRoot, "apps/studio/node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm.js"),
        }));
        plugin.onResolve({ filter: /^keel:brotli-wasm-base64$/ }, () => ({ path: "keel:brotli-wasm-base64", namespace: "keel-wasm" }));
        plugin.onLoad({ filter: /.*/, namespace: "keel-wasm" }, () => ({
          contents: `export default ${JSON.stringify(wasm.toString("base64"))}`,
          loader: "js",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "keel" }, () => ({
          contents: decoderMode === "embedded"
            ? `import {decompress,initSync} from "brotli-dec-wasm/web";import encoded from "keel:brotli-wasm-base64";const bytes=()=>Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));export const decodeBrotli=decompress;export function initBrotli(){initSync({module:bytes()})}`
            : `export function initBrotli(){}export function decodeBrotli(){throw new Error("This verified shell did not declare the KEEL Brotli decoder module.")}`,
          loader: "js",
        }));
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
    brotliDecoder: decoderMode === "embedded"
      ? { kind: "embedded", package: "brotli-dec-wasm@2.3.2", digest: wasmIntegrity.digest }
      : { kind: "disabled" },
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
  readonly brotliDecoder?: "embedded" | "disabled";
}): Promise<{
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
  readonly prefixIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
  readonly suffixIntegrity: { readonly algorithm: "sha256"; readonly digest: Hex; readonly byteLength: number };
}> {
  const emptyDigest = (await sha256Integrity(new Uint8Array())).digest;
  const placeholder = await buildStandaloneKeelViewer({
    repositoryRoot: input.repositoryRoot,
    ...(input.brotliDecoder === undefined ? {} : { brotliDecoder: input.brotliDecoder }),
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

/**
 * Runtime used only by the default composable Inline lane. It intentionally
 * contains no catalogue client, RPC reader, Brotli decoder, or presentation
 * chrome. The ordered object graph supplies every byte between the two shell
 * halves; this code verifies stored and decoded commitments, uses the
 * browser's native Gzip/Deflate decoder, and mounts the verified entrypoint.
 */
function compactInlineRuntime(
  mountKeelVerification: (input: {
    readonly result: unknown;
    readonly runtime?: unknown;
    readonly context?: unknown;
    readonly extraRows?: readonly { readonly key: string; readonly value: string }[];
  }) => unknown,
): void {
  const globals = globalThis as typeof globalThis & {
    __KEEL_ITEMS__?: unknown;
    __KEEL_CONTEXT__?: unknown;
    __KEEL_VERIFICATION__?: unknown;
    __KEEL_SHELL_API__?: unknown;
  };
  const source = Array.isArray(globals.__KEEL_ITEMS__) ? globals.__KEEL_ITEMS__.filter(Boolean) : [];
  const stage = document.querySelector("#keel-stage");
  const status = document.querySelector("#keel-status");
  if (!(stage instanceof HTMLElement) || !(status instanceof HTMLElement) || typeof mountKeelVerification !== "function") {
    throw new Error("Invalid KEEL Inline shell.");
  }
  const items = source as KeelStandaloneViewerItem[];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  const fromHex = (value: string) => Uint8Array.from(value.slice(2).match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  const sha256Fallback = (bytes: Uint8Array) => {
    const constants = Uint32Array.from([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const rotateRight = (value: number, count: number) => (value >>> count) | (value << (32 - count));
    const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.byteLength] = 0x80;
    const bitLength = bytes.byteLength * 8;
    const paddedView = new DataView(padded.buffer);
    paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);
    const hash = Uint32Array.from([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const schedule = new Uint32Array(64);
    for (let block = 0; block < paddedLength; block += 64) {
      for (let index = 0; index < 16; index += 1) schedule[index] = paddedView.getUint32(block + index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const left = schedule[index - 15] as number;
        const right = schedule[index - 2] as number;
        schedule[index] = (
          (schedule[index - 16] as number)
          + (rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3))
          + (schedule[index - 7] as number)
          + (rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10))
        ) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash as unknown as [number, number, number, number, number, number, number, number];
      for (let index = 0; index < 64; index += 1) {
        const upper = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temporary1 = (h + upper + choice + (constants[index] as number) + (schedule[index] as number)) >>> 0;
        const lower = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temporary2 = (lower + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
      }
      hash[0] = ((hash[0] as number) + a) >>> 0;
      hash[1] = ((hash[1] as number) + b) >>> 0;
      hash[2] = ((hash[2] as number) + c) >>> 0;
      hash[3] = ((hash[3] as number) + d) >>> 0;
      hash[4] = ((hash[4] as number) + e) >>> 0;
      hash[5] = ((hash[5] as number) + f) >>> 0;
      hash[6] = ((hash[6] as number) + g) >>> 0;
      hash[7] = ((hash[7] as number) + h) >>> 0;
    }
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    hash.forEach((value, index) => outputView.setUint32(index * 4, value, false));
    return output;
  };
  const sha256 = async (bytes: Uint8Array) => {
    const subtle = globalThis.crypto?.subtle;
    return subtle?.digest
      ? new Uint8Array(await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))
      : sha256Fallback(bytes);
  };
  const safeJSON = (value: unknown) => JSON.stringify(value)
    .replace(/[&<>\u2028\u2029]/gu, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
  const verify = async (bytes: Uint8Array, integrity: Sha256Integrity, label: string) => {
    if (bytes.byteLength !== integrity.byteLength) throw new Error(`${label} length mismatch.`);
    const seen = await sha256(bytes);
    if (!equal(seen, fromHex(integrity.digest))) throw new Error(`${label} SHA-256 mismatch.`);
    return bytes;
  };
  const decompress = async (compression: "none" | "gzip" | "deflate" | "brotli", bytes: Uint8Array) => {
    if (compression === "none") return bytes;
    if (compression !== "gzip" && compression !== "deflate") throw new Error("Unsupported KEEL resource compression.");
    if (typeof DecompressionStream !== "function") throw new Error(`${compression} decompression is unavailable.`);
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(compression));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const resolve = async (item: KeelStandaloneViewerItem) => {
    const embedded = item.embedded;
    if (embedded === undefined || typeof embedded.storedBase64 !== "string") {
      throw new Error(`Missing embedded bytes for ${item.id}.`);
    }
    const stored = fromBase64(embedded.storedBase64);
    if (embedded.storedIntegrity !== undefined) await verify(stored, embedded.storedIntegrity, `${item.id} stored`);
    return verify(await decompress(embedded.compression, stored), item.integrity, item.id);
  };
  const dataURL = (bytes: Uint8Array, mediaType: string) => {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
    }
    return `data:${mediaType};base64,${btoa(binary)}`;
  };
  const replaceAliases = (text: string, aliases: ReadonlyMap<string, string>) => {
    let output = text;
    for (const [alias, url] of [...aliases].sort(([left], [right]) => right.length - left.length || left.localeCompare(right))) output = output.replaceAll(alias, url);
    return output;
  };
  const childHTML = (
    html: string,
    context: unknown,
    verification: unknown,
    contentUrls: Record<string, string>,
    directEntry?: { readonly id: string; readonly name: string; readonly mediaType: string; readonly digest: string; readonly byteLength: number; readonly url: string; readonly moduleURL: string },
  ) => {
    // Construct the child terminator at runtime so the parent HTML parser
    // never sees a literal closing script tag inside this shell script.
    const closeScript = String.fromCharCode(60, 47, 115, 99, 114, 105, 112, 116, 62);
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' data: blob:; style-src \'unsafe-inline\' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src \'none\'; object-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'">';
    const injection = `<script>{const c=Object.freeze(${safeJSON(context ?? {})});globalThis.__KEEL_CONTEXT__=c;const s=c?.derivedTokenSeed??c?.tokenSeed??c?.seed;if(typeof s==="string"&&/^0x[0-9a-f]{64}$/i.test(s))Object.defineProperty(globalThis,"KEEL_SEED",{value:s.toLowerCase(),enumerable:true,writable:false,configurable:false});Object.defineProperty(globalThis,"__KEEL_VERIFICATION__",{value:Object.freeze(${safeJSON(verification)}),enumerable:true,writable:false,configurable:false})}${closeScript}`;
    const content = `<script>(()=>{const u=Object.freeze(${safeJSON(contentUrls)}),r=Object.freeze(${safeJSON((verification as { readonly checks?: unknown }).checks ?? [])}),bytes=id=>{const value=u[id];if(typeof value!=="string")throw new Error("Undeclared verified content "+id);const encoded=value.slice(value.indexOf(",")+1);return Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))},resources=()=>r;Object.defineProperty(globalThis,"__KEEL_CONTENT__",{value:Object.freeze({url:id=>u[id]??null,bytes,resources}),enumerable:true,writable:false,configurable:false})})()${closeScript}`;
    const direct = directEntry === undefined ? "" : `<script>{const e=Object.freeze(${safeJSON(directEntry)});Object.defineProperty(globalThis,"__KEEL_ENTRY__",{value:e,enumerable:true,writable:false,configurable:false})}${closeScript}`;
    const document = directEntry === undefined
      ? html
      : `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#keel-asset-display{width:100%;height:100%;margin:0;overflow:hidden;background:#05060b}</style></head><body><main id="keel-asset-display"></main><script src="${directEntry.moduleURL}">${closeScript}</body></html>`;
    return /<head(?:\s[^>]*)?>/iu.test(document)
      ? document.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${policy}${injection}${content}${direct}`)
      : `<!doctype html><html><head><meta charset="utf-8">${policy}${injection}${content}${direct}</head><body>${document}</body></html>`;
  };
  const launch = async () => {
    if (items.length === 0) throw new Error("The KEEL Inline graph is empty.");
    status.textContent = `VERIFYING ${items.length} ITEMS`;
    const resolved = new Map<string, Uint8Array>();
    for (const item of items) {
      status.textContent = `VERIFYING ${item.id.toUpperCase()}`;
      resolved.set(item.id, await resolve(item));
    }
    const entry = items.find((item) => item.role === "entrypoint");
    if (entry === undefined) throw new Error("The KEEL Inline graph has no entrypoint.");
    const aliases = new Map<string, string>();
    for (const item of items.filter((candidate) => candidate !== entry)) {
      const bytes = resolved.get(item.id);
      if (bytes === undefined) throw new Error(`Resolved bytes missing for ${item.id}.`);
      const output = /^(?:text\/|application\/(?:javascript|json))/u.test(item.mediaType)
        ? new TextEncoder().encode(replaceAliases(decoder.decode(bytes), aliases))
        : bytes;
      const url = dataURL(output, item.mediaType);
      aliases.set(item.id, url);
      for (const alias of item.aliases) aliases.set(alias, url);
    }
    const entryBytes = resolved.get(entry.id);
    if (entryBytes === undefined) throw new Error("Resolved entrypoint bytes are missing.");
    const verificationChecks = Object.freeze(items.map((item) => Object.freeze({
      id: item.id,
      name: item.aliases[0] ?? item.id,
      label: item.aliases[0] ?? item.id,
      role: item.role ?? "asset",
      mediaType: item.mediaType,
      digest: item.integrity.digest,
      byteLength: item.integrity.byteLength,
      passed: true,
      detail: `${item.integrity.byteLength} bytes matched ${item.integrity.digest}`,
      severity: "fatal",
    })));
    const verification = Object.freeze({
      protocol: "keel-inline-verification@1",
      state: "verified",
      title: "KEEL verified",
      summary: `${items.length} committed resources matched before the work was mounted.`,
      checks: verificationChecks,
      proofTier: "Committed resource graph",
      isFixture: false,
      proofMode: "keel-inline-verification@1",
      syntheticTokenContext: false,
    });
    const contentUrls = Object.fromEntries(items.map((item) => {
      const bytes = resolved.get(item.id);
      if (bytes === undefined) throw new Error(`Resolved bytes missing for ${item.id}.`);
      return [item.id, dataURL(bytes, item.mediaType)];
    }));
    globals.__KEEL_VERIFICATION__ = verification;
    const resources = verificationChecks;
    const context = globals.__KEEL_CONTEXT__;
    const extensions = typeof context === "object" && context !== null && Array.isArray((context as { shellPlugins?: unknown }).shellPlugins)
      ? (context as { shellPlugins: unknown[] }).shellPlugins.slice(0, 8).flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const candidate = value as { id?: unknown; title?: unknown; body?: unknown };
        return typeof candidate.id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/u.test(candidate.id)
          && typeof candidate.title === "string" && candidate.title.length > 0 && candidate.title.length <= 64
          && typeof candidate.body === "string" && candidate.body.length <= 2_048
          ? [Object.freeze({ id: candidate.id, title: candidate.title, body: candidate.body })]
          : [];
      })
      : [];
    const plugins = Object.freeze(extensions);
    Object.defineProperty(globals, "__KEEL_SHELL_API__", {
      value: Object.freeze({
        protocol: "keel-shell-plugin@1",
        verification: () => verification,
        resources: () => resources,
        plugins: () => plugins,
      }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
    mountKeelVerification({
      result: verification,
      runtime: Object.freeze({ protocol: "keel-inline-runtime@1" }),
      context,
      extraRows: plugins.map((plugin) => Object.freeze({ key: plugin.title, value: plugin.body })),
    });
    const frame = document.createElement("iframe");
    frame.title = "Verified KEEL work";
    frame.sandbox.add("allow-scripts", "allow-pointer-lock");
    frame.referrerPolicy = "no-referrer";
    const directMedia = entry.mediaType.startsWith("image/") || entry.mediaType.startsWith("video/") || entry.mediaType === "model/gltf-binary";
    const assetDisplay = directMedia
      ? items.filter((item) => item.id === "keel.asset-display" && item.role === "module" && item.mediaType === "text/javascript")
      : [];
    if (directMedia && assetDisplay.length !== 1) {
      throw new Error("A direct media entry requires exactly one verified keel.asset-display module.");
    }
    const entryURL = contentUrls[entry.id];
    if (entryURL === undefined) throw new Error("Verified entrypoint descriptor is missing.");
    frame.srcdoc = childHTML(
      directMedia ? "" : replaceAliases(decoder.decode(entryBytes), aliases),
      globals.__KEEL_CONTEXT__,
      verification,
      contentUrls,
      directMedia ? {
        id: entry.id,
        name: entry.aliases[0] ?? entry.id,
        mediaType: entry.mediaType,
        digest: entry.integrity.digest,
        byteLength: entry.integrity.byteLength,
        url: entryURL,
        moduleURL: contentUrls[assetDisplay[0]!.id]!,
      } : undefined,
    );
    stage.replaceChildren(frame);
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Verified entrypoint timed out.")), 15_000);
      frame.addEventListener("load", () => {
        clearTimeout(timer);
        resolveReady();
      }, { once: true });
      frame.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Verified entrypoint failed to load."));
      }, { once: true });
    });
    document.body.dataset.verification = "verified";
    status.hidden = true;
  };
  document.addEventListener("DOMContentLoaded", () => void launch().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    document.body.dataset.verification = "failed";
    status.hidden = false;
    status.textContent = `KEEL VERIFICATION FAILED\n${message}`;
    mountKeelVerification({
      result: Object.freeze({
        state: "failed",
        title: "Verification failed",
        summary: message,
        checks: Object.freeze([Object.freeze({
          id: "keel-inline-runtime",
          label: "Committed resource graph",
          passed: false,
          detail: message,
          severity: "fatal",
        })]),
        proofTier: "Rejected render",
        isFixture: false,
        proofMode: "rejected",
        syntheticTokenContext: false,
      }),
      runtime: Object.freeze({ protocol: "keel-inline-runtime@1" }),
      context: globals.__KEEL_CONTEXT__,
    });
  }), { once: true });
}

/** Build the two small reusable halves for the composable Inline lane. */
export async function buildCompactInlineKeelShell(input: {
  /** Checkout containing the one canonical KEEL verification chrome module. */
  readonly repositoryRoot?: string;
} = {}): Promise<{
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
  readonly prefixIntegrity: Sha256Integrity;
  readonly suffixIntegrity: Sha256Integrity;
}> {
  const repositoryRoot = path.resolve(input.repositoryRoot ?? ".");
  const verificationChromePath = path.join(repositoryRoot, "packages/viewer/src/keel-verification-chrome.js");
  await readFile(verificationChromePath);
  const runtimeBuild = await build({
    absWorkingDir: repositoryRoot,
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: "browser",
    format: "iife",
    target: ["es2022"],
    write: false,
    stdin: {
      contents: `import { mountKeelVerification } from ${JSON.stringify(verificationChromePath)};(${compactInlineRuntime.toString()})(mountKeelVerification)`,
      resolveDir: repositoryRoot,
      sourcefile: "keel-inline-runtime.js",
      loader: "js",
    },
  });
  const runtime = runtimeBuild.outputFiles[0]?.text;
  if (runtime === undefined) throw new Error("Compact KEEL Inline runtime produced no JavaScript.");
  const prefix = utf8ToBytes('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body,#keel-stage,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#05060b;color:#eafff8}body{position:relative}#keel-status{position:fixed;inset:0;z-index:2;display:grid;place-items:center;white-space:pre-wrap;text-align:center;color:#d7ff63;background:#05060b;font:700 12px/1.7 monospace}[hidden]{display:none!important}</style></head><body data-verification="pending"><div id="keel-stage"></div><div id="keel-status">VERIFYING KEEL GRAPH</div><script>globalThis.__KEEL_ITEMS__=[null');
  const suffix = utf8ToBytes(`];${runtime}</script></body></html>`);
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
  assertDataUriMediaType(input.mediaType);
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
