import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from "./overlay-protocol";

const KEY = "ic.overlay.settings.v1";

/** Browser-only read; callers must invoke from an effect / event handler. */
export function loadOverlaySettings(): OverlaySettings {
  if (typeof window === "undefined") return DEFAULT_OVERLAY_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_OVERLAY_SETTINGS;
    return { ...DEFAULT_OVERLAY_SETTINGS, ...(JSON.parse(raw) as Partial<OverlaySettings>) };
  } catch {
    return DEFAULT_OVERLAY_SETTINGS;
  }
}

export function saveOverlaySettings(settings: OverlaySettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage disabled */
  }
}
