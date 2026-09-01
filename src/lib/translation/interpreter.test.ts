import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERPRETER_SETTINGS,
  isLikelyEcho,
  resolveIncomingTarget,
  resolveOutgoingTarget,
  routingForPlatform,
  voicesFor,
} from "./interpreter-protocol";
import { DEFAULT_TRANSLATION_SETTINGS } from "./translation-protocol";

const translation = { ...DEFAULT_TRANSLATION_SETTINGS, enabled: true };

describe("language switching", () => {
  it("uses the explicit interviewer language when set", () => {
    const s = { ...DEFAULT_INTERPRETER_SETTINGS, interviewerHears: "de" as const };
    expect(resolveOutgoingTarget(s, translation, "fr")).toBe("de");
  });

  it("falls back to the declared translation source language", () => {
    const s = { ...DEFAULT_INTERPRETER_SETTINGS, interviewerHears: "auto" as const };
    expect(resolveOutgoingTarget(s, { ...translation, sourceLanguage: "es" }, null)).toBe("es");
  });

  it("falls back to the detected interviewer language, then English", () => {
    const s = { ...DEFAULT_INTERPRETER_SETTINGS, interviewerHears: "auto" as const };
    expect(resolveOutgoingTarget(s, translation, "fr")).toBe("fr");
    expect(resolveOutgoingTarget(s, translation, null)).toBe("en");
  });

  it("reads incoming speech in the user's chosen reading language", () => {
    expect(resolveIncomingTarget({ ...translation, targetLanguage: "roman_ur" })).toBe("roman_ur");
  });
});

describe("echo prevention", () => {
  const spoken = ["I work with React and Supabase."];

  it("drops a transcript line that repeats what we just spoke", () => {
    expect(isLikelyEcho("I work with React and Supabase", spoken)).toBe(true);
    expect(isLikelyEcho("i work with react and supabase!", spoken)).toBe(true);
  });

  it("keeps genuinely new candidate speech", () => {
    expect(isLikelyEcho("I also deploy on Kubernetes", spoken)).toBe(false);
  });

  it("ignores very short fragments rather than guessing", () => {
    expect(isLikelyEcho("I", spoken)).toBe(false);
  });
});

describe("audio output routing / platform detection", () => {
  it("routes desktop meeting apps through the companion virtual microphone", () => {
    expect(routingForPlatform("zoom_desktop")).toBe("companion_virtual_mic");
    expect(routingForPlatform("teams_desktop")).toBe("companion_virtual_mic");
  });

  it("routes browser platforms through a selected output device", () => {
    for (const p of ["google_meet", "zoom_web", "teams_web", "manual", undefined]) {
      expect(routingForPlatform(p)).toBe("browser_output_device");
    }
  });
});

describe("voice settings", () => {
  it("offers voices for both genders and defaults inside the allowed range", () => {
    expect(voicesFor("female").length).toBeGreaterThan(0);
    expect(voicesFor("male").length).toBeGreaterThan(0);
    expect(DEFAULT_INTERPRETER_SETTINGS.speed).toBeGreaterThanOrEqual(0.7);
    expect(DEFAULT_INTERPRETER_SETTINGS.speed).toBeLessThanOrEqual(1.2);
  });

  it("keeps the original microphone off by default so only the translation is heard", () => {
    expect(DEFAULT_INTERPRETER_SETTINGS.originalMicEnabled).toBe(false);
    expect(DEFAULT_INTERPRETER_SETTINGS.enabled).toBe(false);
  });
});
