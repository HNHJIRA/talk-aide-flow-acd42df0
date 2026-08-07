import { STT_SAMPLE_RATE } from "@/lib/audio/pcm-source";

export type SttState = "idle" | "connecting" | "active" | "reconnecting" | "error" | "closed";

export type SttResult = {
  text: string;
  isFinal: boolean;
  confidence: number | null;
  startMs: number | null;
  endMs: number | null;
};

type Options = {
  getToken: () => Promise<{ key: string; expiresAt: string; mode?: string }>;
  language?: string;
  onResult: (result: SttResult) => void;
  onState: (state: SttState, detail?: string) => void;
};

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

  constructor(private readonly opts: Options) {}

  getState() {
    return this.state;
  }

  private setState(state: SttState, detail?: string) {
    this.state = state;
    this.opts.onState(state, detail);
  }

  async start() {
    this.closedByUser = false;
    await this.connect();
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

    const params = new URLSearchParams({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: String(STT_SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      language: this.opts.language ?? "en",
    });

    // A /v1/auth/grant access token authenticates with the "bearer" subprotocol;
    // a raw API key would use "token". We only ever receive the short-lived grant token.
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [
      token.mode === "grant" ? "bearer" : "token",
      token.key,
    ]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      this.attempts = 0;
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
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          is_final?: boolean;
          speech_final?: boolean;
          start?: number;
          duration?: number;
          channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
        };
        if (payload.type && payload.type !== "Results") return;
        const alt = payload.channel?.alternatives?.[0];
        const text = (alt?.transcript ?? "").trim();
        if (!text) return;
        const startMs = payload.start != null ? Math.round(payload.start * 1000) : null;
        const endMs =
          payload.start != null && payload.duration != null
            ? Math.round((payload.start + payload.duration) * 1000)
            : null;
        this.opts.onResult({
          text,
          isFinal: Boolean(payload.is_final),
          confidence: alt?.confidence ?? null,
          startMs,
          endMs,
        });
      } catch {
        /* ignore malformed frame */
      }
    };

    ws.onerror = () => {
      this.setState("error", "Transcription connection error");
    };

    ws.onclose = () => {
      this.clearKeepAlive();
      if (this.closedByUser) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.attempts, 5));
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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
