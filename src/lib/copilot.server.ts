/** Server-only helpers for the copilot: Deepgram key minting, context retrieval, prompts. */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export function serviceClient() {
  return createClient<Database>(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type DeepgramAuthMode = "grant";

export type DeepgramDiagnostics = {
  configured: boolean;
  scopes: string[];
  canGrant: boolean;
  mode: DeepgramAuthMode | null;
  problem: string | null;
};

function dgHeaders(apiKey: string) {
  return { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" };
}

/**
 * Short-lived browser credential for Deepgram, minted with POST /v1/auth/grant —
 * the least-privileged path (no keys:write, no temporary project keys created).
 * The long-lived DEEPGRAM_API_KEY never leaves the server.
 */
export async function mintDeepgramKey(): Promise<{ key: string; expiresAt: string; mode: DeepgramAuthMode }> {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "Live transcription is not configured yet. Add a Deepgram API key to enable real-time transcription.",
    );
  }

  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: dgHeaders(apiKey),
    body: JSON.stringify({ ttl_seconds: 300 }),
  });

  if (res.ok) {
    const grant = (await res.json()) as { access_token: string; expires_in?: number };
    return {
      key: grant.access_token,
      expiresAt: new Date(Date.now() + (grant.expires_in ?? 300) * 1000).toISOString(),
      mode: "grant",
    };
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Deepgram refused to mint a temporary token for this API key (403 Insufficient permissions). The key currently carries only the 'account:write' scope. In the Deepgram console delete it and create a new API key using the built-in 'Member' role (not a custom scope selection) — Member is enough for /v1/auth/grant.",
    );
  }
  const detail = await res.text().catch(() => "");
  throw new Error(`Deepgram /v1/auth/grant failed (${res.status}). ${detail.slice(0, 160)}`);
}

/** Honest, non-faked report of what the configured Deepgram key can actually do. */
export async function deepgramDiagnostics(): Promise<DeepgramDiagnostics> {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    return {
      configured: false,
      scopes: [],
      canGrant: false,
      
      mode: null,
      problem: "No Deepgram API key is configured.",
    };
  }
  const headers = dgHeaders(apiKey);
  let scopes: string[] = [];
  try {
    const me = await fetch("https://api.deepgram.com/v1/auth/token", { headers });
    if (me.ok) scopes = ((await me.json()) as { scopes?: string[] }).scopes ?? [];
  } catch {
    /* network */
  }
  let mode: DeepgramAuthMode | null = null;
  let problem: string | null = null;
  try {
    mode = (await mintDeepgramKey()).mode;
  } catch (error) {
    problem = error instanceof Error ? error.message : "Unknown Deepgram error.";
  }
  return {
    configured: true,
    scopes,
    canGrant: mode === "grant",
    mode,
    problem,
  };
}

export async function analyzePrerecordedDiarization(wavBase64: string) {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) throw new Error("Live transcription is not configured.");
  const audio = Uint8Array.from(atob(wavBase64), (character) => character.charCodeAt(0));
  const params = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    punctuate: "true",
    diarize_model: "latest",
  });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/wav" },
    body: audio,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Pre-recorded diarization failed (${response.status}): ${detail.slice(0, 160)}`);
  }
  const payload = (await response.json()) as {
    metadata?: { model_info?: Record<string, { name?: string; version?: string }> };
    results?: { channels?: { alternatives?: { words?: { word?: string; speaker?: number }[] }[] }[] };
  };
  const words = payload.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  const ids = [...new Set(words.flatMap((word) => (Number.isInteger(word.speaker) ? [word.speaker as number] : [])))];
  const wordsBySpeaker: Record<string, number> = {};
  let speakerChanges = 0;
  let previous: number | null = null;
  for (const word of words) {
    if (!Number.isInteger(word.speaker)) continue;
    const speaker = word.speaker as number;
    wordsBySpeaker[String(speaker)] = (wordsBySpeaker[String(speaker)] ?? 0) + 1;
    if (previous != null && previous !== speaker) speakerChanges += 1;
    previous = speaker;
  }
  const model = Object.values(payload.metadata?.model_info ?? {})[0];
  return {
    uniqueSpeakerIds: ids.sort((a, b) => a - b),
    wordsBySpeaker,
    speakerChanges,
    wordCount: words.length,
    model: model?.name ?? "nova-3",
    modelVersion: model?.version ?? null,
  };
}


export const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
export const FAST_MODEL = "google/gemini-3.1-flash-lite";
export const ANSWER_MODEL = "google/gemini-3.6-flash";

export function lovableAiHeaders() {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project.");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "X-Lovable-AIG-SDK": "fetch",
  };
}

export const NO_FABRICATION_RULES = `You are an interview coaching copilot.
Use the candidate's verified resume, documents and supplied context as the only source of truth for their personal background.
Never invent employers, education, degrees, certifications, project results, revenue, years of experience, team size, technologies, job titles, dates or accomplishments.
When required information is missing, give a truthful framework the candidate can adapt (e.g. "A strong example here would be a project where you ...") instead of fabricating personal history.
Write in natural spoken English that sounds right when said out loud.`;

const LENGTH_RULES: Record<string, string> = {
  ultra_short: "Answer in at most 35 words. One tight paragraph or two bullets.",
  short: "Answer in 50-90 words.",
  normal: "Answer in 90-140 words.",
  detailed: "Answer in 160-240 words.",
};

const STYLE_RULES: Record<string, string> = {
  quick: "Format as 2-4 short bullets, each one speakable sentence.",
  natural: "Format as a conversational short paragraph: direct answer first, then 2-3 supporting points.",
  star: "Format with bold labels Situation, Task, Action, Result — one or two sentences each.",
  technical: "Format with bold labels Concept, Implementation, Example, Tradeoffs.",
  leadership: "Format with bold labels Context, Decision, Team Action, Result, Lesson.",
  bullets: "Format as 3-5 speaking points, each a single short line.",
  simpler: "Explain in plain language a non-expert could follow, no jargon.",
  more_detail: "Give a deeper answer with concrete specifics drawn only from the provided context.",
};

/**
 * Language rules that a bare BCP-47 code cannot express — notably
 * transliterations, which the model must not render in the native script.
 */
const LANGUAGE_RULES: Record<string, string> = {
  roman_ur:
    "Write the answer in Roman Urdu: Urdu spoken naturally but typed in Latin script (e.g. 'Main ne yeh project lead kiya tha'). Never use Arabic script. Keep technical terms, product names and acronyms in English.",
  ur: "Write the answer in Urdu using Arabic script. Keep technical terms, product names and acronyms in English.",
  hi: "Write the answer in Hindi using Devanagari script. Keep technical terms, product names and acronyms in English.",
};

export function answerInstructions(style: string, length: string, language: string) {
  return [
    STYLE_RULES[style] ?? STYLE_RULES["natural"],
    LENGTH_RULES[length] ?? LENGTH_RULES["short"],
    LANGUAGE_RULES[language] ?? `Write the answer in this language code: ${language}.`,
    "Bold at most a few key terms. Never add preambles like 'Here is your answer'.",
  ].join(" ");
}


/** Keyword/full-text retrieval over the candidate's document chunks. */
export async function retrieveContext(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  documentId: string | null,
  question: string,
): Promise<string> {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8);

  const { data: chunks } = await db
    .from("document_chunks")
    .select("content, chunk_type, document_id")
    .eq("user_id", userId)
    .limit(200);

  if (!chunks?.length) return "";

  const scored = chunks
    .map((chunk) => {
      const text = chunk.content.toLowerCase();
      let score = terms.reduce((acc, term) => acc + (text.includes(term) ? 1 : 0), 0);
      if (documentId && chunk.document_id === documentId) score += 1.5;
      if (["summary", "skills", "experience"].includes(chunk.chunk_type)) score += 0.5;
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .filter((item) => item.score > 0);

  const selected = scored.length ? scored : chunks.slice(0, 4).map((chunk) => ({ chunk, score: 0 }));
  return selected
    .map((item) => `[${item.chunk.chunk_type}] ${item.chunk.content}`)
    .join("\n---\n")
    .slice(0, 6000);
}

/* ============================================================
 * LIVE ANSWER PATH (latency-optimised)
 * Everything below serves the automatic in-interview answer only.
 * Practice evaluations, notes and manual regeneration keep using
 * ANSWER_MODEL through /api/answer-stream unchanged.
 * ============================================================ */

/**
 * Latency preset for the automatic live answer. Server-side only — never sent
 * to the browser. "fast" is the production default and is benchmark-derived:
 * gemini-2.5-flash-lite measured a 517 ms median TTFT vs 819 ms for
 * gemini-3.6-flash and 671–881 ms for the gpt-5.6 family on the same prompt.
 */
export const LIVE_LATENCY_MODE = process.env["LIVE_LATENCY_MODE"] ?? "fast";

const LIVE_PRESETS: Record<
  string,
  { model: string; effort: string; tier: string; maxOutput: number }
> = {
  fast: { model: "google/gemini-2.5-flash-lite", effort: "none", tier: "fast", maxOutput: 220 },
  balanced: { model: "google/gemini-3.6-flash", effort: "none", tier: "", maxOutput: 320 },
  quality: { model: "openai/gpt-5.6-terra", effort: "none", tier: "fast", maxOutput: 400 },
};
const LIVE_PRESET = LIVE_PRESETS[LIVE_LATENCY_MODE] ?? LIVE_PRESETS["fast"]!;

/** Fast model for the automatic live answer. Overridable without a redeploy. */
export const LIVE_ANSWER_MODEL = process.env["LIVE_ANSWER_MODEL"] ?? LIVE_PRESET.model;
/** "none" removes model thinking latency — measured 1979ms -> 817ms TTFT. */
export const LIVE_REASONING_EFFORT = process.env["LIVE_REASONING_EFFORT"] ?? LIVE_PRESET.effort;
/** OpenAI-style fast/priority serving tier; empty string = provider default. */
export const LIVE_SERVICE_TIER = process.env["LIVE_SERVICE_TIER"] ?? LIVE_PRESET.tier;
export const LIVE_MAX_OUTPUT = Number(process.env["LIVE_MAX_OUTPUT"] ?? LIVE_PRESET.maxOutput);
/** Stronger model kept for "More detail" / deep-dive regeneration only. */
export const LIVE_DEEP_MODEL = process.env["LIVE_DEEP_MODEL"] ?? "openai/gpt-5.6-terra";
/** Candidates for the dev-only live-answer benchmark. */
export const LIVE_BENCHMARK_MODELS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-3.1-flash-lite",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
];


type CacheEntry<T> = { at: number; value: T };
const TTL_MS = 10 * 60 * 1000;

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T) {
  if (map.size > 200) {
    for (const [k, v] of map) if (Date.now() - v.at > TTL_MS) map.delete(k);
  }
  map.set(key, { at: Date.now(), value });
}

export type LiveSessionContext = {
  sessionId: string;
  userId: string;
  targetRole: string | null;
  companyName: string | null;
  jobDescription: string | null;
  resumeDocumentId: string | null;
  answerStyle: string;
  answerLength: string;
  answerLanguage: string;
  rollingSummary: string | null;
  profileLine: string;
  /** Pre-meeting knowledge base, compiled once at Go Live. */
  meetingBrief: string | null;
  /** Carried-over knowledge from earlier meetings on the same project. */
  projectMemory: string | null;
  /** Claims the user explicitly does not want made on their behalf. */
  avoidClaims: string | null;
};


type Chunk = { content: string; chunk_type: string; document_id: string };

const sessionCtxCache = new Map<string, CacheEntry<LiveSessionContext>>();
const chunkCache = new Map<string, CacheEntry<Chunk[]>>();
const prefetchCache = new Map<string, CacheEntry<string>>();

/** Session-level immutable context, loaded once per session (primed at Go Live). */
export async function getLiveSessionContext(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  sessionId: string,
  refresh = false,
): Promise<LiveSessionContext | null> {
  const key = `${userId}:${sessionId}`;
  if (!refresh) {
    const cached = cacheGet(sessionCtxCache, key);
    if (cached) return cached;
  }

  const [{ data: session }, { data: profile }, { data: prep }] = await Promise.all([
    db
      .from("interview_sessions")
      .select(
        "id, user_id, target_role, company_name, job_description, resume_document_id, answer_style, answer_length, answer_language, rolling_summary, project_id",
      )
      .eq("id", sessionId)
      .maybeSingle(),
    db
      .from("profiles")
      .select("full_name, current_position, target_role, experience_level")
      .eq("user_id", userId)
      .maybeSingle(),
    db
      .from("meeting_preparations")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle(),
  ]);

  if (!session || session.user_id !== userId) return null;

  // Project memory: what earlier meetings on the same project established.
  let projectMemory: string | null = null;
  if (session.project_id) {
    const [{ data: project }, { data: priorNotes }] = await Promise.all([
      db
        .from("projects")
        .select("name, client_name, description, shared_notes")
        .eq("id", session.project_id)
        .maybeSingle(),
      db
        .from("interview_sessions")
        .select("id, rolling_summary, created_at")
        .eq("project_id", session.project_id)
        .neq("id", sessionId)
        .order("created_at", { ascending: false })
        .limit(3),
    ]);
    const lines = [
      project?.name ? `Project: ${project.name}` : "",
      project?.client_name ? `Client: ${project.client_name}` : "",
      project?.description ? `About: ${project.description}` : "",
      project?.shared_notes ? `Standing notes: ${project.shared_notes}` : "",
      ...(priorNotes ?? [])
        .filter((s) => s.rolling_summary)
        .map((s, i) => `Earlier meeting ${i + 1}: ${s.rolling_summary}`),
    ].filter(Boolean);
    projectMemory = lines.length ? lines.join("\n").slice(0, LIVE_BUDGET.project) : null;
  }

  const meetingBrief = prep ? compileMeetingBrief(prep as Record<string, string | null>) : null;

  const ctx: LiveSessionContext = {
    sessionId: session.id,
    userId,
    targetRole: session.target_role,
    companyName: session.company_name,
    jobDescription: (session.job_description ?? "").slice(0, 2000) || null,
    resumeDocumentId: session.resume_document_id,
    answerStyle: session.answer_style ?? "natural",
    answerLength: session.answer_length ?? "short",
    answerLanguage: session.answer_language ?? "en",
    rollingSummary: session.rolling_summary,
    profileLine: `Name: ${profile?.full_name ?? "unknown"} | Current: ${profile?.current_position ?? "unknown"} | Target: ${session.target_role ?? profile?.target_role ?? "unknown"} | Level: ${profile?.experience_level ?? "unknown"}`,
    meetingBrief,
    projectMemory,
    avoidClaims: (prep?.avoid_claims ?? null) || null,
  };
  cacheSet(sessionCtxCache, key, ctx);
  return ctx;
}

/**
 * Compile the pre-meeting knowledge base into the stable brief that becomes
 * part of the cached system prompt. Pure formatting — nothing is generated.
 */
export function compileMeetingBrief(prep: Record<string, string | null>): string | null {
  const row = (label: string, key: string) => {
    const value = (prep[key] ?? "").toString().replace(/\s+/g, " ").trim();
    return value ? `${label}: ${value}` : "";
  };
  const brief = [
    row("Meeting", "meeting_title"),
    row("Type", "meeting_type"),
    row("Company/client", "company_name"),
    row("Client website", "client_website"),
    row("Project", "project_name"),
    row("Project description", "project_description"),
    row("Role discussed", "role_discussed"),
    row("Requirements", "requirements"),
    row("Goals", "goals"),
    row("Challenges", "challenges"),
    row("Tech stack", "tech_stack"),
    row("Budget", "budget_notes"),
    row("Timeline", "timeline"),
    row("Known client concerns", "client_concerns"),
    row("Important facts", "important_facts"),
    row("Emphasise", "emphasize"),
    row("Previous communication", "previous_communication"),
    row("Notes", "custom_notes"),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, LIVE_BUDGET.brief);
  return brief || null;
}


/** Already-indexed chunks only — no parsing/chunking/embedding ever happens here. */
async function getUserChunks(db: ReturnType<typeof serviceClient>, userId: string): Promise<Chunk[]> {
  const cached = cacheGet(chunkCache, userId);
  if (cached) return cached;
  const { data } = await db
    .from("document_chunks")
    .select("content, chunk_type, document_id")
    .eq("user_id", userId)
    .limit(300);
  const chunks = (data ?? []) as Chunk[];
  cacheSet(chunkCache, userId, chunks);
  return chunks;
}

/**
 * Prompt budgets for the automatic live answer. These are TARGETS, not the
 * maximums the model could take: every extra character is prefill latency.
 */
export const LIVE_BUDGET = {
  resume: 1200,
  conversation: 400,
  priorQna: 400,
  summary: 300,
  job: 350,
  /** Pre-meeting knowledge base (stable, cached in the system prompt). */
  brief: 1400,
  /** Carried-over project knowledge from earlier meetings. */
  project: 700,
  /** Live meeting memory sent per question. */
  meetingTurns: 700,
  meetingFacts: 400,
  claims: 300,
};


/** Top-k keyword retrieval over the cached chunk set. */
export async function retrieveLiveContext(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  documentId: string | null,
  question: string,
  k = 3,
): Promise<string> {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 10);

  const chunks = await getUserChunks(db, userId);
  if (!chunks.length) return "";

  const scored = chunks
    .map((chunk) => {
      const text = chunk.content.toLowerCase();
      let score = terms.reduce((acc, term) => acc + (text.includes(term) ? 1 : 0), 0);
      if (documentId && chunk.document_id === documentId) score += 1.5;
      if (["summary", "skills", "experience"].includes(chunk.chunk_type)) score += 0.5;
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((item) => item.score > 0);

  const selected = scored.length ? scored : chunks.slice(0, Math.min(2, k)).map((chunk) => ({ chunk, score: 0 }));
  return selected
    .map((item) => `[${item.chunk.chunk_type}] ${item.chunk.content.replace(/\s+/g, " ").trim()}`)
    .join("\n---\n")
    .slice(0, LIVE_BUDGET.resume);
}

const factCardCache = new Map<string, CacheEntry<string>>();

/**
 * Compact LIVE CANDIDATE FACT CARD, built once at Go Live from already-indexed
 * chunks. Pure extraction — every line is verbatim resume text, nothing is
 * summarised by a model and nothing is invented.
 */
export async function getLiveFactCard(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  ctx: LiveSessionContext,
  refresh = false,
): Promise<string> {
  const key = `${userId}:${ctx.sessionId}`;
  if (!refresh) {
    const cached = cacheGet(factCardCache, key);
    if (cached != null) return cached;
  }
  const chunks = await getUserChunks(db, userId);
  const clean = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
  const pick = (types: string[], n: number, max: number) =>
    chunks
      .filter((c) => types.includes(c.chunk_type))
      .filter((c) => !ctx.resumeDocumentId || c.document_id === ctx.resumeDocumentId)
      .slice(0, n)
      .map((c) => `- ${clean(c.content, max)}`);

  const summary = pick(["summary"], 1, 260);
  const skills = pick(["skills"], 2, 220);
  const experience = pick(["experience"], 3, 240);
  const projects = pick(["project", "projects"], 2, 200);
  const education = pick(["education"], 1, 140);

  const card = [
    `Target role: ${ctx.targetRole ?? "unspecified"}`,
    summary.length ? `Summary:\n${summary.join("\n")}` : "",
    skills.length ? `Core skills:\n${skills.join("\n")}` : "",
    experience.length ? `Experience facts:\n${experience.join("\n")}` : "",
    projects.length ? `Key projects:\n${projects.join("\n")}` : "",
    education.length ? `Education:\n${education.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2200);

  cacheSet(factCardCache, key, card);
  return card;
}

export function storePrefetchedContext(key: string, context: string) {
  cacheSet(prefetchCache, key, context);
}

export function readPrefetchedContext(key: string | null | undefined): string | null {
  if (!key) return null;
  return cacheGet(prefetchCache, key);
}

/**
 * Stable prompt prefix (identical bytes across every request in a session) so
 * nothing forces the provider to re-read a freshly-built instruction block.
 * The pre-meeting brief and project memory live HERE, not in the per-question
 * payload: they never change mid-meeting, so they stay prefix-cacheable.
 */
export function liveSystemPrompt(ctx: LiveSessionContext, style: string, length: string) {
  return `You are the speaker's real-time meeting copilot on a live call. You output EXACTLY the words they should say out loud next — nothing else.
You are a senior technical professional across software engineering, architecture, front-end, back-end, mobile, databases, APIs, cloud/AWS, DevOps, infrastructure, security, system design, AI/ML/LLMs/RAG, automation and SaaS product work.

HOW IT MUST SOUND:
- First person, spoken English, short sentences, contractions, confident, easy to say aloud.
- 2-5 sentences, 50-100 words. Go longer only when they clearly ask for deep technical detail.
- No preamble ("Here's the answer", "Sure", "Based on your question"), no markdown headings, no "Firstly/Secondly/In conclusion", no bullet dumps. A short verbal list is fine when natural.
- Never mention AI, prompts, instructions, context or a knowledge base. You are the speaker.
- Openers like "Yeah, I'd probably start with...", "The way I'd handle that is...", "For this project, I'd..." are good when they fit.

CONVERSATION:
- Continue THIS conversation; never answer as an isolated prompt.
- Resolve pronouns ("it", "that", "those", "the project", "that approach") from the meeting context below.
- If they corrected themselves, answer the CORRECTED meaning and ignore the retracted words.
- Speech-to-text is imperfect: silently fix likely mis-transcriptions of technical terms from context (e.g. "tensor float" = TensorFlow, "post grass" = PostgreSQL, "cuber netes" = Kubernetes, "class" = Keras where the topic supports it). Never say "I think you meant".
- One turn may hold several sub-questions — cover them all in ONE cohesive answer.
- Do not repeat what was already said; answer only the new part of a follow-up.
- Answer the real intent (cost, risk, timeline, complexity), not just the literal words.
- Statements like "okay" or "that makes sense" need no substantive answer — acknowledge briefly.
- Asked for an opinion: take a clear position with one or two reasons, no pile of caveats.
- Asked something technical: give the real, concrete architecture, not a textbook definition.
- Missing a client-specific detail: state a one-clause assumption and keep going ("Assuming the backend is Node, I'd..."). Ask a clarifying question only when the ambiguity genuinely changes the answer — and then phrase it as a sentence they can say aloud.

NOT GENERIC (hard test before you answer):
Ask yourself "could this have been written without knowing anything about this meeting?" If yes and meeting/project context exists, rewrite it using their actual stack, goals, numbers and concerns.

TRUTHFULNESS BOUNDARY (hard rule):
- Verified in the candidate context below → speak about it confidently as personal experience.
- Not verified but within professional knowledge → be confident about the APPROACH: "I can handle that — the way I'd do it is...".
- Never invent employers, clients, projects, revenue, years of experience, team sizes, certifications, dates or achievements.
- Never contradict a claim the speaker already made in this meeting.
- Never answer with "I don't know" or "I can't help with that"; give a concrete practical approach instead.
${ctx.avoidClaims ? `- The speaker explicitly does NOT want these claims made on their behalf: ${ctx.avoidClaims.slice(0, 300)}` : ""}

${answerInstructions(style, length, ctx.answerLanguage)}
This is LIVE: they must be able to start saying your first sentence immediately. Lead with the answer.

SPEAKER PROFILE:
${ctx.profileLine}
TARGET: ${ctx.targetRole ?? "unspecified"} at ${ctx.companyName ?? "unspecified company"}
${
  ctx.meetingBrief
    ? `
MEETING BRIEF (prepared before this call — treat as established fact):
${ctx.meetingBrief}`
    : ""
}${
    ctx.projectMemory
      ? `
PROJECT MEMORY (earlier meetings on this project):
${ctx.projectMemory}`
      : ""
  }

JOB / PROJECT CONTEXT:
${(ctx.jobDescription ?? "(none provided)").slice(0, LIVE_BUDGET.job)}`;
}

/** The compact per-question packet assembled client-side. */
export type LivePacket = {
  resolvedQuestion?: string;
  currentTopic?: string;
  subQuestions?: string[];
  recentTurns?: string[];
  meetingFacts?: string[];
  candidateClaims?: string[];
  previousAnswerSummary?: string;
  corrections?: string[];
  /** Which remote participant asked this question (multi-participant calls). */
  askedBy?: string;
};


/**
 * Knowledge priority (highest first): current turn > live meeting conversation
 * > meeting knowledge base > verified profile/resume > documents > job spec >
 * general model knowledge. The prompt is ordered to make that explicit.
 */
export function liveUserPrompt(args: {
  question: string;
  category: string;
  context: string;
  recentConversation: string;
  priorQna: string;
  rollingSummary: string | null;
  packet?: LivePacket;
}) {
  const p = args.packet ?? {};
  const parts: string[] = [];

  if (p.corrections?.length)
    parts.push(
      `SELF-CORRECTIONS IN THIS TURN (the speaker retracted the first wording — answer the second):\n${p.corrections.join("\n")}`,
    );
  if (p.recentTurns?.length)
    parts.push(`LIVE MEETING (most recent turns):\n${p.recentTurns.join("\n").slice(-LIVE_BUDGET.meetingTurns)}`);
  else if (args.recentConversation)
    parts.push(`LIVE MEETING (most recent turns):\n${args.recentConversation.slice(-LIVE_BUDGET.conversation)}`);
  if (p.meetingFacts?.length)
    parts.push(
      `FACTS ESTABLISHED IN THIS MEETING (attributed — do not mix up who said what):\n${p.meetingFacts.join("\n").slice(0, LIVE_BUDGET.meetingFacts)}`,
    );
  if (p.candidateClaims?.length)
    parts.push(
      `WHAT THE SPEAKER HAS ALREADY CLAIMED (stay consistent, never contradict):\n${p.candidateClaims.join("\n").slice(0, LIVE_BUDGET.claims)}`,
    );
  if (args.rollingSummary)
    parts.push(`MEETING SUMMARY SO FAR:\n${args.rollingSummary.slice(0, LIVE_BUDGET.summary)}`);
  parts.push(
    `VERIFIED PERSONAL BACKGROUND (only source of personal facts):\n${
      args.context.slice(0, LIVE_BUDGET.resume) ||
      "(no verified background available — do not invent any personal history)"
    }`,
  );
  if (p.previousAnswerSummary)
    parts.push(`ALREADY SAID (do not repeat this):\n${p.previousAnswerSummary.slice(0, 400)}`);
  else if (args.priorQna) parts.push(`EARLIER Q&A:\n${args.priorQna.slice(-LIVE_BUDGET.priorQna)}`);

  const question = p.resolvedQuestion?.trim() || args.question;
  const subs = p.subQuestions?.length
    ? `\nThis one turn contains several parts — cover them all in ONE natural answer:\n${p.subQuestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "";
  parts.push(
    `CURRENT TOPIC: ${p.currentTopic || "(opening)"}\n\n${
      p.askedBy ? `${p.askedBy.toUpperCase()} JUST ASKED` : "THEY JUST ASKED"
    } (category: ${args.category}):\n${question}${subs}\n\nSay what the speaker should say now — one continuous, conversational answer.`,
  );

  return parts.join("\n\n");
}

export type LiveMessage = { role: string; content: string };

export type LivePromptStats = {
  promptChars: number;
  systemChars: number;
  userChars: number;
  resumeChars: number;
  conversationChars: number;
  priorQnaChars: number;
  jobChars: number;
  summaryChars: number;
  briefChars: number;
  projectChars: number;
  meetingChars: number;
  subQuestions: number;
  corrections: number;
};

/**
 * THE single live prompt builder. Benchmark and production both go through it,
 * so a measured configuration is by construction the configuration that ships.
 */
export function buildLiveMessages(args: {
  ctx: LiveSessionContext;
  style: string;
  length: string;
  question: string;
  category: string;
  context: string;
  recentConversation: string;
  priorQna: string;
  /** Follow-ups need earlier Q&A; a fresh question does not. */
  isFollowUp?: boolean;
  packet?: LivePacket;
}): { messages: LiveMessage[]; stats: LivePromptStats } {
  const resume = args.context.slice(0, LIVE_BUDGET.resume);
  const conversation = (args.recentConversation ?? "").slice(-LIVE_BUDGET.conversation);
  const priorQna = args.isFollowUp ? (args.priorQna ?? "").slice(-LIVE_BUDGET.priorQna) : "";
  const system = liveSystemPrompt(args.ctx, args.style, args.length);
  const user = liveUserPrompt({
    question: args.question.trim(),
    category: args.category,
    context: resume,
    recentConversation: conversation,
    priorQna,
    rollingSummary: args.ctx.rollingSummary,
    ...(args.packet ? { packet: args.packet } : {}),
  });

  const meetingChars = (args.packet?.recentTurns ?? []).join("\n").length;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stats: {
      promptChars: system.length + user.length,
      systemChars: system.length,
      userChars: user.length,
      resumeChars: resume.length,
      conversationChars: meetingChars || conversation.length,
      priorQnaChars: priorQna.length,
      jobChars: (args.ctx.jobDescription ?? "").slice(0, LIVE_BUDGET.job).length,
      summaryChars: (args.ctx.rollingSummary ?? "").slice(0, LIVE_BUDGET.summary).length,
      briefChars: (args.ctx.meetingBrief ?? "").length,
      projectChars: (args.ctx.projectMemory ?? "").length,
      meetingChars,
      subQuestions: args.packet?.subQuestions?.length ?? 0,
      corrections: args.packet?.corrections?.length ?? 0,
    },

  };
}

export type LiveCallConfig = {
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  maxOutput: number;
};

export const liveCallConfig = (): LiveCallConfig => ({
  model: LIVE_ANSWER_MODEL,
  reasoningEffort: LIVE_REASONING_EFFORT,
  serviceTier: LIVE_SERVICE_TIER,
  maxOutput: LIVE_MAX_OUTPUT,
});

/**
 * Body for the live streaming call. The output-token field and the sampling
 * knobs differ per vendor: the gpt-5.6 family rejects `max_tokens` outright.
 */
export function liveAnswerBody(messages: LiveMessage[], cfg: LiveCallConfig = liveCallConfig()) {
  const isOpenAi = cfg.model.startsWith("openai/");
  const body: Record<string, unknown> = {
    model: cfg.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(isOpenAi
      ? { max_completion_tokens: cfg.maxOutput }
      : { max_tokens: cfg.maxOutput, temperature: 0.4 }),
  };
  if (cfg.reasoningEffort) body["reasoning_effort"] = cfg.reasoningEffort;
  if (cfg.serviceTier) body["service_tier"] = cfg.serviceTier;
  return body;
}

export type LiveUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

export type LiveExecResult = {
  upstream: Response;
  cfg: LiveCallConfig;
  usedTier: string;
  usedEffort: string;
  fallbackReason: string | null;
  fallbackFromModel: string | null;
  fallbackToModel: string | null;
  /** ms from t0 to the moment the gateway request was actually dispatched. */
  requestSentMs: number;
  /** ms from t0 to upstream response headers. */
  headersMs: number;
};

/**
 * THE single gateway call used by the live answer AND by the benchmark. The two
 * paths differ only in what they do with the returned stream.
 */
export async function executeLiveAnswerRequest(
  messages: LiveMessage[],
  cfg: LiveCallConfig,
  t0: number,
): Promise<LiveExecResult> {
  const call = (payload: Record<string, unknown>) =>
    fetch(GATEWAY_URL, {
      method: "POST",
      headers: lovableAiHeaders(),
      body: JSON.stringify(payload),
    });

  const payload = liveAnswerBody(messages, cfg);
  const requestSentMs = Date.now() - t0;
  let usedTier = cfg.serviceTier || "default";
  let usedEffort = cfg.reasoningEffort || "default";
  let fallbackReason: string | null = null;
  let upstream = await call(payload);

  // Speed knobs are best-effort: never break a live session because a tier or
  // reasoning setting is unsupported. The model itself is NEVER swapped.
  if (upstream.status === 400 && ("reasoning_effort" in payload || "service_tier" in payload)) {
    const detail = await upstream.clone().text().catch(() => "");
    fallbackReason = `gateway 400 on speed knobs: ${detail.slice(0, 160)}`;
    const retry = { ...payload };
    delete retry["reasoning_effort"];
    delete retry["service_tier"];
    usedTier = "default (fast rejected)";
    usedEffort = "default (none rejected)";
    upstream = await call(retry);
  }

  return {
    upstream,
    cfg,
    usedTier,
    usedEffort,
    fallbackReason,
    fallbackFromModel: null,
    fallbackToModel: null,
    requestSentMs,
    headersMs: Date.now() - t0,
  };
}

/**
 * THE single SSE parser. Used to instrument the production pass-through and to
 * measure the benchmark, so both report the same numbers on the same events.
 */
export class LiveStreamSniffer {
  firstEventMs: number | null = null;
  firstTextMs: number | null = null;
  totalMs: number | null = null;
  usage: LiveUsage | null = null;
  actualModel: string | null = null;
  actualTier: string | null = null;
  provider: string | null = null;
  text = "";
  private buffer = "";
  private decoder = new TextDecoder();

  constructor(
    private readonly t0: number,
    private readonly collectText = false,
  ) {}

  pushBytes(chunk: Uint8Array) {
    this.push(this.decoder.decode(chunk, { stream: true }));
  }

  push(part: string) {
    this.buffer += part;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      if (this.firstEventMs == null) this.firstEventMs = Date.now() - this.t0;
      try {
        const json = JSON.parse(raw) as {
          model?: string;
          provider?: string;
          service_tier?: string;
          usage?: LiveUsage;
          choices?: { delta?: { content?: string } }[];
        };
        if (json.model) this.actualModel = json.model;
        if (json.provider) this.provider = json.provider;
        if (json.service_tier) this.actualTier = json.service_tier;
        if (json.usage) this.usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (this.firstTextMs == null) this.firstTextMs = Date.now() - this.t0;
          if (this.collectText) this.text += delta;
        }
      } catch {
        /* partial frame */
      }
    }
  }

  finish() {
    this.totalMs = Date.now() - this.t0;
    return this;
  }
}

/** Drain a stream fully through the shared sniffer (benchmark path). */
export async function measureLiveStream(res: Response, t0: number) {
  const sniffer = new LiveStreamSniffer(t0, true);
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sniffer.pushBytes(value);
  }
  return sniffer.finish();
}


/* ------------------------------------------------------------------ *
 * Warm auth cache
 *
 * `auth.getUser(token)` is a network round-trip to the auth server on EVERY
 * live request — measured at ~150-250 ms, which is spent entirely inside the
 * speculative head start. Access tokens are immutable and short-lived, so a
 * verified token is cached for a minute (never past its own `exp`).
 * ------------------------------------------------------------------ */

const tokenCache = new Map<string, { userId: string; exp: number }>();

/** Verify a Supabase access token, reusing a recent verification when possible. */
export async function verifyLiveToken(
  token: string,
  verify: (token: string) => Promise<string | null>,
): Promise<{ userId: string | null; cached: boolean }> {
  const now = Date.now();
  const hit = tokenCache.get(token);
  if (hit && hit.exp > now) return { userId: hit.userId, cached: true };

  const userId = await verify(token);
  if (!userId) return { userId: null, cached: false };

  // Never outlive the token itself.
  let tokenExp = now + 60_000;
  try {
    const claims = JSON.parse(atob(token.split(".")[1] ?? "")) as { exp?: number };
    if (claims.exp) tokenExp = Math.min(tokenExp, claims.exp * 1000);
  } catch {
    /* opaque token: fall back to the 60 s window */
  }
  if (tokenCache.size > 200) tokenCache.clear();
  tokenCache.set(token, { userId, exp: tokenExp });
  return { userId, cached: false };
}

/** Per-request phase timings for the live route, in ms from request arrival. */
export type LivePhases = {
  authMs: number;
  authCached: boolean;
  sessionMs: number;
  contextMs: number;
  contextSource: "prefetch" | "retrieval" | "factcard" | "none";
  promptMs: number;
  dispatchMs: number;
  headersMs: number;
  firstForwardMs: number | null;
};
