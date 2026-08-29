import {
  defaultKeelStudioPublicationIntent,
  type KeelStudioPublicationIntent,
} from "./studio-publication.js";

export const KEEL_STUDIO_ARTIFACT_UPLOAD_PROTOCOL = "keel-studio-artifact-upload@1" as const;

export interface KeelStudioArtifactUploadResult {
  readonly id: string;
}

export interface UploadKeelStudioArtifactInput {
  readonly endpoint: string | URL;
  readonly formData: FormData;
  readonly writeToken?: string;
  readonly onProgress?: (percent: number) => void;
  readonly fetchImplementation?: typeof fetch;
}

export type KeelStudioComponentRole =
  | "entrypoint"
  | "renderer"
  | "runtime"
  | "script"
  | "module"
  | "style"
  | "data"
  | "library"
  | "image"
  | "other";

export type KeelStudioComponentFormat = "asset" | "classic-script" | "es-module" | "umd" | "wasm";

/**
 * Manifest declaration for a Flash/SWF project that runs through the
 * verified, self-hosted Ruffle runtime. The paths are project-relative and
 * are resolved again by Studio after every staged file is digest-checked.
 */
export interface KeelStudioFlashRuntime {
  readonly swfPath: string;
  readonly loaderPath: string;
  readonly seededRandomPath: string;
  readonly editionPath: string;
  readonly ruffleMainPath: string;
  readonly ruffleModernCorePath: string;
  readonly ruffleLegacyCorePath: string;
  /** Optional MVP/vanilla WASM. Unsupported browsers may upload it locally. */
  readonly ruffleModernWasmPath?: string;
  readonly ruffleLegacyWasmPath: string;
  readonly ruffleModernWasmSha256?: string;
  readonly ruffleModernWasmByteLength?: number;
  readonly ruffleModernWasmFileName?: string;
  readonly collectionSize: number;
  readonly previewRootSeed?: string;
}

export interface KeelStudioStagedProjectFile {
  readonly path: string;
  readonly bytes: Blob | Uint8Array;
  readonly mediaType: string;
  readonly role: KeelStudioComponentRole;
  readonly format: KeelStudioComponentFormat;
  readonly updateMode?: "locked" | "manual";
  readonly label?: string;
}

export interface StageKeelStudioProjectInput {
  readonly studioUrl: string | URL;
  readonly agentToken: string;
  readonly title: string;
  readonly description?: string;
  readonly storageStrategy: "local" | "onchain" | "hybrid";
  readonly marketplaceExportMode?: "recursive" | "packed" | "hybrid" | "onchfs";
  /** Defaults to the reusable KEEL verification shell. */
  readonly viewer?: "keel-verification-shell" | "none";
  readonly files: readonly KeelStudioStagedProjectFile[];
  readonly reusableModule?: {
    readonly resourcePaths: readonly string[];
    readonly assetType: "runtime" | "library" | "tool" | "other";
    readonly license: string;
    readonly accessMode?: "open" | "paid" | "license" | "subscription" | "request" | "special";
    readonly tags?: readonly string[];
  };
  readonly releaseIntent?: {
    readonly schema: "keel-release-intent@1";
    readonly chainId: number;
    readonly mode: "art-only" | "release";
    readonly collection: {
      readonly mode: "choose-in-studio" | "new" | "existing";
      readonly address?: `0x${string}`;
    };
    readonly release: {
      readonly type: "open-edition" | "limited-edition" | "one-of-one" | "generative-series" | "unique-set" | "interactive-work" | "game-world" | "asset-library" | "custom";
      readonly supply: string;
      readonly saleMechanism: "fixed-price" | "auction" | "claim";
      readonly priceEth: string;
      readonly accessMode: "public" | "allowlist" | "holder" | "claim" | "custom";
      readonly startsAt: string | null;
      readonly endsAt: string | null;
    };
    /** Initial Studio choice. The UI still measures exact size and read gas. */
    readonly presentation?: {
      readonly preferredMode: "inline" | "hybrid" | "ipfs";
    };
    readonly status: "editable-draft";
    readonly wallet: { readonly approvalRequiredNow: false; readonly transactionSubmitted: false };
  };
  readonly publicationIntent?: KeelStudioPublicationIntent;
  readonly flashRuntime?: KeelStudioFlashRuntime;
  readonly fetchImplementation?: typeof fetch;
}

export interface KeelStudioProjectHandoffResult {
  readonly schema: "keel-studio-project-handoff@1";
  readonly id: string;
  readonly handoffUrl: string;
  readonly expiresAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly wallet: { readonly signing: "not-performed"; readonly submission: "not-performed" };
}

interface UploadErrorBody {
  readonly error?: string;
}

function result(value: unknown, status: number): KeelStudioArtifactUploadResult {
  if (typeof value !== "object" || value === null) {
    throw new Error(`KEEL Studio upload returned HTTP ${status} without a JSON result.`);
  }
  const body = value as UploadErrorBody & { readonly id?: unknown };
  if (status < 200 || status >= 300) {
    throw new Error(body.error ?? `KEEL Studio upload failed with HTTP ${status}.`);
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new Error("KEEL Studio upload did not return an artifact ID.");
  }
  return Object.freeze({ id: body.id });
}

/**
 * Uploads an artifact to KEEL Studio without performing any wallet or chain
 * action. Browser callers use their signed creator session; agents use the
 * server-side write token and an explicit creatorAddress form field.
 */
export async function uploadKeelStudioArtifact(
  input: UploadKeelStudioArtifactInput,
): Promise<KeelStudioArtifactUploadResult> {
  if (input.onProgress !== undefined && typeof XMLHttpRequest !== "undefined") {
    return uploadWithProgress(input);
  }
  const request = input.fetchImplementation ?? fetch;
  const response = await request(input.endpoint, {
    method: "POST",
    body: input.formData,
    credentials: "same-origin",
    ...(input.writeToken === undefined
      ? {}
      : { headers: { "x-keel-studio-write-token": input.writeToken } }),
  });
  return result(await response.json(), response.status);
}

function safeProjectPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized.length === 0 || normalized.length > 512 || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`Invalid staged project path: ${JSON.stringify(value)}.`);
  }
  return normalized;
}

/**
 * Stages a creator-editable project and returns a secret continuation URL.
 * This is an off-chain upload only: it neither requests a wallet signature nor
 * submits a transaction. The creator signs in and reviews the project later.
 */
export async function stageKeelStudioProject(
  input: StageKeelStudioProjectInput,
): Promise<KeelStudioProjectHandoffResult> {
  const title = input.title.trim();
  if (title.length < 2 || title.length > 160) throw new RangeError("Staged project title must contain from 2 through 160 characters.");
  if (input.agentToken.length < 32) throw new TypeError("KEEL Studio agent token must contain at least 32 characters.");
  if (input.files.length < 1 || input.files.length > 256) throw new RangeError("Stage from 1 through 256 project files.");
  if (input.viewer === "none" && input.publicationIntent !== undefined) {
    throw new TypeError("A storage-only project cannot also require the KEEL verification shell.");
  }

  const paths = input.files.map((file) => safeProjectPath(file.path));
  if (new Set(paths).size !== paths.length) throw new TypeError("Staged project paths must be unique.");
  const form = new FormData();
  const components = input.files.map((file, index) => ({
    path: paths[index],
    mediaType: file.mediaType,
    role: file.role,
    format: file.format,
    updateMode: file.updateMode ?? "locked",
    label: file.label ?? paths[index]?.split("/").at(-1) ?? paths[index],
  }));
  const publicationIntent = input.viewer === "none"
    ? undefined
    : input.publicationIntent ?? defaultKeelStudioPublicationIntent();
  form.set("metadata", JSON.stringify({
    schema: "keel-studio-staged-project@1",
    title,
    description: input.description?.trim() ?? "",
    storageStrategy: input.storageStrategy,
    marketplaceExportMode: input.marketplaceExportMode ?? "recursive",
    components,
    ...(input.reusableModule === undefined ? {} : { reusableModule: input.reusableModule }),
    ...(input.releaseIntent === undefined ? {} : { releaseIntent: input.releaseIntent }),
    ...(publicationIntent === undefined ? {} : { publicationIntent }),
    ...(input.flashRuntime === undefined ? {} : { flashRuntime: input.flashRuntime }),
  }));
  input.files.forEach((file, index) => {
    const blob = file.bytes instanceof Blob ? file.bytes : new Blob([Uint8Array.from(file.bytes).buffer], { type: file.mediaType });
    form.append("files", blob, paths[index]);
  });

  const endpoint = new URL("/api/agent/staging", input.studioUrl);
  const response = await (input.fetchImplementation ?? fetch)(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${input.agentToken}` },
    body: form,
  });
  const value = await response.json() as Partial<KeelStudioProjectHandoffResult> & UploadErrorBody;
  if (!response.ok) throw new Error(value.error ?? `KEEL Studio staging failed with HTTP ${response.status}.`);
  if (value.schema !== "keel-studio-project-handoff@1" || typeof value.id !== "string" ||
    typeof value.handoffUrl !== "string" || typeof value.expiresAt !== "string" ||
    typeof value.fileCount !== "number" || typeof value.totalBytes !== "number" ||
    value.wallet?.signing !== "not-performed" || value.wallet.submission !== "not-performed") {
    throw new Error("KEEL Studio staging returned an invalid handoff result.");
  }
  return Object.freeze(value as KeelStudioProjectHandoffResult);
}

function uploadWithProgress(input: UploadKeelStudioArtifactInput): Promise<KeelStudioArtifactUploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", String(input.endpoint));
    request.responseType = "json";
    if (input.writeToken !== undefined) request.setRequestHeader("x-keel-studio-write-token", input.writeToken);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) input.onProgress?.(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      try {
        resolve(result(request.response, request.status));
      } catch (error) {
        reject(error);
      }
    });
    request.addEventListener("error", () => reject(new Error("The browser could not reach KEEL Studio upload.")));
    request.send(input.formData);
  });
}
