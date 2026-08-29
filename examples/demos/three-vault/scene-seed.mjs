const BYTES32 = /^0x[0-9a-f]{64}$/u;

export const DEFAULT_SCENE_SEED =
  "0x000000000000000000000000000000000000000000000000000000005f3a91c7";

export function normalizeSeedHex(value) {
  if (typeof value !== "string") return undefined;
  const candidate = value.startsWith("0x") ? value : `0x${value}`;
  return BYTES32.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function seedWord(seedHex) {
  const normalized = normalizeSeedHex(seedHex);
  if (normalized === undefined) throw new TypeError("Scene seed must be canonical bytes32.");
  return Number.parseInt(normalized.slice(-8), 16) >>> 0;
}

function wordSeed(value) {
  if (!Number.isSafeInteger(value)) return undefined;
  const word = value >>> 0;
  return `0x${word.toString(16).padStart(64, "0")}`;
}

export function resolveSceneSeed(context = {}, injectedSeed) {
  const contextSeed = normalizeSeedHex(
    context?.derivedTokenSeed ?? context?.tokenSeed ?? context?.seed,
  );
  if (contextSeed !== undefined) {
    return {
      hex: contextSeed,
      word: seedWord(contextSeed),
      source: context.seedSource ?? context.source ?? "contract context",
      contract: context.contract ?? context.collection,
      view: context.view ?? context.contractView,
    };
  }

  const injected = wordSeed(
    injectedSeed ?? (typeof globalThis === "undefined" ? undefined : globalThis.KEEL_SEED),
  );
  const hex = injected ?? DEFAULT_SCENE_SEED;
  return {
    hex,
    word: seedWord(hex),
    source: injected === undefined ? "local fallback" : "injected preview",
  };
}
