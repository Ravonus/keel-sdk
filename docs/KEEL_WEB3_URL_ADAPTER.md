# Keel web3:// URL Compatibility

Status: implemented for `keel-web3-adapter@1`

Keel does not imitate the web3:// standards; the standards are made to
imitate Keel at a disposable boundary. Internally there is exactly one read
model:

```text
(objectId, index) -> data, hasNext        nextIndex = index + 1
```

Externally, an ERC-5219/7617 client sees an HTTP-like chunk stream whose
continuation URLs are generated per response and stored nowhere.

## 1. The two models — do not confuse them

### Native Keel (canonical, permanent)

```text
readChunk(objectId, index) -> (bytes data, bool hasNext)
flatSlugCount(objectId)   -> uint256
```

- Indexed: one stable `bytes32` object id, integer chunk index.
- Random access: locating index `N` walks descriptor bytecode only. The
  payloads of chunks `0..N-1` are never read
  (`testRandomAccessSkipsPriorChunkPayloads` proves this by gas bound).
- Implicit continuation: the next chunk is `index + 1`; `hasNext` is one
  boolean, not a stored URL.
- The flat index enumerates the object's leaf chunks in committed order,
  across composite boundaries, so the concatenation of all flat chunks equals
  `haulObject(objectId)` for uncompressed objects.
- Lives in `KeelHold` itself. It references no web3:// concept and no draft
  ERC; it is simply the recursion primitive made callable.

### ERC-7617 compatibility view (generated, disposable)

```text
request(["object", "<objectId>", "<n>"]) ->
    body   = chunk n
    header = web3-next-chunk: /object/<objectId>/<n+1>   (only while hasNext)
```

- Sequential, linked-URL traversal for standards clients.
- The "next URL" is derived from `index + 1` at answer time. **No URL is ever
  stored in Keel.** Deleting the adapter loses nothing.
- Lives in `KeelWeb3ResourceAdapter`, a stateless, ownerless, view-only
  contract bound to one immutable `KeelHold`.

## 2. Standards research summary (checked 2026-08-21, ethereum/ERCs master)

| ERC | Subject | Status |
|---|---|---|
| 5219 | `request()` resource interface, `KeyValue` headers | **Final** |
| 6860 | web3:// URL -> EVM call translation, auto/manual modes | Draft |
| 6944 | `resolveMode() == "5219"` routing | Draft |
| 7617 | `web3-next-chunk` response header | Draft |
| 7618 | `Content-Encoding` in 5219 responses (`gzip`, `br`) | Draft |
| 4804 | Predecessor of 6860 | Final (superseded in practice) |

Key normative facts implemented against:

- ERC-5219 ABI: `request(string[],(string,string)[])` returning
  `(uint16,string,(string,string)[])`, selector `0x1374c460`; `view` only.
- ERC-6944: `resolveMode()` must return `bytes32("5219")` (case-insensitive
  comparison on the client side).
- ERC-6860 auto mode infers `uint256` from bare digits and `bytes32` from
  `0x` + 64 hex — which is exactly the shape of `readChunk(bytes32,uint256)`.
- ERC-7617: `web3-next-chunk` is a **response** header; the first response's
  status/headers stream to the client, later chunk responses contribute body
  only; loop ends when the header is absent.
- ERC-7618: recognized encodings are exactly `gzip` and `br`; a gateway that
  must decode anything else errors.

Spec gaps closed by documented policy here (the drafts are silent):

- No normative mapping from URL path/query to `request()` arguments — we
  follow the 5219 NatSpec example (`/a/b` -> `["a","b"]`) as every known
  client does.
- No normative relative-URL resolution for `web3-next-chunk` (ERC-6860's
  relative grammar covers only auto/manual modes). All known clients resolve
  absolute-path relatives against the same contract and chain, and every
  example in the wild uses that form, so the adapter emits
  `/object/<id>/<n+1>` — never a bare `1` or `./1`, which no spec text
  authorizes.
- No loop/DoS bounds anywhere in 7617 (see §5).

## 3. Architecture

```text
web3:// client
   │
   ├── auto mode (ERC-6860) ──────────────► KeelHold.readChunk / haulObject
   │                                        (no adapter, no new code path)
   │
   └── 5219 mode (ERC-6944/7617/7618) ───► KeelWeb3ResourceAdapter
                                               │ view calls only, fixed target
                                               ▼
                                           KeelHold (canonical primitive)
```

- **Indexed access needs zero adapter code.** `KeelHold` implements no
  `resolveMode()`, so ERC-6860 clients treat it as auto mode. `readChunk`,
  `haulObject`, `getChunk`, `flatSlugCount` are directly URL-addressable.
- **One contract per resolve mode.** A contract answering `"5219"` loses auto
  mode, so the streaming surface must be a separate address. That is the only
  reason the adapter exists as a contract at all.
- **Draft isolation / re-targeting.** All Draft-ERC behavior (URL grammar,
  header names, status mapping) lives in the adapter. It holds no state, no
  ownership, no registry, and no storage duplication; tracking a standards
  revision or pointing at a different store means deploying a replacement
  (~5.6 KB runtime) and updating off-chain URLs. Core contracts and stored
  objects never change.
- **Not a call proxy.** The adapter can call only the store address fixed at
  construction, only through typed `view` functions (STATICCALL-enforced by
  the compiler, since `request` itself is `view`).

## 4. URLs

Indexed (auto mode, canonical semantics preserved):

```text
web3://<keelHold>:<chainId>/readChunk/0x<objectId>/57?returns=(bytes,bool)
  -> ["0x<chunk57>", true]                          # JSON, both values kept
web3://<keelHold>:<chainId>/haulObject/0x<objectId>
  -> whole uncompressed object as body
web3://<keelHold>:<chainId>/flatSlugCount/0x<objectId>?returns=(uint256)
  -> ["0x3c"]
```

Streaming (5219 mode):

```text
web3://<adapter>:<chainId>/object/0x<objectId>          # starts at chunk 0
  200, body = chunk0
  Content-Type: <mediaType from the object record>
  Content-Encoding: gzip | deflate | br                 # only when stored so
  web3-next-chunk: /object/0x<objectId>/1               # only while hasNext

web3://<adapter>:<chainId>/object/0x<objectId>/1
  200, body = chunk1
  web3-next-chunk: /object/0x<objectId>/2

web3://<adapter>:<chainId>/object/0x<objectId>/2        # final chunk
  200, body = chunk2                                    # no web3-next-chunk
```

Status codes: `200` served; `400` malformed id/index/path shape; `404`
unknown route, missing object, or index past EOF; `501` composite objects the
projection cannot represent (§6); `500` unexpected store revert.

## 5. Loop protection — where each limit lives

```text
KeelHold   deterministic primitive; MAX_READ_DEPTH (16) bounds descriptor
             recursion; descriptors are immutable and content-committed, so a
             chunk sequence cannot be extended after creation — an
             "intentionally infinite hasNext" object is unconstructible here.

Adapter      pure translation; emits web3-next-chunk only from hasNext; adds
             no recursion of its own beyond a one-level part scan.

Client       owns the traversal budget (total chunks, total bytes, wall
             clock), exactly as an HTTP client owns redirect/download
             budgets. ERC-7617 specifies none; any gateway following
             unbounded next-chunk chains from arbitrary contracts needs its
             own cap regardless of what Keel does.
```

No artificial global chunk maximum was added: arbitrary-size resources remain
streamable, and the core's depth bound plus immutable descriptors already
make the on-chain side terminate.

## 6. Content-Type, compression, and the 501 boundary

- `Content-Type` comes from the object record's `mediaType` (committed at
  creation, 1..128 bytes). No MIME database exists on chain.
- Stored bytes are served as stored. Nothing decompresses or recompresses on
  chain; `Content-Encoding` merely tells the client what the bytes already
  are: `Gzip -> gzip`, `Brotli -> br`, `Deflate -> deflate`, `None -> omitted`.
- Content headers are emitted on chunk 0 only — ERC-7617 clients ignore
  headers on later chunk responses, and a mid-stream slice of a compressed
  body is not itself a valid encoded document.
- Composite objects stream when every part is an uncompressed leaf (the
  common Studio shape: bounded leaves under one root). A single
  `Content-Encoding` cannot describe a concatenation of independently
  compressed parts, and Solidity cannot decompress, so compressed-part or
  nested composites answer `501`. They remain fully readable through the
  native indexed primitive and the existing viewer path.

## 7. Standards incompatibilities discovered

1. **`Deflate` has no ERC-7618 name.** The adapter emits honest
   `Content-Encoding: deflate`; strict 7618 gateways will refuse to decode
   it (their mandatory list is `gzip`, `br`). Clients that pass encodings
   through, or accept deflate, work. Prefer Gzip/Brotli for new objects that
   must stream through 7618 gateways.
2. **Independently compressed composite parts are unrepresentable** as one
   7617 stream without on-chain decompression (`501`, see §6).
3. **Relative `web3-next-chunk` resolution is unspecified** in every relevant
   ERC; the adapter emits the de-facto-interoperable absolute-path relative
   form (§2).
4. **ERC-6860 remains Draft** while ERC-5219 is Final; if 6860's URL grammar
   shifts, only client-side URL construction and this adapter are affected.
5. **ERC-6944 "5219" resolve mode is not supported by surveyed third-party
   resolvers** (field-tested 2026-08-21: onchainchecker.xyz and
   nftinspector.xyz both reject it — "Web3 URL resolve mode is not
   supported" — while both handle auto mode). Consequence: URLs meant for
   arbitrary wallets/marketplaces should default to **auto mode against the
   KeelHold** (`/haulObject/<id>?mime.type=<ext>`, ERC-7087 MIME hint);
   the 5219 adapter is the streaming-capable surface for clients that
   implement it (the reference web3protocol client, ERC-6944 gateways).
   Auto-mode caveats: no `Content-Encoding` signaling (serve uncompressed
   copies of media that must resolve this way) and whole-object reads only
   (subject to RPC call-gas ceilings; ~2 MB practical).

## 8. Benchmarks

See `test/gas/KeelWeb3.gas.t.sol` (forge, execution gas) and §9 for
RPC-level numbers. Summary on this tree (via-IR, optimizer 200):

RPC-shaped (anvil, `eth_estimateGas` on view calls — includes 21k intrinsic;
calldata/return-data in bytes; chunks are full 23,000-byte carriers):

| Operation | Gas | Calldata | Return data |
|---|---|---|---|
| `readChunk(O1, 0)` single chunk, EOF | 48,125 | 68 | 23,104 |
| `readChunk(O100, 0)` head of 100-chunk leaf | 48,125 | 68 | 23,104 |
| `readChunk(O100, 57)` random access | 48,137 | 68 | 23,104 |
| `readChunk(O100, 99)` tail | 48,137 | 68 | 23,104 |
| `flatSlugCount(O100)` | 28,968 | 36 | 32 |
| `haulObject(O10)` whole 230 KB | 579,996 | 36 | 230,080 |
| `haulObject(O100)` whole 2.3 MB | exceeds 30M call allowance | 36 | — |
| adapter `request` head chunk + headers | 126,434 | 388 | 23,680 |
| adapter `request` mid chunk | 122,111 | 484 | 23,456 |
| adapter `request` tail chunk (no header) | 105,054 | 484 | 23,168 |
| full retrieval 2 chunks: core / adapter | 96,262 / 232,250 | — | — |
| full retrieval 10 chunks (230 KB): core / adapter | 481,358 / 1,202,990 | — | — |

Forge-level (setup excluded, `test/gas/KeelWeb3.gas.t.sol`):
`readChunk` head vs tail of a 100-chunk leaf is 20,264 vs 20,151 gas —
random access inside a leaf is O(1), and composite skipping costs descriptor
reads only (tail of a 3-leaf composite: 70,647 vs 473,307 for whole-object
assembly).

Readings:

- Adapter translation overhead is ~57–78k gas per chunk (string parsing,
  header/URL construction, one extra `getObject` on chunk 0). Real but
  irrelevant to transactions — these are `eth_call`s.
- The 2.3 MB whole-object read fails a default 30M-gas RPC call envelope;
  the chunked surfaces never exceed ~126k per hop at any resource size. That
  is the concrete reason the `(objectId, index)` model exists.
- Deploy cost (Sepolia, measured): KeelHold 1,550,338 gas; adapter
  1,267,289 gas. Runtime sizes 6,922 / 5,598 bytes — both far under EIP-170.

Continuation-URL cost: the emitted relative form is 77 bytes of header value;
a fully absolute `web3://0x<adapter>:11155111` prefix would add 52 bytes of
string building and return data per chunk for no added client compatibility,
so the relative form is kept.

## 9. Local and testnet verification

Local: 23 unit tests plus 14 gas benchmarks pass (`forge test` in
`packages/contracts`). End-to-end validation runs the **reference
`web3protocol` JS client (v0.6.3)** — not our own URL interpretation —
against anvil: auto-mode indexed reads with `?returns=(bytes,bool)`, random
access, `flatSlugCount`, full ERC-7617 stream reassembly via
`web3-next-chunk`, Content-Type propagation, and 404 mapping all pass. The
client's ERC-7617 code resolves only absolute-path relative URLs
(`/...` prefixed with `web3://<contract>:<chain>`), confirming the §2 header
format choice.

Sepolia (chain 11155111, deployed 2026-08-21, record in
`examples/demos/keel-web3-adapter/sepolia-deployment.json`):

- `KeelHold` (with `readChunk`/`flatSlugCount`):
  `0x417cfdf69ed808b7e6e6c5d974c27bb8ccffbec5`
- `KeelWeb3ResourceAdapter`:
  `0x6b5a95a1dfa9122f45c81b1c5a43d0496a027eb7`
- Test object (3-chunk `text/html`, 197 bytes):
  `0x4c2cdd5d0f491946a060b1964a9e42c01c69d4f69ca61e4f2ae278eb46d81748`

Verified against live Sepolia RPC with the reference client: indexed random
access to the final chunk (`hasNext=false`), and a 200 `text/html` stream
reassembled intact across all three `web3-next-chunk` hops.

```text
web3://0x417cfdf69ed808b7e6e6c5d974c27bb8ccffbec5:11155111/readChunk/0x4c2cdd5d0f491946a060b1964a9e42c01c69d4f69ca61e4f2ae278eb46d81748/1?returns=(bytes,bool)
web3://0x6b5a95a1dfa9122f45c81b1c5a43d0496a027eb7:11155111/object/0x4c2cdd5d0f491946a060b1964a9e42c01c69d4f69ca61e4f2ae278eb46d81748
```

Redeploy path: `forge build`, then
`npx tsx apps/studio/scripts/deploy-keel-web3-adapter-sepolia.ts` (reads
the Foundry artifacts and the standard Sepolia deployer secret).

## 10. Test map

- `test/KeelHoldFlatRead.t.sol` — primitive: sequential traversal, EOF,
  composite flattening (depth 2 and 3), random-access gas proof, stored-bytes
  semantics for compressed leaves, missing/zero ids, out-of-bounds, depth
  bomb.
- `test/KeelWeb3ResourceAdapter.t.sol` — resolve mode, usage root, single
  and multi-chunk streams with exact `web3-next-chunk` values, header
  presence/absence per position, gzip/br/deflate signaling, streamable and
  refused composites, uppercase hex, ignored query params, the full 400/404
  malformed-input matrix.
- `test/gas/KeelWeb3.gas.t.sol` — measured read paths above.

JS boundary suites (`packages/web3-boundary-tests`, run with
`pnpm contracts:web3:test`; needs `forge build` output and the `anvil`
binary — each suite boots its own anvil):

- `test/reference-client.test.mjs` — the official `web3protocol` client
  against a live chain: auto-mode indexed access with both values, random
  access, `flatSlugCount`, ERC-7617 reassembly, 404/400 mapping, and
  transparent ERC-7618 gzip and brotli decompression.
- `test/stream-loader.test.mjs` — the dependency-free loader
  (`examples/demos/keel-web3-adapter/web3-stream-loader.mjs`): the
  hand-rolled ABI codec cross-checked against a real ABI encoder (binary
  bodies included), indexed and streaming fetches, gzip, status-code
  passthrough, and the client-side traversal budget.
- `test/arbitrary-artifact.test.mjs` — a separately authored, pre-existing
  714 KB HTML artifact (the bundled vault gallery viewer, 32 full carriers)
  streamed back SHA-256-identical, plus its gzip-stored variant, plus
  mid-artifact random access.
- `test/forge-guardrail.test.mjs` — the repo-root foundry.toml stub fails
  bare `forge` runs loudly while `--root packages/contracts` keeps working.

## 11. Token demo: NFT media as Keel objects (Sepolia)

`KeelWeb3TokenDemo` at `0xbce62004766b4a86f3655bab7134b471c789f5d8`
(record: `examples/demos/keel-web3-adapter/sepolia-token-demo.json`).
Metadata JSON, gzip-stored SVG image (ERC-7618), and a 19-chunk animation
(ERC-7617) are all Keel objects on the KeelHold in §9; three tokens
exercise three tokenURI styles:

| # | tokenURI style | onchainchecker.xyz result |
|---|---|---|
| 1 | HTTPS gateway URL (w3link) | detected "Web3 · Hard-coded gateway", 1/5 |
| 2 | native `web3://` URL | metadata badged **Onchain · Web3**, no gateway note |
| 3 | `data:application/json;base64` + gateway media | **5/5 Fully On-Chain**; image and animation each badged **Onchain · Web3** |

Independent-validation notes from that test (2026-08-21):

- The checker runs its own in-browser web3:// client (it ships brotli-wasm)
  and *rewrites recognized gateway URLs back into native web3:// resolution*
  before fetching — so it graded Keel media as on-chain Web3 content in
  every variant.
- Actual pixel rendering failed **on the checker's side**: it pins Sepolia
  to `https://rpc.sepolia.org`, whose CORS headers are broken, so every
  Sepolia web3-protocol fetch it attempts dies in preflight (our gateway
  serves `access-control-allow-origin: *` and returns the content fine).
  On chains where its RPC works, the same tokens would render.
- `web3-token-viewer.html` (below) renders token #2 fully natively:
  tokenURI, image, and animation all resolved over web3:// — "3 of 3 URIs
  resolved natively" — against the public Sepolia RPC.
### v2: field-driven revision (same day)

Both sites rejected the ERC-6944 tokenURI with "Web3 URL resolve mode is
not supported" — their resolvers implement auto/manual only (§7 item 5).
`KeelWeb3TokenDemo` **v2** at `0x87c96dc8b411da0cf5b1248b2c8b522ddaccbd66`
(Sourcify-verified, as is v1) responds with:

- ERC-7572 `contractURI()` (on-chain `data:` JSON) plus a deployer-only
  `setTokenURI` iteration hook;
- an uncompressed copy of the SVG (auto mode cannot signal
  `Content-Encoding`);
- token #1: **auto-mode tokenURI**
  `web3://<store>:11155111/haulObject/<metadataObject>?mime.type=json`,
  with media as auto-mode URLs; #2: `data:` + gateway media; #3: ERC-6944
  native.

Result on nftinspector.xyz for token #1: **74/100 "Hosted Guarded"** (up
from 0/100 "Dead"), metadata badged Onchain (`web3 -> data`), and **both
the SVG and the 19-chunk animation render in its preview** — a third-party
site loading token media straight from Keel recursion with no gateway.
onchainchecker.xyz recognizes and badges the same metadata as Onchain ·
Web3 but still cannot fetch: its pinned `rpc.sepolia.org` is dead (returns
404 server-to-server; CORS-blocked in browsers) — their infra, affecting
every Sepolia web3-protocol asset there.

Second-round findings that finalized the recipe:

- **Renderers put media URLs straight into `<img>`/`<iframe>` elements.**
  nftinspector's preview set `<iframe src="web3://...">` verbatim — browsers
  cannot load the scheme, so native-URL media shows blank even when the
  site's *analyzer* resolves web3 server-side. Analysis and rendering are
  different pipelines with different capabilities.
- **One unresolvable token can poison a whole collection on some sites.**
  nftinspector caches media hydration per contract; the ERC-6944-URI token
  cached a "resolve mode is not supported" error that surfaced on sibling
  token pages. Token #3 was repointed to the gateway HTTPS form via
  `setTokenURI` to clear it.
- Sites rate-limit their hydration endpoints (429s look like broken tokens
  but pass on retry).

### v3: on-chain materialized `data:` (the both-axes winner)

The gateway-media variant renders but grades "Hosted" (the scorer judges
URL form, not byte residency). `KeelWeb3InlineTokenDemo` at
`0x24931891c79fe2ad8df9c5dbd23313f647558112` (Sourcify-verified) closes the
gap: `tokenURI()` is a **view that materializes the whole document
on-chain** — `haulObject` assembles the flat chunk sequence live from the
KeelHold and inlines image and animation as `data:` URIs inside a
`data:application/json;base64` response. Bytes live once in Keel; the
only per-token storage is two `bytes32` object ids. nftinspector result:
**88/100 "Onchain Immutable", Trustlessness 100/100**, every component
badged Onchain, and both media render — no gateway, no resolver, no
"Hosted" note. Constraint: media must be stored uncompressed (haulObject
serves stored bytes verbatim), and eth_call must fit the assembled +
base64-inflated document (~4/3 x media bytes; practical ceiling well over
1 MB).

Final tokenURI recipe, validated end to end:

- `tokenURI`: auto-mode web3:// (best on-chain grading that still resolves;
  74/100 vs 43/100 for the gateway-media variant) **or** `data:` JSON.
- `image` / `animation_url`: **gateway HTTPS URLs** — the only form that
  both analyzer and renderer pipelines handle everywhere.
- `web3_image` / `web3_animation_url`: native web3:// for wallets, viewers,
  and gateways that resolve the scheme themselves.
- Never ship a raw ERC-6944 URI as any token's `tokenURI` on a collection
  that must display on today's third-party sites.

## 12. Any HTML viewer, separately

`examples/demos/keel-web3-adapter/web3-stream-loader.mjs` +
`web3-stream-viewer.html` (raw objects) and `web3-token-viewer.html`
(ERC-721 tokens: reads `tokenURI` over raw JSON-RPC, resolves `data:`,
`https:`, and native `web3://` URIs, prefers the `web3_*` metadata fields)
demonstrate that a viewer needs **no Keel code and no libraries** to
consume the recursion: raw JSON-RPC `eth_call` over
`fetch()`, ~120 lines of hand-rolled ABI codec for the ERC-5219 `request()`
tuple, `web3-next-chunk` following, and platform `DecompressionStream` for
encodings. The viewer page takes `?rpc=&adapter=&object=`, streams the
artifact, and renders it into a sandboxed iframe under the served
`Content-Type` — verified live in a browser against anvil with both a
self-contained animated artifact and the 714 KB gallery bundle (the bundle
streams byte-exact; its full visual render additionally needs the host
context its own runtime expects, which is an application concern, not a
transport one).
