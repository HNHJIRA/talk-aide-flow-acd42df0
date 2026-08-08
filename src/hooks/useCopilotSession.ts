import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { createPcmSource, stopStream, type PcmSource } from "@/lib/audio/pcm-source";
import {
  SttConnection,
  type SttState,
  type SttEvent,
  type SttProfile,
} from "@/lib/stt/stt-connection";
import { createSttSession, detectQuestion, prefetchContext, primeLiveContext } from "@/lib/copilot.functions";
import {
  TurnTimer,
  EMPTY_WATERFALL,
  type LatencyWaterfall,
  type LiveCallMeta,
  type TurnStatus,
} from "@/lib/latency";

import { fastQuestionGate, isPrefetchWorthy, topicTerms } from "@/lib/question-gate";

import {
  CompanionBridge,
  detectCompanion,
  COMPANION_SAMPLE_RATE,
  type CompanionFormat,
  type CompanionHealth,
  type CompanionState,
} from "@/lib/companion/companion-client";

/** Every remote source (meeting tab or Zoom Desktop companion) feeds one INTERVIEWER pipeline. */
export type SourceKind = "microphone" | "remote_meeting" | "zoom_desktop";

export type SourceStatus = "disconnected" | "connecting" | "active" | "silent" | "error";
export type SessionState =
  | "idle"
  | "ready"
  | "listening"
  | "paused"
  | "ending"
  | "completed"
  | "error";

export type MicMode = "candidate" | "test" | "fallback";
export type Speaker = "interviewer" | "candidate" | "test";

export type Segment = {
  id: string;
  source: SourceKind;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  at: number;
};

export type QuestionItem = {
  /** Stable client-side turn id; the row id arrives later and never blocks the UI. */
  id: string;
  dbId: string | null;
  text: string;
  category: string;
  confidence: number;
  status: "generating" | "answered" | "error" | "stopped";
  answer: string;
  answerId: string | null;
  firstTokenMs: number | null;
  pinned: boolean;
};


export type DebugInfo = {
  micTrack: string;
  micTrackLabel: string;
  meetingTrack: string;
  meetingTrackLabel: string;
  meetingTracksReturned: string;
  micLevel: number;
  meetingLevel: number;
  remoteStt: SttState;
  localStt: SttState;
  remoteCount: number;
  localCount: number;
  lastTranscriptSource: string;
  lastQuestion: string;
  lastConfidence: number | null;
  aiState: string;
  firstTokenMs: number | null;
  micMode: MicMode;
  micRole: string;
  detectionSources: string;
  /* --- low-latency pipeline --- */
  sttProfile: string;
  turnStatus: TurnStatus;
  speculativePrepared: number;
  speculativeCancelled: number;
  specStarted: number;
  specReused: number;
  specAborted: number;
  gateRejected: number;
  classifierCalls: number;
  /* --- interviewer turn assembly --- */
  turnId: string;
  turnSegments: number;
  turnAssembled: string;
  segmentsMerged: number;
  turnsResumed: number;
  graceHolds: number;
  duplicateAnswersBlocked: number;
  lastContinuationReason: string;


  /* --- desktop companion / Zoom Desktop --- */
  companionState: CompanionState;

  companionVersion: string;
  companionOs: string;
  companionBackend: string;
  remoteCaptureMethod: string;
  remoteSourceDetected: string;
  remoteSampleRate: string;
  remoteChannels: string;
  processedSampleRate: string;
  echoSuppressed: number;
  lastCaptureError: string;
  errors: string[];
};



const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function similar(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.95;
  const aw = new Set(a.split(" "));
  const bw = new Set(b.split(" "));
  let shared = 0;
  aw.forEach((w) => {
    if (bw.has(w)) shared += 1;
  });
  return shared / Math.max(aw.size, bw.size);
}

type Options = {
  sessionId: string;
  language: string;
  autoDetect: boolean;
  autoGenerate: boolean;
  confidenceThreshold: number;
  /**
   * How microphone speech is treated.
   * - "candidate" (production dual-source): mic = CANDIDATE, never triggers detection.
   * - "test" (STT Test Mode): mic = TEST AUDIO, may trigger detection for validation.
   * - "fallback": mic-only user; detection only when fallbackAutoDetect is on or promoted manually.
   */
  micMode: MicMode;
  fallbackAutoDetect: boolean;
  micConstraints: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
};

export function useCopilotSession(opts: Options) {
  const { sessionId } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [micStatus, setMicStatus] = useState<SourceStatus>("disconnected");
  const [meetingStatus, setMeetingStatus] = useState<SourceStatus>("disconnected");
  const [micDeviceLabel, setMicDeviceLabel] = useState<string>("");
  const [micLevel, setMicLevel] = useState(0);
  const [meetingLevel, setMeetingLevel] = useState(0);
  const [localStt, setLocalStt] = useState<SttState>("idle");
  const [remoteStt, setRemoteStt] = useState<SttState>("idle");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState<{ microphone: string; remote_meeting: string; zoom_desktop: string }>({
    microphone: "",
    remote_meeting: "",
    zoom_desktop: "",
  });
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  /* --- desktop companion --- */
  const [companionHealth, setCompanionHealth] = useState<CompanionHealth | null>(null);
  const [companionState, setCompanionState] = useState<CompanionState>("disconnected");
  const [companionLevel, setCompanionLevel] = useState(0);
  const [companionFormat, setCompanionFormat] = useState<CompanionFormat | null>(null);
  const companionRef = useRef<CompanionBridge | null>(null);

  const micStream = useRef<MediaStream | null>(null);
  const meetingStream = useRef<MediaStream | null>(null);
  const micPcm = useRef<PcmSource | null>(null);
  const meetingPcm = useRef<PcmSource | null>(null);
  const micStt = useRef<SttConnection | null>(null);
  const remoteStt_ = useRef<SttConnection | null>(null);
  const sequence = useRef(0);
  const startedAt = useRef<number | null>(null);
  const pendingUtterance = useRef("");
  const detectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentQuestions = useRef<{ norm: string; at: number }[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const counts = useRef({ remote: 0, local: 0, echo: 0 });
  const liveRef = useRef(false);
  const lastConfidence = useRef<number | null>(null);
  const recentMicFinals = useRef<{ norm: string; at: number }[]>([]);
  const [diag, setDiag] = useState({
    lastTranscriptSource: "none",
    lastQuestion: "",
    lastConfidence: null as number | null,
    aiState: "idle",
    firstTokenMs: null as number | null,
    meetingTracksReturned: "not requested",
    micTrackLabel: "none",
    meetingTrackLabel: "none",
    lastCaptureError: "none",
  });
  const lastMicSegment = useRef<{ text: string; id: string | null } | null>(null);
  const patchDiag = useCallback(
    (patch: Partial<typeof diag>) => setDiag((prev) => ({ ...prev, ...patch })),
    [],
  );



  const pushError = useCallback((message: string) => {
    setErrors((prev) => (prev.includes(message) ? prev : [...prev.slice(-4), message]));
  }, []);

  /* ---------------- persistence ---------------- */

  /* ---------------- persistence (never on the critical path) ---------------- */

  /**
   * Transcript rows are written fire-and-forget. Nothing in the live answer path
   * waits for this promise; a failed write degrades history, not latency.
   */
  const persistSegment = useCallback(
    async (segment: Segment, confidence: number | null, startMs: number | null, endMs: number | null) => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return null;
      const { data, error } = await supabase
        .from("transcript_segments")
        .insert({
          session_id: sessionId,
          user_id: auth.user.id,
          source: segment.source,
          speaker: segment.speaker,
          text: segment.text,
          is_final: true,
          confidence,
          started_at_ms: startMs,
          ended_at_ms: endMs,
          sequence_number: sequence.current++,
        })
        .select("id")
        .single();
      if (error) {
        pushError("Could not save a transcript line.");
        return null;
      }
      return data.id;
    },
    [sessionId, pushError],
  );

  /** clientTurnId -> promise of the detected_questions row id (resolved in background). */
  const questionRowIds = useRef(new Map<string, Promise<string | null>>());

  const persistQuestion = useCallback(
    (clientId: string, question: string, category: string, confidence: number, segmentId: string | null) => {
      const promise = (async () => {
        const { data: auth } = await supabase.auth.getUser();
        if (!auth.user) return null;
        const { data, error } = await supabase
          .from("detected_questions")
          .insert({
            user_id: auth.user.id,
            session_id: sessionId,
            transcript_segment_id: segmentId,
            question_text: question,
            normalized_question: normalize(question),
            category,
            confidence,
            status: "generating",
          })
          .select("id")
          .single();
        if (error || !data) return null;
        setQuestions((prev) => prev.map((q) => (q.id === clientId ? { ...q, dbId: data.id } : q)));
        return data.id;
      })();
      questionRowIds.current.set(clientId, promise);
      return promise;
    },
    [sessionId],
  );

  /* ---------------- turn state machine ---------------- */

  type Turn = {
    id: string;
    timer: TurnTimer;
    status: TurnStatus;
    text: string;
    /** Every finalised STT segment that belongs to this logical turn. */
    segments: string[];
    /** How many times Deepgram Flux told us the turn kept going. */
    resumedCount: number;
    /** Flux turn index this logical turn is bound to (null on the classic pipeline). */
    turnIndex: number | null;
    /** One turn id produces at most one automatic answer. */
    answered: boolean;
    segmentId: string | null;

    contextKey: string | null;
    prefetch: Promise<string | null> | null;
    prefetchTopic: string;
    decideTimer: ReturnType<typeof setTimeout> | null;
    /* --- speculative generation (started on eager end-of-turn) --- */
    spec: {
      question: string;
      category: string;
      controller: AbortController;
      /** hidden text generated before the turn was confirmed */
      buffer: string;
      promoted: boolean;
      aborted: boolean;
      /** promote + immediately paint everything generated so far */
      flush: (() => void) | null;
    } | null;
  };

  const turnRef = useRef<Turn | null>(null);
  const prefetchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRemoteVoiceAt = useRef<number | null>(null);
  const segmentsRef = useRef<Segment[]>([]);
  const questionsRef = useRef<QuestionItem[]>([]);
  questionsRef.current = questions;
  const [latency, setLatency] = useState<LatencyWaterfall>(EMPTY_WATERFALL);
  const [latencyHistory, setLatencyHistory] = useState<LatencyWaterfall[]>([]);
  const [aiCall, setAiCall] = useState<LiveCallMeta | null>(null);

  const [sttProfile, setSttProfile] = useState("standard — nova-3");
  const turnStats = useRef({
    prepared: 0,
    cancelled: 0,
    gateRejected: 0,
    classifierCalls: 0,
    specStarted: 0,
    specReused: 0,
    specAborted: 0,
    merged: 0,
    resumed: 0,
    graceHolds: 0,
    duplicateBlocked: 0,
  });
  /** Turn ids that already produced an automatic answer. */
  const answeredTurns = useRef<Set<string>>(new Set());
  const [turnView, setTurnView] = useState({
    id: "—",
    segments: 0,
    assembled: "",
    continuation: "—",
  });

  const newTurn = useCallback(() => {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const turn: Turn = {
      id,
      timer: new TurnTimer(id),
      status: "listening",
      text: "",
      segments: [],
      resumedCount: 0,
      turnIndex: null,
      answered: false,
      segmentId: null,
      contextKey: null,
      prefetch: null,
      prefetchTopic: "",
      decideTimer: null,
      spec: null,
    };
    turnRef.current = turn;
    return turn;
  }, []);



  const currentTurn = useCallback(() => {
    const turn = turnRef.current;
    if (!turn || turn.status === "completed" || turn.status === "cancelled") return newTurn();
    return turn;
  }, [newTurn]);

  /**
   * Speculative preparation: as soon as a stabilised interim looks like it could
   * become a question, retrieve resume context in the background. Nothing is ever
   * shown to the user from unconfirmed speech — only the retrieval is speculative.
   */
  const schedulePrefetch = useCallback(
    (turn: Turn, interimText: string) => {
      if (prefetchDebounce.current) clearTimeout(prefetchDebounce.current);
      prefetchDebounce.current = setTimeout(() => {
        const topic = topicTerms(interimText) || interimText.slice(0, 120);
        if (!isPrefetchWorthy(interimText)) return;
        if (turn.prefetchTopic === topic) return;
        turn.prefetchTopic = topic;
        turn.status = "preparing";
        turnStats.current.prepared += 1;
        turn.timer.remark("prefetchStart");
        turn.prefetch = prefetchContext({
          data: { sessionId, topic, turnId: turn.id },
        })
          .then((res) => {
            turn.timer.remark("prefetchDone");
            turn.contextKey = res.contextKey;
            return res.contextKey;
          })
          .catch(() => null);
      }, 250);
    },
    [sessionId],
  );

  /* ---------------- answer streaming ---------------- */

  /** rAF-batched token flush: never more than one React commit per frame. */
  const useFlusher = () => {
    const frame = useRef<number | null>(null);
    return useCallback((apply: () => void) => {
      if (frame.current != null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        apply();
      });
    }, []);
  };
  const scheduleFlush = useFlusher();

  const publishWaterfall = useCallback((timer: TurnTimer) => {
    const wf = timer.waterfall();
    setLatency(wf);
    // One entry per turn: later paints of the same turn replace the earlier one.
    setLatencyHistory((prev) => [wf, ...prev.filter((h) => h.turnId !== wf.turnId)].slice(0, 8));
  }, []);


  /**
   * LIVE answer path. Can run in two modes:
   *  - confirmed  : the question is final, tokens paint as they arrive.
   *  - speculative: started on Deepgram's eager end-of-turn. The model runs and
   *    its text is buffered but NEVER shown; on confirmation the same in-flight
   *    request is promoted and the buffer is flushed in one paint. If the
   *    interviewer keeps talking, the request is aborted and the text discarded.
   */
  const streamLiveAnswer = useCallback(
    async (
      turn: Turn,
      questionText: string,
      category: string,
      opts: { speculative?: boolean } = {},
    ) => {
      const speculative = opts.speculative === true;
      const controller = new AbortController();
      if (speculative) {
        turn.spec = {
          question: questionText,
          category,
          controller,
          buffer: "",
          promoted: false,
          aborted: false,
          flush: null,
        };
        turn.timer.speculative = true;
        turnStats.current.specStarted += 1;
      } else {
        abortRef.current?.abort();
        abortRef.current = controller;
      }
      const timer = turn.timer;
      turn.status = "generating";
      if (!speculative) patchDiag({ aiState: "generating", firstTokenMs: null });

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        if (!speculative) pushError("Your session expired. Please sign in again.");
        return;
      }

      // Give the speculative retrieval a short grace period, then proceed without it.
      let contextKey: string | null = null;
      if (turn.prefetch) {
        contextKey = await Promise.race([
          turn.prefetch,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
        ]);
      }
      timer.contextPrefetch = contextKey ? "hit" : turn.prefetch ? "miss" : "none";


      // Keep the live prompt small on purpose: the caps in copilot.server are
      // maximums, these are the targets for the first automatic answer.
      const recentConversation = segmentsRef.current
        .slice(-6)
        .map(
          (s) =>
            `${s.speaker === "interviewer" ? "INTERVIEWER" : s.speaker === "test" ? "TEST AUDIO" : "CANDIDATE"}: ${s.text}`,
        )
        .join("\n")
        .slice(-500);
      const isFollowUp =
        questionsRef.current.length > 0 &&
        (questionText.trim().length < 60 ||
          /\b(that|those|it|this|they|you just|also|and how|what about)\b/i.test(questionText));
      const priorQna = isFollowUp
        ? questionsRef.current
            .slice(0, 1)
            .map((q) => `Q: ${q.text}\nSuggested: ${q.answer.slice(0, 200)}`)
            .join("\n\n")
        : "";

      timer.remark("aiRequestStart");
      let answer = "";
      let firstToken: number | null = null;

      const spec = turn.spec;
      const paint = (snapshot: string) =>
        scheduleFlush(() => {
          timer.mark("aiFirstRender");
          setQuestions((prev) =>
            prev.map((q) =>
              q.id === turn.id ? { ...q, answer: snapshot, firstTokenMs: firstToken } : q,
            ),
          );
          patchDiag({ aiState: "streaming", firstTokenMs: firstToken });
          publishWaterfall(timer);
        });
      if (spec) {
        // Promotion: the confirmed question matched — flush everything the model
        // has already produced in one paint, then keep streaming normally.
        spec.flush = () => {
          spec.promoted = true;
          timer.speculativeReused = true;
          timer.bufferedCharsAtConfirm = answer.length;
          if (answer) paint(answer);
        };
      }

      try {
        const res = await fetch("/api/live-answer", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          signal: controller.signal,
          body: JSON.stringify({
            sessionId,
            questionText,
            category,
            contextKey,
            recentConversation,
            priorQna,
            isFollowUp,
          }),
        });
        timer.mark("aiResponseHeaders");
        const preludeMs = Number(res.headers.get("X-IC-Prelude-Ms") ?? "");
        if (!Number.isNaN(preludeMs)) timer.serverTtftMs = preludeMs;
        if (res.headers.get("X-IC-Context") === "hit") timer.contextPrefetch = "hit";


        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          if (speculative && !spec?.promoted) {
            turn.spec = null;
            turn.status = "listening";
            return;
          }
          const message =
            res.status === 429
              ? "AI rate limit reached — try again in a moment."
              : res.status === 402
                ? "AI credits exhausted. Add credits to keep generating answers."
                : `AI request failed: ${detail.slice(0, 140) || res.status}`;
          pushError(message);
          patchDiag({ aiState: "error" });
          setQuestions((prev) => prev.map((q) => (q.id === turn.id ? { ...q, status: "error" } : q)));
          turn.status = "completed";
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          timer.mark("streamOpen");
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
                ic_meta?: LiveCallMeta;
                ic_open?: { preludeMs: number };
                ic_upstream?: { requestSentMs: number; headersMs: number };
                ic_first?: { firstForwardMs: number };
                ic_error?: { status: number; message: string };
              };
              if (json.ic_open) {
                timer.serverTtftMs = json.ic_open.preludeMs;
                continue;
              }
              if (json.ic_upstream) {
                timer.serverDispatchMs = json.ic_upstream.requestSentMs;
                continue;
              }
              if (json.ic_first) {
                // Server-side ms at which the FIRST upstream byte was forwarded:
                // everything after this is pure transport + browser parsing.
                timer.serverTtftMs = json.ic_first.firstForwardMs;
                continue;
              }
              if (json.ic_error) {
                throw Object.assign(new Error(json.ic_error.message), {
                  status: json.ic_error.status,
                });
              }
              if (json.ic_meta) {
                setAiCall(json.ic_meta);
                continue;
              }
              const delta = json.choices?.[0]?.delta?.content;
              if (!delta) continue;

              if (firstToken === null) {
                timer.mark("aiFirstToken");
                firstToken = Math.round(
                  (timer.marks.aiFirstToken ?? performance.now()) - (timer.marks.aiRequestStart ?? 0),
                );
              }
              answer += delta;
              if (spec && !spec.promoted) {
                // Generated, but deliberately invisible until the turn confirms.
                spec.buffer = answer;
                continue;
              }
              paint(answer);
            } catch (frameError) {
              if (frameError instanceof Error && "status" in frameError) throw frameError;
              /* partial frame */
            }
          }
        }


        if (spec && !spec.promoted) {
          // Stream finished while still unconfirmed: hold the text, promotion
          // will paint it instantly when the turn is confirmed.
          spec.buffer = answer;
          timer.mark("aiComplete");
          return;
        }

        timer.mark("aiComplete");
        turn.status = "completed";
        setQuestions((prev) =>
          prev.map((q) => (q.id === turn.id ? { ...q, answer, status: "answered" } : q)),
        );
        patchDiag({ aiState: "answered" });
        publishWaterfall(timer);

        // Persistence happens strictly after the answer is on screen.
        void (async () => {
          const dbId = await questionRowIds.current.get(turn.id);
          if (!dbId || !answer.trim()) return;
          const { data: auth } = await supabase.auth.getUser();
          if (!auth.user) return;
          const { data: saved } = await supabase
            .from("generated_answers")
            .insert({
              user_id: auth.user.id,
              session_id: sessionId,
              question_id: dbId,
              answer_text: answer,
              answer_style: "natural",
              model: "live",
              generation_ms: Math.round(
                (timer.marks.aiComplete ?? 0) - (timer.marks.aiRequestStart ?? 0),
              ),
              first_token_ms: firstToken,
            })
            .select("id")
            .single();
          setQuestions((prev) =>
            prev.map((q) => (q.id === turn.id ? { ...q, answerId: saved?.id ?? null } : q)),
          );
          await supabase.from("detected_questions").update({ status: "answered" }).eq("id", dbId);
        })();
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          if (speculative && !spec?.promoted) {
            // Abandoned speculation: the user never saw a character of it.
            turn.spec = null;
            return;
          }
          turn.status = "completed";
          patchDiag({ aiState: "stopped" });
          setQuestions((prev) => prev.map((q) => (q.id === turn.id ? { ...q, status: "stopped" } : q)));
          return;
        }
        turn.status = "completed";
        if (speculative && !spec?.promoted) {
          turn.spec = null;
          return;
        }
        patchDiag({ aiState: "error" });
        pushError(error instanceof Error ? error.message : "Answer generation failed.");
        setQuestions((prev) => prev.map((q) => (q.id === turn.id ? { ...q, status: "error" } : q)));
      }
    },

    [sessionId, pushError, patchDiag, scheduleFlush, publishWaterfall],
  );

  /**
   * Existing full-context path, kept for manual regeneration and style variants.
   * It requires a persisted question row, so it is never used for the live turn.
   */
  const streamAnswer = useCallback(
    async (questionId: string, overrides?: { style?: string; length?: string }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const t0 = performance.now();
      let firstToken: number | null = null;

      patchDiag({ aiState: "generating", firstTokenMs: null });
      setQuestions((prev) =>
        prev.map((q) => (q.dbId === questionId ? { ...q, status: "generating", answer: "" } : q)),
      );

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        pushError("Your session expired. Please sign in again.");
        return;
      }

      try {
        const res = await fetch("/api/answer-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          signal: controller.signal,
          body: JSON.stringify({
            sessionId,
            questionId,
            answerStyle: overrides?.style,
            answerLength: overrides?.length,
          }),
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          const message =
            res.status === 429
              ? "AI rate limit reached — try again in a moment."
              : res.status === 402
                ? "AI credits exhausted. Add credits to keep generating answers."
                : `AI request failed: ${detail.slice(0, 140) || res.status}`;
          pushError(message);
          patchDiag({ aiState: "error" });
          setQuestions((prev) => prev.map((q) => (q.dbId === questionId ? { ...q, status: "error" } : q)));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let answer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: { delta?: { content?: string } }[];
              };
              const delta = json.choices?.[0]?.delta?.content;
              if (!delta) continue;
              if (firstToken === null) {
                firstToken = Math.round(performance.now() - t0);
                patchDiag({ aiState: "streaming", firstTokenMs: firstToken });
              }
              answer += delta;
              const snapshot = answer;
              scheduleFlush(() =>
                setQuestions((prev) =>
                  prev.map((q) =>
                    q.dbId === questionId ? { ...q, answer: snapshot, firstTokenMs: firstToken } : q,
                  ),
                ),
              );
            } catch {
              /* partial frame */
            }
          }
        }

        const { data: auth } = await supabase.auth.getUser();
        if (auth.user && answer.trim()) {
          const { data: saved } = await supabase
            .from("generated_answers")
            .insert({
              user_id: auth.user.id,
              session_id: sessionId,
              question_id: questionId,
              answer_text: answer,
              answer_style: overrides?.style ?? "natural",
              model: "gemini-3.6-flash",
              generation_ms: Math.round(performance.now() - t0),
              first_token_ms: firstToken,
            })
            .select("id")
            .single();
          setQuestions((prev) =>
            prev.map((q) =>
              q.dbId === questionId
                ? { ...q, answer, status: "answered", answerId: saved?.id ?? null }
                : q,
            ),
          );
          await supabase.from("detected_questions").update({ status: "answered" }).eq("id", questionId);
          patchDiag({ aiState: "answered" });
        } else {
          setQuestions((prev) =>
            prev.map((q) => (q.dbId === questionId ? { ...q, status: "answered" } : q)),
          );
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          patchDiag({ aiState: "stopped" });
          setQuestions((prev) => prev.map((q) => (q.dbId === questionId ? { ...q, status: "stopped" } : q)));
          return;
        }
        patchDiag({ aiState: "error" });
        pushError(error instanceof Error ? error.message : "Answer generation failed.");
        setQuestions((prev) => prev.map((q) => (q.dbId === questionId ? { ...q, status: "error" } : q)));
      }
    },
    [sessionId, pushError, patchDiag, scheduleFlush],
  );

  /* ---------------- question detection ---------------- */

  /** Duplicate / repeat-question guard, shared by every entry point. */
  const isDuplicate = useCallback((question: string) => {
    const norm = normalize(question);
    const now = Date.now();
    recentQuestions.current = recentQuestions.current.filter((q) => now - q.at < 90_000);
    if (recentQuestions.current.some((q) => similar(q.norm, norm) > 0.8)) return true;
    recentQuestions.current.push({ norm, at: now });
    return false;
  }, []);

  /** Confirmed question -> UI row + streaming answer. Database writes trail behind. */
  const commitQuestion = useCallback(
    (turn: Turn, question: string, category: string, confidence: number) => {
      // One logical interviewer turn -> at most one automatic answer, no matter
      // how many STT segments or speculative restarts it went through.
      if (turn.answered || answeredTurns.current.has(turn.id)) {
        turnStats.current.duplicateBlocked += 1;
        return;
      }
      turn.answered = true;
      answeredTurns.current.add(turn.id);
      lastConfidence.current = confidence;
      patchDiag({ lastQuestion: question, lastConfidence: confidence });
      turn.status = "confirmed";


      setQuestions((prev) => [
        {
          id: turn.id,
          dbId: null,
          text: question,
          category,
          confidence,
          status: "generating",
          answer: "",
          answerId: null,
          firstTokenMs: null,
          pinned: false,
        },
        ...prev,
      ]);

      void persistQuestion(turn.id, question, category, confidence, turn.segmentId);

      if (!optsRef.current.autoGenerate) {
        turn.spec?.controller.abort();
        turn.spec = null;
        turn.status = "completed";
        return;
      }

      // Reuse the in-flight speculative generation when the confirmed question is
      // essentially the eager-end-of-turn text: its head start becomes our TTFT.
      const spec = turn.spec;
      if (spec && !spec.aborted && similar(normalize(spec.question), normalize(question)) > 0.7) {
        turnStats.current.specReused += 1;
        spec.flush?.();
        publishWaterfall(turn.timer);
        return;
      }
      if (spec) {
        turnStats.current.specAborted += 1;
        spec.aborted = true;
        spec.controller.abort();
        turn.spec = null;
        turn.timer.speculativeReused = false;
      }
      void streamLiveAnswer(turn, question, category);
    },
    [patchDiag, persistQuestion, streamLiveAnswer, publishWaterfall],
  );


  /**
   * Decide a completed turn. The local gate answers the vast majority instantly;
   * only ambiguous utterances pay for the AI classifier round trip.
   */
  const decideTurn = useCallback(
    async (turn: Turn) => {
      const text = turn.text.trim();
      if (!text || text.length < 6) {
        turn.status = "completed";
        return;
      }

      turn.timer.mark("gateStart");
      const verdict = fastQuestionGate(text);
      turn.timer.mark("gateDone");

      if (verdict.decision === "reject") {
        turnStats.current.gateRejected += 1;
        turn.status = "completed";
        patchDiag({ lastQuestion: `(not a question — ${verdict.reason}) ${text.slice(0, 60)}` });
        return;
      }

      if (verdict.decision === "question") {
        if (verdict.confidence < optsRef.current.confidenceThreshold) {
          turn.status = "completed";
          return;
        }
        if (isDuplicate(verdict.question)) {
          turn.status = "completed";
          return;
        }
        commitQuestion(turn, verdict.question, verdict.category, verdict.confidence);
        publishWaterfall(turn.timer);
        return;
      }

      // Ambiguous: escalate to the AI classifier (kept for edge cases only).
      turnStats.current.classifierCalls += 1;
      turn.timer.classifierUsed = true;
      turn.timer.mark("classifierStart");
      const recentContext = segmentsRef.current
        .slice(-8)
        .map(
          (s) =>
            `${s.speaker === "interviewer" ? "INTERVIEWER" : s.speaker === "test" ? "TEST AUDIO" : "CANDIDATE"}: ${s.text}`,
        )
        .join("\n");
      let result;
      try {
        result = await detectQuestion({ data: { text, recentContext } });
      } catch (error) {
        turn.status = "completed";
        pushError(error instanceof Error ? error.message : "Question detection failed.");
        return;
      }
      turn.timer.mark("classifierDone");
      patchDiag({
        lastConfidence: result.confidence,
        lastQuestion: result.isQuestion ? result.question : `(not a question) ${text.slice(0, 60)}`,
      });
      if (!result.isQuestion || !result.requiresAnswer) {
        turn.status = "completed";
        return;
      }
      if (result.confidence < optsRef.current.confidenceThreshold) {
        turn.status = "completed";
        return;
      }
      if (isDuplicate(result.question)) {
        turn.status = "completed";
        return;
      }
      commitQuestion(turn, result.question, result.category, result.confidence);
      publishWaterfall(turn.timer);
    },
    [commitQuestion, isDuplicate, patchDiag, pushError, publishWaterfall],
  );

  /**
   * Manual entry points (typed question, promoted microphone line) reuse the same
   * machine but always skip the local reject rules.
   */
  const runDetection = useCallback(
    async (utterance: string, segmentId: string | null) => {
      const text = utterance.trim();
      if (text.length < 4) return;
      const turn = newTurn();
      turn.segmentId = segmentId;
      turn.text = text;
      turn.timer.mark("speechEnd");
      turn.timer.mark("sttFinal");
      const verdict = fastQuestionGate(text);
      const category = verdict.category;
      if (isDuplicate(text)) return;
      commitQuestion(turn, text, category, Math.max(verdict.confidence, 0.9));
    },
    [newTurn, isDuplicate, commitQuestion],
  );

  /* ---------------- STT wiring ---------------- */

  const handleResult = useCallback(
    (
      source: SourceKind,
      speaker: Speaker,
      result: {
        text: string;
        isFinal: boolean;
        confidence: number | null;
        startMs: number | null;
        endMs: number | null;
        event?: SttEvent;
      },
    ) => {
      const isRemote = source !== "microphone";
      const mode = optsRef.current.micMode;
      // Only an interviewer-side stream drives the low-latency machine; STT Test Mode
      // and opt-in mic-only fallback are the two explicit exceptions.
      const drivesDetection =
        optsRef.current.autoDetect &&
        (isRemote || mode === "test" || (mode === "fallback" && optsRef.current.fallbackAutoDetect));

      if (!result.isFinal) {
        if (result.event === "turn_resumed") {
          // The speaker kept going: the speculative end-of-turn was wrong, so any
          // hidden generation is thrown away before it can ever be seen.
          const turn = turnRef.current;
          if (turn) {
            if (turn.status === "preparing") turnStats.current.cancelled += 1;
            if (turn.spec && !turn.spec.promoted) {
              turnStats.current.specAborted += 1;
              turn.spec.aborted = true;
              turn.spec.controller.abort();
              turn.spec = null;
              turn.timer.speculativeCancelled = true;
              turn.status = "listening";
            }
          }
          return;
        }
        setInterim((prev) => ({ ...prev, [source]: result.text }));
        if (drivesDetection && result.text.trim()) {
          const turn = currentTurn();
          turn.timer.mark("sttFirstInterim");
          lastRemoteVoiceAt.current = performance.now();
          if (result.event === "eager_end_of_turn") {
            turn.timer.remark("speechEnd");
            turn.timer.mark("sttStableInterim");
            turn.timer.mark("eagerEot");
            schedulePrefetch(turn, result.text);
            // Speculative head start: run the real answer request now, invisibly.
            if (
              optsRef.current.autoGenerate &&
              !turn.spec &&
              turn.status !== "generating" &&
              turn.status !== "confirmed"
            ) {
              const guess = result.text.trim();
              const verdict = fastQuestionGate(guess);
              if (
                verdict.decision === "question" &&
                verdict.confidence >= optsRef.current.confidenceThreshold
              ) {
                turn.timer.mark("speculativeStart");
                void streamLiveAnswer(turn, verdict.question, verdict.category, {
                  speculative: true,
                });
              }
            }
            return;
          }
          schedulePrefetch(turn, result.text);
        }
        return;
      }

      setInterim((prev) => ({ ...prev, [source]: "" }));

      const norm = normalize(result.text);
      const now = Date.now();
      if (source === "microphone") {
        recentMicFinals.current = recentMicFinals.current.filter((m) => now - m.at < 12_000);
        recentMicFinals.current.push({ norm, at: now });
      } else {
        // Echo guard: speaker bleed / Zoom sidetone can feed the candidate's own
        // voice back through the remote capture. Prefer microphone attribution and
        // never let an echo become an interviewer question.
        const echo = recentMicFinals.current.some(
          (m) => now - m.at < 6000 && similar(m.norm, norm) > 0.85,
        );
        if (echo) {
          counts.current.echo += 1;
          patchDiag({ lastTranscriptSource: `${source} (echo of microphone — discarded)` });
          return;
        }
      }

      patchDiag({
        lastTranscriptSource: isRemote
          ? `${source} (INTERVIEWER)`
          : speaker === "test"
            ? "microphone (TEST AUDIO / single source)"
            : "microphone (ME / CANDIDATE)",
      });
      if (isRemote) counts.current.remote += 1;
      else counts.current.local += 1;

      const segment: Segment = {
        id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source,
        speaker,
        text: result.text,
        isFinal: true,
        at: Date.now(),
      };
      segmentsRef.current = [...segmentsRef.current.slice(-400), segment];
      setSegments((prev) => [...prev.slice(-400), segment]);

      // Fire-and-forget: the answer never waits for the transcript insert.
      void persistSegment(segment, result.confidence, result.startMs, result.endMs).then((id) => {
        if (source === "microphone") lastMicSegment.current = { text: result.text, id: id ?? null };
        if (turnRef.current && !turnRef.current.segmentId) turnRef.current.segmentId = id ?? null;
      });

      if (!drivesDetection) return;

      const turn = currentTurn();
      // speechEnd is the last moment we heard voice on this turn — the honest
      // anchor for "speech end -> first token", not the moment STT finalised.
      turn.timer.mark("speechEnd", lastRemoteVoiceAt.current ?? performance.now());
      turn.timer.remark("sttFinal");
      turn.text = `${turn.text} ${result.text}`.trim().slice(-600);

      if (turn.decideTimer) clearTimeout(turn.decideTimer);
      // Flux emits one confirmed EndOfTurn, so decide immediately. The classic
      // pipeline can split a question across finals: allow a short merge window,
      // shorter when the utterance already ends in terminal punctuation.
      const delay = result.event === "final" && sttProfileRef.current === "flux" ? 0 : /[?.!]\s*$/.test(result.text) ? 120 : 320;
      if (delay === 0) void decideTurn(turn);
      else
        turn.decideTimer = setTimeout(() => {
          turn.decideTimer = null;
          void decideTurn(turn);
        }, delay);
    },
    [persistSegment, patchDiag, currentTurn, schedulePrefetch, decideTurn],
  );

  /** Which remote capture currently feeds the single remote Deepgram socket. */
  const remoteSourceRef = useRef<Exclude<SourceKind, "microphone">>("remote_meeting");
  const sttProfileRef = useRef<SttProfile>("standard");

  const startStt = useCallback(
    (source: SourceKind) => {
      const isRemote = source !== "microphone";
      const setState = isRemote ? setRemoteStt : setLocalStt;
      // Low-latency pipeline for interviewer audio; the candidate microphone keeps
      // the standard pipeline (and gets it too in STT Test Mode, which stands in
      // for the interviewer).
      const lowLatency = isRemote || optsRef.current.micMode === "test";
      const connection = new SttConnection({
        getToken: async () => createSttSession(),
        language: optsRef.current.language,
        lowLatency,
        onResult: (result) =>
          handleResult(
            isRemote ? remoteSourceRef.current : source,
            isRemote
              ? "interviewer"
              : optsRef.current.micMode === "test"
                ? "test"
                : "candidate",
            result,
          ),
        onProfile: (profile, detail) => {
          if (isRemote || optsRef.current.micMode === "test") {
            sttProfileRef.current = profile;
            setSttProfile(detail);
          }
        },
        onState: (state, detail) => {
          setState(state);
          if (state === "error" && detail) pushError(detail);
        },
      });
      if (isRemote) remoteStt_.current = connection;
      else micStt.current = connection;
      void connection.start();
      return connection;
    },
    [handleResult, pushError],
  );



  // Stable indirection so connect handlers defined above can open an STT socket
  // when a source is attached after the session is already live.
  const startSttRef = useRef<((source: SourceKind) => void) | null>(null);
  startSttRef.current = startStt;

  /* ---------------- connect sources ---------------- */

  const connectMicrophone = useCallback(
    async (deviceId?: string) => {
      setMicStatus("connecting");
      try {
        const { echoCancellation, noiseSuppression, autoGainControl } = optsRef.current.micConstraints;
        const audio: MediaTrackConstraints = { echoCancellation, noiseSuppression, autoGainControl };
        if (deviceId) audio.deviceId = { exact: deviceId };
        const stream = await navigator.mediaDevices.getUserMedia({ audio });

        micStream.current?.getTracks().forEach((t) => t.stop());
        micPcm.current?.stop();
        micStream.current = stream;
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error("No microphone audio track was provided.");
        setMicDeviceLabel(track.label || "Microphone");
        patchDiag({ micTrackLabel: track.label || "Microphone" });
        track.onended = () => setMicStatus("disconnected");
        const pcm = createPcmSource(stream, (chunk) => micStt.current?.send(chunk));
        micPcm.current = pcm;
        setMicStatus("active");
        if (liveRef.current && !micStt.current) startSttRef.current?.("microphone");
        return true;
      } catch (error) {
        setMicStatus("error");
        pushError(
          error instanceof Error && error.name === "NotAllowedError"
            ? "Microphone permission was denied. Allow it in your browser's site settings and try again."
            : `Microphone error: ${(error as Error).message}`,
        );
        return false;
      }
    },
    [pushError, patchDiag],
  );

  const connectMeetingAudio = useCallback(async () => {
    setMeetingStatus("connecting");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });
      const audioTracks = stream.getAudioTracks();
      patchDiag({
        meetingTracksReturned: `${stream.getVideoTracks().length} video / ${audioTracks.length} audio` +
          (audioTracks.length ? ` — "${audioTracks[0]!.label || "unlabelled"}"` : ""),
        meetingTrackLabel: audioTracks[0]?.label || "none",
      });
      if (audioTracks.length === 0) {
        stopStream(stream);
        setMeetingStatus("error");
        pushError(
          `No meeting audio track was returned by the browser (got ${stream.getVideoTracks().length} video, 0 audio). Reconnect, choose the "Chrome Tab" option with the Google Meet / Zoom tab, and switch on "Also share tab audio" in the picker. Window and entire-screen sharing cannot carry audio in Chrome.`,
        );
        return false;
      }
      // We only need audio — drop the video track immediately.
      stream.getVideoTracks().forEach((track) => {
        track.stop();
        stream.removeTrack(track);
      });
      meetingStream.current?.getTracks().forEach((t) => t.stop());
      meetingPcm.current?.stop();
      meetingStream.current = stream;
      remoteSourceRef.current = "remote_meeting";
      audioTracks[0]!.onended = () => {
        setMeetingStatus("disconnected");
        pushError("Meeting audio sharing was stopped in the browser.");
      };
      const pcm = createPcmSource(stream, (chunk) => remoteStt_.current?.send(chunk));
      meetingPcm.current = pcm;
      setMeetingStatus("active");
      if (liveRef.current && !remoteStt_.current) startSttRef.current?.("remote_meeting");
      return true;
    } catch (error) {
      setMeetingStatus("error");
      pushError(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Screen/tab sharing was cancelled, so no meeting audio is connected."
          : `Meeting audio error: ${(error as Error).message}`,
      );
      return false;
    }
  }, [pushError, patchDiag]);

  /* ---------------- desktop companion (Zoom Desktop) ---------------- */

  /** Probe the local bridge; returns the health payload or null when not installed. */
  const refreshCompanion = useCallback(async () => {
    const health = await detectCompanion();
    setCompanionHealth(health);
    if (!health) setCompanionState((prev) => (prev === "capturing" ? prev : "not_installed"));
    return health;
  }, []);

  /**
   * Attach the paired Desktop Companion. Audio only starts flowing after the user
   * explicitly presses "Connect Zoom Desktop Audio" (startCompanionCapture).
   */
  const connectCompanion = useCallback(
    async (bridgeToken: string, target: "zoom" | "system" = "zoom") => {
      const health = companionHealth ?? (await refreshCompanion());
      if (!health) {
        setCompanionState("not_installed");
        pushError("InterviewCopilot Companion is not running on this computer.");
        return false;
      }
      companionRef.current?.disconnect();
      const bridge = new CompanionBridge(health.port, bridgeToken, target, {
        onState: (state, detail) => {
          setCompanionState(state);
          if (state === "capturing") {
            remoteSourceRef.current = "zoom_desktop";
            setMeetingStatus("active");
            if (liveRef.current && !remoteStt_.current) startSttRef.current?.("zoom_desktop");
          }
          if (state === "silent") setMeetingStatus("silent");
          if (state === "stopped" || state === "disconnected") setMeetingStatus("disconnected");
          if (state === "error" && detail) {
            setMeetingStatus("error");
            patchDiag({ lastCaptureError: detail });
            pushError(detail);
          }
        },
        onLevel: (level) => setCompanionLevel(level),
        onFormat: (format) => setCompanionFormat(format),
        onPcm: (chunk) => remoteStt_.current?.send(chunk),
      });
      companionRef.current = bridge;
      bridge.connect();
      return true;
    },
    [companionHealth, refreshCompanion, pushError, patchDiag],
  );

  /** Explicit user action — the companion never captures silently. */
  const startCompanionCapture = useCallback(() => {
    if (!companionRef.current) {
      pushError("Pair the Desktop Companion first.");
      return;
    }
    remoteSourceRef.current = "zoom_desktop";
    companionRef.current.startCapture();
    if (liveRef.current && !remoteStt_.current) startSttRef.current?.("zoom_desktop");
  }, [pushError]);

  const stopCompanionCapture = useCallback(() => {
    companionRef.current?.stopCapture();
    setMeetingStatus("disconnected");
  }, []);


  /* ---------------- lifecycle ---------------- */

  const startListening = useCallback(async () => {
    if (micPcm.current && !micStt.current) startStt("microphone");
    if ((meetingPcm.current || companionRef.current?.isCapturing()) && !remoteStt_.current)
      startStt(remoteSourceRef.current);
    startedAt.current = Date.now();
    liveRef.current = true;
    setSessionState("listening");
    // Warm session + resume caches server-side so the first question of the
    // interview is as fast as the tenth. Never blocks going live.
    void primeLiveContext({ data: { sessionId } }).catch(() => undefined);
    await supabase
      .from("interview_sessions")
      .update({ status: "listening", started_at: new Date().toISOString() })
      .eq("id", sessionId);
  }, [startStt, sessionId]);


  const pause = useCallback(() => {
    // Only gates PCM delivery: the two Deepgram sockets stay open, so resuming
    // never opens a duplicate connection or replays buffered audio.
    micPcm.current?.setPaused(true);
    meetingPcm.current?.setPaused(true);
    companionRef.current?.setPaused(true);
    setSessionState("paused");
  }, []);

  const resume = useCallback(() => {
    micPcm.current?.setPaused(false);
    meetingPcm.current?.setPaused(false);
    companionRef.current?.setPaused(false);
    setSessionState("listening");
  }, []);

  const teardown = useCallback(() => {
    liveRef.current = false;
    abortRef.current?.abort();
    if (detectTimer.current) clearTimeout(detectTimer.current);
    if (prefetchDebounce.current) clearTimeout(prefetchDebounce.current);
    if (turnRef.current?.decideTimer) clearTimeout(turnRef.current.decideTimer);
    turnRef.current = null;
    micStt.current?.stop();

    remoteStt_.current?.stop();
    micStt.current = null;
    remoteStt_.current = null;
    micPcm.current?.stop();
    meetingPcm.current?.stop();
    micPcm.current = null;
    meetingPcm.current = null;
    companionRef.current?.disconnect();
    companionRef.current = null;
    setCompanionState("disconnected");
    setCompanionLevel(0);
    stopStream(micStream.current);
    stopStream(meetingStream.current);
    micStream.current = null;
    meetingStream.current = null;
    setMicStatus("disconnected");
    setMeetingStatus("disconnected");
  }, []);


  const endSession = useCallback(async () => {
    setSessionState("ending");
    const duration = startedAt.current ? Math.round((Date.now() - startedAt.current) / 1000) : 0;
    teardown();
    await supabase
      .from("interview_sessions")
      .update({
        status: "completed",
        ended_at: new Date().toISOString(),
        duration_seconds: duration,
      })
      .eq("id", sessionId);
    setSessionState("completed");
    return duration;
  }, [teardown, sessionId]);

  const stopGenerating = useCallback(() => abortRef.current?.abort(), []);

  /**
   * Regeneration works on the persisted row, which may still be in flight when
   * the user clicks: resolve the client turn id to its database id first.
   */
  const regenerate = useCallback(
    async (clientId: string, overrides?: { style?: string; length?: string }) => {
      const known = questionsRef.current.find((q) => q.id === clientId)?.dbId;
      const dbId = known ?? (await questionRowIds.current.get(clientId)) ?? null;
      if (!dbId) {
        pushError("This answer is still being saved — try again in a second.");
        return;
      }
      await streamAnswer(dbId, overrides);
    },
    [streamAnswer, pushError],
  );

  const togglePin = useCallback(async (clientId: string) => {
    let next = false;
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== clientId) return q;
        next = !q.pinned;
        return { ...q, pinned: next };
      }),
    );
    const target = questionsRef.current.find((q) => q.id === clientId);
    if (target?.answerId) {
      await supabase.from("generated_answers").update({ is_pinned: next }).eq("id", target.answerId);
    }
  }, []);


  /** Mic-only fallback: explicitly treat the last microphone utterance as an interviewer question. */
  const promoteLastMicSegment = useCallback(async () => {
    const last = lastMicSegment.current;
    if (!last) {
      pushError("No microphone transcript to promote yet.");
      return;
    }
    await runDetection(last.text, last.id);
  }, [runDetection, pushError]);

  const manualQuestion = useCallback(
    async (text: string) => {
      await runDetection(text, null);
    },
    [runDetection],
  );

  /* ---------------- meters, timers, network ---------------- */

  useEffect(() => {
    const id = setInterval(() => {
      setMicLevel(micPcm.current?.getLevel() ?? 0);
      setMeetingLevel(meetingPcm.current?.getLevel() ?? 0);
    }, 120);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (startedAt.current && sessionState === "listening") {
        setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sessionState]);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => teardown, [teardown]);

  const debug: DebugInfo = useMemo(
    () => ({
      micTrack: micStream.current?.getAudioTracks()[0]?.readyState ?? "none",
      micTrackLabel: diag.micTrackLabel,
      meetingTrack: meetingStream.current?.getAudioTracks()[0]?.readyState ?? "none",
      meetingTrackLabel: diag.meetingTrackLabel,
      meetingTracksReturned: diag.meetingTracksReturned,
      micLevel,
      meetingLevel: remoteSourceRef.current === "zoom_desktop" ? companionLevel : meetingLevel,
      remoteStt,
      localStt,
      remoteCount: counts.current.remote,
      localCount: counts.current.local,
      lastTranscriptSource: diag.lastTranscriptSource,
      lastQuestion: diag.lastQuestion,
      lastConfidence: diag.lastConfidence,
      aiState: diag.aiState,
      firstTokenMs: diag.firstTokenMs,
      micMode: opts.micMode,
      micRole:
        opts.micMode === "test"
          ? "TEST AUDIO (single source)"
          : opts.micMode === "fallback"
            ? "CANDIDATE (mic-only fallback)"
            : "CANDIDATE (ME)",
      detectionSources:
        opts.micMode === "test"
          ? "microphone (test mode) + interviewer stream"
          : opts.micMode === "fallback" && opts.fallbackAutoDetect
            ? "microphone (fallback auto-detect) + interviewer stream"
            : "interviewer stream only (meeting tab / Zoom Desktop)",
      sttProfile,
      turnStatus: turnRef.current?.status ?? "listening",
      speculativePrepared: turnStats.current.prepared,
      speculativeCancelled: turnStats.current.cancelled,
      specStarted: turnStats.current.specStarted,
      specReused: turnStats.current.specReused,
      specAborted: turnStats.current.specAborted,
      gateRejected: turnStats.current.gateRejected,


      classifierCalls: turnStats.current.classifierCalls,
      companionState,

      companionVersion: companionHealth?.version ?? "not detected",
      companionOs: companionHealth?.os ?? "unknown",
      companionBackend: companionHealth?.captureBackend ?? "unknown",
      remoteCaptureMethod:
        remoteSourceRef.current === "zoom_desktop"
          ? (companionFormat?.captureMethod ?? "companion (pending)")
          : "browser getDisplayMedia (tab audio)",
      remoteSourceDetected:
        remoteSourceRef.current === "zoom_desktop"
          ? companionFormat
            ? companionFormat.sourceDetected
              ? `yes — ${companionFormat.captureTarget}`
              : "no source detected"
            : "unknown"
          : meetingStatus === "active"
            ? "yes — shared tab"
            : "no",
      remoteSampleRate: String(companionFormat?.sampleRate ?? COMPANION_SAMPLE_RATE),
      remoteChannels: String(companionFormat?.channels ?? 1),
      processedSampleRate: `${COMPANION_SAMPLE_RATE} Hz mono linear16`,
      echoSuppressed: counts.current.echo,
      lastCaptureError: diag.lastCaptureError,
      errors,
    }),
    [
      micLevel,
      meetingLevel,
      companionLevel,
      remoteStt,
      localStt,
      errors,
      diag,
      opts.micMode,
      opts.fallbackAutoDetect,
      companionState,
      companionHealth,
      companionFormat,
      meetingStatus,
      sttProfile,
    ],
  );

  return {
    sessionState,
    micStatus,
    meetingStatus,
    micDeviceLabel,
    micLevel,
    meetingLevel: remoteSourceRef.current === "zoom_desktop" ? companionLevel : meetingLevel,
    localStt,
    remoteStt,
    segments,
    interim,
    questions,
    errors,
    online,
    elapsed,
    debug,
    latency,
    latencyHistory,
    aiCall,

    companionHealth,
    companionState,
    connectMicrophone,
    connectMeetingAudio,
    refreshCompanion,
    connectCompanion,
    startCompanionCapture,
    stopCompanionCapture,
    startListening,
    pause,
    resume,
    endSession,
    stopGenerating,
    regenerate,
    togglePin,
    manualQuestion,
    promoteLastMicSegment,
  };
}

