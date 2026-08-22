import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  createIntegrity,
  manifestIntegrity,
  parseArtifactManifest,
  verifyIntegrity,
  type ArtifactManifest,
  type Hex,
  type Integrity,
  type ResourceSource,
} from "@keel/protocol";
import { decompressBytes } from "./compress.js";

export type VerificationStatus = "verified" | "failed" | "unavailable";

export interface SourceVerificationResult {
  readonly index: number;
  readonly kind: ResourceSource["kind"];
  readonly status: VerificationStatus;
  readonly message?: string;
  readonly actual?: Integrity;
}

export interface ResourceVerificationResult {
  readonly resource: string;
  readonly status: VerificationStatus;
  readonly sources: readonly SourceVerificationResult[];
}

export interface ManifestVerificationResult {
  readonly status: VerificationStatus;
  readonly envelopePresent: boolean;
  readonly expected?: Integrity;
  readonly actual?: Integrity;
  readonly message?: string;
}

export interface VerifyBuiltArtifactOptions {
  readonly directory: string;
  readonly manifestName?: string;
  /** Optional local safety cap for decoded resource reads. Legacy callers remain uncapped. */
  readonly maxSourceBytes?: number;
  /** Optional cap for manifest and integrity-envelope reads. */
  readonly maxManifestBytes?: number;
}

export interface BuiltArtifactVerification {
  readonly schema: "oca-build-verification@1";
  readonly valid: boolean;
  readonly manifestPath: string;
  readonly manifestIntegrity: ManifestVerificationResult;
  readonly resources: readonly ResourceVerificationResult[];
  readonly issues: readonly string[];
  readonly manifest?: ArtifactManifest;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function parseIntegrity(value: unknown, label: string): Integrity {
  const object = jsonObject(value, label);
  const algorithm = object.algorithm;
  if (algorithm !== "sha256" && algorithm !== "keccak256" && algorithm !== "none") throw new TypeError(`${label}.algorithm is unsupported.`);
  const digest = object.digest;
  if (typeof digest !== "string" || !/^0x[0-9a-f]*$/u.test(digest)) throw new TypeError(`${label}.digest must be lowercase hexadecimal.`);
  const byteLength = object.byteLength;
  if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0)) throw new TypeError(`${label}.byteLength must be a non-negative safe integer.`);
  return {
    algorithm,
    digest: digest as Hex,
    ...(byteLength === undefined ? {} : { byteLength: byteLength as number }),
  };
}

function integrityEnvelope(value: unknown): Integrity {
  const object = jsonObject(value, "manifest integrity");
  if (object.schema !== "oca-manifest-integrity@2") throw new TypeError("manifest integrity schema is unsupported.");
  return parseIntegrity(object.integrity, "manifest integrity.integrity");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function localSourcePath(root: string, uri: string): Promise<string> {
  if (uri.length === 0 || uri.startsWith("/") || /^[a-z][a-z\d+.-]*:/iu.test(uri)) throw new Error("only manifest-relative sources can be verified locally");
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error("source URI is not valid percent-encoding");
  }
  const resolvedRoot = await realpath(root);
  const resolved = path.resolve(resolvedRoot, decoded);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("source URI escapes the artifact directory");
  }
  const resolvedTarget = await realpath(resolved);
  const realRelative = path.relative(resolvedRoot, resolvedTarget);
  if (realRelative.length === 0 || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error("source URI symlink escapes the artifact directory");
  }
  return resolvedTarget;
}

function decodeBase64(value: string, urlSafe: boolean): Uint8Array {
  const normalized = urlSafe ? value.replaceAll("-", "+").replaceAll("_", "/") : value;
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

async function sourceBytes(source: ResourceSource, root: string, maxSourceBytes?: number): Promise<Uint8Array> {
  let bytes: Uint8Array;
  switch (source.kind) {
    case "inline":
      if (source.encoding === "utf8") bytes = new TextEncoder().encode(source.data);
      else if (source.encoding === "base64") bytes = decodeBase64(source.data, false);
      else if (source.encoding === "base64url") bytes = decodeBase64(source.data, true);
      else throw new Error(`inline ${source.encoding} is not supported by the local verifier`);
      break;
    case "uri":
      {
        const sourcePath = await localSourcePath(root, source.uri);
        const info = await stat(sourcePath);
        if (maxSourceBytes !== undefined && info.size > maxSourceBytes) throw new RangeError("decoded source exceeds the configured MCP safety cap");
        bytes = new Uint8Array(await readFile(sourcePath));
        const after = await stat(sourcePath);
        if (bytes.byteLength !== info.size || bytes.byteLength !== after.size) throw new Error("decoded source changed while it was being read");
      }
      break;
    default:
      throw new Error(`${source.kind} sources require a chain or gateway resolver`);
  }
  const decoded = source.compression === undefined || source.compression === "none" ? bytes : await decompressBytes(source.compression, bytes);
  if (maxSourceBytes !== undefined && decoded.byteLength > maxSourceBytes) throw new RangeError("decoded source exceeds the configured MCP safety cap");
  return decoded;
}

async function readBounded(filePath: string, maxBytes: number | undefined): Promise<Uint8Array> {
  if (maxBytes === undefined) return new Uint8Array(await readFile(filePath));
  const before = await stat(filePath);
  if (!before.isFile() || before.size > maxBytes) throw new RangeError(`file exceeds the configured ${maxBytes}-byte manifest cap`);
  const bytes = new Uint8Array(await readFile(filePath));
  const after = await stat(filePath);
  if (bytes.byteLength !== before.size || bytes.byteLength !== after.size) throw new Error("file changed while it was being read");
  return bytes;
}

async function verifyResource(resource: ArtifactManifest["resources"][number], root: string, maxSourceBytes?: number): Promise<ResourceVerificationResult> {
  const sourceResults: SourceVerificationResult[] = [];
  for (let index = 0; index < resource.sources.length; index += 1) {
    const source = resource.sources[index];
    if (source === undefined) continue;
    try {
      const bytes = await sourceBytes(source, root, maxSourceBytes);
      const actual = await createIntegrity(bytes, source.integrity.algorithm);
      const valid = await verifyIntegrity(bytes, source.integrity);
      sourceResults.push({ index, kind: source.kind, status: valid ? "verified" : "failed", ...(valid ? {} : { actual, message: "decoded bytes do not match the committed integrity" }) });
      if (valid) break;
    } catch (error) {
      sourceResults.push({ index, kind: source.kind, status: "unavailable", message: errorText(error) });
    }
  }
  const status = sourceResults.some((source) => source.status === "verified")
    ? "verified"
    : sourceResults.some((source) => source.status === "failed")
      ? "failed"
      : "unavailable";
  return { resource: resource.id, status, sources: sourceResults };
}

export async function verifyBuiltArtifact(options: VerifyBuiltArtifactOptions): Promise<BuiltArtifactVerification> {
  const directory = path.resolve(options.directory);
  const manifestName = options.manifestName ?? "manifest.json";
  if (options.maxSourceBytes !== undefined && (!Number.isSafeInteger(options.maxSourceBytes) || options.maxSourceBytes <= 0)) throw new RangeError("maxSourceBytes must be a positive safe integer.");
  if (options.maxManifestBytes !== undefined && (!Number.isSafeInteger(options.maxManifestBytes) || options.maxManifestBytes <= 0)) throw new RangeError("maxManifestBytes must be a positive safe integer.");
  if (
    manifestName.length === 0 ||
    manifestName === "." ||
    manifestName === ".." ||
    manifestName.includes("/") ||
    manifestName.includes("\\") ||
    /[<>:"|?*]/u.test(manifestName) ||
    /[\u0000-\u001f\u007f]/u.test(manifestName)
  ) {
    throw new TypeError("manifestName must be a filename-safe segment without path separators.");
  }
  const manifestPath = path.join(directory, manifestName);
  const issues: string[] = [];
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await readBounded(manifestPath, options.maxManifestBytes);
  } catch (error) {
    const message = `manifest could not be read: ${errorText(error)}`;
    return {
      schema: "oca-build-verification@1",
      valid: false,
      manifestPath,
      manifestIntegrity: { status: "unavailable", envelopePresent: false, message },
      resources: [],
      issues: [message],
    };
  }
  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown);
  } catch (error) {
    const message = `manifest is invalid: ${errorText(error)}`;
    return {
      schema: "oca-build-verification@1",
      valid: false,
      manifestPath,
      manifestIntegrity: { status: "failed", envelopePresent: false, message },
      resources: [],
      issues: [message],
    };
  }

  const actualManifestIntegrity = await manifestIntegrity(manifest);
  let manifestIntegrityResult: ManifestVerificationResult;
  try {
    const envelopeBytes = await readBounded(path.join(directory, "manifest.integrity.json"), options.maxManifestBytes);
    const expected = integrityEnvelope(JSON.parse(new TextDecoder().decode(envelopeBytes)) as unknown);
    const valid = expected.algorithm === actualManifestIntegrity.algorithm && expected.digest === actualManifestIntegrity.digest && expected.byteLength === actualManifestIntegrity.byteLength;
    manifestIntegrityResult = {
      status: valid ? "verified" : "failed",
      envelopePresent: true,
      expected,
      actual: actualManifestIntegrity,
      ...(valid ? {} : { message: "manifest.integrity.json does not match the canonical manifest" }),
    };
  } catch (error) {
    manifestIntegrityResult = { status: "unavailable", envelopePresent: false, actual: actualManifestIntegrity, message: errorText(error) };
  }
  if (manifestIntegrityResult.status !== "verified") issues.push(`manifest integrity ${manifestIntegrityResult.status}: ${manifestIntegrityResult.message ?? "mismatch"}`);

  const resources: ResourceVerificationResult[] = [];
  for (const resource of manifest.resources) {
    const result = await verifyResource(resource, directory, options.maxSourceBytes);
    resources.push(result);
    if (result.status !== "verified") issues.push(`resource ${resource.id} ${result.status}`);
  }
  return {
    schema: "oca-build-verification@1",
    valid: manifestIntegrityResult.status === "verified" && resources.every((resource) => resource.status === "verified"),
    manifestPath,
    manifestIntegrity: manifestIntegrityResult,
    resources,
    issues,
    manifest,
  };
}
