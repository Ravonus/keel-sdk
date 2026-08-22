import { createMcpServer } from "./server.js";
import type { StdioInput, StdioOutput } from "./types.js";

function lineResponse(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const MAX_LINE_BYTES = 1024 * 1024;

export async function runStdio(
  input: StdioInput = (process as unknown as { readonly stdin: StdioInput }).stdin,
  output: StdioOutput = process.stdout,
  workspaceRoot = ".",
): Promise<void> {
  const server = await createMcpServer({ workspaceRoot });
  let buffer = "";
  let droppingOversized = false;
  let queue = Promise.resolve();
  const dispatch = (line: string): void => {
    if (line.trim().length === 0) return;
    if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) {
      output.write(lineResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC frame exceeds the 1 MiB limit." } }));
      return;
    }
    queue = queue.then(async () => {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        output.write(lineResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }));
        return;
      }
      try {
        const response = await server.handle(message);
        if (response !== undefined) output.write(lineResponse(response));
      } catch (error) {
        output.write(lineResponse({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      }
    });
  };
  await new Promise<void>((resolve, reject) => {
    input.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : String(chunk ?? "");
      if (droppingOversized) {
        const boundary = buffer.indexOf("\n");
        if (boundary < 0) {
          buffer = "";
          return;
        }
        buffer = buffer.slice(boundary + 1);
        droppingOversized = false;
      }
      if (buffer.length > MAX_LINE_BYTES && buffer.indexOf("\n") < 0) {
        output.write(lineResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC frame exceeds the 1 MiB limit." } }));
        buffer = "";
        droppingOversized = true;
        return;
      }
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/u, "");
        buffer = buffer.slice(boundary + 1);
        dispatch(line);
        boundary = buffer.indexOf("\n");
      }
    });
    input.on("error", (error) => reject(error));
    input.on("end", () => {
      if (buffer.trim().length > 0) dispatch(buffer);
      queue.then(() => resolve(), reject);
    });
  });
}
