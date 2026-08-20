import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Mic,
  MonitorSpeaker,
  Laptop,
  TriangleAlert,
  Pause,
  Play,
  Square,
  RefreshCw,
  Pin,
  StopCircle,
  Send,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/copilot/StatusIndicators";
import { DockSource } from "@/components/copilot/DockSource";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CompanionPanel } from "@/components/copilot/CompanionPanel";
import { OverlayControl } from "@/components/copilot/OverlayControl";
import { ParticipantsPanel } from "@/components/copilot/ParticipantsPanel";
import { useOverlayPublisher } from "@/hooks/useOverlayPublisher";

import { useCopilotSession, type SourceStatus } from "@/hooks/useCopilotSession";
import { sttDiagnostics } from "@/lib/copilot.functions";
import { detectCapabilities } from "@/lib/audio/capability";
import { formatDuration, PLATFORM_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LatencyWaterfallPanel } from "@/components/copilot/LatencyWaterfall";

const COMPANION_STATUS: Record<string, string> = {
  not_installed: "Companion not detected",
  disconnected: "Not connected",
  pairing: "Pairing…",
  connected: "Paired — ready to capture",
  requesting_permission: "Waiting for OS audio permission",
  ready: "Ready",
  capturing: "Connected · Interviewer",
  silent: "Paired — no Zoom audio",
  reconnecting: "Reconnecting…",
  error: "Companion error",
  stopped: "Stopped",
};

export const Route = createFileRoute("/_authenticated/session/$sessionId")({
  head: () => ({
    meta: [
      { title: "Live copilot — InterviewCopilot" },
      {
        name: "description",
        content: "Live transcription, question detection and streaming resume-grounded answers.",
      },
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
  const [showDebug] = useState(true);
  const [sttTestMode, setSttTestMode] = useState(false);
  const [fallbackAutoDetect, setFallbackAutoDetect] = useState(false);
  const [multiParticipant, setMultiParticipant] = useState(true);
  const [autoAssignFirstSpeaker, setAutoAssignFirstSpeaker] = useState(true);
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

  const isManualPlatform =
    session?.meeting_platform === "manual" || session?.meeting_platform === "practice";
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
    multiParticipant,
    autoAssignFirstSpeaker,
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
    speakers,
    setSpeakerRole,
    setPrimarySpeaker,
    renameSpeaker,
    diarizationNote,
  } = copilot;

  const isZoomDesktop = session?.meeting_platform === "zoom_desktop";
  const [forceTabFallback, setForceTabFallback] = useState(false);
  const needsMeetingAudio =
    session?.meeting_platform !== "manual" && session?.meeting_platform !== "practice";
  const canStart = micStatus === "active" || meetingStatus === "active";

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [segments, interim]);

  const live = sessionState === "listening";
  const activeQuestion = useMemo(() => questions[0], [questions]);

  /* Private overlay: a thin, read-only publisher on top of the existing session. */
  const overlay = useOverlayPublisher({
    sessionId,
    sessionTitle: session?.title ?? "Interview session",
    live,
    paused: sessionState === "paused",
    generating: questions.some((q) => q.status === "generating"),
    elapsed,
    source:
      isZoomDesktop && !forceTabFallback
        ? "Zoom Desktop"
        : meetingStatus === "active"
          ? "Meeting tab"
          : sttTestMode
            ? "Helper (mic)"
            : "Microphone",
    micLabel: micStatus === "active" ? (sttTestMode ? "Helper" : "Candidate") : "Mic off",
    questions,
  });

  const finish = async () => {
    await endSession();
    toast.success("Session saved");
    void navigate({ to: "/history/$sessionId", params: { sessionId } });
  };

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-3">
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
          <StatusDot
            label="Network"
            status={online ? "ok" : "error"}
            detail={online ? "" : "offline"}
          />
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

      {/* ---------- main: transcript | questions ---------- */}
      <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ---------- left: transcript ---------- */}
        <section className="panel order-2 flex min-h-0 flex-col p-5 lg:order-1">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Live transcript
            </h2>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                live
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-border text-muted-foreground",
              )}
            >
              {live ? "Live" : sessionState === "paused" ? "Paused" : "Idle"}
            </span>
          </div>
          <div ref={transcriptRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
            {interim.remote_meeting || interim.zoom_desktop ? (
              <p className="text-sm italic text-muted-foreground">
                {interim.remote_meeting || interim.zoom_desktop}
              </p>
            ) : null}
            {interim.microphone ? (
              <p className="text-sm italic text-muted-foreground">{interim.microphone}</p>
            ) : null}
            {[...segments].reverse().map((segment) => (
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
                    ? (segment.speakerLabel ??
                      (multiParticipant && segment.speakerId == null
                        ? "Remote unknown"
                        : "Interviewer"))
                    : segment.speaker === "test"
                      ? "Helper"
                      : "You"}
                </span>
                <span className="text-foreground/90">{segment.text}</span>
              </p>
            ))}
            {segments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect your sources and go live — speech appears here in real time.
              </p>
            ) : null}
          </div>

          <form
            className="mt-3 flex gap-2 border-t border-border/70 pt-3"
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
        </section>

        {/* ---------- right: answers ---------- */}
        <section className="panel order-1 flex min-h-0 flex-col p-5 lg:order-2">
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

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
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
                      <Pin
                        className={cn("size-4", question.pinned && "fill-primary text-primary")}
                      />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void regenerate(question.id)}
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {question.askedBy ? `${question.askedBy} · ` : ""}
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
        </section>
      </div>

      {/* ---------- diagnostics drawer ---------- */}
      {showDebug ? (
        <div className="max-h-[42vh] overflow-y-auto border-t border-border bg-card/60 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted p-3 text-[11px] leading-relaxed md:grid-cols-4">
            {[
              ["Mic level", `${Math.round(micLevel * 100)}%`],
              ["Meeting level", `${Math.round(meetingLevel * 100)}%`],
              ["Mic track", `${debug.micTrack} · ${debug.micTrackLabel}`],
              ["Meeting track", `${debug.meetingTrack} · ${debug.meetingTrackLabel}`],
              ["Tracks returned by browser", debug.meetingTracksReturned],
              ["Deepgram (microphone)", debug.localStt],
              ["Deepgram (interviewer)", debug.remoteStt],
              ["Deepgram auth mode", stt?.mode ?? (stt?.problem ? "unavailable" : "…")],
              [
                "Session mode",
                sttTestMode
                  ? "HELPER MODE"
                  : micOnlyFallback
                    ? "mic-only fallback"
                    : "dual source (production)",
              ],
              ["Microphone role", debug.micRole],
              ["Detection sources", debug.detectionSources],
              ["STT profile (interviewer)", debug.sttProfile],
              ["Turn state", debug.turnStatus],
              ["Interviewer turn id", debug.turnId],
              ["Segments in current turn", String(debug.turnSegments)],
              ["Assembled turn text", debug.turnAssembled || "—"],
              ["Continuation guard", debug.lastContinuationReason],
              ["Turn revision", `r${debug.turnRevision}`],
              ["Current turn silence", `${debug.turnSilenceMs} ms`],
              ["Turn stage", debug.turnStage],
              ["Hard commits (silence deadline)", String(debug.hardCommits)],
              ["Late-continuation window", debug.lateWindowState],
              ["Late continuations detected", String(debug.lateContinuations)],
              [
                "Turns reopened / answers superseded",
                `${debug.turnsReopened} / ${debug.answersSuperseded}`,
              ],
              [
                "Segments merged / turns resumed",
                `${debug.segmentsMerged} / ${debug.turnsResumed}`,
              ],
              ["Grace-window holds", String(debug.graceHolds)],
              ["Duplicate answers blocked", String(debug.duplicateAnswersBlocked)],
              [
                "Speculative started / reused / aborted",
                `${debug.specStarted} / ${debug.specReused} / ${debug.specAborted}`,
              ],
              [
                "Speculative prep (done/cancelled)",
                `${debug.speculativePrepared} / ${debug.speculativeCancelled}`,
              ],
              [
                "Local gate rejects / AI classifier calls",
                `${debug.gateRejected} / ${debug.classifierCalls}`,
              ],

              ["— REMOTE DIARIZATION —", ""],
              ["Diarization enabled", debug.diarization],
              ["Model", debug.diarizationModel],
              ["Actual request configuration", debug.diarizationRequestConfig],
              ["Diarization requested", debug.diarizationRequested],
              ["Diarization active", debug.diarizationActive],
              ["Raw unique speaker IDs seen this session", debug.rawUniqueSpeakerIds],
              ["Word counts per raw speaker ID", debug.wordsBySpeaker],
              ["Roster speaker IDs", debug.rosterSpeakerIds],
              ["Roster participants (raw ID / names / role)", debug.rosterParticipants],
              ["Current active speaker", debug.currentDiarizedSpeaker],
              ["Speaker changes detected", String(debug.speakerChangesDetected)],
              ["Unknown / missing speaker words", String(debug.unknownSpeakerWords)],
              ["Roster entries created", String(debug.rosterEntriesCreated)],
              ["Raw diarized words (latest final)", debug.rawDiarizedWords],
              ["Remote speakers", debug.remoteSpeakers],
              ["Answers routed from", debug.answersRoutedFrom],
              ["Current turn speaker", debug.turnSpeaker],
              [
                "Routed / ignored / unassigned segments",
                `${debug.routedSegments} / ${debug.ignoredSegments} / ${debug.unassignedSegments}`,
              ],
              ["Turn splits on speaker change", String(debug.turnSpeakerSplits)],

              ["— CONVERSATION INTELLIGENCE —", ""],
              ["Current topic", debug.currentTopic],
              ["Raw transcript (turn)", debug.rawTranscript || "—"],
              ["Resolved transcript (turn)", debug.resolvedTranscript || "—"],
              ["Corrections detected", String(debug.correctionsDetected)],
              ["Last correction", debug.lastCorrection],
              ["Sub-questions in turn", debug.subQuestions],
              ["Meeting turns remembered", String(debug.meetingTurnsRemembered)],
              [
                "Facts / claims available",
                `${debug.meetingFactsAvailable} / ${debug.candidateClaimsAvailable}`,
              ],
              [
                "Context packet (turns/facts/claims)",
                `${debug.packetRecentTurns} / ${debug.packetMeetingFacts} / ${debug.packetCandidateClaims}`,
              ],
              ["Rolling summary updated", debug.rollingSummaryUpdated],

              ["Companion state", debug.companionState],
              ["Companion version / OS", `${debug.companionVersion} · ${debug.companionOs}`],
              ["Companion capture backend", debug.companionBackend],
              ["Interviewer capture method", debug.remoteCaptureMethod],
              ["Interviewer source detected", debug.remoteSourceDetected],
              [
                "Capture format",
                `${debug.remoteSampleRate} Hz · ${debug.remoteChannels} ch → ${debug.processedSampleRate}`,
              ],
              ["Echo/duplicate segments dropped", String(debug.echoSuppressed)],
              ["Last capture error", debug.lastCaptureError],
              ["Current transcript source", debug.lastTranscriptSource],
              ["Final segments (interviewer/me)", `${debug.remoteCount} / ${debug.localCount}`],
              ["Last detected question", debug.lastQuestion || "—"],
              [
                "Question confidence",
                debug.lastConfidence == null ? "—" : debug.lastConfidence.toFixed(2),
              ],
              ["AI generation state", debug.aiState],
              [
                "First-token latency",
                debug.firstTokenMs == null ? "—" : `${debug.firstTokenMs} ms`,
              ],
              [
                "Transcription errors",
                debug.errors.length ? debug.errors[debug.errors.length - 1]! : "none",
              ],
            ].map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd
                  className={cn(
                    "font-mono text-foreground/90",
                    label === "Raw diarized words (latest final)"
                      ? "max-h-32 overflow-y-auto whitespace-pre-wrap break-words"
                      : "truncate",
                  )}
                  title={String(value)}
                >
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <LatencyWaterfallPanel latency={latency} history={latencyHistory} aiCall={aiCall} />
        </div>
      ) : null}

      {/* ---------- bottom meeting control dock ---------- */}
      <div className="sticky bottom-0 z-20 border-t border-border bg-background/85 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex flex-wrap items-center gap-3">
          {/* interviewer source */}
          {isZoomDesktop && !forceTabFallback ? (
            <DockSource
              icon={Laptop}
              title="Zoom Desktop"
              state={
                companionState === "capturing"
                  ? "connected"
                  : companionState === "silent"
                    ? "warning"
                    : companionState === "error"
                      ? "error"
                      : companionState === "pairing" ||
                          companionState === "reconnecting" ||
                          companionState === "requesting_permission"
                        ? "connecting"
                        : "disconnected"
              }
              statusLabel={COMPANION_STATUS[companionState] ?? "Not connected"}
              meta={
                companionHealth
                  ? `${companionHealth.os ?? "Desktop"} • ${companionHealth.captureBackend}`
                  : null
              }
              level={meetingLevel}
              action={
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline">
                      Companion
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="end" className="w-[340px]">
                    <CompanionPanel
                      embedded
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
                  </PopoverContent>
                </Popover>
              }
            />
          ) : (
            <DockSource
              icon={MonitorSpeaker}
              title="Meeting audio"
              state={
                meetingStatus === "active"
                  ? "connected"
                  : meetingStatus === "connecting"
                    ? "connecting"
                    : meetingStatus === "silent"
                      ? "warning"
                      : meetingStatus === "error"
                        ? "error"
                        : "disconnected"
              }
              statusLabel={
                meetingStatus === "active"
                  ? "Connected · Interviewer"
                  : meetingStatus === "connecting"
                    ? "Connecting…"
                    : meetingStatus === "silent"
                      ? "No audio detected"
                      : meetingStatus === "error"
                        ? "Capture failed"
                        : "Not connected"
              }
              level={meetingLevel}
              meta={!caps.hasGetDisplayMedia ? "This browser can't share tab audio." : null}
              action={
                <Button
                  size="sm"
                  variant={meetingStatus === "active" ? "outline" : "default"}
                  onClick={() => void connectMeetingAudio()}
                  disabled={!caps.hasGetDisplayMedia}
                >
                  {meetingStatus === "active" ? "Reconnect" : "Connect"}
                </Button>
              }
            />
          )}

          {needsMeetingAudio &&
          meetingStatus !== "active" &&
          !(isZoomDesktop && !forceTabFallback) ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] font-medium text-warning transition-colors duration-200 hover:bg-warning/15"
                >
                  <TriangleAlert className="size-3.5" /> Meeting audio required
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-[280px] text-xs">
                Without meeting audio only your own speech is transcribed — interviewer questions
                won't be detected.
              </PopoverContent>
            </Popover>
          ) : null}

          {/* microphone */}
          <DockSource
            icon={Mic}
            tone="accent"
            title="Your microphone"
            state={
              micStatus === "active"
                ? "connected"
                : micStatus === "connecting"
                  ? "connecting"
                  : micStatus === "silent"
                    ? "warning"
                    : micStatus === "error"
                      ? "error"
                      : "disconnected"
            }
            statusLabel={
              micStatus === "active"
                ? `Connected · ${sttTestMode ? "Helper" : "Candidate"}`
                : micStatus === "connecting"
                  ? "Connecting…"
                  : micStatus === "error"
                    ? "Microphone blocked"
                    : "Not connected"
            }
            meta={micDeviceLabel || null}
            level={micLevel}
            action={
              <Button
                size="sm"
                variant={micStatus === "active" ? "outline" : "default"}
                onClick={() => void connectMicrophone()}
              >
                {micStatus === "active" ? "Reconnect" : "Connect"}
              </Button>
            }
          />

          {isZoomDesktop ? (
            <div
              role="tablist"
              aria-label="Meeting source"
              className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
            >
              {[
                { key: "zoom", label: "Zoom", icon: Laptop },
                { key: "tab", label: "Tab", icon: MonitorSpeaker },
              ].map((option) => {
                const selected = option.key === "tab" ? forceTabFallback : !forceTabFallback;
                return (
                  <button
                    key={option.key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setForceTabFallback(option.key === "tab")}
                    className={cn(
                      "flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-200",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <option.icon className="size-3.5" /> {option.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* remote participants / interviewer routing */}
          <ParticipantsPanel
            speakers={speakers}
            enabled={multiParticipant}
            onEnabledChange={setMultiParticipant}
            autoAssignFirst={autoAssignFirstSpeaker}
            onAutoAssignChange={setAutoAssignFirstSpeaker}
            onSetRole={setSpeakerRole}
            onSetPrimary={setPrimarySpeaker}
            onRename={renameSpeaker}
            note={diarizationNote}
          />

          {/* private overlay */}
          <OverlayControl
            settings={overlay.settings}
            patch={overlay.patch}
            linkState={overlay.linkState}
            status={overlay.status}
            health={overlay.health}
            pairingCode={overlay.pairingCode}
            busy={overlay.busy}
            error={overlay.error}
            onPair={() => void overlay.startPairing()}
            onDisconnect={overlay.disconnect}
            onRefresh={() => void overlay.refresh()}
          />

          {/* Helper toggle */}

          <div
            className="flex shrink-0 items-center gap-2 rounded-xl border border-border/70 bg-card/50 px-3 py-2"
            title="Helper mode — microphone speech is treated as interviewer input so you can validate the pipeline without a meeting."
          >
            <label
              htmlFor="stt-test-mode"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Helper
            </label>
            <Switch id="stt-test-mode" checked={sttTestMode} onCheckedChange={setSttTestMode} />
          </div>

          {!sttTestMode && micOnlyFallback ? (
            <div className="flex shrink-0 items-center gap-2 rounded-xl border border-warning/30 bg-warning/[0.07] px-3 py-2">
              <Button size="sm" variant="outline" onClick={() => void promoteLastMicSegment()}>
                Promote to question
              </Button>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Switch checked={fallbackAutoDetect} onCheckedChange={setFallbackAutoDetect} />
                <span>Auto-detect</span>
              </label>
            </div>
          ) : null}

          {/* primary actions */}
          <div className="ml-auto flex items-center gap-2">
            {!live ? (
              <Button
                onClick={() => void (sessionState === "paused" ? resume() : startListening())}
                disabled={!canStart}
                className="px-5"
              >
                <Play className="size-4" /> {sessionState === "paused" ? "Resume" : "Go live"}
              </Button>
            ) : (
              <Button variant="outline" onClick={pause}>
                <Pause className="size-4" /> Pause
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void finish()}
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              <Square className="size-4" /> End
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
