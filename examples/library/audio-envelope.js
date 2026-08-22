/** Small deterministic oscillator/envelope primitives for Web Audio authoring. MIT. */
export function noteFrequency(note, tuning = 440) {
  if (!Number.isFinite(note) || !Number.isFinite(tuning) || tuning <= 0) throw new RangeError("Invalid note or tuning.");
  return tuning * 2 ** ((note - 69) / 12);
}

export function scheduleEnvelope(parameter, startTime, peak, { attack = 0.01, decay = 0.08, sustain = 0.6, release = 0.18, duration = 0.4 } = {}) {
  for (const value of [startTime, peak, attack, decay, sustain, release, duration]) if (!Number.isFinite(value) || value < 0) throw new RangeError("Invalid envelope value.");
  const releaseAt = startTime + Math.max(duration, attack + decay);
  parameter.cancelScheduledValues(startTime);
  parameter.setValueAtTime(0, startTime);
  parameter.linearRampToValueAtTime(peak, startTime + attack);
  parameter.linearRampToValueAtTime(peak * sustain, startTime + attack + decay);
  parameter.setValueAtTime(peak * sustain, releaseAt);
  parameter.linearRampToValueAtTime(0, releaseAt + release);
  return releaseAt + release;
}

export function oscillatorVoice(context, destination, options = {}) {
  const oscillator = new OscillatorNode(context, { type: options.type ?? "sine", frequency: options.frequency ?? 440 });
  const gain = new GainNode(context, { gain: 0 });
  oscillator.connect(gain).connect(destination);
  return { oscillator, gain };
}
