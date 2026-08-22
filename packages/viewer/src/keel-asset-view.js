/**
 * Keel asset view — render any preserved asset the way art should be shown,
 * and tell the caller exactly where it ended up on screen.
 *
 * Two jobs. First, present the work: fill the frame, keep the aspect ratio, and
 * never upscale a raster past its own pixels — a 631×631 PNG blown up to 4K is
 * not respect, it is mush. Vectors have no native size, so they are allowed to
 * fill everything.
 *
 * Second, report the painted rectangle. `object-fit: contain` means the element
 * box and the pixels a viewer actually sees are different rectangles, and
 * anything that wants to sit in the corner *of the artwork* — a seal, a badge,
 * a frame — needs the second one. Without this you end up pinning a mark to the
 * corner of the letterboxing instead of the corner of the art.
 */

/** What kind of thing these bytes are, decided by their magic number. */
export function detectAssetKind(bytes) {
  const hex = [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const text = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
  if (hex.startsWith("89504e470d0a1a0a")) return { kind: "raster", mime: "image/png" };
  if (hex.startsWith("ffd8ff")) return { kind: "raster", mime: "image/jpeg" };
  if (hex.startsWith("47494638")) return { kind: "raster", mime: "image/gif" };
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return { kind: "raster", mime: "image/webp" };
  if (hex.startsWith("0000000c6a5020200d0a870a")) return { kind: "raster", mime: "image/jp2" };
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
    return { kind: "vector", mime: "image/svg+xml" };
  }
  if (hex.slice(8, 16) === "66747970") return { kind: "video", mime: "video/mp4" };
  if (hex.startsWith("1a45dfa3")) return { kind: "video", mime: "video/webm" };
  if (hex.startsWith("676c5446")) return { kind: "model", mime: "model/gltf-binary" };
  if (hex.startsWith("4f676753")) return { kind: "audio", mime: "audio/ogg" };
  if (hex.startsWith("494433") || hex.startsWith("fffb")) return { kind: "audio", mime: "audio/mpeg" };
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return { kind: "document", mime: "text/html" };
  return { kind: "unknown", mime: "application/octet-stream" };
}

function toDataUri(bytes, mime) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * The rectangle the content actually occupies inside its element, accounting
 * for `object-fit: contain` letterboxing. Returns element bounds unchanged for
 * anything with no intrinsic aspect ratio.
 */
export function paintedRect(node) {
  const box = node.getBoundingClientRect();
  const naturalWidth = node.naturalWidth ?? node.videoWidth ?? 0;
  const naturalHeight = node.naturalHeight ?? node.videoHeight ?? 0;
  if (!naturalWidth || !naturalHeight) return box;
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return new DOMRect(box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height);
}

/**
 * Mount `bytes` into `target`.
 *
 * @param upscale Allow a raster to be drawn larger than its own pixels. Off by
 * default, because upscaling somebody's artwork without being asked is a
 * decision the viewer does not get to make.
 * @param onRect Called with `(rect, detected, shape)` whenever the painted
 * rectangle changes, so a caller can pin chrome to the corner of the art rather
 * than the frame, and stroke a frame along the artwork's own backdrop edge.
 */
export function mountAsset({ target, bytes, upscale = false, onRect } = {}) {
  const detected = detectAssetKind(bytes);
  const source = toDataUri(bytes, detected.mime);
  let node;

  if (detected.kind === "video") {
    node = document.createElement("video");
    Object.assign(node, { src: source, autoplay: true, loop: true, muted: true, playsInline: true, controls: false });
  } else if (detected.kind === "audio") {
    node = document.createElement("audio");
    Object.assign(node, { src: source, controls: true });
  } else if (detected.kind === "document" || detected.kind === "model") {
    // A document brings its own scripts and a model needs a renderer; both are
    // given their own frame rather than being trusted with this one.
    node = document.createElement("iframe");
    node.src = source;
    node.setAttribute("sandbox", "allow-scripts");
    node.style.border = "0";
  } else {
    node = document.createElement("img");
    node.src = source;
    node.alt = "";
    node.decoding = "async";
  }

  node.dataset.keelAsset = detected.kind;
  Object.assign(node.style, {
    display: "block",
    maxWidth: "100%",
    maxHeight: "100%",
    width: detected.kind === "vector" || detected.kind === "document" || detected.kind === "model" ? "100%" : "auto",
    height: detected.kind === "vector" || detected.kind === "document" || detected.kind === "model" ? "100%" : "auto",
    objectFit: "contain",
  });

  target.replaceChildren(node);

  // The backdrop is a property of the bytes, not of the window, so it is
  // measured once when the asset settles and reused on every resize.
  let shape = null;
  const report = () => onRect?.(paintedRect(node), detected, shape);
  const settle = () => {
    // A raster is capped at its own resolution unless the caller opts in.
    if (!upscale && (detected.kind === "raster") && node.naturalWidth) {
      node.style.maxWidth = `min(100%, ${node.naturalWidth}px)`;
      node.style.maxHeight = `min(100%, ${node.naturalHeight}px)`;
    }
    if (node.tagName === "IMG" || node.tagName === "VIDEO") shape = detectBackdrop(node);
    report();
  };

  if (node.tagName === "IMG") node.complete ? settle() : node.addEventListener("load", settle, { once: true });
  else if (node.tagName === "VIDEO") node.addEventListener("loadedmetadata", settle, { once: true });
  else settle();

  if (typeof ResizeObserver === "function") new ResizeObserver(report).observe(target);
  addEventListener("resize", report);

  return { node, detected, rect: () => paintedRect(node), shape: () => shape, refresh: report };
}

/* ------------------------------------------------------------------------- */
/* Backdrop geometry                                                          */
/*                                                                            */
/* A frame drawn around the element box is a frame around the letterboxing.   */
/* A frame drawn around the painted rect is closer, but still wrong for the   */
/* very common case where the artwork carries its own backdrop with rounded   */
/* corners — a BAYC ape is a 631×631 PNG whose orange field is a rounded rect */
/* of radius 21 with transparent corners. Squaring that off cuts the artwork's */
/* own shape. So: read the pixels, find where the backdrop actually ends, and  */
/* measure how curved it is.                                                  */
/* ------------------------------------------------------------------------- */

// Working resolution for the probe. High enough that a typical avatar — a few
// hundred pixels square — is measured at its native size rather than a
// downscale, and low enough that a 4000px scan stays cheap.
const PROBE = 768;
const MATCH = 24; // channel distance under which two pixels are "the same"

/**
 * How much of this pixel the backdrop covers, 0..1.
 *
 * Edges are antialiased, so the boundary almost never falls on a pixel
 * boundary. Treating a 9%-covered pixel as fully inside — which any fixed
 * threshold does — pulls every traced arc inward by about a pixel, and on a
 * small radius that is a large fraction of the answer. Reading the coverage
 * ramp instead puts the edge where it actually is.
 */
function coverage(pixels, i, outside, inside) {
  if (outside[3] < 8) return pixels[i + 3] / 255;
  if (!inside) return near(pixels, i, outside) ? 0 : 1;
  const toOutside = Math.hypot(pixels[i] - outside[0], pixels[i + 1] - outside[1], pixels[i + 2] - outside[2]);
  const span = Math.hypot(inside[0] - outside[0], inside[1] - outside[1], inside[2] - outside[2]);
  if (span < 8) return near(pixels, i, outside) ? 0 : 1;
  return Math.min(1, toOutside / span);
}

function near(pixels, i, ref) {
  // Fully transparent pixels are equal regardless of what the RGB channels
  // happen to hold; PNG encoders leave garbage under alpha 0.
  const alpha = pixels[i + 3];
  if (alpha < 8 && ref[3] < 8) return true;
  return (
    Math.abs(alpha - ref[3]) <= MATCH &&
    Math.abs(pixels[i] - ref[0]) <= MATCH &&
    Math.abs(pixels[i + 1] - ref[1]) <= MATCH &&
    Math.abs(pixels[i + 2] - ref[2]) <= MATCH
  );
}

/**
 * Fit a corner radius to one corner's arc.
 *
 * For a rounded rectangle the inset at row `y` above the straight edge is
 * `r - sqrt(r² - (r - y)²)`. Sweeping candidate radii and keeping the least
 * squared error recovers `r` from the traced arc without any curve fitting
 * library, and degrades to 0 for a hard corner because a hard corner traces a
 * flat profile that only r = 0 explains.
 */
function fitRadius(trace) {
  const limit = trace.length;
  // Each traced value is the uncovered length of that row, and each row's band
  // is centred half a pixel below its index, so the model is evaluated there.
  const score = (r) => {
    let error = 0;
    for (let y = 0; y < limit; y++) {
      const centre = y + 0.5;
      const expected = centre < r ? r - Math.sqrt(Math.max(0, r * r - (r - centre) * (r - centre))) : 0;
      const delta = expected - trace[y];
      error += delta * delta;
    }
    return error;
  };
  let best = 0;
  let bestError = Infinity;
  for (let r = 0; r <= limit; r++) {
    const error = score(r);
    if (error < bestError) {
      bestError = error;
      best = r;
    }
  }
  // Refine below one pixel. The arc is traced at probe resolution, so the true
  // radius rarely lands on an integer there, and rounding it visibly pulls the
  // frame off a shallow curve when it is scaled back up to display size.
  for (let r = Math.max(0, best - 1); r <= best + 1; r += 0.05) {
    const error = score(r);
    if (error < bestError) {
      bestError = error;
      best = r;
    }
  }
  return { radius: best, error: Math.sqrt(bestError / Math.max(1, limit)) };
}

/**
 * Measure the backdrop shape of a raw RGBA buffer.
 *
 * Pure geometry — no DOM, no assumptions about what the artwork is. Given
 * `width * height * 4` bytes it decides whether there is a backdrop at all,
 * where it ends, and how curved its corners are. Everything comes out as a
 * fraction of the buffer, so it scales to any display size.
 *
 * @returns {{kind: string, x: number, y: number, w: number, h: number, r: number, color: string|null, confidence: number}}
 */
export function measureBackdrop(pixels, width, height) {
  const full = { kind: "full", x: 0, y: 0, w: 1, h: 1, r: 0, color: null, confidence: 0 };
  if (!pixels || width < 8 || height < 8) return full;

  const at = (x, y) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const outside = [pixels[corners[0]], pixels[corners[0] + 1], pixels[corners[0] + 2], pixels[corners[0] + 3]];

  // If the four corners disagree, the artwork runs all the way out to them and
  // there is no backdrop to trace — a photograph, a full-bleed composition.
  if (!corners.every((i) => near(pixels, i, outside))) return full;

  // Walk in from each edge to the first line holding anything that is not the
  // outside colour. A handful of stray pixels is not an edge, so a line has to
  // carry a couple of them to count.
  const populated = (fixed, horizontal) => {
    let hits = 0;
    const span = horizontal ? width : height;
    for (let i = 0; i < span; i++) {
      const index = horizontal ? at(i, fixed) : at(fixed, i);
      if (!near(pixels, index, outside) && ++hits > 2) return true;
    }
    return false;
  };
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;
  while (top < bottom && !populated(top, true)) top++;
  while (bottom > top && !populated(bottom, true)) bottom--;
  while (left < right && !populated(left, false)) left++;
  while (right > left && !populated(right, false)) right--;

  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  if (boxWidth < 8 || boxHeight < 8) return full;

  // Trace each corner's arc: how far in the backdrop starts, row by row. The
  // probe reaches half the short side so a circle — whose radius *is* half the
  // short side — is still inside the window.
  const shortSide = Math.min(boxWidth, boxHeight);
  const probeDepth = Math.max(4, Math.floor(shortSide / 2));
  // The colour well inside the backdrop, which the coverage ramp is measured
  // against. Taken from the middle of the box, where nothing is blended.
  const centre = at(left + (boxWidth >> 1), top + (boxHeight >> 1));
  const inside = [pixels[centre], pixels[centre + 1], pixels[centre + 2], pixels[centre + 3]];
  // How far the backdrop is set in on each row, measured as the uncovered
  // length of that row rather than the index of the first solid pixel. Summing
  // coverage this way places the edge exactly wherever it falls — no rounding
  // to a pixel, no half-pixel convention to get wrong — and it costs nothing
  // extra, because the same pixels were going to be read either way.
  const traceCorner = (originX, originY, stepX, stepY) => {
    const trace = [];
    for (let d = 0; d < probeDepth; d++) {
      const y = originY + stepY * d;
      let uncovered = 0;
      for (let step = 0; step < probeDepth; step++) {
        const covered = coverage(pixels, at(originX + stepX * step, y), outside, inside);
        uncovered += 1 - covered;
        // The first solid pixel ends the run; anything transparent deeper in
        // belongs to the artwork, not to the shape of its backdrop.
        if (covered >= 0.5) break;
      }
      trace.push(uncovered);
    }
    return trace;
  };
  const fits = [
    fitRadius(traceCorner(left, top, 1, 1)),
    fitRadius(traceCorner(right, top, -1, 1)),
    fitRadius(traceCorner(left, bottom, 1, -1)),
    fitRadius(traceCorner(right, bottom, -1, -1)),
  ];

  const radii = fits.map((f) => f.radius).sort((a, b) => a - b);
  const midRadius = (radii[1] + radii[2]) / 2;
  const spread = radii[3] - radii[0];
  const residual = fits.reduce((sum, f) => sum + f.error, 0) / fits.length;

  // Four corners that disagree, or an arc the circle model cannot explain, is
  // not a rounded rectangle. Say so rather than inventing a radius.
  const uniform = spread <= Math.max(2, midRadius * 0.35);
  const tolerance = Math.max(1.6, shortSide * 0.02);
  const explained = residual <= tolerance;
  const confidence = uniform && explained ? Math.max(0, 1 - residual / tolerance) : 0;

  let kind = "rect";
  let radius = 0;
  if (confidence > 0 && midRadius >= 1.5) {
    radius = midRadius;
    // A radius at half the short side is not a rounded rectangle any more, it
    // is a circle, and a circle wants an ellipse rather than a 50% corner.
    kind = midRadius >= shortSide * 0.45 ? "ellipse" : "rounded";
  }

  // The backdrop colour is taken as the median of a ring just inside the edge,
  // clear of both the antialiased rim and the corner arcs. A single sample can
  // land on a stray pixel or a rim blend; a median cannot.
  const ring = [[], [], []];
  const margin = Math.max(2, Math.ceil(radius) + 2);
  const samples = 24;
  for (let s = 0; s < samples; s++) {
    const t = (s + 0.5) / samples;
    const along = (span) => Math.round(margin + t * Math.max(0, span - 1 - margin * 2));
    for (const [x, y] of [
      [left + along(boxWidth), top + margin],
      [left + along(boxWidth), bottom - margin],
      [left + margin, top + along(boxHeight)],
      [right - margin, top + along(boxHeight)],
    ]) {
      const i = at(Math.max(0, Math.min(width - 1, x)), Math.max(0, Math.min(height - 1, y)));
      if (pixels[i + 3] < 8) continue;
      ring[0].push(pixels[i]);
      ring[1].push(pixels[i + 1]);
      ring[2].push(pixels[i + 2]);
    }
  }
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const channels = ring.map(median);

  return {
    kind,
    x: left / width,
    y: top / height,
    w: boxWidth / width,
    h: boxHeight / height,
    r: radius / shortSide,
    color: channels[0] === null ? null : `rgb(${channels[0]},${channels[1]},${channels[2]})`,
    confidence,
  };
}

/**
 * Rasterise a loaded image or video at probe resolution and measure it.
 *
 * The only DOM-aware half: everything decided about the shape happens in
 * `measureBackdrop`, which can be run over any RGBA buffer from anywhere.
 */
export function detectBackdrop(node) {
  const full = { kind: "full", x: 0, y: 0, w: 1, h: 1, r: 0, radiusPx: 0, color: null, confidence: 0 };
  const naturalWidth = node.naturalWidth ?? node.videoWidth ?? 0;
  const naturalHeight = node.naturalHeight ?? node.videoHeight ?? 0;
  if (!naturalWidth || !naturalHeight) return full;

  const scale = Math.min(1, PROBE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(8, Math.round(naturalWidth * scale));
  const height = Math.max(8, Math.round(naturalHeight * scale));

  let pixels;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(node, 0, 0, width, height);
    pixels = ctx.getImageData(0, 0, width, height).data;
  } catch {
    // A tainted canvas means the bytes came from somewhere this document is
    // not allowed to read. Nothing to measure; fall back to the plain frame.
    return full;
  }

  const shape = measureBackdrop(pixels, width, height);
  return { ...shape, radiusPx: Math.round((shape.r * Math.min(width, height) * shape.w) / scale) };
}

/**
 * Turn a detected backdrop into an SVG path in the coordinate space of a
 * painted rectangle, so a frame can be stroked along the artwork's own edge.
 */
export function backdropPath(shape, rect, inset = 0) {
  const x = rect.width * shape.x + inset;
  const y = rect.height * shape.y + inset;
  const w = rect.width * shape.w - inset * 2;
  const h = rect.height * shape.h - inset * 2;
  if (w <= 0 || h <= 0) return "";
  if (shape.kind === "ellipse") {
    const rx = w / 2;
    const ry = h / 2;
    return `M ${x} ${y + ry} a ${rx} ${ry} 0 1 0 ${w} 0 a ${rx} ${ry} 0 1 0 ${-w} 0 Z`;
  }
  const r = Math.max(0, Math.min(shape.r * Math.min(w, h), Math.min(w, h) / 2));
  if (r < 0.5) return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
  return (
    `M ${x + r} ${y} h ${w - r * 2} a ${r} ${r} 0 0 1 ${r} ${r}` +
    ` v ${h - r * 2} a ${r} ${r} 0 0 1 ${-r} ${r}` +
    ` h ${-(w - r * 2)} a ${r} ${r} 0 0 1 ${-r} ${-r}` +
    ` v ${-(h - r * 2)} a ${r} ${r} 0 0 1 ${r} ${-r} Z`
  );
}
