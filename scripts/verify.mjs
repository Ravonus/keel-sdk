import { access } from "node:fs/promises";
import path from "node:path";
import { root, run, tsc } from "./run.mjs";

run("node", ["scripts/check.mjs"]);
tsc("apps/demo/tsconfig.json");
run("node", ["scripts/verify-examples.mjs"]);
run("node", ["scripts/verify-doc-links.mjs"]);
run("node", ["--check", "scripts/compile-solidity.mjs"]);

for (const required of [
  "README.md",
  "RELEASE_NOTES.md",
  "VERIFICATION.md",
  "docs/ARCHITECTURE.md",
  "docs/STUDIO.md",
  "docs/CONTENT_GATEWAY.md",
  "docs/LEGACY_AUDIT.md",
  "docs/PROTOCOL.md",
  "docs/RUNTIME.md",
  "docs/SECURITY.md",
  "docs/GAS.md",
  "docs/STORAGE.md",
  "docs/KEEL_CONTRACTS.md",
  "packages/contracts/src/modules/keel-hold/KeelHold.sol",
  "packages/contracts/src/modules/keel-hold/KeelIndex.sol",
  "packages/contracts/src/modules/keel-mint-access/KeelMintGate.sol",
  "packages/contracts/src/modules/keel-die/KEEL721.sol",
  "packages/contracts/src/modules/keel-mint-access/OneMintController.sol",
  "packages/contracts/src/modules/keel-artifacts/KeelArtifactRegistry.sol",
  "packages/contracts/src/modules/keel-artifacts/KeelHarnessRegistry.sol",
  "packages/contracts/src/modules/keel-creator-identity/KeelAttributionRegistry.sol",
  "packages/contracts/src/modules/keel-artifacts/KeelLinkRegistry.sol",
  "packages/contracts/src/modules/keel-artifacts/KeelSeedRegistry.sol",
  "packages/contracts/src/modules/keel-equipment/KeelEquipmentInventory.sol",
  "packages/contracts/src/modules/keel-graph/KeelGraphRegistry.sol",
  "packages/contracts/src/modules/keel-graph/KeelPluginRegistry.sol",
  "packages/contracts/src/modules/keel-graph/KeelModuleReviewRegistry.sol",
  "packages/contracts/src/modules/keel-market/KeelMarket.sol",
  "packages/viewer/src/gateway.ts",
  "packages/viewer/src/registry-adapter.ts",
  "packages/viewer/src/egress.ts",
  "packages/viewer/src/manifest.ts",
  "packages/viewer/src/keel-adapter.ts",
  "packages/viewer/src/plugin-adapter.ts",
  "packages/viewer/src/plugin-bridge.ts",
  "packages/viewer/src/host-bridge.ts",
  "packages/viewer/src/capability-policy.ts",
  "packages/protocol/src/capability-policy.ts",
  "packages/sandbox-sdk/src/index.ts",
  "packages/sandbox-sdk/src/project.ts",
  "packages/sandbox-sdk/src/inspect.ts",
]) {
  await access(path.join(root, required));
}

console.log(
  "Repository verification passed: TypeScript packages, the complete Node test suite, demo typecheck, v2 examples, documentation links, Solidity policy gate, and compiler-script syntax. Exact Solidity compilation/Foundry tests run after dependencies are installed.",
);
