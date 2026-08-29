# Agent p5 project handoff

This example declares p5.js and KEEL's deterministic seeded-random helper as
separate browser modules, reads and hashes both from Sepolia, stages only the
project-owned locked resources in KEEL Studio, and
prints a creator continuation URL. Staging is off-chain. The creator signs in,
reviews the strict viewer/sandbox verification, and decides whether to publish.

```sh
pnpm build
KEEL_STUDIO_AGENT_TOKEN=... \
node examples/agent-p5-project/stage.mjs
```

`KEEL_CHAIN_ID` defaults to Sepolia (`11155111`). Both module pointers come
from `deployments.json`; adding a chain is one chain-scoped record containing
both verified modules. A chain with either module missing fails before staging.

The script has no embedded fallback for p5 or seeded-random. It stops before
upload unless each exact module can be read from and digest-verified on the
target chain. No wallet signature or transaction is requested by this script.
