import { manifestIntegrity, verifyIntegrity } from "@keel/protocol";
import { decompressBytes } from "@keel/builder";
import type { PreparedStudioArtifact, PreparedVerificationResult } from "./types.js";

export async function verifyPreparedStudioArtifact(artifact: PreparedStudioArtifact): Promise<PreparedVerificationResult> {
  const errors: string[] = [];
  const currentManifestIntegrity = await manifestIntegrity(artifact.manifest);
  const manifestValid = currentManifestIntegrity.digest === artifact.manifestIntegrity.digest;
  if (!manifestValid) errors.push("Canonical manifest digest changed after preparation.");

  let resourcesValid = true;
  for (const resource of artifact.resources) {
    try {
      if (!(await verifyIntegrity(resource.storedBytes, resource.storedIntegrity))) {
        throw new Error(`Stored-byte digest failed for ${resource.resource.id}.`);
      }
      const decoded = await decompressBytes(resource.compression, resource.storedBytes);
      if (!(await verifyIntegrity(decoded, resource.decodedIntegrity))) {
        throw new Error(`Decoded-byte digest failed for ${resource.resource.id}.`);
      }
    } catch (error) {
      resourcesValid = false;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { valid: manifestValid && resourcesValid, manifestValid, resourcesValid, errors };
}
