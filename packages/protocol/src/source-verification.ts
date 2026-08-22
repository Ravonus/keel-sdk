import { canonicalJson } from "./canonical.js";
import { utf8ToBytes } from "./bytes.js";
import { createIntegrity } from "./integrity.js";
import type { Hex, Integrity } from "./types.js";

export const KEEL_SOURCE_ANALYSIS_PROTOCOL = "keel-source-analysis@1" as const;
export const KEEL_SOURCE_RECEIPT_PROTOCOL = "keel-source-receipt@1" as const;
export const KEEL_SOURCE_BUILD_VERIFICATION_PROTOCOL = "keel-source-build-verification@1" as const;
export const KEEL_SOURCE_ANALYZER_VERSION = "1.0.0" as const;

export type SourceReadabilityClass =
  | "readable"
  | "minified"
  | "potentially-obfuscated"
  | "not-applicable";

export interface SourceReadabilityMetrics {
  readonly characters: number;
  readonly lines: number;
  readonly longestLine: number;
  readonly averageLine: number;
  readonly whitespaceRatioPermille: number;
  readonly commentCharacters: number;
  readonly identifiers: number;
  readonly shortIdentifierRatioPermille: number;
  readonly dynamicCodeCalls: number;
  readonly encodedLiteralCharacters: number;
}

/** Deterministic heuristic report. It classifies source; it is not proof of author intent. */
export interface SourceReadabilityReport {
  readonly protocol: typeof KEEL_SOURCE_ANALYSIS_PROTOCOL;
  readonly analyzer: { readonly name: "keel-source-readability"; readonly version: typeof KEEL_SOURCE_ANALYZER_VERSION };
  readonly mediaType: string;
  readonly classification: SourceReadabilityClass;
  readonly readabilityScore: number;
  readonly metrics: SourceReadabilityMetrics;
  readonly reasons: readonly string[];
}

export interface KeelSourceReceipt {
  readonly protocol: typeof KEEL_SOURCE_RECEIPT_PROTOCOL;
  readonly source: Integrity;
  readonly output: Integrity;
  readonly report: SourceReadabilityReport;
  readonly reportDigest: Hex;
  readonly repository?: {
    readonly url: string;
    readonly revision: string;
    readonly path: string;
  };
  /** Digest of a canonical deterministic build recipe. Required when source and output differ. */
  readonly buildRecipeDigest?: Hex;
  readonly verification?: {
    readonly protocol: typeof KEEL_SOURCE_BUILD_VERIFICATION_PROTOCOL;
    readonly verifier: { readonly name: string; readonly version: string };
    readonly buildRecipeDigest: Hex;
    readonly rebuiltOutput: Integrity;
  };
  readonly disposition: "queued" | "exact-source-output" | "reproducible-build";
}

const TEXT_MEDIA = /^(?:text\/|application\/(?:javascript|json|typescript|xml|wasm-text))/iu;
const IDENTIFIER = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/gu;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/gu;
const DYNAMIC_CODE = /\b(?:eval|Function)\s*\(|\bset(?:Timeout|Interval)\s*\(\s*["']/gu;
const ENCODED_LITERAL = /["'`](?:[A-Za-z0-9+/]{160,}={0,2}|(?:\\x[0-9a-fA-F]{2}){40,}|(?:\\u[0-9a-fA-F]{4}){24,})["'`]/gu;
const RESERVED = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false", "finally", "for", "from",
  "function", "get", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return",
  "set", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var",
  "void", "while", "with", "yield",
]);

function permille(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator * 1_000) / denominator);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function analyzeSourceReadability(source: string, mediaType: string): SourceReadabilityReport {
  if (!TEXT_MEDIA.test(mediaType)) {
    return {
      protocol: KEEL_SOURCE_ANALYSIS_PROTOCOL,
      analyzer: { name: "keel-source-readability", version: KEEL_SOURCE_ANALYZER_VERSION },
      mediaType,
      classification: "not-applicable",
      readabilityScore: 0,
      metrics: {
        characters: source.length,
        lines: 0,
        longestLine: 0,
        averageLine: 0,
        whitespaceRatioPermille: 0,
        commentCharacters: 0,
        identifiers: 0,
        shortIdentifierRatioPermille: 0,
        dynamicCodeCalls: 0,
        encodedLiteralCharacters: 0,
      },
      reasons: ["Readability analysis applies only to declared textual source."],
    };
  }

  const lines = source.split(/\r?\n/u);
  const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
  const whitespace = source.match(/\s/gu)?.length ?? 0;
  const comments = source.match(COMMENTS) ?? [];
  const identifiers = (source.match(IDENTIFIER) ?? []).filter((identifier) => !RESERVED.has(identifier));
  const shortIdentifiers = identifiers.filter((identifier) => identifier.length <= 2).length;
  const dynamicCodeCalls = source.match(DYNAMIC_CODE)?.length ?? 0;
  const encodedLiterals = source.match(ENCODED_LITERAL) ?? [];
  const encodedLiteralCharacters = encodedLiterals.reduce((total, literal) => total + literal.length, 0);
  const whitespaceRatioPermille = permille(whitespace, source.length);
  const shortIdentifierRatioPermille = permille(shortIdentifiers, identifiers.length);
  const commentCharacters = comments.reduce((total, comment) => total + comment.length, 0);
  const averageLine = lines.length === 0 ? 0 : Math.round(source.length / lines.length);

  const minifiedLayout = source.length >= 400 && (longestLine >= 800 || averageLine >= 320) && whitespaceRatioPermille < 160;
  const encodedPayload = encodedLiteralCharacters >= 160;
  const opaqueNames = identifiers.length >= 20 && shortIdentifierRatioPermille >= 720;
  const potentialObfuscation = (dynamicCodeCalls > 0 && (encodedPayload || opaqueNames)) || encodedLiteralCharacters >= 2_000;

  let classification: SourceReadabilityClass;
  if (potentialObfuscation) classification = "potentially-obfuscated";
  else if (minifiedLayout || (opaqueNames && longestLine >= 500)) classification = "minified";
  else classification = "readable";

  let readabilityScore = 100;
  if (longestLine >= 800) readabilityScore -= 30;
  else if (longestLine >= 300) readabilityScore -= 12;
  if (whitespaceRatioPermille < 80) readabilityScore -= 24;
  else if (whitespaceRatioPermille < 130) readabilityScore -= 10;
  if (opaqueNames) readabilityScore -= 28;
  if (dynamicCodeCalls > 0) readabilityScore -= Math.min(20, dynamicCodeCalls * 5);
  if (encodedPayload) readabilityScore -= Math.min(30, Math.ceil(encodedLiteralCharacters / 250));
  if (commentCharacters > 0) readabilityScore += 4;
  readabilityScore = clamp(readabilityScore, 0, 100);

  const reasons: string[] = [];
  if (classification === "readable") reasons.push("Layout and identifier signals are consistent with human-readable source.");
  if (minifiedLayout) reasons.push("Most code is concentrated into unusually long lines with little whitespace.");
  if (opaqueNames) reasons.push("A high share of identifiers are one or two characters long.");
  if (dynamicCodeCalls > 0) reasons.push("Dynamic code construction is present and requires reviewer attention.");
  if (encodedPayload) reasons.push("Large encoded string payloads are present and require reviewer attention.");
  if (commentCharacters > 0) reasons.push("Source retains comments that can aid review.");
  if (reasons.length === 0) reasons.push("No strong readability or obfuscation signal was found.");

  return {
    protocol: KEEL_SOURCE_ANALYSIS_PROTOCOL,
    analyzer: { name: "keel-source-readability", version: KEEL_SOURCE_ANALYZER_VERSION },
    mediaType,
    classification,
    readabilityScore,
    metrics: {
      characters: source.length,
      lines: lines.length,
      longestLine,
      averageLine,
      whitespaceRatioPermille,
      commentCharacters,
      identifiers: identifiers.length,
      shortIdentifierRatioPermille,
      dynamicCodeCalls,
      encodedLiteralCharacters,
    },
    reasons,
  };
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

export async function createSourceReceipt(input: {
  readonly sourceBytes: Uint8Array;
  readonly outputBytes: Uint8Array;
  readonly mediaType: string;
  readonly repository?: { readonly url: string; readonly revision: string; readonly path: string };
  readonly buildRecipeDigest?: Hex;
}): Promise<KeelSourceReceipt> {
  const sourceText = TEXT_MEDIA.test(input.mediaType)
    ? new TextDecoder("utf-8", { fatal: true }).decode(input.sourceBytes)
    : "";
  const report = analyzeSourceReadability(sourceText, input.mediaType);
  const [source, output, reportIntegrity] = await Promise.all([
    createIntegrity(input.sourceBytes),
    createIntegrity(input.outputBytes),
    createIntegrity(utf8ToBytes(canonicalJson(report))),
  ]);
  if (!sameIntegrity(source, output) && input.buildRecipeDigest === undefined) {
    throw new TypeError("Transformed output requires the digest of its deterministic build recipe.");
  }
  return {
    protocol: KEEL_SOURCE_RECEIPT_PROTOCOL,
    source,
    output,
    report,
    reportDigest: reportIntegrity.digest,
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.buildRecipeDigest === undefined ? {} : { buildRecipeDigest: input.buildRecipeDigest }),
    disposition: sameIntegrity(source, output) ? "exact-source-output" : "queued",
  };
}

/** Records the result after a sandbox/build worker reproduces the exact decoded artifact bytes. */
export async function verifySourceBuild(input: {
  readonly sourceBytes: Uint8Array;
  readonly outputBytes: Uint8Array;
  readonly rebuiltOutputBytes: Uint8Array;
  readonly mediaType: string;
  readonly repository?: { readonly url: string; readonly revision: string; readonly path: string };
  readonly buildRecipeDigest: Hex;
  readonly verifier: { readonly name: string; readonly version: string };
}): Promise<KeelSourceReceipt> {
  const receipt = await createSourceReceipt(input);
  const rebuiltOutput = await createIntegrity(input.rebuiltOutputBytes);
  if (!sameIntegrity(receipt.output, rebuiltOutput)) {
    throw new TypeError("Rebuilt output does not match the exact decoded Keel artifact.");
  }
  if (sameIntegrity(receipt.source, receipt.output)) return receipt;
  return {
    ...receipt,
    verification: {
      protocol: KEEL_SOURCE_BUILD_VERIFICATION_PROTOCOL,
      verifier: input.verifier,
      buildRecipeDigest: input.buildRecipeDigest,
      rebuiltOutput,
    },
    disposition: "reproducible-build",
  };
}
