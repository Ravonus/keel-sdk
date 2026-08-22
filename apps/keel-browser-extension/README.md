# Keel Verified Viewer extension

Load this directory as an unpacked Chromium extension. On OBJKT token routes it
detects the collection and token id, reads standard TZIP metadata from TzKT,
resolves the declared `keelArtifactUri`, verifies `keelViewerDigest`, and
renders the exact recursive viewer in an extension-owned overlay.

The extension does not enable or modify OBJKT Advanced Mode. It is a separate,
fail-closed Keel delivery path. Native Keel HTML plus independently
compressed modules is canonical. An IPFS module-directory mirror is the normal
large-artifact compatibility carrier; Studio generates a self-contained ZIP
only when a marketplace explicitly requires one.
