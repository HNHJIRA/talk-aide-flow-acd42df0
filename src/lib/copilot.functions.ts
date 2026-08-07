import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const QUESTION_CATEGORIES = [
  "intro",
  "resume",
  "behavioral",
  "situational",
  "technical",
  "coding",
  "system_design",
  "leadership",
  "management",
  "product",
  "sales",
  "culture",
  "salary",
  "availability",
  "follow_up",
  "clarification",
  "general",
] as const;

export const createSttSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { mintDeepgramKey } = await import("@/lib/copilot.server");
    return mintDeepgramKey();
  });

export const sttConfigured = createServerFn({ method: "GET" }).handler(async () => ({
  configured: Boolean(process.env["DEEPGRAM_API_KEY"]),
}));

const DetectInput = z.object({
  text: z.string().min(1).max(2000),
  recentContext: z.string().max(4000).default(""),
});

export const detectQuestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => DetectInput.parse(input))
  .handler(async ({ data }) => {
    const { GATEWAY_URL, FAST_MODEL, lovableAiHeaders } = await import("@/lib/copilot.server");
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: lovableAiHeaders(),
      body: JSON.stringify({
        model: FAST_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You classify interviewer speech during a live job interview.
Return ONLY JSON: {"is_question": boolean, "question": string, "category": string, "confidence": number, "requires_answer": boolean}.
is_question is true only when the interviewer is asking the candidate something that deserves a spoken answer, including imperatives like "Tell me about yourself" or "Walk me through your last project".
It is false for acknowledgements ("okay", "right", "interesting", "that makes sense") and for statements of fact.
If the utterance is a short follow-up ("What was the hardest part?"), rewrite question so it is self-contained using the recent context, and set category to follow_up.
category must be one of: ${QUESTION_CATEGORIES.join(", ")}.
confidence is 0-1.`,
          },
          {
            role: "user",
            content: `Recent conversation:\n${data.recentContext || "(none)"}\n\nInterviewer just said:\n"${data.text}"`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Question detection failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = payload.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      is_question?: boolean;
      question?: string;
      category?: string;
      confidence?: number;
      requires_answer?: boolean;
    };
    return {
      isQuestion: Boolean(parsed.is_question),
      question: (parsed.question ?? data.text).trim(),
      category: (QUESTION_CATEGORIES as readonly string[]).includes(parsed.category ?? "")
        ? parsed.category!
        : "general",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      requiresAnswer: parsed.requires_answer !== false,
    };
  });

const NotesInput = z.object({ sessionId: z.string().uuid() });

export const generateSessionNotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => NotesInput.parse(input))
  .handler(async ({ data, context }) => {
    const { GATEWAY_URL, ANSWER_MODEL, lovableAiHeaders } = await import("@/lib/copilot.server");
    const { supabase, userId } = context;

    const { data: session } = await supabase
      .from("interview_sessions")
      .select("id, target_role, company_name, session_type")
      .eq("id", data.sessionId)
      .maybeSingle();
    if (!session) throw new Error("Session not found.");

    const [{ data: segments }, { data: questions }] = await Promise.all([
      supabase
        .from("transcript_segments")
        .select("speaker, text")
        .eq("session_id", data.sessionId)
        .eq("is_final", true)
        .order("sequence_number", { ascending: true })
        .limit(600),
      supabase
        .from("detected_questions")
        .select("question_text, category")
        .eq("session_id", data.sessionId)
        .order("created_at", { ascending: true }),
    ]);

    const transcript = (segments ?? [])
      .map((s) => `${s.speaker === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${s.text}`)
      .join("\n")
      .slice(-16000);

    if (!transcript.trim()) {
      return { skipped: true as const };
    }

    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: lovableAiHeaders(),
      body: JSON.stringify({
        model: ANSWER_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Summarize a job interview transcript for the candidate. Base everything strictly on the transcript; invent nothing.
Return ONLY JSON with string fields: summary, questions_summary, key_topics, strengths, improvement_areas, follow_up_topics, action_items. Use short markdown bullet lists inside each string where it helps.`,
          },
          {
            role: "user",
            content: `Role: ${session.target_role ?? "unspecified"} at ${session.company_name ?? "unspecified company"} (${session.session_type}).
Questions asked: ${(questions ?? []).map((q) => `${q.question_text} [${q.category}]`).join(" | ") || "none detected"}

Transcript:
${transcript}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Notes generation failed (${res.status}).`);
    const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const notes = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as Record<string, string>;

    await supabase.from("session_notes").insert({
      user_id: userId,
      session_id: data.sessionId,
      summary: notes["summary"] ?? null,
      questions_summary: notes["questions_summary"] ?? null,
      key_topics: notes["key_topics"] ?? null,
      strengths: notes["strengths"] ?? null,
      improvement_areas: notes["improvement_areas"] ?? null,
      follow_up_topics: notes["follow_up_topics"] ?? null,
      action_items: notes["action_items"] ?? null,
    });

    return { skipped: false as const };
  });
