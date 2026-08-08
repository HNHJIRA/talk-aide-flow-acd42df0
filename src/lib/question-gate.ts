/**
 * Fast LOCAL question gate.
 *
 * Runs in the browser in well under a millisecond so the overwhelming majority
 * of interviewer turns never pay for an AI classifier round trip. Only genuinely
 * ambiguous utterances fall through to the existing `detectQuestion` server fn.
 */

export type GateDecision = "question" | "reject" | "ambiguous";

export type GateVerdict = {
  decision: GateDecision;
  question: string;
  category: string;
  confidence: number;
  reason: string;
};

const clean = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim();

const normalize = (text: string) =>
  clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .trim();

/** Acknowledgements and filler — never an interview question. */
const FILLERS = new Set([
  "okay", "ok", "okay okay", "right", "alright", "all right", "interesting", "great",
  "good", "nice", "cool", "makes sense", "that makes sense", "thank you", "thanks",
  "perfect", "got it", "gotcha", "hmm", "mhm", "uh huh", "sure", "yeah", "yes", "no",
  "exactly", "understood", "i see", "of course", "wonderful", "excellent", "awesome",
  "fair enough", "no worries", "sounds good", "very good", "amazing", "lovely",
  "perfect thank you", "okay great", "okay thank you", "great thank you", "thank you so much",
]);

/** Leading interrogatives / imperatives that mark a request for a spoken answer. */
const QUESTION_LEADS: { re: RegExp; category: string }[] = [
  { re: /^(tell me|talk me through|walk me through|give me an example|give me a|share)\b/, category: "resume" },
  { re: /^(explain|describe|define|elaborate on|clarify)\b/, category: "technical" },
  { re: /^(design|architect|compare|contrast|implement|write|code|debug|optimi[sz]e)\b/, category: "system_design" },
  { re: /^(suppose|imagine|say that|let's say|lets say|pretend)\b/, category: "situational" },
  { re: /^(how|why|what|when|where|which|who|whose|whom)\b/, category: "general" },
  { re: /^(can you|could you|would you|will you|are you|were you|have you|has your|had you|do you|did you|does your|is there|was there|any chance)\b/, category: "general" },
  { re: /^(and (how|why|what|when|which|can|could|do|did))\b/, category: "follow_up" },
  { re: /^(so (how|why|what|when|which|tell|can|could|do|did))\b/, category: "follow_up" },
];

const CATEGORY_HINTS: { re: RegExp; category: string }[] = [
  { re: /\b(yourself|about you|background|introduce)\b/, category: "intro" },
  { re: /\b(salary|compensation|pay|rate|package)\b/, category: "salary" },
  { re: /\b(notice period|start date|available|availability|join)\b/, category: "availability" },
  { re: /\b(team|manage|lead|mentor|stakeholder|conflict)\b/, category: "leadership" },
  { re: /\b(architecture|scale|scaling|system design|throughput|latency|database design)\b/, category: "system_design" },
  { re: /\b(react|typescript|python|api|algorithm|code|function|bug|deploy|test)\b/, category: "technical" },
  { re: /\b(tell me about a time|describe a situation|example of when)\b/, category: "behavioral" },
  { re: /\b(hardest part|how did you solve|what happened next|why that|and then)\b/, category: "follow_up" },
  { re: /\b(resume|cv|your experience|worked on|project you)\b/, category: "resume" },
  { re: /\b(company|culture|values|why us|why do you want)\b/, category: "culture" },
];

function guessCategory(norm: string, fallback: string) {
  for (const hint of CATEGORY_HINTS) if (hint.re.test(norm)) return hint.category;
  return fallback;
}

/**
 * Classify an interviewer utterance without any network call.
 * `ambiguous` means: escalate to the AI classifier.
 */
export function fastQuestionGate(rawText: string): GateVerdict {
  const text = clean(rawText);
  const norm = normalize(text);
  const words = norm ? norm.split(" ") : [];

  if (!norm || words.length < 2) {
    return { decision: "reject", question: text, category: "general", confidence: 0.95, reason: "too short" };
  }
  if (FILLERS.has(norm)) {
    return { decision: "reject", question: text, category: "general", confidence: 0.95, reason: "acknowledgement" };
  }
  // "Perfect, thank you." / "Okay great." — every word is filler.
  if (words.length <= 4 && words.every((w) => FILLERS.has(w) || w === "so" || w === "and" || w === "very")) {
    return { decision: "reject", question: text, category: "general", confidence: 0.9, reason: "acknowledgement" };
  }

  const endsWithQuestionMark = /\?\s*$/.test(text);
  const lead = QUESTION_LEADS.find((l) => l.re.test(norm));

  if (lead) {
    const category = guessCategory(norm, lead.category);
    // A clear interrogative/imperative lead with enough substance is a question,
    // punctuation or not ("Tell me about yourself.").
    const confidence = endsWithQuestionMark ? 0.95 : words.length >= 4 ? 0.88 : 0.7;
    if (confidence >= 0.85) {
      return { decision: "question", question: text, category, confidence, reason: "interrogative lead" };
    }
    return { decision: "ambiguous", question: text, category, confidence, reason: "short interrogative lead" };
  }

  if (endsWithQuestionMark && words.length >= 3) {
    return {
      decision: "question",
      question: text,
      category: guessCategory(norm, "general"),
      confidence: 0.9,
      reason: "question mark",
    };
  }

  // Mid-sentence interrogative ("...and what was the hardest part").
  if (/\b(what|how|why|when|which|tell me|walk me through|describe|explain)\b/.test(norm) && words.length >= 5) {
    return {
      decision: "ambiguous",
      question: text,
      category: guessCategory(norm, "general"),
      confidence: 0.6,
      reason: "embedded interrogative",
    };
  }

  // Short statements with no interrogative signal: reject locally, no AI call.
  if (words.length <= 6) {
    return { decision: "reject", question: text, category: "general", confidence: 0.8, reason: "statement" };
  }

  return { decision: "ambiguous", question: text, category: "general", confidence: 0.4, reason: "unclear" };
}

/** Is a partial interim already substantive enough to prefetch resume context for? */
export function isPrefetchWorthy(interimText: string) {
  const norm = normalize(interimText);
  if (norm.split(" ").length < 4) return false;
  if (FILLERS.has(norm)) return false;
  const verdict = fastQuestionGate(interimText);
  return verdict.decision !== "reject";
}

/** Topic keywords used to warm the retrieval cache from unstable interim text. */
export function topicTerms(text: string) {
  return normalize(text)
    .split(" ")
    .filter((w) => w.length > 3)
    .slice(0, 10)
    .join(" ");
}
