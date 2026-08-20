/**
 * REMOTE SPEAKER ROSTER
 *
 * A Zoom/Meet call can carry several remote voices on one audio stream. Deepgram
 * diarization tags each transcript with a speaker index ("0", "1", …) — an
 * arbitrary, per-session label that says nothing about WHO the person is.
 *
 * This module owns the roster: pure, synchronous, deterministic. Nothing here
 * does I/O or calls a model, so speaker routing costs no latency.
 */

export type SpeakerRole = "primary_interviewer" | "interviewer" | "other" | "ignore" | "unassigned";

export type RemoteSpeaker = {
  /** Temporary Deepgram voice-cluster index, or "single" when diarization is off. */
  id: string;
  /** Explicit immutable copy of the raw Deepgram speaker index. */
  rawSpeakerId: string;
  /** Immutable generated name derived only from rawSpeakerId. */
  displayName: string;
  /** User-provided name; never used as an identity or map key. */
  customName: string | null;
  /** Effective UI label: customName when present, otherwise displayName. */
  label: string;
  role: SpeakerRole;
  /** How many finalised segments we have heard from this speaker. */
  segments: number;
  firstHeardAt: number;
  lastHeardAt: number;
  /** Newest thing they said, shown in the roster UI so the user can identify them. */
  lastText: string;
};

export const SPEAKER_ROLE_LABELS: Record<SpeakerRole, string> = {
  primary_interviewer: "Primary interviewer",
  interviewer: "Interviewer",
  other: "Other participant",
  ignore: "Ignore",
  unassigned: "Unassigned",
};

export const SPEAKER_ROLE_ORDER: SpeakerRole[] = [
  "primary_interviewer",
  "interviewer",
  "other",
  "ignore",
];

/** Only these roles are allowed to trigger question detection and answers. */
export function roleDrivesAnswers(role: SpeakerRole): boolean {
  return role === "primary_interviewer" || role === "interviewer";
}

/** Roles whose speech is still transcribed and remembered, but never answered. */
export function roleIsHeard(role: SpeakerRole): boolean {
  return role !== "ignore";
}

export function defaultSpeakerLabel(id: string): string {
  if (id === "single") return "Interviewer";
  const n = Number(id);
  return Number.isFinite(n) ? `Voice ${n + 1}` : `Voice ${id}`;
}

export function makeSpeaker(id: string, role: SpeakerRole, at = Date.now()): RemoteSpeaker {
  const displayName = defaultSpeakerLabel(id);
  return {
    id,
    rawSpeakerId: id,
    displayName,
    customName: null,
    label: displayName,
    role,
    segments: 0,
    firstHeardAt: at,
    lastHeardAt: at,
    lastText: "",
  };
}

/**
 * Stable, human-readable attribution used in transcripts, memory and the overlay.
 *
 * Identity is only claimed when the user actually assigned a role to a diarized
 * voice. Otherwise the speech is attributed to a generic "Remote participant" —
 * never to the primary interviewer, and never to a name we merely guessed.
 */
export function speakerTag(speaker: RemoteSpeaker | null | undefined): string {
  if (!speaker) return "Remote participant";
  if (speaker.role === "primary_interviewer") return `${speaker.label} · primary`;
  if (speaker.role === "interviewer" || speaker.customName) return speaker.label;
  return "Remote participant";
}
