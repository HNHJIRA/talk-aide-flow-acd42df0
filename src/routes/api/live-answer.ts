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
  /** Translation layer override: language code the answer must be written in. */
  answerLanguage?: string;
  isFollowUp?: boolean;
  /** Compact conversational context packet (meeting memory, corrections, sub-questions). */
  packet?: {
    resolvedQuestion?: string;
    currentTopic?: string;
    subQuestions?: string[];
    recentTurns?: string[];
    meetingFacts?: string[];
    candidateClaims?: string[];
    previousAnswerSummary?: string;
    corrections?: string[];
  };
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
 * The response headers are flushed BEFORE the gateway call is dispatched: the
 * browser gets a `: ic-open` comment frame within a few ms, which (a) defeats
 * any proxy that would otherwise buffer until the first real chunk and (b)
 * lets the client separate transport cost from provider cost.
 *
 * Benchmark mode and production mode build the prompt with `buildLiveMessages`
 * and issue the gateway call with `executeLiveAnswerRequest` — one code path.
 */
export const Route = createFileRoute("/api/live-answer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const t0 = Date.now();
        const since = () => Date.now() - t0;
        const {
          getLiveSessionContext,
          retrieveLiveContext,
          getLiveFactCard,
          readPrefetchedContext,
          buildLiveMessages,
          executeLiveAnswerRequest,
          measureLiveStream,
          LiveStreamSniffer,
          verifyLiveToken,
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

        /* ---------------- auth (warm-cached) ---------------- */
        const authStart = Date.now();
        const { userId, cached: authCached } = await verifyLiveToken(token, async (jwt) => {
          const url = process.env["SUPABASE_URL"]!;
          const publishable = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
          const authClient = createClient<Database>(url, publishable, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: {
              fetch: (input, init) => {
                const h = new Headers(init?.headers);
                if (
                  publishable.startsWith("sb_") &&
                  h.get("Authorization") === `Bearer ${publishable}`
                ) {
                  h.delete("Authorization");
                }
                h.set("apikey", publishable);
                return fetch(input, { ...init, headers: h });
              },
            },
          });
          const { data, error } = await authClient.auth.getUser(jwt);
          return error || !data.user ? null : data.user.id;
        });
        if (!userId) return new Response("Unauthorized", { status: 401 });
        const authMs = Date.now() - authStart;

        /* ---------------- session context (warm-cached) ---------------- */
        const sessionStart = Date.now();
        const db = serviceClient();
        const ctx = await getLiveSessionContext(db, userId, body.sessionId);
        if (!ctx) return new Response("Not found", { status: 404 });
        const sessionMs = Date.now() - sessionStart;

        /* ---------------- resume context ---------------- */
        const contextStart = Date.now();
        const prefetched = readPrefetchedContext(body.contextKey);
        let contextSource: "prefetch" | "retrieval" | "factcard" | "none" = "none";
        let contextText = "";
        if (body.benchmarkNoContext) {
          contextSource = "none";
        } else if (prefetched) {
          contextText = prefetched;
          contextSource = "prefetch";
        } else {
          contextText = await retrieveLiveContext(
            db,
            userId,
            ctx.resumeDocumentId,
            body.packet?.resolvedQuestion || body.questionText,
            3,
          );
          contextSource = "retrieval";
          if (!contextText) {
            contextText = (await getLiveFactCard(db, userId, ctx)).slice(0, 1200);
            contextSource = "factcard";
          }
        }
        const contextMs = Date.now() - contextStart;

        /* ---------------- prompt ---------------- */
        const promptStart = Date.now();
        const { messages, stats } = buildLiveMessages({
          ctx: body.answerLanguage ? { ...ctx, answerLanguage: body.answerLanguage } : ctx,
          style: body.answerStyle ?? ctx.answerStyle,
          length: body.answerLength ?? ctx.answerLength,
          question: body.questionText,
          category: body.category ?? "general",
          context: contextText,
          recentConversation: body.recentConversation ?? "",
          priorQna: body.priorQna ?? "",
          isFollowUp: body.isFollowUp ?? false,
          ...(body.packet ? { packet: body.packet } : {}),
        });
        const promptMs = Date.now() - promptStart;

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
            phases: { authMs, authCached, sessionMs, contextMs, contextSource, promptMs },
            results,
          });
        }

        /* ---------------- streamed production answer ---------------- */
        const encoder = new TextEncoder();
        const sniffer = new LiveStreamSniffer(t0, false);
        const preludeMs = since();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Flushed before the gateway is even called: proves the transport is
            // unbuffered and starts the browser's clock on real bytes.
            controller.enqueue(
              encoder.encode(
                `: ic-open ${preludeMs}\n\ndata: ${JSON.stringify({
                  ic_open: { preludeMs, authMs, authCached, sessionMs, contextMs, contextSource, promptMs },
                })}\n\n`,
              ),
            );

            // Keepalive comments while the provider thinks: without traffic some
            // proxies hold the connection and the first token arrives in a burst.
            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ka ${since()}\n\n`));
              } catch {
                /* closed */
              }
            }, 100);

            let exec: Awaited<ReturnType<typeof executeLiveAnswerRequest>> | null = null;
            try {
              exec = await executeLiveAnswerRequest(messages, cfg, t0);
              const upstream = exec.upstream;

              if (!upstream.ok || !upstream.body) {
                const detail = await upstream.text().catch(() => "");
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      ic_error: {
                        status: upstream.status,
                        message: detail.slice(0, 300) || "AI request failed",
                      },
                    })}\n\n`,
                  ),
                );
                return;
              }

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    ic_upstream: { requestSentMs: exec.requestSentMs, headersMs: exec.headersMs },
                  })}\n\n`,
                ),
              );

              const reader = upstream.body.getReader();
              let firstForwardMs: number | null = null;
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (firstForwardMs == null) {
                  firstForwardMs = since();
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ ic_first: { firstForwardMs } })}\n\n`),
                  );
                }
                controller.enqueue(value);
                sniffer.pushBytes(value);
              }

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
                  briefChars: stats.briefChars,
                  projectChars: stats.projectChars,
                  meetingChars: stats.meetingChars,
                  subQuestions: stats.subQuestions,
                  corrections: stats.corrections,
                  serverRequestSentMs: exec.requestSentMs,
                  upstreamHeadersMs: exec.headersMs,
                  upstreamFirstEventMs: sniffer.firstEventMs,
                  upstreamFirstDeltaMs: sniffer.firstTextMs,
                  upstreamTotalMs: since(),
                  contextChars: contextText.length,
                  context: contextSource === "prefetch" ? "hit" : "miss",
                  phases: {
                    authMs,
                    authCached,
                    sessionMs,
                    contextMs,
                    contextSource,
                    promptMs,
                    preludeMs,
                    dispatchMs: exec.requestSentMs,
                    headersMs: exec.headersMs,
                    firstForwardMs,
                  },
                },
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(meta)}\n\n`));
            } catch (error) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    ic_error: {
                      status: 500,
                      message: error instanceof Error ? error.message : "AI request failed",
                    },
                  })}\n\n`,
                ),
              );
            } finally {
              clearInterval(keepalive);
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",
            Connection: "keep-alive",
            "X-IC-Context": contextSource === "prefetch" ? "hit" : "miss",
            "X-IC-Model": cfg.model,
            "X-IC-Tier": cfg.serviceTier || "default",
            "X-IC-Effort": cfg.reasoningEffort || "default",
            "X-IC-Prompt-Chars": String(stats.promptChars),
            "X-IC-Prelude-Ms": String(preludeMs),
            "X-IC-Auth-Ms": `${authMs}${authCached ? "c" : ""}`,
            "X-IC-Server-Ms": String(preludeMs),
            "Access-Control-Expose-Headers":
              "X-IC-Context, X-IC-Model, X-IC-Tier, X-IC-Effort, X-IC-Prompt-Chars, X-IC-Server-Ms, X-IC-Prelude-Ms, X-IC-Auth-Ms",
          },
        });
      },
    },
  },
});
