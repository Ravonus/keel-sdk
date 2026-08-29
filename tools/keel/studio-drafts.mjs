#!/usr/bin/env node
/**
 * Run one creator-scoped Studio draft operation from a JSON or YAML file.
 *
 *   keel studio-drafts --config ./draft-operation.yaml
 *
 * The configuration is intentionally limited to the SDK's draft client. It
 * cannot sign, submit, or otherwise perform a wallet or chain operation.
 */
import {
  executeKeelStudioAgentDraftOperation,
} from "../../packages/sdk/dist/studio-agent-drafts.js";
import { readStudioConfig } from "./studio-config.mjs";

function validateConfig(value, environment = process.env) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Studio agent draft configuration must be an object.");
  const supported = new Set(["studioUrl", "operation", "releaseId", "draft", "expectedRevision"]);
  for (const key of Object.keys(value)) if (!supported.has(key)) throw new TypeError(`Studio agent draft configuration.${key} is not supported.`);
  if (typeof value.studioUrl !== "string" || value.studioUrl.trim() === "") throw new TypeError("Studio agent draft configuration requires studioUrl.");
  const environmentToken = typeof environment.KEEL_STUDIO_AGENT_TOKEN === "string" && environment.KEEL_STUDIO_AGENT_TOKEN.length >= 48
    ? environment.KEEL_STUDIO_AGENT_TOKEN
    : undefined;
  const grantToken = environmentToken;
  if (grantToken === undefined) {
    throw new TypeError("Studio agent draft access requires KEEL_STUDIO_AGENT_TOKEN. The token is never accepted in the explicit config.");
  }
  if (!new Set(["list", "read", "create", "update"]).has(value.operation)) throw new TypeError("Studio agent draft configuration requires a supported operation.");
  return { ...value, grantToken };
}

try {
  const loaded = await readStudioConfig(process.argv.slice(2), "studio-drafts", "Studio agent draft");
  const config = validateConfig(loaded.value);
  const result = await executeKeelStudioAgentDraftOperation(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
