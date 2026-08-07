/**
 * Desktop Companion pairing redemption.
 *
 * The companion posts the 6-character code the user typed (after they pressed
 * "Allow" in the companion window) and receives ONLY a bridge token scoped to
 * that user + interview session. No Deepgram, OpenAI, Stripe or Supabase
 * service credentials ever reach the desktop app.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  code: z.string().min(5).max(10),
  os: z.string().max(64).optional(),
  version: z.string().max(32).optional(),
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export const Route = createFileRoute("/api/public/companion/pair")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      POST: async ({ request }) => {
        let parsed;
        try {
          parsed = Body.parse(await request.json());
        } catch {
          return Response.json({ error: "Invalid request." }, { status: 400, headers: cors });
        }

        const code = parsed.code.trim().toUpperCase();
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: row } = await supabaseAdmin
          .from("companion_pairings")
          .select("id, session_id, bridge_token, status, expires_at")
          .eq("code", code)
          .eq("status", "pending")
          .maybeSingle();

        if (!row || new Date(row.expires_at).getTime() < Date.now()) {
          return Response.json(
            { error: "That pairing code is invalid or has expired." },
            { status: 404, headers: cors },
          );
        }

        const { data: session } = await supabaseAdmin
          .from("interview_sessions")
          .select("id, title, target_role, company_name")
          .eq("id", row.session_id)
          .maybeSingle();

        await supabaseAdmin
          .from("companion_pairings")
          .update({
            status: "approved",
            approved_at: new Date().toISOString(),
            companion_os: parsed.os ?? null,
            companion_version: parsed.version ?? null,
          })
          .eq("id", row.id);

        return Response.json(
          {
            pairingId: row.id,
            sessionId: row.session_id,
            sessionTitle: session?.title ?? "Interview session",
            bridgeToken: row.bridge_token,
            expiresAt: row.expires_at,
          },
          { headers: cors },
        );
      },
    },
  },
});
