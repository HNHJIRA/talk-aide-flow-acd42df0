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
  /** Development-only: benchmark several models on this exact prompt. */
  benchmark?: boolean;
  benchmarkModels?: string[];
  benchmarkRuns?: number;
};

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

/** Reads one SSE stream, returning TTFT, total duration, usage and text. */
async function measureStream(res: Response, t0: number) {
  const out = {
    ttftMs: null as number | null,
    totalMs: null as number | null,
    text: "",
    usage: null as Usage | null,
    actualModel: null as string | null,
    actualTier: null as string | null,
  };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          model?: string;
          service_tier?: string;
          usage?: Usage;
          choices?: { delta?: { content?: string } }[];
        };
        if (json.model) out.actualModel = json.model;
        if (json.service_tier) out.actualTier = json.service_tier;
        if (json.usage) out.usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (out.ttftMs == null) out.ttftMs = Date.now() - t0;
          out.text += delta;
        }
      } catch {
        /* partial frame */
      }
    }
  }
  out.totalMs = Date.now() - t0;
  return out;
}

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
          liveCallConfig,
          LIVE_LATENCY_MODE,
          LIVE_BENCHMARK_MODELS,
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

        // Stable prefix first (identical bytes across the session, cache friendly),
        // then only the small changing context.
        const messages = [
          { role: "system", content: liveSystemPrompt(ctx, style, length) },
          {
            role: "user",
            content: liveUserPrompt({
              question: body.questionText.trim(),
              category: body.category ?? "general",
              context: contextText,
              recentConversation: (body.recentConversation ?? "").slice(-1200),
              priorQna: (body.priorQna ?? "").slice(-700),
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

        const cfg = liveCallConfig();

        /* ---------------- development-only model benchmark ---------------- */
        if (body.benchmark && import.meta.env.DEV) {
          const models = body.benchmarkModels?.length
            ? body.benchmarkModels
            : LIVE_BENCHMARK_MODELS;
          const runs = Math.min(Math.max(body.benchmarkRuns ?? 3, 1), 5);
          const results: unknown[] = [];
          for (const model of models) {
            const samples: Awaited<ReturnType<typeof measureStream>>[] = [];
            let error: string | null = null;
            for (let i = 0; i < runs; i++) {
              const start = Date.now();
              const res = await call(liveAnswerBody(messages, { ...cfg, model }));
              if (!res.ok || !res.body) {
                error = `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
                break;
              }
              samples.push(await measureStream(res, start));
            }
            const median = (values: number[]) =>
              values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null;
            results.push({
              model,
              requestedTier: cfg.serviceTier || "default",
              error,
              ttftMedianMs: median(samples.map((s) => s.ttftMs ?? 0)),
              totalMedianMs: median(samples.map((s) => s.totalMs ?? 0)),
              actualTier: samples[0]?.actualTier ?? null,
              usage: samples[0]?.usage ?? null,
              sample: samples[0]?.text.slice(0, 400) ?? null,
            });
          }
          return Response.json({ latencyMode: LIVE_LATENCY_MODE, live: cfg, results });
        }

        const payload = liveAnswerBody(messages, cfg);
        let usedTier = cfg.serviceTier || "default";
        let usedEffort = cfg.reasoningEffort || "default";
        let upstream = await call(payload);

        // Speed knobs are best-effort: never break a live session because a tier
        // or reasoning setting is unsupported for the configured model.
        if (upstream.status === 400 && ("reasoning_effort" in payload || "service_tier" in payload)) {
          const fallback = { ...payload };
          delete fallback["reasoning_effort"];
          delete fallback["service_tier"];
          usedTier = "default (fast rejected)";
          usedEffort = "default (none rejected)";
          upstream = await call(fallback);
        }

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          const status = upstream.status === 429 || upstream.status === 402 ? upstream.status : 500;
          return new Response(detail.slice(0, 400) || "AI request failed", { status });
        }

        const upstreamHeadersMs = Date.now() - t0;

        // Byte-for-byte pass-through: every upstream chunk is enqueued the moment
        // it arrives (no buffering, no re-encoding, no DB work), while we sniff
        // timings/usage for diagnostics and append one trailing meta frame.
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let sniff = "";
        let firstDeltaMs: number | null = null;
        let usage: Usage | null = null;
        let actualModel: string | null = null;
        let actualTier: string | null = null;

        const instrumented = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            sniff += decoder.decode(chunk, { stream: true });
            const lines = sniff.split("\n");
            sniff = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              try {
                const json = JSON.parse(raw) as {
                  model?: string;
                  service_tier?: string;
                  usage?: Usage;
                  choices?: { delta?: { content?: string } }[];
                };
                if (json.model) actualModel = json.model;
                if (json.service_tier) actualTier = json.service_tier;
                if (json.usage) usage = json.usage;
                if (json.choices?.[0]?.delta?.content && firstDeltaMs == null) {
                  firstDeltaMs = Date.now() - t0;
                }
              } catch {
                /* partial frame */
              }
            }
          },
          flush(controller) {
            const meta = {
              ic_meta: {
                requestedModel: cfg.model,
                actualModel,
                requestedEffort: cfg.reasoningEffort || "default",
                actualEffort: usedEffort,
                requestedTier: cfg.serviceTier || "default",
                actualTier: actualTier ?? usedTier,
                latencyMode: LIVE_LATENCY_MODE,
                maxOutputTokens: cfg.maxOutput,
                inputTokens: usage?.prompt_tokens ?? null,
                cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
                outputTokens: usage?.completion_tokens ?? null,
                upstreamHeadersMs,
                upstreamFirstDeltaMs: firstDeltaMs,
                upstreamTotalMs: Date.now() - t0,
                contextChars: contextText.length,
                context: prefetched ? "hit" : "miss",
              },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(meta)}\n\n`));
          },
        });

        return new Response(upstream.body.pipeThrough(instrumented), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
            "X-IC-Context": prefetched ? "hit" : "miss",
            "X-IC-Model": cfg.model,
            "X-IC-Tier": cfg.serviceTier || "default",
            "X-IC-Effort": cfg.reasoningEffort || "default",
            "X-IC-Server-Ms": String(upstreamHeadersMs),
            "Access-Control-Expose-Headers":
              "X-IC-Context, X-IC-Model, X-IC-Tier, X-IC-Effort, X-IC-Server-Ms",
          },
        });
      },
    },
  },
});
