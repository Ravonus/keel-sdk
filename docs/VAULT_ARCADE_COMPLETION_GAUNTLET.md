# Vault Arcade Completion Gauntlet

**Status:** active. The current runtime is a working deterministic prototype,
not a finished game and not an approved art build.

This gauntlet is the acceptance contract for completing Vault Arcade. It is
deliberately separate from the cross-chain release ledger: a contract or
testnet pass cannot make an unfinished game pass, and a good-looking local game
cannot substitute for contract, public viewer, or wallet proof.

## Hard process rules

1. A builder never approves its own work.
2. A critic reviews the exact source and evidence fingerprint produced by the
   builder. A mismatched fingerprint is `NEEDS_EVIDENCE`, never a pass.
3. PixelLabs remains closed until a generator critic and an art-pipeline critic
   independently approve the world grammar, placeholder boundaries, exact
   animation inventory, and review tooling.
4. Mobs, bosses, characters, foliage, props, tiles, and moving world art remain
   **placeholders** until PixelLabs produces the approved directional masters
   and ImageGen produces the approved animation loops. A placeholder can prove
   mechanics, sockets, masks, and budgets; it cannot prove final visuals.
5. Every generator stage must preserve determinism, connectivity, map/character
   seed separation, and prior contract invariants. Each stage reruns focused
   tests and the world benchmark.
6. A screenshot is required for visual review but cannot replace a machine
   receipt. A machine receipt cannot replace visual review.
7. If the available research, screenshots, source, or measurements are
   insufficient, the critic returns `NEEDS_EVIDENCE` and research continues.

## World-generation acceptance

The same map seed and layer must replay byte-identically. Different map seeds
must produce materially different authored-looking spaces, not merely different
decorations on the same graph. Each accepted population run must prove:

- large connected worlds with locked mission progression and a final holdout;
- coherent biome materials, water/lava/other bodies, elevation, cliffs,
  double-layer ramps, bridges, dynamic bridges, towers, foliage, and objects;
- constrained room situations with traversal and combat purpose rather than
  unconstrained random scatter;
- animated state for water, lava, foliage, machines, doors, bridges, hazards,
  and mission objects while all simulation remains stateless and seed-derived;
- deterministic shops, three-choice floor decisions, automatic affinity growth,
  boss stores, minibosses, puzzles, elites, and character/map seed separation;
- generator performance inside the benchmark budget.

The executable population gate is `scripts/benchmark-vault-worlds.mjs`.

## Stage ledger

Only `CRITIC_PASS` closes a gate.

| Stage | Required proof | State |
| --- | --- | --- |
| G0 baseline and gap receipt | benchmark records current feature failures | BUILDER_PASS |
| G1 biome terrain grammar | bodies, shores, hazards, deterministic masks | PENDING |
| G2 elevation grammar | cliffs, two-level ramps, navigation preservation | PENDING |
| G3 traversal grammar | bridges, dynamic bridges, towers, route purpose | PENDING |
| G4 authored situations | room templates, missions, foliage/objects, breathing states | PENDING |
| G5 game integration | runtime rendering, collisions, minimap, combat, station loop | PENDING |
| G6 contract parity | map clamp/build/stake/run semantics and focused contract suite | PENDING |
| A0 art inventory | every directional/action/FX requirement enumerated | PENDING |
| A1 PixelLabs master gate | independent critics approve generation inputs | CLOSED |
| A2 ImageGen motion gate | actual loops reviewed frame by frame | CLOSED |
| A3 final atlas integration | masks, pivots, targets, budgets, runtime pixels | CLOSED |
| R0 fresh browser playthrough | multiple seeds, missions, boss, station, no console errors | PENDING |
| R1 independent final judge | exact fingerprints and all upstream evidence | PENDING |

## Benchmark thresholds

The benchmark samples many seeds and layers and fails closed on determinism,
connectivity, signature uniqueness, four-biome coverage, authored situations,
breathing objects, bodies, cliffs, ramps, bridges, dynamic bridges, towers,
foliage, and p95 generation time. Thresholds live in the executable script so
the receipt and the gate cannot silently disagree.

## Art pipeline boundary

For each animation-bearing asset family the pipeline is:

1. approved grayscale/material-target design specification;
2. PixelLabs eight-direction master (or explicitly direction-free radial
   master when geometry proves that exception);
3. source and per-direction visual review;
4. ImageGen idle/move/attack/hit/death or world-state loops;
5. frame-by-frame critic review for identity, direction, motion, silhouettes,
   pivots, equipment separation, target masks, and loop continuity;
6. atlas compile, byte budget, runtime capture, and independent final approval.

No generated candidate is promoted merely because a job completed.
