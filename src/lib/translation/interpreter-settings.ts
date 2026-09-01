import {
  DEFAULT_INTERPRETER_SETTINGS,
  type InterpreterSettings,
} from "./interpreter-protocol";

const KEY = "ic.interpreter.settings.v1";

/** Browser-only read; call from an effect or event handler. */
export function loadInterpreterSettings(): InterpreterSettings {
  if (typeof window === "undefined") return DEFAULT_INTERPRETER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_INTERPRETER_SETTINGS;
    return {
      ...DEFAULT_INTERPRETER_SETTINGS,
      ...(JSON.parse(raw) as Partial<InterpreterSettings>),
    };
  } catch {
    return DEFAULT_INTERPRETER_SETTINGS;
  }
}

export function saveInterpreterSettings(settings: InterpreterSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage disabled */
  }
}
