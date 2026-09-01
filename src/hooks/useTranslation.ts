/**
 * Real-time translation layer (client side).
 *
 * Design rules:
 *  - Purely additive. It observes segments / questions produced by the session
 *    hook and translates them asynchronously. It never blocks STT, question
 *    detection or answer generation, and it never mutates the originals.
 *  - Progressive: interim (still-being-spoken) remote text is translated on a
 *    short debounce so the reader sees the sentence grow.
 *  - Cached by (text, source, target) so replays and re-renders cost nothing.
 *  - Remote/interviewer speech only, unless the user enables response
 *    translation for their own microphone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translateText } from "@/lib/translation.functions";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  resolveAnswerLanguage,
  type LanguageCode,
  type TranslationDiagnostics,
  type TranslationSettings,
} from "@/lib/translation/translation-protocol";
import {
  loadTranslationSettings,
  saveTranslationSettings,
} from "@/lib/translation/translation-settings";
import type { QuestionItem, Segment } from "@/hooks/useCopilotSession";

/** Interim text is retranslated at most this often (latency vs. cost). */
const PARTIAL_DEBOUNCE_MS = 350;
/** Don't spend a request on a fragment shorter than this. */
const MIN_PARTIAL_CHARS = 12;

type Input = {
  segments: Segment[];
  interim: Partial<Record<string, string>>;
  questions: QuestionItem[];
  /** Meeting topic / recent context, improves disambiguation. */
  context?: string;
};

type Pending = { id: number; text: string };

export function useTranslation(input: Input) {
  const [settings, setSettings] = useState<TranslationSettings>(DEFAULT_TRANSLATION_SETTINGS);
  const [ready, setReady] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState<string>("");
  const [version, setVersion] = useState(0);

  const cache = useRef(new Map<string, string>());
  const inflight = useRef(new Set<string>());
  const stats = useRef({
    requests: 0,
    cacheHits: 0,
    errors: 0,
    lastError: "",
    lastLatencyMs: null as number | null,
    latencies: [] as number[],
    firstPartialMs: null as number | null,
    completeMs: null as number | null,
    provider: "",
  });
  const partialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [partialText, setPartialText] = useState<Pending | null>(null);
  const [partialTranslation, setPartialTranslation] = useState("");
  const partialSeq = useRef(0);

  useEffect(() => {
    setSettings(loadTranslationSettings());
    setReady(true);
    return () => {
      if (partialTimer.current) clearTimeout(partialTimer.current);
    };
  }, []);

  const patch = useCallback((next: Partial<TranslationSettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      saveTranslationSettings(merged);
      return merged;
    });
  }, []);

  const active = ready && settings.enabled && !settings.paused;
  const source = settings.sourceLanguage;
  const target = settings.targetLanguage;
  const contextRef = useRef(input.context ?? "");
  contextRef.current = input.context ?? "";

  /** Translate once, memoised. Returns null while the request is in flight. */
  const request = useCallback(
    async (text: string, to: LanguageCode, partial: boolean): Promise<string | null> => {
      const k = `${source}|${to}|${text}`;
      const hit = cache.current.get(k);
      if (hit != null) {
        stats.current.cacheHits += 1;
        return hit;
      }
      if (inflight.current.has(k)) return null;
      inflight.current.add(k);
      const t0 = performance.now();
      stats.current.requests += 1;
      try {
        const out = await translateText({
          data: {
            text,
            source,
            target: to,
            provider: settings.provider,
            partial,
            ...(contextRef.current ? { context: contextRef.current } : {}),
          },
        });
        const ms = Math.round(performance.now() - t0);
        stats.current.lastLatencyMs = ms;
        stats.current.latencies = [...stats.current.latencies.slice(-19), ms];
        stats.current.provider = out.provider;
        if (partial) stats.current.firstPartialMs = ms;
        else stats.current.completeMs = ms;
        if (out.detectedSource && out.detectedSource !== "auto") {
          setDetectedLanguage(out.detectedSource);
        }
        cache.current.set(k, out.text);
        setVersion((v) => v + 1);
        return out.text;
      } catch (error) {
        stats.current.errors += 1;
        stats.current.lastError = error instanceof Error ? error.message : "Translation failed";
        setVersion((v) => v + 1);
        return null;
      } finally {
        inflight.current.delete(k);
      }
    },
    [settings.provider, source],
  );

  /* ---------------- final remote segments ---------------- */

  const translatableSegments = useMemo(
    () =>
      input.segments.filter(
        (s) =>
          s.isFinal &&
          s.text.trim().length > 1 &&
          (s.speaker === "interviewer" ||
            s.speaker === "test" ||
            (settings.translateMySpeech && s.speaker === "candidate")),
      ),
    [input.segments, settings.translateMySpeech],
  );

  useEffect(() => {
    if (!active) return;
    // Only the tail matters live; older lines resolve from cache on demand.
    for (const segment of translatableSegments.slice(-6)) {
      const to = segment.speaker === "candidate" ? languageOfInterviewer(settings) : target;
      if (cache.current.has(`${source}|${to}|${segment.text}`)) continue;
      void request(segment.text, to, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, request, segmentsKey(translatableSegments), settings, source, target]);

  /* ---------------- progressive interim translation ---------------- */

  const remoteInterim =
    input.interim["remote_meeting"] ||
    input.interim["zoom_desktop"] ||
    input.interim["teams_desktop"] ||
    "";

  useEffect(() => {
    if (!active) {
      setPartialTranslation("");
      return;
    }
    const text = remoteInterim.trim();
    if (text.length < MIN_PARTIAL_CHARS) return;
    if (partialTimer.current) clearTimeout(partialTimer.current);
    partialTimer.current = setTimeout(() => {
      const seq = ++partialSeq.current;
      setPartialText({ id: seq, text });
      void request(text, target, true).then((out) => {
        // Drop stale partials: only the newest fragment may paint.
        if (out && seq === partialSeq.current) setPartialTranslation(out);
      });
    }, PARTIAL_DEBOUNCE_MS);
  }, [active, remoteInterim, request, target]);

  useEffect(() => {
    if (!remoteInterim) setPartialTranslation("");
  }, [remoteInterim]);

  /* ---------------- questions + answers ---------------- */

  const answerLanguage = resolveAnswerLanguage(settings, detectedLanguage || null);

  useEffect(() => {
    if (!active) return;
    for (const q of input.questions.slice(0, 3)) {
      if (q.text.trim()) void request(q.text, target, false);
      // The answer only needs translating when it is NOT already in the
      // language the user reads.
      if (q.status === "answered" && q.answer.trim() && answerLanguage !== target) {
        void request(q.answer, target, false);
      }
    }
  }, [active, answerLanguage, input.questions, request, target]);

  const translate = useCallback(
    (text: string, to: LanguageCode = target): string | null => {
      if (!text) return null;
      return cache.current.get(`${source}|${to}|${text}`) ?? null;
    },
    [source, target],
  );

  const diagnostics: TranslationDiagnostics = useMemo(() => {
    const s = stats.current;
    const avg = s.latencies.length
      ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
      : null;
    return {
      status: !settings.enabled
        ? "off"
        : settings.paused
          ? "paused"
          : s.lastError && s.errors > 0
            ? "error"
            : inflight.current.size
              ? "translating"
              : "idle",
      sourceLanguage: detectedLanguage || settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      responseLanguage: settings.responseLanguage,
      answerLanguage,
      provider: s.provider || (settings.provider === "auto" ? "auto (pending)" : settings.provider),
      providersAvailable: "",
      detectedLanguage: detectedLanguage || "—",
      requests: s.requests,
      cacheHits: s.cacheHits,
      inflight: inflight.current.size,
      lastLatencyMs: s.lastLatencyMs,
      avgLatencyMs: avg,
      firstPartialMs: s.firstPartialMs,
      completeMs: s.completeMs,
      errors: s.errors,
      lastError: s.lastError || "none",
    };
    // `version` intentionally re-derives the snapshot as requests land.
  }, [answerLanguage, detectedLanguage, settings, version]);

  const swapLanguages = useCallback(() => {
    patch({
      sourceLanguage: settings.targetLanguage,
      targetLanguage:
        settings.sourceLanguage === "auto" ? settings.responseLanguage : settings.sourceLanguage,
    });
  }, [patch, settings]);

  return {
    settings,
    patch,
    active,
    translate,
    partialTranslation,
    partialSource: partialText?.text ?? "",
    answerLanguage,
    detectedLanguage,
    diagnostics,
    swapLanguages,
    setPaused: (paused: boolean) => patch({ paused }),
  };
}

/** The language the interviewer should receive the candidate's words in. */
function languageOfInterviewer(settings: TranslationSettings): LanguageCode {
  return settings.sourceLanguage === "auto" ? "en" : settings.sourceLanguage;
}

/** Cheap dependency key so the effect only reruns when the tail changes. */
function segmentsKey(list: Segment[]) {
  return list
    .slice(-6)
    .map((s) => s.id)
    .join(",");
}
