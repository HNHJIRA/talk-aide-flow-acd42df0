/**
 * Text-to-speech for Voice Interpreter Mode.
 *
 * Runs through the Lovable AI Gateway (server-side key only). Short
 * conversational utterances are synthesized as one buffered MP3 so the client
 * can hand the bytes straight to an <audio> element routed at the chosen
 * output device (virtual microphone or headphones).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const SpeakInput = z.object({
  text: z.string().min(1).max(1200),
  voice: z.string().min(1).max(40).default("alloy"),
  speed: z.number().min(0.7).max(1.2).default(1),
  /** Steering hint (kept short: it costs latency). */
  instructions: z.string().max(300).optional(),
});

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SpeakInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env["LOVABLE_API_KEY"];
    if (!apiKey) throw new Error("Text-to-speech is not configured");

    const started = Date.now();
    const response = await fetch("https://ai.gateway.lovable.dev/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: data.text,
        voice: data.voice,
        speed: data.speed,
        response_format: "mp3",
        ...(data.instructions ? { instructions: data.instructions } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 429) throw new Error("Voice engine is rate limited — try again");
      if (response.status === 402)
        throw new Error(body || "AI credits exhausted — add credits to keep the interpreter voice");
      throw new Error(`Speech synthesis failed [${response.status}]: ${body}`);
    }

    const buffer = await response.arrayBuffer();
    return {
      audio: Buffer.from(buffer).toString("base64"),
      mimeType: "audio/mpeg",
      ttsMs: Date.now() - started,
    };
  });
