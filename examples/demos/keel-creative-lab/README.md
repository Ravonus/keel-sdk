# Keel Creative Lab

Temporary consumer test surface for pinned p5.js and Three.js Keel scenes.

The HTML verifier/loader is an on-chain Keel object in every lane. Hybrid
means that a committed manifest inside that on-chain wrapper names an external
payload carrier; it never means that `animation_url` hands control to an
off-chain viewer. Missing, corrupt, stale, or unavailable payloads remain inside
the same wrapper and produce its terminal verification failure state.

`edge-case-matrix.json` binds the real stress assets and contract shapes. The
compact WebP renditions exercise fully recursive on-chain image delivery, while
the multi-megabyte PNG originals exercise hash-bound hybrid delivery. The scene
set also includes inline seeded instancing, textured geometry, and a mixed graph
that combines a large image with thousands of deterministic objects. The same
forced verifier shell also mounts plain images, an independently stored WebM,
classic canvas JavaScript, and a manifested API snapshot algorithm;
presentation modules are not separate verifier implementations.

Presentation changes are declared rather than hidden. A creator-authorized CSS
revision remains verified with a new parented resource revision. Locked code
cannot be replaced by that CSS policy. Token-owner palette state may reuse the
same package bytes when the host preserves committed query state. API-driven art
renders only committed canonical snapshots with an advancing sequence; live or
wrong-format responses fail verification.

The page intentionally has two states:

- Without `release.json`, all six scenes may be previewed, but publishing is disabled and the UI says **Preview only**.
- With a deployment-generated `release.json`, editable scene cards expose only exact prebuilt revisions. The page submits the listed wallet transactions, waits for receipts, proves `tokenURI` changed, executes every recursive proof read, and then exposes the chain-bound collector URL.

The proof surface keeps three independent facts separate:

- **On-chain item** means the recursive descriptors and carrier bytes are immutable and publicly readable from `KeelHold` by root object ID.
- **Runtime verified** means the viewer reconstructed the item, decompressed it, and matched the declared decoded length and SHA-256. A matching Item Builder receipt may enable a sandboxed fast path, but the viewer still rechecks it in the background.
- **Source/build verified** means readable source plus its committed deterministic build recipe reproduced the exact decoded executable bytes. This is the Etherscan-style source claim; it is independent of the storage route.

The Item Builder emits the recursive storage object and optional hash-equivalent representations. It does not embed a verifier into every item. The Viewer Builder emits a shared, minified HTML verifier/launcher for one exact delivery profile. An onchain build contains the recursive contract reader. A URL build contains an immutable ordered source list: the creator's mirror first, then a canonical Keel gateway URL for the same onchain object. Every response must match its committed stored-byte receipt (when compressed) and the same final decoded SHA-256. If every listed URL fails or mismatches, the wrapper fails hard; it never switches to an uncommitted runtime route. Switching delivery profiles or changing the ordered URLs is a tracked presentation revision, not a `tokenURI` argument. Browser and WASM packages execute inside that wrapper; native packages can be verified and handed to an installed launcher without being executed by the browser.

The default output is ordinary, uncompressed `.html` with the small verifier and Brotli decoder embedded; saving the returned bytes as HTML is enough to launch it. Viewer Builder also emits an optional `.html.br` variant for storage-constrained callers. That variant is explicitly a compressed file and must be decompressed before a browser can interpret it as HTML. Compressed p5/Three modules need no caller-side magic because the uncompressed wrapper performs their decompression and verification itself.

`release.json` is generated output and must never be authored by the browser. Its shape is:

```json
{
  "schema": "keel-creative-lab-release@1",
  "network": "Ethereum Sepolia",
  "chainId": 11155111,
  "rpcUrl": "https://credential-free-rpc.example",
  "scenes": [
    {
      "id": "three-edit",
      "collectorUrl": "https://studio.example/collect/11155111/0xcollection/3",
      "collection": "0xcollection",
      "tokenURICallData": "0xc87b56dd...",
      "revisions": [
        {
          "revision": 2,
          "attributes": { "seed": 90210, "background": "#102538", "accent": "#74ffd0" },
          "collectorUrl": "https://studio.example/collect/11155111/0xcollection/3",
          "transactions": [
            { "from": "0xowner", "to": "0xcontract", "data": "0x...", "value": "0x0" }
          ],
          "proofReads": [
            { "label": "active presentation", "to": "0xregistry", "data": "0x...", "sha256": "0x..." }
          ]
        }
      ]
    }
  ]
}
```

The deployment generator must include proof reads for the active KeelIndex presentation, manifest content object, Keel viewer/object slots, exact Library policy/graph versions, and any token attribute object. A receipt with only a presentation transaction is incomplete.
