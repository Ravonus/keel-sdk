import { prepareStudioArtifact, type StudioAssetInput } from "@keel/studio-core";
import { createSandboxDocument, resolveArtifact, type FetchResponseLike } from "@keel/viewer";

import { inspectSandboxManifest } from "./inspect.js";
import type { PreparedSandboxProject, SandboxProjectInput } from "./types.js";

const BASE_URL = "https://sandbox.oca.invalid/project/";

function response(bytes: Uint8Array, url: string): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bytes.slice().buffer;
    },
  };
}

export async function prepareSandboxProject(input: SandboxProjectInput): Promise<PreparedSandboxProject> {
  const assets: StudioAssetInput[] = input.files.map((file) => ({
    fileName: file.path,
    bytes: file.bytes,
    ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    ...(file.component === undefined ? {} : { stack: file.component }),
  }));
  const prepared = await prepareStudioArtifact({
    id: input.id,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.creator === undefined ? {} : { creator: input.creator }),
    revision: input.revision ?? 1,
    ...(input.parentRevision === undefined ? {} : { parentRevision: input.parentRevision }),
    assets,
  });
  const locations = new Map<string, Uint8Array>();
  for (const resource of prepared.resources) {
    for (const source of resource.resource.sources) {
      if (source.kind === "uri" && (source.uri.startsWith("./") || source.uri.startsWith("../"))) {
        locations.set(new URL(source.uri, BASE_URL).toString(), resource.decodedBytes);
      }
    }
  }
  const resolved = await resolveArtifact(prepared.manifest, {
    baseUrl: BASE_URL,
    sourceAllowlist: [BASE_URL],
    commitment: {
      integrity: prepared.manifestIntegrity,
      digestVerified: true,
      sourceUrl: `${BASE_URL}manifest.json`,
    },
    adapters: {
      fetch: async (url) => {
        const bytes = locations.get(url);
        if (bytes === undefined) return { ok: false, status: 404, statusText: "Not Found", url, async arrayBuffer() { return new ArrayBuffer(0); } };
        return response(bytes, url);
      },
    },
  });
  const report = await inspectSandboxManifest(prepared.manifest, {
    ...(input.previousManifest === undefined ? {} : { previousManifest: input.previousManifest }),
    manualApproval: input.manualApproval === true,
  });
  return { prepared, report, audit: resolved.audit, sandbox: createSandboxDocument(resolved) };
}
