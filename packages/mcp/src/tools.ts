import {
  analyzeCost,
  analyzeMedia,
  assertValidKeelModuleResolverSnapshot,
  createRecursiveUploadPlan,
  createUploadPlan,
  resolveModule,
  runMediaPipeline,
  verifyBuiltArtifact,
  type CostAnalysisOptions,
  type KeelModuleResolverSnapshot,
  type KeelModuleSelector,
} from "@keel/builder";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  createKeelWalletRequest,
  encodeKeelWalletRequestQr,
  createKeelPublishReviewPlan,
  createKeelWalletLink,
  createCollectionAuthorizationTypedData,
  fetchStudioCapabilities,
  buildKeelModuleReviewRequest,
  type KeelWalletLinkInput,
  type KeelModuleReviewInput,
} from "@keel/sdk";
import {
  createKeelFactoryConfigDigest,
  normalizeKeelFactoryCollectionConfig,
  type KeelFactoryCollectionConfig,
} from "@keel/ethereum-adapter";
import type { Compression, Hex } from "@keel/protocol";
import { TOOL_SCHEMAS } from "./schemas.js";
import { createChainOperationPlan } from "./chain-plan.js";
import { ethereumEncodeTool as runEthereumEncodeTool } from "./ethereum-encode.js";
import { chainGuide, prepareFrayAuctionIntake, searchKeelIndexes, stageFrayProject, type FrayPreviewCapture } from "./fray-agent.js";
import type { JsonSchema, ToolContext, ToolDefinition } from "./types.js";

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_PLAN_OBJECTS = 512;
const MAX_PLAN_DEPTH = 8;
// toolResult carries the same value as structuredContent and text; keep
// detailed plans bounded so the duplicated JSON stays below the 1 MiB frame.
const MAX_PLAN_RESPONSE_BYTES = 256 * 1024;

function record(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  const fields = new Set(allowed);
  for (const key of Object.keys(result)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
  return result;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${key} must be a non-empty string.`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${key} must be text.`);
  return value;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError(`${key} must be a safe integer.`);
  return value;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${key} must be boolean.`);
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function selectorValue(value: unknown): KeelModuleSelector {
  const input = record(value, ["sha256", "byteLength", "name", "artist", "tags"], "selector");
  const digest = input.sha256;
  if (digest !== undefined || input.byteLength !== undefined) {
    if (typeof digest !== "string" || typeof input.byteLength !== "number") throw new TypeError("hash selector requires sha256 and byteLength.");
    if (!/^0x[0-9a-f]{64}$/u.test(digest) || !Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) throw new TypeError("hash selector is invalid.");
    return { sha256: digest as Hex, byteLength: input.byteLength };
  }
  const name = optionalString(input, "name");
  const artist = optionalString(input, "artist");
  const tagsValue = input.tags;
  if (tagsValue !== undefined && (!Array.isArray(tagsValue) || tagsValue.some((tag) => typeof tag !== "string"))) throw new TypeError("selector.tags must be text values.");
  if (name === undefined && artist === undefined && (!Array.isArray(tagsValue) || tagsValue.length === 0)) throw new TypeError("query selector needs name, artist, or tags.");
  return { ...(name === undefined ? {} : { name }), ...(artist === undefined ? {} : { artist }), ...(tagsValue === undefined ? {} : { tags: tagsValue as string[] }) };
}

async function snapshot(context: ToolContext, pathValue: string): Promise<KeelModuleResolverSnapshot> {
  const loaded = await context.workspace.readFile(pathValue, MAX_SNAPSHOT_BYTES);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes)) as unknown;
  assertValidKeelModuleResolverSnapshot(parsed);
  return parsed;
}

async function analyzeTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["input", "mediaType"], "analyze arguments");
  const file = await context.workspace.resolveExistingFile(requiredString(input, "input"), MAX_MEDIA_BYTES);
  const mediaType = optionalString(input, "mediaType");
  return analyzeMedia({ input: file, maxInputBytes: MAX_MEDIA_BYTES, ...(mediaType === undefined ? {} : { mediaType }) });
}

async function buildTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["input", "outputDirectory", "createdAt", "name", "description", "id", "creator", "sourceRepository", "viewerBaseUrl", "webpQuality", "preserveOriginal", "sourceMode"], "build arguments");
  const source = await context.workspace.resolveExistingFile(requiredString(input, "input"), MAX_MEDIA_BYTES);
  const outputDirectory = await context.workspace.resolveOutputDirectory(requiredString(input, "outputDirectory"));
  const createdAt = requiredString(input, "createdAt");
  const name = optionalString(input, "name");
  const description = optionalString(input, "description");
  const id = optionalString(input, "id");
  const creator = optionalString(input, "creator");
  const sourceRepository = optionalString(input, "sourceRepository");
  const viewerBaseUrl = optionalString(input, "viewerBaseUrl");
  const webpQuality = optionalNumber(input, "webpQuality");
  const preserveOriginal = optionalBoolean(input, "preserveOriginal");
  const sourceMode = optionalString(input, "sourceMode");
  if (sourceMode !== undefined && sourceMode !== "files" && sourceMode !== "inline") throw new TypeError("sourceMode must be files or inline.");
  return runMediaPipeline({
    input: source,
    outputDirectory,
    createdAt,
    maxInputBytes: MAX_MEDIA_BYTES,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(id === undefined ? {} : { id }),
    ...(creator === undefined ? {} : { creator }),
    ...(sourceRepository === undefined ? {} : { sourceRepository }),
    ...(viewerBaseUrl === undefined ? {} : { viewerBaseUrl }),
    ...(webpQuality === undefined ? {} : { webpQuality }),
    ...(preserveOriginal === undefined ? {} : { preserveOriginal }),
    ...(sourceMode === undefined ? {} : { sourceMode }),
  });
}

async function verifyTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["directory", "manifestName"], "verify arguments");
  const directory = await context.workspace.resolveExistingDirectory(requiredString(input, "directory"));
  const manifestName = optionalString(input, "manifestName");
  const manifestPath = `${directory}/${manifestName ?? "manifest.json"}`;
  let manifestBytes: { readonly path: string; readonly bytes: Uint8Array };
  try {
    manifestBytes = await context.workspace.readFile(manifestPath, MAX_SNAPSHOT_BYTES);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return verifyBuiltArtifact({ directory, maxManifestBytes: MAX_SNAPSHOT_BYTES, maxSourceBytes: MAX_MEDIA_BYTES, ...(manifestName === undefined ? {} : { manifestName }) });
    throw error;
  }
  try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes.bytes)); }
  catch { return verifyBuiltArtifact({ directory, maxManifestBytes: MAX_SNAPSHOT_BYTES, maxSourceBytes: MAX_MEDIA_BYTES, ...(manifestName === undefined ? {} : { manifestName }) }); }
  try {
    await context.workspace.readFile(`${directory}/manifest.integrity.json`, MAX_SNAPSHOT_BYTES);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return verifyBuiltArtifact({ directory, maxManifestBytes: MAX_SNAPSHOT_BYTES, maxSourceBytes: MAX_MEDIA_BYTES, ...(manifestName === undefined ? {} : { manifestName }) });
}

async function costTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["input", "mediaType", "compression", "maxChunkBytes", "leafDecodedBytes", "maxPartsPerComposite", "maxTreeDepth"], "cost arguments");
  const loaded = await context.workspace.readFile(requiredString(input, "input"), MAX_MEDIA_BYTES);
  const compressionValue = optionalString(input, "compression");
  if (compressionValue !== undefined && !["auto", "none", "brotli", "gzip", "deflate"].includes(compressionValue)) throw new TypeError("compression is unsupported.");
  const mediaType = optionalString(input, "mediaType");
  const maxChunkBytes = optionalNumber(input, "maxChunkBytes");
  const leafDecodedBytes = optionalNumber(input, "leafDecodedBytes");
  const maxPartsPerComposite = optionalNumber(input, "maxPartsPerComposite");
  const maxTreeDepth = optionalNumber(input, "maxTreeDepth");
  const options: CostAnalysisOptions = {
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(compressionValue === undefined ? {} : { compression: compressionValue as Exclude<CostAnalysisOptions["compression"], undefined> }),
    ...(maxChunkBytes === undefined ? {} : { maxChunkBytes }),
    ...(leafDecodedBytes === undefined ? {} : { leafDecodedBytes }),
    ...(maxPartsPerComposite === undefined ? {} : { maxPartsPerComposite }),
    ...(maxTreeDepth === undefined ? {} : { maxTreeDepth }),
  };
  return analyzeCost(loaded.bytes, options);
}

function boundedPlanText(value: unknown, key: string, max: number): string {
  const textValue = requiredString({ [key]: value }, key);
  if (textValue.length > max || /[\u0000-\u001f\u007f]/u.test(textValue)) throw new TypeError(`${key} is invalid.`);
  if (new TextEncoder().encode(textValue).byteLength > max) throw new TypeError(`${key} exceeds its UTF-8 byte limit.`);
  return textValue;
}

function planCompression(value: unknown): Compression | "auto" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !["auto", "none", "brotli", "gzip", "deflate"].includes(value)) throw new TypeError("compression is unsupported.");
  return value as Compression | "auto";
}

function planInteger(value: unknown, key: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${key} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function estimatedRecursiveObjects(leafCount: number, maxParts: number): number {
  let total = leafCount;
  let level = leafCount;
  while (level > 1) {
    level = Math.ceil(level / maxParts);
    total += level;
  }
  return total;
}

async function uploadPlanTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["input", "objectName", "mediaType", "strategy", "compression", "maxChunkBytes", "leafDecodedBytes", "maxPartsPerComposite"], "upload-plan arguments");
  const source = await context.workspace.readFile(requiredString(input, "input"), MAX_MEDIA_BYTES);
  const objectName = boundedPlanText(input.objectName, "objectName", 128);
  if (objectName === "." || objectName === ".." || objectName.includes("/") || objectName.includes("\\")) throw new TypeError("objectName must be a metadata-safe name.");
  const mediaType = boundedPlanText(input.mediaType, "mediaType", 128);
  const strategyValue = optionalString(input, "strategy");
  if (strategyValue !== undefined && strategyValue !== "flat" && strategyValue !== "recursive") throw new TypeError("strategy must be flat or recursive.");
  const strategy = strategyValue ?? "flat";
  const compression = planCompression(input.compression);
  const maxChunkBytes = planInteger(input.maxChunkBytes, "maxChunkBytes", 1, 23_000);
  const leafDecodedBytes = planInteger(input.leafDecodedBytes, "leafDecodedBytes", 4_096, MAX_MEDIA_BYTES);
  const maxPartsPerComposite = planInteger(input.maxPartsPerComposite, "maxPartsPerComposite", 2, 128);
  if (strategy === "recursive") {
    const leaves = Math.ceil(source.bytes.byteLength / (leafDecodedBytes ?? 512 * 1024));
    const objects = estimatedRecursiveObjects(leaves, maxPartsPerComposite ?? 64);
    if (objects > MAX_PLAN_OBJECTS) throw new RangeError(`recursive plan exceeds the ${MAX_PLAN_OBJECTS}-object inspection limit; increase leafDecodedBytes or maxPartsPerComposite.`);
    let depth = 0;
    for (let level = leaves; level > 1; level = Math.ceil(level / (maxPartsPerComposite ?? 64))) depth += 1;
    if (depth > MAX_PLAN_DEPTH) throw new RangeError(`recursive plan depth ${depth} exceeds the direct reader limit of ${MAX_PLAN_DEPTH}.`);
  }
  const scratch = await mkdtemp(path.join("/tmp", "keel-mcp-upload-plan-"));
  try {
    const common = {
      objectName,
      mediaType,
      outputDirectory: scratch,
      ...(compression === undefined ? {} : { compression }),
      ...(maxChunkBytes === undefined ? {} : { maxChunkBytes }),
    };
    const plan = strategy === "recursive"
      ? await createRecursiveUploadPlan(source.bytes, { ...common, ...(leafDecodedBytes === undefined ? {} : { leafDecodedBytes }), ...(maxPartsPerComposite === undefined ? {} : { maxPartsPerComposite }) })
      : await createUploadPlan(source.bytes, common);
    const planBytes = new TextEncoder().encode(JSON.stringify(plan)).byteLength;
    if (planBytes > MAX_PLAN_RESPONSE_BYTES) throw new RangeError(`upload plan response exceeds the ${MAX_PLAN_RESPONSE_BYTES}-byte MCP detail limit; use larger leaves or the builder CLI for a materialized plan.`);
    return { status: "planned", dryRun: true, materialized: false, files: "unavailable-after-dry-run", strategy, plan };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function moduleResolveTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["snapshot", "selector"], "module resolve arguments");
  return resolveModule(await snapshot(context, requiredString(input, "snapshot")), selectorValue(input.selector));
}

async function chainPlanTool(context: ToolContext, value: unknown): Promise<unknown> {
  return createChainOperationPlan(context.workspace, value);
}

async function ethereumEncodeTool(context: ToolContext, value: unknown): Promise<unknown> {
  return runEthereumEncodeTool(context.workspace, value);
}

async function publishPlanTool(_context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["chainPlan"], "publish review plan arguments");
  const envelope = await createKeelPublishReviewPlan(input.chainPlan);
  return {
    status: "review-only",
    chainReady: false,
    signing: "not-performed",
    submission: "not-performed",
    envelope,
  };
}

async function moduleLockTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["snapshot", "out", "selector"], "module lock arguments");
  const result = await resolveModule(await snapshot(context, requiredString(input, "snapshot")), selectorValue(input.selector));
  if (result.status !== "bytes-unavailable" && result.status !== "resolved") throw new Error(`Module cannot be locked: ${result.status}.`);
  const out = await context.workspace.writeJson(requiredString(input, "out"), result.lock);
  const receiptEnvelope = { receipt: result.receipt, integrity: result.receiptDigest };
  const receipt = await context.workspace.writeJson(`${requiredString(input, "out")}.receipt.json`, receiptEnvelope);
  return { status: "locked", lockPath: out, receiptPath: receipt, lock: result.lock, receipt: result.receipt, receiptDigest: result.receiptDigest, bytes: "unavailable" };
}

async function walletRequestPrepareTool(_context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["request", "qr"], "wallet request arguments");
  const envelope = await createKeelWalletRequest(input.request);
  const qr = optionalBoolean(input, "qr");
  const qrPayload = qr === true ? await encodeKeelWalletRequestQr(envelope) : undefined;
  return {
    status: "prepared-only",
    signing: "not-performed",
    submission: "not-performed",
    envelope,
    ...(qrPayload === undefined ? {} : { qr: qrPayload }),
  };
}

async function walletLinkTool(_context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["link"], "wallet link arguments");
  const rawLink = record(input.link, ["family", "accountAddress", "agentAddress", "target", "scopes", "issuedAt", "expiresAt", "nonce", "transport", "revocation", "rotation", "collectionConfig"], "wallet link");
  const { collectionConfig: rawConfig, ...linkInput } = rawLink;
  const link = await createKeelWalletLink(linkInput as unknown as KeelWalletLinkInput);
  if (link.status === "deferred") return { status: "deferred", chainReady: false, walletApproval: "required", link, signing: "not-performed", submission: "not-performed" };
  if (link.revocation.status === "revoked") {
    return {
      status: "deferred",
      chainReady: false,
      walletApproval: "required",
      code: "link-revoked",
      family: "ethereum",
      issues: ["The wallet link is revoked; typed data was not emitted."],
      signing: "not-performed",
      submission: "not-performed",
      link,
    };
  }
  if (rawConfig === undefined) {
    return {
      status: "deferred",
      code: "config-verification-required",
      family: "ethereum",
      chainReady: false,
      walletApproval: "required",
      issues: ["An exact KeelFactory collectionConfig is required before emitting account-signable typed data."],
      signing: "not-performed",
      submission: "not-performed",
      link,
    };
  }
  const normalizedConfig: KeelFactoryCollectionConfig = normalizeKeelFactoryCollectionConfig(rawConfig);
  const computedDigest = createKeelFactoryConfigDigest(normalizedConfig);
  if (computedDigest !== link.target.configDigest) throw new Error("collectionConfig digest does not match wallet link.target.configDigest.");
  const typed = createCollectionAuthorizationTypedData(link.target.chainId, link.target.factoryAddress, {
    creator: link.accountAddress as `0x${string}`,
    agent: link.agentAddress as `0x${string}`,
    nonce: BigInt(link.target.authorizationNonce),
    deadline: BigInt(link.expiresAt),
    configDigest: link.target.configDigest as `0x${string}`,
  });
  const jsonTyped = {
    ...typed,
    domain: { ...typed.domain, chainId: typed.domain.chainId.toString() },
    message: { ...typed.message, nonce: typed.message.nonce.toString(), deadline: typed.message.deadline.toString() },
  };
  return {
    status: "review-only",
    chainReady: false,
    walletApproval: "required",
    signing: "not-performed",
    submission: "not-performed",
    approval: "not-granted",
    collectionConfig: normalizedConfig,
    configDigestVerified: true,
    link,
    typedData: jsonTyped,
  };
}

async function frayAuctionIntakeTool(_context: ToolContext, value: unknown): Promise<unknown> {
  return prepareFrayAuctionIntake(value);
}

async function frayStageProjectTool(context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["studioUrl", "sourcePath", "title", "description", "family", "network", "auctionPreset", "metadataMode", "releaseOutcome", "mediaType", "previewExecution", "viewerModules", "previewCapture"], "Fray stage project arguments");
  const sourcePath = requiredString(input, "sourcePath");
  if (sourcePath.startsWith("/") || sourcePath.split("/").some((part) => part === "." || part === "..")) throw new TypeError("sourcePath must be a safe workspace-relative path.");
  const loaded = await context.workspace.readFile(sourcePath, MAX_MEDIA_BYTES);
  const family = requiredString(input, "family");
  if (family !== "ethereum" && family !== "tezos") throw new TypeError("family must be ethereum or tezos.");
  const metadataMode = optionalString(input, "metadataMode") ?? "Onchain";
  if (metadataMode !== "IPFS" && metadataMode !== "Onchain") throw new TypeError("metadataMode must be IPFS or Onchain.");
  const rawOutcome = optionalString(input, "releaseOutcome");
  const releaseOutcome = rawOutcome ?? (Number(input.auctionPreset) === 1 ? "bidder" : "patrons");
  if (releaseOutcome !== "bidder" && releaseOutcome !== "patrons") throw new TypeError("releaseOutcome must be bidder or patrons.");
  const preset = input.auctionPreset;
  if (typeof preset !== "number" || !Number.isSafeInteger(preset) || preset < 1 || preset > 3) throw new TypeError("auctionPreset must be 1, 2, or 3.");
  const mediaType = optionalString(input, "mediaType") ?? inferMediaType(sourcePath);
  const title = requiredBoundedString(input, "title", 120);
  const description = requiredBoundedString(input, "description", 2_000);
  const network = requiredBoundedString(input, "network", 64);
  const previewExecution = optionalString(input, "previewExecution") ?? inferPreviewExecution(sourcePath, mediaType);
  if (previewExecution !== "none" && previewExecution !== "doom-wasm-sandbox" && previewExecution !== "html-sandbox") throw new TypeError("previewExecution is invalid.");
  const viewerModules = input.viewerModules === undefined
    ? defaultViewerModules(previewExecution)
    : parseViewerModules(input.viewerModules);
  const studioUrl = optionalString(input, "studioUrl");
  return stageFrayProject({
    ...(studioUrl === undefined ? {} : { studioUrl }),
    sourcePath,
    sourceFileName: path.basename(sourcePath),
    sourceMediaType: mediaType,
    sourceBytes: loaded.bytes,
    title,
    description,
    family,
    network,
    auctionPreset: preset as 1 | 2 | 3,
    metadataMode,
    releaseOutcome,
    previewExecution,
    viewerModules,
    ...(input.previewCapture === undefined ? {} : { previewCapture: parsePreviewCapture(input.previewCapture) }),
  });
}

function requiredBoundedString(input: Record<string, unknown>, key: string, maxLength: number): string {
  const value = requiredString(input, key).trim();
  if (value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${key} must be bounded text.`);
  return value;
}

function inferMediaType(sourcePath: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  return ({
    ".wasm": "application/wasm",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function inferPreviewExecution(sourcePath: string, mediaType: string): "none" | "doom-wasm-sandbox" | "html-sandbox" {
  if (mediaType === "text/html") return "html-sandbox";
  if (mediaType === "application/wasm" && path.basename(sourcePath).toLowerCase().includes("doom")) return "doom-wasm-sandbox";
  return "none";
}

function defaultViewerModules(execution: "none" | "doom-wasm-sandbox" | "html-sandbox"): readonly string[] {
  if (execution === "doom-wasm-sandbox") return ["render:wasm-sandbox", "verify:keel-object", "runtime:doom-wasm", "lifecycle:preview", "lifecycle:auction-reveal", "lifecycle:token-resolution"];
  if (execution === "html-sandbox") return ["render:html-sandbox", "verify:keel-object", "lifecycle:preview", "lifecycle:auction-reveal", "lifecycle:token-resolution"];
  return ["verify:keel-object", "lifecycle:preview", "lifecycle:auction-reveal"];
}

function parseViewerModules(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 120)) throw new TypeError("viewerModules must contain at most 32 non-empty module names.");
  return value as string[];
}

function parsePreviewCapture(value: unknown): FrayPreviewCapture {
  const input = record(value, ["still", "video"], "previewCapture");
  const still = record(input.still, ["mode", "atMs"], "previewCapture.still");
  const video = record(input.video, ["enabled", "mode", "atMs", "durationMs", "fps"], "previewCapture.video");
  const stillMode = requiredString(still, "mode");
  const videoMode = requiredString(video, "mode");
  if (!["hook", "timestamp", "settle"].includes(stillMode) || !["hook", "timestamp", "settle"].includes(videoMode)) throw new TypeError("preview capture mode must be hook, timestamp, or settle.");
  const enabled = video.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("previewCapture.video.enabled must be boolean.");
  const durationMs = video.durationMs;
  const fps = video.fps;
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 30_000) throw new TypeError("previewCapture.video.durationMs must be 1000-30000 milliseconds.");
  if (typeof fps !== "number" || !Number.isSafeInteger(fps) || fps < 1 || fps > 30) throw new TypeError("previewCapture.video.fps must be 1-30.");
  const atMs = (entry: Record<string, unknown>, label: string): number | undefined => {
    const candidate = entry.atMs;
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > 86_400_000) throw new TypeError(`${label}.atMs must be a non-negative millisecond timestamp.`);
    return candidate;
  };
  const stillAt = atMs(still, "previewCapture.still");
  const videoAt = atMs(video, "previewCapture.video");
  return {
    still: { mode: stillMode as FrayPreviewCapture["still"]["mode"], ...(stillAt === undefined ? {} : { atMs: stillAt }) },
    video: { enabled, mode: videoMode as FrayPreviewCapture["video"]["mode"], ...(videoAt === undefined ? {} : { atMs: videoAt }), durationMs, fps },
  };
}

async function chainGuideTool(_context: ToolContext, value: unknown): Promise<unknown> {
  return chainGuide(value);
}

async function keelLibrarySearchTool(_context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["studioUrl", "query", "limit"], "Keel index search arguments");
  const query = requiredString(input, "query");
  const studioUrl = optionalString(input, "studioUrl");
  const limit = optionalNumber(input, "limit");
  return searchKeelIndexes({ query, ...(studioUrl === undefined ? {} : { studioUrl }), ...(limit === undefined ? {} : { limit }) });
}

async function studioCapabilitiesTool(_context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["studioUrl"], "Studio capabilities arguments");
  const configured = optionalString(input, "studioUrl") ?? process.env.KEEL_STUDIO_URL;
  if (configured === undefined) {
    return {
      schema: "keel-studio-capabilities@1",
      status: "unconfigured",
      message: "Set KEEL_STUDIO_URL or pass studioUrl to inspect a Studio without uploading or opening a wallet.",
    };
  }
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new TypeError("studioUrl must use HTTPS.");
  return fetchStudioCapabilities(url);
}

async function moduleReviewPrepareTool(_context: ToolContext, value: unknown): Promise<unknown> {
  const input = record(value, ["review"], "module review arguments");
  const review = record(
    input.review,
    ["chainId", "registry", "action", "spec", "specDigest", "reviewDigest", "reasonDigest", "replacementSpecDigest", "validUntil"],
    "module review",
  );
  return buildKeelModuleReviewRequest(review as unknown as KeelModuleReviewInput);
}

function tool(name: string, description: string, inputSchema: JsonSchema, run: ToolDefinition["run"]): ToolDefinition {
  return { descriptor: { name, description, inputSchema }, run };
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  tool("analyze", "Analyze a workspace media file and report integrity and wrapper support.", TOOL_SCHEMAS.analyze, analyzeTool),
  tool("build", "Build and verify a deterministic local media artifact; no chain or wallet action occurs.", TOOL_SCHEMAS.build, buildTool),
  tool("verify", "Verify a local artifact manifest and its available relative resources.", TOOL_SCHEMAS.verify, verifyTool),
  tool("cost", "Estimate compression, chunks, recursive depth, transactions, and calldata using an offline model.", TOOL_SCHEMAS.cost, costTool),
  tool("upload-plan", "Plan flat or recursive chunk uploads from bounded local bytes without writing to the workspace or touching a chain.", TOOL_SCHEMAS.uploadPlan, uploadPlanTool),
  tool("chain-plan", "Verify a materialized upload plan and emit deterministic review-only contract operation descriptors; no ABI encoding, signing, or submission occurs.", TOOL_SCHEMAS.chainPlan, chainPlanTool),
  tool("ethereum-encode", "Encode verified local Ethereum KeelHold operations with viem for review only; no RPC, signing, submission, or QR payload is produced.", TOOL_SCHEMAS.ethereumEncode, ethereumEncodeTool),
  tool("publish-plan", "Bind a verified review-only chain descriptor to a canonical SDK envelope; no ABI encoding, signing, or submission occurs.", TOOL_SCHEMAS.publishPlan, publishPlanTool),
  tool("module-resolve", "Resolve one exact module selector from a local snapshot without fetching carriers.", TOOL_SCHEMAS.moduleResolve, moduleResolveTool),
  tool("module-lock", "Write a canonical local module lock and unavailable-by-default receipt.", TOOL_SCHEMAS.moduleLock, moduleLockTool),
  tool("wallet-request-prepare", "Prepare a canonical user-reviewable wallet request or QR payload without signing or submitting.", TOOL_SCHEMAS.walletRequestPrepare, walletRequestPrepareTool),
  tool("wallet-link", "Prepare a review-only account-to-agent KeelFactory castDieFor authorization and JSON-safe EIP-712 typed data; no signing, RPC, or submission occurs.", TOOL_SCHEMAS.walletLink, walletLinkTool),
  tool("module-review-prepare", "Prepare a review-only KeelModuleReviewRegistry action (submit/sanction/deprecate/revoke a non-contract module's on-chain trust) as a canonical descriptor; no signing, encoding, or submission occurs.", TOOL_SCHEMAS.moduleReview, moduleReviewPrepareTool),
  tool("fray-auction-intake", "Collect the title, description, chain, and one of exactly three Fray auction presets before emitting a user-approved API and wallet handoff; no signing or submission occurs.", TOOL_SCHEMAS.frayAuctionIntake, frayAuctionIntakeTool),
  tool("fray-stage-project", "Upload bounded source bytes to the configured Fray Studio temporary project store, prepare still/video previews, preflight the fee, and return a wallet-facing handoff; no signing or submission occurs.", TOOL_SCHEMAS.frayStageProject, frayStageProjectTool),
  tool("keel-chain-guide", "List supported testnets and human faucet links; the MCP server never claims faucet funds or moves wallet assets.", TOOL_SCHEMAS.chainGuide, chainGuideTool),
  tool("keel-library-search", "Search configured Keel Studio Keel indexes for exact reusable library/module candidates; metadata only, no carrier bytes are fetched.", TOOL_SCHEMAS.keelLibrarySearch, keelLibrarySearchTool),
  tool("keel-studio-capabilities", "Inspect a Studio's supported chains, zero-spend sandbox, staging, authorization, and MSP readiness before any upload or wallet action.", TOOL_SCHEMAS.studioCapabilities, studioCapabilitiesTool),
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((entry) => entry.descriptor.name === name);
}
