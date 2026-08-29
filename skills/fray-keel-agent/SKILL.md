---
name: fray-keel-agent
description: Prepare a KEEL Studio storage-only project, optional release/listing, Fray auction, or large publication when a creator asks an agent to stage artwork, reuse an indexed module, or hand work to Studio for review. Use with the portable KEEL MCP server; never sign, submit, claim faucet funds, or move wallet assets on the creator's behalf.
---

# Fray Keel Agent

Use this skill when the creator says things like “upload Doom as a Sepolia
Fray auction,” “reuse the Three.js module,” or “prepare this release for my
wallet.” The MCP server is the portable cross-agent layer; this skill supplies
the conversation and safety rules.

For a large object, storage-route decision, gas quote, retry, or recovery, read
[publication-modes.md](references/publication-modes.md) before planning. Resolve
the configured public endpoints with `keel-endpoint-config`; explicit tool input
wins over KEEL environment configuration, which wins over the canonical KEEL
test defaults. Never silently retain or substitute a Stratus hostname.

## Studio project intake

Call `keel-studio-project-intake` for an ordinary creator project. Give it every
decision already present in the request and ask only the questions it returns.

- “Put this on KEEL” may finish as `storage-only`: stage, sandbox, store, and
  verify the work without inventing a token, sale, or listing.
- “Make this a one-of-one and list it for 0.1 ETH” is `release`: prefill an
  editable release intent and let Studio handle the remaining storage, quote,
  contract, and listing choices.
- If the requested outcome is ambiguous, ask once: storage and verification
  only, or also an editable release/listing?

Do not require a listing to complete storage. Do not silently create a sale.
The MCP agent stages the exact project graph and returns one Studio link;
Studio owns route benchmarking, the visual gas/read explanation, ETH/USD quote,
and final editable decisions.

## Fray auction intake

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

For ordinary KEEL work that is not a Fray auction, use
`keel-studio-stage-project`. Omit `viewer` for the normal path: the SDK selects
`keel-verification-shell`, and Studio later resolves and reuses the selected
chain's existing pre-encoded KEEL Inline shell graph. Studio does **not** ask
the agent to create another shell. Use `viewer: "none"` only when the creator
explicitly requests an artifact/storage-only project with no viewer.

Declare only creator-owned project files. An image project normally stages the
image alone with role `image`; p5 or Three work stages only its creator
script/assets plus exact same-chain module declarations. Never manufacture or
label a local `viewer.js`, `index.html`, protected-harness wrapper, or other
file as the default KEEL verification shell. If the selected-chain shell or
module catalog is missing, stale, or ambiguous, stop: do not substitute a local
wrapper. Creator-authored HTML is still valid project content, including an
actual artwork named `index.html`; it runs inside the canonical KEEL shell and
does not replace it. The server-issued handoff URL is the only project link the
agent should show.

## Repair an existing draft

When a creator opens a draft and asks the agent to rename it, change the sale,
or attach a corrected prepared artifact, use `keel-studio-draft`. The scoped
key belongs in `KEEL_STUDIO_AGENT_TOKEN`; never copy it into tool arguments,
chat, logs, or a handoff URL.

1. `list` or `read` the creator-owned draft first.
2. Preserve its returned `revision` and every field the creator did not ask to
   change.
3. For media changes, run `media-optimize` as a dry-run and show the measured
   before/after bytes and percentage. Do not change storage mode. A local CLI
   user may explicitly apply a smaller candidate to a new file; the source is
   retained.
4. Stage corrected project bytes as a new project handoff. The creator still
   signs in and prepares those bytes in Studio; an agent grant does not bypass
   project verification.
5. After Studio returns the new artifact ID, call `update` with the exact prior
   `revision`. A stale revision stops instead of erasing newer browser work.

Draft tools never review, cancel, sign, submit, or confirm a publication. If a
release is already under review, stop and let the creator cancel that review in
Studio before editing.

When the creator wants a new token contract or wants to organize an existing
contract, call `keel-creator-collection-prepare` only after the project and
metadata digest are exact. Choose one lane: dedicated ERC-721 for individually
numbered works, dedicated ERC-1155 for many edition items in one creator
contract, shared ERC-1155 for the lowest deployment cost, or external for a
creator-controlled bring-your-own contract. Never substitute one lane for
another. Missing or ambiguous factory/renderer deployment records are a safe
stop, not a reason to invent an address or request approval. A review-only plan
still requires an exact factory-to-renderer read-back before Studio may show the
wallet action; collection creation does not mint an item or create its sale.

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
