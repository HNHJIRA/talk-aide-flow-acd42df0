/** Server-only helpers for the copilot: Deepgram key minting, context retrieval, prompts. */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export function serviceClient() {
  return createClient<Database>(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function mintDeepgramKey(): Promise<{ key: string; expiresAt: string }> {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "Live transcription is not configured yet. Add a Deepgram API key to enable real-time transcription.",
    );
  }
  const headers = { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" };
  const projectsRes = await fetch("https://api.deepgram.com/v1/projects", { headers });
  if (!projectsRes.ok) throw new Error(`Deepgram rejected the request (${projectsRes.status}).`);
  const projects = (await projectsRes.json()) as { projects?: { project_id: string }[] };
  const projectId = projects.projects?.[0]?.project_id;
  if (!projectId) throw new Error("No Deepgram project is available for this API key.");

  const expiresAt = new Date(Date.now() * 1 + 5 * 60 * 1000).toISOString();
  const keyRes = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      comment: "InterviewCopilot session key",
      scopes: ["usage:write"],
      time_to_live_in_seconds: 300,
    }),
  });
  if (!keyRes.ok) throw new Error(`Could not create a temporary transcription key (${keyRes.status}).`);
  const created = (await keyRes.json()) as { key: string };
  return { key: created.key, expiresAt };
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
