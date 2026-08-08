import { createFileRoute } from "@tanstack/react-router";

/**
 * Infrastructure buffering canary.
 *
 * Emits 10 SSE frames, one every 100 ms, each carrying the server-side ms at
 * which it was enqueued. If the browser receives them ~100 ms apart the path is
 * unbuffered; if they land in one burst at the end, something between the
 * worker and the browser is buffering the stream.
 */
export const Route = createFileRoute("/api/stream-canary")({
  server: {
    handlers: {
      GET: async () => {
        const t0 = Date.now();
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`: canary-open\n\n`));
            for (let i = 0; i < 10; i++) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ i, serverMs: Date.now() - t0 })}\n\n`,
                ),
              );
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});
