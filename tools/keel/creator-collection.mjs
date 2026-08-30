#!/usr/bin/env node
/**
 * Prepare one creator collection wallet review from JSON or YAML.
 *
 * The SDK deployment registry is authoritative. Missing or ambiguous factory
 * and renderer records stop before wallet approval, signing, or submission.
 */
import { prepareKeelCreatorCollectionWalletReview } from "../../packages/sdk/dist/creator-collection-wallet.js";
import { readStudioConfig } from "./studio-config.mjs";

function validateConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Creator collection configuration must be an object.");
  const supported = new Set(["chainId", "creator", "instance", "creatorNonce", "operation"]);
  for (const key of Object.keys(value)) if (!supported.has(key)) throw new TypeError(`Creator collection configuration.${key} is not supported.`);
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0) throw new TypeError("Creator collection configuration requires a positive chainId.");
  if (typeof value.creator !== "string" || value.creator.length === 0) throw new TypeError("Creator collection configuration requires creator.");
  if (value.instance !== undefined && (typeof value.instance !== "string" || value.instance.length === 0)) throw new TypeError("Creator collection configuration.instance must be non-empty text.");
  if (typeof value.creatorNonce !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value.creatorNonce)) throw new TypeError("Creator collection configuration requires creatorNonce as canonical unsigned decimal text.");
  if (value.operation === null || typeof value.operation !== "object" || Array.isArray(value.operation)) throw new TypeError("Creator collection configuration requires operation.");
  return value;
}

try {
  const loaded = await readStudioConfig(process.argv.slice(2), "creator-collection", "Creator collection");
  const result = prepareKeelCreatorCollectionWalletReview(validateConfig(loaded.value));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
