import { STT_SAMPLE_RATE } from "@/lib/audio/pcm-source";

export type SttState = "idle" | "connecting" | "active" | "reconnecting" | "error" | "closed";

/** Which Deepgram pipeline is actually carrying this socket right now. */
export type SttProfile = "flux" | "standard";

export type SttEvent =
  | "interim"
  | "start_of_turn"
  | "eager_end_of_turn"
  | "turn_resumed"
  | "final";


export type SttResult = {
  text: string;
  isFinal: boolean;
  confidence: number | null;
  startMs: number | null;
  endMs: number | null;
  /** Richer turn signal; "interim"/"final" for the classic pipeline. */
  event: SttEvent;
  turnIndex: number | null;
};

type Options = {
  getToken: () => Promise<{ key: string; expiresAt: string; mode?: string }>;
  language?: string;
  /**
   * Ask for the low-latency conversational pipeline (Deepgram Flux) on this
   * socket. Interviewer/remote audio only; the candidate microphone keeps the
   * proven standard pipeline. Falls back automatically when unavailable.
   */
  lowLatency?: boolean;
  onResult: (result: SttResult) => void;
  onState: (state: SttState, detail?: string) => void;
  onProfile?: (profile: SttProfile, detail: string) => void;
};

const FLUX_URL = "wss://api.deepgram.com/v2/listen";
const STANDARD_URL = "wss://api.deepgram.com/v1/listen";

/**
 * One streaming Deepgram connection. Explicit lifecycle: exactly one socket per
 * instance, reconnects with exponential backoff, never spawns duplicates.
 */
export class SttConnection {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempts = 0;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: ArrayBuffer[] = [];
  private state: SttState = "idle";
  private profile: SttProfile;
  private fluxOpened = false;
  private fluxDisabled = false;

  constructor(private readonly opts: Options) {
    this.profile = opts.lowLatency ? "flux" : "standard";
  }

  getState() {
    return this.state;
  }

  getProfile() {
    return this.profile;
  }

  private setState(state: SttState, detail?: string) {
    this.state = state;
    this.opts.onState(state, detail);
  }

  async start() {
    this.closedByUser = false;
    await this.connect();
  }

  private buildUrl() {
    if (this.profile === "flux") {
      const params = new URLSearchParams({
        model: "flux-general-en",
        encoding: "linear16",
        sample_rate: String(STT_SAMPLE_RATE),
        // Emit a speculative end-of-turn early so speculative preparation can start
        // before the confirmed end of turn arrives.
        eager_eot_threshold: "0.6",
        eot_threshold: "0.7",
      });
      return `${FLUX_URL}?${params.toString()}`;
    }
    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: String(STT_SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      // Tightened from 300/1000: finalisation is the first link of the latency chain.
      endpointing: this.opts.lowLatency ? "150" : "300",
      utterance_end_ms: this.opts.lowLatency ? "1000" : "1000",
      language: this.opts.language ?? "en",
    });
    return `${STANDARD_URL}?${params.toString()}`;
  }

  private async connect() {
    if (this.closedByUser) return;
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");
    let token: { key: string; mode?: string };
    try {
      token = await this.opts.getToken();
    } catch (error) {
      this.setState("error", error instanceof Error ? error.message : "Could not authorize transcription");
      this.scheduleReconnect();
      return;
    }

    // A /v1/auth/grant access token authenticates with the "bearer" subprotocol;
    // a raw API key would use "token". We only ever receive the short-lived grant token.
    const ws = new WebSocket(this.buildUrl(), [
      token.mode === "grant" ? "bearer" : "token",
      token.key,
    ]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    const openedWithProfile = this.profile;

    ws.onopen = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.attempts = 0;
      if (openedWithProfile === "flux") this.fluxOpened = true;
      this.opts.onProfile?.(
        openedWithProfile,
        openedWithProfile === "flux"
          ? "Deepgram Flux (conversational end-of-turn)"
          : this.opts.lowLatency
            ? "nova-3 (endpointing 150ms)"
            : "nova-3 (endpointing 300ms)",
      );
      this.setState("active");
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 8000);
      const pending = this.queue;
      this.queue = [];
      pending.forEach((chunk) => ws.send(chunk));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (openedWithProfile === "flux") this.handleFlux(payload);
        else this.handleStandard(payload);
      } catch {
        /* ignore malformed frame */
      }
    };

    ws.onerror = () => {
      if (openedWithProfile === "flux" && !this.fluxOpened) return; // handled in onclose
      this.setState("error", "Transcription connection error");
    };

    ws.onclose = () => {
      this.clearKeepAlive();
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      // Flux never came up on this project/key: permanently drop to the proven pipeline.
      if (openedWithProfile === "flux" && !this.fluxOpened) {
        this.fluxDisabled = true;
        this.profile = "standard";
        this.opts.onProfile?.(
          "standard",
          "Flux unavailable — fell back to nova-3 (endpointing 150ms)",
        );
        void this.connect();
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Classic /v1/listen Results frames. */
  private handleStandard(payload: Record<string, unknown>) {
    const type = payload["type"] as string | undefined;
    if (type && type !== "Results") return;
    const channel = payload["channel"] as
      | { alternatives?: { transcript?: string; confidence?: number }[] }
      | undefined;
    const alt = channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (!text) return;
    const start = payload["start"] as number | undefined;
    const duration = payload["duration"] as number | undefined;
    const isFinal = Boolean(payload["is_final"]);
    this.opts.onResult({
      text,
      isFinal,
      confidence: alt?.confidence ?? null,
      startMs: start != null ? Math.round(start * 1000) : null,
      endMs: start != null && duration != null ? Math.round((start + duration) * 1000) : null,
      event: isFinal ? "final" : "interim",
      turnIndex: null,
    });
  }

  /** Flux TurnInfo frames: Update / EagerEndOfTurn / TurnResumed / EndOfTurn. */
  private handleFlux(payload: Record<string, unknown>) {
    if (payload["type"] !== "TurnInfo") return;
    const evt = String(payload["event"] ?? "");
    const text = String(payload["transcript"] ?? "").trim();
    const turnIndex = typeof payload["turn_index"] === "number" ? (payload["turn_index"] as number) : null;
    const confidence =
      typeof payload["end_of_turn_confidence"] === "number"
        ? (payload["end_of_turn_confidence"] as number)
        : null;

    const map: Record<string, SttEvent | undefined> = {
      Update: "interim",
      StartOfTurn: undefined,
      EagerEndOfTurn: "eager_end_of_turn",
      TurnResumed: "turn_resumed",
      EndOfTurn: "final",
    };
    const mapped = map[evt];
    if (!mapped) return;
    if (mapped !== "turn_resumed" && !text) return;

    this.opts.onResult({
      text,
      isFinal: mapped === "final",
      confidence,
      startMs: null,
      endMs: null,
      event: mapped,
      turnIndex,
    });
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempts, 5));
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.fluxDisabled) this.profile = "standard";
      void this.connect();
    }, delay);
  }

  send(chunk: ArrayBuffer) {
    if (this.closedByUser) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else if (this.queue.length < 40) {
      this.queue.push(chunk);
    }
  }

  private clearKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  stop() {
    this.closedByUser = true;
    this.clearKeepAlive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.queue = [];
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* noop */
      }
      ws.close();
    }
    this.setState("closed");
  }
}
