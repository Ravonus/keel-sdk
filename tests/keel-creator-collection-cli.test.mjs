import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CLI = path.join(ROOT, "tools", "keel", "cli.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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

test("creator-collection CLI accepts JSON and YAML and stops before wallet approval on an unconfigured chain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keel-creator-collection-cli-"));
  const base = {
    chainId: 11155111,
    creator: "0x1111111111111111111111111111111111111111",
    instance: "creator-v1",
    creatorNonce: "0",
    operation: {
      kind: "dedicated-erc721",
      config: { name: "One of One", symbol: "ONE", maxSupply: 1, metadataDigest: `0x${"a".repeat(64)}` },
    },
  };
  try {
    const jsonPath = path.join(directory, "creator.json");
    await writeFile(jsonPath, JSON.stringify(base));
    const json = await runCli(["creator-collection", "--config", jsonPath]);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).status, "blocked");
    assert.equal(JSON.parse(json.stdout).walletApproval, "not-requested");

    const yamlPath = path.join(directory, "creator.yaml");
    await writeFile(yamlPath, `chainId: 11155111\ncreator: "${base.creator}"\ninstance: creator-v1\ncreatorNonce: "0"\noperation:\n  kind: shared-erc1155\n  name: Ten Thousand\n  metadataDigest: "0x${"b".repeat(64)}"\n`);
    const yaml = await runCli(["creator-collection", "--config", yamlPath]);
    assert.equal(yaml.status, 0, yaml.stderr);
    const parsed = JSON.parse(yaml.stdout);
    assert.equal(parsed.status, "blocked");
    assert.equal(parsed.signing, "not-performed");
    assert.equal(parsed.submission, "not-performed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
