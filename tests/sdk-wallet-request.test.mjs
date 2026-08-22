import test from "node:test";
import assert from "node:assert/strict";

import {
  KEEL_WALLET_REQUEST_PROTOCOL,
  createKeelWalletRequest,
  decodeKeelWalletRequestQr,
  encodeKeelWalletRequestQr,
  parseKeelWalletRequest,
  verifyKeelWalletRequest,
} from "../packages/sdk/dist/index.js";

const ethereum = {
  protocol: KEEL_WALLET_REQUEST_PROTOCOL,
  requestId: "claim-001",
  label: "Publish the verified Keel manifest",
  family: "ethereum",
  chainId: 1,
  to: "0x1111111111111111111111111111111111111111",
  data: "0xAABB00",
  valueWei: "0",
  transport: "ledger",
};

const tezos = {
  protocol: KEEL_WALLET_REQUEST_PROTOCOL,
  requestId: "claim-002",
  label: "Publish the verified Tezos manifest",
  family: "tezos",
  network: "ghostnet",
  destination: "KT1AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA",
  amountMutez: "0",
  entrypoint: "publish",
  parameters: '{"prim":"Pair","args":[{"int":"7"},{"int":"8"}]}',
  transport: "tezconnect",
};

test("wallet requests normalize Ethereum fields and verify a canonical integrity envelope", async () => {
  const envelope = await createKeelWalletRequest(ethereum);
  assert.equal(envelope.request.family, "ethereum");
  assert.equal(envelope.request.to, ethereum.to.toLowerCase());
  assert.equal(envelope.request.data, "0xaabb00");
  assert.equal(envelope.request.valueWei, "0");
  const verified = await verifyKeelWalletRequest(envelope);
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.integrity, envelope.integrity);
  const tampered = { ...envelope, request: { ...envelope.request, valueWei: "1" } };
  assert.equal((await verifyKeelWalletRequest(tampered)).valid, false);
});

test("Tezos requests preserve chain parity and canonicalize Micheline parameters", async () => {
  const request = parseKeelWalletRequest(tezos);
  assert.equal(request.family, "tezos");
  assert.equal(request.destination, tezos.destination);
  assert.equal(request.amountMutez, "0");
  assert.equal(request.parameters, '{"args":[{"int":"7"},{"int":"8"}],"prim":"Pair"}');
  const envelope = await createKeelWalletRequest(request);
  assert.equal((await verifyKeelWalletRequest(envelope)).valid, true);
});

test("wallet envelopes round-trip through QR payloads without executing a connector", async () => {
  const envelope = await createKeelWalletRequest(ethereum);
  const payload = await encodeKeelWalletRequestQr(envelope);
  assert.match(payload, /^keel-wallet-request:[A-Za-z0-9_-]+$/u);
  const decoded = await decodeKeelWalletRequestQr(payload);
  assert.deepEqual(decoded, envelope);
  await assert.rejects(() => decodeKeelWalletRequestQr(payload.replace(/.$/u, payload.endsWith("A") ? "B" : "A")), /integrity|JSON|base64/u);
});

test("wallet request validation rejects mixed or unsafe chain fields", async () => {
  await assert.rejects(() => createKeelWalletRequest({ ...ethereum, chainId: 0 }), /chainId/u);
  await assert.rejects(() => createKeelWalletRequest({ ...ethereum, data: "0x0" }), /even-length/u);
  await assert.rejects(() => createKeelWalletRequest({ ...tezos, destination: "not-a-tezos-address" }), /Tezos/u);
  await assert.rejects(() => createKeelWalletRequest({ ...ethereum, transport: "tezconnect" }), /only compatible with Tezos/u);
  await assert.rejects(() => createKeelWalletRequest({ ...tezos, transport: "injected" }), /only compatible with Ethereum/u);
  await assert.rejects(() => createKeelWalletRequest({ ...tezos, parameters: "7" }), /Micheline|object/u);
  await assert.rejects(() => createKeelWalletRequest({ ...tezos, parameters: '{"int":"01"}' }), /int/u);
  await assert.rejects(() => createKeelWalletRequest({ ...ethereum, transport: "tezconnect", name: "ignored" }), /not supported/u);
});
