# THE KEEL LEXICON

```
    ██╗  ██╗███████╗███████╗██╗
    ██║ ██╔╝██╔════╝██╔════╝██║
    █████╔╝ █████╗  █████╗  ██║
    ██╔═██╗ ██╔══╝  ██╔══╝  ██║
    ██║  ██╗███████╗███████╗███████╗
    ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝
    every word is one hard word doing one job
```

We threw out the engineering vocabulary. Every term below is one hard word doing
one job — so a collector, a gallery, and an engineer can all use the same
sentence and mean the same thing. This file is canonical: when a contract, a
doc, and a conversation disagree, this file wins.

## The platform

| Term | Role | Replaces |
|------|------|----------|
| **KEEL** | The platform. Everything below. | Stratus / OCA |
| **FRAY** | The contest that discovers price. | the auction |
| **SLAB** | The object that lands in your wallet. | the NFT |
| **RITE** | The standard every Slab is struck under. | the smart contract |

## The layers

Eight layers. Each one has exactly one job, in the order the artwork moves
through them.

| # | Layer | Its one job | Where it lives |
|---|-------|-------------|----------------|
| 01 | **THE DIE** | The artist's contract. Strikes the tokens: who may buy, how many exist, what each one points at. | [`KEEL721`](../packages/contracts/src/modules/keel-die/KEEL721.sol), [`KeelFactory`](../packages/contracts/src/modules/keel-die/KeelFactory.sol), [`KeelMintGate`](../packages/contracts/src/modules/keel-mint-access/KeelMintGate.sol) |
| 02 | **THE HOLD** | Where the bytes live on the chain. Shared, permanent, never moves. | [`KeelHold`](../packages/contracts/src/modules/keel-hold/KeelHold.sol), [`Ingot`](../packages/contracts/src/modules/keel-hold/Ingot.sol) |
| 03 | **THE INDEX** | The sealed inventory. Every piece the work is made of, and its Mark. | [`KeelIndex`](../packages/contracts/src/modules/keel-hold/KeelIndex.sol), [`KeelArtifactRegistry`](../packages/contracts/src/modules/keel-artifacts/KeelArtifactRegistry.sol) |
| 04 | **THE CRUCIBLE** | Proves the work on every open, on the viewer's own machine. Clean, or slag. | `keel-crucible/` registries + the viewer-side verifier |
| 05 | **THE HARNESS** | Runs the art sealed off from your wallet and the open internet. Contains the Cage. | [`KeelHarnessRegistry`](../packages/contracts/src/modules/keel-artifacts/KeelHarnessRegistry.sol), [`KeelHarnessBuilder`](../packages/contracts/src/modules/keel-harness/KeelHarnessBuilder.sol) |
| 06 | **THE ANCHOR** | A copy of the exact bytes driven into another chain. | `keel-anchors/` — attested, portable, zk, IPFS |
| 07 | **PARTS & INLAYS** | Art built out of other art, verified as hard as its host. | `keel-graph/`, `keel-equipment/` |
| 08 | **THE SLEEVE** | What ordinary marketplaces see. Boring, standard, works everywhere. | [`KeelSleeve`](../packages/contracts/src/modules/keel-sleeve/KeelSleeve.sol), the ERC-721/2981/4906 surface of `KEEL721` |

## The parts

| Term | Role |
|------|------|
| **SLUG** | One cut piece of the work, ~23 KB — the largest bite the chain takes comfortably. |
| **INGOT** | The chain-cast block a Slug lives in. Code-as-data with a halt byte up front: it can never execute. |
| **WELD** | Ingots joined into a tree. Up to 128 children per weld; welds stack on welds. |
| **MARK** | A piece's unique fingerprint. Change one byte and the Mark changes completely. |
| **POUR** | One run through the Crucible. |
| **HAUL** | Everything that came out clean. |
| **CAGE** | The sealed box inside the Harness. No wallet, no network, no neighbours. |
| **SEAM** | The only way in or out of the Cage. Size-capped, shape-checked, rejected by default. |
| **KNOCK** | The art requesting. It can knock; it cannot reach. |
| **GUARD** | What the art is allowed to do. |
| **ACCORD** | The permissions all four parties agreed on: artist, parts, gallery, chain. Always the smallest set. |
| **GRIP** | How many chains hold an Anchor. |

## The four verdicts

Every artifact, every part, every mod is in exactly one of these states.

| Verdict | Meaning |
|---------|---------|
| **RAW** | Never tested. No claims made. |
| **CLEAN** | Came out of the Crucible whole. |
| **STALE** | Was clean once. Superseded now. |
| **SLAG** | Failed. The bytes lied. Rejected. |

And one more: **BURNED** — a human with authority killed it deliberately.
Slag and Burned are different events, and Keel says which one happened.

## The verbs — how the API speaks

The public methods carry the vocabulary. The famous flows read like the
process they are:

| Doom verb | What it does | Where |
|-----------|--------------|-------|
| `castSlug` / `castSlugs` | Write cut pieces into the chain as Ingots. | `KeelHold` |
| `weldObject` / `weldComposite` | Join slugs (or objects) into a tree. | `KeelHold` |
| `haulObject` | One call, the entire working file back out. | `KeelHold` |
| `forgeArtifact` (+`For`, `WithRevisionPolicy`) | Register one complete work above the bytes. | `KeelArtifactRegistry` |
| `appendArtifactRevision` / `freezeArtifact` | Move a work's lineage forward, or seal it forever. | `KeelArtifactRegistry` |
| `forgeHarness` / `forkHarnessForToken` / `effectiveHarness` | Pin what runs, fork it per token, resolve what's live. | `KeelHarnessRegistry` |
| `harnessHTML` / `protectedHarnessDataURI` | Rebuild the sealed runtime from chain bytes. | `KeelHarnessBuilder` |
| `castDie` / `castDieFor` / `predictDieAddress` | Deploy an artist's Die at a known address. Event: `DieCast`. | `KeelFactory` |
| `strikeFromManager` / `adminStrike` / `reserveStrikeCapacity` | The Die strikes tokens; capacity lives on the die itself. | `KEEL721` |
| `driveAnchor` / `stampNative` / `setAnchor` / `grip` | Drive a copy into another chain; sight it; set it; count the chains that hold it. | `keel-anchors` |

## Old name → new name

The engineering names this vocabulary replaced, for anyone reading old
history, old deployments, or old ABIs:

| Old | New |
|-----|-----|
| Stratus (platform) | Keel |
| OCA / OCA721 / STR721 | KEEL721 |
| StratusFactory / OCAFactory | KeelFactory |
| ChunkStore | KeelHold |
| BytecodeBlob | Ingot |
| ArtifactRegistry (presentation revisions) | KeelIndex |
| StratusObjectRegistry | KeelArtifactRegistry |
| StratusViewerRegistry | KeelHarnessRegistry |
| StratusOnchainHTMLBuilder | KeelHarnessBuilder |
| StratusMetadataResolver | KeelSleeve |
| MintAccessManager | KeelMintGate |
| a chunk | a Slug |
| a viewer | a Harness composition |
| an anchor | still an Anchor — that one was always right |
| `putChunk(s)` | `castSlug(s)` |
| `createObject` (hold) / `createCompositeObject` | `weldObject` / `weldComposite` |
| `readObject` | `haulObject` |
| `createObject` (registry) / `object*` reads | `forgeArtifact` / `artifact*` |
| `createViewer` / `viewer*` | `forgeHarness` / `harness*` |
| `createCollection` | `castDie` (event `CollectionCreated` → `DieCast`) |
| `mintFromManager` / `adminMint` | `strikeFromManager` / `adminStrike` |
| `requestAnchor` / `anchorNative` / `finalizeAnchor` | `driveAnchor` / `stampNative` / `setAnchor` |

> Deployed contracts from the Stratus era keep their old ABIs. The rename is
> source-level; anything already on a network answers to its old selectors and
> domain strings until redeployed.

### Wire formats keep their bytes

A few identifiers are **format magic, not branding**, and deliberately keep
their old spelling until the format itself revs — changing them would orphan
every manifest and descriptor already published on chain:

- `oca-manifest@2` — the manifest format id (becomes `keel-manifest@3` at the
  next format bump, not before)
- `oca://` — the virtual route scheme inside the sandbox
- `oca.per-token-mint-data.v1` and similar already-deployed hash domains
- `STR3` (`0x53545233`) — the descriptor magic in `KeelHold`

New domain separators introduced after the rename are `keel.*`; the recorded
cross-language golden vectors were re-cut for every renamed domain.
