import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CLI = path.join(ROOT, "tools", "keel", "cli.mjs");
const token = `keel_agent_${"s".repeat(48)}`;

function runCli(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("studio-stage CLI accepts JSON and YAML image projects and returns only server handoffs", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = Buffer.alloc(0);
    request.on("data", (chunk) => { body = Buffer.concat([body, chunk]); });
    request.on("end", () => {
      requests.push({ authorization: request.headers.authorization, body: body.toString("utf8") });
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schema: "keel-studio-project-handoff@1",
        id: `stage-${requests.length}`,
        handoffUrl: `https://studio.example/studio/projects/new?handoff=server-${requests.length}`,
        expiresAt: "2030-01-01T00:00:00.000Z",
        fileCount: 1,
        totalBytes: 8,
        wallet: { signing: "not-performed", submission: "not-performed" },
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const studioUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-studio-stage-cli-"));
  try {
    await writeFile(path.join(directory, "signal.webp"), Uint8Array.of(82, 73, 70, 70, 1, 2, 3, 4));
    const jsonPath = path.join(directory, "stage.json");
    await writeFile(jsonPath, JSON.stringify({ studioUrl, title: "Signal Bloom", storageStrategy: "onchain", files: [{ path: "signal.webp", mediaType: "image/webp", role: "image", format: "asset" }] }));
    const json = await runCli(["studio-stage", "--config", jsonPath], { KEEL_STUDIO_AGENT_TOKEN: token });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).wallet.signing, "not-performed");

    const yamlPath = path.join(directory, "stage.yaml");
    await writeFile(yamlPath, `studioUrl: ${studioUrl}\ntitle: Signal Bloom YAML\nstorageStrategy: onchain\nfiles:\n  - path: signal.webp\n    mediaType: image/webp\n    role: image\n    format: asset\n`);
    const yaml = await runCli(["studio-stage", "--config", yamlPath], { KEEL_STUDIO_AGENT_TOKEN: token });
    assert.equal(yaml.status, 0, yaml.stderr);
    assert.equal(JSON.parse(yaml.stdout).fileCount, 1);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.authorization === `Bearer ${token}`));
    assert.ok(requests.every((request) => request.body.includes('"role":"image"')));
    assert.ok(requests.every((request) => !request.body.includes("viewer.js") && !request.body.includes("index.html")));

    const missing = await runCli(["studio-stage", "--config", jsonPath], { KEEL_STUDIO_AGENT_TOKEN: "" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /KEEL_STUDIO_AGENT_TOKEN/u);
    assert.equal(requests.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
});
