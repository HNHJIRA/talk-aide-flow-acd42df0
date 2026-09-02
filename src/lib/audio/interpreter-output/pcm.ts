/**
 * TTS audio -> 16 kHz mono PCM16, for the native interpreter output path.
 *
 * Isolated from the meeting capture PCM helpers (`src/lib/audio/pcm-source.ts`)
 * on purpose: nothing here is shared with STT, Deepgram or capture.
 */
export const INTERPRETER_OUTPUT_SAMPLE_RATE = 16_000;

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let decodeCtx: AudioContext | null = null;

function context(): AudioContext {
  if (!decodeCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    decodeCtx = new Ctor();
  }
  return decodeCtx;
}

/** Downmix to mono and linearly resample to the interpreter output rate. */
export function toMono16k(buffer: AudioBuffer, targetRate = INTERPRETER_OUTPUT_SAMPLE_RATE) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const mono = new Float32Array(frames);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i += 1) mono[i] += data[i]! / channels;
  }
  if (buffer.sampleRate === targetRate) return mono;

  const ratio = targetRate / buffer.sampleRate;
  const outLength = Math.round(frames * ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i / ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const a = mono[idx] ?? 0;
    const b = mono[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export type DecodedSpeech = {
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
};

/** Decode base64 TTS audio (mp3/wav/opus) into 16 kHz mono PCM16. */
export async function decodeSpeechToPcm16(
  base64: string,
  targetRate = INTERPRETER_OUTPUT_SAMPLE_RATE,
): Promise<DecodedSpeech> {
  const bytes = base64ToBytes(base64);
  const ctx = context();
  const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
  const mono = toMono16k(buffer, targetRate);
  return {
    pcm: floatToPcm16(mono),
    sampleRate: targetRate,
    durationMs: Math.round((mono.length / targetRate) * 1000),
  };
}
