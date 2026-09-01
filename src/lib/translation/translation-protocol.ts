/**
 * Real-time translation layer — shared types.
 *
 * This layer sits BETWEEN transcription and presentation. It never touches
 * audio capture, Deepgram, speaker routing, turn assembly or the answer
 * pipeline: it consumes already-produced text and produces translated text
 * asynchronously. If it fails or is slow, nothing upstream is affected.
 */

export type LanguageCode =
  | "auto"
  | "en"
  | "ur"
  | "roman_ur"
  | "hi"
  | "es"
  | "fr"
  | "de"
  | "ar"
  | "pt"
  | "zh"
  | "ja"
  | "ru"
  | "tr"
  | "id";

export type Language = { code: LanguageCode; label: string; native?: string };

/** Languages the remote/interviewer side may speak. */
export const SOURCE_LANGUAGES: Language[] = [
  { code: "auto", label: "Auto detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ur", label: "Urdu" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ru", label: "Russian" },
  { code: "tr", label: "Turkish" },
  { code: "id", label: "Indonesian" },
];

/** Languages the user can read / answer in. `auto` is never a target. */
export const TARGET_LANGUAGES: Language[] = [
  { code: "en", label: "English" },
  { code: "roman_ur", label: "Roman Urdu", native: "Urdu written in Latin script" },
  { code: "ur", label: "Urdu", native: "اردو" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ru", label: "Russian" },
  { code: "tr", label: "Turkish" },
  { code: "id", label: "Indonesian" },
];

export function languageLabel(code: string): string {
  return (
    [...SOURCE_LANGUAGES, ...TARGET_LANGUAGES].find((l) => l.code === code)?.label ?? code
  );
}

/** Transliteration targets that machine-translation APIs cannot produce. */
export const TRANSLITERATION_TARGETS: LanguageCode[] = ["roman_ur"];

export type TranslationProviderId = "auto" | "google" | "deepl" | "azure" | "ai";

export type AnswerLanguageMode = "match_interviewer" | "my_language" | "custom";

export type TranslationSettings = {
  enabled: boolean;
  /** What the interviewer speaks (`auto` lets the model detect it). */
  sourceLanguage: LanguageCode;
  /** What the user wants to READ incoming speech in. */
  targetLanguage: LanguageCode;
  /** What the user speaks / wants their own reply rendered in. */
  responseLanguage: LanguageCode;
  /** How the AI answer language is chosen. */
  answerLanguageMode: AnswerLanguageMode;
  answerLanguageCustom: LanguageCode;
  /** Translate the candidate's own microphone speech into the interviewer language. */
  translateMySpeech: boolean;
  /** Preferred provider; `auto` = fastest available. */
  provider: TranslationProviderId;
  /** Temporarily stop translating without losing the configuration. */
  paused: boolean;
  /** Overlay presentation. */
  overlayMode: "translation_only" | "original_and_translation";
};

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  enabled: false,
  sourceLanguage: "auto",
  targetLanguage: "roman_ur",
  responseLanguage: "en",
  answerLanguageMode: "match_interviewer",
  answerLanguageCustom: "en",
  translateMySpeech: false,
  provider: "auto",
  paused: false,
  overlayMode: "original_and_translation",
};

/** Resolve the language code the AI answer must be written in. */
export function resolveAnswerLanguage(
  s: TranslationSettings,
  detectedInterviewerLanguage: string | null,
): LanguageCode {
  if (!s.enabled) return "en";
  switch (s.answerLanguageMode) {
    case "my_language":
      return s.responseLanguage;
    case "custom":
      return s.answerLanguageCustom;
    case "match_interviewer":
    default: {
      const detected = (detectedInterviewerLanguage ?? "") as LanguageCode;
      if (s.sourceLanguage !== "auto") return s.sourceLanguage;
      return detected && detected !== "auto" ? detected : "en";
    }
  }
}

/** One translated unit of text, cached by content hash. */
export type TranslationResult = {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: Exclude<TranslationProviderId, "auto">;
  /** Round-trip latency measured on the client. */
  latencyMs: number;
  partial: boolean;
};

export type TranslationDiagnostics = {
  status: "off" | "paused" | "idle" | "translating" | "error";
  sourceLanguage: string;
  targetLanguage: string;
  responseLanguage: string;
  answerLanguage: string;
  provider: string;
  providersAvailable: string;
  detectedLanguage: string;
  requests: number;
  cacheHits: number;
  inflight: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  firstPartialMs: number | null;
  completeMs: number | null;
  errors: number;
  lastError: string;
};
