#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.KEEL_SHADOWNET_RPC ?? "https://rpc.shadownet.teztnets.com";
const CHAIN_ID = "NetXsqzbfFenSTS";
const CHARACTER = "KT1LpCu73gb87jz96tnkiU6nfWgunHUue7VP";
const VIEW = "get_recipe";
const TOKEN_IDS = new Set(["0", "1", "2"]);
const demoDirectory = path.dirname(fileURLToPath(import.meta.url));

const resources = new Map([
  ["index.html", { file: path.join(demoDirectory, "index.html"), type: "text/html; charset=utf-8" }],
  ["scene.js", { file: path.join(demoDirectory, "scene.js"), type: "text/javascript; charset=utf-8" }],
  ["scene-seed.mjs", { file: path.join(demoDirectory, "scene-seed.mjs"), type: "text/javascript; charset=utf-8" }],
  ["three.min.js", { file: path.join(demoDirectory, "../vendor/three.min.js"), type: "text/javascript; charset=utf-8" }],
  ["three.core.min.js", { file: path.join(demoDirectory, "../vendor/three.core.min.js"), type: "text/javascript; charset=utf-8" }],
]);

async function rpcJson(pathname, init) {
  const response = await fetch(`${RPC}${pathname}`, init);
  if (!response.ok) throw new Error(`ShadowNet RPC ${pathname} returned HTTP ${response.status}`);
  return response.json();
}

function flattenMichelson(value, output = []) {
  if (Array.isArray(value)) {
    for (const child of value) flattenMichelson(child, output);
    return output;
  }
  if (value?.prim === "Pair" && Array.isArray(value.args)) {
    for (const child of value.args) flattenMichelson(child, output);
    return output;
  }
  output.push(value);
  return output;
}

function bytesAt(fields, index, label) {
  const value = fields[index]?.bytes;
  if (typeof value !== "string" || !/^[0-9a-f]+$/iu.test(value)) {
    throw new Error(`ShadowNet ${VIEW} returned no ${label} at field ${index}`);
  }
  return `0x${value.toLowerCase()}`;
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function tokenIdFrom(requestUrl) {
  const tokenId = requestUrl.searchParams.get("tokenId") ?? "0";
  if (!TOKEN_IDS.has(tokenId)) {
    const error = new Error("tokenId must be one of 0, 1, or 2");
    error.statusCode = 400;
    throw error;
  }
  return tokenId;
}

async function readContext(tokenId) {
  const [chainId, blockHash] = await Promise.all([
    rpcJson("/chains/main/chain_id"),
    rpcJson("/chains/main/blocks/head/hash"),
  ]);
  if (chainId !== CHAIN_ID) throw new Error(`expected ${CHAIN_ID}, got ${chainId}`);
  const header = await rpcJson(`/chains/main/blocks/${encodeURIComponent(blockHash)}/header`);
  const viewResponse = await rpcJson(
    `/chains/main/blocks/${encodeURIComponent(blockHash)}/helpers/scripts/run_script_view`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contract: CHARACTER,
        view: VIEW,
        input: { int: tokenId },
        chain_id: CHAIN_ID,
        unlimited_gas: true,
        unparsing_mode: "Optimized",
      }),
    },
  );
  const fields = flattenMichelson(viewResponse.data ?? viewResponse);
  const derivedTokenSeed = bytesAt(fields, 7, "seed");
  const sceneId = bytesAt(fields, 8, "scene_id");
  return {
    protocol: "keel-three-vault-shadownet@1",
    source: "tezos-shadownet",
    network: CHAIN_ID,
    rpc: RPC,
    contract: CHARACTER,
    collection: CHARACTER,
    view: VIEW,
    contractView: VIEW,
    tokenId,
    derivedTokenSeed,
    seedSource: "Tezos ShadowNet get_recipe",
    sceneId,
    blockHash,
    blockLevel: Number(header.level),
    readOnly: true,
    rawRecipe: fields,
  };
}

function renderHtml(source, context) {
  const tokenLinks = [...TOKEN_IDS]
    .map((tokenId) => `<a href="/?tokenId=${tokenId}">TOKEN ${tokenId}</a>`)
    .join("<span> · </span>");
  const readback = `<aside id="shadownet-readback">
    <strong>READ-ONLY SHADOWNET · get_recipe</strong>
    <span>token ${context.tokenId} · seed ${context.derivedTokenSeed.slice(-8)} · block ${context.blockLevel}</span>
    <nav>${tokenLinks}</nav>
  </aside>`;
  const style = `<style>
    #shadownet-readback { position: fixed; z-index: 4; top: 18px; left: 18px; padding: 10px 12px; border: 1px solid rgba(89,229,255,.35); background: rgba(4,5,14,.78); color: #b7f5ff; font: 11px/1.45 ui-monospace, monospace; letter-spacing: .03em; backdrop-filter: blur(10px); }
    #shadownet-readback strong, #shadownet-readback span, #shadownet-readback nav { display: block; }
    #shadownet-readback span { color: #8b8ba7; margin-top: 3px; }
    #shadownet-readback nav { margin-top: 6px; }
    #shadownet-readback a { color: #59e5ff; text-decoration: none; }
    #shadownet-readback a:hover { text-decoration: underline; }
  </style>`;
  const bootstrap = `<script>globalThis.__KEEL_CONTEXT__=Object.freeze(${safeScriptJson(context)});</script>`;
  return source.replace("<body>", `<body>${style}${readback}${bootstrap}`);
}

async function sendFile(response, resource) {
  response.writeHead(200, { "content-type": resource.type, "cache-control": "no-store" });
  response.end(await readFile(resource.file));
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (requestUrl.pathname === "/api/context") {
      sendJson(response, 200, await readContext(tokenIdFrom(requestUrl)));
      return;
    }
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      const context = await readContext(tokenIdFrom(requestUrl));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderHtml(await readFile(resources.get("index.html").file, "utf8"), context));
      return;
    }
    if (requestUrl.pathname.startsWith("/content/")) {
      const resource = resources.get(requestUrl.pathname.slice("/content/".length));
      if (!resource) {
        sendJson(response, 404, { error: "resource not declared" });
        return;
      }
      await sendFile(response, resource);
      return;
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    sendJson(response, statusCode, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, async () => {
  try {
    const context = await readContext("0");
    console.log(`ShadowNet read-only Three.js preview: http://${host}:${port}/?tokenId=0`);
    console.log(`contract ${context.contract}::${context.view}`);
    console.log(`block ${context.blockLevel} ${context.blockHash}`);
    console.log(`token 0 seed ${context.derivedTokenSeed}`);
    console.log("switch tokens with ?tokenId=0, ?tokenId=1, or ?tokenId=2");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    server.close(() => process.exitCode = 1);
  }
});

process.once("SIGINT", () => server.close(() => process.exit(0)));
