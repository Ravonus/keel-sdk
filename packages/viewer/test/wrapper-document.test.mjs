import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeKeelBase64DataUri,
  encodeKeelPercentDataUri,
  makeKeelWrapperViewerDocument,
} from "../src/wrapper-viewer/document.js";

test("data URI encoders round-trip every document byte without repacking safe payload text", () => {
  const source = "<!doctype html>\n<script>const x = \"# % \\ & < >\";</script>\u2028";
  const percent = encodeKeelPercentDataUri("text/html;charset=utf-8", source);
  assert.equal(percent.startsWith("data:text/html;charset=utf-8,"), true);
  assert.equal(decodeURIComponent(percent.slice(percent.indexOf(",") + 1)), source);
  assert.equal(percent.includes(" # "), false);

  const packed = "H4sIAAAAAAAA/8tIzcnJBwCGphA2BQAAAA==";
  assert.equal(encodeKeelPercentDataUri("application/octet-stream", packed), `data:application/octet-stream,${packed}`);

  const base64 = encodeKeelBase64DataUri("text/html", source);
  assert.equal(Buffer.from(base64.slice(base64.indexOf(",") + 1), "base64").toString("utf8"), source);
});

test("wrapper title is HTML text escaped before it enters the document", () => {
  const render = makeKeelWrapperViewerDocument({ css: "", markup: "", app: "" });
  const document_ = render({ title: "<unsafe> & \"title\"", context: { html: "</script>& >" }, artworkBase64: "YQ==" });
  assert.match(document_, /<title>&lt;unsafe&gt; &amp; &quot;title&quot;<\/title>/u);
  assert.equal(document_.includes("<title><unsafe>"), false);
  assert.match(document_, /\\u003c\/script\\u003e\\u0026 \\u003e/u);
  assert.throws(() => render({ artworkBase64: "not base64" }), /canonical/u);
  assert.throws(() => encodeKeelPercentDataUri("text/html\n", "x"), /media type/u);
});
