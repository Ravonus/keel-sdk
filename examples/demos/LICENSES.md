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
