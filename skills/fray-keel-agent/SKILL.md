---
name: fray-keel-agent
description: Prepare a Fray auction through Keel when a creator asks an agent to publish artwork, reuse an indexed module, choose a supported testnet, or hand work to a wallet for approval. Use with the portable Keel Keel MCP server; never sign, submit, claim faucet funds, or move wallet assets on the creator's behalf.
---

# Fray Keel Agent

Use this skill when the creator says things like “upload Doom as a Sepolia
Fray auction,” “reuse the Three.js module,” or “prepare this release for my
wallet.” The MCP server is the portable cross-agent layer; this skill supplies
the conversation and safety rules.

## Intake

Call `fray-auction-intake` before preparing a publication handoff.

- If `title` is absent, ask what to call the artwork.
- If `description` is absent, ask for text or whether to use the short default.
- If `auctionPreset` is absent, offer exactly these choices and accept only `1`, `2`, or `3`:
  1. Quick test — one-hour bidder-only auction.
  2. Standard — twenty-four-hour auction with the ordinary patron round.
  3. Collector — three-day auction with a larger patron edition.
- If the chain is absent, ask which supported testnet to use. Use `keel-chain-guide` to show current testnet/faucet links.

Do not fill in a missing title, silently select a fourth auction mode, or turn a
mainnet request into a testnet request. Keep the creator's exact title,
description, chain, and preset in the approval envelope.

## Reuse before upload

When the request names a library or runtime such as Three.js, call
`keel-library-search` with the configured Keel Studio URL. Treat results as
metadata only. Bind a candidate only when its exact identity,
policy/catalog commitment, license, and intended role are visible. If more than
one candidate matches, ask the creator to choose; if no candidate matches, plan
a new upload. Never fetch or execute a carrier just because an index lists it.

## Stage the project before wallet approval

After intake and module selection, call `fray-stage-project` when a source path
is available. It sends the bounded source to the configured Fray Studio
temporary project store, where the Studio creates the collector-facing still
and (for scripts, WASM, HTML, or video) a bounded preview video. The returned
handoff URL is the only link to show the creator.

For a script or video, ask for the preview capture choice before staging:

- still: `hook`, a millisecond `timestamp`, or `settle`;
- video start: `hook`, a millisecond `timestamp`, or `settle`, plus duration and
  fps.

The default, when the creator explicitly chooses it, is a hook capture and a
three-second, twelve-fps video. The Studio runs the capture in its isolated
preview environment and records the choice with the staged project.

The handoff attaches the project to the creator only after the creator signs in
to Studio with the wallet session. The agent never receives a private key or a
wallet signature. A project that has been attached appears in **Agent-prepared
projects** and can be reopened later.

## Approval handoff

The completed intake returns a digest-bound `fray-approval-request@1` envelope.
Show the creator:

- title and description;
- selected chain and native currency;
- selected auction preset and its values;
- reused modules/library bindings or the explicit “new upload” result;
- the API request scope and wallet execution mode.
- the temporary-project expiry, still/video capture choice, and the Studio
  handoff URL;
- the fee preflight, including native cost, USD estimate, timestamp, and whether
  it came from live RPC or a configured fallback. The Studio refreshes this on
  open and the wallet remains final.

Then stop at the approval boundary. The API request is user-approved, and the
wallet is user-controlled. Prefer EIP-5792 `wallet_sendCalls` on EVM and a
Beacon batch operation on Tezos when the connected wallet advertises those
capabilities. One cryptographic signature is capability-dependent; otherwise
present the sequential wallet approvals clearly. Never report an auction as
minted or uploaded until the wallet UI and chain readback provide receipts.

## Testnet funding

Use `keel-chain-guide` to show faucet links. The creator opens and claims
funds; the agent does not call a faucet, store a private key, or infer that a
balance exists. Confirm the wallet network and balance in the wallet/application
before asking for the publication approval.

For the portable MCP connection example, read
[mcp-config.md](references/mcp-config.md).
