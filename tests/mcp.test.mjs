import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createRecursiveUploadPlan, createUploadPlan } from "../packages/builder/dist/index.js";
import { createIntegrity } from "../packages/protocol/dist/index.js";
import { createMcpServer } from "../packages/mcp/dist/index.js";

const bytes = (value) => new TextEncoder().encode(value);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAk+Uzr4AAAAASUVORK5CYII=",
  "base64",
);

async function moduleSnapshot() {
  const content = bytes("export const demo = true;\n");
  const integrity = await createIntegrity(content);
  return {
    protocol: "keel-module-resolver-snapshot@1",
    catalog: {
      protocol: "keel-module-catalog@1",
      canonicalDigest: "sha256",
      releases: [{
        identity: { namespace: "npm", name: "demo", version: "1.0.0", entry: "dist/index.js" },
        mediaType: "text/javascript",
        format: "es-module",
        integrity,
        byteLength: content.byteLength,
        carriers: [{ kind: "https", uri: "https://example.test/demo.js", immutable: true }],
      }],
    },
    display: [{
      identity: { namespace: "npm", name: "demo", version: "1.0.0", entry: "dist/index.js" },
      artist: "Keel",
      tags: ["example"],
    }],
  };
}

async function call(server, id, name, args) {
  return server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

const initializeParams = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } };

test("MCP initializes, lists strict tools, and returns JSON-RPC parameter errors", async () => {
  const directory = await mkdtemp(path.join("/tmp", "keel-mcp-"));
  try {
    const server = await createMcpServer({ workspaceRoot: directory });
    const before = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(before?.error?.code, -32002);
    const promptsBefore = await server.handle({ jsonrpc: "2.0", id: 8, method: "prompts/list", params: {} });
    assert.equal(promptsBefore?.error?.code, -32002);
    const resourcesBefore = await server.handle({ jsonrpc: "2.0", id: 21, method: "resources/list", params: {} });
    assert.equal(resourcesBefore?.error?.code, -32002);
    const ping = await server.handle({ jsonrpc: "2.0", id: 7, method: "ping", params: {} });
    assert.deepEqual(ping?.result, {});
    const noIdPing = await server.handle({ jsonrpc: "2.0", method: "ping", params: {} });
    assert.equal(noIdPing?.error?.code, -32600);
    const noIdInitialize = await server.handle({ jsonrpc: "2.0", method: "initialize", params: initializeParams });
    assert.equal(noIdInitialize?.error?.code, -32600);
    const nullId = await server.handle({ jsonrpc: "2.0", id: null, method: "initialize", params: initializeParams });
    assert.equal(nullId?.error?.code, -32600);
    const malformedInitialize = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    assert.equal(malformedInitialize?.error?.code, -32602);
    const unsupportedInitialize = await server.handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: { ...initializeParams, protocolVersion: "2025-06-18" } });
    assert.equal(unsupportedInitialize?.error?.code, -32602);
    const initialized = await server.handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: initializeParams });
    assert.equal(initialized?.result.serverInfo.name, "keel-mcp");
    assert.deepEqual(Object.keys(initialized?.result.capabilities), ["tools", "prompts", "resources"]);
    const listed = await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    assert.deepEqual(listed?.result.tools.map((tool) => tool.name), ["analyze", "media-optimize", "build", "verify", "cost", "upload-plan", "chain-plan", "ethereum-encode", "publish-plan", "module-resolve", "module-lock", "wallet-request-prepare", "wallet-link", "module-review-prepare", "fray-auction-intake", "fray-stage-project", "keel-chain-guide", "keel-library-search", "keel-endpoint-config", "keel-studio-capabilities", "keel-studio-project-intake"]);
    const malformed = await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cost", unexpected: true } });
    assert.equal(malformed?.error?.code, -32602);
    const malformedArguments = await server.handle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "cost", arguments: null } });
    assert.equal(malformedArguments?.error?.code, -32602);
    const malformedPing = await server.handle({ jsonrpc: "2.0", id: 13, method: "ping", params: { unexpected: true } });
    assert.equal(malformedPing?.error?.code, -32602);
    const nullPing = await server.handle({ jsonrpc: "2.0", id: 27, method: "ping", params: null });
    assert.equal(nullPing?.error?.code, -32602);
    const nullToolsList = await server.handle({ jsonrpc: "2.0", id: 28, method: "tools/list", params: null });
    assert.equal(nullToolsList?.error?.code, -32602);
    const shutdownServer = await createMcpServer({ workspaceRoot: directory });
    await shutdownServer.handle({ jsonrpc: "2.0", id: 29, method: "initialize", params: initializeParams });
    const nullShutdown = await shutdownServer.handle({ jsonrpc: "2.0", id: 30, method: "shutdown", params: null });
    assert.equal(nullShutdown?.error?.code, -32602);
    const noIdTool = await server.handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "module-lock", arguments: {} } });
    assert.equal(noIdTool?.error?.code, -32600);
    const noIdPrompt = await server.handle({ jsonrpc: "2.0", method: "prompts/list", params: {} });
    assert.equal(noIdPrompt?.error?.code, -32600);
    const noIdResource = await server.handle({ jsonrpc: "2.0", method: "resources/list", params: {} });
    assert.equal(noIdResource?.error?.code, -32600);
    const promptList = await server.handle({ jsonrpc: "2.0", id: 9, method: "prompts/list", params: {} });
    assert.deepEqual(promptList?.result.prompts.map((prompt) => prompt.name), ["keel-asset-review", "fray-auction-review"]);
    const frayPrompt = await server.handle({ jsonrpc: "2.0", id: 11, method: "prompts/get", params: { name: "fray-auction-review" } });
    assert.match(frayPrompt?.result.messages[0].content.text, /exactly three auction setups/iu);
    assert.match(frayPrompt?.result.messages[0].content.text, /stop and wait/iu);
    const malformedPromptList = await server.handle({ jsonrpc: "2.0", id: 10, method: "prompts/list", params: { unexpected: true } });
    assert.equal(malformedPromptList?.error?.code, -32602);
    const malformedResourceList = await server.handle({ jsonrpc: "2.0", id: 22, method: "resources/list", params: null });
    assert.equal(malformedResourceList?.error?.code, -32602);
    const resourceFiles = await readdir(directory);
    const resourceList = await server.handle({ jsonrpc: "2.0", id: 23, method: "resources/list", params: {} });
    assert.deepEqual(resourceList?.result.resources.map((resource) => resource.uri), ["keel://mcp/workflow", "keel://mcp/limits", "keel://mcp/publication-modes"]);
    const resourceRead = await server.handle({ jsonrpc: "2.0", id: 24, method: "resources/read", params: { uri: "keel://mcp/limits" } });
    assert.equal(JSON.parse(resourceRead?.result.contents[0].text).kind, "offline-limits");
    const workflowRead = await server.handle({ jsonrpc: "2.0", id: 27, method: "resources/read", params: { uri: "keel://mcp/workflow" } });
    const workflow = JSON.parse(workflowRead?.result.contents[0].text);
    assert.ok(workflow.steps.includes("module-resolve"));
    assert.ok(workflow.steps.includes("module-lock"));
    assert.ok(workflow.steps.includes("ethereum-encode"));
    assert.ok(workflow.steps.includes("publish-plan"));
    const publicationModesRead = await server.handle({ jsonrpc: "2.0", id: 29, method: "resources/read", params: { uri: "keel://mcp/publication-modes" } });
    const publicationModes = JSON.parse(publicationModesRead?.result.contents[0].text);
    assert.equal(publicationModes.defaultMode, "native-carrier-v1");
    assert.equal(publicationModes.modes.find((mode) => mode.id === "history-inscription-v1").contractReadable, false);
    assert.match(publicationModes.presentation.sdkPlanner.portableThreeDefault, /Three\.js r180/u);
    assert.deepEqual(await readdir(directory), resourceFiles);
    const unknownResource = await server.handle({ jsonrpc: "2.0", id: 25, method: "resources/read", params: { uri: "keel://mcp/unknown" } });
    assert.equal(unknownResource?.error?.code, -32002);
    const malformedResourceRead = await server.handle({ jsonrpc: "2.0", id: 26, method: "resources/read", params: { uri: "keel://mcp/limits", extra: true } });
    assert.equal(malformedResourceRead?.error?.code, -32602);
    const unknownPrompt = await server.handle({ jsonrpc: "2.0", id: 11, method: "prompts/get", params: { name: "missing" } });
    assert.equal(unknownPrompt?.error?.code, -32602);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP cost, module lock, and wallet preparation stay offline and bounded", async () => {
  const directory = await mkdtemp(path.join("/tmp", "keel-mcp-"));
  try {
    await writeFile(path.join(directory, "asset.js"), "export const asset = true;\n");
    await writeFile(path.join(directory, "art.png"), ONE_PIXEL_PNG);
    await writeFile(path.join(directory, "snapshot.json"), JSON.stringify(await moduleSnapshot()));
    const server = await createMcpServer({ workspaceRoot: directory });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const promptFiles = await readdir(directory);
    const prompt = await server.handle({ jsonrpc: "2.0", id: 16, method: "prompts/get", params: { name: "keel-asset-review", arguments: { input: "asset.js", objectName: "asset", mediaType: "text/javascript" } } });
    assert.equal(prompt?.result.description, "Offline, review-only Keel asset workflow.");
    assert.equal(prompt?.result.messages.length, 1);
    assert.match(prompt?.result.messages[0].content.text, /asset\.js/u);
    assert.match(prompt?.result.messages[0].content.text, /chain-plan/u);
    assert.deepEqual(await readdir(directory), promptFiles);
    const malformedPrompt = await server.handle({ jsonrpc: "2.0", id: 17, method: "prompts/get", params: { name: "keel-asset-review", arguments: { input: "asset.js", unknown: "value" } } });
    assert.equal(malformedPrompt?.error?.code, -32602);
    const nullPromptArguments = await server.handle({ jsonrpc: "2.0", id: 18, method: "prompts/get", params: { name: "keel-asset-review", arguments: null } });
    assert.equal(nullPromptArguments?.error?.code, -32602);
    const unsafePromptName = await server.handle({ jsonrpc: "2.0", id: 19, method: "prompts/get", params: { name: "keel-asset-review", arguments: { input: "asset.js", objectName: "../escape" } } });
    assert.equal(unsafePromptName?.error?.code, -32602);
    const unsafePromptPath = await server.handle({ jsonrpc: "2.0", id: 20, method: "prompts/get", params: { name: "keel-asset-review", arguments: { input: "../outside.js" } } });
    assert.equal(unsafePromptPath?.error?.code, -32602);
    const oversizedPromptMedia = await server.handle({ jsonrpc: "2.0", id: 31, method: "prompts/get", params: { name: "keel-asset-review", arguments: { input: "asset.js", mediaType: "é".repeat(65) } } });
    assert.equal(oversizedPromptMedia?.error?.code, -32602);
    const cost = await call(server, 2, "cost", { input: "asset.js", compression: "none" });
    assert.equal(cost?.result.structuredContent.model.caveat, "modeled-estimate-not-gas-quote");
    const optimizerFiles = await readdir(directory);
    const optimize = await call(server, 7, "media-optimize", { input: "art.png", selectedStorageMode: "inline" });
    assert.equal(optimize?.result.structuredContent.mode, "dry-run");
    assert.equal(optimize?.result.structuredContent.measurements.state, "measured-in-memory");
    assert.equal(typeof optimize?.result.structuredContent.measurements.afterBytes, "number");
    assert.deepEqual(optimize?.result.structuredContent.storage, { selectedMode: "inline", changed: false });
    assert.equal(optimize?.result.structuredContent.sourceRetention.sourceRemoved, false);
    assert.deepEqual(await readdir(directory), optimizerFiles);
    const uploadPlan = await call(server, 8, "upload-plan", { input: "asset.js", objectName: "asset", mediaType: "text/javascript", strategy: "flat", compression: "none" });
    assert.equal(uploadPlan?.result.structuredContent.dryRun, true);
    assert.equal(uploadPlan?.result.structuredContent.materialized, false);
    assert.equal(uploadPlan?.result.structuredContent.plan.schema, "keel-upload-plan@2");
    const recursiveA = await call(server, 9, "upload-plan", { input: "asset.js", objectName: "asset", mediaType: "text/javascript", strategy: "recursive", compression: "none", leafDecodedBytes: 4096 });
    const recursiveB = await call(server, 10, "upload-plan", { input: "asset.js", objectName: "asset", mediaType: "text/javascript", strategy: "recursive", compression: "none", leafDecodedBytes: 4096 });
    assert.deepEqual(recursiveA?.result.structuredContent.plan, recursiveB?.result.structuredContent.plan);
    await assert.rejects(() => readFile(path.join(directory, "recursive-upload-plan.json")));
    const materializedDirectory = path.join(directory, "materialized");
    await mkdir(materializedDirectory, { recursive: true });
    await createUploadPlan(bytes("export const chainReady = true;\n"), {
      objectName: "chain-ready",
      mediaType: "text/javascript",
      compression: "none",
      outputDirectory: materializedDirectory,
    });
    const chainPlan = await call(server, 11, "chain-plan", {
      plan: "materialized/upload-plan.json",
      family: "ethereum",
      chainId: 1,
      target: "0x0000000000000000000000000000000000000000",
    });
    assert.equal(chainPlan?.result.structuredContent.status, "review-only");
    assert.equal(chainPlan?.result.structuredContent.materialized, true);
    assert.equal(chainPlan?.result.structuredContent.descriptorMaterialized, true);
    assert.equal(chainPlan?.result.structuredContent.chainReady, false);
    assert.equal(chainPlan?.result.structuredContent.sourcePlan.path, "materialized/upload-plan.json");
    assert.equal(chainPlan?.result.structuredContent.signing, "not-performed");
    assert.equal(chainPlan?.result.structuredContent.submission, "not-performed");
    assert.equal(chainPlan?.result.structuredContent.encoding, "deferred-contract-abi");
    assert.equal(chainPlan?.result.structuredContent.operations.at(-1).kind, "weldObject");
    const filesBeforeEncode = await readdir(directory);
    const encoded = await call(server, 33, "ethereum-encode", {
      plan: "materialized/upload-plan.json",
      family: "ethereum",
      chainId: 1,
      target: "0x0000000000000000000000000000000000000000",
    });
    assert.equal(encoded?.result.structuredContent.status, "ready-for-review");
    assert.equal(encoded?.result.structuredContent.chainReady, false);
    assert.match(encoded?.result.structuredContent.operations[0].data, /^0x[0-9a-f]+$/u);
    assert.equal(encoded?.result.structuredContent.transport.qr, "unsupported");
    assert.equal(encoded?.result.structuredContent.transport.requested, false);
    const encodedQr = await call(server, 34, "ethereum-encode", {
      plan: "materialized/upload-plan.json",
      family: "ethereum",
      chainId: 1,
      target: "0x0000000000000000000000000000000000000000",
      qr: true,
    });
    assert.equal(encodedQr?.result.structuredContent.transport.qr, "unsupported");
    assert.equal(encodedQr?.result.structuredContent.transport.requested, true);
    assert.deepEqual(await readdir(directory), filesBeforeEncode);
    const publishPlan = await call(server, 32, "publish-plan", { chainPlan: chainPlan?.result.structuredContent });
    assert.equal(publishPlan?.result.structuredContent.status, "review-only");
    assert.equal(publishPlan?.result.structuredContent.chainReady, false);
    assert.equal(publishPlan?.result.structuredContent.envelope.plan.protocol, "keel-publish-plan@1");
    assert.equal(publishPlan?.result.structuredContent.envelope.integrity.algorithm, "sha256");
    assert.equal(publishPlan?.result.structuredContent.envelope.plan.source.path, undefined);
    assert.equal(publishPlan?.result.structuredContent.envelope.plan.operations[0].descriptor.chunkFiles, undefined);
    const materializedPlanPath = path.join(materializedDirectory, "upload-plan.json");
    const materializedPlan = JSON.parse(await readFile(materializedPlanPath, "utf8"));
    materializedPlan.integrity.digest = `0x${"0".repeat(64)}`;
    await writeFile(materializedPlanPath, JSON.stringify(materializedPlan));
    const tamperedChainPlan = await call(server, 13, "chain-plan", {
      plan: "materialized/upload-plan.json",
      family: "ethereum",
      chainId: 1,
      target: "0x0000000000000000000000000000000000000000",
    });
    assert.equal(tamperedChainPlan?.result.isError, true);
    const recursiveMaterializedDirectory = path.join(directory, "recursive-materialized");
    await mkdir(recursiveMaterializedDirectory, { recursive: true });
    await createRecursiveUploadPlan(new Uint8Array(9000).fill(7), {
      objectName: "recursive-chain-ready",
      mediaType: "application/octet-stream",
      compression: "none",
      leafDecodedBytes: 4096,
      maxPartsPerComposite: 2,
      outputDirectory: recursiveMaterializedDirectory,
    });
    const recursiveChainPlan = await call(server, 14, "chain-plan", {
      plan: "recursive-materialized/recursive-upload-plan.json",
      family: "ethereum",
      chainId: 1,
      target: "0x0000000000000000000000000000000000000000",
    });
    assert.equal(recursiveChainPlan?.result.structuredContent.status, "review-only");
    const recursivePlanPath = path.join(recursiveMaterializedDirectory, "recursive-upload-plan.json");
    const tamperedRecursivePlan = JSON.parse(await readFile(recursivePlanPath, "utf8"));
    tamperedRecursivePlan.objects.find((item) => item.kind === "leaf").level = 1;
    await writeFile(recursivePlanPath, JSON.stringify(tamperedRecursivePlan));
    const tamperedRecursiveChainPlan = await call(server, 15, "chain-plan", {
      plan: "recursive-materialized/recursive-upload-plan.json",
      family: "ethereum",
      chainId: 1,
      target: "0x0000000000000000000000000000000000000000",
    });
    assert.equal(tamperedRecursiveChainPlan?.result.isError, true);
    const tezosPlan = await call(server, 12, "chain-plan", {
      plan: "materialized/upload-plan.json",
      family: "tezos",
      network: "mainnet",
      target: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton",
    });
    assert.equal(tezosPlan?.result.isError, true);
    const resolved = await call(server, 3, "module-resolve", { snapshot: "snapshot.json", selector: { name: "demo" } });
    assert.equal(resolved?.result.structuredContent.status, "bytes-unavailable");
    const locked = await call(server, 4, "module-lock", { snapshot: "snapshot.json", out: "root.lock.json", selector: { name: "demo" } });
    assert.equal(locked?.result.structuredContent.status, "locked");
    assert.match(await readFile(path.join(directory, "root.lock.json"), "utf8"), /keel-module-lock/u);
    const receiptSidecar = JSON.parse(await readFile(path.join(directory, "root.lock.json.receipt.json"), "utf8"));
    assert.equal(receiptSidecar.receipt.protocol, "keel-module-resolution-receipt@1");
    assert.equal(receiptSidecar.integrity.digest, locked?.result.structuredContent.receiptDigest.digest);
    const prepared = await call(server, 5, "wallet-request-prepare", {
      request: {
        protocol: "keel-wallet-request@1", requestId: "mcp-test", label: "Review", family: "ethereum", chainId: 1,
        to: "0x0000000000000000000000000000000000000000", data: "0x", valueWei: "0", transport: "walletconnect-qr",
      }, qr: true,
    });
    assert.equal(prepared?.result.structuredContent.status, "prepared-only");
    assert.match(prepared?.result.structuredContent.qr, /^keel-wallet-request:/u);
    const collectionConfig = {
      name: "Keel Demo",
      symbol: "KEEL",
      admin: "0x1111111111111111111111111111111111111111",
      royaltyReceiver: "0x2222222222222222222222222222222222222222",
      royaltyBps: "250",
      maxSupply: "1000",
      mintManager: "0x3333333333333333333333333333333333333333",
      keelIndex: "0x4444444444444444444444444444444444444444",
    };
    const walletLinkInput = {
        family: "ethereum",
        accountAddress: "0x1111111111111111111111111111111111111111",
        agentAddress: "0x2222222222222222222222222222222222222222",
        target: {
          chainId: 1,
          factoryAddress: "0x3333333333333333333333333333333333333333",
          factoryVersion: `0x${"44".repeat(32)}`,
          creationCodeHash: `0x${"55".repeat(32)}`,
          operation: "keelFactory.castDie",
          configDigest: "0x818fc05dadddd562c44596d54c5a4a3f934f2058101087ed8f0bb95fa42c3744",
          configEncoding: "keel-factory-config-keccak@1",
          authorizationNonce: "0",
        },
        scopes: ["create-collection", "prepare"],
        issuedAt: 1_800_000_000,
        expiresAt: 1_800_003_600,
        nonce: "mcp-link-0",
        transport: "ledger",
        collectionConfig,
    };
    const walletLink = await call(server, 35, "wallet-link", { link: walletLinkInput });
    assert.equal(walletLink?.result.structuredContent.status, "review-only");
    assert.equal(walletLink?.result.structuredContent.link.signing, "not-performed");
    assert.equal(walletLink?.result.structuredContent.typedData.primaryType, "CollectionAuthorization");
    assert.equal(walletLink?.result.structuredContent.typedData.message.nonce, "0");
    assert.equal(walletLink?.result.structuredContent.configDigestVerified, true);
    assert.deepEqual(walletLink?.result.structuredContent.collectionConfig, collectionConfig);
    const walletFiles = await readdir(directory);
    const escalatedLink = await call(server, 36, "wallet-link", {
      link: { ...walletLinkInput, scopes: ["create-collection", "sign"] },
    });
    assert.equal(escalatedLink?.result.isError, true);
    const tezosLink = await call(server, 37, "wallet-link", {
      link: { ...walletLinkInput, family: "tezos", transport: "tezconnect" },
    });
    assert.equal(tezosLink?.result.structuredContent.link.status, "deferred");
    const { collectionConfig: _omittedConfig, ...withoutConfig } = walletLinkInput;
    const missingConfig = await call(server, 39, "wallet-link", { link: withoutConfig });
    assert.equal(missingConfig?.result.structuredContent.status, "deferred");
    assert.equal(missingConfig?.result.structuredContent.code, "config-verification-required");
    assert.equal("typedData" in (missingConfig?.result.structuredContent ?? {}), false);
    const mismatchedConfig = await call(server, 40, "wallet-link", {
      link: { ...walletLinkInput, collectionConfig: { ...collectionConfig, name: "Mutated" } },
    });
    assert.equal(mismatchedConfig?.result.isError, true);
    const revokedLink = await call(server, 38, "wallet-link", {
      link: {
        ...walletLinkInput,
        revocation: { status: "revoked", nonce: "mcp-link-revoked", revokedAt: 1_800_000_100 },
      },
    });
    assert.equal(revokedLink?.result.structuredContent.status, "deferred");
    assert.equal(revokedLink?.result.structuredContent.code, "link-revoked");
    assert.equal(revokedLink?.result.structuredContent.link.revocation.status, "revoked");
    assert.equal("typedData" in (revokedLink?.result.structuredContent ?? {}), false);
    assert.deepEqual(await readdir(directory), walletFiles);
    const escaped = await call(server, 6, "analyze", { input: "../outside.bin" });
    assert.equal(escaped?.result.isError, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP rejects symlink inputs and CLI emits protocol JSON only", async () => {
  const directory = await mkdtemp(path.join("/tmp", "keel-mcp-"));
  const outside = await mkdtemp(path.join("/tmp", "keel-mcp-outside-"));
  try {
    await writeFile(path.join(outside, "asset.js"), "export const outside = true;\n");
    await symlink(path.join(outside, "asset.js"), path.join(directory, "linked.js"));
    const server = await createMcpServer({ workspaceRoot: directory });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const rejected = await call(server, 2, "analyze", { input: "linked.js" });
    assert.equal(rejected?.result.isError, true);
    const missing = await call(server, 3, "verify", { directory: "." });
    assert.equal(missing?.result.structuredContent.valid, false);
    assert.equal(missing?.result.structuredContent.manifestIntegrity.status, "unavailable");
    const cli = path.resolve("packages/mcp/dist/cli.js");
    const output = execFileSync(process.execPath, [cli, "--workspace", directory], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "keel://mcp/workflow" } })}\n`,
      encoding: "utf8",
    });
    const lines = output.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 4);
    assert.equal(lines[0].id, 1);
    assert.equal(lines[1].result.tools.length, 21);
    assert.equal(lines[2].result.resources.length, 3);
    assert.equal(JSON.parse(lines[3].result.contents[0].text).kind, "offline-workflow");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Fray intake asks for creator choices and emits a digest-bound approval handoff", async () => {
  const directory = await mkdtemp(path.join("/tmp", "keel-mcp-"));
  try {
    const server = await createMcpServer({ workspaceRoot: directory });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const missing = await call(server, 2, "fray-auction-intake", { family: "ethereum", network: "sepolia" });
    assert.equal(missing?.result.structuredContent.status, "needs-input");
    assert.deepEqual(missing?.result.structuredContent.questions.map((question) => question.field), ["title", "description", "auctionPreset"]);
    assert.equal(missing?.result.structuredContent.auctionPresets.length, 3);
    assert.equal(missing?.result.structuredContent.auctionPresets[0].id, 1);
    assert.equal(missing?.result.structuredContent.auctionPresets[2].id, 3);

    const ready = await call(server, 3, "fray-auction-intake", {
      sourcePath: "doom.wasm",
      title: "Doom",
      useDefaultDescription: true,
      auctionPreset: 1,
      family: "ethereum",
      network: "sepolia",
      reuseQuery: "three.js",
    });
    const plan = ready?.result.structuredContent;
    assert.equal(plan.status, "ready-for-approval");
    assert.equal(plan.descriptionSource, "agent-default");
    assert.equal(plan.auction.policy.presetId, 1);
    assert.equal(plan.auction.policy.protocol, "fray-auction-policy@1");
    assert.equal(plan.auction.terms.reserveAtomic, "10000000000000000");
    assert.equal(plan.auction.terms.bidIncrementAtomic, "5000000000000000");
    assert.equal(plan.auction.terms.maximumEditionSize, 0);
    assert.equal(plan.approvalRequest.api.body.auctionPreset, undefined);
    assert.deepEqual(plan.approvalRequest.api.body.auctionPolicy.terms, plan.auction.terms);
    assert.equal(plan.chain.chainId, 11155111);
    assert.equal(plan.approvalRequest.protocol, "fray-approval-request@1");
    assert.match(plan.approvalRequest.requestId, /^fray-[0-9a-f]{16}$/u);
    assert.equal(plan.approvalRequest.api.userApprovalRequired, true);
    assert.equal(plan.approvalRequest.wallet.preferred, "eip-5792");
    assert.equal(plan.approvalRequest.wallet.oneSignature, "capability-dependent");
    assert.equal(plan.approvalRequest.wallet.signing, "not-performed");
    assert.equal(plan.wallet.submission, "not-performed");

    const chainGuide = await call(server, 4, "keel-chain-guide", { family: "tezos" });
    assert.equal(chainGuide?.result.structuredContent.status, "ok");
    assert.equal(chainGuide?.result.structuredContent.chains[0].network, "shadownet");
    assert.equal(chainGuide?.result.structuredContent.chains[0].faucet.agentAction, "show-links-only");

    const missingOutcome = await call(server, 40, "keel-studio-project-intake", {
      title: "Seed Current",
      description: "A p5 work.",
    });
    assert.deepEqual(missingOutcome?.result.structuredContent.questions.map(({ field }) => field), ["outcome"]);
    const storageOnly = await call(server, 41, "keel-studio-project-intake", {
      title: "Seed Current",
      description: "A p5 work.",
      outcome: "storage-only",
    });
    assert.equal(storageOnly?.result.structuredContent.status, "ready");
    assert.equal(storageOnly?.result.structuredContent.releaseIntent, undefined);
    const release = await call(server, 42, "keel-studio-project-intake", {
      title: "Seed Current",
      description: "A p5 work.",
      outcome: "release",
      chainId: 11155111,
      release: { type: "one-of-one", saleMechanism: "fixed-price", priceEth: "0.1" },
    });
    assert.equal(release?.result.structuredContent.releaseIntent.release.priceEth, "0.1");

    const search = await call(server, 5, "keel-library-search", { query: "three.js" });
    assert.equal(search?.result.structuredContent.status, "unconfigured");
    assert.match(search?.result.structuredContent.message, /no carrier bytes were fetched/iu);
    const endpoints = await call(server, 6, "keel-endpoint-config", {
      studioUrl: "https://studio.example",
      publicRpcUrl: "https://rpc.example",
      indexerUrl: "https://indexer.example",
    });
    assert.equal(endpoints?.result.structuredContent.studioUrl, "https://studio.example");
    assert.equal(endpoints?.result.structuredContent.sources.studioUrl, "explicit");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Keel index search reads bounded metadata and locks an exact reuse candidate", async () => {
  const directory = await mkdtemp(path.join("/tmp", "keel-mcp-"));
  const indexServer = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/library?")) {
      response.end(JSON.stringify({ assets: [{
        name: "Three.js runtime",
        assetId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        registry: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        policyVersion: 2,
        policyCommitment: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        license: "MIT",
        role: "runtime",
        byteLength: 42,
        mediaType: "text/javascript",
      }] }));
      return;
    }
    if (request.url?.startsWith("/api/modules?")) {
      response.end(JSON.stringify({ modules: [{
        name: "three",
        namespace: "npm",
        versions: [{
          identity: { namespace: "npm", name: "three", version: "0.180.0", entry: "build/three.module.js" },
          mediaType: "text/javascript",
          format: "es-module",
          integrity: { algorithm: "sha256", digest: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", byteLength: 84 },
          byteLength: 84,
          license: "MIT",
          carriers: [{ kind: "keel", network: "sepolia", store: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", objectId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }],
        }],
        carrierKinds: ["keel"],
      }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    indexServer.once("error", reject);
    indexServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = indexServer.address();
    assert.ok(address && typeof address === "object");
    const server = await createMcpServer({ workspaceRoot: directory });
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    const result = await call(server, 2, "keel-library-search", { studioUrl: `http://127.0.0.1:${address.port}`, query: "three.js" });
    const content = result?.result.structuredContent;
    assert.equal(content.status, "ok");
    assert.equal(content.library[0].selection.updateMode, "locked");
    assert.equal(content.library[0].selection.policyVersion, 2);
    assert.equal(content.modules[0].versions[0].identity.name, "three");
    assert.equal(content.reuse.status, "needs-selection");
    assert.match(content.carriers, /metadata-only/iu);
  } finally {
    await new Promise((resolve) => indexServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP CLI help, version, and self-test are explicit non-stdio modes", async () => {
  const directory = await mkdtemp(path.join("/tmp", "keel-mcp-"));
  try {
    const cli = path.resolve("packages/mcp/dist/cli.js");
    const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.match(help, /^Usage: keel-mcp /u);
    assert.doesNotMatch(help, /^\s*\{\s*"jsonrpc"/u);
    assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }), "0.4.0\n");
    const before = await readdir(directory);
    const first = execFileSync(process.execPath, [cli, "--self-test", "--workspace", directory], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [cli, "--self-test", `--workspace=${directory}`], { encoding: "utf8" });
    assert.deepEqual(await readdir(directory), before);
    assert.throws(() => execFileSync(process.execPath, [cli, "--self-test", "--workspace", directory, `--workspace=${directory}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (error) => error?.status === 1);
    assert.equal(first, second);
    const health = JSON.parse(first);
    assert.equal(health.status, "ok");
    assert.equal(health.protocolVersion, "2024-11-05");
    assert.equal(health.toolCount, 21);
    assert.deepEqual(health.checks, ["initialize", "ping", "tools/list", "prompts/list", "prompts/get", "resources/list", "resources/read"]);
    assert.equal(health.jsonrpc, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
