/** Fixed-timestep animation clock with explicit FPS and bounded catch-up. MIT. */
export function createFrameClock({ fps = 12, maxCatchUpFrames = 4, onFrame }) {
  if (!(fps > 0 && fps <= 240) || !Number.isSafeInteger(maxCatchUpFrames) || maxCatchUpFrames < 1) {
    throw new RangeError("Invalid frame-clock limits.");
  }
  const step = 1_000 / fps;
  let running = false;
  let request = 0;
  let previous = 0;
  let accumulator = 0;
  let frame = 0;
  const tick = (now) => {
    if (!running) return;
    if (previous === 0) previous = now;
    accumulator += Math.min(now - previous, step * maxCatchUpFrames);
    previous = now;
    let iterations = 0;
    while (accumulator >= step && iterations < maxCatchUpFrames) {
      onFrame({ frame, time: frame * step, delta: step });
      frame += 1;
      iterations += 1;
      accumulator -= step;
    }
    request = requestAnimationFrame(tick);
  };
  return {
    start() { if (!running) { running = true; request = requestAnimationFrame(tick); } },
    stop() { running = false; cancelAnimationFrame(request); previous = 0; accumulator = 0; },
    seek(nextFrame) { if (!Number.isSafeInteger(nextFrame) || nextFrame < 0) throw new RangeError("Invalid frame."); frame = nextFrame; },
    get frame() { return frame; },
  };
}
