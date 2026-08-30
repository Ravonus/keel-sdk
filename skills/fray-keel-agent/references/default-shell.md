# Canonical KEEL verification shell

Read this before staging any collector-facing viewer.

## Non-negotiable route

Omit `viewer` in `keel-studio-stage-project`. Studio must resolve the registered
`keel-verification-shell` from the selected chain's active Inline catalog. The
agent supplies creator resources and exact module declarations only.

This default is the collector-friendly K/Stratus experience: the protected K
opens Proof, Files, and Trail; the panel docks on the right without covering the
art on desktop and becomes a bottom sheet on mobile. It also owns the frozen
data-only `keel-shell-plugin@1` API. If those behaviors are missing, the agent is
not looking at the canonical default and must stop instead of authoring one.

Never:

- author, copy, shrink, fork, relabel, or upload the default shell;
- use a creator `index.html`, Vault Arcade, Ghost Flash, or another demo as a
  replacement shell;
- infer readiness from an old deployment journal, another builder address, or
  historic `protectorPrefix`, `protectorSuffix`, `protectedHarnessDataURI`, or
  `NoProtector` state;
- manufacture a local fallback when the shell or module catalog is incomplete.

Studio resolves the active `keel-harness-builder`, derives the stable canonical
Inline protection shell ID through the SDK, then verifies the exact registered
prefix, suffix, metadata, existence flag, and `PreEncodedGraph` mode. A missing
or ambiguous record is a safe stop.

## Project content is not shell content

- A static image/video/self-contained GLB becomes direct creator media inside
  registered `keel.asset-display@1` and the registered shell.
- p5, Three.js, Doom, and Flash projects stage creator code/assets and bind
  registered runtime modules inside the same shell.
- Creator-authored HTML is valid artwork content in the shell's opaque child
  frame. Its filename can be `index.html`; its role is still project content.
- `viewer: "none"` means no viewer at all. It does not allow a custom viewer.
  The raw immutable artifact remains releasable, mintable, and directly
  contract-readable.

The shell owns the protected verification UI and proof state. Creator code runs
inside an opaque, deny-by-default child and cannot rewrite the shell's K control,
proof result, or outer panels.

When working in the SDK repository, use
`docs/KEEL_VERIFICATION_SHELL.md` as the canonical implementation and security
map. Cross-link it; do not copy its source or generated HTML into a project.

Registering a different reusable presentation shell is a separate explicit
action using reviewed immutable objects and `keel-shell-prepare`; it cannot
overwrite the default shell. Once registered and indexed, any creator may
explicitly select that compatible shell. It is never an automatic fallback for
ordinary project preparation.
