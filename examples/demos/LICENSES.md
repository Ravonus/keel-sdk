# Third-party content in the demo gallery

The demo sources under `examples/demos/` are MIT, like the rest of this
repository. The vendored libraries and the original Keel assets they load are
not, and are listed here in full.

## `vendor/three.min.js`, `vendor/three.core.min.js`

three.js r180 — **MIT**, © three.js authors. <https://github.com/mrdoob/three.js>

Retrieved from `https://unpkg.com/three@0.180.0/build/`.

**Modified.** r180 ships as a two-module graph, and `three.min.js` ends with a
bare relative import of `./three.core.min.js`. A relative specifier cannot be
resolved inside the Keel sandbox, which serves resources from verified
`/content/<id>` routes and has no origin to resolve against. That single
specifier was rewritten:

```diff
-from"./three.core.min.js"
+from"/content/three.core.min.js"
```

Nothing else was touched. Both files keep their original license headers.

## `vendor/p5.min.js`

p5.js 1.11.3 — **LGPL-2.1**, © the Processing Foundation.
<https://github.com/processing/p5.js>

Retrieved verbatim from cdnjs; unmodified. It is loaded as a separate, complete
library rather than linked into any derived work, which is the arrangement
LGPL-2.1 is written for. If you would rather not carry an LGPL file in this
tree, delete `p5-flowfield` from `demos.mjs` and the `vendor/p5.min.js` file —
nothing else depends on it.

## `vendor/p5.brush.min.js`

p5.brush.js 1.1.4 — **MIT**, © 2023-2024 Alejandro Campos Uribe.
<https://github.com/acamposuribe/p5.brush>

Retrieved from the npm registry tarball
(`https://registry.npmjs.org/p5.brush/-/p5.brush-1.1.4.tgz`, `dist/p5.brush.js`).

**Modified.** The library builds its vector-field grid once, sized to the
canvas at first init, and `load()` never re-fits it — after a canvas resize,
field-driven strokes sample a stale grid. One expression was appended to the
internal `load` path so an already-initialized field grid is rebuilt at the
new canvas size:

```diff
-y.load(e),o=!0}
+y.load(e),o=!0,n&&z.create()}
```

Nothing else was touched. SHA-256 of the patched file:
`9b13697c3d545973a37233b551504cdacc82fa9539395103b202b7c4f787f411`, 36,861
bytes — the same commitment `p5-brush-watermarks/shared-module.mjs` pins for
the on-chain shared-library declaration. Version 1.1.4 is the last release
targeting p5.js 1.x, matching the vendored (and Sepolia-deployed) p5 1.11.3;
the 2.x line requires p5 2.x. It is a UMD bundle with no imports, so no
`/content/` specifier rewriting was needed.

## `vendor/player-small.js`

SoundBox CPlayer — **zlib/libpng**, © 2011-2013 Marcus Geelnard.
<https://github.com/mbitsnbites/soundbox>

Unmodified. Note that the SoundBox *editor* is GPL-3; only the player, used
here, is zlib licensed. Its notice is preserved in the file header.

## `soundbox-synth/{shot,laser,song}.json`

Original Keel synth patches, from `Ravonus/oca_whitepaper` (`public/jsons/`).
Same license as this repository.

## `sprite-forge/*.webp`, `sprite-forge/char1.png`

Original Keel attribute art, from `Ravonus/oca_whitepaper`
(`public/attributes/`). Same license as this repository.

## Historical Keel corpus

The separate historical `.b85` compatibility fixtures have their own provenance
and unresolved-license record in [`examples/keel/LICENSES.md`](../keel/LICENSES.md).
The `keel-genart` gallery entry is the deliberately narrow exception: it
uses only the author-origin `start-genart` object and 137-byte seed helper from
the portable evidence subset. It remains labelled
`LicenseRef-Ravonus-Keel-Research`; it does not bundle the unresolved Fluid,
TWGL, Babylon, capture, or webMatrix dependencies.
