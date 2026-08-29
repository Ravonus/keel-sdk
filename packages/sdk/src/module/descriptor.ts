import { KEEL_MODULES, type KeelModuleId } from "../modules.js";

/** The two things a Keel project can extend have deliberately separate lanes. */
export type ModuleLane = "solidity" | "browser";

/**
 * A type-only description of the API a runtime will provide.
 *
 * It emits no functions and makes no verification claim. A catalogue/build step
 * still has to resolve and verify the implementation before `init` is run.
 */
export interface ModuleApiShape<Api> {
  readonly kind: "keel-module-api-shape";
  /** Phantom field: absent at runtime, present only so TypeScript carries Api. */
  readonly __api?: Api;
}

const MODULE_API_SHAPES = new WeakSet<object>();
const MODULE_DESCRIPTORS = new WeakSet<object>();

export function moduleApi<Api>(): ModuleApiShape<Api> {
  const shape = Object.freeze({ kind: "keel-module-api-shape" }) as ModuleApiShape<Api>;
  MODULE_API_SHAPES.add(shape);
  return shape;
}

function isModuleApiShape(value: unknown): value is ModuleApiShape<unknown> {
  return typeof value === "object" && value !== null && MODULE_API_SHAPES.has(value);
}

const DESCRIPTOR_MARK = "keel-module-descriptor@1" as const;

export interface ModuleDescriptor<
  Id extends string = string,
  Lane extends ModuleLane = ModuleLane,
  Key extends string = string,
  Api = unknown,
> {
  readonly schema: typeof DESCRIPTOR_MARK;
  readonly id: Id;
  readonly lane: Lane;
  /** The readable property exposed to `init`, for example `verificationHarness`. */
  readonly key: Key;
  /** Type carrier only; it is not a resolved or verified implementation. */
  readonly api: ModuleApiShape<Api>;
}

export type SolidityCapabilityDescriptor<
  Id extends KeelModuleId = KeelModuleId,
  Key extends string = string,
  Api = unknown,
> = ModuleDescriptor<Id, "solidity", Key, Api>;

export type BrowserModuleDescriptor<
  Id extends string = string,
  Key extends string = string,
  Api = unknown,
> = ModuleDescriptor<Id, "browser", Key, Api>;

export interface BrowserModuleCarrierBinding {
  readonly moduleId: string;
  readonly version: string;
  readonly digest: string;
  readonly objectId: string;
  readonly store: string;
  readonly chain: string;
}

interface DescriptorOptions<Key extends string, Api> {
  /** The identifier used inside `init({ ... })`. Defaults to the module id. */
  readonly as?: Key;
  readonly api: ModuleApiShape<Api>;
}

const CORE_IDS = new Set<string>(KEEL_MODULES.map((entry) => entry.id));
const BROWSER_BINDINGS = new WeakMap<object, Readonly<BrowserModuleCarrierBinding>>();
const VERIFIED_BROWSER_BINDINGS = new WeakSet<object>();

function requireIdentifier(value: string, label: string): void {
  if (value.trim() === "") throw new TypeError(`${label} must not be empty.`);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)) {
    throw new TypeError(`${label} ${JSON.stringify(value)} is not a valid JavaScript identifier.`);
  }
}

/**
 * Defines the value exported by a typed Solidity capability package.
 * Only ids in Keel's generated core catalogue are accepted.
 */
export function solidityCapability<
  const Id extends KeelModuleId,
  const Key extends string = Id,
  Api = unknown,
>(id: Id, options: DescriptorOptions<Key, Api>): SolidityCapabilityDescriptor<Id, Key, Api> {
  if (!CORE_IDS.has(id)) throw new TypeError(`unknown Keel Solidity capability: ${id}.`);
  const key = options.as ?? (id as unknown as Key);
  requireIdentifier(key, "module API name");
  if (!isModuleApiShape(options.api)) throw new TypeError("module api must be created with moduleApi().");
  const descriptor = Object.freeze({ schema: DESCRIPTOR_MARK, id, lane: "solidity", key, api: options.api });
  MODULE_DESCRIPTORS.add(descriptor);
  return descriptor;
}

/**
 * Defines a browser module descriptor for a package/catalogue to export.
 * This is authoring metadata only; verification is established later from the
 * resolved source and bytes, never from this declaration.
 */
export function browserModule<
  const Id extends string,
  const Key extends string = Id,
  Api = unknown,
>(id: Id, options: DescriptorOptions<Key, Api>): BrowserModuleDescriptor<Id, Key, Api> {
  if (id.trim() === "") throw new TypeError("browser module id must not be empty.");
  if (CORE_IDS.has(id)) {
    throw new TypeError(`${id} is a Solidity capability; declare it with solidityCapability().`);
  }
  const key = options.as ?? (id as unknown as Key);
  requireIdentifier(key, "module API name");
  if (!isModuleApiShape(options.api)) throw new TypeError("module api must be created with moduleApi().");
  const descriptor = Object.freeze({ schema: DESCRIPTOR_MARK, id, lane: "browser", key, api: options.api });
  MODULE_DESCRIPTORS.add(descriptor);
  return descriptor;
}

export function isModuleDescriptor(value: unknown): value is ModuleDescriptor {
  return typeof value === "object" && value !== null && MODULE_DESCRIPTORS.has(value);
}

/** @internal Attaches an immutable carrier selected by the SDK module resolver. */
export function bindBrowserModuleDescriptor(
  descriptor: BrowserModuleDescriptor,
  binding: BrowserModuleCarrierBinding,
): void {
  if (!isModuleDescriptor(descriptor) || descriptor.lane !== "browser") {
    throw new TypeError("only an SDK browser module descriptor can receive a carrier binding.");
  }
  if (BROWSER_BINDINGS.has(descriptor)) throw new TypeError(`browser module ${descriptor.id} already has a carrier binding.`);
  BROWSER_BINDINGS.set(descriptor, Object.freeze({ ...binding }));
}

/** @internal Returns only bindings attached by the SDK module resolver. */
export function browserModuleCarrierBinding(
  descriptor: BrowserModuleDescriptor,
): Readonly<BrowserModuleCarrierBinding> | undefined {
  return BROWSER_BINDINGS.get(descriptor);
}

/** @internal Marks a descriptor only after the SDK has read and hashed its carrier bytes. */
export function markBrowserModuleDescriptorVerified(descriptor: BrowserModuleDescriptor): void {
  if (!BROWSER_BINDINGS.has(descriptor)) throw new TypeError("an unbound browser module cannot be marked verified.");
  VERIFIED_BROWSER_BINDINGS.add(descriptor);
}

/** @internal */
export function isBrowserModuleDescriptorVerified(descriptor: BrowserModuleDescriptor): boolean {
  return VERIFIED_BROWSER_BINDINGS.has(descriptor);
}

export function isCoreCapabilityId(value: string): value is KeelModuleId {
  return CORE_IDS.has(value);
}
