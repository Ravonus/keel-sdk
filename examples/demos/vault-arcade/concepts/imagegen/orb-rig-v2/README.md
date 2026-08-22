# Orb rig v2 ImageGen candidate

Status: **candidate only — pending visual approval; not used by the viewer**.

This directory records the first single-angle ImageGen attempt for the missing
`south-southwest` view. The earlier eight-sprite sheet attempt was rejected
because it repeated the supplied key angles and is not included here.

## Inputs

- `orb-panel-mask-v2.png` is the user-supplied replacement semantic mask.
- The adjacent `south` and `south-west` art/mask cells were supplied to
  ImageGen individually. No human turnaround was used.

## Outputs

- `south-southwest-imagegen-source.png` is the opaque ImageGen source on a
  magenta keyed background.
- `south-southwest-candidate-34-rgb.png` is the normalized opaque RGB candidate.
- `south-southwest-candidate-34-mask.png` is the separate 34x34 coverage mask.
- `south-southwest-candidate-34-semantic-mask.png` is the palette-quantized
  shell/visor/light/port ID mask.
- `south-halfway-southwest-review.png` shows SOUTH, candidate, SOUTH-WEST.

Background extraction uses RGB mask classification only. Generated alpha is
ignored. The normalized coverage mask contains 444 foreground cells, compared
with 446 foreground cells in each adjacent authored view.

## ImageGen prompt

Generate exactly one new SOUTH-SOUTHWEST view of the same Vault Orb,
geometrically halfway between the supplied SOUTH and SOUTH-WEST art references.
It must be a genuinely new 22.5-degree camera view, not either endpoint and not
a blend, dissolve, double exposure, flat canvas rotation, sprite sheet, or
presentation board. Preserve the exact Orb identity, proportions, one-pixel
outline, shell seams, grayscale palette, visor/core-light construction, rear
port construction, and low-resolution pixel vocabulary. Render one centered,
groundless Orb on a fully opaque flat magenta keyed background. No transparency,
human, weapon, shadow, text, grid, added panel, antialiasing, blur, or glow.

## Review note

The candidate is a distinct frame, but the normalized result still shows a
soft vertical seam and palette drift. Do not promote it without visual approval
and a focused cleanup pass.
