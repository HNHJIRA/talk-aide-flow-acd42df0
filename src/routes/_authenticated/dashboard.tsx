import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Radio, FileText, Clock, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { formatDuration, PLATFORM_LABELS } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — InterviewCopilot" },
      { name: "description", content: "Your interview minutes, recent sessions and primary resume." },
      { property: "og:title", content: "Dashboard — InterviewCopilot" },
      { property: "og:description", content: "Start a live copilot session or review your interview history." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const [credits, sessions, resume, questions] = await Promise.all([
        supabase.from("user_credits").select("available_seconds, used_seconds, plan").maybeSingle(),
        supabase
          .from("interview_sessions")
          .select("id, title, company_name, target_role, meeting_platform, duration_seconds, created_at, status")
          .order("created_at", { ascending: false })
          .limit(5),
        supabase.from("documents").select("id, file_name, processing_status").eq("is_primary", true).maybeSingle(),
        supabase.from("detected_questions").select("id", { count: "exact", head: true }),
      ]);
      return {
        credits: credits.data,
        sessions: sessions.data ?? [],
        resume: resume.data,
        questionCount: questions.count ?? 0,
      };
    },
  });

  const remaining = (data?.credits?.available_seconds ?? 0) - (data?.credits?.used_seconds ?? 0);

  return (
    <AppShell>
      <section className="panel mb-6 flex flex-wrap items-center justify-between gap-6 p-8">
        <div>
          <h1 className="text-2xl font-semibold">Ready for your next interview?</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Connect your meeting audio and microphone, and the copilot will transcribe both sides, spot the
            interviewer's questions and stream an answer grounded in your resume.
          </p>
        </div>
        <div className="flex gap-3">
          <Button asChild size="lg">
            <Link to="/new-session">
              <Radio className="size-4" /> Start copilot
            </Link>
          </Button>
        </div>
      </section>

      <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Clock} label="Minutes remaining" value={Math.max(0, Math.round(remaining / 60)).toString()} />
        <Stat icon={Radio} label="Sessions" value={(data?.sessions.length ?? 0).toString()} />
        <Stat icon={MessageSquare} label="Questions answered" value={data?.questionCount.toString() ?? "0"} />
        <Stat
          icon={FileText}
          label="Primary resume"
          value={data?.resume?.file_name ? "Ready" : "Not set"}
          detail={data?.resume?.file_name ?? "Upload one to ground your answers"}
        />
      </section>

      <section className="panel p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent sessions</h2>
          <Link to="/history" className="text-xs text-primary hover:underline">
            View all
          </Link>
        </div>
        {data?.sessions.length ? (
          <ul className="divide-y divide-border">
            {data.sessions.map((session) => (
              <li key={session.id}>
                <Link
                  to="/history/$sessionId"
                  params={{ sessionId: session.id }}
                  className="flex items-center justify-between gap-4 py-3 text-sm hover:text-primary"
                >
                  <span className="truncate">
                    {session.title || session.target_role || "Interview session"}
                    {session.company_name ? ` · ${session.company_name}` : ""}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {PLATFORM_LABELS[session.meeting_platform] ?? session.meeting_platform} ·{" "}
                    {formatDuration(session.duration_seconds)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sessions yet — your first one will appear here.</p>
        )}
      </section>
    </AppShell>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="panel p-5">
      <Icon className="mb-3 size-4 text-primary" />
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
