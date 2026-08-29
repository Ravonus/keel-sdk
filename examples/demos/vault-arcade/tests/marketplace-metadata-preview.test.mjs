import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const file = new URL("../marketplace-metadata-preview.html", import.meta.url);

test("marketplace preview reads and renders canonical token metadata", async () => {
  const html = await readFile(file, "utf8");
  assert.match(html, /const TOKEN_URI = "c87b56dd"/u);
  assert.match(html, /const THUMBNAIL_URI = "08aa39b2"/u);
  assert.match(html, /decodeAbiString/u);
  assert.match(html, /decodeDataJSON/u);
  assert.match(html, /const TZKT_SHADOWNET = "https:\/\/api\.shadownet\.tzkt\.io"/u);
  assert.match(html, /tezosStorageRoute/u);
  assert.match(html, /tezosStorageBytes/u);
  assert.match(html, /const relative = \/\^tezos-storage:/u);
  assert.match(html, /loadTezosToken/u);
  assert.match(html, /hydrateTezosArtifact/u);
  assert.match(html, /metadata\.keelArtifactUri/u);
  assert.match(html, /Keel HTML artifact digest mismatch/u);
  assert.match(html, /data:application\/octet-stream;base64/u);
  assert.match(html, /Hybrid module .* returned HTTP/u);
  assert.match(html, /\$\("animation"\)\.srcdoc = animationHTML/u);
  assert.match(html, /on-chain marketplace SVG; Keel HTML hash verified/u);
  assert.match(html, /On-chain artifact resource is not HTML/u);
  assert.match(html, /local fallback — token metadata omits image/u);
  assert.match(html, /metadata\.animation_url\.startsWith\("data:text\/html"\)/u);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-downloads"/u);
  assert.match(html, /TOKEN PREVIEW FAILED/u);
  assert.match(html, /input\.get\("contract"\) && input\.get\("tokenId"\).*loadToken/u);
  assert.doesNotMatch(html, /innerHTML\s*=/u);
});
