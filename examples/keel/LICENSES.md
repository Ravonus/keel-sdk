# Historical corpus provenance and license status

These fixtures were copied from the author's September 2023 ChainRouge Solidity
/ Keel prototype. The snapshot's `package.json` declares ISC for that project,
but it has no repository-level `LICENSE`, `NOTICE`, or Git metadata. That package
field is not treated here as proof of the license for every embedded payload.

Known third-party material:

- `fluid-dat.gui.b85` / `decompressed/fluid-dat.gui.js` identifies itself as
  dat.gui, copyright 2011 Data Arts Team and Google Creative Lab, licensed under
  Apache License 2.0. Its original notice remains byte-for-byte in the expanded
  file. <https://www.apache.org/licenses/LICENSE-2.0>
- `twgl.b85` expands byte-for-byte to the historical tree's
  `THREECHAIN/twgl-full.module.js`, but that snapshot retains no reliable version
  or license notice in the payload.
- `webMatrix.b85`, `fluid-capture.all.b85`, and the remaining fluid modules have
  vendor-like code without enough retained provenance to assert a license here.
- `start-p5.b85` is an entry script that expects p5 as an external global; it
  does not embed the p5 library. The production-path Comet compatibility fixture
  pins the exact emitted dependency, p5.js 1.7.0, at
  `vendor/p5-1.7.0.min.js` (SHA-256
  `bb7f8f14b9ce2e2344ff5cd6c06f2e105eb99541ecbfec77139e2886d9c0b9ba`).
  It is redistributed under LGPL-2.1 with the exact upstream license retained
  at `vendor/p5-1.7.0-LICENSE.txt`; upstream source tag:
  <https://github.com/processing/p5.js/tree/v1.7.0>.

The corpus is checked in for local compatibility research and byte verification.
Do not represent the unresolved entries as MIT or publish/deploy this corpus
until their upstream versions and redistribution terms are pinned.

The portable historical evidence subset under `historical/` has a narrower
scope. Its exact three.js r154 source and serializations are retained under the
upstream MIT notice in `historical/THREE-LICENSE.txt`. The Comet and game files
are author-origin prototype fixtures used for local reconstruction tests. This
does not resolve or relicense the third-party dependencies listed above.
