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

export const sttDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { deepgramDiagnostics } = await import("@/lib/copilot.server");
    return deepgramDiagnostics();
  });

const PrerecordedDiarizationInput = z.object({
  wavBase64: z.string().min(1).max(3_000_000),
});

export const runPrerecordedDiarization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PrerecordedDiarizationInput.parse(input))
  .handler(async ({ data }) => {
    const { analyzePrerecordedDiarization } = await import("@/lib/copilot.server");
    return analyzePrerecordedDiarization(data.wavBase64);
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
      .select("id, target_role, company_name, session_type, rolling_summary")
      .eq("id", data.sessionId)
      .maybeSingle();
    if (!session) throw new Error("Session not found.");

    const [{ data: segments }, { data: questions }, { data: facts }, { data: claims }] = await Promise.all([
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
      supabase
        .from("meeting_facts")
        .select("label, value, said_by")
        .eq("session_id", data.sessionId)
        .is("superseded_at", null)
        .order("created_at", { ascending: true })
        .limit(60),
      supabase
        .from("candidate_claims")
        .select("claim")
        .eq("session_id", data.sessionId)
        .order("created_at", { ascending: true })
        .limit(40),
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
            content: `Summarize a live meeting/interview for the participant. Base everything strictly on the supplied material; invent nothing.
Return ONLY JSON with string fields: summary, questions_summary, key_topics, strengths, improvement_areas, follow_up_topics, action_items.
- summary: what was discussed, client requirements, project scope, technical requirements, budget/timeline mentions and decisions.
- key_topics: topics + important facts established, attributed to who said them.
- follow_up_topics: open questions, next steps, and things to remember for the next meeting.
- action_items: commitments and promises made, with who owns each.
Use short markdown bullet lists inside each string where it helps.`,
          },
          {
            role: "user",
            content: `Role: ${session.target_role ?? "unspecified"} at ${session.company_name ?? "unspecified company"} (${session.session_type}).
Rolling meeting memory: ${session.rolling_summary ?? "(none)"}
Facts established: ${(facts ?? []).map((f) => `${f.said_by}: ${f.label} = ${f.value}`).join(" | ") || "none"}
Claims made by the participant: ${(claims ?? []).map((c) => c.claim).join(" | ") || "none"}
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

/* ---------- live latency path ---------- */

const PrimeInput = z.object({ sessionId: z.string().uuid() });

/** Called once when the user goes live: warms session + resume caches server-side. */
export const primeLiveContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PrimeInput.parse(input))
  .handler(async ({ data, context }) => {
    const { getLiveSessionContext, retrieveLiveContext, serviceClient } = await import(
      "@/lib/copilot.server"
    );
    const db = serviceClient();
    const ctx = await getLiveSessionContext(db, context.userId, data.sessionId, true);
    if (!ctx) return { primed: false as const, chunks: 0 };
    // Warm the chunk cache with a generic retrieval so the first real question is a hit.
    const warm = await retrieveLiveContext(db, context.userId, ctx.resumeDocumentId, "experience skills summary", 4);
    return { primed: true as const, chunks: warm.length };
  });

const PrefetchInput = z.object({
  sessionId: z.string().uuid(),
  topic: z.string().min(3).max(1000),
  turnId: z.string().min(1).max(64),
});

/**
 * Speculative retrieval from stabilised interim text. Returns a context key the
 * live answer route can redeem, so the critical path skips retrieval entirely.
 */
export const prefetchContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PrefetchInput.parse(input))
  .handler(async ({ data, context }) => {
    const { getLiveSessionContext, retrieveLiveContext, storePrefetchedContext, serviceClient } =
      await import("@/lib/copilot.server");
    const db = serviceClient();
    const ctx = await getLiveSessionContext(db, context.userId, data.sessionId);
    if (!ctx) return { contextKey: null, chars: 0 };
    const retrieved = await retrieveLiveContext(db, context.userId, ctx.resumeDocumentId, data.topic, 4);
    const key = `${context.userId}:${data.sessionId}:${data.turnId}`;
    storePrefetchedContext(key, retrieved);
    return { contextKey: key, chars: retrieved.length };
  });

/* ---------- meeting intelligence (all OFF the live latency path) ---------- */

const PrepFields = {
  meeting_title: z.string().max(200).optional(),
  meeting_type: z.string().max(60).optional(),
  company_name: z.string().max(200).optional(),
  client_website: z.string().max(400).optional(),
  project_name: z.string().max(200).optional(),
  project_description: z.string().max(4000).optional(),
  role_discussed: z.string().max(200).optional(),
  requirements: z.string().max(4000).optional(),
  goals: z.string().max(2000).optional(),
  challenges: z.string().max(2000).optional(),
  tech_stack: z.string().max(1000).optional(),
  budget_notes: z.string().max(1000).optional(),
  timeline: z.string().max(1000).optional(),
  client_concerns: z.string().max(2000).optional(),
  important_facts: z.string().max(3000).optional(),
  emphasize: z.string().max(2000).optional(),
  avoid_claims: z.string().max(2000).optional(),
  previous_communication: z.string().max(4000).optional(),
  custom_notes: z.string().max(4000).optional(),
};

const PrepInput = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  prep: z.object(PrepFields),
});

/** Saves the pre-meeting knowledge base and compiles the stable meeting brief. */
export const saveMeetingPrep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PrepInput.parse(input))
  .handler(async ({ data, context }) => {
    const { compileMeetingBrief, getLiveSessionContext, serviceClient } = await import(
      "@/lib/copilot.server"
    );
    const { supabase, userId } = context;
    const row = {
      user_id: userId,
      session_id: data.sessionId,
      project_id: data.projectId ?? null,
      ...(Object.fromEntries(
        Object.entries(data.prep).map(([k, v]) => [k, (v ?? null) || null]),
      ) as Record<string, string | null>),
      brief: compileMeetingBrief(data.prep as Record<string, string | null>),
    };
    const { error } = await supabase.from("meeting_preparations").upsert(row, {
      onConflict: "session_id",
    });
    if (error) throw new Error(error.message);
    // Refresh the cached live context so Go Live picks the brief up immediately.
    await getLiveSessionContext(serviceClient(), userId, data.sessionId, true);
    return { saved: true as const, brief: row.brief };
  });

export const getMeetingPrep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sessionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: prep } = await context.supabase
      .from("meeting_preparations")
      .select("*")
      .eq("session_id", data.sessionId)
      .maybeSingle();
    return prep;
  });

export const listProjects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("projects")
      .select("id, name, client_name, description")
      .order("updated_at", { ascending: false })
      .limit(50);
    return data ?? [];
  });

export const upsertProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(200),
        clientName: z.string().max(200).optional(),
        websiteUrl: z.string().max(400).optional(),
        description: z.string().max(4000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("projects")
      .upsert({
        ...(data.id ? { id: data.id } : {}),
        user_id: context.userId,
        name: data.name,
        client_name: data.clientName ?? null,
        website_url: data.websiteUrl ?? null,
        description: data.description ?? null,
      })
      .select("id, name")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

const MemoryInput = z.object({
  sessionId: z.string().uuid(),
  /** Recent attributed turns since the last memory update. */
  turns: z.array(z.string().max(1200)).max(40),
  previousSummary: z.string().max(4000).default(""),
});

/**
 * Asynchronous rolling meeting memory. Called every few meaningful turns from
 * the client and never awaited by the answer path: it updates the session's
 * rolling summary and appends newly-established facts / candidate claims.
 */
export const updateMeetingMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => MemoryInput.parse(input))
  .handler(async ({ data, context }) => {
    const { GATEWAY_URL, FAST_MODEL, lovableAiHeaders, getLiveSessionContext, serviceClient } =
      await import("@/lib/copilot.server");
    const { supabase, userId } = context;
    if (!data.turns.length) return { updated: false as const };

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
            content: `You maintain the rolling memory of a live business/interview call.
Return ONLY JSON:
{"summary": string, "topics": string[], "facts": [{"label": string, "value": string, "said_by": "client"|"candidate"}], "claims": [{"topic": string, "claim": string}], "open_questions": string[], "action_items": string[]}
summary: <=120 words, merges the previous summary with the new turns, newest correction always wins.
facts: only concrete things stated on the call (numbers, budgets, tools, deadlines, requirements) — attribute correctly to who said it.
claims: only things the CANDIDATE/ME speaker asserted about their own experience.
Invent nothing.`,
          },
          {
            role: "user",
            content: `Previous summary:\n${data.previousSummary || "(none)"}\n\nNew turns:\n${data.turns.join("\n")}`,
          },
        ],
      }),
    });
    if (!res.ok) return { updated: false as const };
    const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    let parsed: {
      summary?: string;
      topics?: string[];
      facts?: { label?: string; value?: string; said_by?: string }[];
      claims?: { topic?: string; claim?: string }[];
      open_questions?: string[];
      action_items?: string[];
    };
    try {
      parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
    } catch {
      return { updated: false as const };
    }

    const summary = (parsed.summary ?? "").slice(0, 2000);
    const { data: session } = await supabase
      .from("interview_sessions")
      .select("project_id")
      .eq("id", data.sessionId)
      .maybeSingle();
    const projectId = session?.project_id ?? null;

    const writes: PromiseLike<unknown>[] = [];
    if (summary) {
      writes.push(
        supabase.from("interview_sessions").update({ rolling_summary: summary }).eq("id", data.sessionId),
      );
    }
    const facts = (parsed.facts ?? []).filter((f) => f.label && f.value).slice(0, 12);
    if (facts.length) {
      writes.push(
        supabase.from("meeting_facts").insert(
          facts.map((f) => ({
            user_id: userId,
            session_id: data.sessionId,
            project_id: projectId,
            label: f.label!.slice(0, 120),
            value: f.value!.slice(0, 600),
            said_by: f.said_by === "candidate" ? "candidate" : "client",
          })),
        ),
      );
    }
    const claims = (parsed.claims ?? []).filter((c) => c.claim).slice(0, 12);
    if (claims.length) {
      writes.push(
        supabase.from("candidate_claims").insert(
          claims.map((c) => ({
            user_id: userId,
            session_id: data.sessionId,
            project_id: projectId,
            topic: (c.topic ?? "general").slice(0, 120),
            claim: c.claim!.slice(0, 600),
          })),
        ),
      );
    }
    await Promise.all(writes);
    if (summary) await getLiveSessionContext(serviceClient(), userId, data.sessionId, true);

    return {
      updated: true as const,
      summary,
      topics: parsed.topics ?? [],
      openQuestions: parsed.open_questions ?? [],
      actionItems: parsed.action_items ?? [],
      facts: facts.length,
      claims: claims.length,
    };
  });
