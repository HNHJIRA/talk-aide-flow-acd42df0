import { DEFAULT_TRANSLATION_SETTINGS, type TranslationSettings } from "./translation-protocol";

const KEY = "ic.translation.settings.v1";

/** Browser-only read; call from an effect or event handler. */
export function loadTranslationSettings(): TranslationSettings {
  if (typeof window === "undefined") return DEFAULT_TRANSLATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_TRANSLATION_SETTINGS;
    return {
      ...DEFAULT_TRANSLATION_SETTINGS,
      ...(JSON.parse(raw) as Partial<TranslationSettings>),
    };
  } catch {
    return DEFAULT_TRANSLATION_SETTINGS;
  }
}

export function saveTranslationSettings(settings: TranslationSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage disabled */
  }
}
