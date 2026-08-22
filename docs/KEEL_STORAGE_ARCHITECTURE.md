# Keel Storage Architecture

Status: implementation draft for `keel-hold@1`

## Decision

Keel is the canonical storage and verification model. Files are stored as an
append-only graph of independently compressed, reusable objects. HTML is the
boot entrypoint and may load ES modules, classic scripts, WASM, shaders, models,
images, audio, and data through the verified Keel content API.

ZIP is **not** a Keel storage primitive. Studio may generate a deterministic
ZIP when a marketplace upload form requires one, but that archive is an
ephemeral compatibility projection of the canonical graph. Creators do not
manually duplicate or repack their libraries.

## Canonical identity

Each resource has two exact commitments:

- `decodedIntegrity`: SHA-256 and length of the bytes exposed to creator code.
- `storedIntegrity`: SHA-256 and length of the independently compressed bytes.

Recursive nodes are domain-separated and SHA-256 addressed. The storage object
ID commits the node root, decoded digest, decoded length, and media type. The
RFC-8785 storage graph commits the source artifact manifest and all resources.

SHA-256 remains the cross-chain content identity. Carrier-specific identifiers,
including OnchFS Keccak CIDs, are indexes that resolve back to the same object.

## Mutable to immutable lifecycle

A mutable resource policy may initially commit an IPFS, HTTPS, or managed
carrier revision. Calling a field `immutable` never makes it so. Contract-level
immutability requires this exact sequence on both chains:

1. write every payload chunk into the append-only native Keel store;
2. address each stored chunk by `keccak256(chunkBytes)`;
3. commit their exact order, lengths, portable full SHA-256, decoded SHA-256,
   media type, and compression in an immutable object descriptor;
4. freeze/seal that object; and
5. seal the presentation policy to that frozen object and current policy
   revision.

After step 5, every contract mutation entrypoint rejects the policy. This is
not a viewer warning and cannot be bypassed by an author, owner, proxy, or
staking adapter.

Large objects use resumable checkpoints rather than one unbounded transaction.
Ethereum creates bounded leaf objects and then a composite root. Tezos writes
chunks to `KeelKeelHold`, then `KeelImmutableCheckpointRegistry`
verifies one ordered Keccak pointer per operation and seals only after the
committed rolling index root, chunk count, and stored byte length are exact.
The portable full-object SHA-256 is verified by reconstructing clients; the
chain-enforced chunk root proves which exact immutable bytes must be
reconstructed.

## Mint seed and packed traits

The production seed is never a creator-authored literal. EVM derives it from a
domain plus chain ID, collection, token ID, mint caller, recipient, mint nonce,
`block.prevrandao`, and block timestamp. Tezos uses commit/reveal over the full
mint intent, minter/recipient, token ID, chain ID, and the committed entropy
level. The permanent seed is then expanded under a separate domain into all 32
packed attribute bytes, so token identity can affect palette, material, weapon,
effects, and scene composition independently. Optional VRF or commit/reveal
entropy augments the mint receipt; it never replaces the receipt binding.

## Delivery carriers

One object may advertise multiple byte-identical carriers:

1. `keel`: native recursive reads from an Ethereum or Tezos Keel store.
2. `onchfs`: an OnchFS-compatible view over the same Tezos Keel bytes.
3. `ipfs`: an immutable module-directory mirror materialized from Keel.
4. `https`: an immutable cache or open proxy, always verified before exposure.

Carrier failure is not content mutation. A resolver may try another declared
carrier, but it accepts bytes only after the canonical decoded hash matches.

## HTML and modules

The marketplace/native artifact is a same-origin directory rooted at
`index.html`. Its scripts, modules, and assets remain individual resources. In a
native Keel viewer, the host resolves them through `__KEEL__` and the
verified virtual content gateway. For OnchFS and IPFS, the materializer exposes
the same relative paths from a directory.

This provides module reuse and independent compression while satisfying hosts
that prohibit undeclared browser network access.

## Carrier selection

Studio always builds the canonical graph first. It then chooses projections:

- Native Keel is always available.
- OnchFS is offered only when every requested file is below a measured,
  protocol-versioned read budget.
- An IPFS directory is the large-artifact compatibility carrier.
- A ZIP may additionally be generated when an upload interface explicitly
  requires it. It is not recommended and never becomes the canonical object.

`planKeelDelivery` will not guess an OnchFS ceiling. It requires a pinned
`keel-measured-read-profile@1` containing the exact network, facade contract,
block, per-file and whole-directory limits, and evidence digest. A directory
outside any measured bound moves to the verified IPFS directory projection;
the canonical Keel graph does not change.

Studio reads that operator-produced receipt from
`KEEL_TEZOS_READ_PROFILE_PATH` (default
`.data/keel-tezos-read-profile.json`). The Create UI leaves the OnchFS option
disabled when the file is absent, and the artifact API independently rejects a
forged `onchfs` form submission when the current directory exceeds any measured
bound. Enabling the option therefore requires both a deployed facade that
implements `onchfs-compatible-view@1` and its pinned read evidence; no sample
or assumed byte ceiling is promoted to production configuration.

The compatible Tezos carrier cannot be a pointer-only contract: the legacy
OnchFS `read_file` view must return bytes whose `content-encoding` matches the
file inode metadata, and a Michelson view cannot Brotli-decompress an arbitrary
Keel object on demand. The supported facade therefore has to be implemented
inside the Tezos Keel store over a shared OnchFS-compatible encoded carrier,
or be treated as a custom proxy transport rather than native OnchFS. Studio's
disabled-by-default gate prevents the latter from being mislabeled as the
former.

The isolated `KeelOnchFSStore` target implements that same-store design. Raw
chunks are stored once under their OnchFS Keccak pointers. Standard file and
directory inodes reference those chunks, while append-only Keel bindings
commit the canonical object manifest, decoded SHA-256, stored SHA-256,
compression, media type, and file CID. The Keel object ID is the SHA-256 of
that domain-labelled binding manifest; the cross-carrier content identity
remains the decoded SHA-256. No ZIP and no second content upload is involved.

Its compatibility surface matches the official Tezos OnchFS types for
`write_chunk`, `create_file`, `create_directory`, `read_chunk`, `read_file`,
and `get_inode_at`. These local gates compile the contract, compare those
Michelson types, exercise multi-chunk HTML/module storage, and verify the
Keel bindings:

```sh
pnpm --filter @keel/vault-tezos keel:store:test
pnpm --filter @keel/vault-tezos keel:carrier:test
```

This source-level vertical slice does not by itself enable Studio's OnchFS
toggle. The contract must first be deployed and probed at a pinned block; only
the resulting measured profile may enable creator selection.

Once that profile exists, selecting the OnchFS projection makes Studio build
and persist an exact `keel-onchfs-directory@1` carrier document. The artifact
page exposes it at `/api/content/<artifact-id>/keel-onchfs.json`. That handoff
contains standard chunk/file/directory inscriptions followed by the Keel
object bindings. Its receipt commits the full document SHA-256, custom-authority
`onchfs://<network>:<contract>/<root>/` URI, operation count, and every decoded
and stored identity. The Tezos batch builder can consume the document directly;
it does not rebuild a ZIP or upload a second copy of any library.

## Marketplace API

The open-source marketplace integration exposes both an ESM package and a
browser global:

```js
const image = Keel.resolve("cover");
const bytes = image.bytes();
const proof = await Keel.verifyMedia({
  sourceResourceId: "cover",
  candidate: marketplaceWebp,
  profile: "display-webp-1024-v1",
});
```

Creator HTML receives the smaller `globalThis.__KEEL__` interface:

```js
const moduleBytes = __KEEL__.read("three-r180");
const moduleUrl = __KEEL__.url("three-r180");
const proof = await __KEEL__.verify("three-r180", moduleBytes);
```

The API never grants undeclared network access. It exposes only already-resolved
and hash-verified manifest resources.

## Media derivatives

Marketplaces may resize or encode media without losing provenance only when the
output is covered by `keel-media-derivative@1`.

A receipt commits:

- source resource and SHA-256 digest;
- pinned transform profile and implementation versions;
- output dimensions and media type;
- exact output SHA-256 digest and length.

Version 1 deliberately supports only bounded WebP profiles at 512, 1024, and
2048 pixels. The output digest is authoritative. An arbitrary optimizer output
that matches neither the source nor a committed derivative is labelled
`unverified`; visual similarity is not cryptographic verification.

## Cross-chain module catalog

`keel-module-catalog@1` gives a reusable module one identity:

```text
namespace + package name + version + entrypoint + SHA-256 bytes
```

The release then lists all exact carriers on Ethereum, Tezos, OnchFS, IPFS, and
immutable HTTPS caches. Search groups releases by package and lists every
version and carrier. If two chains claim the same package/version but return
different bytes, catalog construction fails closed.

Studio reads this directory from `KEEL_MODULE_CATALOG_PATH`. Operators build
it from exact local module bytes plus deployment receipts:

```sh
pnpm --filter @keel/studio modules:build-catalog ./keel-modules.json
```

The `/modules` page and `/api/modules?q=three.js` expose the resulting versions
and carriers. A name or version declaration without matching bytes cannot enter
the catalogue.

## Trust boundary

- The chain commits graph and content identities.
- Proxies and gateways transport untrusted bytes.
- The trusted host verifies before exposing bytes to creator code.
- Creator code runs in the existing deny-by-default sandbox.
- A local user can alter their own renderer but cannot change the historical
  chain commitment or produce a valid proof for different bytes.

## Compatibility commitment

Existing OBJKT ZIP export remains supported as a generated compatibility path.
Existing Keel manifests and `tokenURI` behavior remain supported. New storage,
module-catalog, derivative, and marketplace APIs are additive and versioned.
