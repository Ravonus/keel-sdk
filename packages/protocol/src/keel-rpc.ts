/**
 * The Keel RPC module: one way to read a chain, for every chain Keel
 * preserves onto.
 *
 * ## Why this exists
 *
 * A Keel viewer document can get the artwork it renders two ways. It can
 * *carry* it — the document is a KeelHold composite whose parts include the
 * artwork object, so rendering it and verifying it are the same act and nothing
 * is fetched. Or it can *read* it — a ~30KB document that pulls the bytes at
 * render time. Carrying is stronger and this protocol prefers it, but a
 * quarter-megabyte artwork carried inline is a quarter-megabyte `animation_url`
 * that every marketplace, wallet, and indexer has to move before anything
 * appears, and past a point a node's `eth_call` response cap simply refuses.
 * Reading keeps the document small and the token renderable.
 *
 * The old way to read was a content host: an IPFS or HTTPS mirror named in the
 * token's metadata. This module is the other way — the bytes come back off the
 * same ledger that proved them, over `eth_call` on Ethereum and a script view
 * on Tezos, and no content host is in the path at all.
 *
 * ## What it looks like to use
 *
 * The transport is deliberately invisible at the call site. A script inside a
 * viewer asks for an object the way it would ask a contract, and the JSON-RPC
 * envelope, the endpoint failover, and the ABI or Michelson decoding all happen
 * underneath:
 *
 *     const chain = createKeelRpcClient({ family: "ethereum", chainId: 1, endpoints });
 *     const artwork = await chain.haulObject(keelHold, assetObjectId);
 *
 *     const chain = createKeelRpcClient({ family: "tezos", network: "NetXdQprcVkpaWU", endpoints });
 *     const artwork = await chain.haulObject(kt1Store, assetObjectId);
 *
 * Same call, same return, different chain. That is the point: a viewer written
 * against this reads on-chain objects without knowing or caring which family it
 * landed on.
 *
 * ## What it does not hide
 *
 * It hides the plumbing from whoever writes the viewer. It does not hide the
 * dependency from whoever reads the token, and the two must not be confused. A
 * document that reads through a host has a host in its trust path, and
 * `disclosure()` exists so the verification chrome can say so plainly. Masking
 * that would make this worse than the mirror it replaces, not better — a viewer
 * that claims "no external dependencies" while holding an open socket is
 * exactly the lie this protocol is meant to be the opposite of.
 *
 * What the reader still gets, and what a mirror never gave them:
 *   - the bytes are content-addressed, so `haulObjectVerified` can prove the
 *     node returned the object that was asked for and not another one;
 *   - the endpoint is governed rather than ad hoc — see `keel-rpc-policy`;
 *   - more than one endpoint can be supplied, and a node that lies or dies is
 *     simply the next one's turn.
 */

import { verifyIntegrity } from "./integrity.js";
import type { Integrity } from "./types.js";
import {
  assertKeelRpcUrl,
  redactRpcUrl,
  KEEL_DEFAULT_RPC_HOSTS,
  type KeelRpcHostList,
} from "./keel-rpc-policy.js";

export type KeelRpcFamily = "ethereum" | "tezos";

/** `KeelHold.haulObject(bytes32)`. Verified against the deployed contract. */
export const KEEL_READ_OBJECT_SELECTOR = "0x5ea5306e" as const;
/** `KeelHold.getObject(bytes32)`. */
export const KEEL_GET_OBJECT_SELECTOR = "0x05144857" as const;
/** The Tezos on-chain view every Keel store exposes. */
export const KEEL_TEZOS_OBJECT_VIEW = "read_keel_object" as const;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Tenderbake finalises at two blocks; deeper only adds margin. */
const DEFAULT_TEZOS_CONFIRMATIONS = 2;

export class KeelRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = "KeelRpcError";
  }
}

export interface KeelRpcClientOptions {
  readonly family: KeelRpcFamily;
  /** Tried in order; the first that answers wins. */
  readonly endpoints: readonly string[];
  /** EVM chain id, for disclosure and for callers that pin one. */
  readonly chainId?: number;
  /** Tezos chain id (`NetXdQprcVkpaWU`), for disclosure and endpoint checks. */
  readonly network?: string;
  /**
   * The governed host list. Defaults to the built-in genesis list; pass the
   * deployment's own list (read from `KeelManager.rpcHostList`) to hold
   * endpoints to what governance actually blessed.
   */
  readonly hostList?: KeelRpcHostList | readonly string[];
  /** Local chains only. See `keelRpcUrlAllowed`. */
  readonly allowPrivateNetworkHosts?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Tezos read depth. Ignored on Ethereum. */
  readonly confirmations?: number;
  readonly signal?: AbortSignal;
}

/** What the verification chrome shows about how these bytes were obtained. */
export interface KeelRpcDisclosure {
  readonly family: KeelRpcFamily;
  readonly chain: string;
  /** Origins only — an endpoint URL routinely carries an API key in its path. */
  readonly endpoints: readonly string[];
  /** The endpoint that actually answered, if one has. */
  readonly servedBy?: string;
  readonly hostListRevision?: number;
  readonly hostListEpoch?: number;
  readonly hostListStale?: boolean;
  readonly reads: number;
}

export interface KeelEthCall {
  readonly to: string;
  readonly data: string;
  /** `"latest"`, a block number, or an EIP-1898 hash selector. */
  readonly block?: string | { readonly blockHash: string; readonly requireCanonical: true };
}

export interface KeelTezosView {
  readonly contract: string;
  readonly view?: string;
  readonly input: unknown;
  readonly block?: string;
}

export interface KeelRpcClient {
  readonly family: KeelRpcFamily;
  /** An arbitrary read. Ethereum only; throws on a Tezos client. */
  call(request: KeelEthCall): Promise<string>;
  /** An arbitrary on-chain view. Tezos only; throws on an Ethereum client. */
  view(request: KeelTezosView): Promise<unknown>;
  /** The bytes of one Keel object, whichever family holds it. */
  haulObject(store: string, objectId: string): Promise<Uint8Array>;
  /**
   * The same read, refused unless the bytes hash to what was asked for. This is
   * what makes reading through a host acceptable rather than merely convenient.
   */
  haulObjectVerified(store: string, objectId: string, integrity: Integrity): Promise<Uint8Array>;
  disclosure(): KeelRpcDisclosure;
}

function hostsOf(hostList: KeelRpcClientOptions["hostList"]): readonly string[] {
  if (hostList === undefined) return KEEL_DEFAULT_RPC_HOSTS;
  return Array.isArray(hostList) ? hostList : (hostList as KeelRpcHostList).hosts;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || /[^0-9a-fA-F]/u.test(body)) {
    throw new KeelRpcError("Response is not hex.", "decode.hex");
  }
  const out = new Uint8Array(body.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode an ABI `bytes` return: an offset word, a length word, then the data.
 * The length is checked against what actually arrived, so a truncated or
 * over-long response is an error rather than a silently short artwork.
 */
export function decodeAbiBytes(result: string, maxBytes: number): Uint8Array {
  const body = result.startsWith("0x") ? result.slice(2) : result;
  if (body.length < 128) throw new KeelRpcError("Response is too short to be ABI bytes.", "decode.abi");
  const length = Number.parseInt(body.slice(64, 128), 16);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new KeelRpcError("Response declares an unusable length.", "decode.abi");
  }
  if (length > maxBytes) {
    throw new KeelRpcError(`Object is ${length} bytes; the limit is ${maxBytes}.`, "limit.response-bytes");
  }
  const data = body.slice(128, 128 + length * 2);
  if (data.length !== length * 2) {
    throw new KeelRpcError("Response is shorter than the length it declares.", "decode.abi");
  }
  return hexToBytes(data);
}

/** Unwrap `bytes`, or an `option bytes`, out of a Michelson view result. */
export function decodeMichelsonBytes(expression: unknown): string | null {
  if (expression !== null && typeof expression === "object") {
    const node = expression as { bytes?: unknown; prim?: unknown; args?: unknown };
    if (typeof node.bytes === "string") return node.bytes.toLowerCase();
    if (node.prim === "Some" && Array.isArray(node.args) && node.args.length === 1) {
      return decodeMichelsonBytes(node.args[0]);
    }
    if (node.prim === "None") return null;
  }
  throw new KeelRpcError("Unexpected Michelson view result.", "decode.michelson");
}

function normalizedObjectId(objectId: string): string {
  const body = objectId.startsWith("0x") ? objectId.slice(2) : objectId;
  if (!/^[0-9a-fA-F]{64}$/u.test(body)) throw new KeelRpcError("objectId must be 32 bytes.", "request.objectId");
  return body.toLowerCase();
}

export function createKeelRpcClient(options: KeelRpcClientOptions): KeelRpcClient {
  const { family } = options;
  if (family !== "ethereum" && family !== "tezos") {
    throw new TypeError(`Unsupported RPC family ${String(family)}.`);
  }
  if (options.endpoints.length === 0) throw new RangeError("At least one RPC endpoint is required.");

  const hosts = hostsOf(options.hostList);
  const policy = { allowPrivateNetworkHosts: options.allowPrivateNetworkHosts ?? false };
  // Every endpoint is checked once, here. A client that exists is a client whose
  // endpoints governance blessed, so no call site has to remember to check.
  const endpoints = options.endpoints.map((endpoint) =>
    assertKeelRpcUrl(endpoint, hosts, policy).replace(/\/+$/u, ""),
  );

  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const confirmations = options.confirmations ?? DEFAULT_TEZOS_CONFIRMATIONS;
  const list = options.hostList === undefined || Array.isArray(options.hostList)
    ? undefined
    : (options.hostList as KeelRpcHostList);

  let servedBy: string | undefined;
  let reads = 0;

  async function attempt<T>(run: (endpoint: string) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const endpoint of endpoints) {
      try {
        const value = await run(endpoint);
        servedBy = endpoint;
        reads += 1;
        return value;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error
      ? last
      : new KeelRpcError("Every RPC endpoint failed.", "transport.exhausted");
  }

  async function request(endpoint: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await doFetch(`${endpoint}${path}`, {
        ...(body === undefined
          ? { method: "GET" }
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        throw new KeelRpcError(
          `HTTP ${response.status} from ${redactRpcUrl(endpoint)}.`,
          "transport.http",
          redactRpcUrl(endpoint),
        );
      }
      const text = await response.text();
      if (text.length > maxResponseBytes * 2 + 1024) {
        throw new KeelRpcError("RPC response exceeds the configured limit.", "limit.response-bytes");
      }
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async function jsonRpc(endpoint: string, method: string, params: readonly unknown[]): Promise<string> {
    const body = (await request(endpoint, "", { jsonrpc: "2.0", id: 1, method, params })) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error !== undefined) {
      throw new KeelRpcError(
        `${method} failed: ${body.error.message ?? "node returned an error"}.`,
        "rpc.error",
        redactRpcUrl(endpoint),
      );
    }
    if (typeof body.result !== "string") {
      throw new KeelRpcError(`${method} returned no result.`, "rpc.empty", redactRpcUrl(endpoint));
    }
    return body.result;
  }

  function requireFamily(expected: KeelRpcFamily, method: string): void {
    if (family !== expected) {
      throw new KeelRpcError(`${method} is a ${expected} read; this client is ${family}.`, "family.mismatch");
    }
  }

  const client: KeelRpcClient = {
    family,

    async call(callRequest: KeelEthCall): Promise<string> {
      requireFamily("ethereum", "call");
      const block = callRequest.block ?? "latest";
      return attempt((endpoint) =>
        jsonRpc(endpoint, "eth_call", [{ to: callRequest.to, data: callRequest.data }, block]),
      );
    },

    async view(viewRequest: KeelTezosView): Promise<unknown> {
      requireFamily("tezos", "view");
      const block = viewRequest.block ?? `head~${confirmations}`;
      return attempt(async (endpoint) => {
        const result = (await request(
          endpoint,
          `/chains/main/blocks/${block}/helpers/scripts/run_script_view`,
          {
            contract: viewRequest.contract,
            view: viewRequest.view ?? KEEL_TEZOS_OBJECT_VIEW,
            input: viewRequest.input,
            ...(options.network === undefined ? {} : { chain_id: options.network }),
            unparsing_mode: "Readable",
          },
        )) as { data?: unknown };
        if (result.data === undefined) {
          throw new KeelRpcError("Script view returned no data.", "rpc.empty", redactRpcUrl(endpoint));
        }
        return result.data;
      });
    },

    async haulObject(store: string, objectId: string): Promise<Uint8Array> {
      const id = normalizedObjectId(objectId);
      if (family === "ethereum") {
        const result = await client.call({ to: store, data: `${KEEL_READ_OBJECT_SELECTOR}${id}` });
        return decodeAbiBytes(result, maxResponseBytes);
      }
      const data = await client.view({ contract: store, input: { bytes: id } });
      const hex = decodeMichelsonBytes(data);
      if (hex === null) throw new KeelRpcError(`Object ${objectId} is not held by ${store}.`, "object.missing");
      return hexToBytes(hex);
    },

    async haulObjectVerified(store: string, objectId: string, integrity: Integrity): Promise<Uint8Array> {
      const bytes = await client.haulObject(store, objectId);
      if (!(await verifyIntegrity(bytes, integrity))) {
        // The node answered, and answered with something else. Which node it
        // was matters to whoever has to go ask why.
        throw new KeelRpcError(
          `Object ${objectId} did not hash to its committed digest.`,
          "object.digest-mismatch",
          servedBy === undefined ? undefined : redactRpcUrl(servedBy),
        );
      }
      return bytes;
    },

    disclosure(): KeelRpcDisclosure {
      return {
        family,
        chain: family === "ethereum"
          ? `eip155:${options.chainId ?? "unknown"}`
          : `tezos:${options.network ?? "unknown"}`,
        endpoints: endpoints.map(redactRpcUrl),
        ...(servedBy === undefined ? {} : { servedBy: redactRpcUrl(servedBy) }),
        ...(list === undefined
          ? {}
          : {
              hostListRevision: list.revision,
              hostListEpoch: list.epoch,
              hostListStale: list.epoch !== list.currentEpoch,
            }),
        reads,
      };
    },
  };

  return client;
}
