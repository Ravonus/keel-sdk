import { isModuleDescriptor, type ModuleDescriptor, type ModuleLane } from "./descriptor.js";
import type { DeclaredModule, ExtendedModuleApis } from "./define.js";

type AnyDescriptor = ModuleDescriptor<string, ModuleLane, string, unknown>;
type AnyDeclared = DeclaredModule<readonly AnyDescriptor[]>;
type DescriptorsOf<Parent> = Parent extends DeclaredModule<infer Descriptors> ? Descriptors : never;
type Combined<Parent, Own extends readonly AnyDescriptor[]> = readonly [...DescriptorsOf<Parent>, ...Own];

export interface ParentScopeReference<Parent extends AnyDeclared> {
  readonly kind: "keel-parent-scope-ref@1";
  readonly name: string;
  readonly __parent?: Parent;
}

export interface ChildModuleScope<Parent extends AnyDeclared, Own extends readonly AnyDescriptor[]> {
  readonly kind: "keel-child-scope@1";
  readonly name: string;
  readonly parent: ParentScopeReference<Parent>;
  readonly ownExtends: Own;
  readonly init?: (modules: ExtendedModuleApis<Combined<Parent, Own>>) => void | Promise<void>;
}

const PARENT_REFS = new WeakSet<object>();
const CHILD_SCOPES = new WeakSet<object>();

interface RuntimeChildScope {
  readonly kind: "keel-child-scope@1";
  readonly name: string;
  readonly parent: { readonly name: string };
  readonly ownExtends: readonly AnyDescriptor[];
}

/**
 * Creates a runtime-light parent link whose generic carries APIs through a
 * type-only import. This is safe when an entry imports a child that imports
 * only `typeof root` back from the entry.
 */
export function parentScope<Parent extends AnyDeclared>(name: string): ParentScopeReference<Parent> {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("parent scope needs a name.");
  const reference = Object.freeze({ kind: "keel-parent-scope-ref@1" as const, name }) as ParentScopeReference<Parent>;
  PARENT_REFS.add(reference);
  return reference;
}

export function defineChildScope<
  Parent extends AnyDeclared,
  const Own extends readonly AnyDescriptor[],
>(name: string, input: {
  readonly parent: ParentScopeReference<Parent>;
  readonly extends: Own;
  readonly init?: (modules: ExtendedModuleApis<Combined<Parent, Own>>) => void | Promise<void>;
}): ChildModuleScope<Parent, Own> {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("child scope needs a name.");
  if (!PARENT_REFS.has(input.parent)) throw new TypeError("parent must be created with parentScope().");
  const ownExtends = Object.freeze([...input.extends]) as unknown as Own;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const descriptor of ownExtends) {
    if (!isModuleDescriptor(descriptor)) throw new TypeError("child extends contains an invalid Keel module descriptor.");
    if (ids.has(descriptor.id)) throw new TypeError(`child scope ${name} extends ${descriptor.id} twice.`);
    if (keys.has(descriptor.key)) throw new TypeError(`child module API name ${descriptor.key} is declared twice.`);
    ids.add(descriptor.id);
    keys.add(descriptor.key);
  }
  const child = Object.freeze({
    kind: "keel-child-scope@1" as const,
    name,
    parent: input.parent,
    ownExtends,
    ...(input.init === undefined ? {} : { init: input.init }),
  }) as ChildModuleScope<Parent, Own>;
  CHILD_SCOPES.add(child);
  return child;
}

/** Bind type-only child references to their real parent and reject conflicts. */
export function connectChildScopes<
  ParentDescriptors extends readonly AnyDescriptor[],
  const Children extends readonly RuntimeChildScope[],
>(parent: DeclaredModule<ParentDescriptors>, children: Children): Readonly<DeclaredModule<ParentDescriptors> & {
  module: DeclaredModule<ParentDescriptors>;
  children: Children;
}> {
  const ids = new Set(parent.extends.map((descriptor) => descriptor.id));
  const keys = new Set(parent.extends.map((descriptor) => descriptor.key));
  const names = new Set<string>();
  for (const child of children) {
    if (!CHILD_SCOPES.has(child)) throw new TypeError("children contains an invalid child scope.");
    if (child.parent.name !== parent.manifest.name) {
      throw new TypeError(`child scope ${child.name} names parent ${child.parent.name}, expected ${parent.manifest.name}.`);
    }
    if (names.has(child.name)) throw new TypeError(`child scope ${child.name} is connected twice.`);
    names.add(child.name);
    for (const descriptor of child.ownExtends) {
      if (ids.has(descriptor.id)) throw new TypeError(`child scope ${child.name} conflicts with inherited module ${descriptor.id}.`);
      if (keys.has(descriptor.key)) throw new TypeError(`child scope ${child.name} conflicts with inherited API name ${descriptor.key}.`);
      ids.add(descriptor.id);
      keys.add(descriptor.key);
    }
  }
  /* A connected declaration remains a declaration. This lets a creator export
   * connectChildScopes(root, children) as its default without making the
   * browser mount path special-case a wrapper; the child registry is additive
   * runtime metadata, never a second module identity. */
  return Object.freeze({
    ...parent,
    module: parent,
    children: Object.freeze([...children]) as unknown as Children,
  });
}
