/**
 * The governed global list of RPC hosts a Keel reader may talk to.
 *
 * Keel already governs which *gateways* may serve IPFS, IPNS, and Arweave
 * bytes (`source-policy` in `@keel/viewer`). It did not govern the endpoint a
 * viewer reads the chain through, even though that endpoint is the single host
 * every hybrid document depends on: a viewer that fetches its artwork with
 * `eth_call` is trusting whoever answers that call to return the object it
 * asked for. The bytes are still checkable — they are content-addressed, and
 * the document hashes them — but *which* host is consulted, and whether a
 * marketplace can quietly point a sealed document at its own node, is a policy
 * question, and policy questions here are settled by governance.
 *
 * So there is exactly one list, it lives on chain, and it moves through the
 * `KeelManager` governor quorum like every other protocol constant:
 *
 *     configureRpcHostList(hosts, expectedRevision)   -- onlySelf, so the only
 *     way in is executeGovernance() with a two-thirds governor envelope.
 *
 * The list is stamped with the `governanceEpoch` it was accepted under, so a
 * governor rotation makes every list written by the previous roster visibly
 * stale rather than silently authoritative. `keelRpcHostListStale` is that
 * check; what a reader does about it is the reader's call.
 *
 * Matching is NOT reimplemented here. `remoteUrlAllowed` is the one place that
 * decides whether a URL is reachable and whether an allowlist admits it, and
 * this module adds exactly one rule on top of it: an empty list denies
 * everything. An empty *gateway* allowlist means "no allowlist configured", a
 * sensible default for optional mirrors. An empty *RPC* list means governance
 * has not blessed an endpoint, and reading the chain through an unblessed host
 * is the thing this list exists to prevent.
 */

import { remoteUrlAllowed } from "./remote-url-policy.js";

export const KEEL_RPC_HOST_LIST_PROTOCOL = "keel-rpc-host-list@1" as const;

/** First line of the digest preimage. Mirrors `KeelManager.RPC_HOST_LIST_DOMAIN`. */
export const KEEL_RPC_HOST_LIST_DOMAIN = "keel-rpc-host-list@1" as const;

/** Mirrors `KeelManager.MAX_RPC_HOSTS`. */
export const MAX_KEEL_RPC_HOSTS = 32;
/** Mirrors `KeelManager.MAX_RPC_HOST_BYTES`. */
export const MAX_KEEL_RPC_HOST_BYTES = 128;

/**
 * The genesis list: the endpoints this repository already reads through, plus
 * the major keyed providers an operator is likely to bring their own key for.
 * It is a starting point, not a judgement — governance narrows or extends it,
 * and a deployment that has published its own list should read that instead of
 * falling back here.
 */
export const KEEL_DEFAULT_RPC_HOSTS: readonly string[] = Object.freeze([
  // Ethereum and EVM L2s.
  "publicnode.com",
  "rpc.thirdweb.com",
  "rpc.ankr.com",
  "cloudflare-eth.com",
  "base.org",
  "g.alchemy.com",
  "infura.io",
  "quiknode.pro",
  "drpc.org",
  // Tezos. One list covers both families: it governs which hosts may be
  // reached, and the client governs which protocol is spoken to them.
  "rpc.tzkt.io",
  "ecadinfra.com",
  "teztnets.com",
  "marigold.dev",
]);

/**
 * Convenience for local chains. Never merged in automatically: an anvil node on
 * the reader's own machine is exactly the kind of host the private-network rule
 * refuses by default, so opting in has to be deliberate on both axes.
 */
export const KEEL_LOCAL_RPC_HOSTS: readonly string[] = Object.freeze(["localhost", "127.0.0.1"]);

export interface KeelRpcHostList {
  readonly protocol: typeof KEEL_RPC_HOST_LIST_PROTOCOL;
  readonly hosts: readonly string[];
  /** Bumped by every accepted `configureRpcHostList`. */
  readonly revision: number;
  /** The `governanceEpoch` this list was accepted under. */
  readonly epoch: number;
  /** The manager's `governanceEpoch` when the list was read. */
  readonly currentEpoch: number;
  /** `sha256(preimage)`, as the manager stored it. */
  readonly digest?: string;
}

/** A host entry is printable, compact, and free of separators and quoting. */
const HOST_ENTRY = /^[!-~]+$/u;

function assertHostEntry(value: string, index: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`rpcHosts[${index}] must be a non-empty string.`);
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > MAX_KEEL_RPC_HOST_BYTES) {
    throw new RangeError(`rpcHosts[${index}] is ${bytes} bytes; the limit is ${MAX_KEEL_RPC_HOST_BYTES}.`);
  }
  // A direct mirror of `KeelManager._validateRpcHost`. The two are checked
  // against the same vector table in tests/keel-rpc-policy.test.mjs, because
  // a normalizer looser than the contract lets a payload through that reverts
  // on chain, and one stricter than it makes a governed list unreadable.
  if (!HOST_ENTRY.test(value) || /["'\\@]/u.test(value)) {
    throw new TypeError(
      `rpcHosts[${index}] must be printable ASCII without whitespace, quotes, backslashes, or credentials.`,
    );
  }
  const https = value.startsWith("https://") && value.length > "https://".length;
  // A bare entry is a registrable hostname and nothing else. `remoteUrlAllowed`
  // matches those against a URL's hostname alone, so an entry carrying a port,
  // a path, a query, or a fragment could never match anything and would only
  // read as policy that is not being enforced.
  if (!https && /[/:?#]/u.test(value)) {
    throw new TypeError(`rpcHosts[${index}] must be a bare host or an https:// URL.`);
  }
  if (https) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.length === 0) throw new TypeError("empty host");
    } catch {
      throw new TypeError(`rpcHosts[${index}] is not a parseable https:// URL.`);
    }
  }
  return value;
}

/**
 * Validate a candidate list against exactly the rules the contract enforces, so
 * a governance payload that would revert on chain fails here first.
 */
export function normalizeKeelRpcHosts(hosts: readonly string[]): readonly string[] {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new RangeError("rpcHosts requires at least one entry.");
  if (hosts.length > MAX_KEEL_RPC_HOSTS) {
    throw new RangeError(`rpcHosts accepts at most ${MAX_KEEL_RPC_HOSTS} entries.`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    hosts.map((value, index) => {
      const entry = assertHostEntry(value, index);
      if (seen.has(entry)) throw new TypeError(`rpcHosts[${index}] duplicates an earlier entry.`);
      seen.add(entry);
      return entry;
    }),
  );
}

/**
 * The exact bytes the manager hashes. Mirrors `rpcHostListPreimage` there, byte
 * for byte, so a holder can recompute the published digest from the list alone:
 *
 *     keel-rpc-host-list@1\n<revision>\n<epoch>\n<host>\n<host>\n...
 */
export function keelRpcHostListPreimage(
  hosts: readonly string[],
  revision: number,
  epoch: number,
): Uint8Array {
  const entries = normalizeKeelRpcHosts(hosts);
  const header = `${KEEL_RPC_HOST_LIST_DOMAIN}\n${uint64(revision, "revision")}\n${uint64(epoch, "epoch")}\n`;
  return new TextEncoder().encode(`${header}${entries.map((entry) => `${entry}\n`).join("")}`);
}

function uint64(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer.`);
  return value.toString(10);
}

function hex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** `sha256(keelRpcHostListPreimage(...))` — what the manager stores. */
export async function keelRpcHostListDigest(
  hosts: readonly string[],
  revision: number,
  epoch: number,
): Promise<string> {
  const preimage = keelRpcHostListPreimage(hosts, revision, epoch);
  const digest = await crypto.subtle.digest("SHA-256", preimage as unknown as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

export interface KeelRpcHostListInput {
  readonly hosts: readonly string[];
  readonly revision?: number;
  readonly epoch?: number;
  readonly currentEpoch?: number;
  readonly digest?: string;
}

export function keelRpcHostList(input: KeelRpcHostListInput): KeelRpcHostList {
  const epoch = input.epoch ?? 0;
  return Object.freeze({
    protocol: KEEL_RPC_HOST_LIST_PROTOCOL,
    hosts: normalizeKeelRpcHosts(input.hosts),
    revision: uintValue(input.revision ?? 0, "revision"),
    epoch: uintValue(epoch, "epoch"),
    currentEpoch: uintValue(input.currentEpoch ?? epoch, "currentEpoch"),
    ...(input.digest === undefined ? {} : { digest: input.digest }),
  });
}

function uintValue(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer.`);
  return value;
}

/**
 * True when the roster that accepted this list is no longer the roster in
 * charge. Not an error on its own — the hosts named are still the hosts the
 * previous quorum blessed — but a reader that cares should say so out loud
 * rather than present a rotated-past list as current policy.
 */
export function keelRpcHostListStale(list: KeelRpcHostList): boolean {
  return list.epoch !== list.currentEpoch;
}

export interface KeelRpcUrlOptions {
  /**
   * Permit `http://` and private, loopback, or link-local hosts. Local chains
   * only. The endpoint must still appear in `hosts`; this relaxes the transport
   * and network rules, it does not bypass the list.
   */
  readonly allowPrivateNetworkHosts?: boolean;
}

/**
 * Whether an endpoint may be read through. Delegates every matching rule to
 * `remoteUrlAllowed`; the one rule added here is that an empty list denies.
 */
export function keelRpcUrlAllowed(
  url: string,
  hosts: readonly string[] = KEEL_DEFAULT_RPC_HOSTS,
  options: KeelRpcUrlOptions = {},
): boolean {
  if (hosts.length === 0) return false;
  return remoteUrlAllowed(url, hosts, options.allowPrivateNetworkHosts ?? false);
}

/** The same check, as a guard that returns the URL so it can be used inline. */
export function assertKeelRpcUrl(
  url: string,
  hosts: readonly string[] = KEEL_DEFAULT_RPC_HOSTS,
  options: KeelRpcUrlOptions = {},
): string {
  if (!keelRpcUrlAllowed(url, hosts, options)) {
    throw new Error(
      `RPC endpoint is not on the governed Keel host list: ${redactRpcUrl(url)}. ` +
        "Add it through KeelManager.configureRpcHostList, or pass the deployment's published list.",
    );
  }
  return url;
}

/**
 * Endpoint URLs routinely carry an API key in the path. Anything that reports
 * a rejected endpoint — an error message, a disclosure row, a log line — shows
 * the origin and drops the rest.
 */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && parsed.search === "" ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return "<unparseable endpoint>";
  }
}
