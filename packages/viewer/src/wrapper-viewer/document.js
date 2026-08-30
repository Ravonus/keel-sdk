/**
 * Assemble the sealed wrapper document.
 *
 * This is the same page a holder gets, built from the same three parts the
 * on-chain composite is built from and in the same order: the stylesheet, the
 * markup, the artwork, the app. Nothing here is a stand-in for the real thing —
 * which is the only reason previewing one locally is worth anything.
 *
 * One rule is absolute and it was learned by breaking it on a live deployment:
 * the document is served inside a data URI and a raw delimiter/control byte can
 * change how a reader parses the URI. The encoder therefore treats the payload
 * as UTF-8 bytes, preserves URI-safe punctuation (including Base64's `+/=`),
 * and writes unsafe bytes as `%HH`. Nothing should embed this document without
 * the helper.
 */

/**
 * Wrap the document as the `data:` URI that carries it.
 *
 * URI-safe punctuation stays literal so compressed/Base64-shaped content is
 * not expanded again. Bytes that can change URL, JSON, or quoted-HTML parsing
 * are percent-escaped.
 */
const DATA_URI_LITERAL = (byte) =>
  (byte >= 0x41 && byte <= 0x5a)
  || (byte >= 0x61 && byte <= 0x7a)
  || (byte >= 0x30 && byte <= 0x39)
  || byte === 0x21 || byte === 0x24
  || (byte >= 0x28 && byte <= 0x2f)
  || byte === 0x3a || byte === 0x3b || byte === 0x3d || byte === 0x40
  || byte === 0x5f || byte === 0x7e;

const HTML_TEXT_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtmlText = (value) => String(value).replace(/[&<>"']/gu, (character) => HTML_TEXT_ESCAPES[character]);
const MEDIA_TYPE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

const assertDataUriMediaType = (mediaType) => {
  if (typeof mediaType !== "string" || mediaType.length === 0 || mediaType.length > 255) {
    throw new TypeError("A data URI media type must be a non-empty value of at most 255 characters.");
  }
  const parts = mediaType.split(";");
  const type = parts.shift() ?? "";
  const slash = type.indexOf("/");
  if (slash <= 0 || slash !== type.lastIndexOf("/") || !MEDIA_TYPE_TOKEN.test(type.slice(0, slash)) || !MEDIA_TYPE_TOKEN.test(type.slice(slash + 1))) {
    throw new TypeError(`Invalid data URI media type: ${mediaType}`);
  }
  for (const parameter of parts) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals === parameter.length - 1 || !MEDIA_TYPE_TOKEN.test(parameter.slice(0, equals)) || !MEDIA_TYPE_TOKEN.test(parameter.slice(equals + 1))) {
      throw new TypeError(`Invalid data URI media type parameter: ${mediaType}`);
    }
  }
  return mediaType;
};

export const encodeKeelPercentDataUri = (mediaType, value) => {
  assertDataUriMediaType(mediaType);
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("A data URI payload must be text or Uint8Array bytes.");
  let payload = "";
  for (const byte of bytes) {
    payload += DATA_URI_LITERAL(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `data:${mediaType},${payload}`;
};

export const keelWrapperViewerUri = (document_) =>
  encodeKeelPercentDataUri("text/html;charset=utf-8", document_);

/**
 * Base64 is the preferred carriage for large viewer documents. It keeps the
 * complete payload inside the RFC 4648 alphabet, so no parser can mistake
 * content bytes for URI or HTML syntax.
 */
export const encodeKeelBase64DataUri = (mediaType, value) => {
  assertDataUriMediaType(mediaType);
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("A data URI payload must be text or Uint8Array bytes.");
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
};

const escapeJson = (value) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Wrapper script data is not JSON serializable.");
  return serialized
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
};

/**
 * Bind the parts once, hand back the builder.
 *
 * The parts arrive from the build rather than being read at run time, so the
 * assembler works anywhere a string works — Node, a browser, a worker — and
 * cannot end up composing a document out of files that no longer match the
 * ones that were bundled.
 */
export function makeKeelWrapperViewerDocument({ css, markup, app }) {
  /**
   * @param artworkBase64 The artwork, already base64. It is carried between two
   *   tags rather than fetched, so this document holds the preserved bytes.
   * @param context What the chain says about this token. Read by the app as
   *   `__KEEL_ONCHAIN_CONTEXT__`; it can never change what a check decides,
   *   only what the panel has to describe.
  */
  return function keelWrapperViewerDocument({ artworkBase64, context = {}, title = "Keel verified" } = {}) {
    const json = JSON.stringify(context);
    if (artworkBase64 !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(artworkBase64)) {
      throw new TypeError("Wrapper artworkBase64 must be canonical RFC 4648 Base64.");
    }
    const document_ = [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
      `<title>${escapeHtmlText(title)}</title>`,
      `<style>${css}</style>`,
      // The marker is where the contract splices a live context in when this
      // document is assembled on chain. Left in place so the local build and
      // the sealed one are the same document with one substitution.
      "<!--@keel:context-->",
      `<script>globalThis.__KEEL_ONCHAIN_CONTEXT__=Object.freeze({json:${escapeJson(json)}});`,
      `globalThis.__KEEL_CONTEXT__=Object.freeze(JSON.parse(${escapeJson(json)}));</script>`,
      "</head><body>",
      markup,
      // The artwork itself, base64, carried by this document rather than
      // fetched. The composite that assembles this page puts the bytes between
      // these two tags, so rendering the page and holding the preserved bytes
      // are the same thing — there is nothing to go and get, and nothing to
      // trust. `text/plain` so a browser never executes what it holds.
      `<script type="text/plain" id="art">${artworkBase64 ?? ""}</script>`,
      `<script>${app}</script>`,
      "</body></html>",
    ].join("");

    return document_;
  };
}
