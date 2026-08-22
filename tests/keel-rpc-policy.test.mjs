import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_KEEL_RPC_HOSTS,
  KEEL_DEFAULT_RPC_HOSTS,
  createKeelRpcClient,
  createIntegrity,
  decodeAbiBytes,
  decodeMichelsonBytes,
  normalizeKeelRpcHosts,
  redactRpcUrl,
  remoteUrlAllowed,
  keelRpcHostList,
  keelRpcHostListDigest,
  keelRpcHostListPreimage,
  keelRpcHostListStale,
  keelRpcUrlAllowed,
} from "../packages/protocol/dist/index.js";
import { rpcHostAllowed } from "../packages/viewer/src/keel-rpc-view.js";

const text = (bytes) => new TextDecoder().decode(bytes);

// ---------------------------------------------------------------- host list

test("the host list accepts exactly what the contract accepts", () => {
  assert.deepEqual(normalizeKeelRpcHosts(["publicnode.com", "https://eth.example.org/v1/"]), [
    "publicnode.com",
    "https://eth.example.org/v1/",
  ]);
  for (const bad of [
    [],
    ["ex ample.com"],
    ["example.com/v1"],
    ["example.com:8545"],
    ["example.com?k=1"],
    ['ex"ample.com'],
    ["http://example.com"],
    ["user@example.com"],
    [""],
    ["example.com", "example.com"],
    Array.from({ length: MAX_KEEL_RPC_HOSTS + 1 }, (_unused, index) => `h${index}.example.com`),
  ]) {
    assert.throws(() => normalizeKeelRpcHosts(bad), `accepted ${JSON.stringify(bad)}`);
  }
});

test("the digest preimage is byte-identical to the one KeelManager hashes", async () => {
  const hosts = ["publicnode.com", "https://eth.example.org/v1/"];
  // Pinned against `testRpcHostListDigestIsTheReproduciblePreimageAndTracksEveryInput`
  // in packages/contracts/test/KeelManager.t.sol. If these two ever
  // disagree a published digest stops meaning anything, so both sides assert
  // the same literal rather than each computing its own idea of the format.
  assert.equal(
    text(keelRpcHostListPreimage(hosts, 7, 3)),
    "keel-rpc-host-list@1\n7\n3\npublicnode.com\nhttps://eth.example.org/v1/\n",
  );
  assert.equal(
    await keelRpcHostListDigest(hosts, 7, 3),
    "0x790b611963878ecb64856104a6e94ba4a60d3e7d9f66bbfd66a2b1b8be852a49",
  );
  assert.equal(text(keelRpcHostListPreimage(["publicnode.com"], 0, 0)), "keel-rpc-host-list@1\n0\n0\npublicnode.com\n");
  // Revision, epoch, and membership each move it.
  const base = await keelRpcHostListDigest(hosts, 7, 3);
  assert.notEqual(base, await keelRpcHostListDigest(hosts, 8, 3));
  assert.notEqual(base, await keelRpcHostListDigest(hosts, 7, 4));
  assert.notEqual(base, await keelRpcHostListDigest(["publicnode.com"], 7, 3));
});

test("a list written by a rotated-out roster reads as stale rather than as policy", () => {
  const current = keelRpcHostList({ hosts: ["publicnode.com"], revision: 3, epoch: 2, currentEpoch: 2 });
  assert.equal(keelRpcHostListStale(current), false);
  const rotated = keelRpcHostList({ hosts: ["publicnode.com"], revision: 3, epoch: 2, currentEpoch: 3 });
  assert.equal(keelRpcHostListStale(rotated), true);
  // Stale is a disclosure, not an outage: the hosts a past quorum blessed are
  // still the hosts it blessed, and reads keep working.
  assert.equal(keelRpcUrlAllowed("https://eth.publicnode.com", rotated.hosts), true);
});

test("an empty RPC list denies, where an empty gateway allowlist would not", () => {
  // The one rule this module adds on top of remoteUrlAllowed, and the reason
  // it is added: "no gateway allowlist configured" is a sane default for an
  // optional mirror, and "governance has blessed no endpoint" is not.
  assert.equal(remoteUrlAllowed("https://anything.example", []), true);
  assert.equal(keelRpcUrlAllowed("https://anything.example", []), false);
  assert.equal(keelRpcUrlAllowed("https://anything.example", undefined), false);
});

test("endpoint matching is remoteUrlAllowed's, not a second opinion", () => {
  const hosts = ["publicnode.com", "https://eth.example.org/v1/"];
  for (const [url, expected] of [
    ["https://ethereum-sepolia-rpc.publicnode.com", true],
    ["https://publicnode.com", true],
    ["https://eth.example.org/v1/key", true],
    ["https://eth.example.org/v2/key", false],
    ["https://notpublicnode.com", false],
    ["http://ethereum-sepolia-rpc.publicnode.com", false],
    ["https://user:pw@ethereum-sepolia-rpc.publicnode.com", false],
    ["not a url", false],
  ]) {
    assert.equal(keelRpcUrlAllowed(url, hosts), expected, url);
    assert.equal(remoteUrlAllowed(url, hosts, false), expected, `remoteUrlAllowed: ${url}`);
  }
});

// A sealed on-chain document cannot import a package, so `keel-rpc-view.js`
// carries its own copy of these rules. A copy that can drift is worse than no
// copy at all, so the same table runs through both and they must agree.
test("the sealed-document mirror agrees with remoteUrlAllowed on every vector", () => {
  const hosts = ["publicnode.com", "https://eth.example.org/v1/", "example.co.uk"];
  const vectors = [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://publicnode.com",
    "https://a.b.publicnode.com",
    "https://publicnode.com.evil.example",
    "https://eth.example.org/v1/",
    "https://eth.example.org/v1/abc123",
    "https://eth.example.org/v1x/abc",
    "https://eth.example.org/",
    "https://example.co.uk",
    "https://sub.example.co.uk",
    "http://publicnode.com",
    "https://user@publicnode.com",
    "https://user:pw@publicnode.com",
    "ftp://publicnode.com",
    "https://localhost",
    "https://foo.localhost",
    "https://service.local",
    "https://127.0.0.1",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://172.32.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://8.8.8.8",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[::ffff:192.168.0.1]",
    "https://[::ffff:8.8.8.8]",
    "https://[2001:4860:4860::8888]",
    "https://999.1.1.1",
    "https://256.1.1.1",
    "https://0.0.0.0",
    "https://223.255.255.255",
    "https://224.0.0.1",
    "not a url",
    "",
  ];
  for (const url of vectors) {
    assert.equal(
      rpcHostAllowed(url, hosts),
      remoteUrlAllowed(url, hosts, false),
      `mirror drifted on ${JSON.stringify(url)}`,
    );
  }

  // The loop above mostly proves the two agree on *rejection*, which they would
  // even if the network rules diverged wildly. These run each vector against a
  // list that names its own hostname, so the allowlist always matches and the
  // private-network rules are the only thing left deciding. That is where a
  // mirror actually drifts: an earlier draft refused every IPv6 literal and
  // every out-of-range octet, and only this loop tells the two apart.
  for (const url of vectors) {
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    if (hostname.length === 0) continue;
    assert.equal(
      rpcHostAllowed(url, [hostname]),
      remoteUrlAllowed(url, [hostname], false),
      `mirror drifted on ${JSON.stringify(url)} against its own hostname`,
    );
  }
  assert.equal(rpcHostAllowed("https://publicnode.com", []), false);
});

test("a rejected endpoint is reported by origin, never with its key", () => {
  assert.equal(redactRpcUrl("https://eth-mainnet.g.alchemy.com/v2/SECRETKEY"), "https://eth-mainnet.g.alchemy.com/…");
  assert.equal(redactRpcUrl("https://ethereum-rpc.publicnode.com"), "https://ethereum-rpc.publicnode.com");
  assert.ok(!redactRpcUrl("https://x.infura.io/v3/SECRETKEY").includes("SECRETKEY"));
});

// ------------------------------------------------------------- the RPC module

const ETH = "https://ethereum-sepolia-rpc.publicnode.com";
const STORE = "0xe795c99e4e4438434958799dfb6c4ca8f43d9bc8";
const OBJECT = `0x${"ab".repeat(32)}`;

function abiBytes(payload) {
  const hex = Buffer.from(payload).toString("hex");
  const length = payload.length.toString(16).padStart(64, "0");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${length}${padded}`;
}

test("a client cannot be built around an endpoint governance has not blessed", () => {
  assert.throws(
    () => createKeelRpcClient({ family: "ethereum", endpoints: ["https://rogue.example/rpc"] }),
    /not on the governed Keel host list/u,
  );
  // The refusal names the origin, not the path that may carry a key.
  assert.throws(
    () => createKeelRpcClient({ family: "ethereum", endpoints: ["https://rogue.example/rpc/SECRETKEY"] }),
    (error) => !error.message.includes("SECRETKEY"),
  );
  assert.doesNotThrow(() => createKeelRpcClient({ family: "ethereum", endpoints: [ETH] }));
  assert.throws(() => createKeelRpcClient({ family: "ethereum", endpoints: [] }), /at least one/iu);
});

test("haulObject reads like a contract call and decodes what the node returns", async () => {
  const artwork = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  let seen;
  const chain = createKeelRpcClient({
    family: "ethereum",
    chainId: 11155111,
    endpoints: [ETH],
    fetchImpl: async (url, init) => {
      seen = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: abiBytes(artwork) }), { status: 200 });
    },
  });
  assert.deepEqual(await chain.haulObject(STORE, OBJECT), artwork);
  assert.equal(seen.method, "eth_call");
  assert.equal(seen.params[0].to, STORE);
  assert.equal(seen.params[0].data, `0x5ea5306e${"ab".repeat(32)}`);
});

test("failover moves to the next endpoint and the disclosure names the one that answered", async () => {
  const artwork = new Uint8Array([1, 2, 3, 4]);
  const chain = createKeelRpcClient({
    family: "ethereum",
    chainId: 1,
    endpoints: ["https://ethereum-rpc.publicnode.com", "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY"],
    fetchImpl: async (url) => {
      if (url.includes("publicnode")) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: abiBytes(artwork) }), { status: 200 });
    },
  });
  assert.deepEqual(await chain.haulObject(STORE, OBJECT), artwork);
  const disclosure = chain.disclosure();
  assert.equal(disclosure.servedBy, "https://eth-mainnet.g.alchemy.com/…");
  assert.equal(disclosure.reads, 1);
  assert.equal(disclosure.chain, "eip155:1");
  assert.ok(!JSON.stringify(disclosure).includes("SECRETKEY"));
});

test("a node that answers with other bytes is caught, and the answer names it", async () => {
  const artwork = new Uint8Array([9, 9, 9, 9]);
  const integrity = await createIntegrity(artwork);
  const chain = createKeelRpcClient({
    family: "ethereum",
    endpoints: [ETH],
    fetchImpl: async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: abiBytes(new Uint8Array([9, 9, 9, 8])) }), {
        status: 200,
      }),
  });
  await assert.rejects(() => chain.haulObjectVerified(STORE, OBJECT, integrity), /did not hash to its committed digest/u);
});

test("a Tezos client reads the same objects through the same call", async () => {
  const artwork = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  let seen;
  const chain = createKeelRpcClient({
    family: "tezos",
    network: "NetXdQprcVkpaWU",
    endpoints: ["https://rpc.tzkt.io/mainnet"],
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: { bytes: Buffer.from(artwork).toString("hex") } }), { status: 200 });
    },
  });
  assert.deepEqual(await chain.haulObject("KT1TestStoreAddressAAAAAAAAAAAAAAAA", OBJECT), artwork);
  assert.match(seen.url, /run_script_view$/u);
  assert.equal(seen.body.view, "read_keel_object");
  assert.equal(seen.body.chain_id, "NetXdQprcVkpaWU");
  assert.equal(chain.disclosure().chain, "tezos:NetXdQprcVkpaWU");
  // A read shaped for the wrong family is refused rather than mangled.
  await assert.rejects(() => chain.call({ to: STORE, data: "0x" }), /this client is tezos/u);
});

test("decoders refuse a truncated or absent object instead of returning a short one", () => {
  const artwork = new Uint8Array([1, 2, 3, 4, 5]);
  assert.deepEqual(decodeAbiBytes(abiBytes(artwork), 1024), artwork);
  assert.throws(() => decodeAbiBytes(abiBytes(artwork), 4), /limit is 4/u);
  assert.throws(() => decodeAbiBytes("0x1234", 1024), /too short/u);
  const truncated = abiBytes(artwork).slice(0, 132);
  assert.throws(() => decodeAbiBytes(truncated, 1024), /shorter than the length/u);
  assert.equal(decodeMichelsonBytes({ prim: "None" }), null);
  assert.equal(decodeMichelsonBytes({ prim: "Some", args: [{ bytes: "AB" }] }), "ab");
  assert.throws(() => decodeMichelsonBytes({ prim: "Pair" }), /Unexpected Michelson/u);
});

test("the genesis list is a usable default and covers both families", () => {
  assert.deepEqual(normalizeKeelRpcHosts([...KEEL_DEFAULT_RPC_HOSTS]), [...KEEL_DEFAULT_RPC_HOSTS]);
  assert.equal(keelRpcUrlAllowed("https://ethereum-sepolia-rpc.publicnode.com"), true);
  assert.equal(keelRpcUrlAllowed("https://rpc.tzkt.io/mainnet"), true);
  assert.equal(keelRpcUrlAllowed("https://rogue.example/rpc"), false);
});
