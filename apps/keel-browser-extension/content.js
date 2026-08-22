(() => {
  "use strict";
  const PROTOCOL = "keel-extension-fetch@1";
  const match = /^\/tokens\/(KT1[1-9A-HJ-NP-Za-km-z]{33})\/(0|[1-9][0-9]*)\/?$/u.exec(location.pathname);
  if (!match) return;
  const [, contract, tokenId] = match;
  const api = location.hostname.startsWith("shadownet.") ? "https://api.shadownet.tzkt.io" : "https://api.tzkt.io";

  const decodeBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const encodeBase64 = (bytes) => {
    let output = "";
    for (let index = 0; index < bytes.length; index += 0x8000) output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(output);
  };
  const bytesFromHex = (value) => Uint8Array.from(String(value || "").replace(/^0x/u, "").match(/.{2}/gu) || [], (pair) => Number.parseInt(pair, 16));
  const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
  const fetchBytes = (url) => new Promise((resolve, reject) => chrome.runtime.sendMessage({ protocol: PROTOCOL, url }, (result) => {
    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
    else if (!result?.ok) reject(new Error(result?.error || "Extension fetch failed."));
    else resolve(decodeBase64(result.bytes));
  }));
  const fetchJson = async (url) => JSON.parse(new TextDecoder().decode(await fetchBytes(url)));
  const route = (uri) => {
    const absolute = /^tezos-storage:\/\/(KT1[1-9A-HJ-NP-Za-km-z]{33})\/([^?#]+)$/u.exec(String(uri || ""));
    if (absolute) return { contract: absolute[1], key: decodeURIComponent(absolute[2]) };
    const relative = /^tezos-storage:([^/?#][^?#]*)$/u.exec(String(uri || ""));
    if (relative) return { contract, key: decodeURIComponent(relative[1]) };
    throw new Error("Token does not expose a supported Keel Tezos-storage route.");
  };
  const tezosStorage = async (uri) => {
    const target = route(uri);
    const storage = await fetchJson(`${api}/v1/contracts/${target.contract}/storage`);
    if (!Number.isInteger(storage?.metadata)) throw new Error("Collection has no standard metadata big-map.");
    const entry = await fetchJson(`${api}/v1/bigmaps/${storage.metadata}/keys/${encodeURIComponent(target.key)}`);
    return bytesFromHex(entry?.value);
  };
  const hydrate = async (html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const contextNode = parsed.querySelector("#keel-context");
    if (!contextNode) return html;
    const context = JSON.parse(contextNode.textContent || "{}");
    for (const [name, descriptor] of Object.entries(context.modules || {})) {
      if (typeof descriptor?.url !== "string") throw new Error(`Module ${name} has no committed delivery URL.`);
      const bytes = await fetchBytes(descriptor.url.replace(/^ipfs:\/\//u, "https://ipfs.io/ipfs/"));
      const actual = await sha256(bytes);
      if (actual !== String(descriptor.encodedSha256 || "").replace(/^0x/u, "").toLowerCase()) throw new Error(`Module ${name} failed encoded SHA-256 verification.`);
      descriptor.url = `data:application/octet-stream;base64,${encodeBase64(bytes)}`;
    }
    contextNode.textContent = JSON.stringify(context);
    return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
  };

  function shell() {
    const root = document.createElement("section");
    root.id = "keel-extension-viewer";
    root.innerHTML = '<button class="keel-close" type="button" aria-label="Close Keel viewer">×</button><div class="keel-state">VERIFYING KEEL TOKEN…</div><iframe title="Verified Keel token" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-downloads" allow="autoplay; gamepad" tabindex="0"></iframe><div class="keel-proof">KEEL · VERIFYING</div>';
    root.querySelector(".keel-close").addEventListener("click", () => root.remove());
    document.documentElement.append(root);
    return root;
  }

  async function open() {
    if (document.querySelector("#keel-extension-viewer")) return;
    const root = shell();
    try {
      const rows = await fetchJson(`${api}/v1/tokens?contract=${contract}&tokenId=${tokenId}`);
      const metadata = rows?.[0]?.metadata;
      if (!metadata || typeof metadata.keelArtifactUri !== "string") throw new Error("This token does not declare a Keel viewer.");
      const bytes = await tezosStorage(metadata.keelArtifactUri);
      const actual = await sha256(bytes);
      const expected = String(metadata.keelViewerDigest || "").replace(/^0x/u, "").toLowerCase();
      if (!/^[0-9a-f]{64}$/u.test(expected) || actual !== expected) throw new Error("Keel viewer digest mismatch.");
      const html = await hydrate(new TextDecoder().decode(bytes));
      const frame = root.querySelector("iframe");
      frame.addEventListener("load", () => { root.dataset.ready = "true"; root.querySelector(".keel-state").hidden = true; frame.focus(); }, { once: true });
      frame.srcdoc = html;
      const proof = root.querySelector(".keel-proof");
      proof.textContent = `KEEL · VERIFIED ${actual.slice(0, 12)}…`;
      proof.dataset.verified = "true";
    } catch (error) {
      root.dataset.failed = "true";
      root.querySelector(".keel-state").textContent = `KEEL VERIFICATION FAILED\n${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const button = document.createElement("button");
  button.id = "keel-extension-open";
  button.type = "button";
  button.textContent = "Open verified Keel viewer";
  button.addEventListener("click", () => void open());
  document.documentElement.append(button);
  chrome.storage.sync.get({ autoOpen: true }, ({ autoOpen }) => { if (autoOpen) void open(); });
})();
