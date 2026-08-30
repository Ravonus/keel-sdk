import { createWorkspace } from "./paths.js";
import { getFrayAuctionReviewPrompt, getKeelAssetReviewPrompt, getKeelDraftRepairPrompt, PROMPT_DEFINITIONS } from "./prompts.js";
import { getMcpResource, McpResourceNotFoundError, RESOURCE_DEFINITIONS } from "./resources.js";
import { toolByName, TOOL_DEFINITIONS } from "./tools.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServer,
  type ToolCallResult,
} from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function parseRequest(value: unknown): JsonRpcRequest {
  const input = object(value, "JSON-RPC request");
  for (const key of Object.keys(input)) if (!["jsonrpc", "id", "method", "params"].includes(key)) throw new TypeError(`JSON-RPC request.${key} is not supported.`);
  if (input.jsonrpc !== "2.0" || typeof input.method !== "string" || input.method.length === 0) throw new TypeError("JSON-RPC request must have jsonrpc 2.0 and a method.");
  if (input.id !== undefined && !validId(input.id)) throw new TypeError("JSON-RPC request.id is invalid.");
  return { jsonrpc: "2.0", ...(input.id === undefined ? {} : { id: input.id }), method: input.method, ...(input.params === undefined ? {} : { params: input.params }) };
}

function response(id: JsonRpcId | undefined, result: unknown): JsonRpcResponse | undefined {
  return id === undefined ? undefined : { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): JsonRpcResponse | undefined {
  if (id === undefined) return undefined;
  const error: JsonRpcError = { code, message, ...(data === undefined ? {} : { data }) };
  return { jsonrpc: "2.0", id, error };
}

function toolResult(value: unknown): ToolCallResult {
  const text = JSON.stringify(value);
  return { content: [{ type: "text", text }], structuredContent: value };
}

function toolError(error: unknown): ToolCallResult {
  const text = errorText(error);
  return { content: [{ type: "text", text }], isError: true };
}

function emptyParams(value: unknown, label: string): void {
  const params = object(value === undefined ? {} : value, label);
  exactKeys(params, ["_meta"], label);
  if (params._meta !== undefined) object(params._meta, `${label}._meta`);
}

function initializeParams(value: unknown): void {
  const params = object(value, "initialize params");
  exactKeys(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"], "initialize params");
  if (params.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new TypeError(`initialize params.protocolVersion must be ${MCP_PROTOCOL_VERSION}.`);
  }
  object(params.capabilities, "initialize params.capabilities");
  if (params._meta !== undefined) object(params._meta, "initialize params._meta");
  const clientInfo = object(params.clientInfo, "initialize params.clientInfo");
  exactKeys(clientInfo, ["name", "version"], "initialize params.clientInfo");
  if (typeof clientInfo.name !== "string" || clientInfo.name.length === 0 || typeof clientInfo.version !== "string" || clientInfo.version.length === 0) {
    throw new TypeError("initialize params.clientInfo requires name and version strings.");
  }
}

export async function createMcpServer(options: { readonly workspaceRoot?: string } = {}): Promise<McpServer> {
  const workspace = await createWorkspace(options.workspaceRoot ?? ".");
  let initialized = false;
  let stopped = false;
  return {
    async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
      let request: JsonRpcRequest;
      try {
        request = parseRequest(message);
      } catch (error) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: errorText(error) } };
      }
      if (request.method === "notifications/initialized" || request.method === "$/cancelRequest") return undefined;
      if (["initialize", "shutdown", "ping", "tools/list", "tools/call", "prompts/list", "prompts/get", "resources/list", "resources/read"].includes(request.method) && request.id === undefined) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: `${request.method} requires a request id.` } };
      }
      if (request.method === "ping") {
        try {
          emptyParams(request.params, "ping params");
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        return response(request.id, {});
      }
      if (request.method === "initialize") {
        if (stopped) return rpcError(request.id, -32000, "MCP server is stopped.");
        try {
          initializeParams(request.params);
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        initialized = true;
        return response(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          instructions: "Keel/Keel preparation and review tools. Local planning is offline; the optional Keel index search only fetches bounded JSON metadata from an explicitly configured HTTPS Studio URL. No wallet signing, faucet claim, chain submission, or carrier-byte fetch is performed.",
        });
      }
      if (stopped) return rpcError(request.id, -32000, "MCP server is stopped.");
      if (!initialized) return rpcError(request.id, -32002, "Call initialize before using MCP tools.");
      if (request.method === "shutdown") {
        try {
          emptyParams(request.params, "shutdown params");
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        stopped = true;
        return response(request.id, null);
      }
      if (request.method === "tools/list") {
        try {
          const params = object(request.params === undefined ? {} : request.params, "tools/list params");
          exactKeys(params, ["cursor", "_meta"], "tools/list params");
          if (params.cursor !== undefined && (typeof params.cursor !== "string" || params.cursor.length > 256)) throw new TypeError("tools/list params.cursor is invalid.");
          if (params._meta !== undefined) object(params._meta, "tools/list params._meta");
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        return response(request.id, { tools: TOOL_DEFINITIONS.map((entry) => entry.descriptor) });
      }
      if (request.method === "tools/call") {
        let params: Record<string, unknown>;
        try {
          params = object(request.params === undefined ? {} : request.params, "tools/call params");
          exactKeys(params, ["name", "arguments", "_meta"], "tools/call params");
          if (params.arguments !== undefined) object(params.arguments, "tools/call params.arguments");
          if (params._meta !== undefined) object(params._meta, "tools/call params._meta");
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        if (typeof params.name !== "string" || params.name.length === 0) return rpcError(request.id, -32602, "tools/call requires a tool name.");
        const tool = toolByName(params.name);
        if (tool === undefined) return response(request.id, toolError(new Error(`Unknown MCP tool: ${params.name}.`)));
        try {
          const result = await tool.run({ workspace }, params.arguments ?? {});
          return response(request.id, toolResult(result));
        } catch (error) {
          return response(request.id, toolError(error));
        }
      }
      if (request.method === "prompts/list") {
        try {
          const params = object(request.params === undefined ? {} : request.params, "prompts/list params");
          exactKeys(params, ["cursor", "_meta"], "prompts/list params");
          if (params.cursor !== undefined && (typeof params.cursor !== "string" || params.cursor.length > 256)) throw new TypeError("prompts/list params.cursor is invalid.");
          if (params._meta !== undefined) object(params._meta, "prompts/list params._meta");
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        return response(request.id, { prompts: PROMPT_DEFINITIONS });
      }
      if (request.method === "prompts/get") {
        try {
          const params = object(request.params === undefined ? {} : request.params, "prompts/get params");
          exactKeys(params, ["name", "arguments", "_meta"], "prompts/get params");
          if (params.arguments !== undefined) object(params.arguments, "prompts/get params.arguments");
          if (params._meta !== undefined) object(params._meta, "prompts/get params._meta");
          if (typeof params.name !== "string" || params.name.length === 0 || params.name.length > 128) throw new TypeError("prompts/get params.name is invalid.");
          return response(request.id,
            params.name === "fray-auction-review"
              ? getFrayAuctionReviewPrompt(params.name, params.arguments)
              : params.name === "keel-draft-repair"
                ? getKeelDraftRepairPrompt(params.name, params.arguments)
                : getKeelAssetReviewPrompt(params.name, params.arguments));
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
      }
      if (request.method === "resources/list") {
        try {
          const params = object(request.params === undefined ? {} : request.params, "resources/list params");
          exactKeys(params, ["cursor", "_meta"], "resources/list params");
          if (params.cursor !== undefined && (typeof params.cursor !== "string" || params.cursor.length > 256)) throw new TypeError("resources/list params.cursor is invalid.");
          if (params._meta !== undefined) object(params._meta, "resources/list params._meta");
        } catch (error) {
          return rpcError(request.id, -32602, errorText(error));
        }
        return response(request.id, { resources: RESOURCE_DEFINITIONS });
      }
      if (request.method === "resources/read") {
        try {
          const params = object(request.params === undefined ? {} : request.params, "resources/read params");
          exactKeys(params, ["uri", "_meta"], "resources/read params");
          if (params._meta !== undefined) object(params._meta, "resources/read params._meta");
          return response(request.id, getMcpResource(params.uri));
        } catch (error) {
          if (error instanceof McpResourceNotFoundError) return rpcError(request.id, -32002, error.message);
          return rpcError(request.id, -32602, errorText(error));
        }
      }
      return rpcError(request.id, -32601, `Method not found: ${request.method}.`);
    },
  };
}
