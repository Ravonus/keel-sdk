# @keel/studio-core

Node-side, framework-neutral preparation for Keel Studio. It normalizes project paths, infers media roles, generates safe browser entrypoints, chooses the smallest supported compression, commits decoded-byte integrity, emits valid `oca-manifest@2` manifests, verifies prepared artifacts, and estimates balanced `KeelHold` uploads.

The package contains no database or web-framework code. `apps/studio` provides the T3/Drizzle adapters.
