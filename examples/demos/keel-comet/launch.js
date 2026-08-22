(() => {
  "use strict";
  const proof = document.getElementById("comet-proof");
  const help = document.getElementById("comet-help");

  try {
    const runtime = globalThis.__KEEL_RUNTIME__;
    const context = globalThis.__KEEL_CONTEXT__;
    const index = globalThis.__KEEL_COMET_INDEX__;
    if (runtime?.determinism?.mode !== "live") throw new Error("Comet requires mode live");
    if (runtime.anchorVerified !== true || context?.protocol !== "keel-context@1") {
      throw new Error("verified live contract context is unavailable");
    }
    if (typeof context.blockTimestamp !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(context.blockTimestamp)) {
      throw new Error("canonical block.timestamp is unavailable");
    }
    const timestamp = Number(context.blockTimestamp);
    if (!Number.isSafeInteger(timestamp)) throw new Error("block.timestamp exceeds the safe legacy extras range");
    if (typeof context.derivedTokenSeed !== "string" || !/^0x[0-9a-f]{64}$/.test(context.derivedTokenSeed)) {
      throw new Error("verified token seed is unavailable");
    }
    if (
      index?.packedWord !== "0x0000000000000006000000000005000000000004000000000003000000000002" ||
      typeof globalThis.p5 !== "function" ||
      typeof globalThis.seedGen !== "function" ||
      typeof globalThis.start !== "function"
    ) {
      throw new Error("five-slot Comet object graph is incomplete");
    }

    globalThis.extras = Object.freeze([timestamp]);
    globalThis.seed = BigInt(context.derivedTokenSeed);
    globalThis.start(Object.freeze({}));
    document.documentElement.dataset.keelCometRendered = "true";
    document.documentElement.dataset.keelRuntimeMode = "live";
    document.documentElement.dataset.keelPackedIds = "2,3,4,5,6";
    if (proof) {
      proof.dataset.state = "ready";
      proof.innerHTML = `<strong>KEEL COMET · LIVE + VERIFIED</strong>viewer [2,3,4,5,6] · block ${context.blockNumber} · timestamp ${context.blockTimestamp}`;
    }

    addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "v" && proof) proof.hidden = !proof.hidden;
      if ((key === "h" || key === "?") && help) help.dataset.open = help.dataset.open === "true" ? "false" : "true";
      if (key === "g") parent.postMessage({ protocol: "keel-viewer-command@1", action: "open-gallery" }, "*");
    });
  } catch (error) {
    document.documentElement.dataset.keelCometRendered = "false";
    if (proof) {
      proof.dataset.state = "error";
      proof.textContent = error instanceof Error ? error.message : String(error);
    }
    throw error;
  }
})();
