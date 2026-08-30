---
name: fray-keel-agent
description: Plan and prepare KEEL 1/1s, collections, reusable browser-art modules, sales, claims, and Fray auctions through the KEEL MCP. Use for p5, Three.js, Doom WASM, Flash AS3, OneMint, storage, or Studio handoffs; never replace the canonical verification shell or perform wallet and chain actions without creator review.
---

# Fray KEEL Agent

Use the KEEL MCP for live capabilities, bounded reads, exact schemas, and
review-only request envelopes. This skill supplies intent discovery, routing,
proof boundaries, and stopping rules. It does not duplicate contract economics
or module records.

## Always begin with a plan

For every new creation, conversion, release, collection, sale, claim, or Fray
auction, enter an explicit planning phase before staging or writing anything.
Use the host's plan mode when available, then request the MCP prompt
`keel-project-plan`. Pass every choice the creator already supplied.

Translate plan choices to the exact MCP schema; never pass planning aliases
verbatim. For an ordinary project, call `keel-studio-project-intake` and ask
only for decisions it still reports missing:

- map fixed sale or claim to `outcome: "release"` plus the exact nested
  `release.saleMechanism`;
- map 1/1, limited edition, or open edition to `release.type`;
- resolve chain text to numeric `chainId` before an ordinary release;
- keep runtime in the plan and later staging/module route, not intake arguments.

For a Fray auction, do not call `keel-studio-project-intake`; call
`fray-auction-intake` with the exact family/network and preset instead.

For every plan, resolve:

- 1/1 or collection;
- storage-only, release, fixed sale, claim, or Fray auction;
- static media, p5, Three.js, Doom WASM, Flash AS3, or another runtime;
- chain/testnet, storage mode, module reuse, and evidence required;
- the point where creator or wallet approval will be required.

Return a concrete plan with project graph, storage/presentation, contracts and
sale path, verification gates, approval boundary, and open questions. Stop at
the plan until the creator asks to continue. Read
[project-routes.md](references/project-routes.md) for route-specific decisions.

## Canonical shell is mandatory for viewers

For every collector-facing viewer, omit `viewer` for the normal path. Studio
selects the registered `keel-verification-shell` graph and does **not** ask the
agent to create another shell. Never author, copy, fork, shrink, replace, or
upload default-shell bytes. If the selected-chain shell record or required
module binding is missing, stale, or ambiguous, stop.

`viewer: "none"` is only an explicit raw-artifact route with no viewer. It is
not a custom-shell route; the immutable artifact can still be released, minted,
and read directly from its contract descriptor. Creator-authored HTML is still
valid project content and runs inside the canonical shell; it never replaces
the shell.

Read [default-shell.md](references/default-shell.md) before staging any viewer.
The canonical implementation map and security contract live in the repository's
`docs/KEEL_VERIFICATION_SHELL.md`; cross-link that document instead of copying
its implementation details into project files.

## Execute the approved plan

1. Inspect the exact local inputs without changing them. Use `analyze`, `cost`,
   and `media-optimize` only as review-only measurements.
2. Search `keel-library-search` before uploading p5, Three.js, Ruffle, decoders,
   seeded-random, or another reusable module. A catalog row is metadata; require
   the exact selected-chain object and registry receipts/read-back before binding
   it as published.
3. Build and test creator-owned bytes locally. Keep source, built output, module
   catalog, browser/runtime, and live-chain evidence separate.
4. Stage only creator resources with `keel-studio-stage-project`, or use
   `fray-stage-project` after `fray-auction-intake` for a Fray auction. Show only
   the server-issued Studio handoff URL.
5. Prepare collection or wallet requests only after the staged project digest,
   selected chain, contract lane, and current creator nonce are exact. MCP output
   remains review-only.

For large objects, mode selection, gas accounting, retry, or recovery, read
[publication-modes.md](references/publication-modes.md). Never silently change
storage or presentation mode during a retry.

## Fray auction choices

Offer exactly four choices and accept only `1`, `2`, `3`, or `4`: Quick test,
Standard, Collector, or Fray Auction showcase. Preset numbers are conversation
shorthand only. Show the complete digest-bound terms returned by
`fray-auction-intake`; do not recreate those economics in the skill.

## Proof and authority

Read [proof-and-approval.md](references/proof-and-approval.md) before any Studio,
wallet, recovery, or live-chain step. In particular:

- local/unit success does not prove browser behavior or a public deployment;
- browser success does not prove the bytes were published onchain;
- a transaction receipt does not prove tokenURI, module, or viewer read-back;
- a planned module ID is not a receipt-backed module binding;
- MCP never signs, submits, claims faucet funds, handles a private key, or
  reports a mint, auction, sale, or upload as complete without the relevant
  receipt and read-back evidence.

For the portable MCP connection and local self-test, read
[mcp-config.md](references/mcp-config.md).
