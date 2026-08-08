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
  isFollowUp?: boolean;
  /** Development-only: benchmark the exact production path on this prompt. */
  benchmark?: boolean;
  benchmarkModels?: string[];
  benchmarkRuns?: number;
  /** Benchmark only: skip resume grounding to isolate prompt-size cost. */
  benchmarkNoContext?: boolean;
};

/**
 * Low-latency LIVE answer stream.
 *
 * Benchmark mode and production mode build the prompt with `buildLiveMessages`
 * and issue the gateway call with `executeLiveAnswerRequest` — one code path,
 * differing only in whether the stream is drained here or passed to the browser.
 */
export const Route = createFileRoute("/api/live-answer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const t0 = Date.now();
        const {
          getLiveSessionContext,
          retrieveLiveContext,
          getLiveFactCard,
          readPrefetchedContext,
          buildLiveMessages,
          executeLiveAnswerRequest,
          measureLiveStream,
          LiveStreamSniffer,
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
        let contextText = body.benchmarkNoContext
          ? ""
          : (prefetched ??
            (await retrieveLiveContext(db, userId, ctx.resumeDocumentId, body.questionText, 3)));
        // Retrieval found nothing relevant: fall back to the compact fact card
        // rather than dumping raw chunks into the critical path.
        if (!contextText && !body.benchmarkNoContext) {
          contextText = (await getLiveFactCard(db, userId, ctx)).slice(0, 1200);
        }

        const { messages, stats } = buildLiveMessages({
          ctx,
          style: body.answerStyle ?? ctx.answerStyle,
          length: body.answerLength ?? ctx.answerLength,
          question: body.questionText,
          category: body.category ?? "general",
          context: contextText,
          recentConversation: body.recentConversation ?? "",
          priorQna: body.priorQna ?? "",
          isFollowUp: body.isFollowUp ?? false,
        });

        const cfg = liveCallConfig();

        /* ------- development-only benchmark: identical prompt + call path ------- */
        if (body.benchmark && import.meta.env.DEV) {
          const models = body.benchmarkModels?.length ? body.benchmarkModels : LIVE_BENCHMARK_MODELS;
          const runs = Math.min(Math.max(body.benchmarkRuns ?? 3, 1), 10);
          const pct = (values: number[], p: number) => {
            const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
            if (!sorted.length) return null;
            return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
          };
          const results: unknown[] = [];
          for (const model of models) {
            const ttfts: number[] = [];
            const totals: number[] = [];
            let error: string | null = null;
            let last: Awaited<ReturnType<typeof measureLiveStream>> | null = null;
            for (let i = 0; i < runs; i++) {
              const start = Date.now();
              const exec = await executeLiveAnswerRequest(messages, { ...cfg, model }, start);
              if (!exec.upstream.ok || !exec.upstream.body) {
                error = `${exec.upstream.status} ${(await exec.upstream.text().catch(() => "")).slice(0, 200)}`;
                break;
              }
              const s = await measureLiveStream(exec.upstream, start);
              if (s.firstTextMs != null) ttfts.push(s.firstTextMs);
              if (s.totalMs != null) totals.push(s.totalMs);
              last = s;
            }
            results.push({
              model,
              error,
              runs: ttfts.length,
              ttftP50: pct(ttfts, 50),
              ttftP75: pct(ttfts, 75),
              ttftP95: pct(ttfts, 95),
              ttftMin: ttfts.length ? Math.min(...ttfts) : null,
              ttftMax: ttfts.length ? Math.max(...ttfts) : null,
              totalP50: pct(totals, 50),
              firstEventMs: last?.firstEventMs ?? null,
              actualModel: last?.actualModel ?? null,
              provider: last?.provider ?? null,
              actualTier: last?.actualTier ?? null,
              usage: last?.usage ?? null,
              sample: last?.text.slice(0, 300) ?? null,
            });
          }
          return Response.json({
            latencyMode: LIVE_LATENCY_MODE,
            live: cfg,
            promptStats: stats,
            grounded: !body.benchmarkNoContext,
            results,
          });
        }

        const exec = await executeLiveAnswerRequest(messages, cfg, t0);
        const upstream = exec.upstream;

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          const status = upstream.status === 429 || upstream.status === 402 ? upstream.status : 500;
          return new Response(detail.slice(0, 400) || "AI request failed", { status });
        }

        // Byte-for-byte pass-through: every upstream chunk is enqueued the moment
        // it arrives (no buffering, no re-encoding, no DB work), while the shared
        // sniffer records timings/usage and one trailing meta frame is appended.
        const encoder = new TextEncoder();
        const sniffer = new LiveStreamSniffer(t0, false);

        const instrumented = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            sniffer.pushBytes(chunk);
          },
          flush(controller) {
            const meta = {
              ic_meta: {
                requestedModel: cfg.model,
                actualModel: sniffer.actualModel,
                provider: sniffer.provider,
                requestedEffort: cfg.reasoningEffort || "default",
                actualEffort: exec.usedEffort,
                requestedTier: cfg.serviceTier || "default",
                actualTier: sniffer.actualTier ?? exec.usedTier,
                fallbackReason: exec.fallbackReason,
                latencyMode: LIVE_LATENCY_MODE,
                maxOutputTokens: cfg.maxOutput,
                inputTokens: sniffer.usage?.prompt_tokens ?? null,
                cachedInputTokens: sniffer.usage?.prompt_tokens_details?.cached_tokens ?? null,
                outputTokens: sniffer.usage?.completion_tokens ?? null,
                promptChars: stats.promptChars,
                resumeChars: stats.resumeChars,
                conversationChars: stats.conversationChars,
                priorQnaChars: stats.priorQnaChars,
                jobChars: stats.jobChars,
                serverRequestSentMs: exec.requestSentMs,
                upstreamHeadersMs: exec.headersMs,
                upstreamFirstEventMs: sniffer.firstEventMs,
                upstreamFirstDeltaMs: sniffer.firstTextMs,
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
            "X-IC-Prompt-Chars": String(stats.promptChars),
            "X-IC-Server-Ms": String(exec.headersMs),
            "Access-Control-Expose-Headers":
              "X-IC-Context, X-IC-Model, X-IC-Tier, X-IC-Effort, X-IC-Prompt-Chars, X-IC-Server-Ms",
          },
        });
      },
    },
  },
});
