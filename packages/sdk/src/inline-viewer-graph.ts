/**
 * Node-only planner for a modular Inline KEEL viewer.
 *
 * Shared shell/module fragments are published once per chain. A creator root
 * references those immutable objects and publishes only its small entry slot.
 * This file prepares and verifies bytes; it never signs or submits.
 */
import { assertDataUriMediaType, createIntegrity, serializeScriptJSON, type Hex, type Integrity } from "@keel/protocol";
import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";
import { encodeAbiParameters, getAddress, keccak256, stringToHex } from "viem";

import { KEEL_INLINE_MAX_TOKEN_URI_BYTES, keelWeb3ObjectURI } from "./presentation.js";
import {
  KEEL_ASSET_DISPLAY_MEDIA_TYPES,
  KEEL_ASSET_DISPLAY_MODULE_ID,
  KEEL_ASSET_DISPLAY_MODULE_VERSION,
  keelAssetDisplayKind,
  keelAssetDisplayModuleBytes,
  type KeelAssetDisplayKind,
  type KeelAssetDisplayMediaType,
} from "./asset-display.js";
import {
  buildCompactInlineKeelShell,
  buildEmbeddedKeelViewerSlot,
  type KeelStandaloneViewerItem,
} from "./verification-shell.js";
import { orderKeelModules, type KeelModulePhase } from "./data-layer.js";
import { KEEL_INLINE_PROTECTION_SHELL_ID } from "./shell-registry.js";

export {
  KEEL_ASSET_DISPLAY_MEDIA_TYPES,
  KEEL_ASSET_DISPLAY_MODULE_ID,
  KEEL_ASSET_DISPLAY_MODULE_VERSION,
  keelAssetDisplayKind,
  keelAssetDisplayModuleBytes,
};
export type { KeelAssetDisplayKind, KeelAssetDisplayMediaType };

const RFC_4648_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface KeelComposableBase64Fragment {
  /** UTF-8/binary byte length before harmless boundary padding. */
  readonly rawByteLength: number;
  /** Harmless raw bytes appended before the one build-time Base64 encode. */
  readonly paddingBytes: 0 | 1 | 2;
  /** RFC 4648 text forming an exact slice of the outer Base64 document. */
  readonly base64: string;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Composable text contains an unpaired high surrogate.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Composable text contains an unpaired low surrogate.");
    }
  }
}

/**
 * Prepare one exact slice of a larger Base64 stream. This is a build-only
 * operation: contracts store/copy the returned ASCII and never encode it.
 */
export function createComposableBase64Fragment(
  raw: Uint8Array | string,
  options: {
    readonly mustAllowFollowingFragment?: boolean;
    readonly paddingStrategy?: "space" | "json-whitespace";
  } = {},
): KeelComposableBase64Fragment {
  if (typeof raw === "string") assertWellFormedUnicode(raw);
  if (!(typeof raw === "string" || raw instanceof Uint8Array)) {
    throw new TypeError("A composable fragment must be UTF-8 text or Uint8Array bytes.");
  }
  const bytes = typeof raw === "string" ? encoder.encode(raw) : raw.slice();
  const mustAlign = options.mustAllowFollowingFragment ?? true;
  const missing = mustAlign ? (3 - (bytes.byteLength % 3)) % 3 : 0;
  const paddingBytes = missing as 0 | 1 | 2;
  if (paddingBytes !== 0 && options.paddingStrategy !== undefined
      && options.paddingStrategy !== "space" && options.paddingStrategy !== "json-whitespace") {
    throw new TypeError("Unsupported composable-fragment padding strategy.");
  }
  const aligned = paddingBytes === 0 ? bytes : concat([bytes, encoder.encode(" ".repeat(paddingBytes))]);
  const base64 = Buffer.from(aligned).toString("base64");
  if (!RFC_4648_BASE64.test(base64) || (mustAlign && (aligned.byteLength % 3 !== 0 || base64.includes("=")))) {
    throw new Error("Composable Base64 fragment failed its RFC 4648 alignment invariant.");
  }
  return { rawByteLength: bytes.byteLength, paddingBytes, base64 };
}

/** Escape JSON for a raw script-text slot before UTF-8 sizing/alignment. */
export function serializeInlineScriptJSON(value: unknown): string {
  return serializeScriptJSON(value);
}

/** Validate and join fragments without decoding or re-encoding any payload. */
export function concatenateComposableBase64Fragments(
  fragments: readonly KeelComposableBase64Fragment[],
): string {
  if (fragments.length === 0) return "";
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index]!;
    if (!Number.isSafeInteger(fragment.rawByteLength) || fragment.rawByteLength < 0
        || !Number.isSafeInteger(fragment.paddingBytes) || fragment.paddingBytes < 0 || fragment.paddingBytes > 2
        || !RFC_4648_BASE64.test(fragment.base64)) {
      throw new TypeError(`Malformed composable Base64 fragment at index ${index}.`);
    }
    if (index < fragments.length - 1 && fragment.base64.includes("=")) {
      throw new TypeError(`Non-terminal composable Base64 fragment ${index} contains padding.`);
    }
  }
  return fragments.map((fragment) => fragment.base64).join("");
}

export interface KeelInlineFragmentBytes {
  readonly bytes: Uint8Array;
  readonly integrity: Integrity;
}

export interface KeelPublishedInlineFragment extends KeelInlineFragmentBytes {
  readonly carrier: {
    readonly chainId: number;
    readonly store: Hex;
    readonly objectId: Hex;
    readonly mediaType: string;
    readonly compression: "none";
    readonly storedByteLength: number;
  };
}

export interface KeelInlineShellFragments {
  readonly schema: "keel-inline-shell-fragments@1";
  readonly codecProfile: "browser-gzip-deflate";
  readonly prefix: KeelInlineFragmentBytes;
  readonly suffix: KeelInlineFragmentBytes;
}

export interface KeelInlineModuleFragment extends KeelInlineFragmentBytes {
  readonly schema: "keel-inline-module-fragment@1";
  readonly moduleId: string;
  readonly version: string;
  readonly execution: "classic" | "module";
  readonly phase: KeelModulePhase;
  readonly weight: number;
  readonly item: KeelStandaloneViewerItem;
}

export type KeelInlineAssetDisplayModuleFragment = KeelInlineModuleFragment & {
  readonly moduleId: typeof KEEL_ASSET_DISPLAY_MODULE_ID;
  readonly version: typeof KEEL_ASSET_DISPLAY_MODULE_VERSION;
};

export type KeelInlineDocumentPart = {
  readonly kind: "existing";
  readonly role: "shell-prefix" | "module" | "entrypoint" | "shell-suffix";
  readonly moduleId?: string;
  readonly moduleVersion?: string;
  readonly execution?: "classic" | "module";
  readonly phase?: KeelModulePhase;
  readonly weight?: number;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly integrity: Integrity;
} | {
  readonly kind: "creator";
  readonly role: "entrypoint" | "asset";
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly integrity: Integrity;
};

export interface KeelInlineGraphDocument {
  readonly rootBytes: Uint8Array;
  readonly rootIntegrity: Integrity;
  readonly byteLength: number;
  readonly parts: readonly KeelInlineDocumentPart[];
}

export interface KeelInlineLocalDocument extends KeelInlineGraphDocument {
  readonly schema: "keel-inline-local-document@1";
}

/**
 * Canonical composition for one normal image, video, or GLB. The shell and
 * asset-display module are reusable objects; the sole creator object is
 * the artist's original media asset.
 */
export interface KeelInlineNormalMediaDocument extends KeelInlineGraphDocument {
  readonly schema: "keel-inline-normal-media-document@1";
  readonly declaration: {
    readonly shellId: typeof KEEL_INLINE_PROTECTION_SHELL_ID;
    readonly assetDisplay: {
      readonly moduleId: typeof KEEL_ASSET_DISPLAY_MODULE_ID;
      readonly version: typeof KEEL_ASSET_DISPLAY_MODULE_VERSION;
      readonly integrity: Integrity;
    };
    readonly creatorAsset: {
      readonly id: string;
      readonly mediaType: KeelAssetDisplayMediaType;
      readonly integrity: Integrity;
    };
  };
}

export interface KeelInlinePreEncodedTokenURIFragment extends KeelInlineFragmentBytes {
  readonly role: "shell-prefix" | "module" | "entrypoint" | "asset" | "shell-suffix";
  readonly sourceKind: "existing" | "creator";
  readonly sourceObjectId?: Hex;
  readonly sourceIntegrity: Integrity;
  readonly decodedHtmlBytes: Uint8Array;
}

/**
 * Static middle of an ERC-721 Base64 JSON tokenURI. Its bytes are themselves
 * Base64 text and can be copied directly between aligned, dynamically encoded
 * JSON prefix/suffix fragments without re-encoding the complete viewer.
 */
export interface KeelInlinePreEncodedTokenURIGraph {
  readonly schema: "keel-inline-preencoded-token-uri@1";
  readonly mediaType: "application/vnd.keel.token-uri-base64-fragment";
  readonly contextParameter: "keel-context";
  readonly contextDelivery: "base64-html-tail";
  readonly fragmentBytes: Uint8Array;
  readonly fragmentIntegrity: Integrity;
  readonly htmlBytes: Uint8Array;
  readonly htmlIntegrity: Integrity;
  readonly creatorPublicationBytes: number;
  readonly parts: readonly KeelInlinePreEncodedTokenURIFragment[];
}

/**
 * Build-time carrier for an immutable prepared tokenURI. The chain stores the
 * `fragmentBytes` as an uncompressed Keel object and copies those bytes between
 * the small outer Base64 prefix/suffix. The decoded HTML is padded only with
 * legal trailing spaces so both Base64 layers remain exactly aligned.
 */
export interface KeelPreparedTokenURIFragment {
  readonly schema: "keel-prepared-token-uri-fragment@1";
  readonly mediaType: "application/vnd.keel.token-uri-base64-fragment";
  readonly sourceByteLength: number;
  readonly sourceIntegrity: Integrity;
  readonly htmlBytes: Uint8Array;
  readonly htmlIntegrity: Integrity;
  readonly fragmentBytes: Uint8Array;
  readonly fragmentIntegrity: Integrity;
}

export interface KeelPreparedOneOfOneTokenURI {
  readonly schema: "keel-prepared-one-of-one-token-uri@1";
  readonly encodedPrefix: Uint8Array;
  readonly encodedSuffix: Uint8Array;
  readonly tokenURI: string;
  readonly tokenJSON: string;
  readonly contextJSON: string;
  readonly contextDigest: Hex;
  readonly derivedTokenSeed: Hex;
}

export interface KeelOnchainShellLoaderInput {
  /** Public, CORS-enabled JSON-RPC endpoint used only to read the committed shell. */
  readonly rpcUrl: string;
  /** The deployed KeelHarnessBuilder that owns the committed shell object. */
  readonly builder: Hex;
  /** The existing uncompressed shell object root. */
  readonly objectId: Hex;
  /** SHA-256 digest committed for the shell object. */
  readonly digest: Hex;
  /**
   * Optional immutable token context. Supplying it makes the loader
   * independent of a contract-side context injector, which is useful with
   * the legacy `setOnchainHarness` route. The object is serialized through
   * the same script-safe JSON boundary as every other inline value.
   */
  readonly context?: {
    readonly json: string;
    readonly digest: Hex;
    readonly byteLength: number;
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const SAFE_INLINE_MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function base64Bytes(bytes: Uint8Array): Uint8Array {
  return encoder.encode(Buffer.from(bytes).toString("base64"));
}

function exactBase64Bytes(value: string, label: string): Uint8Array {
  if (!RFC_4648_BASE64.test(value)) throw new TypeError(`${label} is not canonical RFC 4648 Base64.`);
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) throw new TypeError(`${label} is not canonical RFC 4648 Base64.`);
  return bytes;
}

function decodePublishedGraphPart(fragment: KeelPublishedInlineFragment): Uint8Array {
  const outerBase64 = decoder.decode(fragment.bytes);
  const outerBytes = exactBase64Bytes(outerBase64, "Published Inline fragment");
  return exactBase64Bytes(decoder.decode(outerBytes), "Published Inline decoded HTML fragment");
}

async function assertPublishedFragmentIntegrity(fragment: KeelPublishedInlineFragment, label: string): Promise<void> {
  if (
    fragment.carrier.compression !== "none"
    || fragment.carrier.storedByteLength !== fragment.bytes.byteLength
    || fragment.integrity.byteLength !== fragment.bytes.byteLength
  ) {
    throw new TypeError(`${label} must be an exact uncompressed reusable fragment object.`);
  }
  const integrity = await createIntegrity(fragment.bytes);
  if (
    integrity.algorithm !== fragment.integrity.algorithm
    || integrity.digest.toLowerCase() !== fragment.integrity.digest.toLowerCase()
    || integrity.byteLength !== fragment.integrity.byteLength
  ) {
    throw new TypeError(`${label} bytes do not match their reusable object commitment.`);
  }
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

/**
 * Verify that a canonical published module fragment expands to the exact
 * decoded SDK module bytes. Publication must consume this stored fragment,
 * not recompress the module with the server's platform zlib implementation.
 */
export async function verifyKeelPublishedInlineModuleFragment(input: {
  readonly fragment: KeelPublishedInlineFragment;
  readonly moduleId: string;
  readonly mediaType: string;
  readonly aliases: readonly string[];
  readonly decodedBytes: Uint8Array;
}): Promise<void> {
  await assertPublishedFragmentIntegrity(input.fragment, `Inline module ${input.moduleId}`);
  const decodedHtmlBytes = decodePublishedGraphPart(input.fragment);
  const text = decoder.decode(decodedHtmlBytes);
  const trailing = text.length - text.trimEnd().length;
  const trailingText = trailing === 0 ? "" : text.slice(text.length - trailing);
  if (!text.startsWith(",") || trailing > 8 || !/^ *$/u.test(trailingText)) {
    throw new TypeError(`Inline module ${input.moduleId} is not one aligned KEEL viewer slot.`);
  }
  let item: KeelStandaloneViewerItem;
  try {
    item = JSON.parse(text.slice(1).trimEnd()) as KeelStandaloneViewerItem;
  } catch {
    throw new TypeError(`Inline module ${input.moduleId} does not contain canonical viewer-slot JSON.`);
  }
  if (
    item.id !== input.moduleId
    || item.role !== "module"
    || item.mediaType !== input.mediaType
    || !exactStringArray(item.aliases, input.aliases)
    || item.integrity.algorithm !== "sha256"
    || item.integrity.byteLength !== input.decodedBytes.byteLength
    || item.embedded === undefined
    || !["none", "gzip", "deflate"].includes(item.embedded.compression)
  ) {
    throw new TypeError(`Inline module ${input.moduleId} metadata does not match its SDK declaration.`);
  }
  const stored = exactBase64Bytes(item.embedded.storedBase64, `Inline module ${input.moduleId} payload`);
  const decoded = item.embedded.compression === "gzip"
    ? new Uint8Array(await gunzipAsync(stored))
    : item.embedded.compression === "deflate"
      ? new Uint8Array(await inflateAsync(stored))
      : stored;
  const [decodedIntegrity, storedIntegrity] = await Promise.all([
    createIntegrity(decoded),
    createIntegrity(stored),
  ]);
  if (
    !exactBytes(decoded, input.decodedBytes)
    || decodedIntegrity.digest.toLowerCase() !== item.integrity.digest.toLowerCase()
    || decodedIntegrity.byteLength !== item.integrity.byteLength
    || (item.embedded.storedIntegrity !== undefined && (
      storedIntegrity.digest.toLowerCase() !== item.embedded.storedIntegrity.digest.toLowerCase()
      || storedIntegrity.byteLength !== item.embedded.storedIntegrity.byteLength
    ))
  ) {
    throw new TypeError(`Inline module ${input.moduleId} payload does not match its decoded SDK bytes.`);
  }
}

function appendSpacesToMultiple(bytes: Uint8Array, multiple: number): Uint8Array {
  const missing = (multiple - (bytes.byteLength % multiple)) % multiple;
  return missing === 0 ? bytes.slice() : concat([bytes, encoder.encode(" ".repeat(missing))]);
}

/**
 * Build a small self-contained bridge to an already committed Keel shell.
 *
 * The bridge is useful when a tokenURI must stay small: it contains no project
 * host, IPFS gateway, or mutable asset URL. It performs one public JSON-RPC
 * read of `harnessHTML`, carries the prepared token context into the returned
 * document, and replaces itself with the canonical verification shell. The
 * outer tokenURI is still Base64 encoded by `buildKeelPreparedOneOfOneTokenURI`.
 */
export function buildKeelOnchainShellLoader(input: KeelOnchainShellLoaderInput): string {
  if (typeof input.rpcUrl !== "string" || input.rpcUrl.trim() === "") {
    throw new TypeError("An onchain shell loader needs a public RPC URL.");
  }
  let rpc: URL;
  try {
    rpc = new URL(input.rpcUrl);
  } catch {
    throw new TypeError("The onchain shell loader RPC URL is malformed.");
  }
  if (rpc.protocol !== "https:" || rpc.username !== "" || rpc.password !== "" || rpc.hash !== "") {
    throw new TypeError("The onchain shell loader RPC URL must be a credential-free HTTPS endpoint.");
  }
  const builder = getAddress(input.builder);
  if (!/^0x[0-9a-f]{64}$/iu.test(input.objectId) || !/^0x[0-9a-f]{64}$/iu.test(input.digest)) {
    throw new TypeError("The onchain shell loader needs canonical object and digest bytes32 values.");
  }
  const selector = keccak256(stringToHex("harnessHTML(bytes32,bytes32)")).slice(0, 10);
  const callData = `${selector}${input.objectId.slice(2)}${input.digest.slice(2)}`;
  let contextLiteral = "null";
  if (input.context !== undefined) {
    if (typeof input.context.json !== "string" || !/^0x[0-9a-f]{64}$/iu.test(input.context.digest)
        || !Number.isSafeInteger(input.context.byteLength) || input.context.byteLength < 0
        || input.context.byteLength !== encoder.encode(input.context.json).byteLength) {
      throw new TypeError("The onchain shell loader context must contain canonical JSON bytes, digest, and length.");
    }
    contextLiteral = serializeInlineScriptJSON(input.context);
  }
  const rpcLiteral = serializeInlineScriptJSON(rpc.toString());
  const builderLiteral = serializeInlineScriptJSON(builder);
  const callLiteral = serializeInlineScriptJSON(callData);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keel shell loader</title></head><body><p id="keel-loader-status">Loading committed Keel shell…</p><script>(()=>{const R=${rpcLiteral},T=${builderLiteral},D=${callLiteral},C=${contextLiteral},E=50000000;const fail=e=>{document.body.textContent="Keel shell load failed: "+(e?.message??e);document.documentElement.dataset.keelLoader="failed"};const hexBytes=h=>{if(typeof h!=="string"||!/^0x[0-9a-f]*$/i.test(h)||h.length%2!==0)throw new Error("RPC returned malformed bytes.");const a=new Uint8Array((h.length-2)/2);for(let i=0;i<a.length;i++)a[i]=Number.parseInt(h.slice(2+i*2,4+i*2),16);return a};const resultBytes=h=>{const o=Number(BigInt("0x"+h.slice(2,66))),p=2+o*2,l=Number(BigInt("0x"+h.slice(p,p+64)));return hexBytes("0x"+h.slice(p+64,p+64+l*2))};const safe=v=>{const s=String.fromCharCode(92),j=JSON.stringify(v);if(j===undefined)throw new Error("Prepared context is not JSON serializable.");return j.replaceAll("&",s+"u0026").replaceAll("<",s+"u003c").replaceAll(">",s+"u003e").replaceAll(String.fromCharCode(8232),s+"u2028").replaceAll(String.fromCharCode(8233),s+"u2029")};(async()=>{await new Promise(r=>setTimeout(r,0));const response=await fetch(R,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:T,data:D,gas:"0x"+E.toString(16)},"latest"]})});const body=await response.json();if(!response.ok||body.error||typeof body.result!=="string")throw new Error(body.error?.message??"RPC shell read failed.");const html=new TextDecoder("utf-8",{fatal:true}).decode(resultBytes(body.result));if(!html.includes("verify-corner"))throw new Error("Committed shell failed its canonical check.");const c=C??globalThis.__KEEL_ONCHAIN_CONTEXT__;if(!c||typeof c.json!=="string"||typeof c.digest!=="string"||!Number.isSafeInteger(c.byteLength))throw new Error("Prepared Keel context was not available.");const injection="<scr"+"ipt>globalThis.__KEEL_ONCHAIN_CONTEXT__=Object.freeze({json:"+safe(c.json)+",digest:"+safe(c.digest)+",byteLength:"+c.byteLength+"})</scr"+"ipt>";const head=/<head(?:\\s[^>]*)?>/i;const next=head.test(html)?html.replace(head,m=>m+injection):injection+html;document.open();document.write(next);document.close()})().catch(fail)})()</script></body></html>`;
}

/**
 * Encode one complete HTML document for KEEL's prepared tokenURI lane.
 *
 * The result is deliberately two Base64 layers: the inner layer is the HTML
 * payload and the outer layer is the exact ASCII stream copied by the
 * contract. No HTML, JSON, whitespace, delimiter, or control byte survives in
 * the published fragment, so URI readers cannot reinterpret content as syntax.
 */
export async function buildKeelPreparedTokenURIFragment(
  source: Uint8Array | string,
): Promise<KeelPreparedTokenURIFragment> {
  if (typeof source === "string") assertWellFormedUnicode(source);
  if (!(typeof source === "string" || source instanceof Uint8Array)) {
    throw new TypeError("A prepared tokenURI fragment must be UTF-8 text or Uint8Array bytes.");
  }
  const sourceBytes = typeof source === "string" ? encoder.encode(source) : source.slice();
  if (sourceBytes.byteLength === 0) throw new TypeError("A prepared tokenURI fragment cannot be empty.");
  const htmlBytes = appendSpacesToMultiple(sourceBytes, 9);
  const inner = base64Bytes(htmlBytes);
  if (inner.byteLength % 3 !== 0) {
    throw new Error("Prepared tokenURI HTML did not align at the outer Base64 boundary.");
  }
  const fragmentBytes = base64Bytes(inner);
  const fragmentText = decoder.decode(fragmentBytes);
  if (fragmentBytes.byteLength % 4 !== 0 || /=/u.test(fragmentText)) {
    throw new Error("Prepared tokenURI fragment must be unpadded RFC 4648 Base64.");
  }
  return {
    schema: "keel-prepared-token-uri-fragment@1",
    mediaType: "application/vnd.keel.token-uri-base64-fragment",
    sourceByteLength: sourceBytes.byteLength,
    sourceIntegrity: await createIntegrity(sourceBytes),
    htmlBytes,
    htmlIntegrity: await createIntegrity(htmlBytes),
    fragmentBytes,
    fragmentIntegrity: await createIntegrity(fragmentBytes),
  };
}

function tokenContextHTMLTail(contextJSON: string, contextDigest: Hex, contextByteLength: number): string {
  const contextBase64URL = Buffer.from(contextJSON, "utf8").toString("base64url");
  return `<script>(()=>{try{const v="${contextBase64URL}",b=v.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-v.length%4)%4),j=atob(b),c=Object.freeze(JSON.parse(j)),o=Object.freeze({json:j,digest:"${contextDigest}",byteLength:${contextByteLength}});Object.defineProperty(globalThis,"__OCA_CONTEXT__",{value:c,enumerable:true,writable:false,configurable:false});Object.defineProperty(globalThis,"__KEEL_CONTEXT__",{value:c,enumerable:true,writable:false,configurable:false});Object.defineProperty(globalThis,"__KEEL_ONCHAIN_CONTEXT__",{value:o,enumerable:true,writable:false,configurable:false})}catch(e){document.documentElement.dataset.keelContext="failed";throw e}})()</script>`;
}

function assertMarketplaceSafeDataURI(value: string, label: string): void {
  if (!value.startsWith("data:")) return;
  const comma = value.indexOf(",");
  if (comma < 5) throw new TypeError(`${label} is not a complete data URI.`);
  const header = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const mediaType = header.replace(/;base64$/iu, "");
  assertDataUriMediaType(mediaType);
  if (mediaType !== header) {
    exactBase64Bytes(payload, `${label} Base64 payload`);
    return;
  }
  // Keep only RFC 3986 unreserved bytes literal. Reserved punctuation is
  // valid in some data-URI readers but can still be reinterpreted by JSON,
  // HTML, marketplace, or opaque-origin parsers downstream.
  if (!/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})*$/iu.test(payload)) {
    throw new TypeError(`${label} contains raw text that must be percent-escaped.`);
  }
}

async function exactFragment(bytes: Uint8Array): Promise<KeelInlineFragmentBytes> {
  if (bytes.byteLength === 0) throw new TypeError("An Inline fragment cannot be empty.");
  return { bytes, integrity: await createIntegrity(bytes) };
}

/** Build the small reusable shell halves without embedding Brotli WASM. */
export async function buildKeelInlineShellFragments(input: {
  readonly repositoryRoot: string;
}): Promise<KeelInlineShellFragments> {
  const shell = await buildCompactInlineKeelShell({ repositoryRoot: input.repositoryRoot });
  return {
    schema: "keel-inline-shell-fragments@1",
    codecProfile: "browser-gzip-deflate",
    prefix: await exactFragment(shell.prefix),
    suffix: await exactFragment(shell.suffix),
  };
}

/**
 * Build the exact reusable JSON slot for a browser module. Publish this slot
 * once per chain and retain its object ID with the module catalogue record.
 */
export async function buildKeelInlineModuleFragment(input: {
  readonly moduleId: string;
  readonly version: string;
  readonly mediaType: string;
  readonly aliases?: readonly string[];
  readonly decodedBytes: Uint8Array;
  readonly compression?: "none" | "gzip" | "deflate";
  readonly execution?: "classic" | "module";
  readonly phase?: KeelModulePhase;
  readonly weight?: number;
}): Promise<KeelInlineModuleFragment> {
  if (input.moduleId.trim() === "" || input.version.trim() === "") {
    throw new TypeError("An Inline module fragment needs an exact module ID and version.");
  }
  if (!SAFE_INLINE_MODULE_ID.test(input.moduleId)) {
    throw new TypeError("An Inline module fragment ID must be safe in an HTML source attribute.");
  }
  const phase = input.phase ?? "runtime";
  const execution = input.execution ?? "module";
  if (phase === "data" && execution !== "classic") {
    throw new TypeError("Inline data modules must use classic execution so they run before renderer code.");
  }
  const weight = input.weight ?? 0;
  orderKeelModules([{ moduleId: input.moduleId, phase, weight }]);
  const slot = await buildEmbeddedKeelViewerSlot({
    id: input.moduleId,
    role: phase === "data" ? "data" : "module",
    mediaType: input.mediaType,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    bytes: input.decodedBytes,
    compression: input.compression ?? "gzip",
  });
  return {
    schema: "keel-inline-module-fragment@1",
    moduleId: input.moduleId,
    version: input.version,
    execution,
    phase,
    weight,
    item: slot.item,
    bytes: slot.fragment,
    integrity: slot.fragmentIntegrity,
  };
}

/** Build the exact reusable normal-media renderer slot for one chain catalogue. */
export async function buildKeelInlineAssetDisplayModuleFragment(): Promise<KeelInlineAssetDisplayModuleFragment> {
  return await buildKeelInlineModuleFragment({
    moduleId: KEEL_ASSET_DISPLAY_MODULE_ID,
    version: KEEL_ASSET_DISPLAY_MODULE_VERSION,
    mediaType: "text/javascript",
    aliases: [KEEL_ASSET_DISPLAY_MODULE_ID],
    decodedBytes: keelAssetDisplayModuleBytes(),
    compression: "gzip",
    execution: "classic",
    phase: "render",
  }) as KeelInlineAssetDisplayModuleFragment;
}

function isNormalMediaEntry(mediaType: string): mediaType is KeelAssetDisplayMediaType {
  return (KEEL_ASSET_DISPLAY_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

async function assertCanonicalAssetDisplayModule(module: KeelInlineModuleFragment): Promise<void> {
  const expected = await buildKeelInlineAssetDisplayModuleFragment();
  if (
    module.moduleId !== expected.moduleId
    || module.version !== expected.version
    || module.execution !== expected.execution
    || module.phase !== expected.phase
    || module.item.role !== "module"
    || !exactBytes(module.bytes, expected.bytes)
    || module.integrity.digest.toLowerCase() !== expected.integrity.digest.toLowerCase()
  ) {
    throw new TypeError("Direct image, video, and GLB entries require the exact registered keel.asset-display module.");
  }
}

/**
 * Build the exact local document used for sandboxing and deterministic
 * fragment generation. It deliberately has no carrier identities: the only
 * publishable graph is the pre-encoded composable graph derived from it.
 */
export async function buildKeelInlineLocalDocument(input: {
  readonly shell: KeelInlineShellFragments;
  readonly modules: readonly KeelInlineModuleFragment[];
  readonly entry: {
    readonly id: string;
    /** Text artwork, or the direct creator media entry mounted by keel.asset-display. */
    readonly mediaType: "text/html" | "text/javascript" | KeelAssetDisplayMediaType;
    readonly source: Uint8Array;
    readonly aliases?: readonly string[];
  };
}): Promise<KeelInlineLocalDocument> {
  const orderedModules = orderKeelModules(input.modules);
  for (const module of orderedModules) {
    if (!SAFE_INLINE_MODULE_ID.test(module.moduleId) || module.item.id !== module.moduleId) {
      throw new TypeError(`Inline module ${module.moduleId} has an unsafe or mismatched resource ID.`);
    }
    if (module.item.embedded?.compression === "brotli") {
      throw new TypeError(`Inline module ${module.moduleId} requires a declared Brotli decoder shell profile.`);
    }
  }
  const directMedia = isNormalMediaEntry(input.entry.mediaType);
  if (directMedia) {
    if (orderedModules.length !== 1) {
      throw new TypeError("A direct image, video, or GLB entry requires exactly one registered keel.asset-display module.");
    }
    await assertCanonicalAssetDisplayModule(orderedModules[0]!);
  }
  const source = directMedia ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(input.entry.source);
  if (input.entry.mediaType === "text/javascript" && source !== undefined && /<\/script/iu.test(source)) {
    throw new TypeError("An Inline JavaScript entry cannot contain a closing script tag.");
  }
  const dataScripts = orderedModules
    .filter((module) => module.phase === "data")
    .map((module) => `<script src="${module.moduleId}"></script>`);
  const htmlEntry = directMedia || source === undefined
    ? undefined
    : dataScripts.length === 0 ? input.entry.source : new TextEncoder().encode(
      /<head(?:\s[^>]*)?>/iu.test(source)
        ? source.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${dataScripts.join("")}`)
        : `<!doctype html><html><head>${dataScripts.join("")}</head><body>${source}</body></html>`,
    );
  const entrySource = directMedia
    ? input.entry.source
    : input.entry.mediaType === "text/javascript" && source !== undefined
      ? new TextEncoder().encode([
          '<div id="stage"></div>',
          ...orderedModules
            .filter((module) => module.execution === "classic")
            .map((module) => {
              return `<script src="${module.moduleId}"></script>`;
            }),
          `<script type="module">${source}</script>`,
        ].join(""))
      : htmlEntry!;
  const entry = await buildEmbeddedKeelViewerSlot({
    id: input.entry.id,
    role: "entrypoint",
    mediaType: directMedia ? input.entry.mediaType : "text/html",
    ...(input.entry.aliases === undefined ? {} : { aliases: input.entry.aliases }),
    bytes: entrySource,
    compression: "gzip",
  });
  const parts: KeelInlineLocalDocument["parts"] = [
    { kind: "existing", role: "shell-prefix", bytes: input.shell.prefix.bytes, byteLength: input.shell.prefix.bytes.byteLength, integrity: input.shell.prefix.integrity },
    ...orderedModules.map((module) => ({
      kind: "existing" as const,
      role: "module" as const,
      moduleId: module.moduleId,
      moduleVersion: module.version,
      execution: module.execution,
      phase: module.phase,
      weight: module.weight,
      bytes: module.bytes,
      byteLength: module.bytes.byteLength,
      integrity: module.integrity,
    })),
    { kind: "creator", role: "entrypoint", bytes: entry.fragment, byteLength: entry.fragment.byteLength, integrity: entry.fragmentIntegrity },
    { kind: "existing", role: "shell-suffix", bytes: input.shell.suffix.bytes, byteLength: input.shell.suffix.bytes.byteLength, integrity: input.shell.suffix.integrity },
  ];
  const rootBytes = concat(parts.map((part) => part.bytes));
  return {
    schema: "keel-inline-local-document@1",
    rootBytes,
    rootIntegrity: await createIntegrity(rootBytes),
    byteLength: rootBytes.byteLength,
    parts,
  };
}

/**
 * Compose a normal single-file image, video, or self-contained GLB without
 * authoring a project wrapper. The registered KEEL shell and asset-display
 * module are reusable graph objects; only `asset.source` is creator-specific.
 */
export async function buildKeelInlineNormalMediaDocument(input: {
  readonly shell: KeelInlineShellFragments;
  readonly asset: {
    readonly id: string;
    readonly mediaType: KeelAssetDisplayMediaType;
    readonly source: Uint8Array;
    readonly aliases?: readonly string[];
  };
}): Promise<KeelInlineNormalMediaDocument> {
  keelAssetDisplayKind(input.asset.mediaType);
  const [assetDisplay, canonicalShell] = await Promise.all([
    buildKeelInlineAssetDisplayModuleFragment(),
    buildKeelInlineShellFragments({ repositoryRoot: "" }),
  ]);
  if (
    !exactBytes(input.shell.prefix.bytes, canonicalShell.prefix.bytes)
    || !exactBytes(input.shell.suffix.bytes, canonicalShell.suffix.bytes)
  ) {
    throw new TypeError("Normal media must use the exact canonical registered KEEL Inline shell fragments.");
  }
  const local = await buildKeelInlineLocalDocument({
    shell: input.shell,
    modules: [assetDisplay],
    entry: input.asset,
  });
  const entry = local.parts[2];
  if (entry === undefined || entry.kind !== "creator" || entry.role !== "entrypoint") {
    throw new Error("Canonical normal-media composition did not produce the creator entrypoint.");
  }
  const entryItem = JSON.parse(decoder.decode(entry.bytes).slice(1)) as KeelStandaloneViewerItem;
  if (entryItem.mediaType !== input.asset.mediaType || entryItem.integrity === undefined) {
    throw new Error("Canonical normal-media composition did not preserve the creator asset commitment.");
  }
  return {
    schema: "keel-inline-normal-media-document@1",
    rootBytes: local.rootBytes,
    rootIntegrity: local.rootIntegrity,
    byteLength: local.byteLength,
    parts: local.parts,
    declaration: {
      shellId: KEEL_INLINE_PROTECTION_SHELL_ID,
      assetDisplay: {
        moduleId: KEEL_ASSET_DISPLAY_MODULE_ID,
        version: KEEL_ASSET_DISPLAY_MODULE_VERSION,
        integrity: assetDisplay.integrity,
      },
      creatorAsset: {
        id: input.asset.id,
        mediaType: input.asset.mediaType,
        integrity: entryItem.integrity,
      },
    },
  };
}

async function assertCanonicalNormalMediaDocument(root: KeelInlineNormalMediaDocument): Promise<void> {
  if (
    root.schema !== "keel-inline-normal-media-document@1"
    || root.declaration.shellId !== KEEL_INLINE_PROTECTION_SHELL_ID
    || root.declaration.assetDisplay.moduleId !== KEEL_ASSET_DISPLAY_MODULE_ID
    || root.declaration.assetDisplay.version !== KEEL_ASSET_DISPLAY_MODULE_VERSION
    || root.parts.length !== 4
    || root.parts[0]?.kind !== "existing" || root.parts[0].role !== "shell-prefix"
    || root.parts[1]?.kind !== "existing" || root.parts[1].role !== "module"
    || root.parts[2]?.kind !== "creator" || root.parts[2].role !== "entrypoint"
    || root.parts[3]?.kind !== "existing" || root.parts[3].role !== "shell-suffix"
  ) {
    throw new TypeError("Normal media must be exactly shell-prefix, keel.asset-display, creator entrypoint, shell-suffix.");
  }
  const [shell, assetDisplay] = await Promise.all([
    buildKeelInlineShellFragments({ repositoryRoot: "" }),
    buildKeelInlineAssetDisplayModuleFragment(),
  ]);
  const expectedRootBytes = concat(root.parts.map((part) => part.bytes));
  const [expectedRootIntegrity, ...partIntegrities] = await Promise.all([
    createIntegrity(expectedRootBytes),
    ...root.parts.map((part) => createIntegrity(part.bytes)),
  ]);
  if (
    !exactBytes(root.rootBytes, expectedRootBytes)
    || root.rootIntegrity.digest.toLowerCase() !== expectedRootIntegrity.digest.toLowerCase()
    || root.rootIntegrity.byteLength !== expectedRootIntegrity.byteLength
    || root.parts.some((part, index) => part.byteLength !== part.bytes.byteLength
      || part.integrity.digest.toLowerCase() !== partIntegrities[index]!.digest.toLowerCase()
      || part.integrity.byteLength !== partIntegrities[index]!.byteLength)
    || !exactBytes(root.parts[0].bytes, shell.prefix.bytes)
    || !exactBytes(root.parts[3].bytes, shell.suffix.bytes)
    || root.declaration.assetDisplay.integrity.digest.toLowerCase() !== assetDisplay.integrity.digest.toLowerCase()
    || root.declaration.assetDisplay.integrity.byteLength !== assetDisplay.integrity.byteLength
  ) {
    throw new TypeError("Normal-media graph does not match the exact canonical KEEL shell and asset-display declarations.");
  }
  await assertCanonicalAssetDisplayModule({
    schema: "keel-inline-module-fragment@1",
    moduleId: root.declaration.assetDisplay.moduleId,
    version: root.declaration.assetDisplay.version,
    execution: root.parts[1].execution ?? "module",
    phase: root.parts[1].phase ?? "runtime",
    weight: root.parts[1].weight ?? 0,
    item: assetDisplay.item,
    bytes: root.parts[1].bytes,
    integrity: root.parts[1].integrity,
  });
  const item = JSON.parse(decoder.decode(root.parts[2].bytes).slice(1)) as KeelStandaloneViewerItem;
  if (
    item.id !== root.declaration.creatorAsset.id
    || item.role !== "entrypoint"
    || item.mediaType !== root.declaration.creatorAsset.mediaType
    || item.integrity.digest.toLowerCase() !== root.declaration.creatorAsset.integrity.digest.toLowerCase()
    || item.integrity.byteLength !== root.declaration.creatorAsset.integrity.byteLength
  ) {
    throw new TypeError("Normal media creator entrypoint does not match its immutable declaration.");
  }
  keelAssetDisplayKind(item.mediaType);
}

/**
 * Turn a normal-media document into a publishable graph only after all three
 * reusable catalogue fragments are supplied. The check compares the complete
 * decoded graph, so another object with the same label cannot substitute for
 * the registered shell or asset-display module.
 */
export async function buildKeelRegisteredInlineNormalMediaTokenURIGraph(input: {
  readonly document: KeelInlineNormalMediaDocument;
  readonly shellId?: typeof KEEL_INLINE_PROTECTION_SHELL_ID;
  readonly existingParts: readonly [KeelPublishedInlineFragment, KeelPublishedInlineFragment, KeelPublishedInlineFragment];
}): Promise<KeelInlinePreEncodedTokenURIGraph> {
  if ((input.shellId ?? KEEL_INLINE_PROTECTION_SHELL_ID) !== KEEL_INLINE_PROTECTION_SHELL_ID) {
    throw new TypeError("Normal media must use the canonical registered KEEL Inline protection shell.");
  }
  await assertCanonicalNormalMediaDocument(input.document);
  const expected = await buildKeelInlinePreEncodedTokenURIGraph(input.document);
  const graph = await buildKeelInlinePreEncodedTokenURIGraph(input.document, { existingParts: input.existingParts });
  const expectedExisting = expected.parts.filter((part) => part.sourceKind === "existing");
  const actualExisting = graph.parts.filter((part) => part.sourceKind === "existing");
  if (
    expectedExisting.length !== 3
    || actualExisting.length !== 3
    || expectedExisting.some((part, index) => !exactBytes(part.decodedHtmlBytes, actualExisting[index]!.decodedHtmlBytes))
  ) {
    throw new TypeError("Normal-media graph does not match the registered KEEL shell and asset-display module.");
  }
  return graph;
}


/**
 * Build the reusable pre-encoded tokenURI lane from an already verified Inline
 * graph. Every non-terminal HTML fragment is padded with legal inter-fragment
 * whitespace to a nine-byte boundary. That makes both Base64 layers line up:
 * concatenating these stored fragments is byte-identical to encoding the
 * completed HTML and then the completed JSON at read time.
 *
 * Existing shell/module source objects yield deterministic reusable fragment
 * bytes and are published once per chain. The creator entry remains the only
 * artwork-specific publication payload.
 */
export async function buildKeelInlinePreEncodedTokenURIGraph(
  root: KeelInlineGraphDocument,
  options: { readonly existingParts?: readonly KeelPublishedInlineFragment[] } = {},
): Promise<KeelInlinePreEncodedTokenURIGraph> {
  if (root.parts.length < 2 || root.parts.at(-1)?.role !== "shell-suffix") {
    throw new TypeError("An Inline pre-encoded tokenURI graph requires an ordered shell and terminal suffix.");
  }

  const fragments: KeelInlinePreEncodedTokenURIFragment[] = [];
  const htmlParts: Uint8Array[] = [];
  let existingIndex = 0;
  for (let index = 0; index < root.parts.length; index += 1) {
    const part = root.parts[index]!;
    const published = part.kind === "existing" ? options.existingParts?.[existingIndex++] : undefined;
    if (options.existingParts !== undefined && part.kind === "existing" && published === undefined) {
      throw new TypeError(`Inline ${part.role} has no canonical published fragment.`);
    }
    if (published !== undefined) {
      await assertPublishedFragmentIntegrity(published, `Inline ${part.role}`);
      const decodedHtmlBytes = decodePublishedGraphPart(published);
      fragments.push({
        bytes: published.bytes.slice(),
        integrity: published.integrity,
        role: part.role,
        sourceKind: part.kind,
        sourceObjectId: published.carrier.objectId,
        sourceIntegrity: await createIntegrity(decodedHtmlBytes),
        decodedHtmlBytes,
      });
      htmlParts.push(decodedHtmlBytes);
      continue;
    }
    const decodedHtmlBytes = appendSpacesToMultiple(part.bytes, 9);
    const inner = base64Bytes(decodedHtmlBytes);
    if (inner.byteLength % 3 !== 0) {
      throw new Error(`Inline ${part.role} fragment did not align at the outer Base64 boundary.`);
    }
    const bytes = base64Bytes(inner);
    const sourceIntegrity = await createIntegrity(part.bytes);
    fragments.push({
      bytes,
      integrity: await createIntegrity(bytes),
      role: part.role,
      sourceKind: part.kind,
      sourceIntegrity,
      decodedHtmlBytes,
    });
    htmlParts.push(decodedHtmlBytes);
  }

  if (options.existingParts !== undefined && existingIndex !== options.existingParts.length) {
    throw new TypeError("Inline graph contains unused canonical published fragments.");
  }

  const fragmentBytes = concat(fragments.map((fragment) => fragment.bytes));
  if (fragmentBytes.byteLength > KEEL_INLINE_MAX_TOKEN_URI_BYTES) {
    throw new RangeError(`The prepared Inline tokenURI stream is ${fragmentBytes.byteLength.toLocaleString()} bytes, above KEEL's ${KEEL_INLINE_MAX_TOKEN_URI_BYTES.toLocaleString()}-byte public-read limit.`);
  }
  if (/=/u.test(decoder.decode(fragmentBytes))) {
    throw new Error("Reusable Inline tokenURI fragments must be unpadded Base64 for exact concatenation.");
  }
  const decodedStatic = Buffer.from(decoder.decode(fragmentBytes), "base64").toString("utf8");
  const htmlBytes = exactBase64Bytes(decodedStatic, "Pre-encoded Inline HTML stream");
  const expectedHtml = concat(htmlParts);
  if (!exactBytes(htmlBytes, expectedHtml)) {
    throw new Error("Pre-encoded Inline tokenURI fragments do not reconstruct the exact aligned HTML.");
  }

  return {
    schema: "keel-inline-preencoded-token-uri@1",
    mediaType: "application/vnd.keel.token-uri-base64-fragment",
    contextParameter: "keel-context",
    contextDelivery: "base64-html-tail",
    fragmentBytes,
    fragmentIntegrity: await createIntegrity(fragmentBytes),
    htmlBytes,
    htmlIntegrity: await createIntegrity(htmlBytes),
    creatorPublicationBytes: fragments
      .filter((fragment) => fragment.sourceKind === "creator")
      .reduce((total, fragment) => total + fragment.bytes.byteLength, 0),
    parts: fragments,
  };
}

/**
 * Finish an immutable 1/1 ERC-721 tokenURI entirely at release-build time.
 * The collection address must already be deterministically predicted. The
 * contract stores these two small outer-Base64 slices and directly copies the
 * reusable middle graph between them.
 */
export async function buildKeelPreparedOneOfOneTokenURI(input: {
  readonly graph: Pick<KeelInlinePreEncodedTokenURIGraph, "fragmentBytes">;
  readonly chainId: number;
  readonly collection: Hex;
  readonly collectionName: string;
  readonly description: string;
  readonly imageURI: string;
  readonly manifestURI: string;
  readonly manifestDigest: Hex;
  /**
   * The creator's immutable artifact, independent of the selected shell.
   * KEEL-aware readers can call `haulObject(bytes32)` directly even when the
   * normal `animation_url` presents the work through a registered shell.
   */
  readonly artifact?: {
    readonly store: Hex;
    readonly objectId: Hex;
    readonly digest: Hex;
    readonly byteLength: number;
    readonly mediaType: string;
  };
  /** Optional ERC-4804 resolver URI. When supplied it is emitted exactly like
   * KEEL721's on-chain prepared envelope. */
  readonly erc4804MetadataURI?: string;
  readonly tokenId?: 1;
  readonly attributes?: readonly unknown[];
  /**
   * Optional chain-derived replay seed. When omitted the historical
   * collection/manifest fallback is retained for callers that do not have a
   * SeedRegistry binding. Immutable seeded releases should pass the value
   * returned by KeelSeedRegistry.deriveTokenSeed so the embedded context and
   * the contract's seed system are byte-for-byte aligned.
   */
  readonly derivedTokenSeed?: Hex;
}): Promise<KeelPreparedOneOfOneTokenURI> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new TypeError("A prepared tokenURI needs a positive safe chain ID.");
  }
  if (!/^0x[0-9a-f]{64}$/iu.test(input.manifestDigest)) {
    throw new TypeError("A prepared tokenURI needs a canonical manifest digest.");
  }
  const collection = getAddress(input.collection);
  const artifact = input.artifact === undefined ? undefined : (() => {
    const store = getAddress(input.artifact.store);
    if (!/^0x[0-9a-f]{64}$/iu.test(input.artifact.objectId)) {
      throw new TypeError("A prepared artifact needs a canonical object ID.");
    }
    if (!/^0x[0-9a-f]{64}$/iu.test(input.artifact.digest)) {
      throw new TypeError("A prepared artifact needs a canonical digest.");
    }
    if (!Number.isSafeInteger(input.artifact.byteLength) || input.artifact.byteLength <= 0) {
      throw new TypeError("A prepared artifact needs a positive safe byte length.");
    }
    const mediaType = input.artifact.mediaType.trim().toLowerCase();
    assertDataUriMediaType(mediaType);
    const objectId = input.artifact.objectId.toLowerCase() as Hex;
    const digest = input.artifact.digest.toLowerCase() as Hex;
    return Object.freeze({
      store: store.toLowerCase(),
      object_id: objectId,
      digest,
      byte_length: input.artifact.byteLength,
      media_type: mediaType,
      uri: keelWeb3ObjectURI({
        chainId: input.chainId,
        storeAddress: store,
        objectId,
        mediaType,
      }),
    });
  })();
  const tokenId = input.tokenId ?? 1;
  if (tokenId !== 1) throw new RangeError("The prepared immutable route currently supports token 1 of 1 only.");
  const derivedTokenSeed = input.derivedTokenSeed === undefined
    ? keccak256(encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      ["keel.inline-token-seed@1", BigInt(input.chainId), collection, 1n, input.manifestDigest],
    ))
    : input.derivedTokenSeed.toLowerCase() as Hex;
  if (!/^0x[0-9a-f]{64}$/iu.test(derivedTokenSeed)) {
    throw new TypeError("A prepared tokenURI derived token seed must be canonical bytes32.");
  }
  const contextJSON = JSON.stringify({
    protocol: "keel-context@1",
    chainId: String(input.chainId),
    collection: collection.toLowerCase(),
    tokenId: "1",
    derivedTokenSeed,
    manifestDigest: input.manifestDigest.toLowerCase(),
  });
  const contextBytes = encoder.encode(contextJSON);
  const contextDigest = (await createIntegrity(contextBytes)).digest as Hex;
  if (!input.imageURI.startsWith("data:")) {
    throw new TypeError("A prepared Inline token image must be a self-contained data URI; use Hybrid for web3, IPFS, or gateway image resolution.");
  }
  assertMarketplaceSafeDataURI(input.imageURI, "Prepared token image");
  const prefixHead = [
    `{"name":${JSON.stringify(`${input.collectionName} #1`)}`,
    `,"description":${JSON.stringify(input.description)}`,
    `,"image":${JSON.stringify(input.imageURI)}`,
  ].join("");
  const animationKey = ',"animation_url":"data:text/html;base64,';
  const prefixPadding = (3 - ((encoder.encode(prefixHead).byteLength + encoder.encode(animationKey).byteLength) % 3)) % 3;
  const prefixRaw = `${prefixHead}${" ".repeat(prefixPadding)}${animationKey}`;
  const suffixRaw = [
    Buffer.from(tokenContextHTMLTail(contextJSON, contextDigest, contextBytes.byteLength), "utf8").toString("base64"),
    '","keel_schema":"keel-manifest@2"',
    `,"keel_manifest":${JSON.stringify(input.manifestURI)}`,
    `,"keel_manifest_digest":${JSON.stringify(input.manifestDigest.toLowerCase())}`,
    ...(artifact === undefined ? [] : [`,"keel_artifact":${serializeInlineScriptJSON(artifact)}`]),
    ...(input.erc4804MetadataURI === undefined ? [] : [
      `,"keel_erc4804_metadata":${JSON.stringify(input.erc4804MetadataURI)}`,
    ]),
    ...(input.attributes === undefined ? [] : [`,"attributes":${serializeInlineScriptJSON(input.attributes)}`]),
    "}",
  ].join("");
  const prefix = createComposableBase64Fragment(prefixRaw, {
    mustAllowFollowingFragment: true,
    paddingStrategy: "json-whitespace",
  });
  if (prefix.paddingBytes !== 0) throw new Error("Prepared token JSON prefix failed its pre-animation alignment.");
  const middleBase64 = decoder.decode(input.graph.fragmentBytes);
  const middleRaw = new Uint8Array(Buffer.from(middleBase64, "base64"));
  const suffix = createComposableBase64Fragment(suffixRaw, { mustAllowFollowingFragment: false });
  const tokenURIBase64 = concatenateComposableBase64Fragments([
    prefix,
    { rawByteLength: middleRaw.byteLength, paddingBytes: 0, base64: middleBase64 },
    suffix,
  ]);
  const tokenJSON = Buffer.from(tokenURIBase64, "base64").toString("utf8");
  const expectedJSON = `${prefixRaw}${" ".repeat(prefix.paddingBytes)}${decoder.decode(middleRaw)}${suffixRaw}`;
  if (tokenJSON !== expectedJSON) throw new Error("Prepared tokenURI fragments changed the exact token JSON bytes.");
  const metadata = JSON.parse(tokenJSON) as { readonly animation_url?: unknown };
  if (typeof metadata.animation_url !== "string") throw new Error("Prepared token metadata has no animation_url.");
  assertMarketplaceSafeDataURI(metadata.animation_url, "Prepared token animation_url");
  return {
    schema: "keel-prepared-one-of-one-token-uri@1",
    encodedPrefix: encoder.encode(prefix.base64),
    encodedSuffix: encoder.encode(suffix.base64),
    tokenURI: `data:application/json;base64,${tokenURIBase64}`,
    tokenJSON,
    contextJSON,
    contextDigest,
    derivedTokenSeed,
  };
}
