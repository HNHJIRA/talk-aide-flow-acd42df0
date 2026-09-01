/**
 * Voice Interpreter Mode — shared types.
 *
 * Additive layer on top of the existing translation stack. It consumes text
 * that the transcription + translation layers already produced and turns it
 * into speech:
 *
 *   OUTGOING  candidate mic -> STT (existing) -> translate -> TTS -> output
 *             device (virtual microphone) -> Zoom / Meet / Teams
 *   INCOMING  interviewer speech -> STT (existing) -> translate -> TTS ->
 *             candidate headphones (original meeting audio ducked)
 *
 * Nothing here touches capture, Deepgram, diarization, turn assembly or the
 * answer pipeline. If the interpreter fails, the meeting continues untouched.
 */
import type { LanguageCode, TranslationSettings } from "./translation-protocol";

export type InterpreterVoiceGender = "female" | "male";

/** Lovable AI Gateway (OpenAI-compatible) voices, grouped by perceived gender. */
export const INTERPRETER_VOICES: {
  id: string;
  label: string;
  gender: InterpreterVoiceGender;
}[] = [
  { id: "alloy", label: "Alloy — neutral professional", gender: "female" },
  { id: "shimmer", label: "Shimmer — warm", gender: "female" },
  { id: "nova", label: "Nova — bright", gender: "female" },
  { id: "onyx", label: "Onyx — deep", gender: "male" },
  { id: "echo", label: "Echo — calm", gender: "male" },
  { id: "fable", label: "Fable — expressive", gender: "male" },
];

export const DEFAULT_INTERPRETER_VOICE = "alloy";

export function voicesFor(gender: InterpreterVoiceGender) {
  return INTERPRETER_VOICES.filter((v) => v.gender === gender);
}

export type InterpreterSettings = {
  /** Master switch for Voice Interpreter Mode. */
  enabled: boolean;
  /** Speak the translated interviewer audio into the candidate's headphones. */
  playIncomingVoice: boolean;
  /** Duck (lower) the original interviewer audio while the translated voice speaks. */
  duckOriginal: boolean;
  /** Speak the candidate's translated speech into the meeting. */
  speakOutgoing: boolean;
  /** The candidate's own (untranslated) microphone reaches the meeting. */
  originalMicEnabled: boolean;
  /** What the candidate speaks. `auto` lets the model detect it. */
  iSpeak: LanguageCode;
  /** What the interviewer should hear. */
  interviewerHears: LanguageCode;
  voiceGender: InterpreterVoiceGender;
  voice: string;
  /** 0.7 – 1.2, forwarded to the TTS provider. */
  speed: number;
  /** 0 – 1 playback gain. */
  volume: number;
  /** `default` = system default output; otherwise a mediaDevices deviceId. */
  outputDeviceId: string;
  /** Minimum characters before a candidate line is worth interpreting. */
  minChars: number;
};

export const DEFAULT_INTERPRETER_SETTINGS: InterpreterSettings = {
  enabled: false,
  playIncomingVoice: false,
  duckOriginal: true,
  speakOutgoing: true,
  originalMicEnabled: false,
  iSpeak: "auto",
  interviewerHears: "en",
  voiceGender: "female",
  voice: DEFAULT_INTERPRETER_VOICE,
  speed: 1,
  volume: 0.9,
  outputDeviceId: "default",
  minChars: 3,
};

export type InterpreterStatus = "off" | "listening" | "translating" | "speaking" | "error";

export const INTERPRETER_STATUS_DOT: Record<InterpreterStatus, string> = {
  off: "⚪",
  listening: "🟢",
  translating: "🟡",
  speaking: "🔵",
  error: "🔴",
};

/** One interpreted utterance, kept for the panel + overlay. */
export type InterpretedUtterance = {
  id: string;
  direction: "incoming" | "outgoing";
  original: string;
  translated: string;
  sourceLanguage: string;
  targetLanguage: string;
  at: number;
  /** Per-stage timings in ms; null while the stage has not completed. */
  sttMs: number | null;
  translateMs: number | null;
  ttsMs: number | null;
  outputMs: number | null;
  totalMs: number | null;
};

export type InterpreterDiagnostics = {
  status: InterpreterStatus;
  incoming: string;
  outgoing: string;
  utterances: number;
  captureMs: number | null;
  sttMs: number | null;
  translateMs: number | null;
  ttsMs: number | null;
  outputMs: number | null;
  totalMs: number | null;
  avgTotalMs: number | null;
  outputDevice: string;
  virtualMic: string;
  echoGuardBlocks: number;
  errors: number;
  lastError: string;
};

/**
 * Language the candidate's speech must be rendered in for the interviewer.
 * Falls back to the interviewer's detected/declared language so the two
 * settings surfaces can never disagree.
 */
export function resolveOutgoingTarget(
  interpreter: InterpreterSettings,
  translation: TranslationSettings,
  detectedInterviewerLanguage: string | null,
): LanguageCode {
  if (interpreter.interviewerHears !== "auto") return interpreter.interviewerHears;
  if (translation.sourceLanguage !== "auto") return translation.sourceLanguage;
  const detected = (detectedInterviewerLanguage ?? "") as LanguageCode;
  return detected && detected !== "auto" ? detected : "en";
}

/** Language the candidate reads/hears incoming speech in. */
export function resolveIncomingTarget(translation: TranslationSettings): LanguageCode {
  return translation.targetLanguage;
}

/**
 * Echo protection: the translated voice we just played must never be treated
 * as new candidate input. Compare normalized text of a fresh transcript line
 * against what the interpreter recently spoke.
 */
export function isLikelyEcho(text: string, recentlySpoken: string[]): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  const candidate = norm(text);
  if (candidate.length < 4) return false;
  return recentlySpoken.some((spoken) => {
    const s = norm(spoken);
    if (!s) return false;
    return s === candidate || s.includes(candidate) || candidate.includes(s);
  });
}

/**
 * Which platforms can receive the interpreted voice, and how.
 * Browser platforms route through a user-selected output device; desktop apps
 * additionally support the native companion's virtual microphone.
 */
export type InterpreterRouting = "browser_output_device" | "companion_virtual_mic";

export function routingForPlatform(platform: string | undefined): InterpreterRouting {
  return platform === "zoom_desktop" || platform === "teams_desktop"
    ? "companion_virtual_mic"
    : "browser_output_device";
}
