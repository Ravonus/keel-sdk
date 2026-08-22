function luminance(pixels, offset) {
  return pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function fnv1aBytes(bytes) {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function readCrop(pixels, width, x, y, cropSize) {
  const crop = new Uint8Array(cropSize * cropSize * 4);
  for (let row = 0; row < cropSize; row += 1) {
    const sourceOffset = ((y + row) * width + x) * 4;
    crop.set(pixels.subarray(sourceOffset, sourceOffset + cropSize * 4), row * cropSize * 4);
  }
  return crop;
}

export function countExactDuplicateCrops({ pixels, width, height, cropSize = 64, origins }) {
  if (pixels.length !== width * height * 4 || !Number.isInteger(cropSize) || cropSize <= 0 || !Array.isArray(origins)) throw new Error("Invalid exact-crop audit input");
  const representatives = [];
  let duplicatePairs = 0;
  for (const origin of origins) {
    if (!Number.isInteger(origin.x) || !Number.isInteger(origin.y) || origin.x < 0 || origin.y < 0 || origin.x + cropSize > width || origin.y + cropSize > height) throw new Error("Exact-crop origin is outside the surface");
    const bytes = readCrop(pixels, width, origin.x, origin.y, cropSize);
    const hash = fnv1aBytes(bytes);
    const match = representatives.find((entry) => entry.hash === hash && equalBytes(entry.bytes, bytes));
    if (match) {
      duplicatePairs += match.count;
      match.count += 1;
    } else {
      representatives.push({ hash, bytes, count: 1 });
    }
  }
  return {
    cropSize,
    totalCrops: origins.length,
    uniqueCrops: representatives.length,
    exactDuplicateCrops: origins.length - representatives.length,
    exactDuplicatePairs: duplicatePairs,
    duplicateGroupSizes: representatives.filter((entry) => entry.count > 1).map((entry) => entry.count).sort((left, right) => right - left),
  };
}

function boundaryEnergy(pixels, width, orientation, coordinate, region, sampleStride) {
  let total = 0;
  let samples = 0;
  if (orientation === "vertical") {
    for (let y = region.top; y < region.bottom; y += sampleStride) {
      const left = (y * width + coordinate - 1) * 4;
      const right = left + 4;
      total += Math.abs(pixels[left] - pixels[right]) + Math.abs(pixels[left + 1] - pixels[right + 1]) + Math.abs(pixels[left + 2] - pixels[right + 2]);
      samples += 1;
    }
  } else {
    for (let x = region.left; x < region.right; x += sampleStride) {
      const top = ((coordinate - 1) * width + x) * 4;
      const bottom = top + width * 4;
      total += Math.abs(pixels[top] - pixels[bottom]) + Math.abs(pixels[top + 1] - pixels[bottom + 1]) + Math.abs(pixels[top + 2] - pixels[bottom + 2]);
      samples += 1;
    }
  }
  return total / Math.max(1, samples);
}

export function periodicBoundaryEnergy({ pixels, width, height, period = 64, region, sampleStride = 2, referenceOffsets = [-24, -16, -8, 8, 16, 24] }) {
  if (pixels.length !== width * height * 4 || !region || region.left < 1 || region.top < 1 || region.right > width || region.bottom > height || region.left >= region.right || region.top >= region.bottom) throw new Error("Invalid periodic-energy audit input");
  const orientationAudit = (orientation) => {
    const minimum = orientation === "vertical" ? region.left : region.top;
    const maximum = orientation === "vertical" ? region.right : region.bottom;
    const boundaryValues = [];
    const referenceValues = [];
    for (let coordinate = Math.ceil((minimum + 1) / period) * period; coordinate < maximum; coordinate += period) {
      boundaryValues.push(boundaryEnergy(pixels, width, orientation, coordinate, region, sampleStride));
      for (const offset of referenceOffsets) {
        const reference = coordinate + offset;
        if (reference <= minimum || reference >= maximum || reference % period === 0) continue;
        referenceValues.push(boundaryEnergy(pixels, width, orientation, reference, region, sampleStride));
      }
    }
    const boundaryMean = mean(boundaryValues);
    const referenceMean = mean(referenceValues);
    return { boundaryCount: boundaryValues.length, referenceCount: referenceValues.length, boundaryMean, referenceMean, ratio: boundaryMean / Math.max(1e-9, referenceMean) };
  };
  const vertical = orientationAudit("vertical");
  const horizontal = orientationAudit("horizontal");
  const boundaryMean = (vertical.boundaryMean * vertical.boundaryCount + horizontal.boundaryMean * horizontal.boundaryCount) / Math.max(1, vertical.boundaryCount + horizontal.boundaryCount);
  const referenceMean = (vertical.referenceMean * vertical.referenceCount + horizontal.referenceMean * horizontal.referenceCount) / Math.max(1, vertical.referenceCount + horizontal.referenceCount);
  return { period, sampleStride, region, boundaryMean, referenceMean, ratio: boundaryMean / Math.max(1e-9, referenceMean), vertical, horizontal };
}

function rectangleMean(pixels, width, rectangle) {
  let total = 0;
  let samples = 0;
  for (let y = rectangle.top; y < rectangle.bottom; y += 1) {
    for (let x = rectangle.left; x < rectangle.right; x += 1) {
      total += luminance(pixels, (y * width + x) * 4);
      samples += 1;
    }
  }
  return total / Math.max(1, samples);
}

export function macroBoundaryLuminance({ basePixels, composedPixels, width, height, bounds, strip = 16 }) {
  if (basePixels.length !== width * height * 4 || composedPixels.length !== width * height * 4 || bounds.x - strip < 0 || bounds.y - strip < 0 || bounds.x + bounds.width + strip > width || bounds.y + bounds.height + strip > height) throw new Error("Invalid macro-boundary audit input");
  const x0 = bounds.x;
  const y0 = bounds.y;
  const x1 = bounds.x + bounds.width;
  const y1 = bounds.y + bounds.height;
  const edges = {
    top: { outside: { left: x0 + strip, top: y0 - strip, right: x1 - strip, bottom: y0 }, inside: { left: x0 + strip, top: y0, right: x1 - strip, bottom: y0 + strip } },
    bottom: { outside: { left: x0 + strip, top: y1, right: x1 - strip, bottom: y1 + strip }, inside: { left: x0 + strip, top: y1 - strip, right: x1 - strip, bottom: y1 } },
    left: { outside: { left: x0 - strip, top: y0 + strip, right: x0, bottom: y1 - strip }, inside: { left: x0, top: y0 + strip, right: x0 + strip, bottom: y1 - strip } },
    right: { outside: { left: x1, top: y0 + strip, right: x1 + strip, bottom: y1 - strip }, inside: { left: x1 - strip, top: y0 + strip, right: x1, bottom: y1 - strip } },
  };
  const results = Object.fromEntries(Object.entries(edges).map(([edge, rectangles]) => {
    const baseOutside = rectangleMean(basePixels, width, rectangles.outside);
    const baseInside = rectangleMean(basePixels, width, rectangles.inside);
    const finalOutside = rectangleMean(composedPixels, width, rectangles.outside);
    const finalInside = rectangleMean(composedPixels, width, rectangles.inside);
    return [edge, {
      baseOutside,
      baseInside,
      finalOutside,
      finalInside,
      finalJump: Math.abs(finalInside - finalOutside),
      macroContributionJump: Math.abs((finalInside - baseInside) - (finalOutside - baseOutside)),
    }];
  }));
  const finalJumps = Object.values(results).map((edge) => edge.finalJump);
  const contributionJumps = Object.values(results).map((edge) => edge.macroContributionJump);
  return {
    strip,
    bounds,
    edges: results,
    meanFinalJump: mean(finalJumps),
    maxFinalJump: Math.max(...finalJumps),
    meanMacroContributionJump: mean(contributionJumps),
    maxMacroContributionJump: Math.max(...contributionJumps),
  };
}

export function perceptualHash({ pixels, width, height, sampleSize = 32, lowFrequencySize = 8 }) {
  if (pixels.length !== width * height * 4 || sampleSize < lowFrequencySize || lowFrequencySize * lowFrequencySize > 64) throw new Error("Invalid perceptual-hash input");
  const samples = new Float64Array(sampleSize * sampleSize);
  for (let sampleY = 0; sampleY < sampleSize; sampleY += 1) {
    const top = Math.floor(sampleY * height / sampleSize);
    const bottom = Math.max(top + 1, Math.floor((sampleY + 1) * height / sampleSize));
    for (let sampleX = 0; sampleX < sampleSize; sampleX += 1) {
      const left = Math.floor(sampleX * width / sampleSize);
      const right = Math.max(left + 1, Math.floor((sampleX + 1) * width / sampleSize));
      let total = 0;
      let count = 0;
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        total += luminance(pixels, (y * width + x) * 4);
        count += 1;
      }
      samples[sampleY * sampleSize + sampleX] = total / count;
    }
  }
  const coefficients = [];
  for (let frequencyY = 0; frequencyY < lowFrequencySize; frequencyY += 1) {
    for (let frequencyX = 0; frequencyX < lowFrequencySize; frequencyX += 1) {
      let coefficient = 0;
      for (let y = 0; y < sampleSize; y += 1) for (let x = 0; x < sampleSize; x += 1) {
        coefficient += samples[y * sampleSize + x]
          * Math.cos(Math.PI * (2 * x + 1) * frequencyX / (2 * sampleSize))
          * Math.cos(Math.PI * (2 * y + 1) * frequencyY / (2 * sampleSize));
      }
      coefficients.push(coefficient);
    }
  }
  const sorted = coefficients.slice(1).sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let hash = 0n;
  for (let index = 1; index < coefficients.length; index += 1) if (coefficients[index] > median) hash |= 1n << BigInt(63 - index);
  return hash.toString(16).padStart(16, "0");
}

export function hammingDistanceHex(left, right) {
  if (left.length !== right.length || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) throw new Error("Invalid hexadecimal hashes");
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
}
