import type { Hex } from "./types.js";

export const KEEL_CREATIVE_RUNTIME_CATALOG_PROTOCOL = "keel-creative-runtime-catalog@1" as const;

export type KeelCreativeRuntimeId = "p5" | "three" | "doom-wasm" | "flash-ruffle";
export type KeelCreativeRuntimeAvailability = "local-source" | "external-source-required";

export interface KeelCreativeRuntimeResource {
  readonly id: string;
  readonly version: string;
  readonly mediaType: "text/javascript" | "application/wasm";
  readonly format: "classic-script" | "es-module" | "wasm-module";
  readonly role: "module" | "runtime";
  /** Position in the reference viewer graph, not local or publication availability. */
  readonly referenceStatus: "active" | "inactive-legacy";
  /** Resource ids in this catalog entry that must be available before this resource. */
  readonly dependencies: readonly string[];
  /** Repository-relative source bytes, or null when this checkout does not carry them. */
  readonly localPath: string | null;
  /** Exact transformation needed before hashing a maintained local compatibility copy. */
  readonly localTransform?: {
    readonly kind: "replace-text";
    readonly from: string;
    readonly to: string;
  };
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly digest: Hex;
    readonly byteLength: number;
  } | null;
  readonly sourceRepository: string;
  readonly sourceRevision: string;
}

export interface KeelCreativeRuntimeCatalogEntry {
  readonly id: KeelCreativeRuntimeId;
  readonly title: string;
  readonly summary: string;
  readonly availability: KeelCreativeRuntimeAvailability;
  readonly resources: readonly KeelCreativeRuntimeResource[];
  readonly evidencePaths: readonly string[];
  /** This local inventory never upgrades plans or remembered addresses into availability proof. */
  readonly publication: {
    readonly status: "not-claimed";
    readonly receiptBacked: false;
    readonly carriers: readonly [];
  };
}

const publication = (): KeelCreativeRuntimeCatalogEntry["publication"] => {
  const carriers: readonly [] = Object.freeze([]);
  return Object.freeze({ status: "not-claimed", receiptBacked: false, carriers });
};

function resource(value: KeelCreativeRuntimeResource): KeelCreativeRuntimeResource {
  return Object.freeze({
    ...value,
    dependencies: Object.freeze([...value.dependencies]),
    ...(value.localTransform === undefined ? {} : { localTransform: Object.freeze({ ...value.localTransform }) }),
    integrity: value.integrity === null ? null : Object.freeze({ ...value.integrity }),
  });
}

function entry(value: Omit<KeelCreativeRuntimeCatalogEntry, "publication">): KeelCreativeRuntimeCatalogEntry {
  return Object.freeze({
    ...value,
    resources: Object.freeze(value.resources.map(resource)),
    evidencePaths: Object.freeze([...value.evidencePaths]),
    publication: publication(),
  });
}

/**
 * Checkout-local creative runtime inventory. It records exact local bytes when
 * this repository carries them and explicitly marks missing source inputs.
 * Onchain carriers stay empty until receipt plus read-back verification exists.
 */
export const KEEL_CREATIVE_RUNTIME_CATALOG: readonly KeelCreativeRuntimeCatalogEntry[] = Object.freeze([
  entry({
    id: "p5",
    title: "p5.js",
    summary: "Current p5 1.11.3 creator runtime plus the pinned 1.7.0 historical compatibility runtime.",
    availability: "local-source",
    resources: [
      {
        id: "p5-1-11-3",
        version: "1.11.3",
        mediaType: "text/javascript",
        format: "classic-script",
        role: "runtime",
        referenceStatus: "active",
        dependencies: [],
        localPath: "examples/demos/vendor/p5.min.js",
        integrity: {
          algorithm: "sha256",
          digest: "0xaf51e6211e061b5ae463fbc5c3c1c272e5ca67fa560ed3513fde17325d837506",
          byteLength: 1_056_654,
        },
        sourceRepository: "https://github.com/processing/p5.js",
        sourceRevision: "3c9de136e36912d6ced8b71a81e7413f3eab8b61",
      },
      {
        id: "p5-1-7-0",
        version: "1.7.0",
        mediaType: "text/javascript",
        format: "classic-script",
        role: "runtime",
        referenceStatus: "active",
        dependencies: [],
        localPath: "examples/keel/vendor/p5-1.7.0.min.js",
        integrity: {
          algorithm: "sha256",
          digest: "0xbb7f8f14b9ce2e2344ff5cd6c06f2e105eb99541ecbfec77139e2886d9c0b9ba",
          byteLength: 977_055,
        },
        sourceRepository: "https://github.com/processing/p5.js",
        sourceRevision: "1.7.0",
      },
    ],
    evidencePaths: [
      "examples/demos/keel-creative-lab/release.json",
      "examples/agent-p5-project/project.mjs",
      "examples/keel/historical/report.json",
      "tests/sdk-inline-viewer-graph.test.mjs",
    ],
  }),
  entry({
    id: "three",
    title: "Three.js",
    summary: "Pinned official r180 ESM main/core graph used by immutable Three scene publication.",
    availability: "local-source",
    resources: [
      {
        id: "three-r180-module",
        version: "0.180.0",
        mediaType: "text/javascript",
        format: "es-module",
        role: "runtime",
        referenceStatus: "active",
        dependencies: ["three-r180-core"],
        localPath: "examples/demos/vendor/three.min.js",
        localTransform: {
          kind: "replace-text",
          from: 'from"/content/three.core.min.js"',
          to: 'from"./three.core.min.js"',
        },
        integrity: {
          algorithm: "sha256",
          digest: "0xe2b5ee6bccd38fd6d8a2428546b83c5f2426d84b152ef82be8055556e3b40eb6",
          byteLength: 338_908,
        },
        sourceRepository: "https://github.com/mrdoob/three.js",
        sourceRevision: "r180",
      },
      {
        id: "three-r180-core",
        version: "0.180.0",
        mediaType: "text/javascript",
        format: "es-module",
        role: "runtime",
        referenceStatus: "active",
        dependencies: [],
        localPath: "examples/demos/vendor/three.core.min.js",
        integrity: {
          algorithm: "sha256",
          digest: "0x61ba0df005b05991361d040d8ff670e1aadfd0ce7aeebd1fdb0725957a8957de",
          byteLength: 381_124,
        },
        sourceRepository: "https://github.com/mrdoob/three.js",
        sourceRevision: "r180",
      },
    ],
    evidencePaths: [
      "examples/fixtures/three-r180-rotating-cube/keel.fixture.json",
      "tests/sdk-three-module.test.mjs",
      "tests/sdk-three-scene-publication.test.mjs",
    ],
  }),
  entry({
    id: "doom-wasm",
    title: "Doom WASM",
    summary: "Pinned preparation workflow; this checkout does not include the GPL WASM input or game-data rights input.",
    availability: "external-source-required",
    resources: [{
      id: "doom-wasm",
      version: "31cc1af9656a8184830090c4e9f268383f5d7e15",
      mediaType: "application/wasm",
      format: "wasm-module",
      role: "runtime",
      referenceStatus: "active",
      dependencies: [],
      localPath: null,
      integrity: null,
      sourceRepository: "https://github.com/jacobenget/doom.wasm",
      sourceRevision: "31cc1af9656a8184830090c4e9f268383f5d7e15",
    }],
    evidencePaths: [
      "examples/demos/doom-wasm/README.md",
      "scripts/prepare-doom-wasm-onchain.mjs",
      "scripts/verify-doom-wasm-ethereum.mjs",
    ],
  }),
  entry({
    id: "flash-ruffle",
    title: "Flash / Ruffle",
    summary: "Reference Flash edition and modern-only Ruffle graph; every source remains an external input in this checkout.",
    availability: "external-source-required",
    resources: [
      {
        id: "flash-edition-module",
        version: "0.1.0",
        mediaType: "text/javascript",
        format: "es-module",
        role: "module",
        referenceStatus: "active",
        dependencies: ["seeded-random-module"],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/Ravonus/keel-modules",
        sourceRevision: "flash-edition@0.1.0",
      },
      {
        id: "seeded-random-module",
        version: "1.0.0",
        mediaType: "text/javascript",
        format: "es-module",
        role: "module",
        referenceStatus: "active",
        dependencies: [],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/Ravonus/fray",
        sourceRevision: "keel.seeded-random@1.0.0",
      },
      {
        id: "ruffle-loader-module",
        version: "0.1.0",
        mediaType: "text/javascript",
        format: "es-module",
        role: "module",
        referenceStatus: "active",
        dependencies: ["ruffle-main"],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/Ravonus/keel-modules",
        sourceRevision: "ruffle-loader@0.1.0",
      },
      {
        id: "ruffle-main",
        version: "0.5.0",
        mediaType: "text/javascript",
        format: "classic-script",
        role: "runtime",
        referenceStatus: "active",
        dependencies: ["ruffle-core-modern", "ruffle-wasm-modern"],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/ruffle-rs/ruffle",
        sourceRevision: "0.5.0",
      },
      {
        id: "ruffle-core-modern",
        version: "0.5.0",
        mediaType: "text/javascript",
        format: "classic-script",
        role: "runtime",
        referenceStatus: "active",
        dependencies: [],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/ruffle-rs/ruffle",
        sourceRevision: "0.5.0",
      },
      {
        id: "ruffle-wasm-modern",
        version: "0.5.0",
        mediaType: "application/wasm",
        format: "wasm-module",
        role: "runtime",
        referenceStatus: "active",
        dependencies: [],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/ruffle-rs/ruffle",
        sourceRevision: "0.5.0",
      },
      {
        id: "brotli-decoder-wasm",
        version: "0.1.0",
        mediaType: "application/wasm",
        format: "wasm-module",
        role: "runtime",
        referenceStatus: "active",
        dependencies: [],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/Ravonus/cool-s-onchain",
        sourceRevision: "keel.brotli-decoder@0.1.0",
      },
      {
        id: "ruffle-core-legacy",
        version: "0.5.0",
        mediaType: "text/javascript",
        format: "classic-script",
        role: "runtime",
        referenceStatus: "inactive-legacy",
        dependencies: ["ruffle-wasm-legacy"],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/ruffle-rs/ruffle",
        sourceRevision: "0.5.0",
      },
      {
        id: "ruffle-wasm-legacy",
        version: "0.5.0",
        mediaType: "application/wasm",
        format: "wasm-module",
        role: "runtime",
        referenceStatus: "inactive-legacy",
        dependencies: [],
        localPath: null,
        integrity: null,
        sourceRepository: "https://github.com/ruffle-rs/ruffle",
        sourceRevision: "0.5.0",
      },
    ],
    evidencePaths: [
      "packages/sdk/src/studio-upload.ts",
      "packages/viewer/src/sandbox.ts",
      "tests/viewer.test.mjs",
    ],
  }),
]);

const CREATIVE_RUNTIME_BY_ID = new Map(KEEL_CREATIVE_RUNTIME_CATALOG.map((candidate) => [candidate.id, candidate]));

export function listKeelCreativeRuntimes(): readonly KeelCreativeRuntimeCatalogEntry[] {
  return KEEL_CREATIVE_RUNTIME_CATALOG;
}

export function getKeelCreativeRuntime(id: KeelCreativeRuntimeId): KeelCreativeRuntimeCatalogEntry {
  const found = CREATIVE_RUNTIME_BY_ID.get(id);
  if (found === undefined) throw new Error(`unknown creative runtime: ${id}`);
  return found;
}

export function searchKeelCreativeRuntimes(query: string): readonly KeelCreativeRuntimeCatalogEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return KEEL_CREATIVE_RUNTIME_CATALOG;
  return Object.freeze(KEEL_CREATIVE_RUNTIME_CATALOG.filter((candidate) => {
    const searchable = [
      candidate.id,
      candidate.title,
      candidate.summary,
      candidate.availability,
      ...candidate.resources.flatMap((item) => [
        item.id,
        item.version,
        item.mediaType,
        item.format,
        item.role,
        item.referenceStatus,
        item.sourceRepository,
        ...item.dependencies,
      ]),
    ].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  }));
}
