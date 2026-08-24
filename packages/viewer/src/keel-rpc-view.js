/**
 * The Keel RPC module, in the form a sealed on-chain document can carry.
 *
 * `@keel/protocol`'s `keel-rpc` is the same idea for everything that runs off
 * chain — the SDK, the MCP server, a build script, a host. A viewer document
 * stored in KeelHold cannot import a package: it is one bundled file, every
 * byte of it costs about 225 gas forever, and it has to run inside whatever
 * sandbox a marketplace puts it in. So this is the small twin, deliberately
 * dependency-free, deliberately the same shape:
 *
 *     const chain = createKeelChain({ rpc, keelHold, hosts });
 *     const artwork = await chain.haulObject(assetObjectId);
 *
 * A script that reads an object writes the same line here as it would in Node.
 * The JSON-RPC envelope, the endpoint failover, and the ABI decoding are the
 * module's problem, not the artwork's.
 *
 * ## Two things this deliberately does not do
 *
 * It does not pretend the read is free of hosts. `disclosure()` names the
 * endpoint that answered so the panel can show it. Hiding the plumbing from
 * whoever writes a viewer is ergonomics; hiding it from whoever is deciding
 * whether to trust the token is a lie, and a viewer that says "nothing is
 * fetched" while holding a socket open is worse than one that admits it.
 *
 * It does not become a second opinion on which hosts are acceptable.
 * `remoteUrlAllowed` in `@keel/protocol` is the authority on that, and
 * `rpcHostAllowed` below is a byte-for-byte mirror of its rules for the one
 * case that cannot import it. `tests/keel-rpc-policy.test.mjs` runs both
 * over the same vector table, so the mirror cannot drift without the gate
 * failing.
 */

/** `KeelHold.haulObject(bytes32)`. */
export const KEEL_READ_OBJECT_SELECTOR = "0xed12d693";

/**
 * The governed host list as it stood when this document was sealed. A document
 * is immutable, so this is a snapshot, not a live read — `revision` and `epoch`
 * are stamped alongside it precisely so a reader can tell how old the snapshot
 * is and go compare it against `KeelManager.rpcHostList` themselves.
 */
export const KEEL_VIEW_RPC_HOSTS = [
  "publicnode.com",
  "rpc.thirdweb.com",
  "rpc.ankr.com",
  "cloudflare-eth.com",
  "base.org",
  "g.alchemy.com",
  "infura.io",
  "quiknode.pro",
  "drpc.org",
];

/** Mirror of `remoteUrlAllowed(url, hosts, false)`. See the header note. */
export function rpcHostAllowed(url, hosts) {
  if (!hosts || hosts.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== "https:") return false;
  // Private, loopback, link-local, and carrier-grade-NAT hosts: a sealed
  // document must never be usable to probe the reader's own network. A faithful
  // port of `isPrivateNetworkHost`, including the parts that look redundant —
  // the 0-255 octet bound matters, because without it a malformed literal like
  // "999.1.1.1" is refused here and allowed there, and a mirror that disagrees
  // anywhere is a mirror nobody can reason about.
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const parts = host.split(".");
  const octets = parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part))
    ? parts.map(Number)
    : null;
  const privateV4 = (values) => {
    if (values === null || values.some((value) => value < 0 || value > 255)) return false;
    const [a, b] = values;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19));
  };
  if (privateV4(octets)) return false;
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return false;
    if (host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host)) return false;
    const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      const values = mapped[1].split(".").map(Number);
      if (privateV4(values.every((value) => Number.isInteger(value)) ? values : null)) return false;
    }
  }
  return hosts.some((entry) => {
    if (entry.startsWith("https://") || entry.startsWith("http://")) {
      let allowed;
      try {
        allowed = new URL(entry);
      } catch {
        return false;
      }
      const prefix = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
      return parsed.origin === allowed.origin
        && (parsed.pathname === allowed.pathname || parsed.pathname.startsWith(prefix));
    }
    return parsed.hostname === entry || parsed.hostname.endsWith(`.${entry}`);
  });
}

/** Origins only: an endpoint URL routinely carries an API key in its path. */
export function redactEndpoint(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && parsed.search === "" ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return "unreadable endpoint";
  }
}

/**
 * A chain the document can read, with the transport underneath.
 *
 * @param rpc         one endpoint, or several to fail over between
 * @param keelHold  the store `haulObject` reads from
 * @param hosts       the governed list; endpoints outside it are dropped, not
 *                    used and reported afterwards
 */
export function createKeelChain({ rpc, keelHold, hosts = KEEL_VIEW_RPC_HOSTS, listRevision = 0, listEpoch = 0, fetchImpl }) {
  const candidates = (Array.isArray(rpc) ? rpc : [rpc]).filter((url) => typeof url === "string" && url.length > 0);
  const endpoints = candidates.filter((url) => rpcHostAllowed(url, hosts));
  const rejected = candidates.filter((url) => !rpcHostAllowed(url, hosts));
  const request = fetchImpl ?? ((...args) => fetch(...args));
  let servedBy = null;
  let reads = 0;

  async function rpcCall(method, params) {
    let last = null;
    for (const endpoint of endpoints) {
      try {
        const response = await request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body = await response.json();
        if (body.error || typeof body.result !== "string") throw new Error("node returned no result");
        servedBy = endpoint;
        reads += 1;
        return body.result;
      } catch (error) {
        last = error;
      }
    }
    throw last ?? new Error("no permitted RPC endpoint");
  }

  return {
    get endpointCount() {
      return endpoints.length;
    },

    /** An arbitrary read, shaped like the contract call it is. */
    call(to, data) {
      return rpcCall("eth_call", [{ to, data }, "latest"]);
    },

    /**
     * The bytes of one Keel object. This is the whole reason a hybrid
     * document is small: the artwork stays a referenced object on chain instead
     * of a quarter-megabyte of base64 inside every `animation_url`.
     */
    async haulObject(objectId, store = keelHold) {
      const id = String(objectId).replace(/^0x/, "").padStart(64, "0");
      const result = await this.call(store, `${KEEL_READ_OBJECT_SELECTOR}${id}`);
      const hex = result.slice(2);
      const length = parseInt(hex.slice(64, 128), 16);
      if (!Number.isFinite(length)) throw new Error("object length is unreadable");
      const body = hex.slice(128, 128 + length * 2);
      if (body.length !== length * 2) throw new Error("object is shorter than it claims");
      return Uint8Array.from(body.match(/../g) || [], (byte) => parseInt(byte, 16));
    },

    /** What the panel shows about how these bytes were obtained. */
    disclosure() {
      return {
        endpoints: endpoints.map(redactEndpoint),
        rejected: rejected.map(redactEndpoint),
        servedBy: servedBy === null ? null : redactEndpoint(servedBy),
        listRevision,
        listEpoch,
        reads,
      };
    },
  };
}
