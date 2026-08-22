// Keel audio reader demo.
//
// The human source remains the historical named Sonant-X JSON. Publication
// compiles it to keel-sonant-bits@1 (60 B Shot, 58 B Laser, 2.1 KB Theme), and
// this verified reader turns those bytes into deterministic stereo PCM.

import {
  KEEL_SOUND_BITS_CODEC,
  createAudioReader,
} from "/content/oca-readers.js";

const PATCHES = [
  { id: "shot", label: "Shot", accent: "#ff8ad4", resourceId: "shot.ocas" },
  { id: "laser", label: "Laser", accent: "#59e5ff", resourceId: "laser.ocas" },
  { id: "song", label: "Theme", accent: "#c6a1ff", resourceId: "song.ocas", loop: true },
];

const status = document.getElementById("status");
const rack = document.getElementById("rack");
const bootButton = document.getElementById("boot");
const buffers = new Map();
const handles = new Map();
let reader;
let bootPromise;

function setStatus(message) {
  status.textContent = message;
}

function soundSpec(patch) {
  return { codec: KEEL_SOUND_BITS_CODEC, resourceId: patch.resourceId };
}

function sampleEnergy(buffer) {
  let energy = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    const stride = Math.max(1, Math.floor(samples.length / 8192));
    for (let index = 0; index < samples.length; index += stride) {
      const sample = samples[index];
      if (!Number.isFinite(sample)) throw new Error("Synth produced non-finite PCM.");
      energy += sample * sample;
    }
  }
  if (energy <= 0.000001) throw new Error("Synth produced silent PCM.");
  return energy;
}

function play(patch) {
  if (reader === undefined) return;
  const buffer = buffers.get(patch.id);
  if (buffer === undefined) return;
  const previous = handles.get(patch.id);
  if (previous !== undefined) {
    try { previous.stop(); } catch { /* source already ended */ }
  }
  const handle = reader.playBuffer(buffer, { loop: patch.loop === true, gain: patch.id === "song" ? 0.5 : 0.85 });
  handles.set(patch.id, handle);
  document.documentElement.dataset.audioStarted = patch.id;
  document.documentElement.dataset.audioContext = reader.context.state;
  setStatus(`${patch.label} playing · ${buffer.duration.toFixed(2)}s · ${buffer.numberOfChannels}ch PCM @ ${buffer.sampleRate} Hz`);
}

async function boot() {
  if (bootPromise !== undefined) return bootPromise;
  bootPromise = (async () => {
    bootButton.disabled = true;
    bootButton.textContent = "Rendering…";
    setStatus("Unlocking audio and decoding verified bitstreams…");
    const runtime = globalThis.__KEEL_RUNTIME__;
    const seed = runtime?.context?.derivedTokenSeed ?? runtime?.manifestDigest ?? "oca-soundbox-live";
    reader = createAudioReader({
      content: globalThis.__KEEL_CONTENT__,
      noiseSeed: seed,
      maxSeconds: 180,
    });
    await reader.unlock();

    const summaries = [];
    for (const patch of PATCHES) {
      const started = performance.now();
      const sourceBytes = globalThis.__KEEL_CONTENT__.bytes(patch.resourceId);
      const buffer = reader.render(soundSpec(patch));
      sampleEnergy(buffer);
      buffers.set(patch.id, buffer);
      summaries.push(`${patch.label} ${sourceBytes.byteLength}B→${buffer.duration.toFixed(0)}s`);
      document.documentElement.dataset[`audio${patch.id[0].toUpperCase()}${patch.id.slice(1)}Ms`] = String(
        Math.round(performance.now() - started),
      );
    }

    rack.hidden = false;
    bootButton.hidden = true;
    document.documentElement.dataset.audioReady = "true";
    document.documentElement.dataset.audioContext = reader.context.state;
    setStatus(`${summaries.join(" · ")} · deterministic stereo PCM`);
    play(PATCHES[2]);
  })().catch((error) => {
    bootPromise = undefined;
    bootButton.disabled = false;
    bootButton.hidden = false;
    bootButton.textContent = "Retry audio";
    document.documentElement.dataset.audioReady = "false";
    setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
  return bootPromise;
}

for (const patch of PATCHES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = patch.label;
  button.style.setProperty("--accent", patch.accent);
  button.dataset.sound = patch.id;
  button.addEventListener("click", () => play(patch));
  rack.appendChild(button);
}

bootButton.addEventListener("click", () => {
  void boot().catch(() => undefined);
});

