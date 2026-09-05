/**
 * Screen Intelligence — Phase 1 screenshot utilities.
 *
 * Deliberately isolated from the meeting audio pipeline: nothing here touches
 * getUserMedia, STT, the interpreter, or the desktop companion. A future AI
 * Vision phase can consume `Screenshot` objects without redesigning capture.
 */

export type ScreenCaptureState =
  | "idle"
  | "requesting"
  | "capturing"
  | "paused"
  | "stopped"
  | "error";

export type ScreenshotSource = "auto" | "manual";

export type ScreenshotStatus = "captured" | "failed";

export type Screenshot = {
  id: string;
  createdAt: number;
  source: ScreenshotSource;
  status: ScreenshotStatus;
  /** JPEG/WebP data URL, ready for a future vision request. */
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  error?: string;
};

export type CaptureIntervalSeconds = 3 | 5 | 10;

export const CAPTURE_INTERVALS: CaptureIntervalSeconds[] = [3, 5, 10];
export const DEFAULT_CAPTURE_INTERVAL: CaptureIntervalSeconds = 5;
export const MAX_SCREENSHOTS = 20;

/** Longest edge of a stored screenshot — plenty for OCR-grade vision models. */
const MAX_EDGE = 1280;
const QUALITY = 0.72;

let preferredMime: string | undefined;

/** WebP where the browser encodes it, JPEG everywhere else. */
export function pickImageMime(): string {
  if (preferredMime) return preferredMime;
  if (typeof document === "undefined") return "image/jpeg";
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const webp = probe.toDataURL("image/webp");
    preferredMime = webp.startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
  } catch {
    preferredMime = "image/jpeg";
  }
  return preferredMime;
}

function scaledSize(width: number, height: number) {
  const longest = Math.max(width, height);
  if (!longest || longest <= MAX_EDGE) return { width, height };
  const ratio = MAX_EDGE / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

function approxBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.round((base64.length * 3) / 4);
}

export function createScreenshotId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Draws the current video frame onto a canvas, downscales and compresses it.
 * Throws with a readable message on any canvas/encoding failure.
 */
export function captureFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  source: ScreenshotSource,
): Screenshot {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("Screen frame is not ready yet");
  }

  const { width, height } = scaledSize(sourceWidth, sourceHeight);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");
  ctx.drawImage(video, 0, 0, width, height);

  const mimeType = pickImageMime();
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL(mimeType, QUALITY);
  } catch {
    throw new Error("Could not read the screen frame (canvas was blocked)");
  }
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Screenshot encoding failed");
  }

  return {
    id: createScreenshotId(),
    createdAt: Date.now(),
    source,
    status: "captured",
    dataUrl,
    mimeType,
    width,
    height,
    bytes: approxBytes(dataUrl),
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const SCREEN_STATE_LABEL: Record<ScreenCaptureState, string> = {
  idle: "Idle",
  requesting: "Requesting permission",
  capturing: "Capturing",
  paused: "Paused",
  stopped: "Stopped",
  error: "Error",
};
