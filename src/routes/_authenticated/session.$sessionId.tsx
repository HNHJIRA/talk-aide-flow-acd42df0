import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Mic,
  MonitorSpeaker,
  Pause,
  Play,
  Square,
  RefreshCw,
  Pin,
  StopCircle,
  Send,
  Bug,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AudioLevelMeter, StatusDot } from "@/components/copilot/StatusIndicators";
import { CompanionPanel } from "@/components/copilot/CompanionPanel";

import { useCopilotSession, type SourceStatus } from "@/hooks/useCopilotSession";
import { sttDiagnostics } from "@/lib/copilot.functions";
import { detectCapabilities } from "@/lib/audio/capability";
import { formatDuration, PLATFORM_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LatencyWaterfallPanel } from "@/components/copilot/LatencyWaterfall";

export const Route = createFileRoute("/_authenticated/session/$sessionId")({
  head: () => ({
    meta: [
      { title: "Live copilot — InterviewCopilot" },
      { name: "description", content: "Live transcription, question detection and streaming resume-grounded answers." },
      { property: "og:title", content: "Live copilot — InterviewCopilot" },
      { property: "og:description", content: "Your real-time interview room." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LiveSession,
});

const STATUS_TONE: Record<SourceStatus, "ok" | "pending" | "error" | "off"> = {
  disconnected: "off",
  connecting: "pending",
  active: "ok",
  silent: "pending",
  error: "error",
};

function LiveSession() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const [manual, setManual] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [sttTestMode, setSttTestMode] = useState(false);
  const [fallbackAutoDetect, setFallbackAutoDetect] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const caps = detectCapabilities();

  const { data: session } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("interview_sessions")
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: stt } = useQuery({
    queryKey: ["stt-diagnostics"],
    queryFn: () => sttDiagnostics(),
    staleTime: 60_000,
  });

  const isManualPlatform = session?.meeting_platform === "manual" || session?.meeting_platform === "practice";
  const micOnlyFallback = isManualPlatform;

  const copilot = useCopilotSession({
    sessionId,
    language: session?.answer_language ?? "en",
    autoDetect: true,
    autoGenerate: true,
    confidenceThreshold: 0.6,
    micMode: sttTestMode ? "test" : micOnlyFallback ? "fallback" : "candidate",
    fallbackAutoDetect,
    micConstraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const {
    sessionState,
    micStatus,
    meetingStatus,
    micDeviceLabel,
    micLevel,
    meetingLevel,
    segments,
    interim,
    questions,
    errors,
    online,
    elapsed,
    debug,
    latency,
    latencyHistory,
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
  } = copilot;

  const isZoomDesktop = session?.meeting_platform === "zoom_desktop";
  const [forceTabFallback, setForceTabFallback] = useState(false);
  const needsMeetingAudio = session?.meeting_platform !== "manual" && session?.meeting_platform !== "practice";
  const canStart = micStatus === "active" || meetingStatus === "active";


  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [segments, interim]);

  const live = sessionState === "listening";
  const activeQuestion = useMemo(() => questions[0], [questions]);

  const finish = async () => {
    await endSession();
    toast.success("Session saved");
    void navigate({ to: "/history/$sessionId", params: { sessionId } });
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="flex items-center gap-4">
          <span className="font-sans text-sm font-semibold">
            Interview<span className="text-primary">Copilot</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {session?.title || "Session"} ·{" "}
            {PLATFORM_LABELS[session?.meeting_platform ?? "manual"] ?? session?.meeting_platform}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <StatusDot
            label="Meeting audio"
            status={STATUS_TONE[meetingStatus]}
            detail={meetingStatus === "active" ? "capturing" : meetingStatus}
          />
          <StatusDot
            label="Microphone"
            status={STATUS_TONE[micStatus]}
            detail={micDeviceLabel || micStatus}
          />
          <StatusDot label="Network" status={online ? "ok" : "error"} detail={online ? "" : "offline"} />
          <span className="font-mono text-sm tabular-nums">{formatDuration(elapsed)}</span>
        </div>
      </header>

      {stt && stt.problem ? (
        <div className="border-b border-warning/40 bg-warning/10 px-6 py-2 text-xs text-warning">
          Transcription unavailable: {stt.problem}
          {stt.scopes.length ? ` (current key scopes: ${stt.scopes.join(", ")})` : ""}
        </div>
      ) : null}

      {errors.length ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-xs text-destructive">
          {errors[errors.length - 1]}
        </div>
      ) : null}

      <div className="grid flex-1 gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ---------- left: setup + transcript ---------- */}
        <section className="flex min-h-0 flex-col gap-4">
          <div className="panel p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Audio sources
            </h2>
            <div className="grid gap-3">
              {isZoomDesktop ? (
                <CompanionPanel
                  sessionId={sessionId}
                  health={companionHealth}
                  state={companionState}
                  level={meetingLevel}
                  onRefresh={refreshCompanion}
                  onConnect={(token) => connectCompanion(token, "zoom")}
                  onStartCapture={startCompanionCapture}
                  onStopCapture={stopCompanionCapture}
                  onFallback={() => setForceTabFallback(true)}
                />
              ) : null}

              {!isZoomDesktop || forceTabFallback ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <MonitorSpeaker className="size-4 text-primary" /> Meeting tab
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {meetingStatus === "active"
                        ? "Receiving audio from the shared tab"
                        : "Share the meeting tab and tick “Also share tab audio”"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <AudioLevelMeter level={meetingLevel} label="Meeting" />
                    <Button
                      size="sm"
                      variant={meetingStatus === "active" ? "outline" : "default"}
                      onClick={() => void connectMeetingAudio()}
                      disabled={!caps.hasGetDisplayMedia}
                    >
                      {meetingStatus === "active" ? "Reconnect" : "Connect"}
                    </Button>
                  </div>
                </div>
              ) : null}


              <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Mic className="size-4 text-accent" /> Your microphone
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {micDeviceLabel || "Not connected"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <AudioLevelMeter level={micLevel} label="Microphone" />
                  <Button
                    size="sm"
                    variant={micStatus === "active" ? "outline" : "default"}
                    onClick={() => void connectMicrophone()}
                  >
                    {micStatus === "active" ? "Reconnect" : "Connect"}
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-border p-3">
              <label className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-sm font-medium">STT Test Mode</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {sttTestMode
                      ? "Microphone is labelled TEST AUDIO and may trigger question detection + AI answers. For validating the pipeline only."
                      : "Off — production behaviour: your microphone is CANDIDATE and can never auto-trigger interviewer answers."}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-primary)]"
                  checked={sttTestMode}
                  onChange={(e) => setSttTestMode(e.target.checked)}
                />
              </label>
            </div>

            {!sttTestMode && micOnlyFallback ? (
              <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                Microphone-only fallback: speaker attribution may be inaccurate — every utterance comes from one
                device, so the app will not assume it is the interviewer.
                <div className="mt-2 flex flex-wrap items-center gap-3 text-foreground">
                  <Button size="sm" variant="outline" onClick={() => void promoteLastMicSegment()}>
                    Treat last transcript as interviewer question
                  </Button>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-primary)]"
                      checked={fallbackAutoDetect}
                      onChange={(e) => setFallbackAutoDetect(e.target.checked)}
                    />
                    <span>Single-source auto-detection</span>
                  </label>
                </div>
              </div>
            ) : null}

            {needsMeetingAudio && meetingStatus !== "active" ? (
              <p className="mt-3 text-xs text-warning">
                Without meeting audio only your own speech is transcribed — questions won't be detected.
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              {!live ? (
                <Button onClick={() => void (sessionState === "paused" ? resume() : startListening())} disabled={!canStart}>
                  <Play className="size-4" /> {sessionState === "paused" ? "Resume" : "Go live"}
                </Button>
              ) : (
                <Button variant="outline" onClick={pause}>
                  <Pause className="size-4" /> Pause
                </Button>
              )}
              <Button variant="destructive" onClick={() => void finish()} disabled={sessionState === "idle"}>
                <Square className="size-4" /> End session
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowDebug((v) => !v)}>
                <Bug className="size-4" /> Diagnostics
              </Button>
            </div>

            {showDebug ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted p-3 text-[11px] leading-relaxed">
                {[
                  ["Mic level", `${Math.round(micLevel * 100)}%`],
                  ["Meeting level", `${Math.round(meetingLevel * 100)}%`],
                  ["Mic track", `${debug.micTrack} · ${debug.micTrackLabel}`],
                  ["Meeting track", `${debug.meetingTrack} · ${debug.meetingTrackLabel}`],
                  ["Tracks returned by browser", debug.meetingTracksReturned],
                  ["Deepgram (microphone)", debug.localStt],
                  ["Deepgram (interviewer)", debug.remoteStt],
                  ["Deepgram auth mode", stt?.mode ?? (stt?.problem ? "unavailable" : "…")],
                  ["Session mode", sttTestMode ? "STT TEST MODE" : micOnlyFallback ? "mic-only fallback" : "dual source (production)"],
                  ["Microphone role", debug.micRole],
                  ["Detection sources", debug.detectionSources],
                  ["STT profile (interviewer)", debug.sttProfile],
                  ["Turn state", debug.turnStatus],
                  ["Speculative prep (done/cancelled)", `${debug.speculativePrepared} / ${debug.speculativeCancelled}`],
                  ["Local gate rejects / AI classifier calls", `${debug.gateRejected} / ${debug.classifierCalls}`],
                  ["Companion state", debug.companionState],

                  ["Companion version / OS", `${debug.companionVersion} · ${debug.companionOs}`],
                  ["Companion capture backend", debug.companionBackend],
                  ["Interviewer capture method", debug.remoteCaptureMethod],
                  ["Interviewer source detected", debug.remoteSourceDetected],
                  ["Capture format", `${debug.remoteSampleRate} Hz · ${debug.remoteChannels} ch → ${debug.processedSampleRate}`],
                  ["Echo/duplicate segments dropped", String(debug.echoSuppressed)],
                  ["Last capture error", debug.lastCaptureError],
                  ["Current transcript source", debug.lastTranscriptSource],
                  ["Final segments (interviewer/me)", `${debug.remoteCount} / ${debug.localCount}`],
                  ["Last detected question", debug.lastQuestion || "—"],
                  ["Question confidence", debug.lastConfidence == null ? "—" : debug.lastConfidence.toFixed(2)],
                  ["AI generation state", debug.aiState],
                  ["First-token latency", debug.firstTokenMs == null ? "—" : `${debug.firstTokenMs} ms`],
                  ["Transcription errors", debug.errors.length ? debug.errors[debug.errors.length - 1]! : "none"],

                ].map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="truncate font-mono text-foreground/90" title={String(value)}>
                      {String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {showDebug ? <LatencyWaterfallPanel latency={latency} history={latencyHistory} /> : null}
          </div>


          <div className="panel flex min-h-0 flex-1 flex-col p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Live transcript
            </h2>
            <div ref={transcriptRef} className="min-h-[240px] flex-1 space-y-3 overflow-y-auto pr-2">
              {segments.map((segment) => (
                <p key={segment.id} className="text-sm">
                  <span
                    className={cn(
                      "mr-2 text-[11px] font-semibold uppercase tracking-wide",
                      segment.speaker === "interviewer"
                        ? "text-primary"
                        : segment.speaker === "test"
                          ? "text-warning"
                          : "text-accent",
                    )}
                  >
                    {segment.speaker === "interviewer"
                      ? "Interviewer"
                      : segment.speaker === "test"
                        ? "Test audio"
                        : "You"}
                  </span>
                  <span className="text-foreground/90">{segment.text}</span>
                </p>
              ))}
              {interim.remote_meeting || interim.zoom_desktop ? (
                <p className="text-sm italic text-muted-foreground">
                  {interim.remote_meeting || interim.zoom_desktop}
                </p>

              ) : null}
              {interim.microphone ? (
                <p className="text-sm italic text-muted-foreground">{interim.microphone}</p>
              ) : null}
              {segments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Connect your sources and go live — speech appears here in real time.
                </p>
              ) : null}
            </div>

            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!manual.trim()) return;
                void manualQuestion(manual.trim());
                setManual("");
              }}
            >
              <Input
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                placeholder="Type a question to answer manually…"
              />
              <Button type="submit" size="icon" variant="outline">
                <Send className="size-4" />
              </Button>
            </form>
          </div>
        </section>

        {/* ---------- right: answers ---------- */}
        <section className="flex min-h-0 flex-col gap-4">
          <div className="panel flex min-h-0 flex-1 flex-col p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Detected questions
              </h2>
              {activeQuestion?.status === "generating" ? (
                <Button size="sm" variant="ghost" onClick={stopGenerating}>
                  <StopCircle className="size-4" /> Stop
                </Button>
              ) : null}
            </div>

            <div className="min-h-[320px] flex-1 space-y-4 overflow-y-auto pr-2">
              {questions.map((question, index) => (
                <article
                  key={question.id}
                  className={cn(
                    "rounded-xl border border-border p-4",
                    index === 0 && "border-primary/50 bg-primary/[0.04]",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{question.text}</p>
                    <div className="flex shrink-0 gap-1">
                      <Button size="icon" variant="ghost" onClick={() => void togglePin(question.id)}>
                        <Pin className={cn("size-4", question.pinned && "fill-primary text-primary")} />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => void regenerate(question.id)}>
                        <RefreshCw className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {question.category}
                    {question.firstTokenMs ? ` · first token ${question.firstTokenMs}ms` : ""}
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                    {question.answer}
                    {question.status === "generating" ? (
                      <span className="ml-1 inline-block h-4 w-[2px] animate-pulse bg-primary align-middle" />
                    ) : null}
                  </p>
                  {question.status === "error" ? (
                    <p className="mt-2 text-xs text-destructive">Answer failed — try regenerating.</p>
                  ) : null}
                </article>
              ))}
              {questions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  When the interviewer asks something, it shows up here with an answer streaming in.
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
