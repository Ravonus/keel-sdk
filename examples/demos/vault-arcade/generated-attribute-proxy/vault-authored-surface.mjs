const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededUnit(key) {
  let state = hashString(key) || 1;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
}

export function buildCandidatePositions(width, height, patchSize, stride = 16) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(patchSize) || !Number.isInteger(stride) || width <= 0 || height <= 0 || patchSize <= 0 || stride <= 0) {
    throw new Error("Authored quilt dimensions must be positive integers");
  }
  if (width < patchSize || height < patchSize) throw new Error("Authored quilt source is smaller than one patch");
  const maximumX = Math.max(0, width - patchSize);
  const maximumY = Math.max(0, height - patchSize);
  const axisPositions = (maximum) => {
    const values = [];
    for (let value = 0; value <= maximum; value += stride) values.push(value);
    if (values.at(-1) !== maximum) values.push(maximum);
    return values;
  };
  const positionsX = axisPositions(maximumX);
  const positionsY = axisPositions(maximumY);
  return positionsY.flatMap((y) => positionsX.map((x) => ({ x, y })));
}

export function buildPlacementOrigins(length, patchSize, overlap) {
  if (!Number.isInteger(length) || !Number.isInteger(patchSize) || !Number.isInteger(overlap) || length <= 0 || patchSize <= 0 || overlap < 0 || overlap >= patchSize) {
    throw new Error("Invalid authored quilt placement dimensions");
  }
  const step = patchSize - overlap;
  const origins = [];
  for (let origin = 0; origin < length; origin += step) origins.push(origin);
  return origins;
}

export function chooseShortlistedCandidate(scored, key, shortlistSize = 8) {
  if (!scored.length) throw new Error("No authored quilt candidates were scored");
  scored.sort((left, right) => left.score - right.score || left.sourceIndex - right.sourceIndex || left.y - right.y || left.x - right.x);
  const shortlist = scored.slice(0, Math.min(shortlistSize, scored.length));
  return shortlist[Math.min(shortlist.length - 1, Math.floor(seededUnit(key) * shortlist.length))];
}

export function minimumErrorSeam(costs, width, height) {
  if (width <= 0 || height <= 0 || costs.length !== width * height) throw new Error("Invalid seam cost field");
  const totals = new Float64Array(costs.length);
  const parents = new Int16Array(costs.length);
  for (let x = 0; x < width; x += 1) totals[x] = costs[x];
  for (let y = 1; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let parentX = x;
      let best = totals[(y - 1) * width + x];
      if (x > 0 && totals[(y - 1) * width + x - 1] < best) {
        best = totals[(y - 1) * width + x - 1];
        parentX = x - 1;
      }
      if (x + 1 < width && totals[(y - 1) * width + x + 1] < best) {
        best = totals[(y - 1) * width + x + 1];
        parentX = x + 1;
      }
      const index = y * width + x;
      totals[index] = costs[index] + best;
      parents[index] = parentX;
    }
  }
  let seamX = 0;
  const lastRow = (height - 1) * width;
  for (let x = 1; x < width; x += 1) if (totals[lastRow + x] < totals[lastRow + seamX]) seamX = x;
  const seam = new Int16Array(height);
  seam[height - 1] = seamX;
  for (let y = height - 1; y > 0; y -= 1) seam[y - 1] = parents[y * width + seam[y]];
  return seam;
}

function colorChannels(color) {
  const value = String(color).replace("#", "");
  return /^[0-9a-f]{6}$/i.test(value)
    ? [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)]
    : [128, 128, 128];
}

function mixChannels(left, right, amount) {
  return left.map((channel, index) => Math.round(channel + (right[index] - channel) * amount));
}

function pixelDifference(left, leftOffset, right, rightOffset) {
  const red = left[leftOffset] - right[rightOffset];
  const green = left[leftOffset + 1] - right[rightOffset + 1];
  const blue = left[leftOffset + 2] - right[rightOffset + 2];
  return red * red + green * green + blue * blue;
}

function pixelAbsoluteDifference(pixels, leftOffset, rightOffset) {
  return Math.abs(pixels[leftOffset] - pixels[rightOffset])
    + Math.abs(pixels[leftOffset + 1] - pixels[rightOffset + 1])
    + Math.abs(pixels[leftOffset + 2] - pixels[rightOffset + 2]);
}

function candidatePeriodicBoundaryPenalty(source, candidate, destinationX, destinationY, patchWidth, patchHeight, period, sampleStride, penaltyCaches, energyCaches, cacheLength, cacheStats) {
  if (!period) return { verticalRatio: 1, horizontalRatio: 1, maximumRatio: 1 };
  const penaltyKey = (((destinationX % period) * period + destinationY % period) * cacheLength + patchWidth) * cacheLength + patchHeight;
  const candidatePenaltyCache = penaltyCaches[candidate.candidateIndex] ??= new Map();
  const cachedPenalty = candidatePenaltyCache.get(penaltyKey);
  if (cachedPenalty) return cachedPenalty;
  const orientationRatio = (orientation) => {
    const destination = orientation === "vertical" ? destinationX : destinationY;
    const length = orientation === "vertical" ? patchWidth : patchHeight;
    const crossLength = orientation === "vertical" ? patchHeight : patchWidth;
    const boundaries = [];
    const references = [];
    const candidateEnergyCache = energyCaches[candidate.candidateIndex] ??= { vertical: new Map(), horizontal: new Map() };
    const orientationCache = candidateEnergyCache[orientation];
    let coordinateEnergies = orientationCache.get(crossLength);
    if (!coordinateEnergies) {
      coordinateEnergies = new Float64Array(cacheLength);
      coordinateEnergies.fill(Number.NaN);
      orientationCache.set(crossLength, coordinateEnergies);
    }
    const energyAt = (coordinate) => {
      const cachedEnergy = coordinateEnergies[coordinate];
      if (!Number.isNaN(cachedEnergy)) return cachedEnergy;
      let total = 0;
      let samples = 0;
      for (let cross = 0; cross < crossLength; cross += sampleStride) {
        const leftX = orientation === "vertical" ? candidate.x + coordinate - 1 : candidate.x + cross;
        const leftY = orientation === "vertical" ? candidate.y + cross : candidate.y + coordinate - 1;
        const rightX = orientation === "vertical" ? leftX + 1 : leftX;
        const rightY = orientation === "vertical" ? leftY : leftY + 1;
        total += pixelAbsoluteDifference(source.pixels, (leftY * source.width + leftX) * 4, (rightY * source.width + rightX) * 4);
        samples += 1;
      }
      const energy = total / Math.max(1, samples);
      coordinateEnergies[coordinate] = energy;
      cacheStats.energies += 1;
      return energy;
    };
    const firstBoundary = Math.ceil((destination + 1) / period) * period - destination;
    for (let coordinate = firstBoundary; coordinate < length; coordinate += period) {
      boundaries.push(energyAt(coordinate));
      for (const offset of [-24, -16, -8, 8, 16, 24]) {
        const reference = coordinate + offset;
        if (reference <= 0 || reference >= length || (destination + reference) % period === 0) continue;
        references.push(energyAt(reference));
      }
    }
    const boundaryMean = boundaries.reduce((sum, value) => sum + value, 0) / Math.max(1, boundaries.length);
    const referenceMean = references.reduce((sum, value) => sum + value, 0) / Math.max(1, references.length);
    return boundaryMean / Math.max(1e-9, referenceMean);
  };
  const verticalRatio = orientationRatio("vertical");
  const horizontalRatio = orientationRatio("horizontal");
  const penalty = { verticalRatio, horizontalRatio, maximumRatio: Math.max(verticalRatio, horizontalRatio) };
  candidatePenaltyCache.set(penaltyKey, penalty);
  cacheStats.penalties += 1;
  return penalty;
}

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b) [a, b] = [b, a % b];
  return a;
}

function deterministicCandidatePool(candidates, limit, key) {
  if (candidates.length <= limit) return candidates;
  const start = hashString(`${key}:start`) % candidates.length;
  let step = Math.max(1, hashString(`${key}:step`) % candidates.length);
  while (greatestCommonDivisor(step, candidates.length) !== 1) step = (step + 1) % candidates.length || 1;
  return Array.from({ length: limit }, (_, index) => candidates[(start + index * step) % candidates.length]);
}

function copyOpaqueSegment(output, outputWidth, source, candidate, destinationX, destinationY, y, startX, endX) {
  if (startX >= endX) return;
  const outputOffset = ((destinationY + y) * outputWidth + destinationX + startX) * 4;
  const sourceOffset = ((candidate.y + y) * source.width + candidate.x + startX) * 4;
  const byteLength = (endX - startX) * 4;
  output.set(source.pixels.subarray(sourceOffset, sourceOffset + byteLength), outputOffset);
  for (let alphaOffset = outputOffset + 3; alphaOffset < outputOffset + byteLength; alphaOffset += 4) output[alphaOffset] = 255;
}

function scorePatch(output, outputWidth, sources, candidate, destinationX, destinationY, patchWidth, patchHeight, overlap, sampleStride) {
  const source = sources[candidate.sourceIndex];
  let score = 0;
  let samples = 0;
  if (destinationX > 0) {
    for (let y = 0; y < patchHeight; y += sampleStride) {
      for (let x = 0; x < Math.min(overlap, patchWidth); x += sampleStride) {
        const outputOffset = ((destinationY + y) * outputWidth + destinationX + x) * 4;
        const sourceOffset = ((candidate.y + y) * source.width + candidate.x + x) * 4;
        score += pixelDifference(output, outputOffset, source.pixels, sourceOffset);
        samples += 1;
      }
    }
  }
  if (destinationY > 0) {
    for (let y = 0; y < Math.min(overlap, patchHeight); y += sampleStride) {
      for (let x = 0; x < patchWidth; x += sampleStride) {
        const outputOffset = ((destinationY + y) * outputWidth + destinationX + x) * 4;
        const sourceOffset = ((candidate.y + y) * source.width + candidate.x + x) * 4;
        score += pixelDifference(output, outputOffset, source.pixels, sourceOffset);
        samples += 1;
      }
    }
  }
  return samples ? score / samples : 0;
}

function verticalSeam(output, outputWidth, source, candidate, destinationX, destinationY, patchWidth, patchHeight, overlap) {
  const seamWidth = Math.min(overlap, patchWidth);
  const costs = new Float64Array(seamWidth * patchHeight);
  for (let y = 0; y < patchHeight; y += 1) {
    for (let x = 0; x < seamWidth; x += 1) {
      const outputOffset = ((destinationY + y) * outputWidth + destinationX + x) * 4;
      const sourceOffset = ((candidate.y + y) * source.width + candidate.x + x) * 4;
      costs[y * seamWidth + x] = pixelDifference(output, outputOffset, source.pixels, sourceOffset);
    }
  }
  return minimumErrorSeam(costs, seamWidth, patchHeight);
}

function horizontalSeam(output, outputWidth, source, candidate, destinationX, destinationY, patchWidth, patchHeight, overlap) {
  const seamHeight = Math.min(overlap, patchHeight);
  const costs = new Float64Array(seamHeight * patchWidth);
  for (let x = 0; x < patchWidth; x += 1) {
    for (let y = 0; y < seamHeight; y += 1) {
      const outputOffset = ((destinationY + y) * outputWidth + destinationX + x) * 4;
      const sourceOffset = ((candidate.y + y) * source.width + candidate.x + x) * 4;
      costs[x * seamHeight + y] = pixelDifference(output, outputOffset, source.pixels, sourceOffset);
    }
  }
  return minimumErrorSeam(costs, seamHeight, patchWidth);
}

export function quiltImageData({ sources, width, height, seed, patchSize = 192, overlap = 48, stride = 16, shortlistSize = 8, sampleStride = 4, candidateLimit = 640, candidateReuseWeight = 0, periodicBoundaryPeriod = 0, periodicBoundaryWeight = 0, periodicBoundarySampleStride = 12 }) {
  if (!sources.length) throw new Error("At least one authored source is required");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("Authored quilt output dimensions must be positive integers");
  if (!Number.isInteger(shortlistSize) || shortlistSize <= 0 || !Number.isInteger(sampleStride) || sampleStride <= 0 || !Number.isInteger(candidateLimit) || candidateLimit <= 0 || !Number.isFinite(candidateReuseWeight) || candidateReuseWeight < 0 || !Number.isInteger(periodicBoundaryPeriod) || periodicBoundaryPeriod < 0 || !Number.isFinite(periodicBoundaryWeight) || periodicBoundaryWeight < 0 || !Number.isInteger(periodicBoundarySampleStride) || periodicBoundarySampleStride <= 0) {
    throw new Error("Authored quilt sampling controls must be positive integers");
  }
  for (const source of sources) {
    if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < patchSize || source.height < patchSize || source.pixels?.length !== source.width * source.height * 4) {
      throw new Error("Invalid authored quilt source pixels");
    }
  }
  const output = new Uint8ClampedArray(width * height * 4);
  const allCandidates = sources.flatMap((source, sourceIndex) => buildCandidatePositions(source.width, source.height, patchSize, stride).map((position) => ({ ...position, sourceIndex })));
  for (let candidateIndex = 0; candidateIndex < allCandidates.length; candidateIndex += 1) allCandidates[candidateIndex].candidateIndex = candidateIndex;
  const originsX = buildPlacementOrigins(width, patchSize, overlap);
  const originsY = buildPlacementOrigins(height, patchSize, overlap);
  const placements = [];
  const candidateUsage = new Map();
  const periodicBoundaryPenaltyCaches = new Array(allCandidates.length);
  const periodicBoundaryEnergyCaches = new Array(allCandidates.length);
  const periodicBoundaryCacheStats = { penalties: 0, energies: 0 };
  for (let row = 0; row < originsY.length; row += 1) {
    for (let column = 0; column < originsX.length; column += 1) {
      const destinationX = originsX[column];
      const destinationY = originsY[row];
      const patchWidth = Math.min(patchSize, width - destinationX);
      const patchHeight = Math.min(patchSize, height - destinationY);
      const pool = deterministicCandidatePool(allCandidates, candidateLimit, `${seed}:pool:${row}:${column}`);
      const scored = pool.map((candidate) => {
        const overlapScore = scorePatch(output, width, sources, candidate, destinationX, destinationY, patchWidth, patchHeight, overlap, sampleStride);
        const usageKey = `${candidate.sourceIndex}:${candidate.x}:${candidate.y}`;
        const reuseCount = candidateUsage.get(usageKey) ?? 0;
        const reusePenalty = reuseCount * candidateReuseWeight;
        if (!candidateReuseWeight && (!periodicBoundaryPeriod || !periodicBoundaryWeight)) return { ...candidate, score: overlapScore };
        if (!periodicBoundaryPeriod || !periodicBoundaryWeight) return { ...candidate, score: overlapScore + reusePenalty, overlapScore, reuseCount, reusePenalty };
        const periodicBoundary = candidatePeriodicBoundaryPenalty(sources[candidate.sourceIndex], candidate, destinationX, destinationY, patchWidth, patchHeight, periodicBoundaryPeriod, periodicBoundarySampleStride, periodicBoundaryPenaltyCaches, periodicBoundaryEnergyCaches, patchSize + 1, periodicBoundaryCacheStats);
        return { ...candidate, overlapScore, reuseCount, reusePenalty, periodicBoundary, score: overlapScore + reusePenalty + periodicBoundary.maximumRatio * periodicBoundaryWeight };
      });
      const candidate = chooseShortlistedCandidate(scored, `${seed}:pick:${row}:${column}`, shortlistSize);
      const candidateUsageKey = `${candidate.sourceIndex}:${candidate.x}:${candidate.y}`;
      candidateUsage.set(candidateUsageKey, (candidateUsage.get(candidateUsageKey) ?? 0) + 1);
      const source = sources[candidate.sourceIndex];
      const leftSeam = destinationX > 0 ? verticalSeam(output, width, source, candidate, destinationX, destinationY, patchWidth, patchHeight, overlap) : null;
      const topSeam = destinationY > 0 ? horizontalSeam(output, width, source, candidate, destinationX, destinationY, patchWidth, patchHeight, overlap) : null;
      const topSeamHeight = Math.min(overlap, patchHeight);
      for (let y = 0; y < patchHeight; y += 1) {
        const leftCut = leftSeam ? leftSeam[y] : 0;
        if (!topSeam || y >= topSeamHeight) {
          copyOpaqueSegment(output, width, source, candidate, destinationX, destinationY, y, leftCut, patchWidth);
          continue;
        }
        let runStart = -1;
        for (let x = leftCut; x <= patchWidth; x += 1) {
          const accepted = x < patchWidth && y >= topSeam[x];
          if (accepted && runStart < 0) runStart = x;
          if (!accepted && runStart >= 0) {
            copyOpaqueSegment(output, width, source, candidate, destinationX, destinationY, y, runStart, x);
            runStart = -1;
          }
        }
      }
      const { candidateIndex: _candidateIndex, ...placementCandidate } = candidate;
      placements.push({ row, column, destinationX, destinationY, patchWidth, patchHeight, ...placementCandidate });
    }
  }
  return { pixels: output, width, height, placements, patchSize, overlap, periodicBoundaryCache: periodicBoundaryCacheStats };
}

export function tintRgbaPixels(pixels, palette) {
  const low = colorChannels(palette.floor);
  const middle = colorChannels(palette.floor2);
  const high = colorChannels(palette.line);
  const accent = colorChannels(palette.accent);
  const output = new Uint8ClampedArray(pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    const luminance = (output[offset] * 0.2126 + output[offset + 1] * 0.7152 + output[offset + 2] * 0.0722) / 255;
    let color = luminance < 0.52 ? mixChannels(low, middle, luminance / 0.52) : mixChannels(middle, high, (luminance - 0.52) / 0.48);
    if (luminance > 0.84) color = mixChannels(color, accent, clamp((luminance - 0.84) / 0.16, 0, 1) * 0.42);
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
  }
  return output;
}

export function tintImageData(imageData, palette) {
  const output = new ImageData(tintRgbaPixels(imageData.data, palette), imageData.width, imageData.height);
  return output;
}

export async function loadImage(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  return image;
}

export function cropSource(image, x, y, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  const frame = context.getImageData(0, 0, width, height);
  return { pixels: frame.data, width, height };
}

export function drawTintedQuilt(canvas, quilt, palette) {
  canvas.width = quilt.width;
  canvas.height = quilt.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const frame = new ImageData(new Uint8ClampedArray(quilt.pixels), quilt.width, quilt.height);
  context.putImageData(tintImageData(frame, palette), 0, 0);
  return context;
}

export function drawFeatheredMacro(context, macroImage, quadrant, destinationX, destinationY, palette, size = 512, feather = 56, alpha = 0.84) {
  const macro = document.createElement("canvas");
  macro.width = size;
  macro.height = size;
  const macroContext = macro.getContext("2d", { willReadFrequently: true });
  const sourceX = (quadrant % 2) * 512;
  const sourceY = Math.floor(quadrant / 2) * 512;
  macroContext.drawImage(macroImage, sourceX, sourceY, 512, 512, 0, 0, size, size);
  const tinted = tintImageData(macroContext.getImageData(0, 0, size, size), palette);
  macroContext.putImageData(tinted, 0, 0);
  const mask = macroContext.createRadialGradient(size / 2, size / 2, Math.max(0, size / 2 - feather * 1.4), size / 2, size / 2, size / 2);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.82, "rgba(0,0,0,0.96)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  macroContext.globalCompositeOperation = "destination-in";
  macroContext.fillStyle = mask;
  macroContext.fillRect(0, 0, size, size);
  macroContext.globalCompositeOperation = "source-over";
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(macro, destinationX, destinationY);
  context.restore();
}
