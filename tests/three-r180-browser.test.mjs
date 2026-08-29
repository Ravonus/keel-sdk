import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertKeelThreeR180OfficialBytes } from "../packages/sdk/dist/index.js";

async function headlessChrome() {
  if (process.env.KEEL_CHROME_HEADLESS_SHELL) return process.env.KEEL_CHROME_HEADLESS_SHELL;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const entries = await readdir(cache, { withFileTypes: true });
  const candidate = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"))
    .sort((left, right) => right.name.localeCompare(left.name))
    .map((entry) => join(cache, entry.name, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"))[0];
  if (candidate === undefined || !(await stat(candidate)).isFile()) {
    throw new Error("A Chrome headless shell is required for the KEEL browser fixture harness. Set KEEL_CHROME_HEADLESS_SHELL.");
  }
  return candidate;
}

async function fixtureServer() {
  const [html, scene, probe, demoMain, core] = await Promise.all([
    readFile("examples/fixtures/three-r180-rotating-cube/index.html"),
    readFile("examples/fixtures/three-r180-rotating-cube/scene.mjs"),
    readFile("examples/fixtures/three-r180-rotating-cube/fixture-probe.mjs"),
    readFile("examples/demos/vendor/three.min.js", "utf8"),
    readFile("examples/demos/vendor/three.core.min.js"),
  ]);
  const main = new TextEncoder().encode(demoMain.replaceAll('from"/content/three.core.min.js"', 'from"./three.core.min.js"'));
  await assertKeelThreeR180OfficialBytes({ main, core: new Uint8Array(core) });
  const files = new Map([
    ["/index.html", ["text/html; charset=utf-8", html]],
    ["/scene.mjs", ["text/javascript; charset=utf-8", scene]],
    ["/fixture-probe.mjs", ["text/javascript; charset=utf-8", probe]],
    ["/content/three.module.min.js", ["text/javascript; charset=utf-8", main]],
    ["/content/three.core.min.js", ["text/javascript; charset=utf-8", core]],
  ]);
  const paths = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.local").pathname;
    paths.push(pathname);
    const item = files.get(pathname);
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'");
    if (item === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", item[0]);
    response.end(item[1]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function dumpDom(binary, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--headless", "--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--virtual-time-budget=2000", "--dump-dom", url], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`Chrome fixture harness failed (${code}): ${stderr}`)));
  });
}

test("network-denied browser harness renders the exact Three r180 rotating cube through the shared aliases", { timeout: 30_000 }, async () => {
  const [chrome, fixture] = await Promise.all([headlessChrome(), fixtureServer()]);
  try {
    const browser = await dumpDom(chrome, `${fixture.origin}/index.html`);
    assert.match(browser.stdout, /id="keel-three-r180-proof"/u);
    assert.match(browser.stdout, /"revision":"180"/u);
    assert.match(browser.stdout, /"network":"denied"/u);
    assert.doesNotMatch(browser.stdout, /"errors":\[[^\]]+\]/u);
    assert.doesNotMatch(browser.stderr, /Uncaught|Refused to connect|net::ERR|Failed to load resource|Content Security Policy/iu);
    assert.deepEqual(fixture.paths.sort(), [
      "/content/three.core.min.js",
      "/content/three.module.min.js",
      "/fixture-probe.mjs",
      "/index.html",
      "/scene.mjs",
    ]);
  } finally {
    await fixture.close();
  }
});
