const ALLOWED = new Set(["api.tzkt.io", "api.shadownet.tzkt.io", "ipfs.io"]);

function base64(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(output);
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.protocol !== "keel-extension-fetch@1" || typeof message.url !== "string") return false;
  void (async () => {
    try {
      const url = new URL(message.url);
      if (url.protocol !== "https:" || !ALLOWED.has(url.hostname)) throw new Error(`Host ${url.hostname} is not approved by this extension build.`);
      const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.pathname}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 16_000_000) throw new Error("Extension response exceeds the 16 MB safety limit.");
      reply({ ok: true, bytes: base64(bytes), mediaType: response.headers.get("content-type") || "application/octet-stream" });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});
