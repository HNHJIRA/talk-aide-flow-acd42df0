import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Body = {
  sessionId: string;
  questionText: string;
  category?: string;
  contextKey?: string | null;
  recentConversation?: string;
  priorQna?: string;
  answerStyle?: string;
  answerLength?: string;
};

/**
 * Low-latency LIVE answer stream.
 *
 * Differences from /api/answer-stream (which stays untouched for regeneration
 * and style variants): the question does not have to exist in the database yet,
 * session context and resume chunks come from warm caches, retrieval is top-k,
 * and the model runs with the live speed configuration.
 */
export const Route = createFileRoute("/api/live-answer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const t0 = Date.now();
        const {
          GATEWAY_URL,
          lovableAiHeaders,
          getLiveSessionContext,
          retrieveLiveContext,
          readPrefetchedContext,
          liveSystemPrompt,
          liveUserPrompt,
          liveAnswerBody,
          LIVE_ANSWER_MODEL,
          serviceClient,
        } = await import("@/lib/copilot.server");

        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return new Response("Unauthorized", { status: 401 });

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return new Response("Invalid body", { status: 400 });
        }
        if (!body.sessionId || !body.questionText?.trim()) {
          return new Response("Invalid body", { status: 400 });
        }

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

        const db = serviceClient();
        const ctx = await getLiveSessionContext(db, userId, body.sessionId);
        if (!ctx) return new Response("Not found", { status: 404 });

        const prefetched = readPrefetchedContext(body.contextKey);
        const contextText =
          prefetched ??
          (await retrieveLiveContext(db, userId, ctx.resumeDocumentId, body.questionText, 4));

        const style = body.answerStyle ?? ctx.answerStyle;
        const length = body.answerLength ?? ctx.answerLength;

        const messages = [
          { role: "system", content: liveSystemPrompt(ctx, style, length) },
          {
            role: "user",
            content: liveUserPrompt({
              question: body.questionText.trim(),
              category: body.category ?? "general",
              context: contextText,
              recentConversation: (body.recentConversation ?? "").slice(-2500),
              priorQna: (body.priorQna ?? "").slice(-1500),
              rollingSummary: ctx.rollingSummary,
            }),
          },
        ];

        const call = (payload: Record<string, unknown>) =>
          fetch(GATEWAY_URL, {
            method: "POST",
            headers: lovableAiHeaders(),
            body: JSON.stringify(payload),
          });

        const payload = liveAnswerBody(messages);
        let upstream = await call(payload);

        // Speed knobs are best-effort: never break a live session because a tier
        // or reasoning setting is unsupported for the configured model.
        if (upstream.status === 400 && ("reasoning_effort" in payload || "service_tier" in payload)) {
          const fallback = { ...payload };
          delete fallback["reasoning_effort"];
          delete fallback["service_tier"];
          upstream = await call(fallback);
        }

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
            "X-IC-Context": prefetched ? "hit" : "miss",
            "X-IC-Model": LIVE_ANSWER_MODEL,
            "X-IC-Server-Ms": String(Date.now() - t0),
            "Access-Control-Expose-Headers": "X-IC-Context, X-IC-Model, X-IC-Server-Ms",
          },
        });
      },
    },
  },
});
