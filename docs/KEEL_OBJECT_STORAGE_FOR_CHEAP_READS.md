# Storing objects so reads are cheap

A token's metadata is read far more often than it is written. Every marketplace,
wallet, indexer and explorer that ever looks at it pays to produce it again, and
none of them pay to store it. So the arithmetic belongs at write time, once, and
a read should cost only what it takes to move bytes that already exist.

This is the convention the contracts read by. **Nobody writing a collection
should have to apply it by hand** — the SDK lays bytes down this way, and the
numbers below are what that buys.

Every figure here is measured, not modelled. See
`packages/contracts/test/KeelPreEncodedBench.t.sol`,
`KeelDirectCopyBench.t.sol` and `KeelBackpackTokenUriGas.t.sol`. Each
benchmark asserts the two paths produce the **same output** before comparing
their cost, because a cheaper read that returns something different is not a
cheaper read.

## The rules

### 1. Store what a reader hands out, not what a reader must convert

A `data:image/png;base64,…` URI needs base64. Store the artwork **already
base64** and flag it in the media type:

```
mediaType: "image/png;base64"
```

The flag is load-bearing. A reader that finds it hands the bytes straight to a
data URI without inspecting them, which is only safe because nothing unflagged
can reach that path — `bindRender` reverts on an object without it, and reverts
again if the bytes are not the encoding of the artwork the ladder proved.

Costs a third more storage, once. Saves the encode on every read, forever.

### 2. Encode once, never twice

`tokenURI` returning `data:application/json;base64,…` around a JSON document
that already contains a base64 image puts the artwork through base64 **twice** —
a third larger again, and the whole pass repeated on every read.

Serve the document as it stands instead:

```
data:application/json;charset=utf-8,{"name":…}
```

| | gas | chars |
| --- | --- | --- |
| encoding the document a second time | 15,842,907 | 304,885 |
| serving it as it stands | **1,373,256** | 228,678 |

**The only thing that made the second encode necessary was a `#` we wrote
ourselves.** A data URI ends at the first `#`, and the sole `#` in the document
came from naming the token `… #4`. Name it without one and there is nothing left
to escape: base64's alphabet contains no `#`, no `%`, nothing that ends a URI.

Do not reach for percent-escaping instead. Escaping means touching every byte in
a loop, and measured over a document this size that cost **160M gas** — an order
of magnitude worse than the base64 it was replacing. Removing the `#` is free;
escaping it is not.

### 3. Where pieces must be joined, join pre-encoded ones

`base64(A + B) == base64(A) + base64(B)` whenever `len(A) % 3 == 0`. JSON ignores
spaces, so a static prefix can be padded to that boundary for nothing. Encode
each piece once at write time and a read only joins them:

| | gas |
| --- | --- |
| encoding the whole document at read | 15,893,247 |
| concatenating pre-encoded pieces | **2,406,646** |

Same string out of both — the benchmark asserts it.

### 4. Copy once, not three times

`haulObject` copies the bytes out of their carriers, `string.concat` copies them
again into a joined buffer, and returning copies them a third time. Nothing is
computed in any of it; the same bytes are restated.

Measure the final length first, allocate exactly one buffer, and `extcodecopy`
each carrier straight into its place:

| | gas |
| --- | --- |
| `haulObject` then `string.concat` | 1,587,265 |
| measure, allocate once, copy into place | **786,575** |

`KeelHarnessBuilder._assembleWithContext` already works this way, and its
comment records why: a bounds-checked `MSTORE8` per byte is tens of gas, and on a
35KB viewer that loop alone once needed 48.3M of a node's 50M `eth_call` cap.

### 5. Bound what a read can be made to cost

`KEEL721.MAX_URI_BYTES = 32_768` exists for a reason its own comment states
plainly: *an unbounded presentation lets a single write make `tokenURI` too large
to read, which bricks the token for every client that reads it — a griefing
vector that costs the writer once and the collection forever.*

Storage is paid by whoever writes it, so the ceiling protects readers rather
than rationing bytes. An `image` is a poster, not the archive: an optimised one
is 2.4–7.7 KB of SVG, about 3.3–10.3 KB base64'd. The full-fidelity artwork
belongs in `animation_url`, where the viewer document carries it.

## What this adds up to

Reading one preserved Bored Ape, over the course of applying the rules above:

| | read gas |
| --- | --- |
| artwork encoded three times over | 67.3M |
| encoded once | 20.3M |
| stored pre-encoded, concatenated | 8.6M |
| copied once instead of three times | **~2M** |

The trade throughout is the same one, and it is deliberate: **pay more to store,
pay far less to read.** Storage is bought once by the person who chose to
preserve something. Reads are paid by everyone who ever looks at it.
