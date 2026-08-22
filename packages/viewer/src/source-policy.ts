import type { ResourceSource, RuntimeViewerMirror } from "@keel/protocol";

// Gateway *joining* lives here; whether a remote URL may be reached at all
// is protocol-level policy, shared with the SDK and the governed RPC host
// list rather than reimplemented per consumer.
export { isPrivateNetworkHost, remoteUrlAllowed } from "@keel/protocol";

export const DEFAULT_IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/"] as const;
export const DEFAULT_IPNS_GATEWAYS = ["https://ipfs.io/ipns/"] as const;
export const DEFAULT_ARWEAVE_GATEWAYS = ["https://arweave.net/"] as const;

export interface GatewayOptions {
  readonly ipfsGateways?: readonly string[];
  readonly ipnsGateways?: readonly string[];
  readonly arweaveGateways?: readonly string[];
  readonly baseUrl?: string;
}

export function joinGateway(gateway: string, value: string): string {
  return `${gateway.endsWith("/") ? gateway : `${gateway}/`}${value.replace(/^\/+/, "")}`;
}

export function uriLocations(uri: string, gateways: GatewayOptions): readonly string[] {
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return (gateways.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS).map((gateway) => joinGateway(gateway, path));
  }
  if (uri.startsWith("ipns://")) {
    const path = uri.slice("ipns://".length).replace(/^ipns\//, "");
    return (gateways.ipnsGateways ?? DEFAULT_IPNS_GATEWAYS).map((gateway) => joinGateway(gateway, path));
  }
  if (uri.startsWith("ar://")) {
    const path = uri.slice("ar://".length);
    return (gateways.arweaveGateways ?? DEFAULT_ARWEAVE_GATEWAYS).map((gateway) => joinGateway(gateway, path));
  }
  if (uri.startsWith("./") || uri.startsWith("../")) {
    if (gateways.baseUrl === undefined) throw new Error(`Relative URI ${uri} requires baseUrl.`);
    return [new URL(uri, gateways.baseUrl).toString()];
  }
  return [uri];
}

export function sourceLocations(source: ResourceSource, options: GatewayOptions): readonly string[] {
  if (source.kind !== "uri") return [];
  if (source.uri.startsWith("ipfs://")) {
    const path = source.uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    const gateways = source.gateways ?? options.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS;
    return gateways.map((gateway) => joinGateway(gateway, path));
  }
  if (source.uri.startsWith("ipns://")) {
    const path = source.uri.slice("ipns://".length).replace(/^ipns\//, "");
    const gateways = source.gateways ?? options.ipnsGateways ?? DEFAULT_IPNS_GATEWAYS;
    return gateways.map((gateway) => joinGateway(gateway, path));
  }
  if (source.uri.startsWith("ar://")) {
    const path = source.uri.slice("ar://".length);
    const gateways = source.gateways ?? options.arweaveGateways ?? DEFAULT_ARWEAVE_GATEWAYS;
    return gateways.map((gateway) => joinGateway(gateway, path));
  }
  return uriLocations(source.uri, options);
}

export function viewerMirrorLocations(mirror: RuntimeViewerMirror, options: GatewayOptions): readonly string[] {
  return uriLocations(mirror.uri, options);
}
