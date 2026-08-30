# `@keel/mcp`

A stdio MCP server for the headless Keel/Keel builder and Fray agent
workflow. It exposes strict local planning tools, conversational Fray auction
intake, supported-testnet/faucet guidance, and an optional bounded search of an
explicit Keel Studio Keel index. It never signs, submits, claims faucet funds,
or mutates a wallet or chain; wallet output is a canonical request envelope for
a separate user-approved wallet UI.

```bash
pnpm install
pnpm --filter @keel/mcp build
node packages/mcp/dist/cli.js --workspace /path/to/project
```

When `@keel/mcp` is installed as a package, the equivalent launcher is
`keel-mcp --workspace /path/to/project`.

For a new work, start with the `keel-project-plan` prompt. It discovers whether
the creator is making a 1/1 or collection, storage-only work, fixed sale, claim,
or Fray auction; routes p5, Three.js, Doom WASM, and Flash AS3; and returns an
explicit review-only plan before staging. It reads the machine-readable
`keel://mcp/project-routes` and `keel://mcp/publication-modes` resources instead
of reproducing contract policy in prompt text. Every collector-facing viewer
uses the registered canonical KEEL verification shell. The MCP never authors,
copies, shrinks, replaces, or uploads that shell.

Use `--help` or `--version` for portable launcher discovery. For a deterministic
repository-local health check, run
`node packages/mcp/dist/cli.js --self-test --workspace /path/to/project`;
it performs `initialize`, `ping`, `tools/list`, `prompts/list`, `prompts/get`, and static resource checks in-process and emits one
non-RPC JSON summary. It reads the workspace root but does not start stdio,
write files, fetch a carrier, sign, or submit.

For Codex, add the built stdio server and confirm discovery:

```bash
codex mcp add keel -- node /absolute/path/to/keel-sdk/packages/mcp/dist/cli.js \
  --workspace /absolute/path/to/project
codex mcp list
```

Use the equivalent `[mcp_servers.keel]` table in a project's
`.codex/config.toml` when the connection should be repository-scoped. Skill
discovery and MCP configuration are separate; installing the skill does not
install or start this server.

For a local agent configuration, point the MCP client at the built CLI:

```json
{
  "mcpServers": {
    "keel-mcp": {
      "command": "node",
      "args": ["/path/to/keel-sdk/packages/mcp/dist/cli.js", "--workspace", "/path/to/project"]
    }
  }
}
```

Messages are newline-delimited JSON-RPC. Initialize first, then use
`tools/list` and `tools/call`. The twenty-seven tools are `analyze`,
`media-optimize`, `media-optimize-apply`, `build`, `verify`, `cost`,
`upload-plan`, `chain-plan`, `ethereum-encode`, `publish-plan`,
`module-resolve`, `module-lock`, `wallet-request-prepare`, `wallet-link`,
`module-review-prepare`, `fray-auction-intake`, `fray-stage-project`,
`keel-chain-guide`, `keel-library-search`, `keel-endpoint-config`,
`keel-studio-capabilities`, `keel-studio-project-intake`, `keel-studio-draft`,
`keel-studio-stage-project`, `keel-creator-collection-prepare`,
`keel-shell-search`, and `keel-shell-prepare`.
File arguments must resolve inside the selected workspace; regular-file reads
reject final symlinks, traversal, unstable content, and oversized frames/files.
Builds and lock sidecars are local writes only. Wallet preparation returns a
digest-bound request/QR payload for review; it never signs or submits. Module
carriers are metadata-only in this offline server, so `bytes-unavailable` is
not content verification. Verify reads are capped at 256 MiB per source and
4 MiB for manifests; remote carrier URIs remain unavailable rather than being
fetched.

`upload-plan` is a dry-run planner. It reads at most 256 MiB from the
workspace, computes a deterministic flat or recursive chunk plan using the
builder's documented limits, and removes temporary chunk files before
returning. The response marks `materialized: false` and
`files: "unavailable-after-dry-run"`; plan file names are descriptors, not
available output paths. Detailed plans are capped at 256 KiB so the duplicated
MCP text/structured response stays below the 1 MiB stdio frame budget; use the
builder CLI for larger materialized plans. It does not write the workspace,
fetch a carrier, sign, or submit.

`chain-plan` consumes a materialized builder upload plan and a review target
(currently Ethereum only). It verifies each local chunk file and emits
deterministic `castSlugs`, `weldObject`, and recursive composite descriptors.
ABI calldata and chunk IDs remain deferred to a contract-specific adapter; the
result is `status: "review-only"`, `chainReady: false`, with signing and
submission explicitly marked `not-performed`. `sourcePlan.path` identifies the
workspace-relative plan directory used to resolve each `chunkFiles` entry.
Tezos requests fail closed until
a Tezos contract adapter is provided. Chunk files and decoded plan digests are
verified locally, but this offline descriptor does not fetch a chain, sign,
submit, or claim that ABI encoding has occurred. Recursive plans are bounded to
512 objects, 256 MiB of retained decoded bytes, and responses to 256 KiB.

`ethereum-encode` is the first family-specific offline encoder. It reads a
materialized upload plan and its relative chunk files through the same bounded,
non-symlink workspace reader, derives Keccak chunk/object IDs with viem, and
emits exact unsigned `castSlugs`, `weldObject`, and composite calldata for
review. It does not query RPC, verify target bytecode, simulate, sign, submit,
or create a WalletConnect/Beacon QR payload. `qr: true` is reported as
`transport.qr: "unsupported"`; large `castSlugs` calldata exceeds the custom
SDK QR budget. A later transport must rebind the plan, pin chain/code state,
simulate, and hand the resulting unsigned request to the user's wallet UI.

`publish-plan` wraps the structured `chain-plan` result in the SDK's
`keel-publish-plan@1` envelope. It strips local paths from the committed
source summary, re-validates operation shapes and limits, binds a canonical
SHA-256 envelope integrity, and remains `review-only`/`chainReady: false`.
The embedded object IDs are explicitly logical builder IDs, not chain IDs;
the adapter must recompute chain IDs from bytes and receipts. Local source paths
are not committed in the envelope, so an adapter must retain its own bounded
workspace binding rather than resolving paths from this result. The canonical
detail is capped at 256 KiB so the duplicated MCP text and structured response
remains within the stdio frame budget.
It does not derive Keccak chunk IDs, encode calldata, perform Tezos packing,
query a target contract, sign, or submit. A future family-specific adapter must
do those steps and provide its own readback/receipt proof.

## Module snapshots and locks

`module-resolve` and `module-lock` consume a local
`keel-module-resolver-snapshot@1` JSON snapshot. Its catalog is the
`keel-module-catalog@1` release list; optional `display` entries contain
artist/tags metadata keyed by the exact release identity. Select by exact
`sha256` plus `byteLength`, or by normalized `name`, `artist`, and/or `tags`.
Ambiguous selectors fail closed. `module-lock` writes the canonical lock to
the requested workspace path and a `.receipt.json` envelope containing the
receipt digest. No carrier is fetched, and a lock with `bytes-unavailable`
must not be presented as content verification.

## Fray agent intake

`fray-auction-intake` is the cross-agent conversation boundary. When the title,
description choice, chain, or auction preset is missing it returns `needs-input`
with the exact question to ask. It exposes exactly four presets and accepts
only preset `1`, `2`, `3`, or `4`: Quick test, Standard, Collector, or Fray
Auction showcase. It does not silently invent an auction policy.
Once complete it resolves the family-specific `fray-auction-policy@1` profile
from `@keel/sdk` and includes every economic term in the digest-bound
`fray-approval-request@1` envelope. Preset IDs are conversation shorthand, not
economic authority. Values are canonical integer `wei` or `mutez`, and the
policy preserves the current Studio values for each chain family.

`fray-stage-project` hashes the bounded local source and materializes a
`fray-auction-intent@1` envelope that binds the source, chain, native atomic
unit, policy version, and all auction terms. That full envelope is sent to the
temporary Studio stage and returned for independent verification; a mismatched
release outcome fails before the request. It first opens the Studio's resumable
content-addressed upload path, hashes every bounded part, and completes against
the ordered source manifest. Older or unconfigured Studios fall back to the
bounded base64 route. Staging is not the zero-write local sandbox. It still does
not sign or submit. The envelope says `signing` and `submission` are
`not-performed`; an EVM client should request EIP-5792 batching when supported,
and a Tezos client should request a Beacon batch when supported, with sequential
wallet approvals as the explicit fallback.

`keel-chain-guide` returns supported testnets and human faucet links. Faucet
links are informational only: the creator opens the page and claims funds. The
built-in guides cover Ethereum Sepolia, Base Sepolia, and Tezos Shadownet.

`keel-library-search` may query `/api/library` and `/api/modules` on an
explicit HTTPS Keel Studio URL. Set `KEEL_STUDIO_URL` for a configured MCP
server or pass `studioUrl` to the tool. Only bounded JSON metadata is read; no
module carrier bytes are fetched. A single exact candidate can be proposed for
reuse, while ambiguous results require creator selection and every binding is
locked to its catalog/policy commitment.

`keel-studio-capabilities` reads the Studio's public
`/.well-known/keel-capabilities` document before any upload or wallet
action. It reports exact protocol versions, zero-spend sandbox behavior,
ready versus blocked chains, staging limits, quote/authorization rules, and
the Studio's current MSP features. The document is strictly parsed by
`@keel/sdk`; unknown fields and unsupported protocol versions fail closed.

`media-optimize` measures image, video, or self-contained GLB candidates in
memory and reports exact before/after bytes, percentage saved, output digest,
adapter version, and settings. It never writes. After the creator reviews that
result, `media-optimize-apply` may write one new workspace-relative file only
when the recomputed digest and byte length exactly match the reviewed result.
It never overwrites or removes the source, changes the selected storage mode,
uploads, signs, or touches a chain. The JSON/YAML CLI equivalent is
`keel media-optimize --config <file>`; omitted `operation` means `plan`, while
`apply-reviewed` requires the exact reviewed digest and output byte length.

`keel-studio-draft` lists, reads, creates, or revision-safely edits a private
release draft through the creator's scoped `KEEL_STUDIO_AGENT_TOKEN`. The token
is read only from the MCP process environment and is never accepted in tool
arguments. Updates require the current revision, so an old agent response
cannot overwrite newer browser work. The tool has no operation for transaction
review, cancellation, signing, publication, or chain submission.

`keel-studio-stage-project` reads a bounded list of workspace-relative files,
preserves their declared roles, and uploads them to Studio's temporary staging
store. The creator's scoped key stays in `KEEL_STUDIO_AGENT_TOKEN`; the tool
returns the server-issued handoff and reports wallet signing/submission as
`not-performed`. Omit `viewer` to select the canonical KEEL Inline graph
(`keel-verification-shell`) for later Studio preparation; `viewer: "none"`
opts out of the shell only. The immutable artifact can still be released,
minted, and retrieved through its exact contract read. During preparation, Studio resolves
the selected chain's catalog-backed, pre-encoded graph and must fail closed for
an incomplete catalog. Agents supply only creator resources/modules and must
never manufacture or upload a file declared as the default KEEL shell, a
protected-harness wrapper, or a local replacement wrapper when catalog
resolution fails. Creator-authored HTML (including `index.html`) is project
content, not a replacement shell.

For one standalone image, video, or self-contained GLB, later Inline
preparation uses exactly the registered KEEL shell, registered
`keel.asset-display@1`, and the direct creator media entry. This is not a
zero-module project and agents must not generate or upload an `index.html`
wrapper. The reusable module displays image/video data URLs or a self-contained
GLB WebGL view from frozen verified descriptors; it has no network or wallet
authority. A `.gltf` requiring external dependencies is not eligible for this
compact normal-media path.

`keel-creator-collection-prepare` prepares one exact EIP-5792
`wallet_sendCalls` review and the JSON-safe durable recovery envelope that must
be saved before submission. It supports the default ERC-721A clone, standard
ERC-721 compatibility, a compact dedicated ERC-1155, a logical collection in
the shared ERC-1155, or authority-checked bring-your-own registration. The
agent supplies the exact creator nonce it already read; the resulting plan is
bound to owner, executor, factory, renderer, nonce, digest, operation count,
chunk count, and cursor. The tool never signs or submits. A missing or
ambiguous `KeelCreatorFactory` + `KeelArtifactTokenRenderer` pair stops safely
without requesting wallet approval. Before submission, Studio must re-read the
factory's immutable `metadataRenderer`, persist the envelope, and reconcile a
timed-out wallet batch instead of preparing a duplicate approval.

`keel-shell-prepare` creates the canonical `keel-shell-manifest@1` JSON used to
index a reusable shell by creator, name, version, and tags, or prepares the
review-only `registerShell` call after its top, bottom, and metadata objects
exist on the selected chain. It never uploads those objects, signs, submits, or
lets an agent replace the platform default. Ordinary project agents should
still omit `viewer` and use the registered KEEL verification shell. The
default registration mode is `pre-encoded-graph`: one top, ordered shared
modules/work, and one bottom. `sandboxed-html` and `gzip-base64` are explicit
advanced modes, not reasons to manufacture another `index.html`.

`keel-shell-search` queries Studio's independently read-back-verified shell
catalogue by creator, name, version, or tags. It returns only the committed
top, bottom, and metadata pointers; it never downloads carrier bytes or asks
for a wallet action.

`wallet-link` accepts the exact KeelFactory `castDieFor` target,
including factory/version commitments, the Keccak config digest encoding, and
the account's creator nonce. Supply the exact `collectionConfig` tuple (name,
symbol, admin, royalty, supply, mint manager, and artifact registry) to compute
and verify the Keccak digest before MCP emits JSON-safe EIP-712
`CollectionAuthorization` typed data. Missing config returns
`config-verification-required`; a digest mismatch is rejected. The response
includes the normalized config and `configDigestVerified: true`. It rejects
sign/submit scopes, zero or equal account/agent addresses, lifetimes over 30
days, and Tezos until a contract-specific adapter exists. The MCP tool never
signs, calls RPC, approves custody, or submits the authorization; the account
must explicitly review and sign it in a separate connector.

## Static workflow prompt

`prompts/list` advertises `keel-project-plan`, `keel-asset-review`,
`keel-draft-repair`, and `fray-auction-review`.
`keel-project-plan` accepts a creator request plus optional `scope`, `runtime`,
`outcome`, and `chain`; it returns an intent-first plan and stops before all
staging, wallet, and chain actions.
`keel-asset-review` accepts a workspace-relative `input` plus optional
`objectName` and `mediaType`, then returns one deterministic review-only
workflow message. `keel-draft-repair` binds an exact release ID and saved
revision to the dry-run → creator review → explicit optimization apply → Studio
staging → creator preparation → revision-checked update sequence. It never
grants an agent wallet, cancellation, review, or publication authority.
`fray-auction-review` teaches the same intake rules as the
companion skill: ask for title and description, offer exactly four presets,
search Keel before uploading a named reusable module, show faucet links only,
and stop at the digest-bound API and wallet approval boundary. Prompts never
read files, execute the tools, fetch carriers, sign, or submit.

## Static resources

`resources/list` advertises four fixed machine-readable resources:
`keel://mcp/workflow` describes the offline analyze-to-review sequence and
`keel://mcp/limits` records the bounded frame, file, planner, and no-network
limits. `keel://mcp/project-routes` maps creation scope, OneMint,
sale/auction outcome, and p5/Three/Doom/Flash runtimes to existing tools, SDK
builders, contract evidence, and examples.
`keel://mcp/publication-modes` defines storage, compression, recovery, and proof
boundaries. `resources/read` serves those constant JSON documents only; unknown
URIs and extra parameters fail closed, and no workspace or network access occurs.
