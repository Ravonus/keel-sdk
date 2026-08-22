/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * The implementation intentionally accepts only values representable by parsed
 * JSON: finite IEEE-754 numbers, valid Unicode strings, arrays, plain objects,
 * booleans, and null. Object names are sorted by UTF-16 code units as required
 * by JCS, while number and string serialization delegates to ECMAScript's
 * JSON.stringify algorithms referenced by RFC 8785.
 */
export const RFC8785_CANONICALIZATION = "RFC8785" as const;

type CanonicalPrimitive = null | boolean | number | string;
export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`Lone high surrogate is not valid I-JSON at ${path}.`);
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`Lone low surrogate is not valid I-JSON at ${path}.`);
    }
  }
}

function normalize(value: unknown, path: string, seen: Set<object>): CanonicalValue {
  if (value === null || typeof value === "boolean") return value;

  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number is not valid I-JSON at ${path}.`);
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value === "bigint") {
    throw new TypeError(`BigInt is not JSON at ${path}; encode it as a decimal string.`);
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Unsupported JSON value at ${path}.`);
  }

  if (typeof value !== "object") throw new TypeError(`Unsupported JSON value at ${path}.`);
  if (seen.has(value)) throw new TypeError(`Circular reference at ${path}.`);
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalize(item, `${path}[${index}]`, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Only plain JSON objects are canonicalizable at ${path}.`);
    }

    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      assertUnicodeScalarString(key, `${path}.[key]`);
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === "undefined") throw new TypeError(`Undefined object member at ${path}.${key}.`);
      output[key] = normalize(item, `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalize(value: unknown): CanonicalValue {
  return normalize(value, "$", new Set<object>());
}

/** RFC 8785/JCS serialization. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Explicit alias for callers that want the normative standard in the API. */
export const canonicalizeRfc8785 = canonicalJson;
