import { createMcpServer } from "./server.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_VERSION,
  type JsonRpcResponse,
} from "./types.js";

const INITIALIZE_PARAMS = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "keel-mcp-self-test", version: MCP_SERVER_VERSION },
} as const;

export const MCP_SELF_TEST_CHECKS = ["initialize", "ping", "tools/list", "prompts/list", "prompts/get", "resources/list", "resources/read"] as const;

export interface McpSelfTestResult {
  readonly status: "ok";
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  readonly serverVersion: typeof MCP_SERVER_VERSION;
  readonly checks: typeof MCP_SELF_TEST_CHECKS;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
}

function resultObject(response: JsonRpcResponse | undefined, label: string): Record<string, unknown> {
  if (response === undefined || response.error !== undefined || response.result === null || typeof response.result !== "object" || Array.isArray(response.result)) {
    throw new Error(`${label} self-test check failed.`);
  }
  return response.result as Record<string, unknown>;
}

function toolNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("tools/list self-test returned no tools.");
  const names = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { readonly name?: unknown }).name !== "string") {
      throw new Error(`tools/list self-test returned an invalid tool at index ${index}.`);
    }
    return (entry as { readonly name: string }).name;
  });
  if (new Set(names).size !== names.length || names.length === 0) throw new Error("tools/list self-test returned duplicate or empty tools.");
  return names;
}

export async function runMcpSelfTest(workspaceRoot = "."): Promise<McpSelfTestResult> {
  const server = await createMcpServer({ workspaceRoot });
  resultObject(await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS }), "initialize");
  resultObject(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }), "ping");
  const listed = resultObject(await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }), "tools/list");
  resultObject(await server.handle({ jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} }), "prompts/list");
  resultObject(await server.handle({ jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "keel-asset-review", arguments: { input: "asset.js" } } }), "prompts/get");
  resultObject(await server.handle({ jsonrpc: "2.0", id: 6, method: "resources/list", params: {} }), "resources/list");
  resultObject(await server.handle({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "keel://mcp/limits" } }), "resources/read");
  const names = toolNames(listed.tools);
  return {
    status: "ok",
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverVersion: MCP_SERVER_VERSION,
    checks: MCP_SELF_TEST_CHECKS,
    toolCount: names.length,
    toolNames: names,
  };
}
