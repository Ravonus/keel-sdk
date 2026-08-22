import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  createIntegrity,
  createKeelVerificationPresentationManifest,
  utf8ToBytes,
  verifySourceBuild,
  type Hex,
  type KeelSourceReceipt,
  type KeelVerificationPresentationManifest,
  type KeelVerificationPresentationOverrides,
} from "@keel/protocol";
import { compressBytes, decompressBytes } from "@keel/builder";
import { build } from "esbuild";

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
    sourceDigest: (await createIntegrity(sourceBytes)).digest,
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
  const wasmIntegrity = await createIntegrity(wasm);
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
  const compressedHtml = await compressBytes("brotli", html);
  const roundTrip = await decompressBytes("brotli", compressedHtml);
  if (roundTrip.byteLength !== html.byteLength || !roundTrip.every((value, index) => value === html[index])) throw new Error("Standalone viewer Brotli round trip failed.");
  const [htmlIntegrity, compressedIntegrity, envelopeIntegrity] = await Promise.all([
    createIntegrity(html),
    createIntegrity(compressedHtml),
    createIntegrity(utf8ToBytes(canonicalJson(input.envelope))),
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
  const buildRecipeDigest = (await createIntegrity(utf8ToBytes(canonicalJson(buildRecipe)))).digest;
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
  const emptyDigest = (await createIntegrity(new Uint8Array())).digest;
  const placeholder = await buildStandaloneKeelViewer({
    repositoryRoot: input.repositoryRoot,
    verificationPresentation: input.verificationPresentation,
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
  const [prefixIntegrity, suffixIntegrity] = await Promise.all([createIntegrity(prefix), createIntegrity(suffix)]);
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
  const stored = compression === "none" ? input.bytes : await compressBytes(compression, input.bytes);
  const [integrity, storedIntegrity] = await Promise.all([createIntegrity(input.bytes), createIntegrity(stored)]);
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
  return { item, fragment, fragmentIntegrity: await createIntegrity(fragment) };
}
