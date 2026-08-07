import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export const DOWNLOADS_BUCKET = "desktop-downloads";

export type PublicRelease = {
  platform: string;
  architecture: string;
  version: string;
  downloadUrl: string;
  fileName: string;
  fileSize: number | null;
  minimumOs: string | null;
  isTestBuild: boolean;
  releaseNotes: string | null;
};

function serverPublicClient() {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/**
 * Resolve a stored `file_url` to something a browser can download.
 * Absolute URLs are used verbatim; anything else is treated as an object path
 * inside the private `desktop-downloads` bucket and signed for one hour.
 */
async function resolveUrl(
  client: ReturnType<typeof serverPublicClient>,
  fileUrl: string,
): Promise<string | null> {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  const { data } = await client.storage.from(DOWNLOADS_BUCKET).createSignedUrl(fileUrl, 3600, {
    download: true,
  });
  return data?.signedUrl ?? null;
}

const PlatformInput = z.object({ platform: z.enum(["macos", "windows"]).default("macos") });

/**
 * Public read of the active desktop release. Returns null when no genuine
 * build has been uploaded and activated yet — the UI must not offer a download
 * in that case.
 */
export const getActiveDesktopRelease = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => PlatformInput.parse(input ?? {}))
  .handler(async ({ data }): Promise<PublicRelease | null> => {
    const client = serverPublicClient();
    const { data: row } = await client
      .from("desktop_releases")
      .select(
        "platform, architecture, version, file_url, file_name, file_size, minimum_os, is_test_build, release_notes",
      )
      .eq("platform", data.platform)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) {
      // Optional env-configured fallback so a release can be published without a DB row.
      const envUrl = data.platform === "macos" ? process.env["MAC_COMPANION_DOWNLOAD_URL"] : undefined;
      if (!envUrl) return null;
      return {
        platform: "macos",
        architecture: "apple_silicon",
        version: process.env["MAC_COMPANION_VERSION"] ?? "0.1.0",
        downloadUrl: envUrl,
        fileName: "InterviewCopilot-Companion.dmg",
        fileSize: null,
        minimumOs: "13.0",
        isTestBuild: true,
        releaseNotes: null,
      };
    }

    const downloadUrl = await resolveUrl(client, row.file_url);
    if (!downloadUrl) return null;

    return {
      platform: row.platform,
      architecture: row.architecture,
      version: row.version,
      downloadUrl,
      fileName: row.file_name,
      fileSize: row.file_size,
      minimumOs: row.minimum_os,
      isTestBuild: row.is_test_build,
      releaseNotes: row.release_notes,
    };
  });

/** Whether the signed-in user may manage releases. */
export const getIsReleaseAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    return { isAdmin: Boolean(data) };
  });

/** Admin: full release list, including inactive drafts. */
export const listDesktopReleases = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("desktop_releases")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

const SaveInput = z.object({
  id: z.string().uuid().optional(),
  platform: z.enum(["macos", "windows"]).default("macos"),
  architecture: z.string().min(1).max(40).default("apple_silicon"),
  version: z.string().min(1).max(40),
  fileUrl: z.string().min(1).max(500),
  fileName: z.string().min(1).max(120).default("InterviewCopilot-Companion.dmg"),
  fileSize: z.number().int().nonnegative().nullable().optional(),
  minimumOs: z.string().max(20).nullable().optional(),
  isActive: z.boolean().default(false),
  isTestBuild: z.boolean().default(true),
  releaseNotes: z.string().max(4000).nullable().optional(),
});

/** Admin: create or update a release row. Activating one deactivates siblings. */
export const saveDesktopRelease = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveInput.parse(input))
  .handler(async ({ data, context }) => {
    const row = {
      platform: data.platform,
      architecture: data.architecture,
      version: data.version,
      file_url: data.fileUrl,
      file_name: data.fileName,
      file_size: data.fileSize ?? null,
      minimum_os: data.minimumOs ?? null,
      is_active: data.isActive,
      is_test_build: data.isTestBuild,
      release_notes: data.releaseNotes ?? null,
    };

    const query = data.id
      ? context.supabase.from("desktop_releases").update(row).eq("id", data.id).select("id").single()
      : context.supabase.from("desktop_releases").insert(row).select("id").single();
    const { data: saved, error } = await query;
    if (error || !saved) throw new Error(error?.message ?? "Could not save the release.");

    if (data.isActive) {
      await context.supabase
        .from("desktop_releases")
        .update({ is_active: false })
        .eq("platform", data.platform)
        .neq("id", saved.id);
    }
    return { id: saved.id };
  });

const IdInput = z.object({ id: z.string().uuid() });

export const deleteDesktopRelease = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdInput.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("desktop_releases").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
