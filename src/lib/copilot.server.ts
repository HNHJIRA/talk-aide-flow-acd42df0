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
