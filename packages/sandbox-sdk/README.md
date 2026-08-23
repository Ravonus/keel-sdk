# Keel Sandbox SDK

The Sandbox SDK gives creators, developers, and AI agents one production-path API for preparing a project, validating its Keel/Keel manifest, resolving exact bytes, and generating the same denied-by-default sandbox document used by the viewer.

```ts
import { prepareSandboxProject } from "@keel/sandbox-sdk";

const result = await prepareSandboxProject({
  id: "my-project",
  name: "My Project",
  files: [{ path: "index.html", bytes: new TextEncoder().encode("<h1>Hello</h1>") }],
});

console.log(result.report);
console.log(result.sandbox.csp);
```

The CLI is machine-readable for AI and CI:

```sh
keel-sandbox prepare ./my-project --json
keel-sandbox prepare ./my-project --out ./sandbox.html
keel-sandbox inspect ./manifest.json --json
keel-sandbox compare ./parent-manifest.json ./child-manifest.json --json
keel-sandbox compare ./parent-manifest.json ./child-manifest.json --approve --json
```

`prepare` never sends project bytes to a server. On-chain or remote manifest resolution is available through the exported viewer adapters, where every source remains digest-bound.

`compare` hashes every named stack component canonically and applies its
Locked, Manual, or Auto-compatible policy. It is a dry-run of the ordinary
parent-to-child revision publication path; there is no separate component
setter and no existing revision is mutated.
