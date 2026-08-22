import { canonicalJson, utf8ToBytes } from "@keel/protocol";
import type {
  ArtifactDeploymentEstimate,
  PreparedStudioArtifact,
  ResourceDeploymentEstimate,
} from "./types.js";

const DEFAULT_CHUNK_BYTES = 23_000;
const DEFAULT_MAX_CHILDREN = 128;

function treeCounts(chunkCount: number, maxChildren: number): {
  readonly leafObjectCount: number;
  readonly compositeObjectCount: number;
  readonly treeDepth: number;
} {
  let nodes = Math.max(1, Math.ceil(chunkCount / maxChildren));
  const leafObjectCount = nodes;
  let compositeObjectCount = 0;
  let treeDepth = 0;
  while (nodes > 1) {
    nodes = Math.ceil(nodes / maxChildren);
    compositeObjectCount += nodes;
    treeDepth += 1;
  }
  return { leafObjectCount, compositeObjectCount, treeDepth };
}

function estimateResource(resourceId: string, decodedByteLength: number, storedByteLength: number, chunkBytes: number, maxChildren: number): ResourceDeploymentEstimate {
  const chunkCount = Math.max(1, Math.ceil(storedByteLength / chunkBytes));
  const tree = treeCounts(chunkCount, maxChildren);
  const transactionCount = Math.ceil(chunkCount / 3) + tree.leafObjectCount + tree.compositeObjectCount;
  return {
    resourceId,
    decodedByteLength,
    storedByteLength,
    chunkCount,
    ...tree,
    transactionCount,
    approximateCalldataBytes: storedByteLength + transactionCount * 192,
  };
}

export function estimateArtifactDeployment(
  artifact: PreparedStudioArtifact,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  maxChildren = DEFAULT_MAX_CHILDREN,
): ArtifactDeploymentEstimate {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > DEFAULT_CHUNK_BYTES) {
    throw new RangeError(`chunkBytes must be from 1 through ${DEFAULT_CHUNK_BYTES}.`);
  }
  if (!Number.isSafeInteger(maxChildren) || maxChildren < 2 || maxChildren > DEFAULT_MAX_CHILDREN) {
    throw new RangeError(`maxChildren must be from 2 through ${DEFAULT_MAX_CHILDREN}.`);
  }
  const resources = artifact.resources.map((item) =>
    estimateResource(item.resource.id, item.decodedByteLength, item.storedByteLength, chunkBytes, maxChildren),
  );
  const manifestBytes = utf8ToBytes(canonicalJson(artifact.manifest));
  resources.push(estimateResource("manifest.json", manifestBytes.byteLength, manifestBytes.byteLength, chunkBytes, maxChildren));
  return {
    schema: "oca-studio-deployment-estimate@1",
    chunkBytes,
    maxChildren,
    resources,
    transactionCount: resources.reduce((sum, item) => sum + item.transactionCount, 0),
    approximateCalldataBytes: resources.reduce((sum, item) => sum + item.approximateCalldataBytes, 0),
  };
}
