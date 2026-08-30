import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildKeelInlineAssetDisplayModuleFragment,
  buildKeelInlineLocalDocument,
  buildKeelInlineModuleFragment,
  buildKeelInlineShellFragments,
} from "../packages/sdk/dist/inline-viewer-graph.js";

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
    const child = spawn(binary, ["--headless", "--virtual-time-budget=4000", "--dump-dom", url], { stdio: ["ignore", "pipe", "pipe"] });
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

async function renderUnderMarketplaceCsp(rootBytes, protocol) {
  const animationBase64 = Buffer.from(rootBytes).toString("base64");
  const host = `<!doctype html><html><body><output id="result">waiting</output><iframe id="marketplace" sandbox="allow-scripts"></iframe><script>
    addEventListener("message",event=>{const result=document.querySelector("#result");if(event.data?.protocol===${JSON.stringify(protocol)}){result.textContent=event.data.state==="ran"?"module ran":JSON.stringify(event.data);result.dataset.state=event.data.state==="ran"?"passed":"failed"}else if((event.data?.protocol==="keel-inline-runtime@1"||event.data?.protocol==="keel-inline-child@1")&&event.data?.action==="failed"){result.textContent=event.data.detail;result.dataset.state="failed"}});
    document.querySelector("#marketplace").srcdoc=atob(${JSON.stringify(animationBase64)});
  </script></body></html>`;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self' data:; style-src 'unsafe-inline'; img-src data:; connect-src 'none'",
    );
    response.end(host);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const chrome = await headlessChrome();
    return await dumpDOM(chrome, `http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("the canonical Inline shell runs verified data modules under a restrictive marketplace srcdoc CSP", { timeout: 30_000 }, async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot: process.cwd() });
  const module = await buildKeelInlineModuleFragment({
    moduleId: "keel.csp-proof",
    version: "1.0.0",
    mediaType: "text/javascript",
    aliases: ["keel-csp-proof.js"],
    decodedBytes: new TextEncoder().encode('top.postMessage({protocol:"keel-csp-proof",state:"ran"},"*")'),
    compression: "gzip",
    execution: "classic",
  });
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [module],
    entry: {
      id: "index.html",
      mediaType: "text/html",
      source: new TextEncoder().encode('<!doctype html><html><head><script src="keel-csp-proof.js"></script></head><body>art</body></html>'),
    },
  });
  const rendered = await renderUnderMarketplaceCsp(local.rootBytes, "keel-csp-proof");
  assert.doesNotMatch(rendered.stderr, /Refused to load the script|violates the following Content Security Policy directive/iu);
  assert.match(rendered.stdout, /id="result" data-state="passed">module ran/u);
});

test("the canonical asset module starts only after its verified child mount exists", { timeout: 30_000 }, async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot: process.cwd() });
  const assetDisplay = await buildKeelInlineAssetDisplayModuleFragment();
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [assetDisplay],
    entry: {
      id: "pixel.png",
      mediaType: "image/png",
      source: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    },
  });
  const rendered = await renderUnderMarketplaceCsp(local.rootBytes, "keel-asset-csp-proof");
  assert.doesNotMatch(rendered.stderr, /Cannot read properties of null|Uncaught/iu);
});

test("the exact p5 and seeded-random modules run under the marketplace CSP", { timeout: 30_000 }, async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot: process.cwd() });
  const [p5Bytes, seededBytes] = await Promise.all([
    readFile("examples/demos/vendor/p5.min.js"),
    readFile("examples/library/seeded-random.js"),
  ]);
  const p5 = await buildKeelInlineModuleFragment({
    moduleId: "p5.js",
    version: "1.11.3",
    mediaType: "text/javascript",
    aliases: ["p5.min.js", "./p5.min.js", "p5.js"],
    decodedBytes: p5Bytes,
    compression: "gzip",
    execution: "classic",
  });
  const seeded = await buildKeelInlineModuleFragment({
    moduleId: "keel.seeded-random",
    version: "1.0.0",
    mediaType: "text/javascript",
    aliases: ["seeded-random.js", "./seeded-random.js", "/content/seeded-random.js", "keel.seeded-random"],
    decodedBytes: seededBytes,
    compression: "gzip",
    execution: "module",
  });
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [p5, seeded],
    entry: {
      id: "sketch.js",
      mediaType: "text/javascript",
      source: new TextEncoder().encode(`import { createSeededRandom } from "/content/seeded-random.js";
        const random=createSeededRandom("0x1234");
        top.postMessage({protocol:"keel-p5-csp-proof",state:typeof p5==="function"&&random()>=0?"ran":"failed"},"*");`),
    },
  });
  const rendered = await renderUnderMarketplaceCsp(local.rootBytes, "keel-p5-csp-proof");
  assert.doesNotMatch(rendered.stderr, /Refused to load the script|violates the following Content Security Policy directive|Uncaught/iu);
  assert.match(rendered.stdout, /id="result" data-state="passed">module ran/u);
});

test("the exact Three.js r180 module pair runs under the marketplace CSP", { timeout: 30_000 }, async () => {
  const shell = await buildKeelInlineShellFragments({ repositoryRoot: process.cwd() });
  const [mainBytes, coreBytes] = await Promise.all([
    readFile("examples/demos/vendor/three.min.js"),
    readFile("examples/demos/vendor/three.core.min.js"),
  ]);
  const core = await buildKeelInlineModuleFragment({
    moduleId: "three.r180.core",
    version: "0.180.0",
    mediaType: "text/javascript",
    aliases: ["three.core.min.js", "./three.core.min.js", "/content/three.core.min.js"],
    decodedBytes: coreBytes,
    compression: "gzip",
    execution: "module",
  });
  const main = await buildKeelInlineModuleFragment({
    moduleId: "three.r180.main",
    version: "0.180.0",
    mediaType: "text/javascript",
    aliases: ["three.module.min.js", "./three.module.min.js", "/content/three.module.min.js"],
    decodedBytes: mainBytes,
    compression: "gzip",
    execution: "module",
  });
  const local = await buildKeelInlineLocalDocument({
    shell,
    modules: [core, main],
    entry: {
      id: "scene.mjs",
      mediaType: "text/javascript",
      source: new TextEncoder().encode(`import * as THREE from "/content/three.module.min.js";
        const vector=new THREE.Vector3(1,2,3);top.postMessage({protocol:"keel-three-csp-proof",state:vector.length()>0?"ran":"failed"},"*");`),
    },
  });
  const rendered = await renderUnderMarketplaceCsp(local.rootBytes, "keel-three-csp-proof");
  assert.doesNotMatch(rendered.stderr, /Refused to load the script|violates the following Content Security Policy directive|Uncaught/iu);
  assert.match(rendered.stdout, /id="result" data-state="passed">module ran/u);
});
