import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  deleteDesktopRelease,
  getIsReleaseAdmin,
  listDesktopReleases,
  saveDesktopRelease,
} from "@/lib/releases.functions";
import { DOWNLOADS_BUCKET } from "@/lib/releases.functions";
import { formatBytes } from "@/lib/releases";

export const Route = createFileRoute("/_authenticated/admin/desktop-releases")({
  head: () => ({
    meta: [
      { title: "Desktop releases — InterviewCopilot admin" },
      { name: "description", content: "Upload and activate the macOS companion installer served to customers." },
      { property: "og:title", content: "Desktop releases — InterviewCopilot admin" },
      { property: "og:description", content: "Manage which companion build the website offers for download." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AdminReleases,
});

function AdminReleases() {
  const qc = useQueryClient();
  const { data: admin, isLoading: adminLoading } = useQuery({
    queryKey: ["is-release-admin"],
    queryFn: () => getIsReleaseAdmin({ data: undefined }),
  });
  const { data: releases } = useQuery({
    queryKey: ["desktop-releases"],
    queryFn: () => listDesktopReleases({ data: undefined }),
    enabled: Boolean(admin?.isAdmin),
  });

  const [version, setVersion] = useState("0.1.0");
  const [minimumOs, setMinimumOs] = useState("13.0");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose the compiled .dmg file first.");
      if (!file.name.toLowerCase().endsWith(".dmg")) throw new Error("Only a real .dmg artifact can be uploaded.");
      const path = `mac/InterviewCopilot-Companion-${version}-arm64.dmg`;
      const { error: upErr } = await supabase.storage
        .from(DOWNLOADS_BUCKET)
        .upload(path, file, { upsert: true, contentType: "application/x-apple-diskimage" });
      if (upErr) throw new Error(upErr.message);
      await saveDesktopRelease({
        data: {
          platform: "macos",
          architecture: "apple_silicon",
          version,
          fileUrl: path,
          fileName: "InterviewCopilot-Companion.dmg",
          fileSize: file.size,
          minimumOs,
          isActive: true,
          isTestBuild: true,
          releaseNotes: notes || null,
        },
      });
    },
    onSuccess: () => {
      toast.success("Release uploaded and activated.");
      setFile(null);
      void qc.invalidateQueries({ queryKey: ["desktop-releases"] });
      void qc.invalidateQueries({ queryKey: ["desktop-release", "macos"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Upload failed"),
    onSettled: () => setBusy(false),
  });

  const toggleActive = useMutation({
    mutationFn: async (row: { id: string; version: string; file_url: string; file_name: string; file_size: number | null; minimum_os: string | null; is_active: boolean; is_test_build: boolean; release_notes: string | null; architecture: string }) =>
      saveDesktopRelease({
        data: {
          id: row.id,
          platform: "macos",
          architecture: row.architecture,
          version: row.version,
          fileUrl: row.file_url,
          fileName: row.file_name,
          fileSize: row.file_size,
          minimumOs: row.minimum_os,
          isActive: !row.is_active,
          isTestBuild: row.is_test_build,
          releaseNotes: row.release_notes,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["desktop-releases"] });
      void qc.invalidateQueries({ queryKey: ["desktop-release", "macos"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDesktopRelease({ data: { id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["desktop-releases"] });
      void qc.invalidateQueries({ queryKey: ["desktop-release", "macos"] });
    },
  });

  if (adminLoading) return <AppShell title="Desktop releases">Loading…</AppShell>;
  if (!admin?.isAdmin) {
    return (
      <AppShell title="Desktop releases">
        <p className="text-sm text-muted-foreground">This area is restricted to administrators.</p>
      </AppShell>
    );
  }

  return (
    <AppShell title="Desktop releases">
      <div className="grid max-w-3xl gap-6">
        <section className="panel grid gap-4 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Upload a compiled macOS build
          </h2>
          <p className="text-xs text-muted-foreground">
            Only upload a genuine Tauri-produced .dmg. Activating it makes the website download button live instantly —
            no code changes needed.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="version">Version</Label>
              <Input id="version" value={version} onChange={(e) => setVersion(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minos">Minimum macOS</Label>
              <Input id="minos" value={minimumOs} onChange={(e) => setMinimumOs(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dmg">Installer (.dmg)</Label>
            <Input
              id="dmg"
              type="file"
              accept=".dmg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">Release notes</Label>
            <Textarea id="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div>
            <Button
              disabled={busy || !file}
              onClick={() => {
                setBusy(true);
                save.mutate();
              }}
            >
              {busy ? "Uploading…" : "Upload & activate"}
            </Button>
          </div>
        </section>

        <section className="panel p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Releases</h2>
          {!releases?.length ? (
            <p className="text-sm text-muted-foreground">No releases yet — the website shows “macOS build preparing”.</p>
          ) : (
            <ul className="divide-y divide-border">
              {releases.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {row.platform} · {row.architecture} · v{row.version}{" "}
                      {row.is_active ? <span className="text-success">(active)</span> : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {row.file_url} {formatBytes(row.file_size) ? `· ${formatBytes(row.file_size)}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => toggleActive.mutate(row)}>
                      {row.is_active ? "Deactivate" : "Activate"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(row.id)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
