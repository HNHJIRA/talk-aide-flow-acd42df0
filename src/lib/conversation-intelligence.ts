/**
 * CONVERSATION INTELLIGENCE LAYER
 *
 * Pure, synchronous, browser-safe helpers that sit between the STT turn
 * assembler and the live answer request. Nothing here does I/O, so it can run
 * inside the latency-critical path without costing a round trip.
 *
 *  1. Speech repair      — "crash, sorry, cross-platform" -> "cross-platform"
 *  2. Sub-question split — one long turn -> main question + sub-questions
 *  3. Meeting memory     — rolling, attributed, compact meeting state
 *  4. Live context packet— the small object sent with each live answer request
 */

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

const normalizeWords = (text: string) =>
  squash(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* ============================================================
 * 1. SPEECH REPAIR / SELF-CORRECTION
 * ============================================================ */

export type Correction = { from: string; to: string; marker: string };

export type RepairResult = {
  /** Verbatim text as transcribed. */
  raw: string;
  /** Corrections applied — what the speaker actually meant. */
  resolved: string;
  corrections: Correction[];
};

/**
 * Markers that announce a self-correction. Ordered longest-first so
 * "no, I meant" wins over "I meant".
 */
const REPAIR_MARKERS = [
  "let me correct that",
  "let me rephrase",
  "no i meant",
  "no, i meant",
  "i should say",
  "i mean to say",
  "sorry i mean",
  "sorry, i mean",
  "or rather",
  "rather than",
  "i meant",
  "i mean",
  "correction",
  "actually",
  "sorry",
  "rather",
  "scratch that",
  "wait",
];

const MARKER_RE = new RegExp(
  `[\\s,;—–-]*\\b(${REPAIR_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b[\\s,:;—–-]*`,
  "gi",
);

/** "not X, Y" / "not X but Y" — an explicit replacement without a marker word. */
const NOT_X_Y = /\bnot\s+([\w-]+(?:\s+[\w-]+){0,2})\s*(?:,|\s+but\s+|\s+)\s*([\w-]+(?:\s+[\w-]+){0,2})\b/i;

/** Words that follow a marker but are not a correction ("sorry about that"). */
const NON_CORRECTION_TAIL =
  /^(about that|for that|to interrupt|go ahead|i missed|say that again|what was that|could you|can you)\b/i;

/**
 * Rewrite an utterance so the corrected meaning wins.
 *
 * The heuristic is deliberately conservative: it only drops the words
 * immediately BEFORE a correction marker (typically 1-3 words — the misspoken
 * term) and keeps everything else verbatim. It never rewrites meaning, only
 * removes the retracted fragment.
 */
export function repairSpeech(rawText: string): RepairResult {
  const raw = squash(rawText);
  if (!raw) return { raw, resolved: "", corrections: [] };

  const corrections: Correction[] = [];
  let resolved = raw;

  // Pass 1: explicit "not X, Y".
  const notMatch = resolved.match(NOT_X_Y);
  if (notMatch) {
    corrections.push({ from: notMatch[1]!, to: notMatch[2]!, marker: "not X, Y" });
    resolved = squash(resolved.replace(NOT_X_Y, notMatch[2]!));
  }

  // Pass 2: marker-driven repairs, left to right.
  for (let guard = 0; guard < 4; guard++) {
    MARKER_RE.lastIndex = 0;
    const match = MARKER_RE.exec(resolved);
    if (!match) break;

    const before = resolved.slice(0, match.index);
    const after = resolved.slice(match.index + match[0].length);
    const marker = (match[1] ?? "").toLowerCase();

    // "Sorry, could you repeat" is not a self-correction.
    if (NON_CORRECTION_TAIL.test(after.trim())) {
      resolved = squash(`${before} ${after}`);
      continue;
    }
    // A marker at the very start ("Actually, how would you ...") is a discourse
    // marker, not a repair: just drop the marker word.
    if (!before.trim()) {
      resolved = squash(after);
      continue;
    }
    if (!after.trim()) break;

    const beforeWords = before.trim().split(/\s+/);
    const afterWords = after.trim().split(/\s+/);

    // How many trailing words were retracted: match the length of the
    // replacement phrase, capped at 3 and never eating the whole sentence.
    const replacementLen = Math.min(afterWords.length, 3);
    let retract = Math.min(replacementLen, Math.max(1, beforeWords.length - 1), 3);
    // Sentence-boundary punctuation before the marker means the speaker
    // finished a thought; retract just the last word.
    if (/(?<![.?!])[.?!]\s*$/.test(before.trim())) retract = 0;

    const from = retract ? beforeWords.slice(-retract).join(" ") : "";
    const kept = retract ? beforeWords.slice(0, -retract) : beforeWords;
    const to = afterWords.slice(0, replacementLen).join(" ");
    if (from) corrections.push({ from, to, marker });
    resolved = squash(`${kept.join(" ")} ${after}`);
  }

  return { raw, resolved: resolved || raw, corrections };
}

/* ============================================================
 * 2. MULTI-PART QUESTION PARSING
 * ============================================================ */

const SUB_SPLIT =
  /(?:,|;|\band\b|\balso\b|\bplus\b|\bthen\b)?\s*\b(how|what|which|why|when|where|who|whether|can you|could you|would you|do you|did you|are you|is there|tell me|walk me through|explain)\b/gi;

/**
 * Split ONE logical interviewer turn into its sub-questions.
 * Returns [] when the turn is a single question — callers should never create
 * more than one answer card regardless of the result.
 */
export function extractSubQuestions(text: string): string[] {
  const clean = squash(text);
  if (clean.length < 30) return [];

  const marks: number[] = [];
  SUB_SPLIT.lastIndex = 0;
  for (let m = SUB_SPLIT.exec(clean); m; m = SUB_SPLIT.exec(clean)) {
    const idx = m.index + m[0].length - (m[1]?.length ?? 0);
    if (idx > 0) marks.push(idx);
  }
  if (marks.length < 2) return [];

  const parts: string[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]! : clean.length;
    const part = squash(clean.slice(start, end).replace(/[,;]\s*$/, "").replace(/[\s,]+(?:and|also|plus|then)\s*$/i, ""));
    // Ignore fragments that are too small to be a real ask.
    if (part.split(" ").length >= 4) parts.push(part);
  }
  const unique = parts.filter((p, i) => parts.findIndex((o) => o.toLowerCase() === p.toLowerCase()) === i);
  return unique.length >= 2 ? unique.slice(0, 5) : [];
}

/* ============================================================
 * 3. PRONOUN / REFERENCE RESOLUTION
 * ============================================================ */

const VAGUE_REFERENCE =
  /\b(it|that|this|those|these|they|them|the project|the approach|that strategy|the previous issue|the same|there)\b/i;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "how", "what", "why", "when", "which", "who", "would",
  "could", "should", "will", "your", "you", "our", "we", "they", "them", "this", "that", "those",
  "these", "with", "for", "from", "about", "into", "have", "has", "had", "are", "was", "were",
  "there", "here", "then", "than", "also", "just", "like", "very", "much", "make", "made", "going",
  "want", "need", "know", "think", "kind", "sort", "thing", "things", "really", "actually", "okay",
  "yeah", "sure", "does", "did", "doing", "been", "being", "over", "some", "more", "most", "them",
]);

/** Content keywords, most-recent-first, used as the meeting's working topic. */
export function keyTerms(text: string, limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of normalizeWords(text).split(" ")) {
    if (word.length < 4 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

export type ResolvedQuestion = {
  question: string;
  /** Question rewritten so pronouns point at the live topic. */
  resolved: string;
  references: string[];
  subQuestions: string[];
};

/**
 * Make a follow-up self-contained. The rewrite is an appended clarifier rather
 * than a substitution so no original wording is lost or misread.
 */
export function resolveQuestion(question: string, topic: string): ResolvedQuestion {
  const clean = squash(question);
  const subQuestions = extractSubQuestions(clean);
  const references: string[] = [];
  let resolved = clean;

  if (topic && VAGUE_REFERENCE.test(clean) && clean.split(" ").length < 30) {
    const match = clean.match(VAGUE_REFERENCE);
    if (match) references.push(match[1]!.toLowerCase());
    resolved = `${clean} (in this meeting, that refers to: ${topic})`;
  }
  return { question: clean, resolved, references, subQuestions };
}

/* ============================================================
 * 4. MEETING MEMORY
 * ============================================================ */

export type MeetingTurn = {
  speaker: "interviewer" | "candidate" | "test";
  text: string;
  at: number;
};

export type MeetingFact = { label: string; value: string; saidBy: "client" | "candidate"; at: number };
export type MeetingClaim = { topic: string; claim: string; at: number };

/** Numeric / concrete statements worth remembering verbatim. */
const FACT_RE =
  /\b(\d[\d,.]*\s*(?:%|percent|k|m|million|thousand|dollars?|usd|eur|hours?|days?|weeks?|months?|years?|pages?|users?|people|clients?)?)\b/i;

const CLAIM_RE =
  /\b(i (?:have|'ve|has|had|worked|built|led|managed|shipped|used|delivered|run|ran|handle|handled)|my (?:experience|team|background|role))\b/i;

/**
 * Rolling, attributed meeting state. Deliberately bounded: the whole point is
 * that the live answer request carries a compact packet, never the transcript.
 */
export class MeetingMemory {
  turns: MeetingTurn[] = [];
  facts: MeetingFact[] = [];
  claims: MeetingClaim[] = [];
  topics: string[] = [];
  corrections: Correction[] = [];
  answeredQuestions: { question: string; answer: string; at: number }[] = [];
  rollingSummary = "";
  lastTopic = "";

  addTurn(speaker: MeetingTurn["speaker"], text: string) {
    const clean = squash(text);
    if (!clean) return;
    this.turns.push({ speaker, text: clean, at: Date.now() });
    if (this.turns.length > 120) this.turns = this.turns.slice(-120);

    const terms = keyTerms(clean, 4);
    if (terms.length) {
      this.lastTopic = terms.join(" ");
      for (const t of terms) if (!this.topics.includes(t)) this.topics.push(t);
      if (this.topics.length > 40) this.topics = this.topics.slice(-40);
    }

    // Attribution matters: a client number is never a candidate claim.
    if (speaker === "interviewer" && FACT_RE.test(clean)) {
      const value = clean.match(FACT_RE)?.[1] ?? "";
      this.recordFact({ label: keyTerms(clean, 3).join(" ") || "detail", value: clean.slice(0, 180), saidBy: "client", at: Date.now(), _v: value });
    }
    if (speaker === "candidate" && CLAIM_RE.test(clean)) {
      this.claims.push({ topic: keyTerms(clean, 3).join(" ") || "general", claim: clean.slice(0, 180), at: Date.now() });
      if (this.claims.length > 40) this.claims = this.claims.slice(-40);
    }
  }

  /** Newest explicit statement about a label wins; older one is superseded. */
  recordFact(fact: MeetingFact & { _v?: string }) {
    const existing = this.facts.findIndex((f) => f.label === fact.label && f.saidBy === fact.saidBy);
    if (existing >= 0) this.facts.splice(existing, 1);
    this.facts.push({ label: fact.label, value: fact.value, saidBy: fact.saidBy, at: fact.at });
    if (this.facts.length > 40) this.facts = this.facts.slice(-40);
  }

  recordCorrections(corrections: Correction[]) {
    if (!corrections.length) return;
    this.corrections.push(...corrections);
    if (this.corrections.length > 30) this.corrections = this.corrections.slice(-30);
  }

  recordAnswer(question: string, answer: string) {
    const clean = squash(answer);
    if (!clean) return;
    this.answeredQuestions.push({ question: squash(question), answer: clean, at: Date.now() });
    if (this.answeredQuestions.length > 30) this.answeredQuestions = this.answeredQuestions.slice(-30);
    // Anything the copilot suggested and the candidate said out loud becomes a
    // claim only when the candidate actually repeats it — tracked via addTurn.
  }

  /** Relevance-ranked facts for the current question. */
  relevantFacts(question: string, limit = 4): string[] {
    const terms = keyTerms(question, 8);
    return [...this.facts]
      .map((f) => {
        const hay = `${f.label} ${f.value}`.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
        return { f, score };
      })
      .sort((a, b) => b.score - a.score || b.f.at - a.f.at)
      .slice(0, limit)
      .map((x) => `${x.f.saidBy === "client" ? "CLIENT" : "CANDIDATE"}: ${x.f.value}`);
  }

  relevantClaims(question: string, limit = 3): string[] {
    const terms = keyTerms(question, 8);
    return [...this.claims]
      .map((c) => {
        const hay = `${c.topic} ${c.claim}`.toLowerCase();
        return { c, score: terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0) };
      })
      .sort((a, b) => b.score - a.score || b.c.at - a.c.at)
      .slice(0, limit)
      .map((x) => x.c.claim);
  }

  recentTurnLines(count = 6): string[] {
    return this.turns
      .slice(-count)
      .map((t) => `${t.speaker === "interviewer" ? "CLIENT" : t.speaker === "test" ? "TEST" : "ME"}: ${t.text}`);
  }

  previousAnswerSummary(): string {
    const last = this.answeredQuestions[this.answeredQuestions.length - 1];
    if (!last) return "";
    return `Q: ${last.question}\nAlready said: ${last.answer.slice(0, 220)}`;
  }

  stateSnapshot() {
    return {
      lastTopic: this.lastTopic,
      topicsDiscussed: this.topics.slice(-12),
      factsEstablished: this.facts.slice(-8).map((f) => f.value),
      candidateStatements: this.claims.slice(-6).map((c) => c.claim),
      questionsAnswered: this.answeredQuestions.length,
      corrections: this.corrections.length,
      rollingSummary: this.rollingSummary,
    };
  }
}

/** Compact per-question context sent to the live answer route. */
export type LiveContextPacket = {
  currentQuestion: string;
  resolvedQuestion: string;
  currentTopic: string;
  subQuestions: string[];
  recentTurns: string[];
  meetingFacts: string[];
  candidateClaims: string[];
  previousAnswerSummary: string;
  corrections: string[];
};

export function buildContextPacket(
  memory: MeetingMemory,
  question: string,
  correctionsForTurn: Correction[] = [],
): LiveContextPacket {
  const resolvedQ = resolveQuestion(question, memory.lastTopic);
  return {
    currentQuestion: resolvedQ.question,
    resolvedQuestion: resolvedQ.resolved,
    currentTopic: memory.lastTopic,
    subQuestions: resolvedQ.subQuestions,
    recentTurns: memory.recentTurnLines(6),
    meetingFacts: memory.relevantFacts(resolvedQ.resolved),
    candidateClaims: memory.relevantClaims(resolvedQ.resolved),
    previousAnswerSummary: memory.previousAnswerSummary(),
    corrections: correctionsForTurn.map((c) => `"${c.from}" -> "${c.to}"`),
  };
}
