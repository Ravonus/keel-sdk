/**
 * Host bridge: the single security contract for every message a trusted host
 * accepts from, or sends to, a restricted Keel application frame.
 *
 * `docs/SECURITY.md` requires that a host "must not trust postMessage data from
 * the artifact without validating sender window, expected protocol, message
 * schema, size, and allowed operation." Before this module that discipline
 * existed only inside `plugin-bridge.ts`, hard-coded to one plugin, and not at
 * all for the presentation/thumbnail protocols or the vault-runner relay. This
 * module generalizes it into a declarative, fail-closed policy that any bridge
 * seam can reuse.
 *
 * Design invariants:
 * - CODE != AUTHORITY. An operation is rejected unless the policy declares it.
 *   The frame cannot widen its own authority by inventing a protocol/operation.
 * - Bounded work, not an inbound-memory defense. Every inbound value is walked
 *   once with early-exit on the first breached limit (bytes, depth, key count,
 *   string/array length). This bounds validation cost and the size of anything
 *   the host re-serializes or forwards downstream to O(maxBytes). It does NOT
 *   cap the peak memory of the message itself: the browser's structured clone
 *   already materialized it before this code runs. Inbound flooding/size DoS
 *   must be handled at the transport (e.g. the relay) or deployment layer.
 * - Authenticated replay state. Sequence floors are tracked only for sessions
 *   the host has explicitly registered; an unregistered session is rejected,
 *   so an attacker cannot flood the table to evict and reset a victim's floor.
 * - No prototype pollution. `__proto__` / `constructor` / `prototype` keys are
 *   rejected, own-keys only, and results are assembled on null-prototype maps.
 * - Deterministic and DOM-free core. `validateInboundMessage` takes plain
 *   `{ data, origin, source }` so it is unit-testable without a browser; the
 *   thin `receiveMessageEvent` adapter binds it to a real `MessageEvent`.
 */

export type BridgeRejectCode =
  | "not-an-object"
  | "oversize"
  | "too-deep"
  | "too-many-keys"
  | "dangerous-key"
  | "bad-origin"
  | "bad-source"
  | "unknown-protocol"
  | "unknown-operation"
  | "schema"
  | "replayed"
  | "unknown-session";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Field specifications for a bounded, declarative message schema. */
export type BridgeFieldSpec =
  | { readonly type: "string"; readonly maxLength: number; readonly pattern?: RegExp; readonly optional?: boolean }
  | {
      readonly type: "number";
      readonly min: number;
      readonly max: number;
      readonly integer?: boolean;
      readonly optional?: boolean;
    }
  | { readonly type: "boolean"; readonly optional?: boolean }
  | { readonly type: "enum"; readonly values: readonly string[]; readonly optional?: boolean }
  | {
      readonly type: "object";
      readonly fields: Readonly<Record<string, BridgeFieldSpec>>;
      readonly optional?: boolean;
    }
  | {
      readonly type: "string-map";
      readonly maxEntries: number;
      readonly maxKeyLength: number;
      readonly maxValueLength: number;
      readonly optional?: boolean;
    };

export interface BridgeOperationSchema {
  /** Field specs for every payload key besides `protocol` and the operation key. */
  readonly fields: Readonly<Record<string, BridgeFieldSpec>>;
}

export interface BridgeProtocolPolicy {
  readonly protocol: string;
  /** Which own-field names the operation within this protocol (e.g. "action", "intentId"). */
  readonly operationKey: string;
  /** The authority set: only these operations are accepted. */
  readonly operations: Readonly<Record<string, BridgeOperationSchema>>;
  /**
   * Optional replay defense. When both are set, messages must carry a session
   * string and a strictly increasing integer sequence per session, AND the
   * session must have been registered on the bridge first
   * (`registerSession`). Messages for an unregistered session are rejected, so
   * the sequence floor cannot be resurrected by evicting the tracking entry.
   */
  readonly sessionKey?: string;
  readonly sequenceKey?: string;
  /** Optional format constraint for the session value (default: safe charset). */
  readonly sessionPattern?: RegExp;
}

export type BridgeOriginPolicy =
  | { readonly kind: "opaque" }
  | { readonly kind: "same-origin"; readonly origin: string }
  | { readonly kind: "allowlist"; readonly origins: readonly string[] }
  | { readonly kind: "any" };

export interface HostBridgePolicy {
  readonly protocols: readonly BridgeProtocolPolicy[];
  /** Hard ceiling on estimated serialized message size, in bytes. */
  readonly maxBytes: number;
  readonly origin: BridgeOriginPolicy;
  readonly maxDepth?: number;
  readonly maxKeysPerObject?: number;
  /** Max distinct sessions tracked for replay defense before the oldest is evicted. */
  readonly maxTrackedSessions?: number;
}

export type BridgeInbound =
  | {
      readonly ok: true;
      readonly protocol: string;
      readonly operation: string;
      readonly session?: string | undefined;
      readonly sequence?: number | undefined;
      readonly message: Record<string, unknown>;
    }
  | { readonly ok: false; readonly code: BridgeRejectCode; readonly reason: string };

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_KEYS = 32;
const DEFAULT_MAX_SESSIONS = 256;

function reject(code: BridgeRejectCode, reason: string): BridgeInbound {
  return { ok: false, code, reason };
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Conservative default session charset (hex, base64url, and common separators). */
const DEFAULT_SESSION_PATTERN = /^[A-Za-z0-9_:.=+/-]{1,130}$/;

/**
 * `RegExp.test` advances `lastIndex` on `g`/`y` patterns, which would make a
 * caller-supplied stateful pattern alternate pass/fail across calls. Reset the
 * cursor first so validation is a pure function of its input.
 */
function testPattern(pattern: RegExp, value: string): boolean {
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * Single bounded walk. Rejects non-plain values, dangerous keys, and anything
 * exceeding depth/key/string/array limits, while accumulating an estimated
 * UTF-8 byte size and early-exiting once `maxBytes` is breached.
 */
function scanBounded(
  value: unknown,
  limits: { readonly maxBytes: number; readonly maxDepth: number; readonly maxKeys: number },
  depth: number,
  budget: { bytes: number },
): BridgeRejectCode | undefined {
  if (depth > limits.maxDepth) return "too-deep";

  if (value === null) {
    budget.bytes += 4;
  } else if (typeof value === "string") {
    // Cheap UTF-8 upper-bound estimate without allocating an encoder per node.
    budget.bytes += value.length * 3 + 2;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) return "schema";
    budget.bytes += 8;
  } else if (typeof value === "boolean") {
    budget.bytes += 5;
  } else if (Array.isArray(value)) {
    budget.bytes += 2;
    for (const entry of value) {
      const code = scanBounded(entry, limits, depth + 1, budget);
      if (code) return code;
      if (budget.bytes > limits.maxBytes) return "oversize";
    }
  } else if (typeof value === "object") {
    // Reject anything that is not a plain data object (Map, Date, class
    // instances, typed arrays, etc. must never cross the trust boundary).
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return "schema";
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > limits.maxKeys) return "too-many-keys";
    budget.bytes += 2;
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) return "dangerous-key";
      budget.bytes += key.length + 3;
      const code = scanBounded((value as Record<string, unknown>)[key], limits, depth + 1, budget);
      if (code) return code;
      if (budget.bytes > limits.maxBytes) return "oversize";
    }
  } else {
    // undefined, bigint, symbol, function — not serializable data.
    return "schema";
  }

  return budget.bytes > limits.maxBytes ? "oversize" : undefined;
}

function checkField(spec: BridgeFieldSpec, present: boolean, value: unknown): string | undefined {
  if (!present || value === undefined) {
    return spec.optional ? undefined : "missing required field";
  }
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return "expected string";
      if (value.length > spec.maxLength) return "string exceeds maxLength";
      if (spec.pattern && !testPattern(spec.pattern, value)) return "string fails pattern";
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected finite number";
      if (spec.integer && !Number.isSafeInteger(value)) return "expected safe integer";
      if (value < spec.min || value > spec.max) return "number out of range";
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected boolean";
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? undefined : "value not in enum";
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return "expected object";
      return checkFields(spec.fields, value as Record<string, unknown>);
    }
    case "string-map": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return "expected string map";
      const entries = Object.keys(value as Record<string, unknown>);
      if (entries.length > spec.maxEntries) return "string map exceeds maxEntries";
      for (const key of entries) {
        if (DANGEROUS_KEYS.has(key)) return "string map has dangerous key";
        if (key.length > spec.maxKeyLength) return "string map key too long";
        const entryValue = (value as Record<string, unknown>)[key];
        if (typeof entryValue !== "string" || entryValue.length > spec.maxValueLength) {
          return "string map value invalid";
        }
      }
      return undefined;
    }
    default:
      return "unknown field spec";
  }
}

function checkFields(
  fields: Readonly<Record<string, BridgeFieldSpec>>,
  payload: Record<string, unknown>,
): string | undefined {
  // Reject any own key not named by the schema (exact-keys discipline).
  for (const key of Object.keys(payload)) {
    if (!hasOwn(fields, key)) return `unexpected field: ${key}`;
  }
  for (const name of Object.keys(fields)) {
    const error = checkField(fields[name]!, hasOwn(payload, name), payload[name]);
    if (error) return `${name}: ${error}`;
  }
  return undefined;
}

/**
 * Pure validator. Returns a discriminated result so the caller decides whether
 * to ignore or surface a rejection. `expectedSource`, when provided, must be
 * strictly equal to `input.source` (the frame's own window).
 */
export function validateInboundMessage(
  input: { readonly data: unknown; readonly origin?: string | undefined; readonly source?: unknown },
  policy: HostBridgePolicy,
  expectedSource?: unknown,
): BridgeInbound {
  // Under an opaque-origin policy every eligible frame shares origin "null", so
  // the origin alone authenticates nothing — the sender window MUST be pinned.
  // Requiring it here means the insecure "accept without a source" path cannot
  // exist for opaque frames; it fails closed instead of silently trusting any
  // co-embedded null-origin frame.
  if (policy.origin.kind === "opaque" && expectedSource === undefined) {
    return reject("bad-source", "opaque-origin policy requires an expected frame window");
  }
  if (expectedSource !== undefined && input.source !== expectedSource) {
    return reject("bad-source", "message did not come from the expected frame window");
  }

  const originCode = checkOrigin(policy.origin, input.origin);
  if (originCode) return originCode;

  const data = input.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return reject("not-an-object", "message is not a plain object");
  }

  const maxDepth = policy.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeys = policy.maxKeysPerObject ?? DEFAULT_MAX_KEYS;
  const budget = { bytes: 0 };
  const scanCode = scanBounded(data, { maxBytes: policy.maxBytes, maxDepth, maxKeys }, 0, budget);
  if (scanCode) return reject(scanCode, `bounded scan rejected message (${scanCode})`);

  const message = data as Record<string, unknown>;
  const protocolValue = hasOwn(message, "protocol") ? message.protocol : undefined;
  if (typeof protocolValue !== "string") return reject("schema", "missing protocol");

  const protocolPolicy = policy.protocols.find((entry) => entry.protocol === protocolValue);
  if (!protocolPolicy) return reject("unknown-protocol", `protocol not allowed: ${protocolValue}`);

  const operationValue = hasOwn(message, protocolPolicy.operationKey)
    ? message[protocolPolicy.operationKey]
    : undefined;
  if (typeof operationValue !== "string") {
    return reject("schema", `missing operation key '${protocolPolicy.operationKey}'`);
  }
  if (!hasOwn(protocolPolicy.operations, operationValue)) {
    return reject("unknown-operation", `operation not allowed: ${operationValue}`);
  }
  const schema = protocolPolicy.operations[operationValue]!;

  // Build the schema-visible payload: everything except protocol/operation, plus
  // the reserved session/sequence keys which are validated separately below.
  const reserved = new Set<string>(["protocol", protocolPolicy.operationKey]);
  if (protocolPolicy.sessionKey) reserved.add(protocolPolicy.sessionKey);
  if (protocolPolicy.sequenceKey) reserved.add(protocolPolicy.sequenceKey);
  const payload: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(message)) {
    if (!reserved.has(key)) payload[key] = message[key];
  }

  const fieldError = checkFields(schema.fields, payload);
  if (fieldError) return reject("schema", fieldError);

  let session: string | undefined;
  let sequence: number | undefined;
  if (protocolPolicy.sessionKey) {
    const raw = hasOwn(message, protocolPolicy.sessionKey) ? message[protocolPolicy.sessionKey] : undefined;
    const pattern = protocolPolicy.sessionPattern ?? DEFAULT_SESSION_PATTERN;
    if (typeof raw !== "string" || !testPattern(pattern, raw)) {
      return reject("schema", "invalid session");
    }
    session = raw;
  }
  if (protocolPolicy.sequenceKey) {
    const raw = hasOwn(message, protocolPolicy.sequenceKey) ? message[protocolPolicy.sequenceKey] : undefined;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      return reject("schema", "invalid sequence");
    }
    sequence = raw;
  }

  const result: Record<string, unknown> = Object.create(null);
  result.protocol = protocolValue;
  result[protocolPolicy.operationKey] = operationValue;
  for (const key of Object.keys(payload)) result[key] = payload[key];
  if (session !== undefined && protocolPolicy.sessionKey) result[protocolPolicy.sessionKey] = session;
  if (sequence !== undefined && protocolPolicy.sequenceKey) result[protocolPolicy.sequenceKey] = sequence;

  return { ok: true, protocol: protocolValue, operation: operationValue, session, sequence, message: result };
}

function checkOrigin(policy: BridgeOriginPolicy, origin: string | undefined): BridgeInbound | undefined {
  switch (policy.kind) {
    case "any":
      return undefined;
    case "opaque":
      // srcdoc / sandboxed opaque-origin frames post with the literal "null".
      // A missing origin is a caller wiring bug, not a valid opaque origin, so
      // it must fail closed rather than be waved through.
      return origin === "null"
        ? undefined
        : reject("bad-origin", `expected opaque origin "null", got ${String(origin)}`);
    case "same-origin":
      return origin === policy.origin
        ? undefined
        : reject("bad-origin", `expected origin ${policy.origin}, got ${origin}`);
    case "allowlist":
      return origin !== undefined && policy.origins.includes(origin)
        ? undefined
        : reject("bad-origin", `origin not in allowlist: ${origin}`);
    default:
      return reject("bad-origin", "unknown origin policy");
  }
}

/**
 * Stateful bridge. Adds per-session strictly-increasing sequence enforcement on
 * top of `validateInboundMessage` for protocols that declare `sequenceKey`.
 */
export interface HostBridge {
  accept(
    input: { readonly data: unknown; readonly origin?: string | undefined; readonly source?: unknown },
    expectedSource?: unknown,
  ): BridgeInbound;
  /** Register a host-minted session so its sequenced messages become eligible. */
  registerSession(protocol: string, session: string): void;
  /** Retire a session (e.g. on disconnect). */
  forgetSession(protocol: string, session: string): void;
  isSessionRegistered(protocol: string, session: string): boolean;
  reset(): void;
}

// Structured, delimiter-free key so a crafted protocol name or session value
// cannot forge a collision with another (protocol, session) tuple.
function sessionMapKey(protocol: string, session: string): string {
  return JSON.stringify([protocol, session]);
}

export function createHostBridge(policy: HostBridgePolicy): HostBridge {
  const maxSessions = policy.maxTrackedSessions ?? DEFAULT_MAX_SESSIONS;
  // key -> last accepted sequence (-1 means registered, no message yet accepted).
  const lastSequence = new Map<string, number>();

  function registerSession(protocol: string, session: string): void {
    const key = sessionMapKey(protocol, session);
    if (lastSequence.has(key)) return;
    // Capacity is a host-side safety bound; only host-registered sessions can
    // ever occupy the table, so eviction is never attacker-driven.
    if (lastSequence.size >= maxSessions) {
      const oldest = lastSequence.keys().next().value;
      if (oldest !== undefined) lastSequence.delete(oldest);
    }
    lastSequence.set(key, -1);
  }

  function accept(
    input: { readonly data: unknown; readonly origin?: string | undefined; readonly source?: unknown },
    expectedSource?: unknown,
  ): BridgeInbound {
    const result = validateInboundMessage(input, policy, expectedSource);
    if (!result.ok) return result;
    if (result.session === undefined || result.sequence === undefined) return result;

    const key = sessionMapKey(result.protocol, result.session);
    const previous = lastSequence.get(key);
    if (previous === undefined) {
      return reject("unknown-session", "session was not registered on the bridge");
    }
    if (result.sequence <= previous) {
      return reject("replayed", "sequence " + result.sequence + " is not greater than " + previous);
    }
    lastSequence.set(key, result.sequence);
    return result;
  }

  return {
    accept,
    registerSession,
    forgetSession: (protocol, session) => {
      lastSequence.delete(sessionMapKey(protocol, session));
    },
    isSessionRegistered: (protocol, session) => lastSequence.has(sessionMapKey(protocol, session)),
    reset: () => lastSequence.clear(),
  };
}

/** Thin DOM adapter: validate a real MessageEvent against a bridge. */
export function receiveMessageEvent(
  bridge: HostBridge,
  event: { readonly data: unknown; readonly origin?: string | undefined; readonly source?: unknown },
  expectedSource?: unknown,
): BridgeInbound {
  return bridge.accept({ data: event.data, origin: event.origin, source: event.source }, expectedSource);
}
