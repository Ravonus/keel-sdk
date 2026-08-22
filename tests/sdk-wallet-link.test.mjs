import test from "node:test";
import assert from "node:assert/strict";

import {
  createCollectionAuthorizationTypedData,
  createKeelWalletLink,
  parseKeelWalletLink,
  verifyKeelWalletLink,
} from "../packages/sdk/dist/index.js";

const account = "0x1111111111111111111111111111111111111111";
const agent = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const target = {
  chainId: 1,
  factoryAddress: factory,
  factoryVersion: `0x${"44".repeat(32)}`,
  creationCodeHash: `0x${"55".repeat(32)}`,
  operation: "keelFactory.castDie",
  configDigest: `0x${"66".repeat(32)}`,
  configEncoding: "keel-factory-config-keccak@1",
  authorizationNonce: "0",
};

function input(overrides = {}) {
  return {
    family: "ethereum",
    accountAddress: account,
    agentAddress: agent,
    target,
    scopes: ["prepare", "create-collection"],
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_003_600,
    nonce: "link-0",
    transport: "ledger",
    ...overrides,
  };
}

test("wallet link is an exact KeelFactory castDieFor review envelope", async () => {
  const link = await createKeelWalletLink(input());
  assert.equal(link.status, "review-only");
  assert.equal(link.approval, "not-granted");
  assert.equal(link.signing, "not-performed");
  assert.equal(link.submission, "not-performed");
  assert.equal(link.target.configEncoding, "keel-factory-config-keccak@1");
  assert.equal(link.target.authorizationNonce, "0");
  assert.deepEqual(link.scopes, ["create-collection", "prepare"]);
  const checked = await verifyKeelWalletLink(link, { nowSeconds: 1_800_000_100 });
  assert.equal(checked.valid, true);
  assert.equal(checked.expired, false);
  assert.equal(checked.notYetValid, false);
  assert.deepEqual(parseKeelWalletLink(link), link);
});

test("account authorization typed data exactly binds factory, account, agent, nonce, deadline, and config digest", () => {
  const typed = createCollectionAuthorizationTypedData(1, factory, {
    creator: account,
    agent,
    nonce: 0n,
    deadline: 1_800_003_600n,
    configDigest: target.configDigest,
  });
  assert.equal(typed.domain.name, "Keel Factory");
  assert.equal(typed.domain.version, "1");
  assert.equal(typed.primaryType, "CollectionAuthorization");
  assert.deepEqual(typed.message, { creator: account, agent, nonce: 0n, deadline: 1_800_003_600n, configDigest: target.configDigest });
  assert.throws(() => createCollectionAuthorizationTypedData(1, "0x0000000000000000000000000000000000000000", typed.message), /zero/u);
});

test("wallet links reject escalation, deployment mismatch, zero addresses, and long lifetimes", async () => {
  await assert.rejects(() => createKeelWalletLink(input({ scopes: ["create-collection", "sign"] })), /scopes/u);
  await assert.rejects(() => createKeelWalletLink(input({ accountAddress: "0x0000000000000000000000000000000000000000" })), /zero|invalid/u);
  await assert.rejects(() => createKeelWalletLink(input({ agentAddress: account })), /distinct|same|agent|account/u);
  await assert.rejects(() => createKeelWalletLink(input({ target: { ...target, factoryAddress: "0x0000000000000000000000000000000000000000" } })), /factoryAddress/u);
  await assert.rejects(() => createKeelWalletLink(input({ expiresAt: 1_800_000_000 + 30 * 24 * 60 * 60 + 1 })), /30 days/u);
  await assert.rejects(() => createKeelWalletLink(input({ target: { ...target, configByteLength: 1 } })), /configByteLength|not supported/u);
  await assert.rejects(() => createKeelWalletLink(input({ revocation: { status: "active", nonce: "revoke", revokedAt: 1_800_000_100 } })), /active|revokedAt/u);
});

test("wallet link verification reports expiry, not-yet-valid, revocation, and tampering", async () => {
  const link = await createKeelWalletLink(input({ revocation: { status: "revoked", nonce: "revoke", revokedAt: 1_800_000_100 } }));
  const revoked = await verifyKeelWalletLink(link, { nowSeconds: 1_800_000_100 });
  assert.equal(revoked.valid, false);
  assert.equal(revoked.revoked, true);
  const future = await createKeelWalletLink(input({ issuedAt: 1_800_000_500, expiresAt: 1_800_003_600 }));
  const notYet = await verifyKeelWalletLink(future, { nowSeconds: 1_800_000_100 });
  assert.equal(notYet.valid, false);
  assert.equal(notYet.notYetValid, true);
  const expired = await verifyKeelWalletLink(future, { nowSeconds: 1_800_003_600 });
  assert.equal(expired.expired, true);
  const unknownTime = await verifyKeelWalletLink(future);
  assert.equal(unknownTime.valid, false);
  assert.equal(unknownTime.timeChecked, false);
  const tampered = { ...link, target: { ...link.target, configDigest: `0x${"77".repeat(32)}` } };
  assert.equal((await verifyKeelWalletLink(tampered)).valid, false);
});

test("Tezos links remain explicitly deferred and transport mismatch is visible", async () => {
  const deferred = await createKeelWalletLink(input({ family: "tezos", transport: "tezconnect" }));
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.code, "tezos-adapter-required");
  const mismatch = await createKeelWalletLink(input({ family: "tezos", transport: "ledger" }));
  assert.equal(mismatch.status, "deferred");
  assert.equal(mismatch.code, "transport-mismatch");
});
