export const KEEL_STUDIO_CAPABILITIES_PROTOCOL = "keel-studio-capabilities@1" as const;

export type StudioChainFamily = "ethereum" | "tezos";
export type StudioChainStatus = "ready" | "blocked";

export interface StudioChainCapability {
  readonly family: StudioChainFamily;
  readonly network: string;
  readonly chainId: number | null;
  readonly nativeCurrency: string;
  readonly status: StudioChainStatus;
  readonly reason?: string;
}

export interface KeelStudioCapabilities {
  readonly schema: typeof KEEL_STUDIO_CAPABILITIES_PROTOCOL;
  readonly generatedAt: string;
  readonly studio: {
    readonly name: string;
    readonly environment: "development" | "testnet" | "production";
  };
  readonly protocols: {
    readonly auctionIntent: "fray-auction-intent@1";
    readonly quote: "fun-art-agent-quote@2";
    readonly recovery: "fun-art-publication-recovery@2";
  };
  readonly sandbox: {
    readonly zeroSpend: true;
    readonly productionViewer: true;
    readonly rawNetwork: "deny-by-default";
    readonly media: readonly ("image" | "audio" | "video" | "html" | "wasm")[];
  };
  readonly staging: {
    readonly endpoint: "/api/agent/staging";
    readonly transport: "base64-json";
    readonly maxSourceBytes: number;
    readonly maximumRetentionSeconds: number;
    readonly resumable: boolean;
    readonly oneUseHandoff: true;
    readonly explicitClaim: true;
  };
  readonly authorization: {
    readonly accountSigns: true;
    readonly agentSubmission: "explicitly-scoped";
    readonly signedCallSimulation: true;
    readonly quoteMaximumAgeSeconds: number;
  };
  readonly msp: {
    readonly authentication: "shared-bearer" | "scoped-service-account";
    readonly tenantIsolation: boolean;
    readonly quotas: boolean;
    readonly auditLog: boolean;
    readonly webhooks: boolean;
  };
  readonly chains: readonly StudioChainCapability[];
}

export interface StudioCapabilitiesFetchOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

/** Reads the Studio's public, non-mutating compatibility document. */
export async function fetchStudioCapabilities(
  studioUrl: string | URL,
  options: StudioCapabilitiesFetchOptions = {},
): Promise<KeelStudioCapabilities> {
  const url = new URL("/.well-known/keel-capabilities", studioUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Studio URL must use HTTP or HTTPS.");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw new Error(`Studio capabilities returned HTTP ${response.status.toString()}.`);
  return parseStudioCapabilities(await response.json());
}

export function parseStudioCapabilities(value: unknown): KeelStudioCapabilities {
  const root = record(value, "Studio capabilities");
  exact(root, ["schema", "generatedAt", "studio", "protocols", "sandbox", "staging", "authorization", "msp", "chains"], "Studio capabilities");
  literal(root.schema, KEEL_STUDIO_CAPABILITIES_PROTOCOL, "Studio capabilities schema");
  isoDate(root.generatedAt, "Studio capabilities generatedAt");

  const studio = record(root.studio, "Studio");
  exact(studio, ["name", "environment"], "Studio");
  text(studio.name, "Studio name");
  oneOf(studio.environment, ["development", "testnet", "production"], "Studio environment");

  const protocols = record(root.protocols, "Studio protocols");
  exact(protocols, ["auctionIntent", "quote", "recovery"], "Studio protocols");
  literal(protocols.auctionIntent, "fray-auction-intent@1", "Auction intent protocol");
  literal(protocols.quote, "fun-art-agent-quote@2", "Quote protocol");
  literal(protocols.recovery, "fun-art-publication-recovery@2", "Recovery protocol");

  const sandbox = record(root.sandbox, "Studio sandbox");
  exact(sandbox, ["zeroSpend", "productionViewer", "rawNetwork", "media"], "Studio sandbox");
  literal(sandbox.zeroSpend, true, "Studio sandbox zeroSpend");
  literal(sandbox.productionViewer, true, "Studio sandbox productionViewer");
  literal(sandbox.rawNetwork, "deny-by-default", "Studio sandbox rawNetwork");
  const media = stringArray(sandbox.media, "Studio sandbox media");
  const allowedMedia = ["image", "audio", "video", "html", "wasm"] as const;
  media.forEach((item) => oneOf(item, allowedMedia, "Studio sandbox media item"));
  if (new Set(media).size !== media.length || media.length === 0) throw new TypeError("Studio sandbox media must be unique and non-empty.");

  const staging = record(root.staging, "Studio staging");
  exact(staging, ["endpoint", "transport", "maxSourceBytes", "maximumRetentionSeconds", "resumable", "oneUseHandoff", "explicitClaim"], "Studio staging");
  literal(staging.endpoint, "/api/agent/staging", "Studio staging endpoint");
  literal(staging.transport, "base64-json", "Studio staging transport");
  positiveInteger(staging.maxSourceBytes, "Studio staging maxSourceBytes");
  positiveInteger(staging.maximumRetentionSeconds, "Studio staging maximumRetentionSeconds");
  boolean(staging.resumable, "Studio staging resumable");
  literal(staging.oneUseHandoff, true, "Studio staging oneUseHandoff");
  literal(staging.explicitClaim, true, "Studio staging explicitClaim");

  const authorization = record(root.authorization, "Studio authorization");
  exact(authorization, ["accountSigns", "agentSubmission", "signedCallSimulation", "quoteMaximumAgeSeconds"], "Studio authorization");
  literal(authorization.accountSigns, true, "Studio authorization accountSigns");
  literal(authorization.agentSubmission, "explicitly-scoped", "Studio authorization agentSubmission");
  literal(authorization.signedCallSimulation, true, "Studio authorization signedCallSimulation");
  positiveInteger(authorization.quoteMaximumAgeSeconds, "Studio authorization quoteMaximumAgeSeconds");

  const msp = record(root.msp, "Studio MSP");
  exact(msp, ["authentication", "tenantIsolation", "quotas", "auditLog", "webhooks"], "Studio MSP");
  oneOf(msp.authentication, ["shared-bearer", "scoped-service-account"], "Studio MSP authentication");
  boolean(msp.tenantIsolation, "Studio MSP tenantIsolation");
  boolean(msp.quotas, "Studio MSP quotas");
  boolean(msp.auditLog, "Studio MSP auditLog");
  boolean(msp.webhooks, "Studio MSP webhooks");

  if (!Array.isArray(root.chains) || root.chains.length === 0) throw new TypeError("Studio chains must be a non-empty array.");
  const chains = root.chains.map((entry, index) => parseChain(entry, index));
  const unique = new Set(chains.map((entry) => `${entry.family}:${entry.network}`));
  if (unique.size !== chains.length) throw new TypeError("Studio chains must not repeat a family and network.");
  return value as KeelStudioCapabilities;
}

function parseChain(value: unknown, index: number): StudioChainCapability {
  const label = `Studio chain ${index.toString()}`;
  const chain = record(value, label);
  exact(chain, ["family", "network", "chainId", "nativeCurrency", "status", "reason"], label, true);
  oneOf(chain.family, ["ethereum", "tezos"], `${label} family`);
  text(chain.network, `${label} network`);
  if (chain.chainId !== null) positiveInteger(chain.chainId, `${label} chainId`);
  text(chain.nativeCurrency, `${label} nativeCurrency`);
  oneOf(chain.status, ["ready", "blocked"], `${label} status`);
  if (chain.status === "blocked") text(chain.reason, `${label} reason`);
  else if (chain.reason !== undefined) throw new TypeError(`${label} reason is only valid when blocked.`);
  return value as StudioChainCapability;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string, optionalReason = false): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
  for (const key of keys) {
    if (optionalReason && key === "reason") continue;
    if (!(key in value)) throw new TypeError(`${label}.${key} is required.`);
  }
}

function literal<T extends string | boolean>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) throw new TypeError(`${label} must be ${String(expected)}.`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`${label} is unsupported.`);
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new TypeError(`${label} must be a non-empty string.`);
}

function boolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean.`);
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new TypeError(`${label} must be a string array.`);
  return value;
}

function isoDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO date.`);
}
