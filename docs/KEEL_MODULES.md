# Keel modules

A **module** is reusable protocol infrastructure: its own contracts, its own test
suite, its own per-chain deployment record, and its own entry in the SDK registry.
Modules are the unit that gets released to a chain and the unit a consumer targets.

An **app** is a concrete product built on those modules — CoolS, LINE, Vault
Runner, and the CoolS canvas. Apps are not modules. They consume modules exactly
as an outside integrator would, they do not ship as repositories, and they are
excluded from the SDK's module registry.

The rule that makes the distinction worth having is enforced, not documented:
**a module may never depend on an app.** If infrastructure reaches into a product,
it can no longer be released or consumed on its own, so `keel check` fails on it.

The long-term destination is one repository per module under the `keel`
organization. Until a module is genuinely self-contained, it develops here, where
the boundary is enforced mechanically rather than by convention.

## Layout

```
packages/contracts/
  src/modules/<id>/            module sources (plus interfaces/ and libraries/)
  test/modules/<id>/           the module's Foundry tests
  modules/<id>/
    keel.module.json           manifest: deps, contracts, deployable set, verify config
    abi/<Contract>.json        recorded ABI, compared byte for byte
    gas.snapshot               recorded gas, compared on every run
    deployments/<chainId>.json recorded addresses, per named instance

  src/apps/<id>/               app sources — same shape, never published
  test/apps/<id>/
  apps/<id>/
```

Imports say which tier they cross: `@keel/<module>/` for infrastructure,
`@app/<app>/` for a product, and `../` only within a unit. A module source
containing `@app/` is a build the checker rejects.

`test/TestBase.sol`, `test/fixtures/`, `test/fork/`, and `test/gas/` stay at the
test root: they are shared helpers and repo-level gates, not module-owned, and
their paths are pinned by `foundry.toml` and the gas-snapshot scripts.

## The boundary is checked, not assumed

`tools/keel/module-map.mjs` is the authoritative assignment of every `.sol` file
to exactly one module, together with the module dependency graph.

```bash
pnpm keel:check
```

This fails on three conditions:

1. **coverage** — a source file owned by no module, owned by two, or named by a
   manifest but absent from disk.
2. **acyclicity** — a cycle in the declared module graph.
3. **boundaries** — an import crossing into a module the importer does not
   declare in its `deps`.

Plus a fourth, fatal for modules only: a module source importing an app.

`deps` is a lockfile, not a wish: it records the edges that exist today, so a new
undeclared coupling fails the gate instead of quietly accumulating. The check runs
as part of `pnpm test`.

A module whose **tests** reach into an app is reported as debt rather than failed.
The module still releases on its own — its sources are clean by the rule above —
but its suite cannot run in a split repository, because apps are never published.
`keel-equipment` is the one current case: it exercises the reservation engine
against Vault Runner's real ERC-1155 rather than a mock.

## Working with modules

```bash
pnpm keel list                      # every module, size, dep count, chains it is live on
pnpm keel list --group core         # filter by group
pnpm keel graph vault-runner        # one module's dependency cone
pnpm keel test keel-market       # forge test scoped to a single module
pnpm keel deployments               # every recorded address, per chain and instance
pnpm keel adopt --apply             # take ownership of newly added contracts
```

## The release gate

Every module is held to the same five checks:

```bash
pnpm keel verify keel-market
pnpm keel verify --all
```

| Step | What it means |
| --- | --- |
| `static` | the Solidity source policy, scoped to this module's files |
| `size` | every deployable contract's runtime bytecode is under EIP-170's 24,576 bytes |
| `abi` | the published ABI has not drifted from its recorded snapshot |
| `test` | the module's own Foundry suite |
| `gas` | the module's gas snapshot has not regressed |

The ABI check is the one that protects consumers: an ABI is a published
interface, and changing it silently breaks every integrator. Snapshots live in
`modules/<id>/abi/` and are compared byte for byte.

Record baselines after an intentional change:

```bash
pnpm keel verify keel-market --update
```

Add `--evidence` to write the run — step results, contract sizes, and a SHA-256
per source file — to `modules/<id>/evidence/verify.json`.

The source policy itself lives in `tools/keel/static-policy.mjs` and is shared
with the repo-wide gate, so the two cannot drift apart.

## Releasing to a chain

A release plan is the module's dependency cone in deploy order, annotated with
what the target chain already has:

```bash
pnpm keel plan vault-runner --chain 8453
```

Modules marked `[DEPLOY]` are not on that chain yet and must be deployed in the
order listed. Deploying a module onto a chain that is missing its dependencies is
the most common way a cross-chain release goes wrong, so the plan makes that state
explicit before anything is broadcast.

After each deploy, record the result and republish the registry:

```bash
pnpm keel record vault-runner --chain 8453 --instance mainnet-v1 \
  --contract VaultCharacter721 --address 0x... --block 123 --tx 0x...
pnpm keel sync
```

`record` refuses a contract name the module's manifest does not list as
deployable, so a typo cannot enter the registry.

## The repositories

Each module is published from its own repository under the
[`keel-web3`](https://github.com/keel-web3) organization. Apps have no
repository. `keel repos` reconciles the two:

```bash
pnpm keel repos          # what exists on GitHub, and its visibility
pnpm keel repos --sync   # record visibility into the manifests
```

Visibility is recorded because it changes how a module is installed, not because
anything depends on it:

```bash
forge install keel-web3/keel-market            # public
forge install git@github.com:keel-web3/keel-market   # private, over SSH
```

Resolution in the SDK is entirely local, so a module behaves identically whether
its repository is public or private.

## Targeting a module from the SDK

`@keel/sdk` ships the registry as generated, typed data — consumers never read this
repository's filesystem.

```ts
import {
  moduleAddress,
  moduleChains,
  moduleDependencyOrder,
  resolveModuleTarget,
} from "@keel/sdk";

moduleAddress("keel-market", "KeelMarket", 11155111);
// => "0xd87f72b751d2008c7365680653b79ff7eb0780b6"

moduleChains("keel-equipment");          // => [11155111]
moduleDependencyOrder("vault-runner");      // deps, in the order they deploy
```

### Connecting to a deployed contract

An address alone is not enough to call anything, so the SDK carries the ABIs too:

```ts
import { moduleContract } from "@keel/sdk";

const market = await moduleContract({
  module: "keel-market",
  contract: "KeelMarket",
  chainId: 11155111,
});
// { address, abi, chainId, instance, ... } — hand straight to viem/ethers/wagmi
```

The 99 recorded ABIs come to roughly a megabyte, so they are not part of the
registry every consumer imports. Each unit's ABIs are a separate module loaded on
demand, which is why `moduleContract` and `moduleAbi` are async.

Nothing in this path touches the network or a repository, so it works the same
for a private module as a public one.

### Named instances

A chain can carry more than one deployment of the same module — the showcase and
the vault-runner each deployed their own `KeelEquipmentInventory` on Sepolia.
Ambiguity is an error rather than a silent first match, because resolving to the
wrong instance sends calls to a different deployment:

```ts
moduleAddress("keel-equipment", "KeelEquipmentInventory", 11155111);
// throws: 2 deployments match ...; pass instance (one of: showcase, vault-runner)

moduleAddress("keel-equipment", "KeelEquipmentInventory", 11155111, "vault-runner");
// => "0xe5f341AB0C6246E230412B464c298fa7980AAdC3"
```

## Splitting a module into its own repository

Cross-module imports are remapped rather than relative, so the same import text
resolves in both layouts:

```
monorepo          @keel/ -> src/modules/          @keel-test/ -> test/modules/
standalone repo   @keel/keel-hold/ -> lib/keel-hold/src/
```

Extraction is therefore a copy plus a remappings file, with no source rewriting:

```bash
pnpm keel split --all --out build/keel-repos --apply
```

Each generated repository carries its own `foundry.toml`, `remappings.txt`,
`install.sh` (the dependency list in resolution order), CI workflow, README with
the module's live addresses, and `package.json`. Test files are the one thing
rewritten, because `src/` and `test/` are siblings in a split repo but three
levels apart in the monorepo.

18 of the 20 modules build and pass their suites standalone. `keel-backpack`'s
gas probes fail identically in the monorepo — several revert by design to print
measurements — and `keel-equipment`'s suite is the app-test-debt case above;
its sources build clean on their own.

### Test dependencies differ from source dependencies

`deps` is what a module's **sources** import; `devDeps` is what its **tests**
additionally need. devDeps routinely point upward — a canvas test builds a LINE
collection to exercise the renderer, and LINE depends on canvas — so they are
deliberately excluded from the acyclicity rule. In a split repo that cycle is
resolved by mapping the module's own name to its own sources:

```
@keel/keel-canvas/=src/          # wins over lib/, so LINE's import lands here
@keel/line/=lib/line/src/
```

## One source of truth for addresses

Addresses used to live in `apps/studio/.data/**/deployment.json`, `evidence/**`,
and several deploy scripts, in four different shapes. The registry is now the
place they are looked up, and `keel reconcile` keeps that honest by re-reading
those original files and comparing them:

```bash
pnpm keel reconcile          # check; fails on drift
pnpm keel reconcile --write  # adopt the files' values into the registry
```

The check runs as part of `pnpm test`, so an address that changes in a deployment
file without reaching the registry fails the build rather than quietly creating a
second source of truth.

Application code resolves through `apps/studio/src/lib/keel-addresses.ts`:

```ts
import { keelAddress, keelInstances } from "@/lib/keel-addresses";

keelAddress({ module: "keel-market", contract: "KeelMarket", chainId: 11155111 });
keelInstances("keel-equipment", 11155111); // ["showcase", "vault-runner"]
```

An environment variable can still pin a specific deployment — a fork, a staging
redeploy — but it is passed in as an explicit `override` rather than shadowing
the registry silently, so a wrong address is a visible decision instead of a
stale default.

Five `*PolicyV1` addresses in the showcase deployment match no contract in this
tree; `keel reconcile` reports them as unmapped rather than guessing at an owner.

## Regenerating

`keel.module.json` and the SDK registry are generated. After adding a contract,
changing the module map, or recording a deployment:

```bash
pnpm keel:sync
```

The `deployable` set is derived from compiled artifacts — a contract is deployable
when forge emitted creation bytecode for it — so interfaces, abstract bases, and
inlined libraries are excluded without anyone maintaining a list.
