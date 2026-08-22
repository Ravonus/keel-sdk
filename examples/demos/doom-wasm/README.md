# Doom WASM on-chain lane

This example treats the compiled Doom WebAssembly module as the decoded bytes,
builds the Keel recursive object plan, and binds one portable manifest root
to the exact bytes. The storage lanes are native Keel contracts:

- Ethereum: `KeelHold` plus the native Keel object and portable-anchor
  registries.
- Tezos: `KeelKeelHold` plus
  `KeelImmutableCheckpointRegistry`, with `ContentObjectRegistry` for the
  portable descriptor and anchor.

The anchor write is native publication only. Foreign-chain verification and
approval remain a separate approval step.

The engine input is pinned to [`jacobenget/doom.wasm`](https://github.com/jacobenget/doom.wasm)
at commit `31cc1af9656a8184830090c4e9f268383f5d7e15`. The shareware WAD is an
explicit local input and is not checked into this repository.

## Prepare both lanes

After building the workspace packages, prepare from a real `doom.wasm` and the
WAD digest used to produce it:

```sh
pnpm build
node scripts/prepare-doom-wasm-onchain.mjs \
  --wasm /path/to/doom.wasm \
  --wad-sha256 <sha256-of-the-input-wad> \
  --output packages/tezos/build/doom-wasm-onchain
```

The output contains the Ethereum recursive upload plan, native Keel Tezos
chunk/checkpoint operations, the portable manifest bytes/root, and the
chain-neutral Tezos recursive-object receipt. Supplying the deployed Tezos
addresses additionally materializes the packed checkpoint identity and the
native content publication/anchor operations:

```sh
  --tezos-chunk-store <keel-chunk-store-kt1> \
  --tezos-checkpoint-registry <checkpoint-registry-kt1> \
  --tezos-content-registry <content-registry-kt1> \
  --tezos-chain-id <tezos-chain-id> \
  --tezos-network-bytes <four-byte-network-id>
```

## Local Ethereum proof

With Anvil running and the Solidity artifacts compiled:

```sh
pnpm local:up
pnpm contracts:compile
node scripts/publish-doom-wasm-ethereum.mjs \
  --local \
  --read-gas 500000000 \
  --output packages/tezos/build/doom-wasm-onchain
```

The receipt records the deployed contracts, transaction hashes, native
portable anchor, and exactly one `KeelHold.haulObject(bytes32)` call whose
returned bytes are checked against the WASM SHA-256.

To re-check an already-published local stack without sending duplicate writes:

```sh
node scripts/verify-doom-wasm-ethereum.mjs \
  --output packages/tezos/build/doom-wasm-onchain \
  --chunk-store <chunk-store-address> \
  --portable-anchor-registry <portable-anchor-registry-address> \
  --root-object-id <recursive-root-object-id> \
  --read-gas 500000000
```

The large full-payload return needs an explicit local read budget because ABI
return encoding has quadratic EVM memory cost. This is a node-call budget, not
a second content read.

## Local Tezos proof

The native Tezos mockup runner originates `KeelKeelHold` and
`KeelImmutableCheckpointRegistry`, writes every prepared chunk, seals the
checkpoint, and performs one full-payload view read:

```sh
pnpm --filter @keel/vault-tezos keel:checkpoint:test
node scripts/publish-doom-wasm-tezos-mockup.mjs \
  --output packages/tezos/build/doom-wasm-onchain
```

The local receipt records 380 native chunk writes, 380 ordered checkpoint
appends, the sealed object ID, and one `read_immutable_object(bytes)` call. The
mockup uses Octez's unlimited local view budget because reconstructing a 4.56 MB
return is intentionally a stress test; this does not claim a production Tezos
gas policy.

The Tezos plan is chain-ready but is not submitted without an explicit network
and signer action. Once the native Keel checkpoint is sealed,
`KeelImmutableCheckpointRegistry.read_immutable_object(bytes)` returns the
complete WASM in one view call; the descriptor and native anchor operations
remain approval-gated.
