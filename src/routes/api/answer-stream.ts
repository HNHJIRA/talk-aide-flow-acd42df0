import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Body = {
  sessionId: string;
  questionId: string;
  answerStyle?: string;
  answerLength?: string;
};

export const Route = createFileRoute("/api/answer-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          GATEWAY_URL,
          ANSWER_MODEL,
          lovableAiHeaders,
          NO_FABRICATION_RULES,
          answerInstructions,
          retrieveContext,
          serviceClient,
        } = await import("@/lib/copilot.server");

        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return new Response("Unauthorized", { status: 401 });

        const url = process.env["SUPABASE_URL"]!;
        const publishable = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const authClient = createClient<Database>(url, publishable, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => {
              const h = new Headers(init?.headers);
              if (publishable.startsWith("sb_") && h.get("Authorization") === `Bearer ${publishable}`) {
                h.delete("Authorization");
              }
              h.set("apikey", publishable);
              return fetch(input, { ...init, headers: h });
            },
          },
        });
        const { data: userData, error: userError } = await authClient.auth.getUser(token);
        if (userError || !userData.user) return new Response("Unauthorized", { status: 401 });
        const userId = userData.user.id;

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return new Response("Invalid body", { status: 400 });
        }

        const db = serviceClient();

        const { data: session } = await db
          .from("interview_sessions")
          .select(
            "id, user_id, target_role, company_name, job_description, resume_document_id, answer_style, answer_length, answer_language, session_type, rolling_summary",
          )
          .eq("id", body.sessionId)
          .maybeSingle();
        if (!session || session.user_id !== userId) return new Response("Not found", { status: 404 });

        const { data: question } = await db
          .from("detected_questions")
          .select("id, user_id, question_text, category, session_id")
          .eq("id", body.questionId)
          .maybeSingle();
        if (!question || question.user_id !== userId || question.session_id !== session.id) {
          return new Response("Not found", { status: 404 });
        }

        const [{ data: profile }, resumeContext, { data: recentSegments }, { data: priorQna }] =
          await Promise.all([
            db
              .from("profiles")
              .select("full_name, current_position, target_role, experience_level")
              .eq("user_id", userId)
              .maybeSingle(),
            retrieveContext(db, userId, session.resume_document_id, question.question_text),
            db
              .from("transcript_segments")
              .select("speaker, text")
              .eq("session_id", session.id)
              .eq("is_final", true)
              .order("sequence_number", { ascending: false })
              .limit(14),
            db
              .from("detected_questions")
              .select("question_text, generated_answers(answer_text)")
              .eq("session_id", session.id)
              .neq("id", question.id)
              .order("created_at", { ascending: false })
              .limit(3),
          ]);

        const style = body.answerStyle ?? session.answer_style;
        const length = body.answerLength ?? session.answer_length;

        const recent = (recentSegments ?? [])
          .slice()
          .reverse()
          .map((s) => `${s.speaker === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${s.text}`)
          .join("\n");

        const history = (priorQna ?? [])
          .map((q) => {
            const answers = q.generated_answers as unknown as { answer_text: string }[] | null;
            return `Q: ${q.question_text}\nSuggested: ${(answers?.[0]?.answer_text ?? "").slice(0, 300)}`;
          })
          .join("\n\n");

        const userPrompt = `INTERVIEW QUESTION (category: ${question.category}):
${question.question_text}

CANDIDATE PROFILE:
Name: ${profile?.full_name ?? "unknown"} | Current: ${profile?.current_position ?? "unknown"} | Target: ${session.target_role ?? profile?.target_role ?? "unknown"} | Level: ${profile?.experience_level ?? "unknown"}

VERIFIED RESUME / DOCUMENT EXCERPTS (only source of personal facts):
${resumeContext || "(no resume content available — do not invent any personal history)"}

JOB DESCRIPTION:
${(session.job_description ?? "(none provided)").slice(0, 2500)}

SESSION SUMMARY SO FAR:
${session.rolling_summary ?? "(none)"}

RECENT CONVERSATION:
${recent || "(none)"}

EARLIER QUESTIONS AND SUGGESTIONS:
${history || "(none)"}

Write the answer the candidate should say now. ${answerInstructions(style, length, session.answer_language)}`;

        const upstream = await fetch(GATEWAY_URL, {
          method: "POST",
          headers: lovableAiHeaders(),
          body: JSON.stringify({
            model: ANSWER_MODEL,
            stream: true,
            messages: [
              { role: "system", content: NO_FABRICATION_RULES },
              { role: "user", content: userPrompt },
            ],
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          const status = upstream.status === 429 || upstream.status === 402 ? upstream.status : 500;
          return new Response(detail.slice(0, 400) || "AI request failed", { status });
        }

        return new Response(upstream.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
