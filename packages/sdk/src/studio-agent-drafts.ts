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

function endpoint(studioUrl: string | URL, path: string): URL {
  const url = new URL(path, studioUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new TypeError("KEEL Studio agent draft API requires HTTPS, except on loopback.");
  }
  return url;
}

async function responseJson<T>(response: Response): Promise<T> {
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
    throw new Error(message);
  }
  return value as T;
}

function clientRequest(options: KeelStudioAgentDraftClientOptions, path: string, init?: RequestInit): Promise<Response> {
  if (options.grantToken.length < 48) throw new TypeError("KEEL Studio agent draft grant is invalid.");
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
  return Object.freeze({
    list: async (): Promise<KeelStudioAgentDraftWorkspace> =>
      responseJson(await clientRequest(options, "/api/agent/drafts", { cache: "no-store" })),
    read: async (releaseId: string): Promise<KeelStudioAgentReleaseView> =>
      responseJson(await clientRequest(options, `/api/agent/drafts/${encodeURIComponent(releaseId)}`, { cache: "no-store" })),
    create: async (draft: KeelStudioAgentReleaseDraft): Promise<KeelStudioAgentReleaseView> =>
      responseJson(await clientRequest(options, "/api/agent/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      })),
    update: async (releaseId: string, draft: KeelStudioAgentReleaseDraft, expectedRevision: number): Promise<KeelStudioAgentReleaseView> => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TypeError("Expected draft revision must be a positive integer.");
      return responseJson(await clientRequest(options, `/api/agent/drafts/${encodeURIComponent(releaseId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, expectedRevision }),
      }));
    },
  });
}
