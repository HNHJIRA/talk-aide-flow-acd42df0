import { createFileRoute, Link } from "@tanstack/react-router";
import { Mic, Radio, Sparkles, ShieldCheck, FileText, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "InterviewCopilot — Real-time AI interview assistant" },
      {
        name: "description",
        content:
          "Live transcription, automatic question detection and streaming AI answers grounded in your real resume — built for Google Meet and Zoom Web in Chrome.",
      },
      { property: "og:title", content: "InterviewCopilot — Real-time AI interview assistant" },
      {
        property: "og:description",
        content:
          "Practice interviews and get permitted real-time assistance: separate interviewer and candidate transcripts, automatic question detection, resume-grounded answers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    icon: Radio,
    title: "Meeting audio, honestly detected",
    body: "Share your Google Meet or Zoom Web tab with audio. We verify a real audio track exists before showing Connected — never a fake status.",
  },
  {
    icon: Mic,
    title: "Two separate streams",
    body: "Interviewer audio and your microphone are transcribed independently, so answers are only generated for what the interviewer actually asks.",
  },
  {
    icon: Sparkles,
    title: "Answers that stream instantly",
    body: "Questions are detected automatically and answers start streaming within moments — no clicking Generate mid-conversation.",
  },
  {
    icon: FileText,
    title: "Grounded in your resume",
    body: "Relevant resume sections are retrieved per question. The model is instructed never to invent employers, results or years of experience.",
  },
  {
    icon: Gauge,
    title: "Built for long sessions",
    body: "Reconnecting transcription, pause/resume, network recovery and clean teardown for 60-minute conversations.",
  },
  {
    icon: ShieldCheck,
    title: "Private by default",
    body: "Raw audio is never stored. Transcripts, questions and answers are yours alone, protected row by row.",
  },
];

function Landing() {
  return (
    <main className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="font-sans text-lg font-semibold tracking-tight">
          Interview<span className="text-primary">Copilot</span>
        </span>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/auth">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/auth" search={{ mode: "signup" }}>
              Get started
            </Link>
          </Button>
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-6 pb-16 pt-14 text-center">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success live-dot" /> Chrome · Google Meet · Zoom Web
        </p>
        <h1 className="text-balance text-5xl font-semibold leading-[1.05] md:text-6xl">
          A real-time copilot for interviews you're allowed to use it in.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          InterviewCopilot listens to the meeting and your microphone as two separate streams, detects the
          interviewer's questions automatically, and streams an answer built from your actual resume.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/auth" search={{ mode: "signup" }}>
              Start free — 60 minutes
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/auth">I already have an account</Link>
          </Button>
        </div>
        <p className="mt-5 text-xs text-muted-foreground">
          Designed for interview practice and for calls where an AI assistant is permitted. No hidden capture,
          no monitoring bypass.
        </p>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 pb-24 md:grid-cols-3">
        {FEATURES.map((feature) => (
          <article key={feature.title} className="panel p-6">
            <feature.icon className="mb-4 size-5 text-primary" />
            <h2 className="mb-2 text-base font-semibold">{feature.title}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
          </article>
        ))}
      </section>

      <footer className="border-t border-border px-6 py-8 text-center text-xs text-muted-foreground">
        InterviewCopilot — use it where AI assistance is allowed.
      </footer>
    </main>
  );
}
