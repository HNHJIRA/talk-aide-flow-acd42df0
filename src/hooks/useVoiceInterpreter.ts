/**
 * Voice Interpreter Mode — client pipeline.
 *
 * Purely additive: it observes the *final* transcript segments the existing
 * session hook already produced and turns them into speech. It never touches
 * capture, Deepgram, diarization, turn assembly or the answer pipeline.
 *
 *   OUTGOING  candidate final segment -> translate(interviewerHears)
 *                                     -> TTS -> output device (virtual mic)
 *   INCOMING  interviewer final segment -> translate(reading language)
 *                                       -> TTS -> headphones (+ duck original)
 *
 * Echo protection: whatever the interpreter speaks is remembered for a short
 * window and any candidate line matching it is dropped, so the translated
 * voice can never re-enter the pipeline as new input.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translateText } from "@/lib/translation.functions";
import { synthesizeSpeech } from "@/lib/speech.functions";
import {
  DEFAULT_INTERPRETER_SETTINGS,
  isLikelyEcho,
  resolveIncomingTarget,
  resolveOutgoingTarget,
  routingForPlatform,
  type InterpretedUtterance,
  type InterpreterDiagnostics,
  type InterpreterSettings,
  type InterpreterStatus,
} from "@/lib/translation/interpreter-protocol";
import {
  loadInterpreterSettings,
  saveInterpreterSettings,
} from "@/lib/translation/interpreter-settings";
import type { LanguageCode, TranslationSettings } from "@/lib/translation/translation-protocol";
import type { Segment } from "@/hooks/useCopilotSession";
import { useInterpreterOutput } from "@/hooks/useInterpreterOutput";

type Input = {
  segments: Segment[];
  translation: TranslationSettings;
  detectedLanguage: string;
  /** Meeting platform id, decides the routing surface. */
  platform: string | undefined;
  /** Only interpret while the session is actually live. */
  live: boolean;
  /** Meeting topic / role, improves disambiguation. */
  context?: string;
  /** Enables the feature-flagged native interpreter output path (pairing). */
  sessionId?: string;
};

type Job = {
  id: string;
  direction: "incoming" | "outgoing";
  text: string;
  target: LanguageCode;
  source: LanguageCode;
  /** When the transcript line was produced (STT end). */
  at: number;
};

const MAX_HISTORY = 40;
const ECHO_WINDOW_MS = 12_000;

export type AudioOutputDevice = { deviceId: string; label: string };

export function useVoiceInterpreter(input: Input) {
  const [settings, setSettings] = useState<InterpreterSettings>(DEFAULT_INTERPRETER_SETTINGS);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<InterpreterStatus>("off");
  const [history, setHistory] = useState<InterpretedUtterance[]>([]);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [deviceError, setDeviceError] = useState("");

  /**
   * Native interpreter output (feature-flagged, additive). When it is off or
   * unavailable, everything below behaves exactly as before.
   */
  const output = useInterpreterOutput({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    deviceId: "",
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queue = useRef<Job[]>([]);
  const running = useRef(false);
  const seen = useRef(new Set<string>());
  const spoken = useRef<{ text: string; at: number }[]>([]);
  const stats = useRef({
    echoBlocks: 0,
    errors: 0,
    lastError: "",
    totals: [] as number[],
    last: {
      captureMs: null as number | null,
      sttMs: null as number | null,
      translateMs: null as number | null,
      ttsMs: null as number | null,
      outputMs: null as number | null,
      totalMs: null as number | null,
    },
  });
  const [tick, setTick] = useState(0);
  const bump = () => setTick((v) => v + 1);

  useEffect(() => {
    setSettings(loadInterpreterSettings());
    setReady(true);
  }, []);

  const patch = useCallback((next: Partial<InterpreterSettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      saveInterpreterSettings(merged);
      return merged;
    });
  }, []);

  const active = ready && settings.enabled && input.live;
  const routing = routingForPlatform(input.platform);

  const outgoingTarget = resolveOutgoingTarget(settings, input.translation, input.detectedLanguage);
  const incomingTarget = resolveIncomingTarget(input.translation);

  /* ---------------- output device ---------------- */

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        list
          .filter((d) => d.kind === "audiooutput")
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || (d.deviceId === "default" ? "System default" : `Output ${i + 1}`),
          })),
      );
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : "Could not list output devices");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshDevices();
  }, [active, refreshDevices]);

  const ensureAudio = useCallback(async () => {
    if (typeof document === "undefined") return null;
    if (!audioRef.current) audioRef.current = new Audio();
    const el = audioRef.current;
    el.volume = settings.volume;
    const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (settings.outputDeviceId && settings.outputDeviceId !== "default" && sinkable.setSinkId) {
      try {
        await sinkable.setSinkId(settings.outputDeviceId);
        setDeviceError("");
      } catch (error) {
        setDeviceError(
          error instanceof Error ? error.message : "Could not route audio to that device",
        );
      }
    }
    return el;
  }, [settings.outputDeviceId, settings.volume]);

  /* ---------------- pipeline ---------------- */

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const job = queue.current.shift()!;
        const captureMs = Math.max(0, Date.now() - job.at);
        setStatus("translating");
        const t0 = performance.now();
        let translated = job.text;
        try {
          const out = await translateText({
            data: {
              text: job.text,
              source: job.source,
              target: job.target,
              provider: input.translation.provider,
              partial: false,
              ...(input.context ? { context: input.context } : {}),
            },
          });
          translated = out.text;
        } catch (error) {
          stats.current.errors += 1;
          stats.current.lastError =
            error instanceof Error ? error.message : "Translation failed";
          setStatus("error");
          bump();
          continue;
        }
        const translateMs = Math.round(performance.now() - t0);

        const entry: InterpretedUtterance = {
          id: job.id,
          direction: job.direction,
          original: job.text,
          translated,
          sourceLanguage: job.source,
          targetLanguage: job.target,
          at: job.at,
          sttMs: null,
          translateMs,
          ttsMs: null,
          outputMs: null,
          totalMs: null,
        };
        setHistory((prev) => [entry, ...prev].slice(0, MAX_HISTORY));

        const shouldSpeak =
          job.direction === "outgoing" ? settings.speakOutgoing : settings.playIncomingVoice;
        if (!shouldSpeak) {
          stats.current.last = {
            captureMs,
            sttMs: null,
            translateMs,
            ttsMs: null,
            outputMs: null,
            totalMs: captureMs + translateMs,
          };
          bump();
          continue;
        }

        const t1 = performance.now();
        let audio: { audio: string; mimeType: string } | null = null;
        try {
          audio = await synthesizeSpeech({
            data: {
              text: translated.slice(0, 1200),
              voice: settings.voice,
              speed: settings.speed,
              instructions: "Speak naturally and professionally, at conversational pace.",
            },
          });
        } catch (error) {
          stats.current.errors += 1;
          stats.current.lastError = error instanceof Error ? error.message : "Speech failed";
          setStatus("error");
          bump();
          continue;
        }
        const ttsMs = Math.round(performance.now() - t1);

        // Echo guard: remember what we are about to say before it is audible.
        spoken.current = [
          ...spoken.current.filter((s) => Date.now() - s.at < ECHO_WINDOW_MS),
          { text: translated, at: Date.now() },
        ];

        const t2 = performance.now();
        setStatus("speaking");
        try {
          // OUTGOING voice prefers the native output layer; incoming voice is
          // for the candidate's own headphones and stays on browser playback.
          const routedNatively =
            job.direction === "outgoing" ? await output.speak(audio.audio) : false;
          const el = routedNatively ? null : await ensureAudio();
          if (el) {
            el.src = `data:${audio.mimeType};base64,${audio.audio}`;
            await el.play();
            await new Promise<void>((resolve) => {
              const done = () => {
                el.removeEventListener("ended", done);
                el.removeEventListener("error", done);
                resolve();
              };
              el.addEventListener("ended", done);
              el.addEventListener("error", done);
            });
          }
        } catch (error) {
          stats.current.errors += 1;
          stats.current.lastError =
            error instanceof Error ? error.message : "Playback blocked by the browser";
        }
        const outputMs = Math.round(performance.now() - t2);
        const totalMs = captureMs + translateMs + ttsMs;

        stats.current.last = {
          captureMs,
          sttMs: null,
          translateMs,
          ttsMs,
          outputMs,
          totalMs,
        };
        stats.current.totals = [...stats.current.totals.slice(-19), totalMs];
        setHistory((prev) =>
          prev.map((h) => (h.id === job.id ? { ...h, ttsMs, outputMs, totalMs } : h)),
        );
        bump();
      }
      setStatus(active ? "listening" : "off");
    } finally {
      running.current = false;
    }
  }, [active, ensureAudio, input.context, input.translation.provider, output, settings]);

  /** Queue newly finalized lines. Interims are never interpreted (they change). */
  useEffect(() => {
    if (!active) return;
    const tail = input.segments.filter((s) => s.isFinal).slice(-8);
    let queued = false;
    for (const segment of tail) {
      if (seen.current.has(segment.id)) continue;
      seen.current.add(segment.id);
      const text = segment.text.trim();
      if (text.length < settings.minChars) continue;

      const outgoing = segment.speaker === "candidate";
      const incoming = segment.speaker === "interviewer" || segment.speaker === "test";
      if (!outgoing && !incoming) continue;
      if (outgoing && !settings.speakOutgoing) continue;
      if (incoming && !settings.playIncomingVoice) continue;

      if (outgoing) {
        // Never re-interpret our own synthetic voice.
        const recent = spoken.current
          .filter((s) => Date.now() - s.at < ECHO_WINDOW_MS)
          .map((s) => s.text);
        if (isLikelyEcho(text, recent)) {
          stats.current.echoBlocks += 1;
          bump();
          continue;
        }
      }

      queue.current.push({
        id: `${segment.id}:${outgoing ? "out" : "in"}`,
        direction: outgoing ? "outgoing" : "incoming",
        text,
        source: outgoing ? settings.iSpeak : input.translation.sourceLanguage,
        target: outgoing ? outgoingTarget : incomingTarget,
        at: segment.at || Date.now(),
      });
      queued = true;
    }
    if (queued) void pump();
    else if (status === "off" && active) setStatus("listening");
  }, [
    active,
    incomingTarget,
    input.segments,
    input.translation.sourceLanguage,
    outgoingTarget,
    pump,
    settings,
    status,
  ]);

  useEffect(() => {
    if (!active) {
      setStatus("off");
      queue.current = [];
      audioRef.current?.pause();
    } else {
      setStatus((s) => (s === "off" ? "listening" : s));
    }
  }, [active]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  /** Original meeting audio should be quiet while the translated voice plays. */
  const duckOriginal = active && settings.duckOriginal && status === "speaking";

  const latest = useMemo(
    () => ({
      incoming: history.find((h) => h.direction === "incoming") ?? null,
      outgoing: history.find((h) => h.direction === "outgoing") ?? null,
    }),
    [history],
  );

  const diagnostics: InterpreterDiagnostics = useMemo(() => {
    const s = stats.current;
    const avg = s.totals.length
      ? Math.round(s.totals.reduce((a, b) => a + b, 0) / s.totals.length)
      : null;
    const device =
      devices.find((d) => d.deviceId === settings.outputDeviceId)?.label ?? "System default";
    return {
      status: !settings.enabled ? "off" : status,
      incoming: `${input.translation.sourceLanguage} → ${incomingTarget}`,
      outgoing: `${settings.iSpeak} → ${outgoingTarget}`,
      utterances: history.length,
      captureMs: s.last.captureMs,
      sttMs: s.last.sttMs,
      translateMs: s.last.translateMs,
      ttsMs: s.last.ttsMs,
      outputMs: s.last.outputMs,
      totalMs: s.last.totalMs,
      avgTotalMs: avg,
      outputDevice: deviceError ? `${device} (${deviceError})` : device,
      virtualMic:
        routing === "companion_virtual_mic"
          ? "Companion virtual microphone"
          : settings.outputDeviceId === "default"
            ? "Not routed — pick a virtual audio device"
            : device,
      echoGuardBlocks: s.echoBlocks,
      errors: s.errors,
      lastError: s.lastError || "none",
    };
    // `tick` re-derives the snapshot as jobs land.
  }, [
    deviceError,
    devices,
    history.length,
    incomingTarget,
    input.translation.sourceLanguage,
    outgoingTarget,
    routing,
    settings,
    status,
    tick,
  ]);

  /** Fired by the panel so the browser grants labelled device names. */
  const requestDevicePermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshDevices();
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : "Microphone permission denied");
    }
  }, [refreshDevices]);

  const testVoice = useCallback(async () => {
    try {
      setStatus("speaking");
      const audio = await synthesizeSpeech({
        data: {
          text: "This is the InterviewCopilot interpreter voice test.",
          voice: settings.voice,
          speed: settings.speed,
        },
      });
      const el = await ensureAudio();
      if (el) {
        el.src = `data:${audio.mimeType};base64,${audio.audio}`;
        await el.play();
      }
    } catch (error) {
      stats.current.errors += 1;
      stats.current.lastError = error instanceof Error ? error.message : "Voice test failed";
      setStatus("error");
      bump();
    } finally {
      setStatus(active ? "listening" : "off");
    }
  }, [active, ensureAudio, settings.speed, settings.voice]);

  return {
    settings,
    patch,
    active,
    status,
    history,
    latest,
    devices,
    refreshDevices,
    requestDevicePermission,
    testVoice,
    duckOriginal,
    routing,
    outgoingTarget,
    incomingTarget,
    diagnostics,
    output,
  };
}
