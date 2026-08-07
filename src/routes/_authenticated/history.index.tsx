import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { formatDuration, PLATFORM_LABELS } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/history/")({
  head: () => ({
    meta: [
      { title: "Session history — InterviewCopilot" },
      { name: "description", content: "Review past interview sessions, transcripts and the answers you were given." },
      { property: "og:title", content: "Session history — InterviewCopilot" },
      { property: "og:description", content: "Every interview session with its transcript and detected questions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: History,
});

function History() {
  const { data } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("interview_sessions")
        .select("id, title, company_name, target_role, meeting_platform, duration_seconds, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <AppShell title="History">
      <div className="grid gap-3">
        {data?.map((session) => (
          <Link
            key={session.id}
            to="/history/$sessionId"
            params={{ sessionId: session.id }}
            className="panel flex flex-wrap items-center justify-between gap-4 p-5 transition-colors hover:border-primary/50"
          >
            <div>
              <p className="text-sm font-medium">{session.title || "Interview session"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {new Date(session.created_at).toLocaleString()} ·{" "}
                {PLATFORM_LABELS[session.meeting_platform] ?? session.meeting_platform}
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>{formatDuration(session.duration_seconds)}</p>
              <p className="capitalize">{session.status}</p>
            </div>
          </Link>
        ))}
        {data && data.length === 0 ? <p className="text-sm text-muted-foreground">No sessions yet.</p> : null}
      </div>
    </AppShell>
  );
}
