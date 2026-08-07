/**
 * Browser-side client for the InterviewCopilot Desktop Companion.
 *
 * The companion is a small Tauri app that captures Zoom Desktop / system output
 * audio natively (WASAPI loopback on Windows, ScreenCaptureKit on macOS) and
 * exposes an authenticated local bridge:
 *
 *   GET  http://127.0.0.1:8765/health          -> { app, version, os, captureBackend }
 *   WS   ws://127.0.0.1:8765/bridge            -> authenticated PCM + state stream
 *
 * Protocol (JSON text frames from browser -> companion):
 *   { type: "auth", token }                     short-lived bridge token from pairing
 *   { type: "start_capture", target, sampleRate }
 *   { type: "stop_capture" }
 *
 * From companion -> browser:
 *   text:   { type: "auth_ok" | "state" | "level" | "error" | "format", ... }
 *   binary: 16-bit little-endian mono PCM at the negotiated sample rate
 *
 * The companion never holds Deepgram/OpenAI/Supabase credentials. It only ever
 * receives the single-use bridge token minted for this user + interview session.
 */

export const COMPANION_PORTS = [8765, 8766, 8767];
export const COMPANION_SAMPLE_RATE = 16000;

export type CompanionState =
  | "not_installed"
  | "disconnected"
  | "pairing"
  | "connected"
  | "requesting_permission"
  | "ready"
  | "capturing"
  | "silent"
  | "reconnecting"
  | "error"
  | "stopped";

export type CompanionHealth = {
  app: string;
  version: string;
  os: string;
  captureBackend: string;
  port: number;
};

export type CompanionFormat = {
  sampleRate: number;
  channels: number;
  captureMethod: string;
  captureTarget: string;
  sourceDetected: boolean;
};

type Handlers = {
  onState: (state: CompanionState, detail?: string) => void;
  onLevel: (level: number) => void;
  onPcm: (chunk: ArrayBuffer) => void;
  onFormat: (format: CompanionFormat) => void;
};

/** Probe the local bridge. Returns null when the companion is not running. */
export async function detectCompanion(timeoutMs = 1200): Promise<CompanionHealth | null> {
  for (const port of COMPANION_PORTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      if (!res.ok) continue;
      const body = (await res.json()) as Omit<CompanionHealth, "port">;
      if (body.app !== "interviewcopilot-companion") continue;
      return { ...body, port };
    } catch {
      /* port closed */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export class CompanionBridge {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudibleAt = 0;
  private wantCapture = false;
  private paused = false;
  private state: CompanionState = "disconnected";


  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly target: "zoom" | "system",
    private readonly handlers: Handlers,
  ) {}

  getState() {
    return this.state;
  }

  isCapturing() {
    return this.state === "capturing" || this.state === "silent";
  }

  /** Gate PCM delivery without tearing down the native capture. */
  setPaused(paused: boolean) {
    this.paused = paused;
  }



  private setState(state: CompanionState, detail?: string) {
    this.state = state;
    this.handlers.onState(state, detail);
  }

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    if (this.closedByUser) return;
    this.setState(this.attempts === 0 ? "pairing" : "reconnecting");
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/bridge`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: this.token }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (this.paused) return;
        this.lastAudibleAt = this.lastAudibleAt || Date.now();
        this.handlers.onPcm(event.data);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg["type"]) {
        case "auth_ok": {
          this.attempts = 0;
          this.setState("connected");
          if (this.wantCapture) this.startCapture();
          break;
        }
        case "format": {
          this.handlers.onFormat({
            sampleRate: Number(msg["sampleRate"] ?? COMPANION_SAMPLE_RATE),
            channels: Number(msg["channels"] ?? 1),
            captureMethod: String(msg["captureMethod"] ?? "unknown"),
            captureTarget: String(msg["captureTarget"] ?? "unknown"),
            sourceDetected: Boolean(msg["sourceDetected"]),
          });
          break;
        }
        case "level": {
          const level = Number(msg["level"] ?? 0);
          if (level > 0.02) this.lastAudibleAt = Date.now();
          this.handlers.onLevel(level);
          break;
        }
        case "state": {
          this.setState(String(msg["state"]) as CompanionState, msg["detail"] ? String(msg["detail"]) : undefined);
          break;
        }
        case "error": {
          this.setState("error", String(msg["message"] ?? "Companion error"));
          break;
        }
        default:
          break;
      }
    };

    ws.onerror = () => {
      this.setState("error", "Local companion bridge connection failed.");
    };

    ws.onclose = () => {
      this.clearSilenceWatch();
      if (this.closedByUser) {
        this.setState("stopped");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(10000, 500 * 2 ** Math.min(this.attempts, 4));
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /** Explicit user action — never called automatically. */
  startCapture() {
    this.wantCapture = true;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.setState("requesting_permission");
    this.ws.send(
      JSON.stringify({ type: "start_capture", target: this.target, sampleRate: COMPANION_SAMPLE_RATE }),
    );
    this.watchSilence();
  }

  stopCapture() {
    this.wantCapture = false;
    this.clearSilenceWatch();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop_capture" }));
    }
  }

  private watchSilence() {
    this.clearSilenceWatch();
    this.lastAudibleAt = Date.now();
    this.silenceTimer = setInterval(() => {
      if (this.state !== "capturing" && this.state !== "silent") return;
      const quietFor = Date.now() - this.lastAudibleAt;
      if (quietFor > 20000 && this.state === "capturing") {
        this.setState("silent", "Zoom audio is not reaching InterviewCopilot.");
      } else if (quietFor < 3000 && this.state === "silent") {
        this.setState("capturing");
      }
    }, 2000);
  }

  private clearSilenceWatch() {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  disconnect() {
    this.closedByUser = true;
    this.wantCapture = false;
    this.clearSilenceWatch();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop_capture" }));
      } catch {
        /* noop */
      }
      ws.close();
    }
    this.setState("stopped");
  }
}
