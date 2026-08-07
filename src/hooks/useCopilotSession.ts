import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { createPcmSource, stopStream, type PcmSource } from "@/lib/audio/pcm-source";
import { SttConnection, type SttState } from "@/lib/stt/stt-connection";
import { createSttSession, detectQuestion } from "@/lib/copilot.functions";
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
  id: string;
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
  const [interim, setInterim] = useState<{ microphone: string; remote_meeting: string }>({
    microphone: "",
    remote_meeting: "",
  });
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [online, setOnline] = useState(true);
  const [elapsed, setElapsed] = useState(0);

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
  const counts = useRef({ remote: 0, local: 0 });
  const liveRef = useRef(false);
  const lastConfidence = useRef<number | null>(null);
  const [diag, setDiag] = useState({
    lastTranscriptSource: "none",
    lastQuestion: "",
    lastConfidence: null as number | null,
    aiState: "idle",
    firstTokenMs: null as number | null,
    meetingTracksReturned: "not requested",
    micTrackLabel: "none",
    meetingTrackLabel: "none",
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

  const persistSegment = useCallback(
    async (segment: Segment, confidence: number | null, startMs: number | null, endMs: number | null) => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return;
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

  /* ---------------- answer streaming ---------------- */

  const streamAnswer = useCallback(
    async (questionId: string, overrides?: { style?: string; length?: string }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const t0 = performance.now();
      let firstToken: number | null = null;

      patchDiag({ aiState: "generating", firstTokenMs: null });
      setQuestions((prev) =>
        prev.map((q) => (q.id === questionId ? { ...q, status: "generating", answer: "" } : q)),
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
          setQuestions((prev) => prev.map((q) => (q.id === questionId ? { ...q, status: "error" } : q)));
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
              setQuestions((prev) =>
                prev.map((q) => (q.id === questionId ? { ...q, answer, firstTokenMs: firstToken } : q)),
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
              q.id === questionId ? { ...q, status: "answered", answerId: saved?.id ?? null } : q,
            ),
          );
          await supabase.from("detected_questions").update({ status: "answered" }).eq("id", questionId);
          patchDiag({ aiState: "answered" });
        } else {
          setQuestions((prev) =>
            prev.map((q) => (q.id === questionId ? { ...q, status: "answered" } : q)),
          );
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          patchDiag({ aiState: "stopped" });
          setQuestions((prev) => prev.map((q) => (q.id === questionId ? { ...q, status: "stopped" } : q)));
          return;
        }
        patchDiag({ aiState: "error" });
        pushError(error instanceof Error ? error.message : "Answer generation failed.");
        setQuestions((prev) => prev.map((q) => (q.id === questionId ? { ...q, status: "error" } : q)));
      }
    },
    [sessionId, pushError, patchDiag],
  );

  /* ---------------- question detection ---------------- */

  const runDetection = useCallback(
    async (utterance: string, segmentId: string | null) => {
      const text = utterance.trim();
      if (text.length < 8) return;

      const recentContext = segments
        .slice(-8)
        .map((s) => `${s.speaker === "interviewer" ? "INTERVIEWER" : s.speaker === "test" ? "TEST AUDIO" : "CANDIDATE"}: ${s.text}`)
        .join("\n");

      let result;
      try {
        result = await detectQuestion({ data: { text, recentContext } });
      } catch (error) {
        pushError(error instanceof Error ? error.message : "Question detection failed.");
        return;
      }
      lastConfidence.current = result.confidence;
      patchDiag({ lastConfidence: result.confidence, lastQuestion: result.isQuestion ? result.question : `(not a question) ${text.slice(0, 60)}` });
      if (!result.isQuestion || !result.requiresAnswer) return;
      if (result.confidence < optsRef.current.confidenceThreshold) return;

      const norm = normalize(result.question);
      const now = Date.now();
      recentQuestions.current = recentQuestions.current.filter((q) => now - q.at < 90_000);
      if (recentQuestions.current.some((q) => similar(q.norm, norm) > 0.8)) return;
      recentQuestions.current.push({ norm, at: now });

      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return;
      const { data: inserted, error } = await supabase
        .from("detected_questions")
        .insert({
          user_id: auth.user.id,
          session_id: sessionId,
          transcript_segment_id: segmentId,
          question_text: result.question,
          normalized_question: norm,
          category: result.category,
          confidence: result.confidence,
          status: optsRef.current.autoGenerate ? "generating" : "detected",
        })
        .select("id")
        .single();
      if (error || !inserted) {
        pushError("Could not save the detected question.");
        return;
      }

      setQuestions((prev) => [
        {
          id: inserted.id,
          text: result.question,
          category: result.category,
          confidence: result.confidence,
          status: "generating",
          answer: "",
          answerId: null,
          firstTokenMs: null,
          pinned: false,
        },
        ...prev,
      ]);

      if (optsRef.current.autoGenerate) void streamAnswer(inserted.id);
    },
    [segments, sessionId, pushError, streamAnswer, patchDiag],
  );

  const queueDetection = useCallback(
    (text: string, segmentId: string | null) => {
      if (!optsRef.current.autoDetect) return;
      pendingUtterance.current = `${pendingUtterance.current} ${text}`.trim().slice(-600);
      if (detectTimer.current) clearTimeout(detectTimer.current);
      detectTimer.current = setTimeout(() => {
        const utterance = pendingUtterance.current;
        pendingUtterance.current = "";
        void runDetection(utterance, segmentId);
      }, 700);
    },
    [runDetection],
  );

  /* ---------------- STT wiring ---------------- */

  const handleResult = useCallback(
    (
      source: SourceKind,
      speaker: Speaker,
      result: { text: string; isFinal: boolean; confidence: number | null; startMs: number | null; endMs: number | null },
    ) => {
      if (!result.isFinal) {
        setInterim((prev) => ({ ...prev, [source]: result.text }));
        return;
      }
      setInterim((prev) => ({ ...prev, [source]: "" }));
      patchDiag({
        lastTranscriptSource:
          source === "remote_meeting"
            ? "remote_meeting (INTERVIEWER)"
            : speaker === "test"
              ? "microphone (TEST AUDIO / single source)"
              : "microphone (ME / CANDIDATE)",
      });
      if (source === "remote_meeting") counts.current.remote += 1;
      else counts.current.local += 1;

      const segment: Segment = {
        id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source,
        speaker,
        text: result.text,
        isFinal: true,
        at: Date.now(),
      };
      setSegments((prev) => [...prev.slice(-400), segment]);

      void persistSegment(segment, result.confidence, result.startMs, result.endMs).then((id) => {
        if (source === "microphone") lastMicSegment.current = { text: result.text, id: id ?? null };
        // Production rule: only the remote meeting (INTERVIEWER) stream can auto-trigger
        // question detection. Microphone speech is CANDIDATE and never fires the pipeline,
        // except in explicit STT Test Mode or opt-in mic-only fallback auto-detection.
        const mode = optsRef.current.micMode;
        const eligible =
          source === "remote_meeting" ||
          mode === "test" ||
          (mode === "fallback" && optsRef.current.fallbackAutoDetect);
        if (eligible) queueDetection(result.text, id ?? null);
      });
    },
    [persistSegment, queueDetection, patchDiag],
  );

  const startStt = useCallback(
    (source: SourceKind) => {
      const setState = source === "remote_meeting" ? setRemoteStt : setLocalStt;
      const connection = new SttConnection({
        getToken: async () => createSttSession(),
        language: optsRef.current.language,
        onResult: (result) =>
          handleResult(
            source,
            source === "remote_meeting"
              ? "interviewer"
              : optsRef.current.micMode === "test"
                ? "test"
                : "candidate",
            result,
          ),
        onState: (state, detail) => {
          setState(state);
          if (state === "error" && detail) pushError(detail);
        },
      });
      if (source === "remote_meeting") remoteStt_.current = connection;
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

  /* ---------------- lifecycle ---------------- */

  const startListening = useCallback(async () => {
    if (micPcm.current && !micStt.current) startStt("microphone");
    if (meetingPcm.current && !remoteStt_.current) startStt("remote_meeting");
    startedAt.current = Date.now();
    liveRef.current = true;
    setSessionState("listening");
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
    setSessionState("paused");
  }, []);

  const resume = useCallback(() => {
    micPcm.current?.setPaused(false);
    meetingPcm.current?.setPaused(false);
    setSessionState("listening");
  }, []);

  const teardown = useCallback(() => {
    liveRef.current = false;
    abortRef.current?.abort();
    if (detectTimer.current) clearTimeout(detectTimer.current);
    micStt.current?.stop();
    remoteStt_.current?.stop();
    micStt.current = null;
    remoteStt_.current = null;
    micPcm.current?.stop();
    meetingPcm.current?.stop();
    micPcm.current = null;
    meetingPcm.current = null;
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

  const regenerate = useCallback(
    (questionId: string, overrides?: { style?: string; length?: string }) =>
      streamAnswer(questionId, overrides),
    [streamAnswer],
  );

  const togglePin = useCallback(async (questionId: string) => {
    let next = false;
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== questionId) return q;
        next = !q.pinned;
        return { ...q, pinned: next };
      }),
    );
    const target = questions.find((q) => q.id === questionId);
    if (target?.answerId) {
      await supabase.from("generated_answers").update({ is_pinned: next }).eq("id", target.answerId);
    }
  }, [questions]);

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
      meetingLevel,
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
          ? "microphone (test mode) + meeting"
          : opts.micMode === "fallback" && opts.fallbackAutoDetect
            ? "microphone (fallback auto-detect) + meeting"
            : "meeting/interviewer only",
      errors,
    }),
    [micLevel, meetingLevel, remoteStt, localStt, errors, diag, opts.micMode, opts.fallbackAutoDetect],
  );

  return {
    sessionState,
    micStatus,
    meetingStatus,
    micDeviceLabel,
    micLevel,
    meetingLevel,
    localStt,
    remoteStt,
    segments,
    interim,
    questions,
    errors,
    online,
    elapsed,
    debug,
    connectMicrophone,
    connectMeetingAudio,
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
