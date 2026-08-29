import { canonicalJson, createIntegrity, utf8ToBytes } from "@keel/protocol";
import {
  FRAY_AUCTION_POLICY_PROFILES,
  createFrayAuctionIntent,
  formatFrayAtomicAmount,
  materializeFrayAuctionIntent,
  resolveFrayAuctionPolicy,
  type FrayAuctionFamily,
  type FrayAuctionPolicyProfile,
} from "@keel/sdk";
import { createHash } from "node:crypto";

export const FRAY_AGENT_PROTOCOL = "fray-keel-agent@1" as const;
export const FRAY_APPROVAL_REQUEST_PROTOCOL = "fray-approval-request@1" as const;

export type FrayFamily = FrayAuctionFamily;

export interface FrayAuctionPreset {
  readonly id: 1 | 2 | 3;
  readonly key: "quick-test" | "standard" | "collector";
  readonly label: string;
  readonly summary: string;
}

/** Preset IDs are conversational shorthand only; exact economics come from
 * the family-specific, versioned SDK policy profile. */
export const FRAY_AUCTION_PRESETS: readonly FrayAuctionPreset[] = [
  {
    id: 1,
    key: "quick-test",
    label: "Quick test",
    summary: "One-hour bidder-only test auction.",
  },
  {
    id: 2,
    key: "standard",
    label: "Standard",
    summary: "Twenty-four-hour auction with the ordinary Fray patron round.",
  },
  {
    id: 3,
    key: "collector",
    label: "Collector",
    summary: "Three-day auction with a larger patron edition for a centerpiece work.",
  },
] as const;

export interface FaucetGuide {
  readonly directoryUrl: string;
  readonly sources: readonly { readonly name: string; readonly url: string }[];
  readonly steps: readonly string[];
  readonly agentAction: "show-links-only";
}

export interface FrayChainProfile {
  readonly family: FrayFamily;
  readonly network: string;
  readonly displayName: string;
  readonly chainId?: number;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: 6 | 18 };
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly faucet?: FaucetGuide;
  readonly walletApproval: {
    readonly preferred: "eip-5792" | "beacon-batch";
    readonly fallback: "sequential-wallet-approvals";
    /** Optional deployed EVM carrier batcher; the creator-bound registry write
     * remains a direct wallet call so the object authority stays correct. */
    readonly contractFallback: "keel-carrier-batcher-then-creator-write";
    readonly oneSignature: "capability-dependent";
  };
  /** The production-friendly path for large immutable Keel media: one
   * creator transaction opens a bounded job, then a funded executor resumes
   * the carrier writes without reopening the wallet. */
  readonly managedPublication?: {
    readonly protocol: "keel-publication-job@1";
    readonly walletAction: "open-job";
    readonly execution: "executor-resumes-split-writes";
    readonly userApprovals: 1;
    readonly requires: readonly ["deployed-job", "funded-executor", "creator-preserving-registry"];
  };
}

/**
 * Testnet discovery is intentionally data-only. Faucet claims remain a
 * human action so an agent cannot drain or redirect a wallet by surprise.
 */
export const FRAY_CHAIN_PROFILES: readonly FrayChainProfile[] = [
  {
    family: "ethereum",
    network: "sepolia",
    displayName: "Ethereum Sepolia",
    chainId: 11_155_111,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
    faucet: {
      directoryUrl: "https://ethereum.org/developers/docs/networks/",
      sources: [
        { name: "Alchemy Sepolia Faucet", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
        { name: "QuickNode Sepolia Faucet", url: "https://faucet.quicknode.com/ethereum/sepolia" },
        { name: "Sepolia PoW Faucet", url: "https://sepolia-faucet.pk910.de/" },
      ],
      steps: [
        "Switch the wallet to Ethereum Sepolia.",
        "Open one of the listed faucet pages and enter the wallet address yourself.",
        "Wait for the balance to appear before approving the release request.",
      ],
      agentAction: "show-links-only",
    },
    walletApproval: { preferred: "eip-5792", fallback: "sequential-wallet-approvals", contractFallback: "keel-carrier-batcher-then-creator-write", oneSignature: "capability-dependent" },
    managedPublication: {
      protocol: "keel-publication-job@1",
      walletAction: "open-job",
      execution: "executor-resumes-split-writes",
      userApprovals: 1,
      requires: ["deployed-job", "funded-executor", "creator-preserving-registry"],
    },
  },
  {
    family: "ethereum",
    network: "base-sepolia",
    displayName: "Base Sepolia",
    chainId: 84_532,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia-explorer.base.org",
    faucet: {
      directoryUrl: "https://docs.base.org/learn/onchain-concepts/using-testnets",
      sources: [
        { name: "Alchemy Base Sepolia Faucet", url: "https://www.alchemy.com/faucets/base-sepolia" },
        { name: "QuickNode Base Sepolia Faucet", url: "https://faucet.quicknode.com/base/sepolia" },
      ],
      steps: [
        "Switch the wallet to Base Sepolia.",
        "Open a faucet page and enter the wallet address yourself.",
        "Wait for the balance to appear before approving the release request.",
      ],
      agentAction: "show-links-only",
    },
    walletApproval: { preferred: "eip-5792", fallback: "sequential-wallet-approvals", contractFallback: "keel-carrier-batcher-then-creator-write", oneSignature: "capability-dependent" },
    managedPublication: {
      protocol: "keel-publication-job@1",
      walletAction: "open-job",
      execution: "executor-resumes-split-writes",
      userApprovals: 1,
      requires: ["deployed-job", "funded-executor", "creator-preserving-registry"],
    },
  },
  {
    family: "tezos",
    network: "shadownet",
    displayName: "Tezos Shadownet",
    nativeCurrency: { name: "tez", symbol: "ꜩ", decimals: 6 },
    rpcUrl: "https://rpc.shadownet.teztnets.com",
    explorerUrl: "https://shadownet.tzkt.io",
    faucet: {
      directoryUrl: "https://teztnets.com/shadownet-about",
      sources: [{ name: "Shadownet Faucet", url: "https://faucet.shadownet.teztnets.com/" }],
      steps: [
        "Switch the Beacon/Temple wallet to Shadownet.",
        "Open the faucet and enter the tz1 address yourself.",
        "Wait for the balance and, for a new account, initialize it with a wallet transaction.",
      ],
      agentAction: "show-links-only",
    },
    walletApproval: { preferred: "beacon-batch", fallback: "sequential-wallet-approvals", contractFallback: "keel-carrier-batcher-then-creator-write", oneSignature: "capability-dependent" },
  },
] as const;

export interface FrayAuctionIntakeInput {
  readonly sourcePath?: string;
  readonly title?: string;
  readonly description?: string;
  readonly useDefaultDescription?: boolean;
  readonly auctionPreset?: number;
  readonly family?: FrayFamily;
  readonly network?: string;
  readonly reuseQuery?: string;
}

export interface FrayPreviewCapture {
  readonly still: {
    readonly mode: "hook" | "timestamp" | "settle";
    readonly atMs?: number;
  };
  readonly video: {
    readonly enabled: boolean;
    readonly mode: "hook" | "timestamp" | "settle";
    readonly atMs?: number;
    readonly durationMs: number;
    readonly fps: number;
  };
}

export interface FrayStageProjectInput {
  readonly studioUrl?: string;
  readonly sourcePath: string;
  readonly sourceFileName: string;
  readonly sourceMediaType: string;
  readonly sourceBytes: Uint8Array;
  readonly title: string;
  readonly description: string;
  readonly family: FrayFamily;
  readonly network: string;
  readonly auctionPreset: 1 | 2 | 3;
  readonly metadataMode: "IPFS" | "Onchain";
  readonly releaseOutcome: "bidder" | "patrons";
  readonly previewExecution: "none" | "doom-wasm-sandbox" | "html-sandbox";
  readonly viewerModules: readonly string[];
  readonly previewCapture?: FrayPreviewCapture;
}

interface IntakeQuestion {
  readonly field: "title" | "description" | "auctionPreset" | "chain";
  readonly question: string;
  readonly options?: readonly string[];
}

function boundedText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be non-empty text of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function parseFrayAuctionIntakeInput(value: unknown): FrayAuctionIntakeInput {
  const input = record(value, "Fray auction intake arguments");
  exactKeys(input, ["sourcePath", "title", "description", "useDefaultDescription", "auctionPreset", "family", "network", "reuseQuery"], "Fray auction intake arguments");
  const sourcePath = boundedText(input.sourcePath, "sourcePath", 1_024);
  if (sourcePath !== undefined && (sourcePath.startsWith("/") || sourcePath.split("/").some((part) => part === "." || part === ".."))) {
    throw new TypeError("sourcePath must be a safe workspace-relative path.");
  }
  const title = boundedText(input.title, "title", 160);
  const description = boundedText(input.description, "description", 2_000);
  const useDefaultDescription = input.useDefaultDescription;
  if (useDefaultDescription !== undefined && typeof useDefaultDescription !== "boolean") throw new TypeError("useDefaultDescription must be boolean.");
  const rawAuctionPreset = input.auctionPreset;
  const auctionPreset = rawAuctionPreset === undefined
    ? undefined
    : typeof rawAuctionPreset === "number"
      ? rawAuctionPreset
      : (() => { throw new TypeError("auctionPreset must be 1, 2, or 3."); })();
  if (auctionPreset !== undefined && (!Number.isSafeInteger(auctionPreset) || auctionPreset < 1 || auctionPreset > 3)) throw new TypeError("auctionPreset must be 1, 2, or 3.");
  const rawFamily = input.family;
  const family = rawFamily === undefined
    ? undefined
    : rawFamily === "ethereum" || rawFamily === "tezos"
      ? rawFamily
      : (() => { throw new TypeError("family must be ethereum or tezos."); })();
  const network = boundedText(input.network, "network", 64);
  const reuseQuery = boundedText(input.reuseQuery, "reuseQuery", 160);
  return { ...(sourcePath === undefined ? {} : { sourcePath }), ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...(useDefaultDescription === undefined ? {} : { useDefaultDescription }), ...(auctionPreset === undefined ? {} : { auctionPreset }), ...(family === undefined ? {} : { family }), ...(network === undefined ? {} : { network }), ...(reuseQuery === undefined ? {} : { reuseQuery }) };
}

function findChainProfile(family: FrayFamily | undefined, network: string | undefined): FrayChainProfile | undefined {
  if (family === undefined || network === undefined) return undefined;
  const normalizedNetwork = network?.toLowerCase().replaceAll("_", "-");
  return FRAY_CHAIN_PROFILES.find((profile) => {
    if (profile.family !== family) return false;
    return profile.network === normalizedNetwork || profile.displayName.toLowerCase().replaceAll(" ", "-") === normalizedNetwork || String(profile.chainId) === normalizedNetwork;
  });
}

function policyReview(profile: FrayAuctionPolicyProfile): Record<string, unknown> {
  return {
    policy: { protocol: "fray-auction-policy@1", presetId: profile.presetId, presetKey: profile.presetKey },
    family: profile.family,
    nativeCurrency: profile.nativeCurrency,
    terms: profile.terms,
    display: {
      label: profile.label,
      summary: profile.summary,
      reserve: `${formatFrayAtomicAmount(profile.terms.reserveAtomic, profile.nativeCurrency.decimals)} ${profile.nativeCurrency.symbol}`,
      bidIncrement: `${formatFrayAtomicAmount(profile.terms.bidIncrementAtomic, profile.nativeCurrency.decimals)} ${profile.nativeCurrency.symbol}`,
    },
  };
}

function presetOptions(family: FrayFamily | undefined): readonly string[] {
  return FRAY_AUCTION_PRESETS.map((preset) => {
    if (family === undefined) return `${preset.id}. ${preset.label} — ${preset.summary} Choose a chain to see exact currency amounts.`;
    const profile = resolveFrayAuctionPolicy(family, preset.id);
    const reserve = formatFrayAtomicAmount(profile.terms.reserveAtomic, profile.nativeCurrency.decimals);
    const increment = formatFrayAtomicAmount(profile.terms.bidIncrementAtomic, profile.nativeCurrency.decimals);
    return `${preset.id}. ${preset.label} — reserve ${reserve} ${profile.nativeCurrency.symbol}; minimum bid +${increment} ${profile.nativeCurrency.symbol}; maximum edition ${profile.terms.maximumEditionSize.toString()}.`;
  });
}

async function requestDigest(value: unknown): Promise<`0x${string}`> {
  const canonical = canonicalJson(value);
  return (await createIntegrity(utf8ToBytes(canonical))).digest as `0x${string}`;
}

function missingQuestions(input: FrayAuctionIntakeInput): readonly IntakeQuestion[] {
  const questions: IntakeQuestion[] = [];
  if (input.title === undefined) questions.push({ field: "title", question: "What should I call the artwork?" });
  if (input.description === undefined && input.useDefaultDescription !== true) {
    questions.push({ field: "description", question: "What description should I use? Reply with your text, or say `default` and I’ll use a short Keel/Fray description." });
  }
  if (input.auctionPreset === undefined) questions.push({ field: "auctionPreset", question: "Which auction setup should I use? Pick 1, 2, or 3.", options: presetOptions(input.family) });
  if (findChainProfile(input.family, input.network) === undefined) questions.push({ field: "chain", question: "Which supported testnet should receive it?", options: FRAY_CHAIN_PROFILES.map((profile) => `${profile.family} · ${profile.network} · ${profile.displayName}`) });
  return questions;
}

export async function prepareFrayAuctionIntake(value: unknown): Promise<unknown> {
  const input = parseFrayAuctionIntakeInput(value);
  const questions = missingQuestions(input);
  const profile = findChainProfile(input.family, input.network);
  if (questions.length > 0 || profile === undefined) {
    return {
      schema: FRAY_AGENT_PROTOCOL,
      status: "needs-input",
      questions,
      auctionPresets: FRAY_AUCTION_PRESETS,
      auctionPolicies: FRAY_AUCTION_POLICY_PROFILES.map(policyReview),
      supportedChains: FRAY_CHAIN_PROFILES,
      wallet: { signing: "not-performed", submission: "not-performed" },
    };
  }
  const preset = FRAY_AUCTION_PRESETS.find((candidate) => candidate.id === input.auctionPreset);
  if (preset === undefined) throw new Error("The selected auction preset is not available.");
  const auctionPolicy = resolveFrayAuctionPolicy(profile.family, preset.id);
  const description = input.description ?? `${input.title} — a Fray auction published through the Keel protocol.`;
  const approvalBody = {
    protocol: FRAY_APPROVAL_REQUEST_PROTOCOL,
    title: input.title,
    description,
    chain: { family: profile.family, network: profile.network, ...(profile.chainId === undefined ? {} : { chainId: profile.chainId }) },
    auctionPolicy: policyReview(auctionPolicy),
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    ...(input.reuseQuery === undefined ? {} : { reuseQuery: input.reuseQuery }),
  };
  const planDigest = await requestDigest(approvalBody);
  return {
    schema: FRAY_AGENT_PROTOCOL,
    status: "ready-for-approval",
    approvalRequest: {
      protocol: FRAY_APPROVAL_REQUEST_PROTOCOL,
      requestId: `fray-${planDigest.slice(2, 18)}`,
      planDigest,
      api: {
        method: "POST",
        path: "/api/agent/approval-requests",
        scope: "publication.prepare",
        body: approvalBody,
        userApprovalRequired: true,
      },
      wallet: {
        family: profile.family,
        network: profile.network,
        preferred: profile.walletApproval.preferred,
        fallback: profile.walletApproval.fallback,
        oneSignature: profile.walletApproval.oneSignature,
        signing: "not-performed",
        submission: "not-performed",
      },
    },
    title: input.title,
    description,
    descriptionSource: input.description === undefined ? "agent-default" : "user",
    chain: profile,
    auction: policyReview(auctionPolicy),
    moduleReuse: input.reuseQuery === undefined
      ? { status: "not-requested", next: "Search the Keel indexes before uploading a library candidate." }
      : { status: "search-required", query: input.reuseQuery, next: "Call keel-library-search and bind only an exact verified candidate." },
    wallet: { signing: "not-performed", submission: "not-performed", approval: "required" },
  };
}

/** Stage source bytes in the Studio's temporary project store and return a
 * wallet-facing handoff. The agent token is only used for this server-to-server
 * upload; it never has wallet authority and is never returned. */
export async function stageFrayProject(input: FrayStageProjectInput): Promise<unknown> {
  const base = safeStudioBase(input.studioUrl ?? process.env.KEEL_STUDIO_URL ?? process.env.FRAY_STUDIO_URL);
  if (base === undefined) {
    return {
      schema: FRAY_AGENT_PROTOCOL,
      status: "unconfigured",
      message: "Set KEEL_STUDIO_URL and FRAY_STUDIO_AGENT_TOKEN to stage a project in the Studio. FRAY_STUDIO_URL remains a deprecated compatibility alias.",
      wallet: { signing: "not-performed", submission: "not-performed" },
    };
  }
  const token = process.env.FRAY_STUDIO_AGENT_TOKEN;
  if (token === undefined || token.length < 32) {
    return {
      schema: FRAY_AGENT_PROTOCOL,
      status: "unconfigured",
      studioUrl: base,
      message: "FRAY_STUDIO_AGENT_TOKEN is not configured. No source bytes were uploaded.",
      wallet: { signing: "not-performed", submission: "not-performed" },
    };
  }
  const profile = findChainProfile(input.family, input.network);
  if (profile === undefined) {
    return {
      schema: FRAY_AGENT_PROTOCOL,
      status: "needs-input",
      questions: [{ field: "chain", question: "Which supported testnet should receive it?", options: FRAY_CHAIN_PROFILES.map((value) => `${value.family} · ${value.network} · ${value.displayName}`) }],
      wallet: { signing: "not-performed", submission: "not-performed" },
    };
  }
  if (input.sourceBytes.byteLength === 0 || input.sourceBytes.byteLength > 256 * 1024 * 1024) throw new TypeError("sourceBytes must be between 1 byte and 256 MiB.");
  const needsCapture = input.sourceMediaType === "text/html" || input.sourceMediaType.startsWith("video/") || input.sourceMediaType === "application/wasm";
  if (needsCapture && input.previewCapture === undefined) {
    return {
      schema: FRAY_AGENT_PROTOCOL,
      status: "needs-input",
      questions: [
        { field: "stillPreview", question: "When should I capture the still preview? Choose hook, timestamp (milliseconds), or settle." },
        { field: "videoPreview", question: "When should the preview video begin? Choose hook, timestamp (milliseconds), or settle, and provide duration and fps. The default is a three-second, twelve-fps preview." },
      ],
      wallet: { signing: "not-performed", submission: "not-performed" },
    };
  }
  const sourceHash = createHash("sha256");
  sourceHash.update(Buffer.from(input.sourceBytes));
  const sourceSha256 = `0x${sourceHash.digest().toString("hex")}`;
  const auctionIntent = await createFrayAuctionIntent(materializeFrayAuctionIntent({
    source: { algorithm: "sha256", digest: sourceSha256 as `0x${string}`, byteLength: input.sourceBytes.byteLength },
    family: profile.family,
    network: profile.network,
    ...(profile.family === "ethereum" ? { chainId: profile.chainId } : {}),
    presetId: input.auctionPreset,
  }));
  if (auctionIntent.intent.terms.releaseOutcome !== input.releaseOutcome) throw new TypeError("releaseOutcome must match the versioned Fray auction policy.");
  const requestId = `fray-${sourceSha256.slice(2, 18)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const chain = chainSlug(profile.family, profile.network);
  const capture = input.previewCapture ?? defaultPreviewCapture();
  const stageBody = {
    requestId,
    family: profile.family === "ethereum" ? "evm" : "tezos",
    chain,
    title: input.title,
    description: input.description,
    medium: input.sourceMediaType,
    sourceFileName: input.sourceFileName,
    sourceMediaType: input.sourceMediaType,
    sourceSha256,
    previewExecution: input.previewExecution,
    viewerModules: input.viewerModules,
    metadataMode: input.metadataMode === "Onchain" ? "onchain" : "ipfs",
    auctionPreset: String(input.auctionPreset),
    auctionIntent,
    releaseOutcome: input.releaseOutcome,
    previewCapture: capture,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  const result = await uploadFrayStage(base, token, input.sourceBytes, sourceSha256, stageBody);
  const stagingTicket = result.staging.capability;
  const staging = {
    id: result.staging.id,
    requestId: typeof result.staging.requestId === "string" ? result.staging.requestId : requestId,
    expiresAt: typeof result.staging.expiresAt === "string" ? result.staging.expiresAt : undefined,
  };
  const handoff = {
    protocol: "fray-agent-handoff@1",
    requestId,
    chain,
    family: profile.family === "ethereum" ? "evm" : "tezos",
    title: input.title,
    description: input.description,
    medium: input.sourceMediaType,
    sourceFileName: input.sourceFileName,
    sourceMediaType: input.sourceMediaType,
    sourceSha256,
    sourceByteLength: input.sourceBytes.byteLength,
    previewExecution: input.previewExecution,
    viewerModules: input.viewerModules,
    staging: { id: staging.id, capability: stagingTicket },
    previewCapture: capture,
    metadataMode: input.metadataMode,
    auctionPreset: String(input.auctionPreset),
    auctionIntent,
    releaseOutcome: input.releaseOutcome,
  };
  const encoded = Buffer.from(JSON.stringify(handoff), "utf8").toString("base64url");
  const handoffUrl = `${base}${input.family === "tezos" ? "/tez/studio" : "/eth/studio"}?frayHandoff=${encoded}`;
  const feeEstimate: unknown = profile.family === "tezos"
    ? { status: "refresh-on-open", nativeSymbol: "ꜩ", message: "The Studio will read the Tezos fee floor and XTZ/USD reference after the creator opens the one-use handoff." }
    : { status: "refresh-on-open", nativeSymbol: "ETH", message: "The Studio will read the current network fee after the creator opens the one-use handoff." };
  return {
    schema: FRAY_AGENT_PROTOCOL,
    status: "ready-for-wallet-review",
    studioUrl: base,
    staging,
    handoffUrl,
    source: { fileName: input.sourceFileName, mediaType: input.sourceMediaType, sha256: sourceSha256, byteLength: input.sourceBytes.byteLength },
    auctionIntent,
    previews: { capture, generatedBy: "Studio Keel preview services", still: "prepared", video: capture.video.enabled ? "prepared" : "disabled" },
    feeEstimate: { preflight: feeEstimate, refreshOnOpen: true, walletRemainsFinal: true },
    wallet: { signing: "not-performed", submission: "not-performed", approval: "required-in-Studio" },
    next: "Open handoffUrl, sign in with the creator wallet, review the preview and live fee, then approve the wallet requests.",
  };
}

interface FrayStageResponse {
  readonly staging?: { readonly id?: unknown; readonly capability?: unknown; readonly requestId?: unknown; readonly expiresAt?: unknown };
  readonly stage?: unknown;
  readonly error?: unknown;
}

async function uploadFrayStage(
  base: string,
  token: string,
  sourceBytes: Uint8Array,
  sourceSha256: string,
  stage: Record<string, unknown>,
): Promise<FrayStageResponse & { staging: { id: string; capability: string; requestId?: unknown; expiresAt?: unknown } }> {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const opened = await fetch(`${base}/api/agent/staging/uploads`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: stage.requestId,
      sourceSha256,
      sourceByteLength: sourceBytes.byteLength,
    }),
  });
  if (opened.ok) {
    const value = await opened.json() as { upload?: { id?: unknown; token?: unknown; partBytes?: unknown }; error?: unknown };
    if (value.upload === undefined || typeof value.upload.id !== "string" || typeof value.upload.token !== "string" || !Number.isInteger(value.upload.partBytes) || Number(value.upload.partBytes) <= 0) {
      throw new Error(typeof value.error === "string" ? value.error : "Studio returned an invalid resumable upload session.");
    }
    const partBytes = Number(value.upload.partBytes);
    const chunks: Array<{ index: number; sha256: string; byteLength: number }> = [];
    for (let index = 0, offset = 0; offset < sourceBytes.byteLength; index += 1, offset += partBytes) {
      const bytes = sourceBytes.slice(offset, Math.min(offset + partBytes, sourceBytes.byteLength));
      const chunkHash = createHash("sha256");
      chunkHash.update(Buffer.from(bytes));
      const sha256 = `0x${chunkHash.digest("hex")}`;
      const stored = await fetch(`${base}/api/agent/staging/uploads/${encodeURIComponent(value.upload.id)}/parts/${index.toString()}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": bytes.byteLength.toString(),
          "content-type": "application/octet-stream",
          "x-fray-chunk-sha256": sha256,
          "x-fray-upload-token": value.upload.token,
        },
        body: Buffer.from(bytes),
      });
      if (!stored.ok) throw new Error(await studioError(stored, "Studio could not store a resumable upload chunk."));
      chunks.push({ index, sha256, byteLength: bytes.byteLength });
    }
    const completed = await fetch(`${base}/api/agent/staging/uploads/${encodeURIComponent(value.upload.id)}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ uploadToken: value.upload.token, chunks, stage }),
    });
    return parseFrayStageResponse(completed);
  }
  if (![404, 405, 503].includes(opened.status)) throw new Error(await studioError(opened, "Studio could not open a resumable upload."));
  const legacy = await fetch(`${base}/api/agent/staging`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...stage, sourceBytesBase64: Buffer.from(sourceBytes).toString("base64") }),
  });
  return parseFrayStageResponse(legacy);
}

async function parseFrayStageResponse(response: Response): Promise<FrayStageResponse & { staging: { id: string; capability: string; requestId?: unknown; expiresAt?: unknown } }> {
  const result = await response.json() as FrayStageResponse;
  if (!response.ok || result.staging === undefined || typeof result.staging.id !== "string" || typeof result.staging.capability !== "string") {
    throw new Error(typeof result.error === "string" ? result.error : `Studio staging returned HTTP ${response.status}.`);
  }
  return result as FrayStageResponse & { staging: { id: string; capability: string; requestId?: unknown; expiresAt?: unknown } };
}

async function studioError(response: Response, fallback: string): Promise<string> {
  const value = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof value?.error === "string" ? value.error : `${fallback} HTTP ${response.status}.`;
}

function defaultPreviewCapture(): FrayPreviewCapture {
  return { still: { mode: "hook" }, video: { enabled: true, mode: "hook", durationMs: 3_000, fps: 12 } };
}

function chainSlug(family: FrayFamily, network: string): string {
  const normalized = network.toLowerCase().replaceAll("_", "-");
  return `${family === "ethereum" ? "ethereum" : "tezos"}-${normalized}`;
}

function safeStudioBase(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("studioUrl must be an absolute URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new TypeError("studioUrl must use HTTPS, except for loopback development.");
  if (url.username || url.password) throw new TypeError("studioUrl must not contain credentials.");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/u, "");
}

async function readJson(url: string, label: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 512 * 1024) throw new Error(`${label} response is too large.`);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function arrayField(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const field = (value as Record<string, unknown>)[key];
  if (!Array.isArray(field)) return [];
  return field.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry)).slice(0, 100);
}

function libraryCandidate(value: Record<string, unknown>): Record<string, unknown> {
  return {
    source: "keel-library-index",
    name: value.name,
    description: value.description,
    chainId: value.chainId,
    registry: value.registry,
    assetId: value.assetId,
    policyVersion: value.policyVersion,
    policyCommitment: value.policyCommitment,
    graphVersion: value.graphVersion,
    role: value.role,
    format: value.format,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    license: value.license,
    tags: value.tags,
    verifiedUses: value.verifiedUses,
    frozen: value.frozen,
    closed: value.closed,
    selection: {
      assetId: value.assetId,
      registry: value.registry,
      policyVersion: value.policyVersion,
      policyCommitment: value.policyCommitment,
      updateMode: "locked",
    },
  };
}

export async function searchKeelIndexes(input: { readonly studioUrl?: string; readonly query: string; readonly limit?: number }): Promise<unknown> {
  const query = boundedText(input.query, "query", 160);
  if (query === undefined) throw new TypeError("query is required.");
  const base = safeStudioBase(input.studioUrl ?? process.env.KEEL_STUDIO_URL);
  if (base === undefined) return { schema: FRAY_AGENT_PROTOCOL, status: "unconfigured", query, message: "Set KEEL_STUDIO_URL or pass studioUrl to search a live Keel index. No carrier bytes were fetched." };
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 20)));
  const encoded = encodeURIComponent(query);
  const [libraryResult, moduleResult] = await Promise.allSettled([
    readJson(`${base}/api/library?q=${encoded}`, "Keel Library index"),
    readJson(`${base}/api/modules?q=${encoded}`, "Keel module catalogue"),
  ]);
  const library = libraryResult.status === "fulfilled" ? arrayField(libraryResult.value, "assets").slice(0, limit).map(libraryCandidate) : [];
  const modules = moduleResult.status === "fulfilled" ? arrayField(moduleResult.value, "modules").slice(0, limit) : [];
  const errors = [
    ...(libraryResult.status === "rejected" ? [`library: ${libraryResult.reason instanceof Error ? libraryResult.reason.message : String(libraryResult.reason)}`] : []),
    ...(moduleResult.status === "rejected" ? [`modules: ${moduleResult.reason instanceof Error ? moduleResult.reason.message : String(moduleResult.reason)}`] : []),
  ];
  const total = library.length + modules.length;
  return {
    schema: FRAY_AGENT_PROTOCOL,
    status: errors.length === 2 ? "unavailable" : errors.length === 1 ? "partial" : "ok",
    studioUrl: base,
    query,
    library,
    modules,
    reuse: total === 0
      ? { status: "none", action: "upload-new-bytes" }
      : total === 1
        ? { status: "candidate", action: "bind-after-exact-integrity-and-license-review" }
        : { status: "needs-selection", action: "ask-the-creator-to-select-one-exact-release" },
    errors,
    carriers: "metadata-only; no carrier bytes were fetched or verified",
  };
}

export function chainGuide(value: unknown): unknown {
  const input = record(value ?? {}, "chain guide arguments");
  exactKeys(input, ["family", "network"], "chain guide arguments");
  const family = input.family;
  if (family !== undefined && family !== "ethereum" && family !== "tezos") throw new TypeError("family must be ethereum or tezos.");
  const network = boundedText(input.network, "network", 64)?.toLowerCase();
  const profiles = FRAY_CHAIN_PROFILES.filter((profile) => (family === undefined || profile.family === family) && (network === undefined || profile.network === network || String(profile.chainId) === network));
  return { schema: FRAY_AGENT_PROTOCOL, status: profiles.length === 0 ? "not-found" : "ok", chains: profiles, faucetAction: "show-links-only" };
}
