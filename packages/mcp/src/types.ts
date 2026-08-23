export const MCP_PROTOCOL_VERSION = "2024-11-05" as const;
export const MCP_SERVER_NAME = "keel-mcp" as const;
export const MCP_SERVER_VERSION = "0.4.0" as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface JsonSchema {
  readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean)[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

export interface McpPrompt {
  readonly name: string;
  readonly description: string;
  readonly arguments?: readonly McpPromptArgument[];
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: { readonly type: "text"; readonly text: string };
}

export interface McpPromptResult {
  readonly description: string;
  readonly messages: readonly McpPromptMessage[];
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface McpResourceReadResult {
  readonly contents: readonly McpResourceContent[];
}

export interface ToolCallResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface Workspace {
  readonly root: string;
  resolveExistingFile(pathValue: string, maxBytes: number): Promise<string>;
  readFile(pathValue: string, maxBytes: number): Promise<{ readonly path: string; readonly bytes: Uint8Array }>;
  resolveExistingDirectory(pathValue: string): Promise<string>;
  resolveOutputDirectory(pathValue: string): Promise<string>;
  writeJson(pathValue: string, value: unknown): Promise<string>;
}

export interface ToolContext {
  readonly workspace: Workspace;
}

export interface ToolDefinition {
  readonly descriptor: McpTool;
  run(context: ToolContext, input: unknown): Promise<unknown>;
}

export interface McpServer {
  handle(message: unknown): Promise<JsonRpcResponse | undefined>;
}

export interface StdioInput {
  on(event: "data" | "end" | "error", listener: (value?: unknown) => void): StdioInput;
}

export interface StdioOutput {
  write(value: string): void;
}
