# Historical Keel evidence fixtures

This directory is the portable, integrity-pinned evidence subset generated from
the two author-provided prototype trees. Regenerate it explicitly with:

```sh
node examples/keel/build-historical-evidence.mjs
node examples/keel/build-historical-evidence.mjs --check
```

The generator reads, but never changes:

- `/Users/ravonus/dev/chainrougesolidity-inventory`
- `/Users/ravonus/dev/chainrougesolidity-development`

`report.json` states the proof boundary. In particular, byte reconstruction is
verified locally; chain publication receipts and browser-render observations
are separate evidence and must not be inferred from this report.

## Contents

- `game-fragments/` stores exactly three shared fragments plus ten per-token
  fragments for token captures 11, 14, 18, 20, 21, 33, 36, 46, 47, and 52.
  Their 44,476 bytes reconstruct all 408,301 original bytes byte-for-byte.
- `game-comparison/` preserves the exact shared/token split for captures 3 and
  4 without storing duplicate full pages.
- `game-unsupported/` preserves variants 6 through 9 so the parser's explicit
  rejection is portable and testable.
- `three/` preserves the exact r154 source and both differently serialized Z85
  artifacts. The `*.z85` filenames are intentionally not called Deflate: their
  decoded payloads are Brotli.
- `comet/` preserves the emitted Comet HTML and the exact historical seed helper.

## Publication boundary

Three.js is MIT-licensed; its notice is retained in `THREE-LICENSE.txt`. The
author-origin game and Comet fixtures are included for local compatibility
research. They are not a blanket license grant for the unresolved third-party
Fluid, TWGL, Babylon, capture, or webMatrix material described in the parent
`LICENSES.md`. Do not turn a research fixture into a public deployment without
resolving those dependencies individually.
