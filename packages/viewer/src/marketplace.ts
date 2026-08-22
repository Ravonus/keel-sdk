import {
  KEEL_MARKETPLACE_API_PROTOCOL,
  assertValidKeelMediaDerivative,
  createIntegrity,
  verifyIntegrity,
  type Hex,
  type KeelMediaDerivative,
  type KeelWebpProfile,
} from "@keel/protocol";

import type { ResolvedArtifact, ResolvedResource } from "./types.js";

export type KeelMediaVerification =
  | {
      readonly status: "exact";
      readonly verified: true;
      readonly sourceResourceId: string;
      readonly sourceDigest: Hex;
      readonly outputDigest: Hex;
      readonly mediaType: string;
    }
  | {
      readonly status: "verified-derivative";
      readonly verified: true;
      readonly sourceResourceId: string;
      readonly sourceDigest: Hex;
      readonly outputDigest: Hex;
      readonly mediaType: string;
      readonly derivative: KeelMediaDerivative;
    }
  | {
      readonly status: "unverified";
      readonly verified: false;
      readonly sourceResourceId: string;
      readonly outputDigest: Hex;
      readonly reason: string;
    };

export interface KeelMarketplaceResource {
  readonly id: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: Hex;
  readonly role: string;
  bytes(): Uint8Array;
  blob(): Blob;
  url(): string;
}

export interface KeelMarketplaceApi {
  readonly protocol: typeof KEEL_MARKETPLACE_API_PROTOCOL;
  readonly manifestId: string;
  readonly manifestDigest?: Hex;
  resources(): readonly Omit<KeelMarketplaceResource, "bytes" | "blob" | "url">[];
  resolve(resourceId: string): KeelMarketplaceResource;
  verifyMedia(input: {
    readonly sourceResourceId: string;
    readonly candidate: Uint8Array | ArrayBuffer | Blob;
    readonly profile?: KeelWebpProfile;
  }): Promise<KeelMediaVerification>;
}

async function bytes(value: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(await value.arrayBuffer());
}

function sourceDigest(resource: ResolvedResource): Hex {
  const integrity = resource.source.integrity;
  if (integrity.algorithm !== "sha256" || !/^0x[0-9a-f]{64}$/u.test(integrity.digest)) {
    throw new Error(`Resource ${resource.resource.id} is not bound by canonical SHA-256.`);
  }
  return integrity.digest;
}

function publicResource(resource: ResolvedResource): KeelMarketplaceResource {
  const digest = sourceDigest(resource);
  return {
    id: resource.resource.id,
    mediaType: resource.mediaType,
    byteLength: resource.bytes.byteLength,
    digest,
    role: resource.resource.role,
    bytes: () => resource.bytes.slice(),
    blob: () => new Blob([resource.bytes.slice()], { type: resource.mediaType }),
    url: () => URL.createObjectURL(new Blob([resource.bytes.slice()], { type: resource.mediaType })),
  };
}

/**
 * Small host API for marketplace React code, plain browser code, or extensions.
 * It verifies exact media and committed optimized derivatives without mounting
 * or executing the artifact's HTML.
 */
export function createKeelMarketplaceApi(
  artifact: ResolvedArtifact,
  derivatives: readonly KeelMediaDerivative[] = artifact.manifest.mediaDerivatives ?? [],
): KeelMarketplaceApi {
  derivatives.forEach(assertValidKeelMediaDerivative);
  const bySource = new Map<string, KeelMediaDerivative[]>();
  for (const derivative of derivatives) {
    const values = bySource.get(derivative.sourceResourceId) ?? [];
    values.push(derivative);
    bySource.set(derivative.sourceResourceId, values);
  }
  const resolve = (resourceId: string): KeelMarketplaceResource => {
    const resource = artifact.resources.get(resourceId);
    if (resource === undefined) throw new Error(`Unknown verified Keel resource ${resourceId}.`);
    return publicResource(resource);
  };
  return Object.freeze({
    protocol: KEEL_MARKETPLACE_API_PROTOCOL,
    manifestId: artifact.manifest.id,
    ...(artifact.commitment === undefined ? {} : { manifestDigest: artifact.commitment.integrity.digest }),
    resources: () => Object.freeze([...artifact.resources.values()].map((resource) => {
      const value = publicResource(resource);
      return Object.freeze({ id: value.id, mediaType: value.mediaType, byteLength: value.byteLength, digest: value.digest, role: value.role });
    })),
    resolve,
    async verifyMedia(input: {
      readonly sourceResourceId: string;
      readonly candidate: Uint8Array | ArrayBuffer | Blob;
      readonly profile?: KeelWebpProfile;
    }): Promise<KeelMediaVerification> {
      const resource = artifact.resources.get(input.sourceResourceId);
      if (resource === undefined) throw new Error(`Unknown verified Keel resource ${input.sourceResourceId}.`);
      const candidate = await bytes(input.candidate);
      const candidateIntegrity = await createIntegrity(candidate);
      if (await verifyIntegrity(candidate, resource.source.integrity)) {
        return {
          status: "exact",
          verified: true,
          sourceResourceId: input.sourceResourceId,
          sourceDigest: sourceDigest(resource),
          outputDigest: candidateIntegrity.digest,
          mediaType: resource.mediaType,
        };
      }
      for (const derivative of bySource.get(input.sourceResourceId) ?? []) {
        if (input.profile !== undefined && derivative.transform.profile !== input.profile) continue;
        if (
          derivative.sourceIntegrity.algorithm !== resource.source.integrity.algorithm ||
          derivative.sourceIntegrity.digest !== resource.source.integrity.digest ||
          derivative.sourceIntegrity.byteLength !== resource.source.integrity.byteLength
        ) continue;
        if (await verifyIntegrity(candidate, derivative.outputIntegrity)) {
          return {
            status: "verified-derivative",
            verified: true,
            sourceResourceId: input.sourceResourceId,
            sourceDigest: derivative.sourceIntegrity.digest,
            outputDigest: derivative.outputIntegrity.digest,
            mediaType: derivative.outputMediaType,
            derivative,
          };
        }
      }
      return {
        status: "unverified",
        verified: false,
        sourceResourceId: input.sourceResourceId,
        outputDigest: candidateIntegrity.digest,
        reason: "Candidate bytes match neither the canonical object nor a committed Keel derivative.",
      };
    },
  });
}

/** Install the same API as a browser global for non-module marketplace code. */
export function installKeelMarketplaceGlobal(
  api: KeelMarketplaceApi,
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): void {
  const existing = target.Keel;
  if (existing !== undefined && existing !== api) throw new Error("globalThis.Keel is already installed.");
  Object.defineProperty(target, "Keel", {
    value: api,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}
