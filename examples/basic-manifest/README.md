# Basic multi-resource artifact

This example keeps HTML, CSS, JavaScript, and SVG as separate inline resources with mandatory SHA-256 integrity.

The HTML uses `/content/style` and `/content/runtime`; the CSS uses `/content/fallback`. Those familiar paths are not web-server permissions. The viewer maps them to verified bytes inside the sandbox.

The manifest demonstrates:

- `oca-manifest@2`;
- RFC 8785 digest sidecar;
- deterministic replay viewport/clock/seed;
- verified-only content policy;
- conventional ERC-721 metadata compatibility.

Rebuild after compiling the protocol package:

```bash
node examples/basic-manifest/build.mjs
node packages/builder/dist/cli.js audit examples/basic-manifest/manifest.json
```
