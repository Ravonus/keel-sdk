export const KEEL_STUDIO_AGENT_DRAFT_API = "keel-studio-agent-drafts@1" as const;

export const KEEL_STUDIO_RELEASE_TYPES = [
  "open-edition",
  "limited-edition",
  "one-of-one",
  "generative-series",
  "unique-set",
  "interactive-work",
  "game-world",
  "asset-library",
  "custom",
] as const;

export type KeelStudioReleaseType = (typeof KEEL_STUDIO_RELEASE_TYPES)[number];
export type KeelStudioReleaseAccessMode = "public" | "allowlist" | "holder" | "claim" | "custom";

export interface KeelStudioAgentReleaseDraft {
  readonly artifactId: string | null;
  readonly title: string;
  readonly description: string;
  readonly story: string;
  readonly releaseType: KeelStudioReleaseType;
  readonly accessMode: KeelStudioReleaseAccessMode;
  readonly supply: string;
  readonly priceEth: string;
  readonly maxPerTransaction: number;
  readonly maxPerWallet: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly networkLabel: string;
  readonly payoutAddress: `0x${string}` | null;
  readonly page: Readonly<Record<string, unknown>>;
}

export interface KeelStudioAgentReleaseView extends KeelStudioAgentReleaseDraft {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly slug: string;
}

export interface KeelStudioAgentDraftWorkspace {
  readonly projects: readonly Readonly<Record<string, unknown>>[];
  readonly releases: readonly KeelStudioAgentReleaseView[];
}

export interface KeelStudioAgentDraftClientOptions {
  readonly studioUrl: string | URL;
  readonly grantToken: string;
  readonly fetchImplementation?: typeof fetch;
}

const KEEL_STUDIO_AGENT_DRAFT_OPERATIONS = ["list", "read", "create", "update"] as const;
export type KeelStudioAgentDraftOperation = (typeof KEEL_STUDIO_AGENT_DRAFT_OPERATIONS)[number];

/**
 * A flat, JSON/YAML-friendly description of one draft operation. The
 * operation is deliberately limited to the creator's Studio draft API; it
 * has no wallet, chain, signing, or publication fields.
 */
export interface KeelStudioAgentDraftOperationConfig extends KeelStudioAgentDraftClientOptions {
  readonly operation: KeelStudioAgentDraftOperation;
  readonly releaseId?: string;
  readonly draft?: KeelStudioAgentReleaseDraft;
  readonly expectedRevision?: number;
}

export type KeelStudioAgentDraftOperationResult = KeelStudioAgentDraftWorkspace | KeelStudioAgentReleaseView;

export interface KeelStudioAgentDraftClient {
  readonly list: () => Promise<KeelStudioAgentDraftWorkspace>;
  readonly read: (releaseId: string) => Promise<KeelStudioAgentReleaseView>;
  readonly create: (draft: KeelStudioAgentReleaseDraft) => Promise<KeelStudioAgentReleaseView>;
  readonly update: (releaseId: string, draft: KeelStudioAgentReleaseDraft, expectedRevision: number) => Promise<KeelStudioAgentReleaseView>;
}

function isDraftOperation(value: unknown): value is KeelStudioAgentDraftOperation {
  return typeof value === "string" && (KEEL_STUDIO_AGENT_DRAFT_OPERATIONS as readonly string[]).includes(value);
}

function endpoint(studioUrl: string | URL, path: string): URL {
  const url = new URL(path, studioUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new TypeError("KEEL Studio agent draft API requires HTTPS, except on loopback.");
  }
  return url;
}

function releasePath(releaseId: string): string {
  if (typeof releaseId !== "string" || releaseId.trim().length === 0) throw new TypeError("Studio release ID must be non-empty text.");
  return `/api/agent/drafts/${encodeURIComponent(releaseId)}`;
}

function redactSensitiveMessage(message: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => {
    if (secret.length === 0) return redacted;
    return redacted
      .split(secret).join("[redacted]")
      .split(encodeURIComponent(secret)).join("[redacted]");
  }, message);
}

async function responseJson<T>(response: Response, secrets: readonly string[]): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`KEEL Studio agent draft API returned HTTP ${response.status} without JSON.`);
  }
  if (!response.ok) {
    const message = value !== null && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : `KEEL Studio agent draft API failed with HTTP ${response.status}.`;
    throw new Error(redactSensitiveMessage(message, secrets));
  }
  return value as T;
}

function clientRequest(options: KeelStudioAgentDraftClientOptions, path: string, init?: RequestInit): Promise<Response> {
  if (typeof options.grantToken !== "string" || options.grantToken.length < 48) throw new TypeError("KEEL Studio agent draft grant is invalid.");
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${options.grantToken}`);
  return (options.fetchImplementation ?? fetch)(endpoint(options.studioUrl, path), {
    ...init,
    headers,
  });
}

/**
 * Creates a wallet-neutral client for creator-authorized draft work. It cannot
 * prepare, submit, confirm, cancel, or otherwise mutate a chain operation.
 */
export function createKeelStudioAgentDraftClient(options: KeelStudioAgentDraftClientOptions) {
  if (options === null || typeof options !== "object") throw new TypeError("KEEL Studio agent draft client options are required.");
  if (typeof options.grantToken !== "string" || options.grantToken.length < 48) throw new TypeError("KEEL Studio agent draft grant is invalid.");
  if (typeof options.studioUrl !== "string" && !(options.studioUrl instanceof URL)) throw new TypeError("Studio URL must be text or a URL.");
  if (options.fetchImplementation !== undefined && typeof options.fetchImplementation !== "function") throw new TypeError("fetchImplementation must be a function.");

  const list = async (): Promise<KeelStudioAgentDraftWorkspace> =>
      responseJson(await clientRequest(options, "/api/agent/drafts", { cache: "no-store" }), [options.grantToken]);
  const read = async (releaseId: string): Promise<KeelStudioAgentReleaseView> =>
      responseJson(await clientRequest(options, releasePath(releaseId), { cache: "no-store" }), [options.grantToken]);
  const create = async (draft: KeelStudioAgentReleaseDraft): Promise<KeelStudioAgentReleaseView> =>
      responseJson(await clientRequest(options, "/api/agent/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      }), [options.grantToken]);
  const update = async (releaseId: string, draft: KeelStudioAgentReleaseDraft, expectedRevision: number): Promise<KeelStudioAgentReleaseView> => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError("Expected draft revision must be a positive integer.");
    return responseJson(await clientRequest(options, releasePath(releaseId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, expectedRevision }),
      }), [options.grantToken]);
  };
  return Object.freeze<KeelStudioAgentDraftClient>({ list, read, create, update });
}

function operationReleaseId(config: KeelStudioAgentDraftOperationConfig): string {
  if (typeof config.releaseId !== "string" || config.releaseId.trim() === "") throw new TypeError(`${config.operation} requires a non-empty releaseId.`);
  return config.releaseId;
}

function operationDraft(config: KeelStudioAgentDraftOperationConfig): KeelStudioAgentReleaseDraft {
  if (config.draft === undefined || config.draft === null || typeof config.draft !== "object" || Array.isArray(config.draft)) throw new TypeError(`${config.operation} requires a draft object.`);
  return config.draft;
}

/** Execute one explicitly configured, creator-scoped draft operation. */
export async function executeKeelStudioAgentDraftOperation(config: KeelStudioAgentDraftOperationConfig): Promise<KeelStudioAgentDraftOperationResult> {
  if (config === null || typeof config !== "object" || !isDraftOperation(config.operation)) throw new TypeError("Studio agent draft operation is unsupported.");
  const supported = new Set(["studioUrl", "grantToken", "operation", "releaseId", "draft", "expectedRevision", "fetchImplementation"]);
  for (const key of Object.keys(config)) if (!supported.has(key)) throw new TypeError(`Studio agent draft configuration.${key} is not supported.`);
  const client = createKeelStudioAgentDraftClient(config);
  switch (config.operation) {
    case "list": return client.list();
    case "read": return client.read(operationReleaseId(config));
    case "create": return client.create(operationDraft(config));
    case "update": return client.update(operationReleaseId(config), operationDraft(config), config.expectedRevision!);
  }
}
