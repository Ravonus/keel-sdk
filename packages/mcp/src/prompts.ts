import type { McpPrompt, McpPromptResult } from "./types.js";

export const KEEL_ASSET_REVIEW_PROMPT = "keel-asset-review" as const;
export const FRAY_AUCTION_REVIEW_PROMPT = "fray-auction-review" as const;

const PROMPT_ARGUMENTS = [
  { name: "input", description: "Workspace-relative media path to review.", required: true },
  { name: "objectName", description: "Optional metadata-safe Keel object name." },
  { name: "mediaType", description: "Optional printable UTF-8 media type." },
] as const;

export const PROMPT_DEFINITIONS: readonly McpPrompt[] = [{
  name: KEEL_ASSET_REVIEW_PROMPT,
  description: "Guide an agent through an offline Keel asset analysis and human-reviewed upload workflow.",
  arguments: PROMPT_ARGUMENTS,
}, {
  name: FRAY_AUCTION_REVIEW_PROMPT,
  description: "Guide an agent through a Fray auction intake, Keel reuse search, and user approval handoff.",
}];

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function promptText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f\\]/u.test(value)) throw new TypeError(`${label} must be bounded text.`);
  return value;
}

function metadataSafeName(value: unknown, label: string): string {
  const name = promptText(value, label, 128);
  if (name === "." || name === ".." || name.includes("/")) throw new TypeError(`${label} must be a metadata-safe name.`);
  return name;
}

function workspacePath(value: unknown, label: string): string {
  const pathValue = promptText(value, label, 1024);
  if (pathValue.startsWith("/") || pathValue.split("/").some((part) => part === "." || part === "..")) throw new TypeError(`${label} must be a safe workspace-relative path.`);
  return pathValue;
}

function boundedMediaType(value: unknown, label: string): string {
  const media = promptText(value, label, 128);
  if (new TextEncoder().encode(media).byteLength > 128) throw new TypeError(`${label} exceeds its UTF-8 byte limit.`);
  return media;
}

function quote(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function promptArguments(value: unknown): { readonly input: string; readonly objectName?: string; readonly mediaType?: string } {
  const input = object(value ?? {}, "prompt arguments");
  exact(input, ["input", "objectName", "mediaType"], "prompt arguments");
  return {
    input: workspacePath(input.input, "prompt arguments.input"),
    ...(input.objectName === undefined ? {} : { objectName: metadataSafeName(input.objectName, "prompt arguments.objectName") }),
    ...(input.mediaType === undefined ? {} : { mediaType: boundedMediaType(input.mediaType, "prompt arguments.mediaType") }),
  };
}

export function getKeelAssetReviewPrompt(name: unknown, argumentsValue: unknown): McpPromptResult {
  if (name !== KEEL_ASSET_REVIEW_PROMPT) throw new TypeError(`Unknown prompt: ${String(name)}.`);
  const args = promptArguments(argumentsValue);
  const objectLine = args.objectName === undefined ? "Let the analysis suggest a metadata-safe object name." : `Use object name ${quote(args.objectName)}.`;
  const mediaLine = args.mediaType === undefined ? "Infer and report the media type; do not silently coerce it." : `Use media type ${quote(args.mediaType)}.`;
  return {
    description: "Offline, review-only Keel asset workflow.",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "Review a Keel asset without fetching, executing, signing, or submitting anything.",
          `Start with the analyze tool for ${quote(args.input)}, then compare modeled cost options with cost and plan a deterministic flat or recursive upload with upload-plan.`,
          "If a materialized artifact is explicitly available, build and verify it before preparing any chain request.",
          "When the asset uses a local module snapshot, resolve an exact module and write a lock only when its catalog receipt is available; bytes-unavailable is not content verification.",
          "Use chain-plan only for local, review-only operation descriptors, then publish-plan to bind a canonical SDK review envelope; ABI encoding, wallet approval, signing, and submission remain separate human-approved steps.",
          "For a materialized Ethereum plan, ethereum-encode may derive and display exact unsigned KeelHold calldata; it does not query, simulate, sign, submit, or create a QR payload.",
          "For account-to-agent collection creation, wallet-link must receive the exact KeelFactory collectionConfig, verify its Keccak digest against the target, and only then return JSON-safe EIP-712 typed data; missing or mismatched config stays deferred, the account must review/sign separately, and MCP never approves custody or submits.",
          "At Studio staging, supply only creator resources/modules. Omitting viewer selects Studio's canonical KEEL Inline graph for later preparation; `none` is the explicit artifact/storage-only opt-out. Never manufacture or upload a default KEEL shell, protected-harness wrapper, or local wrapper when catalog resolution fails; Studio must fail closed for an incomplete selected-chain catalog during preparation. Creator-authored HTML is project content, not a replacement shell.",
          "Report unavailable carriers and modeled estimates honestly, and never call a URI proof of bytes.",
          objectLine,
          mediaLine,
        ].join(" "),
      },
    }],
  };
}

export function getFrayAuctionReviewPrompt(name: unknown, argumentsValue: unknown): McpPromptResult {
  if (name !== FRAY_AUCTION_REVIEW_PROMPT) throw new TypeError(`Unknown prompt: ${String(name)}.`);
  const args = object(argumentsValue ?? {}, "prompt arguments");
  exact(args, [], "prompt arguments");
  return {
    description: "Fray auction intake, reuse, and approval workflow.",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          "Prepare a Fray auction through Keel, but do not sign, submit, claim faucet funds, or report a mint/upload without receipts.",
          "Call fray-auction-intake first. If title or description is missing, ask for it; the creator may choose the short default description.",
          "Offer exactly three auction setups and accept only 1, 2, or 3: Quick test, Standard, or Collector. Do not invent a fourth preset or silently choose one when the creator has not selected it.",
          "If the chain is missing, call keel-chain-guide and ask for a supported testnet. Faucet entries are links for the creator to open and claim manually.",
          "If the request names Three.js or another reusable dependency, call keel-library-search against the configured Keel Studio URL before planning new bytes. Use only an exact, policy/license-compatible candidate; ambiguous matches require creator selection.",
          "When a source path is available, call fray-stage-project after intake. For scripts, WASM, HTML, or video, ask when to capture the still and when the video should begin: hook, timestamp, or settle; collect duration and fps for video. The default is a three-second, twelve-fps hook preview only when the creator chooses the default.",
          "Show the returned Studio handoff URL. Explain that the agent staged the project but the creator's Studio wallet sign-in attaches it to the correct account. Show the fee preflight and say the Studio refreshes it on open; the wallet is still the final fee authority.",
          "When intake is complete, show the digest-bound fray-approval-request envelope, API scope, module bindings, and wallet mode. Prefer EIP-5792 on EVM or a Beacon batch on Tezos when the connected wallet supports it. If EIP-5792 is unavailable and Studio has a verified Keel carrier batcher configured, use it for immutable carriers and content descriptors, then keep the creator-bound logical registry write as a direct wallet approval; otherwise show sequential approvals. Stop and wait for the creator's approval.",
        ].join(" "),
      },
    }],
  };
}

export function promptByName(name: string): McpPrompt | undefined {
  return PROMPT_DEFINITIONS.find((prompt) => prompt.name === name);
}
