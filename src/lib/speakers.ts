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
  /** Deepgram diarization index as a string, or "single" when diarization is off. */
  id: string;
  /** Editable display name. Defaults to "Speaker 1", "Speaker 2", … */
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
  return Number.isFinite(n) ? `Speaker ${n + 1}` : `Speaker ${id}`;
}

export function makeSpeaker(id: string, role: SpeakerRole, at = Date.now()): RemoteSpeaker {
  return {
    id,
    label: defaultSpeakerLabel(id),
    role,
    segments: 0,
    firstHeardAt: at,
    lastHeardAt: at,
    lastText: "",
  };
}

/** Stable, human-readable attribution used in transcripts, memory and the overlay. */
export function speakerTag(speaker: RemoteSpeaker | null | undefined): string {
  if (!speaker) return "Interviewer";
  return speaker.role === "primary_interviewer" ? `${speaker.label} · primary` : speaker.label;
}
