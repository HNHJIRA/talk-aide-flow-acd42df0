/**
 * SOURCE CAPABILITY MODEL
 *
 * Routing must never claim more than the audio source can actually deliver.
 * A browser tab capture gives us ONE mixed stream: diarization may or may not
 * separate the voices in it, so identity there is best-effort. A future native
 * SDK source (Zoom Desktop, Meet SDK) can deliver per-participant frames with
 * real ids — that is the only case where identity is deterministic.
 *
 * Everything here is pure data: no I/O, no latency.
 */

export type ParticipantCapability =
  /** Real participant identity / per-participant audio from the source itself. */
  | "deterministic_participant_audio"
  /** One mixed stream; diarization may separate voices probabilistically. */
  | "diarized_mixed_audio"
  /** One mixed stream and no reliable speaker separation available. */
  | "mixed_audio_only";

export const CAPABILITY_LABELS: Record<ParticipantCapability, string> = {
  deterministic_participant_audio: "Per-participant audio • real identities",
  diarized_mixed_audio: "Mixed audio • voice separation best-effort • identity not guaranteed",
  mixed_audio_only: "Mixed audio • speaker separation unavailable",
};

export type IdentityConfidence = "none" | "best-effort" | "deterministic";

export function identityConfidence(capability: ParticipantCapability): IdentityConfidence {
  if (capability === "deterministic_participant_audio") return "deterministic";
  if (capability === "diarized_mixed_audio") return "best-effort";
  return "none";
}

/**
 * Frame contract a future deterministic source (Zoom SDK, Meet SDK, native
 * companion with per-participant taps) implements. When `participantId` is
 * present, Deepgram is used for SPEECH ONLY and never for identity.
 */
export type ParticipantAudioFrame = {
  sourceType:
    | "browser_tab"
    | "zoom_desktop"
    | "teams_desktop"
    | "zoom_sdk"
    | "meet_sdk"
    | "microphone";
  participantId: string | null;
  participantName: string | null;
  audioFrame: ArrayBuffer;
  at: number;
};

export type ParticipantSource = {
  sourceType: ParticipantAudioFrame["sourceType"];
  capability: ParticipantCapability;
  /** True only when the source itself supplies participant ids per frame. */
  providesParticipantIdentity: boolean;
};

/** What a given remote capture can promise before any audio has been heard. */
export function capabilityForSource(
  source: "remote_meeting" | "desktop_companion" | "microphone",
  diarizationRequested: boolean,
): ParticipantCapability {
  if (source === "microphone") return "mixed_audio_only";
  // Neither browser tab audio nor the current companion tap carries participant
  // ids: both are mixed streams. Diarization is the only (probabilistic) split.
  return diarizationRequested ? "diarized_mixed_audio" : "mixed_audio_only";
}

/** Honest, user-facing statement of what separation actually happened so far. */
export function speakerSeparationStatus(
  capability: ParticipantCapability,
  distinctVoices: number,
  fallbackActive: boolean,
): string {
  if (capability === "deterministic_participant_audio")
    return `Participant identity provided by the meeting source (${distinctVoices} participants)`;
  if (distinctVoices >= 2) return `Detected ${distinctVoices} temporary voice labels (best effort)`;
  if (fallbackActive)
    return "Only one voice label detected — using All Remote mode";
  return "No separated voices yet — best-effort on mixed audio";
}
