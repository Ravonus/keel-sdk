(() => {
  "use strict";
  const proof = document.getElementById("archive-proof");
  const help = document.getElementById("keel-help");
  try {
    const runtime = globalThis.__KEEL_RUNTIME__;
    const context = globalThis.__KEEL_CONTEXT__;
    if (runtime?.determinism?.mode !== "live") {
      throw new Error("Keel production viewer requires mode live");
    }
    if (runtime.anchorVerified !== true || context?.protocol !== "keel-context@1") {
      throw new Error("verified live contract context is unavailable");
    }
    if (typeof context.blockTimestamp !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(context.blockTimestamp)) {
      throw new Error("canonical block.timestamp is unavailable");
    }
    if (typeof globalThis.seedGen !== "function" || typeof globalThis.start !== "function") {
      throw new Error("historical object graph is incomplete");
    }
    globalThis.seed = BigInt(context.blockTimestamp);
    globalThis.start(Object.freeze({}));
    document.documentElement.dataset.keelHistoricalRendered = "true";
    document.documentElement.dataset.keelRuntimeMode = "live";
    if (proof) {
      proof.dataset.state = "ready";
      proof.innerHTML = `<strong>KEEL · LIVE + VERIFIED</strong>block ${context.blockNumber} · timestamp ${context.blockTimestamp} · V/H/G controls`;
    }
    addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "v" && proof) proof.hidden = !proof.hidden;
      if ((key === "h" || key === "?") && help) help.dataset.open = help.dataset.open === "true" ? "false" : "true";
      if (key === "g") {
        parent.postMessage({ protocol: "oca-viewer-command@1", action: "open-gallery" }, "*");
      }
    });
  } catch (error) {
    document.documentElement.dataset.keelHistoricalRendered = "false";
    if (proof) {
      proof.dataset.state = "error";
      proof.textContent = error instanceof Error ? error.message : String(error);
    }
    throw error;
  }
})();
