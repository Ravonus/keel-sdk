import type { McpResource, McpResourceReadResult } from "./types.js";

export const KEEL_WORKFLOW_RESOURCE = "keel://mcp/workflow" as const;
export const KEEL_LIMITS_RESOURCE = "keel://mcp/limits" as const;
export const KEEL_PUBLICATION_MODES_RESOURCE = "keel://mcp/publication-modes" as const;
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
  [KEEL_PUBLICATION_MODES_RESOURCE]: resourceJson({
    schema: "keel-publication-modes@1",
    defaultMode: "native-carrier-v1",
    presentation: {
      storageIndependent: true,
      terms: {
        bootShell: "Small uncompressed HTML that the contract can read directly.",
        resourceGraph: "Digest-bound scripts, modules, assets, and data; child resources may be compressed.",
        browserDecoder: "Committed browser or WASM code that verifies stored bytes, decompresses them, and verifies decoded bytes before execution.",
        inline: "Complete onchain-assembled data:text/html animation_url with no gateway, IPFS, /content, or RPC fetch.",
        hybrid: "Native KEEL objects resolved by the boot shell through an RPC reader; still fully onchain when every resource is a native KEEL object.",
        ipfs: "Explicitly selected IPFS delivery; never inferred from Hybrid.",
      },
      inlineGate: {
        rootCompression: "none",
        maximumReconstructedBytes: 2000000,
        maximumReadGas: 30000000,
        requiresConfiguredBuilder: true,
        forbidsRuntimeFetch: true,
      },
      codecs: {
        none: "Boot shell and small uncompressed resources.",
        gzip: "Capability-checked browser DecompressionStream path in the committed shell.",
        deflate: "Capability-checked browser DecompressionStream path in the committed shell.",
        brotli: "Exact digest-locked KEEL decoder module, normally the reusable thin WASM decoder published once per chain; never copied into every creator upload.",
      },
      sdkPlanner: {
        package: "@keel/sdk/inline-viewer-graph",
        shell: "buildKeelInlineShellFragments",
        module: "buildKeelInlineModuleFragment",
        localDocument: "buildKeelInlineLocalDocument",
        publishableGraph: "buildKeelInlinePreEncodedTokenURIGraph",
        portableP5Default: "Once-per-chain Gzip p5 fragment plus the browser Gzip/Deflate shell profile.",
        portableThreeDefault: "Once-per-chain exact Three.js r180 ESM main/core graph. Bind both verified current-chain objects; never embed Three.js in each creator project.",
      },
    },
    modes: [{
      id: "native-carrier-v1",
      status: "implemented",
      contractReadable: true,
      chunkBytes: 23000,
      maximumChunksPerExecutorTransaction: 3,
      description: "Immutable native KEEL carriers plus one logical object operation.",
    }, {
      id: "history-inscription-v1",
      status: "benchmark-only",
      contractReadable: false,
      description: "Ethereum calldata/log history recovered by an indexer or archival receipt provider; not native KEEL storage.",
    }, {
      id: "external-chain-inscription-v1",
      status: "design-only",
      contractReadable: false,
      description: "Payload history on a configured external chain with Ethereum identity/commitment; requires an explicit indexer and viewer route.",
    }],
    rules: [
      "Never silently change the selected mode.",
      "Benchmark-only and design-only modes must not be presented as chain-ready.",
      "One wallet approval, one logical object operation, and multiple executor transactions are distinct concepts.",
      "Native carrier gas, calldata intrinsic gas, object gas, logical operation gas, escrow, and transaction fees must be reported separately.",
      "Storage mode and presentation mode are separate; Hybrid does not mean IPFS or offchain storage.",
      "Compress heavy child resources, not the contract-readable boot shell.",
    ],
  }),
};

export const RESOURCE_DEFINITIONS: readonly McpResource[] = [
  { uri: KEEL_WORKFLOW_RESOURCE, name: "keel-workflow", description: "Machine-readable offline analyze-to-review workflow.", mimeType: "application/json" },
  { uri: KEEL_LIMITS_RESOURCE, name: "keel-limits", description: "Machine-readable MCP and planner safety limits.", mimeType: "application/json" },
  { uri: KEEL_PUBLICATION_MODES_RESOURCE, name: "keel-publication-modes", description: "Machine-readable KEEL storage modes, readiness, and accounting boundaries.", mimeType: "application/json" },
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
