/**
 * Wraps a MediaStream into: a live level meter (AnalyserNode) and a 16 kHz
 * mono PCM (linear16) callback suitable for streaming speech-to-text.
 * Every resource created here is released by `stop()`.
 */
export type PcmSource = {
  stop: () => void;
  getLevel: () => number;
  getMetrics: () => PcmMetrics;
  setPaused: (paused: boolean) => void;
  isRunning: () => boolean;
  startRecording: () => void;
  stopRecording: () => ArrayBuffer;
  isRecording: () => boolean;
};

export type PcmMetrics = {
  rms: number;
  peak: number;
  clippingCount: number;
  audioSeconds: number;
  speechSeconds: number;
  silencePercentage: number;
};

export const STT_SAMPLE_RATE = 16000;

export function createPcmSource(
  stream: MediaStream,
  onPcm: (chunk: ArrayBuffer) => void,
): PcmSource {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: STT_SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const analyserData = new Float32Array(analyser.fftSize);

  const processor = ctx.createScriptProcessor(4096, 1, 1);
  let paused = false;
  let running = true;
  let recording = false;
  let recordedSamples = 0;
  let recordedChunks: Int16Array[] = [];
  let rms = 0;
  let peak = 0;
  let clippingCount = 0;
  let totalSamples = 0;
  let silentSamples = 0;
  let speechSamples = 0;
  const maxRecordedSamples = STT_SAMPLE_RATE * 60;

  processor.onaudioprocess = (event) => {
    if (paused || !running) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    let sumSquares = 0;
    let chunkPeak = 0;
    let chunkClipping = 0;
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      const magnitude = Math.abs(s);
      sumSquares += s * s;
      chunkPeak = Math.max(chunkPeak, magnitude);
      if (magnitude >= 0.999) chunkClipping += 1;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    rms = Math.sqrt(sumSquares / Math.max(1, input.length));
    peak = chunkPeak;
    clippingCount += chunkClipping;
    totalSamples += input.length;
    // -50 dBFS is deliberately only a measurement threshold; no gain or filtering is applied.
    if (rms >= 0.00316) speechSamples += input.length;
    else silentSamples += input.length;
    if (recording && recordedSamples < maxRecordedSamples) {
      const remaining = maxRecordedSamples - recordedSamples;
      const copy = pcm.slice(0, remaining);
      recordedChunks.push(copy);
      recordedSamples += copy.length;
    }
    onPcm(pcm.buffer);
  };

  source.connect(analyser);
  analyser.connect(processor);
  // Required for ScriptProcessor to run; a zero-gain sink avoids echoing audio back out.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(ctx.destination);

  void ctx.resume().catch(() => undefined);

  return {
    stop: () => {
      running = false;
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
        analyser.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
      void ctx.close().catch(() => undefined);
    },
    getLevel: () => {
      if (!running) return 0;
      analyser.getFloatTimeDomainData(analyserData);
      let sum = 0;
      for (let i = 0; i < analyserData.length; i += 1) sum += analyserData[i]! * analyserData[i]!;
      const rms = Math.sqrt(sum / analyserData.length);
      return Math.min(1, rms * 4);
    },
    getMetrics: () => ({
      rms,
      peak,
      clippingCount,
      audioSeconds: totalSamples / STT_SAMPLE_RATE,
      speechSeconds: speechSamples / STT_SAMPLE_RATE,
      silencePercentage: totalSamples ? (silentSamples / totalSamples) * 100 : 100,
    }),
    setPaused: (value: boolean) => {
      paused = value;
    },
    isRunning: () => running,
    startRecording: () => {
      recordedChunks = [];
      recordedSamples = 0;
      recording = true;
    },
    stopRecording: () => {
      recording = false;
      const output = new Int16Array(recordedSamples);
      let offset = 0;
      for (const chunk of recordedChunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      recordedChunks = [];
      recordedSamples = 0;
      return output.buffer;
    },
    isRecording: () => recording,
  };
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* noop */
    }
  });
}
