import type { CompressionSummary } from "./types.js";

export function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return value;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "artifact";
}

export function normalizeVirtualPath(value: string): string {
  const trimmed = value.trim();
  if (!/^\/(?:content|onchain|ipfs)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(trimmed)) {
    throw new TypeError("Virtual path is outside the Keel gateway namespaces.");
  }
  if (trimmed.includes("..") || trimmed.includes("\\") || trimmed.includes("?") || trimmed.includes("#")) {
    throw new TypeError("Virtual path contains unsafe syntax.");
  }
  return trimmed;
}

export function compressionSummary(originalBytes: number, storedBytes: number): CompressionSummary {
  nonNegativeSafeInteger(originalBytes, "originalBytes");
  nonNegativeSafeInteger(storedBytes, "storedBytes");
  if (originalBytes === 0) return { originalBytes, storedBytes, savedBytes: 0, ratio: 1, percentSaved: 0 };
  const savedBytes = Math.max(0, originalBytes - storedBytes);
  return {
    originalBytes,
    storedBytes,
    savedBytes,
    ratio: storedBytes / originalBytes,
    percentSaved: (savedBytes / originalBytes) * 100,
  };
}

export function formatBytes(value: number): string {
  nonNegativeSafeInteger(value, "bytes");
  if (value < 1_000) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let amount = value / 1_000;
  let index = 0;
  while (amount >= 1_000 && index < units.length - 1) {
    amount /= 1_000;
    index += 1;
  }
  const unit = units[index] ?? "TB";
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
}
