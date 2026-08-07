/**
 * Wraps a MediaStream into: a live level meter (AnalyserNode) and a 16 kHz
 * mono PCM (linear16) callback suitable for streaming speech-to-text.
 * Every resource created here is released by `stop()`.
 */
export type PcmSource = {
  stop: () => void;
  getLevel: () => number;
  setPaused: (paused: boolean) => void;
  isRunning: () => boolean;
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

  processor.onaudioprocess = (event) => {
    if (paused || !running) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
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
    setPaused: (value: boolean) => {
      paused = value;
    },
    isRunning: () => running,
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
