import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/AppShell";
import { formatDuration, PLATFORM_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/history/$sessionId")({
  head: () => ({
    meta: [
      { title: "Session detail — InterviewCopilot" },
      { name: "description", content: "Full transcript, detected questions and generated answers for this interview session." },
      { property: "og:title", content: "Session detail — InterviewCopilot" },
      { property: "og:description", content: "Review the transcript and answers from a past interview." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SessionDetail,
});

function SessionDetail() {
  const { sessionId } = Route.useParams();

  const { data, isLoading } = useQuery({
    queryKey: ["session-detail", sessionId],
    queryFn: async () => {
      const [session, segments, questions, answers] = await Promise.all([
        supabase.from("interview_sessions").select("*").eq("id", sessionId).maybeSingle(),
        supabase
          .from("transcript_segments")
          .select("*")
          .eq("session_id", sessionId)
          .order("sequence", { ascending: true }),
        supabase
          .from("detected_questions")
          .select("*")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: true }),
        supabase.from("generated_answers").select("*").eq("session_id", sessionId),
      ]);
      return {
        session: session.data,
        segments: segments.data ?? [],
        questions: questions.data ?? [],
        answers: answers.data ?? [],
      };
    },
  });

  if (isLoading) return <AppShell title="Session">Loading…</AppShell>;
  if (!data?.session) return <AppShell title="Session">Session not found.</AppShell>;

  const session = data.session;

  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{session.title || "Interview session"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {new Date(session.created_at).toLocaleString()} ·{" "}
          {PLATFORM_LABELS[session.meeting_platform] ?? session.meeting_platform} ·{" "}
          {formatDuration(session.duration_seconds)} · {data.questions.length} questions
        </p>
      </header>

      {session.rolling_summary ? (
        <section className="panel mb-6 p-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Summary</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{session.rolling_summary}</p>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Transcript</h2>
          <div className="max-h-[560px] space-y-3 overflow-y-auto pr-2">
            {data.segments.map((segment) => (
              <div key={segment.id} className="text-sm">
                <span
                  className={cn(
                    "mr-2 text-xs font-medium uppercase tracking-wide",
                    segment.speaker === "interviewer" ? "text-primary" : "text-accent",
                  )}
                >
                  {segment.speaker === "interviewer" ? "Interviewer" : "You"}
                </span>
                <span className="text-foreground/90">{segment.text}</span>
              </div>
            ))}
            {data.segments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transcript captured.</p>
            ) : null}
          </div>
        </section>

        <section className="panel p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Questions & answers
          </h2>
          <div className="max-h-[560px] space-y-4 overflow-y-auto pr-2">
            {data.questions.map((question) => {
              const answer = data.answers.find((a) => a.question_id === question.id);
              return (
                <article key={question.id} className="rounded-xl border border-border p-4">
                  <p className="text-sm font-medium">{question.question_text}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {question.category}
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                    {answer?.answer_text ?? "No answer generated."}
                  </p>
                </article>
              );
            })}
            {data.questions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No questions detected.</p>
            ) : null}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
