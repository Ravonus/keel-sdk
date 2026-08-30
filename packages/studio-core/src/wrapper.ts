import { serializeScriptJSON } from "@keel/protocol";
import type { EntrypointMode } from "@keel/protocol";
import type { WrapperInput } from "./types.js";

/** Resource IDs used by the manifest-declared Ruffle runtime wrapper. */
export interface FlashWrapperResources {
  readonly swf: string;
  readonly loader: string;
  readonly seededRandom: string;
  readonly edition: string;
  readonly ruffleMain: string;
  readonly ruffleModernCore: string;
  readonly ruffleLegacyCore: string;
  /** Optional extensions-enabled WASM. */
  readonly ruffleModernWasm?: string;
  /** MVP/vanilla WASM. Unsupported browsers can upload it locally. */
  readonly ruffleLegacyWasm: string;
  /** Modern-only binds one extensions-enabled WASM resource and emits no upload fallback. */
  readonly ruffleWasmPolicy?: "modern-only" | "dual";
  readonly ruffleModernWasmSha256?: string;
  readonly ruffleModernWasmByteLength?: number;
  readonly ruffleModernWasmFileName?: string;
  readonly collectionSize: number;
  readonly previewRootSeed?: string;
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function scriptString(value: string): string {
  return serializeScriptJSON(value);
}

function flashPresentation(resources: FlashWrapperResources, name: string): string {
  if (!Number.isSafeInteger(resources.collectionSize) || resources.collectionSize < 1) {
    throw new RangeError("Flash collectionSize must be a positive safe integer.");
  }
  const seed = resources.previewRootSeed ?? `0x${"0".repeat(64)}`;
  if (!/^0x[0-9a-f]{64}$/iu.test(seed)) throw new TypeError("Flash previewRootSeed must be a canonical bytes32 value.");
  const modernOnly = resources.ruffleWasmPolicy === "modern-only";
  if (modernOnly && resources.ruffleModernWasm === undefined) {
    throw new TypeError("Modern-only Flash runtime requires the verified modern Ruffle WASM resource.");
  }
  const fallbackWasmSha256 = resources.ruffleModernWasmSha256;
  const fallbackWasmByteLength = resources.ruffleModernWasmByteLength;
  if (!modernOnly && resources.ruffleModernWasm === undefined &&
      (!/^0x[0-9a-f]{64}$/iu.test(fallbackWasmSha256 ?? "") ||
       typeof fallbackWasmByteLength !== "number" || !Number.isSafeInteger(fallbackWasmByteLength) || fallbackWasmByteLength <= 0)) {
    throw new TypeError("Flash fallback WASM requires a canonical SHA-256 digest and byte length.");
  }
  const id = (value: string): string => scriptString(value);
  const modernWasmAsset = resources.ruffleModernWasm === undefined ? "" : `modernWasm: ${id(resources.ruffleModernWasm)},`;
  const fallbackDescriptor = resources.ruffleModernWasm === undefined
    ? `{fileName:${id(resources.ruffleModernWasmFileName ?? "a71cef02d58dcec6f55f.wasm")},sha256:${id(resources.ruffleModernWasmSha256 ?? "")},byteLength:${resources.ruffleModernWasmByteLength}}`
    : "null";
  const fallbackMarkup = modernOnly ? "" : `<div class="flash-fallback" id="keel-flash-fallback" hidden></div>`;
  const fallbackCode = modernOnly ? "" : `const fallback = ${fallbackDescriptor};
const requestFallbackWasm = () => {
  if (fallback === null) return Promise.reject(new Error("This browser needs Ruffle's MVP WASM, but no local fallback is declared."));
  const host = document.querySelector("#keel-flash-fallback");
  if (!(host instanceof HTMLElement)) return Promise.reject(new Error("Ruffle fallback upload control is unavailable."));
  host.hidden = false;
  host.replaceChildren(document.createTextNode("This browser lacks Ruffle WASM extensions. Upload the pinned MVP file "), (() => { const code = document.createElement("code"); code.textContent = fallback.fileName; return code; })(), document.createTextNode(" · "));
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".wasm,application/wasm";
  input.setAttribute("aria-label", "Upload Ruffle MVP WASM");
  host.append(input);
  return new Promise((resolve, reject) => {
    input.addEventListener("change", () => {
      void (async () => {
        const file = input.files?.[0];
        if (file === undefined) throw new Error("Choose the pinned Ruffle MVP WASM file to continue.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength !== fallback.byteLength) throw new Error("Ruffle fallback WASM byte length does not match the declared commitment.");
        const digest = await globalThis.crypto?.subtle?.digest("SHA-256", bytes);
        if (digest === undefined) throw new Error("Web Crypto is required to verify the local Ruffle fallback.");
        const actual = "0x" + [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        if (actual.toLowerCase() !== fallback.sha256.toLowerCase()) throw new Error("Ruffle fallback WASM SHA-256 does not match the declared commitment.");
        host.replaceChildren(document.createTextNode("LOCAL FALLBACK VERIFIED · "), (() => { const code = document.createElement("code"); code.textContent = file.name; return code; })());
        resolve(URL.createObjectURL(new Blob([bytes], { type: "application/wasm" })));
      })().catch(reject);
    }, { once: true });
  });
};`;
  const fallbackArgument = modernOnly ? "" : "fallbackWasmUrl,";
  return `<div class="flash-stage" data-keel-flash-runtime="ruffle"><div class="flash-player" id="keel-flash-player" aria-label="${escapeAttribute(name)}"></div><p class="flash-status" id="keel-flash-status">VERIFYING RUFFLE RESOURCES</p>${fallbackMarkup}</div><script type="module">
const content = globalThis.__KEEL_CONTENT__;
const context = globalThis.__KEEL_CONTEXT__ ?? {};
const maxToken = ${resources.collectionSize};
const tokenId = typeof context.tokenId === "string" && /^[0-9]+$/.test(context.tokenId) && BigInt(context.tokenId) >= 1n && BigInt(context.tokenId) <= BigInt(maxToken) ? context.tokenId : "1";
const safeToken = Number(tokenId);
const status = document.querySelector("#keel-flash-status");
const setStatus = (value, failed = false) => { if (status) { status.textContent = value; status.classList.toggle("error", failed); } };
const loadModule = async (resourceId) => {
  if (content === undefined || typeof content.url !== "function") throw new Error("Verified Keel content reader is unavailable.");
  const url = content.url(resourceId);
  if (typeof url !== "string" || url.length === 0) throw new Error("Missing verified Flash module resource: " + resourceId);
  return import(url);
};
const [{ createRuffleLoader, supportsRuffleWasmExtensions }, { createSeededRandom, randomInt }, { deriveFlashEdition, deriveTokenSeed }] = await Promise.all([
  loadModule(${id(resources.loader)}),
  loadModule(${id(resources.seededRandom)}),
  loadModule(${id(resources.edition)})
]);
const randomModule = { createSeededRandom, randomInt };
const contextSeed = [context.derivedTokenSeed, context.tokenSeed, context.seed].find((value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value));
const tokenSeed = contextSeed === undefined ? deriveTokenSeed(${scriptString(seed)}, safeToken, randomModule) : contextSeed.toLowerCase();
const traits = deriveFlashEdition(tokenSeed, safeToken, randomModule);
setStatus((contextSeed === undefined ? "PREVIEW" : "CHAIN SEED") + " · TOKEN " + tokenId + " · SEED " + tokenSeed.slice(-8) + " · PALETTE " + traits.paletteIndex);
${fallbackCode}
try {
  ${modernOnly ? "" : "const fallbackWasmUrl = supportsRuffleWasmExtensions() ? undefined : await requestFallbackWasm();"}
  const loader = createRuffleLoader({
    window,
    document,
    content,
    assets: {
      main: ${id(resources.ruffleMain)},
      modernCore: ${id(resources.ruffleModernCore)},
      legacyCore: ${id(resources.ruffleLegacyCore)},
      ${modernWasmAsset}
      legacyWasm: ${id(resources.ruffleLegacyWasm)}
    },
    ${fallbackArgument}
    autoplay: "on",
    unmuteOverlay: "hidden",
    publicPath: "keel://ruffle/"
  });
  const api = await loader.load();
  const player = api.newest().createPlayer();
  player.setAttribute("aria-label", ${id(name)});
  document.querySelector("#keel-flash-player")?.replaceWith(player);
  const swf = content.url(${id(resources.swf)});
  if (swf === null) throw new Error("Missing verified SWF resource.");
  await player.load({ url: swf, parameters: {
    seed: tokenSeed,
    tokenId,
    paletteIndex: String(traits.paletteIndex),
    motion: String(traits.motion),
    attraction: String(traits.attraction),
    gravity: String(traits.gravity),
    length: String(traits.length),
    bend: String(traits.bend)
  } });
  setStatus("VERIFIED · TOKEN " + tokenId + " · SEED " + tokenSeed.slice(-8) + " · PALETTE " + traits.paletteIndex);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.dataset.loadError = message;
  setStatus("Ruffle load failed: " + message, true);
  throw error;
}
</script>`;
}

function presentation(mode: EntrypointMode, resourceId: string, mediaType: string, name: string, flashRuntime?: FlashWrapperResources): string {
  if (flashRuntime !== undefined) return flashPresentation(flashRuntime, name);
  const source = `keel://${escapeAttribute(resourceId)}`;
  switch (mode) {
    case "image":
    case "svg":
      return `<img src="${source}" alt="${escapeAttribute(name)}">`;
    case "video":
      return `<video src="${source}" controls playsinline></video>`;
    case "audio":
      return `<section class="audio"><div class="disc" aria-hidden="true"></div><audio src="${source}" controls></audio></section>`;
    case "model":
      return `<section class="unsupported"><h2>3D model artifact</h2><p>This artifact includes a verified <code>${escapeHtml(mediaType)}</code> resource. Add an HTML entrypoint with your preferred WebGL renderer to make it interactive.</p><a href="${source}" download>Download verified model</a></section>`;
    case "module":
      return `<section class="unsupported"><h2>Module artifact</h2><p>A module needs an HTML mount point. Add an <code>index.html</code> file or use this generated wrapper as a starting point.</p></section><script type="module" src="${source}"></script>`;
    case "html":
      if (mediaType.toLowerCase().split(";", 1)[0] === "application/x-shockwave-flash") {
        return `<section class="unsupported" data-keel-flash-runtime="missing"><h2>Ruffle runtime required</h2><p>This verified SWF is not executed as a native browser plugin. Declare the Keel Ruffle runtime resources in the manifest to render it safely in the sandbox.</p><a href="${source}" download>Download verified SWF</a></section>`;
      }
      return `<iframe src="${source}" title="${escapeAttribute(name)}"></iframe>`;
  }
}

export function createGeneratedWrapper(input: {
  readonly name: string;
  readonly description?: string;
  readonly resourceId: string;
  readonly mediaType: string;
  readonly mode: EntrypointMode;
  readonly downloads: boolean;
  readonly flashRuntime?: FlashWrapperResources;
}): string {
  const main = presentation(input.mode, input.resourceId, input.mediaType, input.name, input.flashRuntime);
  const download = input.downloads
    ? `<a class="download" href="keel://${escapeAttribute(input.resourceId)}" download>Download verified original</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(input.name)}</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#08090c;color:#f7f7f8}
    *{box-sizing:border-box}html,body,main{width:100%;height:100%;margin:0}body{overflow:hidden}
    main{display:grid;place-items:center;position:relative;background:radial-gradient(circle at 50% 25%,#ffb6c11f,transparent 45%),#08090c}
    img,video,iframe{display:block;width:100%;height:100%;object-fit:contain;border:0}.audio{display:grid;gap:28px;place-items:center}.disc{width:min(58vw,340px);aspect-ratio:1;border-radius:50%;background:repeating-radial-gradient(circle,#1b1d24 0 4px,#111218 5px 9px);box-shadow:0 30px 100px #000}.unsupported{max-width:620px;padding:32px;border:1px solid #ffffff1f;border-radius:20px;background:#11131acc;line-height:1.55}.unsupported a,.download{color:#ffb6c1}.flash-stage{position:relative;width:100%;height:100%;display:grid;place-items:center;background:#07070b}.flash-player{width:100%;height:100%}.flash-player ruffle-player{display:block;width:100%;height:100%}.flash-status{position:absolute;left:12px;bottom:10px;margin:0;padding:6px 9px;background:#07070bcc;color:#9ea6ff;font-size:11px;letter-spacing:.08em;pointer-events:none}.flash-status.error{color:#ff91c8}.download{position:absolute;right:16px;bottom:16px;padding:10px 14px;border:1px solid #ffffff24;border-radius:999px;background:#11131add;text-decoration:none;backdrop-filter:blur(14px)}
  </style>
</head>
<body>
  <main aria-label="${escapeAttribute(input.name)}" data-description="${escapeAttribute(input.description ?? "")}">
    ${main}
    ${download}
  </main>
</body>
</html>`;
}

function safeCssColor(value: string | undefined): string {
  if (value === undefined) return "#090b12";
  return /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([0-9.,% ]+\)|hsla?\([0-9.,% deg]+\))$/u.test(value)
    ? value
    : "#090b12";
}

export function createArtifactWrapper(input: WrapperInput): string {
  const title = escapeHtml(input.title);
  const resourcePath = escapeAttribute(input.resourcePath);
  const originalPath = input.originalPath === undefined ? undefined : escapeAttribute(input.originalPath);
  const background = safeCssColor(input.backgroundColor);
  const objectFit = input.objectFit ?? "contain";
  const mediaType = input.mediaType.toLowerCase().split(";", 1)[0] ?? input.mediaType.toLowerCase();
  let content: string;
  if (mediaType.startsWith("image/")) content = `<img class="asset" src="${resourcePath}" alt="${title}">`;
  else if (mediaType.startsWith("video/")) content = `<video class="asset" src="${resourcePath}" controls playsinline preload="metadata"></video>`;
  else if (mediaType.startsWith("audio/")) content = `<div class="audio-shell"><audio src="${resourcePath}" controls preload="metadata"></audio></div>`;
  else if (mediaType === "text/html" || mediaType === "image/svg+xml") content = `<iframe class="document" src="${resourcePath}" title="${title}"></iframe>`;
  else content = `<div class="unsupported"><strong>${title}</strong><p>${escapeHtml(input.mediaType)}</p><a href="${resourcePath}" download>Download verified resource</a></div>`;
  const download = originalPath === undefined ? "" : `<a class="download" href="${originalPath}" download>Download original</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark;background:${background}}*{box-sizing:border-box}html,body,main{width:100%;height:100%;margin:0}body{overflow:hidden;background:${background};color:#fff;font-family:ui-sans-serif,system-ui}main{position:relative;display:grid;place-items:center}.asset{width:100%;height:100%;object-fit:${objectFit}}.document{width:100%;height:100%;border:0}.download{position:fixed;right:1rem;bottom:1rem;padding:.65rem .9rem;border:1px solid #ffffff40;border-radius:999px;background:#090b12cc;color:#fff;text-decoration:none}.audio-shell,.unsupported{padding:2rem;text-align:center}audio{width:min(90vw,40rem)}</style></head><body><main>${content}${download}</main></body></html>`;
}
