import { readFile } from "node:fs/promises";

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const OBJECT_ID = /^0x[0-9a-f]{64}$/iu;

function moduleBinding(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} deployment is missing.`);
  if (!ADDRESS.test(value.store)) throw new Error(`${label} deployment has an invalid store.`);
  if (!OBJECT_ID.test(value.objectId)) throw new Error(`${label} deployment has an invalid object id.`);
  return Object.freeze({ store: value.store, objectId: value.objectId });
}

/** Resolves both foundational browser modules from one chain-scoped record. */
export async function p5ProjectBindings(chainId = 11_155_111) {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("KEEL_CHAIN_ID must be a positive integer.");
  const deploymentSource = process.env.KEEL_AGENT_P5_DEPLOYMENTS_PATH?.trim();
  const catalogue = JSON.parse(await readFile(
    deploymentSource === undefined || deploymentSource === ""
      ? new URL("./deployments.json", import.meta.url)
      : deploymentSource,
    "utf8",
  ));
  if (catalogue.schema !== "keel-agent-p5-deployments@1") throw new Error("The p5 deployment catalogue schema is unsupported.");
  const deployment = catalogue.chains?.[String(chainId)];
  if (typeof deployment !== "object" || deployment === null || Array.isArray(deployment)) {
    throw new Error(`p5.js and seeded-random are not both registered for chain ${chainId}.`);
  }
  const chain = `eip155:${chainId}`;
  if (deployment.chain !== chain) throw new Error(`The chain ${chainId} p5 deployment record is inconsistent.`);
  return Object.freeze({
    chain,
    p5: moduleBinding(deployment.p5, "p5.js"),
    seededRandom: moduleBinding(deployment.seededRandom, "seeded-random"),
  });
}
