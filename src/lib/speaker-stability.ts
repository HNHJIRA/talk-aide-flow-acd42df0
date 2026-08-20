/**
 * Mixed-stream diarization labels are temporary acoustic clusters, not people.
 * This analyser only decides whether those labels are stable enough for
 * short-lived routing restrictions; it never attempts speaker recognition.
 */
export type SpeakerObservation = {
  at: number;
  wordsBySpeaker: Record<string, number>;
  switches: number;
};

export type SpeakerStability = {
  unstable: boolean;
  reason: string | null;
  distribution: Record<string, number>;
  recentSwitches: number;
};

function totals(observations: SpeakerObservation[]) {
  const counts: Record<string, number> = {};
  let words = 0;
  let switches = 0;
  for (const observation of observations) {
    switches += observation.switches;
    for (const [id, count] of Object.entries(observation.wordsBySpeaker)) {
      counts[id] = (counts[id] ?? 0) + count;
      words += count;
    }
  }
  return { counts, words, switches };
}

function dominant(counts: Record<string, number>, words: number) {
  const entry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return entry ? { id: entry[0], share: words ? entry[1] / words : 0 } : null;
}

export function analyzeSpeakerStability(
  observations: SpeakerObservation[],
  now = Date.now(),
): SpeakerStability {
  const recent = observations.filter((item) => now - item.at <= 60_000);
  const current = totals(recent);
  const distribution = Object.fromEntries(
    Object.entries(current.counts).map(([id, count]) => [id, current.words ? count / current.words : 0]),
  );
  if (current.words < 40) {
    return { unstable: false, reason: null, distribution, recentSwitches: current.switches };
  }

  if (current.switches / current.words >= 0.3) {
    return {
      unstable: true,
      reason: "rapid label switching",
      distribution,
      recentSwitches: current.switches,
    };
  }

  const midpoint = Math.max(1, Math.floor(recent.length / 2));
  const earlier = totals(recent.slice(0, midpoint));
  const later = totals(recent.slice(midpoint));
  const oldDominant = dominant(earlier.counts, earlier.words);
  const newDominant = dominant(later.counts, later.words);
  if (
    earlier.words >= 15 &&
    later.words >= 15 &&
    oldDominant &&
    newDominant &&
    oldDominant.id !== newDominant.id &&
    oldDominant.share >= 0.65 &&
    newDominant.share >= 0.65
  ) {
    return {
      unstable: true,
      reason: "dominant voice label shifted",
      distribution,
      recentSwitches: current.switches,
    };
  }

  return { unstable: false, reason: null, distribution, recentSwitches: current.switches };
}