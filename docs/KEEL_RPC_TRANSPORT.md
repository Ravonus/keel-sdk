# Keel RPC transport and the governed host list

## The two jobs IPFS was doing

A content identifier does two unrelated things in this protocol, and until now
they were served by the same fetch.

**As a proof input**, a CID is the name a collection committed its artwork
under. Recomputing it from bytes and finding it equal is what makes preservation
mean anything, and none of that changes here. `KeelIpfsCidVerifier` still
recomputes CIDs on chain, the proof ladder still refuses a mismatch, the sealed
viewer still hashes the bytes it renders before it shows them, and
`hybridSource` in the Keel adapter still drops a fidelity link whose
committed digest, length, or media type disagrees with the object descriptor.

**As a transport**, a CID was a way to *get* the bytes: resolve it through a
gateway and render whatever comes back. That is the part that is replaced. The
same bytes are on chain, under a proof this protocol already made, and reading
them from there removes a content host from the render path.

Keeping the two apart is the whole change. Nothing about how artwork is proven
moves. Only where the displayed copy is fetched from.

## Carriage: what a document does, not what it says

A viewer document obtains its artwork one of two ways.

**Inline** — the document is a KeelHold composite whose parts include the
artwork object. The bytes arrive with the page. Nothing is fetched, no host has
to be up or honest, and rendering the document and holding the artwork are the
same act.

**Hybrid** — the document is around thirty kilobytes and reads the artwork when
it renders. That keeps a quarter-megabyte artwork out of every `animation_url`
a marketplace, wallet, or indexer has to move before anything appears, and past
a certain size it is the difference between a token that renders and one whose
read exceeds a node's response cap.

`KeelBackpackProofLedger.viewerCarriage(backpack, tokenId)` answers which,
and it does not ask the document. It reads the viewer composite's own part list
on chain and looks for the asset the ladder proved, returning
`Unknown | Linked | Inline | Hybrid`. A document's own account of whether it
fetches would be the least trustworthy claim on the panel; this one is a fact
about the composite.

The verification chrome surfaces it. `mountKeelVerification` takes `carriage`
and `transport` alongside `result`, `runtime`, and `context`, and the "Where the
bytes come from" section leads with carriage before it lists mirrors — because
carriage is the question every line under it qualifies. Where no ledger answer
is supplied, the panel reports what it observed from the sources that actually
resolved and labels it as observed, which is a weaker claim and says so.

## The RPC module

`createKeelRpcClient` in `@keel/protocol` is one way to read a chain, for both
families Keel preserves onto:

```ts
const chain = createKeelRpcClient({ family: "ethereum", chainId: 1, endpoints });
const artwork = await chain.haulObject(keelHold, assetObjectId);

const chain = createKeelRpcClient({ family: "tezos", network: "NetXdQprcVkpaWU", endpoints });
const artwork = await chain.haulObject(kt1Store, assetObjectId);
```

Same call, same return, different chain. The JSON-RPC envelope, the endpoint
failover, the ABI decoding on Ethereum and the Michelson view on Tezos all
happen underneath, so a script reads an on-chain object without knowing which
family it landed on. `haulObjectVerified` adds the digest check, which is what
makes reading through a host acceptable rather than merely convenient.

`packages/viewer/src/keel-rpc-view.js` is the same module in the form a
sealed on-chain document can carry: dependency-free, deliberately small, and the
same shape. A document cannot import a package, and every byte it carries costs
about 225 gas forever.

**What the module hides and what it must not.** It hides the plumbing from
whoever writes a viewer — that is ergonomics, and a read that looks like a chain
read is easier to get right. It does not hide the dependency from whoever is
deciding whether to trust the token. `disclosure()` names the endpoint that
answered, and the panel shows it. A viewer that claims "no external
dependencies" while holding a socket open is worse than the mirror it replaced.

## The governed host list

There was no global list of permitted RPC endpoints. Endpoints were passed in
ad hoc or hardcoded into a document. For a hybrid viewer the node is the single
host it depends on, so which nodes are acceptable is a policy question, and
policy questions here are settled by governance.

`KeelManager` holds the list and moves it through the governor quorum it
already had:

```solidity
configureRpcHostList(string[] hosts, uint64 expectedRevision)   // onlySelf
rpcHostList() returns (hosts, revision, listEpoch, currentEpoch, digest)
```

`configureRpcHostList` is `onlySelf`, and an execution policy cannot be pointed
at the manager's own selectors, so `executeGovernance` with a sorted two-thirds
envelope is the only door. `expectedRevision` means two envelopes signed over
the same list cannot both land.

The list is stamped with the `governanceEpoch` it was accepted under and
returned next to the current epoch rather than checked against it. A governor
rotation should make a list *visibly stale*, not brick every reader until the
new roster re-affirms it; `keelRpcHostListStale` is that check, and what a
reader does about it is the reader's call.

`digest` is `sha256` over a preimage a holder can reproduce by hand:

```
keel-rpc-host-list@1\n<revision>\n<epoch>\n<host>\n<host>\n
```

SHA-256 rather than keccak so a browser document with no hashing dependency can
recompute it from WebCrypto alone. `rpcHostListPreimage` is behind its own
external entry point: `via_ir` inlines a buffer-growing loop into whatever calls
it, the same trap `linkedImageURI` is kept out of `preservedImageSvg` for.

### Matching is not reimplemented

`remoteUrlAllowed` decides whether a URL is reachable and whether an allowlist
admits it, and it is the only implementation of those rules off chain. It moved
from `@keel/viewer`'s source-policy to `@keel/protocol` so the SDK, the MCP
server, and any host share it; the viewer re-exports it, so existing imports are
unchanged.

`keelRpcUrlAllowed` delegates to it and adds exactly one rule: **an empty
list denies**. An empty gateway allowlist means "no allowlist configured", which
is a sane default for an optional mirror. An empty RPC list means governance has
blessed no endpoint, and reading the chain through an unblessed host is the
thing the list exists to prevent.

Two places necessarily carry their own copy of the matching rules: the sealed
document, which cannot import anything, and `_validateRpcHost` in the manager,
which only checks entry *shape*. Both are pinned to the authority by tests —
`tests/keel-rpc-policy.test.mjs` runs one vector table through both
`remoteUrlAllowed` and the sealed-document mirror, and the same table of
accepted and rejected entries runs against the contract in
`packages/contracts/test/KeelManager.t.sol`. A copy that can drift is worse
than no copy, so drift breaks the gate.

## Choosing a transport

`bindKeelManifest` and `resolveKeelArtifact` take `gatewayTransport`:

| Value | Order |
| --- | --- |
| `"off"` *(default)* | Chain only. A declared mirror is not consulted for display. |
| `"fallback"` | Chain first, a proven mirror behind it. |
| `"preferred"` | Mirror first, the chain behind it. What Keel used to do. |

`sourcePreference` still works and still means what it meant — `"hybrid-first"`
maps to `"preferred"` and `"onchain-first"` to `"fallback"` — so a caller that
set it keeps its behaviour instead of being silently switched. When both are
given, `gatewayTransport` wins.

Turning a mirror off does not unbind it. It stays declared, stays committed, and
stays checkable; it is simply not the transport. The corrupt-mirror rejection
this protocol has always proven still runs, under the opt-in, in
`tests/viewer.test.mjs`.
