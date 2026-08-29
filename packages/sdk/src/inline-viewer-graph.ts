/**
 * Node-only planner for a modular Inline KEEL viewer.
 *
 * Shared shell/module fragments are published once per chain. A creator root
 * references those immutable objects and publishes only its small entry slot.
 * This file prepares and verifies bytes; it never signs or submits.
 */
import { createIntegrity, type Hex, type Integrity } from "@keel/protocol";
import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";
import { encodeAbiParameters, getAddress, keccak256 } from "viem";

import { KEEL_INLINE_MAX_TOKEN_URI_BYTES } from "./presentation.js";
import {
  buildCompactInlineKeelShell,
  buildEmbeddedKeelViewerSlot,
  type KeelStandaloneViewerItem,
} from "./verification-shell.js";
import { orderKeelModules, type KeelModulePhase } from "./data-layer.js";

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
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Inline script data is not JSON serializable.");
  return serialized
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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

export interface KeelInlineLocalDocument {
  readonly schema: "keel-inline-local-document@1";
  readonly rootBytes: Uint8Array;
  readonly rootIntegrity: Integrity;
  readonly byteLength: number;
  readonly parts: readonly ({
    readonly kind: "existing";
    readonly role: "shell-prefix" | "module" | "shell-suffix";
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
    readonly role: "entrypoint";
    readonly bytes: Uint8Array;
    readonly byteLength: number;
    readonly integrity: Integrity;
  })[];
}

export interface KeelInlinePreEncodedTokenURIFragment extends KeelInlineFragmentBytes {
  readonly role: "shell-prefix" | "module" | "entrypoint" | "shell-suffix";
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
  readonly fragmentBytes: Uint8Array;
  readonly fragmentIntegrity: Integrity;
  readonly htmlBytes: Uint8Array;
  readonly htmlIntegrity: Integrity;
  readonly creatorPublicationBytes: number;
  readonly parts: readonly KeelInlinePreEncodedTokenURIFragment[];
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

function base64Bytes(bytes: Uint8Array): Uint8Array {
  return encoder.encode(Buffer.from(bytes).toString("base64"));
}

function exactBase64Bytes(value: string, label: string): Uint8Array {
  if (!RFC_4648_BASE64.test(value)) throw new TypeError(`${label} is not canonical RFC 4648 Base64.`);
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) throw new TypeError(`${label} is not canonical RFC 4648 Base64.`);
  return bytes;
}

function decodePublishedGraphPart(fragment: KeelPublishedInlineFragment): {
  readonly decodedHtmlBytes: Uint8Array;
  readonly terminalContext: boolean;
} {
  const outerBase64 = decoder.decode(fragment.bytes);
  const outerBytes = exactBase64Bytes(outerBase64, "Published Inline fragment");
  const innerWithContext = decoder.decode(outerBytes);
  const marker = innerWithContext.indexOf("#");
  const terminalContext = marker >= 0;
  const innerBase64 = terminalContext ? innerWithContext.slice(0, marker) : innerWithContext;
  if (terminalContext && !/^#(?:_x{1,2}=&)?keel-context=$/u.test(innerWithContext.slice(marker))) {
    throw new TypeError("Published Inline terminal fragment has an invalid token-context lane.");
  }
  return {
    decodedHtmlBytes: exactBase64Bytes(innerBase64, "Published Inline decoded HTML fragment"),
    terminalContext,
  };
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
  const { decodedHtmlBytes, terminalContext } = decodePublishedGraphPart(input.fragment);
  if (terminalContext) throw new TypeError(`Inline module ${input.moduleId} cannot contain a terminal token-context lane.`);
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

const HASH_CONTEXT_BOOTSTRAP = '<script>(()=>{try{const p=new URLSearchParams(location.hash.slice(1)),v=p.get("keel-context");if(!v)return;const b=v.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-v.length%4)%4),j=atob(b),c=Object.freeze(JSON.parse(j));globalThis.__OCA_CONTEXT__=c;globalThis.__KEEL_CONTEXT__=c;globalThis.__KEEL_ONCHAIN_CONTEXT__=Object.freeze({json:j,digest:p.get("keel-context-digest")||"",byteLength:new TextEncoder().encode(j).length})}catch(e){document.documentElement.dataset.keelContext="failed";throw e}})()</script>';

function withHashContextBootstrap(bytes: Uint8Array): Uint8Array {
  const html = decoder.decode(bytes);
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head?.index === undefined) throw new TypeError("Inline shell prefix has no HTML head for the token context bootstrap.");
  const insertAt = head.index + head[0].length;
  return encoder.encode(`${html.slice(0, insertAt)}${HASH_CONTEXT_BOOTSTRAP}${html.slice(insertAt)}`);
}

function terminalContextPrefix(innerSuffixBase64Length: number): string {
  for (let padding = 0; padding < 3; padding += 1) {
    const candidate = padding === 0
      ? "#keel-context="
      : `#_${"x".repeat(padding)}=&keel-context=`;
    if ((innerSuffixBase64Length + candidate.length) % 3 === 0) return candidate;
  }
  throw new Error("Unable to align the Inline token context fragment.");
}

async function exactFragment(bytes: Uint8Array): Promise<KeelInlineFragmentBytes> {
  if (bytes.byteLength === 0) throw new TypeError("An Inline fragment cannot be empty.");
  return { bytes, integrity: await createIntegrity(bytes) };
}

/** Build the small reusable shell halves without embedding Brotli WASM. */
export async function buildKeelInlineShellFragments(input: {
  readonly repositoryRoot: string;
}): Promise<KeelInlineShellFragments> {
  void input.repositoryRoot;
  const shell = await buildCompactInlineKeelShell();
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
    readonly mediaType: "text/html" | "text/javascript";
    readonly source: Uint8Array;
    readonly aliases?: readonly string[];
  };
}): Promise<KeelInlineLocalDocument> {
  const orderedModules = orderKeelModules(input.modules);
  for (const module of orderedModules) {
    if (module.item.embedded?.compression === "brotli") {
      throw new TypeError(`Inline module ${module.moduleId} requires a declared Brotli decoder shell profile.`);
    }
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(input.entry.source);
  if (input.entry.mediaType === "text/javascript" && /<\/script/iu.test(source)) {
    throw new TypeError("An Inline JavaScript entry cannot contain a closing script tag.");
  }
  const dataScripts = orderedModules
    .filter((module) => module.phase === "data")
    .map((module) => `<script src="${module.item.aliases[0] ?? module.moduleId}"></script>`);
  const htmlEntry = dataScripts.length === 0 ? input.entry.source : new TextEncoder().encode(
    /<head(?:\s[^>]*)?>/iu.test(source)
      ? source.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${dataScripts.join("")}`)
      : `<!doctype html><html><head>${dataScripts.join("")}</head><body>${source}</body></html>`,
  );
  const entrySource = input.entry.mediaType === "text/javascript"
    ? new TextEncoder().encode([
        '<div id="stage"></div>',
        ...orderedModules
          .filter((module) => module.execution === "classic")
          .map((module) => {
            const alias = module.item.aliases[0] ?? module.moduleId;
            return `<script src="${alias}"></script>`;
          }),
        `<script type="module">${source}</script>`,
      ].join(""))
    : htmlEntry;
  const entry = await buildEmbeddedKeelViewerSlot({
    id: input.entry.id,
    role: "entrypoint",
    mediaType: "text/html",
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
  root: KeelInlineLocalDocument,
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
    const terminal = index === root.parts.length - 1;
    const published = part.kind === "existing" ? options.existingParts?.[existingIndex++] : undefined;
    if (options.existingParts !== undefined && part.kind === "existing" && published === undefined) {
      throw new TypeError(`Inline ${part.role} has no canonical published fragment.`);
    }
    if (published !== undefined) {
      await assertPublishedFragmentIntegrity(published, `Inline ${part.role}`);
      const decoded = decodePublishedGraphPart(published);
      if (decoded.terminalContext !== terminal) {
        throw new TypeError(`Inline ${part.role} has the wrong terminal token-context shape.`);
      }
      fragments.push({
        bytes: published.bytes.slice(),
        integrity: published.integrity,
        role: part.role,
        sourceKind: part.kind,
        sourceObjectId: published.carrier.objectId,
        sourceIntegrity: await createIntegrity(decoded.decodedHtmlBytes),
        decodedHtmlBytes: decoded.decodedHtmlBytes,
      });
      htmlParts.push(decoded.decodedHtmlBytes);
      continue;
    }
    const bootstrapped = index === 0 ? withHashContextBootstrap(part.bytes) : part.bytes.slice();
    const decodedHtmlBytes = terminal ? bootstrapped : appendSpacesToMultiple(bootstrapped, 9);
    const inner = base64Bytes(decodedHtmlBytes);
    const outerInput = terminal
      ? concat([inner, encoder.encode(terminalContextPrefix(inner.byteLength))])
      : inner;
    if (outerInput.byteLength % 3 !== 0) {
      throw new Error(`Inline ${part.role} fragment did not align at the outer Base64 boundary.`);
    }
    const bytes = base64Bytes(outerInput);
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
  const marker = decodedStatic.lastIndexOf("#");
  if (marker < 0 || !decodedStatic.slice(marker).includes("keel-context=")) {
    throw new Error("Pre-encoded Inline tokenURI fragment has no terminal context lane.");
  }
  const htmlBytes = new Uint8Array(Buffer.from(decodedStatic.slice(0, marker), "base64"));
  const expectedHtml = concat(htmlParts);
  if (!exactBytes(htmlBytes, expectedHtml)) {
    throw new Error("Pre-encoded Inline tokenURI fragments do not reconstruct the exact aligned HTML.");
  }

  return {
    schema: "keel-inline-preencoded-token-uri@1",
    mediaType: "application/vnd.keel.token-uri-base64-fragment",
    contextParameter: "keel-context",
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
  readonly tokenId?: 1;
  readonly attributes?: readonly unknown[];
}): Promise<KeelPreparedOneOfOneTokenURI> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new TypeError("A prepared tokenURI needs a positive safe chain ID.");
  }
  if (!/^0x[0-9a-f]{64}$/iu.test(input.manifestDigest)) {
    throw new TypeError("A prepared tokenURI needs a canonical manifest digest.");
  }
  const collection = getAddress(input.collection);
  const tokenId = input.tokenId ?? 1;
  if (tokenId !== 1) throw new RangeError("The prepared immutable route currently supports token 1 of 1 only.");
  const derivedTokenSeed = keccak256(encodeAbiParameters(
    [
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    ["keel.inline-token-seed@1", BigInt(input.chainId), collection, 1n, input.manifestDigest],
  ));
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
  const contextBase64URL = Buffer.from(contextBytes).toString("base64url");
  const prefixRaw = [
    `{"name":${JSON.stringify(`${input.collectionName} #1`)}`,
    `,"description":${JSON.stringify(input.description)}`,
    `,"image":${JSON.stringify(input.imageURI)}`,
    ',"animation_url":"data:text/html;base64,',
  ].join("");
  const suffixRaw = [
    contextBase64URL,
    `&keel-context-digest=${contextDigest}`,
    `&keel-context-length=${contextBytes.byteLength}`,
    '","keel_schema":"keel-manifest@2"',
    `,"keel_manifest":${JSON.stringify(input.manifestURI)}`,
    `,"keel_manifest_digest":${JSON.stringify(input.manifestDigest.toLowerCase())}`,
    ...(input.attributes === undefined ? [] : [`,"attributes":${serializeInlineScriptJSON(input.attributes)}`]),
    "}",
  ].join("");
  const prefix = createComposableBase64Fragment(prefixRaw, {
    mustAllowFollowingFragment: true,
    paddingStrategy: "json-whitespace",
  });
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
  JSON.parse(tokenJSON);
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
