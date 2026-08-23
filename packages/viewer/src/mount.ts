import { createSandboxDocument } from "./sandbox.js";
import type { MountOptions, MountedArtifact, ResolvedArtifact } from "./types.js";

export function mountArtifact(
  container: HTMLElement,
  artifact: ResolvedArtifact,
  options: MountOptions = {},
): MountedArtifact {
  const sandboxDocument = createSandboxDocument(artifact, {
    ...(options.runtimeContext === undefined ? {} : { runtimeContext: options.runtimeContext }),
    ...(options.consumer === true ? { consumer: true } : {}),
  });
  const iframe = globalThis.document.createElement("iframe");
  iframe.title = options.title ?? artifact.manifest.name;
  iframe.className = options.className ?? "keel-viewer-frame";
  iframe.loading = options.loading ?? "eager";
  // A mounted game/artifact is an interactive document, not a decorative
  // image. Making the verified frame programmatically focusable lets a host
  // offer an explicit Play/Focus control without granting the frame any new
  // sandbox capability.
  iframe.tabIndex = 0;
  iframe.referrerPolicy = options.referrerPolicy ?? "no-referrer";
  // Chromium embedded-CSP enforcement carries this policy across frame navigations.
  // Other engines safely ignore the unknown attribute, so host egress isolation is
  // still required for a cross-browser high-assurance deployment.
  iframe.setAttribute("csp", sandboxDocument.csp);
  // Prevent ambient cookies/storage credentials even if a browser attempts a
  // frame navigation. Verified bytes are already embedded locally.
  iframe.setAttribute("credentialless", "");
  iframe.sandbox.value = sandboxDocument.sandboxTokens.join(" ");
  if (sandboxDocument.allow.length > 0) iframe.allow = sandboxDocument.allow;
  iframe.srcdoc = sandboxDocument.html;
  iframe.style.border = "0";

  const viewportMode = options.deterministicViewport ?? "scale";
  const viewport = sandboxDocument.viewport;
  let root: HTMLElement = iframe;
  let observer: ResizeObserver | undefined;

  if (viewport !== undefined && viewportMode !== "host") {
    const shell = globalThis.document.createElement("div");
    shell.className = "keel-viewer-viewport";
    shell.style.position = "relative";
    shell.style.width = "100%";
    shell.style.height = "100%";
    shell.style.overflow = "hidden";

    iframe.width = String(viewport.width);
    iframe.height = String(viewport.height);
    iframe.style.position = "absolute";
    iframe.style.width = `${viewport.width}px`;
    iframe.style.height = `${viewport.height}px`;
    iframe.style.transformOrigin = "top left";
    shell.append(iframe);
    root = shell;

    const layout = (): void => {
      if (viewportMode === "fixed") {
        iframe.style.left = "0";
        iframe.style.top = "0";
        iframe.style.transform = "none";
        return;
      }
      const hostWidth = shell.clientWidth || viewport.width || 1;
      const hostHeight = shell.clientHeight || viewport.height || 1;
      const scale = Math.min(hostWidth / viewport.width, hostHeight / viewport.height);
      const renderedWidth = viewport.width * scale;
      const renderedHeight = viewport.height * scale;
      iframe.style.left = `${Math.max(0, (hostWidth - renderedWidth) / 2)}px`;
      iframe.style.top = `${Math.max(0, (hostHeight - renderedHeight) / 2)}px`;
      iframe.style.transform = `scale(${scale})`;
    };

    if (typeof globalThis.ResizeObserver === "function") {
      observer = new ResizeObserver(layout);
      observer.observe(shell);
    }
    queueMicrotask(layout);
  } else {
    iframe.style.width = "100%";
    iframe.style.height = "100%";
  }

  container.replaceChildren(root);
  return {
    iframe,
    root,
    audit: artifact.audit,
    destroy(): void {
      observer?.disconnect();
      root.remove();
    },
  };
}
