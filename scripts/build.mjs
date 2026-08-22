import "./workspace-links.mjs";
import { run, tsc } from "./run.mjs";

run("node", ["scripts/build-keel-market-wallet.mjs"]);

tsc("packages/protocol/tsconfig.json");
tsc("packages/viewer/tsconfig.json");
tsc("packages/sdk/tsconfig.json");
tsc("packages/builder/tsconfig.json");
tsc("packages/ethereum-adapter/tsconfig.json");
tsc("packages/mcp/tsconfig.json");
tsc("packages/sprite-codex/tsconfig.json");
tsc("packages/studio-core/tsconfig.json");
tsc("packages/sandbox-sdk/tsconfig.json");
console.log(
);
