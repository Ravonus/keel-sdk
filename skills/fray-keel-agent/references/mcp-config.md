# Portable MCP connection

Use the built `@keel/mcp` CLI from the repository or an installed package. A
Claude/Codex client can connect over stdio with a configuration equivalent to:

```json
{
  "mcpServers": {
    "oca-keel": {
      "command": "node",
      "args": ["/path/to/oca-modern/packages/mcp/dist/cli.js", "--workspace", "/path/to/artwork-workspace"],
      "env": {
        "FRAY_STUDIO_URL": "https://your-studio.example",
        "FRAY_STUDIO_AGENT_TOKEN": "<server-to-server-token>"
      }
    }
  }
}
```

The Studio URL is optional. Without it, local planning and chain/faucet
guidance still work, while `keel-library-search` reports `unconfigured`.
The MCP server reads only bounded JSON metadata from `/api/library` and
`/api/modules`; `fray-stage-project` is the explicit exception that sends the
selected bounded source to the Studio temporary project endpoint. It requires
the separate `FRAY_STUDIO_AGENT_TOKEN`, never accepts a wallet key, and never
signs or submits a wallet request.
