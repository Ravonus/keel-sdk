/**
 * The standalone viewer builders moved into the SDK so galleries, scripts,
 * and the CLI share one implementation: `@keel/sdk` (verification-shell).
 * This file stays as the studio-local import path for the deploy scripts and
 * fixtures; it re-exports the package module and adds nothing.
 */

export {
  KEEL_STANDALONE_VIEWER_PROTOCOL,
  buildEmbeddedKeelViewerShell,
  buildEmbeddedKeelViewerSlot,
  buildStandaloneKeelViewer,
  wrapInVerificationShell,
  type KeelStandaloneViewerBuild,
  type KeelStandaloneViewerEnvelope,
  type KeelStandaloneViewerItem,
  type WrapInVerificationShellOptions,
  type WrapInVerificationShellResult,
} from "@keel/sdk/verification-shell";
