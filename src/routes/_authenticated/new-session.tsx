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
import { MacDownloadButton } from "@/components/download/MacDownloadButton";
import { listProjects, saveMeetingPrep, upsertProject } from "@/lib/copilot.functions";
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
  {
    value: "teams_web",
    label: "Microsoft Teams Web",
    hint: "Join Teams in the browser, then share that tab's audio",
  },
  {
    value: "teams_desktop",
    label: "Microsoft Teams Desktop",
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

  /* ---- meeting prep knowledge base ---- */
  const [projectId, setProjectId] = useState<string>("");
  const [newProject, setNewProject] = useState("");
  const [prep, setPrep] = useState({
    meeting_title: "",
    meeting_type: "client_call",
    client_website: "",
    project_description: "",
    requirements: "",
    goals: "",
    challenges: "",
    tech_stack: "",
    budget_notes: "",
    timeline: "",
    client_concerns: "",
    important_facts: "",
    emphasize: "",
    avoid_claims: "",
    previous_communication: "",
    custom_notes: "",
  });
  const setPrepField = (key: keyof typeof prep) => (value: string) =>
    setPrep((prev) => ({ ...prev, [key]: value }));

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
  });

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
      let linkedProject = projectId || null;
      if (!linkedProject && newProject.trim()) {
        const created = await upsertProject({
          data: { name: newProject.trim(), ...(company ? { clientName: company } : {}) },
        });
        linkedProject = created?.id ?? null;
      }

      const { data, error } = await supabase
        .from("interview_sessions")
        .insert({
          user_id: auth.user.id,
          title: role ? `${role}${company ? ` @ ${company}` : ""}` : "Interview session",
          target_role: role || null,
          company_name: company || null,
          job_description: jobDescription || null,
          meeting_platform: platform,
          project_id: linkedProject,
          resume_document_id: resume?.id ?? null,
          status: "active",
        })
        .select("id")
        .single();
      if (error) throw error;

      // The knowledge base is compiled BEFORE Go Live so nothing is parsed
      // during the meeting itself.
      await saveMeetingPrep({
        data: {
          sessionId: data.id,
          projectId: linkedProject,
          prep: {
            ...prep,
            meeting_title: prep.meeting_title || (role ? `${role}${company ? ` @ ${company}` : ""}` : ""),
            company_name: company,
            project_name: newProject.trim() || projects.find((p) => p.id === projectId)?.name || "",
            role_discussed: role,
          },
        },
      }).catch(() => {
        /* prep is optional — never block going live */
      });

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

        {platform === "teams_web" ? (
          <div className="panel border-primary/40 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Microsoft Teams Web</p>
            <p className="mt-1">
              Open your Teams meeting in the browser, then share the Teams tab and enable tab audio when the live room
              asks for meeting audio. Your microphone stays a separate candidate stream.
            </p>
          </div>
        ) : null}

        {platform === "zoom_desktop" || platform === "teams_desktop" ? (
          <div className="panel border-primary/40 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              {platform === "teams_desktop" ? "Microsoft Teams Desktop" : "Zoom Desktop"} needs the InterviewCopilot
              Companion
            </p>
            <p className="mt-1">
              Browsers cannot record another desktop app's audio. The companion captures meeting output natively
              (WASAPI system playback capture on Windows, ScreenCaptureKit on macOS) and streams it to this session
              after you pair it. On Windows this is system playback capture, so other system sounds can be included.
              You can pair it in the live room — if it isn't installed, the room falls back to browser tab-audio
              sharing.
            </p>
            <div className="mt-3">
              <MacDownloadButton size="sm" />
            </div>
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

        <section className="panel grid gap-4 p-6">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Meeting prep &amp; knowledge base
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Everything here is compiled into a stable meeting brief before you go live, so the copilot already knows
              the project and never has to parse anything mid-call. All fields are optional.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project">Project</Label>
              <select
                id="project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">— new / none —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {!projectId ? (
                <Input
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  placeholder="New project name (carries memory to later meetings)"
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Summaries from earlier meetings on this project are loaded automatically.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meetingTitle">Meeting title</Label>
              <Input
                id="meetingTitle"
                value={prep.meeting_title}
                onChange={(e) => setPrepField("meeting_title")(e.target.value)}
                placeholder="Discovery call — SEO growth"
              />
              <Label htmlFor="meetingType">Meeting type</Label>
              <select
                id="meetingType"
                value={prep.meeting_type}
                onChange={(e) => setPrepField("meeting_type")(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {[
                  ["client_call", "Client call"],
                  ["job_interview", "Job interview"],
                  ["discovery", "Discovery / scoping"],
                  ["status_update", "Status update"],
                  ["sales", "Sales call"],
                  ["other", "Other"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="website">Client website</Label>
              <Input
                id="website"
                value={prep.client_website}
                onChange={(e) => setPrepField("client_website")(e.target.value)}
                placeholder="https://client.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stack">Tech stack</Label>
              <Input
                id="stack"
                value={prep.tech_stack}
                onChange={(e) => setPrepField("tech_stack")(e.target.value)}
                placeholder="Next.js, Postgres, Vercel"
              />
            </div>
          </div>

          {(
            [
              ["project_description", "Project description", "What the project actually is."],
              ["requirements", "Main requirements", "What must be delivered."],
              ["goals", "Goals", "What success looks like for the client."],
              ["challenges", "Problems / challenges", "Known blockers or risks."],
              ["client_concerns", "Known client concerns", "What they will push back on."],
              ["important_facts", "Important facts", "Numbers, dates, names you must get right."],
              ["emphasize", "Things I want to emphasise", "Strengths to steer answers toward."],
              ["avoid_claims", "Things I should NOT claim", "The copilot will never assert these on your behalf."],
              ["previous_communication", "Previous communication", "Emails, prior calls, agreed scope."],
              ["custom_notes", "Custom notes", ""],
            ] as const
          ).map(([key, label, hint]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>{label}</Label>
              <Textarea
                id={key}
                rows={2}
                value={prep[key]}
                onChange={(e) => setPrepField(key)(e.target.value)}
                placeholder={hint}
              />
            </div>
          ))}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="budget">Budget notes</Label>
              <Input
                id="budget"
                value={prep.budget_notes}
                onChange={(e) => setPrepField("budget_notes")(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeline">Timeline</Label>
              <Input
                id="timeline"
                value={prep.timeline}
                onChange={(e) => setPrepField("timeline")(e.target.value)}
              />
            </div>
          </div>
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
