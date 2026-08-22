import type {
  Hex,
  KeelIPControlAction,
  KeelIPControlExtension,
  KeelIPControlMode,
} from "@keel/protocol";
import type {
  IPControlReadRequest,
  IPControlReadResult,
  IPControlResourceResult,
} from "./types.js";
import type {
  KeelContractFunction,
  KeelContractRead,
} from "./keel-adapter.js";

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;
const TEZOS_BURN_ADDRESS = "tz1burnburnburnburnburnburnburjAYjjX";
const BROTLI_HEX = "0x62726f746c69";
const BYTES32 = /^0x[0-9a-fA-F]{64}$/u;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const TEZOS_ADDRESS = /^(?:KT1|tz[1-4])[1-9A-HJ-NP-Za-km-z]{33}$/u;

const ACTION_BITS: Readonly<Record<KeelIPControlAction, number>> = {
  view: 1,
  download: 2,
  remint: 4,
  "mint-to-backpack": 8,
};

function tupleValue(value: unknown, key: string, index: number): unknown {
  let tuple = value;
  if (Array.isArray(tuple) && tuple.length === 1 && tuple[0] !== null && typeof tuple[0] === "object") {
    tuple = tuple[0];
  }
  if (Array.isArray(tuple)) return tuple[index];
  if (tuple !== null && typeof tuple === "object") {
    const record = tuple as Record<string | number, unknown>;
    return record[key] ?? record[index];
  }
  return undefined;
}

function scalar(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  const resolved = scalar(value);
  if (typeof resolved !== "boolean") throw new TypeError(`${label} must be boolean.`);
  return resolved;
}

function safeNumber(value: unknown, label: string, minimum = 0): number {
  let resolved: unknown = value;
  if (typeof resolved === "bigint") resolved = Number(resolved);
  if (typeof resolved === "string" && /^(?:0|[1-9][0-9]*)$/u.test(resolved)) resolved = Number(resolved);
  if (!Number.isSafeInteger(resolved) || (resolved as number) < minimum) {
    throw new RangeError(`${label} exceeds safe client limits.`);
  }
  return resolved as number;
}

function asBigInt(value: unknown, label: string): bigint {
  try {
    const resolved = typeof value === "bigint" ? value : BigInt(value as string | number);
    if (resolved < 0n) throw new RangeError();
    return resolved;
  } catch {
    throw new RangeError(`${label} must be an unsigned integer.`);
  }
}

function bytes32(value: unknown, label: string): Hex {
  const resolved = text(value, label).toLowerCase();
  if (!BYTES32.test(resolved)) throw new TypeError(`${label} must be bytes32.`);
  return resolved as Hex;
}

function evmAddress(value: unknown, label: string): Hex {
  const resolved = text(value, label);
  if (!EVM_ADDRESS.test(resolved)) throw new TypeError(`${label} must be an EVM address.`);
  return resolved.toLowerCase() as Hex;
}

function tezosAddress(value: unknown, label: string): string {
  const resolved = text(value, label);
  if (!TEZOS_ADDRESS.test(resolved)) throw new TypeError(`${label} must be a Tezos address.`);
  return resolved;
}

function ipMode(value: unknown, label: string): KeelIPControlMode {
  switch (safeNumber(value, label)) {
    case 0: return "open";
    case 1: return "allowlist";
    case 2: return "token";
    case 3: return "creator-grant";
    case 4: return "external-rule";
    default: throw new TypeError(`${label} is not a supported IP-control mode.`);
  }
}

function actionsForMask(mask: number, declared: readonly KeelIPControlAction[]): KeelIPControlAction[] {
  return declared.filter((action) => (mask & ACTION_BITS[action]) === ACTION_BITS[action]);
}

function utf8Bytes(value: unknown, label: string): string {
  const resolved = text(value, label);
  if (!/^0x[0-9a-fA-F]*$/u.test(resolved) || (resolved.length - 2) % 2 !== 0) return resolved;
  const bytes = new Uint8Array((resolved.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(resolved.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function tezosBytes32(value: unknown, label: string): Hex {
  const resolved = text(value, label).toLowerCase();
  const normalized = resolved.startsWith("0x") ? resolved : `0x${resolved}`;
  return bytes32(normalized, label);
}

function tezosCompression(value: unknown, label: string): "brotli" {
  const resolved = text(value, label).toLowerCase();
  const normalized = resolved.startsWith("0x") ? resolved : `0x${resolved}`;
  if (normalized !== BROTLI_HEX) throw new TypeError(`${label} is not Brotli.`);
  return "brotli";
}

function declaredAccount(request: IPControlReadRequest, chain: "ethereum" | "tezos"): string {
  if (request.account === undefined) return chain === "ethereum" ? ZERO_ADDRESS : TEZOS_BURN_ADDRESS;
  return chain === "ethereum"
    ? evmAddress(request.account, "ip-control.account")
    : tezosAddress(request.account, "ip-control.account");
}

export interface EthereumIPControlReaderOptions {
  readonly readContract: KeelContractRead;
}

/** Read and normalize an EVM KeelIPControl registry through the host's approved transport. */
export function createEthereumIPControlReader(
  options: EthereumIPControlReaderOptions,
): (request: IPControlReadRequest, signal: AbortSignal) => Promise<IPControlReadResult> {
  return async (request, signal): Promise<IPControlReadResult> => {
    if (request.declaration.chain !== "ethereum") throw new TypeError("The Ethereum IP reader cannot read a Tezos registry.");
    const declaration = request.declaration;
    const registry = evmAddress(declaration.registry, "ip-control.registry");
    const account = declaredAccount(request, "ethereum") as Hex;
    const blockNumber = request.blockNumber === undefined ? undefined : asBigInt(request.blockNumber, "ip-control.blockNumber");
    const read = (functionName: Extract<KeelContractFunction, `ip${string}`>, args: readonly unknown[]): Promise<unknown> =>
      options.readContract({
        chainId: declaration.chainId,
        address: registry,
        functionName,
        args,
        ...(blockNumber === undefined ? {} : { blockNumber }),
        ...(request.blockHash === undefined ? {} : { blockHash: request.blockHash }),
        signal,
      });

    const [policyValue, licenseValue] = await Promise.all([
      read("ipPolicy", [declaration.policyId]),
      read("ipLicense", [declaration.license.licenseId]),
    ]);
    if (!bool(tupleValue(policyValue, "exists", 6), "ip-control.policy.exists")) throw new Error("IP-control policy is missing.");
    if (!bool(tupleValue(licenseValue, "exists", 9), "ip-control.license.exists")) throw new Error("IP-control license is missing.");
    const policyObjectId = bytes32(tupleValue(policyValue, "objectId", 0), "ip-control.policy.objectId");
    const policyObjectRevision = safeNumber(tupleValue(policyValue, "objectRevision", 1), "ip-control.policy.objectRevision", 1);
    const policyCreator = evmAddress(tupleValue(policyValue, "creator", 2), "ip-control.policy.creator");
    const policyLicenseId = bytes32(tupleValue(policyValue, "licenseId", 3), "ip-control.policy.licenseId");
    const policyVersion = safeNumber(tupleValue(policyValue, "version", 4), "ip-control.policy.version", 1);
    const configFrozen = bool(tupleValue(policyValue, "configFrozen", 5), "ip-control.policy.configFrozen");
    const license: IPControlReadResult["license"] = {
      licenseId: declaration.license.licenseId,
      contentObjectId: bytes32(tupleValue(licenseValue, "contentObjectId", 0), "ip-control.license.contentObjectId"),
      decodedDigest: bytes32(tupleValue(licenseValue, "decodedDigest", 1), "ip-control.license.decodedDigest"),
      decodedByteLength: safeNumber(tupleValue(licenseValue, "byteLength", 2), "ip-control.license.byteLength", 1),
      storedByteLength: safeNumber(tupleValue(licenseValue, "storedByteLength", 3), "ip-control.license.storedByteLength", 1),
      compression: safeNumber(tupleValue(licenseValue, "compression", 4), "ip-control.license.compression") === 3 ? "brotli" : (() => { throw new TypeError("IP-control license is not Brotli."); })(),
      identifier: text(tupleValue(licenseValue, "identifier", 5), "ip-control.license.identifier"),
      name: text(tupleValue(licenseValue, "name", 6), "ip-control.license.name"),
      publisher: evmAddress(tupleValue(licenseValue, "publisher", 7), "ip-control.license.publisher"),
      standard: bool(tupleValue(licenseValue, "standard", 8), "ip-control.license.standard"),
    };
    if (policyObjectId !== declaration.objectId || policyObjectRevision !== declaration.objectRevision || policyLicenseId !== declaration.license.licenseId) {
      throw new Error("IP-control policy does not match the manifest binding.");
    }

    const resources = await Promise.all(declaration.resources.map(async (binding): Promise<IPControlResourceResult> => {
      const [ruleValue, statusValue] = await Promise.all([
        read("ipRule", [declaration.policyId, binding.objectId]),
        read("ipAuthorizationStatus", [declaration.policyId, binding.objectId, account, ACTION_BITS.view]),
      ]);
      if (!bool(tupleValue(ruleValue, "exists", 6), "ip-control.rule.exists")) throw new Error(`IP-control rule is missing for ${binding.resource}.`);
      const mode = ipMode(tupleValue(ruleValue, "mode", 0), `ip-control.rule.${binding.resource}.mode`);
      const objectRevision = safeNumber(tupleValue(ruleValue, "objectRevision", 5), `ip-control.rule.${binding.resource}.objectRevision`, 1);
      const actionMask = safeNumber(tupleValue(ruleValue, "actionMask", 2), `ip-control.rule.${binding.resource}.actionMask`);
      if (objectRevision !== binding.objectRevision || actionMask <= 0 || actionMask > 15) throw new Error(`IP-control rule does not match ${binding.resource}.`);
      const statusMode = ipMode(tupleValue(statusValue, "mode", 1), `ip-control.status.${binding.resource}.mode`);
      const statusMask = safeNumber(tupleValue(statusValue, "actionMask", 2), `ip-control.status.${binding.resource}.actionMask`);
      const statusLicense = bytes32(tupleValue(statusValue, "licenseId", 5), `ip-control.status.${binding.resource}.licenseId`);
      const statusVersion = safeNumber(tupleValue(statusValue, "policyVersion", 6), `ip-control.status.${binding.resource}.policyVersion`, 1);
      if (statusMode !== mode || statusMask !== actionMask || statusLicense !== policyLicenseId || statusVersion !== policyVersion) {
        throw new Error(`IP-control authorization status does not match ${binding.resource}.`);
      }
      const allowedActions = mode === "open" && request.account === undefined
        ? actionsForMask(actionMask, binding.actions)
        : (await Promise.all(binding.actions.map(async (action) =>
            bool(await read("ipIsAuthorized", [declaration.policyId, binding.objectId, account, ACTION_BITS[action]]), `ip-control.${binding.resource}.${action}`)
              ? action
              : undefined,
          ))).filter((action): action is KeelIPControlAction => action !== undefined);
      return {
        resource: binding.resource,
        objectId: binding.objectId,
        objectRevision,
        ruleId: bytes32(tupleValue(statusValue, "effectiveRuleId", 4), `ip-control.${binding.resource}.effectiveRuleId`),
        mode,
        actionMask,
        allowedActions,
        allowed: allowedActions.includes("view"),
        ...(request.account === undefined ? {} : { currentAccount: account }),
      };
    }));

    return {
      chain: "ethereum",
      chainId: declaration.chainId,
      registry,
      policyId: declaration.policyId,
      objectId: policyObjectId,
      objectRevision: policyObjectRevision,
      creator: policyCreator,
      version: policyVersion,
      configFrozen,
      license,
      resources,
      ...(request.blockNumber === undefined ? {} : { blockNumber: request.blockNumber }),
      ...(request.blockHash === undefined ? {} : { blockHash: request.blockHash }),
    };
  };
}

export type KeelTezosIPControlView =
  | "get_license"
  | "authorization_status"
  | "is_authorized"
  | "code_hash";

export interface KeelTezosIPControlViewRequest {
  readonly network: string;
  readonly address: string;
  readonly view: KeelTezosIPControlView;
  readonly input: unknown;
  readonly signal: AbortSignal;
}

export type KeelTezosIPControlViewRunner = (request: KeelTezosIPControlViewRequest) => Promise<unknown>;

export interface TezosIPControlReaderOptions {
  readonly network: string;
  readonly runView: KeelTezosIPControlViewRunner;
}

/** Read the native SmartPy views exposed by the Tezos KeelIPControl target. */
export function createTezosIPControlReader(
  options: TezosIPControlReaderOptions,
): (request: IPControlReadRequest, signal: AbortSignal) => Promise<IPControlReadResult> {
  return async (request, signal): Promise<IPControlReadResult> => {
    if (request.declaration.chain !== "tezos") throw new TypeError("The Tezos IP reader cannot read an Ethereum registry.");
    const declaration = request.declaration;
    const registry = text(declaration.registry, "ip-control.registry");
    if (!TEZOS_ADDRESS.test(registry)) throw new TypeError("ip-control.registry must be a Tezos address.");
    const account = declaredAccount(request, "tezos");
    const network = declaration.network ?? options.network;
    if (network.length === 0) throw new TypeError("ip-control.network must be a non-empty Tezos network.");
    const readAt = (address: string, view: KeelTezosIPControlView, input: unknown): Promise<unknown> => options.runView({
      network,
      address,
      view,
      input,
      signal,
    });
    const read = (view: KeelTezosIPControlView, input: unknown): Promise<unknown> => readAt(registry, view, input);
    const licenseRegistry = text(declaration.licenseRegistry, "ip-control.licenseRegistry");
    if (!TEZOS_ADDRESS.test(licenseRegistry)) throw new TypeError("ip-control.licenseRegistry must be a Tezos address.");
    const licenseValue = await readAt(licenseRegistry, "get_license", declaration.license.licenseId);
    const license: IPControlReadResult["license"] = {
      licenseId: declaration.license.licenseId,
      contentObjectId: tezosBytes32(tupleValue(licenseValue, "object_id", 0), "ip-control.license.object_id"),
      decodedDigest: tezosBytes32(tupleValue(licenseValue, "decoded_sha256", 1), "ip-control.license.decoded_sha256"),
      decodedByteLength: safeNumber(tupleValue(licenseValue, "decoded_byte_length", 2), "ip-control.license.decoded_byte_length", 1),
      storedByteLength: safeNumber(tupleValue(licenseValue, "stored_byte_length", 3), "ip-control.license.stored_byte_length", 1),
      compression: tezosCompression(tupleValue(licenseValue, "compression", 4), "ip-control.license.compression"),
      identifier: utf8Bytes(tupleValue(licenseValue, "identifier", 5), "ip-control.license.identifier"),
      name: utf8Bytes(tupleValue(licenseValue, "name", 6), "ip-control.license.name"),
      publisher: tezosAddress(tupleValue(licenseValue, "publisher", 7), "ip-control.license.publisher"),
      standard: bool(tupleValue(licenseValue, "standard", 8), "ip-control.license.standard"),
    };
    const tokenGate = declaration.tokenGate === undefined ? undefined : text(declaration.tokenGate, "ip-control.tokenGate");
    if (tokenGate !== undefined && !/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/u.test(tokenGate)) {
      throw new TypeError("ip-control.tokenGate must be a Tezos KT1 address.");
    }
    const authorizationInput = (resourceObjectId: Hex, action: number) => ({
      policy_id: declaration.policyId,
      resource_object_id: resourceObjectId,
      account,
      action,
    });
    const liveAllowed = async (status: unknown, resourceObjectId: Hex, action: number): Promise<boolean> => {
      const actionMask = safeNumber(tupleValue(status, "action_mask", 3), "ip-control.status.action_mask");
      if ((actionMask & action) !== action) return false;
      const mode = ipMode(tupleValue(status, "mode", 1), "ip-control.status.mode");
      if (mode === "token") {
        if (tokenGate === undefined) throw new Error("Tezos token IP policy has no declared tokenGate evaluator.");
        return bool(await readAt(tokenGate, "is_authorized", {
          policy_id: declaration.policyId,
          resource_object_id: tezosBytes32(tupleValue(status, "effective_resource_object_id", 4), "ip-control.status.effective_resource_object_id"),
          account,
          token_logic: safeNumber(tupleValue(status, "token_logic", 2), "ip-control.status.token_logic"),
        }), "ip-control.tokenGate.is_authorized");
      }
      if (mode === "external-rule") {
        const externalRule = tezosAddress(tupleValue(status, "external_rule", 5), "ip-control.status.external_rule");
        const expectedCodeHash = tezosBytes32(tupleValue(status, "external_rule_code_hash", 6), "ip-control.status.external_rule_code_hash");
        const codeHash = tezosBytes32(await readAt(externalRule, "code_hash", declaration.policyId), "ip-control.external-rule.code_hash");
        if (codeHash !== expectedCodeHash) return false;
        return bool(await readAt(externalRule, "is_authorized", authorizationInput(
          resourceObjectId,
          action,
        )), "ip-control.external-rule.is_authorized");
      }
      return bool(tupleValue(status, "allowed", 0), "ip-control.status.allowed");
    };
    const snapshots = await Promise.all(declaration.resources.map(async (binding) => {
      const statusValues = await Promise.all(binding.actions.map(async (action) => {
        const status = await read("authorization_status", {
          policy_id: declaration.policyId,
          resource_object_id: binding.objectId,
          account,
          action: ACTION_BITS[action],
        });
        return { status, action };
      }));
      const firstStatus = statusValues[0]?.status;
      if (firstStatus === undefined) throw new Error(`IP-control status is missing for ${binding.resource}.`);
      const mode = ipMode(tupleValue(firstStatus, "mode", 1), `ip-control.rule.${binding.resource}.mode`);
      const objectRevision = safeNumber(tupleValue(firstStatus, "object_revision", 11), `ip-control.rule.${binding.resource}.object_revision`, 1);
      const actionMask = safeNumber(tupleValue(firstStatus, "action_mask", 3), `ip-control.rule.${binding.resource}.action_mask`);
      const policyObjectId = tezosBytes32(tupleValue(firstStatus, "object_id", 10), `ip-control.policy.object_id`);
      const policyCreator = tezosAddress(tupleValue(firstStatus, "creator", 12), `ip-control.policy.creator`);
      const policyVersion = safeNumber(tupleValue(firstStatus, "policy_version", 9), `ip-control.policy.version`, 1);
      const configFrozen = bool(tupleValue(firstStatus, "config_frozen", 13), `ip-control.policy.config_frozen`);
      const policyLicenseId = tezosBytes32(tupleValue(firstStatus, "license_id", 8), `ip-control.policy.license_id`);
      const allowedResults = await Promise.all(statusValues.map(async ({ status, action }) => ({
        action,
        allowed: await liveAllowed(status, binding.objectId, ACTION_BITS[action]),
      })));
      const allowedActions = allowedResults.filter(({ allowed }) => allowed).map(({ action }) => action);
      for (const { status } of statusValues) {
        if (ipMode(tupleValue(status, "mode", 1), `ip-control.status.${binding.resource}.mode`) !== mode
          || safeNumber(tupleValue(status, "action_mask", 3), `ip-control.status.${binding.resource}.action_mask`) !== actionMask
          || tezosBytes32(tupleValue(status, "license_id", 8), `ip-control.status.${binding.resource}.license_id`) !== policyLicenseId
          || safeNumber(tupleValue(status, "policy_version", 9), `ip-control.status.${binding.resource}.policy_version`, 1) !== policyVersion
          || tezosBytes32(tupleValue(status, "object_id", 10), `ip-control.status.${binding.resource}.object_id`) !== policyObjectId
          || safeNumber(tupleValue(status, "object_revision", 11), `ip-control.status.${binding.resource}.object_revision`, 1) !== objectRevision
          || tezosAddress(tupleValue(status, "creator", 12), `ip-control.status.${binding.resource}.creator`) !== policyCreator
          || bool(tupleValue(status, "config_frozen", 13), `ip-control.status.${binding.resource}.config_frozen`) !== configFrozen) {
          throw new Error(`IP-control authorization status does not match ${binding.resource}.`);
        }
      }
      return {
        policy: {
          objectId: policyObjectId,
          objectRevision: safeNumber(tupleValue(firstStatus, "object_revision", 11), `ip-control.policy.object_revision`, 1),
          creator: policyCreator,
          version: policyVersion,
          configFrozen,
          licenseId: policyLicenseId,
        },
        resource: {
          resource: binding.resource,
          objectId: binding.objectId,
          objectRevision,
          mode,
          actionMask,
          allowedActions,
          allowed: allowedActions.includes("view"),
          ...(request.account === undefined ? {} : { currentAccount: account }),
        } satisfies IPControlResourceResult,
      };
    }));
    const firstSnapshot = snapshots[0];
    if (firstSnapshot === undefined) throw new Error("IP-control policy has no resources.");
    for (const snapshot of snapshots.slice(1)) {
      if (snapshot.policy.objectId !== firstSnapshot.policy.objectId
        || snapshot.policy.objectRevision !== firstSnapshot.policy.objectRevision
        || snapshot.policy.creator !== firstSnapshot.policy.creator
        || snapshot.policy.version !== firstSnapshot.policy.version
        || snapshot.policy.configFrozen !== firstSnapshot.policy.configFrozen
        || snapshot.policy.licenseId !== firstSnapshot.policy.licenseId) {
        throw new Error("IP-control resources returned inconsistent policy metadata.");
      }
    }
    if (firstSnapshot.policy.licenseId !== declaration.license.licenseId) {
      throw new Error("IP-control policy license does not match the manifest binding.");
    }
    return {
      chain: "tezos",
      chainId: declaration.chainId,
      registry,
      policyId: declaration.policyId,
      objectId: firstSnapshot.policy.objectId,
      objectRevision: firstSnapshot.policy.objectRevision,
      creator: firstSnapshot.policy.creator,
      version: firstSnapshot.policy.version,
      configFrozen: firstSnapshot.policy.configFrozen,
      license,
      resources: snapshots.map(({ resource }) => resource),
      licenseRegistry,
      ...(request.blockNumber === undefined ? {} : { blockNumber: request.blockNumber }),
      ...(request.blockHash === undefined ? {} : { blockHash: request.blockHash }),
    };
  };
}
