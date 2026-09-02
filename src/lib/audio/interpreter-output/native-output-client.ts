/**
 * Native interpreter output client.
 *
 * Opens its OWN authenticated WebSocket to the desktop companion, separate
 * from `CompanionBridge` (meeting capture) and `OverlayLink`. It only ever
 * sends interpreter voice:
 *
 *   { type: "auth", token }
 *   { type: "interpreter_output_open", deviceId, sampleRate }
 *   <binary frames>  16-bit little-endian mono PCM
 *   { type: "interpreter_output_stats" }
 *   { type: "interpreter_output_close" }
 *
 * It never sends capture commands and never reads meeting audio.
 */
import { INTERPRETER_OUTPUT_SAMPLE_RATE } from "./pcm";

export type NativeOutputState =
  | "disabled"
  | "unavailable"
  | "connecting"
  | "ready"
  | "streaming"
  | "error";

export type NativeOutputStats = {
  backend: string;
  device: string;
  open: boolean;
  sampleRateIn: number;
  sampleRateOut: number;
  bufferFrames: number;
  bufferedMs: number;
  framesIn: number;
  framesOut: number;
  droppedFrames: number;
  underruns: number;
  latencyMs: number;
  lastError: string;
};

export const EMPTY_NATIVE_STATS: NativeOutputStats = {
  backend: "—",
  device: "—",
  open: false,
  sampleRateIn: 0,
  sampleRateOut: 0,
  bufferFrames: 0,
  bufferedMs: 0,
  framesIn: 0,
  framesOut: 0,
  droppedFrames: 0,
  underruns: 0,
  latencyMs: 0,
  lastError: "",
};

/** Phase 2: branded InterviewCopilot Virtual Microphone health. */
export type VirtualMicStatus = {
  installed: boolean;
  active: boolean;
  deviceName: string;
  renderEndpoint: string;
  platform: string;
  thirdPartyDevices: string[];
  installHint: string;
  level: number;
  framesRendered: number;
  droppedFrames: number;
  latencyMs: number;
  sampleRate: number;
  bufferFrames: number;
  underruns: number;
  consumer: string;
  note: string;
};

export const EMPTY_VIRTUAL_MIC: VirtualMicStatus = {
  installed: false,
  active: false,
  deviceName: "InterviewCopilot Virtual Microphone",
  renderEndpoint: "InterviewCopilot Virtual Audio",
  platform: "unknown",
  thirdPartyDevices: [],
  installHint: "",
  level: 0,
  framesRendered: 0,
  droppedFrames: 0,
  latencyMs: 0,
  sampleRate: 0,
  bufferFrames: 0,
  underruns: 0,
  consumer: "",
  note: "",
};

/**
 * Device-id sentinel meaning "render into the branded virtual microphone if
 * it is installed, otherwise the system default" (resolved by the companion).
 */
export const VIRTUAL_MIC_DEVICE_ID = "interviewcopilot-virtual-mic";

type Handlers = {
  onState: (state: NativeOutputState, detail?: string) => void;
  onStats: (stats: NativeOutputStats) => void;
  onVirtualMic?: (status: VirtualMicStatus) => void;
};

/** ~40 ms of 16 kHz mono audio per binary frame. */
const FRAME_SAMPLES = 640;

export class NativeInterpreterOutput {
  private ws: WebSocket | null = null;
  private authed = false;
  private opened = false;
  private closedByUser = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private deviceId = "";

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly handlers: Handlers,
  ) {}

  get connected() {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(deviceId = "") {
    this.closedByUser = false;
    this.deviceId = deviceId;
    this.handlers.onState("connecting");
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/bridge`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.token }));

    ws.onmessage = (event) => {
      // Binary from the companion is meeting capture audio — not ours.
      if (typeof event.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg["type"]) {
        case "auth_ok":
          this.authed = true;
          this.open(this.deviceId);
          break;
        case "interpreter_output_open":
          this.opened = true;
          this.handlers.onState("ready");
          break;
        case "virtual_mic_status":
          this.handlers.onVirtualMic?.({
            ...EMPTY_VIRTUAL_MIC,
            ...(msg as object),
          } as VirtualMicStatus);
          break;
        case "interpreter_output_stats":
          this.handlers.onStats({ ...EMPTY_NATIVE_STATS, ...(msg as object) } as NativeOutputStats);
          break;
        case "error":
          this.handlers.onState("error", String(msg["message"] ?? "Companion error"));
          break;
        default:
          break;
      }
    };

    ws.onerror = () => this.handlers.onState("unavailable", "Companion bridge unreachable.");
    ws.onclose = () => {
      this.authed = false;
      this.opened = false;
      this.stopStats();
      if (!this.closedByUser) this.handlers.onState("unavailable", "Companion disconnected.");
    };
  }

  /** Bind (or re-bind) the native output device. */
  open(deviceId: string) {
    this.deviceId = deviceId;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authed) return;
    this.ws.send(
      JSON.stringify({
        type: "interpreter_output_open",
        deviceId,
        sampleRate: INTERPRETER_OUTPUT_SAMPLE_RATE,
      }),
    );
    this.startStats();
  }

  /**
   * Stream one utterance as binary PCM frames. Returns false when the native
   * path is not usable, so the caller can fall back to browser playback.
   */
  sendPcm(pcm: Int16Array): boolean {
    if (!this.connected || !this.opened) return false;
    const ws = this.ws!;
    for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
      const frame = pcm.subarray(offset, Math.min(offset + FRAME_SAMPLES, pcm.length));
      // Copy so the buffer sent is exactly this frame.
      ws.send(new Int16Array(frame).buffer);
    }
    this.handlers.onState("streaming");
    return true;
  }

  private startStats() {
    this.stopStats();
    this.statsTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "interpreter_output_stats" }));
        this.ws.send(JSON.stringify({ type: "virtual_mic_status" }));
      }
    }, 1000);
  }

  private stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  disconnect() {
    this.closedByUser = true;
    this.stopStats();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "interpreter_output_close" }));
      this.ws.close();
    }
    this.ws = null;
    this.authed = false;
    this.opened = false;
    this.handlers.onState("disabled");
  }
}
