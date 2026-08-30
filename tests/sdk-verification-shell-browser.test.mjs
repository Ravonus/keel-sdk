import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildKeelInlinePreEncodedTokenURIGraph,
  buildKeelInlineLocalDocument,
  buildKeelPreparedOneOfOneTokenURI,
  buildKeelInlineShellFragments,
} from "../packages/sdk/dist/index.js";

async function headlessChrome() {
  if (process.env.KEEL_CHROME_HEADLESS_SHELL) return process.env.KEEL_CHROME_HEADLESS_SHELL;
  const entries = await readdir(join(homedir(), "Library/Caches/ms-playwright"), { withFileTypes: true });
  const candidate = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"))
    .sort((left, right) => right.name.localeCompare(left.name))
    .map((entry) => join(homedir(), "Library/Caches/ms-playwright", entry.name, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"))[0];
  if (candidate === undefined || !(await stat(candidate)).isFile()) throw new Error("Chrome headless shell missing");
  return candidate;
}

function dumpDOM(binary, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--headless", "--virtual-time-budget=2500", "--dump-dom", url], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Chrome failed (${code}): ${stderr}`)));
  });
}

async function fixtureServer() {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot: process.cwd() });
  const entry = new TextEncoder().encode(`<!doctype html><html><head></head><body><div id="art">art</div><script>
    try { parent.document.querySelector('#verify-seal').textContent = 'PWNED' } catch {}
  </script></body></html>`);
  const valid = await buildKeelInlineLocalDocument({
    shell,
    modules: [],
    entry: { id: "art.html", mediaType: "text/html", source: entry },
  });
  const validHTML = new TextDecoder().decode(valid.rootBytes);
  const invalidHTML = validHTML.replace(/"digest":"0x[0-9a-f]{64}"/u, `"digest":"0x${"00".repeat(32)}"`);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/invalid" ? invalidHTML : valid.rootBytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("the protected K shell mounts only verified art inside an opaque network-denied frame", { timeout: 30_000 }, async () => {
  const [chrome, fixture] = await Promise.all([headlessChrome(), fixtureServer()]);
  try {
    const valid = await dumpDOM(chrome, fixture.origin);
    assert.match(valid.stdout, /data-vault-verification="verified"/u);
    assert.match(valid.stdout, /id="verify-seal"/u);
    assert.match(valid.stdout, /id="verify-title">KEEL verified/u);
    assert.match(valid.stdout, /class="verify-page-nav"/u);
    assert.match(valid.stdout, /sandbox="allow-scripts allow-pointer-lock"/u);
    assert.doesNotMatch(valid.stdout, /allow-same-origin|>PWNED<|https?:\/\//u);
    assert.doesNotMatch(valid.stderr, /Uncaught|net::ERR|Failed to load resource/iu);

    const invalid = await dumpDOM(chrome, `${fixture.origin}/invalid`);
    assert.match(invalid.stdout, /data-vault-verification="failed"/u);
    assert.match(invalid.stdout, /id="verify-seal"/u);
    assert.match(invalid.stdout, /id="verify-title">Verification failed/u);
    assert.doesNotMatch(invalid.stdout, /<iframe/u);
  } finally {
    await fixture.close();
  }
});

test("the marketplace-safe prepared animation URI installs token context before the K shell launches", { timeout: 30_000 }, async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot: process.cwd() });
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [],
    entry: {
      id: "context.html",
      mediaType: "text/html",
      source: new TextEncoder().encode('<!doctype html><html><body><div id="art">context ready</div></body></html>'),
    },
  });
  const graph = await buildKeelInlinePreEncodedTokenURIGraph(local);
  const prepared = await buildKeelPreparedOneOfOneTokenURI({
    graph,
    chainId: 11_155_111,
    collection: `0x${"ab".repeat(20)}`,
    collectionName: "Context proof",
    description: "Pure Base64 browser proof",
    imageURI: "data:image/svg+xml;base64,PHN2Zy8+",
    manifestURI: `web3://0x${"cd".repeat(20)}:11155111/object/0x${"ef".repeat(32)}`,
    manifestDigest: `0x${"12".repeat(32)}`,
  });
  const metadata = JSON.parse(Buffer.from(prepared.tokenURI.split(",", 2)[1], "base64").toString("utf8"));
  const animationPayload = metadata.animation_url.split(",", 2)[1];
  assert.match(animationPayload, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
  assert.doesNotMatch(animationPayload, /[#?&_-]/u);

  const [chrome, fixture] = await Promise.all([headlessChrome(), new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(Buffer.from(animationPayload, "base64"));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
    }));
  })]);
  try {
    const rendered = await dumpDOM(chrome, fixture.origin);
    assert.match(rendered.stdout, /data-vault-verification="verified"/u);
    assert.match(rendered.stdout, /id="verify-seal"/u);
    assert.match(rendered.stdout, /id="verify-title">KEEL verified/u);
    assert.match(rendered.stdout, /0xabababababababababababababababababababab/u);
    assert.doesNotMatch(rendered.stderr, /Uncaught|net::ERR|Failed to load resource/iu);
  } finally {
    await fixture.close();
  }
});
