import { verifyIntegrity, type RuntimeViewerMirror } from "@keel/protocol";
import { remoteUrlAllowed, viewerMirrorLocations } from "./source-policy.js";
import type { FetchLike, VerifiedViewerBundle, ViewerBundleLoadOptions, ViewerLaunch } from "./types.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") throw new Error("fetch() is unavailable; provide a fetch adapter.");
  return globalThis.fetch as unknown as FetchLike;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return resolved;
}

function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  if (parent.aborted) {
    controller.abort(parent.reason);
    return () => undefined;
  }
  const listener = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", listener, { once: true });
  return () => parent.removeEventListener("abort", listener);
}

export async function loadVerifiedViewerBundle(
  mirrors: readonly RuntimeViewerMirror[],
  options: ViewerBundleLoadOptions = {},
): Promise<VerifiedViewerBundle> {
  if (mirrors.length === 0) throw new Error("No viewer mirrors were declared.");
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const fetcher = options.fetch ?? defaultFetch();
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const timeout = setTimeout(() => controller.abort(new Error("Viewer bundle load timed out.")), timeoutMs);
  let lastError: unknown;

  try {
    for (const mirror of mirrors) {
      for (const location of viewerMirrorLocations(mirror, options)) {
        if (!remoteUrlAllowed(location, options.sourceAllowlist, options.allowPrivateNetworkSources)) {
          lastError = new Error(`Viewer mirror is not permitted: ${location}`);
          continue;
        }
        try {
          await options.authorizeRemoteSource?.(location, controller.signal);
          const response = await fetcher(location, { signal: controller.signal, redirect: "error" });
          if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${location}.`);
          const sourceUrl = response.url || location;
          if (!remoteUrlAllowed(sourceUrl, options.sourceAllowlist, options.allowPrivateNetworkSources)) {
            throw new Error(`Viewer mirror response location is not permitted: ${sourceUrl}`);
          }
          await options.authorizeRemoteSource?.(sourceUrl, controller.signal);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > maxBytes) throw new RangeError(`Viewer bundle exceeds ${maxBytes} bytes.`);
          if (!(await verifyIntegrity(bytes, mirror.integrity, options.customDigest))) {
            throw new Error(`Viewer bundle integrity failed for mirror ${mirror.id}.`);
          }
          return { mirror, bytes, sourceUrl, integrityVerified: true };
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("No verified viewer mirror could be loaded.");
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}

export function viewerLaunches(
  mirrors: readonly RuntimeViewerMirror[],
  manifestUri: string,
  manifestDigest: string,
): readonly ViewerLaunch[] {
  return mirrors.map((mirror) => {
    const launchUrl = mirror.launchUrlTemplate
      ?.replaceAll("{manifest}", encodeURIComponent(manifestUri))
      .replaceAll("{digest}", encodeURIComponent(manifestDigest));
    return {
      mirrorId: mirror.id,
      bundleUri: mirror.uri,
      ...(launchUrl === undefined ? {} : { launchUrl }),
      integrity: mirror.integrity,
    };
  });
}
