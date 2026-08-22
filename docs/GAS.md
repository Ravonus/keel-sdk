# Contract gas discipline

Keel/Keel treats gas as a product constraint. The cheapest transaction that
changes the wrong state, weakens an authority boundary, or becomes reentrant is
not an optimization.

## Required ordering

Every state-changing entrypoint follows Checks-Effects-Interactions (CEI):

1. **Checks:** read state and external view data, validate authority, payment,
   signatures, balances, bounds, nonces, and invariants.
2. **Effects:** commit every internal state change needed to make callbacks
   harmless. Consume nonces, allocations, claims, and escrow before control can
   leave the contract.
3. **Interactions:** perform token transfers, native-value calls, receiver
   callbacks, mint hooks, and other external mutations last.

An external view read may be needed during checks. It must be fail-closed and
must not be confused with a safe state-changing callback. Pull credits are
preferred to push payouts. User-triggered interaction paths also use a
reentrancy guard when a callback can observe or re-enter mutable state.

## Compiler and runtime policy

- Solidity is pinned to `0.8.36`, the optimizer and IR pipeline are mandatory,
  and Foundry settings must match the canonical artifact compiler.
- The EVM target is Cancun. Protected methods therefore use OpenZeppelin's
  EIP-1153 `ReentrancyGuardTransient`, avoiding persistent guard storage on
  every transaction while preserving the same one-entry invariant.
- CBOR/IPFS metadata is omitted from deployed bytecode. The standard compiler
  input and emitted artifact metadata remain available for source
  verification, while users do not pay to deploy unreachable metadata bytes.
- Production code uses custom errors and rejects the 2,300-gas `transfer` and
  `send` stipend patterns.
- Assembly is allowed only where the byte layout is canonical, bounds are
  proven, and ordinary unit tests verify exact round trips. The packed
  KeelHold descriptor writer is the reference example.
- Large creation code belongs in a narrowly scoped deployer child rather than
  the factory runtime. CREATE2 salts in a shared child must include the calling
  factory namespace so direct calls cannot squat a predicted address.

Run the source-wide policy gate:

```sh
pnpm contracts:gas:policy
pnpm contracts:size:check
```

## Benchmarks and regression budgets

`packages/contracts/test/gas` contains stable, transaction-shaped benchmarks
for core user writes. Forge stores their exact budgets in
`packages/contracts/.gas-snapshot`.

```sh
pnpm contracts:gas:snapshot # deliberately accept a reviewed new baseline
pnpm contracts:gas:check    # policy plus exact snapshot comparison
pnpm contracts:gas:report   # complete method report from the full test suite
```

Do not refresh a snapshot merely because it fails. Inspect the diff, explain
every increase, and keep a more expensive path only when its security or
product behavior justifies the cost. A gas decrease still requires the normal
behavioral and adversarial tests; the number alone is not proof of safety.

## Method review checklist

For every new or changed public method:

- reject invalid input before writes and reject it with a custom error;
- load a storage value once when repeated reads would be cold or expensive;
- pack durable fields when it does not obscure invariants or break upgrade
  layout;
- bound loops and calldata before iteration;
- use calldata and immutable values where ownership and lifecycle allow it;
- commit replay, capacity, escrow, and ownership effects before callbacks;
- put external mutations last and add a transient guard when callbacks exist;
- benchmark the successful user path and important repeat path;
- compare runtime gas, deployment gas, and EIP-170 size rather than optimizing
  one metric blindly.

Local snapshots prove only local compiler/EVM behavior. They do not prove a
deployed address, wallet estimate, L2 fee component, or live-chain receipt.

## Tezos and SmartPy

Tezos uses the same security intent with different execution mechanics. A
SmartPy entrypoint completes before Tezos executes its queued internal
operations, so the enforceable order is **Checks-Effects-Operations**:

1. **Checks:** validate sender, amount, signatures, nonces, time windows,
   bounds, object state, and fail-closed `sp.view` results.
2. **Effects:** consume replay state and commit every big-map/storage mutation.
3. **Operations:** enqueue `sp.transfer` or contract origination only after the
   state is callback-safe.

An `sp.view` is a synchronous, read-only check, not a state-changing operation.
Its failure still aborts the transaction. Conversely, toggling a storage lock
to `true`, enqueueing an operation, and resetting it to `false` in the same
entrypoint provides no reentrancy protection on Tezos; it only charges users
for redundant instructions. Durable state effects are the protection.

The Tezos policy gate parses every production SmartPy contract, follows
operation-producing private helpers, rejects `sp.send`, pins SmartPy, and fails
when any entrypoint or helper writes storage after an internal operation. The
artifact gate then compiles all 21 standalone targets and compares canonical
Micheline code and initial-storage bytes against the reviewed snapshot. Code
size is capped at 65,536 bytes and any code increase fails. Initial-storage
increases also fail, except for a 4 KiB allowance on the character target's
freshly rendered PNG compression; that narrow cross-platform variance is still
budgeted rather than ignored.

```sh
pnpm tezos:gas:policy
pnpm tezos:gas:snapshot # deliberately accept a reviewed new baseline
pnpm tezos:gas:check    # policy, compile, size, and regression comparison
pnpm tezos:gas:report   # all targets, storage bytes, and size headroom
pnpm tezos:test:contracts
pnpm tezos:gas:octez    # pinned Octez v25 gas receipts and full mockup flow
```

The Octez snapshot covers ten dependency-wired originations plus the viewer
route, seed-consumer, and verification-hook configuration entrypoints. Refresh
it only with `pnpm tezos:gas:octez:snapshot` after reviewing every receipt
change; this also runs the complete 94-operation mockup finalization flow.

For Tezos reviews, optimize both execution and storage burn:

- replace membership-check-plus-index patterns with one fail-closed big-map
  read when the value is needed;
- never persist a lock that cannot protect the later queued operation;
- keep unbounded data out of loops and cap lists before iteration;
- store hashes, roots, and compact counters instead of duplicate payloads;
- preserve exact manager, access-controller, and signature-only authority
  boundaries rather than combining them into a cheaper universal executor;
- review code size and initial storage together, because reducing one can make
  the other or the successful call path more expensive.

The SmartPy scenarios prove local state transitions and the pinned compiler
artifacts prove deterministic local budgets. They do not prove Shadownet or
mainnet fees, an injected operation, a wallet estimate, or a live-chain receipt.
