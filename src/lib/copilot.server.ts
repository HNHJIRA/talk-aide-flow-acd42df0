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

export function answerInstructions(style: string, length: string, language: string) {
  return [
    STYLE_RULES[style] ?? STYLE_RULES["natural"],
    LENGTH_RULES[length] ?? LENGTH_RULES["short"],
    `Write the answer in this language code: ${language}.`,
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

  const [{ data: session }, { data: profile }] = await Promise.all([
    db
      .from("interview_sessions")
      .select(
        "id, user_id, target_role, company_name, job_description, resume_document_id, answer_style, answer_length, answer_language, rolling_summary",
      )
      .eq("id", sessionId)
      .maybeSingle(),
    db
      .from("profiles")
      .select("full_name, current_position, target_role, experience_level")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (!session || session.user_id !== userId) return null;

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
  };
  cacheSet(sessionCtxCache, key, ctx);
  return ctx;
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
 */
export function liveSystemPrompt(ctx: LiveSessionContext, style: string, length: string) {
  return `${NO_FABRICATION_RULES}

${answerInstructions(style, length, ctx.answerLanguage)}
This is a LIVE interview: the candidate must be able to start speaking your first sentence immediately. Lead with the answer, no preamble.
Keep the initial suggestion to 40-80 words, or 3-4 short speaking bullets. The candidate can ask for more detail afterwards.

CANDIDATE PROFILE:
${ctx.profileLine}
TARGET: ${ctx.targetRole ?? "unspecified"} at ${ctx.companyName ?? "unspecified company"}

JOB CONTEXT:
${(ctx.jobDescription ?? "(none provided)").slice(0, LIVE_BUDGET.job)}`;
}

export function liveUserPrompt(args: {
  question: string;
  category: string;
  context: string;
  recentConversation: string;
  priorQna: string;
  rollingSummary: string | null;
}) {
  const parts = [
    `VERIFIED RESUME EXCERPTS (only source of personal facts):\n${
      args.context.slice(0, LIVE_BUDGET.resume) ||
      "(no resume content available — do not invent any personal history)"
    }`,
  ];
  if (args.rollingSummary)
    parts.push(`SESSION SUMMARY:\n${args.rollingSummary.slice(0, LIVE_BUDGET.summary)}`);
  if (args.recentConversation)
    parts.push(`RECENT CONVERSATION:\n${args.recentConversation.slice(-LIVE_BUDGET.conversation)}`);
  if (args.priorQna) parts.push(`EARLIER Q&A:\n${args.priorQna.slice(-LIVE_BUDGET.priorQna)}`);
  parts.push(
    `INTERVIEW QUESTION (category: ${args.category}):\n${args.question}\n\nWrite what the candidate should say now.`,
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
  });

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
      conversationChars: conversation.length,
      priorQnaChars: priorQna.length,
      jobChars: (args.ctx.jobDescription ?? "").slice(0, LIVE_BUDGET.job).length,
      summaryChars: (args.ctx.rollingSummary ?? "").slice(0, LIVE_BUDGET.summary).length,
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
