/**
 * Reconciles the repo's ad-hoc deployment records with the module registry.
 *
 *   --check   (default) report drift and anything unrecorded; exit 1 on drift
 *   --write   ingest the ad-hoc records into the per-module deployment files
 *
 * The registry is meant to be the one place an address is looked up. That only
 * stays true if divergence is caught, so this compares the two rather than
 * assuming a one-time import held.
 *
 * Real chains carry more than one instance of the same contract (the showcase and
 * the vault-runner each deployed their own KeelEquipmentInventory), so records
 * are keyed by an instance name and name the contract as a field.
 *
 * Anything this table cannot map confidently is reported, never guessed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MODULE_BY_ID, TIER_OF } from "./module-map.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const metaDir = (id) => join(REPO, "../keel-contracts", TIER_OF.get(id), id);
const WRITE = process.argv.includes("--write");

/** source file -> { instance, pick(json) -> [{key, module, contract}] } */
const SOURCES = [
  {
    file: "apps/studio/.data/keel-sepolia-showcase/deployment.json",
    instance: "showcase",
    map: {
      keelHold: ["keel-hold", "KeelHold"],
      keelIndex: ["keel-hold", "KeelIndex"],
      managerImplementation: ["keel-artifacts", "KeelManager"],
      keelManager: ["keel-artifacts", "KeelManagerProxy"],
      keelObjectRegistry: ["keel-artifacts", "KeelArtifactRegistry"],
      keelHarnessRegistry: ["keel-artifacts", "KeelHarnessRegistry"],
      keelLinkRegistry: ["keel-artifacts", "KeelLinkRegistry"],
      keelSeedRegistry: ["keel-artifacts", "KeelSeedRegistry"],
      keelCreatorProfileRegistry: ["keel-creator-identity", "KeelCreatorProfileRegistry"],
      keelMintGate: ["keel-mint-access", "KeelMintGate"],
      oneMintController: ["keel-mint-access", "OneMintController"],
      factory: ["keel-die", "KeelFactory"],
      collection: ["keel-die", "KEEL721"],
      keelEquipmentInventory: ["keel-equipment", "KeelEquipmentInventory"],
      keelGraphRegistry: ["keel-graph", "KeelGraphRegistry"],
      keelPluginRegistry: ["keel-graph", "KeelPluginRegistry"],
      keelMarket: ["keel-market", "KeelMarket"],
      keelCommunityReplicationRegistryV1: ["keel-crucible", "KeelCommunityReplicationRegistry"],
    },
  },
  {
    file: "apps/studio/.data/keel-ip-sepolia-v1/deployment.json",
    instance: "ip-v1",
    map: {
      control: ["keel-ip-control", "KeelIPControl"],
      actionExecutor: ["keel-ip-control", "KeelIPActionExecutor"],
      wrapped721: ["keel-ip-control", "KeelIPWrapped721"],
    },
  },
  {
    file: "evidence/vault-runner-sepolia/vault-character-pack-v2-deployment.json",
    instance: "vault-runner",
    flat: true,
    map: {
      characterCollection: ["vault-runner", "VaultCharacter721"],
      inventory: ["keel-equipment", "KeelEquipmentInventory"],
      arcade: ["vault-runner", "VaultArcadeRegistry"],
      pack: ["vault-runner", "VaultCharacterPackV2"],
    },
  },
  {
    file: "evidence/keel-trusted-runtime/module-review-registry-sepolia.json",
    instance: "trusted-runtime",
    flat: true,
    map: {
      registry: ["keel-graph", "KeelModuleReviewRegistry"],
      graphRegistry: ["keel-graph", "KeelGraphRegistry"],
    },
  },
];

const records = new Map(); // `${module}:${chainId}` -> record
const unmapped = [];

for (const source of SOURCES) {
  const p = join(REPO, source.file);
  if (!existsSync(p)) { unmapped.push(`missing source ${source.file}`); continue; }
  const json = JSON.parse(readFileSync(p, "utf8"));
  const chainId = json.chainId;
  const bag = source.flat ? json : (json.contracts ?? {});
  for (const [key, raw] of Object.entries(bag)) {
    const target = source.map[key];
    const address = typeof raw === "string" ? raw : raw?.address;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    if (key === "deployer" || key === "administrator") continue; // EOAs, not contracts
    if (!target) { unmapped.push(`${source.file}: ${key} = ${address}`); continue; }
    const [moduleId, contract] = target;
    if (!MODULE_BY_ID.has(moduleId)) throw new Error(`unknown module ${moduleId}`);
    const rk = `${moduleId}:${chainId}`;
    if (!records.has(rk)) records.set(rk, { schema: "keel.deployments@1", module: moduleId, chainId, deployments: {} });
    const rec = records.get(rk);
    // every contract from the same source+module belongs to ONE named instance
    const slot = (rec.deployments[source.instance] ??= {});
    const entry = {
      contract,
      address,
      block: typeof raw === "object" ? (raw.blockNumber ?? json.blockNumber ?? null) : (json.blockNumber ?? null),
      txHash: typeof raw === "object" ? (raw.transactionHash ?? null) : (json.transactionHashes?.deploy ?? null),
      source: source.file,
    };
    (slot.contracts ??= {})[contract] = entry;
  }
}

let files = 0, entries = 0;
const drift = [];
for (const rec of records.values()) {
  const dir = join(metaDir(rec.module), "deployments");
  for (const inst of Object.values(rec.deployments)) entries += Object.keys(inst.contracts ?? {}).length;

  if (WRITE) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${rec.chainId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
    files++;
    continue;
  }

  // check mode: every address in the ad-hoc file must match the registry
  const file = join(dir, `${rec.chainId}.json`);
  if (!existsSync(file)) {
    drift.push(`${rec.module} has no registry record for chain ${rec.chainId}`);
    continue;
  }
  files++;
  const recorded = JSON.parse(readFileSync(file, "utf8"));
  for (const [instance, slot] of Object.entries(rec.deployments)) {
    for (const [contract, entry] of Object.entries(slot.contracts ?? {})) {
      const have = recorded.deployments?.[instance]?.contracts?.[contract]?.address;
      if (!have) {
        drift.push(`${rec.module}/${contract} (${instance}, chain ${rec.chainId}) is in ${entry.source} but not in the registry`);
      } else if (have.toLowerCase() !== entry.address.toLowerCase()) {
        drift.push(`${rec.module}/${contract} (${instance}, chain ${rec.chainId}) is ${entry.address} in ${entry.source} but ${have} in the registry`);
      }
    }
  }
}
console.log(`keel reconcile (${WRITE ? "write" : "check"}): ${entries} address(es) across ${files} record file(s)`);
for (const rec of [...records.values()].sort((a, b) => a.module.localeCompare(b.module))) {
  const names = Object.entries(rec.deployments).map(([n, v]) => `${n}(${Object.keys(v.contracts).length})`).join(" ");
  console.log(`  ${rec.module.padEnd(32)} chain ${rec.chainId}  ${names}`);
}
if (unmapped.length) {
  console.log(`\n${unmapped.length} unmapped (recorded nowhere — extend the table to adopt):`);
  for (const u of unmapped) console.log(`  ${u}`);
}
if (!WRITE && drift.length) {
  console.error(`\n${drift.length} drift finding(s) — the registry and the deployment files disagree:`);
  for (const d of drift) console.error(`  FAIL  ${d}`);
  console.error("\nrun `pnpm keel reconcile --write` after confirming which side is right");
  process.exit(1);
}
if (!WRITE) console.log("\nOK — every recorded address matches the registry.");
