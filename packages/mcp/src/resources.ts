import type { McpResource, McpResourceReadResult } from "./types.js";

export const KEEL_WORKFLOW_RESOURCE = "keel://mcp/workflow" as const;
export const KEEL_LIMITS_RESOURCE = "keel://mcp/limits" as const;
const MAX_RESOURCE_BYTES = 64 * 1024;

export class McpResourceNotFoundError extends Error {
  constructor(uri: string) {
    super(`Unknown resource URI: ${uri}.`);
    this.name = "McpResourceNotFoundError";
  }
}

const resourceJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

const RESOURCE_TEXT: Readonly<Record<string, string>> = {
  [KEEL_WORKFLOW_RESOURCE]: resourceJson({
    schema: "keel-mcp-resource@1",
    kind: "offline-workflow",
    steps: ["studio-capabilities", "analyze", "cost", "upload-plan", "build", "verify", "module-resolve", "module-lock", "chain-plan", "ethereum-encode", "publish-plan", "wallet-request-prepare", "wallet-link"],
    caveats: ["cost is a modeled estimate", "carriers are metadata-only until bytes are supplied", "ethereum-encode emits unsigned calldata only and does not produce QR payloads", "wallet-link requires and verifies the exact collectionConfig before emitting typed data; account signature, wallet approval, and chain submission are never performed by MCP"],
  }),
  [KEEL_LIMITS_RESOURCE]: resourceJson({
    schema: "keel-mcp-resource@1",
    kind: "offline-limits",
    stdioMaxLineBytes: 1048576,
    mediaInputMaxBytes: 268435456,
    manifestMaxBytes: 4194304,
    sourceMaxBytes: 268435456,
    uploadPlanResponseMaxBytes: 262144,
    chainPlanResponseMaxBytes: 262144,
    ethereumAdapterPlanMaxBytes: 4194304,
    ethereumAdapterChunkMaxBytes: 23000,
    ethereumAdapterResponseMaxBytes: 262144,
    ethereumAdapterQr: "unsupported",
    publishPlanResponseMaxBytes: 262144,
    recursivePlanMaxObjects: 512,
    recursivePlanMaxDepth: 8,
    recursiveDecodedBytesBudget: 268435456,
    networkAccess: "explicit-studio-metadata-and-staging-only",
    walletSigning: "disabled",
    chainSubmission: "disabled",
  }),
};

export const RESOURCE_DEFINITIONS: readonly McpResource[] = [
  { uri: KEEL_WORKFLOW_RESOURCE, name: "keel-workflow", description: "Machine-readable offline analyze-to-review workflow.", mimeType: "application/json" },
  { uri: KEEL_LIMITS_RESOURCE, name: "keel-limits", description: "Machine-readable MCP and planner safety limits.", mimeType: "application/json" },
];

export function getMcpResource(uri: unknown): McpResourceReadResult {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 256) throw new TypeError("resources/read uri is invalid.");
  const text = RESOURCE_TEXT[uri];
  if (text === undefined) throw new McpResourceNotFoundError(uri);
  if (new TextEncoder().encode(text).byteLength > MAX_RESOURCE_BYTES) throw new Error("Static resource exceeds the MCP resource size limit.");
  const definition = RESOURCE_DEFINITIONS.find((entry) => entry.uri === uri);
  if (definition === undefined) throw new Error("Static resource definition is missing.");
  return { contents: [{ uri, mimeType: definition.mimeType, text }] };
}
