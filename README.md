# KEEL SDK

KEEL is a toolkit for storing browser-native artwork as immutable object graphs,
assembling collector-facing token views, verifying every byte before execution,
and preparing mint, sale, collection, and Fray auction actions without giving an
agent control of a wallet.

This repository contains the TypeScript protocol, SDK, builder, viewer, Studio
core, MCP server, examples, and local verification tooling. The EVM contracts
and their Forge tests live in the sibling
[`keel-contracts`](https://github.com/Ravonus/keel-contracts) repository.

## Start here

Requirements: Node.js 22 or newer and pnpm 10.15. Foundry is additionally
required for EVM contract tests.

```bash
pnpm install
pnpm build
pnpm test
```

The broad local gate is:

```bash
pnpm verify
```

This aggregate gate expects the canonical sibling `keel-contracts` and
`keel-site` checkouts. Use `pnpm build` and `pnpm test` for the SDK checkout's
portable local gate.

`pnpm test:conformance` deliberately requires the sibling contracts and related
fixtures. See [Testing and readiness](docs/TESTING.md) for focused SDK,
OneMint, Fray auction, sale, storage, token, module, p5, Three.js, Doom, and
Flash checks.

## Plan a work before staging it

Every new KEEL work starts with intent, then an explicit plan:

1. Is it a 1/1 or a collection?
2. Is the outcome storage-only, a release, fixed sale, claim, or Fray auction?
3. Is the runtime static media, p5, Three.js, Doom WASM, Flash AS3, or something
   else?
4. Which chain, storage mode, reusable modules, contracts, and proof layers are
   required?
5. Where does creator or wallet approval begin?

The MCP prompt `keel-project-plan` performs this discovery and returns a
review-only plan. The repo-local `$fray-keel-agent` skill makes that planning
phase the default agent workflow for 1/1s, collections, OneMint drops, sales,
claims, and Fray auctions.

## The default verification shell is mandatory

Every collector-facing viewer uses KEEL's registered canonical verification
shell. A project supplies creator files and exact module declarations; it never
authors, copies, forks, shrinks, relabels, or uploads another default shell.
Omitting `viewer` in the Studio handoff selects the registered selected-chain
shell graph. If that graph is unavailable or ambiguous, preparation fails
closed.

`viewer: "none"` is the explicit raw-artifact route with no viewer—not a custom
shell route. The immutable artifact remains independently releasable, mintable,
and contract-readable. Creator-authored HTML remains artwork content inside the
canonical shell.

Read [The KEEL verification shell](docs/KEEL_VERIFICATION_SHELL.md) for the
single implementation map, registry checks, protected K control, opaque child
boundary, and exact Ethereum/Tezos reconstruction paths.

## Repository map

| Area | Purpose |
| --- | --- |
| `packages/protocol` | Canonical bytes, manifests, integrity, packing, and shared schemas |
| `packages/sdk` | Typed builders, ABIs, viewer graphs, collection plans, wallet-neutral envelopes |
| `packages/builder` | Media analysis, deterministic module builds, receipts, indexes, and upload plans |
| `packages/viewer` | Verified resource resolution, canonical shell chrome, and sandbox runtime |
| `packages/studio-core` | Project preparation and wrapper orchestration shared with Studio |
| `packages/mcp` | Stdio MCP tools, prompts, and resources for review-only agent workflows |
| `examples` | Static, p5, Three.js, Doom, module, and marketplace fixtures |
| `skills/fray-keel-agent` | Installable agent workflow with progressive references |
| `.agents/skills/fray-keel-agent` | Repo-scoped discovery link to the canonical skill above |

The contract module map is maintained in `tools/keel/module-map.mjs`; contract
sources, module manifests, ABI snapshots, deployment records, and Forge tests
remain in the sibling contracts repository.

Examples and unit fixtures are synthetic. Creator collection names, media, and
release artifacts are project inputs, never SDK modules or catalog entries.

## MCP setup

Build and self-test the local server:

```bash
pnpm --filter @keel/mcp build
node packages/mcp/dist/cli.js --self-test --workspace /path/to/artwork
```

Add the built stdio server to Codex, then confirm that Codex sees it:

```bash
codex mcp add keel -- node /absolute/path/to/keel-sdk/packages/mcp/dist/cli.js \
  --workspace /absolute/path/to/artwork
codex mcp list
```

For repository-scoped configuration instead of a user-level CLI entry, add the
equivalent server table to `.codex/config.toml`:

```toml
[mcp_servers.keel]
command = "node"
args = ["/absolute/path/to/keel-sdk/packages/mcp/dist/cli.js", "--workspace", "/absolute/path/to/artwork"]
```

Other MCP clients can point at the same built CLI:

```json
{
  "mcpServers": {
    "keel-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/keel-sdk/packages/mcp/dist/cli.js",
        "--workspace",
        "/absolute/path/to/artwork"
      ]
    }
  }
}
```

The server advertises focused tools plus four prompts and four static resources:

- `keel-project-plan` for intent discovery and a plan-first handoff;
- `keel-asset-review`, `keel-draft-repair`, and `fray-auction-review`;
- `keel://mcp/workflow`, `keel://mcp/limits`,
  `keel://mcp/project-routes`, and `keel://mcp/publication-modes`.

The MCP does not sign, submit, claim faucet funds, fetch undeclared carrier
bytes, or treat a plan as approval. Optional Studio operations are bounded to
explicitly configured metadata and staging endpoints. See
[`@keel/mcp`](packages/mcp/README.md) for the complete tool and transport
contract.

## Skill setup

Codex discovers the skill automatically when opened anywhere in this repository
through `.agents/skills/fray-keel-agent`, which points to the one canonical
source at `skills/fray-keel-agent`. Codex supports symlinked skill folders; if a
new skill does not appear, restart Codex.

For a separate installation, use the skill installer with this repository path:

```text
$skill-installer Install https://github.com/Ravonus/keel-sdk/tree/master/skills/fray-keel-agent
```

Then start with a request such as:

```text
$fray-keel-agent Plan a deterministic p5 collection on Sepolia with a claim.
```

Installing the skill does not install, start, authenticate, or connect the MCP.
Configure and self-test the server separately.

## Creator and runtime routes

| Work | Creator-owned bytes | Reused system pieces | Starting example |
| --- | --- | --- | --- |
| Image/video/GLB | Direct media | default shell + `keel.asset-display@1` | `examples/image-wrapper` |
| p5 | Script and assets | same-chain p5 + `keel.seeded-random` | `examples/agent-p5-project` |
| Three.js | Scene, model, assets | exact same-chain Three.js module graph | `examples/starters/three-model` |
| Doom WASM | WASM-derived project descriptors | WASM sandbox/runtime + recursive native storage | `examples/demos/doom-wasm` |
| Flash AS3 | Compiled SWF + project declaration | receipt-backed Ruffle/decoder/seed modules | sibling `flash-keel` repository |

A module's planned object ID, catalog name, or local digest is not publication
proof. Bind reusable modules only after object bytes, digest/length, registry
records, and selected-chain deployment receipts have been read back.

## Build, test, and index JavaScript modules

The module pipeline keeps readable source, deterministic shipped bytes, test
vectors, catalog indexing, and chain deployment as separate facts:

```bash
pnpm exec keel module build --all --root ./keel-modules
pnpm exec keel module test --all --root ./keel-modules
pnpm exec keel module index --root ./keel-modules \
  --repository https://github.com/you/keel-modules
```

These forms resolve the checkout-local CLI after `pnpm install`. If the KEEL
CLI is installed separately, the equivalent commands begin with `keel`.

`verified` means the readable source reproduces the exact output. `deployed`
means a chain deployment record exists. Neither implies the other. Read
[The KEEL module pipeline](docs/KEEL_MODULE_PIPELINE.md) and
[Module assurance](docs/KEEL_MODULE_ASSURANCE.md) before publishing or indexing
third-party modules.

## Proof is layered

Local tests prove local behavior. Forge tests prove contract behavior in their
test environment. A deterministic catalog proves indexed source/output
relationships. Browser evidence proves the actual runtime at the tested URL.
A transaction receipt proves one transaction succeeded. Contract read-back
proves the stored state or bytes at a block.

Do not collapse these into one "verified" label. A live publication claim needs
receipts and read-back; a viewer claim also needs browser/runtime evidence.
