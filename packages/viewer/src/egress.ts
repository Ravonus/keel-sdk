/**
 * Host-level network guard for dedicated Electron viewer sessions.
 *
 * The iframe sandbox blocks browser APIs and virtualizes declared resources,
 * but a production desktop host should also deny requests below the renderer.
 * Resolve and verify remote/IPFS/on-chain bytes in a trusted process, then pass
 * only the completed ResolvedArtifact into the guarded viewer WebContents.
 */

export interface ElectronBeforeRequestDetailsLike {
  readonly url: string;
  readonly resourceType?: string;
  readonly webContentsId?: number;
}

export interface ElectronBeforeRequestResultLike {
  readonly cancel?: boolean;
  readonly redirectURL?: string;
}

export interface ElectronWebRequestLike {
  onBeforeRequest(
    filter: { readonly urls: readonly string[] } | null,
    listener:
      | ((
          details: ElectronBeforeRequestDetailsLike,
          callback: (result: ElectronBeforeRequestResultLike) => void,
        ) => void)
      | null,
  ): void;
}

export interface ElectronSessionLike {
  readonly webRequest: ElectronWebRequestLike;
}

export interface ElectronEgressGuard {
  readonly blockedPatterns: readonly string[];
  dispose(): void;
}

export const VIEWER_BLOCKED_REQUEST_PATTERNS = ["<all_urls>"] as const;

/**
 * Install only on a dedicated Electron session/partition. Electron permits a
 * single listener for this event, so sharing the session with unrelated pages
 * would replace their request policy.
 */
export function installElectronViewerEgressGuard(session: ElectronSessionLike): ElectronEgressGuard {
  const blockedPatterns = VIEWER_BLOCKED_REQUEST_PATTERNS;
  session.webRequest.onBeforeRequest({ urls: blockedPatterns }, (_details, callback) => {
    callback({ cancel: true });
  });
  return {
    blockedPatterns,
    dispose(): void {
      session.webRequest.onBeforeRequest(null, null);
    },
  };
}
