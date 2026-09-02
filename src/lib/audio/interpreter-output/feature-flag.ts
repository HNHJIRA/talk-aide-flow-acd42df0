/**
 * Rollback protection for the native interpreter output path.
 *
 * ENABLE_NATIVE_INTERPRETER_OUTPUT=false (the default) makes the app behave
 * exactly like the current production version: TTS MP3 -> <audio> -> setSinkId.
 * Enabling it activates the binary-PCM -> companion -> native render path,
 * which still falls back to browser playback whenever the companion is not
 * available.
 *
 * Sources, in order of precedence:
 *   1. localStorage override (per browser, for support/debug),
 *   2. VITE_ENABLE_NATIVE_INTERPRETER_OUTPUT build env,
 *   3. false.
 */
export const NATIVE_OUTPUT_FLAG_KEY = "ic.interpreter.nativeOutput";

function envFlag(): boolean {
  const raw = import.meta.env["VITE_ENABLE_NATIVE_INTERPRETER_OUTPUT"];
  return String(raw ?? "false").toLowerCase() === "true";
}

export function nativeInterpreterOutputEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const override = window.localStorage.getItem(NATIVE_OUTPUT_FLAG_KEY);
    if (override === "true") return true;
    if (override === "false") return false;
  } catch {
    /* storage blocked */
  }
  return envFlag();
}

export function setNativeInterpreterOutputEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(NATIVE_OUTPUT_FLAG_KEY, enabled ? "true" : "false");
  } catch {
    /* storage blocked */
  }
}
