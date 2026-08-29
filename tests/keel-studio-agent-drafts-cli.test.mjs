import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CLI = path.join(ROOT, "tools", "keel", "cli.mjs");

const draft = {
  artifactId: null,
  title: "CLI draft",
  description: "A draft managed through the SDK CLI.",
  story: "",
  releaseType: "one-of-one",
  accessMode: "public",
  supply: "1",
  priceEth: "0.1",
  maxPerTransaction: 1,
  maxPerWallet: 1,
  startsAt: null,
  endsAt: null,
  networkLabel: "Sepolia",
  payoutAddress: null,
  page: {},
};

function runCli(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("studio draft CLI reads JSON and YAML configs without wallet or chain actions", async () => {
  const token = `keel_agent_${"d".repeat(48)}`;
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === "/api/agent/drafts/echo-token") {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: `invalid token ${token}` }));
      return;
    }
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...draft, id: "release-1", revision: 1, status: "draft", slug: "release-1" }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(payload.expectedRevision, 1);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...payload.draft, id: "release-1", revision: 2, status: "draft", slug: "release-1" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const studioUrl = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-studio-drafts-cli-"));
  try {
    const jsonPath = path.join(directory, "read.json");
    await writeFile(jsonPath, JSON.stringify({ studioUrl, operation: "read", releaseId: "release-1" }));
    const read = await runCli(["studio-drafts", "--config", jsonPath], { KEEL_STUDIO_AGENT_TOKEN: token });
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).id, "release-1");

    const yamlPath = path.join(directory, "edit.yaml");
    await writeFile(yamlPath, `studioUrl: ${studioUrl}\noperation: update\nreleaseId: release-1\nexpectedRevision: 1\ndraft:\n  artifactId: null\n  title: CLI YAML edit\n  description: A draft managed through the SDK CLI.\n  story: ''\n  releaseType: one-of-one\n  accessMode: public\n  supply: '1'\n  priceEth: '0.1'\n  maxPerTransaction: 1\n  maxPerWallet: 1\n  startsAt: null\n  endsAt: null\n  networkLabel: Sepolia\n  payoutAddress: null\n  page: {}\n`);
    const edit = await runCli(["studio-drafts", "--config", yamlPath], { KEEL_STUDIO_AGENT_TOKEN: token });
    assert.equal(edit.status, 0, edit.stderr);
    assert.equal(JSON.parse(edit.stdout).title, "CLI YAML edit");
    assert.deepEqual(calls.map(({ method, url }) => ({ method, url })), [
      { method: "GET", url: "/api/agent/drafts/release-1" },
      { method: "PATCH", url: "/api/agent/drafts/release-1" },
    ]);

    const hostilePath = path.join(directory, "hostile.json");
    await writeFile(hostilePath, JSON.stringify({ studioUrl, operation: "read", releaseId: "echo-token" }));
    const hostile = await runCli(["studio-drafts", "--config", hostilePath], { KEEL_STUDIO_AGENT_TOKEN: token });
    assert.equal(hostile.status, 1);
    assert.match(hostile.stderr, /invalid token \[redacted\]/u);
    assert.doesNotMatch(hostile.stderr, new RegExp(token, "u"));

    const unsupportedPath = path.join(directory, "unsupported.yaml");
    await writeFile(unsupportedPath, `studioUrl: ${studioUrl}\noperation: list\nchainId: 11155111\n`);
    const unsupported = await runCli(["studio-drafts", "--config", unsupportedPath]);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /configuration\.chainId is not supported/u);

    const duplicatePath = path.join(directory, "duplicate.yaml");
    await writeFile(duplicatePath, `studioUrl: ${studioUrl}\ngrantToken: ${token}\noperation: list\nstudioUrl: ${studioUrl}\n`);
    const duplicate = await runCli(["studio-drafts", "--config", duplicatePath]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /YAML configuration is invalid/u);
    assert.equal(calls.length, 3);

    const missingTokenPath = path.join(directory, "missing-token.json");
    await writeFile(missingTokenPath, JSON.stringify({ studioUrl, operation: "list" }));
    const missingToken = await runCli(["studio-drafts", "--config", missingTokenPath], { KEEL_STUDIO_AGENT_TOKEN: "" });
    assert.equal(missingToken.status, 1);
    assert.match(missingToken.stderr, /KEEL_STUDIO_AGENT_TOKEN/u);
    assert.doesNotMatch(missingToken.stderr, /keel_agent_/u);
    assert.equal(calls.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
});
