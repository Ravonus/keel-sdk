# `@keel/builder`

Build and audit tools for browser-native Keel artifacts.

The CLI bin is `keel`. The old `oca` bin name still works as a compatibility
alias for existing scripts; new documentation and tooling use `keel`.

## Author module pipeline

`keel module init|build|plan` walks a strict-TypeScript module from scaffold to
a review-only publish plan. See `docs/KEEL_MODULE_PIPELINE.md` for the full
walkthrough:

```bash
keel module init ./my-module
keel module build ./my-module   # strict tsc, esbuild minify, recipe + receipt
keel module plan ./my-module    # review-only keel-publish-plan@1, no signing
```

## Deterministic media pipeline

The headless pipeline is shared by the CLI and future Studio/MCP consumers. It
analyzes a local file, wraps supported image media, then verifies every local
manifest source and integrity envelope:

```bash
keel analyze ./art.png --json
keel build ./art.png --out ./release --created-at 2026-01-01T00:00:00.000Z --json
keel verify ./release --json
```

`build` requires a canonical UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) so
repeated builds have the same manifest commitment. `--json` selects the
machine-readable result; without it, the command prints a short summary. The
first slice wraps image files; other media is still classified by `analyze` and
reports that a media-specific builder is not yet available. Fixed inputs and
the manifest are deterministic, while encoded preview bytes remain
processor-dependent (for example, the selected `sharp`/libvips adapter); the
result does not claim codec-byte reproducibility without a pinned processor.
Local verification fails closed for missing, tampered, unavailable, or
path-escaping resources. Chain and gateway sources require their resolver
adapter and are not silently treated as verified by this local command.

## Modeled storage cost analysis

The pure `analyzeCost` API and `keel cost` command compare deterministic
`none`, Brotli, gzip, and deflate encodings (or one requested encoding), then
report exact stored chunk counts, flat-object feasibility, recursive leaf/tree
counts, modeled transaction counts, and ABI-sized calldata bytes:

```bash
keel cost ./release/viewer.html \
  --media-type text/html \
  --compression auto \
  --chunk-bytes 23000 \
  --leaf-bytes 524288 \
  --parts 64 \
  --max-depth 8 \
  --json
```

Flat estimates use the KeelHold limits (128 children and three chunk
payloads per upload transaction). Recursive estimates compress each decoded
leaf independently and include leaf and composite object calls; the default
depth budget of 8 matches the direct Keel object reader and can be raised
only when targeting a reader with a larger documented limit. These are
deterministic planning numbers based on the documented ABI-size model, not gas
quotes: chain, calldata pricing, refunds, base fees, and wallet/provider
behavior are deliberately outside this offline command.

## Module resolver snapshot

The resolver consumes a local `keel-module-resolver-catalog@1` snapshot. It
contains the existing `keel-module-catalog@1` releases plus a separate,
display-only metadata list keyed by the exact release key. Artist and tag
metadata is a search aid, not creator or chain identity proof. A canonical
SHA-256 digest of the snapshot is pinned into every lock and receipt.

```bash
keel module-resolve ./modules.snapshot.json \
  --namespace npm --name three --version 0.180.0 \
  --artist "Three.js Authors" --tag renderer --json

keel module-lock ./modules.snapshot.json \
  --out ./keel.lock.json \
  --namespace npm --name three --version 0.180.0
```

Exact content selectors use both `--digest 0x…` and `--byte-length`; name,
artist, and tag selectors fail closed when they match more than one release.
The lock writes a `.receipt.json` sidecar. Both files commit canonical
integrities, but `bytes=unavailable` is intentional: a catalog carrier URI is
metadata only and has not been fetched or verified. Supply exact bytes to the
receipt API before treating a release as content-verified.
The snapshot file helpers are Node CLI-only; browser and MCP consumers should
use the exported pure snapshot, resolver, lock, and receipt APIs.

## Image wrapper

```bash
keel wrap-image ./art.png \
  --out ./release \
  --name "Living Study #1" \
  --description "WebP display with the exact PNG retained"
```

Default output:

```text
release/
├── living-study-1.preview.webp
├── living-study-1.viewer.html
├── living-study-1.original.png
├── manifest.json
└── manifest.integrity.json
```

The wrapper uses `/content/preview` and `/content/original`. Those names are resolved only after verification. The manifest includes:

- `keel-manifest@2`;
- RFC 8785 canonicalization;
- per-resource SHA-256 integrity;
- deterministic replay inputs;
- verified-only content policy;
- exact original download when preserved.

Options:

- `--inline`: embed resource bytes as Base64;
- `--no-original`: intentionally omit the original/download;
- `--quality 1..100`: set WebP quality;
- `--viewer-base-url`: conventional external viewer route.

Programmatic callers may inject an `ImageProcessor`, registry anchor, and hash-verified viewer mirrors.

## Audit

```bash
keel audit ./release/manifest.json
```

The command parses untrusted JSON, validates semantics, canonicalizes with RFC 8785, and reports the canonical SHA-256 digest.

## Flat object plan

```bash
keel chunk ./release/living-study-1.viewer.html \
  --out ./release/viewer-object \
  --media-type text/html \
  --compression auto \
  --chunk-bytes 23000
```

Every chunk and object descriptor is emitted. Reconstruction must match the exact original decoded bytes.

## Balanced recursive plan

```bash
keel chunk-recursive ./film.mp4 \
  --out ./film-plan \
  --media-type video/mp4 \
  --leaf-bytes 524288 \
  --parts 64
```

Each leaf is independently compressed and verified. Composite levels contain at most 128 child objects; fanout above the contract limit is rejected. The root digest remains the digest of the original decoded file.
