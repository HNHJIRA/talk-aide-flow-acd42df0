import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Apple, Monitor } from "lucide-react";
import { MacDownloadButton } from "@/components/download/MacDownloadButton";
import { detectVisitorOs, type VisitorOs } from "@/lib/releases";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/download")({
  head: () => ({
    meta: [
      { title: "Download the InterviewCopilot Companion for macOS" },
      {
        name: "description",
        content:
          "Install the InterviewCopilot Desktop Companion to use Zoom Desktop audio. Apple Silicon, macOS 13 or later. Windows coming soon.",
      },
      { property: "og:title", content: "Download the InterviewCopilot Companion for macOS" },
      {
        property: "og:description",
        content: "The lightweight companion that streams Zoom Desktop audio into InterviewCopilot.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DownloadPage,
});

const STEPS = [
  "Open InterviewCopilot-Companion.dmg.",
  "Drag InterviewCopilot Companion into Applications.",
  "Open InterviewCopilot Companion.",
  "Allow Screen & System Audio Recording when macOS asks.",
  "Return to InterviewCopilot and click Check again.",
];

function DownloadPage() {
  const [os, setOs] = useState<VisitorOs>("other");
  useEffect(() => setOs(detectVisitorOs()), []);

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-5">
        <Link to="/" className="font-sans text-base font-semibold">
          Interview<span className="text-primary">Copilot</span>
        </Link>
        <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          Open app
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-20">
        <h1 className="text-3xl font-semibold tracking-tight">InterviewCopilot Companion</h1>
        <p className="mt-2 max-w-xl text-muted-foreground">
          Required for Zoom Desktop audio integration. Browsers cannot record another desktop app, so the companion
          captures Zoom output natively and streams it to your live session.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <section
            className={cn(
              "panel p-6",
              os === "macos" && "border-primary/50",
            )}
          >
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Apple className="size-4" /> macOS
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              For Apple Silicon MacBooks running macOS 13 or later.
            </p>
            <div className="mt-4">
              <MacDownloadButton />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              After installation, macOS will ask for Screen &amp; System Audio Recording permission.
            </p>
          </section>

          <section className={cn("panel p-6", os === "windows" && "border-border")}>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Monitor className="size-4" /> Windows
            </p>
            <p className="mt-1 text-xs text-muted-foreground">WASAPI loopback capture for Windows 10 and 11.</p>
            <p className="mt-4 inline-flex rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
              Coming soon
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              We publish a Windows installer only once a real native build has been compiled and tested.
            </p>
          </section>
        </div>

        <section className="panel mt-6 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">After downloading</h2>
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            {STEPS.map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs text-primary">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </section>

        <p className="mt-6 text-xs text-muted-foreground">
          The companion contains no API keys. It connects to your session with a short-lived, session-scoped pairing
          token only.
        </p>
      </main>
    </div>
  );
}
