import { canonicalJson, createIntegrity, utf8ToBytes, type Hex, type Integrity } from "@keel/protocol";

export const FRAY_AUCTION_INTENT_PROTOCOL = "fray-auction-intent@1" as const;
export const FRAY_AUCTION_POLICY_PROTOCOL = "fray-auction-policy@1" as const;

const DIGEST = /^0x[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const NETWORK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_UINT256 = (1n << 256n) - 1n;

export type FrayAuctionFamily = "ethereum" | "tezos";
export type FrayAuctionPresetId = 1 | 2 | 3;
export type FrayAuctionPresetKey = "quick-test" | "standard" | "collector";
export type FrayAuctionReleaseOutcome = "bidder" | "patrons";
export type FrayPatronPricingMode = "economic" | "demand";

export interface FrayAuctionSourceIntegrity {
  readonly algorithm: "sha256";
  readonly digest: Hex;
  readonly byteLength: number;
}

export interface FrayAuctionCurrency {
  readonly symbol: string;
  readonly unit: "wei" | "mutez";
  readonly decimals: 18 | 6;
}

export interface FrayAuctionChain {
  readonly family: FrayAuctionFamily;
  readonly network: string;
  readonly chainId?: number;
  readonly nativeCurrency: FrayAuctionCurrency;
}

export interface FrayAuctionPolicyReference {
  readonly protocol: typeof FRAY_AUCTION_POLICY_PROTOCOL;
  readonly presetId: FrayAuctionPresetId;
  readonly presetKey: FrayAuctionPresetKey;
}

export interface FrayAuctionTerms {
  readonly releaseOutcome: FrayAuctionReleaseOutcome;
  readonly startDelaySeconds: number;
  readonly durationSeconds: number;
  readonly reserveAtomic: string;
  readonly bidIncrementAtomic: string;
  readonly royaltyBps: number;
  readonly minimumPatronCapAtomic: string;
  readonly maximumEditionSize: number;
  readonly maximumPatronPriceAtomic: string;
  readonly patronPricingMode: FrayPatronPricingMode;
  readonly extensionSeconds: number;
  readonly maximumExtensionSeconds: number;
}

export interface FrayAuctionIntent {
  readonly protocol: typeof FRAY_AUCTION_INTENT_PROTOCOL;
  readonly source: FrayAuctionSourceIntegrity;
  readonly chain: FrayAuctionChain;
  readonly policy: FrayAuctionPolicyReference;
  readonly terms: FrayAuctionTerms;
}

export interface FrayAuctionIntentEnvelope {
  readonly intent: FrayAuctionIntent;
  readonly integrity: Integrity;
}

export interface FrayAuctionIntentVerification {
  readonly valid: boolean;
  readonly intent?: FrayAuctionIntent;
  readonly integrity?: Integrity;
  readonly issues: readonly string[];
}

export interface FrayAuctionPolicyProfile {
  readonly family: FrayAuctionFamily;
  readonly presetId: FrayAuctionPresetId;
  readonly presetKey: FrayAuctionPresetKey;
  readonly label: string;
  readonly summary: string;
  readonly nativeCurrency: FrayAuctionCurrency;
  readonly terms: FrayAuctionTerms;
}

const quickEthereum = Object.freeze({
  releaseOutcome: "bidder",
  startDelaySeconds: 300,
  durationSeconds: 3_600,
  reserveAtomic: "10000000000000000",
  bidIncrementAtomic: "5000000000000000",
  royaltyBps: 500,
  minimumPatronCapAtomic: "0",
  maximumEditionSize: 0,
  maximumPatronPriceAtomic: "0",
  patronPricingMode: "economic",
  extensionSeconds: 900,
  maximumExtensionSeconds: 3_600,
} satisfies FrayAuctionTerms);

const standardEthereum = Object.freeze({
  releaseOutcome: "patrons",
  startDelaySeconds: 300,
  durationSeconds: 86_400,
  reserveAtomic: "100000000000000000",
  bidIncrementAtomic: "20000000000000000",
  royaltyBps: 500,
  minimumPatronCapAtomic: "10000000000000000",
  maximumEditionSize: 10,
  maximumPatronPriceAtomic: "0",
  patronPricingMode: "economic",
  extensionSeconds: 900,
  maximumExtensionSeconds: 3_600,
} satisfies FrayAuctionTerms);

const collectorEthereum = Object.freeze({
  releaseOutcome: "patrons",
  startDelaySeconds: 300,
  durationSeconds: 259_200,
  reserveAtomic: "250000000000000000",
  bidIncrementAtomic: "50000000000000000",
  royaltyBps: 750,
  minimumPatronCapAtomic: "20000000000000000",
  maximumEditionSize: 25,
  maximumPatronPriceAtomic: "500000000000000000",
  patronPricingMode: "demand",
  extensionSeconds: 1_800,
  maximumExtensionSeconds: 7_200,
} satisfies FrayAuctionTerms);

const quickTezos = Object.freeze({
  releaseOutcome: "bidder",
  startDelaySeconds: 300,
  durationSeconds: 3_600,
  reserveAtomic: "100000",
  bidIncrementAtomic: "20000",
  royaltyBps: 500,
  minimumPatronCapAtomic: "0",
  maximumEditionSize: 0,
  maximumPatronPriceAtomic: "0",
  patronPricingMode: "economic",
  extensionSeconds: 900,
  maximumExtensionSeconds: 3_600,
} satisfies FrayAuctionTerms);

const standardTezos = Object.freeze({
  releaseOutcome: "patrons",
  startDelaySeconds: 300,
  durationSeconds: 86_400,
  reserveAtomic: "1000000",
  bidIncrementAtomic: "200000",
  royaltyBps: 500,
  minimumPatronCapAtomic: "100000",
  maximumEditionSize: 10,
  maximumPatronPriceAtomic: "0",
  patronPricingMode: "economic",
  extensionSeconds: 900,
  maximumExtensionSeconds: 3_600,
} satisfies FrayAuctionTerms);

const collectorTezos = Object.freeze({
  releaseOutcome: "patrons",
  startDelaySeconds: 300,
  durationSeconds: 259_200,
  reserveAtomic: "2500000",
  bidIncrementAtomic: "500000",
  royaltyBps: 750,
  minimumPatronCapAtomic: "200000",
  maximumEditionSize: 25,
  maximumPatronPriceAtomic: "5000000",
  patronPricingMode: "demand",
  extensionSeconds: 1_800,
  maximumExtensionSeconds: 7_200,
} satisfies FrayAuctionTerms);

const ethereumCurrency = Object.freeze({ symbol: "ETH", unit: "wei", decimals: 18 } satisfies FrayAuctionCurrency);
const tezosCurrency = Object.freeze({ symbol: "ꜩ", unit: "mutez", decimals: 6 } satisfies FrayAuctionCurrency);

/**
 * Versioned Fray defaults preserved from the current Studio execution forms.
 * A preset is presentation shorthand only: handoffs and wallet review must use
 * the fully materialized, digest-bound intent returned by this module.
 */
export const FRAY_AUCTION_POLICY_PROFILES: readonly FrayAuctionPolicyProfile[] = Object.freeze([
  Object.freeze({ family: "ethereum", presetId: 1, presetKey: "quick-test", label: "Quick test", summary: "One-hour bidder-only test auction.", nativeCurrency: ethereumCurrency, terms: quickEthereum }),
  Object.freeze({ family: "ethereum", presetId: 2, presetKey: "standard", label: "Standard", summary: "Twenty-four-hour auction with the ordinary Fray patron round.", nativeCurrency: ethereumCurrency, terms: standardEthereum }),
  Object.freeze({ family: "ethereum", presetId: 3, presetKey: "collector", label: "Collector", summary: "Three-day auction with a larger patron edition for a centerpiece work.", nativeCurrency: ethereumCurrency, terms: collectorEthereum }),
  Object.freeze({ family: "tezos", presetId: 1, presetKey: "quick-test", label: "Quick test", summary: "One-hour bidder-only test auction.", nativeCurrency: tezosCurrency, terms: quickTezos }),
  Object.freeze({ family: "tezos", presetId: 2, presetKey: "standard", label: "Standard", summary: "Twenty-four-hour auction with the ordinary Fray patron round.", nativeCurrency: tezosCurrency, terms: standardTezos }),
  Object.freeze({ family: "tezos", presetId: 3, presetKey: "collector", label: "Collector", summary: "Three-day auction with a larger patron edition for a centerpiece work.", nativeCurrency: tezosCurrency, terms: collectorTezos }),
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new TypeError(`${label}.${key} is not supported.`);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum.toString()} through ${maximum.toString()}.`);
  }
  return value as number;
}

function atomic(value: unknown, label: string, positive = false): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || value.length > 78) throw new TypeError(`${label} must be a canonical atomic-unit decimal string.`);
  const numeric = BigInt(value);
  if (numeric > MAX_UINT256 || (positive && numeric === 0n)) throw new RangeError(`${label} is outside its allowed atomic-unit range.`);
  return value;
}

function sourceIntegrity(value: unknown): FrayAuctionSourceIntegrity {
  const input = object(value, "Fray auction source");
  exactKeys(input, ["algorithm", "digest", "byteLength"], "Fray auction source");
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new TypeError("Fray auction source must use lower-case SHA-256.");
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: integer(input.byteLength, "Fray auction source.byteLength", 1, 256 * 1024 * 1024) };
}

function currency(value: unknown, family: FrayAuctionFamily): FrayAuctionCurrency {
  const input = object(value, "Fray auction nativeCurrency");
  exactKeys(input, ["symbol", "unit", "decimals"], "Fray auction nativeCurrency");
  if (family === "ethereum") {
    if (input.symbol !== "ETH" || input.unit !== "wei" || input.decimals !== 18) throw new TypeError("Ethereum Fray intents must use ETH, wei, and 18 decimals.");
    return { symbol: "ETH", unit: "wei", decimals: 18 };
  }
  if (input.symbol !== "ꜩ" || input.unit !== "mutez" || input.decimals !== 6) throw new TypeError("Tezos Fray intents must use ꜩ, mutez, and 6 decimals.");
  return { symbol: "ꜩ", unit: "mutez", decimals: 6 };
}

function chain(value: unknown): FrayAuctionChain {
  const input = object(value, "Fray auction chain");
  exactKeys(input, ["family", "network", "chainId", "nativeCurrency"], "Fray auction chain");
  if (input.family !== "ethereum" && input.family !== "tezos") throw new TypeError("Fray auction chain.family must be ethereum or tezos.");
  if (typeof input.network !== "string" || !NETWORK.test(input.network) || input.network.length > 64) throw new TypeError("Fray auction chain.network must be a lower-case slug.");
  const nativeCurrency = currency(input.nativeCurrency, input.family);
  if (input.family === "ethereum") {
    return { family: "ethereum", network: input.network, chainId: integer(input.chainId, "Fray auction chain.chainId", 1, Number.MAX_SAFE_INTEGER), nativeCurrency };
  }
  if (input.chainId !== undefined) throw new TypeError("Tezos Fray intents must not include chainId.");
  return { family: "tezos", network: input.network, nativeCurrency };
}

function policy(value: unknown): FrayAuctionPolicyReference {
  const input = object(value, "Fray auction policy");
  exactKeys(input, ["protocol", "presetId", "presetKey"], "Fray auction policy");
  if (input.protocol !== FRAY_AUCTION_POLICY_PROTOCOL) throw new TypeError("Unsupported Fray auction policy protocol.");
  const presetId = integer(input.presetId, "Fray auction policy.presetId", 1, 3) as FrayAuctionPresetId;
  const expectedKey: FrayAuctionPresetKey = presetId === 1 ? "quick-test" : presetId === 2 ? "standard" : "collector";
  if (input.presetKey !== expectedKey) throw new TypeError("Fray auction policy presetId and presetKey disagree.");
  return { protocol: FRAY_AUCTION_POLICY_PROTOCOL, presetId, presetKey: expectedKey };
}

function terms(value: unknown): FrayAuctionTerms {
  const input = object(value, "Fray auction terms");
  exactKeys(input, ["releaseOutcome", "startDelaySeconds", "durationSeconds", "reserveAtomic", "bidIncrementAtomic", "royaltyBps", "minimumPatronCapAtomic", "maximumEditionSize", "maximumPatronPriceAtomic", "patronPricingMode", "extensionSeconds", "maximumExtensionSeconds"], "Fray auction terms");
  if (input.releaseOutcome !== "bidder" && input.releaseOutcome !== "patrons") throw new TypeError("Fray auction terms.releaseOutcome is invalid.");
  if (input.patronPricingMode !== "economic" && input.patronPricingMode !== "demand") throw new TypeError("Fray auction terms.patronPricingMode is invalid.");
  const normalized: FrayAuctionTerms = {
    releaseOutcome: input.releaseOutcome,
    startDelaySeconds: integer(input.startDelaySeconds, "Fray auction terms.startDelaySeconds", 0, 30 * 24 * 60 * 60),
    durationSeconds: integer(input.durationSeconds, "Fray auction terms.durationSeconds", 60, 365 * 24 * 60 * 60),
    reserveAtomic: atomic(input.reserveAtomic, "Fray auction terms.reserveAtomic", true),
    bidIncrementAtomic: atomic(input.bidIncrementAtomic, "Fray auction terms.bidIncrementAtomic", true),
    royaltyBps: integer(input.royaltyBps, "Fray auction terms.royaltyBps", 0, 10_000),
    minimumPatronCapAtomic: atomic(input.minimumPatronCapAtomic, "Fray auction terms.minimumPatronCapAtomic"),
    maximumEditionSize: integer(input.maximumEditionSize, "Fray auction terms.maximumEditionSize", 0, 1_000_000),
    maximumPatronPriceAtomic: atomic(input.maximumPatronPriceAtomic, "Fray auction terms.maximumPatronPriceAtomic"),
    patronPricingMode: input.patronPricingMode,
    extensionSeconds: integer(input.extensionSeconds, "Fray auction terms.extensionSeconds", 0, 30 * 24 * 60 * 60),
    maximumExtensionSeconds: integer(input.maximumExtensionSeconds, "Fray auction terms.maximumExtensionSeconds", 0, 30 * 24 * 60 * 60),
  };
  if (normalized.extensionSeconds > normalized.maximumExtensionSeconds) throw new TypeError("Fray auction extension exceeds its maximum extension.");
  if (normalized.releaseOutcome === "bidder" && (normalized.maximumEditionSize !== 0 || normalized.minimumPatronCapAtomic !== "0" || normalized.maximumPatronPriceAtomic !== "0")) throw new TypeError("Bidder-only Fray auctions cannot carry patron edition or price terms.");
  if (normalized.releaseOutcome === "patrons" && (normalized.maximumEditionSize === 0 || normalized.minimumPatronCapAtomic === "0")) throw new TypeError("Patron Fray auctions require an edition size and minimum patron cap.");
  if (normalized.patronPricingMode === "demand" && normalized.maximumPatronPriceAtomic === "0") throw new TypeError("Demand-priced Fray auctions require a maximum patron price.");
  return normalized;
}

function integrity(value: unknown): Integrity {
  const input = object(value, "Fray auction intent integrity");
  exactKeys(input, ["algorithm", "digest", "byteLength"], "Fray auction intent integrity");
  if (input.algorithm !== "sha256" || typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new TypeError("Fray auction intent integrity must use lower-case SHA-256.");
  return { algorithm: "sha256", digest: input.digest as Hex, byteLength: integer(input.byteLength, "Fray auction intent integrity.byteLength", 1, 64 * 1024) };
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

export function parseFrayAuctionIntent(value: unknown): FrayAuctionIntent {
  const input = object(value, "Fray auction intent");
  exactKeys(input, ["protocol", "source", "chain", "policy", "terms"], "Fray auction intent");
  if (input.protocol !== FRAY_AUCTION_INTENT_PROTOCOL) throw new TypeError("Unsupported Fray auction intent protocol.");
  const normalizedChain = chain(input.chain);
  const normalizedPolicy = policy(input.policy);
  const profile = resolveFrayAuctionPolicy(normalizedChain.family, normalizedPolicy.presetId);
  if (profile.presetKey !== normalizedPolicy.presetKey) throw new TypeError("Fray auction policy profile is inconsistent.");
  const normalizedTerms = terms(input.terms);
  if (canonicalJson(normalizedTerms) !== canonicalJson(profile.terms)) throw new TypeError("Fray auction terms do not match the referenced versioned policy profile.");
  return { protocol: FRAY_AUCTION_INTENT_PROTOCOL, source: sourceIntegrity(input.source), chain: normalizedChain, policy: normalizedPolicy, terms: normalizedTerms };
}

export function resolveFrayAuctionPolicy(family: FrayAuctionFamily, presetId: FrayAuctionPresetId): FrayAuctionPolicyProfile {
  const profile = FRAY_AUCTION_POLICY_PROFILES.find((candidate) => candidate.family === family && candidate.presetId === presetId);
  if (profile === undefined) throw new TypeError(`No ${family} Fray auction policy exists for preset ${presetId.toString()}.`);
  return profile;
}

export function materializeFrayAuctionIntent(value: unknown): FrayAuctionIntent {
  const input = object(value, "Fray auction materializer input");
  exactKeys(input, ["source", "family", "network", "chainId", "presetId"], "Fray auction materializer input");
  if (input.family !== "ethereum" && input.family !== "tezos") throw new TypeError("Fray auction materializer input.family must be ethereum or tezos.");
  const presetId = integer(input.presetId, "Fray auction materializer input.presetId", 1, 3) as FrayAuctionPresetId;
  if (input.family === "tezos" && input.chainId !== undefined) throw new TypeError("Tezos Fray intents must not include chainId.");
  const profile = resolveFrayAuctionPolicy(input.family, presetId);
  return parseFrayAuctionIntent({
    protocol: FRAY_AUCTION_INTENT_PROTOCOL,
    source: input.source,
    chain: {
      family: input.family,
      network: input.network,
      ...(input.family === "ethereum" ? { chainId: input.chainId } : {}),
      nativeCurrency: profile.nativeCurrency,
    },
    policy: { protocol: FRAY_AUCTION_POLICY_PROTOCOL, presetId: profile.presetId, presetKey: profile.presetKey },
    terms: profile.terms,
  });
}

export async function createFrayAuctionIntent(value: unknown): Promise<FrayAuctionIntentEnvelope> {
  const intent = parseFrayAuctionIntent(value);
  return { intent, integrity: await createIntegrity(utf8ToBytes(canonicalJson(intent))) };
}

export async function verifyFrayAuctionIntent(value: unknown): Promise<FrayAuctionIntentVerification> {
  try {
    const envelope = object(value, "Fray auction intent envelope");
    exactKeys(envelope, ["intent", "integrity"], "Fray auction intent envelope");
    const intent = parseFrayAuctionIntent(envelope.intent);
    const supplied = integrity(envelope.integrity);
    const actual = await createIntegrity(utf8ToBytes(canonicalJson(intent)));
    const issues = sameIntegrity(actual, supplied) ? [] : ["Fray auction intent integrity does not match canonical intent bytes"];
    return { valid: issues.length === 0, intent, integrity: actual, issues };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

export function formatFrayAtomicAmount(value: string, decimals: 6 | 18): string {
  const amount = atomic(value, "Fray display amount");
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
