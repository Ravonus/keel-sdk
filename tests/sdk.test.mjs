import test from "node:test";
import assert from "node:assert/strict";

import {
  createKeelChunkPlan,
  createKeelNetworkDocument,
  createKeelViewerComposition,
  resolveKeelNetworkPath,
  keelTokenJSONURI,
  keelTokenURIFromJSON,
} from "../packages/sdk/dist/index.js";

const bytes32 = (value) => `0x${value.repeat(64).slice(0, 64)}`;

test("Keel network documents apply a default version while explicit routes override it", () => {
  const document = createKeelNetworkDocument("sepolia-eth", 3);
  const relative = resolveKeelNetworkPath("module/three.js", document);
  const explicit = resolveKeelNetworkPath("/base/v2/content/tree-state", document);
  assert.equal(relative.target.alias, "sepolia-eth");
  assert.equal(relative.version, 3);
  assert.equal(relative.explicitNetwork, false);
  assert.equal(explicit.target.alias, "base");
  assert.equal(explicit.version, 2);
  assert.equal(explicit.path, "content/tree-state");
});

test("Keel viewer composition preserves slots, aliases, and owner-state binding", () => {
  const composition = createKeelViewerComposition({
    network: "base-sepolia",
    slots: [{
      resource: "viewer",
      objectId: bytes32("a"),
      objectRevision: 1,
      aliases: ["keel://module/three.js"],
    }, {
      resource: "state",
      objectId: bytes32("b"),
      objectRevision: 2,
      aliases: ["keel://data/tree-state"],
    }],
    state: {
      registry: "0x1111111111111111111111111111111111111111",
      policyId: bytes32("c"),
      resource: "state",
    },
  });
  assert.equal(composition.network.defaultNetwork, "base-sepolia");
  assert.deepEqual(composition.slotResources, ["viewer", "state"]);
  assert.equal(composition.aliases.get("keel://module/three.js"), "viewer");
  assert.equal(composition.state?.resource, "state");
});

test("Keel chunk plans are KeelHold-ready and never exceed the carrier limit", async () => {
  const bytes = new Uint8Array(23_001);
  bytes.fill(7);
  const plan = await createKeelChunkPlan(bytes, {
    objectName: "tree-state.json",
    mediaType: "application/json",
    keccak256: async (chunk) => `0x${Buffer.from(chunk).toString("hex").padEnd(64, "0").slice(0, 64)}`,
  });
  assert.equal(plan.protocol, "keel-chunk-plan@1");
  assert.equal(plan.chunks.length, 2);
  assert.ok(plan.chunks.every((chunk) => chunk.bytes.byteLength <= 23_000));
  assert.ok(plan.chunks.every((chunk) => chunk.slugId?.startsWith("0x")));
  assert.equal(plan.integrity.byteLength, 23_001);
});

test("Keel metadata helpers expose the web3 tokenJSON route and legacy tokenURI", () => {
  const json = '{"name":"My NFT","description":"é","image":"..."}';
  assert.equal(
    keelTokenJSONURI({
      chainId: 11_155_111,
      contract: "0xAbCdEfabcdefABCDEFabcdefabcdefabcdefABCD",
      tokenId: 7,
    }),
    "web3://0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:11155111/tokenJSON/7",
  );
  assert.equal(
    keelTokenURIFromJSON(json),
    `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`,
  );
});
