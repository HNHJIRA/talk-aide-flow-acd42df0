import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const SessionInput = z.object({ sessionId: z.string().uuid() });
const PairingInput = z.object({ pairingId: z.string().uuid() });

/** Human-friendly, unambiguous alphabet (no O/0/I/1). */
function pairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]!);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

function bridgeToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Mint a short-lived, single-use pairing code for the Desktop Companion.
 * The code carries no API credentials: redeeming it only yields a bridge token
 * scoped to this user + interview session.
 */
export const createCompanionPairing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Invalidate any earlier pending codes for this session.
    await supabase
      .from("companion_pairings")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("session_id", data.sessionId)
      .eq("status", "pending");

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { data: row, error } = await supabase
      .from("companion_pairings")
      .insert({
        user_id: userId,
        session_id: data.sessionId,
        code: pairingCode(),
        bridge_token: bridgeToken(),
        status: "pending",
        expires_at: expiresAt,
      })
      .select("id, code, expires_at")
      .single();
    if (error || !row) throw new Error("Could not create a pairing code.");

    return { pairingId: row.id, code: row.code, expiresAt: row.expires_at };
  });

/** Poll for companion approval; the bridge token is only released once approved. */
export const getCompanionPairing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PairingInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("companion_pairings")
      .select("id, status, expires_at, approved_at, companion_os, companion_version, bridge_token")
      .eq("id", data.pairingId)
      .maybeSingle();
    if (!row) throw new Error("Pairing not found.");

    const expired = new Date(row.expires_at).getTime() < Date.now();
    const approved = row.status === "approved" && !expired;
    return {
      status: expired && row.status === "pending" ? "expired" : row.status,
      approved,
      companionOs: row.companion_os,
      companionVersion: row.companion_version,
      bridgeToken: approved ? row.bridge_token : null,
    };
  });

export const revokeCompanionPairing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PairingInput.parse(input))
  .handler(async ({ data, context }) => {
    await context.supabase
      .from("companion_pairings")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("id", data.pairingId);
    return { ok: true };
  });
