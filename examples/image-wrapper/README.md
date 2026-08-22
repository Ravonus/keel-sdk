# Original-preserving image wrapper

`source.svg` is represented as:

- WebP browser preview;
- small HTML viewer using `/content/preview` and `/content/original`;
- untouched original SVG;
- `keel-manifest@2` with file-relative, SHA-256-pinned resources;
- RFC 8785 manifest digest sidecar.

Regenerate the media and manifest with the builder after optional `sharp` support is installed:

```bash
node packages/builder/dist/cli.js wrap-image examples/image-wrapper/source.svg \
  --out examples/image-wrapper/release \
  --name "Original Preserved" \
  --description "WebP display with exact SVG original download"
```

Rebuild only the manifest/integrity files around the checked-in release media:

```bash
node examples/image-wrapper/build-release.mjs
```

Audit:

```bash
node packages/builder/dist/cli.js audit examples/image-wrapper/release/manifest.json
```
