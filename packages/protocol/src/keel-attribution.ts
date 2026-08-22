/** Portable creator-authored attribution records for Keel objects and viewers. */
export const KEEL_ATTRIBUTION_PROTOCOL = "keel-attribution@1" as const;
export const KEEL_ATTRIBUTION_MAX_ENTRIES = 128 as const;
export const KEEL_ATTRIBUTION_MAX_TAG_BYTES = 64 as const;
export const KEEL_ATTRIBUTION_MAX_DISPLAY_NAME_BYTES = 96 as const;

/** Suggestions only. A creator may use any non-empty custom tag. */
export const KEEL_ATTRIBUTION_ROLE_SUGGESTIONS = Object.freeze([
  "artist",
  "engineer",
  "designer",
  "writer",
  "producer",
  "contributor",
  "partner",
  "curator",
  "researcher",
  "other",
] as const);

export type KeelAttributionSubjectKind = "object" | "viewer";

/** An optional exact subject binding for a portable attribution record. */
export interface KeelAttributionTarget {
  readonly kind: KeelAttributionSubjectKind;
  /** A logical object ID, viewer ID, or a creator-defined portable subject ID. */
  readonly id: string;
  /** Optional revision at which this attribution was recorded. */
  readonly revision?: number;
  /** Optional registry identifier for cross-registry portability. */
  readonly registry?: string;
}

/**
 * A label is descriptive metadata, not an access grant. Multiple entries may
 * name the same account with different labels, such as artist and engineer.
 */
export interface KeelAttribution {
  /** EVM address, Tezos address, DID, or another declared creator identity. */
  readonly account: string;
  /** Creator-authored label; built-in role suggestions are not an enum. */
  readonly tag: string;
  readonly displayName?: string;
  readonly target?: KeelAttributionTarget;
}

export interface KeelAttributionSet {
  readonly protocol: typeof KEEL_ATTRIBUTION_PROTOCOL;
  readonly entries: readonly KeelAttribution[];
}

const CONTROL = /[\u0000-\u001f\u007f]/u;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${path} must not be empty.`);
  if (CONTROL.test(normalized)) throw new TypeError(`${path} must not contain control characters.`);
  if (byteLength(normalized) > maxBytes) throw new RangeError(`${path} is limited to ${maxBytes} UTF-8 bytes.`);
  return normalized;
}

function target(value: unknown, path: string): KeelAttributionTarget | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "object" && input.kind !== "viewer") throw new TypeError(`${path}.kind must be object or viewer.`);
  const id = text(input.id, `${path}.id`, 128);
  const revision = input.revision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1)) {
    throw new RangeError(`${path}.revision must be a positive safe integer.`);
  }
  const registry = input.registry === undefined ? undefined : text(input.registry, `${path}.registry`, 128);
  return {
    kind: input.kind,
    id,
    ...(revision === undefined ? {} : { revision: Number(revision) }),
    ...(registry === undefined ? {} : { registry }),
  };
}

/** Normalize and validate creator-authored attribution entries. */
export function normalizeKeelAttributions(
  value: readonly KeelAttribution[],
): readonly KeelAttribution[] {
  if (!Array.isArray(value)) throw new TypeError("Keel attributions must be an array.");
  if (value.length > KEEL_ATTRIBUTION_MAX_ENTRIES) {
    throw new RangeError(`Keel attributions are limited to ${KEEL_ATTRIBUTION_MAX_ENTRIES} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`attributions[${index}] must be an object.`);
    }
    const account = text(entry.account, `attributions[${index}].account`, 128);
    const tag = text(entry.tag, `attributions[${index}].tag`, KEEL_ATTRIBUTION_MAX_TAG_BYTES);
    const displayName = entry.displayName === undefined
      ? undefined
      : text(entry.displayName, `attributions[${index}].displayName`, KEEL_ATTRIBUTION_MAX_DISPLAY_NAME_BYTES);
    const subject = target(entry.target, `attributions[${index}].target`);
    const key = `${subject?.kind ?? "viewer"}:${subject?.id.toLowerCase() ?? "manifest"}:${account.toLowerCase()}:${tag.toLowerCase()}`;
    if (seen.has(key)) throw new TypeError(`Duplicate attribution at attributions[${index}].`);
    seen.add(key);
    return {
      account,
      tag,
      ...(displayName === undefined ? {} : { displayName }),
      ...(subject === undefined ? {} : { target: subject }),
    };
  });
}

export function assertValidKeelAttributions(value: unknown): asserts value is readonly KeelAttribution[] {
  normalizeKeelAttributions(value as readonly KeelAttribution[]);
}

