import { createIntegrity, type KeelModuleIdentity } from "@keel/protocol";
import {
  createExternalModuleIndex,
  customExternalBrowserModule,
  externalModuleIndexEntry,
  moduleApi,
  type ExternalBrowserModuleDeclaration,
  type ExternalModuleIndex,
  type ExternalModuleProvenance,
} from "./module/index.js";

/** Exact upstream ESM release used by the shared KEEL Three.js library. */
export const KEEL_THREE_R180 = Object.freeze({
  version: "0.180.0",
  license: "MIT",
  mediaType: "text/javascript",
  main: Object.freeze({
    id: "three-r180-module",
    identity: Object.freeze({ namespace: "npm", name: "three", version: "0.180.0", entry: "build/three.module.min.js" }) satisfies KeelModuleIdentity,
    sourceUrl: "https://unpkg.com/three@0.180.0/build/three.module.min.js",
    digest: "sha256:e2b5ee6bccd38fd6d8a2428546b83c5f2426d84b152ef82be8055556e3b40eb6",
    byteLength: 338_908,
  }),
  core: Object.freeze({
    id: "three-r180-core",
    identity: Object.freeze({ namespace: "npm", name: "three", version: "0.180.0", entry: "build/three.core.min.js" }) satisfies KeelModuleIdentity,
    sourceUrl: "https://unpkg.com/three@0.180.0/build/three.core.min.js",
    digest: "sha256:61ba0df005b05991361d040d8ff670e1aadfd0ce7aeebd1fdb0725957a8957de",
    byteLength: 381_124,
  }),
});

const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const BYTES32 = /^0x[0-9a-f]{64}$/iu;
const SEPOLIA = 11_155_111;
const CORE_IMPORT_SPECIFIER = "./three.core.min.js";
const MAIN_IMPORT = `from"${CORE_IMPORT_SPECIFIER}"`;

export interface KeelThreeR180ModuleBindings {
  /** The only supported chain for this record. A different chain needs its own exact binding. */
  readonly chainId: typeof SEPOLIA;
  readonly store: string;
  readonly mainObjectId: string;
  readonly coreObjectId: string;
}

export interface KeelThreeR180BrowserModules {
  readonly main: ExternalBrowserModuleDeclaration<unknown, ExternalModuleProvenance>;
  readonly core: ExternalBrowserModuleDeclaration<unknown, ExternalModuleProvenance>;
}

function requireAddress(value: string, label: string): string {
  if (!ADDRESS.test(value)) throw new TypeError(`${label} must be a 20-byte EVM address.`);
  return value.toLowerCase();
}

function requireBytes32(value: string, label: string): string {
  if (!BYTES32.test(value)) throw new TypeError(`${label} must be a bytes32 value.`);
  return value.toLowerCase();
}

async function hasExpectedIntegrity(bytes: Uint8Array, expected: { readonly digest: string; readonly byteLength: number }): Promise<boolean> {
  const integrity = await createIntegrity(bytes);
  return integrity.byteLength === expected.byteLength && `sha256:${integrity.digest.slice(2)}` === expected.digest;
}

/**
 * Proves locally supplied source bytes are the exact upstream r180 ESM graph.
 * The main module's only relative core dependency is deliberate and must be bound
 * as the declared `three-r180-core` dependency by the viewer/runtime.
 */
export async function assertKeelThreeR180OfficialBytes(input: {
  readonly main: Uint8Array;
  readonly core: Uint8Array;
}): Promise<typeof KEEL_THREE_R180> {
  if (!await hasExpectedIntegrity(input.main, KEEL_THREE_R180.main)) {
    throw new Error("Three r180 main module digest or byte length does not match the pinned official release.");
  }
  if (!await hasExpectedIntegrity(input.core, KEEL_THREE_R180.core)) {
    throw new Error("Three r180 core module digest or byte length does not match the pinned official release.");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(input.main);
  const imports = [...source.matchAll(/\bfrom"([^"]+)"/gu)].map((match) => match[1]);
  if (imports.length !== 2 || imports.some((specifier) => specifier !== CORE_IMPORT_SPECIFIER)) {
    throw new Error("Three r180 main module must retain only its declared relative core dependency.");
  }
  return KEEL_THREE_R180;
}

/**
 * Creates the two-entry shared-library index for a current Sepolia binding.
 * This only records claimed immutable locations. Callers still must read and
 * hash each carrier through `verifyExternalBrowserModuleOnchain` (or the
 * Studio gateway) before it can enter a publishable browser module graph.
 */
export function createKeelThreeR180ModuleIndex(input: KeelThreeR180ModuleBindings): Readonly<ExternalModuleIndex> {
  if (input.chainId !== SEPOLIA) throw new RangeError("The pinned Three r180 shared-module record is currently prepared for Sepolia only.");
  const store = requireAddress(input.store, "Three r180 store");
  const mainObjectId = requireBytes32(input.mainObjectId, "Three r180 main objectId");
  const coreObjectId = requireBytes32(input.coreObjectId, "Three r180 core objectId");
  const chain = `eip155:${SEPOLIA}`;
  const main = externalModuleIndexEntry(
    KEEL_THREE_R180.main.id,
    KEEL_THREE_R180.version,
    "three.js-authors",
    KEEL_THREE_R180.main.digest,
    KEEL_THREE_R180.main.byteLength,
    KEEL_THREE_R180.mediaType,
    mainObjectId,
    store,
    chain,
    KEEL_THREE_R180.main.sourceUrl,
    KEEL_THREE_R180.main.digest,
    undefined,
    undefined,
    "shared-library",
    "publisher-attested",
    `${KEEL_THREE_R180.core.id}@${KEEL_THREE_R180.version}`,
  );
  const core = externalModuleIndexEntry(
    KEEL_THREE_R180.core.id,
    KEEL_THREE_R180.version,
    "three.js-authors",
    KEEL_THREE_R180.core.digest,
    KEEL_THREE_R180.core.byteLength,
    KEEL_THREE_R180.mediaType,
    coreObjectId,
    store,
    chain,
    KEEL_THREE_R180.core.sourceUrl,
    KEEL_THREE_R180.core.digest,
    undefined,
    undefined,
    "shared-library",
    "publisher-attested",
  );
  return createExternalModuleIndex(main, core);
}

/** Declares the exact main/core graph without embedding either library in creator bytes. */
export function declareKeelThreeR180BrowserModules(index: Readonly<ExternalModuleIndex>): KeelThreeR180BrowserModules {
  return Object.freeze({
    main: customExternalBrowserModule(index, KEEL_THREE_R180.main.id, KEEL_THREE_R180.version, moduleApi(), "three"),
    core: customExternalBrowserModule(index, KEEL_THREE_R180.core.id, KEEL_THREE_R180.version, moduleApi(), "threeCore"),
  });
}
