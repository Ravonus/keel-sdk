import type {
  ArtifactManifest,
  ManifestValidationIssue,
  ProjectComponentCommitmentEntry,
  ProjectRevisionEvaluation,
  KeelComponentFormat,
  KeelComponentRole,
  KeelComponentUpdatePolicy,
} from "@keel/protocol";
import type { PreparedStudioArtifact, StudioStackComponentInput } from "@keel/studio-core";
import type { ResolutionAudit, SandboxDocument } from "@keel/viewer";

export type SandboxDiagnosticLevel = "pass" | "info" | "warning" | "error";

export interface SandboxDiagnostic {
  readonly level: SandboxDiagnosticLevel;
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly componentId?: string;
}

export interface SandboxInspectionReport {
  readonly schema: "oca-sandbox-report@1";
  readonly valid: boolean;
  readonly manifestId: string;
  readonly revision: number;
  readonly protocolIssues: readonly ManifestValidationIssue[];
  readonly diagnostics: readonly SandboxDiagnostic[];
  /** Canonical hashes consumed by Studio, updater apps, CI, and AI tooling. */
  readonly componentCommitments: readonly ProjectComponentCommitmentEntry[];
  readonly projectRevision?: ProjectRevisionEvaluation;
  readonly summary: {
    readonly resources: number;
    readonly components: number;
    readonly libraries: number;
    readonly decodedBytesDeclared: number;
    readonly locked: number;
    readonly manual: number;
    readonly automatic: number;
  };
}

export interface SandboxProjectFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly component?: StudioStackComponentInput;
}

export interface SandboxProjectInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly files: readonly SandboxProjectFile[];
  readonly creator?: string;
  readonly revision?: number;
  readonly parentRevision?: number;
  readonly previousManifest?: ArtifactManifest;
  readonly manualApproval?: boolean;
}

export interface PreparedSandboxProject {
  readonly prepared: PreparedStudioArtifact;
  readonly report: SandboxInspectionReport;
  readonly audit: ResolutionAudit;
  readonly sandbox: SandboxDocument;
}

export interface DetectedComponent {
  readonly label: string;
  readonly role: KeelComponentRole;
  readonly format: KeelComponentFormat;
  readonly updates: KeelComponentUpdatePolicy;
}
