/**
 * Small, verified-reader primitives for creator code.
 *
 * The API is deliberately declarative so a person or coding model can author
 * JSON, compile it to compact bytes, and use the same reader in a Keel
 * sandbox. Nothing in this module performs network I/O: callers provide the
 * manifest-scoped `__KEEL_CONTENT__` object.
 *
 * The Sonant renderer below is derived from Dominic Szablewski's pl_synth
 * (MIT, Copyright 2024-2025 Dominic Szablewski), itself based on Sonant.
 * It is adapted here to use a per-render deterministic noise seed, bounded
 * allocation, and the historical named Sonant-X JSON format used by OCA.
 */

export const KEEL_SOUND_BITS_CODEC = "keel-sonant-bits@1" as const;
export const KEEL_SPRITE_SOUND_SCHEMA = "keel-sprite-sounds@1" as const;
export const SONANT_LEGACY_JSON_CODEC = "sonant-x-legacy-json@1" as const;
export const KEEL_SPRITE_BITS_CODEC = "keel-sprite-bit-atlas@1" as const;
export const KEEL_GRID_SPRITE_CODEC = "keel-grid-sprite-sheet@1" as const;
export const KEEL_MATERIAL_BITS_CODEC = "keel-material-bits@1" as const;
export const KEEL_ATLAS_MATERIAL_BITS_CODEC =
  "keel-atlas-material-map@1" as const;
export const KEEL_TRAIT_BITS_CODEC = "keel-trait-catalog-bits@2" as const;
/** Append-only trait catalog. Options carry their introduction epoch so a
 * token can always resolve against the catalog revision it was minted with. */
export const KEEL_APPEND_ONLY_TRAIT_BITS_CODEC =
  "keel-trait-catalog-bits@3" as const;
export const KEEL_CHARACTER_METADATA_BITS_CODEC =
  "keel-character-metadata-bits@1" as const;

export interface KeelContentReader {
  readonly protocol: string;
  readonly manifestId: string;
  bytes(name: string): Uint8Array;
  text(name: string): string;
  json(name: string): unknown;
  integrity(name: string): string | undefined;
  url(name: string): string;
}

const SONANT_FIELDS = [
  "osc1_oct",
  "osc1_det",
  "osc1_detune",
  "osc1_xenv",
  "osc1_vol",
  "osc1_waveform",
  "osc2_oct",
  "osc2_det",
  "osc2_detune",
  "osc2_xenv",
  "osc2_vol",
  "osc2_waveform",
  "noise_fader",
  "env_attack",
  "env_sustain",
  "env_release",
  "env_master",
  "fx_filter",
  "fx_freq",
  "fx_resonance",
  "fx_delay_time",
  "fx_delay_amt",
  "fx_pan_freq",
  "fx_pan_amt",
  "lfo_osc1_freq",
  "lfo_fx_freq",
  "lfo_freq",
  "lfo_amt",
  "lfo_waveform",
] as const;

export type SonantField = (typeof SONANT_FIELDS)[number];

export interface SonantPattern {
  readonly n: readonly number[];
  readonly f?: readonly number[];
}

export type SonantTrack = Readonly<Record<SonantField, number>> & {
  readonly p: readonly number[];
  readonly c: readonly SonantPattern[];
};

export interface SonantLegacySong {
  readonly rowLen: number;
  readonly endPattern: number;
  readonly songLen?: number;
  readonly songData: readonly SonantTrack[];
}

export type CompactSonantInstrument = readonly number[];
export type CompactSonantTrack = readonly [
  instrument: CompactSonantInstrument,
  sequence: readonly number[],
  patterns: readonly (readonly number[])[],
];
export type CompactSonantSong = readonly [
  rowLength: number,
  tracks: readonly CompactSonantTrack[],
];

interface MutableSonantTrack extends Record<SonantField, number> {
  p: number[];
  c: Array<{ n: number[]; f?: number[] }>;
}

const MAX_SOUND_BYTES = 16 * 1024 * 1024;
const MAX_TRACKS = 64;
const MAX_SEQUENCE = 4096;
const MAX_PATTERNS = 1024;
const MAX_INTEGER = 0xffff_ffff;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  label: string,
  min = 0,
  max = MAX_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new RangeError(
      `${label} must be an integer from ${min} through ${max}.`,
    );
  }
  return value as number;
}

function integerArray(
  value: unknown,
  label: string,
  maxLength: number,
): number[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new TypeError(
      `${label} must be an array with at most ${maxLength} entries.`,
    );
  }
  return value.map((item, index) => integer(item, `${label}[${index}]`));
}

/** Parse and fully validate the historical named Sonant-X song schema. */
export function parseSonantLegacySong(value: unknown): SonantLegacySong {
  const source = record(value, "song");
  const rowLen = integer(source.rowLen, "song.rowLen", 1, 10_000_000);
  const endPattern = integer(source.endPattern, "song.endPattern", 0, 65_535);
  const songLen =
    source.songLen === undefined
      ? undefined
      : integer(source.songLen, "song.songLen", 1, 86_400);
  if (
    !Array.isArray(source.songData) ||
    source.songData.length === 0 ||
    source.songData.length > MAX_TRACKS
  ) {
    throw new TypeError(
      `song.songData must contain 1 through ${MAX_TRACKS} tracks.`,
    );
  }

  const songData = source.songData.map((candidate, trackIndex): SonantTrack => {
    const trackSource = record(candidate, `song.songData[${trackIndex}]`);
    const track = {} as MutableSonantTrack;
    for (const field of SONANT_FIELDS) {
      track[field] = integer(
        trackSource[field],
        `song.songData[${trackIndex}].${field}`,
        0,
        1_000_000,
      );
    }
    if (
      track.osc1_waveform > 3 ||
      track.osc2_waveform > 3 ||
      track.lfo_waveform > 3
    ) {
      throw new RangeError(
        `song.songData[${trackIndex}] contains an unsupported waveform.`,
      );
    }
    if (track.fx_filter > 4)
      throw new RangeError(
        `song.songData[${trackIndex}].fx_filter must be 0 through 4.`,
      );
    for (const field of [
      "osc1_vol",
      "osc2_vol",
      "noise_fader",
      "env_master",
      "fx_resonance",
      "fx_delay_amt",
      "fx_pan_amt",
      "lfo_amt",
    ] as const) {
      if (track[field] > 255)
        throw new RangeError(
          `song.songData[${trackIndex}].${field} must be 0 through 255.`,
        );
    }

    track.p = integerArray(
      trackSource.p,
      `song.songData[${trackIndex}].p`,
      MAX_SEQUENCE,
    );
    if (!Array.isArray(trackSource.c) || trackSource.c.length > MAX_PATTERNS) {
      throw new TypeError(
        `song.songData[${trackIndex}].c must contain at most ${MAX_PATTERNS} patterns.`,
      );
    }
    track.c = trackSource.c.map((patternValue, patternIndex) => {
      const pattern = record(
        patternValue,
        `song.songData[${trackIndex}].c[${patternIndex}]`,
      );
      const notes = integerArray(
        pattern.n,
        `song.songData[${trackIndex}].c[${patternIndex}].n`,
        128,
      );
      if (notes.length !== 32) {
        throw new RangeError(
          `song.songData[${trackIndex}].c[${patternIndex}].n must contain exactly 32 rows.`,
        );
      }
      const effects =
        pattern.f === undefined
          ? undefined
          : integerArray(
              pattern.f,
              `song.songData[${trackIndex}].c[${patternIndex}].f`,
              128,
            );
      if (effects !== undefined && effects.length !== 64) {
        throw new RangeError(
          `song.songData[${trackIndex}].c[${patternIndex}].f must contain exactly 64 values.`,
        );
      }
      return effects === undefined ? { n: notes } : { n: notes, f: effects };
    });
    for (
      let patternIndex = 0;
      patternIndex < track.p.length;
      patternIndex += 1
    ) {
      const selected = track.p[patternIndex] ?? 0;
      if (selected > track.c.length) {
        throw new RangeError(
          `song.songData[${trackIndex}].p[${patternIndex}] selects an unknown pattern.`,
        );
      }
    }
    return track;
  });

  return {
    rowLen,
    endPattern,
    ...(songLen === undefined ? {} : { songLen }),
    songData,
  };
}

class ByteWriter {
  readonly #values: number[] = [];

  byte(value: number): void {
    this.#values.push(integer(value, "byte", 0, 255));
  }

  raw(values: readonly number[] | Uint8Array): void {
    for (const value of values) this.byte(value);
  }

  varUint(value: number): void {
    let remaining = integer(value, "varuint");
    do {
      let next = remaining % 128;
      remaining = Math.floor(remaining / 128);
      if (remaining > 0) next |= 0x80;
      this.byte(next);
    } while (remaining > 0);
  }

  sparse(values: readonly number[]): void {
    this.varUint(values.length);
    const present: Array<readonly [number, number]> = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] ?? 0;
      if (value !== 0) present.push([index, value]);
    }
    this.varUint(present.length);
    let previous = -1;
    for (const [index, value] of present) {
      this.varUint(index - previous - 1);
      this.varUint(value);
      previous = index;
    }
  }

  text(value: string, label: string, maximumBytes = 255): void {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
      throw new RangeError(
        `${label} must contain 1 through ${maximumBytes} UTF-8 bytes.`,
      );
    }
    this.varUint(bytes.byteLength);
    this.raw(bytes);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#values);
  }
}

class ByteReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOUND_BYTES) {
      throw new RangeError(
        `Codec input must contain 1 through ${MAX_SOUND_BYTES} bytes.`,
      );
    }
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.#offset === this.#bytes.byteLength;
  }

  byte(): number {
    const value = this.#bytes[this.#offset];
    if (value === undefined)
      throw new RangeError("Unexpected end of codec input.");
    this.#offset += 1;
    return value;
  }

  raw(length: number): number[] {
    return Array.from({ length }, () => this.byte());
  }

  varUint(label = "varuint"): number {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * factor;
      if (value > MAX_INTEGER) throw new RangeError(`${label} exceeds uint32.`);
      if ((byte & 0x80) === 0) return value;
      factor *= 128;
    }
    throw new RangeError(`${label} uses a non-canonical varuint.`);
  }

  sparse(label: string, maxLength: number): number[] {
    const length = this.varUint(`${label}.length`);
    if (length > maxLength)
      throw new RangeError(`${label} exceeds ${maxLength} entries.`);
    const count = this.varUint(`${label}.count`);
    if (count > length)
      throw new RangeError(`${label} has more values than slots.`);
    const output = new Array<number>(length).fill(0);
    let previous = -1;
    for (let item = 0; item < count; item += 1) {
      const index = previous + 1 + this.varUint(`${label}.delta`);
      if (index >= length)
        throw new RangeError(`${label} sparse index is out of bounds.`);
      output[index] = this.varUint(`${label}.value`);
      previous = index;
    }
    return output;
  }

  text(label: string, maximumBytes = 255): string {
    const length = this.varUint(`${label}.length`);
    if (length === 0 || length > maximumBytes) {
      throw new RangeError(
        `${label} must contain 1 through ${maximumBytes} UTF-8 bytes.`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(this.raw(length)),
      );
    } catch {
      throw new TypeError(`${label} must be valid UTF-8.`);
    }
  }
}

const SOUND_MAGIC = [0x4f, 0x43, 0x41, 0x53] as const; // OCAS

/** Compile human-readable Sonant-X JSON into the compact on-chain bit codec. */
export function encodeSoundBits(value: unknown): Uint8Array {
  const song = parseSonantLegacySong(value);
  const writer = new ByteWriter();
  writer.raw(SOUND_MAGIC);
  writer.byte(1);
  writer.byte(song.songLen === undefined ? 0 : 1);
  writer.varUint(song.rowLen);
  writer.varUint(song.endPattern);
  if (song.songLen !== undefined) writer.varUint(song.songLen);
  writer.varUint(song.songData.length);
  for (const track of song.songData) {
    for (const field of SONANT_FIELDS) writer.varUint(track[field]);
    writer.sparse(track.p);
    writer.varUint(track.c.length);
    for (const pattern of track.c) {
      writer.sparse(pattern.n);
      writer.byte(pattern.f === undefined ? 0 : 1);
      if (pattern.f !== undefined) writer.sparse(pattern.f);
    }
  }
  return writer.finish();
}

/** Decode compact sound bytes back into the canonical human JSON shape. */
export function decodeSoundBits(bytes: Uint8Array): SonantLegacySong {
  const reader = new ByteReader(bytes);
  const magic = reader.raw(SOUND_MAGIC.length);
  if (!magic.every((value, index) => value === SOUND_MAGIC[index]))
    throw new TypeError("Not a Keel sound bitstream.");
  if (reader.byte() !== 1)
    throw new TypeError("Unsupported Keel sound bitstream version.");
  const flags = reader.byte();
  if ((flags & ~1) !== 0)
    throw new TypeError("Unsupported Keel sound bitstream flags.");
  const rowLen = reader.varUint("rowLen");
  const endPattern = reader.varUint("endPattern");
  const songLen = (flags & 1) === 0 ? undefined : reader.varUint("songLen");
  const trackCount = reader.varUint("trackCount");
  if (trackCount === 0 || trackCount > MAX_TRACKS)
    throw new RangeError(`trackCount must be 1 through ${MAX_TRACKS}.`);

  const songData: MutableSonantTrack[] = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const track = {} as MutableSonantTrack;
    for (const field of SONANT_FIELDS)
      track[field] = reader.varUint(`track[${trackIndex}].${field}`);
    track.p = reader.sparse(`track[${trackIndex}].p`, MAX_SEQUENCE);
    const patternCount = reader.varUint(`track[${trackIndex}].patternCount`);
    if (patternCount > MAX_PATTERNS)
      throw new RangeError(`track[${trackIndex}] has too many patterns.`);
    track.c = [];
    for (let patternIndex = 0; patternIndex < patternCount; patternIndex += 1) {
      const n = reader.sparse(`track[${trackIndex}].c[${patternIndex}].n`, 128);
      const effectFlag = reader.byte();
      if (effectFlag > 1)
        throw new TypeError("Unsupported pattern effect flag.");
      const f =
        effectFlag === 0
          ? undefined
          : reader.sparse(`track[${trackIndex}].c[${patternIndex}].f`, 128);
      track.c.push(f === undefined ? { n } : { n, f });
    }
    songData.push(track);
  }
  if (!reader.done)
    throw new TypeError("Trailing bytes after Keel sound bitstream.");
  return parseSonantLegacySong({
    rowLen,
    endPattern,
    ...(songLen === undefined ? {} : { songLen }),
    songData,
  });
}

/** Convert the named legacy JSON shape into pl_synth's compact array shape. */
export function compactSonantSong(value: unknown): CompactSonantSong {
  const song = parseSonantLegacySong(value);
  return [
    song.rowLen,
    song.songData.map(
      (track) =>
        [
          SONANT_FIELDS.map((field) => track[field]),
          [...track.p],
          track.c.map((pattern) => [...pattern.n]),
        ] as const,
    ),
  ];
}

function seed32(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value)) return value >>> 0;
  const text = String(value ?? "oca-audio");
  let state = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return state >>> 0 || 0x9e3779b9;
}

function estimateSongSamples(song: CompactSonantSong): number {
  const [rowLen, tracks] = song;
  let maximum = 0;
  for (const [instrument, sequence] of tracks) {
    const envelope =
      (instrument[13] ?? 0) + (instrument[14] ?? 0) + (instrument[15] ?? 0);
    const delay = Math.max(0, (instrument[20] ?? 0) * rowLen * 4);
    maximum = Math.max(
      maximum,
      sequence.length * rowLen * 32 + envelope + delay,
    );
  }
  return maximum;
}

/**
 * Deterministic Sonant renderer adapted from pl_synth. A new renderer is made
 * for every buffer so noise never depends on the order buttons were clicked.
 */
function renderSonantSong(
  context: BaseAudioContext,
  song: CompactSonantSong,
  noiseSeed: number,
  maxSamples: number,
  declaredSamples?: number,
): AudioBuffer {
  const sampleRate = 44_100;
  const tableSize = 4096;
  const tableMask = tableSize - 1;
  const table = new Float32Array(tableSize * 4);
  for (let index = 0; index < tableSize; index += 1) {
    const sine = Math.sin((index * Math.PI * 2) / tableSize);
    table[index] = sine;
    table[index + tableSize] = sine < 0 ? -1 : 1;
    table[index + tableSize * 2] = index / tableSize - 0.5;
    table[index + tableSize * 3] =
      index < tableSize / 2
        ? index / (tableSize / 4) - 1
        : 3 - index / (tableSize / 4);
  }

  const [rowLen, tracks] = song;
  const sampleCount = Math.max(estimateSongSamples(song), declaredSamples ?? 0);
  if (sampleCount <= 0 || sampleCount > maxSamples) {
    throw new RangeError(
      `Rendered song requires ${sampleCount} samples; limit is ${maxSamples}.`,
    );
  }
  const output = context.createBuffer(2, sampleCount, sampleRate);
  const outputLeft = output.getChannelData(0);
  const outputRight = output.getChannelData(1);
  let randomState = noiseSeed >>> 0 || 0x9e3779b9;

  const generate = (
    instrument: CompactSonantInstrument,
    note: number,
    left: Float32Array,
    right: Float32Array,
    writePosition: number,
  ): void => {
    const parameter = (index: number): number => instrument[index] ?? 0;
    const attack = parameter(13);
    const sustain = parameter(14);
    const release = parameter(15);
    const envelopeSamples = attack + sustain + release;
    const osc1Frequency =
      Math.pow(
        1.059463094,
        note + (parameter(0) - 8) * 12 + parameter(1) - 128,
      ) *
      0.00390625 *
      (1 + 0.0008 * parameter(2));
    const osc2Frequency =
      Math.pow(
        1.059463094,
        note + (parameter(6) - 8) * 12 + parameter(7) - 128,
      ) *
      0.00390625 *
      (1 + 0.0008 * parameter(8));
    const lfoOffset = parameter(28) * tableSize;
    const osc1Offset = parameter(5) * tableSize;
    const osc2Offset = parameter(11) * tableSize;
    const panFrequency = Math.pow(2, parameter(22) - 8) / rowLen;
    const panAmount = parameter(23) / 512;
    const lfoAmount = parameter(27) / 512;
    const lfoFrequency = (Math.pow(2, parameter(26) - 8) / rowLen) * tableSize;
    const resonance = parameter(19) / 255;
    const noiseVolume = parameter(12) * 4.6566e-10;
    let osc1Position = 0;
    let osc2Position = 0;
    let low = 0;
    let band = 0;

    for (let sampleIndex = 0; sampleIndex < envelopeSamples; sampleIndex += 1) {
      const target = writePosition + sampleIndex;
      if (target >= left.length) break;
      const lfo =
        (table[lfoOffset + ((target * lfoFrequency) & tableMask)] ?? 0) *
          lfoAmount +
        0.5;
      let envelope = 1;
      if (attack > 0 && sampleIndex < attack) envelope = sampleIndex / attack;
      else if (release > 0 && sampleIndex >= attack + sustain) {
        envelope = 1 - (sampleIndex - attack - sustain) / release;
      }

      let osc1Step = osc1Frequency;
      if (parameter(24) !== 0) osc1Step *= lfo;
      if (parameter(3) !== 0) osc1Step *= envelope * envelope;
      osc1Position += osc1Step;
      let sample =
        (table[osc1Offset + ((osc1Position * tableSize) & tableMask)] ?? 0) *
        parameter(4);

      let osc2Step = osc2Frequency;
      if (parameter(9) !== 0) osc2Step *= envelope * envelope;
      osc2Position += osc2Step;
      sample +=
        (table[osc2Offset + ((osc2Position * tableSize) & tableMask)] ?? 0) *
        parameter(10);

      if (parameter(12) !== 0) {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        sample += (randomState | 0) * noiseVolume * envelope;
      }
      sample *= envelope / 255;

      const filter = parameter(17);
      if (filter !== 0) {
        let frequency = parameter(18);
        if (parameter(25) !== 0) frequency *= lfo;
        frequency =
          1.5 *
          (table[(frequency * (0.5 / sampleRate) * tableSize) & tableMask] ??
            0);
        low += frequency * band;
        const high = resonance * (sample - band) - low;
        band += frequency * high;
        sample = [sample, high, low, band, low + high][filter] ?? sample;
      }

      const pan =
        (table[(target * panFrequency * tableSize) & tableMask] ?? 0) *
          panAmount +
        0.5;
      sample *= 0.00238 * parameter(16);
      left[target] = (left[target] ?? 0) + sample * (1 - pan);
      right[target] = (right[target] ?? 0) + sample * pan;
    }
  };

  for (const [instrument, sequence, patterns] of tracks) {
    const trackLeft = new Float32Array(sampleCount);
    const trackRight = new Float32Array(sampleCount);
    let writePosition = 0;
    let first = sampleCount;
    for (const patternId of sequence) {
      const pattern = patternId === 0 ? undefined : patterns[patternId - 1];
      for (let row = 0; row < 32; row += 1) {
        const note = pattern?.[row] ?? 0;
        if (note !== 0) {
          first = Math.min(first, writePosition);
          generate(instrument, note, trackLeft, trackRight, writePosition);
        }
        writePosition += rowLen;
      }
    }

    const delayAmount = (instrument[21] ?? 0) / 255;
    const delayShift = ((instrument[20] ?? 0) * rowLen) >> 1;
    if (delayAmount > 0 && delayShift > 0 && first < sampleCount) {
      for (
        let source = first, target = first + delayShift;
        target < sampleCount;
        source += 1, target += 1
      ) {
        trackLeft[target] =
          (trackLeft[target] ?? 0) + (trackRight[source] ?? 0) * delayAmount;
        trackRight[target] =
          (trackRight[target] ?? 0) + (trackLeft[source] ?? 0) * delayAmount;
      }
    }
    if (first < sampleCount) {
      for (let index = first; index < sampleCount; index += 1) {
        outputLeft[index] = (outputLeft[index] ?? 0) + (trackLeft[index] ?? 0);
        outputRight[index] =
          (outputRight[index] ?? 0) + (trackRight[index] ?? 0);
      }
    }
  }
  return output;
}

export type AudioReaderSpec =
  | {
      readonly codec: typeof SONANT_LEGACY_JSON_CODEC;
      readonly resourceId: string;
    }
  | {
      readonly codec: typeof KEEL_SOUND_BITS_CODEC;
      readonly resourceId: string;
    };

export function parseAudioReaderSpec(value: unknown): AudioReaderSpec {
  const source = record(value, "audio reader spec");
  const codec = source.codec;
  const resourceId = source.resourceId;
  if (codec !== SONANT_LEGACY_JSON_CODEC && codec !== KEEL_SOUND_BITS_CODEC) {
    throw new TypeError("Unsupported audio reader codec.");
  }
  if (
    typeof resourceId !== "string" ||
    resourceId.length === 0 ||
    resourceId.length > 256
  ) {
    throw new TypeError("audio reader resourceId must be a non-empty string.");
  }
  return { codec, resourceId };
}

export interface AudioPlaybackHandle {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  stop(when?: number): void;
  setGain(value: number, when?: number): void;
}

export interface KeelAudioReader {
  readonly context: AudioContext;
  unlock(): Promise<void>;
  load(spec: AudioReaderSpec): SonantLegacySong;
  render(specOrSong: AudioReaderSpec | SonantLegacySong): AudioBuffer;
  playBuffer(
    buffer: AudioBuffer,
    options?: {
      readonly loop?: boolean;
      readonly gain?: number;
      readonly rate?: number;
      readonly when?: number;
    },
  ): AudioPlaybackHandle;
  play(
    specOrSong: AudioReaderSpec | SonantLegacySong,
    options?: {
      readonly loop?: boolean;
      readonly gain?: number;
      readonly rate?: number;
      readonly when?: number;
    },
  ): Promise<AudioPlaybackHandle>;
  stopAll(): void;
  dispose(): Promise<void>;
}

/** Create the AI-friendly runtime audio API used inside a verified reader. */
export function createAudioReader(options: {
  readonly content: KeelContentReader;
  readonly noiseSeed?: string | number;
  readonly maxSeconds?: number;
  readonly context?: AudioContext;
  readonly createContext?: () => AudioContext;
}): KeelAudioReader {
  const AudioContextConstructor =
    globalThis.AudioContext ??
    (
      globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  const context =
    options.context ??
    options.createContext?.() ??
    (AudioContextConstructor === undefined
      ? undefined
      : new AudioContextConstructor({ sampleRate: 44_100 }));
  if (context === undefined)
    throw new Error("Web Audio is unavailable in this reader.");
  const maxSeconds = options.maxSeconds ?? 180;
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 600) {
    throw new RangeError(
      "maxSeconds must be greater than 0 and no more than 600.",
    );
  }
  const maxSamples = Math.floor(maxSeconds * 44_100);
  const active = new Set<AudioBufferSourceNode>();

  const load = (spec: AudioReaderSpec): SonantLegacySong => {
    const parsed = parseAudioReaderSpec(spec);
    return parsed.codec === KEEL_SOUND_BITS_CODEC
      ? decodeSoundBits(options.content.bytes(parsed.resourceId))
      : parseSonantLegacySong(options.content.json(parsed.resourceId));
  };
  const song = (input: AudioReaderSpec | SonantLegacySong): SonantLegacySong =>
    "codec" in input ? load(input) : parseSonantLegacySong(input);
  const render = (input: AudioReaderSpec | SonantLegacySong): AudioBuffer => {
    const parsed = song(input);
    return renderSonantSong(
      context,
      compactSonantSong(parsed),
      seed32(options.noiseSeed),
      maxSamples,
      parsed.songLen === undefined ? undefined : parsed.songLen * 44_100,
    );
  };
  const playBuffer = (
    buffer: AudioBuffer,
    playback: {
      readonly loop?: boolean;
      readonly gain?: number;
      readonly rate?: number;
      readonly when?: number;
    } = {},
  ): AudioPlaybackHandle => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    const amount = playback.gain ?? 1;
    const rate = playback.rate ?? 1;
    if (!Number.isFinite(amount) || amount < 0 || amount > 4)
      throw new RangeError("gain must be from 0 through 4.");
    if (!Number.isFinite(rate) || rate <= 0 || rate > 4)
      throw new RangeError("rate must be greater than 0 and no more than 4.");
    gain.gain.value = amount;
    source.playbackRate.value = rate;
    source.loop = playback.loop ?? false;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(context.destination);
    active.add(source);
    source.addEventListener("ended", () => active.delete(source), {
      once: true,
    });
    source.start(playback.when ?? 0);
    return {
      source,
      gain,
      stop: (when = 0) => source.stop(when),
      setGain: (value, when = context.currentTime) => {
        if (!Number.isFinite(value) || value < 0 || value > 4)
          throw new RangeError("gain must be from 0 through 4.");
        gain.gain.setValueAtTime(value, when);
      },
    };
  };

  return {
    context,
    async unlock(): Promise<void> {
      if (context.state !== "running") await context.resume();
      if (context.state !== "running")
        throw new Error(`AudioContext remained ${context.state}.`);
    },
    load,
    render,
    playBuffer,
    async play(input, playback = {}): Promise<AudioPlaybackHandle> {
      if (context.state !== "running") await context.resume();
      return playBuffer(render(input), playback);
    },
    stopAll(): void {
      for (const source of active) {
        try {
          source.stop();
        } catch {
          /* already ended */
        }
      }
      active.clear();
    },
    async dispose(): Promise<void> {
      this.stopAll();
      if (context.state !== "closed") await context.close();
    },
  };
}

export interface SpriteSoundVariation {
  readonly soundId: string;
  readonly resourceId: string;
  readonly codec: typeof KEEL_SOUND_BITS_CODEC;
  readonly weight: number;
  readonly gain: number;
  readonly rate: number;
}

export interface SpriteSoundEvent {
  readonly eventId: string;
  readonly retriggerMs: number;
  readonly variations: readonly SpriteSoundVariation[];
}

export interface SpriteSoundProfile {
  readonly soundProfileId: number;
  readonly id: string;
  readonly assetId: string;
  readonly events: readonly SpriteSoundEvent[];
}

export interface SpriteSoundCatalog {
  readonly schema: typeof KEEL_SPRITE_SOUND_SCHEMA;
  readonly storage: "keel-object-revision";
  readonly profiles: readonly SpriteSoundProfile[];
}

function soundString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${label} must be a non-empty string of at most 256 characters.`);
  }
  return value;
}

/** Parse the generic event-to-sound assignments attached to any Keel sprite asset. */
export function parseSpriteSoundCatalog(value: unknown): SpriteSoundCatalog {
  const source = record(value, "sprite sound catalog");
  if (source.schema !== KEEL_SPRITE_SOUND_SCHEMA) {
    throw new TypeError("Unsupported sprite sound catalog schema.");
  }
  if (source.storage !== "keel-object-revision") {
    throw new TypeError("Sprite sound catalogs must use Keel object revisions.");
  }
  if (!Array.isArray(source.profiles) || source.profiles.length > 65_535) {
    throw new TypeError("sprite sound profiles must be an array with at most 65535 entries.");
  }
  const profileIds = new Set<number>();
  const assetIds = new Set<string>();
  const profiles = source.profiles.map((candidate, profileIndex): SpriteSoundProfile => {
    const profile = record(candidate, `profiles[${profileIndex}]`);
    const soundProfileId = integer(profile.soundProfileId, `profiles[${profileIndex}].soundProfileId`, 0, 0xffff_ffff);
    const id = soundString(profile.id, `profiles[${profileIndex}].id`);
    const assetId = soundString(profile.assetId, `profiles[${profileIndex}].assetId`);
    if (profileIds.has(soundProfileId)) throw new TypeError(`Duplicate soundProfileId ${soundProfileId}.`);
    if (assetIds.has(assetId)) throw new TypeError(`Duplicate sprite sound assetId ${assetId}.`);
    profileIds.add(soundProfileId);
    assetIds.add(assetId);
    if (!Array.isArray(profile.events) || profile.events.length === 0 || profile.events.length > 256) {
      throw new TypeError(`profiles[${profileIndex}].events must contain 1 through 256 events.`);
    }
    const eventIds = new Set<string>();
    const events = profile.events.map((eventValue, eventIndex): SpriteSoundEvent => {
      const event = record(eventValue, `profiles[${profileIndex}].events[${eventIndex}]`);
      const eventId = soundString(event.eventId, `profiles[${profileIndex}].events[${eventIndex}].eventId`);
      if (eventIds.has(eventId)) throw new TypeError(`Duplicate sprite sound event ${assetId}:${eventId}.`);
      eventIds.add(eventId);
      const retriggerMs = integer(event.retriggerMs, `profiles[${profileIndex}].events[${eventIndex}].retriggerMs`, 0, 60_000);
      if (!Array.isArray(event.variations) || event.variations.length === 0 || event.variations.length > 256) {
        throw new TypeError(`profiles[${profileIndex}].events[${eventIndex}].variations must contain 1 through 256 sounds.`);
      }
      const soundIds = new Set<string>();
      const variations = event.variations.map((variationValue, variationIndex): SpriteSoundVariation => {
        const variation = record(variationValue, `profiles[${profileIndex}].events[${eventIndex}].variations[${variationIndex}]`);
        const soundId = soundString(variation.soundId, `profiles[${profileIndex}].events[${eventIndex}].variations[${variationIndex}].soundId`);
        if (soundIds.has(soundId)) throw new TypeError(`Duplicate sprite sound variation ${assetId}:${eventId}:${soundId}.`);
        soundIds.add(soundId);
        if (variation.codec !== KEEL_SOUND_BITS_CODEC) throw new TypeError(`Unsupported codec for ${soundId}.`);
        const gain = variation.gain === undefined ? 1 : Number(variation.gain);
        const rate = variation.rate === undefined ? 1 : Number(variation.rate);
        if (!Number.isFinite(gain) || gain < 0 || gain > 4) throw new RangeError(`${soundId}.gain must be from 0 through 4.`);
        if (!Number.isFinite(rate) || rate <= 0 || rate > 4) throw new RangeError(`${soundId}.rate must be greater than 0 and no more than 4.`);
        return {
          soundId,
          resourceId: soundString(variation.resourceId, `${soundId}.resourceId`),
          codec: KEEL_SOUND_BITS_CODEC,
          weight: integer(variation.weight, `${soundId}.weight`, 1, 0xffff_ffff),
          gain,
          rate,
        };
      });
      const totalWeight = variations.reduce((total, variation) => total + variation.weight, 0);
      if (!Number.isSafeInteger(totalWeight) || totalWeight > 0xffff_ffff) {
        throw new RangeError(`${assetId}:${eventId} sound weights exceed uint32.`);
      }
      return { eventId, retriggerMs, variations };
    });
    return { soundProfileId, id, assetId, events };
  });
  return { schema: KEEL_SPRITE_SOUND_SCHEMA, storage: "keel-object-revision", profiles };
}

/** Resolve one deterministic variation for a sprite event. The profile itself
 * is pinned by the asset's exact Keel object revision, so later catalog
 * appends cannot alter previously published assignments. */
export function resolveSpriteSound(
  catalogValue: unknown,
  assetId: string,
  eventId: string,
  seed: string | number,
  occurrence = 0,
): { readonly profile: SpriteSoundProfile; readonly event: SpriteSoundEvent; readonly sound: SpriteSoundVariation } {
  const catalog = parseSpriteSoundCatalog(catalogValue);
  const profile = catalog.profiles.find((candidate) => candidate.assetId === assetId);
  if (profile === undefined) throw new RangeError(`No sprite sound profile for asset ${assetId}.`);
  const event = profile.events.find((candidate) => candidate.eventId === eventId);
  if (event === undefined) throw new RangeError(`No sprite sound event ${assetId}:${eventId}.`);
  const totalWeight = event.variations.reduce((total, variation) => total + variation.weight, 0);
  let target = seed32(`${seed}:sprite-sound:${profile.soundProfileId}:${eventId}:${integer(occurrence, "sound occurrence")}`) % totalWeight;
  const sound = event.variations.find((variation) => {
    if (target < variation.weight) return true;
    target -= variation.weight;
    return false;
  });
  if (sound === undefined) throw new Error("Sprite sound selection overflowed its weight table.");
  return { profile, event, sound };
}

export interface SpriteFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly originX?: number;
  readonly originY?: number;
}

export interface SpriteAtlas {
  readonly codec:
    | typeof KEEL_SPRITE_BITS_CODEC
    | typeof KEEL_GRID_SPRITE_CODEC
    | "keel-json-sprite-atlas@1";
  readonly frames: readonly SpriteFrame[];
}

export interface SpriteFrameInput {
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
  readonly originX?: number;
  readonly originY?: number;
}

export interface PackedSpriteAtlas {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly atlas: SpriteAtlas;
}

export interface DirectionalAnimationClip {
  readonly id: string;
  readonly frames: number;
  readonly fps?: number;
}

export interface DirectionalAnimationRow {
  readonly clipId: string;
  readonly direction: string;
  readonly row: number;
  readonly frameOffset: number;
  readonly frameCount: number;
}

export interface DirectionalAnimationAtlas {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly columns: number;
  readonly rows: readonly DirectionalAnimationRow[];
  readonly atlas: SpriteAtlas;
}

export interface SpritePixelBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly visiblePixels: number;
}

export interface DirectionalFrameInspection {
  readonly clipId: string;
  readonly direction: string;
  readonly row: number;
  readonly frame: number;
  readonly expected: boolean;
  readonly bounds?: SpritePixelBounds;
}

export interface DirectionalAtlasInspection {
  readonly complete: boolean;
  readonly expectedFrames: number;
  readonly occupiedFrames: number;
  readonly missingFrames: readonly string[];
  readonly unexpectedCells: readonly string[];
  readonly frames: readonly DirectionalFrameInspection[];
}

const SPRITE_MAGIC = [0x4f, 0x43, 0x41, 0x41] as const; // OCAA

/** Build equal-sized, left-to-right/top-to-bottom frame rectangles. */
export function createGridSpriteAtlas(options: {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly count?: number;
  readonly fps?: number;
}): SpriteAtlas {
  const imageWidth = integer(options.imageWidth, "imageWidth", 1, 65_535);
  const imageHeight = integer(options.imageHeight, "imageHeight", 1, 65_535);
  const frameWidth = integer(options.frameWidth, "frameWidth", 1, imageWidth);
  const frameHeight = integer(
    options.frameHeight,
    "frameHeight",
    1,
    imageHeight,
  );
  if (imageWidth % frameWidth !== 0 || imageHeight % frameHeight !== 0) {
    throw new RangeError(
      "Frame dimensions must divide the image dimensions exactly.",
    );
  }
  const columns = imageWidth / frameWidth;
  const rows = imageHeight / frameHeight;
  const available = columns * rows;
  const count =
    options.count === undefined
      ? available
      : integer(options.count, "count", 1, available);
  const fps = options.fps ?? 8;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240)
    throw new RangeError("fps must be greater than 0 and no more than 240.");
  const durationMs = Math.max(1, Math.round(1000 / fps));
  return {
    codec: KEEL_GRID_SPRITE_CODEC,
    frames: Array.from({ length: count }, (_, index) => ({
      x: (index % columns) * frameWidth,
      y: Math.floor(index / columns) * frameHeight,
      width: frameWidth,
      height: frameHeight,
      durationMs,
    })),
  };
}

/**
 * Deterministically shelf-pack variable-size frames in their declared order.
 * The returned rectangles can be encoded with `encodeSpriteBitAtlas`; callers
 * composite the matching source pixels into the reported image dimensions.
 */
export function packSpriteFrames(options: {
  readonly frames: readonly SpriteFrameInput[];
  readonly maxWidth: number;
  readonly padding?: number;
  readonly defaultDurationMs?: number;
}): PackedSpriteAtlas {
  if (options.frames.length === 0 || options.frames.length > 4096) {
    throw new RangeError("Sprite packer requires 1 through 4096 frames.");
  }
  const maxWidth = integer(options.maxWidth, "maxWidth", 1, 65_535);
  const padding = integer(options.padding ?? 0, "padding", 0, 255);
  const defaultDurationMs = integer(
    options.defaultDurationMs ?? 100,
    "defaultDurationMs",
    1,
    60_000,
  );
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let usedWidth = 0;
  const frames = options.frames.map((candidate, index): SpriteFrame => {
    const width = integer(candidate.width, `frames[${index}].width`, 1, 65_535);
    const height = integer(
      candidate.height,
      `frames[${index}].height`,
      1,
      65_535,
    );
    if (width > maxWidth)
      throw new RangeError(`frames[${index}].width exceeds maxWidth.`);
    if (x > 0 && x + width > maxWidth) {
      y += rowHeight + padding;
      x = 0;
      rowHeight = 0;
    }
    const frame: SpriteFrame = {
      x,
      y,
      width,
      height,
      durationMs: integer(
        candidate.durationMs ?? defaultDurationMs,
        `frames[${index}].durationMs`,
        1,
        60_000,
      ),
      ...(candidate.originX === undefined
        ? {}
        : {
            originX: integer(
              candidate.originX,
              `frames[${index}].originX`,
              0,
              65_535,
            ),
          }),
      ...(candidate.originY === undefined
        ? {}
        : {
            originY: integer(
              candidate.originY,
              `frames[${index}].originY`,
              0,
              65_535,
            ),
          }),
    };
    x += width + padding;
    rowHeight = Math.max(rowHeight, height);
    usedWidth = Math.max(usedWidth, x - padding);
    return frame;
  });
  return {
    imageWidth: usedWidth,
    imageHeight: y + rowHeight,
    atlas: { codec: KEEL_SPRITE_BITS_CODEC, frames },
  };
}

/**
 * Build the canonical authoring grid used by every layered character asset.
 * Frame order is clip, then direction, then frame; short clips leave trailing
 * grid cells empty without changing any other row's coordinates.
 */
export function createDirectionalAnimationAtlas(options: {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly directions: readonly string[];
  readonly clips: readonly DirectionalAnimationClip[];
  readonly defaultFps?: number;
}): DirectionalAnimationAtlas {
  const frameWidth = integer(options.frameWidth, "frameWidth", 1, 65_535);
  const frameHeight = integer(options.frameHeight, "frameHeight", 1, 65_535);
  if (options.directions.length === 0 || options.directions.length > 16) {
    throw new RangeError("directions must contain 1 through 16 entries.");
  }
  if (options.clips.length === 0 || options.clips.length > 64) {
    throw new RangeError("clips must contain 1 through 64 entries.");
  }
  const safeLabel = (value: string, label: string): string => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/u.test(value))
      throw new TypeError(`${label} is not a safe identifier.`);
    return value;
  };
  const directions = options.directions.map((value, index) =>
    safeLabel(value, `directions[${index}]`),
  );
  if (new Set(directions).size !== directions.length)
    throw new RangeError("directions must be unique.");
  const defaultFps = integer(options.defaultFps ?? 8, "defaultFps", 1, 240);
  const clips = options.clips.map((clip, index) => ({
    id: safeLabel(clip.id, `clips[${index}].id`),
    frames: integer(clip.frames, `clips[${index}].frames`, 1, 256),
    fps: integer(clip.fps ?? defaultFps, `clips[${index}].fps`, 1, 240),
  }));
  if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
    throw new RangeError("clip IDs must be unique.");
  const columns = Math.max(...clips.map((clip) => clip.frames));
  const rows: DirectionalAnimationRow[] = [];
  const frames: SpriteFrame[] = [];
  for (const [clipIndex, clip] of clips.entries()) {
    for (const [directionIndex, direction] of directions.entries()) {
      const row = clipIndex * directions.length + directionIndex;
      const frameOffset = frames.length;
      rows.push({
        clipId: clip.id,
        direction,
        row,
        frameOffset,
        frameCount: clip.frames,
      });
      for (let frame = 0; frame < clip.frames; frame += 1) {
        frames.push({
          x: frame * frameWidth,
          y: row * frameHeight,
          width: frameWidth,
          height: frameHeight,
          durationMs: Math.max(1, Math.round(1000 / clip.fps)),
        });
      }
    }
  }
  return {
    imageWidth: columns * frameWidth,
    imageHeight: rows.length * frameHeight,
    columns,
    rows,
    atlas: { codec: KEEL_GRID_SPRITE_CODEC, frames },
  };
}

/** Inspect decoded RGBA pixels against a canonical directional animation grid. */
export function inspectDirectionalAnimationAtlasPixels(options: {
  readonly pixels: Uint8Array | Uint8ClampedArray;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly layout: DirectionalAnimationAtlas;
  readonly alphaThreshold?: number;
}): DirectionalAtlasInspection {
  const imageWidth = integer(options.imageWidth, "imageWidth", 1, 65_535);
  const imageHeight = integer(options.imageHeight, "imageHeight", 1, 65_535);
  if (
    imageWidth !== options.layout.imageWidth ||
    imageHeight !== options.layout.imageHeight
  ) {
    throw new RangeError(
      `Atlas must be ${options.layout.imageWidth}x${options.layout.imageHeight}; received ${imageWidth}x${imageHeight}.`,
    );
  }
  if (options.pixels.byteLength !== imageWidth * imageHeight * 4) {
    throw new RangeError(
      "Atlas pixel length does not match its RGBA dimensions.",
    );
  }
  const alphaThreshold = integer(
    options.alphaThreshold ?? 8,
    "alphaThreshold",
    0,
    255,
  );
  const frameWidth = options.layout.atlas.frames[0]?.width;
  const frameHeight = options.layout.atlas.frames[0]?.height;
  if (frameWidth === undefined || frameHeight === undefined)
    throw new RangeError("Directional atlas has no frames.");
  const frames: DirectionalFrameInspection[] = [];
  const missingFrames: string[] = [];
  const unexpectedCells: string[] = [];
  let occupiedFrames = 0;
  for (const row of options.layout.rows) {
    for (let frame = 0; frame < options.layout.columns; frame += 1) {
      let left = frameWidth;
      let right = -1;
      let top = frameHeight;
      let bottom = -1;
      let visiblePixels = 0;
      for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
          const atlasX = frame * frameWidth + x;
          const atlasY = row.row * frameHeight + y;
          const alpha =
            options.pixels[(atlasY * imageWidth + atlasX) * 4 + 3] ?? 0;
          if (alpha < alphaThreshold) continue;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          visiblePixels += 1;
        }
      }
      const expected = frame < row.frameCount;
      const key = `${row.clipId}/${row.direction}/${frame}`;
      if (visiblePixels === 0) {
        if (expected) missingFrames.push(key);
        frames.push({
          clipId: row.clipId,
          direction: row.direction,
          row: row.row,
          frame,
          expected,
        });
        continue;
      }
      occupiedFrames += expected ? 1 : 0;
      if (!expected) unexpectedCells.push(key);
      frames.push({
        clipId: row.clipId,
        direction: row.direction,
        row: row.row,
        frame,
        expected,
        bounds: {
          left,
          top,
          right,
          bottom,
          width: right - left + 1,
          height: bottom - top + 1,
          centerX: (left + right) / 2,
          centerY: (top + bottom) / 2,
          visiblePixels,
        },
      });
    }
  }
  return {
    complete: missingFrames.length === 0 && unexpectedCells.length === 0,
    expectedFrames: options.layout.atlas.frames.length,
    occupiedFrames,
    missingFrames,
    unexpectedCells,
    frames,
  };
}

function parseSpriteFrame(value: unknown, label: string): SpriteFrame {
  const source = record(value, label);
  const frameSource =
    source.frame === undefined
      ? source
      : record(source.frame, `${label}.frame`);
  const widthValue = frameSource.width ?? frameSource.w;
  const heightValue = frameSource.height ?? frameSource.h;
  const duration =
    source.durationMs ?? source.duration ?? frameSource.durationMs ?? 100;
  const originX =
    source.originX === undefined
      ? undefined
      : integer(source.originX, `${label}.originX`, 0, 65_535);
  const originY =
    source.originY === undefined
      ? undefined
      : integer(source.originY, `${label}.originY`, 0, 65_535);
  return {
    x: integer(frameSource.x, `${label}.x`, 0, 65_535),
    y: integer(frameSource.y, `${label}.y`, 0, 65_535),
    width: integer(widthValue, `${label}.width`, 1, 65_535),
    height: integer(heightValue, `${label}.height`, 1, 65_535),
    durationMs: integer(duration, `${label}.durationMs`, 1, 60_000),
    ...(originX === undefined ? {} : { originX }),
    ...(originY === undefined ? {} : { originY }),
  };
}

/** Parse Keel or common TexturePacker-style JSON atlas data. */
export function parseSpriteAtlasJson(value: unknown): SpriteAtlas {
  const source = record(value, "sprite atlas");
  const framesValue = source.frames;
  let frames: SpriteFrame[];
  if (Array.isArray(framesValue)) {
    frames = framesValue.map((frame, index) =>
      parseSpriteFrame(frame, `frames[${index}]`),
    );
  } else {
    const entries = Object.entries(record(framesValue, "sprite atlas.frames"));
    frames = entries.map(([name, frame]) =>
      parseSpriteFrame(frame, `frames.${name}`),
    );
  }
  if (frames.length === 0 || frames.length > 4096)
    throw new RangeError("Sprite atlas must contain 1 through 4096 frames.");
  return { codec: "keel-json-sprite-atlas@1", frames };
}

/** Encode frame rectangles as a compact varint bit atlas for on-chain use. */
export function encodeSpriteBitAtlas(
  value: SpriteAtlas | { readonly frames: readonly SpriteFrame[] },
): Uint8Array {
  const frames = value.frames.map((frame, index) =>
    parseSpriteFrame(frame, `frames[${index}]`),
  );
  if (frames.length === 0 || frames.length > 4096)
    throw new RangeError("Sprite atlas must contain 1 through 4096 frames.");
  const writer = new ByteWriter();
  writer.raw(SPRITE_MAGIC);
  writer.byte(1);
  writer.byte(0);
  writer.varUint(frames.length);
  for (const frame of frames) {
    writer.varUint(frame.x);
    writer.varUint(frame.y);
    writer.varUint(frame.width);
    writer.varUint(frame.height);
    writer.varUint(frame.durationMs);
    writer.varUint(frame.originX ?? 0);
    writer.varUint(frame.originY ?? 0);
  }
  return writer.finish();
}

export function decodeSpriteBitAtlas(bytes: Uint8Array): SpriteAtlas {
  const reader = new ByteReader(bytes);
  const magic = reader.raw(SPRITE_MAGIC.length);
  if (!magic.every((value, index) => value === SPRITE_MAGIC[index]))
    throw new TypeError("Not a Keel sprite atlas.");
  if (reader.byte() !== 1)
    throw new TypeError("Unsupported Keel sprite atlas version.");
  if (reader.byte() !== 0)
    throw new TypeError("Unsupported Keel sprite atlas flags.");
  const count = reader.varUint("frameCount");
  if (count === 0 || count > 4096)
    throw new RangeError("Sprite atlas must contain 1 through 4096 frames.");
  const frames = Array.from({ length: count }, (_, index): SpriteFrame => ({
    x: reader.varUint(`frames[${index}].x`),
    y: reader.varUint(`frames[${index}].y`),
    width: reader.varUint(`frames[${index}].width`),
    height: reader.varUint(`frames[${index}].height`),
    durationMs: reader.varUint(`frames[${index}].durationMs`),
    originX: reader.varUint(`frames[${index}].originX`),
    originY: reader.varUint(`frames[${index}].originY`),
  }));
  if (!reader.done)
    throw new TypeError("Trailing bytes after Keel sprite atlas.");
  return {
    codec: KEEL_SPRITE_BITS_CODEC,
    frames: frames.map((frame, index) =>
      parseSpriteFrame(frame, `frames[${index}]`),
    ),
  };
}

export type KeelRgb = readonly [red: number, green: number, blue: number];

export interface KeelWeightedColor {
  readonly color: KeelRgb;
  readonly weight: number;
}

export type KeelMaterialRule =
  | { readonly mode: "locked"; readonly color: KeelRgb }
  | { readonly mode: "palette"; readonly colors: readonly KeelWeightedColor[] }
  | {
      readonly mode: "ramp";
      readonly dark: KeelRgb;
      readonly mid: KeelRgb;
      readonly light: KeelRgb;
    }
  | {
      readonly mode: "range";
      readonly hue: readonly [minimum: number, maximum: number];
      readonly saturation: readonly [minimum: number, maximum: number];
      readonly lightness: readonly [minimum: number, maximum: number];
      readonly darken: number;
      readonly lighten: number;
    };

export interface KeelMaterialRegion {
  /** Stable numeric key whose human name lives in the verified catalogue. */
  readonly regionId: number;
  /** Relative rarity of this material region/set. */
  readonly weight: number;
  readonly rule: KeelMaterialRule;
}

export interface KeelMaterialProfile {
  readonly codec: typeof KEEL_MATERIAL_BITS_CODEC;
  readonly setId: number;
  readonly setWeight: number;
  readonly regions: readonly KeelMaterialRegion[];
}

export interface KeelResolvedMaterialRegion {
  readonly regionId: number;
  readonly mode: KeelMaterialRule["mode"];
  readonly colors: readonly KeelRgb[];
}

export type KeelChannelRange = readonly [minimum: number, maximum: number];
export type KeelAtlasShadeChannel = "luminance" | "red" | "green" | "blue";

export interface KeelAtlasMaterialTarget {
  /** Stable identity for this pixel target. Human-readable and compact-codec retained. */
  readonly targetId: number;
  readonly label: string;
  /** Preserve keeps authored pixels fixed; material resolves through a region. */
  readonly action: "material" | "preserve";
  /** Multiple material targets may intentionally resolve through the same region. */
  readonly materialRegionId?: number;
  readonly red: KeelChannelRange;
  readonly green: KeelChannelRange;
  readonly blue: KeelChannelRange;
  readonly alpha?: KeelChannelRange;
  readonly shade: KeelAtlasShadeChannel;
  /** Higher priority wins when deliberately overlapping a broad range. */
  readonly priority: number;
}

export interface KeelAtlasMaterialMap {
  readonly codec: typeof KEEL_ATLAS_MATERIAL_BITS_CODEC;
  readonly unmatched: "preserve";
  readonly targets: readonly KeelAtlasMaterialTarget[];
}

export interface KeelTraitOption {
  readonly optionId: number;
  readonly weight: number;
  readonly materialProfileId?: number;
  /** First catalog revision that may select this stable option ID. */
  readonly introducedAt?: number;
}

export interface KeelTraitAttribute {
  /** Stable numeric key; labels and descriptions remain in verified metadata. */
  readonly attributeId: number;
  /** 0..8 for interoperable equipment slots, or absent for any custom trait. */
  readonly coreSlot?: number;
  readonly required?: boolean;
  /** First catalog revision that may emit this attribute. */
  readonly introducedAt?: number;
  /** Stable roll domain. It must never be changed after publication. */
  readonly entropyDomain?: number;
  readonly options: readonly KeelTraitOption[];
}

export interface KeelTraitCatalog {
  readonly codec:
    | typeof KEEL_TRAIT_BITS_CODEC
    | typeof KEEL_APPEND_ONLY_TRAIT_BITS_CODEC;
  readonly revision: number;
  readonly rejectExactDuplicates: boolean;
  readonly attributes: readonly KeelTraitAttribute[];
}

export interface KeelResolvedTrait {
  readonly attributeId: number;
  readonly optionId: number;
  readonly materialProfileId?: number;
}

export interface KeelCharacterAttributeSelection {
  readonly attributeId: number;
  readonly optionId: number;
  readonly materialProfileId?: number;
  readonly colorProfileId?: number;
  readonly effectProfileId?: number;
}

export interface KeelCharacterMetadataVector {
  readonly codec: typeof KEEL_CHARACTER_METADATA_BITS_CODEC;
  readonly catalogRevision: number;
  readonly sceneId: number;
  readonly attributes: readonly KeelCharacterAttributeSelection[];
}

const MATERIAL_MAGIC = [0x4f, 0x43, 0x4d, 0x50] as const; // OCMP
const ATLAS_MATERIAL_MAGIC = [0x4f, 0x43, 0x41, 0x4d] as const; // OCAM
const TRAIT_MAGIC = [0x4f, 0x43, 0x54, 0x52] as const; // OCTR
const CHARACTER_METADATA_MAGIC = [0x4f, 0x43, 0x4d, 0x56] as const; // OCMV
const MAX_MATERIAL_REGIONS = 64;
const MAX_PALETTE_COLORS = 32;
const MAX_ATLAS_MATERIAL_TARGETS = 64;
const MAX_TRAIT_ATTRIBUTES = 256;
const MAX_TRAIT_OPTIONS = 1024;

function rgb(value: unknown, label: string): KeelRgb {
  if (!Array.isArray(value) || value.length !== 3)
    throw new TypeError(`${label} must be an RGB triplet.`);
  return [
    integer(value[0], `${label}[0]`, 0, 255),
    integer(value[1], `${label}[1]`, 0, 255),
    integer(value[2], `${label}[2]`, 0, 255),
  ];
}

function writeRgb(writer: ByteWriter, value: KeelRgb): void {
  writer.raw(value);
}

function readRgb(reader: ByteReader): KeelRgb {
  const value = reader.raw(3);
  return [value[0]!, value[1]!, value[2]!];
}

function channelRange(value: unknown, label: string): KeelChannelRange {
  if (!Array.isArray(value) || value.length !== 2)
    throw new TypeError(`${label} must be a min/max pair.`);
  const minimum = integer(value[0], `${label}[0]`, 0, 255);
  return [minimum, integer(value[1], `${label}[1]`, minimum, 255)];
}

function validMaterialTargetLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,47}$/u.test(value)
  ) {
    throw new TypeError(`${label} must be 1 through 48 safe label characters.`);
  }
  return value;
}

function rangesOverlap(left: KeelChannelRange, right: KeelChannelRange): boolean {
  return left[0] <= right[1] && right[0] <= left[1];
}

function targetsOverlap(
  left: KeelAtlasMaterialTarget,
  right: KeelAtlasMaterialTarget,
): boolean {
  return (
    rangesOverlap(left.red, right.red) &&
    rangesOverlap(left.green, right.green) &&
    rangesOverlap(left.blue, right.blue) &&
    rangesOverlap(left.alpha ?? [0, 255], right.alpha ?? [0, 255])
  );
}

export function parseAtlasMaterialMap(value: unknown): KeelAtlasMaterialMap {
  const source = record(value, "atlas material map");
  if (
    !Array.isArray(source.targets) ||
    source.targets.length === 0 ||
    source.targets.length > MAX_ATLAS_MATERIAL_TARGETS
  ) {
    throw new RangeError(
      `atlas material map.targets must contain 1 through ${MAX_ATLAS_MATERIAL_TARGETS} targets.`,
    );
  }
  if (source.unmatched !== undefined && source.unmatched !== "preserve") {
    throw new TypeError("atlas material map.unmatched must be preserve.");
  }
  const seen = new Set<number>();
  const targets = source.targets
    .map((candidate, index): KeelAtlasMaterialTarget => {
      const entry = record(candidate, `atlas material map.targets[${index}]`);
      const targetId = integer(
        entry.targetId,
        `atlas material map.targets[${index}].targetId`,
        0,
        65_535,
      );
      if (seen.has(targetId))
        throw new RangeError(
          `atlas material map contains duplicate targetId ${targetId}.`,
        );
      seen.add(targetId);
      const shade = entry.shade ?? "luminance";
      if (
        shade !== "luminance" &&
        shade !== "red" &&
        shade !== "green" &&
        shade !== "blue"
      ) {
        throw new TypeError(
          `atlas material map.targets[${index}].shade is unsupported.`,
        );
      }
      const action = entry.action ?? "material";
      if (action !== "material" && action !== "preserve") {
        throw new TypeError(
          `atlas material map.targets[${index}].action must be material or preserve.`,
        );
      }
      if (action === "material" && entry.materialRegionId === undefined) {
        throw new TypeError(
          `atlas material map.targets[${index}].materialRegionId is required for material targets.`,
        );
      }
      if (action === "preserve" && entry.materialRegionId !== undefined) {
        throw new TypeError(
          `atlas material map.targets[${index}].materialRegionId must be absent for preserve targets.`,
        );
      }
      return {
        targetId,
        label: validMaterialTargetLabel(
          entry.label,
          `atlas material map.targets[${index}].label`,
        ),
        action,
        ...(action === "material"
          ? {
              materialRegionId: integer(
                entry.materialRegionId,
                `atlas material map.targets[${index}].materialRegionId`,
                0,
                65_535,
              ),
            }
          : {}),
        red: channelRange(
          entry.red,
          `atlas material map.targets[${index}].red`,
        ),
        green: channelRange(
          entry.green,
          `atlas material map.targets[${index}].green`,
        ),
        blue: channelRange(
          entry.blue,
          `atlas material map.targets[${index}].blue`,
        ),
        ...(entry.alpha === undefined
          ? {}
          : {
              alpha: channelRange(
                entry.alpha,
                `atlas material map.targets[${index}].alpha`,
              ),
            }),
        shade,
        priority: integer(
          entry.priority ?? 0,
          `atlas material map.targets[${index}].priority`,
          0,
          255,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.priority - left.priority || left.targetId - right.targetId,
    );
  for (let leftIndex = 0; leftIndex < targets.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < targets.length;
      rightIndex += 1
    ) {
      const left = targets[leftIndex]!;
      const right = targets[rightIndex]!;
      if (left.priority === right.priority && targetsOverlap(left, right)) {
        throw new RangeError(
          `atlas material targets ${left.targetId} and ${right.targetId} overlap at equal priority.`,
        );
      }
    }
  }
  return {
    codec: KEEL_ATLAS_MATERIAL_BITS_CODEC,
    unmatched: "preserve",
    targets,
  };
}

/** Compile human-readable lossy-safe channel ranges to a compact on-chain map. */
export function encodeAtlasMaterialMapBits(value: unknown): Uint8Array {
  const map = parseAtlasMaterialMap(value);
  const writer = new ByteWriter();
  writer.raw(ATLAS_MATERIAL_MAGIC);
  writer.byte(1);
  writer.byte(0);
  writer.varUint(map.targets.length);
  for (const target of map.targets) {
    writer.varUint(target.targetId);
    writer.text(target.label, "material target label", 48);
    writer.byte(target.action === "preserve" ? 1 : 0);
    if (target.action === "material") writer.varUint(target.materialRegionId!);
    writer.byte(target.priority);
    writer.byte(
      target.shade === "luminance"
        ? 0
        : target.shade === "red"
          ? 1
          : target.shade === "green"
            ? 2
            : 3,
    );
    writer.byte(target.alpha === undefined ? 0 : 1);
    writer.raw([...target.red, ...target.green, ...target.blue]);
    if (target.alpha !== undefined) writer.raw(target.alpha);
  }
  return writer.finish();
}

export function decodeAtlasMaterialMapBits(
  bytes: Uint8Array,
): KeelAtlasMaterialMap {
  const reader = new ByteReader(bytes);
  if (
    !reader
      .raw(4)
      .every((entry, index) => entry === ATLAS_MATERIAL_MAGIC[index])
  ) {
    throw new TypeError("Not a Keel atlas material map.");
  }
  if (reader.byte() !== 1)
    throw new TypeError("Unsupported Keel atlas material map version.");
  if (reader.byte() !== 0)
    throw new TypeError("Unsupported Keel atlas material map flags.");
  const count = reader.varUint("targetCount");
  if (count === 0 || count > MAX_ATLAS_MATERIAL_TARGETS)
    throw new RangeError("Invalid atlas material target count.");
  const targets = Array.from(
    { length: count },
    (_, index): KeelAtlasMaterialTarget => {
      const targetId = reader.varUint(`targets[${index}].targetId`);
      const label = reader.text(`targets[${index}].label`, 48);
      const actionFlag = reader.byte();
      if (actionFlag > 1)
        throw new TypeError("Unsupported atlas material action.");
      const action = actionFlag === 1 ? "preserve" : "material";
      const materialRegionId =
        action === "material"
          ? reader.varUint(`targets[${index}].materialRegionId`)
          : undefined;
      const priority = reader.byte();
      const shadeId = reader.byte();
      if (shadeId > 3)
        throw new TypeError("Unsupported atlas material shade channel.");
      const alphaFlag = reader.byte();
      if (alphaFlag > 1)
        throw new TypeError("Unsupported atlas material alpha flag.");
      const ranges = reader.raw(alphaFlag === 0 ? 6 : 8);
      return {
        targetId,
        label,
        action,
        ...(materialRegionId === undefined ? {} : { materialRegionId }),
        priority,
        shade: (["luminance", "red", "green", "blue"] as const)[shadeId]!,
        red: [ranges[0]!, ranges[1]!],
        green: [ranges[2]!, ranges[3]!],
        blue: [ranges[4]!, ranges[5]!],
        ...(alphaFlag === 0
          ? {}
          : { alpha: [ranges[6]!, ranges[7]!] as const }),
      };
    },
  );
  if (!reader.done)
    throw new TypeError("Trailing bytes after Keel atlas material map.");
  return parseAtlasMaterialMap({ unmatched: "preserve", targets });
}

function parseMaterialRule(value: unknown, label: string): KeelMaterialRule {
  const source = record(value, label);
  if (source.mode === "locked")
    return { mode: "locked", color: rgb(source.color, `${label}.color`) };
  if (source.mode === "ramp") {
    return {
      mode: "ramp",
      dark: rgb(source.dark, `${label}.dark`),
      mid: rgb(source.mid, `${label}.mid`),
      light: rgb(source.light, `${label}.light`),
    };
  }
  if (source.mode === "palette") {
    if (
      !Array.isArray(source.colors) ||
      source.colors.length === 0 ||
      source.colors.length > MAX_PALETTE_COLORS
    ) {
      throw new RangeError(
        `${label}.colors must contain 1 through ${MAX_PALETTE_COLORS} colors.`,
      );
    }
    return {
      mode: "palette",
      colors: source.colors.map((candidate, index) => {
        const entry = record(candidate, `${label}.colors[${index}]`);
        return {
          color: rgb(entry.color, `${label}.colors[${index}].color`),
          weight: integer(
            entry.weight,
            `${label}.colors[${index}].weight`,
            1,
            65_535,
          ),
        };
      }),
    };
  }
  if (source.mode === "range") {
    const pair = (
      candidate: unknown,
      pairLabel: string,
      maximum: number,
    ): readonly [number, number] => {
      if (!Array.isArray(candidate) || candidate.length !== 2)
        throw new TypeError(`${pairLabel} must be a min/max pair.`);
      const minimum = integer(candidate[0], `${pairLabel}[0]`, 0, maximum);
      const upper = integer(candidate[1], `${pairLabel}[1]`, minimum, maximum);
      return [minimum, upper];
    };
    return {
      mode: "range",
      hue: pair(source.hue, `${label}.hue`, 359),
      saturation: pair(source.saturation, `${label}.saturation`, 100),
      lightness: pair(source.lightness, `${label}.lightness`, 100),
      darken: integer(source.darken ?? 24, `${label}.darken`, 0, 100),
      lighten: integer(source.lighten ?? 24, `${label}.lighten`, 0, 100),
    };
  }
  throw new TypeError(`${label}.mode must be locked, palette, ramp, or range.`);
}

export function parseMaterialProfile(value: unknown): KeelMaterialProfile {
  const source = record(value, "material profile");
  if (
    !Array.isArray(source.regions) ||
    source.regions.length === 0 ||
    source.regions.length > MAX_MATERIAL_REGIONS
  ) {
    throw new RangeError(
      `material profile.regions must contain 1 through ${MAX_MATERIAL_REGIONS} regions.`,
    );
  }
  const seen = new Set<number>();
  const regions = source.regions.map((candidate, index): KeelMaterialRegion => {
    const entry = record(candidate, `material profile.regions[${index}]`);
    const regionId = integer(
      entry.regionId,
      `material profile.regions[${index}].regionId`,
      0,
      65_535,
    );
    if (seen.has(regionId))
      throw new RangeError(
        `material profile contains duplicate regionId ${regionId}.`,
      );
    seen.add(regionId);
    return {
      regionId,
      weight: integer(
        entry.weight ?? 1,
        `material profile.regions[${index}].weight`,
        1,
        65_535,
      ),
      rule: parseMaterialRule(
        entry.rule,
        `material profile.regions[${index}].rule`,
      ),
    };
  });
  return {
    codec: KEEL_MATERIAL_BITS_CODEC,
    setId: integer(source.setId, "material profile.setId", 0, MAX_INTEGER),
    setWeight: integer(
      source.setWeight ?? 1,
      "material profile.setWeight",
      1,
      65_535,
    ),
    regions,
  };
}

/** Compile fixed colors, weighted palettes, and three-stop material ramps to compact bytes. */
export function encodeMaterialBits(value: unknown): Uint8Array {
  const profile = parseMaterialProfile(value);
  const writer = new ByteWriter();
  writer.raw(MATERIAL_MAGIC);
  writer.byte(1);
  writer.byte(0);
  writer.varUint(profile.setId);
  writer.varUint(profile.setWeight);
  writer.varUint(profile.regions.length);
  for (const region of profile.regions) {
    writer.varUint(region.regionId);
    writer.varUint(region.weight);
    writer.byte(
      region.rule.mode === "locked"
        ? 0
        : region.rule.mode === "palette"
          ? 1
          : region.rule.mode === "ramp"
            ? 2
            : 3,
    );
    if (region.rule.mode === "locked") writeRgb(writer, region.rule.color);
    else if (region.rule.mode === "ramp") {
      writeRgb(writer, region.rule.dark);
      writeRgb(writer, region.rule.mid);
      writeRgb(writer, region.rule.light);
    } else if (region.rule.mode === "palette") {
      writer.varUint(region.rule.colors.length);
      for (const entry of region.rule.colors) {
        writeRgb(writer, entry.color);
        writer.varUint(entry.weight);
      }
    } else {
      writer.varUint(region.rule.hue[0]);
      writer.varUint(region.rule.hue[1]);
      writer.byte(region.rule.saturation[0]);
      writer.byte(region.rule.saturation[1]);
      writer.byte(region.rule.lightness[0]);
      writer.byte(region.rule.lightness[1]);
      writer.byte(region.rule.darken);
      writer.byte(region.rule.lighten);
    }
  }
  return writer.finish();
}

export function decodeMaterialBits(bytes: Uint8Array): KeelMaterialProfile {
  const reader = new ByteReader(bytes);
  if (!reader.raw(4).every((value, index) => value === MATERIAL_MAGIC[index]))
    throw new TypeError("Not a Keel material profile.");
  if (reader.byte() !== 1)
    throw new TypeError("Unsupported Keel material profile version.");
  if (reader.byte() !== 0)
    throw new TypeError("Unsupported Keel material profile flags.");
  const setId = reader.varUint("setId");
  const setWeight = reader.varUint("setWeight");
  const count = reader.varUint("regionCount");
  if (count === 0 || count > MAX_MATERIAL_REGIONS)
    throw new RangeError("Invalid material region count.");
  const regions: KeelMaterialRegion[] = [];
  for (let index = 0; index < count; index += 1) {
    const regionId = reader.varUint(`regions[${index}].regionId`);
    const weight = reader.varUint(`regions[${index}].weight`);
    const mode = reader.byte();
    let rule: KeelMaterialRule;
    if (mode === 0) rule = { mode: "locked", color: readRgb(reader) };
    else if (mode === 2)
      rule = {
        mode: "ramp",
        dark: readRgb(reader),
        mid: readRgb(reader),
        light: readRgb(reader),
      };
    else if (mode === 1) {
      const colorCount = reader.varUint(`regions[${index}].colorCount`);
      if (colorCount === 0 || colorCount > MAX_PALETTE_COLORS)
        throw new RangeError("Invalid material palette size.");
      const colors = Array.from(
        { length: colorCount },
        (_, colorIndex): KeelWeightedColor => ({
          color: readRgb(reader),
          weight: reader.varUint(
            `regions[${index}].colors[${colorIndex}].weight`,
          ),
        }),
      );
      rule = { mode: "palette", colors };
    } else if (mode === 3) {
      rule = {
        mode: "range",
        hue: [
          reader.varUint(`regions[${index}].hueMin`),
          reader.varUint(`regions[${index}].hueMax`),
        ],
        saturation: [reader.byte(), reader.byte()],
        lightness: [reader.byte(), reader.byte()],
        darken: reader.byte(),
        lighten: reader.byte(),
      };
    } else throw new TypeError("Unsupported Keel material region mode.");
    regions.push({ regionId, weight, rule });
  }
  if (!reader.done)
    throw new TypeError("Trailing bytes after Keel material profile.");
  return parseMaterialProfile({ setId, setWeight, regions });
}

function stableSeed32(
  seed: string | number | Uint8Array,
  domain: number,
): number {
  const bytes =
    typeof seed === "string"
      ? new TextEncoder().encode(seed)
      : typeof seed === "number"
        ? new TextEncoder().encode(String(seed))
        : seed;
  let state = (0x811c9dc5 ^ domain) >>> 0;
  for (const byte of bytes) {
    state ^= byte;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15;
  return state >>> 0;
}

function weightedIndex(
  weights: readonly number[],
  seed: string | number | Uint8Array,
  domain: number,
): number {
  const total = weights.reduce(
    (sum, weight) => sum + integer(weight, "weight", 1, 65_535),
    0,
  );
  let target = stableSeed32(seed, domain) % total;
  for (let index = 0; index < weights.length; index += 1) {
    target -= weights[index]!;
    if (target < 0) return index;
  }
  return weights.length - 1;
}

function rangedInteger(
  range: readonly [number, number],
  seed: string | number | Uint8Array,
  domain: number,
): number {
  return range[0] + (stableSeed32(seed, domain) % (range[1] - range[0] + 1));
}

function hslRgb(hue: number, saturation: number, lightness: number): KeelRgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const position = hue / 60;
  const x = chroma * (1 - Math.abs((position % 2) - 1));
  const [red, green, blue] =
    position < 1
      ? [chroma, x, 0]
      : position < 2
        ? [x, chroma, 0]
        : position < 3
          ? [0, chroma, x]
          : position < 4
            ? [0, x, chroma]
            : position < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const match = l - chroma / 2;
  return [red, green, blue].map((channel) =>
    Math.round((channel + match) * 255),
  ) as unknown as KeelRgb;
}

/** Resolve only mutable palette choices; locked colors and full ramps remain exact. */
export function resolveMaterialProfile(
  value: unknown,
  seed: string | number | Uint8Array,
): readonly KeelResolvedMaterialRegion[] {
  const profile = parseMaterialProfile(value);
  return profile.regions.map((region) => {
    if (region.rule.mode === "locked")
      return {
        regionId: region.regionId,
        mode: "locked",
        colors: [region.rule.color],
      };
    if (region.rule.mode === "ramp") {
      return {
        regionId: region.regionId,
        mode: "ramp",
        colors: [region.rule.dark, region.rule.mid, region.rule.light],
      };
    }
    if (region.rule.mode === "range") {
      const hue = rangedInteger(region.rule.hue, seed, region.regionId ^ 0x11);
      const saturation = rangedInteger(
        region.rule.saturation,
        seed,
        region.regionId ^ 0x22,
      );
      const lightness = rangedInteger(
        region.rule.lightness,
        seed,
        region.regionId ^ 0x33,
      );
      return {
        regionId: region.regionId,
        mode: "range",
        colors: [
          hslRgb(hue, saturation, Math.max(0, lightness - region.rule.darken)),
          hslRgb(hue, saturation, lightness),
          hslRgb(
            hue,
            saturation,
            Math.min(100, lightness + region.rule.lighten),
          ),
        ],
      };
    }
    const selected =
      region.rule.colors[
        weightedIndex(
          region.rule.colors.map((entry) => entry.weight),
          seed,
          region.regionId,
        )
      ]!;
    return {
      regionId: region.regionId,
      mode: "palette",
      colors: [selected.color],
    };
  });
}

function inChannelRange(value: number, range: KeelChannelRange): boolean {
  return value >= range[0] && value <= range[1];
}

function mixChannel(left: number, right: number, amount: number): number {
  return Math.round(left + (right - left) * amount);
}

function mixRgb(left: KeelRgb, right: KeelRgb, amount: number): KeelRgb {
  return [
    mixChannel(left[0], right[0], amount),
    mixChannel(left[1], right[1], amount),
    mixChannel(left[2], right[2], amount),
  ];
}

function materialColor(colors: readonly KeelRgb[], shade: number): KeelRgb {
  if (colors.length === 0)
    throw new RangeError(
      "Resolved material region must contain at least one color.",
    );
  if (colors.length === 1) return colors[0]!;
  if (colors.length === 2) return mixRgb(colors[0]!, colors[1]!, shade);
  if (shade <= 0.5) return mixRgb(colors[0]!, colors[1]!, shade * 2);
  return mixRgb(colors[1]!, colors[2]!, (shade - 0.5) * 2);
}

/**
 * Apply a verified material map to RGBA atlas bytes. This intentionally works
 * on tolerant channel ranges so lossy WebP/AVIF assets do not depend on exact
 * marker colors. Unmatched pixels, including authored fixed accents, remain
 * byte-identical.
 */
export function applyAtlasMaterialMap(
  pixels: Uint8Array | Uint8ClampedArray,
  mapValue: unknown,
  resolvedRegions: readonly KeelResolvedMaterialRegion[],
): Uint8ClampedArray {
  if (pixels.byteLength === 0 || pixels.byteLength % 4 !== 0) {
    throw new RangeError("Atlas pixels must contain non-empty RGBA bytes.");
  }
  const map = parseAtlasMaterialMap(mapValue);
  const regions = new Map(
    resolvedRegions.map((region) => [region.regionId, region]),
  );
  for (const target of map.targets) {
    if (
      target.action === "material" &&
      !regions.has(target.materialRegionId!)
    ) {
      throw new RangeError(
        `Material region ${target.materialRegionId} required by ${target.label} is missing.`,
      );
    }
  }
  const output = new Uint8ClampedArray(pixels);
  for (let offset = 0; offset < output.byteLength; offset += 4) {
    const red = output[offset]!;
    const green = output[offset + 1]!;
    const blue = output[offset + 2]!;
    const alpha = output[offset + 3]!;
    const target = map.targets.find(
      (candidate) =>
        inChannelRange(red, candidate.red) &&
        inChannelRange(green, candidate.green) &&
        inChannelRange(blue, candidate.blue) &&
        inChannelRange(alpha, candidate.alpha ?? [0, 255]),
    );
    if (target === undefined) continue;
    if (target.action === "preserve") continue;
    const shade =
      target.shade === "red"
        ? red / 255
        : target.shade === "green"
          ? green / 255
          : target.shade === "blue"
            ? blue / 255
            : (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    const resolved = regions.get(target.materialRegionId!)!;
    const color = materialColor(
      resolved.colors,
      Math.max(0, Math.min(1, shade)),
    );
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
  }
  return output;
}

export function parseTraitCatalog(value: unknown): KeelTraitCatalog {
  const source = record(value, "trait catalog");
  const codec = source.codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
    ? KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
    : KEEL_TRAIT_BITS_CODEC;
  const revision = integer(
    source.revision,
    "trait catalog.revision",
    1,
    MAX_INTEGER,
  );
  if (
    !Array.isArray(source.attributes) ||
    source.attributes.length === 0 ||
    source.attributes.length > MAX_TRAIT_ATTRIBUTES
  ) {
    throw new RangeError(
      `trait catalog.attributes must contain 1 through ${MAX_TRAIT_ATTRIBUTES} attributes.`,
    );
  }
  const seen = new Set<number>();
  const attributes = source.attributes.map(
    (candidate, index): KeelTraitAttribute => {
      const entry = record(candidate, `trait catalog.attributes[${index}]`);
      const attributeId = integer(
        entry.attributeId,
        `trait catalog.attributes[${index}].attributeId`,
        0,
        MAX_INTEGER,
      );
      if (seen.has(attributeId))
        throw new RangeError(
          `trait catalog contains duplicate attributeId ${attributeId}.`,
        );
      seen.add(attributeId);
      const introducedAt = codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
        ? integer(
            entry.introducedAt ?? 1,
            `trait catalog.attributes[${index}].introducedAt`,
            1,
            revision,
          )
        : undefined;
      if (
        !Array.isArray(entry.options) ||
        entry.options.length === 0 ||
        entry.options.length > MAX_TRAIT_OPTIONS
      ) {
        throw new RangeError(
          `trait catalog.attributes[${index}].options must contain 1 through ${MAX_TRAIT_OPTIONS} options.`,
        );
      }
      return {
        attributeId,
        ...(entry.coreSlot === undefined
          ? {}
          : {
              coreSlot: integer(
                entry.coreSlot,
                `trait catalog.attributes[${index}].coreSlot`,
                0,
                8,
              ),
            }),
        required: entry.required === true,
        ...(introducedAt === undefined ? {} : { introducedAt }),
        ...(codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
          ? {
              entropyDomain: integer(
                entry.entropyDomain,
                `trait catalog.attributes[${index}].entropyDomain`,
                0,
                MAX_INTEGER,
              ),
            }
          : {}),
        options: (() => {
          const optionIds = new Set<number>();
          return entry.options.map((option, optionIndex) => {
          const item = record(
            option,
            `trait catalog.attributes[${index}].options[${optionIndex}]`,
          );
          const optionId = integer(
              item.optionId,
              `trait catalog.attributes[${index}].options[${optionIndex}].optionId`,
              0,
              MAX_INTEGER,
            );
          if (optionIds.has(optionId)) throw new RangeError(`Attribute ${attributeId} contains duplicate optionId ${optionId}.`);
          optionIds.add(optionId);
          return {
            optionId,
            weight: integer(
              item.weight,
              `trait catalog.attributes[${index}].options[${optionIndex}].weight`,
              1,
              65_535,
            ),
            ...(item.materialProfileId === undefined
              ? {}
              : {
                  materialProfileId: integer(
                    item.materialProfileId,
                    `trait catalog.attributes[${index}].options[${optionIndex}].materialProfileId`,
                    0,
                    MAX_INTEGER,
                  ),
                }),
            ...(codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
              ? {
                  introducedAt: integer(
                    item.introducedAt ?? introducedAt,
                    `trait catalog.attributes[${index}].options[${optionIndex}].introducedAt`,
                    introducedAt,
                    revision,
                  ),
                }
              : {}),
          };
          });
        })(),
      };
    },
  );
  return {
    codec,
    revision,
    rejectExactDuplicates: source.rejectExactDuplicates === true,
    attributes,
  };
}

/** Compile an extensible weighted mint catalogue. Human labels stay in the hashed JSON metadata. */
export function encodeTraitCatalogBits(value: unknown): Uint8Array {
  const catalog = parseTraitCatalog(value);
  const writer = new ByteWriter();
  writer.raw(TRAIT_MAGIC);
  const appendOnly = catalog.codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC;
  writer.byte(appendOnly ? 3 : 2);
  writer.byte(catalog.rejectExactDuplicates ? 1 : 0);
  writer.varUint(catalog.revision);
  writer.varUint(catalog.attributes.length);
  for (const attribute of catalog.attributes) {
    writer.varUint(attribute.attributeId);
    writer.byte(
      (attribute.required ? 1 : 0) | (attribute.coreSlot === undefined ? 0 : 2),
    );
    if (attribute.coreSlot !== undefined) writer.byte(attribute.coreSlot);
    if (appendOnly) {
      writer.varUint(attribute.introducedAt!);
      writer.varUint(attribute.entropyDomain!);
    }
    writer.varUint(attribute.options.length);
    for (const option of attribute.options) {
      writer.varUint(option.optionId);
      writer.varUint(option.weight);
      writer.varUint(
        option.materialProfileId === undefined
          ? 0
          : option.materialProfileId + 1,
      );
      if (appendOnly) writer.varUint(option.introducedAt!);
    }
  }
  return writer.finish();
}

export function decodeTraitCatalogBits(bytes: Uint8Array): KeelTraitCatalog {
  const reader = new ByteReader(bytes);
  if (!reader.raw(4).every((value, index) => value === TRAIT_MAGIC[index]))
    throw new TypeError("Not a Keel trait catalog.");
  const version = reader.byte();
  if (version !== 2 && version !== 3)
    throw new TypeError("Unsupported Keel trait catalog version.");
  const appendOnly = version === 3;
  const flags = reader.byte();
  if ((flags & ~1) !== 0)
    throw new TypeError("Unsupported Keel trait catalog flags.");
  const revision = reader.varUint("revision");
  const count = reader.varUint("attributeCount");
  if (count === 0 || count > MAX_TRAIT_ATTRIBUTES)
    throw new RangeError("Invalid trait attribute count.");
  const attributes = Array.from(
    { length: count },
    (_, index): KeelTraitAttribute => {
      const attributeId = reader.varUint(`attributes[${index}].attributeId`);
      const attributeFlags = reader.byte();
      if ((attributeFlags & ~3) !== 0)
        throw new TypeError("Unsupported trait attribute flags.");
      const coreSlot = (attributeFlags & 2) === 0 ? undefined : reader.byte();
      const introducedAt = appendOnly
        ? reader.varUint(`attributes[${index}].introducedAt`)
        : undefined;
      const entropyDomain = appendOnly
        ? reader.varUint(`attributes[${index}].entropyDomain`)
        : undefined;
      const optionCount = reader.varUint(`attributes[${index}].optionCount`);
      if (optionCount === 0 || optionCount > MAX_TRAIT_OPTIONS)
        throw new RangeError("Invalid trait option count.");
      const options = Array.from(
        { length: optionCount },
        (_, optionIndex): KeelTraitOption => {
          const optionId = reader.varUint(
            `attributes[${index}].options[${optionIndex}].optionId`,
          );
          const weight = reader.varUint(
            `attributes[${index}].options[${optionIndex}].weight`,
          );
          const materialReference = reader.varUint(
            `attributes[${index}].options[${optionIndex}].materialProfileId`,
          );
          const optionIntroducedAt = appendOnly
            ? reader.varUint(
                `attributes[${index}].options[${optionIndex}].introducedAt`,
              )
            : undefined;
          return {
            optionId,
            weight,
            ...(materialReference === 0
              ? {}
              : { materialProfileId: materialReference - 1 }),
            ...(optionIntroducedAt === undefined
              ? {}
              : { introducedAt: optionIntroducedAt }),
          };
        },
      );
      return {
        attributeId,
        required: (attributeFlags & 1) !== 0,
        ...(coreSlot === undefined ? {} : { coreSlot }),
        ...(introducedAt === undefined ? {} : { introducedAt }),
        ...(entropyDomain === undefined ? {} : { entropyDomain }),
        options,
      };
    },
  );
  if (!reader.done)
    throw new TypeError("Trailing bytes after Keel trait catalog.");
  return parseTraitCatalog({
    codec: appendOnly
      ? KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
      : KEEL_TRAIT_BITS_CODEC,
    revision,
    rejectExactDuplicates: (flags & 1) !== 0,
    attributes,
  });
}

export function resolveTraitCatalog(
  value: unknown,
  seed: string | number | Uint8Array,
  pinnedRevision?: number,
): readonly KeelResolvedTrait[] {
  const catalog = parseTraitCatalog(value);
  const revision = pinnedRevision === undefined
    ? catalog.revision
    : integer(pinnedRevision, "pinned trait revision", 1, catalog.revision);
  return catalog.attributes
    .filter((attribute) =>
      catalog.codec !== KEEL_APPEND_ONLY_TRAIT_BITS_CODEC ||
      attribute.introducedAt! <= revision)
    .map((attribute, index) => {
    // Attribute IDs frequently match their array position. XOR would collapse
    // every domain to zero in that normal case and make all traits choose the
    // same option. Multiplication keeps stable IDs and positions separated.
    const domain = catalog.codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
      ? attribute.entropyDomain!
      : (Math.imul(attribute.attributeId + 1, 0x9e3779b1) ^
          Math.imul(index + 1, 0x85ebca6b)) >>> 0;
    const options = catalog.codec === KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
      ? attribute.options.filter((option) => option.introducedAt! <= revision)
      : attribute.options;
    if (options.length === 0) {
      throw new RangeError(
        `Attribute ${attribute.attributeId} has no options at revision ${revision}.`,
      );
    }
    const option =
      options[
        weightedIndex(
          options.map((candidate) => candidate.weight),
          seed,
          domain,
        )
      ]!;
    return {
      attributeId: attribute.attributeId,
      optionId: option.optionId,
      ...(option.materialProfileId === undefined
        ? {}
        : { materialProfileId: option.materialProfileId }),
    };
  });
}

/** Fail closed when a new catalog reorders, deletes, or mutates published IDs. */
export function assertTraitCatalogAppendOnly(previousValue: unknown, nextValue: unknown): void {
  const previous = parseTraitCatalog(previousValue);
  const next = parseTraitCatalog(nextValue);
  if (
    previous.codec !== KEEL_APPEND_ONLY_TRAIT_BITS_CODEC ||
    next.codec !== KEEL_APPEND_ONLY_TRAIT_BITS_CODEC
  ) throw new TypeError("Append-only comparison requires trait codec v3.");
  if (next.revision <= previous.revision)
    throw new RangeError("The next trait catalog revision must increase.");
  const nextAttributes = new Map(next.attributes.map((attribute) => [attribute.attributeId, attribute]));
  const previousAttributeIds = new Set(previous.attributes.map((attribute) => attribute.attributeId));
  for (const attribute of next.attributes) {
    if (!previousAttributeIds.has(attribute.attributeId) && attribute.introducedAt! <= previous.revision) {
      throw new RangeError(`New attribute ${attribute.attributeId} must start after revision ${previous.revision}.`);
    }
  }
  for (const attribute of previous.attributes) {
    const candidate = nextAttributes.get(attribute.attributeId);
    if (candidate === undefined) throw new RangeError(`Attribute ${attribute.attributeId} was removed.`);
    if (
      candidate.coreSlot !== attribute.coreSlot ||
      candidate.required !== attribute.required ||
      candidate.introducedAt !== attribute.introducedAt ||
      candidate.entropyDomain !== attribute.entropyDomain
    ) throw new RangeError(`Attribute ${attribute.attributeId} changed its stable definition.`);
    if (candidate.options.length < attribute.options.length) {
      throw new RangeError(`Attribute ${attribute.attributeId} removed options.`);
    }
    for (let index = 0; index < attribute.options.length; index += 1) {
      const option = attribute.options[index]!;
      const nextOption = candidate.options[index];
      if (
        nextOption === undefined ||
        nextOption.optionId !== option.optionId ||
        nextOption.weight !== option.weight ||
        nextOption.materialProfileId !== option.materialProfileId ||
        nextOption.introducedAt !== option.introducedAt
      ) throw new RangeError(`Attribute ${attribute.attributeId} option ${option.optionId} changed.`);
    }
    for (let index = attribute.options.length; index < candidate.options.length; index += 1) {
      if (candidate.options[index]!.introducedAt! <= previous.revision) {
        throw new RangeError(
          `New attribute ${attribute.attributeId} option ${candidate.options[index]!.optionId} must start after revision ${previous.revision}.`,
        );
      }
    }
  }
}

function parseCharacterMetadataVector(value: unknown): KeelCharacterMetadataVector {
  const source = record(value, "character metadata vector");
  if (!Array.isArray(source.attributes) || source.attributes.length > MAX_TRAIT_ATTRIBUTES) {
    throw new RangeError(`character metadata attributes must contain at most ${MAX_TRAIT_ATTRIBUTES} entries.`);
  }
  let previous = -1;
  const attributes = source.attributes.map((candidate, index): KeelCharacterAttributeSelection => {
    const entry = record(candidate, `character metadata attributes[${index}]`);
    const attributeId = integer(entry.attributeId, `character metadata attributes[${index}].attributeId`);
    if (attributeId <= previous) throw new RangeError("Character metadata attribute IDs must be unique and increasing.");
    previous = attributeId;
    const optional = (name: "materialProfileId" | "colorProfileId" | "effectProfileId") =>
      entry[name] === undefined ? undefined : integer(entry[name], `character metadata attributes[${index}].${name}`);
    const materialProfileId = optional("materialProfileId");
    const colorProfileId = optional("colorProfileId");
    const effectProfileId = optional("effectProfileId");
    return {
      attributeId,
      optionId: integer(entry.optionId, `character metadata attributes[${index}].optionId`),
      ...(materialProfileId === undefined ? {} : { materialProfileId }),
      ...(colorProfileId === undefined ? {} : { colorProfileId }),
      ...(effectProfileId === undefined ? {} : { effectProfileId }),
    };
  });
  return {
    codec: KEEL_CHARACTER_METADATA_BITS_CODEC,
    catalogRevision: integer(source.catalogRevision, "character metadata catalogRevision", 1),
    sceneId: integer(source.sceneId ?? 0, "character metadata sceneId"),
    attributes,
  };
}

/** Compact, reversible token metadata. Labels and descriptions are joined from
 * the catalog after decode instead of being duplicated for every token. */
export function encodeCharacterMetadataBits(value: unknown): Uint8Array {
  const vector = parseCharacterMetadataVector(value);
  const writer = new ByteWriter();
  writer.raw(CHARACTER_METADATA_MAGIC);
  writer.byte(1);
  writer.varUint(vector.catalogRevision);
  writer.varUint(vector.sceneId);
  writer.varUint(vector.attributes.length);
  let previous = -1;
  for (const attribute of vector.attributes) {
    writer.varUint(attribute.attributeId - previous - 1);
    previous = attribute.attributeId;
    const flags =
      (attribute.materialProfileId === undefined ? 0 : 1) |
      (attribute.colorProfileId === undefined ? 0 : 2) |
      (attribute.effectProfileId === undefined ? 0 : 4);
    writer.byte(flags);
    writer.varUint(attribute.optionId);
    if (attribute.materialProfileId !== undefined) writer.varUint(attribute.materialProfileId);
    if (attribute.colorProfileId !== undefined) writer.varUint(attribute.colorProfileId);
    if (attribute.effectProfileId !== undefined) writer.varUint(attribute.effectProfileId);
  }
  return writer.finish();
}

export function decodeCharacterMetadataBits(bytes: Uint8Array): KeelCharacterMetadataVector {
  const reader = new ByteReader(bytes);
  if (!reader.raw(4).every((value, index) => value === CHARACTER_METADATA_MAGIC[index])) {
    throw new TypeError("Not a Keel character metadata vector.");
  }
  if (reader.byte() !== 1) throw new TypeError("Unsupported Keel character metadata version.");
  const catalogRevision = reader.varUint("catalogRevision");
  const sceneId = reader.varUint("sceneId");
  const count = reader.varUint("attributeCount");
  if (count > MAX_TRAIT_ATTRIBUTES) throw new RangeError("Invalid character metadata attribute count.");
  let previous = -1;
  const attributes = Array.from({ length: count }, (_, index): KeelCharacterAttributeSelection => {
    const attributeId = previous + 1 + reader.varUint(`attributes[${index}].attributeDelta`);
    previous = attributeId;
    const flags = reader.byte();
    if ((flags & ~7) !== 0) throw new TypeError("Unsupported character metadata flags.");
    const optionId = reader.varUint(`attributes[${index}].optionId`);
    return {
      attributeId,
      optionId,
      ...((flags & 1) === 0 ? {} : { materialProfileId: reader.varUint(`attributes[${index}].materialProfileId`) }),
      ...((flags & 2) === 0 ? {} : { colorProfileId: reader.varUint(`attributes[${index}].colorProfileId`) }),
      ...((flags & 4) === 0 ? {} : { effectProfileId: reader.varUint(`attributes[${index}].effectProfileId`) }),
    };
  });
  if (!reader.done) throw new TypeError("Trailing bytes after Keel character metadata vector.");
  return parseCharacterMetadataVector({ catalogRevision, sceneId, attributes });
}

/** Number of exact option combinations before continuous/custom seed parameters. */
export function traitCombinationCount(value: unknown): bigint {
  return parseTraitCatalog(value).attributes.reduce(
    (total, attribute) => total * BigInt(attribute.options.length),
    1n,
  );
}

export interface SpriteLayerSpec {
  readonly resourceId: string;
  readonly tint?: string;
  readonly opacity?: number;
}

type DrawableImage = ImageBitmap | HTMLImageElement;

async function decodeVerifiedImage(
  content: KeelContentReader,
  resourceId: string,
): Promise<DrawableImage> {
  const bytes = content.bytes(resourceId);
  if (globalThis.createImageBitmap !== undefined) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return createImageBitmap(new Blob([copy.buffer]));
  }
  const image = new Image();
  image.decoding = "async";
  image.src = content.url(resourceId);
  await image.decode();
  return image;
}

export interface KeelSpritePlayer {
  readonly frameCount: number;
  readonly frameIndex: number;
  readonly playing: boolean;
  readonly fps: number;
  load(): Promise<void>;
  draw(index?: number): void;
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  setFps(value: number): void;
  dispose(): void;
}

/** Create a real frame-cropping, layered Canvas2D sprite player. */
export function createSpritePlayer(options: {
  readonly content: KeelContentReader;
  readonly canvas: HTMLCanvasElement;
  readonly atlas: SpriteAtlas;
  readonly layers: readonly SpriteLayerSpec[];
  readonly scale?: number;
  readonly fps?: number;
}): KeelSpritePlayer {
  const frames = options.atlas.frames.map((frame, index) =>
    parseSpriteFrame(frame, `frames[${index}]`),
  );
  if (frames.length === 0)
    throw new RangeError("Sprite player requires at least one frame.");
  if (options.layers.length === 0 || options.layers.length > 64)
    throw new RangeError("Sprite player requires 1 through 64 layers.");
  const context = options.canvas.getContext("2d", { alpha: true });
  if (context === null)
    throw new Error("Canvas2D is unavailable in this reader.");
  const scale = integer(options.scale ?? 12, "scale", 1, 64);
  const images: DrawableImage[] = [];
  let current = 0;
  let running = false;
  let fps = options.fps ?? Math.round(1000 / (frames[0]?.durationMs ?? 125));
  let animationFrame = 0;
  let previousTime: number | undefined;
  let accumulator = 0;

  const first = frames[0];
  if (first === undefined)
    throw new RangeError("Sprite player requires at least one frame.");
  options.canvas.width = first.width * scale;
  options.canvas.height = first.height * scale;
  context.imageSmoothingEnabled = false;
  const scratch = document.createElement("canvas");
  scratch.width = first.width;
  scratch.height = first.height;
  const scratchContext = scratch.getContext("2d");
  if (scratchContext === null)
    throw new Error("Canvas2D scratch surface is unavailable.");

  const draw = (index = current): void => {
    if (images.length !== options.layers.length)
      throw new Error("Sprite layers have not loaded yet.");
    current =
      ((integer(index, "frame index") % frames.length) + frames.length) %
      frames.length;
    const frame = frames[current];
    if (frame === undefined) throw new RangeError("Sprite frame disappeared.");
    context.clearRect(0, 0, options.canvas.width, options.canvas.height);
    for (
      let layerIndex = 0;
      layerIndex < options.layers.length;
      layerIndex += 1
    ) {
      const layer = options.layers[layerIndex];
      const image = images[layerIndex];
      if (layer === undefined || image === undefined) continue;
      const opacity = layer.opacity ?? 1;
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
        throw new RangeError("Layer opacity must be from 0 through 1.");
      context.globalAlpha = opacity;
      if (layer.tint === undefined) {
        context.drawImage(
          image,
          frame.x,
          frame.y,
          frame.width,
          frame.height,
          0,
          0,
          options.canvas.width,
          options.canvas.height,
        );
      } else {
        scratchContext.clearRect(0, 0, scratch.width, scratch.height);
        scratchContext.globalCompositeOperation = "source-over";
        scratchContext.drawImage(
          image,
          frame.x,
          frame.y,
          frame.width,
          frame.height,
          0,
          0,
          scratch.width,
          scratch.height,
        );
        scratchContext.globalCompositeOperation = "multiply";
        scratchContext.fillStyle = layer.tint;
        scratchContext.fillRect(0, 0, scratch.width, scratch.height);
        scratchContext.globalCompositeOperation = "destination-in";
        scratchContext.drawImage(
          image,
          frame.x,
          frame.y,
          frame.width,
          frame.height,
          0,
          0,
          scratch.width,
          scratch.height,
        );
        scratchContext.globalCompositeOperation = "source-over";
        context.drawImage(
          scratch,
          0,
          0,
          options.canvas.width,
          options.canvas.height,
        );
      }
    }
    context.globalAlpha = 1;
    options.canvas.dataset.spriteFrame = String(current);
  };

  const tick = (time: number): void => {
    if (!running) return;
    if (previousTime === undefined) previousTime = time;
    accumulator += time - previousTime;
    previousTime = time;
    const interval = 1000 / fps;
    while (accumulator >= interval) {
      accumulator -= interval;
      current = (current + 1) % frames.length;
      draw(current);
    }
    animationFrame = requestAnimationFrame(tick);
  };

  return {
    get frameCount() {
      return frames.length;
    },
    get frameIndex() {
      return current;
    },
    get playing() {
      return running;
    },
    get fps() {
      return fps;
    },
    async load(): Promise<void> {
      if (images.length > 0) return;
      for (const layer of options.layers)
        images.push(
          await decodeVerifiedImage(options.content, layer.resourceId),
        );
      for (let layerIndex = 0; layerIndex < images.length; layerIndex += 1) {
        const image = images[layerIndex];
        if (image === undefined) continue;
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
          const frame = frames[frameIndex];
          if (frame === undefined) continue;
          if (
            frame.x + frame.width > image.width ||
            frame.y + frame.height > image.height
          ) {
            throw new RangeError(
              `Frame ${frameIndex} exceeds layer ${layerIndex} (${image.width}x${image.height}).`,
            );
          }
        }
      }
      draw(0);
    },
    draw,
    play(): void {
      if (running) return;
      running = true;
      previousTime = undefined;
      accumulator = 0;
      animationFrame = requestAnimationFrame(tick);
    },
    pause(): void {
      running = false;
      cancelAnimationFrame(animationFrame);
    },
    next(): void {
      draw((current + 1) % frames.length);
    },
    previous(): void {
      draw((current - 1 + frames.length) % frames.length);
    },
    setFps(value: number): void {
      if (!Number.isFinite(value) || value <= 0 || value > 240)
        throw new RangeError(
          "fps must be greater than 0 and no more than 240.",
        );
      fps = value;
    },
    dispose(): void {
      this.pause();
      for (const image of images)
        if ("close" in image && typeof image.close === "function")
          image.close();
      images.length = 0;
      context.clearRect(0, 0, options.canvas.width, options.canvas.height);
    },
  };
}

export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function mat4Perspective(
  fieldOfViewRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  if (
    ![fieldOfViewRadians, aspect, near, far].every(Number.isFinite) ||
    aspect <= 0 ||
    near <= 0 ||
    far <= near
  ) {
    throw new RangeError("Invalid perspective parameters.");
  }
  const f = 1 / Math.tan(fieldOfViewRadians / 2);
  const range = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (near + far) * range,
    -1,
    0,
    0,
    near * far * 2 * range,
    0,
  ]);
}

export function mat4Multiply(left: Mat4, right: Mat4): Mat4 {
  if (left.length !== 16 || right.length !== 16)
    throw new RangeError("mat4Multiply requires two 4x4 matrices.");
  const output = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value +=
          (left[index * 4 + row] ?? 0) * (right[column * 4 + index] ?? 0);
      }
      output[column * 4 + row] = value;
    }
  }
  return output;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  if (![x, y, z].every(Number.isFinite))
    throw new RangeError("Translation values must be finite.");
  const matrix = mat4Identity();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

export function mat4RotationY(radians: number): Mat4 {
  if (!Number.isFinite(radians))
    throw new RangeError("Rotation must be finite.");
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return new Float32Array([
    cosine,
    0,
    -sine,
    0,
    0,
    1,
    0,
    0,
    sine,
    0,
    cosine,
    0,
    0,
    0,
    0,
    1,
  ]);
}
