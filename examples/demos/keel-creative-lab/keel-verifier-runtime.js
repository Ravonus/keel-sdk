import { decodeBrotli, initBrotli } from "keel:compression-runtime";
import { replaceVerifiedAliases } from "./alias-resolution.js";
import { browserSha256 } from "./sha256.js";

/*__KEEL_VAULT_VERIFICATION_CHROME__*/

const envelopeElement = document.querySelector("#keel-verification-envelope");
if (!(envelopeElement instanceof HTMLScriptElement)) throw new Error("Missing Keel verification envelope.");
const rawEnvelope = JSON.parse(envelopeElement.textContent ?? "null");
const envelopeItems = Array.isArray(rawEnvelope?.items) ? rawEnvelope.items.filter(Boolean) : [];
const envelope = Object.freeze({
  ...rawEnvelope,
  items: Object.freeze(envelopeItems),
  entrypoint: rawEnvelope?.entrypoint ?? envelopeItems.find((item) => item?.role === "entrypoint")?.id,
});
const stage = document.querySelector("#keel-stage");
const status = document.querySelector("#keel-status");
if (!(stage instanceof HTMLElement) || !(status instanceof HTMLElement)) throw new Error("Invalid Keel verifier document.");
const localParams = new URLSearchParams(location.search);
let contextData = globalThis.__KEEL_CONTEXT__;
let runtimeData = globalThis.__KEEL_RUNTIME__;
let verificationUI;
const outerResources = Object.freeze(envelope.items.map((item) => Object.freeze({
  id: item.id,
  originalName: item.id,
  role: item.role ?? "resource",
  mediaType: item.mediaType,
  byteLength: item.integrity.byteLength,
  digest: item.integrity.digest,
  sources: Object.freeze(item.store && item.objectId
    ? [{ kind: "onchain", chainId: item.chainId, objectId: item.objectId }]
    : item.sources?.map((source) => ({ kind: "url", uri: source.uri }))
      ?? [{ kind: "inline" }]),
})));
Object.defineProperty(globalThis, "__KEEL_CONTENT__", {
  value: Object.freeze({ resources: () => outerResources }),
  configurable: false,
  writable: false,
});

function verificationResult(state, error) {
  const failed = state === "failed";
  const checks = failed
    ? [Object.freeze({ id: "viewer-execution", label: "Committed object verification", passed: false, detail: error, severity: "fatal", plain: "The viewer rejected a committed object before presenting the creator content.", impact: "Unverified bytes are never passed into the creator iframe." })]
    : envelope.items.map((item) => Object.freeze({
      id: `resource-${item.id}`,
      label: `${item.role ?? "resource"} · ${item.id}`,
      passed: true,
      detail: `${item.integrity.digest} · ${item.integrity.byteLength} bytes`,
      severity: "fatal",
      plain: "Decoded SHA-256 and byte length match the committed Keel object.",
      impact: "A byte change fails verification before this resource reaches the creator iframe.",
    }));
  return Object.freeze({
    state,
    title: failed ? "Verification failed" : "Keel runtime verified",
    summary: failed
      ? error
      : `${envelope.items.length} committed viewer objects passed decoded SHA-256 and byte-length verification.`,
    checks: Object.freeze(checks),
    proofTier: failed ? "Rejected render" : "Keel object proof",
    isFixture: false,
    syntheticTokenContext: contextData?.blockNumber === undefined || contextData?.blockHash === undefined,
    proofMode: failed ? "rejected" : "runtime-preview",
  });
}

const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
initBrotli();

const hex = (bytes) => `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
const bytesFromHex = (value) => Uint8Array.from(value.slice(2).match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const word = (value, offset) => value.slice(offset * 2, (offset + 32) * 2);
const integer = (value, offset) => Number(BigInt(`0x${word(value, offset)}`));
const padWord = (value) => value.toString(16).padStart(64, "0");
const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

async function digest(bytes) {
  return browserSha256(bytes);
}

async function verify(bytes, integrity, label) {
  if (bytes.byteLength !== integrity.byteLength) throw new Error(`${label} decoded length mismatch.`);
  if (!equal(await digest(bytes), bytesFromHex(integrity.digest))) throw new Error(`${label} decoded SHA-256 mismatch.`);
  return bytes;
}

async function decompress(compression, bytes) {
  if (compression === "none") return bytes;
  if (compression === "brotli") return decodeBrotli(bytes);
  if (typeof DecompressionStream !== "function") throw new Error(`${compression} decompression is unavailable.`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(compression));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function rpc(method, params) {
  const response = await fetch(envelope.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `RPC ${method} failed.`);
  return payload.result;
}

async function ethCall(to, data) {
  return rpc("eth_call", [{ to, data }, envelope.blockTag ?? "latest"]);
}

function decodeObjectRecord(result) {
  const data = result.slice(2);
  const base = integer(data, 0);
  return {
    digest: `0x${word(data, base)}`,
    byteLength: integer(data, base + 96),
    storedByteLength: integer(data, base + 128),
    count: integer(data, base + 160),
    compression: integer(data, base + 192),
    composite: integer(data, base + 224) === 1,
    exists: integer(data, base + 256) === 1,
  };
}

function decodeArray(result, address) {
  const data = result.slice(2);
  const base = integer(data, 0);
  const count = integer(data, base);
  return Array.from({ length: count }, (_, index) => {
    const value = word(data, base + 32 + index * 32);
    return address ? `0x${value.slice(24)}` : `0x${value}`;
  });
}

const compressionName = (value) => ["none", "gzip", "deflate", "brotli"][value] ?? "unknown";

async function readOnchainObject(item, active = new Set()) {
  const key = `${item.chainId}:${item.store}:${item.objectId}`.toLowerCase();
  if (active.has(key)) throw new Error(`Recursive object cycle at ${item.objectId}.`);
  active.add(key);
  try {
    const record = decodeObjectRecord(await ethCall(item.store, `0x05144857${item.objectId.slice(2)}`));
    if (!record.exists) throw new Error(`Missing onchain object ${item.objectId}.`);
    let decoded;
    if (record.composite) {
      const ids = decodeArray(await ethCall(item.store, `0x7e0fdb69${item.objectId.slice(2)}${padWord(0)}${padWord(record.count)}`), false);
      const parts = [];
      for (const objectId of ids) parts.push(await readOnchainObject({ ...item, objectId }, active));
      const length = parts.reduce((total, part) => total + part.byteLength, 0);
      decoded = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) { decoded.set(part, offset); offset += part.byteLength; }
    } else {
      const pointers = decodeArray(await ethCall(item.store, `0x144658f2${item.objectId.slice(2)}${padWord(0)}${padWord(record.count)}`), true);
      const carriers = await Promise.all(pointers.map(async (pointer) => {
        const code = bytesFromHex(await rpc("eth_getCode", [pointer, envelope.blockTag ?? "latest"]));
        if (code[0] !== 0) throw new Error(`Invalid immutable carrier ${pointer}.`);
        return code.slice(1);
      }));
      const stored = new Uint8Array(carriers.reduce((total, part) => total + part.byteLength, 0));
      let offset = 0;
      for (const carrier of carriers) { stored.set(carrier, offset); offset += carrier.byteLength; }
      if (stored.byteLength !== record.storedByteLength) throw new Error(`Stored length mismatch for ${item.objectId}.`);
      decoded = await decompress(compressionName(record.compression), stored);
    }
    return verify(decoded, { digest: record.digest, byteLength: record.byteLength }, item.id);
  } finally {
    active.delete(key);
  }
}

async function readUrlItem(item) {
  let lastError;
  for (const source of item.sources) {
    try {
      const response = await fetch(source.uri, { cache: "no-store", redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${source.uri}.`);
      const stored = new Uint8Array(await response.arrayBuffer());
      if (source.storedIntegrity) await verify(stored, source.storedIntegrity, `${item.id} stored source`);
      const decoded = await decompress(source.compression, stored);
      return verify(decoded, item.integrity, item.id);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No URL source resolved for ${item.id}.`);
}

async function readEmbeddedItem(item) {
  if (!item.embedded || typeof item.embedded.storedBase64 !== "string") {
    throw new Error(`Missing embedded bytes for ${item.id}.`);
  }
  const stored = fromBase64(item.embedded.storedBase64);
  if (item.embedded.storedIntegrity) {
    await verify(stored, item.embedded.storedIntegrity, `${item.id} stored source`);
  }
  const decoded = await decompress(item.embedded.compression, stored);
  return verify(decoded, item.integrity, item.id);
}

async function resolveItem(item) {
  if (envelope.deliveryProfile === "onchain-recursive") return readOnchainObject(item);
  if (envelope.deliveryProfile === "ordered-url") return readUrlItem(item);
  if (envelope.deliveryProfile === "embedded-assembled") return readEmbeddedItem(item);
  throw new Error(`Unsupported delivery profile ${envelope.deliveryProfile}.`);
}

function installVerificationPresentation(resolved) {
  const presentation = embeddedVerificationPresentation;
  const cssResource = presentation.theme?.cssResource;
  if (cssResource !== undefined) {
    const item = envelope.items.find((candidate) => candidate.id === cssResource.id);
    if (!item || item.mediaType !== "text/css" || item.integrity.digest !== cssResource.digest || item.integrity.byteLength !== cssResource.byteLength) {
      throw new Error("The verification presentation CSS commitment does not match a verified Keel item.");
    }
    const cssBytes = resolved.get(item.id);
    const cssText = new TextDecoder("utf-8", { fatal: true }).decode(cssBytes);
    if (/@import\b|url\s*\(/iu.test(cssText)) throw new Error("Verification presentation CSS cannot perform external requests.");
    const style = document.createElement("style");
    style.dataset.keelVerificationCss = item.id;
    style.textContent = cssText;
    document.head.append(style);
  }
  Object.defineProperty(globalThis, "__KEEL_VERIFICATION_PRESENTATION__", {
    value: presentation,
    configurable: false,
    writable: false,
  });
}

function replaceAliases(text, aliases) {
  return replaceVerifiedAliases(text, aliases);
}

function dataUrl(bytes, mediaType) {
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    encoded += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return `data:${mediaType};base64,${btoa(encoded)}`;
}

function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

async function verifiedRuntimeContext() {
  const candidate = globalThis.__KEEL_ONCHAIN_CONTEXT__;
  if (candidate !== undefined) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.json !== "string"
      || !/^0x[0-9a-f]{64}$/iu.test(candidate.digest) || !Number.isSafeInteger(candidate.byteLength)
      || candidate.byteLength < 2 || candidate.byteLength > 4_096) {
      throw new Error("Malformed onchain runtime context envelope.");
    }
    const bytes = new TextEncoder().encode(candidate.json);
    await verify(bytes, { digest: candidate.digest, byteLength: candidate.byteLength }, "runtime context");
    const parsed = JSON.parse(candidate.json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Runtime context must be a JSON object.");
    return parsed;
  }

  // OnchFS/IPFS directory artifacts can reuse one immutable verified package
  // while binding each token's deterministic recipe in the artifact URI query.
  // Only canonical values are admitted to the child runtime; arbitrary query
  // fields remain inert.
  const params = new URLSearchParams(location.search);
  const declared = ["tokenId", "seed", "attributes"];
  if (!declared.some((name) => params.has(name))) return undefined;
  for (const name of declared) {
    if (params.getAll(name).length > 1) throw new Error(`Duplicate ${name} runtime context field.`);
  }
  const tokenId = params.get("tokenId");
  const seed = params.get("seed");
  const packedAttributes = params.get("attributes");
  if (tokenId !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(tokenId) || tokenId.length > 78 || BigInt(tokenId) > (1n << 256n) - 1n)) {
    throw new Error("Query tokenId must be a canonical uint256 decimal string.");
  }
  for (const [name, value] of [["seed", seed], ["attributes", packedAttributes]]) {
    if (value !== null && !/^0x[0-9a-f]{64}$/u.test(value)) throw new Error(`Query ${name} must be canonical bytes32.`);
  }
  return {
    protocol: "keel-context@1",
    ...(tokenId === null ? {} : { tokenId }),
    ...(seed === null ? {} : { derivedTokenSeed: seed }),
    ...(packedAttributes === null ? {} : { packedAttributes }),
  };
}

function instrumentEntrypoint(html, nonce, runtimeContext, contentUrls, childProof) {
  const context = runtimeContext === undefined
    ? ""
    : `<script>globalThis.__KEEL_CONTEXT__=Object.freeze(${scriptJson(runtimeContext)});globalThis.__KEEL_RUNTIME__=Object.freeze({context:globalThis.__KEEL_CONTEXT__})</script>`;
  // The verification this runtime just performed, forwarded so a child that
  // mounts its own proof chrome renders the host's real result rather than
  // synthesising one. A child only exists because every item passed; this is
  // that fact, with the per-item checks attached.
  const proof = childProof === undefined
    ? ""
    : `<script>globalThis.__KEEL_VERIFICATION__=Object.freeze(${scriptJson(childProof)})</script>`;
  const content = `<script>(()=>{const u=Object.freeze(${scriptJson(contentUrls)}),bytes=id=>{const value=u[id];if(typeof value!=="string")throw new Error("Undeclared verified content "+id);const encoded=value.slice(value.indexOf(",")+1);return Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))};globalThis.__KEEL_CONTENT__=Object.freeze({url:id=>u[id]??null,bytes})})()</script>`;
  const inputBridge = `<script>(()=>{addEventListener("message",event=>{const data=event.data;if(event.source!==parent||data?.protocol!=="keel-child-input@1"||!['keydown','keyup'].includes(data.type)||typeof data.code!=="string"||data.code.length>48||typeof data.key!=="string"||data.key.length>48)return;document.documentElement.dataset.keelLastInput=data.type+':'+data.code;dispatchEvent(new KeyboardEvent(data.type,{code:data.code,key:data.key,repeat:data.repeat===true,altKey:data.altKey===true,ctrlKey:data.ctrlKey===true,metaKey:data.metaKey===true,shiftKey:data.shiftKey===true,bubbles:true,cancelable:true}))})})()</script>`;
  const probe = `<script>(()=>{const n=${JSON.stringify(nonce)},send=(state,detail={})=>parent.postMessage({protocol:"keel-child-runtime@1",nonce:n,state,...detail},"*");addEventListener("error",event=>send("failed",{message:event.message||"Entrypoint runtime error."}));addEventListener("unhandledrejection",event=>send("failed",{message:String(event.reason?.message??event.reason??"Unhandled entrypoint rejection.")}));addEventListener("load",()=>setTimeout(()=>send("ready",{canvasCount:document.querySelectorAll("canvas").length,childCount:document.body?.childElementCount??0,loadError:document.body?.dataset?.loadError??null}),500),{once:true})})()</script>`;
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, (match) => `${match}${context}${proof}${content}${inputBridge}${probe}`);
  }
  // A verified entrypoint may be a fragment (canvas/script) rather than a
  // complete document. Wrap it before injecting Keel globals so the child
  // always executes inside a real top-level document with a <head>.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${context}${proof}${content}${inputBridge}${probe}</head><body>${html}</body></html>`;
}

/*
 * Which document owns the idle seal. False until a verified child says it has
 * mounted its own; `mountVerificationUI` claims the chrome for this document
 * on every call, so this is re-applied after each one.
 */
let childOwnsChrome = false;
function applyChromeOwnership() {
  if (childOwnsChrome) document.documentElement.dataset.verificationChrome = "external";
}

async function launch() {
  document.body.dataset.verification = "loading";
  status.textContent = `VERIFYING ${envelope.items.length} ITEMS`;
  const resolved = new Map();
  for (const item of envelope.items) {
    status.textContent = `VERIFYING ${item.id.toUpperCase()}`;
    resolved.set(item.id, await resolveItem(item));
  }
  installVerificationPresentation(resolved);
  const aliases = new Map();
  for (const item of envelope.items.filter((candidate) => candidate.id !== envelope.entrypoint)) {
    const bytes = resolved.get(item.id);
    let output = bytes;
    if (/^(?:text\/|application\/(?:javascript|json))/u.test(item.mediaType)) {
      output = new TextEncoder().encode(replaceAliases(new TextDecoder().decode(bytes), aliases));
    }
    const url = dataUrl(output, item.mediaType);
    for (const alias of item.aliases) aliases.set(alias, url);
  }
  const entry = envelope.items.find((item) => item.id === envelope.entrypoint);
  if (!entry) throw new Error("Missing entrypoint item.");
  // The Solidity prefix is intentionally inert while the wrapper resolves and
  // authenticates every committed resource. Only an integrity-checked context
  // is copied into the verified child; failed resources never receive it.
  const runtimeContext = await verifiedRuntimeContext();
  contextData = runtimeContext;
  runtimeData = Object.freeze({
    manifestDigest: hex(await digest(new TextEncoder().encode(envelopeElement.textContent ?? ""))),
    revision: 1,
    context: runtimeContext,
  });
  const contentUrls = Object.fromEntries(envelope.items.map((item) => [item.id, dataUrl(resolved.get(item.id), item.mediaType)]));
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  // Every item passed - this frame would not exist otherwise - so the child is
  // handed that result, per-item checks included, as __KEEL_VERIFICATION__.
  const html = instrumentEntrypoint(
    replaceAliases(new TextDecoder().decode(resolved.get(entry.id)), aliases), nonce, runtimeContext, contentUrls,
    verificationResult("verified"),
  );
  const frame = document.createElement("iframe");
  frame.title = envelope.title;
  frame.tabIndex = 0;
  frame.sandbox = "allow-scripts allow-pointer-lock";
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = html;
  // A child that mounts its own Keel proof chrome says so; one seal is enough,
  // and the child's tracks the artwork rather than the viewport. This document
  // keeps rendering the alert states - only the idle corner defers.
  //
  // The claim is kept as state rather than written straight to the attribute,
  // because `mountVerificationUI` sets `verificationChrome` to "embedded" every
  // time it runs and this document mounts its own chrome *after* the child
  // reports ready. Setting it once here was overwritten moments later and both
  // seals appeared - seen, not reasoned about. So the claim is re-applied after
  // any mount, and the two orderings converge on the same answer.
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.data?.protocol !== "keel-viewer-verification@1") return;
    if (event.data.action === "ready") {
      childOwnsChrome = true;
      applyChromeOwnership();
    }
  });
  const forwardInput = (event) => {
    if (!frame.contentWindow || !["keydown", "keyup"].includes(event.type) || typeof event.code !== "string") return;
    frame.contentWindow.postMessage({ protocol: "keel-child-input@1", type: event.type, code: event.code, key: event.key, repeat: event.repeat, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }, "*");
  };
  addEventListener("keydown", forwardInput);
  addEventListener("keyup", forwardInput);
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.protocol !== "keel-host-input@1") return;
    forwardInput(event.data);
  });
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Verified entrypoint did not report runtime readiness.")), 15_000);
    const receive = (event) => {
      if (event.source !== frame.contentWindow || event.data?.protocol !== "keel-child-runtime@1" || event.data?.nonce !== nonce) return;
      if (event.data.state === "failed") {
        clearTimeout(timer);
        removeEventListener("message", receive);
        reject(new Error(event.data.message || "Verified entrypoint runtime failed."));
      } else if (event.data.state === "ready") {
        if (event.data.loadError) {
          clearTimeout(timer);
          removeEventListener("message", receive);
          reject(new Error(`Verified entrypoint reported ${event.data.loadError}.`));
          return;
        }
        const minimumCanvasCount = envelope.runtimeExpectations?.minimumCanvasCount ?? 0;
        if ((event.data.canvasCount ?? 0) < minimumCanvasCount) {
          clearTimeout(timer);
          removeEventListener("message", receive);
          reject(new Error(`Verified entrypoint rendered ${event.data.canvasCount ?? 0} canvases; expected at least ${minimumCanvasCount}.`));
          return;
        }
        clearTimeout(timer);
        removeEventListener("message", receive);
        document.body.dataset.childCanvasCount = String(event.data.canvasCount ?? 0);
        resolve();
      }
    };
    addEventListener("message", receive);
    frame.addEventListener("error", () => { clearTimeout(timer); removeEventListener("message", receive); reject(new Error("Verified entrypoint failed to load.")); }, { once: true });
  });
  stage.replaceChildren(frame);
  await loaded;
  document.body.dataset.verification = "verified";
  status.textContent = "VERIFIED";
  status.hidden = true;
  verificationUI = mountVerificationUI(verificationResult("verified"), runtimeData, contextData);
  applyChromeOwnership();
  verificationUI.ready();
}

launch().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  document.body.dataset.verification = "failed";
  status.hidden = true;
  // A failed verification is this document's to report, whatever a child
  // claimed before it died. Deferring the seal here would leave the refusal
  // resting on a frame that may never have mounted.
  childOwnsChrome = false;
  verificationUI = mountVerificationUI(verificationResult("failed", message), runtimeData, contextData);
  verificationUI.ready();
});
