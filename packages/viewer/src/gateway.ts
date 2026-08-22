import { KEEL_CONTENT_GATEWAY_PROTOCOL, type Integrity, type ResourceSource } from "@keel/protocol";
import type {
  ResolvedArtifact,
  ResolvedResource,
  VerifiedContentGateway,
  VerifiedContentResponse,
  VerifiedContentRoute,
} from "./types.js";

interface GatewayEntry {
  readonly resource: ResolvedResource;
  readonly integrity: Integrity;
  readonly aliases: readonly string[];
}

function sourceIntegrity(source: ResourceSource): Integrity {
  const integrity = source.integrity;
  if (integrity === undefined || integrity.algorithm === "none") {
    throw new Error("Keel v2 content gateway requires cryptographic integrity for every accepted source.");
  }
  return integrity;
}

function normalizedPrefix(value: string | undefined, fallback: "/content/" | "/onchain/" | "/ipfs/"): string {
  return value ?? fallback;
}

function addAlias(target: Set<string>, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  target.add(value);
}

function ipfsVirtualPath(uri: string, prefix: string): string | undefined {
  if (!uri.startsWith("ipfs://")) return undefined;
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "").replace(/^\/+/, "");
  return `${prefix}${path}`;
}

/** All exact virtual names by which committed creator code may request a resource. */
export function resourceGatewayAliases(artifact: ResolvedArtifact, resource: ResolvedResource): readonly string[] {
  const content = artifact.manifest.runtime.content;
  const resourcePrefix = normalizedPrefix(content.resourcePathPrefix, "/content/");
  const onchainPrefix = normalizedPrefix(content.onchainPathPrefix, "/onchain/");
  const ipfsPrefix = normalizedPrefix(content.ipfsPathPrefix, "/ipfs/");
  const aliases = new Set<string>();
  const encodedId = encodeURIComponent(resource.resource.id);
  const encodedManifest = encodeURIComponent(artifact.manifest.id);

  addAlias(aliases, `oca://${resource.resource.id}`);
  addAlias(aliases, `${resourcePrefix}${encodedId}`);
  addAlias(aliases, `${resourcePrefix}${encodedManifest}/${encodedId}`);
  for (const alias of resource.resource.aliases ?? []) addAlias(aliases, alias);

  for (const source of resource.resource.sources) {
    if (source.kind === "uri") {
      addAlias(aliases, source.uri);
      addAlias(aliases, ipfsVirtualPath(source.uri, ipfsPrefix));
    } else if (source.kind === "onchain") {
      const route = `${onchainPrefix}${source.chainId}/${source.store.toLowerCase()}/${source.objectId.toLowerCase()}`;
      addAlias(aliases, route);
      addAlias(aliases, `eip155:${source.chainId}:${source.store.toLowerCase()}/object/${source.objectId.toLowerCase()}`);
    } else if (source.kind === "contract-call") {
      addAlias(
        aliases,
        `${onchainPrefix}${source.chainId}/${source.to.toLowerCase()}/call/${source.data.toLowerCase()}`,
      );
    }
  }

  addAlias(aliases, resource.location);
  return [...aliases];
}

function entries(artifact: ResolvedArtifact): readonly GatewayEntry[] {
  if (artifact.manifest.runtime.content.manifestTrust === "registry" && artifact.commitment?.registry?.verified !== true) {
    throw new Error("Registry-trusted artifacts require a verified KeelIndex commitment before gateway creation.");
  }
  return [...artifact.resources.values()].map((resource) => ({
    resource,
    integrity: sourceIntegrity(resource.source),
    aliases: resourceGatewayAliases(artifact, resource),
  }));
}

function responseFor(entry: GatewayEntry, method: string): VerifiedContentResponse {
  const headers = {
    "Content-Type": entry.resource.mediaType,
    "Content-Length": String(entry.resource.bytes.byteLength),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Keel-Verified": entry.integrity.digest,
    "X-Keel-Resource": entry.resource.resource.id,
  } as const;
  return {
    status: 200,
    headers,
    ...(method === "HEAD" ? {} : { body: entry.resource.bytes }),
    resourceId: entry.resource.resource.id,
  };
}

/**
 * Framework-neutral handler for `/content/`, `/onchain/`, `/ipfs/`, `oca://`,
 * and exact committed source URIs. Undeclared names never fall through to the
 * public network.
 */
export function createVerifiedContentGateway(artifact: ResolvedArtifact): VerifiedContentGateway {
  const gatewayEntries = entries(artifact);
  const byAlias = new Map<string, GatewayEntry>();
  for (const entry of gatewayEntries) {
    for (const alias of entry.aliases) {
      const existing = byAlias.get(alias);
      if (existing !== undefined && existing.resource.resource.id !== entry.resource.resource.id) {
        throw new Error(`Virtual content alias collision at ${alias}.`);
      }
      byAlias.set(alias, entry);
    }
  }

  const routes: VerifiedContentRoute[] = gatewayEntries.map((entry) => ({
    path: `/content/${encodeURIComponent(entry.resource.resource.id)}`,
    resourceId: entry.resource.resource.id,
    mediaType: entry.resource.mediaType,
    byteLength: entry.resource.bytes.byteLength,
    integrity: entry.integrity,
    aliases: entry.aliases,
  }));

  return {
    protocol: KEEL_CONTENT_GATEWAY_PROTOCOL,
    manifestId: artifact.manifest.id,
    routes,
    resolve(input: string, requestedMethod = "GET"): VerifiedContentResponse {
      const method = requestedMethod.toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        return { status: 405, headers: { Allow: "GET, HEAD", "X-Keel-Blocked": "method" } };
      }
      const entry = byAlias.get(input);
      if (entry !== undefined) return responseFor(entry, method);
      return {
        status: input.startsWith("/content/") || input.startsWith("/onchain/") || input.startsWith("/ipfs/")
          ? 404
          : 403,
        headers: { "X-Keel-Blocked": "undeclared-resource", "Cache-Control": "no-store" },
      };
    },
  };
}

function gatewayRequestCandidates(input: Request | string): readonly string[] {
  if (typeof input === "string") {
    try {
      const url = new URL(input);
      return [...new Set([input, url.href, `${url.pathname}${url.search}`, url.pathname])];
    } catch {
      return [input];
    }
  }
  const url = new URL(input.url);
  return [...new Set([input.url, url.href, `${url.pathname}${url.search}`, url.pathname])];
}

function gatewayResponse(gateway: VerifiedContentGateway, input: Request | string, method?: string): VerifiedContentResponse {
  const candidates = gatewayRequestCandidates(input);
  let result = gateway.resolve(candidates[0] ?? "", method);
  for (const candidate of candidates.slice(1)) {
    if (result.status !== 403 && result.status !== 404) break;
    const next = gateway.resolve(candidate, method);
    if (next.status !== 403 && next.status !== 404) return next;
    result = next;
  }
  return result;
}

/**
 * Fetch/Service-Worker/Next.js compatible adapter for the verified gateway.
 * It never delegates to global fetch: every request receives a local verified
 * response, a manifest-scoped 404, or a deny-by-default 403/405.
 */
export function createVerifiedContentFetchHandler(
  artifactOrGateway: ResolvedArtifact | VerifiedContentGateway,
): (request: Request | string, init?: RequestInit) => Response {
  const gateway = "resolve" in artifactOrGateway
    ? artifactOrGateway
    : createVerifiedContentGateway(artifactOrGateway);
  return (request: Request | string, init?: RequestInit): Response => {
    const requestMethod = typeof request === "string" ? undefined : request.method;
    const result = gatewayResponse(gateway, request, init?.method ?? requestMethod ?? "GET");
    const body = result.body === undefined ? null : new Uint8Array(result.body).buffer;
    return new Response(body, {
      status: result.status,
      headers: result.headers,
    });
  };
}
