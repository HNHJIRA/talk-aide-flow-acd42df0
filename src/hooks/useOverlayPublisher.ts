/**
 * Drives the native Private Overlay from the live session.
 *
 * Responsibilities:
 *  - pair with the Desktop Companion (short-lived code -> bridge token)
 *  - hold one lightweight OverlayLink (independent of the audio bridge)
 *  - publish a throttled, thin snapshot of the current question/answer turn
 *  - relay overlay keyboard-shortcut commands (next / prev) back into the app
 *
 * It never touches the transcription, question-detection, AI or audio paths.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OverlayLink, type OverlayLinkState } from "@/lib/overlay/overlay-link";
import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_PROTOCOL_VERSION,
  type OverlayMode,
  type OverlayPhase,
  type OverlaySettings,
  type OverlaySnapshot,
  type OverlayStatus,
} from "@/lib/overlay/overlay-protocol";
import { loadOverlaySettings, saveOverlaySettings } from "@/lib/overlay/overlay-settings";
import { detectCompanion, type CompanionHealth } from "@/lib/companion/companion-client";
import { createCompanionPairing, getCompanionPairing } from "@/lib/companion.functions";
import type { QuestionItem } from "@/hooks/useCopilotSession";

export type OverlayInput = {
  sessionId: string;
  sessionTitle: string;
  live: boolean;
  paused: boolean;
  generating: boolean;
  elapsed: number;
  source: string;
  micLabel: string;
  questions: QuestionItem[];
};

export function useOverlayPublisher(input: OverlayInput) {
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);
  const [linkState, setLinkState] = useState<OverlayLinkState>("idle");
  const [status, setStatus] = useState<OverlayStatus | null>(null);
  const [health, setHealth] = useState<CompanionHealth | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 0 = newest turn; >0 walks back through history via overlay shortcuts. */
  const [cursor, setCursor] = useState(0);

  const link = useRef<OverlayLink | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPublished = useRef<string>("");

  useEffect(() => {
    setSettings(loadOverlaySettings());
    void detectCompanion().then(setHealth);
    return () => {
      if (poll.current) clearInterval(poll.current);
      link.current?.disconnect();
      link.current = null;
    };
  }, []);

  const patch = useCallback((next: Partial<OverlaySettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next };
      saveOverlaySettings(merged);
      const l = link.current;
      if (l) {
        if (next.mode) l.setMode(next.mode);
        if (next.opacity != null) l.setOpacity(next.opacity);
        if (next.lockPosition != null) l.setLocked(next.lockPosition);
        if (next.alwaysOnTop != null) l.setAlwaysOnTop(next.alwaysOnTop);
        if (next.hideFromCapture != null) l.setHideFromCapture(next.hideFromCapture);
        if (next.show) l.setShow(next.show);
        if (next.enabled != null) (next.enabled ? l.show() : l.hide());
      }
      return merged;
    });
  }, []);

  const refresh = useCallback(async () => {
    const found = await detectCompanion();
    setHealth(found);
    return found;
  }, []);

  const attach = useCallback(
    (port: number, token: string) => {
      link.current?.disconnect();
      const l = new OverlayLink(port, token, {
        onState: (state, detail) => {
          setLinkState(state);
          if (detail) setError(detail);
        },
        onStatus: setStatus,
        onCommand: (action) => {
          if (action === "next") setCursor((c) => Math.max(0, c - 1));
          else if (action === "prev") setCursor((c) => c + 1);
        },
      });
      link.current = l;
      l.connect();
      // Apply the persisted preferences to the freshly created overlay window.
      window.setTimeout(() => {
        l.setMode(settings.mode);
        l.setOpacity(settings.opacity);
        l.setLocked(settings.lockPosition);
        l.setAlwaysOnTop(settings.alwaysOnTop);
        l.setHideFromCapture(settings.hideFromCapture);
        l.setShow(settings.show);
        l.show();
        l.requestStatus();
      }, 400);
      patch({ enabled: true });
    },
    [patch, settings],
  );

  /** Mint a pairing code and wait for the user to approve it in the companion. */
  const startPairing = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await refresh();
      if (!found) {
        setError("Desktop Companion is not running on this computer.");
        return;
      }
      const pairing = await createCompanionPairing({ data: { sessionId: input.sessionId } });
      setPairingCode(pairing.code);
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const st = await getCompanionPairing({ data: { pairingId: pairing.pairingId } });
          if (st.approved && st.bridgeToken) {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setPairingCode(null);
            attach(found.port, st.bridgeToken);
          } else if (st.status === "expired" || st.status === "revoked") {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setPairingCode(null);
            setError("Pairing code expired. Generate a new one.");
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a pairing code.");
    } finally {
      setBusy(false);
    }
  }, [attach, input.sessionId, refresh]);

  const disconnect = useCallback(() => {
    link.current?.disconnect();
    link.current = null;
    setStatus(null);
    setLinkState("idle");
    patch({ enabled: false });
  }, [patch]);

  /** Existing pairing token can be reused directly (e.g. Zoom Desktop audio already paired). */
  const attachWithToken = useCallback(
    async (token: string) => {
      const found = health ?? (await refresh());
      if (!found) {
        setError("Desktop Companion is not running on this computer.");
        return;
      }
      attach(found.port, token);
    },
    [attach, health, refresh],
  );

  /* ---------------- snapshot publishing ---------------- */

  const visible = useMemo(
    () => input.questions.filter((q) => q.text.trim().length > 0),
    [input.questions],
  );

  const current = visible[Math.min(cursor, Math.max(0, visible.length - 1))] ?? null;

  useEffect(() => {
    // Any new turn snaps the overlay back to the newest item.
    setCursor(0);
  }, [visible.length]);

  useEffect(() => {
    const l = link.current;
    if (!l || linkState !== "connected" || !settings.enabled) return;

    const phase: OverlayPhase = !input.live
      ? "idle"
      : input.paused
        ? "paused"
        : current?.status === "generating"
          ? "answering"
          : input.generating
            ? "thinking"
            : "listening";

    const snapshot: OverlaySnapshot = {
      v: OVERLAY_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      live: input.live && !input.paused,
      phase,
      elapsed: input.elapsed,
      source: input.source,
      micLabel: input.micLabel,
      index: visible.length ? visible.length - Math.min(cursor, visible.length - 1) : 0,
      total: visible.length,
      question: current?.text ?? "",
      answer: current?.answer ?? "",
      answerStatus: current ? current.status : "none",
      revision: current ? current.answer.length : 0,
      at: Date.now(),
    };

    const fingerprint = JSON.stringify({ ...snapshot, at: 0, elapsed: 0 });
    const elapsedTick = snapshot.elapsed;
    const key = `${fingerprint}|${elapsedTick}`;
    if (key === lastPublished.current) return;
    lastPublished.current = key;
    l.publish(snapshot);
  }, [current, cursor, input, linkState, settings.enabled, visible.length]);

  return {
    settings,
    patch,
    linkState,
    status,
    health,
    pairingCode,
    busy,
    error,
    cursor,
    startPairing,
    attachWithToken,
    disconnect,
    refresh,
  };
}
