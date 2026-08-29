// Watermarks — a brushed watercolor PFP renderer for the Keel demo gallery.
//
// p5.brush (shared library, verified bytes) does the pigment work; this file
// decides what the pigment says. p5.brush 1.x owns a single WebGL context, so
// the painting is layered without extra buffers: every pass is painted on the
// main canvas and snapshotted with get() —
//
//   bases[2]   background + face washes + wash-borne traits + committed
//              click splats, in TWO wash variants whose slow crossfade
//              re-forms the blot itself (the Rorschach morph). Rebuilt from
//              the recipe on resize — resolution-independent.
//   frames     per variant, the base plus identical ink line work ×3,
//              cycled and crossfaded — the hand-drawn "boil".
//   blinks     per variant, the same painting with the eyes drawn closed;
//              blended in for blinks and for idle sleep.
//   live fx    pupils (the gaze follows the pointer), major trait
//              animations, the drying tide line, damp hover marks, trails
//              and swipe gusts — brushed on top of the frame every draw.
//
// Identity (traits, layout, colorways) comes from /content/traits.js and is
// derived once from the token seed; the paint streams here only add stroke
// wobble, so one seed is one person forever, at any resolution.

import { deriveIdentity, makeStream } from "/content/traits.js";

// --------------------------------------------------------------------------
// Seed and identity

function readUrlParam(name) {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Expands a small collection index into a full 256-bit hex seed. */
function seedFromIndex(index) {
  let h = 0x811c9dc5;
  const feed = (text) => {
    for (let at = 0; at < text.length; at += 1) {
      h ^= text.charCodeAt(at);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  feed(`watermarks:${index}`);
  let hex = "";
  for (let word = 0; word < 8; word += 1) {
    hex += feed(`:${word}`).toString(16).padStart(8, "0");
  }
  return `0x${hex}`;
}

const CONTEXT = globalThis.__KEEL_CONTEXT__;
const URL_SEED = readUrlParam("seed");
const URL_INDEX = Number.parseInt(readUrlParam("n") ?? "", 10);
const TOKEN_INDEX = Number.isFinite(URL_INDEX) ? URL_INDEX : 3;
const RAW_SEED = CONTEXT?.derivedTokenSeed ?? globalThis.KEEL_SEED ?? URL_SEED ?? seedFromIndex(TOKEN_INDEX);
const SEED = typeof RAW_SEED === "number"
  ? `0x${(RAW_SEED >>> 0).toString(16).padStart(8, "0")}`
  : String(RAW_SEED);
const SEED_INT = Number.parseInt(SEED.replace(/^0x/u, "").slice(-8), 16) >>> 0;
const BACKGROUND_OVERRIDE = CONTEXT?.background ?? globalThis.KEEL_BACKGROUND ?? readUrlParam("bg") ?? undefined;

const identity = deriveIdentity(SEED, { background: BACKGROUND_OVERRIDE });
const P = identity.palette;
const L = identity.layout;

function trait(slot) {
  return identity.traits.find((entry) => entry.slot === slot);
}
const FACE = trait("Face");
const EYES = trait("Eyes");
const MOUTH = trait("Mouth");

// --------------------------------------------------------------------------
// Seed bar — a browsing affordance for the gallery page only. Inside a Keel
// token context the bar stays hidden and the token seed rules.

(function mountSeedBar() {
  const bar = globalThis.document?.getElementById("seedbar");
  if (!bar) return;
  if (CONTEXT?.derivedTokenSeed !== undefined) {
    bar.style.display = "none";
    return;
  }
  const label = document.getElementById("seedlabel");
  if (label) {
    label.textContent = URL_SEED ? `${SEED.slice(0, 10)}…` : `Nº ${TOKEN_INDEX}`;
  }
  const go = (index) => {
    location.href = `?n=${index}`;
  };
  document.getElementById("seedprev")?.addEventListener("click", () => go(TOKEN_INDEX - 1));
  document.getElementById("seednext")?.addEventListener("click", () => go(TOKEN_INDEX + 1));
  document.getElementById("seedrand")?.addEventListener("click", () =>
    go(1 + Math.floor(Math.random() * 100000)));
})();

// --------------------------------------------------------------------------
// Color helpers — hex in, gentle pigment behavior out.

function hexToRgb(css) {
  // Accepts #rrggbb and the rgb(r,g,b) strings our own helpers emit, so
  // pigment transforms chain freely.
  const rgb = css.match(/rgb\((\d+),(\d+),(\d+)\)/u);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const clean = css.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(clean.slice(index, index + 2), 16));
}
function rgbCss([r, g, b]) {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
function mixHex(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbCss(a.map((channel, index) => channel + (b[index] - channel) * t));
}
function jitterColor(hex, rng, amount = 10) {
  const c = hexToRgb(hex);
  return rgbCss(c.map((channel) => Math.max(0, Math.min(255, channel + (rng() - 0.5) * 2 * amount))));
}
/** Airy version of a pigment: pulled toward the paper like a diluted wash. */
function dilute(hex, t) {
  return mixHex(hex, P.paper, t);
}
/** Resolves a colorway to a concrete color for stroke t in [0,1]. */
function colorwayAt(colorway, t, rng) {
  if (colorway.kind === "duotone") return jitterColor(t < 0.5 ? colorway.from : colorway.to, rng, 8);
  if (colorway.from === colorway.to) return jitterColor(colorway.from, rng, 8);
  const a = hexToRgb(colorway.from);
  const b = hexToRgb(colorway.to);
  const mixed = a.map((channel, index) => channel + (b[index] - channel) * t);
  return rgbCss(mixed.map((channel) => Math.max(0, Math.min(255, channel + (rng() - 0.5) * 16))));
}

// --------------------------------------------------------------------------
// Geometry — unit space is 1000x1000, mapped onto the centered art square.

let S = 0; // art square in px
let U = 1; // px per unit
let OX = 0;
let OY = 0;
function ux(x) { return OX + x * U; }
function uy(y) { return OY + y * U; }
function uu(v) { return v * U; }

const shapeRng = makeStream(SEED, "shape");
const faceOffsets = Array.from({ length: FACE.params.vertices }, () =>
  1 + (shapeRng() - 0.5) * 2 * FACE.params.irregularity);
const biteIndex = Math.floor(shapeRng() * FACE.params.vertices);

/** Face contour in unit space, optionally wobbled, scaled, and re-rotated. */
function faceContour({ amp = 0, rng = null, scale = 1, spin = 0, dx = 0, dy = 0 } = {}) {
  const n = FACE.params.vertices;
  const w = FACE.params.width * scale;
  const h = w * FACE.params.aspect;
  const tilt = ((FACE.params.tilt + spin) * Math.PI) / 180;
  const points = [];
  for (let index = 0; index < n; index += 1) {
    const angle = (index / n) * Math.PI * 2 - Math.PI / 2;
    let radius = faceOffsets[index];
    if (FACE.variant === "Cutout" && index === biteIndex) radius *= 0.62;
    let x = Math.cos(angle) * (w / 2) * radius;
    let y = Math.sin(angle) * (h / 2) * radius;
    if (FACE.variant === "Arch" && y > 0) {
      y *= 0.72;
      x *= 1.14;
    }
    if (amp > 0 && rng) {
      x += (rng() - 0.5) * 2 * amp;
      y += (rng() - 0.5) * 2 * amp;
    }
    const rx = x * Math.cos(tilt) - y * Math.sin(tilt);
    const ry = x * Math.sin(tilt) + y * Math.cos(tilt);
    points.push([L.cx + dx + rx, L.cy + dy + ry]);
  }
  return points;
}
const faceW = FACE.params.width;
const faceH = faceW * FACE.params.aspect;

// Feature anchors (unit space).
const eyeY = L.cy - faceH * 0.08 + EYES.params.height * faceH;
const eyeGap = (faceW * EYES.params.gap) / 2;
// PFP eyes carry the face: scaled up from the rolled radius.
const EYE_SCALE = 1.6;
const eyeL = { x: L.cx - eyeGap, y: eyeY, r: EYES.params.radius * EYE_SCALE, tilt: EYES.params.tiltL };
const eyeR = { x: L.cx + eyeGap, y: eyeY, r: EYES.params.radius * EYE_SCALE * EYES.params.asym, tilt: EYES.params.tiltR };
const mouthY = eyeY + faceH * MOUTH.params.drop;
const mouthW = faceW * MOUTH.params.width;
const mouthX = L.cx + faceW * MOUTH.params.offCenter;

// --------------------------------------------------------------------------
// Brush plumbing — one canvas, one context; layers live as snapshots.

// Two complete paintings of the SAME person. Variant 0 and variant 1 differ
// only in the paint-stream rolls of the wash — lobe wobble, glaze drift,
// droplets — while the background is byte-identical and the ink strokes are
// identical. Slowly crossfading between them re-forms the blot itself,
// Rorschach-mask style; the features and the paper hold perfectly still.
let bases = [null, null];
let frames = [
  [null, null, null],
  [null, null, null],
];
let blinks = [null, null];
let variantReady = false; // variant 1 builds lazily, after the first paint
let vmixEased = 0;
let morphClock = 0;
const queue = []; // paint thunks, drained per frame — the portrait paints itself
let ready = false;

/** Seeds every generator, frames the unit square, runs fn, flushes brushes. */
function phase(name, fn) {
  brush.seed(`${SEED}:${name}`);
  randomSeed(SEED_INT ^ name.length);
  push();
  translate(-width / 2, -height / 2);
  fn();
  brush.reDraw();
  brush.reBlend();
  pop();
}

function strokePolygon(points, curvature = 0.4, close = true) {
  brush.beginShape(curvature);
  for (const [x, y] of points) brush.vertex(ux(x), uy(y));
  brush.endShape(close ? CLOSE : undefined);
}

function fillPolygon(points, css, opacity, bleedStrength, texture, curvature = 0.4, border = 0.5) {
  brush.noStroke();
  brush.fill(css, opacity);
  brush.bleed(bleedStrength, "out");
  brush.fillTexture(texture, border);
  strokePolygon(points, curvature, true);
  brush.noFill();
}

function inkSpline(points, brushName, css, weight, curvature = 0.5) {
  brush.set(brushName, css, weight);
  brush.spline(points.map(([x, y]) => [ux(x), uy(y)]), curvature);
}

/** A soft, very dilute stain — the water in watercolor. */
function bloom(rng, x, y, size, hex, opacity = 22) {
  const points = [];
  const n = 8;
  for (let step = 0; step < n; step += 1) {
    const angle = (step / n) * Math.PI * 2;
    const radius = size * (0.7 + rng() * 0.6);
    points.push([x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * (0.8 + rng() * 0.4)]);
  }
  fillPolygon(points, dilute(hex, 0.82), opacity, 0.46, 0.9, 0.5);
}

// --------------------------------------------------------------------------
// Background painters — paper stays dominant; washes live inside a deckle
// margin so every token keeps a breath of clean sheet at the edges.

function paintBackground(rng) {
  const style = identity.background.style;
  const washA = dilute(P.washes[0], 0.72);
  const washB = dilute(P.washes[1 % P.washes.length], 0.78);
  background(P.paper);
  const m = Math.min(width, height) * 0.035; // deckle margin

  const fillRect = (x, y, w, h, css, opacity, bleedStrength) => {
    brush.noStroke();
    brush.fill(css, opacity);
    brush.bleed(bleedStrength, "out");
    brush.fillTexture(0.8, 0.5);
    brush.beginShape(0.28);
    brush.vertex(x + (rng() - 0.5) * 12, y + (rng() - 0.5) * 12);
    brush.vertex(x + w + (rng() - 0.5) * 12, y + (rng() - 0.5) * 12);
    brush.vertex(x + w + (rng() - 0.5) * 12, y + h + (rng() - 0.5) * 12);
    brush.vertex(x + (rng() - 0.5) * 12, y + h + (rng() - 0.5) * 12);
    brush.endShape(CLOSE);
    brush.noFill();
  };

  if (style === "Wash Fade") {
    const bandY = height * (0.52 + rng() * 0.2);
    fillRect(m, bandY, width - m * 2, height - bandY - m, washA, 42, 0.42);
    fillRect(m, bandY - height * 0.1, width - m * 2, height * 0.12, washB, 26, 0.46);
  } else if (style === "Split Wash") {
    const seam = width * (0.3 + rng() * 0.25);
    fillRect(m, m, seam, height - m * 2, washA, 34, 0.4);
    fillRect(seam + width * 0.04, height * 0.2, width - seam - width * 0.04 - m, height * 0.8 - m, washB, 28, 0.44);
  } else if (style === "Halo Wash") {
    brush.noStroke();
    brush.fill(dilute(P.washes[1 % P.washes.length], 0.84), 30);
    brush.bleed(0.4, "out");
    brush.fillTexture(0.85, 0.55);
    brush.circle(ux(L.cx), uy(L.cy - 40), uu(290 + rng() * 50));
    brush.noFill();
  } else if (style === "Granulated Field") {
    brush.field("waves");
    for (let index = 0; index < 20; index += 1) {
      brush.set(rng() < 0.5 ? "marker" : "2B", dilute(P.washes[index % P.washes.length], 0.55 + rng() * 0.2), 1 + rng());
      brush.flowLine(m + rng() * (width - m * 2), m + rng() * (height - m * 2), uu(90 + rng() * 190), 0);
    }
    brush.noField();
  } else if (style === "Hatch Weave") {
    // Two woven hatch fields, no outlines — cloth showing through the paint.
    brush.noStroke();
    brush.setHatch("marker2", dilute(P.washes[0], 0.55), 1.4);
    brush.hatch(uu(19 + rng() * 5), Math.PI / 4, { rand: 0.15, continuous: false, gradient: 0.25 });
    brush.rect(m, height * 0.48, width - m * 2, height * 0.52 - m);
    brush.setHatch("marker2", dilute(P.washes[1 % P.washes.length], 0.6), 1.2);
    brush.hatch(uu(24 + rng() * 6), -Math.PI / 4, { rand: 0.2, continuous: false, gradient: false });
    brush.rect(m, height * 0.62, width - m * 2, height * 0.38 - m);
    brush.noHatch();
  } else if (style === "Deep Pool") {
    fillRect(m, m, width - m * 2, height - m * 2, mixHex(P.washes[0], P.deep, 0.4), 92, 0.3);
  } else {
    // Spatter Paper — the sheet nearly bare, flecked.
    bloom(rng, 500 + (rng() - 0.5) * 500, 300 + rng() * 500, 90 + rng() * 80, P.washes[0], 16);
  }

  // A water stain or two: every sheet has lived a little.
  const stains = 1 + Math.floor(rng() * 2);
  for (let index = 0; index < stains; index += 1) {
    bloom(rng, rng() * 1000, rng() * 1000, 36 + rng() * 46,
      P.washes[Math.floor(rng() * P.washes.length)], 10 + rng() * 6);
  }

  // Sparse spatter — paper is never perfectly clean.
  const flecks = style === "Spatter Paper" ? 22 : 8;
  brush.set("spray", dilute(P.ink, 0.4), 1);
  for (let index = 0; index < flecks; index += 1) {
    const x = rng() * width;
    const y = rng() * height;
    brush.line(x, y, x + (rng() - 0.5) * 14, y + (rng() - 0.5) * 14);
  }
}

// --------------------------------------------------------------------------
// Base washes — the face is glazes, not a filled outline: translucent layers
// that drift, escape the silhouette, and run.

function paintFaceWash(rng) {
  const cw = FACE.colorway;
  const deepPool = identity.background.style === "Deep Pool";
  // The head is a thrown splat scaled up: juicy pigment, not a pale glaze.
  const faceTint = (hex, t) => (deepPool ? dilute(hex, 0.72) : dilute(hex, t));

  if (FACE.variant === "Mirror Split") {
    const off = FACE.params.splitOffset;
    const left = faceContour({ dx: -off * 0.4, dy: -off * 0.5, spin: -3 });
    const right = faceContour({ dx: off * 0.4, dy: off * 0.5, spin: 3 });
    fillPolygon(left, faceTint(cw.from, 0.34), 96, 0.3, 0.75, 0.42);
    fillPolygon(right, faceTint(cw.kind === "washMix" ? cw.to : cw.from, 0.48), 74, 0.3, 0.78, 0.42);
  } else {
    const curvature = FACE.variant === "Shard" ? 0.08 : 0.48;
    // The main charge: one bold wet mass with a hard watercolor edge —
    // pigment pooling at the rim defines the head without any drawn outline.
    fillPolygon(faceContour({ amp: 4, rng }), faceTint(colorwayAt(cw, 0.1, rng), 0.42), 98, 0.3, 0.8, curvature, 0.78);
    // The glaze: a smaller pass of the far pigment, still wet, drifting.
    const glaze = faceContour({
      scale: 0.72,
      spin: (rng() - 0.5) * 10,
      dx: (rng() - 0.5) * 30,
      dy: (rng() - 0.5) * 26 + faceH * 0.06,
    });
    fillPolygon(glaze, faceTint(colorwayAt(cw, 0.9, rng), 0.5), 66, 0.34, 0.85, curvature, 0.6);
    if (FACE.variant === "Double Wash") {
      const echo = faceContour({ scale: 0.94, dx: FACE.params.echoOffset, dy: -FACE.params.echoOffset * 0.6 });
      fillPolygon(echo, faceTint(colorwayAt(cw, 0.5, rng), 0.58), 44, 0.32, 0.8, curvature);
    }
  }

  // Wet-in-wet variegation: other pigments blooming inside the still-damp
  // mass, plus a dried tide line just past the edge — the actual watermark.
  const veins = 2 + Math.floor(rng() * 2);
  for (let index = 0; index < veins; index += 1) {
    const angle = rng() * Math.PI * 2;
    bloom(rng,
      L.cx + Math.cos(angle) * faceW * 0.22,
      L.cy + Math.sin(angle) * faceH * 0.24,
      26 + rng() * 34,
      index === 0 ? P.accents[0] : P.washes[index % P.washes.length],
      18 + rng() * 8);
  }
  fillPolygon(faceContour({ scale: 1.14, dx: 4, dy: 6 }), dilute(cw.from, 0.88), 15, 0.5, 1, 0.5, 0.9);

  // Splat vocabulary around the silhouette: rim spray and thrown flicks.
  const contour = faceContour();
  const pigment = faceTint(cw.from, 0.2);
  brush.set("spray", pigment, 1.3);
  for (let index = 0; index < 6; index += 1) {
    const [x, y] = contour[Math.floor(rng() * contour.length)];
    brush.line(ux(x), uy(y), ux(x + (rng() - 0.5) * 26), uy(y + (rng() - 0.5) * 26));
  }
  brush.set("pen", faceTint(cw.from, 0.15), 1.1);
  for (let flick = 0; flick < 3; flick += 1) {
    const [x, y] = contour[Math.floor(rng() * contour.length)];
    const angle = Math.atan2(y - L.cy, x - L.cx) + (rng() - 0.5) * 0.5;
    brush.line(ux(x), uy(y),
      ux(x + Math.cos(angle) * (20 + rng() * 34)), uy(y + Math.sin(angle) * (20 + rng() * 34)));
  }
  // Satellite droplets — the splat's little companions.
  for (let drop = 0; drop < 3; drop += 1) {
    const angle = rng() * Math.PI * 2;
    const reach = 0.62 + rng() * 0.24;
    brush.noStroke();
    brush.fill(faceTint(colorwayAt(cw, rng(), rng), 0.3), 90);
    brush.bleed(0.36, "out");
    brush.fillTexture(0.7, 0.5);
    brush.circle(
      ux(L.cx + Math.cos(angle) * faceW * reach),
      uy(L.cy + Math.sin(angle) * faceH * reach),
      uu(5 + rng() * 9),
    );
    brush.noFill();
  }

  // Drips: gravity finishing the bottom edge.
  const drips = 1 + Math.floor(rng() * 3);
  for (let index = 0; index < drips; index += 1) {
    const x = L.cx + (rng() - 0.5) * faceW * 0.7;
    const y0 = L.cy + faceH * (0.3 + rng() * 0.12);
    const len = 40 + rng() * 90;
    brush.set("marker", faceTint(cw.from, 0.3), 1.8);
    brush.line(ux(x), uy(y0), ux(x + (rng() - 0.5) * 8), uy(y0 + len));
    brush.circle(ux(x + (rng() - 0.5) * 6), uy(y0 + len + 4), uu(3.2), true);
  }
}

/** The face's stable structure — the cheek shadow and the eye sockets.
 * Painted with the SAME stream in both morph variants, so the region around
 * the features never moves: the mass lives, the face holds still. */
function paintFaceStructure(rng) {
  const cw = FACE.colorway;
  const deepPool = identity.background.style === "Deep Pool";
  const faceTint = (hex, t) => (deepPool ? dilute(hex, 0.72) : dilute(hex, t));

  // One cheek plane drops back into shadow…
  const shadeSide = FACE.params.tilt >= 0 ? 1 : -1;
  brush.noStroke();
  brush.fill(faceTint(P.washes[1 % P.washes.length], 0.5), 34);
  brush.bleed(0.4, "in");
  brush.fillTexture(0.8, 0.35);
  brush.circle(ux(L.cx + shadeSide * faceW * 0.26), uy(L.cy + faceH * 0.16), uu(faceW * 0.2));
  brush.noFill();
  // …and two sockets lift out of the pigment where the eyes will live —
  // thin lifted wells, tinted so they stay part of the wash instead of
  // reading as cutouts.
  for (const eye of [eyeL, eyeR]) {
    brush.noStroke();
    brush.fill(dilute(cw.from, 0.86), 92);
    brush.bleed(0.32, "in");
    brush.fillTexture(0.7, 0.3);
    brush.circle(ux(eye.x), uy(eye.y + 1), uu(eye.r * 1.45));
    brush.noFill();
  }
}

/** Curtain hair hangs BEHIND the head: painted before the face mass so the
 * strands fall from under the wash instead of lying on top of it. */
function paintCurtainBehind(rng) {
  const hair = trait("Hair");
  if (hair?.variant !== "Curtain") return;
  const count = hair.params.strokes;
  const topY = L.cy - faceH * 0.46;
  for (let strand = 0; strand < count; strand += 1) {
    const t = count === 1 ? 0.5 : strand / (count - 1);
    const css = colorwayAt(hair.colorway, t, rng);
    const side = t < 0.5 ? -1 : 1;
    const rootX = L.cx + side * faceW * (0.3 + Math.abs(t - 0.5) * 0.55);
    const rootY = topY + 4;
    const tipY = rootY + faceH * (0.72 + hair.params.length * 0.35) * (0.85 + rng() * 0.3);
    const drift = side * (10 + rng() * 10);
    inkSpline([
      [rootX, rootY],
      [rootX + drift * 0.5 + (rng() - 0.5) * 6, rootY + (tipY - rootY) * 0.55],
      [rootX + drift, tipY],
    ], strand % 3 === 0 ? "2B" : "marker", css, 2.3, 0.6);
    if (strand % 4 === 1) {
      brush.noStroke();
      brush.fill(css, 110);
      brush.bleed(0.3, "out");
      brush.fillTexture(0.6, 0.5);
      brush.circle(ux(rootX + drift), uy(tipY + 3), uu(3.4 + rng() * 2));
      brush.noFill();
    }
  }
}

function paintWashTraits(rng) {
  const hair = trait("Hair");
  if (hair?.variant === "Wash Cap") {
    // A cap of pigment hugging the scalp — a crescent, not a cloud.
    const capY = L.cy - faceH * 0.36;
    const points = [];
    for (let index = 0; index <= 9; index += 1) {
      const angle = Math.PI + (index / 9) * Math.PI;
      points.push([
        L.cx + Math.cos(angle) * faceW * 0.5 * (1 + (rng() - 0.5) * 0.14),
        capY + Math.sin(angle) * faceH * (Math.sin(angle) < 0 ? 0.26 : 0.1) * (1 + (rng() - 0.5) * 0.14),
      ]);
    }
    fillPolygon(points, dilute(hair.colorway.from, 0.14), 112, 0.22, 0.75, 0.5);
  }

  const headwear = trait("Headwear");
  if (headwear?.variant === "Wide Brim") {
    const y = L.cy - faceH * 0.48 - headwear.params.lift;
    const w = faceW * (1.1 + headwear.params.width * 0.6);
    fillPolygon([
      [L.cx - w / 2, y], [L.cx + w / 2, y - 6],
      [L.cx + w / 2, y + 26], [L.cx - w / 2, y + 32],
    ], dilute(headwear.colorway.from, 0.48), 58, 0.36, 0.7, 0.2);
  }
  if (headwear?.variant === "Halo") {
    brush.noStroke();
    brush.fill(dilute(headwear.colorway.to, 0.55), 40);
    brush.bleed(0.44, "out");
    brush.fillTexture(0.85, 0.55);
    brush.circle(ux(L.cx), uy(L.cy - faceH * 0.62 - headwear.params.lift), uu(faceW * 0.34));
    brush.noFill();
  }
  if (headwear?.variant === "Paper Crown") {
    const y = L.cy - faceH * 0.4 - headwear.params.lift;
    const w = faceW * headwear.params.width;
    const points = [[L.cx - w / 2, y]];
    for (let index = 0; index < headwear.params.points; index += 1) {
      const t0 = (index + 0.5) / headwear.params.points;
      const t1 = (index + 1) / headwear.params.points;
      points.push([L.cx - w / 2 + w * t0, y - 34 - rng() * 14]);
      points.push([L.cx - w / 2 + w * t1, y]);
    }
    fillPolygon(points, dilute(headwear.colorway.from, 0.6), 40, 0.3, 0.6, 0.06);
  }

  const blush = trait("Blush");
  if (blush) {
    const size = blush.params.size * (blush.variant === "Feverish" ? 1.35 : 1);
    const opacity = blush.variant === "Feverish" ? 52 : 34;
    const sides = blush.variant === "Lopsided" || blush.params.side !== "both"
      ? [blush.params.side === "both" ? "left" : blush.params.side]
      : ["left", "right"];
    for (const side of sides) {
      const eye = side === "left" ? eyeL : eyeR;
      brush.noStroke();
      brush.fill(dilute(colorwayAt(blush.colorway, side === "left" ? 0 : 1, rng), 0.4), opacity);
      brush.bleed(0.42, "in");
      brush.fillTexture(0.8, 0.35);
      brush.circle(ux(eye.x + (side === "left" ? -6 : 6)), uy(eye.y + faceH * 0.14), uu(size));
      brush.noFill();
    }
  }

  const collar = trait("Collar");
  if (collar && collar.variant !== "Stitch Collar") {
    const top = L.cy + faceH * (collar.variant === "High Wrap" ? 0.34 : 0.46) - collar.params.lift;
    for (let row = 0; row < collar.params.rows; row += 1) {
      const y = top + row * 30;
      const w = faceW * (0.9 + row * 0.22);
      fillPolygon([
        [L.cx - w / 2, y + 14], [L.cx, y - 10 - rng() * 8], [L.cx + w / 2, y + 16],
        [L.cx + w / 2 * 1.12, y + 90], [L.cx - w / 2 * 1.12, y + 92],
      ], dilute(colorwayAt(collar.colorway, row / 2, rng), 0.52), 44, 0.38, 0.75, 0.35);
    }
  }

  if (EYES.variant === "Wide Wells") {
    for (const eye of [eyeL, eyeR]) {
      brush.noStroke();
      brush.fill(mixHex(P.ink, P.deep, 0.5), 110);
      brush.bleed(0.26, "out");
      brush.fillTexture(0.6, 0.45);
      brush.circle(ux(eye.x), uy(eye.y), uu(eye.r * 1.25));
      brush.noFill();
    }
  }
  if (EYES.variant === "Shadow Pools") {
    // Pigment pooling deeper where the eyes sit — no outline at all; the
    // live pupil floats in the pool.
    for (const eye of [eyeL, eyeR]) {
      brush.noStroke();
      brush.fill(dilute(mixHex(P.washes[0], P.ink, 0.55), 0.3), 74);
      brush.bleed(0.36, "in");
      brush.fillTexture(0.8, 0.4);
      brush.circle(ux(eye.x), uy(eye.y + 2), uu(eye.r * 1.1));
      brush.noFill();
    }
  }

  if (MOUTH.variant === "Bloom Blot") {
    brush.noStroke();
    brush.fill(dilute(colorwayAt(MOUTH.colorway, 0.5, rng), 0.3), 84);
    brush.bleed(0.44, "out");
    brush.fillTexture(0.8, 0.55);
    brush.circle(ux(mouthX), uy(mouthY), uu(mouthW * 0.42));
    brush.noFill();
  }

  const nose = trait("Nose");
  if (nose?.variant === "Wash Triangle") {
    const y = eyeY + faceH * 0.1;
    fillPolygon([
      [L.cx, y], [L.cx - 12, y + nose.params.length], [L.cx + 14, y + nose.params.length + 3],
    ], dilute(colorwayAt(nose.colorway, 0.5, rng), 0.5), 42, 0.36, 0.7, 0.2);
  }

  // Dry-brush grain along the jaw: the imperfection that sells the medium.
  brush.set("charcoal", dilute(P.washes[0], 0.5), 1);
  const contour = faceContour();
  for (let index = 0; index < 3; index += 1) {
    const [x, y] = contour[Math.floor(rng() * contour.length)];
    brush.line(ux(x - 8 + rng() * 6), uy(y + rng() * 6), ux(x + 10 + rng() * 8), uy(y + 8 + rng() * 6));
  }

  paintTechnique(rng);
}

/** The Technique trait — named watercolor techniques baked into the wash. */
function paintTechnique(rng) {
  const tech = trait("Technique");
  if (!tech) return;
  const contour = faceContour();

  if (tech.variant === "Salt") {
    // Salt thrown on wet paint pulls pigment away in pale little stars.
    for (let grain = 0; grain < tech.params.count; grain += 1) {
      const angle = rng() * Math.PI * 2;
      const reach = rng() * tech.params.scatter;
      const gx = L.cx + Math.cos(angle) * faceW * 0.5 * reach;
      const gy = L.cy + Math.sin(angle) * faceH * 0.5 * reach;
      const size = 3 + rng() * 5;
      const points = [];
      for (let v = 0; v < 7; v += 1) {
        const a = (v / 7) * Math.PI * 2;
        points.push([gx + Math.cos(a) * size * (0.4 + rng()), gy + Math.sin(a) * size * (0.4 + rng())]);
      }
      fillPolygon(points, P.paper, 110, 0.16, 0.6, 0.3);
    }
  } else if (tech.variant === "Dry Brush") {
    // A starved brush dragged over the tooth of the sheet.
    for (let stroke = 0; stroke < 6; stroke += 1) {
      const [x, y] = contour[Math.floor(rng() * contour.length)];
      const angle = Math.atan2(y - L.cy, x - L.cx) + Math.PI / 2 + (rng() - 0.5) * 0.5;
      const len = 30 + rng() * 44;
      brush.set("charcoal", dilute(colorwayAt(tech.colorway, rng(), rng), 0.4), 1.7);
      brush.line(
        ux(x - Math.cos(angle) * len * 0.5), uy(y - Math.sin(angle) * len * 0.5),
        ux(x + Math.cos(angle) * len * 0.5), uy(y + Math.sin(angle) * len * 0.5),
      );
    }
  } else if (tech.variant === "Backruns") {
    // Water crept back into a drying wash: cauliflower blooms.
    for (let run = 0; run < 3; run += 1) {
      const angle = rng() * Math.PI * 2;
      bloom(rng,
        L.cx + Math.cos(angle) * faceW * (0.25 + rng() * 0.3),
        L.cy + Math.sin(angle) * faceH * (0.25 + rng() * 0.3),
        40 + rng() * 40, colorwayAt(tech.colorway, rng(), rng), 20 + rng() * 8);
    }
  } else if (tech.variant === "Splatter") {
    // The loaded brush was flicked over the finished head.
    for (let drop = 0; drop < tech.params.count; drop += 1) {
      const angle = rng() * Math.PI * 2;
      const reach = 0.4 + rng() * 0.65;
      const gx = L.cx + Math.cos(angle) * faceW * 0.62 * reach;
      const gy = L.cy + Math.sin(angle) * faceH * 0.6 * reach;
      const css = dilute(colorwayAt(tech.colorway, drop / tech.params.count, rng), 0.25);
      brush.noStroke();
      brush.fill(css, 100);
      brush.bleed(0.3, "out");
      brush.fillTexture(0.65, 0.5);
      brush.circle(ux(gx), uy(gy), uu(2.4 + rng() * 3.6));
      brush.noFill();
      if (drop % 4 === 0) {
        brush.set("pen", css, 1);
        brush.line(ux(gx), uy(gy), ux(gx + (rng() - 0.5) * 26), uy(gy + (rng() - 0.5) * 26));
      }
    }
  }
}

// --------------------------------------------------------------------------
// Ink line work — gestural fragments, never a closed outline. Painted three
// times with fresh wobble; the frames cycle to make the boil.

const inkColor = () => (identity.background.style === "Deep Pool" ? mixHex(P.ink, "#111111", 0.2) : P.ink);

function paintEyesInk(rng, k, closedEyes = false) {
  const ink = inkColor();
  const eyes = [
    { ...eyeL, side: 0 },
    { ...eyeR, side: 1 },
  ];
  for (const eye of eyes) {
    const x = eye.x + (rng() - 0.5) * 1.4;
    const y = eye.y + (rng() - 0.5) * 1.4;
    // Mismatch pairs two different OPEN marks — one closed plus one open
    // reads as a stuck wink and always looks wrong.
    const variant = EYES.variant === "Mismatch" ? (eye.side === 0 ? "Wet Dabs" : "Dot Pair") : EYES.variant;

    if (closedEyes && variant !== "Sleepy Lines") {
      // Closed lid, same hand, same wet marker: a soft downward arc where
      // the eye was, with a couple of resting lashes.
      brush.set("marker", ink, 2.4);
      brush.arc(ux(x), uy(y - eye.r * 0.15), uu(eye.r * 0.95), Math.PI * 0.12, Math.PI * 0.88);
      brush.set("2H", dilute(ink, 0.35), 1.2);
      for (let lash = 0; lash < 2; lash += 1) {
        const lx = x - eye.r * 0.4 + lash * eye.r * 0.8;
        brush.line(ux(lx), uy(y + eye.r * 0.42), ux(lx + 3), uy(y + eye.r * 0.42 + 6));
      }
      continue;
    }

    if (variant === "Wet Dabs") {
      // A thumbed dab of pigment: the eye was PRESSED into the sheet.
      brush.noStroke();
      brush.fill(P.deep, 170);
      brush.bleed(0.26, "out");
      brush.fillTexture(0.65, 0.5);
      brush.beginShape(0.5);
      brush.vertex(ux(x - eye.r * 0.85), uy(y + 2));
      brush.vertex(ux(x - eye.r * 0.2), uy(y - eye.r * 0.38));
      brush.vertex(ux(x + eye.r * 0.5), uy(y - eye.r * 0.32));
      brush.vertex(ux(x + eye.r * 0.85), uy(y + 3));
      brush.vertex(ux(x), uy(y + eye.r * 0.34));
      brush.endShape(CLOSE);
      brush.noFill();
    } else if (variant === "Wide Wells" || variant === "Shadow Pools") {
      // The wells and pools live entirely in the base wash and the live
      // pupil — nothing drawn here.
    } else if (variant === "Dot Pair") {
      // A plain charged blot in the DARKEST pigment. No ring, no glint —
      // anything shiny turns it into a cartoon eye and breaks the wash.
      brush.noStroke();
      brush.fill(P.deep, 200);
      brush.bleed(0.22, "out");
      brush.fillTexture(0.6, 0.5);
      brush.circle(ux(x), uy(y), uu(eye.r * 0.46));
      brush.noFill();
      brush.set("spray", ink, 1);
      brush.line(ux(x), uy(y), ux(x + (rng() - 0.5) * 10), uy(y + (rng() - 0.5) * 10));
    } else if (variant === "Sleepy Lines") {
      brush.set("marker", ink, 2.6);
      brush.line(ux(x - eye.r * 1.15), uy(y + (eye.tilt / 9) * 3), ux(x + eye.r * 1.15), uy(y - (eye.tilt / 9) * 3));
      brush.set("2B", ink, 1.6);
      brush.line(ux(x - eye.r), uy(y + 1), ux(x + eye.r), uy(y));
      brush.set("2H", dilute(ink, 0.4), 1.4);
      brush.line(ux(x - eye.r * 0.6), uy(y + 6), ux(x + eye.r * 0.6), uy(y + 5));
    } else if (variant === "Halfmoon") {
      brush.set("2B", ink, 2.4);
      brush.arc(ux(x), uy(y - 2), uu(eye.r * 1.1), Math.PI * 0.08, Math.PI * 0.92);
    } else if (variant === "Ripples") {
      // A drop just landed: a dark center and still rings spreading out.
      brush.noStroke();
      brush.fill(P.deep, 190);
      brush.bleed(0.2, "out");
      brush.fillTexture(0.55, 0.4);
      brush.circle(ux(x), uy(y), uu(eye.r * 0.28));
      brush.noFill();
      brush.set("2B", ink, 1.7);
      brush.circle(ux(x), uy(y), uu(eye.r * 0.62), true);
      brush.set("2H", dilute(ink, 0.45), 1.3);
      brush.circle(ux(x + 1), uy(y + 1), uu(eye.r * 0.95), true);
    }

    if (EYES.params.lashes && variant === "Halfmoon") {
      brush.set("2H", ink, 1.4);
      for (let lash = 0; lash < 3; lash += 1) {
        const angle = -Math.PI / 2 + (lash - 1) * 0.35 + (rng() - 0.5) * 0.1;
        const sx = x + Math.cos(angle) * eye.r;
        const sy = y + Math.sin(angle) * eye.r;
        brush.line(ux(sx), uy(sy), ux(sx + Math.cos(angle) * 6), uy(sy + Math.sin(angle) * 6));
      }
    }
  }
}

function paintMouthInk(rng) {
  const ink = colorwayAt(MOUTH.colorway, rng(), rng);
  const y = mouthY + (rng() - 0.5) * 1.4;
  const half = mouthW / 2;
  const curve = MOUTH.params.curve;
  const lip = (t) => y - Math.sin(t * Math.PI) * curve * 14;

  if (MOUTH.variant === "Open O") {
    brush.set("2B", ink, 2.2);
    brush.circle(ux(mouthX), uy(y), uu(half * 0.55), true);
    return;
  }
  const points = [];
  const steps = MOUTH.variant === "Wave" ? 7 : 4;
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    let py = lip(t);
    if (MOUTH.variant === "Wave") py += Math.sin(t * Math.PI * 3) * 4;
    if (MOUTH.variant === "Smirk") py -= t * 9;
    points.push([mouthX - half + mouthW * t + (rng() - 0.5) * 1.4, py + (rng() - 0.5) * 1.4]);
  }
  // A wet marker line carries the mouth; a pencil pass gives it grain.
  inkSpline(points, "marker", ink, 3.2, 0.55);
  inkSpline(points.map(([px, py]) => [px + 1, py - 1]), "2B", ink, 1.4, 0.55);

  // A charged corner: the brush rested there a beat too long.
  if (rng() < 0.5) {
    const cornerX = rng() < 0.5 ? mouthX - half : mouthX + half;
    brush.noStroke();
    brush.fill(ink, 120);
    brush.bleed(0.3, "out");
    brush.fillTexture(0.6, 0.5);
    brush.circle(ux(cornerX), uy(lip(cornerX > mouthX ? 1 : 0) + 1), uu(3.4));
    brush.noFill();
  }

  if (MOUTH.variant === "Tide") {
    inkSpline(points.map(([px, py]) => [px + 2, py + 6]), "2H", dilute(ink, 0.4), 1.4, 0.55);
  }
  if (MOUTH.variant === "Stitch") {
    brush.set("pen", ink, 1.5);
    for (let stitch = 1; stitch < 4; stitch += 1) {
      const t = stitch / 4;
      const px = mouthX - half + mouthW * t;
      brush.line(ux(px), uy(lip(t) - 5), ux(px + (rng() - 0.5) * 2), uy(lip(t) + 5));
    }
  }
  if (MOUTH.variant === "Hum") {
    brush.set("marker", ink, 1.8);
    brush.circle(ux(mouthX + half + 8), uy(y - 2), uu(2.8), true);
  }
  if (MOUTH.variant === "Bloom Blot") {
    inkSpline([[mouthX - half * 0.5, y], [mouthX, y + 2], [mouthX + half * 0.5, y - 1]], "pen", ink, 1.4, 0.5);
  }
}

function paintOptionalInk(rng, k) {
  const ink = inkColor();

  const brows = trait("Brows");
  if (brows) {
    for (const side of [-1, 1]) {
      const eye = side < 0 ? eyeL : eyeR;
      let lift = brows.params.lift;
      let tilt = 0;
      if (brows.variant === "Worried") tilt = side * 0.28;
      if (brows.variant === "Quizzical" && side > 0) lift += 9;
      if (brows.variant === "Serene") tilt = -side * 0.08;
      const w = eye.r * 1.5 * brows.params.spread;
      const y = eye.y - eye.r - 12 - lift;
      const weight = brows.variant === "Heavy" ? 3.2 : 2;
      brush.set(brows.variant === "Heavy" ? "marker" : "2B", ink, weight);
      brush.line(
        ux(eye.x - w / 2 + (rng() - 0.5) * 2), uy(y + tilt * w + (rng() - 0.5) * 2),
        ux(eye.x + w / 2), uy(y - tilt * w),
      );
    }
  }

  const nose = trait("Nose");
  if (nose && nose.variant !== "Wash Triangle") {
    const cw = colorwayAt(nose.colorway, rng(), rng);
    const y0 = eyeY + faceH * 0.06;
    const len = nose.params.length;
    if (nose.variant === "Dot") {
      brush.set("marker", cw, 1.3);
      brush.circle(ux(L.cx + nose.params.bend * 8), uy(y0 + len * 0.6), uu(2.6), true);
    } else {
      const hook = nose.variant === "Hook Line" ? 12 : 4;
      inkSpline([
        [L.cx + (rng() - 0.5) * 2, y0],
        [L.cx + nose.params.bend * 10, y0 + len * 0.6],
        [L.cx + nose.params.bend * 14, y0 + len],
        [L.cx + nose.params.bend * 14 + hook, y0 + len + 2],
      ], "2B", cw, 1.1, 0.5);
    }
  }

  const freckles = trait("Freckles");
  if (freckles) {
    const spread = freckles.params.spread;
    const dots = [];
    const freckleRng = makeStream(SEED, "freckles"); // placement is identity-stable
    for (let index = 0; index < freckles.params.count; index += 1) {
      const side = index % 2 === 0 ? -1 : 1;
      const eye = side < 0 ? eyeL : eyeR;
      dots.push([
        eye.x + (freckleRng() - 0.5) * faceW * 0.24 * spread,
        eye.y + faceH * 0.12 + freckleRng() * faceH * 0.1 * spread,
      ]);
    }
    for (const [index, [x, y]] of dots.entries()) {
      const css = colorwayAt(freckles.colorway, index / Math.max(1, dots.length - 1), rng);
      brush.set("cpencil", css, 1);
      brush.circle(ux(x + (rng() - 0.5) * 1.6), uy(y + (rng() - 0.5) * 1.6), uu(1.1 + rng() * 1.2), true);
    }
    if (freckles.params.linked) {
      brush.set("2H", dilute(ink, 0.55), 0.8);
      for (let index = 0; index + 1 < Math.min(dots.length, 6); index += 1) {
        brush.line(ux(dots[index][0]), uy(dots[index][1]), ux(dots[index + 1][0]), uy(dots[index + 1][1]));
      }
    }
  }

  const hair = trait("Hair");
  if (hair) paintHairInk(rng, k, hair);

  const ears = trait("Ears");
  if (ears) {
    for (const side of [-1, 1]) {
      const x = L.cx + side * faceW * 0.52;
      const y = eyeY + 6;
      brush.set("2B", colorwayAt(ears.colorway, side < 0 ? 0 : 1, rng), 1.2);
      brush.arc(ux(x), uy(y), uu(ears.params.size), side < 0 ? Math.PI * 0.6 : -Math.PI * 0.4, side < 0 ? Math.PI * 1.4 : Math.PI * 0.4);
      if (ears.variant !== "Arcs") {
        // Dangles swing on the boil: each frame hangs at a different angle.
        const swing = Math.sin((k / 3) * Math.PI * 2) * 4;
        const dx = x + swing * 0.4;
        const dy = y + ears.params.size * 0.55 + ears.params.dangle;
        if (ears.variant === "Rings") {
          brush.circle(ux(dx + swing), uy(dy), uu(4.5), true);
        } else {
          inkSpline([[x, y + ears.params.size * 0.5], [dx + swing, dy]], "pen", ink, 1, 0.3);
          brush.set("marker", colorwayAt(ears.colorway, 0.5, rng), 1.3);
          brush.circle(ux(dx + swing), uy(dy + 3), uu(2.6), true);
        }
      }
    }
  }

  const marks = trait("Marks");
  if (marks) {
    const side = marks.params.side === "left" ? -1 : 1;
    const cw = colorwayAt(marks.colorway, rng(), rng);
    if (marks.variant === "Third Line") {
      inkSpline([
        [L.cx + (rng() - 0.5) * 2, L.cy - faceH * 0.34],
        [L.cx + (rng() - 0.5) * 3, L.cy - faceH * 0.34 + marks.params.length],
      ], "pen", cw, 1.1, 0.2);
    } else if (marks.variant === "Underline") {
      const eye = side < 0 ? eyeL : eyeR;
      brush.set("2B", cw, 1);
      brush.line(ux(eye.x - marks.params.length / 2), uy(eye.y + eye.r + 8), ux(eye.x + marks.params.length / 2), uy(eye.y + eye.r + 9));
    } else if (marks.variant === "Hatch Patch") {
      brush.setHatch("hatch_brush", cw, 0.9);
      brush.hatch(uu(4), Math.PI / 3 + side * 0.3, { rand: 0.12, continuous: false, gradient: false });
      const eye = side < 0 ? eyeL : eyeR;
      brush.rect(ux(eye.x + side * 26 - 11), uy(eye.y + faceH * 0.13), uu(22), uu(16));
      brush.noHatch();
    } else if (marks.variant === "Tear") {
      // The tear crawls: each boil frame hangs it a little lower.
      const eye = side < 0 ? eyeL : eyeR;
      const drop = eye.r + 10 + k * 7;
      brush.set("marker", cw, 1.2);
      brush.circle(ux(eye.x + side * 4), uy(eye.y + drop), uu(2.8), true);
      brush.set("2H", dilute(cw, 0.4), 0.8);
      brush.line(ux(eye.x + side * 4), uy(eye.y + eye.r + 4), ux(eye.x + side * 4), uy(eye.y + drop - 3));
    }
  }

  const headwear = trait("Headwear");
  if (headwear && headwear.variant !== "Halo") {
    const y = L.cy - faceH * (headwear.variant === "Wide Brim" ? 0.48 : 0.4) - headwear.params.lift;
    const cw = colorwayAt(headwear.colorway, rng(), rng);
    if (headwear.variant === "Wide Brim") {
      const w = faceW * (1.1 + headwear.params.width * 0.6);
      inkSpline([[L.cx - w / 2, y + 4], [L.cx, y - 2], [L.cx + w / 2, y + 2]], "2B", cw, 1.3, 0.4);
    } else if (headwear.variant === "Pin Feather") {
      const x0 = L.cx + faceW * 0.2;
      inkSpline([[x0, y], [x0 + 26, y - 42], [x0 + 34, y - 78]], "2B", cw, 1.1, 0.55);
      brush.set("2H", cw, 0.8);
      for (let barb = 1; barb < 6; barb += 1) {
        const t = barb / 6;
        brush.line(ux(x0 + 30 * t), uy(y - 78 * t), ux(x0 + 30 * t - 10), uy(y - 78 * t + 6));
      }
    } else if (headwear.variant === "Paper Crown") {
      const w = faceW * headwear.params.width;
      const points = [[L.cx - w / 2, y]];
      for (let index = 0; index < headwear.params.points; index += 1) {
        points.push([L.cx - w / 2 + w * ((index + 0.5) / headwear.params.points), y - 34]);
        points.push([L.cx - w / 2 + w * ((index + 1) / headwear.params.points), y]);
      }
      brush.set("pen", cw, 1.1);
      strokePolygon(points.map(([x, py]) => [x + (rng() - 0.5) * 2, py + (rng() - 0.5) * 2]), 0.08, false);
    }
  }

  const collar = trait("Collar");
  if (collar?.variant === "Stitch Collar") {
    const y = L.cy + faceH * 0.46 - collar.params.lift;
    brush.set("pen", colorwayAt(collar.colorway, 0.5, rng), 1);
    for (let stitch = 0; stitch < 8; stitch += 1) {
      const t = stitch / 7;
      const x = L.cx - faceW * 0.45 + faceW * 0.9 * t;
      brush.line(ux(x), uy(y + Math.sin(t * Math.PI) * -10), ux(x + 8), uy(y + Math.sin(t * Math.PI) * -10 + 6));
    }
  }

  // Signature: a tiny scribble, different in every token, same hand. It
  // hugs the visible bottom-right corner, so zoomed-in crops keep it.
  const sigRng = makeStream(SEED, `signature:${k}`);
  const sx = Math.min(905, (width - OX) / U - 95);
  const sy = Math.min(952, (height - OY) / U - 48);
  inkSpline([
    [sx, sy], [sx + 10 + sigRng() * 8, sy - 6 - sigRng() * 5],
    [sx + 22, sy + 2], [sx + 34 + sigRng() * 8, sy - 4],
  ], "2H", dilute(ink, 0.35), 0.8, 0.7);
}

function paintHairInk(rng, k, hair) {
  if (hair.variant === "Curtain") return; // painted behind the face instead
  const count = hair.params.strokes;
  const sway = hair.params.sway;
  const phaseAngle = (k / 3) * Math.PI * 2;
  const topY = L.cy - faceH * 0.46;

  if (hair.variant === "Wash Cap") {
    // Rim accent hugging the cap itself.
    brush.set("2B", colorwayAt(hair.colorway, 0.2, rng), 2);
    brush.arc(ux(L.cx), uy(L.cy - faceH * 0.3), uu(faceW * 0.48), Math.PI * 1.08, Math.PI * 1.92);
    return;
  }
  if (hair.variant === "Topknot") {
    const cw = colorwayAt(hair.colorway, 0.4, rng);
    // A charged little blot of a bun.
    brush.noStroke();
    brush.fill(cw, 130);
    brush.bleed(0.32, "out");
    brush.fillTexture(0.65, 0.5);
    brush.circle(ux(L.cx + Math.sin(phaseAngle) * 1.5), uy(topY - 30), uu(19));
    brush.noFill();
    inkSpline([[L.cx - 14, topY - 12], [L.cx + 12, topY - 16]], "2B", cw, 2, 0.4);
    return;
  }

  for (let strand = 0; strand < count; strand += 1) {
    const t = count === 1 ? 0.5 : strand / (count - 1);
    const css = colorwayAt(hair.colorway, t, rng);
    const wobble = Math.sin(phaseAngle + strand * 1.7) * 3 * sway;
    let rootX;
    let rootY;
    let tip;
    if (hair.variant === "Curtain") {
      const side = t < 0.5 ? -1 : 1;
      rootX = L.cx + side * faceW * (0.3 + Math.abs(t - 0.5) * 0.5);
      rootY = topY + 8;
      tip = [rootX + side * (14 + rng() * 8) + wobble, rootY + faceH * (0.5 + hair.params.length * 0.3)];
    } else if (hair.variant === "Twin Tufts") {
      const side = t < 0.5 ? -1 : 1;
      rootX = L.cx + side * faceW * 0.3;
      rootY = topY - 4;
      tip = [rootX + side * 18 + wobble, rootY - 36 - rng() * 14];
    } else {
      // Flow Mane and Ink Scribble rise from the scalp arc.
      const angle = Math.PI * (1.12 + t * 0.76);
      rootX = L.cx + Math.cos(angle) * faceW * 0.46;
      rootY = topY + 20 + Math.sin(angle) * faceH * 0.3;
      const reach = faceH * (0.28 + hair.params.length * 0.34) * (0.7 + rng() * 0.5);
      tip = [rootX + Math.cos(angle) * reach * 0.8 + wobble * 2, rootY + Math.sin(angle) * reach - reach * 0.24];
    }
    const mid = [
      rootX + (tip[0] - rootX) * 0.5 + wobble + (rng() - 0.5) * 5,
      rootY + (tip[1] - rootY) * 0.5 + (rng() - 0.5) * 5,
    ];
    // Wet strands: markers carry pigment, pencils give a few strands grain.
    const scribble = hair.variant === "Ink Scribble";
    const brushName = scribble ? "pen" : strand % 3 === 0 ? "2B" : "marker";
    inkSpline([[rootX, rootY], mid, tip], brushName, css, scribble ? 1.5 : 2.3, 0.6);
    if (scribble && strand % 2 === 0) {
      inkSpline([tip, [tip[0] - 10 + rng() * 20, tip[1] - 8], [tip[0] + (rng() - 0.5) * 24, tip[1] + 6]],
        "pen", css, 1.3, 0.8);
    }
    // Root droplets — the splat vocabulary carried into the hairline.
    if (!scribble && strand % 4 === 1) {
      brush.noStroke();
      brush.fill(css, 110);
      brush.bleed(0.3, "out");
      brush.fillTexture(0.6, 0.5);
      brush.circle(ux(rootX), uy(rootY), uu(3.6 + rng() * 2.4));
      brush.noFill();
    }
  }
}

// --------------------------------------------------------------------------
// Live fx — pupils, major animations, hover trail, swipe gusts. Painted over
// the frame every draw; re-seeded per tick so strokes hold still.

const pointer = { x: 500, y: 470, trail: [] };
let gust = null;
const splats = [];

/** Still drying: a faint pencil-thin tide edge slowly migrates around the
 * blot on a long cycle — the painting never quite finishes. */
function paintTideLine(now) {
  const scale = 1.12 + 0.035 * Math.sin((now * Math.PI * 2) / 34);
  const points = faceContour({ scale });
  points.push(points[0]);
  inkSpline(points, "2H", dilute(P.washes[0], 0.86), 1.3, 0.5);
}

/** The paper remembers: linger and a damp mark blooms under the pointer,
 * then dries away. Taps stay forever; lingering is temporary. */
function paintDampMarks(now) {
  if (dwellSince !== Infinity && now - dwellSince > 0.8 && now > dampNext) {
    damp.push({ x: pointer.x, y: pointer.y, id: dampId, born: now });
    dampId += 1;
    if (damp.length > 2) damp.shift();
    dampNext = now + 2.5;
    dwellSince = now;
  }
  for (let index = damp.length - 1; index >= 0; index -= 1) {
    const mark = damp[index];
    const age = now - mark.born;
    if (age > 9) {
      damp.splice(index, 1);
      continue;
    }
    const envelope = age < 1 ? age : Math.max(0, 1 - (age - 1) / 8);
    const markRng = makeStream(SEED, `damp:${mark.id}`);
    bloom(markRng, mark.x, mark.y, 15 + age * 2.2, P.washes[0], 24 * envelope);
  }
}

function paintPupils(rng) {
  const variant = EYES.variant;
  // Only the two wet-pool styles carry a floating pupil; everything else is
  // finished pigment with nothing drawn on top.
  if (variant !== "Wide Wells" && variant !== "Shadow Pools") return;
  for (const eye of [eyeL, eyeR]) {
    const dx = gaze.x - eye.x;
    const dy = gaze.y - eye.y;
    const distance = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, distance / 300) * eye.r * 0.3;
    const px = eye.x + (dx / distance) * reach;
    const py = eye.y + (dy / distance) * reach;
    // Pupils are wet drops of pigment, not drawn rings.
    brush.noStroke();
    if (variant === "Wide Wells") {
      brush.fill(P.paper, 180);
      brush.bleed(0.2, "out");
      brush.fillTexture(0.5, 0.4);
      brush.circle(ux(px), uy(py), uu(eye.r * 0.2));
    } else {
      // A small quiet drop of the darkest pigment — no glint, no gloss.
      brush.fill(P.deep, 200);
      brush.bleed(0.2, "out");
      brush.fillTexture(0.5, 0.4);
      brush.circle(ux(px), uy(py), uu(eye.r * 0.17));
    }
    brush.noFill();
  }
}

function paintMajors(rng, t) {
  const aura = trait("Aura");
  if (aura) {
    const orbit = faceW * 0.62 * aura.params.orbit;
    for (let index = 0; index < aura.params.count; index += 1) {
      const share = index / aura.params.count;
      const css = colorwayAt(aura.colorway, share, rng);
      if (aura.variant === "Falling Petals") {
        // The span reaches past both edges so a petal leaves the sheet
        // completely before it wraps — the loop never jumps in view.
        const span = 1300;
        const fall = ((t * 40 * aura.params.pace + share * span) % span) - 260;
        const x = L.cx + Math.sin(share * 31 + t * 0.8) * faceW * 0.85 + Math.sin(t + index) * 8;
        // A petal is a droplet of wash, drifting down.
        brush.noStroke();
        brush.fill(css, 90);
        brush.bleed(0.3, "out");
        brush.fillTexture(0.65, 0.5);
        brush.circle(ux(x), uy(123 + fall), uu(3.4 + Math.sin(share * 17) * 1.2));
        brush.noFill();
      } else {
        const angle = share * Math.PI * 2 + t * 0.22 * aura.params.pace;
        const x = L.cx + Math.cos(angle) * orbit;
        const y = L.cy - 30 + Math.sin(angle) * orbit * 0.8;
        if (aura.variant === "Drift Motes") {
          brush.noStroke();
          brush.fill(css, 100);
          brush.bleed(0.28, "out");
          brush.fillTexture(0.6, 0.5);
          brush.circle(ux(x), uy(y), uu(2.6 + Math.sin(angle * 3) * 0.9));
          brush.noFill();
        } else {
          brush.set("marker", css, 2.2);
          brush.line(ux(x), uy(y), ux(x - Math.sin(angle) * 10), uy(y + Math.cos(angle) * 10));
        }
      }
    }
  }

  const headwear = trait("Headwear");
  if (headwear?.variant === "Halo") {
    const y = L.cy - faceH * 0.62 - headwear.params.lift;
    const radius = faceW * 0.34;
    brush.set("pen", colorwayAt(headwear.colorway, 0.8, rng), 1.1);
    for (let dash = 0; dash < 7; dash += 1) {
      const angle = (dash / 7) * Math.PI * 2 + t * 0.3;
      brush.arc(ux(L.cx), uy(y), uu(radius), angle, angle + 0.45);
    }
  }

  const companion = trait("Companion");
  if (companion) {
    const side = companion.params.side === "left" ? -1 : 1;
    const bob = Math.sin(t * 1.2) * 7;
    const x = L.cx + side * faceW * 0.78;
    const y = L.cy + faceH * companion.params.drop + bob;
    const size = companion.params.size;
    const css = colorwayAt(companion.colorway, 0.5, rng);
    if (companion.variant === "Blot Bird") {
      brush.set("marker", css, 1.4);
      brush.circle(ux(x), uy(y), uu(size * 0.32), true);
      const flap = Math.sin(t * 3.4) * 6; // continuous beat, never a flip
      inkSpline([[x - size * 0.4, y - flap], [x, y - 2], [x + size * 0.4, y - flap]], "2B", css, 1.1, 0.5);
      brush.set("pen", css, 1);
      brush.line(ux(x + size * 0.3), uy(y - 2), ux(x + size * 0.5), uy(y));
    } else if (companion.variant === "Paper Boat") {
      inkSpline([[x - size * 0.5, y], [x + size * 0.5, y], [x + size * 0.3, y + size * 0.3], [x - size * 0.3, y + size * 0.3]], "pen", css, 1, 0.1);
      brush.set("pen", css, 1);
      brush.line(ux(x), uy(y), ux(x), uy(y - size * 0.45));
      brush.line(ux(x - size * 0.5), uy(y + size * 0.42), ux(x + size * 0.55), uy(y + size * 0.42));
    } else {
      for (let wave = 0; wave < 3; wave += 1) {
        inkSpline([
          [x - size * 0.5, y + wave * 6 - 6 + Math.sin(t * 3 + wave) * 3],
          [x, y + wave * 6 - 9],
          [x + size * 0.5, y + wave * 6 - 6 + Math.cos(t * 3 + wave) * 3],
        ], "2H", dilute(css, 0.25 * wave), 0.9, 0.6);
      }
    }
  }
}

function paintTrailAndGust(rng, now) {
  pointer.trail = pointer.trail.filter((point) => now - point.t < 0.9);
  if (pointer.trail.length > 2) {
    inkSpline(pointer.trail.map((point) => [point.x, point.y]), "marker", dilute(P.accents[0], 0.45), 1.6, 0.6);
  }

  if (gust) {
    const age = now - gust.born;
    if (age > 0.9) {
      gust = null;
    } else {
      const decay = 1 - age / 0.9;
      const gustRng = makeStream(SEED, `gust:${gust.id}`);
      const strokes = Math.round(12 * decay);
      // Rays travel downwind as they fade — the gust sweeps through instead
      // of hanging in place.
      const sweep = age * 260;
      for (let index = 0; index < strokes; index += 1) {
        const css = index % 3 === 0 ? dilute(P.accents[0], 0.4) : dilute(P.washes[index % P.washes.length], 0.45);
        const x0 = gustRng() * 1000 + Math.cos(gust.dir) * sweep;
        const y0 = gustRng() * 1000 + Math.sin(gust.dir) * sweep;
        const len = (160 + gustRng() * 240) * (0.7 + decay * 0.3);
        const wob = (gustRng() - 0.5) * 60;
        brush.set(index % 2 === 0 ? "2B" : "charcoal", css, 1 + decay);
        brush.spline([
          [ux(x0), uy(y0)],
          [ux(x0 + Math.cos(gust.dir) * len * 0.5 + wob * 0.3), uy(y0 + Math.sin(gust.dir) * len * 0.5 + wob)],
          [ux(x0 + Math.cos(gust.dir) * len), uy(y0 + Math.sin(gust.dir) * len + wob * 0.5)],
        ], 0.5);
      }
    }
  }
}

// --------------------------------------------------------------------------
// Click splats — the shared touch: same gesture system, this token's colors.

function paintSplat({ x, y, index }) {
  const rng = makeStream(SEED, `splat:${index}`);
  const pigment = rng.pick([P.accents[0], P.washes[0], P.washes[1 % P.washes.length]]);
  const size = 12 + rng() * 20;
  const points = [];
  const n = 8 + rng.int(0, 3);
  for (let step = 0; step < n; step += 1) {
    const angle = (step / n) * Math.PI * 2;
    const radius = size * (0.6 + rng() * 0.8);
    points.push([x + Math.cos(angle) * radius, y + Math.sin(angle) * radius]);
  }
  fillPolygon(points, dilute(pigment, 0.35), 88, 0.38, 0.75, 0.5);
  brush.set("spray", dilute(pigment, 0.2), 1.2);
  for (let fleck = 0; fleck < 4; fleck += 1) {
    const angle = rng() * Math.PI * 2;
    const reach = size * (1.3 + rng() * 1.6);
    brush.line(ux(x), uy(y), ux(x + Math.cos(angle) * reach), uy(y + Math.sin(angle) * reach));
  }
  brush.set("pen", dilute(pigment, 0.15), 1);
  for (let flick = 0; flick < 3; flick += 1) {
    const angle = rng() * Math.PI * 2;
    brush.line(
      ux(x + Math.cos(angle) * size * 0.8), uy(y + Math.sin(angle) * size * 0.8),
      ux(x + Math.cos(angle) * size * 1.6), uy(y + Math.sin(angle) * size * 1.6),
    );
  }
}

// --------------------------------------------------------------------------
// Pipeline — one thunk per frame on the shared canvas, snapshotting layers.

function snapshot() {
  return get();
}

// p5.brush's scaleBrushes() MULTIPLIES its stored brush parameters in place
// (and its init auto-bakes canvasWidth/250 once). Track what is currently
// baked in and only ever apply the ratio to the desired total — otherwise
// every resize rebuild compounds the factor and strokes drift fatter or
// thinner each time.
let brushScaleBaked = null;
function setBrushScale(target) {
  brush.scaleBrushes(target / brushScaleBaked);
  brushScaleBaked = target;
}

/** Draws a snapshot cover-fit: aspect ratio always preserved, overflow
 * cropped. When the snapshot matches the canvas this is a plain blit; while
 * a resize repaint streams in, the stale painting scales without warping. */
function drawCover(img) {
  const scale = Math.max(width / img.width, height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  image(img, (width - w) / 2, (height - h) / 2, w, h);
}

function coverWith(img) {
  push();
  translate(-width / 2, -height / 2);
  drawCover(img);
  pop();
}

// --------------------------------------------------------------------------
// The living blot. One fragment shader composites the whole painting:
//
// - Regional morph: every pixel drifts between the two wash variants on its
//   own LOCAL phase (a slow spatial field), so lobes grow and recede
//   independently — metaballs-alive, never a synchronized pulse. Where the
//   variants are identical (background, structure, features, ink) the mix
//   is a no-op, so only the living pigment moves.
// - Edge warp + breath: a gentle displacement band around the blot's edge,
//   swelling with the breath.
// - The boil crossfade and the blink/sleep blend ride the same pass.

const MORPH_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
varying vec2 vUV;
void main() {
  vUV = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}`;

const MORPH_FRAG = `
precision highp float;
varying vec2 vUV;
uniform sampler2D texA0;
uniform sampler2D texA1;
uniform sampler2D texB0;
uniform sampler2D texB1;
uniform float uMelt;
uniform float uAvail;
uniform float uAlpha;
uniform float uWarpT;
uniform float uMorphT;
uniform float uSwell;
uniform vec2 uRes;
uniform vec2 uHead;
uniform float uFaceR;
uniform vec2 uUvScale;
uniform vec2 uUvOff;
void main() {
  vec2 px = vUV * uRes;
  vec2 d = px - uHead;
  float dist = length(d);
  float band = smoothstep(uFaceR * 0.25, uFaceR * 0.75, dist)
             * (1.0 - smoothstep(uFaceR * 1.05, uFaceR * 1.6, dist));
  vec2 wob = vec2(
    sin(px.x * 0.012 + uWarpT * 0.5) * cos(px.y * 0.009 - uWarpT * 0.33),
    cos(px.x * 0.010 - uWarpT * 0.41) * sin(px.y * 0.013 + uWarpT * 0.47));
  vec2 dir = dist > 1.0 ? d / dist : vec2(0.0, 0.0);
  vec2 offPx = band * (wob * uFaceR * 0.018 + dir * uSwell * uFaceR * 0.011);
  vec2 uv = uUvOff + (vUV + offPx / uRes) * uUvScale;
  vec2 q = d / uFaceR;
  // Several independent phase regions must fit ACROSS the blot, or the mass
  // mixes in sync and reads as a pulse. The domain warp slides the regions
  // themselves, so the lobes migrate as well as swell.
  vec2 qq = q * 3.0 + vec2(
    sin(q.y * 2.7 + uMorphT * 0.21),
    cos(q.x * 2.3 - uMorphT * 0.17)) * 0.8;
  float phase = sin(qq.x * 1.9 + uMorphT * 0.31)
              + sin(qq.y * 2.3 - uMorphT * 0.24)
              + sin((qq.x + qq.y) * 1.3 + uMorphT * 0.18);
  float m = uAvail * (0.5 + 0.5 * sin(phase));
  vec4 colA = mix(texture2D(texA0, uv), texture2D(texA1, uv), uMelt);
  vec4 colB = mix(texture2D(texB0, uv), texture2D(texB1, uv), uMelt);
  vec4 col = mix(colA, colB, m);
  gl_FragColor = vec4(col.rgb, uAlpha);
}`;

let morphShader = null;

function morphPass(a0, a1, b0, b1, melt, alphaVal, swell, now) {
  const cover = Math.max(width / a0.width, height / a0.height);
  const uvScaleX = width / (a0.width * cover);
  const uvScaleY = height / (a0.height * cover);
  morphShader.setUniform("texA0", a0);
  morphShader.setUniform("texA1", a1);
  morphShader.setUniform("texB0", b0);
  morphShader.setUniform("texB1", b1);
  morphShader.setUniform("uMelt", melt);
  morphShader.setUniform("uAvail", vmixEased);
  morphShader.setUniform("uAlpha", alphaVal);
  morphShader.setUniform("uWarpT", now);
  morphShader.setUniform("uMorphT", morphClock);
  morphShader.setUniform("uSwell", swell);
  morphShader.setUniform("uRes", [width, height]);
  morphShader.setUniform("uHead", [ux(L.cx), uy(L.cy)]);
  morphShader.setUniform("uFaceR", uu(faceW * 0.5));
  morphShader.setUniform("uUvScale", [uvScaleX, uvScaleY]);
  morphShader.setUniform("uUvOff", [(1 - uvScaleX) / 2, (1 - uvScaleY) / 2]);
  rect(0, 0, width, height);
}

/** One full ink pass. Streams are split per feature so the closed-eye frame
 * reproduces frame k exactly, apart from the eyes. */
function paintInk(k, closedEyes) {
  paintEyesInk(makeStream(SEED, `eyes:${k}`), k, closedEyes);
  paintMouthInk(makeStream(SEED, `mouth:${k}`));
  paintOptionalInk(makeStream(SEED, `opt:${k}`), k);
}

/** Appends the ops that ink variant v's boil frames and closed-eye frame.
 * The ink phases use the SAME seeds for both variants, so the strokes are
 * identical — during the morph only the wash beneath them moves. */
function appendFrameOps(v) {
  for (let k = 0; k < 3; k += 1) {
    queue.push(() => {
      coverWith(bases[v]);
      phase(`ink:${k}`, () => paintInk(k, false));
      frames[v][k] = snapshot();
    });
  }
  queue.push(() => {
    // The blink frame is the same painting with the eyes DRAWN closed —
    // not an overlay patch — so the crossfade reads as the eyes melting
    // shut and open again.
    coverWith(bases[v]);
    phase("ink:closed", () => paintInk(0, true));
    blinks[v] = snapshot();
    if (v === 0) ready = true;
    else variantReady = true;
  });
}

/** The paint steps for one base variant. Background and splats use the same
 * streams for both variants (byte-identical paper); only the wash rolls
 * differently, so the morph moves nothing but pigment. */
function baseStepsFor(v) {
  return [
    () => {
      setBrushScale(S / 300);
      phase("background", () => paintBackground(makeStream(SEED, "bgpaint")));
    },
    () => phase("hair-behind", () => paintCurtainBehind(makeStream(SEED, "curtain"))),
    () => phase(`face:${v}`, () => paintFaceWash(makeStream(SEED, `facepaint:${v}`))),
    // Structure and wash traits use the SAME streams for both variants —
    // only the mass morphs; everything the features sit on stays pinned.
    () => phase("structure", () => paintFaceStructure(makeStream(SEED, "structure"))),
    () => phase("traits", () => paintWashTraits(makeStream(SEED, "traitpaint"))),
    ...splats.map((splat) => () => phase(`splat:${splat.index}`, () => paintSplat(splat))),
    () => { bases[v] = snapshot(); },
  ];
}

/**
 * showStale: keep the finished snapshots (and ready state) on screen while
 * the repaint streams in behind them — resizes swap resolution without ever
 * dropping back to blank paper.
 */
function buildPipeline({ showStale = false } = {}) {
  queue.length = 0;
  variantReady = false;
  if (!showStale || bases[0] === null) {
    ready = false;
    bases = [null, null];
  }
  const steps = baseStepsFor(0);
  if (showStale) {
    // While the stale painting keeps showing, the composite repaints the
    // canvas between queue steps — a multi-step base build would snapshot
    // its own ghosts. Build the whole base in ONE atomic step instead.
    queue.push(() => { for (const stepFn of steps) stepFn(); });
  } else {
    queue.push(...steps);
  }
  appendFrameOps(0);
  // Variant 1 — the morph partner — builds after the portrait is already
  // live; by then the composite interleaves, so its base is one atomic step.
  const partnerSteps = baseStepsFor(1);
  queue.push(() => { for (const stepFn of partnerSteps) stepFn(); });
  appendFrameOps(1);
}

function commitSplat(x, y) {
  const splat = { x, y, index: splats.length };
  splats.push(splat);
  // The splat joins BOTH variants' bases (same stream — the same splat), and
  // the ink re-lands over each; old frames keep showing until each rebuilt
  // one swaps in, so nothing flashes and the morph never pops.
  queue.length = 0;
  for (const v of [0, 1]) {
    if (bases[v] === null) continue;
    queue.push(() => {
      coverWith(bases[v]);
      phase(`splat:${splat.index}`, () => paintSplat(splat));
      bases[v] = snapshot();
    });
  }
  appendFrameOps(0);
  if (bases[1] !== null) {
    appendFrameOps(1);
  } else {
    // The splat interrupted variant 1's initial build — restart it, now
    // including the new splat via the shared replay list.
    variantReady = false;
    const partnerSteps = baseStepsFor(1);
    queue.push(() => { for (const stepFn of partnerSteps) stepFn(); });
    appendFrameOps(1);
  }
}

// --------------------------------------------------------------------------
// p5 lifecycle

let blinkAt = 0;
let blinkStart = -10;
const blinkRng = makeStream(SEED, "blink");
const boilShift = { x: 0, y: 0 };
// The gaze eases toward the pointer instead of snapping to it.
const gaze = { x: 500, y: 470 };

// Idle sleep: leave them alone long enough and they drift off — eyes melt
// closed, breath deepens and slows, the boil settles. They wake on touch.
const IDLE_DELAY = 32 + blinkRng() * 14;
let lastActive = -1;
let sleepiness = 0;

// Variable-rate clocks (boil slows and breath deepens in sleep — a raw
// now*rate would jump when the rate changes, these integrate instead).
let boilClock = 0;
let breathClock = 0;
let lastNow = 0;

// The paper remembers: linger somewhere and a damp mark blooms, then dries.
const damp = [];
let dampId = 0;
let dampNext = 0;
let dwellX = 500;
let dwellY = 470;
let dwellSince = Infinity;

globalThis.setup = function setup() {
  // Clamp: an embedding pane can report a 0-sized viewport mid-open, and
  // p5.brush divides by the canvas width at init (0/0 → NaN → crash).
  const canvas = createCanvas(Math.max(320, windowWidth), Math.max(320, windowHeight), WEBGL);
  canvas.parent("stage");
  pixelDensity(Math.min(window.devicePixelRatio || 1, 1.5));
  frameRate(30);
  morphShader = createShader(MORPH_VERT, MORPH_FRAG);
  brush.load(); // pin p5.brush to this canvas now, not at its lazy hook
  // p5.brush's lazy init will bake width/250 into the brush params at the
  // afterSetup hook — before any of our paint steps run.
  brushScaleBaked = width / 250;

  computeLayoutTransform();

  brush.seed(SEED);
  randomSeed(SEED_INT);
  noiseSeed(SEED_INT);

  blinkAt = 1.6 + blinkRng() * 3;
  buildPipeline();

  // Some embeds suspend requestAnimationFrame entirely, and a one-shot init
  // race can kill p5's loop while isLooping() still reports true. Watch the
  // frame counter itself: if it stalls, loop() re-enters the draw cycle.
  let watchdogFrame = -1;
  setInterval(() => {
    try {
      if (frameCount === watchdogFrame) loop();
      watchdogFrame = frameCount;
    } catch {
      /* keep trying */
    }
  }, 1200);
};

let sizeMismatchFrames = 0;
let lastWantW = -1;
let lastWantH = -1;

globalThis.draw = function draw() {
  const now = millis() / 1000;

  // An embedding pane can reveal the page at its real size without ever
  // firing a resize event (it loads hidden, viewport 0). Watch for a
  // mismatch, but only act once the viewport has SETTLED — during a live
  // window drag the wanted size keeps changing, and rebuilding on every
  // twitch would repaint the portrait over and over.
  const wantW = Math.max(320, windowWidth);
  const wantH = Math.max(320, windowHeight);
  if (wantW !== width || wantH !== height) {
    sizeMismatchFrames = wantW === lastWantW && wantH === lastWantH ? sizeMismatchFrames + 1 : 1;
    lastWantW = wantW;
    lastWantH = wantH;
    if (sizeMismatchFrames >= 4) {
      sizeMismatchFrames = 0;
      applyCanvasSize();
      return;
    }
  } else {
    sizeMismatchFrames = 0;
  }

  if (queue.length > 0) {
    // Paint steps drain on a time budget: the portrait still paints itself
    // in, but a throttled embed doesn't stretch the reveal to forever.
    // While the boil frames rebuild, keep showing the finished base instead
    // of the half-inked canvas.
    // In a throttled embed frames are seconds apart — spend proportionally
    // more of each rare frame on painting so the reveal still lands fast.
    const slice = Math.min(420, Math.max(120, (deltaTime || 33) * 0.6));
    const budget = performance.now() + slice;
    while (queue.length > 0 && performance.now() < budget) {
      queue.shift()();
    }
    if (!ready && bases[0] === null) return; // reveal: show the wet paint
    if (queue.length > 0 && !ready && bases[0] !== null) coverWith(bases[0]);
    if (!ready) return;
  }
  if (!ready) return;

  // Clocks: boil slows and breath deepens as sleep sets in, so both run on
  // integrated clocks instead of raw time (a rate change must never jump).
  const dt = Math.min(0.1, Math.max(0.001, now - lastNow));
  lastNow = now;

  // Sleep: drift off when left alone, ease awake on touch.
  const idle = lastActive >= 0 && now - lastActive > IDLE_DELAY;
  sleepiness += ((idle ? 1 : 0) - sleepiness) * (idle ? dt * 0.35 : dt * 2.2);
  sleepiness = Math.max(0, Math.min(1, sleepiness));
  const sleepClosed = sleepiness * sleepiness * (3 - 2 * sleepiness);

  boilClock += dt * (L.boilPace / 4) * (1 - sleepClosed * 0.45);
  breathClock += dt * ((Math.PI * 2) / (4.6 * (1 + sleepClosed * 0.5)));
  const swell = Math.sin(breathClock) * (1 + sleepClosed * 0.8);

  // The Rorschach morph clock: the shader's spatial field turns this into
  // per-lobe local phases — continuous growth and recession, never a
  // synchronized pulse. vmixEased only gates whether the partner variant
  // exists yet, easing in and out so a rebuild can never pop.
  morphClock += dt * ((Math.PI * 2) / 12) * (1 - sleepClosed * 0.3);
  const vmixTarget = variantReady ? 1 : 0;
  vmixEased += (vmixTarget - vmixEased) * Math.min(1, dt * 1.5);

  // Blink scheduling — an eased envelope; paused while asleep.
  if (now > blinkAt) {
    if (sleepClosed < 0.6) blinkStart = now;
    blinkAt = now + L.blinkEvery * (0.7 + blinkRng() * 0.6) + (blinkRng() < 0.15 ? 0.4 : 0);
  }
  const bt = now - blinkStart;
  const blinkAlpha = bt < 0.09 ? bt / 0.09 : bt < 0.16 ? 1 : bt < 0.3 ? 1 - (bt - 0.16) / 0.14 : 0;
  const closedAmount = Math.max(blinkAlpha, sleepClosed);

  // The gaze eases toward the pointer; nothing in the face ever snaps.
  gaze.x += (pointer.x - gaze.x) * 0.1;
  gaze.y += (pointer.y - gaze.y) * 0.1;

  // Composite: paper, then the breathing painting. The boil ping-pongs
  // (0,1,2,1) and CROSSFADES between frames, so the ink melts from one
  // settle to the next instead of flicking shapes. Every layer is drawn
  // through the Rorschach warp so the blot itself is alive.
  const seqIndex = Math.floor(boilClock);
  const seq = [0, 1, 2, 1];
  const frameA = seq[seqIndex % 4];
  const frameB = seq[(seqIndex + 1) % 4];
  const fade = boilClock - seqIndex;
  const melt = fade * fade * (3 - 2 * fade); // smoothstep
  const headX = ux(L.cx);
  const headY = uy(L.cy);
  const breath = 1 + 0.005 * L.breath * (1 + swell) * 0.5;
  const parallaxX = ((gaze.x - 500) / 500) * uu(2);
  const parallaxY = ((gaze.y - 470) / 500) * uu(1.5);
  boilShift.x *= 0.92;
  boilShift.y *= 0.92;

  push();
  translate(-width / 2, -height / 2);
  background(P.paper);
  push();
  translate(headX, headY);
  scale(breath);
  rotate(0.0025 * Math.sin((now * Math.PI * 2) / 6.2));
  translate(-headX + parallaxX + boilShift.x, -headY + parallaxY + boilShift.y);
  const a0 = frames[0][frameA];
  const a1 = frames[0][frameB];
  const b0 = frames[1][frameA] ?? a0;
  const b1 = frames[1][frameB] ?? a1;
  shader(morphShader);
  noStroke();
  morphPass(a0, a1, b0, b1, melt, 1, swell, now);
  if (closedAmount > 0.01) {
    const c0 = blinks[0];
    const c1 = blinks[1] ?? c0;
    morphPass(c0, c0, c1, c1, 0, closedAmount, swell, now);
  }
  resetShader();
  pop();
  pop();

  // Live paint: fixed brush seed, continuous time — geometry moves smoothly
  // while each element's stroke texture stays coherent frame to frame.
  brush.seed(`${SEED}:fx`);
  randomSeed(SEED_INT);
  push();
  translate(-width / 2, -height / 2);
  const rng = makeStream(SEED, "fx");
  paintTideLine(now);
  paintDampMarks(now);
  if (closedAmount < 0.5) paintPupils(rng);
  paintMajors(rng, now);
  paintTrailAndGust(rng, now);
  brush.reDraw();
  brush.reBlend();
  pop();
};

// --------------------------------------------------------------------------
// Interaction — hover feeds the gaze and trail, drag can gust, tap splats.

const gesture = { downX: 0, downY: 0, downAt: 0, moved: 0, lastGust: 0, gustCount: 0 };

function toUnits(px, py) {
  return { x: (px - OX) / U, y: (py - OY) / U };
}

function pointerMove(px, py) {
  const { x, y } = toUnits(px, py);
  const speed = Math.hypot(x - pointer.x, y - pointer.y);
  pointer.x = x;
  pointer.y = y;
  const now = millis() / 1000;
  lastActive = now;
  // Dwell tracking for damp marks: moving far re-anchors the lingering spot.
  if (Math.hypot(x - dwellX, y - dwellY) > 14) {
    dwellX = x;
    dwellY = y;
    dwellSince = now;
  }
  if (speed > 2) pointer.trail.push({ x, y, t: now });
  if (pointer.trail.length > 14) pointer.trail.shift();
  return speed;
}

function pointerDown(px, py) {
  const { x, y } = toUnits(px, py);
  gesture.downX = x;
  gesture.downY = y;
  gesture.downAt = millis();
  gesture.moved = 0;
  lastActive = millis() / 1000;
}

function pointerDrag(px, py) {
  const speed = pointerMove(px, py);
  gesture.moved += speed;
  const now = millis() / 1000;
  if (gesture.moved > 130 && now - gesture.lastGust > 0.7) {
    const dir = Math.atan2(pointer.y - gesture.downY, pointer.x - gesture.downX);
    gesture.gustCount += 1;
    gust = { dir, born: now, id: gesture.gustCount };
    gesture.lastGust = now;
    boilShift.x = Math.cos(dir) * uu(7);
    boilShift.y = Math.sin(dir) * uu(7);
    gesture.downX = pointer.x;
    gesture.downY = pointer.y;
    gesture.moved = 0;
  }
}

function pointerUp(px, py) {
  const { x, y } = toUnits(px, py);
  const dt = millis() - gesture.downAt;
  const travel = Math.hypot(x - gesture.downX, y - gesture.downY);
  if (ready && travel < 14 && dt < 450 && splats.length < 40) {
    commitSplat(x, y);
  }
}

globalThis.mouseMoved = function mouseMoved() { pointerMove(mouseX, mouseY); };
globalThis.mouseDragged = function mouseDragged() { pointerDrag(mouseX, mouseY); return false; };
globalThis.mousePressed = function mousePressed() { pointerDown(mouseX, mouseY); };
globalThis.mouseReleased = function mouseReleased() { pointerUp(mouseX, mouseY); };
globalThis.touchStarted = function touchStarted() {
  if (touches.length > 0) pointerDown(touches[0].x, touches[0].y);
  return false;
};
globalThis.touchMoved = function touchMoved() {
  if (touches.length > 0) pointerDrag(touches[0].x, touches[0].y);
  return false;
};
globalThis.touchEnded = function touchEnded() {
  pointerUp(pointer.x * U + OX, pointer.y * U + OY);
  return false;
};

/**
 * Maps unit space onto the canvas with the HEAD as the anchor, not the
 * sheet. On large screens this reduces exactly to fitting the 1000-unit
 * sheet into the short side; as the screen shrinks the framing zooms toward
 * the face (up to ~62% of the short side) so the portrait stays the subject
 * instead of becoming a tiny figure in a field of margins.
 */
function computeLayoutTransform() {
  const minDim = Math.min(width, height);
  const sheetFrac = faceW / 1000; // face share of the short side at sheet fit
  const t = Math.max(0, Math.min(1, (900 - minDim) / (900 - 430)));
  const ease = t * t * (3 - 2 * t);
  const targetFrac = sheetFrac + (0.62 - sheetFrac) * ease;
  U = (targetFrac * minDim) / faceW;
  S = U * 1000; // sheet size in px — brush texture scales with the zoom
  OX = width / 2 - L.cx * U;
  OY = height * 0.47 - L.cy * U; // head rides slightly above center
}

let resizeTimer = null;
function applyCanvasSize() {
  // The settled-size watcher and the debounced resize handler can both land
  // here; whoever arrives second finds nothing to do.
  if (Math.max(320, windowWidth) === width && Math.max(320, windowHeight) === height) return;
  resizeCanvas(Math.max(320, windowWidth), Math.max(320, windowHeight));
  brush.load(); // recreate p5.brush's masks at the new canvas size
  computeLayoutTransform();
  buildPipeline({ showStale: true });
}
globalThis.windowResized = function windowResized() {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyCanvasSize, 180);
};
