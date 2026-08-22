# Keel public showcase release

This receipt identifies the public, sleeping Keel showcase released on
2026-08-13. It contains no signing keys or private deployment material.

## Public endpoints

- App: `https://keel-test.149-28-255-65.sslip.io`
- Read-only wallet RPC: `https://rpc.keel-test.149-28-255-65.sslip.io`
- Ethereum chain: Sepolia (`11155111`)
- Tezos carrier: Shadownet (`NetXsqzbfFenSTS`)

The public RPC rejects administrative/debug methods. The app container is
started by the persistent sleep proxy on the first request and stopped after
the configured idle interval; the named data volume survives that cycle.

## Exact release identity

- Next BUILD_ID: `TSdbF-y6ch5NxQUF0X-UI`
- Runtime image: `sha256:3bcbad24ff33f4da5eabb0f77583007059826e51e4e7a94c58a3a81b67bb36a8`
- Runtime architecture: `linux/amd64`
- Browser gate: 30 desktop/mobile route navigations, including the real
  verified collector iframe, with no overflow, broken images, or list-page
  iframe fanout.

## Sepolia contracts

| Contract | Address |
| --- | --- |
| KeelManager proxy | `0x7cb6d62cdd968ba45a8a1f0d99a02e5e274fe6e3` |
| CreatorProfileRegistry | `0xa4112eda52ca519adaeebee7c12c4770594529fa` |
| KeelMintGate | `0xec125031e5972f0f874b313e8e3c69d42503c9cf` |
| OneMintController | `0xf0e7ca391105fb34ef00db72027752998de1067a` |
| Showcase collection | `0x71B25649E8A27992494eDAD355497c0Bea50A8e0` |
| KeelIndex | `0x0146f7b087d64ad6351c99471ce1fdbcc024ccb6` |
| KeelHold | `0x10a44bb5d9107ee2dd244a2fc0cea6cc8979c5a3` |
| KeelMarket | `0xd87f72b751d2008c7365680653b79ff7eb0780b6` |
| ObjectRegistry with preservation policy | `0x36a4123a7f8cce004771b928ed5cbc6858d3293d` |
| CommunityReplicationRegistry | `0xee36d4123fda319ecf64363317658cfa8c3d96bf` |

## Live OneMint release

- Drop ID: `0x7695151e73f0bedaab013716fff5760cfd93b73f4368b4a2ba52989f517d04be`
- Creation transaction: `0xc61c80e67956fef2a55c594225a2c29dd07b0c7d9791c4d1b162843dff230ff5`
- Supply: 32
- Public price: 0.002 ETH
- Detail route: `/drops/11155111/0xf0e7ca391105fb34ef00db72027752998de1067a/0x7695151e73f0bedaab013716fff5760cfd93b73f4368b4a2ba52989f517d04be`

## Community preservation sample

`examples/demos/community-signal` is committed as the public preservation
sample. Its exact HTML, manifest, and 1200x750 poster are represented by three
Sepolia campaigns. The accepted Tezos copies are read back from Shadownet
OnchFS contract `KT1WGYJVUzsoxrhUvYbSiEgciirPXkvW5TsL`; accepted carrier
proofs are indexed separately from the authoritative contract checks.

Carrier policy is monotonic. Once a lineage accepts an onchain carrier, a later
revision cannot replace it with an offchain-only revision. Tezos commitments
remain on Tezos and EVM commitments remain on EVM; additional carriers are
additive evidence rather than chain substitution.

## Reproduction gates

Before a remote image is published:

1. build protocol, SDK, Studio core, viewer, and Studio from a scoped tree;
2. run the complete Foundry suite and Studio unit/showcase tests;
3. run the local sleep/wake harness against the exact image;
4. run a native-amd64 768 MiB concurrency and scheduled-index overlap gate;
5. verify the public cold request, TLS, RPC restrictions, rendered routes, and
   a second wake using the same persisted volume.
