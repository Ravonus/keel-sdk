# Historical Keel Z85 corpus

This fixture preserves the 19 top-level `.b85` objects from the September 2023
ChainRouge Solidity / Keel inventory. It proves the historical byte pipeline
without depending on either external source tree at test time:

```text
preserved file → legacy wrapper extraction → Z85 decode → Brotli decompress → JavaScript bytes
```

`b85/` is copied byte-for-byte from the read-only inventory. `decoded/` contains
the Z85-decoded Brotli streams, while `decompressed/` contains the exact final
JavaScript bytes. `corpus.json` commits sizes and SHA-256 digests at every stage.

The scope is deliberately **top-level files only**. The nested historical test
fixture `test/twgl.b85` is not one of the 19 objects named by the gauntlet and is
recorded as an explicit exclusion in the manifest.

## Legacy wrapper

`start.b85` is the sole file stored as `<b85>…</b85>`. Those delimiters cannot be
passed to a Z85 decoder because several delimiter characters are valid Z85
digits. The original `ScriptStorage.sol` runtime detects the envelope and uses
`slice(5, -6)` before `de85`; this importer preserves the raw file and applies
the same container rule. The modern `decodeBase85` primitive remains unchanged.

## Reproduce and check

```bash
node examples/keel/build-corpus.mjs
node examples/keel/build-corpus.mjs --check
node --test tests/keel-corpus.test.mjs
```

The generator only reads the checked-in `b85/` directory. It validates fatal
UTF-8 but never imports or executes the historical JavaScript. This is a byte
pipeline fixture, not yet a Keel artifact; verified browser rendering belongs
to the next gauntlet item.

See [LICENSES.md](LICENSES.md) before publishing any historical payload.
