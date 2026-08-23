import { bytesToUtf8, encodeBase64, toDataUrl, type ResourceSource } from "@keel/protocol";
import { createVerifiedContentGateway, resourceGatewayAliases } from "./gateway.js";
import { evaluateCollectionVerification } from "./collection-verification.js";
import type { RuntimeCapabilities } from "@keel/protocol";
import type {
  ResolvedArtifact,
  ResolvedResource,
  RuntimeContext,
  RuntimeStakeObjectContext,
  SandboxDocument,
  SandboxOptions,
} from "./types.js";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function inlineModule(code: string): string {
  return code.replace(/<\/script/giu, "<\\/script");
}

function isTextResource(mediaType: string): boolean {
  const type = mediaType.toLowerCase().split(";", 1)[0] ?? mediaType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/javascript" ||
    type === "application/ecmascript" ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "image/svg+xml"
  );
}

interface Materializer {
  readonly warnings: string[];
  readonly cache: Map<string, string>;
  readonly artifact: ResolvedArtifact;
  readonly aliasMap: ReadonlyMap<string, string>;
}

function materializeResource(materializer: Materializer, id: string, active: ReadonlySet<string>): string | undefined {
  const cached = materializer.cache.get(id);
  if (cached !== undefined) return cached;
  const resource = materializer.artifact.resources.get(id);
  if (resource === undefined) {
    materializer.warnings.push(`Document references unresolved resource ${id}.`);
    return undefined;
  }
  if (active.has(id)) {
    materializer.warnings.push(`Cyclic verified-resource reference detected at ${id}.`);
    return undefined;
  }

  let bytes = resource.bytes;
  if (isTextResource(resource.mediaType)) {
    const next = new Set(active);
    next.add(id);
    const text = replaceResourceUrls(bytesToUtf8(bytes), materializer, next);
    bytes = new TextEncoder().encode(text);
  }
  const dataUrl = toDataUrl(resource.mediaType, bytes);
  materializer.cache.set(id, dataUrl);
  return dataUrl;
}

function replaceResourceUrls(input: string, materializer: Materializer, active: ReadonlySet<string>): string {
  let output = input;
  const aliases = [...materializer.aliasMap.keys()].sort((left, right) => right.length - left.length);
  for (const alias of aliases) {
    if (!output.includes(alias)) continue;
    const id = materializer.aliasMap.get(alias);
    if (id === undefined) continue;
    const materialized = materializeResource(materializer, id, active);
    if (materialized !== undefined) output = output.split(alias).join(materialized);
  }
  return output;
}

function entrypointText(materializer: Materializer): string {
  const id = materializer.artifact.entrypoint.resource.id;
  return replaceResourceUrls(bytesToUtf8(materializer.artifact.entrypoint.bytes), materializer, new Set([id]));
}

/**
 * Resolve the effective browser capabilities: the manifest's declared
 * capabilities, optionally clamped by a host ceiling. A capability survives only
 * if the manifest declares it AND (when a ceiling is present) the ceiling allows
 * it. The host can narrow, never widen — and it never touches the content
 * composition path (that runs through __KEEL__/__KEEL_CONTENT__/the gateway,
 * which are not browser capabilities), so dynamic on-chain builds are unaffected.
 */
function resolveCapabilities(
  artifact: ResolvedArtifact,
  ceiling: Readonly<Partial<Record<keyof RuntimeCapabilities, boolean>>> | undefined,
): RuntimeCapabilities {
  const declared = artifact.manifest.runtime.capabilities ?? {};
  if (!ceiling) return declared;
  const keys: (keyof RuntimeCapabilities)[] = [
    "downloads",
    "pointerLock",
    "fullscreen",
    "clipboardWrite",
    "gamepad",
    "audioAutoplay",
    "webAssembly",
  ];
  const clamped: Record<string, boolean> = {};
  for (const key of keys) clamped[key] = declared[key] === true && ceiling[key] === true;
  return clamped as RuntimeCapabilities;
}

function capabilitiesToSandbox(capabilities: RuntimeCapabilities): readonly string[] {
  const tokens = ["allow-scripts"];
  if (capabilities.downloads === true) tokens.push("allow-downloads");
  if (capabilities.pointerLock === true) tokens.push("allow-pointer-lock");
  return tokens;
}

function capabilitiesToAllow(capabilities: RuntimeCapabilities): string {
  const values: string[] = [];
  if (capabilities.fullscreen === true) values.push("fullscreen");
  if (capabilities.gamepad === true) values.push("gamepad");
  if (capabilities.clipboardWrite === true) values.push("clipboard-write");
  if (capabilities.audioAutoplay === true) values.push("autoplay");
  return values.join("; ");
}

/** Creator content gets no raw network directive at all. */
function contentSecurityPolicy(capabilities: RuntimeCapabilities): string {
  const wasm = capabilities.webAssembly === true ? " 'wasm-unsafe-eval'" : "";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "manifest-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    `script-src 'unsafe-inline' data: blob:${wasm}`,
    "style-src 'unsafe-inline' data: blob:",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data: blob:",
  ].join("; ");
}

function validateStakeRuntimeContext(value: RuntimeStakeObjectContext): RuntimeStakeObjectContext {
  const decimal = /^(?:0|[1-9][0-9]*)$/u;
  const bytes32 = /^0x[0-9a-f]{64}$/u;
  if (value.protocol !== "keel-stake-context@1") throw new TypeError("Unsupported stake runtime context protocol.");
  if (value.chain !== "ethereum" && value.chain !== "tezos") throw new TypeError("Invalid stake runtime chain.");
  if (typeof value.manager !== "string" || value.manager.length === 0) throw new TypeError("Stake manager is required.");
  for (const [name, candidate] of [["stakeObjectId", value.stakeObjectId], ["viewerId", value.viewerId], ["runtimeDigest", value.runtimeDigest], ["codeObjectId", value.codeObjectId], ["runtimeSeed", value.runtimeSeed], ["argumentsDigest", value.argumentsDigest], ["variablesDigest", value.variablesDigest]] as const) {
    if (candidate !== undefined && !bytes32.test(candidate)) throw new TypeError(`Stake ${name} must be canonical bytes32.`);
  }
  for (const [name, candidate] of [["hostTokenId", value.hostTokenId], ["stakedTokenId", value.stakedTokenId], ["activeTokenId", value.activeTokenId], ["startedAt", value.startedAt]] as const) {
    const symbolic = candidate === "$anchor.tokenId" || candidate === "$staked.tokenId";
    if (candidate !== undefined && !symbolic && (!decimal.test(candidate) || candidate.length > 78 || BigInt(candidate) > (1n << 256n) - 1n)) {
      throw new TypeError(`Stake ${name} must be a canonical uint256 decimal string.`);
    }
  }
  if (!Number.isSafeInteger(value.slot) || value.slot < 0) throw new RangeError("Stake slot exceeds safe client limits.");
  if (value.codeObjectRevision !== undefined && (!Number.isSafeInteger(value.codeObjectRevision) || value.codeObjectRevision < 1)) throw new RangeError("Stake code object revision is invalid.");
  if (typeof value.active !== "boolean" || typeof value.managerVerified !== "boolean") throw new TypeError("Stake verification state is invalid.");
  if (value.requireStaked !== true || typeof value.hostCollection !== "string" || value.hostCollection.length === 0 || typeof value.stakedEntrypoint !== "string" || value.stakedEntrypoint.length === 0) {
    throw new TypeError("Stake host and entrypoint bindings are incomplete.");
  }
  for (const [name, candidate] of Object.entries(value.counters)) {
    if (!Number.isSafeInteger(candidate) || candidate < 0) throw new RangeError(`Stake ${name} counter exceeds safe client limits.`);
  }
  if (value.lockup.mode === "minimum-duration" && (!Number.isSafeInteger(value.lockup.seconds) || value.lockup.seconds <= 0)) {
    throw new RangeError("Stake minimum lockup is invalid.");
  }
  if (value.managerPolicy.mode === "verified-custom") {
    if (value.managerPolicy.adapterId.length === 0 || !bytes32.test(value.managerPolicy.immutableCodeHash) || !bytes32.test(value.managerPolicy.evidenceDigest) || !bytes32.test(value.managerPolicy.reviewReceipt) || !bytes32.test(value.managerPolicy.feeReceipt)) {
      throw new TypeError("Custom stake manager proof is incomplete.");
    }
  }
  if (value.managerProof !== undefined && (!bytes32.test(value.managerProof.codeHash) || value.managerProof.immutable !== true || value.managerProof.manager.toLowerCase() !== value.manager.toLowerCase())) {
    throw new TypeError("Stake manager proof is invalid.");
  }
  if (!Array.isArray(value.gatedResourceIds) || value.gatedResourceIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Stake gated resource IDs are invalid.");
  }
  return value;
}

function validateRuntimeContext(context: RuntimeContext): RuntimeContext {
  if (context.protocol !== "keel-context@1") throw new TypeError("Unsupported runtime context protocol.");
  if (context.chainId !== undefined && (!Number.isSafeInteger(context.chainId) || context.chainId <= 0)) {
    throw new RangeError("Invalid runtime chain ID.");
  }
  const decimal = /^(?:0|[1-9][0-9]*)$/u;
  const bytes32 = /^0x[0-9a-f]{64}$/u;
  for (const value of [context.blockNumber, context.blockTimestamp, context.tokenId]) {
    if (value !== undefined && !decimal.test(value)) {
      throw new TypeError("Runtime context uint values must be canonical decimal strings.");
    }
  }
  if (context.tokenId !== undefined && (context.tokenId.length > 78 || BigInt(context.tokenId) > (1n << 256n) - 1n)) {
    throw new RangeError("Runtime token ID exceeds uint256.");
  }
  if (context.blockHash !== undefined && !bytes32.test(context.blockHash)) {
    throw new TypeError("Runtime block hash must be canonical bytes32.");
  }
  if (context.derivedTokenSeed !== undefined && !bytes32.test(context.derivedTokenSeed)) {
    throw new TypeError("Runtime token seed must be canonical bytes32.");
  }
  for (const [name, value] of Object.entries({
    packedAttributes: context.packedAttributes,
    portableRoot: context.portableRoot,
    portableManifestObjectId: context.portableManifestObjectId,
    portableDecodedObjectId: context.portableDecodedObjectId,
    portableAnchorRoot: context.portableAnchorRoot,
    assetFamilyId: context.assetFamilyId,
    assetId: context.assetId,
    spriteObjectId: context.spriteObjectId,
    targetMapObjectId: context.targetMapObjectId,
    effectProfileObjectId: context.effectProfileObjectId,
    soundProfileObjectId: context.soundProfileObjectId,
    emitterMaterialTargetId: context.emitterMaterialTargetId,
    mapCharacterSeed: context.mapCharacterSeed,
    mapSeed: context.mapSeed,
    mapPortableRoot: context.mapPortableRoot,
    mapPortableManifestObjectId: context.mapPortableManifestObjectId,
    mapPortableDecodedObjectId: context.mapPortableDecodedObjectId,
    mapPortableAnchorRoot: context.mapPortableAnchorRoot,
  })) if (value !== undefined && !bytes32.test(value)) throw new TypeError(`Runtime ${name} must be canonical bytes32.`);
  for (const [name, value] of Object.entries({
    catalogRevision: context.catalogRevision,
    assetFamilyRevision: context.assetFamilyRevision,
    emitterPresetId: context.emitterPresetId,
    emitterRevision: context.emitterRevision,
    emitterSpriteBundleId: context.emitterSpriteBundleId,
    emitterSpriteBundleRevision: context.emitterSpriteBundleRevision,
    emitterSpriteAssetId: context.emitterSpriteAssetId,
    emitterSpriteSelectionRevision: context.emitterSpriteSelectionRevision,
    fxCatalogRevision: context.fxCatalogRevision,
    mapGenerationEpoch: context.mapGenerationEpoch,
    emitterSeedDomainVersion: context.emitterSeedDomainVersion,
    emitterPaletteMode: context.emitterPaletteMode,
    sceneId: context.sceneId,
    portableManifestObjectRevision: context.portableManifestObjectRevision,
    portableDecodedObjectRevision: context.portableDecodedObjectRevision,
    mapBuildRevision: context.mapBuildRevision,
    mapPortableManifestObjectRevision: context.mapPortableManifestObjectRevision,
    mapPortableDecodedObjectRevision: context.mapPortableDecodedObjectRevision,
  })) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`Runtime ${name} exceeds safe client limits.`);
  }
  for (const [name, value] of Object.entries({
    emitterPresetId: context.emitterPresetId,
    emitterRevision: context.emitterRevision,
    emitterSpriteBundleId: context.emitterSpriteBundleId,
    emitterSpriteBundleRevision: context.emitterSpriteBundleRevision,
    emitterSpriteAssetId: context.emitterSpriteAssetId,
    emitterSpriteSelectionRevision: context.emitterSpriteSelectionRevision,
    fxCatalogRevision: context.fxCatalogRevision,
    mapGenerationEpoch: context.mapGenerationEpoch,
  })) if (value !== undefined && value > 0xffff_ffff) {
    throw new RangeError(`Runtime ${name} exceeds emitter@1 uint32 limits.`);
  }
  if (context.emitterSeedDomainVersion !== undefined && context.emitterSeedDomainVersion !== 1) {
    throw new RangeError("Runtime emitter seed domain must be emitter@1.");
  }
  if (context.emitterPaletteMode !== undefined && context.emitterPaletteMode > 3) {
    throw new RangeError("Runtime emitter palette mode is outside emitter@1 bounds.");
  }
  if (context.collectionVerification !== undefined) {
    evaluateCollectionVerification(context.collectionVerification);
  }
  if (context.stakeObject !== undefined) validateStakeRuntimeContext(context.stakeObject);
  if (Object.keys(context).length === 1) throw new TypeError("Runtime context must expose at least one declared field.");
  return context;
}

function runtimeBootstrap(artifact: ResolvedArtifact, runtimeContext?: RuntimeContext): string {
  const runtime = {
    engine: artifact.manifest.runtime.engine,
    determinism: artifact.manifest.runtime.determinism,
    content: artifact.manifest.runtime.content,
    manifestId: artifact.manifest.id,
    manifestDigest: artifact.commitment?.integrity.digest,
    anchorVerified: artifact.commitment?.registry?.verified === true,
    revision: artifact.manifest.revision.number,
    ...(runtimeContext === undefined ? {} : { context: validateRuntimeContext(runtimeContext) }),
  };
  const serialized = scriptSafeJson(runtime);
  return `(()=>{"use strict";const runtime=${serialized};const freeze=value=>{if(value&&typeof value==="object"&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))freeze(item)}return value};const d=runtime.determinism;if(d.mode==="replay"){const hex=d.seed.slice(2);const state=[];for(let i=0;i<4;i++){state[i]=((Number.parseInt(hex.slice(i*8,i*8+8),16)^Number.parseInt(hex.slice((i+4)*8,(i+5)*8),16))>>>0)}if(state.every(value=>value===0))state[0]=0x9e3779b9;const rotl=(value,count)=>((value<<count)|(value>>>(32-count)))>>>0;const next=()=>{const result=Math.imul(rotl(Math.imul(state[1],5)>>>0,7),9)>>>0;const t=(state[1]<<9)>>>0;state[2]^=state[0];state[3]^=state[1];state[1]^=state[2];state[0]^=state[3];state[2]^=t;state[3]=rotl(state[3],11);return result};Math.random=()=>next()/4294967296;try{const deterministicValues=array=>{const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);for(let i=0;i<bytes.length;i++)bytes[i]=next()&255;return array};Object.defineProperty(crypto,"getRandomValues",{value:deterministicValues,configurable:false,writable:false});Object.defineProperty(crypto,"randomUUID",{value:()=>{const b=deterministicValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(v=>v.toString(16).padStart(2,"0")).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)},configurable:false,writable:false})}catch{}let frame=0;const frameDuration=d.clock.mode==="frame"?d.clock.frameDurationMs:0;const now=()=>d.clock.epochMs+(d.clock.mode==="frame"?frame*frameDuration:0);const NativeDate=Date;class KeelDate extends NativeDate{constructor(...args){super(...(args.length>0?args:[now()]))}static now(){return now()}}Object.defineProperty(globalThis,"Date",{value:KeelDate,configurable:false,writable:false});try{Object.defineProperty(globalThis,"devicePixelRatio",{value:d.viewport.devicePixelRatio,configurable:false})}catch{}try{Object.defineProperty(navigator,"language",{value:d.locale,configurable:false});Object.defineProperty(navigator,"languages",{value:[d.locale],configurable:false})}catch{}const nativeRaf=globalThis.requestAnimationFrame?.bind(globalThis);if(nativeRaf){Object.defineProperty(globalThis,"requestAnimationFrame",{value:callback=>nativeRaf(()=>{const timestamp=d.clock.mode==="frame"?frame*frameDuration:0;callback(timestamp);if(d.clock.mode==="frame")frame+=1}),configurable:false,writable:false})}try{Object.defineProperty(performance,"now",{value:()=>d.clock.mode==="frame"?frame*frameDuration:0,configurable:false})}catch{}const wrapIntl=(name,timezone)=>{const Native=Intl[name];if(typeof Native!=="function")return;const Wrapped=function(locales,options){const locale=locales??d.locale;const nextOptions=timezone?{timeZone:d.timezone,...(options??{})}:options;return new Native(locale,nextOptions)};Wrapped.prototype=Native.prototype;Object.setPrototypeOf(Wrapped,Native);try{Intl[name]=Wrapped}catch{}};wrapIntl("DateTimeFormat",true);for(const name of ["NumberFormat","Collator","PluralRules","RelativeTimeFormat","ListFormat","DisplayNames"])wrapIntl(name,false);document.documentElement.lang=d.locale}if(runtime.context)Object.defineProperty(globalThis,"__KEEL_CONTEXT__",{value:freeze(runtime.context),enumerable:true,configurable:false,writable:false});Object.defineProperty(globalThis,"__KEEL_RUNTIME__",{value:freeze(runtime),enumerable:true,configurable:false,writable:false})})();`;
}

function thumbnailBootstrap(artifact: ResolvedArtifact): string {
  const capture = artifact.manifest.thumbnail?.capture;
  const serialized = scriptSafeJson(capture ?? null);
  return `(()=>{"use strict";const policy=${serialized};const started=performance.now();let timer;let stopTimer;let initialized=false;const emit=(action,label)=>parent.postMessage({protocol:"keel-thumbnail-capture@1",action,label:String(label||policy?.label||"hero").slice(0,64),elapsedMs:Math.max(0,Math.round(performance.now()-started))},"*");const stop=label=>{clearTimeout(timer);clearTimeout(stopTimer);emit("stop",label)};const capture=label=>{emit("capture",label);if(policy?.durationMs)stopTimer=setTimeout(()=>stop(label),policy.durationMs)};const init=label=>{if(initialized)return;initialized=true;emit("init",label);if(policy?.mode==="after-init")timer=setTimeout(()=>capture(label),policy.delayMs||0)};const api=Object.freeze({protocol:"keel-thumbnail-capture@1",init,capture,ready:capture,stop,after:(delayMs,label)=>{const delay=Number(delayMs);if(!Number.isFinite(delay)||delay<0||delay>30000)throw new RangeError("Thumbnail delay must be from 0 through 30000ms.");clearTimeout(timer);timer=setTimeout(()=>capture(label),delay)}});Object.defineProperty(globalThis,"__KEEL_THUMBNAIL__",{value:api,enumerable:true,configurable:false,writable:false});for(const [name,action] of [["KEEL_THUMBNAIL_INIT",init],["KEEL_THUMBNAIL_STOP",stop]]){let value=false;Object.defineProperty(globalThis,name,{enumerable:true,configurable:false,get:()=>value,set:next=>{value=Boolean(next);if(value)action()}})}if(policy?.mode==="time")addEventListener("DOMContentLoaded",()=>{timer=setTimeout(()=>capture(),policy.delayMs||0)},{once:true})})();`;
}

interface GatewayPayloadResource {
  readonly body: string;
  readonly mediaType: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly role: string;
  readonly originalName?: string;
  readonly description?: string;
  readonly sources: readonly Record<string, unknown>[];
}

interface GatewayPayload {
  readonly protocol: "keel-content-gateway@1";
  readonly manifestId: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, GatewayPayloadResource>>;
}

function sourceMetadata(source: ResourceSource): Record<string, unknown> {
  const integrity = {
    algorithm: source.integrity.algorithm,
    digest: source.integrity.digest,
    ...(source.integrity.byteLength === undefined ? {} : { byteLength: source.integrity.byteLength }),
  };
  if (source.kind === "onchain") {
    return { kind: source.kind, chainId: source.chainId, store: source.store, objectId: source.objectId, integrity };
  }
  if (source.kind === "uri") {
    return {
      kind: source.kind,
      uri: source.uri,
      ...(source.immutable === undefined ? {} : { immutable: source.immutable }),
      integrity,
    };
  }
  if (source.kind === "contract-call") {
    return { kind: source.kind, chainId: source.chainId, to: source.to, data: source.data, decode: source.decode, integrity };
  }
  if (source.kind === "composite") {
    return { kind: source.kind, parts: source.parts, ...(source.separator === undefined ? {} : { separator: source.separator }), integrity };
  }
  return { kind: source.kind, integrity };
}

function gatewayPayload(artifact: ResolvedArtifact): GatewayPayload {
  const gateway = createVerifiedContentGateway(artifact);
  const aliases: Record<string, string> = {};
  const resources: Record<string, GatewayPayloadResource> = {};
  for (const route of gateway.routes) {
    const resource = artifact.resources.get(route.resourceId);
    if (resource === undefined) throw new Error(`Resolved resource ${route.resourceId} disappeared during gateway creation.`);
    resources[route.resourceId] = {
      body: encodeBase64(resource.bytes),
      mediaType: resource.mediaType,
      digest: route.integrity.digest,
      byteLength: resource.bytes.byteLength,
      role: resource.resource.role,
      ...(resource.resource.originalName === undefined ? {} : { originalName: resource.resource.originalName }),
      ...(resource.resource.description === undefined ? {} : { description: resource.resource.description }),
      sources: resource.resource.sources.map(sourceMetadata),
    };
    for (const alias of route.aliases) aliases[alias] = route.resourceId;
    // __KEEL_CONTENT__ is an ID-addressed reader API. Keep the raw resource ID
    // local to the runtime lookup table; it must not enter the URL alias list
    // used by static text materialization or string literals would be rewritten
    // into data URLs before reader code can request them by ID.
    aliases[route.resourceId] = route.resourceId;
  }
  return { protocol: "keel-content-gateway@1", manifestId: artifact.manifest.id, aliases, resources };
}

function contentGatewayBootstrap(artifact: ResolvedArtifact): string {
  const payload = scriptSafeJson(gatewayPayload(artifact));
  return `(() => {
  "use strict";
  const payload = ${payload};
  const aliases = Object.freeze(payload.aliases);
  const resources = Object.freeze(payload.resources);
  const blocked = value => new DOMException("Keel blocked undeclared content request: " + String(value), "SecurityError");
  const rawName = input => {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return String(input);
  };
  const normalize = value => {
    const raw = rawName(value);
    if (Object.hasOwn(aliases, raw)) return raw;
    if (raw.startsWith("keel://") || raw.startsWith("/")) return raw;
    try {
      const parsed = new URL(raw, "https://keel.invalid/");
      if (parsed.origin === "https://keel.invalid") return parsed.pathname + parsed.search + parsed.hash;
      return parsed.href;
    } catch {
      return raw;
    }
  };
  const lookup = input => {
    const name = normalize(input);
    const id = aliases[name];
    return id === undefined ? undefined : { name, id, resource: resources[id] };
  };
  const decode = value => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const dataUrl = resource => "data:" + resource.mediaType + ";base64," + resource.body;
  // Text resources have their /content/ references rewritten to data: URLs
  // before they run, so a script that fetches a declared resource at runtime
  // sees the rewritten form. Decode it here rather than reaching the network:
  // connect-src is 'none', and the bytes are already the verified ones.
  const dataResponse = raw => {
    const comma = raw.indexOf(",");
    if (comma < 0) return undefined;
    const meta = raw.slice(5, comma);
    const base64 = /;base64$/i.test(meta);
    const mediaType = (base64 ? meta.slice(0, -7) : meta) || "text/plain;charset=US-ASCII";
    try {
      const body = raw.slice(comma + 1);
      const bytes = base64 ? decode(body) : new TextEncoder().encode(decodeURIComponent(body));
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": mediaType,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "X-Keel-Inline": "data-url",
        },
      });
    } catch {
      return undefined;
    }
  };
  const safeUrl = value => {
    const raw = String(value);
    if (raw === "" || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
    const found = lookup(raw);
    return found === undefined ? undefined : dataUrl(found.resource);
  };
  const verifiedFetch = async (input, init) => {
    const inputMethod = input && typeof input === "object" && "method" in input ? input.method : undefined;
    const method = String(init?.method ?? inputMethod ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { "Allow": "GET, HEAD", "X-Keel-Blocked": "method" },
      });
    }
    const requested = rawName(input);
    if (requested.startsWith("data:")) {
      const inline = dataResponse(requested);
      if (inline !== undefined) return inline;
    }
    const found = lookup(input);
    if (found === undefined) {
      return new Response("Undeclared Keel resource", {
        status: 403,
        headers: { "X-Keel-Blocked": "undeclared-resource", "Cache-Control": "no-store" },
      });
    }
    const headers = {
      "Content-Type": found.resource.mediaType,
      "Content-Length": String(found.resource.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Keel-Verified": found.resource.digest,
      "X-Keel-Resource": found.id,
    };
    return new Response(method === "HEAD" ? null : decode(found.resource.body), { status: 200, headers });
  };
  Object.defineProperty(globalThis, "fetch", { value: verifiedFetch, configurable: false, writable: false });

  if (globalThis.XMLHttpRequest) {
    const nativeOpen = XMLHttpRequest.prototype.open;
    Object.defineProperty(XMLHttpRequest.prototype, "open", {
      value: function(method, url, ...rest) {
        const found = lookup(url);
        if (found === undefined) throw blocked(url);
        const verb = String(method).toUpperCase();
        if (verb !== "GET" && verb !== "HEAD") throw blocked(method);
        return nativeOpen.call(this, method, dataUrl(found.resource), ...rest);
      },
      configurable: false,
      writable: false,
    });
  }

  const denyConstructor = name => {
    const denied = function() { throw blocked(name); };
    try {
      Object.defineProperty(globalThis, name, { value: denied, configurable: false, writable: false });
    } catch {}
  };
  for (const name of [
    "WebSocket",
    "EventSource",
    "Worker",
    "SharedWorker",
    "WebTransport",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "PresentationRequest",
  ]) denyConstructor(name);
  try {
    Object.defineProperty(navigator, "sendBeacon", { value: () => false, configurable: false, writable: false });
  } catch {}
  try {
    Object.defineProperty(navigator, "share", { value: async () => { throw blocked("navigator.share"); }, configurable: false, writable: false });
  } catch {}
  try {
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        value: async value => { throw blocked(value ?? "serviceWorker.register"); },
        configurable: false,
        writable: false,
      });
    }
  } catch {}
  try {
    Object.defineProperty(globalThis, "open", { value: () => null, configurable: false, writable: false });
  } catch {}
  try {
    const blockNavigation = event => {
      if (typeof event.preventDefault === "function") event.preventDefault();
    };
    globalThis.navigation?.addEventListener("navigate", blockNavigation);
  } catch {}
  try {
    const locationPrototype = globalThis.Location?.prototype;
    for (const method of ["assign", "replace", "reload"]) {
      if (!locationPrototype) continue;
      Object.defineProperty(locationPrototype, method, {
        value: value => { throw blocked(value ?? method); },
        configurable: false,
        writable: false,
      });
    }
  } catch {}

  const urlAttributes = new Set(["src", "srcset", "href", "ping", "poster", "data", "action", "formaction"]);
  const nativeSetAttribute = Element.prototype.setAttribute;
  Object.defineProperty(Element.prototype, "setAttribute", {
    value: function(name, value) {
      const normalizedName = String(name).toLowerCase();
      if (urlAttributes.has(normalizedName)) {
        const safe = safeUrl(value);
        if (safe === undefined) throw blocked(value);
        return nativeSetAttribute.call(this, name, safe);
      }
      return nativeSetAttribute.call(this, name, value);
    },
    configurable: false,
    writable: false,
  });

  const patchUrlProperty = (prototype, property) => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.get || !descriptor?.set) return;
    try {
      Object.defineProperty(prototype, property, {
        get: descriptor.get,
        set(value) {
          const safe = safeUrl(value);
          if (safe === undefined) throw blocked(value);
          return descriptor.set.call(this, safe);
        },
        configurable: false,
        enumerable: descriptor.enumerable,
      });
    } catch {}
  };
  patchUrlProperty(globalThis.HTMLImageElement?.prototype, "src");
  patchUrlProperty(globalThis.HTMLImageElement?.prototype, "srcset");
  patchUrlProperty(globalThis.HTMLScriptElement?.prototype, "src");
  patchUrlProperty(globalThis.HTMLLinkElement?.prototype, "href");
  patchUrlProperty(globalThis.HTMLSourceElement?.prototype, "src");
  patchUrlProperty(globalThis.HTMLSourceElement?.prototype, "srcset");
  patchUrlProperty(globalThis.HTMLMediaElement?.prototype, "src");
  patchUrlProperty(globalThis.HTMLVideoElement?.prototype, "poster");
  patchUrlProperty(globalThis.HTMLTrackElement?.prototype, "src");
  patchUrlProperty(globalThis.HTMLAnchorElement?.prototype, "href");
  patchUrlProperty(globalThis.HTMLAnchorElement?.prototype, "ping");
  patchUrlProperty(globalThis.HTMLAreaElement?.prototype, "href");
  patchUrlProperty(globalThis.HTMLAreaElement?.prototype, "ping");
  patchUrlProperty(globalThis.HTMLFormElement?.prototype, "action");
  patchUrlProperty(globalThis.HTMLInputElement?.prototype, "formAction");
  patchUrlProperty(globalThis.HTMLButtonElement?.prototype, "formAction");

  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target) return;
    const href = target.getAttribute("href") ?? "";
    const sameDocument = href === "" || href.startsWith("#");
    const download = target.hasAttribute("download");
    const safe = safeUrl(href);
    // Ordinary anchor navigation is never required by the artifact protocol.
    // Same-document fragments and explicit verified downloads are the only
    // anchor behaviors retained inside the frame.
    if ((!sameDocument && !download) || safe === undefined) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (safe !== href) nativeSetAttribute.call(target, "href", safe);
  }, true);
  document.addEventListener("submit", event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  try {
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      value: () => { throw blocked("form.submit"); },
      configurable: false,
      writable: false,
    });
    Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", {
      value: () => { throw blocked("form.requestSubmit"); },
      configurable: false,
      writable: false,
    });
  } catch {}

  const api = Object.freeze({
    protocol: payload.protocol,
    manifestId: payload.manifestId,
    resolve: name => lookup(name)?.id,
    url: name => {
      const found = lookup(name);
      if (found === undefined) throw blocked(name);
      return dataUrl(found.resource);
    },
    bytes: name => {
      const found = lookup(name);
      if (found === undefined) throw blocked(name);
      return decode(found.resource.body).slice();
    },
    text: name => new TextDecoder().decode(api.bytes(name)),
    json: name => JSON.parse(api.text(name)),
    integrity: name => lookup(name)?.resource.digest,
    paths: Object.freeze(Object.keys(aliases)),
    describe: name => {
      const found = lookup(name);
      if (found === undefined) return undefined;
      const resource = found.resource;
      return Object.freeze({
        id: found.id,
        role: resource.role,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength,
        digest: resource.digest,
        ...(resource.originalName === undefined ? {} : { originalName: resource.originalName }),
        ...(resource.description === undefined ? {} : { description: resource.description }),
        sources: Object.freeze((resource.sources ?? []).map(source => Object.freeze({ ...source }))),
        aliases: Object.freeze(Object.entries(aliases).filter(([, id]) => id === found.id).map(([alias]) => alias)),
      });
    },
    resources: () => Object.freeze(Object.entries(resources).map(([id, resource]) => Object.freeze({
      id,
      role: resource.role,
      mediaType: resource.mediaType,
      byteLength: resource.byteLength,
      digest: resource.digest,
      ...(resource.originalName === undefined ? {} : { originalName: resource.originalName }),
      ...(resource.description === undefined ? {} : { description: resource.description }),
      sources: Object.freeze((resource.sources ?? []).map(source => Object.freeze({ ...source }))),
    }))),
  });
  Object.defineProperty(globalThis, "__KEEL_CONTENT__", {
    value: api,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  const hex = bytes => "0x" + [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  const candidateBytes = async value => {
    if (value instanceof Uint8Array) return value.slice();
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    throw new TypeError("Keel verification accepts Uint8Array, ArrayBuffer, or Blob bytes.");
  };
  const keel = Object.freeze({
    protocol: "keel-marketplace-api@1",
    manifestId: payload.manifestId,
    resolve: api.resolve,
    read: api.bytes,
    bytes: api.bytes,
    text: api.text,
    json: api.json,
    url: api.url,
    integrity: api.integrity,
    describe: api.describe,
    resources: api.resources,
    verify: async (name, candidate) => {
      const expected = api.integrity(name);
      if (expected === undefined) throw blocked(name);
      const input = await candidateBytes(candidate);
      const actual = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
      return Object.freeze({
        protocol: "keel-marketplace-api@1",
        resourceId: api.resolve(name),
        expected,
        actual,
        byteLength: input.byteLength,
        verified: actual === expected,
      });
    },
  });
  Object.defineProperty(globalThis, "__KEEL__", {
    value: keel,
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();`;
}
function headPayload(artifact: ResolvedArtifact, csp: string, runtimeContext?: RuntimeContext, consumer = false): string {
  const consumerChrome = consumer
    ? `<style>html[data-oca-consumer="true"] button,html[data-oca-consumer="true"] input,html[data-oca-consumer="true"] select,html[data-oca-consumer="true"] textarea,html[data-oca-consumer="true"] [role="button"]{display:none!important;pointer-events:none!important}</style>`
    : "";
  const verificationChrome = `(() => {
    ${consumer ? 'document.documentElement.dataset.ocaConsumer = "true";' : ""}
    const apply = (value) => {
      if (value !== "internal" && value !== "external") return;
      document.documentElement.dataset.verificationChrome = value;
    };
    addEventListener("message", (event) => {
      const command = event.data;
      if (command?.protocol === "keel-viewer-verification@1" && command.action === "set-chrome") apply(command.chrome);
    });
  })();`;
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><meta name="referrer" content="no-referrer">${consumerChrome}<script>${verificationChrome}</script><script>${runtimeBootstrap(artifact, runtimeContext)}</script><script>${thumbnailBootstrap(artifact)}</script><script>${contentGatewayBootstrap(artifact)}</script>`;
}

function documentShell(body: string, artifact: ResolvedArtifact, csp: string, runtimeContext?: RuntimeContext, consumer = false): string {
  const background = artifact.manifest.fallback.backgroundColor ?? "transparent";
  const replay = artifact.manifest.runtime.determinism.mode === "replay";
  const viewport = replay ? artifact.manifest.runtime.determinism.viewport : undefined;
  const dimensions = viewport === undefined ? "width:100%;height:100%" : `width:${viewport.width}px;height:${viewport.height}px`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${headPayload(artifact, csp, runtimeContext, consumer)}<style>html,body{margin:0;${dimensions};overflow:hidden;background:${escapeAttribute(background)}}*{box-sizing:border-box}</style></head><body>${body}</body></html>`;
}

function removeNavigationPrimitives(html: string, warnings: string[]): string {
  let output = html;
  const strippedBase = output.replace(/<base\b[^>]*>/giu, "");
  if (strippedBase !== output) warnings.push("Removed <base> element; base URI changes are forbidden in the verified sandbox.");
  output = strippedBase;
  const strippedRefresh = output.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/giu, "");
  if (strippedRefresh !== output) warnings.push("Removed meta refresh navigation from creator HTML.");
  return strippedRefresh;
}

function injectIntoDocument(
  html: string,
  artifact: ResolvedArtifact,
  csp: string,
  warnings: string[],
  runtimeContext?: RuntimeContext,
  consumer = false,
): string {
  const safeHtml = removeNavigationPrimitives(html, warnings);
  const payload = headPayload(artifact, csp, runtimeContext, consumer);
  if (/<head[\s>]/iu.test(safeHtml)) return safeHtml.replace(/<head([^>]*)>/iu, `<head$1>${payload}`);
  if (/<html[\s>]/iu.test(safeHtml)) return safeHtml.replace(/<html([^>]*)>/iu, `<html$1><head>${payload}</head>`);
  return documentShell(safeHtml.replace(/<!doctype[^>]*>/iu, ""), artifact, csp, runtimeContext, consumer);
}

function aliasMap(artifact: ResolvedArtifact): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const resource of artifact.resources.values()) {
    for (const alias of resourceGatewayAliases(artifact, resource)) {
      const existing = aliases.get(alias);
      if (existing !== undefined && existing !== resource.resource.id) {
        throw new Error(`Virtual route collision at ${alias}.`);
      }
      aliases.set(alias, resource.resource.id);
    }
  }
  return aliases;
}

function mediaDataUrl(resource: ResolvedResource): string {
  return toDataUrl(resource.mediaType, resource.bytes);
}

export function createSandboxDocument(artifact: ResolvedArtifact, options: SandboxOptions = {}): SandboxDocument {
  const warnings: string[] = [];
  const gateway = createVerifiedContentGateway(artifact);
  const materializer: Materializer = { artifact, warnings, cache: new Map(), aliasMap: aliasMap(artifact) };
  const mode = artifact.manifest.entrypoint.mode;
  const entry = artifact.entrypoint;
  const capabilities = resolveCapabilities(artifact, options.capabilityCeiling);
  const csp = contentSecurityPolicy(capabilities);
  let body: string;

  if (artifact.manifest.runtime.sandbox === "isolated-origin") {
    warnings.push(
      "The generated srcdoc still uses a unique opaque origin. A dedicated viewer origin may host it, but creator code receives no same-origin or raw-network privilege.",
    );
  }
  if (artifact.manifest.runtime.determinism.mode === "live") {
    warnings.push("This manifest explicitly uses live browser state; captures are not guaranteed to reproduce exactly.");
  }
  if (artifact.commitment === undefined) {
    warnings.push("Manifest commitment was not supplied; only use this path for local development.");
  }

  if (mode === "html") {
    const html = entrypointText(materializer);
    const document = /<!doctype|<html[\s>]/iu.test(html)
      ? injectIntoDocument(html, artifact, csp, warnings, options.runtimeContext, options.consumer === true)
      : documentShell(removeNavigationPrimitives(html, warnings), artifact, csp, options.runtimeContext, options.consumer === true);
    return {
      html: document,
      sandboxTokens: capabilitiesToSandbox(capabilities),
      allow: capabilitiesToAllow(capabilities),
      csp,
      warnings,
      routeCount: gateway.routes.length,
      ...(artifact.manifest.runtime.determinism.mode === "replay"
        ? { viewport: artifact.manifest.runtime.determinism.viewport }
        : {}),
    };
  }

  switch (mode) {
    case "module": {
      const code = entrypointText(materializer);
      body = `<div id="${escapeAttribute(artifact.manifest.entrypoint.mount ?? "oca-root")}" style="width:100%;height:100%"></div><script type="module">${inlineModule(code)}</script>`;
      break;
    }
    case "svg":
    case "image": {
      const source = materializeResource(materializer, entry.resource.id, new Set()) ?? mediaDataUrl(entry);
      body = `<img alt="${escapeAttribute(artifact.manifest.name)}" src="${source}" style="display:block;width:100%;height:100%;object-fit:contain">`;
      break;
    }
    case "video": {
      const source = mediaDataUrl(entry);
      body = `<video controls playsinline src="${source}" style="display:block;width:100%;height:100%;object-fit:contain"></video>`;
      break;
    }
    case "audio": {
      const source = mediaDataUrl(entry);
      body = `<main style="display:grid;place-items:center;width:100%;height:100%"><audio controls src="${source}"></audio></main>`;
      break;
    }
    case "model": {
      const source = mediaDataUrl(entry);
      body = `<main style="display:grid;place-items:center;width:100%;height:100%;font:14px system-ui"><a download="artifact" href="${source}">Download 3D model</a></main>`;
      warnings.push("No built-in 3D engine is injected. Use an HTML/module entrypoint for interactive model rendering.");
      break;
    }
  }

  return {
    html: documentShell(body, artifact, csp, options.runtimeContext, options.consumer === true),
    sandboxTokens: capabilitiesToSandbox(capabilities),
    allow: capabilitiesToAllow(capabilities),
    csp,
    warnings,
    routeCount: gateway.routes.length,
    ...(artifact.manifest.runtime.determinism.mode === "replay"
      ? { viewport: artifact.manifest.runtime.determinism.viewport }
      : {}),
  };
}
