import type { McpPrompt, McpPromptResult } from "./types.js";

export const KEEL_ASSET_REVIEW_PROMPT = "keel-asset-review" as const;
export const KEEL_DRAFT_REPAIR_PROMPT = "keel-draft-repair" as const;
export const FRAY_AUCTION_REVIEW_PROMPT = "fray-auction-review" as const;
export const KEEL_PROJECT_PLAN_PROMPT = "keel-project-plan" as const;

const PROMPT_ARGUMENTS = [
  { name: "input", description: "Workspace-relative media path to review.", required: true },
  { name: "objectName", description: "Optional metadata-safe Keel object name." },
  { name: "mediaType", description: "Optional printable UTF-8 media type." },
] as const;

export const PROMPT_DEFINITIONS: readonly McpPrompt[] = [{
  name: KEEL_PROJECT_PLAN_PROMPT,
  description: "Discover a creator's intent and return an explicit, review-only plan for a KEEL 1/1, collection, sale, or Fray auction.",
  arguments: [
    { name: "request", description: "What the creator wants to make or test.", required: true },
    { name: "scope", description: "Optional one-of-one or collection scope." },
    { name: "runtime", description: "Optional static, p5, three, doom-wasm, flash-as3, or other runtime." },
    { name: "outcome", description: "Optional storage-only, release, fixed-price, claim, or fray-auction outcome." },
    { name: "chain", description: "Optional requested chain or testnet." },
  ],
}, {
  name: KEEL_ASSET_REVIEW_PROMPT,
  description: "Guide an agent through an offline Keel asset analysis and human-reviewed upload workflow.",
  arguments: PROMPT_ARGUMENTS,
}, {
  name: KEEL_DRAFT_REPAIR_PROMPT,
  description: "Repair one exact Studio draft revision without gaining wallet or publication authority.",
  arguments: [
    { name: "releaseId", description: "Exact Studio release draft identifier.", required: true },
    { name: "expectedRevision", description: "Exact saved draft revision to preserve.", required: true },
    { name: "request", description: "Concrete creator-requested change.", required: true },
    { name: "presentationMode", description: "Current presentation mode that must not change silently." },
  ],
}, {
  name: FRAY_AUCTION_REVIEW_PROMPT,
  description: "Guide an agent through a Fray auction intake, Keel reuse search, and user approval handoff.",
}];

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function positiveRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
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

function optionalChoice(value: unknown, label: string, choices: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  const selected = promptText(value, label, 64);
  if (!choices.includes(selected)) throw new TypeError(`${label} must be one of: ${choices.join(", ")}.`);
  return selected;
}

function projectRouteInstructions(
  scope: string | undefined,
  runtime: string | undefined,
  outcome: string | undefined,
  chain: string | undefined,
): readonly string[] {
  const outcomeRoute = outcome === "fray-auction"
    ? "For this Fray auction, do not call keel-studio-project-intake. Call fray-auction-intake with family/network and one of presets 1-4; use fray-stage-project only after intake is complete."
    : outcome === "fixed-price" || outcome === "claim"
      ? `For this ${outcome} route, call keel-studio-project-intake with outcome=\"release\" and release.saleMechanism=\"${outcome}\"; never pass outcome=\"${outcome}\" to that tool.`
      : outcome === "release"
        ? "For this ordinary release, call keel-studio-project-intake with outcome=\"release\" and ask for release.saleMechanism (fixed-price, auction, or claim) plus price before calling it."
        : outcome === "storage-only"
          ? "For this storage-only route, call keel-studio-project-intake with outcome=\"storage-only\" and no release object."
          : "Call keel-studio-project-intake without outcome so it asks storage-only versus release; after the answer, use only outcome=\"storage-only\" or outcome=\"release\" in that tool.";
  const scopeRoute = scope === "one-of-one"
    ? "For an ordinary release, map scope=one-of-one to release.type=\"one-of-one\"."
    : scope === "collection"
      ? "For an ordinary collection release, ask limited-edition versus open-edition and map it to release.type; never pass scope to the intake tool or let it default to one-of-one."
      : "Resolve scope before an ordinary release, then map it to release.type; scope is not an intake-tool argument.";
  const runtimeRoute = runtime === undefined
    ? "Runtime belongs in the project plan and later staging/module route, not in keel-studio-project-intake."
    : `Keep runtime=${runtime} in the project plan and later staging/module route; runtime is not a keel-studio-project-intake argument.`;
  const chainRoute = outcome === "fray-auction"
    ? chain === undefined
      ? "Resolve the Fray chain as family plus network for fray-auction-intake."
      : `Resolve chain=${chain} to the exact Fray family plus network; do not pass textual chain or chainId to keel-studio-project-intake for this route.`
    : chain === undefined
      ? "For an ordinary release, resolve the selected network to the numeric chainId expected by keel-studio-project-intake."
      : `Resolve chain=${chain} with keel-chain-guide and pass its numeric chainId for an ordinary release; never pass textual chain to keel-studio-project-intake.`;
  return [
    "Planning aliases are not MCP tool arguments: translate them to the advertised schema instead of forwarding scope, runtime, outcome aliases, or textual chain verbatim.",
    outcomeRoute,
    scopeRoute,
    runtimeRoute,
    chainRoute,
  ];
}

export function getKeelProjectPlanPrompt(name: unknown, argumentsValue: unknown): McpPromptResult {
  if (name !== KEEL_PROJECT_PLAN_PROMPT) throw new TypeError(`Unknown prompt: ${String(name)}.`);
  const input = object(argumentsValue ?? {}, "prompt arguments");
  exact(input, ["request", "scope", "runtime", "outcome", "chain"], "prompt arguments");
  const request = promptText(input.request, "prompt arguments.request", 2_000);
  const scope = optionalChoice(input.scope, "prompt arguments.scope", ["one-of-one", "collection"]);
  const runtime = optionalChoice(input.runtime, "prompt arguments.runtime", ["static", "p5", "three", "doom-wasm", "flash-as3", "other"]);
  const outcome = optionalChoice(input.outcome, "prompt arguments.outcome", ["storage-only", "release", "fixed-price", "claim", "fray-auction"]);
  const chain = input.chain === undefined ? undefined : promptText(input.chain, "prompt arguments.chain", 64);
  const supplied = [
    ...(scope === undefined ? [] : [`scope=${scope}`]),
    ...(runtime === undefined ? [] : [`runtime=${runtime}`]),
    ...(outcome === undefined ? [] : [`outcome=${outcome}`]),
    ...(chain === undefined ? [] : [`chain=${chain}`]),
  ];
  return {
    description: "Intent-first, review-only KEEL project plan.",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Plan this KEEL project before staging, uploading, preparing a wallet request, or changing chain state: ${quote(request)}.`,
          supplied.length === 0 ? "No structured choices were supplied." : `Known choices: ${supplied.join(", ")}.`,
          ...projectRouteInstructions(scope, runtime, outcome, chain),
          "Return an explicit plan with these headings: Intent, Project graph, Storage and presentation, Contracts and sale, Verification, Approval boundary, and Open questions.",
          "For every collector-facing viewer, use the registered canonical KEEL verification shell by omitting viewer. Never author, copy, shrink, replace, or upload a shell. viewer=none is only an explicit raw-artifact route with no viewer; it is not a custom-shell route.",
          "Read keel://mcp/project-routes for p5, Three.js, Doom WASM, Flash AS3, OneMint, collection, fixed-sale, claim, and Fray routing. Read keel://mcp/publication-modes before selecting or pricing a storage route. Search the KEEL library before planning duplicate reusable runtime bytes.",
          "Keep SDK/unit, Forge contract, module-catalog, browser/runtime, and live-chain evidence as separate plan gates. Local tests do not prove a browser render, receipt, public RPC read-back, or deployed module binding.",
          "Stop at a reviewable plan. Do not stage, upload, sign, submit, claim faucet funds, or infer approval from this prompt.",
        ].join(" "),
      },
    }],
  };
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
          "At Studio staging, supply only creator resources/modules. Omitting viewer selects Studio's canonical KEEL Inline graph for later preparation; `none` opts out of the shell only, while the immutable artifact can still be released, minted, and retrieved by its contract read. A standalone image, video, or self-contained GLB resolves to registered shell plus registered keel.asset-display@1 plus the direct creator asset, never zero modules or a manufactured index.html. Resolve the active builder from the selected-chain Studio Inline catalog and verify the registered pre-encoded shell record. Never use protectorPrefix, protectorSuffix, protectedHarnessDataURI, or a NoProtector result as the default Inline readiness check. Never manufacture or upload a default KEEL shell, protected-harness wrapper, or local wrapper when catalog resolution fails; Studio must fail closed for an incomplete selected-chain catalog during preparation. Creator-authored HTML is project content, not a replacement shell.",
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
          "Offer exactly four auction setups and accept only 1, 2, 3, or 4: Quick test, Standard, Collector, or Fray Auction showcase. Do not invent another preset or silently choose one when the creator has not selected it.",
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

export function getKeelDraftRepairPrompt(name: unknown, argumentsValue: unknown): McpPromptResult {
  if (name !== KEEL_DRAFT_REPAIR_PROMPT) throw new TypeError(`Unknown prompt: ${String(name)}.`);
  const args = object(argumentsValue ?? {}, "prompt arguments");
  exact(args, ["releaseId", "expectedRevision", "request", "presentationMode"], "prompt arguments");
  const releaseId = promptText(args.releaseId, "prompt arguments.releaseId", 128);
  const expectedRevision = positiveRevision(args.expectedRevision, "prompt arguments.expectedRevision");
  const request = promptText(args.request, "prompt arguments.request", 2_000);
  const presentationMode = args.presentationMode === undefined
    ? undefined
    : promptText(args.presentationMode, "prompt arguments.presentationMode", 128);
  return {
    description: "Revision-bound, wallet-neutral KEEL Studio draft repair.",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: [
          `Repair Studio release draft ${quote(releaseId)} at exact revision ${expectedRevision}.`,
          `Requested change: ${request}`,
          "Read the draft first with keel-studio-draft and preserve every field the creator did not ask to change.",
          ...(presentationMode === undefined ? [] : [`Keep presentation mode ${quote(presentationMode)} unless the creator explicitly changes it.`]),
          "For image, video, or self-contained GLB changes, call media-optimize first and show exact before bytes, after bytes, percentage saved, adapter, settings, output digest, and byte length.",
          "Do not write until the creator approves that exact measured result. Then call media-optimize-apply with the reviewed digest and byte length; it must write one new file and preserve the source.",
          "Stage corrected project bytes with keel-studio-stage-project. The creator still performs Studio's gas-free preparation and chooses the resulting project before the draft can reference it.",
          `Update the draft only with expectedRevision ${expectedRevision}. Stop on a revision conflict or reviewed publish action instead of retrying against newer state.`,
          "Never cancel, sign, submit, publish, request wallet approval, or change storage/presentation mode implicitly.",
        ].join(" "),
      },
    }],
  };
}

export function promptByName(name: string): McpPrompt | undefined {
  return PROMPT_DEFINITIONS.find((prompt) => prompt.name === name);
}
