import {
  KEEL_MEDIA_DERIVATIVE_PROTOCOL,
  assertValidKeelMediaDerivative,
  canonicalJson,
  createIntegrity,
  utf8ToBytes,
  type Integrity,
  type KeelMediaDerivative,
  type KeelWebpProfile,
} from "@keel/protocol";

interface DerivativeSharpImage {
  rotate(): DerivativeSharpImage;
  resize(options: {
    readonly width: number;
    readonly height: number;
    readonly fit: "inside";
    readonly withoutEnlargement: true;
    readonly kernel: "lanczos3";
  }): DerivativeSharpImage;
  toColourspace(value: "srgb"): DerivativeSharpImage;
  webp(options: { readonly quality: number; readonly effort: 6; readonly smartSubsample: true }): DerivativeSharpImage;
  toBuffer(): Promise<Uint8Array>;
  metadata(): Promise<{ readonly width?: number; readonly height?: number; readonly pageHeight?: number }>;
}

interface DerivativeSharpFactory {
  (input: Uint8Array, options?: { readonly animated?: boolean; readonly failOn?: "warning"; readonly limitInputPixels?: number }): DerivativeSharpImage;
  readonly versions: { readonly sharp: string; readonly vips: string };
}

let derivativeSharpPromise: Promise<DerivativeSharpFactory> | undefined;

function loadDerivativeSharp(): Promise<DerivativeSharpFactory> {
  derivativeSharpPromise ??= import("sharp").then(
    (module) => module.default as unknown as DerivativeSharpFactory,
  );
  return derivativeSharpPromise;
}

export interface BuiltKeelMediaDerivative {
  readonly bytes: Uint8Array;
  readonly receipt: KeelMediaDerivative;
}

const PROFILES = {
  "preview-webp-512-v1": { width: 512, height: 512, quality: 78 },
  "display-webp-1024-v1": { width: 1024, height: 1024, quality: 82 },
  "display-webp-2048-v1": { width: 2048, height: 2048, quality: 84 },
} as const satisfies Readonly<Record<KeelWebpProfile, { readonly width: 512 | 1024 | 2048; readonly height: 512 | 1024 | 2048; readonly quality: number }>>;

/**
 * Create a bounded marketplace derivative from exact source bytes. The output
 * digest is authoritative; the pinned recipe explains and reproduces lineage.
 */
export async function buildKeelWebpDerivative(input: {
  readonly sourceResourceId: string;
  readonly outputResourceId: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceIntegrity?: Integrity;
  readonly profile: KeelWebpProfile;
}): Promise<BuiltKeelMediaDerivative> {
  if (!(input.sourceBytes instanceof Uint8Array) || input.sourceBytes.byteLength === 0) {
    throw new RangeError("A media derivative requires non-empty source bytes.");
  }
  const derivativeSharp = await loadDerivativeSharp();
  const sourceIntegrity = input.sourceIntegrity ?? await createIntegrity(input.sourceBytes);
  const profile = PROFILES[input.profile];
  const implementation = {
    name: "sharp-libvips" as const,
    sharpVersion: derivativeSharp.versions.sharp,
    vipsVersion: derivativeSharp.versions.vips,
  };
  const recipe = {
    profile: input.profile,
    codec: "webp" as const,
    width: profile.width,
    height: profile.height,
    fit: "inside" as const,
    withoutEnlargement: true as const,
    colorSpace: "srgb" as const,
    quality: profile.quality,
    effort: 6 as const,
    smartSubsample: true as const,
    implementation,
  };
  const recipeDigest = (await createIntegrity(utf8ToBytes(canonicalJson(recipe)))).digest;
  const output = await derivativeSharp(input.sourceBytes, {
    animated: true,
    failOn: "warning",
    limitInputPixels: 100_000_000,
  })
    .rotate()
    .resize({
      width: profile.width,
      height: profile.height,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .toColourspace("srgb")
    .webp({ quality: profile.quality, effort: 6, smartSubsample: true })
    .toBuffer();
  const bytes = new Uint8Array(output);
  const metadata = await derivativeSharp(bytes, { animated: true, failOn: "warning" }).metadata();
  if (metadata.width === undefined || metadata.height === undefined) throw new Error("WebP derivative dimensions are unavailable.");
  const receipt: KeelMediaDerivative = {
    protocol: KEEL_MEDIA_DERIVATIVE_PROTOCOL,
    sourceResourceId: input.sourceResourceId,
    sourceIntegrity,
    outputResourceId: input.outputResourceId,
    outputIntegrity: await createIntegrity(bytes),
    outputMediaType: "image/webp",
    outputWidth: metadata.width,
    outputHeight: metadata.pageHeight ?? metadata.height,
    transform: { ...recipe, recipeDigest },
    authority: "manifest-output-digest",
  };
  assertValidKeelMediaDerivative(receipt);
  return { bytes, receipt };
}
