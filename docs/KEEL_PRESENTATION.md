# KEEL presentation: shell, graph, and delivery mode

KEEL separates **where bytes are stored** from **how a collector's browser
receives them**. Native KEEL storage is not synonymous with Inline, and Hybrid
does not mean IPFS.

## The four pieces

1. **Boot shell** — small, uncompressed HTML that starts the verified viewer.
   The current contract builder must be able to read this root document without
   running a codec.
2. **Resource graph** — exact scripts, onchain modules, images, WASM, and data
   committed by digest. These child resources should normally be compressed.
3. **Browser decoder** — committed browser code, including the thin WASM Brotli
   decoder where Brotli is selected. It verifies stored bytes, decompresses
   them, verifies decoded bytes, and only then exposes them to the artwork.
4. **Presentation mode** — the explicit route used to deliver the verified
   graph to the browser.

The shell is not a replacement for p5, a seed module, or the creator's script.
It is the small immutable program that loads those exact resources and refuses
to run if their commitments do not match.

## SDK vocabulary

- **KEEL module** — reusable executable or data bytes with a stable module ID,
  version, digest, and exact same-chain object binding. Examples are `p5.js`,
  `keel.seeded-random`, and the thin Brotli WASM decoder.
- **Reusable Inline fragment** — the pre-encoded viewer slot for one module,
  or one half of the verifier shell, published once in a particular chain's
  KEEL store. It is an immutable object reference in a creator plan, not a new
  carrier upload or weld operation.
- **Creator entry slot** — the new artwork-specific script or data. This is the
  part a small generative work normally pays to publish.
- **Inline root** — one ordered composite object: shell prefix, reusable module
  fragments, creator entry slot, and shell suffix. One object can therefore
  reuse many immutable child objects without packing them into the creator's
  carrier chunks again.

A module declaration is not “no code.” It says which exact reusable code the
artwork needs. The publication plan must resolve that declaration to an object
on the selected chain or stop before wallet review. Studio must label reused
fragments as **onchain reused** and creator bytes as **new upload**; calling
both “local” or charging for both hides the most important cost boundary.

## Presentation modes

| Mode | What `animation_url` contains | Byte storage | Runtime dependency |
| --- | --- | --- | --- |
| **Inline** | The complete `data:text/html` document, assembled onchain | Native KEEL objects may be reused | No gateway, IPFS, `/content`, or RPC fetch after the contract read |
| **Hybrid** | An onchain boot shell that resolves committed KEEL objects | Native KEEL storage | A configured RPC reader in the browser |
| **IPFS** | An explicitly selected IPFS shell or graph | IPFS plus the declared commitments | An IPFS gateway/provider |

Hybrid is still fully onchain when every resource is a native KEEL object. The
word describes the **read path**, not a move to offchain storage. IPFS is a
different, explicit selection and must never be substituted silently.

## Compression rule

Keep the boot shell uncompressed. Compress the heavy child resources with
Gzip, Deflate, or Brotli when the selected browser decoder supports that codec.
The Solidity builder does not decompress Brotli. The browser/WASM decoder does,
after verifying the stored commitment, and then verifies the decoded digest.

The SDK exposes this as `KEEL_PRESENTATION_CODEC_POLICY`:

- `none` is the normal boot-shell codec;
- `gzip` and `deflate` use a capability-checked browser
  `DecompressionStream` path in the committed shell;
- `brotli` requires an exact digest-locked KEEL decoder module, normally the
  reusable thin WASM decoder published once per chain. A creator references
  that module; they do not upload another copy with every artwork. Native
  browser Brotli support must not be assumed.

The decoder itself is part of the verified resource graph. If the selected
chain does not contain the declared decoder module, planning stops before
wallet review instead of embedding an unannounced fallback.

For small p5 works, the portable default is a once-per-chain **Gzip p5
fragment** plus the Gzip/Deflate shell profile. It avoids both a creator copy of
p5 and a creator copy of Brotli WASM. Use the Node-side
`@keel/sdk/inline-viewer-graph` helpers to build this graph:

- `buildKeelInlineShellFragments` builds the reusable shell halves without
  Brotli WASM;
- `buildKeelInlineModuleFragment` builds a digest-bound reusable module slot;
- `buildKeelInlineLocalDocument` assembles the exact local sandbox document;
- `buildKeelInlinePreEncodedTokenURIGraph` produces the one publishable ordered
  graph: shell top, project-selected middle, creator entry, shell bottom.

### Normal image, video, and 3D works

A standalone creator image, video, or self-contained binary GLB is not a
zero-module Inline document. Its only valid default graph is:

```text
registered KEEL Inline shell prefix
registered keel.asset-display@1 module
direct creator image / video / model entrypoint
registered KEEL Inline shell suffix
```

`buildKeelInlineNormalMediaDocument` produces those four parts and rejects a
missing, additional, or byte-different display module. The creator entry is the
original media object, not a generated `index.html`; the module receives only a
frozen verified data-URL descriptor and supports images, videos, and
self-contained `model/gltf-binary` WebGL display. A `.gltf` that depends on
external files is not this compact path. `buildKeelRegisteredInlineNormalMediaTokenURIGraph`
requires the exact three reusable catalogue objects before producing a
publishable graph.

Studio binds every reusable graph fragment to an exact same-chain object before
wallet review. The local document is a deterministic preview result, not a
second publication lane.

These functions prepare and verify bytes only. They do not publish the shared
fragments, request approval, or submit a transaction.

Therefore “the p5 module is Brotli-compressed” does **not** make a project
ineligible for Inline. Inline remains possible when a graph-aware contract
builder assembles the module's committed stored bytes into the returned HTML.
A shell containing `/content/...`, `/api/onchain/...`, or an HTTP script URL is
Hybrid because it still performs a runtime fetch.

## Inline recommendation gate

Studio and agents must use `assessKeelInlinePresentation` from `@keel/sdk`.
Inline is recommended only when all of these are true:

- the root is uncompressed HTML;
- the complete `tokenURI` string returned through the public RPC is at most
  2,000,000 bytes;
- it contains no remaining gateway, IPFS, `/content`, or RPC fetch dependency;
- the selected chain exposes the verified builder for the exact KEEL store;
- the exact builder read succeeds under the 30,000,000-gas public-RPC safety
  cap.

The byte and gas checks apply to the **prepared contract return**, not the
browser-decoded p5/module size and not just the tiny boot-shell file. The shell
decompresses child modules after the read. Crossing a public-read limit
recommends Hybrid and explains why; it must not silently change the user's
selected mode.

```ts
import {
  KEEL_PRESENTATION_CODEC_POLICY,
  KEEL_PRESENTATION_TERMS,
  assessKeelInlinePresentation,
} from "@keel/sdk/presentation";

const assessment = assessKeelInlinePresentation({
  builderConfigured: true,
  bootShellCompression: "none",
  tokenUriByteLength: preparedTokenUriBytes,
  mediaType: "text/html",
  html: completeDocument,
});

console.log(KEEL_PRESENTATION_TERMS[assessment.recommendedMode]);
console.log(KEEL_PRESENTATION_CODEC_POLICY.brotli.requirement);
```

This function is read-only. It does not estimate publication fees, open a job,
request wallet approval, publish bytes, or submit a transaction.
