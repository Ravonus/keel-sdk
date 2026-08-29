# Portable MCP connection

Use the built `@keel/mcp` CLI from the repository or an installed package. A
Claude/Codex client can connect over stdio with a configuration equivalent to:

```json
{
  "mcpServers": {
    "keel-mcp": {
      "command": "node",
      "args": ["/path/to/keel-sdk/packages/mcp/dist/cli.js", "--workspace", "/path/to/artwork-workspace"],
      "env": {
        "KEEL_STUDIO_URL": "https://keel-test.149-28-255-65.sslip.io",
        "KEEL_PUBLIC_RPC_URL": "https://rpc.keel-test.149-28-255-65.sslip.io",
        "KEEL_INDEXER_URL": "https://your-indexer.example",
        "FRAY_STUDIO_AGENT_TOKEN": "<server-to-server-token>"
      }
    }
  }
}
```

All endpoint values are optional. `keel-endpoint-config` resolves each URL with
this precedence: explicit tool input, KEEL environment value, canonical KEEL
test default. There is no canonical indexer default. `FRAY_STUDIO_URL` remains
a deprecated Studio-only compatibility input; new configuration must use
`KEEL_STUDIO_URL`. `KEEL_PUBLIC_RPC_URL` names the browser/wallet-facing RPC and
must not be confused with a server's private upstream `KEEL_RPC_URL`.

The current canonical Studio upload page is:
`https://keel-test.149-28-255-65.sslip.io/studio/projects/new`.

The MCP server reads only bounded JSON metadata from `/api/library` and
`/api/modules`; `fray-stage-project` is the explicit exception that sends the
selected bounded source to the Studio temporary project endpoint. It requires
the separate `FRAY_STUDIO_AGENT_TOKEN`, never accepts a wallet key, and never
signs or submits a wallet request.
