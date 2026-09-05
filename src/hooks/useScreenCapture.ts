/**
 * Screen Intelligence — Phase 1 capture controller.
 *
 * Fully isolated from the meeting pipeline: it owns its own getDisplayMedia
 * stream (video only), video element and canvas, and never touches microphone
 * capture, meeting audio, STT, the interpreter or the desktop companion.
 * Every failure is caught and surfaced as state; nothing here can throw into
 * the live session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  captureFrame,
  DEFAULT_CAPTURE_INTERVAL,
  MAX_SCREENSHOTS,
  type CaptureIntervalSeconds,
  type Screenshot,
  type ScreenCaptureState,
  type ScreenshotSource,
} from "@/lib/screen/screenshot";

export type ScreenCaptureController = {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  state: ScreenCaptureState;
  error: string;
  supported: boolean;
  sharing: boolean;
  sourceLabel: string;
  intervalSeconds: CaptureIntervalSeconds;
  setIntervalSeconds: (s: CaptureIntervalSeconds) => void;
  screenshots: Screenshot[];
  lastCaptureAt: number | undefined;
  totalCaptures: number;
  failedCaptures: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  captureNow: () => void;
  pause: () => void;
  resume: () => void;
  clearHistory: () => void;
};

export function useScreenCapture(): ScreenCaptureController {
  const [enabled, setEnabledState] = useState(false);
  const [state, setState] = useState<ScreenCaptureState>("idle");
  const [error, setError] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [intervalSeconds, setIntervalSeconds] =
    useState<CaptureIntervalSeconds>(DEFAULT_CAPTURE_INTERVAL);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [lastCaptureAt, setLastCaptureAt] = useState<number | undefined>(undefined);
  const [totalCaptures, setTotalCaptures] = useState(0);
  const [failedCaptures, setFailedCaptures] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef<ScreenCaptureState>("idle");

  stateRef.current = state;

  const supported = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
    [],
  );

  const getCanvas = () => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    return canvasRef.current;
  };

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pushScreenshot = useCallback((shot: Screenshot) => {
    setScreenshots((prev) => [shot, ...prev].slice(0, MAX_SCREENSHOTS));
    setLastCaptureAt(shot.createdAt);
    if (shot.status === "captured") setTotalCaptures((n) => n + 1);
    else setFailedCaptures((n) => n + 1);
  }, []);

  /** Asynchronous so a slow encode never blocks the audio/answer pipeline. */
  const grab = useCallback(
    (source: ScreenshotSource) => {
      const video = videoRef.current;
      if (!video || !streamRef.current) return;
      queueMicrotask(() => {
        try {
          pushScreenshot(captureFrame(video, getCanvas(), source));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Screenshot failed";
          pushScreenshot({
            id: `${Date.now()}-failed`,
            createdAt: Date.now(),
            source,
            status: "failed",
            dataUrl: "",
            mimeType: "",
            width: 0,
            height: 0,
            bytes: 0,
            error: message,
          });
        }
      });
    },
    [pushScreenshot],
  );

  const teardown = useCallback(
    (next: ScreenCaptureState) => {
      clearTimer();
      const stream = streamRef.current;
      streamRef.current = null;
      if (stream) {
        for (const track of stream.getTracks()) {
          track.onended = null;
          try {
            track.stop();
          } catch {
            /* already stopped */
          }
        }
      }
      const video = videoRef.current;
      if (video) {
        try {
          video.pause();
        } catch {
          /* ignore */
        }
        video.srcObject = null;
      }
      canvasRef.current = null;
      setSourceLabel("");
      setState(next);
    },
    [clearTimer],
  );

  const stop = useCallback(() => teardown("stopped"), [teardown]);

  const start = useCallback(async () => {
    if (!supported) {
      setError("Screen sharing is not supported in this browser.");
      setState("error");
      return;
    }
    if (streamRef.current) return;
    setError("");
    setState("requesting");
    let stream: MediaStream;
    try {
      // Video only — meeting audio capture stays entirely on its own stream.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      const message =
        name === "NotAllowedError"
          ? "Screen sharing permission was denied."
          : name === "NotFoundError"
            ? "No screen or window was available to share."
            : err instanceof Error && err.message
              ? err.message
              : "Screen sharing could not start.";
      // A cancelled picker also raises NotAllowedError; treat both as a soft stop.
      setError(message);
      setState("error");
      return;
    }

    const [track] = stream.getVideoTracks();
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      setError("The selected source returned no video.");
      setState("error");
      return;
    }
    track.onended = () => teardown("stopped");
    streamRef.current = stream;
    setSourceLabel(track.label || "Shared screen");

    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      video.muted = true;
      try {
        await video.play();
      } catch {
        /* autoplay guard — preview still renders once metadata arrives */
      }
    }
    setState("capturing");
  }, [supported, teardown]);

  const captureNow = useCallback(() => {
    if (!streamRef.current) return;
    grab("manual");
  }, [grab]);

  const pause = useCallback(() => {
    if (!streamRef.current) return;
    clearTimer();
    setState("paused");
  }, [clearTimer]);

  const resume = useCallback(() => {
    if (!streamRef.current) return;
    setState("capturing");
  }, []);

  const clearHistory = useCallback(() => setScreenshots([]), []);

  const setEnabled = useCallback(
    (v: boolean) => {
      setEnabledState(v);
      if (!v) teardown("idle");
    },
    [teardown],
  );

  /* automatic capture timer — restarted whenever the interval or state changes */
  useEffect(() => {
    clearTimer();
    if (!enabled || state !== "capturing") return;
    timerRef.current = setInterval(() => grab("auto"), intervalSeconds * 1000);
    return clearTimer;
  }, [enabled, state, intervalSeconds, grab, clearTimer]);

  /* Ctrl/Cmd + Shift + S — manual capture while sharing is active */
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "s") return;
      if (!streamRef.current) return;
      e.preventDefault();
      grab("manual");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, grab]);

  /* unmount cleanup */
  useEffect(() => () => teardown("idle"), [teardown]);

  return {
    enabled,
    setEnabled,
    state,
    error,
    supported,
    sharing: state === "capturing" || state === "paused",
    sourceLabel,
    intervalSeconds,
    setIntervalSeconds,
    screenshots,
    lastCaptureAt,
    totalCaptures,
    failedCaptures,
    videoRef,
    start,
    stop,
    captureNow,
    pause,
    resume,
    clearHistory,
  };
}
