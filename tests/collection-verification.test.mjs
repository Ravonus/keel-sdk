import assert from "node:assert/strict";
import test from "node:test";

import {
  KEEL_CUSTOM_CONTRACT_UNVERIFIED_REASON,
  KEEL_ZERO_ADDRESS,
  keelCollectorSummary,
  validateKeelCollectionVerificationProfile,
} from "../packages/sdk/dist/index.js";
import {
  allowCollectionVerificationFixtureQuery,
  evaluateCollectionVerification,
} from "../packages/viewer/dist/index.js";

const address = (byte) => `0x${byte.repeat(40)}`;
const digest = (byte) => `0x${byte.repeat(64)}`;
const green = (reason) => ({ verdict: "green", reason });
const unknown = () => ({ verdict: "unknown", reason: KEEL_CUSTOM_CONTRACT_UNVERIFIED_REASON });
const contentBinding = Object.freeze({
  portableAnchorRoot: digest("a"),
  presentationContentDigest: digest("b"),
});
const receiptIdentity = Object.freeze({
  receiptId: digest("c"),
  observationBlockNumber: "8",
  observationBlockHash: digest("d"),
});

const base = Object.freeze({
  proofClass: "native-proof",
  chainId: 11155111n,
  collection: address("1"),
  tokenId: 1n,
  runtimeCodeHash: digest("1"),
  implementationCodeHash: digest("0"),
  evidenceBlock: 9n,
  evidenceBlockHash: digest("2"),
  evidenceRoot: digest("3"),
  policyId: digest("4"),
  policyVersion: 1n,
  expiresAt: 0n,
  revoked: false,
  tokenURIHash: digest("5"),
  resolver: address("2"),
  keelIndex: address("3"),
  presentationScope: 1n,
  presentationRevision: 2n,
  portableRoot: digest("6"),
  ...contentBinding,
  manifestDigest: digest("7"),
  revisionLineageRoot: digest("8"),
  currentSupply: 10n,
  lifetimeMinted: 12n,
  burnedCount: 2n,
  remainingMintable: 85n,
  maxSupply: 100n,
  reservedSupply: 5n,
  supplyKnownFlags: 0x3f,
  maxSupplyKind: 1,
  burnPolicy: 0,
  mintStatus: 1,
  mintAuthoritiesRoot: digest("9"),
  mintAuthorityCount: 1,
  implementation: KEEL_ZERO_ADDRESS,
  proxyAdmin: KEEL_ZERO_ADDRESS,
  beacon: KEEL_ZERO_ADDRESS,
  facets: Object.freeze({
    route: green("tokenURI permanently delegates to the approved Keel resolver"),
    content: green("active revision roots match at the pinned block"),
    governance: { verdict: "amber", authority: address("4"), reason: "creator may publish tracked revisions" },
    mint: { verdict: "amber", authority: address("5"), reason: "role may mint while supply remains" },
    supply: green("maximum supply is fixed"),
    upgrade: green("runtime is immutable"),
  }),
});

test("collector proof keeps route lock separate from tracked revision governance", () => {
  const profile = validateKeelCollectionVerificationProfile(base);
  assert.match(keelCollectorSummary(profile), /Keel route locked \/ Current revision r2 verified/);
  const view = evaluateCollectionVerification({
    proofClass: "native-proof",
    ...receiptIdentity,
    chainId: "11155111",
    blockNumber: "9",
    blockHash: digest("2"),
    collection: address("1"),
    tokenId: "1",
    policyVersion: "1",
    evidenceRoot: digest("3"),
    presentationRevision: "2",
    portableRoot: digest("6"),
    ...contentBinding,
    revoked: false,
    expired: false,
    facets: base.facets,
  });
  assert.equal(view.state, "conditional");
  assert.equal(view.seal, "Keel route locked");
  assert.equal(view.rows.find((row) => row.id === "governance")?.verdict, "amber");
});

test("frozen URI with mutable supply and immutable supply with mutable URI stay independent", () => {
  const expandable = validateKeelCollectionVerificationProfile({
    ...base,
    facets: { ...base.facets, supply: { verdict: "amber", authority: address("6"), reason: "cap authority may expand supply" } },
  });
  assert.match(keelCollectorSummary(expandable), /supply expandable by 0x6666/);

  const redirectable = evaluateCollectionVerification({
    proofClass: "adapter-proof", ...receiptIdentity, chainId: "1", blockNumber: "9", blockHash: digest("2"),
    collection: address("1"), tokenId: "1", policyVersion: "1", evidenceRoot: digest("3"),
    presentationRevision: "2", portableRoot: digest("6"), ...contentBinding, revoked: false, expired: false,
    facets: { ...base.facets, route: { verdict: "amber", authority: address("7"), reason: "owner can redirect tokenURI" } },
  });
  assert.equal(redirectable.state, "conditional");
  assert.match(redirectable.summary, /Route redirectable by 0x7777/);
});

test("no-hook custom contract verifies content only and cannot manufacture control rows", () => {
  const contentOnly = {
    ...base,
    proofClass: "content-only",
    facets: { route: unknown(), content: green("current bytes and roots verify"), governance: unknown(), mint: unknown(), supply: unknown(), upgrade: unknown() },
  };
  assert.equal(validateKeelCollectionVerificationProfile(contentOnly).facets.mint.verdict, "unknown");
  assert.throws(
    () => validateKeelCollectionVerificationProfile({ ...contentOnly, facets: { ...contentOnly.facets, supply: green("liar getter") } }),
    /cannot infer/,
  );
  assert.throws(
    () => evaluateCollectionVerification({
      proofClass: "content-only", ...receiptIdentity, chainId: "1", blockNumber: "9", blockHash: digest("2"), collection: address("1"),
      tokenId: "1", policyVersion: "1", evidenceRoot: digest("3"), presentationRevision: "1", portableRoot: digest("6"), ...contentBinding,
      revoked: false, expired: false,
      facets: { ...contentOnly.facets, upgrade: green("self-declared owner renunciation") },
    }),
    /cannot manufacture/,
  );
});

test("malformed pinned block, anonymous amber authority, and route-without-content fail closed", () => {
  assert.throws(
    () => evaluateCollectionVerification({
      proofClass: "native-proof", ...receiptIdentity, chainId: "1", blockNumber: "9", blockHash: "0x1234", collection: address("1"),
      tokenId: "1", policyVersion: "1", evidenceRoot: digest("3"), presentationRevision: "1", portableRoot: digest("6"), ...contentBinding,
      revoked: false, expired: false, facets: base.facets,
    }),
    /malformed/,
  );
  assert.throws(
    () => evaluateCollectionVerification({
      proofClass: "native-proof", ...receiptIdentity, receiptId: "0x1234", chainId: "1", blockNumber: "9",
      blockHash: digest("2"), collection: address("1"), tokenId: "1", policyVersion: "1", evidenceRoot: digest("3"),
      presentationRevision: "1", portableRoot: digest("6"), ...contentBinding,
      revoked: false, expired: false, facets: base.facets,
    }),
    /malformed/,
  );
  assert.throws(
    () => validateKeelCollectionVerificationProfile({
      ...base, facets: { ...base.facets, mint: { verdict: "amber", reason: "unnamed authority" } },
    }),
    /must identify/,
  );
  assert.throws(
    () => validateKeelCollectionVerificationProfile({
      ...base, facets: { ...base.facets, content: { verdict: "red", reason: "root mismatch" } },
    }),
    /requires verified current content/,
  );
});

test("any attempted red mint or supply proof forces the large-failure state", () => {
  for (const facet of ["mint", "supply"]) {
    const view = evaluateCollectionVerification({
      proofClass: "native-proof", ...receiptIdentity, chainId: "1", blockNumber: "9", blockHash: digest("2"), collection: address("1"),
      tokenId: "1", policyVersion: "1", evidenceRoot: digest("3"), presentationRevision: "1", portableRoot: digest("6"), ...contentBinding,
      revoked: false, expired: false,
      facets: { ...base.facets, governance: green("frozen"), mint: green("fixed public mint"),
        supply: green("fixed cap"), [facet]: { verdict: "red", reason: `${facet} proof contradicted storage` } },
    });
    assert.equal(view.state, "failed", facet);
    assert.equal(view.seal, "Verification failed", facet);
    assert.match(view.summary, new RegExp(`${facet === "mint" ? "Minting" : "Supply"} failed: ${facet} proof contradicted storage`));
  }
});

test("threshold attestation remains conditional even when every asserted facet is green", () => {
  const allGreen = { route: green("route"), content: green("content"), governance: green("governance"),
    mint: green("mint"), supply: green("supply"), upgrade: green("upgrade") };
  const view = evaluateCollectionVerification({
    proofClass: "attested-proof", ...receiptIdentity, chainId: "1", blockNumber: "9", blockHash: digest("2"), collection: address("1"),
    tokenId: "1", policyVersion: "1", evidenceRoot: digest("3"), presentationRevision: "1", portableRoot: digest("6"), ...contentBinding,
    revoked: false, expired: false, facets: allGreen,
  });
  assert.equal(view.state, "conditional");
  assert.equal(view.seal, "Keel route locked");
});

test("Ethereum native and Tezos adapter receipts produce the same verifier lifecycle states", () => {
  const allGreen = { route: green("route locked"), content: green("bytes match"), governance: green("frozen"),
    mint: green("mint receipt current"), supply: green("supply exact"), upgrade: green("immutable") };
  const common = {
    ...receiptIdentity, chainId: "11155111", blockNumber: "9", blockHash: digest("2"), collection: address("1"),
    tokenId: "7", policyVersion: "1", evidenceRoot: digest("3"), presentationRevision: "2", portableRoot: digest("6"),
    ...contentBinding, revoked: false, expired: false, facets: allGreen,
  };
  const ethereum = evaluateCollectionVerification({ proofClass: "native-proof", ...common });
  const tezos = evaluateCollectionVerification({ proofClass: "adapter-proof", ...common, chainId: "20260811" });
  assert.equal(ethereum.state, "verified");
  assert.equal(tezos.state, "verified");
  assert.equal(ethereum.seal, tezos.seal);
  assert.deepEqual(ethereum.rows, tezos.rows);

  for (const lifecycle of [
    { name: "stale content", facets: { ...allGreen, content: { verdict: "red", reason: "active digest changed" } } },
    { name: "revoked receipt", revoked: true },
    { name: "expired receipt", expired: true },
  ]) {
    for (const proofClass of ["native-proof", "adapter-proof"]) {
      const view = evaluateCollectionVerification({ proofClass, ...common, ...lifecycle });
      assert.equal(view.state, "failed", `${proofClass} ${lifecycle.name}`);
      assert.equal(view.seal, "Verification failed", `${proofClass} ${lifecycle.name}`);
    }
  }
});

test("unsupported custom proof formats cannot claim a verifier receipt", () => {
  const common = {
    ...receiptIdentity, chainId: "1", blockNumber: "9", blockHash: digest("2"), collection: address("1"), tokenId: "7",
    policyVersion: "1", evidenceRoot: digest("3"), presentationRevision: "2", portableRoot: digest("6"),
    ...contentBinding, revoked: false, expired: false, facets: base.facets,
  };
  assert.throws(
    () => evaluateCollectionVerification({ ...common, proofClass: "creator-invented-api@99" }),
    /proof class is unsupported/u,
  );
});

test("collection proof query fixtures are ignored outside explicit test mode or loopback", () => {
  assert.equal(allowCollectionVerificationFixtureQuery("marketplace.example", false), false);
  assert.equal(allowCollectionVerificationFixtureQuery("", false), false);
  assert.equal(allowCollectionVerificationFixtureQuery("127.0.0.1", false), true);
  assert.equal(allowCollectionVerificationFixtureQuery("localhost", false), true);
  assert.equal(allowCollectionVerificationFixtureQuery("marketplace.example", true), true);
});
