import { canonicalJson } from "./canonical.js";
import { createIntegrity } from "./integrity.js";
import type {
  ArtifactManifest,
  Integrity,
  KeelLibraryReference,
  KeelProjectComponent,
} from "./types.js";
import { utf8ToBytes } from "./bytes.js";

export type ProjectComponentChangeKind =
  | "added"
  | "removed"
  | "descriptor"
  | "policy"
  | "library-version"
  | "unchanged";
export type ProjectComponentChangeDecision = "allowed" | "approval-required" | "blocked";

export interface ProjectComponentCommitmentEntry {
  readonly componentId: string;
  readonly label: string;
  readonly order: number;
  readonly updateMode: KeelProjectComponent["updates"]["mode"];
  readonly commitment: Integrity;
}

export interface ProjectComponentChange {
  readonly componentId: string;
  readonly kind: ProjectComponentChangeKind;
  readonly decision: ProjectComponentChangeDecision;
  readonly reason: string;
  readonly parentCommitment?: Integrity;
  readonly nextCommitment?: Integrity;
}

export interface ProjectRevisionEvaluation {
  readonly valid: boolean;
  readonly requiresManualApproval: boolean;
  readonly changes: readonly ProjectComponentChange[];
}

function libraryById(manifest: ArtifactManifest): ReadonlyMap<string, KeelLibraryReference> {
  return new Map((manifest.libraries?.assets ?? []).map((asset) => [asset.id, asset] as const));
}

function componentBinding(component: KeelProjectComponent, library: KeelLibraryReference | undefined): unknown {
  return {
    id: component.id,
    label: component.label,
    role: component.role,
    order: component.order,
    resource: component.resource,
    resourceIntegrity: component.resourceIntegrity,
    ...(component.library === undefined ? {} : { library: component.library }),
    ...(component.labelOrigin === undefined ? {} : { labelOrigin: component.labelOrigin }),
    format: component.format,
    updates: component.updates,
    ...(library === undefined
      ? {}
      : {
          libraryBinding: {
            chainId: library.chainId,
            registry: library.registry,
            assetId: library.assetId,
            policyVersion: library.policyVersion,
            policyCommitment: library.policyCommitment,
            graph: library.graph,
            manifestDigest: library.manifestDigest,
            resourceGraphDigest: library.resourceGraphDigest,
          },
        }),
  };
}

/** Exact SHA-256 commitment used by updater UIs, SDKs, and CI. */
export async function projectComponentCommitment(
  component: KeelProjectComponent,
  library?: KeelLibraryReference,
): Promise<Integrity> {
  return createIntegrity(utf8ToBytes(canonicalJson(componentBinding(component, library))));
}

/**
 * Canonical per-component hashes for updater apps, creator UIs, and CI. IDs are
 * the stable comparison keys; array position remains committed through `order`.
 */
export async function projectStackCommitments(
  manifest: ArtifactManifest,
): Promise<readonly ProjectComponentCommitmentEntry[]> {
  const libraries = libraryById(manifest);
  const components = manifest.stack?.components ?? [];
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id)) throw new TypeError(`Duplicate project component ID: ${component.id}`);
    ids.add(component.id);
  }
  return Promise.all(
    [...components]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map(async (component) => ({
        componentId: component.id,
        label: component.label,
        order: component.order,
        updateMode: component.updates.mode,
        commitment: await projectComponentCommitment(
          component,
          component.library === undefined ? undefined : libraries.get(component.library),
        ),
      })),
  );
}

function sameIntegrity(left: Integrity, right: Integrity): boolean {
  return left.algorithm === right.algorithm && left.digest === right.digest && left.byteLength === right.byteLength;
}

function sameLibraryIdentity(left: KeelLibraryReference, right: KeelLibraryReference): boolean {
  return (
    left.chainId === right.chainId &&
    left.registry.toLowerCase() === right.registry.toLowerCase() &&
    left.assetId === right.assetId &&
    left.graph.registry.toLowerCase() === right.graph.registry.toLowerCase() &&
    left.graph.graphId === right.graph.graphId
  );
}

function policyRank(mode: KeelProjectComponent["updates"]["mode"]): number {
  if (mode === "locked") return 2;
  if (mode === "manual") return 1;
  return 0;
}

function sameUpdatePolicy(
  left: KeelProjectComponent["updates"],
  right: KeelProjectComponent["updates"],
): boolean {
  return (
    left.mode === right.mode &&
    left.compatibleGraphVersions?.min === right.compatibleGraphVersions?.min &&
    left.compatibleGraphVersions?.max === right.compatibleGraphVersions?.max
  );
}

function broadenedAutoRange(
  parent: KeelProjectComponent["updates"],
  next: KeelProjectComponent["updates"],
): boolean {
  if (parent.mode !== "auto-compatible" || next.mode !== "auto-compatible") return false;
  const before = parent.compatibleGraphVersions;
  const after = next.compatibleGraphVersions;
  return before === undefined || after === undefined || after.min < before.min || after.max > before.max;
}

function componentIndex(manifest: ArtifactManifest): {
  readonly components: ReadonlyMap<string, KeelProjectComponent>;
  readonly duplicateIds: readonly string[];
} {
  const components = new Map<string, KeelProjectComponent>();
  const duplicateIds = new Set<string>();
  for (const component of manifest.stack?.components ?? []) {
    if (components.has(component.id)) duplicateIds.add(component.id);
    components.set(component.id, component);
  }
  return { components, duplicateIds: [...duplicateIds].sort() };
}

function autoCompatibleChange(
  parent: KeelProjectComponent,
  next: KeelProjectComponent,
  parentLibrary: KeelLibraryReference | undefined,
  nextLibrary: KeelLibraryReference | undefined,
): string | undefined {
  if (parentLibrary === undefined || nextLibrary === undefined) return "Automatic updates require an exact Library binding in both revisions.";
  if (!sameLibraryIdentity(parentLibrary, nextLibrary)) return "Automatic updates cannot switch to a different Library asset or graph.";
  const range = parent.updates.compatibleGraphVersions;
  if (range === undefined || nextLibrary.graph.version < range.min || nextLibrary.graph.version > range.max) {
    return "The proposed Library graph version is outside the creator-approved compatibility range.";
  }
  if (nextLibrary.graph.version < parentLibrary.graph.version) return "Automatic updates cannot move a component backward.";
  if (
    parent.id !== next.id ||
    parent.label !== next.label ||
    parent.role !== next.role ||
    parent.order !== next.order ||
    parent.resource !== next.resource ||
    parent.library !== next.library ||
    parent.labelOrigin !== next.labelOrigin ||
    parent.format !== next.format
  ) {
    return "Automatic updates may advance exact Library bytes, not rename, reorder, or reinterpret the component.";
  }
  const nextRange = next.updates.compatibleGraphVersions;
  if (next.updates.mode === "auto-compatible") {
    if (nextRange === undefined || nextRange.min < range.min || nextRange.max > range.max) {
      return "A child revision cannot broaden its automatic update range.";
    }
  }
  return undefined;
}

/**
 * Compare an immutable parent manifest to a proposed child. This is the single
 * publication gate used for manual and automated updates; it never mutates a
 * project and never replaces the normal KeelIndex revision call.
 */
export async function evaluateProjectRevision(
  parent: ArtifactManifest,
  next: ArtifactManifest,
  options: { readonly manualApproval?: boolean } = {},
): Promise<ProjectRevisionEvaluation> {
  if (next.revision.parent !== parent.revision.number || next.revision.number !== parent.revision.number + 1) {
    return {
      valid: false,
      requiresManualApproval: false,
      changes: [{
        componentId: "project",
        kind: "descriptor",
        decision: "blocked",
        reason: "The proposed manifest must be the next sequential child of the exact parent revision.",
      }],
    };
  }

  const parentIndex = componentIndex(parent);
  const nextIndex = componentIndex(next);
  const duplicateIds = [...new Set([...parentIndex.duplicateIds, ...nextIndex.duplicateIds])];
  if (duplicateIds.length > 0) {
    return {
      valid: false,
      requiresManualApproval: false,
      changes: duplicateIds.map((componentId) => ({
        componentId,
        kind: "descriptor",
        decision: "blocked",
        reason: "Project component IDs must be unique before hashes can be compared safely.",
      })),
    };
  }
  const parentComponents = parentIndex.components;
  const nextComponents = nextIndex.components;
  const parentLibraries = libraryById(parent);
  const nextLibraries = libraryById(next);
  const ids = new Set([...parentComponents.keys(), ...nextComponents.keys()]);
  const changes: ProjectComponentChange[] = [];

  for (const id of ids) {
    const before = parentComponents.get(id);
    const after = nextComponents.get(id);
    if (before === undefined && after !== undefined) {
      const nextCommitment = await projectComponentCommitment(after, after.library === undefined ? undefined : nextLibraries.get(after.library));
      changes.push({
        componentId: id,
        kind: "added",
        decision: options.manualApproval === true ? "allowed" : "approval-required",
        reason: "Adding a project component requires explicit creator approval.",
        nextCommitment,
      });
      continue;
    }
    if (before !== undefined && after === undefined) {
      const parentCommitment = await projectComponentCommitment(before, before.library === undefined ? undefined : parentLibraries.get(before.library));
      const locked = before.updates.mode === "locked";
      changes.push({
        componentId: id,
        kind: "removed",
        decision: locked ? "blocked" : options.manualApproval === true ? "allowed" : "approval-required",
        reason: locked ? "A locked component cannot be removed." : "Removing a component requires explicit creator approval.",
        parentCommitment,
      });
      continue;
    }
    if (before === undefined || after === undefined) continue;
    const beforeLibrary = before.library === undefined ? undefined : parentLibraries.get(before.library);
    const afterLibrary = after.library === undefined ? undefined : nextLibraries.get(after.library);
    const [parentCommitment, nextCommitment] = await Promise.all([
      projectComponentCommitment(before, beforeLibrary),
      projectComponentCommitment(after, afterLibrary),
    ]);
    if (sameIntegrity(parentCommitment, nextCommitment)) {
      changes.push({ componentId: id, kind: "unchanged", decision: "allowed", reason: "Exact component commitment retained.", parentCommitment, nextCommitment });
      continue;
    }
    if (policyRank(after.updates.mode) < policyRank(before.updates.mode)) {
      changes.push({
        componentId: id,
        kind: "descriptor",
        decision: "blocked",
        reason: "A child revision cannot reopen a stricter component update policy.",
        parentCommitment,
        nextCommitment,
      });
      continue;
    }
    if (broadenedAutoRange(before.updates, after.updates)) {
      changes.push({
        componentId: id,
        kind: "policy",
        decision: "blocked",
        reason: "A child revision cannot broaden its automatic update range.",
        parentCommitment,
        nextCommitment,
      });
      continue;
    }
    if (!sameUpdatePolicy(before.updates, after.updates)) {
      changes.push({
        componentId: id,
        kind: "policy",
        decision: options.manualApproval === true ? "allowed" : "approval-required",
        reason: "Changing or tightening a component update policy requires explicit creator approval.",
        parentCommitment,
        nextCommitment,
      });
      continue;
    }
    if (before.updates.mode === "locked") {
      changes.push({ componentId: id, kind: "descriptor", decision: "blocked", reason: "A locked component descriptor cannot change.", parentCommitment, nextCommitment });
      continue;
    }
    if (before.updates.mode === "manual") {
      changes.push({
        componentId: id,
        kind: "descriptor",
        decision: options.manualApproval === true ? "allowed" : "approval-required",
        reason: "This component is configured for creator-approved updates.",
        parentCommitment,
        nextCommitment,
      });
      continue;
    }
    const blocked = autoCompatibleChange(before, after, beforeLibrary, afterLibrary);
    changes.push({
      componentId: id,
      kind: "library-version",
      decision: blocked === undefined ? "allowed" : "blocked",
      reason: blocked ?? "Exact Library version advanced inside the creator-approved range.",
      parentCommitment,
      nextCommitment,
    });
  }

  const requiresManualApproval = changes.some((change) => change.decision === "approval-required");
  return {
    valid: !changes.some((change) => change.decision === "blocked") && !requiresManualApproval,
    requiresManualApproval,
    changes,
  };
}
