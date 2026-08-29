import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildKeelInlineLocalDocument,
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
    try { parent.document.querySelector('#keel-verify-stamp').textContent = 'PWNED' } catch {}
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
    assert.match(valid.stdout, /id="keel-verify-stamp"[^>]*data-state="verified"/u);
    assert.match(valid.stdout, />K<\/button>/u);
    assert.match(valid.stdout, /id="keel-verify-title">KEEL verified/u);
    assert.match(valid.stdout, /sandbox="allow-scripts allow-pointer-lock"/u);
    assert.doesNotMatch(valid.stdout, /allow-same-origin|>PWNED<|https?:\/\//u);
    assert.doesNotMatch(valid.stderr, /Uncaught|net::ERR|Failed to load resource/iu);

    const invalid = await dumpDOM(chrome, `${fixture.origin}/invalid`);
    assert.match(invalid.stdout, /id="keel-verify-stamp"[^>]*data-state="failed"/u);
    assert.match(invalid.stdout, /id="keel-verify-title">Verification failed/u);
    assert.doesNotMatch(invalid.stdout, /<iframe/u);
  } finally {
    await fixture.close();
  }
});
