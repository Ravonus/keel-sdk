import type { ArtifactManifest, KeelIndexAnchor, Compression, Integrity, RuntimeViewerMirror } from "@keel/protocol";

export interface StoredChunkPlan {
  readonly index: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly file: string;
}

export interface ObjectUploadPlan {
  readonly schema: "keel-upload-plan@2";
  readonly indexEncoding: "keel-object-index@1";
  readonly objectName: string;
  readonly mediaType: string;
  readonly originalByteLength: number;
  readonly storedByteLength: number;
  readonly compression: Compression;
  readonly integrity: Integrity;
  readonly maxChildren: number;
  readonly chunks: readonly StoredChunkPlan[];
}


export interface ImageMetadata {
  readonly width?: number;
  readonly height?: number;
}

export interface WebpWriteOptions {
  readonly quality: number;
  readonly effort: number;
}

/** Optional adapter for deterministic builds or environments without sharp. */
export interface ImageProcessor {
  metadata(input: string): Promise<ImageMetadata>;
  writeWebp(input: string, output: string, options: WebpWriteOptions): Promise<void>;
}

export interface WrapImageOptions {
  readonly input: string;
  readonly outputDirectory: string;
  /**
   * Explicit provenance time used by deterministic callers. Omitting it keeps
   * the historical wrapper behaviour (the current time).
   */
  readonly createdAt?: string;
  readonly name?: string;
  readonly description?: string;
  readonly id?: string;
  readonly creator?: string;
  readonly sourceRepository?: string;
  readonly viewerBaseUrl?: string;
  readonly webpQuality?: number;
  readonly preserveOriginal?: boolean;
  readonly anchor?: KeelIndexAnchor;
  readonly viewerMirrors?: readonly RuntimeViewerMirror[];
  readonly imageProcessor?: ImageProcessor;
  /** Store resource bytes beside the manifest (default) or embed them as base64. */
  readonly sourceMode?: "files" | "inline";
}

export interface WrappedArtifactOutput {
  readonly manifest: ArtifactManifest;
  readonly manifestPath: string;
  readonly wrapperPath: string;
  readonly previewPath: string;
  readonly originalPath?: string;
  readonly manifestIntegrity: Integrity;
  readonly manifestIntegrityPath: string;
}

export interface RecursiveLeafObjectPlan {
  readonly id: string;
  readonly kind: "leaf";
  readonly level: 0;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly storedByteLength: number;
  readonly mediaType: string;
  readonly compression: Compression;
  readonly integrity: Integrity;
  readonly chunks: readonly StoredChunkPlan[];
}

export interface RecursiveCompositeObjectPlan {
  readonly id: string;
  readonly kind: "composite";
  readonly level: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly integrity: Integrity;
  readonly parts: readonly string[];
}

export type RecursiveObjectPlan = RecursiveLeafObjectPlan | RecursiveCompositeObjectPlan;

export interface RecursiveUploadPlan {
  readonly schema: "keel-recursive-upload-plan@2";
  readonly indexEncoding: "keel-object-index@1";
  readonly objectName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly integrity: Integrity;
  readonly root: string;
  readonly treeDepth: number;
  readonly leafDecodedBytes: number;
  readonly maxChunkBytes: number;
  readonly maxPartsPerComposite: number;
  readonly maxChildren: number;
  readonly objects: readonly RecursiveObjectPlan[];
}
