/**
 * Private Overlay protocol (web app  <->  native Desktop Companion).
 *
 * The overlay is a NATIVE always-on-top window owned by the Tauri companion.
 * The web app remains the only place that talks to Supabase / Deepgram / the AI
 * gateway; it pushes a *thin* read-only snapshot of the current turn down the
 * already-authenticated localhost bridge (`ws://127.0.0.1:876x/bridge`).
 *
 * Nothing sensitive travels here: no API keys, no resume text, no full
 * transcript — only the currently displayed question/answer pair the user is
 * already looking at in the browser.
 */

export const OVERLAY_PROTOCOL_VERSION = 1;

export type OverlayMode = "bubble" | "mini" | "focus";

export type OverlayPhase = "idle" | "listening" | "thinking" | "answering" | "paused";

/** Read-only snapshot of the live session, published to the native overlay. */
export type OverlaySnapshot = {
  v: number;
  sessionId: string;
  sessionTitle: string;
  live: boolean;
  phase: OverlayPhase;
  elapsed: number;
  source: string;
  micLabel: string;
  /** 1-based position within the answered/answering question list. */
  index: number;
  total: number;
  question: string;
  /** Roster label of the participant who asked, when several people are on the call. */
  askedBy: string;
  answer: string;
  answerStatus: "none" | "generating" | "answered" | "error" | "stopped";
  /** Translation layer (empty when translation is off). */
  questionTranslated?: string;
  answerTranslated?: string;
  translationLanguage?: string;
  /** "translation_only" hides the original text in the bubble. */
  translationMode?: "translation_only" | "original_and_translation";
  /** Bumps whenever the same logical turn is revised, so stale text is dropped. */
  revision: number;
  at: number;
};

export type OverlaySettings = {
  enabled: boolean;
  mode: OverlayMode;
  opacity: number;
  alwaysOnTop: boolean;
  hideFromCapture: boolean;
  launchOnSessionStart: boolean;
  lockPosition: boolean;
  show: "both" | "question" | "answer";
};

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  enabled: false,
  mode: "mini",
  opacity: 1,
  alwaysOnTop: true,
  hideFromCapture: true,
  launchOnSessionStart: false,
  lockPosition: false,
  show: "both",
};

/** Honest, per-platform statement of what the OS can actually guarantee. */
export type OverlayCapabilities = {
  platform: "windows" | "macos" | "unsupported";
  /** Overlay window can be created + kept above other apps. */
  alwaysOnTop: boolean;
  /** OS-level exclusion from screen capture is available. */
  captureExclusion: boolean;
  /** Currently applied to the live overlay window. */
  captureExclusionActive: boolean;
  note: string;
};

export type OverlayStatus = {
  visible: boolean;
  mode: OverlayMode;
  opacity: number;
  locked: boolean;
  capabilities: OverlayCapabilities;
};

/** Shortcut-driven requests coming back from the native overlay. */
export type OverlayCommand = "next" | "prev" | "toggle_live" | "hide";

export const BROWSER_ONLY_LIMITATION =
  "A browser tab cannot float above other applications or hide itself from screen sharing. " +
  "The private overlay therefore requires the InterviewCopilot Desktop Companion.";
