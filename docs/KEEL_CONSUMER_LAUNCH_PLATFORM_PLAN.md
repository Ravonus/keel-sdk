# Keel consumer launch platform plan

Date: 2026-08-15

## Product decision

Keel must stop presenting its contract and verification machinery as the
product. The product is a place where an artist can prepare a project, publish
a release, and give collectors a clear page where they can understand and mint
the work. Contracts, event reconciliation, signatures, digests, registries,
controller selection, and indexer state are implementation details used by the
platform to make that journey safe.

This is not a copy rewrite. The current creator and collector launch surfaces
need a new information architecture, a persistent release model in PostgreSQL,
server-side transaction preparation, automatic eligibility resolution, and a
strict separation between consumer UI and operator tooling.

The non-negotiable rule is:

> No creator or collector should ever paste a signature, digest, Merkle root,
> Unix timestamp, calldata, transaction hash, registry address, controller
> address, or raw token ID list into the normal Keel product flow.

Those values can remain inspectable in an expandable proof view and usable in
a protected operator/developer console. They cannot be required product input.

## Audit basis

This plan is based on:

- a route and component audit of all 35 Studio pages and 41 API routes;
- direct source inspection of creator account, project creation, collection,
  launch, mint, marketplace, collector, indexer, and database code;
- a rendered local inspection of `/`, `/create`, `/manage`, `/launch`,
  `/launch/agent`, `/drops`, `/market`, and `/collect`;
- source inspection of the specific collector route because the local database
  backing the current showcase build was unavailable during the audit;
- current launchpad research from OpenSea, Highlight, Manifold, and Foundation.

The local rendered inspection found that `/launch` exposes an operator form for
contract deployment, access configuration, and governance handoff;
`/launch/agent` exposes factory and agent wallet addresses; `/create` could only
show a technical “creation module” reconnection state; and `/launch/mint` failed
as a whole when the system overview database read was unavailable. That last
failure is environment-specific, but the lack of a consumer-safe error boundary
is a product issue.

## What other launch products consistently do

The useful lesson is not to imitate another site's visual design. It is to
adopt the task model consumers already understand.

- [OpenSea Studio](https://support.opensea.io/en/articles/8867080-how-do-i-use-opensea-studio)
  begins with the creator's intent: a scheduled community drop or a collection
  the creator mints directly. It explains the practical difference before any
  contract choice is required.
- [OpenSea Drops](https://support.opensea.io/en/articles/8867043-drops-on-opensea)
  gives every release a landing page with the name, creator, social links,
  schedule, sample gallery, story, team, roadmap, and FAQ. Contract deployment,
  metadata, schedule, and page design are handled in one Studio flow.
- [Highlight](https://highlight.xyz/) leads with recognizable formats—open
  edition, limited edition, 1-of-1, generative, and series—then sale mechanics.
  Its [product changelog](https://highlight.xyz/changelog) describes the key
  patterns Keel is missing: rich examples when choosing a project type,
  advanced controls revealed only when needed, persistent and duplicable
  drafts, testnet iteration, and a single collection page that evolves from
  announcement to primary mint to secondary sales.
- [Manifold editions](https://help.manifold.xyz/en/articles/9387344-create-an-edition-open-or-limited)
  use a simple sequence: choose/create a contract, add the work, set price and
  supply, review, and publish. The collector receives a purpose-built mint
  page, not an execution console.
- [Foundation Drops](https://help.foundation.app/hc/en-us/articles/9321632980507-Drops-FAQ)
  reduces the collector action to choosing quantity, clicking Mint, and
  confirming in the wallet. Supply and release rules may be immutable onchain,
  but the UI describes the consumer consequence instead of exposing the rule
  encoding.

Common pattern:

```text
Choose release type
  -> add work
  -> describe collection
  -> set sale and access
  -> design collector page
  -> test and preview
  -> review consequences and cost
  -> publish
  -> manage the live release
```

Keel already has more capable provenance, browser-native work, contract
events, and verification than these products. The missing layer is the product
orchestration that converts those capabilities into this familiar journey.

## Current product diagnosis

| Surface | Current behavior | Product failure | Required outcome |
| --- | --- | --- | --- |
| `/manage` | Generic pipeline and links into separate tools | No project/release home, launch readiness, draft, or clear next action | A creator dashboard organized by projects and releases |
| `/create` | Selects an indexed technical creation module | Creation is disconnected from release setup and can dead-end on infrastructure wording | A project-type chooser with examples and a resilient default path |
| `/account` | Requires URL and wallet/address concepts; onchain publication blocks launch | Identity setup feels like protocol enrollment | A normal creator profile with image upload; chain publication becomes a reviewed launch step |
| `/launch` | 625-line deployment, campaign, and Safe handoff console | KEEL721, bps, EOA, Merkle, digest, signatures, calldata, and hashes are primary UI | Remove from product navigation; replace with project release dashboard |
| `/launch/mint` | 864-line form for shell/controller/profile/module configuration | “Simple” mode still requires chain ID, collection address, controller, Unix times, and protocol vocabulary | A persisted release editor that infers all platform configuration |
| `/launch/agent` | One-shot EIP-712 authorization builder | Internal automation architecture is presented as a creator task | Move behind protected automation settings or eliminate from UI |
| `/drops` | Useful campaign cards fed by indexed contract state | Closest surface to a real launchpad, but sparse storytelling and fragile empty states | Primary discovery feed with announcement/live/ended filters and editorial metadata |
| `/drops/[chain]/[controller]/[drop]` | Raw signer signatures, authorization deadline, token IDs, mintData, pre-read addresses, and receipt internals | Collector must understand and supply execution artifacts | A launch page with automatic eligibility and one clear mint action |
| `/collection/[chain]/[collection]` | Gallery with useful identity media | Separate from the live drop lifecycle and exposes address as page content | Canonical collection/release page with primary and secondary state |
| `/market` and `/keel/market` | Marketplace authority exists in a separate surface | Primary release and secondary market feel like different products | Same collection page evolves into secondary market state |
| Indexer and DB | Strong chain event projections and collection profiles, but no release draft model | UI has to assemble live calls and local React state every visit | PostgreSQL owns drafts and presentation; indexed events own observed chain projection |

The three launch components alone contain 1,992 lines of UI logic:
`launch-dashboard.tsx` (625), `mint-configurator.tsx` (864), and
`collector-mint.tsx` (503). This is not inherently bad, but the complexity is
currently on the screen instead of behind the product service boundary.

## Product model

The forward-facing product should teach only three durable concepts.

### Creator

The person or studio publishing the work. The creator has a profile, projects,
collaborators, payout preferences, and collections. Wallets prove authority but
are not the creator's visible identity.

### Project

The work being prepared: a 1-of-1, edition, series, generative work,
interactive work, game/world, or reusable creative asset. A project can have
files, metadata, previews, dependencies, Keel verification, drafts, and
revisions before it has a token or public release.

### Release

The public event that distributes a project. A release has a format, supply,
price, timing, access rules, collector page, status, and contract-backed mint.
It can be draft, test, scheduled, live, paused, ended, sold out, or archived.

“Collection,” “contract,” “drop controller,” “campaign,” “shell,” and
“presentation” remain real implementation concepts. They are mapped to the
three product objects by the platform and appear only in technical details.

## Audience and surface separation

### Collector product

Collectors get discovery, artist pages, project/release pages, minting,
collection ownership, marketplace activity, and plain-language proof.

### Creator Studio

Creators get projects, persistent drafts, previews, release configuration,
test launches, publishing, live management, earnings, collectors, and support.

### Operator console

Operators get contract registration, controller configuration, Safe handoff,
role checks, indexer controls, raw identifiers, execution recovery, and
protocol diagnostics. This must require an operator session and must not be
linked from normal creator navigation.

### Developer/proof view

Developers and advanced collectors can expand exact chain IDs, addresses,
events, digests, source trails, and SDK exports. Read-only proof is public;
manual write controls are not.

## Proposed information architecture

| New route | Purpose | Replaces or absorbs |
| --- | --- | --- |
| `/` | Art-first discovery | Current home, with better live data resilience |
| `/drops` | Upcoming, live, and recently ended releases | Current `/drops` |
| `/drop/[slug]` | Canonical collector launch page | `/drops/[chainId]/[controller]/[dropId]` |
| `/artist/[username]` | Human artist identity and releases | Address-first artist route, with address route retained as resolver |
| `/collection/[slug]` | Collection story, works, mint/market state | Address-first collection route, with address route retained as resolver |
| `/studio` | Creator project and release dashboard | `/manage` |
| `/studio/projects/new` | Project type chooser | Front of `/create` |
| `/studio/projects/[id]` | Project overview and readiness | Fragmented create/manage state |
| `/studio/projects/[id]/work` | Files, metadata, preview, dependencies | Upload Wizard surfaces |
| `/studio/projects/[id]/release` | Sale, access, timing, and supply | Consumer replacement for `/launch/mint` |
| `/studio/projects/[id]/page` | Collector page editor and preview | Collection identity editor plus missing story modules |
| `/studio/projects/[id]/review` | Exact review, costs, irreversible choices, wallet actions | Launch review and scattered transaction buttons |
| `/studio/releases/[id]` | Live status, controls, collectors, revenue, links | Launch dashboard and indexed campaign panels |
| `/ops/launch` | Contract/controller/governance operations | Current `/launch` |
| `/ops/automation` | Agent authorization and revocation | Current `/launch/agent` |

Existing address-based public routes should 301/308 to slugs after resolving
the indexed identity. Address routes remain valid deep-link and recovery APIs;
they stop being the URL a human is expected to share.

## Creator journey

### 1. Start a project

The first screen asks “What are you releasing?” and presents visual examples:

- 1-of-1;
- limited edition;
- open edition;
- series / unique set;
- generative work;
- interactive work or world;
- reusable asset/library release;
- advanced custom contract, visually separated and explicitly advanced.

Each choice explains collector behavior, not token standards. Example: “One
artwork, a fixed number available” rather than “ERC-1155 edition.”

### 2. Add the work

Upload or select a Keel project. Studio determines the appropriate creation
module from the selected project type and files. If the module index is
temporarily unavailable, a saved draft and safe default upload path remain
usable; the page never says the creator must wait for a manifest to be indexed.

The creator sees:

- work preview;
- files and detected project type;
- title and description;
- cover image/video;
- traits or metadata where relevant;
- verification progress expressed as “Ready,” “Needs attention,” or “Blocked.”

Exact resource graphs and source commitments remain under “View technical
proof.”

### 3. Build the public identity

Collection/project identity belongs inside the project, before contract
deployment. The creator adds:

- collection and release name;
- artist or studio attribution;
- description and story;
- avatar/logo, desktop banner, mobile banner, and social card;
- website and social links;
- optional story sections, collaborators, roadmap, and FAQ;
- URL slug with availability check.

Images are uploaded directly. Asking for a profile image URL is removed.

### 4. Set the release

Default form:

- edition type: limited or open;
- quantity available;
- price: free or fixed price;
- start: now or scheduled date/time;
- end: no end or scheduled date/time;
- mint limit per collector;
- earnings destination, prefilled from the creator account;
- network, shown by name with a plain fee estimate;
- collector access: everyone, invite list, holders of a collection, or custom.

Advanced options are contextual. They never expose an encoding. For example,
“Collectors who own…” opens a searchable collection picker backed by indexed
holdings; the system selects the gate contract and builds the exact rule.

### 5. Test the release

The creator can preview the exact desktop and mobile collector page with:

- a disconnected visitor;
- an eligible collector;
- an ineligible collector;
- sold-out/ended state;
- missing media and temporarily delayed index state.

For irreversible or generative releases, “Test on Sepolia” duplicates the
release draft, deploys the test configuration through the same compiler, and
records the test receipt. It does not make the creator rebuild the project.

### 6. Review and publish

The review page shows only meaningful consequences:

- what collectors receive;
- number available and collector limit;
- price and estimated creator proceeds;
- start/end timing and access audience;
- earnings wallet and royalties;
- network and estimated gas;
- what cannot change after launch;
- public page preview;
- Keel readiness result.

The primary action is “Publish release.” The wallet may require more than one
confirmation when a collection and release both need deployment. The UI shows
named steps—“Create collection,” “Publish verified work,” “Open mint”—and
resumes from the last confirmed receipt. It does not show raw transaction
arguments.

### 7. Manage the live release

The release dashboard shows:

- Scheduled / Live / Paused / Ended / Sold out;
- minted count, remaining supply, unique collectors, and proceeds;
- current access phase and next scheduled change;
- public page and share links;
- recent mints and marketplace activity;
- allowed actions derived from live contract state;
- sync status when the index is behind;
- expandable onchain proof and explorer links.

The platform never lets a stale database projection enable an invalid action.
It can show indexed analytics immediately while a background live-chain check
confirms every write.

## Collector journey

The collector page is an editorial launch page, not a verification dashboard.
It should contain:

- artwork or live interactive preview;
- release title, creator identity, story, and social links;
- status and human date/time with local timezone;
- price, remaining supply, and collector limit;
- clear access explanation (“Public,” “Collectors of X,” “You are on the
  invite list”);
- one mint card with quantity and total;
- sample gallery or outputs where the release supports it;
- optional project sections and FAQ;
- concise “Verified by Keel” summary with expandable proof;
- primary and secondary market activity on the same page after the mint ends.

Collector action:

```text
Open page
  -> connect wallet only when needed
  -> Keel resolves eligibility automatically
  -> choose quantity
  -> click Mint
  -> confirm in wallet
  -> see artwork, receipt summary, and collection link
```

### Signed and gated access

The current pasted signature and deadline UI must be deleted.

For invite/allowlist stages:

1. The browser sends the authenticated wallet, release, stage, and quantity to
   an eligibility endpoint.
2. The server checks the release rules, indexed list membership, and live
   contract usage at a recorded block.
3. If eligible, the authorized signer service returns a short-lived signature
   for the exact contract authorization.
4. The browser immediately includes it in simulation and mint. It is never
   displayed or editable.
5. A final live simulation is the authority immediately before wallet prompt.

For holder claims:

1. The indexer returns matching owned entitlement tokens.
2. Live ownership and claim-consumed state are checked.
3. The collector chooses a recognizable owned item/card if a choice is needed;
   otherwise Keel selects the valid item automatically.
4. Token IDs and context are generated and passed internally.

There is no “Check inputs” button. Eligibility begins automatically after
wallet connection or quantity change. The Mint button explains the current
blocker when disabled.

## Translation of current fields

| Current field or phrase | Consumer product replacement | Technical handling |
| --- | --- | --- |
| Chain ID | Network name and fee estimate | Stored numeric chain ID |
| Collection shell address | Existing collection picker or “Create new collection” | Resolved to creator-owned collection |
| Controller address/lane | Nothing | Selected from registered platform configuration |
| Factory address | Nothing | Selected by network and project type |
| KEEL721 / ERC-721 / ERC-1155 | Release behavior explanation | Compiler selects standard/shell |
| Royalty bps | Royalties percentage | Convert percent to basis points |
| Payout address | Earnings destination | Prefill verified account wallet; advanced wallet picker |
| Unix seconds | Local date and time picker | Convert to UTC epoch |
| Signature mode / signer | “Who can mint?” rule | Platform signer policy generated internally |
| Merkle root | Invite list upload/search | Build and persist list; generate proof/root internally |
| Gate token address | Holder collection picker | Resolve indexed collection and contract |
| Metadata/artifact digest | Nothing | Computed from verified project/release document |
| Profile ID / module root / seed registry | Generative project readiness | Inferred and live-validated from project contract graph |
| `mintData` | Nothing | Generated by the selected project profile |
| Calldata and Safe transaction hash | Operator governance step | `/ops/launch`, never creator release setup |
| Agent wallet address | Automation setting | Protected service identity |
| Authorization signature textarea | Nothing | Short-lived server response passed in memory |
| Authorization deadline | Nothing | Server chooses a narrow expiry |
| Entitlement token IDs | Owned-item selector, if necessary | Indexed then live-checked |
| “Simulate + create mint” | Publish release | Simulation remains mandatory internally |
| “Simulate + mint” | Mint | Simulation remains mandatory internally |
| SDK-parity JSON | Download technical configuration | Read-only advanced export after successful compilation |
| Receipt events wall | “Mint confirmed” summary | Expandable proof trail retains all decoded evidence |

## PostgreSQL product layer

The current database is already the correct place for users, creator profiles,
artifacts, content-addressed blobs, collection profiles, chain events, and
indexed contract projections. It needs a release workspace layer.

Add the following conceptual tables. Names can follow existing Drizzle
conventions during implementation.

### `creator_projects`

- id, creator id, project type, title, description;
- active artifact/revision and preview identity;
- lifecycle: draft, ready, released, archived;
- optional linked chain collection;
- created/updated timestamps and optimistic version.

### `release_drafts`

- id, project id, creator id;
- format, network, supply mode, supply, price, currency;
- start/end policy, wallet limit, payout preference;
- presentation/page state;
- lifecycle status and validation summary;
- compiled configuration digest and compiler version;
- optional parent draft for duplicate/testnet promotion;
- optimistic version and last autosave.

### `release_stages`

- release draft id and ordered position;
- consumer label, start/end, price, limit;
- access rule reference;
- immutable compiled stage digest after publication.

### `release_access_rules`

- public, invite list, holder collection, claim, or custom;
- human configuration and normalized internal configuration;
- list/member counts and source revision;
- no raw secrets in presentation data.

### `release_page_sections`

- ordered story, media, gallery, FAQ, team, link, and embed sections;
- desktop/mobile media variants and social card;
- draft/published revision.

### `release_operations`

- idempotency key and release draft version;
- named step, expected account/network/target;
- prepared transaction commitment;
- submitted transaction hash and receipt status;
- correlated event identity and resulting collection/drop IDs;
- failure category, safe retry state, timestamps.

### `published_releases`

- stable public release id/slug;
- creator project and final draft revision;
- chain/controller/collection/drop identity;
- current indexed lifecycle projection;
- public page revision;
- last live-check block and sync state.

### `eligibility_lists` and `eligibility_members`

- release/stage ownership, normalized wallet, optional allocation/price;
- encrypted private list attributes where required;
- list revision/root and import audit;
- never expose the full private list through public APIs.

### `authorization_issuances`

- release/stage/wallet/quantity/context commitment;
- issued-at, expiry, signer key version, consumed/expired status;
- store the signature only if operationally required and encrypt it at rest;
  otherwise store its digest and issuance audit.

Do not copy indexed contract facts into mutable release draft fields after
publication. Join the published release identity to existing indexed tables and
derive current lifecycle state from canonical events.

## Source-of-truth contract

| Data | Authority | Product use |
| --- | --- | --- |
| Draft title, story, media, FAQ, schedule intent | PostgreSQL draft | Autosave, preview, collaboration |
| Exact uploaded bytes and Keel manifest | Content-addressed blob/artifact records | Preview and publication compiler |
| Creator session and draft ownership | Signed session + PostgreSQL | Authorization |
| Deployed collection/drop identity | Confirmed receipt and canonical event | Bind published release |
| Mint supply, wallet usage, paused/closed state | Live contract read for writes; canonical index for discovery | Enable actions and show analytics |
| Mint history and aggregate analytics | Reorg-aware event index | Fast dashboards and discovery |
| Collector eligibility list | PostgreSQL rule/list + live usage | Issue exact short-lived authorization |
| Proof and provenance | Contract commitments plus verified content resolution | Expandable collector trust view |

The database makes the experience fast and coherent. It does not pretend to be
the chain. The chain makes releases authoritative. It does not have to be the
creator's form database.

## Release state machine

```text
draft
  -> validating
  -> ready
  -> publishing_collection (when needed)
  -> publishing_work
  -> publishing_release
  -> awaiting_index
  -> scheduled | live
  -> paused | ended | sold_out
  -> archived

Any publishing state
  -> failed_retryable | failed_action_required | submission_unknown
```

Every state transition records the draft version and operation identity. A
browser refresh resumes the operation. A transaction timeout never triggers an
automatic duplicate write. `submission_unknown` reconciles the account nonce,
receipt, and indexed event before presenting Retry.

## Service architecture

### Release compiler

Move the normalization currently embedded in client components behind a typed
server/service boundary. The compiler accepts the consumer draft plus observed
project/collection facts and returns:

- validation issues written in product language;
- immutable-choice summary;
- estimated operations and gas;
- prepared transaction commitments;
- a versioned technical export;
- collector-page projection for preview.

Existing `mint-launch-schema.ts`, OneMint, MintAccess, shell inspection, and
Keel verification remain implementation inputs. They are not deleted.

### Operation coordinator

The coordinator persists the named wallet steps, verifies expected network and
account, accepts transaction submission state, correlates receipts/events, and
updates the published release link. The browser remains responsible for
wallet-confirmed writes unless an explicitly authorized relayer operation is
part of the product.

### Eligibility service

The eligibility service reads indexed rules and lists, checks live chain usage,
issues exact short-lived authorizations, and returns a consumer result:
eligible, not eligible, sold out, too many requested, sale not started, sale
ended, wrong network, or temporarily unavailable.

### Projection service

Build one public `ReleaseView` projection consumed by `/drops`, `/drop/[slug]`,
collection pages, Studio dashboards, search, and social metadata. Stop having
each surface independently reinterpret indexed campaigns and OneMint drops.

## Visual and language direction

The existing Keel identity can remain distinctive, but the product needs a
readable hierarchy.

- Keep the display face for major titles; use the text face or a conventional
  UI face for body copy, labels, status, dates, prices, and forms.
- Lead with artwork and creator identity, not black panels of configuration.
- Use one strong primary action per state.
- Replace dense all-caps microcopy with sentence-case language.
- Use familiar date, currency, percentage, and quantity formatting.
- Keep addresses and hashes truncated and behind “View onchain details.”
- Put “Verified by Keel” near the work as a concise benefit: exact files,
  known source, and checkable history. Expand into the existing detailed trail.
- Give release pages desktop and mobile hero media rather than relying on a
  generic gradient when creator media exists.
- Treat loading, empty, partial-index, and delayed-chain states as designed
  product states with a retry or next action—not infrastructure prose.

Copy examples:

| Current | Replace with |
| --- | --- |
| “Attach your collection shell” | “Choose a collection” |
| “Inspect live shell” | Automatic “Checking collection…” |
| “Shared supply” | “Available to collect” |
| “Per wallet · all stages” | “Limit per collector” |
| “Ordered immutable stages” | “Sale schedule” |
| “Creator payout” | “Earnings go to” |
| “Authorization signer” | Nothing |
| “Canonical context locked” | “Traits are generated fairly from the published rules,” only when that exact fairness claim is proven |
| “Pre-read configuration context” | “Verified release details” collapsed by default |
| “Run the indexer after creating a campaign” | “Your release is syncing. This usually updates automatically.” |
| “Creation setups are reconnecting” | “We could not load your project types. Retry,” while saved projects remain accessible |

## Implementation sequence

### P0 — Quarantine internal tooling and remove unsafe inputs

1. Remove `/launch`, `/launch/agent`, and raw `/launch/mint` from creator
   navigation.
2. Move the existing pages unchanged under authenticated `/ops/*` routes so
   protocol operations remain available during the transition.
3. Delete signature, deadline, raw entitlement ID, and mintData inputs from the
   collector UI. Until the automatic service exists, mark those gated release
   types unavailable to collectors with a clear message; never fall back to
   paste-based execution.
4. Add route-level error boundaries and resilient partial states to create,
   launch, drop, and collector pages.
5. Stop showing local/test chain IDs and runtime badges to public visitors.

Acceptance:

- no public or creator route contains an editable raw address/hash/signature
  unless the user deliberately enters an Advanced developer view;
- operator routes require operator authorization;
- public navigation has no link to operator tooling;
- an unavailable DB/index/RPC cannot turn an entire page into the generic Next
  error screen.

### P1 — Persistent project and release workspace

1. Add project/release/stage/page/operation tables and migrations.
2. Add creator-owned CRUD APIs with optimistic concurrency and autosave.
3. Replace `/manage` with project and release cards: Draft, Needs attention,
   Ready, Scheduled, Live, Ended.
4. Build the project-type chooser and connect it to the existing upload and
   creation-module system.
5. Add direct profile and collection media upload; remove URL-only identity
   input.

Acceptance:

- a creator can start, leave, return, duplicate, archive, and delete a draft;
- two browser tabs cannot silently overwrite a newer draft;
- infrastructure interruption does not lose entered work;
- draft ownership is enforced by signed creator session.

### P2 — Consumer release editor and compiler

1. Build Work, Details, Sale, Page, and Review sections on the persistent draft.
2. Add the release compiler service around existing OneMint/MintAccess and shell
   validation code.
3. Infer platform controller, registry, factory, and generative configuration.
4. Add local date/time, price, supply, wallet limit, payout, and network
   controls with product validation.
5. Add exact desktop/mobile collector preview and social-card preview.
6. Persist named transaction steps and resume behavior.

Acceptance:

- a limited edition using an existing creator collection can be configured
  without typing a chain ID or address;
- review shows every irreversible choice before wallet confirmation;
- compiled transaction arguments match the existing SDK compiler exactly;
- refresh during any publish step resumes without duplicate submission.

### P3 — Automatic collector mint

1. Build the canonical `/drop/[slug]` projection and page.
2. Implement automatic live public-sale eligibility.
3. Implement the authorization service for invite and holder stages.
4. Add owned-entitlement discovery and live recheck.
5. Merge primary mint and post-mint marketplace state on the collection page.
6. Replace receipt/debug walls with confirmation summary plus expandable proof.

Acceptance:

- a public mint is quantity → Mint → wallet confirmation;
- an eligible invite mint is the same visible flow;
- an ineligible wallet receives a plain reason and never sees a signature;
- final simulation prevents stale index/list data from enabling an invalid mint;
- success appears only after a correlated receipt and expected mint events;
- the collector page works at mobile width without horizontal overflow or
  technical data dominating the page.

### P4 — Release storytelling, discovery, and lifecycle

1. Add page sections, mobile media, creator links, collaborators, FAQ, and
   optional roadmap/story blocks.
2. Add announcement, upcoming, live, ended, and sold-out discovery filters.
3. Add follow/reminder plumbing only after consent and notification scope are
   specified.
4. Build artist and collection slug resolvers and redirects.
5. Generate server-rendered social metadata from the published release page.
6. Show secondary listings/offers on the same page after primary mint.

Acceptance:

- every published release has a complete shareable page even before mint opens;
- public status transitions are driven by indexed events plus live time/state;
- artwork and creator identity occupy the primary visual hierarchy;
- social preview contains the creator-supplied release identity.

### P5 — Advanced formats without leaking implementation

1. Add generative, interactive, series, holder claim, token payment, and custom
   access editors as contextual project types.
2. Map every type to existing frozen Keel profile and proof gates.
3. Keep unsupported or unproven capabilities blocked rather than exposing raw
   escape-hatch fields.
4. Add developer export and exact proof in a read-only Advanced panel.

Acceptance:

- generative setup is driven by project assets and declared behavior, not
  module addresses;
- ETH and Tezos parity is explicit wherever a feature claims cross-chain
  support;
- the UI never claims randomness/fairness/storage/provenance beyond the proof
  actually available;
- custom contracts can be attached through a deliberate developer path without
  contaminating the default product.

### P6 — Operator hardening and production rollout

1. Add operator RBAC, audit log, and two-person confirmation for governance and
   authority handoff.
2. Separate indexer recovery and contract registration from customer Studio.
3. Add signer key rotation/versioning, issuance audit, rate limits, and abuse
   protection.
4. Add release reconciliation workers and submission-unknown recovery.
5. Add product analytics without storing private eligibility lists in event
   payloads.
6. Run local build and full local vertical slice before any managed/AWS rollout.

Acceptance:

- creator/collector sessions cannot reach operator mutations;
- signer compromise has a documented bounded rotation/revocation path;
- event rewind/reorg rebuilds the same published release projection;
- deployment follows the repository rule: clean local build is a hard gate
  before manifest sync or remote rollout.

## Code ownership map

| Area | Current code to reuse | Main change |
| --- | --- | --- |
| Public discovery | `customer-platform-service.ts`, `launchpad-explorer.tsx` | Introduce shared `ReleaseView` and richer public metadata |
| Project creation | `upload-wizard.tsx`, creation-module services, upload store | Persist project first; infer modules behind type chooser |
| Collection identity | `collection-identity-editor.tsx`, collection profile service | Move into project page; add mobile/social media and sections |
| Release compiler | `mint-launch-schema.ts`, `mint-configurator.tsx` logic | Extract server/service compiler; replace client form |
| Launch operations | wallet helpers, OneMint/MintAccess SDK, receipt parsers | Persist named operations and resume/reconcile |
| Collector mint | `collector-mint.tsx`, preflight and receipt evidence helpers | New consumer component; keep live checks/evidence internally |
| Eligibility | showcase authorization API, indexed stages/mints | Production rule service with list/holder support |
| Chain projection | indexer, indexed campaigns/drops/stages/mints | Bind to published release; keep reorg authority |
| Marketplace | Keel market services and wallet component | Surface primary/secondary state on canonical collection page |
| Proof | artifact viewer, ResolutionAudit, source trail | Plain summary plus expandable exact evidence |
| Internal operations | launch dashboard and agent approval components | Relocate to `/ops` with RBAC and audit |

## Verification strategy

Each implementation wave must prove behavior at four levels.

### Contract and compiler parity

- existing SDK/contract tests remain green;
- consumer draft compiles to the same normalized OneMint/MintAccess arguments;
- invalid/unproven generative graphs remain blocked;
- receipt/event identity remains correlated exactly.

### Database and event reconciliation

- autosave and optimistic concurrency tests;
- operation idempotency and submission-unknown recovery tests;
- index rewind/replay produces the same release status;
- live contract read overrides stale enabling state.

### Product behavior

- fresh creator creates a profile, project, release, preview, test launch, and
  production review without manual technical input;
- public, invite, holder, sold-out, paused, and ended collector scenarios;
- no-wallet browsing and wallet/network switching;
- DB down, RPC down, partial index, delayed receipt, rejected wallet, and
  duplicate-submission scenarios.

### Rendered acceptance

- fresh desktop and mobile browser runs, not source-only checks;
- keyboard, screen-reader labels, focus, reduced motion, and contrast;
- no console errors;
- measured page load and interaction latency for discovery, editor, preview,
  eligibility, and mint confirmation;
- screenshots of every lifecycle state using real projection fixtures.

## Launch metrics

Measure whether the redesign actually removes protocol work from the user.

- time from New project to valid preview;
- percentage of drafts resumed after leaving;
- release-editor completion and abandonment by section;
- number of raw technical inputs in default flow: target **zero**;
- wallet confirmations expected versus completed;
- publish operations requiring support or manual recovery;
- eligibility response latency and authorization failure rate;
- mint conversion after wallet connect;
- index lag visible to users;
- percentage of releases with complete banner, story, mobile media, and social
  preview;
- collector proof expansion rate, without forcing proof into the primary task.

## Explicit non-goals

- Do not replace the contracts or make PostgreSQL authoritative for mint rules.
- Do not hide irreversible consequences; translate and review them.
- Do not weaken Keel verification to make the UI shorter.
- Do not invent demo/fake release state when the DB, index, or RPC is missing.
- Do not require every creator to understand multisig or agent automation.
- Do not expose an “advanced” escape hatch that lets unproven configurations be
  published with a friendlier label.
- Do not split primary mint and secondary market into unrelated product pages.
- Do not claim Ethereum/Tezos parity until both paths pass the same consumer
  acceptance criteria.

## Definition of done

The launch platform is forward-facing only when all of the following are true:

- a creator begins with the kind of work and release they want, not a contract;
- every draft persists and can be previewed before chain writes;
- a creator can publish the main supported release without typing technical
  identifiers;
- the wallet asks for named, expected irreversible actions only;
- a collector never pastes a signature or proof artifact;
- eligibility, price, supply, and limits are resolved automatically;
- the collector page tells the project's story and remains the canonical page
  before, during, and after the mint;
- PostgreSQL supplies coherent drafts and fast presentation while canonical
  events and live reads retain transaction authority;
- Keel proof is easy to understand and expandable, not removed;
- operator controls are authenticated, audited, and absent from consumer
  navigation;
- the complete creator-to-collector vertical slice is browser-verified on
  desktop and mobile with real contract and database state.

