/**
 * Per-turn latency instrumentation for the live interviewer pipeline.
 *
 * Every mark is a browser `performance.now()` timestamp so the whole waterfall
 * is measured on one clock. Nothing here touches the network or React state.
 */

export type LatencyMark =
  | "audioFirstPacket"
  | "sttFirstInterim"
  | "sttStableInterim"
  | "eagerEot"
  | "speculativeStart"
  | "speechEnd"
  | "sttFinal"
  | "gateStart"
  | "gateDone"
  | "classifierStart"
  | "classifierDone"
  | "prefetchStart"
  | "prefetchDone"
  | "contextStart"
  | "contextDone"
  | "aiRequestStart"
  | "aiResponseHeaders"
  | "streamOpen"
  | "aiFirstToken"
  | "aiFirstRender"
  | "aiComplete";


export type TurnStatus =
  | "listening"
  | "preparing"
  | "confirmed"
  | "generating"
  | "cancelled"
  | "completed";

export type TurnTimings = Partial<Record<LatencyMark, number>>;

export type LatencyWaterfall = {
  turnId: string;
  sttFirstInterimMs: number | null;
  speechEndToFinalMs: number | null;
  questionGateMs: number | null;
  classifierUsed: boolean;
  classifierMs: number | null;
  contextMs: number | null;
  contextPrefetch: "hit" | "miss" | "none";
  aiRequestMs: number | null;
  aiTtftMs: number | null;
  serverToBrowserMs: number | null;
  browserRenderMs: number | null;
  totalMs: number | null;
  completeMs: number | null;
  /* --- speculative head start --- */
  speculative: boolean;
  speculativeReused: boolean;
  speculativeCancelled: boolean;
  /** ms the AI request ran before the confirmed end of turn (client clock). */
  headStartMs: number | null;
  /** ms the PROVIDER was already generating before the confirmed end of turn. */
  providerHeadStartMs: number | null;
  /** aiRequestStart -> first byte of the SSE prelude (pure transport + server prelude). */
  streamOpenMs: number | null;
  /** first upstream byte forwarded by the server -> first token seen by the browser. */
  transportOverheadMs: number | null;
  /** characters already generated (and hidden) at confirmation. */
  bufferedCharsAtConfirm: number | null;
  /** confirmed end of turn -> first visible token. This is the felt latency. */
  visibleAfterConfirmMs: number | null;
};



const diff = (a: number | undefined, b: number | undefined) =>
  a != null && b != null ? Math.round(b - a) : null;

export class TurnTimer {
  readonly turnId: string;
  readonly marks: TurnTimings = {};
  classifierUsed = false;
  contextPrefetch: "hit" | "miss" | "none" = "none";
  /** Server-reported ms spent between request arrival and first upstream token. */
  serverTtftMs: number | null = null;
  /* --- speculative generation --- */
  speculative = false;
  speculativeReused = false;
  speculativeCancelled = false;
  bufferedCharsAtConfirm: number | null = null;

  constructor(turnId: string) {
    this.turnId = turnId;
  }

  mark(name: LatencyMark, value = performance.now()) {
    if (this.marks[name] == null) this.marks[name] = value;
    return value;
  }

  /** Re-mark: used when a speculative stage restarts within the same turn. */
  remark(name: LatencyMark, value = performance.now()) {
    this.marks[name] = value;
    return value;
  }

  waterfall(): LatencyWaterfall {
    const m = this.marks;
    const anchor = m.speechEnd ?? m.sttFinal;
    return {
      turnId: this.turnId,
      sttFirstInterimMs: diff(m.audioFirstPacket, m.sttFirstInterim),
      speechEndToFinalMs: diff(m.speechEnd, m.sttFinal),
      questionGateMs: diff(m.gateStart, m.gateDone),
      classifierUsed: this.classifierUsed,
      classifierMs: diff(m.classifierStart, m.classifierDone),
      contextMs: diff(m.contextStart, m.contextDone),
      contextPrefetch: this.contextPrefetch,
      aiRequestMs: diff(m.sttFinal, m.aiRequestStart),
      aiTtftMs: diff(m.aiRequestStart, m.aiFirstToken),
      serverToBrowserMs:
        this.serverTtftMs != null && m.aiRequestStart != null && m.aiFirstToken != null
          ? Math.max(0, Math.round(m.aiFirstToken - m.aiRequestStart - this.serverTtftMs))
          : null,
      browserRenderMs: diff(m.aiFirstToken, m.aiFirstRender),
      totalMs: diff(anchor, m.aiFirstRender),
      completeMs: diff(anchor, m.aiComplete),
      speculative: this.speculative,
      speculativeReused: this.speculativeReused,
      speculativeCancelled: this.speculativeCancelled,
      headStartMs: diff(m.aiRequestStart, m.sttFinal),
      bufferedCharsAtConfirm: this.bufferedCharsAtConfirm,
      visibleAfterConfirmMs: diff(m.sttFinal, m.aiFirstRender),
    };
  }
}

export const EMPTY_WATERFALL: LatencyWaterfall = {
  turnId: "—",
  sttFirstInterimMs: null,
  speechEndToFinalMs: null,
  questionGateMs: null,
  classifierUsed: false,
  classifierMs: null,
  contextMs: null,
  contextPrefetch: "none",
  aiRequestMs: null,
  aiTtftMs: null,
  serverToBrowserMs: null,
  browserRenderMs: null,
  totalMs: null,
  completeMs: null,
  speculative: false,
  speculativeReused: false,
  speculativeCancelled: false,
  headStartMs: null,
  bufferedCharsAtConfirm: null,
  visibleAfterConfirmMs: null,
};


export const ms = (value: number | null) => (value == null ? "—" : `${value} ms`);

/** Server-reported configuration and usage for one live AI answer call. */
export type LiveCallMeta = {
  requestedModel: string;
  actualModel: string | null;
  provider?: string | null;
  requestedEffort: string;
  actualEffort: string;
  requestedTier: string;
  actualTier: string;
  fallbackReason?: string | null;
  latencyMode: string;
  maxOutputTokens: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  promptChars?: number;
  resumeChars?: number;
  conversationChars?: number;
  priorQnaChars?: number;
  jobChars?: number;
  serverRequestSentMs?: number;
  upstreamHeadersMs: number;
  upstreamFirstEventMs?: number | null;
  upstreamFirstDeltaMs: number | null;
  upstreamTotalMs: number;
  contextChars: number;

  context: "hit" | "miss";
};

