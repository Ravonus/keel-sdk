import {
  browserModuleCarrierBinding,
  isBrowserModuleDescriptorVerified,
  isCoreCapabilityId,
  isModuleDescriptor,
  type ModuleDescriptor,
  type ModuleLane,
  type BrowserModuleDescriptor,
} from "./descriptor.js";
import type { KeelModuleId } from "../modules.js";
import { isModuleDocument, type ModuleDocumentDeclaration } from "./document.js";

export type ArtifactKind = "module" | "app" | "collection" | "object";
export type AssetKind = "image" | "animation" | "document" | "bytes";

export interface AssetDeclaration {
  readonly kind: AssetKind;
  readonly name: string;
  readonly description: string;
}

const declareAsset = (kind: AssetKind) => (name: string, description = ""): AssetDeclaration => {
  if (name.trim() === "") throw new TypeError(`a ${kind} asset needs a name.`);
  return Object.freeze({ kind, name, description });
};

export const Asset = Object.freeze({
  image: declareAsset("image"),
  animation: declareAsset("animation"),
  document: declareAsset("document"),
  bytes: declareAsset("bytes"),
});

export interface ModuleTarget {
  readonly raw: string;
  readonly family: "eth" | "tez";
  readonly network: string;
  readonly surface: string | null;
}

export function parseTarget(raw: string): ModuleTarget {
  if (typeof raw !== "string") {
    throw new TypeError(`target must be a string. Got ${String(raw)}.`);
  }
  const parts = raw.split("/");
  const family = parts[1];
  const network = parts[2];
  if (parts[0] !== "@keel" || (family !== "eth" && family !== "tez") || !network || parts.length > 4) {
    throw new TypeError(`target must look like "@keel/<eth|tez>/<network>", optionally with "/<surface>". Got ${JSON.stringify(raw)}.`);
  }
  return Object.freeze({ raw, family, network, surface: parts[3] ?? null });
}

export type VerificationRequest =
  | { readonly shell: true }
  | { readonly shell: false; readonly reason: string };

export interface ModuleManifest {
  readonly schema: "keel-module@1";
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly target: ModuleTarget;
  readonly use: readonly KeelModuleId[];
  readonly modules: readonly string[];
  /** Exact on-chain carriers for browser modules, in `modules` order. */
  readonly moduleBindings: readonly import("./descriptor.js").BrowserModuleCarrierBinding[];
  readonly assets: Readonly<Record<string, AssetDeclaration>>;
  readonly npm: Readonly<Record<string, string>>;
  /** Requested policy only. A declaration is not proof that verification passed. */
  readonly verification: VerificationRequest;
}

type AnyDescriptor = ModuleDescriptor<string, ModuleLane, string, unknown>;
type ApiOf<D> = D extends ModuleDescriptor<string, ModuleLane, string, infer Api> ? Api : never;
type KeyOf<D> = D extends ModuleDescriptor<string, ModuleLane, infer Key, unknown> ? Key : never;
type DescriptorApi<D> = D extends AnyDescriptor ? { readonly [K in KeyOf<D>]: ApiOf<D> } : never;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends
  (value: infer I) => void ? I : never;

export type ExtendedModuleApis<Descriptors extends readonly AnyDescriptor[]> =
  UnionToIntersection<DescriptorApi<Descriptors[number]>>;

export interface DefineModuleInput<Descriptors extends readonly AnyDescriptor[]> {
  readonly kind?: ArtifactKind;
  readonly target: string;
  /** Imported module descriptors. This exact tuple determines the APIs visible in `init`. */
  readonly extends: Descriptors;
  readonly assets?: Readonly<Record<string, AssetDeclaration>>;
  readonly npm?: Readonly<Record<string, string>>;
  readonly verification?: VerificationRequest;
  /** Browser document authored in TypeScript; excluded from the plain manifest. */
  readonly document?: ModuleDocumentDeclaration;
  readonly init?: (modules: ExtendedModuleApis<Descriptors>) => void | Promise<void>;
}

export interface DeclaredModule<Descriptors extends readonly AnyDescriptor[]> {
  readonly manifest: ModuleManifest;
  readonly extends: Descriptors;
  readonly document?: ModuleDocumentDeclaration;
  readonly init?: (modules: ExtendedModuleApis<Descriptors>) => void | Promise<void>;
}

const ARTIFACT_KINDS = new Set<ArtifactKind>(["module", "app", "collection", "object"]);
const ASSET_KINDS = new Set<AssetKind>(["image", "animation", "document", "bytes"]);

function ownDataDescriptors(value: unknown): PropertyDescriptorMap | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return descriptor === undefined || !("value" in descriptor);
    })) return null;
    return descriptors;
  } catch {
    return null;
  }
}

function snapshotAssets(value: Readonly<Record<string, AssetDeclaration>> | undefined): Readonly<Record<string, AssetDeclaration>> {
  if (value === undefined) return Object.freeze({});
  const entries = ownDataDescriptors(value);
  if (entries === null) throw new TypeError("assets must be an own-data record.");

  const snapshot: Record<string, AssetDeclaration> = {};
  for (const [assetKey, entry] of Object.entries(entries)) {
    const asset = entry.value;
    const fields = ownDataDescriptors(asset);
    if (fields === null || Reflect.ownKeys(fields).length !== 3 ||
      fields.kind === undefined || fields.name === undefined || fields.description === undefined) {
      throw new TypeError(`asset ${JSON.stringify(assetKey)} must have exactly kind, name, and description data fields.`);
    }
    const kind = fields.kind.value;
    const name = fields.name.value;
    const description = fields.description.value;
    if (typeof kind !== "string" || !ASSET_KINDS.has(kind as AssetKind) ||
      typeof name !== "string" || name.trim() === "" || typeof description !== "string") {
      throw new TypeError(`asset ${JSON.stringify(assetKey)} is invalid.`);
    }
    Object.defineProperty(snapshot, assetKey, {
      value: Object.freeze({ kind: kind as AssetKind, name, description }),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotVerification(value: VerificationRequest | undefined): VerificationRequest {
  if (value === undefined) return Object.freeze({ shell: true });
  const fields = ownDataDescriptors(value);
  if (fields === null) throw new TypeError("verification must be an own-data object.");
  const keys = Reflect.ownKeys(fields);
  if (keys.length === 1 && keys[0] === "shell" && fields.shell?.value === true) {
    return Object.freeze({ shell: true });
  }
  if (keys.length === 2 && keys.includes("shell") && keys.includes("reason") &&
    fields.shell?.value === false && typeof fields.reason?.value === "string" && fields.reason.value.trim() !== "") {
    return Object.freeze({ shell: false, reason: fields.reason.value });
  }
  throw new TypeError("verification must be exactly { shell: true } or { shell: false, reason: nonempty }.");
}

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const EXACT_NPM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function snapshotNpm(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const entries = ownDataDescriptors(value);
  if (entries === null) throw new TypeError("npm must be an own-data record without symbols or accessors.");

  const snapshot: Record<string, string> = {};
  for (const [packageName, entry] of Object.entries(entries)) {
    if (packageName.length > 214 || !NPM_PACKAGE_NAME.test(packageName)) {
      throw new TypeError(`npm package name ${JSON.stringify(packageName)} is invalid.`);
    }
    const version = entry.value;
    if (typeof version !== "string" || !EXACT_NPM_VERSION.test(version)) {
      throw new TypeError(`npm version for ${JSON.stringify(packageName)} must be an exact nonempty version.`);
    }
    Object.defineProperty(snapshot, packageName, {
      value: version,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

export function defineModule<const Descriptors extends readonly AnyDescriptor[]>(
  name: string,
  input: DefineModuleInput<Descriptors>,
): DeclaredModule<Descriptors> {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("a module needs a name.");
  if (!ARTIFACT_KINDS.has(input.kind ?? "module")) {
    throw new TypeError(`unknown Keel artifact kind: ${String(input.kind)}.`);
  }

  const descriptorSnapshot = Object.freeze([...input.extends]) as unknown as Descriptors;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const use: KeelModuleId[] = [];
  const modules: string[] = [];
  const moduleBindings: import("./descriptor.js").BrowserModuleCarrierBinding[] = [];
  const target = parseTarget(input.target);
  for (const descriptor of descriptorSnapshot) {
    if (!isModuleDescriptor(descriptor)) throw new TypeError("extends contains an invalid Keel module descriptor.");
    if (ids.has(descriptor.id)) throw new TypeError(`module ${name} extends ${descriptor.id} twice.`);
    if (keys.has(descriptor.key)) throw new TypeError(`module API name ${descriptor.key} is declared twice.`);
    ids.add(descriptor.id);
    keys.add(descriptor.key);
    if (descriptor.lane === "solidity") {
      if (!isCoreCapabilityId(descriptor.id)) {
        throw new TypeError(`unknown Keel Solidity capability: ${descriptor.id}.`);
      }
      use.push(descriptor.id);
    } else {
      if (isCoreCapabilityId(descriptor.id)) {
        throw new TypeError(`${descriptor.id} is a Solidity capability, not a browser module.`);
      }
      modules.push(descriptor.id);
      const binding = browserModuleCarrierBinding(descriptor as BrowserModuleDescriptor);
      if (target.surface === "browser") {
        if (binding === undefined) {
          throw new TypeError(`browser module ${descriptor.id} is not resolved to an on-chain carrier for ${target.raw}.`);
        }
        if (target.family !== "eth" || !/^eip155:[1-9][0-9]*$/u.test(target.network)) {
          throw new TypeError("publishable Ethereum browser targets must name their CAIP-2 chain, for example @keel/eth/eip155:11155111/browser.");
        }
        if (binding.chain !== target.network) {
          throw new TypeError(`browser module ${descriptor.id} is resolved on ${binding.chain}, but the project targets ${target.network}.`);
        }
        if (!isBrowserModuleDescriptorVerified(descriptor as BrowserModuleDescriptor)) {
          throw new TypeError(`browser module ${descriptor.id} has not passed an exact on-chain byte read on ${target.network}.`);
        }
        moduleBindings.push(binding);
      }
    }
  }

  const verification = snapshotVerification(input.verification);
  if (input.document !== undefined && !isModuleDocument(input.document)) {
    throw new TypeError("document must be created with defineDocument().");
  }

  const manifest: ModuleManifest = Object.freeze({
    schema: "keel-module@1",
    name,
    kind: input.kind ?? "module",
    target,
    use: Object.freeze(use),
    modules: Object.freeze(modules),
    moduleBindings: Object.freeze(moduleBindings),
    assets: snapshotAssets(input.assets),
    npm: snapshotNpm(input.npm),
    verification,
  });
  return Object.freeze({
    manifest,
    extends: descriptorSnapshot,
    ...(input.document === undefined ? {} : { document: input.document }),
    ...(input.init === undefined ? {} : { init: input.init }),
  });
}
