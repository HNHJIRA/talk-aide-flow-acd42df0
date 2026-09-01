/**
 * Client-safe server functions for the real-time translation layer.
 * Everything provider-related stays behind `providers.server.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const TranslateInput = z.object({
  text: z.string().min(1).max(4000),
  source: z.string().default("auto"),
  target: z.string().min(2),
  context: z.string().max(2000).optional(),
  provider: z.enum(["auto", "google", "deepl", "azure", "ai"]).default("auto"),
  partial: z.boolean().default(false),
});

export const translateText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TranslateInput.parse(input))
  .handler(async ({ data }) => {
    const { translateWithBestProvider } = await import("@/lib/translation/providers.server");
    const out = await translateWithBestProvider({
      text: data.text,
      source: data.source,
      target: data.target,
      preferred: data.provider,
      partial: data.partial,
      ...(data.context ? { context: data.context } : {}),
    });
    return out;
  });

export const translationDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { availableProviders } = await import("@/lib/translation/providers.server");
    const providers = availableProviders();
    return { providers, configured: providers.length > 0 };
  });
