import type { RecursiveUploadPlan } from "@keel/builder";
import type { Compression } from "@keel/protocol";
import type { UploadPlanMetrics } from "./types.js";

export function uploadPlanMetrics(plan: RecursiveUploadPlan): UploadPlanMetrics {
  let chunks = 0;
  let leafObjects = 0;
  let compositeObjects = 0;
  let storedBytes = 0;
  const compressions = new Set<Compression>();

  for (const object of plan.objects) {
    if (object.kind === "leaf") {
      leafObjects += 1;
      chunks += object.chunks.length;
      storedBytes += object.storedByteLength;
      compressions.add(object.compression);
    } else {
      compositeObjects += 1;
    }
  }

  const decodedBytes = plan.byteLength;
  const savedBytes = Math.max(0, decodedBytes - storedBytes);
  return {
    decodedBytes,
    storedBytes,
    savedBytes,
    savingsRatio: decodedBytes === 0 ? 0 : savedBytes / decodedBytes,
    compression: compressions.size === 1 ? ([...compressions][0] ?? "none") : "mixed",
    chunks,
    leafObjects,
    compositeObjects,
    treeDepth: plan.treeDepth,
    estimatedTransactions: chunks + leafObjects + compositeObjects,
  };
}

export function compressionCode(value: Compression): 0 | 1 | 2 | 3 {
  switch (value) {
    case "none":
      return 0;
    case "gzip":
      return 1;
    case "deflate":
      return 2;
    case "brotli":
      return 3;
  }
}
