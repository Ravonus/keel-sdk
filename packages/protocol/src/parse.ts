import { assertValidManifest } from "./validate.js";
import { assertValidKeelMediaDerivative, type KeelMediaDerivative } from "./keel-hold.js";
import { assertValidKeelStakeObject, type KeelStakeObject } from "./stake-object.js";
import {
  assertValidKeelCommunityReplicationPreference,
  KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY,
} from "./community-replication.js";
import {
  assertValidKeelIPControlExtension,
  KEEL_IP_CONTROL_EXTENSION_KEY,
} from "./keel-ip-control.js";
import { normalizeKeelAttributions, type KeelAttribution } from "./keel-attribution.js";
import type { ArtifactManifest } from "./types.js";

interface JsonObject {
  readonly [key: string]: unknown;
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be a finite number.`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean.`);
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) string(value, path);
}

function optionalNumber(value: unknown, path: string): void {
  if (value !== undefined) number(value, path);
}

function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined) boolean(value, path);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const resolved = string(value, path);
  if (!(allowed as readonly string[]).includes(resolved)) throw new TypeError(`${path} has an unsupported value.`);
  return resolved as T;
}

function integrity(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.algorithm, ["sha256", "keccak256", "none"], `${path}.algorithm`);
  string(data.digest, `${path}.digest`);
  optionalNumber(data.byteLength, `${path}.byteLength`);
}

function optionalIntegrity(value: unknown, path: string): void {
  if (value !== undefined) integrity(value, path);
}

function source(value: unknown, path: string): void {
  const data = object(value, path);
  const kind = oneOf(data.kind, ["inline", "uri", "onchain", "contract-call", "composite"], `${path}.kind`);
  if (data.compression !== undefined) {
    oneOf(data.compression, ["none", "gzip", "deflate", "brotli"], `${path}.compression`);
  }

  switch (kind) {
    case "inline":
      string(data.data, `${path}.data`);
      oneOf(data.encoding, ["utf8", "base64", "base64url"], `${path}.encoding`);
      integrity(data.integrity, `${path}.integrity`);
      return;
    case "uri":
      string(data.uri, `${path}.uri`);
      if (data.gateways !== undefined) {
        array(data.gateways, `${path}.gateways`).forEach((entry, index) => string(entry, `${path}.gateways[${index}]`));
      }
      integrity(data.integrity, `${path}.integrity`);
      optionalBoolean(data.immutable, `${path}.immutable`);
      return;
    case "onchain":
      number(data.chainId, `${path}.chainId`);
      string(data.store, `${path}.store`);
      string(data.objectId, `${path}.objectId`);
      if (data.chunks !== undefined) {
        array(data.chunks, `${path}.chunks`).forEach((entry, index) => string(entry, `${path}.chunks[${index}]`));
      }
      integrity(data.integrity, `${path}.integrity`);
      return;
    case "contract-call":
      number(data.chainId, `${path}.chainId`);
      string(data.to, `${path}.to`);
      string(data.data, `${path}.data`);
      oneOf(data.decode, ["bytes", "string", "base64"], `${path}.decode`);
      integrity(data.integrity, `${path}.integrity`);
      return;
    case "composite":
      array(data.parts, `${path}.parts`).forEach((entry, index) => string(entry, `${path}.parts[${index}]`));
      optionalString(data.separator, `${path}.separator`);
      integrity(data.integrity, `${path}.integrity`);
  }
}

function resource(value: unknown, path: string): void {
  const data = object(value, path);
  string(data.id, `${path}.id`);
  oneOf(
    data.role,
    [
      "entrypoint",
      "fallback",
      "preview",
      "original",
      "script",
      "style",
      "font",
      "image",
      "audio",
      "video",
      "model",
      "shader",
      "data",
      "library",
      "other",
    ],
    `${path}.role`,
  );
  string(data.mediaType, `${path}.mediaType`);
  optionalBoolean(data.executable, `${path}.executable`);
  optionalString(data.originalName, `${path}.originalName`);
  optionalString(data.description, `${path}.description`);
  if (data.aliases !== undefined) {
    array(data.aliases, `${path}.aliases`).forEach((entry, index) => string(entry, `${path}.aliases[${index}]`));
  }
  array(data.sources, `${path}.sources`).forEach((entry, index) => source(entry, `${path}.sources[${index}]`));
  if (data.extensions !== undefined) object(data.extensions, `${path}.extensions`);
}

function keelGraphAnchor(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-graph-registry@1"], `${path}.protocol`);
  number(data.chainId, `${path}.chainId`);
  string(data.registry, `${path}.registry`);
  string(data.graphId, `${path}.graphId`);
  number(data.version, `${path}.version`);
  oneOf(data.storageTier, ["remote-pinned", "content-addressed", "onchain"], `${path}.storageTier`);
}

function keelTrustBinding(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-plugin-registry@1"], `${path}.protocol`);
  number(data.chainId, `${path}.chainId`);
  string(data.registry, `${path}.registry`);
  string(data.specDigest, `${path}.specDigest`);
  oneOf(data.requiredStatus, ["sanctioned"], `${path}.requiredStatus`);
}

function keelPinnedResource(value: unknown, path: string): void {
  const data = object(value, path);
  string(data.resource, `${path}.resource`);
  integrity(data.integrity, `${path}.integrity`);
}

function keelPluginBindings(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-plugin-bindings@1"], `${path}.protocol`);
  array(data.plugins, `${path}.plugins`).forEach((entry, index) => {
    const pluginPath = `${path}.plugins[${index}]`;
    const plugin = object(entry, pluginPath);
    string(plugin.id, `${pluginPath}.id`);
    string(plugin.manifestResource, `${pluginPath}.manifestResource`);
    integrity(plugin.manifestIntegrity, `${pluginPath}.manifestIntegrity`);
    keelGraphAnchor(plugin.graph, `${pluginPath}.graph`);
    keelTrustBinding(plugin.trust, `${pluginPath}.trust`);
  });
}

function keelLibraryBindings(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-library-bindings@1"], `${path}.protocol`);
  array(data.assets, `${path}.assets`).forEach((entry, index) => {
    const assetPath = `${path}.assets[${index}]`;
    const asset = object(entry, assetPath);
    string(asset.id, `${assetPath}.id`);
    string(asset.resource, `${assetPath}.resource`);
    integrity(asset.resourceIntegrity, `${assetPath}.resourceIntegrity`);
    number(asset.chainId, `${assetPath}.chainId`);
    string(asset.registry, `${assetPath}.registry`);
    string(asset.assetId, `${assetPath}.assetId`);
    number(asset.policyVersion, `${assetPath}.policyVersion`);
    string(asset.policyCommitment, `${assetPath}.policyCommitment`);
    keelGraphAnchor(asset.graph, `${assetPath}.graph`);
    string(asset.manifestDigest, `${assetPath}.manifestDigest`);
    string(asset.resourceGraphDigest, `${assetPath}.resourceGraphDigest`);
    const updates = object(asset.updates, `${assetPath}.updates`);
    oneOf(updates.mode, ["locked", "manual", "auto-compatible"], `${assetPath}.updates.mode`);
    if (updates.compatibleGraphVersions !== undefined) {
      const compatibility = object(
        updates.compatibleGraphVersions,
        `${assetPath}.updates.compatibleGraphVersions`,
      );
      number(compatibility.min, `${assetPath}.updates.compatibleGraphVersions.min`);
      number(compatibility.max, `${assetPath}.updates.compatibleGraphVersions.max`);
    }
  });
}

function keelProjectStack(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-project-stack@1"], `${path}.protocol`);
  array(data.components, `${path}.components`).forEach((entry, index) => {
    const componentPath = `${path}.components[${index}]`;
    const component = object(entry, componentPath);
    string(component.id, `${componentPath}.id`);
    string(component.label, `${componentPath}.label`);
    oneOf(
      component.role,
      [
        "entrypoint",
        "renderer",
        "runtime",
        "script",
        "module",
        "style",
        "shader",
        "sprite-atlas",
        "sprite-loader",
        "audio-engine",
        "wallet-runtime",
        "audio",
        "image",
        "font",
        "model",
        "data",
        "plugin",
        "library",
        "other",
      ],
      `${componentPath}.role`,
    );
    number(component.order, `${componentPath}.order`);
    string(component.resource, `${componentPath}.resource`);
    integrity(component.resourceIntegrity, `${componentPath}.resourceIntegrity`);
    optionalString(component.library, `${componentPath}.library`);
    if (component.labelOrigin !== undefined) {
      oneOf(component.labelOrigin, ["creator", "library-default"], `${componentPath}.labelOrigin`);
    }
    oneOf(
      component.format,
      ["asset", "classic-script", "es-module", "commonjs", "umd", "wasm"],
      `${componentPath}.format`,
    );
    const updates = object(component.updates, `${componentPath}.updates`);
    oneOf(updates.mode, ["locked", "manual", "auto-compatible"], `${componentPath}.updates.mode`);
    if (updates.compatibleGraphVersions !== undefined) {
      const compatibility = object(
        updates.compatibleGraphVersions,
        `${componentPath}.updates.compatibleGraphVersions`,
      );
      number(compatibility.min, `${componentPath}.updates.compatibleGraphVersions.min`);
      number(compatibility.max, `${componentPath}.updates.compatibleGraphVersions.max`);
    }
  });
}

function keelBuildProvenance(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-build-provenance@1"], `${path}.protocol`);
  const source = object(data.source, `${path}.source`);
  oneOf(source.availability, ["included", "digest-only"], `${path}.source.availability`);
  optionalString(source.resource, `${path}.source.resource`);
  integrity(source.integrity, `${path}.source.integrity`);
  array(data.steps, `${path}.steps`).forEach((entry, index) => {
    const stepPath = `${path}.steps[${index}]`;
    const step = object(entry, stepPath);
    string(step.id, `${stepPath}.id`);
    oneOf(
      step.operation,
      ["normalize", "transpile", "bundle", "minify", "compress", "encode", "package"],
      `${stepPath}.operation`,
    );
    const tool = object(step.tool, `${stepPath}.tool`);
    string(tool.name, `${stepPath}.tool.name`);
    string(tool.version, `${stepPath}.tool.version`);
    integrity(step.input, `${stepPath}.input`);
    integrity(step.output, `${stepPath}.output`);
    string(step.optionsDigest, `${stepPath}.optionsDigest`);
    if (step.deterministic !== true) throw new TypeError(`${stepPath}.deterministic must be true.`);
  });
  const final = object(data.final, `${path}.final`);
  string(final.resource, `${path}.final.resource`);
  integrity(final.integrity, `${path}.final.integrity`);
  if (data.storage !== undefined) {
    const storage = object(data.storage, `${path}.storage`);
    oneOf(storage.compression, ["gzip", "deflate", "brotli"], `${path}.storage.compression`);
    integrity(storage.input, `${path}.storage.input`);
    integrity(storage.stored, `${path}.storage.stored`);
    const tool = object(storage.tool, `${path}.storage.tool`);
    string(tool.name, `${path}.storage.tool.name`);
    string(tool.version, `${path}.storage.tool.version`);
    string(storage.optionsDigest, `${path}.storage.optionsDigest`);
    if (storage.deterministic !== true) throw new TypeError(`${path}.storage.deterministic must be true.`);
  }
}

function keelContractPlugin(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["keel-contract-plugin@1"], `${path}.protocol`);
  string(data.pluginId, `${path}.pluginId`);
  number(data.version, `${path}.version`);
  if (data.parent !== undefined) {
    const parent = object(data.parent, `${path}.parent`);
    number(parent.version, `${path}.parent.version`);
    string(parent.manifestDigest, `${path}.parent.manifestDigest`);
  }
  keelGraphAnchor(data.graph, `${path}.graph`);
  if (data.trust !== undefined) {
    throw new TypeError(`${path}.trust is forbidden because it would create a circular manifest/spec digest; trust belongs to the outer plugin reference.`);
  }

  const contract = object(data.contract, `${path}.contract`);
  number(contract.chainId, `${path}.contract.chainId`);
  string(contract.address, `${path}.contract.address`);
  string(contract.runtimeCodeHash, `${path}.contract.runtimeCodeHash`);
  string(contract.requiredInterfaceId, `${path}.contract.requiredInterfaceId`);

  const runtime = object(data.runtime, `${path}.runtime`);
  keelPinnedResource(runtime.abi, `${path}.runtime.abi`);
  keelPinnedResource(runtime.adapter, `${path}.runtime.adapter`);
  keelPinnedResource(runtime.walletLibrary, `${path}.runtime.walletLibrary`);

  const permissions = object(data.permissions, `${path}.permissions`);
  oneOf(permissions.protocol, ["keel-wallet-intents@1"], `${path}.permissions.protocol`);
  string(permissions.digest, `${path}.permissions.digest`);
  array(permissions.intents, `${path}.permissions.intents`).forEach((entry, index) => {
    const intentPath = `${path}.permissions.intents[${index}]`;
    const intent = object(entry, intentPath);
    string(intent.id, `${intentPath}.id`);
    string(intent.label, `${intentPath}.label`);
    oneOf(intent.target, ["plugin-contract", "artifact-collection"], `${intentPath}.target`);
    string(intent.selector, `${intentPath}.selector`);
    oneOf(intent.stateMutability, ["view", "nonpayable", "payable"], `${intentPath}.stateMutability`);
    oneOf(intent.valuePolicy, ["zero", "exact-quote"], `${intentPath}.valuePolicy`);
    string(intent.confirmation, `${intentPath}.confirmation`);
  });
}

function runtime(value: unknown, path: string): void {
  const data = object(value, path);
  const engine = object(data.engine, `${path}.engine`);
  oneOf(engine.protocol, ["oca-runtime@1"], `${path}.engine.protocol`);
  oneOf(engine.viewerProtocol, ["oca-viewer@1"], `${path}.engine.viewerProtocol`);
  oneOf(engine.renderer, ["browser"], `${path}.engine.renderer`);
  if (engine.viewerMirrors !== undefined) {
    array(engine.viewerMirrors, `${path}.engine.viewerMirrors`).forEach((entry, index) => {
      const mirror = object(entry, `${path}.engine.viewerMirrors[${index}]`);
      string(mirror.id, `${path}.engine.viewerMirrors[${index}].id`);
      string(mirror.uri, `${path}.engine.viewerMirrors[${index}].uri`);
      integrity(mirror.integrity, `${path}.engine.viewerMirrors[${index}].integrity`);
      optionalBoolean(mirror.immutable, `${path}.engine.viewerMirrors[${index}].immutable`);
      optionalString(mirror.launchUrlTemplate, `${path}.engine.viewerMirrors[${index}].launchUrlTemplate`);
    });
  }

  const determinism = object(data.determinism, `${path}.determinism`);
  const mode = oneOf(determinism.mode, ["live", "replay"], `${path}.determinism.mode`);
  if (mode === "replay") {
    string(determinism.seed, `${path}.determinism.seed`);
    oneOf(determinism.randomAlgorithm, ["xoshiro128ss"], `${path}.determinism.randomAlgorithm`);
    const viewport = object(determinism.viewport, `${path}.determinism.viewport`);
    number(viewport.width, `${path}.determinism.viewport.width`);
    number(viewport.height, `${path}.determinism.viewport.height`);
    number(viewport.devicePixelRatio, `${path}.determinism.viewport.devicePixelRatio`);
    const clock = object(determinism.clock, `${path}.determinism.clock`);
    const clockMode = oneOf(clock.mode, ["fixed", "frame"], `${path}.determinism.clock.mode`);
    number(clock.epochMs, `${path}.determinism.clock.epochMs`);
    if (clockMode === "frame") number(clock.frameDurationMs, `${path}.determinism.clock.frameDurationMs`);
    string(determinism.locale, `${path}.determinism.locale`);
    string(determinism.timezone, `${path}.determinism.timezone`);
  }

  const content = object(data.content, `${path}.content`);
  oneOf(content.protocol, ["oca-content-gateway@1"], `${path}.content.protocol`);
  oneOf(content.mode, ["verified-only"], `${path}.content.mode`);
  oneOf(content.externalSources, ["host-verified"], `${path}.content.externalSources`);
  oneOf(content.manifestTrust, ["digest", "registry"], `${path}.content.manifestTrust`);
  if (content.blockUndeclared !== true) throw new TypeError(`${path}.content.blockUndeclared must be true.`);
  optionalString(content.resourcePathPrefix, `${path}.content.resourcePathPrefix`);
  optionalString(content.onchainPathPrefix, `${path}.content.onchainPathPrefix`);
  optionalString(content.ipfsPathPrefix, `${path}.content.ipfsPathPrefix`);

  oneOf(data.sandbox, ["strict", "isolated-origin"], `${path}.sandbox`);
  if (data.capabilities !== undefined) {
    const capabilities = object(data.capabilities, `${path}.capabilities`);
    if ("network" in capabilities) throw new TypeError(`${path}.capabilities.network is not supported; remote sources are host-verified.`);
    for (const key of [
      "downloads",
      "pointerLock",
      "fullscreen",
      "clipboardWrite",
      "gamepad",
      "audioAutoplay",
      "webAssembly",
    ]) optionalBoolean(capabilities[key], `${path}.capabilities.${key}`);
  }
  if (data.networkAllowlist !== undefined) throw new TypeError(`${path}.networkAllowlist is not supported; declare hashed URI sources instead.`);
  for (const key of ["maxResourceBytes", "maxTotalBytes", "maxRecursionDepth", "maxResources", "timeoutMs"]) {
    optionalNumber(data[key], `${path}.${key}`);
  }
}

function anchor(value: unknown, path: string): void {
  const data = object(value, path);
  oneOf(data.protocol, ["oca-artifact-registry@1"], `${path}.protocol`);
  oneOf(data.kind, ["artifact-registry"], `${path}.kind`);
  number(data.chainId, `${path}.chainId`);
  string(data.registry, `${path}.registry`);
  string(data.collection, `${path}.collection`);
  string(data.tokenId, `${path}.tokenId`);
  optionalNumber(data.revision, `${path}.revision`);
}

function revision(value: unknown, path: string): void {
  const data = object(value, path);
  number(data.number, `${path}.number`);
  optionalNumber(data.parent, `${path}.parent`);
  optionalIntegrity(data.parentDigest, `${path}.parentDigest`);
  const compatibility = object(data.compatibility, `${path}.compatibility`);
  number(compatibility.min, `${path}.compatibility.min`);
  number(compatibility.max, `${path}.compatibility.max`);
  oneOf(data.policy, ["immutable", "creator", "token-owner", "creator-or-token-owner", "timelocked"], `${path}.policy`);
  optionalString(data.activationTime, `${path}.activationTime`);
  optionalBoolean(data.frozen, `${path}.frozen`);
  optionalString(data.notes, `${path}.notes`);
}

function provenance(value: unknown, path: string): void {
  const data = object(value, path);
  optionalString(data.creator, `${path}.creator`);
  string(data.createdAt, `${path}.createdAt`);
  optionalString(data.collection, `${path}.collection`);
  optionalString(data.tokenId, `${path}.tokenId`);
  optionalNumber(data.chainId, `${path}.chainId`);
  optionalString(data.sourceRepository, `${path}.sourceRepository`);
  optionalString(data.license, `${path}.license`);
}

/** Parse untrusted JSON into a semantically validated Keel v2 manifest. */
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const data = object(value, "$");
  string(data.schema, "$.schema");
  string(data.canonicalization, "$.canonicalization");
  string(data.id, "$.id");
  string(data.name, "$.name");
  optionalString(data.description, "$.description");

  const entrypoint = object(data.entrypoint, "$.entrypoint");
  string(entrypoint.resource, "$.entrypoint.resource");
  oneOf(entrypoint.mode, ["html", "module", "svg", "image", "video", "audio", "model"], "$.entrypoint.mode");
  optionalString(entrypoint.mount, "$.entrypoint.mount");

  const rawResources = array(data.resources, "$.resources");
  rawResources.forEach((entry, index) => resource(entry, `$.resources[${index}]`));
  const fallback = object(data.fallback, "$.fallback");
  string(fallback.image, "$.fallback.image");
  optionalString(fallback.animation, "$.fallback.animation");
  optionalString(fallback.externalUrl, "$.fallback.externalUrl");
  optionalString(fallback.backgroundColor, "$.fallback.backgroundColor");

  if (data.thumbnail !== undefined) {
    const thumbnail = object(data.thumbnail, "$.thumbnail");
    oneOf(thumbnail.protocol, ["oca-thumbnail@1"], "$.thumbnail.protocol");
    optionalString(thumbnail.image, "$.thumbnail.image");
    optionalString(thumbnail.animation, "$.thumbnail.animation");
    number(thumbnail.maxBytes, "$.thumbnail.maxBytes");
    if (thumbnail.capture !== undefined) {
      const capture = object(thumbnail.capture, "$.thumbnail.capture");
      oneOf(capture.mode, ["signal", "after-init", "time"], "$.thumbnail.capture.mode");
      oneOf(capture.target, ["canvas", "viewport"], "$.thumbnail.capture.target");
      optionalNumber(capture.delayMs, "$.thumbnail.capture.delayMs");
      optionalNumber(capture.durationMs, "$.thumbnail.capture.durationMs");
      optionalNumber(capture.frameRate, "$.thumbnail.capture.frameRate");
      optionalString(capture.label, "$.thumbnail.capture.label");
    }
  }
  if (data.mediaDerivatives !== undefined) {
    array(data.mediaDerivatives, "$.mediaDerivatives").forEach((entry, index) => {
      object(entry, `$.mediaDerivatives[${index}]`);
      assertValidKeelMediaDerivative(entry as KeelMediaDerivative);
    });
  }
  if (data.stakeObject !== undefined) {
    object(data.stakeObject, "$.stakeObject");
    assertValidKeelStakeObject(
      data.stakeObject as KeelStakeObject,
      new Set(rawResources.map((entry) => (entry as Record<string, unknown>).id as string)),
    );
  }

  runtime(data.runtime, "$.runtime");
  if (data.plugins !== undefined) keelPluginBindings(data.plugins, "$.plugins");
  if (data.libraries !== undefined) keelLibraryBindings(data.libraries, "$.libraries");
  if (data.stack !== undefined) keelProjectStack(data.stack, "$.stack");
  if (data.build !== undefined) keelBuildProvenance(data.build, "$.build");
  if (data.contractPlugin !== undefined) keelContractPlugin(data.contractPlugin, "$.contractPlugin");
  if (data.anchor !== undefined) anchor(data.anchor, "$.anchor");
  revision(data.revision, "$.revision");
  provenance(data.provenance, "$.provenance");

  if (data.downloads !== undefined) {
    array(data.downloads, "$.downloads").forEach((entry, index) => {
      const download = object(entry, `$.downloads[${index}]`);
      string(download.resource, `$.downloads[${index}].resource`);
      string(download.label, `$.downloads[${index}].label`);
      optionalString(download.filename, `$.downloads[${index}].filename`);
    });
  }

  if (data.attributes !== undefined) {
    array(data.attributes, "$.attributes").forEach((entry, index) => {
      const attribute = object(entry, `$.attributes[${index}]`);
      string(attribute.trait_type, `$.attributes[${index}].trait_type`);
      if (typeof attribute.value !== "string" && typeof attribute.value !== "number") {
        throw new TypeError(`$.attributes[${index}].value must be a string or number.`);
      }
      optionalString(attribute.display_type, `$.attributes[${index}].display_type`);
    });
  }
  if (data.attributions !== undefined) {
    normalizeKeelAttributions(data.attributions as readonly KeelAttribution[]);
  }
  if (data.extensions !== undefined) {
    const extensions = object(data.extensions, "$.extensions");
    if (extensions[KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY] !== undefined) {
      assertValidKeelCommunityReplicationPreference(
        extensions[KEEL_COMMUNITY_REPLICATION_EXTENSION_KEY],
      );
    }
    if (extensions[KEEL_IP_CONTROL_EXTENSION_KEY] !== undefined) {
      assertValidKeelIPControlExtension(
        extensions[KEEL_IP_CONTROL_EXTENSION_KEY],
        new Set(rawResources.map((entry) => (entry as Record<string, unknown>).id as string)),
      );
    }
  }

  const manifest = value as ArtifactManifest;
  assertValidManifest(manifest);
  return manifest;
}
