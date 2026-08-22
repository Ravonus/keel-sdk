# Keel demo gallery

Five artifacts that exist to prove specific claims from the Keel whitepaper and
the recovered Keel prototype — on
a real chain, through the real pipeline, not as screenshots.

| Demo | Proves |
| --- | --- |
| `three-vault` | A full 3D library (726 KB of three.js) can be committed on chain and verified byte-for-byte before it runs. |
| `p5-flowfield` | A seeded sketch renders identically for every viewer, because the seed is pinned in the manifest. |
| `soundbox-synth` | Sound can be stored as a few hundred bytes of synthesis parameters instead of audio. |
| `sprite-forge` | Attribute art under 1 KB stays cheap on chain because WebGL supplies colour and lighting at runtime. |
| `keel-genart` | An exact historical Z85/Brotli object can render through the verified modern gateway without its old remote loader. |

`soundbox-synth` and `sprite-forge` use the original Keel assets from the
whitepaper repository. See [`LICENSES.md`](./LICENSES.md) for everything
vendored here.

## Layout

```
demos.mjs      the catalogue — the single source of truth for what each demo contains
build.mjs      builds a self-contained oca-manifest@2 per demo (used by the tests)
vendor/        three.js, p5.js, and the SoundBox player
<slug>/        one directory per demo: index.html plus its own sources
```

`demos.mjs` lists resources in load order. A resource's `id` is the flat
filename it is uploaded under, which is also the `/content/<id>` route its HTML
references — the same id the Studio creator pipeline derives from an uploaded
project path. That is why the demos work identically whether they are built
locally by `build.mjs` or published through Studio.

## Building the manifests

```bash
pnpm demos:build
```

Writes `dist/<slug>.manifest.json` and a `dist/summary.json` with each demo's
digest and compression numbers. Sources are inline and individually compressed
with whichever of brotli, gzip, deflate, or none is actually smallest for that
resource. Integrity is always recorded over the *decoded* bytes, so the
commitment describes the artifact rather than the encoding it travelled in.

## Publishing to the local chain

```bash
pnpm local:setup          # postgres, anvil, migration, contracts, deploy, seed
pnpm studio:seed-demos    # ingest, upload to KeelHold, anchor in the registry
pnpm studio:index
pnpm studio               # then open /demos
```

`studio:seed-demos` takes no shortcuts around the product: each demo goes
through the same `createArtifact()` the `/create` page calls, its resources are
uploaded to `KeelHold` as real transactions, and its manifest is published to
the `KeelIndex` and activated. The `/demos` page then resolves each one
starting from the live registry commitment.

Re-running it is safe — already-published demos are skipped. To republish one,
delete its row first:

```bash
psql "$DATABASE_URL" -c "delete from artifacts where slug='three-vault'"
```

## Tests

`tests/demos.test.mjs` covers every demo: resource resolution and integrity,
byte-exact round-tripping through compression, gateway route allow/deny,
sandbox mounting, digest stability, and the fact that entrypoints only reference
routes the manifest actually declares. It also checks the whitepaper's
compression claims against the real three.js build, and the modern uint48
packer against the original Keel `packIds` implementation.

`apps/studio/tests/e2e/demos.spec.ts` drives the gallery in a browser and
asserts each demo reaches `ready` with `anchor verified`.
