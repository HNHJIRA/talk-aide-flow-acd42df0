/**
 * Thin browser -> companion link used *only* by the Private Overlay.
 *
 * It deliberately does NOT reuse `CompanionBridge`: the audio path must keep
 * working exactly as before whether or not the overlay is enabled, and the
 * overlay must work for Google Meet / browser-capture sessions where no native
 * audio capture is running at all.
 *
 * Auth is the same short-lived, session-scoped bridge token minted by the
 * pairing flow — no long-lived credential is ever handed to the desktop app.
 */

import {
  type OverlayCommand,
  type OverlayMode,
  type OverlaySnapshot,
  type OverlayStatus,
} from "./overlay-protocol";
import { detectCompanion, type CompanionHealth } from "@/lib/companion/companion-client";

export type OverlayLinkState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

type Handlers = {
  onState: (state: OverlayLinkState, detail?: string) => void;
  onStatus: (status: OverlayStatus) => void;
  onCommand: (command: OverlayCommand) => void;
};

export class OverlayLink {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  private lastSnapshot: OverlaySnapshot | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly handlers: Handlers,
  ) {}

  static async detect(): Promise<CompanionHealth | null> {
    return detectCompanion();
  }

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    if (this.closedByUser) return;
    this.handlers.onState(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/bridge`);
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.token }));

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg["type"]) {
        case "auth_ok": {
          this.attempts = 0;
          this.handlers.onState("connected");
          this.flush();
          this.send({ type: "overlay_hello", protocol: 1 });
          if (this.lastSnapshot) this.publish(this.lastSnapshot);
          break;
        }
        case "overlay_status": {
          this.handlers.onStatus(msg["status"] as OverlayStatus);
          break;
        }
        case "overlay_command": {
          this.handlers.onCommand(String(msg["action"]) as OverlayCommand);
          break;
        }
        case "error": {
          this.handlers.onState("error", String(msg["message"] ?? "Overlay link error"));
          break;
        }
        default:
          break;
      }
    };

    ws.onerror = () => this.handlers.onState("error", "Could not reach the Desktop Companion.");

    ws.onclose = () => {
      if (this.closedByUser) return;
      if (this.timer) return;
      this.attempts += 1;
      const delay = Math.min(10000, 500 * 2 ** Math.min(this.attempts, 4));
      this.handlers.onState("reconnecting");
      this.timer = setTimeout(() => {
        this.timer = null;
        this.open();
      }, delay);
    };
  }

  private send(payload: Record<string, unknown>) {
    const text = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(text);
      return;
    }
    // Only the most recent control frames matter after a reconnect.
    this.queue.push(text);
    if (this.queue.length > 8) this.queue.shift();
  }

  private flush() {
    const pending = this.queue;
    this.queue = [];
    for (const text of pending) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    }
  }

  publish(snapshot: OverlaySnapshot) {
    this.lastSnapshot = snapshot;
    this.send({ type: "overlay_update", payload: snapshot });
  }

  show() {
    this.send({ type: "overlay_show" });
  }

  hide() {
    this.send({ type: "overlay_hide" });
  }

  setMode(mode: OverlayMode) {
    this.send({ type: "overlay_mode", mode });
  }

  setOpacity(opacity: number) {
    this.send({ type: "overlay_opacity", opacity });
  }

  setLocked(locked: boolean) {
    this.send({ type: "overlay_lock", locked });
  }

  setAlwaysOnTop(alwaysOnTop: boolean) {
    this.send({ type: "overlay_always_on_top", alwaysOnTop });
  }

  setHideFromCapture(hide: boolean) {
    this.send({ type: "overlay_hide_from_capture", hide });
  }

  setShow(show: "both" | "question" | "answer") {
    this.send({ type: "overlay_show_fields", show });
  }

  requestStatus() {
    this.send({ type: "overlay_status" });
  }

  disconnect() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "overlay_hide" }));
      } catch {
        /* noop */
      }
      ws.close();
    }
    this.handlers.onState("idle");
  }
}
