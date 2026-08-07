import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { detectCapabilities } from "@/lib/audio/capability";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/new-session")({
  head: () => ({
    meta: [
      { title: "New session — InterviewCopilot" },
      { name: "description", content: "Set up a live interview copilot session for Google Meet, Zoom Web or microphone only." },
      { property: "og:title", content: "New session — InterviewCopilot" },
      { property: "og:description", content: "Configure the role, company and meeting platform before going live." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: NewSession,
});

const PLATFORMS = [
  { value: "google_meet", label: "Google Meet", hint: "Share the Meet tab with 'Share tab audio'" },
  { value: "zoom_web", label: "Zoom Web", hint: "Join in browser, then share that tab's audio" },
  {
    value: "zoom_desktop",
    label: "Zoom Desktop",
    hint: "Native app audio via the Desktop Companion (browser tab-share fallback)",
  },
  { value: "manual", label: "Microphone only", hint: "Speakerphone or in-person practice" },
  { value: "practice", label: "Practice mode", hint: "Rehearse with your own questions" },
] as const;


function NewSession() {
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<string>("google_meet");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const caps = detectCapabilities();

  const { data: resume } = useQuery({
    queryKey: ["primary-resume"],
    queryFn: async () => {
      const { data } = await supabase
        .from("documents")
        .select("id, file_name")
        .eq("is_primary", true)
        .maybeSingle();
      return data;
    },
  });

  const start = async () => {
    setBusy(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Not signed in.");
      const { data, error } = await supabase
        .from("interview_sessions")
        .insert({
          user_id: auth.user.id,
          title: role ? `${role}${company ? ` @ ${company}` : ""}` : "Interview session",
          target_role: role || null,
          company_name: company || null,
          job_description: jobDescription || null,
          meeting_platform: platform,
          resume_document_id: resume?.id ?? null,
          status: "active",
        })
        .select("id")
        .single();
      if (error) throw error;
      void navigate({ to: "/session/$sessionId", params: { sessionId: data.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start session");
      setBusy(false);
    }
  };

  return (
    <AppShell title="New session">
      <div className="grid max-w-4xl gap-6">
        {!caps.meetingAudioLikely ? (
          <div className="panel border-warning/40 p-4 text-sm text-warning">
            {caps.browser} on {caps.os} can't reliably capture meeting tab audio. Use desktop Chrome over HTTPS for
            Google Meet or Zoom Web — microphone-only sessions still work here.
          </div>
        ) : null}

        <section className="panel p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Where is the interview?
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {PLATFORMS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPlatform(option.value)}
                className={cn(
                  "rounded-xl border border-border p-4 text-left transition-colors hover:border-primary/60",
                  platform === option.value && "border-primary bg-primary/10",
                )}
              >
                <p className="text-sm font-medium">{option.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{option.hint}</p>
              </button>
            ))}
          </div>
        </section>

        {platform === "zoom_desktop" ? (
          <div className="panel border-primary/40 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Zoom Desktop needs the InterviewCopilot Companion</p>
            <p className="mt-1">
              Browsers cannot record another desktop app's audio. The companion captures Zoom output natively (WASAPI
              loopback on Windows, ScreenCaptureKit on macOS) and streams it to this session after you pair it. You can
              pair it in the live room — if it isn't installed, the room falls back to browser tab-audio sharing.
            </p>
          </div>
        ) : null}

        <section className="panel grid gap-4 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Context</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="role">Target role</Label>

              <Input id="role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Senior Backend Engineer" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="company">Company</Label>
              <Input id="company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jd">Job description (optional)</Label>
            <Textarea
              id="jd"
              rows={5}
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              placeholder="Paste the posting so answers can mirror its language."
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Resume grounding:{" "}
            {resume?.file_name ? (
              <span className="text-success">{resume.file_name}</span>
            ) : (
              <span className="text-warning">no primary resume — answers will stay generic</span>
            )}
          </p>
        </section>

        <div className="flex justify-end">
          <Button size="lg" onClick={start} disabled={busy}>
            {busy ? "Creating…" : "Continue to live room"}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
