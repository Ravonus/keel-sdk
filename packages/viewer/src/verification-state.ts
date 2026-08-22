export type ViewerVerificationStatus = "pending" | "verified" | "failed" | "unavailable";

export interface ViewerVerificationHostState {
  readonly mountedSeen: boolean;
  readonly readySeen: boolean;
  readonly terminalFailed: boolean;
  readonly status: ViewerVerificationStatus;
}

export type ViewerVerificationHostEvent =
  | { readonly action: "mounted" }
  | { readonly action: "ready" | "state"; readonly childState: "verified" | "failed" | "unavailable" }
  | { readonly action: "timeout" };

export const INITIAL_VIEWER_VERIFICATION_HOST_STATE: ViewerVerificationHostState = Object.freeze({
  mountedSeen: false,
  readySeen: false,
  terminalFailed: false,
  status: "pending",
});

export function transitionViewerVerificationHost(
  current: ViewerVerificationHostState,
  event: ViewerVerificationHostEvent,
  parentVerified: boolean,
): ViewerVerificationHostState {
  if (current.terminalFailed) return current;
  // A child viewer may be a perfectly valid, already-verified runtime that
  // predates the optional `oca-viewer-verification@1` chrome protocol. A
  // missing handshake is therefore an unavailable *interactive* proof, not a
  // failed artifact proof. Keep the state non-terminal so a late handshake can
  // still upgrade the chrome to verified.
  if (event.action === "timeout") return Object.freeze({ ...current, status: "unavailable" });
  if (event.action === "mounted") {
    if (current.mountedSeen) return Object.freeze({ ...current, terminalFailed: true, status: "failed" });
    return Object.freeze({ ...current, mountedSeen: true });
  }
  if (event.action === "state" && event.childState !== "failed" && !current.readySeen) return current;
  if (!current.mountedSeen || event.childState === "failed" || (event.action === "ready" && current.readySeen)) {
    return Object.freeze({ ...current, terminalFailed: true, status: "failed" });
  }
  if (event.action === "ready") {
    return Object.freeze({
      ...current,
      readySeen: true,
      status: event.childState === "verified" && parentVerified ? "verified" : "unavailable",
    });
  }
  return Object.freeze({
    ...current,
    status:
      event.childState === "verified" && parentVerified && current.status === "verified" ? "verified" : "unavailable",
  });
}
