# Project planning and routes

Read this reference while resolving a new project's intent. Prefer the live MCP
schemas and returned data when they differ from prose here.

## Intent worksheet

Capture known answers and ask only for missing decisions:

| Decision | Choices |
| --- | --- |
| Scope | one-of-one, collection |
| Outcome | storage-only, release, fixed-price, claim, Fray auction |
| Runtime | static media, p5, Three.js, Doom WASM, Flash AS3, other |
| Chain | creator-selected supported chain/testnet |
| Storage | explicit native/Inline/Hybrid/IPFS route; never silently changed |
| Viewer | registered canonical KEEL verification shell for every viewer |
| Modules | exact reusable same-chain bindings or explicit new-publication plan |
| Evidence | local, contract, catalog, browser, and live-chain gates needed |

Use `keel-studio-project-intake` for ordinary work. `storage-only` stages and
verifies without inventing a token or sale. `release` carries an editable
one-of-one, limited-edition, or open-edition intent and an explicit fixed-price,
auction, or claim mechanism. No intake or staging call creates the token or sale.

Planning terms are not intake arguments. Translate them exactly:

| Planning choice | MCP input |
| --- | --- |
| storage-only | `outcome: "storage-only"` |
| fixed sale | `outcome: "release"`, `release.saleMechanism: "fixed-price"` |
| claim | `outcome: "release"`, `release.saleMechanism: "claim"` |
| 1/1, limited, open | matching `release.type` |
| chain/testnet text | numeric `chainId` after resolution |
| runtime | retain in plan/staging; do not pass to intake |
| Fray auction | use `fray-auction-intake`, not Studio project intake |

## Token, sale, and auction routes

- **1/1:** stage the exact project, then use
  `keel-creator-collection-prepare` only if a new collection is wanted. A
  dedicated ERC-721 plan can use maximum supply 1; preparation does not mint it.
- **Collection:** choose dedicated ERC-721, dedicated ERC-1155, shared ERC-1155,
  or a creator-controlled external contract. Never substitute one lane. Preserve
  collection type, supply, royalty receiver/bps, renderer, and metadata digest.
- **OneMint/drop:** treat OneMint as contract behavior, not an upload mode. Verify
  route registration, target authority, reserved capacity, stage schedule,
  allowlist/signature rules, wallet limits, payment asset/amount, pause/close,
  and replay protection in the contracts suite before a live test.
- **Fixed sale or claim:** keep the sale mechanism, price, start/end, and supply
  explicit in the editable Studio release intent. Staging does not list it.
- **Fray auction:** use `fray-auction-review`, then `fray-auction-intake`. Offer
  exactly four presets: `1` Quick test, `2` Standard, `3` Collector, and `4`
  Fray Auction showcase. Bind the full family-specific terms returned by the
  SDK; never infer terms from the number alone.

## Runtime routes

### Static image, video, or self-contained GLB

Stage the direct creator asset. Do not generate `index.html`. Studio resolves
the registered `keel.asset-display@1` module inside the canonical shell. A
`.gltf` with undeclared external dependencies is not eligible for this compact
route.

Repository example: `examples/image-wrapper`.

### p5

Stage creator scripts/assets only. Bind exact same-chain p5 and
`keel.seeded-random` module objects. Do not bundle another p5 runtime into each
project and do not use a CDN fallback.

Repository checks:

```bash
pnpm --dir examples/agent-p5-project test
pnpm build
```

Staging additionally requires current receipt-backed module bindings and a
scoped Studio token; local tests do not establish either one.

### Three.js

Stage the creator scene/model/assets. Bind the exact selected-chain Three.js
module graph; the supported r180 ESM route has distinct main/core objects and
both must verify. Do not embed Three.js per artwork.

Repository checks:

```bash
pnpm test:browser
pnpm verify:three-one-of-one
```

The browser gate runs the fixture's browser-only probe under a network-denied
local server; do not execute `fixture-probe.mjs` directly with Node. The
container check is offline/review-only. Neither proves a public viewer or
transaction.

### Doom WASM

Treat the compiled WASM as the decoded artifact and use a recursive native
object plan for large bytes. Pin the source commit and input WAD digest. Declare
the WASM sandbox/runtime modules and a bounded capture choice; no WAD is assumed
to be in the repository.

Start at `examples/demos/doom-wasm/README.md`. Local managed verification is:

```bash
# In a separate terminal, start a disposable local chain.
anvil --port 8545

# Then compile and run the verifier from the SDK workspace.
pnpm contracts:compile
KEEL_DOOM_STORED_INPUT_PATH=/absolute/path/to/release-candidate.bin.br \
  pnpm verify:doom-managed-local
```

This requires a fresh local Anvil listener. The script verifies the explicit
container before local writes and does not silently fetch it from a public RPC.
Label Anvil and Tezos mockup results as local. They do not prove public-chain
gas, hosted playback, or wallet execution.

### Flash AS3 / Ruffle

Compile the creator's AS3 into a SWF and stage the SWF plus project declaration.
Reuse exact same-chain Ruffle loader/runtime/core/WASM, seeded-random, and any
declared Brotli decoder objects. Modern-only Ruffle is a valid project choice;
do not silently add a legacy fallback or upload local runtime bytes when a
binding is missing.

In the sibling `flash-keel` checkout, the local gate is:

```bash
npm run verify
```

That gate verifies the pinned local SWF, preview, runtime, and shell plan. Do not
run the shell-regeneration command merely to check the project: a regenerated
escape sequence can differ from the receipt-pinned shell bytes. A successful
local gate remains separate from module receipts, mint receipts, tokenURI
read-back, and hosted Ruffle playback.

## Reuse and JavaScript module indexing

The source workspace owns readable modules; the builder owns deterministic
build receipts and the catalog; chain registries own publication records. Do
not merge those layers into one "indexed" claim.

```bash
keel module build --all --root ./keel-modules
keel module test --all --root ./keel-modules
keel module index --root ./keel-modules --repository https://github.com/you/keel-modules
```

`verified` means the readable source reproduces the exact shipped bytes.
`deployed` means a receipt-backed chain record exists. They are independent.
Indexing is offline and deterministic; `keel module verify --all` is the
separate networked origin-reproduction gate for registered third-party sources.

## Existing draft repair

Use `keel-studio-draft` to read the exact revision first. Preserve every field
the creator did not request to change. Media optimization is dry-run first;
apply only the exact creator-reviewed digest and byte length, write a new file,
and retain the source. Stage corrected bytes, then update with the original
revision. A stale revision or already-reviewed publication stops the workflow.
