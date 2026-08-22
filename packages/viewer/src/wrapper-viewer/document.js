/**
 * Assemble the sealed wrapper document.
 *
 * This is the same page a holder gets, built from the same three parts the
 * on-chain composite is built from and in the same order: the stylesheet, the
 * markup, the artwork, the app. Nothing here is a stand-in for the real thing —
 * which is the only reason previewing one locally is worth anything.
 *
 * One rule is absolute and it was learned by breaking it on a live deployment:
 * the document is served inside a data URI, a data URI ends at its first `#`,
 * and the truncation is silent — the JSON still parses and the picture is
 * simply gone. The fix is not to ban `#`, which would cost every hex colour in
 * the stylesheet; it is to escape it on the way in. `keelWrapperViewerUri`
 * does that, and nothing should ever embed this document without it.
 */

/**
 * Wrap the document as the `data:` URI that carries it.
 *
 * Exactly three characters are escaped, which is exactly what the contract
 * escapes when it builds the same URI on chain: `%` first so the escapes
 * themselves are not re-escaped, then `"` because the URI sits inside a JSON
 * string, then `#` because a URI ends there. `<` and `>` are legal in the
 * payload and escaping them would cost real gas on every read for nothing.
 */
export const keelWrapperViewerUri = (document_) =>
  `data:text/html;charset=utf-8,${document_.replace(/%/g, "%25").replace(/"/g, "%22").replace(/#/g, "%23")}`;

const escapeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

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
    const document_ = [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
      `<title>${title}</title>`,
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
