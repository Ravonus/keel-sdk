export interface KeelDropApiDocument {
  readonly schema: "keel.drop@1";
  readonly chainId: number;
  readonly controller: `0x${string}`;
  readonly dropId: `0x${string}`;
  readonly collection: {
    readonly address: `0x${string}`;
    readonly name: string;
    readonly symbol: string;
    readonly slug: string | null;
    readonly description: string | null;
    readonly bannerUrl: string | null;
    readonly panelImageUrl: string | null;
    readonly avatarUrl: string | null;
    readonly galleryUrl: string;
  };
  readonly drop: {
    readonly supply: string;
    readonly minted: string;
    readonly remaining: string;
    readonly openSupply: boolean;
    readonly maxPerTransaction: string;
    readonly maxPerWallet: string;
    readonly paused: boolean;
    readonly closed: boolean;
    readonly metadataDigest: `0x${string}`;
  };
  readonly stages: readonly Record<string, unknown>[];
  readonly activeStageIndex: number | null;
  readonly eligibility: { readonly canMint: boolean; readonly code: string; readonly message: string };
  readonly events: Readonly<Record<string, string>>;
  readonly sdk: { readonly package: string; readonly contract: string; readonly mintFunctions: readonly string[]; readonly note: string };
}

/** Fetch the public Keel drop document for a custom frontend or agent-built UI. */
export async function fetchKeelDrop(baseUrl: string, input: {
  readonly chainId: number;
  readonly controller: string;
  readonly dropId: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<KeelDropApiDocument> {
  const request = input.fetch ?? globalThis.fetch;
  const url = `${baseUrl.replace(/\/$/u, "")}/api/drops/${input.chainId}/${input.controller}/${input.dropId}`;
  const response = await request(url, { headers: { accept: "application/json" } });
  const body = await response.json() as KeelDropApiDocument & { readonly message?: string };
  if (!response.ok) throw new Error(body.message ?? `Keel drop request failed with HTTP ${response.status}.`);
  return body;
}
