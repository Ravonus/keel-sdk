import {
  evaluateProjectRevision,
  projectStackCommitments,
  validateManifest,
  type ArtifactManifest,
  type KeelProjectComponent,
} from "@keel/protocol";

import type { SandboxDiagnostic, SandboxInspectionReport } from "./types.js";

function decodedBytes(manifest: ArtifactManifest): number {
  const digests = new Map<string, number>();
  for (const resource of manifest.resources) {
    for (const source of resource.sources) {
      if (source.integrity.byteLength !== undefined) digests.set(source.integrity.digest, source.integrity.byteLength);
    }
  }
  return [...digests.values()].reduce((sum, value) => sum + value, 0);
}

function fallbackDiagnostic(manifest: ArtifactManifest): SandboxDiagnostic {
  const fallback = manifest.resources.find((resource) => resource.id === manifest.fallback.image);
  const compatible = fallback?.mediaType.startsWith("image/") === true;
  return compatible
    ? { level: "pass", code: "fallback.image", title: "Marketplace preview ready", message: "A conventional image fallback is available for viewers that do not open the full project." }
    : { level: "warning", code: "fallback.non-image", title: "Add a marketplace preview", message: "The fallback is not an image. Older ERC-721 viewers may show a broken or empty thumbnail." };
}

function componentDiagnostics(component: KeelProjectComponent): readonly SandboxDiagnostic[] {
  const diagnostics: SandboxDiagnostic[] = [];
  if (component.format === "commonjs") {
    diagnostics.push({
      level: "warning",
      code: "module.commonjs-build",
      title: `${component.label} needs a browser bundle`,
      message: "CommonJS is accepted as source, but the published executable should be a deterministic ES-module or classic-script build with a verified build receipt.",
      componentId: component.id,
    });
  } else {
    diagnostics.push({
      level: "pass",
      code: "module.known-format",
      title: `${component.label} has a declared format`,
      message: `${component.format.replaceAll("-", " ")} will be checked consistently by Studio and the sandbox SDK.`,
      componentId: component.id,
    });
  }
  if (component.updates.mode === "locked") {
    diagnostics.push({ level: "info", code: "updates.locked", title: `${component.label} is locked`, message: "A child project revision cannot rename, reorder, replace, or remove this exact component.", componentId: component.id });
  }
  if (component.updates.mode === "auto-compatible") {
    diagnostics.push({ level: "info", code: "updates.auto", title: `${component.label} may advance automatically`, message: "Only a new exact Library version inside the creator-approved range may create a child project revision.", componentId: component.id });
  }
  return diagnostics;
}

export async function inspectSandboxManifest(
  manifest: ArtifactManifest,
  options: { readonly previousManifest?: ArtifactManifest; readonly manualApproval?: boolean } = {},
): Promise<SandboxInspectionReport> {
  const validation = validateManifest(manifest);
  const components = manifest.stack?.components ?? [];
  const diagnostics: SandboxDiagnostic[] = [fallbackDiagnostic(manifest)];
  let componentCommitments: Awaited<ReturnType<typeof projectStackCommitments>> = [];
  try {
    componentCommitments = await projectStackCommitments(manifest);
  } catch (error) {
    diagnostics.push({
      level: "error",
      code: "stack.commitments",
      title: "Component hashes could not be created",
      message: error instanceof Error ? error.message : "The project stack is invalid.",
    });
  }
  if (manifest.stack === undefined) {
    diagnostics.push({ level: "warning", code: "stack.missing", title: "Project parts are not labelled", message: "Add a Keel project stack so creators and collectors can see which exact renderer, assets, scripts, and update rules make up this revision." });
  } else {
    diagnostics.push(...components.flatMap(componentDiagnostics));
  }
  const hasRemote = manifest.resources.some((resource) => resource.sources.some((source) => source.kind === "uri" && !source.uri.startsWith("./") && !source.uri.startsWith("../")));
  diagnostics.push(hasRemote
    ? { level: "info", code: "storage.hybrid", title: "Verified remote mirror declared", message: "The host may retrieve the mirror only when its decoded bytes match the committed resource digest." }
    : { level: "pass", code: "storage.local-or-onchain", title: "No unbound remote dependency", message: "Every declared source still passes the same exact-byte verifier before sandbox exposure." });
  const projectRevision = options.previousManifest === undefined
    ? undefined
    : await evaluateProjectRevision(options.previousManifest, manifest, { manualApproval: options.manualApproval === true });
  if (projectRevision !== undefined) {
    for (const change of projectRevision.changes.filter((item) => item.kind !== "unchanged")) {
      diagnostics.push({
        level: change.decision === "blocked" ? "error" : change.decision === "approval-required" ? "warning" : "pass",
        code: `revision.${change.decision}`,
        title: `${change.componentId}: ${change.kind}`,
        message: change.reason,
        componentId: change.componentId,
      });
    }
  }
  const errors =
    validation.issues.some((issue) => issue.level === "error") ||
    diagnostics.some((diagnostic) => diagnostic.level === "error") ||
    projectRevision?.valid === false;
  return {
    schema: "keel-sandbox-report@1",
    valid: !errors,
    manifestId: manifest.id,
    revision: manifest.revision.number,
    protocolIssues: validation.issues,
    diagnostics,
    componentCommitments,
    ...(projectRevision === undefined ? {} : { projectRevision }),
    summary: {
      resources: manifest.resources.length,
      components: components.length,
      libraries: manifest.libraries?.assets.length ?? 0,
      decodedBytesDeclared: decodedBytes(manifest),
      locked: components.filter((item) => item.updates.mode === "locked").length,
      manual: components.filter((item) => item.updates.mode === "manual").length,
      automatic: components.filter((item) => item.updates.mode === "auto-compatible").length,
    },
  };
}
