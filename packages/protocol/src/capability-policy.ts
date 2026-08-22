/**
 * Effective-capability intersection: the layer that lets a marketplace declare
 * what it permits once and be sure an application beneath the Keel runtime
 * can only ever *narrow* that grant, never widen it.
 *
 *   effective = (⋂ allow_i) \ (⋃ deny_i)
 *
 * over the ordered layers  host ⊇ manifest ⊇ module ⊇ app  (and optional user).
 * Structural guarantees, all test-covered:
 *   - Monotonicity: adding a layer can only remove capabilities, never add one.
 *   - Deny-wins: if any layer denies a capability it is absent, regardless of
 *     how many layers allow it.
 *
 * Capabilities are namespaced string tokens (`browser.webAssembly`,
 * `wallet.market.bid`, `host.openListing`, `viewer.dynamicBind`,
 * `network.manifested`), matching the flat ALLOW/DENY marketplace-policy
 * vocabulary in the design brief. Matching is case-insensitive. A layer may
 * allow `"*"` (grant-all) or a namespace wildcard (`wallet.*`).
 *
 * The ceiling (host) is authoritative. Because the candidate universe is the set
 * of tokens anyone concretely names, a ceiling that grants a *wildcard* can bless
 * a token a lower layer introduced — that is intentional dynamism, but it is a
 * forward-compat surface (a future gated token under `wallet.*` would be granted
 * to every host that shipped `wallet.*`). So this module never lets that happen
 * silently:
 *   - `unbounded` is set when a ceiling layer grants `"*"` (grant-all).
 *   - `wildcardGranted` lists effective tokens a ceiling allowed only via a
 *     wildcard (never a concrete entry) — the blast radius, made visible.
 *   - `strictCeiling` (opt-in, recommended for high-trust enforcement) makes a
 *     ceiling's wildcards non-granting: only its concrete tokens bless a token,
 *     so the ceiling is a forward-safe exact whitelist. Deny wildcards always
 *     still apply.
 *
 * Wallet-intent tokens are keyed by a plugin's human-chosen `id`, which a hostile
 * plugin controls. Id-based allow/deny is therefore an ADVISORY narrowing only;
 * the hard bind on what a wallet intent can actually do remains the plugin
 * adapter's selector/target/ABI verification (`plugin-adapter.ts`). Hosts that
 * want a binding deny should gate by 4-byte selector via `walletSelectorToken`.
 */

/** Well-known browser-capability tokens, aligned with `RuntimeCapabilities`. */
export const BROWSER_CAPABILITY_TOKENS = {
  downloads: "browser.downloads",
  pointerLock: "browser.pointerlock",
  fullscreen: "browser.fullscreen",
  clipboardWrite: "browser.clipboardwrite",
  gamepad: "browser.gamepad",
  audioAutoplay: "browser.audioautoplay",
  webAssembly: "browser.webassembly",
} as const;

export type BrowserCapabilityKey = keyof typeof BROWSER_CAPABILITY_TOKENS;

/** Tokens for capabilities the strict sandbox never grants, so a host can assert their denial explicitly. */
export const ALWAYS_DENIED_BROWSER_TOKENS = ["browser.camera", "browser.microphone", "browser.geolocation"] as const;

/** Tokens for dynamically binding the trusted viewer/verifier to an arbitrary object. */
export const VIEWER_CAPABILITY_TOKENS = {
  /** Permit binding a Keel viewer to an object that did not declare one. */
  dynamicBind: "viewer.dynamicbind",
  /** Permit wrapping arbitrary content in the trusted verification shell. */
  attachVerifier: "verifier.attach",
} as const;

export interface CapabilityLayer {
  /** Human-readable origin of this layer, e.g. "host", "manifest", "module", "app", "user". */
  readonly label: string;
  /** Capabilities this layer permits. `"*"` grants all (see `unbounded`). */
  readonly allow: readonly string[] | "*";
  /** Capabilities this layer forbids outright. Deny always wins over any allow. */
  readonly deny?: readonly string[];
  /**
   * Marks this layer as an authoritative ceiling (the host). Wildcard grants and
   * grant-all are only *tracked* (`unbounded`/`wildcardGranted`) or *neutralized*
   * (`strictCeiling`) for ceiling layers. If no layer is flagged, the first layer
   * is treated as the ceiling.
   */
  readonly ceiling?: boolean;
}

export interface CapabilityExplanation {
  readonly token: string;
  readonly allowed: boolean;
  /** Was the token concretely named by some layer (i.e. in the candidate universe)? */
  readonly inUniverse: boolean;
  /** Layer labels that denied the token (deny-wins). */
  readonly deniedBy: readonly string[];
  /** Layer labels that failed to allow the token (missing from their allow-set). */
  readonly notAllowedBy: readonly string[];
  /** True if a ceiling layer allowed the token only via a wildcard, not a concrete entry. */
  readonly ceilingWildcardGranted: boolean;
}

export interface CapabilityIntersectionOptions {
  /** When true, ceiling layers' wildcards do not grant (only concrete tokens bless). Default false. */
  readonly strictCeiling?: boolean;
}

export interface EffectiveCapabilities {
  readonly tokens: ReadonlySet<string>;
  readonly layers: readonly CapabilityLayer[];
  /** True if any ceiling layer grants `"*"` (grant-all): there is effectively no ceiling. */
  readonly unbounded: boolean;
  /** Effective tokens a ceiling layer granted only via a wildcard (forward-compat blast radius). */
  readonly wildcardGranted: readonly string[];
  isAllowed(token: string): boolean;
  explain(token: string): CapabilityExplanation;
}

function normalizeToken(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  // Case-insensitive so a mixed-case token cannot slip past a lower-case deny.
  const trimmed = token.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function isWildcardPattern(pattern: string): boolean {
  return pattern === "*" || pattern.endsWith(".*");
}

/** Does `pattern` match `token`? Supports an exact match or a trailing `.*` namespace wildcard. */
function patternMatches(pattern: string, token: string): boolean {
  if (pattern === "*") return true;
  if (pattern === token) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return token === prefix || token.startsWith(`${prefix}.`);
  }
  return false;
}

interface NormalizedLayer {
  readonly label: string;
  readonly allowAll: boolean;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ceiling: boolean;
}

function normalizeLayer(layer: CapabilityLayer, isCeiling: boolean): NormalizedLayer {
  const rawAllow = layer.allow === "*" ? ["*"] : layer.allow;
  const allow = rawAllow.map(normalizeToken).filter((t): t is string => t !== undefined);
  // A literal "*" anywhere in the allow list means grant-all (fixes the
  // array-"*" vs string-"*" divergence).
  const allowAll = layer.allow === "*" || allow.includes("*");
  return {
    label: layer.label,
    allowAll,
    allow: allow.filter((t) => t !== "*"),
    deny: (layer.deny ?? []).map(normalizeToken).filter((t): t is string => t !== undefined),
    ceiling: isCeiling,
  };
}

function layerAllows(layer: NormalizedLayer, token: string, strictCeiling: boolean): boolean {
  // In strict mode a ceiling layer's wildcards do not grant; only concrete tokens.
  if (layer.ceiling && strictCeiling) {
    return layer.allow.some((pattern) => !isWildcardPattern(pattern) && pattern === token);
  }
  if (layer.allowAll) return true;
  return layer.allow.some((pattern) => patternMatches(pattern, token));
}

function layerDenies(layer: NormalizedLayer, token: string): boolean {
  return layer.deny.some((pattern) => patternMatches(pattern, token));
}

/** Did a ceiling layer allow this token only via a wildcard (no concrete equal)? */
function ceilingWildcardOnly(ceilingLayers: readonly NormalizedLayer[], token: string): boolean {
  if (ceilingLayers.length === 0) return false;
  let anyWildcard = false;
  for (const layer of ceilingLayers) {
    const concrete = layer.allow.some((p) => !isWildcardPattern(p) && p === token);
    if (concrete) return false;
    if (layer.allowAll || layer.allow.some((p) => isWildcardPattern(p) && patternMatches(p, token))) anyWildcard = true;
  }
  return anyWildcard;
}

export function intersectCapabilities(
  layers: readonly CapabilityLayer[],
  options: CapabilityIntersectionOptions = {},
): EffectiveCapabilities {
  const strictCeiling = options.strictCeiling === true;
  const anyFlagged = layers.some((layer) => layer.ceiling === true);
  const normalized = layers.map((layer, index) =>
    normalizeLayer(layer, anyFlagged ? layer.ceiling === true : index === 0),
  );
  const ceilingLayers = normalized.filter((layer) => layer.ceiling);

  // Candidate universe: every concrete (non-wildcard) allow token, across layers.
  const universe = new Set<string>();
  for (const layer of normalized) {
    for (const token of layer.allow) {
      if (!isWildcardPattern(token)) universe.add(token);
    }
  }

  const effective = new Set<string>();
  const wildcardGranted: string[] = [];
  for (const token of universe) {
    const allowedByAll = normalized.every((layer) => layerAllows(layer, token, strictCeiling));
    const deniedByAny = normalized.some((layer) => layerDenies(layer, token));
    if (allowedByAll && !deniedByAny) {
      effective.add(token);
      if (!strictCeiling && ceilingWildcardOnly(ceilingLayers, token)) wildcardGranted.push(token);
    }
  }

  const unbounded = !strictCeiling && ceilingLayers.some((layer) => layer.allowAll);
  const frozenLayers = layers.map((layer) =>
    Object.freeze({
      label: layer.label,
      allow: layer.allow === "*" ? ("*" as const) : Object.freeze([...layer.allow]),
      deny: layer.deny ? Object.freeze([...layer.deny]) : undefined,
      ceiling: layer.ceiling,
    }),
  );

  const explain = (rawToken: string): CapabilityExplanation => {
    const token = normalizeToken(rawToken) ?? "";
    const deniedBy = normalized.filter((layer) => layerDenies(layer, token)).map((layer) => layer.label);
    const notAllowedBy = normalized
      .filter((layer) => !layerAllows(layer, token, strictCeiling))
      .map((layer) => layer.label);
    return {
      token,
      allowed: effective.has(token),
      inUniverse: universe.has(token),
      deniedBy,
      notAllowedBy,
      ceilingWildcardGranted: !strictCeiling && effective.has(token) && ceilingWildcardOnly(ceilingLayers, token),
    };
  };

  return {
    tokens: effective,
    layers: frozenLayers as readonly CapabilityLayer[],
    unbounded,
    wildcardGranted,
    isAllowed: (token: string) => {
      const normalizedToken = normalizeToken(token);
      return normalizedToken !== undefined && effective.has(normalizedToken);
    },
    explain,
  };
}

function assertNoWildcard(value: string, kind: string): void {
  if (value.includes("*")) throw new Error(`Keel capability ${kind} must not contain "*": ${value}`);
}

/** Build the wallet-intent token for a symbolic intent id (advisory; prefer selector for binding denies). */
export function walletIntentToken(intentId: string): string {
  assertNoWildcard(intentId, "intent id");
  return `wallet.${intentId}`.toLowerCase();
}

/** Build a binding wallet token keyed by the 4-byte selector — hostile plugins cannot rename a selector. */
export function walletSelectorToken(selector: string): string {
  assertNoWildcard(selector, "selector");
  return `walletselector.${selector}`.toLowerCase();
}

/** Build the host-operation token for a bridge operation (e.g. `openListing` -> `host.openlisting`). */
export function hostOperationToken(operation: string): string {
  assertNoWildcard(operation, "operation");
  return `host.${operation}`.toLowerCase();
}

/**
 * Derive the capability layer a manifest contributes: the browser capabilities
 * it declares, plus `network.manifested` (the only network posture v2 allows),
 * plus any declared wallet-intent ids. The manifest can only ever *ask*; the
 * host ceiling still applies. Ids are sanitized via `walletIntentToken`.
 */
export function manifestCapabilityLayer(input: {
  readonly capabilities?: Readonly<Partial<Record<BrowserCapabilityKey, boolean>>> | undefined;
  readonly walletIntentIds?: readonly string[];
  readonly hasNetworkSources?: boolean;
  readonly label?: string;
}): CapabilityLayer {
  const allow: string[] = [];
  const caps = input.capabilities ?? {};
  for (const key of Object.keys(BROWSER_CAPABILITY_TOKENS) as BrowserCapabilityKey[]) {
    if (caps[key] === true) allow.push(BROWSER_CAPABILITY_TOKENS[key]);
  }
  if (input.hasNetworkSources) allow.push("network.manifested");
  for (const id of input.walletIntentIds ?? []) allow.push(walletIntentToken(id));
  return { label: input.label ?? "manifest", allow };
}

/**
 * Map an effective capability set back to `RuntimeCapabilities` booleans for the
 * sandbox document, so the host mounts a frame whose browser capabilities never
 * exceed the effective ceiling.
 */
export function effectiveRuntimeCapabilities(
  effective: EffectiveCapabilities,
): Readonly<Record<BrowserCapabilityKey, boolean>> {
  const result = {} as Record<BrowserCapabilityKey, boolean>;
  for (const key of Object.keys(BROWSER_CAPABILITY_TOKENS) as BrowserCapabilityKey[]) {
    result[key] = effective.isAllowed(BROWSER_CAPABILITY_TOKENS[key]);
  }
  return result;
}

/** Filter candidate wallet-intent ids to those the effective set allows. */
export function allowedWalletIntents(
  effective: EffectiveCapabilities,
  candidateIntentIds: readonly string[],
): string[] {
  return candidateIntentIds.filter((id) => effective.isAllowed(walletIntentToken(id)));
}

/** Filter candidate host-bridge operation names to those the effective set allows. */
export function allowedHostOperations(
  effective: EffectiveCapabilities,
  candidateOperations: readonly string[],
): string[] {
  return candidateOperations.filter((op) => effective.isAllowed(hostOperationToken(op)));
}

/**
 * Narrow a keyed operations map (e.g. a host-bridge protocol's `operations`, or a
 * plugin's resolved wallet-intent table) to the entries the effective set allows,
 * keying each entry name through `tokenFor`. This is deliberately additive-only:
 * it can REMOVE an operation the host policy forbids, never introduce one the
 * source map did not already declare — so the source map (the plugin manifest the
 * adapter cryptographically verified) remains the hard gate, and host policy is a
 * further restriction on top of it.
 */
export function narrowOperationsByCapability<T>(
  operations: Readonly<Record<string, T>>,
  effective: EffectiveCapabilities,
  tokenFor: (operationName: string) => string,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const name of Object.keys(operations)) {
    if (effective.isAllowed(tokenFor(name))) result[name] = operations[name]!;
  }
  return result;
}

/** Narrow a wallet-intent operations map (keyed by intent id) by host capability policy. */
export function narrowWalletOperations<T>(
  operations: Readonly<Record<string, T>>,
  effective: EffectiveCapabilities,
): Record<string, T> {
  return narrowOperationsByCapability(operations, effective, walletIntentToken);
}

/** Narrow a host-operation map (keyed by operation name) by host capability policy. */
export function narrowHostOperations<T>(
  operations: Readonly<Record<string, T>>,
  effective: EffectiveCapabilities,
): Record<string, T> {
  return narrowOperationsByCapability(operations, effective, hostOperationToken);
}
