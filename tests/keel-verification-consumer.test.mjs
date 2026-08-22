import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source=async(path)=>readFile(new URL(path,import.meta.url),"utf8");

test("consumer matrix uses the canonical builder for real media and hostile verifier cases",async()=>{
  const [builder,app,index]=await Promise.all([
    source("../apps/studio/scripts/keel-verification-consumer-fixtures.ts"),
    source("../examples/demos/keel-verification-consumer/app.js"),
    source("../examples/demos/keel-verification-consumer/index.html"),
  ]);
  for(const id of ["classic-script","p5","three","image","video","vault-game","creator-css-revision","token-owner-palette","staking-adapter-unconfigured","staking-update-locked","staking-controller-enabled","immutable-code-revision","custom-contract-enabled","api-verified","api-wrong-format","api-uncommitted","api-stale","integrity-tampered","verifier-api-disabled"]){
    assert.ok(builder.includes(`"${id}"`),`missing ${id}`);
  }
  assert.match(builder,/buildStandaloneKeelViewer/u);
  assert.match(builder,/p5\.min\.js/u);
  assert.match(builder,/three\.core\.min\.js/u);
  assert.match(builder,/aurora-signal-loop-v1\.webm/u);
  assert.match(builder,/committedBytes: original/u);
  assert.match(builder,/API snapshot format is not enabled by the Keel manifest/u);
  assert.match(builder,/API response is not committed by the enabled manifest/u);
  assert.match(builder,/API snapshot sequence is stale/u);
  assert.match(builder,/Verifier API not enabled for this contract control/u);
  assert.match(builder,/repairEnvelope/u);
  assert.match(builder,/variants/u);
  assert.match(builder,/assetReady='p5'/u);
  assert.match(builder,/vault-keel-viewer-bundled\.html/u);
  assert.match(builder,/creator publishes committed CSS revision 4/u);
  assert.match(builder,/owner publishes rgb24 revision 4/u);
  assert.match(builder,/configured: false/u);
  assert.match(builder,/lock-updates-while-staked/u);
  assert.match(app,/runAll/u);
  assert.match(app,/repairToggle/u);
  assert.match(app,/liveControlButtons/u);
  assert.match(app,/targetTokenId/u);
  assert.match(app,/chainlink-vrf/u);
  assert.match(app,/sha256Hex/u);
  assert.match(app,/mintFixtureFor/u);
  for(const mintField of ["chainId","collection","minter","recipient","mintNonce","blockNumber","timestamp","blockEntropy"])assert.match(app,new RegExp(mintField,"u"));
  assert.match(app,/keel-packed-attributes@1/u);
  assert.match(app,/Array\.from\(\{ length: 32 \}/u);
  assert.match(app,/same token/u);
  assert.ok(app.includes("dataset?.verification"));
  assert.match(index,/KEEL CONSUMER TEST APP/u);
  assert.match(index,/id="chain"/u);
});

test("both chain contract gates cover revisions, staking authority, immutable code, API manifests, and permanent materialization",async()=>{
  const [evm,evmObjects,evmMint,tezos,tezosCheckpoint]=await Promise.all([
    source("../../keel-contracts/test/modules/keel-presentation/KeelPresentationStateRegistry.t.sol"),
    source("../../keel-contracts/test/modules/keel-artifacts/KeelArtifactRegistry.t.sol"),
    source("../../vault-of-the-fallen/contracts/test/VaultCharacter721.t.sol"),
    source("../packages/tezos/tests/test_keel_presentation_state.py"),
    source("../packages/tezos/tests/test_keel_immutable_checkpoint.py"),
  ]);
  for(const pattern of [/CreatorCssRevision/u,/ImmutableExecutable/u,/UnconfiguredPolicyMakesNoStakingClaim/u,/ConfiguredStakingAdapterCanLock/u,/ConfiguredStakingAdapterCanDelegate/u,/ApiSnapshotRequiresOracleManifestFormatAndAdvancingSequence/u,/MutableCarrierBecomesContractImmutableOnlyAfterOnchainMaterialization/u])assert.match(evm,pattern);
  assert.match(evmObjects,/ObjectLargerThanOneSlugManifestSealsThroughCompositeCheckpoints/u);
  assert.match(evmMint,/MintSeedCommitsAutomaticChainMintInputsBeforeTraitExpansion/u);
  for(const phrase of ["css-v2","locked-code","set_owner","configure_staking_rule","UPDATES_LOCKED_WHILE_STAKED","controller-while-staked","INVALID_MEDIA_TYPE","API_MANIFEST_MISSING","API_SEQUENCE_STALE","seal_policy_to_onchain_object","POLICY_SEALED"])assert.match(tezos,new RegExp(phrase,"u"));
  for(const phrase of ["append_checkpoint_chunk","CHECKPOINT_INCOMPLETE","OBJECT_SEALED","get_immutable_object"])assert.match(tezosCheckpoint,new RegExp(phrase,"u"));
});

test("consumer UI caps the artwork and keeps warning dismissal separate from repair",async()=>{
  const [css,html,javascript]=await Promise.all([
    source("../examples/demos/keel-verification-consumer/styles.css"),
    source("../examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.html"),
    source("../examples/demos/vault-arcade/generated-attribute-proxy/vault-keel-viewer.js"),
  ]);
  assert.match(css,/max-width:\s*500px/u);
  assert.match(css,/max-height:\s*500px/u);
  assert.match(html,/id="verify-alert-dismiss"/u);
  assert.match(javascript,/verification-alert-dismissed/u);
});
